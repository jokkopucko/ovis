/**
 * The account service as this client calls it (docs/account.md, "Account service API"): the
 * directory of the account's PCs, and the tokens a sign-in gives. Answers are parsed here, at the
 * edge; a token is never logged or put in an error's text.
 */
import { accountLabel, accountOsOf, type AccountAsker, type AccountOs } from "../../../shared/account-asker.ts";
import type { AccountLimits } from "../../../shared/protocol.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { newRecordId, registerSigningBytes, type AccountRecord, type DeviceSafetyRecord } from "../../../shared/account-records.ts";
import { isWssOrigin } from "../../../shared/relay-offer.ts";
import { toBase64Url } from "../../../shared/relay-pair-sas.ts";
import { GLOBAL_APP } from "../../../shared/relay-regions.ts";
import type { AccountLock, AccountProvider, AccountSession, AccountStore } from "./store.ts";
import { ACCOUNT_PROVIDERS, accountLock, indexedAccountStore } from "./store.ts";

/**
 * The account service this page signs in with, from `<meta name="ovis-account-service">`: an https
 * origin, or http on loopback for a local test. None, or one that is neither, and the page offers
 * no sign-in at all, so a build is never left with buttons for a service it cannot reach.
 */
export function accountServiceOf(document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null }): string | null {
  const content = document.querySelector('meta[name="ovis-account-service"]')?.getAttribute("content");
  if (!content) return null;
  let url: URL;
  try { url = new URL(content); } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  return url.protocol === "https:" || (url.protocol === "http:" && loopback) ? url.origin : null;
}

/**
 * The account service the hosted shell signs in with: the page's (accountServiceOf), but in a browser
 * only on app.ovis.sh. The service sends a browser back to `<origin>/` for that origin alone, so a
 * copy served anywhere else (the regional app beside a relay, a preview, a local test run) offers
 * no sign-in rather than one the service refuses; the phone app comes back through its own scheme.
 */
export function shellAccountServiceOf(document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null }, origin: string, nativeApp: boolean): string | null {
  return nativeApp || origin === GLOBAL_APP ? accountServiceOf(document) : null;
}

/**
 * The account service a PC's own page signs in with (GitHub's device flow, lib/account/deviceSignIn.ts),
 * from `<meta name="ovis-pc-account-service">`, which only the PC's server writes (server/static.ts):
 * an https origin, and only on a secure page, where WebCrypto works and no one on the network could
 * have rewritten the script that holds the sign-in. The hosted shell has its own meta and redirect.
 */
export function pcAccountServiceOf(document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null }, secure: boolean): string | null {
  const content = document.querySelector('meta[name="ovis-pc-account-service"]')?.getAttribute("content");
  if (!secure || !content) return null;
  // new URL in a try: an older WebView has no URL.canParse
  try {
    const url = new URL(content);
    return url.protocol === "https:" ? url.origin : null;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

export function accountProvidersOf(document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null }): AccountProvider[] {
  const named = new Set((document.querySelector('meta[name="ovis-account-providers"]')?.getAttribute("content") ?? "").split(",").map((name) => name.trim()));
  const offered = ACCOUNT_PROVIDERS.filter((provider) => named.has(provider));
  return offered.length > 0 ? offered : ["github"];
}

export const DEVICE_PROVIDERS = ["github", "google"] as const;
export type DeviceProvider = (typeof DEVICE_PROVIDERS)[number];

export interface OfferedProviders {
  readonly providers: AccountProvider[];
  /** What the service's answer named, none included; null when it gave none to read (`providers` is then the build's) */
  readonly listed: AccountProvider[] | null;
  readonly device: DeviceProvider[];
  readonly page: DeviceProvider[];
}

export async function offeredProviders(service: string, fallback: readonly AccountProvider[], options: { fetch?: Fetch } = {}): Promise<OfferedProviders> {
  const before: OfferedProviders = { providers: [...fallback], listed: null, device: ["github"], page: [] };
  let body: unknown;
  try {
    const response = await (options.fetch ?? fetch)(new URL("/v1/providers", service));
    if (!response.ok) return before;
    body = await response.json();
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError) return before;
    throw error;
  }
  if (!isRecord(body) || !Array.isArray(body.providers) || !Array.isArray(body.device)) return before;
  const named = new Set<unknown>(body.providers);
  const providers = ACCOUNT_PROVIDERS.filter((provider) => named.has(provider));
  if (providers.length === 0) return { ...before, listed: [] };
  const device = new Set<unknown>(body.device);
  const page = new Set<unknown>(Array.isArray(body.device_page) ? body.device_page : []);
  return {
    providers,
    listed: providers,
    device: DEVICE_PROVIDERS.filter((provider) => device.has(provider) && named.has(provider)),
    page: DEVICE_PROVIDERS.filter((provider) => page.has(provider) && named.has(provider)),
  };
}

