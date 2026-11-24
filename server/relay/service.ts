import { MACHINE_DIRECT_CARRIER_ENABLED, MachineCodeForAccountError } from "../machine-profile.ts";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { DeviceConnection } from "../../shared/access.ts";
import { encodeOffer } from "../../shared/relay-offer.ts";
import type { RelayOffer } from "../../shared/relay-offer.ts";
import { parseRelayPass, relayPassAdmitsNewSessions } from "../../shared/relay-pass.ts";
import { GLOBAL_RELAY, REGIONAL_RELAYS } from "../../shared/relay-regions.ts";
import type { AccountPairing, RelayErrorCode, RelayStatus } from "../../shared/protocol.ts";
import { PcInAccountError } from "../devices.ts";
import type { RequestServices } from "../dispatch.ts";
import { isJsonObject } from "../http.ts";
import { writePrivateState } from "../private-state.ts";
import { DEFAULT_ACCOUNT_SERVICE } from "../static.ts";
import { loadRelayIdentity, RelayIdentityError, rotateRelayIdentity, savedIdentityReader, savedServerId } from "./identity.ts";
import type { RelayIdentity } from "./identity.ts";
import { forgetListKeys } from "../account/list-keys.ts";
import { forgetList } from "../account/list-follow.ts";
import { SignedInSessions } from "./admissions.ts";
import { DirectCarrier } from "./direct.ts";
import type { DirectCarrierOptions } from "./direct.ts";
import { RelayLink, relayEnforcesPasses } from "./link.ts";
import type { RelayLinkOptions } from "./link.ts";
import { RelayPairingApprovals } from "./pairing-approvals.ts";
import { RelayPairCodes } from "./pair-code.ts";
import { RelayPassKeeper, type RelayPassClock } from "./pass.ts";
import type { RelayPassNotice } from "./link.ts";

export const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * No account was named for this PC (RelayService.setRelayAccount), so no code is made for the relay tab's QR code
 * (RelayService.offer `noAccountOnly`): a device that pairs with that code is taken into the named account alone
 * (server/account/records.ts applyLink).
 */
export class NoAccountNamedError extends Error {
  readonly code = "no_account_named";
  constructor() {
    super("This PC is not set up for an Ovis account yet. Sign in on this PC and add it to your account, or run `ovis add` on it; then it can show its QR code.");
  }
}

export class ResetRegistryUnavailableError extends Error {
  readonly code = "gate_unavailable";
  constructor() { super("Cannot reset the relay identity while this PC's paired device registry is unreadable."); }
}

/**
 * The reset a person confirmed for a PC its account's list removed, refused: the PC is no longer the one the question
 * was about (`identity_changed`), it is in an account again (`in_account`), or that list did not remove it (`not_removed`).
 */
export class ResetNotAskedError extends Error {
  constructor(readonly code: "identity_changed" | "in_account" | "not_removed") {
    super(code === "identity_changed" ? "This PC's relay identity is no longer the one that was to be reset."
      : code === "in_account" ? "This PC is in an Ovis account now, so it was not reset."
      : "That account's list did not remove this PC.");
  }
}

/**
 * The account service is turned off on this PC (OVIS_ACCOUNT_SERVICE_URL=off), so no code is made that puts it in an
 * account: a device that pairs with one is let in only on its account's word (server/account/records.ts applyLink).
 */
export class AccountServiceOffError extends Error {
  readonly code = "account_service_off";
  constructor() {
    super("This PC's Ovis account service is turned off, so it cannot be added to an account with a QR code. Pair a device with `ovis pair` instead.");
  }
}

export interface RelayServiceOptions {
  readonly stateDir: string;
  readonly relay?: string;
  readonly app?: string;
  readonly connect?: RelayLinkOptions["connect"];
  readonly clock?: RelayLinkOptions["clock"];
  readonly random?: RelayLinkOptions["random"];
  readonly serverVersion?: RelayLinkOptions["serverVersion"];
  readonly minSupportedClient?: RelayLinkOptions["minSupportedClient"];
  /**
   * Regional relays to measure against `relay`. Ovis's own (shared/relay-regions.ts) when neither
   * `relay` nor OVIS_RELAY_URL names a relay; none otherwise, so a self-hosted relay stays the only one.
   */
  readonly regionalRelays?: readonly string[];
  readonly probe?: (relay: string, signal: AbortSignal) => Promise<number | null>;
  /**
   * The relay typed pairing codes meet on (server/relay/pair-code.ts): Ovis's global one, where the
   * hosted app looks for them, when this PC is on it; none on a relay of its own. Tests name theirs.
   */
  readonly pairCodeRelay?: string;
  /**
   * Direct connections on this PC's networks while the relay is on (server/relay/direct.ts), once
   * turned on: the real entrypoint passes `{}`; without it (tests) nothing listens on the network.
   */
  readonly direct?: Pick<DirectCarrierOptions, "addresses" | "peerAllowed" | "preferredPort" | "refreshMs" | "advertise" | "tailnetIp" | "tailnetAddresses">;
  /** The account service a relay pass comes from (server/relay/pass.ts), or why none can be used; none is asked without it. */
  readonly accountService?: string | Error;
  readonly accountFetch?: (request: Request) => Promise<Response>;
  readonly passClock?: RelayPassClock;
  /**
   * The relays that count as Ovis's own, the only ones a pass goes to: GLOBAL_RELAY and REGIONAL_RELAYS (or only the
   * staging copy OVIS_RELAY_URL names with OVIS_RELAY_STAGING=1) unless tests name theirs.
   */
  readonly ovisRelays?: readonly string[];
}

