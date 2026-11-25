/**
 * The account service as this client calls it (docs/account.md, "Account service API"): the
 * directory of the account's PCs, and the tokens a sign-in gives. Answers are parsed here, at the
 * edge; a token is never logged or put in an error's text.
 */
import { accountLabel, accountOsOf, type AccountAsker, type AccountOs } from "../../../shared/account-asker.ts";
import type { AccountLimits } from "../../../shared/protocol.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { newRecordId, pcAddSigningBytes, registerSigningBytes, type AccountRecord, type DeviceSafetyRecord, type PcAddPurpose } from "../../../shared/account-records.ts";
import { inviteMakeBytes } from "../../../shared/account-list-invite.ts";
import { isWssOrigin } from "../../../shared/relay-offer.ts";
import { toBase64Url } from "../../../shared/relay-pair-sas.ts";
import { GLOBAL_APP } from "../../../shared/relay-regions.ts";
import { attemptOf, claimsOf, genesisBody, hintOf, nowOf, pageOf, postsOf, wrapsOf, type ListAttempt, type ListClaim, type ListPost, type PlacedWrap, type ListHint, type ListPage, type ListWrap } from "./listAnswers.ts";
import type { PcProofFields } from "./pcProof.ts";
import type { AccountKey, AccountLock, AccountProvider, AccountSession, AccountStore } from "./store.ts";
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

/**
 * The account service adds a PC for a sign-in from its last ten minutes, or an older one with a key proof (docs/account.md,
 * "In one press"). Past this, under those ten minutes, an add proves this sign-in's key, so a press near the edge never
 * crosses it on its way, and neither does this device's clock running a little apart from the service's.
 */
export const PC_ADD_FRESH_MS = 9 * 60_000;

/** `key_proof` of an add: a challenge of POST /v1/pcs/challenge and this sign-in's key's signature (raw r then s, base64url). */
interface PcAddProof { readonly challenge_id: string; readonly signature: string }

/**
 * `retryAfterMs`: the wait the answer's `retry-after` named (a 429's), or null without one. `reason`: the one word the
 * refusal adds to its code, where it has one (an entry that was refused says why), never its message.
 */
export class AccountServiceError extends Error {
  /** The place of the entry a refusal of a list's request is about (entry 0 is 0), where it names one. */
  index: number | null = null;
  /** The list a `409 list_exists` names, where it names one: only a hint, which the log alone confirms. */
  list: string | null = null;
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterMs: number | null = null, readonly reason: string | null = null) {
    super(message);
    this.name = "AccountServiceError";
  }
}

/** The listing a request named is no longer the one waiting for it (account#57, #67): nothing was written, and the PCs are read again. */
export const listingChanged = (error: unknown): boolean => error instanceof AccountServiceError && error.status === 409 && error.code === "listing_changed";

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

/** A request that is sent once: no second send after a 401, a 429 or no answer. */
const SENT_ONCE: SendAgain = { sends: 1, before: async () => {}, wait: async () => false };

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
  /**
   * When the PC said it is bound by this listing's add (account#57, POST /v1/pc/complete): null while it is only listed or
   * admitted; absent from an older service, which does not tell.
   */
  readonly completed_at?: string | null;
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
  /** the service sent a new window this device cannot read as a time: `new_until` is null, and a vouched approval refuses the PC (vouched-pc.ts) */
  readonly new_until_unreadable?: true;
  /** when the PC was added in one press (kept after its 24 hours), or null */
  readonly admitted_at: string | null;
  /** the PC was added in one press under the first-PC exemption before this device joined: nobody was told of it */
  readonly admitted_before_you: boolean;
  /**
   * PCL-1: listed by a device code (a PC's own sign-in), which anyone can type for any PC, and not confirmed by an app's own
   * sign-in since: only `listUnconfirmedPcs` returns such a row, and nothing opens or lists it as the account's.
   */
  readonly unconfirmed?: true;
  /**
   * On an unconfirmed PC, who asks (docs/account.md, "Add on another device"): the system its listing said it runs and where
   * the account service saw that listing come from, each null when unknown. Absent from a service that does not say.
   */
  readonly asking?: AccountAsker;
  /** Until when an unconfirmed PC may be let in, by the account service's clock; null when no window applies; absent from a service that does not say. */
  readonly asking_until?: string | null;
  /**
   * Never from the account service: the row is a PC that this device's verified list holds (listPcs.ts). Its name and
   * its new window are the list's, and only its relay and `last_seen_at` are the directory's.
   */
  readonly by_list?: true;
  /** On such a row, while it is new: the name of the device whose signature brought the PC in, where this device can read it. */
  readonly added_by?: string;
  /**
   * Never from the account service: this device is in a list of the account, or cannot read the one it has, and that
   * list does not hold the PC (listPcs.ts). The row is the directory's; nothing opens it by itself.
   */
  readonly not_in_list?: true;
}

type Fetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

const SERVER_ID = /^[0-9a-f]{32}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The service's error code only: its message is the service's text, which could echo a token, so it is never kept. */
export async function failure(response: Response): Promise<AccountServiceError> {
  let code = "http_error";
  let reason: string | null = null;
  let index: number | null = null;
  let list: string | null = null;
  try {
    const body: unknown = await response.json();
    const error = isRecord(body) && isRecord(body.error) ? body.error : null;
    if (typeof error?.code === "string" && /^[a-z_]{1,40}$/.test(error.code)) code = error.code;
    if (typeof error?.reason === "string" && /^[a-z_]{1,40}$/.test(error.reason)) reason = error.reason;
    if (typeof error?.index === "number" && Number.isSafeInteger(error.index) && error.index >= 0) index = error.index;
    if (typeof error?.list === "string" && /^[0-9a-f]{64}$/.test(error.list)) list = error.list;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const failed = new AccountServiceError(response.status, code, `The account service answered ${response.status} (${code})`, retryAfterMs(response.headers.get("retry-after")), reason);
  failed.index = index;
  failed.list = list;
  return failed;
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
  const completed_at = "completed_at" in value ? (typeof value.completed_at === "string" && !Number.isNaN(Date.parse(value.completed_at)) ? value.completed_at : null) : undefined;
  const asking_until = "asking_until" in value ? (typeof value.asking_until === "string" && !Number.isNaN(Date.parse(value.asking_until)) ? value.asking_until : null) : undefined;
  return { server_id: value.server_id, label: value.label, added_at: value.added_at, last_seen_at: value.last_seen_at, public_key, relay, new_until, admitted_at, admitted_before_you: admitted_at !== null && value.admitted_before_you === true,
    ...(listing_id === undefined ? {} : { listing_id }), ...(completed_at === undefined ? {} : { completed_at }), ...(invited_at === undefined ? {} : { invited_at }),
    ...(value.new_until != null && new_until === null ? { new_until_unreadable: true as const } : {}),
    ...(value.unconfirmed === true ? { unconfirmed: true as const } : {}),
    ...(asking_until === undefined ? {} : { asking_until }), ...(askerOf(value) ?? {}) };
}

/** Who asks, as an unconfirmed PC's row names it: one plain line for a city, and only with a country; undefined when the row says nothing of it. */
function askerOf(value: Record<string, unknown>): { readonly asking: AccountAsker } | undefined {
  if (!("asking_os" in value || "asking_country" in value || "asking_city" in value)) return undefined;
  const country = typeof value.asking_country === "string" && /^[A-Z]{2}$/.test(value.asking_country) ? value.asking_country : null;
  const city = country !== null && typeof value.asking_city === "string" ? accountLabel(value.asking_city) : "";
  return { asking: { os: accountOsOf(value.asking_os), country, city: city === "" ? null : city } };
}

export function sessionOf(body: unknown, service: string, now: number): AccountSession {
  if (!isRecord(body)) throw new AccountServiceError(502, "invalid_answer", "The account service sent no sign-in");
  const { access_token, refresh_token, expires_in, account, provider } = body;
  if (typeof access_token !== "string" || access_token === "" || typeof refresh_token !== "string" || refresh_token === ""
    || typeof expires_in !== "number" || !(expires_in > 0) || typeof account !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(account)
    || !ACCOUNT_PROVIDERS.includes(provider as AccountProvider)) {
    throw new AccountServiceError(502, "invalid_answer", "The account service sent an incomplete sign-in");
  }
  return { service, account, provider: provider as AccountProvider, access_token, refresh_token, expires_at: now + expires_in * 1000, sign_in_id: newRecordId(), signed_in_at: now };
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
    // a row the service marks unconfirmed is never the account's here, whatever asked for it
    return pcs.map(parsePc).filter((pc): pc is DirectoryPc => pc !== null && pc.unconfirmed !== true);
  }

  /** PCL-1: the account's PCs a device code listed and no app's own sign-in confirmed, to offer them for a confirm. */
  async listUnconfirmedPcs(signal?: AbortSignal): Promise<DirectoryPc[]> {
    const body = await this.call("GET", "/v1/pcs?include=unconfirmed", undefined, signal);
    const pcs = isRecord(body) && Array.isArray(body.pcs) ? body.pcs : null;
    if (pcs === null) throw new AccountServiceError(502, "invalid_answer", "The account service sent no PC list");
    return pcs.map(parsePc).filter((pc): pc is DirectoryPc => pc !== null && pc.unconfirmed === true);
  }

  /**
   * PCL-1/PCL-4: this own sign-in says the PC is the account's, with the key and relay its listing gave. The service refuses
   * a device code's sign-in (`own_sign_in_required`), one older than ten minutes (`session_not_fresh`) and one without
   * two-step in a used account (`two_step_required`). The confirmed row comes back new for 24 hours (C3). It names the
   * listing the card showed (account#67), so a replacement is never confirmed by it: the service answers 409
   * `listing_changed` (`listingChanged`); one that predates the field ignores it.
   */
  async confirmPc(pc: DirectoryPc): Promise<DirectoryPc> {
    if (pc.public_key === null || pc.relay === null) throw new AccountServiceError(409, "unconfirmable", "The listing gives no key or relay to confirm");
    const body = await this.call("PUT", `/v1/pcs/${pc.server_id}`, { label: pc.label, public_key: pc.public_key, relay: pc.relay, confirm: true,
      ...(typeof pc.listing_id === "string" ? { listing_id: pc.listing_id } : {}) });
    const row = isRecord(body) ? parsePc(body.pc) : null;
    if (row === null || row.server_id !== pc.server_id || row.unconfirmed === true) throw new AccountServiceError(502, "invalid_answer", "The account service did not confirm the PC");
    return row;
  }

  /** Whether this sign-in is an app's own (a device code's never is): only such a sign-in may confirm a PC. */
  async ownSignIn(signal?: AbortSignal): Promise<boolean> {
    const body = await this.call("GET", "/v1/session", undefined, signal);
    return isRecord(body) && body.own_sign_in === true;
  }

  /** When this sign-in was made (GET /v1/session `signed_in_at`, kept by every refresh), in ms; null when the service does not say. */
  async signedInAt(signal?: AbortSignal): Promise<number | null> {
    const body = await this.call("GET", "/v1/session", undefined, signal);
    const at = isRecord(body) && typeof body.signed_in_at === "string" ? Date.parse(body.signed_in_at) : Number.NaN;
    return Number.isFinite(at) ? at : null;
  }

  /**
   * Lists a PC in the account's directory, with its relay key and relay so a new device can compare digits with it; with
   * the PC's own proof (ownPcProof) when the PC itself lists it, which alone lists it again after it left (409 `pc_left`).
   * `os`: the system the PC runs, which a listing that asks to join shows the account's devices. A PC the account does not
   * list yet is an add: once the account service holds listings to it, an own sign-in older than ten minutes lists it only
   * with a key proof, `list` over no listing, and is refused `session_not_fresh` without one. `prove`: this listing is a
   * person's press of an add, which proves the key (addProof) when the sign-in is old; nothing else ever signs (opening a
   * saved pairing lists with no proof), and upkeep of a listed PC proves nothing. A proof whose challenge was spent or ran
   * out on the way (a send again after no answer) is made anew once.
   */
  async putPc(serverId: string, entry: { label: string; public_key: string; relay: string; os?: AccountOs } & PcProofFields, signal?: AbortSignal, again?: SendAgain, { prove = false }: { readonly prove?: boolean } = {}): Promise<void> {
    const proved = (): Promise<PcAddProof | null> => prove
      ? this.addProof("list", serverId, async () => await this.listingOf(serverId, signal, again) === null ? "" : null, signal, again)
      : Promise.resolve(null);
    const send = (proof: PcAddProof | null) => this.proving(proof, () => this.call("PUT", `/v1/pcs/${serverId}`, proof === null ? entry : { ...entry, key_proof: proof }, signal, again));
    const proof = await proved();
    try { await send(proof); }
    catch (error) {
      if (proof === null || !(error instanceof AccountServiceError && error.status === 400 && error.code === "challenge_invalid")) throw error;
      await send(await proved());
    }
  }

  /**
   * Removes a PC. A Decline names the listing its card showed (account#67): the service then removes only that listing while
   * it still asks to join, and answers 409 `listing_changed` (`listingChanged`) otherwise; one that predates it ignores it.
   */
  async deletePc(serverId: string, listingId?: string): Promise<void> {
    await this.call("DELETE", `/v1/pcs/${serverId}${listingId === undefined ? "" : `?listing_id=${encodeURIComponent(listingId)}`}`);
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
        if (listingChanged(error)) return "changed";
        if (listingId === undefined && error.status === 404 && error.code === "not_found") return "legacy";
      }
      throw error;
    }
  }

  /**
   * Admits a PC this account lists in one press, from an own sign-in made in the last ten minutes, or older with a proof by
   * its registered key (addProof) over the PC's current listing (`listingId` when the caller just read it, else read here):
   * the service refuses anything else (`session_not_fresh`, `own_sign_in_required`, 409 `listing_expired` for a listing
   * past its window, `pc_add_cap`, an older service `two_step_required`, or 404 where it has no such route).
   * `admitted_at`: the service's time of the admission, as its directory row gives it; null when the answer does not say.
   */
  async admitPc(serverId: string, signal?: AbortSignal, listingId?: string): Promise<{ readonly account: string; readonly new_until: string; readonly admitted_at: string | null }> {
    const proof = await this.addProof("admit", serverId, async () => listingId ?? await this.listingOf(serverId, signal) ?? "", signal);
    const body = await this.proving(proof, () => this.call("POST", `/v1/pcs/${serverId}/admit`, proof === null ? {} : { key_proof: proof }, signal));
    if (!isRecord(body) || typeof body.account !== "string" || typeof body.new_until !== "string") throw new AccountServiceError(502, "invalid_answer", "The account service sent no admission");
    return { account: body.account, new_until: body.new_until, admitted_at: typeof body.admitted_at === "string" && Number.isFinite(Date.parse(body.admitted_at)) ? body.admitted_at : null };
  }

  /**
   * A proof by `key`, the key this sign-in registered (signInKey.ts), for adding `serverId` (docs/account.md, "In one
   * press"): the service's single-use challenge (POST /v1/pcs/challenge), signed over pcAddSigningBytes. Null when the
   * service gives no challenge (404: one from before key proofs, or Step 2 off; 403 `own_sign_in_required`: a device code's
   * sign-in, which the add then refuses as before).
   */
  private async pcAddProof(session: AccountSession, key: AccountKey, purpose: PcAddPurpose, serverId: string, listingId: string, signal?: AbortSignal, again?: SendAgain, only?: number): Promise<PcAddProof | null> {
    return this.challengeProof(key, (id, challenge) => pcAddSigningBytes(purpose, session.account, serverId, listingId, id, challenge), signal, again, only);
  }

  /** A proof by `key` over the bytes `signed` gives for the service's single-use challenge; null as pcAddProof says. */
  private async challengeProof(key: AccountKey, signed: (challengeId: string, challenge: string) => Uint8Array<ArrayBuffer>, signal?: AbortSignal, again?: SendAgain, only?: number): Promise<PcAddProof | null> {
    let issued: unknown;
    try { issued = await this.call("POST", "/v1/pcs/challenge", {}, signal, again, only); }
    catch (error) {
      const refused = error instanceof AccountServiceError && !(error instanceof AccountRefreshError);
      if (refused && (error.status === 404 || (error.status === 403 && error.code === "own_sign_in_required"))) return null;
      throw error;
    }
    if (!isRecord(issued) || typeof issued.challenge_id !== "string" || !/^[0-9a-f]{32}$/.test(issued.challenge_id) || typeof issued.challenge !== "string" || issued.challenge === "") {
      throw new AccountServiceError(502, "invalid_answer", "The account service sent no challenge");
    }
    const bytes = signed(issued.challenge_id, issued.challenge);
    return { challenge_id: issued.challenge_id, signature: toBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.private_key, bytes))) };
  }

  /**
   * The proof an add sends: none while the sign-in is younger than PC_ADD_FRESH_MS by this device's clock, and none when it
   * registered no key; else pcAddProof over the listing `listing` names, read only then (null: this call adds nothing, and
   * proves nothing). One proof per call.
   */
  private async addProof(purpose: PcAddPurpose, serverId: string, listing: () => Promise<string | null>, signal?: AbortSignal, again?: SendAgain, only?: number): Promise<PcAddProof | null> {
    const session = await this.bound();
    const age = session.signed_in_at === undefined ? Number.NaN : this.now() - session.signed_in_at;
    if (age >= 0 && age <= PC_ADD_FRESH_MS) return null;
    const key = await this.registeredKey(session);
    if (key === null) return null;
    const listingId = await listing();
    return listingId === null ? null : this.pcAddProof(session, key, purpose, serverId, listingId, signal, again, only);
  }

  /**
   * Sends an add that carried `proof`. A service that does not take a proof there answers 400 `invalid_request`, which is
   * told as the refusal of the old sign-in the proof stood in for (`session_not_fresh`), so the caller offers Sign in again.
   */
  private async proving<T>(proof: PcAddProof | null, send: () => Promise<T>): Promise<T> {
    try { return await send(); }
    catch (error) {
      if (proof !== null && error instanceof AccountServiceError && !(error instanceof AccountRefreshError) && error.status === 400 && error.code === "invalid_request") {
        throw new AccountServiceError(403, "session_not_fresh", "The account service took no key proof: sign in again");
      }
      throw error;
    }
  }

  /** The account's current listing of `serverId` as the service names it ("" when it names none), or null when the account lists no such PC. */
  private async listingOf(serverId: string, signal?: AbortSignal, again?: SendAgain): Promise<string | null> {
    const body = await this.call("GET", "/v1/pcs?include=unconfirmed", undefined, signal, again);
    const pcs = isRecord(body) && Array.isArray(body.pcs) ? body.pcs : null;
    if (pcs === null) throw new AccountServiceError(502, "invalid_answer", "The account service sent no PC list");
    const pc = pcs.map(parsePc).find((each) => each?.server_id === serverId);
    return pc === undefined || pc === null ? null : pc.listing_id ?? "";
  }

  /** The sign-in this service acts for: the one it is bound to (forSignIn), else the stored one. */
  private async bound(): Promise<AccountSession> {
    const session = this.options.signIn ?? await this.session();
    if (session === undefined) throw new SignedOutError();
    return session;
  }

  /** The key `session` registered with the account service (signInKey.ts), or null: none, still unconfirmed, or another sign-in's. */
  private async registeredKey(session: AccountSession): Promise<AccountKey | null> {
    const kept = await this.options.store.get("signin_key");
    return kept !== undefined && kept.no !== null && session.sign_in_id !== undefined && kept.account === session.account && kept.sign_in_id === session.sign_in_id ? kept.key : null;
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
   * the QR or digits path stays (G5). A sign-in registers one key; another key for it is refused (T40). `label` is
   * the name the account's lists and the PCs' notices show for the key; without one the service names it "Device {no}".
   */
  async registerDeviceKey(key: { readonly private_key: CryptoKey; readonly public_spki: string }, label?: string): Promise<{ no: number; key: string } | null> {
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
    const name = accountLabel(label ?? "");
    const body = await this.call("POST", "/v1/devices", { challenge_id: issued.challenge_id, key: key.public_spki, signature, ...(name === "" ? {} : { label: name }) });
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

  /**
   * Signs every device out of the account (POST /v1/signout/all): each sign-in of it ends at the service, this one's
   * included, so this sign-in is forgotten here too, unless another took its place meanwhile. Its PCs and device keys
   * stay, and so do its unsent blocks: a later sign-in to the account sends them (S32-1). Like deleting the account it
   * wants an own sign-in made in the last ten minutes (403 `reauth_required`, `web_sign_in_required`).
   */
  async signOutEverywhere(): Promise<void> {
    const ended = this.options.signIn ?? await this.session();
    if (ended === undefined) throw new SignedOutError();
    // only the documented 204 ended them: any other success leaves this sign-in as it was
    await this.call("POST", "/v1/signout/all", {}, undefined, undefined, 204);
    await this.options.store.update("session", (current) => current !== undefined && sameSignIn(current, ended) ? undefined : current);
    if (this.options.store === indexedAccountStore) globalThis.window?.dispatchEvent(new Event(ACCOUNT_SIGN_OUT_EVENT));
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
   * One request of the list's routes, sent once. Whatever it is answered is that request's answer and no more: a 401
   * neither refreshes the tokens nor ends the sign-in here, as it does for the routes this client has always called.
   * These routes are asked by themselves, on a clock, of services that may not have them: what such a service says
   * of a route it does not know must not sign anybody out. A sign-in that really ended is found by the next call that
   * a person's own act makes. `only`: the one status that is an answer.
   */
  private listCall(method: string, path: string, body?: unknown, signal?: AbortSignal, only = 200): Promise<unknown> {
    return this.call(method, path, body, signal, SENT_ONCE, only);
  }

  /**
   * The signed list the account service names for this account, with the head it says the list has (`GET
   * /v2/lists/mine`; docs/account-list.md, "On a device"): null for an account that may have a list and has none, and
   * "off" for one the service keeps no lists for (404: it is not on the service's switch, or the service has no such
   * route). `now` is the service's clock in seconds, where it says it. All of it is a hint: a device follows a list
   * only by its own evidence.
   */
  async accountList(signal?: AbortSignal): Promise<{ readonly hint: ListHint | null; readonly now: number | null; /** the account has no list and is on the service's migrate switch: it may move onto one (Part F) */ readonly migrate: boolean } | "off"> {
    let body: unknown;
    try { body = await this.listCall("GET", "/v2/lists/mine", undefined, signal); }
    catch (error) {
      if (error instanceof AccountServiceError && !(error instanceof AccountRefreshError) && error.status === 404) return "off";
      throw error;
    }
    const hint = hintOf(body);
    if (hint === undefined) throw new AccountServiceError(502, "invalid_answer", "The account service sent no list");
    return { hint, now: nowOf(body), migrate: hint === null && isRecord(body) && body.migrate === true };
  }

  /**
   * The keys the account's sign-ins registered (`GET /v1/devices`), each with whether the service says a PC lets it in
   * now (`eligible`), whether it was removed, and the name the app sent when it registered the key (`label`, only
   * where it sent one). The service's word, which the first device of a move holds against what its PCs say they let
   * in (shared/account-list-migrate.ts migrationPlan); the name only names a carried device in the list.
   */
  async devices(signal?: AbortSignal): Promise<{ readonly key: string; readonly eligible: boolean; readonly removed: boolean; readonly label?: string }[]> {
    const body = await this.call("GET", "/v1/devices", undefined, signal);
    if (!isRecord(body) || !Array.isArray(body.devices)) throw new AccountServiceError(502, "invalid_answer", "The account service sent no devices");
    return (body.devices as readonly unknown[]).flatMap((row) => isRecord(row) && typeof row.key === "string" && typeof row.eligible === "boolean" && typeof row.removed === "boolean"
      ? [{ key: row.key, eligible: row.eligible && !row.removed, removed: row.removed, ...(typeof row.label === "string" && row.label.length >= 1 && row.label.length <= 48 ? { label: row.label } : {}) }] : []);
  }

  /**
   * The one request that moves an account that was in use onto its list (`POST /v2/lists` with `entries`; Part F,
   * F10b): entry 0, the whole run, the hand-over and the `epoch`, placed whole or not at all, with the wraps of the epoch
   * the birth opens and the hand-over's link. Sent once per call: the caller keeps the request and sends it again as it
   * is. A refusal is thrown as the service's (`409 list_exists` names the account's list in `list`; `403 not_carried`
   * and `400 entry_refused` name the place they are about in `index`).
   */
  async startBirth(birth: { readonly entry: string; readonly entries: readonly string[]; readonly wraps: readonly PlacedWrap[]; readonly link?: { readonly member: string; readonly device: string } }, signal?: AbortSignal): Promise<{ readonly list: string }> {
    const body = await this.listCall("POST", "/v2/lists", { entry: birth.entry, entries: birth.entries, wraps: birth.wraps, ...(birth.link === undefined ? {} : { link: birth.link }) }, signal, 201);
    if (!isRecord(body) || typeof body.list !== "string" || !/^[0-9a-f]{64}$/.test(body.list)) throw new AccountServiceError(502, "invalid_answer", "The account service placed no list");
    return { list: body.list };
  }

  /**
   * Starts the account's list with the entry 0 this device signed (`POST /v2/lists`), and hands over the first epoch
   * key's wrap for the device itself. The service takes it from an own sign-in made in the last ten minutes, or older
   * with a proof by its registered key (addProof, purpose `list-genesis`, over the list id): `session_not_fresh`
   * otherwise. "exists": the account has a list already, this one or another's (409 `list_exists`); which one is read
   * from the log, never from this answer. `list` is entry 0's hash, which the caller worked out itself.
   */
  async startList(list: string, entry: string, wrap: { readonly member: string; readonly wrap: string }, signal?: AbortSignal): Promise<"placed" | "exists"> {
    const body = genesisBody(entry, wrap);
    const proved = (): Promise<PcAddProof | null> => this.addProof("list-genesis", list, async () => "", signal);
    const send = async (proof: PcAddProof | null): Promise<"placed" | "exists"> => {
      try { await this.proving(proof, () => this.listCall("POST", "/v2/lists", proof === null ? body : { ...body, key_proof: proof }, signal, 201)); }
      catch (error) {
        if (error instanceof AccountServiceError && !(error instanceof AccountRefreshError) && error.status === 409 && error.code === "list_exists") return "exists";
        throw error;
      }
      return "placed";
    };
    const proof = await proved();
    try { return await send(proof); }
    catch (error) {
      // the proof's challenge was spent or ran out on the way: one more, made anew
      if (proof === null || !(error instanceof AccountServiceError && error.status === 400 && error.code === "challenge_invalid")) throw error;
      return send(await proved());
    }
  }

  /**
   * One page of a list's log after `after`, or from entry 0, of at most `limit` entries (`GET /v2/lists/{list}/log`).
   * Every entry in it is the reader's to check.
   */
  async listLog(list: string, after: number | null, signal?: AbortSignal, limit?: number): Promise<ListPage> {
    const query = [...(after === null ? [] : [`after=${after}`]), ...(limit === undefined ? [] : [`limit=${limit}`])].join("&");
    const page = pageOf(await this.listCall("GET", `/v2/lists/${list}/log${query === "" ? "" : `?${query}`}`, undefined, signal));
    if (page === null) throw new AccountServiceError(502, "invalid_answer", "The account service sent no page of the list");
    return page;
  }

  /** The epoch keys the service holds wrapped to `member` (`GET /v2/lists/{list}/wraps`). Only that member's own key opens one. */
  async listWraps(list: string, member: string, signal?: AbortSignal): Promise<ListWrap[]> {
    const wraps = wrapsOf(await this.listCall("GET", `/v2/lists/${list}/wraps?member=${encodeURIComponent(member)}`, undefined, signal));
    if (wraps === null) throw new AccountServiceError(502, "invalid_answer", "The account service sent no wraps");
    return wraps;
  }

  /**
   * Says that `card.key` is this sign-in's own member key, with the card it made for `list` (`POST
   * /v2/lists/{list}/claims`): the account service places a `device` entry for a key only while such a claim is at
   * most ten minutes old, so a member's signature alone lets nobody in. From an own sign-in made in the last ten
   * minutes, or older with a proof by its registered key (purpose `list-claim`, over the list id and the claimed key).
   * Claimed again, it is renewed.
   */
  async claimListKey(list: string, card: { readonly key: string; readonly enc: string; readonly card: string }, signal?: AbortSignal): Promise<void> {
    // asked by the device itself, as the list's own routes are: the challenge is sent once, and no answer to it ends the sign-in
    const proved = (): Promise<PcAddProof | null> => this.addProof("list-claim", list, async () => card.key, signal, SENT_ONCE, 200);
    const send = (proof: PcAddProof | null) => this.proving(proof, () => this.listCall("POST", `/v2/lists/${list}/claims`, proof === null ? card : { ...card, key_proof: proof }, signal));
    const proof = await proved();
    try { await send(proof); }
    catch (error) {
      // the proof's challenge was spent or ran out on the way: one more, made anew
      if (proof === null || !(error instanceof AccountServiceError && error.status === 400 && error.code === "challenge_invalid")) throw error;
      await send(await proved());
    }
  }

  /** The claims of the list that still stand (`GET /v2/lists/{list}/claims`): where a device that lets another in finds its card. */
  async listClaims(list: string, signal?: AbortSignal): Promise<ListClaim[]> {
    const claims = claimsOf(await this.listCall("GET", `/v2/lists/${list}/claims`, undefined, signal));
    if (claims === null) throw new AccountServiceError(502, "invalid_answer", "The account service sent no claims");
    return claims;
  }

  /** The PCs that posted their keys for the list and still wait to be added (`GET /v2/lists/{list}/posts`), each with the comparison under way for it. */
  async listPosts(list: string, signal?: AbortSignal): Promise<ListPost[]> {
    const posts = postsOf(await this.listCall("GET", `/v2/lists/${list}/posts`, undefined, signal));
    if (posts === null) throw new AccountServiceError(502, "invalid_answer", "The account service sent no posts");
    return posts;
  }

  /**
   * One message of the comparison of numbers with a PC that posted (`POST /v2/lists/{list}/posts/{endpoint}/attempt`),
   * which the account service only carries. Without `reveal` it opens an attempt with this device's key and its
   * commitment, in place of any before it; with `reveal` it hands over the nonce it committed to, once the PC answered
   * with its own. Refusals are the service's: `409 post_changed` (the PC posted other keys, or none stands),
   * `409 attempt_changed` (not the open attempt, or the PC has not answered yet), `429 attempts_spent`.
   */
  async listAttempt(list: string, endpoint: string, message: { readonly key: string; readonly adder: string; readonly commitment: string; readonly reveal?: string }, signal?: AbortSignal): Promise<ListAttempt> {
    const body = await this.listCall("POST", `/v2/lists/${list}/posts/${endpoint}/attempt`, message, signal);
    const attempt = isRecord(body) ? attemptOf(body.attempt) : undefined;
    if (attempt === undefined || attempt === null) throw new AccountServiceError(502, "invalid_answer", "The account service sent no attempt");
    return attempt;
  }

  /**
   * Places entries at the list's head, whole or not at all, with the wraps that go with them (`POST
   * /v2/lists/{list}/entries`). The answer says nothing a member relies on: its own entry is in its copy only when
   * the log shows it. A refusal is thrown as the account service's: `409 head_moved` (read and sign again),
   * `400 entry_refused` with its `reason`, `403 not_claimed`, `429 entry_budget`, `503 list_rebuilding` (the same
   * request again), `503 list_stopped`.
   */
  async placeEntries(list: string, entries: readonly string[], wraps: readonly PlacedWrap[], signal?: AbortSignal, invite?: { readonly key: string; readonly auto: boolean }, link?: { readonly member: string; readonly device: string }): Promise<void> {
    // a link rides only on a carried device's hand-over (Part F, F10b): the D11.2 link of its member key to this sign-in's key
    const body = { entries, ...(wraps.length === 0 ? {} : { wraps }), ...(link === undefined ? {} : { link }) };
    if (invite === undefined) { await this.listCall("POST", `/v2/lists/${list}/entries`, body, signal); return; }
    // an invite is placed as one is made: by a sign-in of the last ten minutes, or with a proof of its registered key for that invite
    const proof = await this.inviteProof(invite.key, invite.auto, signal);
    await this.proving(proof, () => this.listCall("POST", `/v2/lists/${list}/entries`, proof === null ? body : { ...body, key_proof: proof }, signal));
  }

  /**
   * The proof that makes or places an invite once the sign-in is older than PC_ADD_FRESH_MS (inviteMakeBytes: the
   * bytes of an add's key proof, with the invite's public key where a listing id stands otherwise). None for a
   * younger sign-in, and none when it registered no key. Only a person's press makes an invite, so only that signs.
   */
  private async inviteProof(inviteKey: string, auto: boolean, signal?: AbortSignal): Promise<PcAddProof | null> {
    const session = await this.bound();
    const age = session.signed_in_at === undefined ? Number.NaN : this.now() - session.signed_in_at;
    if (age >= 0 && age <= PC_ADD_FRESH_MS) return null;
    const key = await this.registeredKey(session);
    if (key === null) return null;
    return this.challengeProof(key, (id, challenge) => inviteMakeBytes({ account: session.account, invite_key: inviteKey, auto, challenge_id: id, challenge }), signal);
  }

  /**
   * Makes the account service's invite for the public key of an invite (`POST /v1/pc-invites`): the service is given
   * that key and whether a machine joins with it by itself, never the line or its private key. Answers the invite's id
   * and the account it is for, which the caller holds against its own before it shows a line. A proof whose challenge
   * was spent or ran out on the way is made anew once.
   */
  async makeInvite(inviteKey: string, auto: boolean, signal?: AbortSignal): Promise<{ readonly id: string; readonly account: string; readonly expires_at: string; readonly auto: boolean }> {
    const send = async (proof: PcAddProof | null): Promise<unknown> =>
      this.proving(proof, () => this.call("POST", "/v1/pc-invites", { invite_key: inviteKey, auto, ...(proof === null ? {} : { key_proof: proof }) }, signal));
    const proof = await this.inviteProof(inviteKey, auto, signal);
    let made: unknown;
    try { made = await send(proof); }
    catch (error) {
      if (proof === null || !(error instanceof AccountServiceError && error.status === 400 && error.code === "challenge_invalid")) throw error;
      made = await send(await this.inviteProof(inviteKey, auto, signal));
    }
    if (!isRecord(made) || typeof made.id !== "string" || !/^[0-9a-f]{32}$/.test(made.id) || typeof made.account !== "string" || typeof made.expires_at !== "string" || Number.isNaN(Date.parse(made.expires_at)) || made.auto !== auto) {
      throw new AccountServiceError(502, "invalid_answer", "The account service sent no invite");
    }
    return { id: made.id, account: made.account, expires_at: made.expires_at, auto };
  }

  /**
   * The account's invites the account service keeps (`GET /v1/pc-invites`): each one's id, and its public key where
   * the service names it (the route is documented without it; an id whose key is not named is no one's to end by key).
   */
  async listInvites(signal?: AbortSignal): Promise<{ readonly id: string; readonly invite_key: string | null }[]> {
    const said = await this.call("GET", "/v1/pc-invites", undefined, signal);
    const rows = isRecord(said) && Array.isArray(said.invites) ? said.invites : [];
    return rows.flatMap((row) => isRecord(row) && typeof row.id === "string" && /^[0-9a-f]{32}$/.test(row.id)
      ? [{ id: row.id, invite_key: typeof row.invite_key === "string" ? row.invite_key : null }] : []);
  }

  /** Ends an invite the account service keeps (`DELETE /v1/pc-invites/{id}`). One a PC used, or that is gone, is refused as the service says. */
  async endInvite(id: string, signal?: AbortSignal): Promise<void> {
    await this.call("DELETE", `/v1/pc-invites/${id}`, undefined, signal);
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
    // the same sign-in: it keeps its id and when it was made (sessionOf stamped the refresh's own time, which is not that)
    const { signed_in_at: _refreshedAt, ...renewed } = next;
    const carried: AccountSession = { ...renewed, sign_in_id: from.sign_in_id ?? next.sign_in_id, ...(from.signed_in_at === undefined ? {} : { signed_in_at: from.signed_in_at }) };
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