/** One way the account signs in (`GET /v1/identities`); the service keeps no email or login to name it by. */
export interface AccountIdentity {
  readonly provider: AccountProvider;
  readonly added_at: string;
}

/** A refresh this long before the access token runs out, so a request never leaves with one about to. */
const REFRESH_EARLY_MS = 60_000;

/** `retryAfterMs`: the wait the answer's `retry-after` named (a 429's), or null without one. */
export class AccountServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterMs: number | null = null) {
    super(message);
    this.name = "AccountServiceError";
  }
}

/**
 * The access token's refresh failed before the request it was for went out: the service has not answered that
 * request, so its error is no refusal of it (a refused refresh that ends the sign-in is a SignedOutError instead).
 */
export class AccountRefreshError extends AccountServiceError {
  constructor(from: AccountServiceError) {
    super(from.status, from.code, from.message, from.retryAfterMs);
    this.name = "AccountRefreshError";
  }
}

/**
 * A request to the account service got no answer at all: the connection dropped under it, or the network was down or
 * changed. Any HTTP answer is an AccountServiceError (or a sign-out) instead. Still a TypeError, as fetch's own failure is.
 */
export class AccountServiceUnreachableError extends TypeError {
  constructor(options: { readonly cause: unknown }) {
    super("The account service could not be reached", options);
    this.name = "AccountServiceUnreachableError";
  }
}

/**
 * How a request is sent again (relay/networkRetry.ts): `sends` HTTP sends in all, the first included; `before` runs
 * immediately before each (its number, from 1), after any token refresh, and ends the request by throwing; `wait` runs
 * after a send that got no answer or a 429, and says whether the next goes.
 */
export interface SendAgain {
  readonly sends: number;
  readonly before: (send: number) => Promise<void>;
  readonly wait: (error: AccountServiceError | AccountServiceUnreachableError, sent: number) => Promise<boolean>;
}

/** The sign-in is gone (revoked, expired past refresh, or never made): the client is signed out. */
export class SignedOutError extends Error {
  readonly code = "signed_out";
  constructor() {
    super("Sign in to your account again");
    this.name = "SignedOutError";
  }
}

export const UNNAMED_DEVICE = "Device";

export interface Admission extends AccountAsker { readonly key: string; readonly label: string; readonly server_id: string; readonly at: string }

export interface DirectoryPc {
  readonly server_id: string;
  readonly label: string;
  readonly added_at: string;
  /** absent from an old service, which has no refresh route; null when the service sent one that is unusable */
  readonly listing_id?: string | null;
  readonly invited_at?: string;
  readonly last_seen_at: string | null;
  /** the PC's relay key (X25519, 64 hex) and relay, to compare digits with it; null from an entry without them */
  readonly public_key: string | null;
  readonly relay: string | null;
  /**
   * Until when a PC added in one press is new to the account (docs/account.md, "One press"): this device opens it only by
   * hand meanwhile. Null for any other PC, and once that time has passed.
   */
  readonly new_until: string | null;
  /** when the PC was added in one press (kept after its 24 hours), or null */
  readonly admitted_at: string | null;
  /** the PC was added in one press under the first-PC exemption before this device joined: nobody was told of it */
  readonly admitted_before_you: boolean;
}

type Fetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