/** Ovis's staging account service (ovis-sh/account `[env.staging]`): the only one whose passes go to a staging relay. */
export const STAGING_ACCOUNT_SERVICE = "https://account-staging.devswha.workers.dev";

/** An origin as compared here: lowercase (as URL makes it), with no trailing dot on its host; null for anything else. */
function originKey(origin: string): string | null {
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.hostname.replace(/\.$/, "")}${url.port ? `:${url.port}` : ""}`;
  } catch { return null; }
}

const PRODUCTION_SERVICE = originKey(DEFAULT_ACCOUNT_SERVICE);
const STAGING_SERVICE = originKey(STAGING_ACCOUNT_SERVICE);

const REGIONAL_SHARE = 0.5;
const PROBE_TIMEOUT_MS = 5_000;

/** The best of three `/health` round trips; the first one opens the connection and is not counted. */
async function probeRelay(relay: string, signal: AbortSignal): Promise<number | null> {
  const url = new URL("/health", relay.replace(/^wss:/, "https:"));
  let best: number | null = null;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = performance.now();
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]), cache: "no-store" });
      await response.arrayBuffer();
      if (!response.ok) return null;
      const elapsed = performance.now() - started;
      if (attempt > 0) best = best === null ? elapsed : Math.min(best, elapsed);
    }
  } catch { return null; }
  return best;
}

function offerName(): { name?: string } {
  const name = hostname().slice(0, 64);
  return name ? { name } : {};
}

/** Only secure origins, without credentials, paths, query, fragments or host lists. */
export function relayEndpoint(input: string, protocol: "wss:" | "https:"): string {
  const url = new URL(input);
  if (url.protocol !== protocol || url.username || url.password || url.search || url.hash
    || url.pathname !== "/" || !/^[a-z0-9.-]+$/i.test(url.hostname)) throw new Error(`Invalid ${protocol} relay origin`);
  return url.origin;
}

export class RelayService {
  private phase: RelayStatus["phase"] = "off";
  private error: string | null = null;
  private errorCode: RelayErrorCode | null = null;
  private blocked: RelayStatus["blocked"] = null;
  private link: RelayLink | undefined;
  private regionalLink: RelayLink | undefined;
  private regionalPhase: RelayStatus["phase"] = "off";
  private regionalRelay: string | null = null;
  private measuring: AbortController | undefined;
  private readonly regionalRelays: readonly string[];
  private readonly pinned: string | null;
  private readonly ovisRelays: readonly string[];
  /** The staging relay OVIS_RELAY_URL names with OVIS_RELAY_STAGING=1 and the staging account service, or null. */
  private readonly stagingRelay: string | null;
  private services: RequestServices | undefined;
  private port = 0;
  private identity: RelayIdentity | undefined;
  private readonly readSavedIdentity: () => RelayIdentity | undefined;
  private saved: string | null | undefined;
  private enabled = false;
  private shuttingDown = false;
  private resetting = false;
  private ending: Promise<void> = Promise.resolve();
  readonly relay: string;
  readonly app: string;
  readonly approvals: RelayPairingApprovals;
  private stopRevokeAll: (() => void) | undefined;
  private pairCodes: RelayPairCodes | undefined;
  /** This PC's relay pass, kept while the relay is on and is one of Ovis's. */
  private passKeeper: RelayPassKeeper | undefined;
  private passNotice: RelayPassNotice | null = null;
  private passRefused = false;
  private directCarrier: DirectCarrier | undefined;
  private directStarting: Promise<void> = Promise.resolve();
  /** signed-in sessions over the relay links and the direct carriers alike, against one set of limits */
  private readonly signedIn = new SignedInSessions();
  /** whether direct connections are on, read once from `relay/direct.json`: off unless turned on */
  private directOn: boolean | undefined;

  constructor(private readonly options: RelayServiceOptions) {
    this.readSavedIdentity = savedIdentityReader(options.stateDir);
    // the pairing window outlives a restart (pairing-approvals.ts), so it is read from this PC's state
    this.approvals = new RelayPairingApprovals({ path: join(options.stateDir, "relay", "pairing-window.json") });
    const named = options.relay ?? process.env["OVIS_RELAY_URL"];
    const origin = named === undefined ? undefined : relayEndpoint(named, "wss:");
    // A test PC on a staging copy of Ovis's relay (relay/README.md, "Staging"), and only with Ovis's staging account
    // service, matched as such: that relay alone, and the staging service's passes go there only.
    const asked = origin !== undefined && process.env["OVIS_RELAY_STAGING"] === "1";
    const service = options.accountService;
    const staging = asked && typeof service === "string" && originKey(service) === STAGING_SERVICE;
    if (asked && !staging) console.error(JSON.stringify({ event: "relay.staging.ignored", reason: `OVIS_RELAY_STAGING needs OVIS_ACCOUNT_SERVICE_URL=${STAGING_ACCOUNT_SERVICE}` }));
    this.stagingRelay = staging ? origin : null;
    this.pinned = !staging && origin !== undefined && REGIONAL_RELAYS.includes(origin) ? origin : null;
    this.relay = origin === undefined || this.pinned ? GLOBAL_RELAY : origin;
    this.ovisRelays = options.ovisRelays ?? (staging ? [origin] : [GLOBAL_RELAY, ...REGIONAL_RELAYS]);
    this.app = relayEndpoint(options.app ?? process.env["OVIS_RELAY_APP_URL"] ?? "https://app.ovis.sh", "https:");
    this.regionalRelays = this.pinned ? [this.pinned]
      : (options.regionalRelays ?? (origin === undefined ? REGIONAL_RELAYS : []))
        .map((relay) => relayEndpoint(relay, "wss:")).filter((relay) => relay !== this.relay);
  }

  currentIdentity(): RelayIdentity | undefined {
    return this.link ? this.identity : this.readSavedIdentity();
  }

  /**
   * What this PC tells another PC of its owner that adds it to an account over SSH (docs/account.md, "Adding a PC over
   * SSH"): its ID, public key, advertised relay and name, as a pairing link would carry them, and nothing secret. It opens
   * no pairing window.
   */
  publicFields(): { server_id: string; public_key: string; relay: string; name?: string } | null {
    const identity = this.currentIdentity();
    return identity ? { server_id: identity.server_id, public_key: identity.public_key, relay: this.advertised, ...offerName() } : null;
  }


  /**
   * An explicit SSH add of a PC whose relay never started (an SSH install skips onboarding): its identity, created when
   * none is saved yet. A damaged one is never replaced (RelayIdentityError), and no pairing window opens.
   */
  ensureIdentity(): RelayIdentity {
    return this.currentIdentity() ?? loadRelayIdentity(this.options.stateDir);
  }

  private get advertised(): string {
    return this.regionalRelay !== null && this.regionalPhase === "online" ? this.regionalRelay : this.relay;
  }

  private relayHints(): readonly string[] {
    return [...new Set([this.advertised, this.relay])];
  }

  serverId(): string | undefined {
    if (this.identity) return this.identity.server_id;
    if (this.saved === undefined) this.saved = savedServerId(this.options.stateDir) ?? null;
    return this.saved ?? undefined;
  }

  connections(): Map<string, DeviceConnection> { return this.signedIn.connections(); }

  checkConnections(timeoutMs: number): Promise<void> { return this.signedIn.check(timeoutMs); }

  status(): RelayStatus {
    return { phase: this.phase, relay: this.advertised, app: this.app,
      sessions: (this.link?.sessions ?? 0) + (this.regionalLink?.sessions ?? 0) + (this.directCarrier?.sessions ?? 0),
      blocked: this.blocked, error: this.error, error_code: this.exactErrorCode(), account_named: this.savedRelayAccount() !== null,
      ...(this.options.direct ? { direct: { on: this.directEnabled(), carriers: this.directCarrier?.advertised(true) ?? [] } } : {}),
      ...(this.passKeeper ? { pass: { state: this.passState(this.passKeeper), relay: this.passNotice?.state ?? null, enforce_at: this.passNotice?.enforce_at ?? null, refused: this.passRefused,
        // a relay that refuses this PC for its pass enforces them, whatever it last said in a `sync`
        enforced: this.passRefused || relayEnforcesPasses(this.passNotice, Date.now()), ...this.newSessions() } } : {}) };
  }

  /**
   * `new_sessions: false` while the pass the global relay holds this PC to says new client sessions to it are not
   * allowed (the one sent, or the one last sent while that relay still honors it), and only while that relay says
   * passes are on and this one holds (`relay` ok): a relay with passes off ignores it. With `enforced` it is what the
   * global link refuses a new device on (server/relay/link.ts).
   */
  private newSessions(): { new_sessions?: false } {
    if (this.passNotice?.state !== "ok") return {};
    const parsed = parseRelayPass(this.passFor(this.relay, true));
    return parsed && !relayPassAdmitsNewSessions(parsed.payload) ? { new_sessions: false } : {};
  }

  /** Where getting a pass stands, as the global link sees it: a pass held that its relay does not take is none. */
  private passState(keeper: RelayPassKeeper): RelayPassKeeper["state"] {
    return keeper.state === "ok" && this.passFor(this.relay) === null ? "unavailable" : keeper.state;
  }

  private exactErrorCode(): RelayErrorCode | null {
    if (this.error === null) return null;
    if (this.errorCode !== "pass_required") return this.errorCode;
    // no account service to ask (turned off or unusable), or a relay that is not Ovis's: waiting brings no pass
    if (!this.passKeeper || this.options.accountService instanceof Error) return "pass_unsupported";
    switch (this.passKeeper.state) {
      case "no_account": return "pass_required";
      case "not_listed": return "pass_not_listed";
      case "limit": return "pass_limit";
      case "unavailable": return "pass_unavailable";
      // a pass is held and the relay refused it: a key it does not trust, a PC it revoked, clocks far apart
      case "ok": return "pass_refused";
    }
  }

  private relayAccountPath(): string { return join(this.options.stateDir, "relay", "account.json"); }

  /** The account a relay pass is asked for under: this PC's members' account, else the one its signed-in owner named. */
  private passAccount(): string | null {
    return this.services?.devices.account() ?? this.savedRelayAccount();
  }

  /**
   * The account this PC's signed-in owner named for it (setRelayAccount), or null for none. While the PC has no
   * member it is also the account its first member comes from (server/account/records.ts applyLink), and the relay
   * tab's QR code is made only once one is named (offer).
   */
  savedRelayAccount(): string | null {
    try {
      const saved: unknown = JSON.parse(readFileSync(this.relayAccountPath(), "utf8"));
      return isJsonObject(saved) && typeof saved.account === "string" && ACCOUNT_ID.test(saved.account) ? saved.account : null;
    } catch { return null; }
  }

  /** The account a signed-in owner listed this PC under: a relay pass is asked for under it while the PC has no members. */
  setRelayAccount(account: string): boolean {
    if (!ACCOUNT_ID.test(account)) return false;
    const before = this.passAccount(), named = this.savedRelayAccount();
    writePrivateState(this.relayAccountPath(), { account });
    // a device that waits under the relay tab's QR code is taken only into the account named when that code was made,
    // and only while that account is the one named (records.ts look); naming another in place of the one read here also
    // ends that code and its rows at once
    if (named !== null && named !== account) this.services?.devices.endNoAccountPairing();
    const unlisted = this.passKeeper?.current() === null && this.passKeeper.refusal === "not_listed";
    if (before !== this.passAccount() || unlisted) void this.passKeeper?.refresh();
    return true;
  }

  /**
   * Forgets the account named for this PC, as before any was (`ovis join` that ended unbound puts back what it found).
   * A no-account code made under the one named ends, as naming another ends it.
   */
  clearRelayAccount(): void {
    const before = this.passAccount(), named = this.savedRelayAccount();
    rmSync(this.relayAccountPath(), { force: true });
    if (named !== null) this.services?.devices.endNoAccountPairing();
    if (before !== this.passAccount()) void this.passKeeper?.refresh();
  }

  /** Whether `relay` is one of Ovis's own: the only relays a pass goes to. */
  private isOvisRelay(relay: string | null): boolean {
    return relay !== null && this.ovisRelays.includes(relay);
  }

  /**
   * Whether a pass the account service `issuer` signed may go to `relay`: the production service's to Ovis's production
   * relays, the staging service's to the staging relay, and nobody else's anywhere (tests name the relays they take).
   */
  private takes(relay: string | null, issuer: string | null): boolean {
    if (relay === null || issuer === null) return false;
    if (this.options.ovisRelays) return this.options.ovisRelays.includes(relay);
    const key = originKey(issuer);
    if (key !== null && key === PRODUCTION_SERVICE) return relay === GLOBAL_RELAY || REGIONAL_RELAYS.includes(relay);
    return key !== null && key === STAGING_SERVICE && relay === this.stagingRelay;
  }

  /**
   * The pass `relay` gets: the one held, when its own service's passes go there. With `honored`, the one that relay
   * may still hold this PC to, which lasts a little longer than it is sent (RelayPassKeeper honored): never sent.
   */
  private passFor(relay: string | null, honored = false): string | null {
    const keeper = this.passKeeper;
    const pass = (honored ? keeper?.honored() : keeper?.current()) ?? null;
    return pass !== null && keeper && this.takes(relay, keeper.issuer()) ? pass : null;
  }

  private startPass(identity: RelayIdentity): void {
    const service = this.options.accountService;
    // a pass goes only to Ovis's own relays, and only from an account service that can be used
    if (service === undefined || !this.isOvisRelay(this.relay)) return;
    this.passKeeper = new RelayPassKeeper({
      stateDir: this.options.stateDir, identity: () => this.identity ?? identity, account: () => this.passAccount(), service,
      ...(this.options.accountFetch ? { fetch: this.options.accountFetch } : {}), ...(this.options.passClock ? { clock: this.options.passClock } : {}),
      onPass: (pass) => {
        // the relay takes a renewal on the open control socket without a word: a notice that the pass was missing is over
        if (this.passNotice !== null && this.passNotice.state !== "ok") this.passNotice = { ...this.passNotice, state: "ok" };
        if (this.passFor(this.relay) === pass) this.link?.renewPass(pass);
        if (this.passFor(this.regionalRelay) === pass) this.regionalLink?.renewPass(pass); },
    });
    this.passKeeper.start();
  }

  private passOptions(relay: string, global: boolean): Pick<RelayLinkOptions, "pass" | "honoredPass" | "onPassNotice" | "onPassRefused"> {
    // a relay that is not Ovis's (a regional one named otherwise) never gets the pass
    if (!this.isOvisRelay(relay)) return {};
    return {
      pass: () => this.passFor(relay),
      honoredPass: () => this.passFor(relay, true),
      onPassNotice: (notice) => {
        if (global) { this.passNotice = notice; this.passRefused = false; }
        // the relay does not take the pass this PC sent (in grace it still lets the PC in): ask for a new one
        if (notice?.state === "invalid" || notice?.state === "expired") void this.passKeeper?.rejected();
      },
      onPassRefused: () => { this.passRefused = true; void this.passKeeper?.rejected(); },
    };
  }

  private directPath(): string { return join(this.options.stateDir, "relay", "direct.json"); }

  private directEnabled(): boolean {
    if (this.directOn === undefined) {
      // only a person's choice is ever written (setDirect), so no file is no choice: off, for a new install and for one
      // that only had the old default (on). A choice that cannot be read is taken as off, so a damaged file never opens
      // the network
      let text: string | undefined;
      try { text = readFileSync(this.directPath(), "utf8"); }
      catch (error) { if (!(isJsonObject(error) && error.code === "ENOENT")) text = ""; }
      if (text === undefined) this.directOn = false;
      else {
        let saved: unknown;
        try { saved = JSON.parse(text); } catch { saved = null; }
        this.directOn = isJsonObject(saved) && saved.on === true;
        if (!(isJsonObject(saved) && typeof saved.on === "boolean")) console.error("Direct connections are off: relay/direct.json cannot be read; turn them on again in Settings.");
      }
    }
    return this.directOn;
  }

  get directAvailable(): boolean { return this.options.direct !== undefined && (this.services?.options.profile !== "machine" || MACHINE_DIRECT_CARRIER_ENABLED); }

  /** Turns direct connections on this PC's networks on or off, kept across restarts; off ends every direct session. */
  async setDirect(on: boolean): Promise<RelayStatus> {
    if (!this.directAvailable) throw new Error("Direct connections are not available on this server.");
    writePrivateState(this.directPath(), { on });
    this.directOn = on;
    if (!on) await this.stopDirect();
    else if (this.link && this.identity && this.services) {
      this.startDirect(this.services, this.identity);
      await this.directStarting;
    }
    return this.status();
  }

  private startDirect(services: RequestServices, identity: RelayIdentity): void {
    if (!this.options.direct || !this.directAvailable || this.directCarrier || !this.directEnabled()) return;
    this.directCarrier = new DirectCarrier({ ...this.options.direct, identity, services, port: this.port, sessions: this.signedIn,
      ...(this.options.clock ? { clock: this.options.clock } : {}), ...(this.options.serverVersion ? { serverVersion: this.options.serverVersion } : {}),
      ...(this.options.minSupportedClient ? { minSupportedClient: this.options.minSupportedClient } : {}) });
    this.directStarting = this.directCarrier.start();
  }

  private stopDirect(): Promise<void> {
    const direct = this.directCarrier;
    this.directCarrier = undefined;
    return direct?.stop() ?? Promise.resolve();
  }

  private directCarriers(tailnet: boolean): readonly string[] { return this.directCarrier?.advertised(tailnet) ?? []; }

  private regionPath(): string { return join(this.options.stateDir, "relay", "region.json"); }

  private async chooseRegion(signal: AbortSignal): Promise<{ relay: string; save: boolean } | null> {
    if (this.pinned) return { relay: this.pinned, save: false };
    try {
      const saved: unknown = JSON.parse(readFileSync(this.regionPath(), "utf8"));
      if (isJsonObject(saved) && typeof saved.relay === "string" && this.regionalRelays.includes(saved.relay)) return { relay: saved.relay, save: false };
    } catch {}
    const probe = this.options.probe ?? probeRelay;
    const [global, ...regional] = await Promise.all([this.relay, ...this.regionalRelays].map((relay) => probe(relay, signal)));
    let chosen: string | null = null;
    let fastest = Infinity;
    for (const [index, rtt] of regional.entries()) {
      if (rtt !== null && rtt < fastest) { chosen = this.regionalRelays[index]!; fastest = rtt; }
    }
    if (chosen === null || global == null || fastest > global * REGIONAL_SHARE) return null;
    return { relay: chosen, save: true };
  }

  private startRegional(link: RelayLink, services: RequestServices, identity: RelayIdentity): void {
    if (this.regionalRelays.length === 0) return;
    this.measuring = new AbortController();
    void this.chooseRegion(this.measuring.signal).catch(() => null).then((choice) => {
      if (!choice || this.link !== link || this.regionalLink) return;
      const { relay } = choice;
      if (choice.save) try { writePrivateState(this.regionPath(), { relay }); } catch {}
      const regional = new RelayLink({
        relay, identity, services, port: this.port, ...this.passOptions(relay, false),
        connect: this.options.connect, clock: this.options.clock, random: this.options.random, serverVersion: this.options.serverVersion,
        minSupportedClient: this.options.minSupportedClient,
        relayHints: () => this.relayHints(), directCarriers: (tailnet) => this.directCarriers(tailnet), sessions: this.signedIn,
        onState: (phase) => { if (this.regionalLink === regional) this.regionalPhase = phase; },
      });
      this.regionalLink = regional;
      this.regionalRelay = relay;
      this.regionalPhase = "connecting";
      regional.start();
    });
  }

  /** Whether this PC's relay switch was ever set (start or stop saved it): an Ovis installed over SSH never set it. */
  switchSet(): boolean {
    return existsSync(join(this.options.stateDir, "relay", "state.json"));
  }

  /** Boot never enables a missing or damaged state file and never replaces a damaged identity. */
  resume(services: RequestServices, port: number): void {
    this.services = services;
    this.port = port;
    // "revoke all" ends what the owner had invited too, not only the devices already let in
    this.stopRevokeAll?.();
    this.stopRevokeAll = services.devices.onRevokeAll(() => this.approvals.closeWindow());
    this.blocked = services.serveOnly ? "serve_only" : null;
    try {
      let saved: unknown;
      try { saved = JSON.parse(readFileSync(join(this.options.stateDir, "relay", "state.json"), "utf8")); }
      catch (error) {
        if (isJsonObject(error) && error.code === "ENOENT") return;
        throw new Error("Could not read saved relay state.");
      }
      if (!isJsonObject(saved) || typeof saved.enabled !== "boolean") throw new Error("Saved relay state is invalid.");
      if (saved.enabled) this.start();
    } catch (error) { this.failed(error); }
  }

  private failed(error: unknown): void {
    this.phase = this.link ? "error" : "off";
    this.error = error instanceof RelayIdentityError ? error.message : "Could not start the relay.";
    this.errorCode = error instanceof RelayIdentityError ? "identity_unreadable" : "start_failed";
    if (error instanceof RelayIdentityError) this.blocked = "identity_unreadable";
  }

  start(): RelayStatus {
    const services = this.services;
    if (!services || this.shuttingDown) throw new Error("Relay service is not available.");
    if (this.resetting) throw new Error("Relay identity reset is in progress.");
    if (services.serveOnly) { this.blocked = "serve_only"; return this.status(); }
    if (this.link) return this.status();
    try {
      this.identity = loadRelayIdentity(this.options.stateDir);
      // Authorization reaches disk before the first outbound socket.
      if (services.token === "") services.devices.closeGate();
      writePrivateState(join(this.options.stateDir, "relay", "state.json"), { enabled: true });
      this.enabled = true;
      this.blocked = null;
      this.error = null;
      this.phase = "connecting";
      this.startPass(this.identity);
      const link = new RelayLink({
        relay: this.relay, identity: this.identity, services, port: this.port, ...this.passOptions(this.relay, true),
        connect: this.options.connect, clock: this.options.clock, random: this.options.random, serverVersion: this.options.serverVersion,
        minSupportedClient: this.options.minSupportedClient,
        relayHints: () => this.relayHints(), directCarriers: (tailnet) => this.directCarriers(tailnet), sessions: this.signedIn,
        onState: (phase, error, code) => { if (this.link === link) { this.phase = phase; this.error = error; this.errorCode = code ?? null; } },
      });
      this.link = link;
      link.start();
      this.startDirect(services, this.identity);
      this.startRegional(link, services, this.identity);
    } catch (error) { this.failed(error); }
    return this.status();
  }

  get linked(): boolean { return this.link !== undefined; }

  private disconnect(): Promise<void> {
    const link = this.link;
    const regional = this.regionalLink;
    this.link = undefined;
    this.regionalLink = undefined;
    this.regionalPhase = "off";
    this.regionalRelay = null;
    this.measuring?.abort();
    this.measuring = undefined;
    this.phase = "off";
    this.error = null;
    this.passKeeper?.stop();
    this.passKeeper = undefined;
    this.passNotice = null;
    this.passRefused = false;
    // a code names this PC's key: it goes with the link
    this.pairCodes?.cancel();
    this.ending = Promise.all([this.ending, link?.stop(), regional?.stop(), this.stopDirect()]).then(() => undefined);
    return this.ending;
  }

  async stop(): Promise<RelayStatus> {
    writePrivateState(join(this.options.stateDir, "relay", "state.json"), { enabled: false });
    this.enabled = false;
    // turned off by the owner, unlike shutdown(): the window does not wait for the relay to come back
    this.approvals.closeWindow();
    await this.disconnect();
    return this.status();
  }

  shutdown(): Promise<void> {
    this.shuttingDown = true;
    return this.disconnect();
  }

  private offerFor(code: string): RelayOffer {
    const name = hostname().slice(0, 64);
    return { v: 1, server_id: this.identity!.server_id, server_public_key: this.identity!.public_key,
      relay: this.advertised, code, ...(name ? { name } : {}), ...this.admissionMark(code) };
  }

  /** The mark of an offer whose code lets a device in only on its account's word (shared/relay-offer.ts `admission`). */
  private admissionMark(code: string): { admission?: 1 } {
    return this.services?.devices.isPinnedCode(code) ? { admission: 1 } : {};
  }

  /**
   * A code to type on the device being paired (server/relay/pair-code.ts), replacing any showing; null
   * when this PC's relay has none (it is not Ovis's own). `account`: the code is made for it (DeviceStore.startAccountPairing),
   * and a PC in an account refuses that before the relay is asked (PcInAccountError). The machine profile makes no
   * code without it (MachineCodeForAccountError), whoever calls; routes.ts answers that before the relay's state.
   */
  async pairCode(by: string | null = null, account?: string): Promise<({ code: string; expires_at: string; server_id: string } & Partial<AccountPairing>) | null> {
    if (!this.enabled || !this.identity || !this.services || this.blocked) throw new Error("Start the relay before pairing.");
    if (account === undefined && this.services.options.profile === "machine") throw new MachineCodeForAccountError();
    if (account !== undefined && this.services.devices.account() !== null) throw new PcInAccountError();
    if (account !== undefined && this.services.accountMailbox.serviceOff()) throw new AccountServiceOffError();
    const relay = this.options.pairCodeRelay ?? (this.relay === GLOBAL_RELAY ? GLOBAL_RELAY : null);
    if (relay === null) return null;
    // the typed code's host carries a pass as the links do: only one its own service's passes go to this relay
    this.pairCodes ??= new RelayPairCodes({ relay, devices: this.services.devices, offer: (code) => this.offerFor(code), identity: () => this.identity!, connect: this.options.connect,
      pass: () => this.passFor(relay) });
    return { ...await this.pairCodes.mint(by, account), server_id: this.identity.server_id };
  }

  cancelPairCode(): void {
    this.pairCodes?.cancel();
  }

  /**
   * `by`: the paired device that asked, null for this PC itself. It holds the code the offer carries, started here or pending already.
   * `noAccountOnly`: the offer is to put this PC in an account (the relay tab's QR code): none is made for a PC that is
   * in one (PcInAccountError), and its code ends when the PC joins one (DeviceStore.pairingForNoAccount). No other
   * offer carries that code (DeviceStore.pairingForOffer). A device that pairs with it is taken into the account
   * named for this PC and into no other, so none is made while no account is named either (NoAccountNamedError):
   * no code is started, and the one pending stays as it was.
   * `account`: the offer's code is made for that account (DeviceStore.pairingForAccount), whatever account was named
   * for this PC, and the answer says so; `noAccountOnly` is not asked with it. The machine profile makes no offer
   * without it (MachineCodeForAccountError), whoever calls, and the code pending stays as it was; routes.ts answers
   * that before the relay's state.
   * `pairing`: the id of the code pending to carry (`new`: a fresh one), for every offer but the relay tab's
   * (DeviceStore.pairingForAccount): an id no longer pending starts no code (PairingGoneError), and the one pending
   * stays as it was. The answer names the code it carries by its id (`pairing.id`).
   * The answer to an offer asked for with `noAccountOnly` also names, as `account`, the account named for this PC as its
   * code was made, the one a device that pairs with it is taken into (the relay tab lists the PC there, and only there,
   * beside the QR code).
   */
  offer(by: string | null = null, options: { noAccountOnly?: boolean; account?: string; pairing?: string } = {}): { url: string; expires_at: string; pairing: { id: string }; account?: string | null } & Partial<AccountPairing> {
    if (!this.enabled || !this.identity || !this.services || this.blocked) throw new Error("Start the relay before pairing.");
    if (options.account === undefined && this.services.options.profile === "machine") throw new MachineCodeForAccountError();
    const devices = this.services.devices;
    // read once: the account that allows the relay tab's code, binds it (pairingForNoAccount) and is named in the answer
    const saved = options.noAccountOnly ? this.savedRelayAccount() : null;
    // a PC that is in an account says so itself (pairingForNoAccount)
    if (options.noAccountOnly && devices.account() === null && saved === null) throw new NoAccountNamedError();
    // a PC in an account says so itself (pairingForAccount, pairingForNoAccount)
    if ((options.account !== undefined || options.noAccountOnly) && devices.account() === null && this.services.accountMailbox.serviceOff()) throw new AccountServiceOffError();
    const { code, expires_at, ...named } = options.account !== undefined ? devices.pairingForAccount(options.account, by, Date.now(), options.pairing)
      : options.noAccountOnly ? devices.pairingForNoAccount(by, Date.now(), saved ?? undefined) : devices.pairingForOffer(by, Date.now(), options.pairing);
    const id = devices.pairingId()!;
    // before the code leaves this PC: a device revoked by now is handed none (DeviceGoneError)
    if (by !== null) devices.holdPairing(by);
    return {
      url: encodeOffer({ v: 1, server_id: this.identity.server_id, server_public_key: this.identity.public_key,
        relay: this.advertised, code, ...offerName(), ...this.admissionMark(code) }, this.app),
      expires_at, pairing: { id }, ...named,
      ...(options.noAccountOnly ? { account: saved } : {}),
    };
  }

  /**
   * A pairing link without a code: the phone that opens it pairs by comparing six digits with this
   * PC, and the owner approves it here (server/relay/session.ts). It holds nothing secret; asking for it
   * opens the window in which this PC takes comparisons (pairing-approvals.ts PAIRING_WINDOW_MS).
   */
  pairingLink(options: { localOnly?: boolean } = {}): { url: string; window_id: string } {
    if (!this.enabled || !this.identity || !this.services || this.blocked) throw new Error("Start the relay before pairing.");
    const window_id = this.approvals.openWindow(Date.now(), options);
    return { window_id, url: encodeOffer({ v: 1, server_id: this.identity.server_id, server_public_key: this.identity.public_key, relay: this.advertised, ...offerName() }, this.app) };
  }

  /**
   * `removed`: the reset a person confirmed to add a PC its account's list removed again, as a new PC. It resets the
   * relay identity it names, of a PC that list removed and that is in no account, and nothing else: asked first, and
   * again in the turn that resets, with no wait in between (ResetNotAskedError).
   */
  async resetIdentity(removed?: { readonly account: string; readonly server_id: string }): Promise<RelayStatus> {
    const services = this.services;
    if (!services || this.shuttingDown) throw new Error("Relay service is not available.");
    if (services.serveOnly) { this.blocked = "serve_only"; return this.status(); }
    // Close old admissions before revoking or replacing the key they authenticated against.
    if (services.devices.error !== null) throw new ResetRegistryUnavailableError();
    if (this.resetting) throw new Error("Relay identity reset is in progress.");
    const asked = (): ResetNotAskedError | null => {
      if (removed === undefined) return null;
      if (this.currentIdentity()?.server_id !== removed.server_id) return new ResetNotAskedError("identity_changed");
      const stands = services.devices.readdReset(removed.account, removed.server_id);
      return stands === "removed" ? null : new ResetNotAskedError(stands);
    };
    const early = asked();
    if (early !== null) throw early;
    this.resetting = true;
    let refused: ResetNotAskedError | null = null;
    try {
      // a window opened for the old key's link does not carry over to the new key
      this.approvals.closeWindow();
      // nor does a code its offers carried: it ends, and the rows that wait to link under it, so an approval asked
      // under the old identity writes no member after the new one
      services.devices.endPairing();
      await this.disconnect();
      // the PC may have joined an account while its relay closed: what the reset is for is asked again in this turn
      refused = asked();
      if (refused === null) this.resetNow(services);
    } finally { this.resetting = false; }
    // a reset that was not made leaves the relay as it found it: running again
    const status = this.enabled ? this.start() : this.status();
    if (refused !== null) throw refused;
    return status;
  }

  /** The reset itself, in the turn that asked whether it is still wanted: nothing is awaited here. */
  private resetNow(services: RequestServices): void {
    for (const device of services.devices.list(null)) if (device.via_relay) services.devices.revoke(device.id);
    // a new relay identity is a new PC to the account: the binding of the old one is cleared (P12, T59)
    services.devices.clearAccountBinding("identity_reset", "pc");
    this.identity = rotateRelayIdentity(this.options.stateDir);
    // a new relay identity is a new PC to the account's signed list too: the keys of the old one go with it
    forgetListKeys(this.options.stateDir);
    forgetList(this.options.stateDir);
    this.blocked = null;
  }
}