const SERVER_ID = /^[0-9a-f]{32}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The service's error code only: its message is the service's text, which could echo a token, so it is never kept. */
export async function failure(response: Response): Promise<AccountServiceError> {
  let code = "http_error";
  try {
    const body: unknown = await response.json();
    const error = isRecord(body) && isRecord(body.error) ? body.error : null;
    if (typeof error?.code === "string" && /^[a-z_]{1,40}$/.test(error.code)) code = error.code;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return new AccountServiceError(response.status, code, `The account service answered ${response.status} (${code})`, retryAfterMs(response.headers.get("retry-after")));
}

/** A `retry-after` in delay-seconds or as an HTTP date, in ms from now; null without one either reads. */
function retryAfterMs(header: string | null): number | null {
  if (header === null || header.trim() === "") return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

export function parseAccountLimits(value: unknown): AccountLimits | null {
  if (!isRecord(value)) return null;
  const { plan, pcs_max, pcs_used, data_cap_bytes, data_used_bytes, data_metering, until } = value;
  if (typeof plan !== "string" || plan.trim() === "") return null;
  if (typeof pcs_max !== "number" || !Number.isSafeInteger(pcs_max) || pcs_max < 0) return null;
  if (pcs_used !== undefined && pcs_used !== null && (typeof pcs_used !== "number" || !Number.isSafeInteger(pcs_used) || pcs_used < 0)) return null;
  if (data_cap_bytes !== undefined && data_cap_bytes !== null && (typeof data_cap_bytes !== "number" || !Number.isSafeInteger(data_cap_bytes) || data_cap_bytes < 0)) return null;
  if (data_used_bytes !== undefined && data_used_bytes !== null && (typeof data_used_bytes !== "number" || !Number.isSafeInteger(data_used_bytes) || data_used_bytes < 0)) return null;
  if (until !== undefined && until !== null && (typeof until !== "number" || !Number.isFinite(until))) return null;
  const metered = data_metering === undefined || data_metering === "on";
  return {
    plan: plan.trim().length > 32 ? `${plan.trim().slice(0, 31)}…` : plan.trim(),
    pcs_max,
    ...(typeof pcs_used === "number" ? { pcs_used } : {}),
    ...(typeof data_cap_bytes === "number" ? { data_cap_bytes } : {}),
    ...(metered && typeof data_used_bytes === "number" ? { data_used_bytes } : {}),
    ...(until !== undefined ? { until: until ?? null } : {}),
  };
}

function parsePc(value: unknown): DirectoryPc | null {
  if (!isRecord(value) || typeof value.server_id !== "string" || !SERVER_ID.test(value.server_id)) return null;
  if (typeof value.label !== "string" || typeof value.added_at !== "string") return null;
  if (value.last_seen_at !== null && typeof value.last_seen_at !== "string") return null;
  const public_key = typeof value.public_key === "string" && /^[0-9a-f]{64}$/.test(value.public_key) ? value.public_key : null;
  const relay = typeof value.relay === "string" && isWssOrigin(value.relay) ? value.relay : null;
  const new_until = typeof value.new_until === "string" && !Number.isNaN(Date.parse(value.new_until)) ? value.new_until : null;
  const admitted_at = typeof value.admitted_at === "string" && !Number.isNaN(Date.parse(value.admitted_at)) ? value.admitted_at : null;
  const listing_id = "listing_id" in value ? (typeof value.listing_id === "string" && SERVER_ID.test(value.listing_id) ? value.listing_id : null) : undefined;
  const invited_at = typeof value.invited_at === "string" && !Number.isNaN(Date.parse(value.invited_at)) ? value.invited_at : undefined;
  return { server_id: value.server_id, label: value.label, added_at: value.added_at, last_seen_at: value.last_seen_at, public_key, relay, new_until, admitted_at, admitted_before_you: admitted_at !== null && value.admitted_before_you === true,
    ...(listing_id === undefined ? {} : { listing_id }), ...(invited_at === undefined ? {} : { invited_at }) };
}

export function sessionOf(body: unknown, service: string, now: number): AccountSession {
  if (!isRecord(body)) throw new AccountServiceError(502, "invalid_answer", "The account service sent no sign-in");
  const { access_token, refresh_token, expires_in, account, provider } = body;
  if (typeof access_token !== "string" || access_token === "" || typeof refresh_token !== "string" || refresh_token === ""
    || typeof expires_in !== "number" || !(expires_in > 0) || typeof account !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(account)
    || !ACCOUNT_PROVIDERS.includes(provider as AccountProvider)) {
    throw new AccountServiceError(502, "invalid_answer", "The account service sent an incomplete sign-in");
  }
  return { service, account, provider: provider as AccountProvider, access_token, refresh_token, expires_at: now + expires_in * 1000, sign_in_id: newRecordId() };
}

/** The id of a sign-in saved without one: a digest of the refresh token it was saved with, the same in every tab. */
function legacySignInId(refreshToken: string): string {
  return `saved-${bytesToHex(sha256(utf8ToBytes(refreshToken)).subarray(0, 16))}`;
}

export function sameSignIn(a: AccountSession, b: AccountSession): boolean {
  return a.refresh_token === b.refresh_token || (a.sign_in_id !== undefined && a.sign_in_id === b.sign_in_id);
}

/** `POST /v1/token`: a code, a refresh token or a native Apple token for a session; `bearer` redeems a linking sign-in. */
export async function requestToken(service: string, grant: Record<string, string>, options: { fetch?: Fetch; now?: () => number; bearer?: string } = {}): Promise<AccountSession> {
  const now = options.now ?? Date.now;
  const response = await (options.fetch ?? fetch)(new URL("/v1/token", service), {
    // a redirect target's answer is never this grant's (see AccountService's fetch)
    redirect: "error",
    method: "POST", headers: { "content-type": "application/json", ...(options.bearer === undefined ? {} : { authorization: `Bearer ${options.bearer}` }) }, body: JSON.stringify(grant),
  });
  if (!response.ok) throw await failure(response);
  return sessionOf(await response.json(), service, now());
}

export interface AccountServiceOptions {
  readonly store: AccountStore;
  readonly fetch?: Fetch;
  readonly now?: () => number;
  readonly lock?: AccountLock;
  readonly signIn?: AccountSession;
}

/**
 * Calls on the signed-in account. An access token about to run out is refreshed first; a refused
 * refresh, or a 401 after one, signs this client out (the stored session goes) and throws
 * SignedOutError. PC pairings are untouched: they never depended on the sign-in.
 *
 * Refresh tokens rotate and a second use ends the whole sign-in, so one refresh runs at a time
 * between tabs (the lock), and a refresh stores its answer only over the session it started from:
 * another tab's refresh, a sign-out or a new sign-in meanwhile wins.
 */
export class AccountService {
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly lock: AccountLock;

  constructor(private readonly options: AccountServiceOptions) {
    const send: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
    // fetch fails with a TypeError only when no answer came (an abort is a DOMException, and passes as it is); a redirect
    // is never followed, so a redirect target's answer never stands in for this endpoint's own: it fails, as no answer
    this.fetch = (input, init) => send(input, { ...init, redirect: "error" }).catch((error: unknown) => {
      throw error instanceof TypeError ? new AccountServiceUnreachableError({ cause: error }) : error;
    });
    this.now = options.now ?? Date.now;
    this.lock = options.lock ?? accountLock;
  }

  /**
   * The stored sign-in. One saved before sign-ins had an id (`sign_in_id`) gets one here, in the store: without it
   * its first refresh, which changes the refresh token, would make every copy read before it another sign-in
   * (sameSignIn), and a call bound to such a copy (forSignIn) would then refuse its own sign-in.
   *
   * The id is worked out from the session itself, so tabs of this build give one sign-in the same id, and it is
   * given in the same update of the store that reads the session: a copy from here always carries the id the
   * store holds, whichever tab named it. A sign-in made meanwhile has an id of its own (sessionOf).
   */
  async session(): Promise<AccountSession | undefined> {
    // read and named in one update of the store, with no read before it: no other tab's write (a refresh, another
    // sign-in, a sign-out) falls between this tab seeing the session and naming it
    let seen: AccountSession | undefined;
    try {
      await this.options.store.update("session", (current) => {
        seen = current === undefined || current.sign_in_id !== undefined ? current : { ...current, sign_in_id: legacySignInId(current.refresh_token) };
        return seen;
      });
    } catch {
      return this.options.store.get("session");
    }
    return seen;
  }

  /**
   * This service acting only for `session`, the sign-in a person acted on: once another one is stored
   * (signed out and in again meanwhile), its calls throw SignedOutError without touching that one, and
   * its sign-out ends `session` alone.
   */
  forSignIn(session: AccountSession): AccountService {
    return new AccountService({ ...this.options, signIn: session });
  }

  async listPcs(signal?: AbortSignal, again?: SendAgain): Promise<DirectoryPc[]> {
    const body = await this.call("GET", "/v1/pcs", undefined, signal, again);
    const pcs = isRecord(body) && Array.isArray(body.pcs) ? body.pcs : null;
    if (pcs === null) throw new AccountServiceError(502, "invalid_answer", "The account service sent no PC list");
    return pcs.map(parsePc).filter((pc): pc is DirectoryPc => pc !== null);
  }

  /** Lists a PC in the account's directory, with its relay key and relay so a new device can compare digits with it. */
  async putPc(serverId: string, entry: { label: string; public_key: string; relay: string }, signal?: AbortSignal, again?: SendAgain): Promise<void> {
    await this.call("PUT", `/v1/pcs/${serverId}`, entry, signal, again);
  }

  async deletePc(serverId: string): Promise<void> {
    await this.call("DELETE", `/v1/pcs/${serverId}`);
  }

  /** Renews an invitation in place. Without a listing ID, the empty body probes for the old service's missing route. */
  async refreshPc(serverId: string, listingId: string | undefined): Promise<"refreshed" | "changed" | "legacy"> {
    try {
      const body = await this.call("POST", `/v1/pcs/${serverId}/refresh`, listingId === undefined ? {} : { listing_id: listingId });
      if (!isRecord(body) || typeof body.invited_at !== "string" || Number.isNaN(Date.parse(body.invited_at))) {
        throw new AccountServiceError(502, "invalid_answer", "The account service sent no invitation time");
      }
      return "refreshed";
    } catch (error) {
      if (error instanceof AccountServiceError) {
        if (error.status === 409 && error.code === "listing_changed") return "changed";
        if (listingId === undefined && error.status === 404 && error.code === "not_found") return "legacy";
      }
      throw error;
    }
  }

  /**
   * Admits a PC this account lists in one press, from a fresh sign-in with two-step sign-in set: the service refuses
   * anything else (`session_not_fresh`, `two_step_required`, `pc_add_cap`, or 404 where it has no such route).
   */
  async admitPc(serverId: string, signal?: AbortSignal): Promise<{ readonly account: string; readonly new_until: string }> {
    const body = await this.call("POST", `/v1/pcs/${serverId}/admit`, {}, signal);
    if (!isRecord(body) || typeof body.account !== "string" || typeof body.new_until !== "string") throw new AccountServiceError(502, "invalid_answer", "The account service sent no admission");
    return { account: body.account, new_until: body.new_until };
  }

  /**
   * Says this signed-in device waits at that PC with its account key: the account's other devices
   * hear of it, and the PC takes a comparison that asks to join the account for 10 minutes.
   * `quiet`: asks the account service to take it as a quiet admission. The service decides: it honours
   * the ask only for a sign-in made in an app itself, and takes any other as an ordinary admission; a service that
   * does not know the field ignores it.
   */
  async postAdmission(serverId: string, label: string, key: string, os: AccountOs | null = null, signal?: AbortSignal, { quiet = false }: { quiet?: boolean } = {}): Promise<void> {
    await this.call("POST", "/v1/admissions", { server_id: serverId, label, key, ...(os === null ? {} : { os }), ...(quiet ? { quiet: true } : {}) }, signal);
  }

  /**
   * The account's admissions of the last 10 minutes, straight from the account service: what a PC
   * passes on cannot change them. Each says who is asking, as far as the service knows (null each).
   */
  async recentAdmissions(): Promise<Admission[]> {
    const body = await this.call("GET", "/v1/admissions");
    const list = isRecord(body) && Array.isArray(body.admissions) ? body.admissions : [];
    return list.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.key !== "string" || typeof entry.label !== "string" || typeof entry.server_id !== "string" || typeof entry.at !== "string") return [];
      // shown on the approval card and signed into the add: one plain line; a name with nothing left
      // keeps its row (it may be the newest) under a plain stand-in
      const label = accountLabel(entry.label) || UNNAMED_DEVICE;
      const city = typeof entry.city === "string" ? accountLabel(entry.city) : "";
      const place = typeof entry.country === "string" && /^[A-Z]{2}$/.test(entry.country)
        ? { country: entry.country, city: city === "" ? null : city }
        : { country: null, city: null };
      return [{ key: entry.key, label, server_id: entry.server_id, at: entry.at, os: accountOsOf(entry.os), ...place }];
    });
  }

  /**
   * Registers `key` for this sign-in (device table T34, P18) by signing the service's single-use challenge, and
   * answers its place in the account's order. Null when the service has no such route (release off, or older):
   * the QR or digits path stays (G5). A sign-in registers one key; another key for it is refused (T40).
   */
  async registerDeviceKey(key: { readonly private_key: CryptoKey; readonly public_spki: string }): Promise<{ no: number; key: string } | null> {
    let issued: unknown;
    try { issued = await this.call("POST", "/v1/devices/challenge", {}); }
    catch (error) {
      if (error instanceof AccountServiceError && error.status === 404) return null;
      throw error;
    }
    const session = await this.session();
    if (session === undefined) return this.signedOut();
    if (!isRecord(issued) || typeof issued.challenge_id !== "string" || typeof issued.challenge !== "string") throw new AccountServiceError(502, "invalid_answer", "The account service sent no challenge");
    const bytes = registerSigningBytes(session.account, key.public_spki, issued.challenge_id, issued.challenge);
    const signature = toBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.private_key, bytes)));
    const body = await this.call("POST", "/v1/devices", { challenge_id: issued.challenge_id, key: key.public_spki, signature });
    if (!isRecord(body) || !Number.isSafeInteger(body.no) || body.key !== key.public_spki) throw new AccountServiceError(502, "invalid_answer", "The account service answered for another key");
    return { no: body.no as number, key: key.public_spki };
  }

  async limits(): Promise<AccountLimits | null> {
    const body = await this.call("GET", "/v1/account/limits");
    return parseAccountLimits(body);
  }

  async identities(): Promise<AccountIdentity[]> {
    const body = await this.call("GET", "/v1/identities");
    const list = isRecord(body) && Array.isArray(body.identities) ? body.identities : [];
    return list.filter((entry): entry is AccountIdentity => isRecord(entry) && ACCOUNT_PROVIDERS.includes(entry.provider as AccountProvider)
      && typeof entry.added_at === "string")
      .map(({ provider, added_at }) => ({ provider, added_at }));
  }

  /**
   * Adds `provider` to the signed-in account on purpose, through a redirect sign-in only (a device
   * code can be phished): the service hands a one-time link token, `signIn` runs that provider's
   * sign-in with it and redeems the code with this account's access token (`bearer`), and only then
   * does the service link it. Its session replaces the one this client had, which then ends at the
   * service. An answer for any other account is ended and refused, and the session stays as it was;
   * an identity another account already has is refused (SignInError `in_use`) and nothing changes.
   * A sign-in older than ten minutes gets 403 `reauth_required` before anything starts: the caller
   * asks the person to sign in again, then repeats. The link is redeemed by this same sign-in.
   */
  async addMethod(provider: AccountProvider, signIn: (linkToken: string, bearer: string) => Promise<AccountSession>): Promise<AccountSession> {
    const body = await this.call("POST", "/v1/identities/link", { provider });
    const linkToken = isRecord(body) && typeof body.link_token === "string" && body.link_token !== "" ? body.link_token : null;
    if (linkToken === null) throw new AccountServiceError(502, "invalid_answer", "The account service sent no link");
    const before = await this.session();
    if (before === undefined) return this.signedOut();
    const after = await signIn(linkToken, before.access_token);
    const end = (session: AccountSession, what: string) => this.fetch(new URL("/v1/signout", session.service), { method: "POST", headers: { authorization: `Bearer ${session.access_token}` } })
      .catch((error: unknown) => console.warn(`Ovis: ${what} was not ended at the account service`, error instanceof Error ? error.name : error));
    if (after.account !== before.account) {
      await end(after, "a sign-in for another account");
      throw new AccountServiceError(502, "invalid_answer", "The account service answered for another account");
    }
    // under the lock sign-out and refresh take: the answer replaces only the sign-in that asked for it
    const outcome = await this.lock(async () => {
      let result: "kept" | "moved-on" | "signed-out" = "signed-out";
      await this.options.store.update("session", (current) => {
        if (current?.refresh_token === before.refresh_token) { result = "kept"; return after; }
        // refreshed by another tab, or signed in again there: the link holds at the service, and that session stays
        if (current !== undefined && current.account === before.account) result = "moved-on";
        return current;
      });
      return result;
    });
    if (outcome === "signed-out") {
      // signed out (or into another account) meanwhile: the new sign-in must not outlive that
      await end(after, "a link that finished after a sign-out");
      throw new SignedOutError();
    }
    if (outcome === "moved-on") {
      await end(after, "a link's sign-in no tab keeps");
      return (await this.session()) ?? after;
    }
    // the old sign-in's tokens would otherwise live on at the service until they expire
    await end(before, "the replaced sign-in");
    return after;
  }

  /**
   * Removes a sign-in method; the service refuses the account's last one (409 `last_identity`), and
   * like a link wants a sign-in made in the last ten minutes (403 `reauth_required`).
   */
  async removeIdentity(provider: AccountProvider): Promise<void> {
    await this.call("DELETE", `/v1/identities/${provider}`);
  }

  /**
   * Deletes the signed-in account and everything the service keeps under it, for good. Like a change
   * to the sign-in methods it wants a sign-in made in the last ten minutes (403 `reauth_required`), and
   * the service refuses it while a subscription still renews (409 `subscription_active`). What this device
   * keeps of the deleted sign-in is forgotten by its caller (deleteAccount.ts), with `forSignIn` so that a
   * sign-in made meanwhile is never the one deleted.
   */
  async deleteAccount(): Promise<void> {
    // only the documented 204 is a completed deletion: a 202 pending, say, leaves the account (and what this device keeps) alone
    await this.call("DELETE", "/v1/account", undefined, undefined, undefined, 204);
  }

  async postRecord(serverIds: readonly string[], record: AccountRecord): Promise<number> {
    if (serverIds.length === 0) return 0;
    const body = await this.call("POST", "/v1/records", { server_ids: serverIds, record });
    return isRecord(body) && typeof body.queued === "number" ? body.queued : 0;
  }

  /**
   * Confirmed only by the committed receipt, a 200 naming the record's id: any other success (a 202 pending, say) is no
   * confirmation and throws. `ready` runs right before each send, after any token refresh, and stops it by throwing.
   */
  async postSafetyRecord(record: DeviceSafetyRecord, ready?: () => void): Promise<void> {
    const again: SendAgain | undefined = ready === undefined ? undefined : { sends: 2, before: async () => ready(), wait: async () => false };
    const body = await this.call("POST", "/v1/safety-records", { record }, AbortSignal.timeout(5_000), again, 200);
    if (!isRecord(body) || body.id !== record.id) throw new AccountServiceError(502, "invalid_answer", "The account service did not confirm this record");
  }

  /**
   * Ends the sign-in on the service, then here. An expired access token is refreshed first, so the
   * service really ends the sign-in's tokens; the session goes here whatever the service answers, and
   * a revocation the service did not confirm throws, so the caller can say so. Only the session it
   * ended goes: a new sign-in made while the service answers (the phone app's page stays open) stays.
   */
  async signOut(): Promise<void> {
    await this.lock(async () => {
      const stored = await this.session();
      if (stored === undefined) return;
      // signed in again since the sign-in this service is for: that one's tokens are ended, and the new sign-in stays
      const from = this.options.signIn;
      const replaced = from !== undefined && !sameSignIn(stored, from);
      const session = replaced ? from : stored;
      let live = session;
      try {
        live = replaced || session.expires_at - REFRESH_EARLY_MS > this.now() ? session : await this.refreshed(session);
        const response = await this.fetch(new URL("/v1/signout", live.service), { method: "POST", headers: { authorization: `Bearer ${live.access_token}` } });
        if (!response.ok) throw await failure(response);
      } catch (error) {
        if (!(error instanceof SignedOutError)) throw error;
      } finally {
        if (!replaced) {
          await this.options.store.update("session", (current) => current?.refresh_token === session.refresh_token || current?.refresh_token === live.refresh_token ? undefined : current);
          // its unsent blocks stay: only the service's answer takes one away, and a later sign-in to this account sends them (S32-1)
          if (this.options.store === indexedAccountStore) globalThis.window?.dispatchEvent(new Event(ACCOUNT_SIGN_OUT_EVENT));
        }
      }
    });
  }

  /** Forgets `from` here, unless another sign-in took its place meanwhile. */
  private async signedOut(from?: AccountSession): Promise<never> {
    await this.options.store.update("session", (current) => from === undefined || current?.refresh_token === from.refresh_token ? undefined : current);
    throw new SignedOutError();
  }

  /** One refresh of `from`; its answer is stored only if `from` is still the stored session. */
  private async refreshed(from: AccountSession): Promise<AccountSession> {
    let next: AccountSession;
    try {
      next = await requestToken(from.service, { grant_type: "refresh_token", refresh_token: from.refresh_token }, { fetch: this.fetch, now: this.now });
    } catch (error) {
      if (error instanceof AccountServiceError && (error.status === 400 || error.status === 401)) return this.signedOut(from);
      throw error instanceof AccountServiceError ? new AccountRefreshError(error) : error;
    }
    // a refresh answers for the sign-in it was asked for: tokens naming another account are no answer, and are not kept
    if (next.account !== from.account) throw new AccountRefreshError(new AccountServiceError(502, "account_changed", "The account service answered a refresh for another account"));
    const carried: AccountSession = from.sign_in_id === undefined ? next : { ...next, sign_in_id: from.sign_in_id };
    let kept = false;
    await this.options.store.update("session", (current) => {
      kept = current?.refresh_token === from.refresh_token;
      return kept ? carried : current;
    });
    if (!kept) throw new SignedOutError();
    return carried;
  }

  /**
   * A session whose access token is good, refreshing once between tabs; `stale` is a token the service just refused.
   * `signal` bounds this caller's wait, the wait for the lock included: work not begun by then is skipped, and a
   * refresh already sent finishes, so the token it rotated is kept for the next call.
   */
  private async fresh(stale?: string, signal?: AbortSignal): Promise<AccountSession> {
    signal?.throwIfAborted();
    // bound to a sign-in that is no longer the stored one: the stored one is someone else's to use or end
    const foreign = (session: AccountSession | undefined): boolean => this.options.signIn !== undefined && (session === undefined || !sameSignIn(session, this.options.signIn));
    const session = await this.session();
    if (foreign(session)) throw new SignedOutError();
    if (session === undefined) return this.signedOut();
    if (stale === undefined && session.expires_at - REFRESH_EARLY_MS > this.now()) return session;
    return this.locked(async () => {
      const current = await this.session();
      if (foreign(current)) throw new SignedOutError();
      if (current === undefined) return this.signedOut();
      // another tab refreshed while this one waited: its tokens are the ones to use
      if (current.access_token !== (stale ?? session.access_token)) return current;
      return this.refreshed(current);
    }, signal);
  }

  /** The lock between tabs, with `signal` bounding the wait for it: work that was not begun by then never begins. */
  private locked<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal === undefined) return this.lock(work);
    signal.throwIfAborted();
    const run = this.lock(async () => { signal.throwIfAborted(); return work(); });
    return new Promise<T>((resolve, reject) => {
      const stop = (): void => reject(signal.reason);
      signal.addEventListener("abort", stop, { once: true });
      run.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    });
  }

  /**
   * `signal`: ends the request itself, not only the wait for it (a post given up must not land later). `again`: this
   * request, and only it, is sent again after no answer or a 429 (a token refresh under it never is), within
   * `again.sends` HTTP sends in all, a send after a 401 included. Without it a 401 is sent again once, as always.
   */
  private async call(method: string, path: string, body?: unknown, signal?: AbortSignal, again?: SendAgain, only?: number): Promise<unknown> {
    let stale: string | undefined;
    let refreshed = false;
    const sends = again?.sends ?? 2;
    for (let sent = 1; ; sent++) {
      const session = await this.fresh(stale, signal);
      await again?.before(sent);
      // nothing is awaited between this and the send
      signal?.throwIfAborted();
      let response: Response;
      try {
        response = await this.fetch(new URL(path, session.service), {
          method,
          headers: { authorization: `Bearer ${session.access_token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        if (again !== undefined && error instanceof AccountServiceUnreachableError && sent < sends && await again.wait(error, sent)) continue;
        throw error;
      }
      if (response.status === 401 && !refreshed) {
        if (sent >= sends) throw await failure(response);
        refreshed = true;
        stale = session.access_token;
        continue;
      }
      // a strict call (`only`) refused again with tokens a refresh just gave: that request's refusal, not a revoked sign-in
      if (response.status === 401 && only !== undefined) throw await failure(response);
      if (response.status === 401) return this.signedOut(session);
      if (!response.ok) {
        const refusal = await failure(response);
        if (again !== undefined && refusal.status === 429 && sent < sends && await again.wait(refusal, sent)) continue;
        throw refusal;
      }
      // `only`: the one success status that counts; another is no answer to rely on
      if (only !== undefined && response.status !== only) throw new AccountServiceError(response.status, "unconfirmed", `The account service answered ${response.status}, not ${only}`);
      return response.status === 204 ? null : response.json();
    }
  }
}

/** The browser's account client, shared by the sign-in surfaces and actions under that sign-in. */
export const indexedAccountService = new AccountService({ store: indexedAccountStore });
export const ACCOUNT_SIGN_OUT_EVENT = "ovis:account-sign-out";
