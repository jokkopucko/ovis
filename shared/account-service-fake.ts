/**
 * Test support only: nothing in production imports it (server/conventions.test.ts).
 * It checks what the real service must check (record shape and signature, the caller's directory,
 * server proof with the `account` role), so tests fail where a PC or app relies on something the
 * service would refuse.
 */
import {
  ACCOUNT_RECORDS_MAX, AccountRecordError, isAccountKeyEncoding, isDeviceSafetyRecord, parseSafetyRecord, readAccountRecord, verifySafetyRecord,
  type AccountRecord, type BlockRecord, type DeviceLiftRecord, type SafetyRecord,
} from "./account-records.ts";
import { ACCOUNT_SNAPSHOT_V, SNAPSHOT_GONE, type AccountSnapshotPage, type SnapshotFreezeLine } from "./account-snapshot.ts";
import { accountOsOf, type AccountOs, type AccountPlace } from "./account-asker.ts";
import { isWssOrigin } from "./relay-offer.ts";
import { deriveServerId, proofKey, serverChallenge, verifyServerProof } from "./relay-server-proof.ts";

export const CHALLENGE_TTL_MS = 60_000;
export const MAILBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAILBOX_PAGE = 100;
export const MAILBOX_MAX = 1000;
export const ACCESS_TOKEN_TTL_S = 3600;
export const DIRECTORY_MAX = 100;
export const LIMIT_WINDOW_MS = 10 * 60_000;
export const ADMISSIONS_PER_WINDOW = 10;
/** Quiet admissions one account may post in a window: a count of their own, apart from the ordinary ones. */
export const QUIET_ADMISSIONS_PER_WINDOW = 60;
export const ACCOUNT_REQUESTS_PER_WINDOW = 600;
export const DEVICE_CODE_TTL_S = 900;
export const DEVICE_POLL_S = 5;
export const ACCOUNT_RING = { pane_id: null, title: "Ovis", body: "Your Ovis account has news", tag: "ovis-account" } as const;

export interface FakeRing { account: string; endpoint: string; payload: typeof ACCOUNT_RING }
export const SIGNIN_CODE_TTL_MS = 60_000;

export type SignInProvider = "github" | "google" | "apple";
const SIGN_IN_PROVIDERS: readonly string[] = ["github", "google", "apple"];
const DEVICE_PAGES: Readonly<Record<string, string>> = { github: "https://github.com/login/device", google: "https://www.google.com/device" };
export const LINK_TOKEN_TTL_S = 600;
/** How recent a sign-in must be to add or remove a sign-in method. */
export const REAUTH_MS = 10 * 60_000;

/** The web app's redirect: the code comes back in the fragment there, so it never reaches the host's logs. */
export const WEB_REDIRECT = "https://app.ovis.sh/";

/** The only redirects sign-in returns to (docs/account.md, "Signing in"), compared exactly. */
export function isAllowedRedirect(uri: string): boolean {
  if (uri === WEB_REDIRECT || uri === "ovis://account/callback") return true;
  const loopback = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/callback$/.exec(uri);
  return loopback !== null && Number(loopback[1]) >= 1 && Number(loopback[1]) <= 65535;
}

async function sha256Hex(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;

interface Session { account: string; provider: SignInProvider | "test"; family: string; expires: number }

/** `public_key`: the PC's relay key (X25519, 64 hex), from which `server_id` derives; `relay`: the wss origin it is reached through. */
export interface FakePc { server_id: string; label: string; public_key: string; relay: string; added_at: string; last_seen_at: string | null; new_until?: string | null; admitted_at?: string | null; exempt?: boolean }
/** How long a PC added in one press stays new to the account's other devices. */
export const PC_NEW_MS = 24 * 60 * 60_000;
/** One-press PC adds one account may make per rolling day; past it 429 `pc_add_cap`. */
export const PC_ADMITS_PER_DAY = 3;
/** `key`: the waiting device's account key, which the PC matches against the comparison it is asked for. */
export interface FakeAdmission { id: string; server_id: string; account: string; label: string; key: string; at: string; os: AccountOs | null; country: string | null; city: string | null }
/** How long an admission reaches its PC's mailbox: the PC lets a waiting account device compare digits only within it. */
export const ADMISSION_TTL_MS = 10 * 60_000;

interface Mail { seq: number; record: AccountRecord; at: number }

/** Devices one snapshot page lists. */
export const SNAPSHOT_PAGE = 100;

/** Device table P6, P21: an account's registered keys, each with a `no` that is never reused, and its durable records. */
interface Registry {
  next: number;
  version: number;
  /** Device table T58: raised when the account gains or loses a sign-in method */
  methods_version: number;
  devices: Map<string, { no: number; label: string; eligible: boolean; removed: boolean }>;
  blocks: BlockRecord[];
  lifts: DeviceLiftRecord[];
  freezes: SnapshotFreezeLine[];
}

type SnapshotState = Omit<AccountSnapshotPage, "page" | "last" | "v">;

export class FakeAccountService {
  private readonly tokens = new Map<string, Session>();
  /** `link`: the sign-in (account and refresh family) a linking sign-in adds this identity to, once that sign-in redeems the code */
  private readonly codes = new Map<string, { account: string; provider: SignInProvider; challenge: string; redirect: string; expires: number; link: { account: string; family: string } | null }>();
  private readonly refreshTokens = new Map<string, { account: string; provider: SignInProvider; family: string; used: boolean }>();
  private readonly revokedFamilies = new Set<string>();
  private readonly appleTokens = new Map<string, { account: string; nonce: string }>();
  private readonly signIns = new Map<SignInProvider, string>();
  private readonly deviceSignIns = new Map<string, { provider: SignInProvider; userCode: string; account: string | null; denied: boolean; interval: number; nextPoll: number; expires: number; challenge: string | null; page?: boolean; requester?: { label: string | null; os: AccountOs | null } }>();
  private readonly identityList = new Map<string, Map<SignInProvider, { added_at: string }>>();
  private readonly linkTokens = new Map<string, { account: string; family: string; provider: SignInProvider; expires: number }>();
  /** by refresh family: when that sign-in was made (a refresh keeps it), for what needs a recent one */
  private readonly signedInAt = new Map<string, number>();
  /** by refresh family: the sign-in's two_step_set (null: unknown, as a Google sign-in without amr) */
  private readonly twoStep = new Map<string, boolean | null>();
  /** what a sign-in made through the sign-in routes says of two-step sign-in; tests set it */
  signInTwoStep: boolean | null = null;
  /** one-press admissions by account and PC (`box`), and each account's admit times, for the daily cap */
  private readonly pcAdmissions = new Map<string, { at: number; taken: boolean; family: string }>();
  private readonly admitTimes = new Map<string, number[]>();
  /** accounts that admitted or removed a PC: never empty again for the first-PC exemption */
  private readonly usedAccounts = new Set<string>();
  /** by refresh family: when that sign-in registered its own account device key (registerSessionKey) */
  private readonly keyRegisteredAt = new Map<string, number>();
  /** by key: the refresh family that registered it with registerSessionKey */
  private readonly keyFamily = new Map<string, string>();
  private offered: { providers: SignInProvider[]; device: SignInProvider[]; device_page?: SignInProvider[] } = { providers: ["github", "google", "apple"], device: ["github", "google"] };
  private readonly pushes = new Map<string, { account: string; endpoint: string }>();
  private readonly counters = new Map<string, { start: number; count: number }>();
  private readonly ringList: FakeRing[] = [];
  private readonly directories = new Map<string, Map<string, FakePc>>();
  private readonly mailboxes = new Map<string, Mail[]>();
  private readonly challenges = new Map<string, { server_id: string; expected: string; expires: number }>();
  private readonly admissionList: FakeAdmission[] = [];
  /** quiet admissions: only an app's own sign-in posts one, and only a PC the account lists reads them */
  private readonly quietList: FakeAdmission[] = [];
  private readonly accountLimits = new Map<string, Record<string, unknown>>();
  private readonly subscribed = new Set<string>();
  private readonly deletedAccounts = new Set<string>();
  /** sign-ins made with a device code or on the link page, refreshes included: they cannot delete the account */
  private readonly deviceFamilies = new Set<string>();
  /** Where the service sees every request come from (Cloudflare's `request.cf`); unknown unless a test says. */
  requestPlace: AccountPlace = { country: null, city: null };
  linkPageAcceptsLabelAndOs = true;
  private readonly registries = new Map<string, Registry>();
  private readonly snapshots = new Map<string, SnapshotState>();
  /** OVIS_ACCOUNT_OPENS_ALL at the service: off, the snapshot and safety-record routes do not exist. */
  opensAll = false;
  /** Newer services distinguish a listed PC's snapshot opt-out from a hidden 404. */
  reportsStep2Off = false;
  private seq = 0;
  readonly requests: string[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  issueToken(account: string, { twoStep = null }: { twoStep?: boolean | null } = {}): string {
    const token = randomHex(32);
    const family = randomHex(16);
    this.tokens.set(token, { account, provider: "test", family, expires: Number.POSITIVE_INFINITY });
    this.signedInAt.set(family, this.now());
    this.twoStep.set(family, twoStep);
    return token;
  }

  setLimits(account: string, limits: Record<string, unknown> | null): void {
    if (limits === null) this.accountLimits.delete(account);
    else this.accountLimits.set(account, limits);
  }

  signInAs(provider: SignInProvider, account: string): void { this.signIns.set(provider, account); }

  subscribe(account: string, renews = true): void { if (renews) this.subscribed.add(account); else this.subscribed.delete(account); }

  deleted(account: string): boolean { return this.deletedAccounts.has(account); }

  offerSignIns(providers: SignInProvider[], device: SignInProvider[]): void { this.offered = { providers, device }; }

  offerLinkPage(providers: SignInProvider[]): void { this.offered = { ...this.offered, device_page: providers }; }

  linkRequester(userCode: string): { label: string | null; os: AccountOs | null } | undefined {
    for (const entry of this.deviceSignIns.values()) if (entry.page && entry.userCode === userCode) return entry.requester;
    return undefined;
  }

  approveOnLinkPage(userCode: string, account: string, provider: SignInProvider): void {
    // one approval, as the service: an approved request's code names nothing any more
    for (const entry of this.deviceSignIns.values()) {
      if (entry.userCode === userCode && entry.page && entry.account === null && this.now() < entry.expires) { entry.account = account; entry.provider = provider; entry.userCode = ""; }
    }
  }


  private addIdentity(account: string, provider: SignInProvider): void {
    const methods = this.identityList.get(account) ?? new Map();
    if (!methods.has(provider)) { methods.set(provider, { added_at: this.iso() }); this.methodsChanged(account); }
    this.identityList.set(account, methods);
  }

  /** An identity token as Sign in with Apple hands an iOS app, for `account`, whose `nonce` claim is the hash the app gave Apple. */
  appleIdToken(account: string, nonceHash: string): string {
    const token = randomHex(32);
    this.appleTokens.set(token, { account, nonce: nonceHash });
    return token;
  }

  approveDevice(userCode: string, account: string): void {
    for (const entry of this.deviceSignIns.values()) if (entry.userCode === userCode) entry.account = account;
  }

  denyDevice(userCode: string): void {
    for (const entry of this.deviceSignIns.values()) if (entry.userCode === userCode) entry.denied = true;
  }

  rings(): readonly FakeRing[] { return this.ringList; }

  private ring(account: string, family: string): void {
    for (const [owner, push] of this.pushes) if (push.account === account && owner !== family) this.ringList.push({ account, endpoint: push.endpoint, payload: ACCOUNT_RING });
  }

  private withinRateLimit(key: string, max: number): boolean {
    const now = this.now();
    const counter = this.counters.get(key);
    if (!counter || now - counter.start >= LIMIT_WINDOW_MS) { this.counters.set(key, { start: now, count: 1 }); return true; }
    counter.count += 1;
    return counter.count <= max;
  }

  revokeToken(token: string): void { this.tokens.delete(token); }

  private grant(account: string, provider: SignInProvider, family?: string, device = false) {
    if (family === undefined) {
      family = randomHex(16);
      this.signedInAt.set(family, this.now());
      this.twoStep.set(family, this.signInTwoStep);
      if (device) this.deviceFamilies.add(family);
    }
    const access = randomHex(32);
    const refresh = randomHex(32);
    this.tokens.set(access, { account, provider, family, expires: this.now() + ACCESS_TOKEN_TTL_S * 1000 });
    this.refreshTokens.set(refresh, { account, provider, family, used: false });
    return json({ access_token: access, refresh_token: refresh, expires_in: ACCESS_TOKEN_TTL_S, account, provider });
  }

  private signIn(url: URL, provider: string): Response {
    if (!SIGN_IN_PROVIDERS.includes(provider)) return problem(404, "not_found", "Unknown provider");
    const redirect = url.searchParams.get("redirect_uri") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const challenge = url.searchParams.get("code_challenge") ?? "";
    if (!isAllowedRedirect(redirect)) return problem(400, "invalid_redirect_uri", "That redirect is not allowed");
    // the web redirect always takes the fragment; the app's scheme may ask for it; a loopback server never sees one
    const mode = url.searchParams.get("response_mode") ?? (redirect === WEB_REDIRECT ? "fragment" : "query");
    const loopback = redirect.startsWith("http://127.0.0.1:");
    if ((mode !== "fragment" && mode !== "query") || (redirect === WEB_REDIRECT && mode !== "fragment") || (loopback && mode !== "query")) {
      return problem(400, "invalid_request", "That response_mode does not go with that redirect");
    }
    if (url.searchParams.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || state.length === 0) {
      return problem(400, "invalid_request", "Send state and an S256 code_challenge");
    }
    // a link token is spent here, but nothing is linked until its code is redeemed (token)
    const link = url.searchParams.get("link_token");
    const linking = link === null ? undefined : this.linkTokens.get(link);
    if (link !== null) this.linkTokens.delete(link);
    const valid = link === null || (linking !== undefined && linking.provider === provider && this.now() < linking.expires);
    const code = randomHex(32);
    if (valid) this.codes.set(code, { account: this.signIns.get(provider as SignInProvider) ?? `acct_${provider}`, provider: provider as SignInProvider, challenge, redirect, expires: this.now() + SIGNIN_CODE_TTL_MS, link: linking ? { account: linking.account, family: linking.family } : null });
    const back = new URL(redirect);
    const answer = new URLSearchParams(valid ? { code, state } : { error: "invalid_link", state });
    if (mode === "fragment") back.hash = answer.toString();
    else back.search = answer.toString();
    return new Response(null, { status: 302, headers: { location: back.href } });
  }

  private async token(request: Request): Promise<Response> {
    const body = await request.json() as Record<string, unknown>;
    const invalid = (message: string) => problem(400, "invalid_grant", message);
    switch (body.grant_type) {
      case "authorization_code": {
        const code = typeof body.code === "string" ? this.codes.get(body.code) : undefined;
        if (typeof body.code === "string") this.codes.delete(body.code);
        if (!code || this.now() >= code.expires || body.redirect_uri !== code.redirect) return invalid("The code is wrong, spent or expired");
        if (typeof body.code_verifier !== "string" || !PKCE.test(body.code_verifier) || await s256(body.code_verifier) !== code.challenge) return invalid("The code_verifier does not match");
        if (code.link === null) {
          this.addIdentity(code.account, code.provider);
          return this.grant(code.account, code.provider);
        }
        // a link commits only here, redeemed by the very sign-in that asked for it
        const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
        const holder = bearer === undefined ? undefined : this.tokens.get(bearer);
        if (holder === undefined || holder.family !== code.link.family || this.now() >= holder.expires || this.revokedFamilies.has(holder.family)) return invalid("Redeem a link with the sign-in that asked for it");
        if (code.account !== code.link.account && this.identityList.get(code.account)?.has(code.provider)) return problem(409, "identity_in_use", "That identity belongs to another account");
        this.signIns.set(code.provider, code.link.account);
        this.addIdentity(code.link.account, code.provider);
        return this.grant(code.link.account, code.provider);
      }
      case "refresh_token": {
        const refresh = typeof body.refresh_token === "string" ? this.refreshTokens.get(body.refresh_token) : undefined;
        if (!refresh || this.revokedFamilies.has(refresh.family)) return invalid("Sign in again");
        // a refresh token is good once: seeing it again means it leaked, so the whole family goes
        if (refresh.used) { this.revokeFamily(refresh.family); return invalid("Sign in again"); }
        refresh.used = true;
        return this.grant(refresh.account, refresh.provider, refresh.family);
      }
      case "apple_id_token": {
        const apple = typeof body.id_token === "string" ? this.appleTokens.get(body.id_token) : undefined;
        if (typeof body.id_token === "string") this.appleTokens.delete(body.id_token);
        // the app sends its plain nonce; Apple was given its SHA-256 in lowercase hex
        if (!apple || typeof body.nonce !== "string" || body.nonce.length < 16 || body.nonce.length > 128 || await sha256Hex(body.nonce) !== apple.nonce) return invalid("The identity token is not valid for that nonce");
        return this.grant(apple.account, "apple");
      }
      case "urn:ietf:params:oauth:grant-type:device_code": {
        const entry = typeof body.device_code === "string" ? this.deviceSignIns.get(body.device_code) : undefined;
        if (!entry || this.now() >= entry.expires) return problem(400, "expired_token", "Start the sign-in again");
        // a bound sign-in: refused before anything else, so a poll without the verifier moves nothing
        if (entry.challenge !== null && (typeof body.code_verifier !== "string" || !PKCE.test(body.code_verifier) || await s256(body.code_verifier) !== entry.challenge)) {
          return invalid("That verifier is not this sign-in's");
        }
        if (this.now() < entry.nextPoll) {
          entry.interval += DEVICE_POLL_S;
          entry.nextPoll = this.now() + entry.interval * 1000;
          return problem(400, "slow_down", `Poll every ${entry.interval} seconds`);
        }
        entry.nextPoll = this.now() + entry.interval * 1000;
        if (entry.denied) { this.deviceSignIns.delete(body.device_code as string); return problem(400, "access_denied", "The sign-in was refused at the provider"); }
        if (entry.account === null) return problem(400, "authorization_pending", "Waiting for the sign-in at the provider");
        this.deviceSignIns.delete(body.device_code as string);
        this.addIdentity(entry.account, entry.provider);
        return this.grant(entry.account, entry.provider, undefined, true);
      }
      default: return problem(400, "unsupported_grant_type", "Use authorization_code, refresh_token or apple_id_token");
    }
  }

  private erase(account: string): void {
    for (const held of [...this.tokens.values()]) if (held.account === account) this.revokeFamily(held.family);
    for (const [token, refresh] of this.refreshTokens) if (refresh.account === account) { this.revokedFamilies.add(refresh.family); this.refreshTokens.delete(token); }
    for (const [provider, signsInTo] of this.signIns) if (signsInTo === account) this.signIns.delete(provider);
    for (const [family, push] of this.pushes) if (push.account === account) this.pushes.delete(family);
    for (const [token, link] of this.linkTokens) if (link.account === account) this.linkTokens.delete(token);
    for (const [code, held] of this.codes) if (held.account === account) this.codes.delete(code);
    for (const key of [...this.mailboxes.keys()]) if (key.endsWith(`\0${account}`)) this.mailboxes.delete(key);
    for (const key of [...this.counters.keys()]) if (key.endsWith(`:${account}`)) this.counters.delete(key);
    for (const list of [this.admissionList, this.quietList]) for (let index = list.length - 1; index >= 0; index--) if (list[index]?.account === account) list.splice(index, 1);
    this.identityList.delete(account);
    this.directories.delete(account);
    this.accountLimits.delete(account);
    this.deletedAccounts.add(account);
  }

  private revokeFamily(family: string): void {
    this.revokedFamilies.add(family);
    for (const [token, session] of this.tokens) if (session.family === family) this.tokens.delete(token);
  }

  private registry(account: string): Registry {
    const registry = this.registries.get(account) ?? { next: 1, version: 1, methods_version: 0, devices: new Map(), blocks: [], lifts: [], freezes: [] };
    this.registries.set(account, registry);
    return registry;
  }

  /** Device table P18, P21: registers a key for the account (S2-19 adds the route) and returns its `no`. */
  /** The account device key the sign-in behind `token` registers now, as POST /v1/devices would. */
  registerSessionKey(token: string, key: string, label: string): number {
    const session = this.tokens.get(token);
    if (session === undefined) throw new Error("no such token");
    this.keyRegisteredAt.set(session.family, this.now());
    this.keyFamily.set(key, session.family);
    return this.registerDevice(session.account, key, label);
  }

  /** Whether the account was ever used: another PC listed, a one-press admit or removal, or any device key ever, revoked ones included. */
  private everUsed(account: string, serverId: string, family: string): boolean {
    const others = [...(this.directories.get(account)?.keys() ?? [])].some((id) => id !== serverId);
    // a key the admitting sign-in registered itself is no other device
    const keys = [...(this.registries.get(account)?.devices.keys() ?? [])].filter((key) => this.keyFamily.get(key) !== family);
    return others || this.usedAccounts.has(account) || keys.length > 0;
  }

  registerDevice(account: string, key: string, label: string, eligible = true): number {
    const registry = this.registry(account);
    const known = registry.devices.get(key);
    if (known) return known.no;
    const no = registry.next++;
    registry.devices.set(key, { no, label, eligible, removed: false });
    registry.version += 1;
    return no;
  }

  /** Device table T36 (service effect): the key leaves the list and keeps its `no` in `removed`. */
  removeDevice(account: string, key: string): void {
    const device = this.registry(account).devices.get(key);
    if (!device || device.removed) return;
    device.removed = true;
    this.registry(account).version += 1;
  }

  private methodsChanged(account: string): void {
    const registry = this.registry(account);
    registry.methods_version += 1;
    registry.version += 1;
  }

  /** Makes every snapshot id handed out so far answer `snapshot_gone`. */
  dropSnapshots(): void { this.snapshots.clear(); }

  pcs(account: string): FakePc[] { return [...this.directories.get(account)?.values() ?? []]; }

  admissions(): readonly FakeAdmission[] { return this.admissionList; }

  quietAdmissions(): readonly FakeAdmission[] { return this.quietList; }

  mailbox(serverId: string, account: string): AccountRecord[] {
    this.expire();
    return (this.mailboxes.get(box(serverId, account)) ?? []).map(({ record }) => record);
  }

  dropQueuedRecords(serverId: string, account: string, predicate: (record: AccountRecord) => boolean): void {
    const key = box(serverId, account);
    this.mailboxes.set(key, (this.mailboxes.get(key) ?? []).filter(({ record }) => !predicate(record)));
  }

  readonly fetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    this.requests.push(`${request.method} ${url.pathname}`);
    try {
      if (url.pathname.startsWith("/v1/pc/")) return await this.pc(request, url.pathname);
      const provider = /^\/v1\/signin\/([a-z]+)$/.exec(url.pathname)?.[1];
      if (provider !== undefined && request.method === "GET") return this.signIn(url, provider);
      if (url.pathname === "/v1/token" && request.method === "POST") return await this.token(request);
      if (url.pathname === "/v1/providers" && request.method === "GET") return json(this.offered);
      if (url.pathname === "/v1/signin/ovis/device" && request.method === "POST" && (this.offered.device_page ?? []).length > 0) {
        const body = JSON.parse(await request.text()) as Record<string, unknown>;
        const label = body.label;
        if (body.code_challenge_method !== "S256" || typeof body.code_challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.code_challenge)
          || (label !== undefined && (typeof label !== "string" || label.length < 1 || label.length > 48 || /[\p{Cc}\p{Cs}]/u.test(label)))
          || Object.keys(body).some((name) => !["code_challenge", "code_challenge_method", ...(this.linkPageAcceptsLabelAndOs ? ["label", "os"] : [])].includes(name))) {
          return problem(400, "invalid_request", "Start a sign-in on the link page with an S256 code_challenge, and a label of 1-48 characters if any");
        }
        const deviceCode = randomHex(32);
        const letters = "BCDFGHJKLMNPQRSTVWXZ";
        const pick = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => letters[byte % letters.length]).join("");
        const userCode = `${pick()}-${pick()}`;
        this.deviceSignIns.set(deviceCode, { provider: "github", userCode, account: null, denied: false, interval: DEVICE_POLL_S, nextPoll: this.now(), expires: this.now() + 600_000, challenge: body.code_challenge, page: true, requester: { label: typeof label === "string" ? label : null, os: accountOsOf(body.os) } });
        const page = new URL("/link", url.origin);
        const complete = new URL(page);
        complete.searchParams.set("code", userCode);
        return json({ device_code: deviceCode, user_code: userCode, verification_uri: page.href, verification_uri_complete: complete.href, expires_in: 600, interval: DEVICE_POLL_S, code_challenge_method: "S256" });
      }
      const deviceProvider = /^\/v1\/signin\/([a-z]+)\/device$/.exec(url.pathname)?.[1];
      if (deviceProvider !== undefined && DEVICE_PAGES[deviceProvider] !== undefined && request.method === "POST") {
        const text = await request.text();
        const body = (text.trim() === "" ? {} : JSON.parse(text)) as Record<string, unknown>;
        // a device code can be phished (RFC 8628): it signs in, but never adds a method to an account
        if ("link_token" in body) return problem(400, "invalid_request", "Add a sign-in method through a redirect sign-in");
        const bound = Object.keys(body).length > 0;
        if (bound && (body.code_challenge_method !== "S256" || typeof body.code_challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.code_challenge) || Object.keys(body).length !== 2)) {
          return problem(400, "invalid_request", "Start a device sign-in with nothing, or an S256 code_challenge");
        }
        const deviceCode = randomHex(32);
        const userCode = `${randomHex(2).toUpperCase()}-${randomHex(2).toUpperCase()}`;
        this.deviceSignIns.set(deviceCode, { provider: deviceProvider as SignInProvider, userCode, account: null, denied: false, interval: DEVICE_POLL_S, nextPoll: this.now(), expires: this.now() + DEVICE_CODE_TTL_S * 1000, challenge: bound ? body.code_challenge as string : null });
        return json({ device_code: deviceCode, user_code: userCode, verification_uri: DEVICE_PAGES[deviceProvider], expires_in: DEVICE_CODE_TTL_S, interval: DEVICE_POLL_S, ...(bound ? { code_challenge_method: "S256" } : {}) });
      }
      if (url.pathname === "/v1/push/key" && request.method === "GET") return json({ public_key: "BFakeVapidPublicKeyForTests" });
      return await this.client(request, url.pathname);
    } catch (error) {
      if (error instanceof AccountRecordError) return problem(400, "record_invalid", error.message);
      if (error instanceof SyntaxError) return problem(400, "invalid_json", "The body is not JSON");
      throw error;
    }
  };

  private async client(request: Request, path: string): Promise<Response> {
    const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const session = bearer === undefined ? undefined : this.tokens.get(bearer);
    if (session === undefined || this.now() >= session.expires || this.revokedFamilies.has(session.family)) return problem(401, "unauthorized", "Sign in again");
    const account = session.account;
    if (!this.withinRateLimit(`requests:${account}`, ACCOUNT_REQUESTS_PER_WINDOW)) return problem(429, "rate_limited", "Too many requests; try again later");
    if (path === "/v1/signout" && request.method === "POST") {
      this.revokeFamily(session.family);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/push" && request.method === "PUT") {
      const body = await request.json() as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
      if (typeof body.endpoint !== "string" || !URL.canParse(body.endpoint) || typeof body.keys?.p256dh !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(body.keys.p256dh)
        || typeof body.keys.auth !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(body.keys.auth)) return problem(400, "invalid_endpoint", "Send the subscription's endpoint and keys");
      this.pushes.set(session.family, { account, endpoint: body.endpoint });
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/push" && request.method === "DELETE") {
      this.pushes.delete(session.family);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/identities" && request.method === "GET") {
      return json({ identities: [...this.identityList.get(account) ?? []].map(([provider, { added_at }]) => ({ provider, added_at })) });
    }
    if (path === "/v1/account/limits" && request.method === "GET") {
      const limits = this.accountLimits.get(account);
      return limits ? json(limits) : problem(404, "not_found", "Unknown request");
    }
    const recent = this.now() - (this.signedInAt.get(session.family) ?? Number.NEGATIVE_INFINITY) <= REAUTH_MS;
    if ((path === "/v1/identities/link" && request.method === "POST") || (path.startsWith("/v1/identities/") && request.method === "DELETE")) {
      if (!recent) return problem(403, "reauth_required", "Sign in again first");
    }
    if (path === "/v1/account" && request.method === "DELETE") {
      // a device code can be typed for someone else's PC: its sign-in must not end the account
      if (this.deviceFamilies.has(session.family)) return problem(403, "web_sign_in_required", "Sign in on this device first");
      if (!recent) return problem(403, "reauth_required", "Sign in again first");
      if (this.subscribed.has(account)) return problem(409, "subscription_active", "Cancel the subscription in the billing portal first");
      this.erase(account);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/identities/link" && request.method === "POST") {
      const body = await request.json() as { provider?: unknown };
      if (typeof body.provider !== "string" || !this.offered.providers.includes(body.provider as SignInProvider)) return problem(400, "invalid_provider", "Name a provider this service offers");
      if (this.identityList.get(account)?.has(body.provider as SignInProvider)) return problem(409, "identity_exists", "The account already signs in with it");
      const token = randomHex(32);
      this.linkTokens.set(token, { account, family: session.family, provider: body.provider as SignInProvider, expires: this.now() + LINK_TOKEN_TTL_S * 1000 });
      return json({ link_token: token, expires_in: LINK_TOKEN_TTL_S });
    }
    const removed = /^\/v1\/identities\/([a-z]+)$/.exec(path)?.[1] as SignInProvider | undefined;
    if (removed !== undefined && request.method === "DELETE") {
      const methods = this.identityList.get(account);
      if (!methods?.has(removed)) return problem(404, "not_found", "The account does not sign in with it");
      if (methods.size === 1) return problem(409, "last_identity", "Add another way to sign in first");
      methods.delete(removed);
      this.methodsChanged(account);
      if (this.signIns.get(removed) === account) this.signIns.delete(removed);
      // the sign-ins made with it end
      for (const held of [...this.tokens.values()]) if (held.account === account && held.provider === removed) this.revokeFamily(held.family);
      return new Response(null, { status: 204 });
    }
    const directory = this.directories.get(account) ?? new Map<string, FakePc>();
    this.directories.set(account, directory);
    if (path === "/v1/pcs" && request.method === "GET") {
      // null while step 2 is off for the account, and once passed
      const keyAt = this.keyRegisteredAt.get(session.family);
      return json({ pcs: [...directory.values()].map(({ exempt, ...entry }) => ({
        ...entry,
        new_until: this.opensAll && entry.new_until != null && Date.parse(entry.new_until) > this.now() ? entry.new_until : null,
        admitted_at: this.opensAll ? entry.admitted_at ?? null : null,
        // the one admit no device was told about: shown to a device whose own key came after it
        admitted_before_you: this.opensAll && exempt === true && keyAt !== undefined && entry.admitted_at != null && Date.parse(entry.admitted_at) < keyAt,
      })) });
    }
    const admitted = /^\/v1\/pcs\/([0-9a-f]{32})\/admit$/.exec(path)?.[1];
    if (admitted !== undefined && request.method === "POST" && this.opensAll) {
      // C1: an app's own sign-in, made within REAUTH_MS, with two-step sign-in set (unknown is not enough)
      if (this.deviceFamilies.has(session.family)) return problem(403, "own_sign_in_required", "Sign in in the app itself");
      if (this.now() - (this.signedInAt.get(session.family) ?? Number.NEGATIVE_INFINITY) > REAUTH_MS) return problem(403, "session_not_fresh", "Sign in again on this device first");
      // the first-PC exemption: an account never used (no other PC, no admit or removal, no device key ever) waives two-step
      const exempt = this.twoStep.get(session.family) !== true;
      const entry = directory.get(admitted);
      const open = this.pcAdmissions.get(box(admitted, account));
      // a retry of this same sign-in's own admission, still open, gets the same answer: no second exemption is granted
      const retry = entry !== undefined && open !== undefined && !open.taken && open.family === session.family && this.now() - open.at <= ADMISSION_TTL_MS && entry.new_until != null;
      if (exempt && !retry && this.everUsed(account, admitted, session.family)) return problem(403, "two_step_required", "Set up two-step sign-in first");
      if (entry === undefined) return problem(400, "unknown_pc", "List PCs of this account only");
      if (open !== undefined && !open.taken && this.now() - open.at <= ADMISSION_TTL_MS && entry.new_until != null) {
        return json({ server_id: admitted, account, admitted_at: new Date(open.at).toISOString(), new_until: entry.new_until });
      }
      // C4: the account's one-press adds of the last day
      const times = (this.admitTimes.get(account) ?? []).filter((at) => this.now() - at < PC_NEW_MS);
      if (times.length >= PC_ADMITS_PER_DAY) {
        const capped = problem(429, "pc_add_cap", "This account added enough PCs today");
        capped.headers.set("retry-after", String(Math.ceil((times[0]! + PC_NEW_MS - this.now()) / 1000)));
        return capped;
      }
      this.admitTimes.set(account, [...times, this.now()]);
      // one instant for the admission, its directory entry and this answer: a retry answers the same
      const at = this.now();
      this.pcAdmissions.set(box(admitted, account), { at, taken: false, family: session.family });
      this.usedAccounts.add(account);
      entry.new_until = new Date(this.now() + PC_NEW_MS).toISOString();
      entry.admitted_at = new Date(at).toISOString();
      entry.exempt = exempt;
      this.ring(account, session.family);
      return json({ server_id: admitted, account, admitted_at: new Date(at).toISOString(), new_until: entry.new_until });
    }
    const pc = /^\/v1\/pcs\/([0-9a-f]{32})$/.exec(path)?.[1];
    if (pc !== undefined && request.method === "PUT") {
      const body = await request.json() as { label?: unknown; public_key?: unknown; relay?: unknown };
      if (typeof body.label !== "string" || body.label.length < 1 || body.label.length > 48) return problem(400, "invalid_label", "Name the PC");
      // the key is stored, but it cannot be forged: it must give this server_id
      const key = proofKey(body.public_key);
      if (!key || deriveServerId(key) !== pc) return problem(400, "server_key_mismatch", "That key does not give that server_id");
      if (typeof body.relay !== "string" || !isWssOrigin(body.relay)) return problem(400, "invalid_relay", "Give the relay's wss origin");
      const fresh = !directory.has(pc);
      if (fresh && directory.size >= DIRECTORY_MAX) return problem(409, "directory_full", "Remove a PC first");
      // a re-PUT (the nine-minute relist) keeps the PC's admission
      const before = directory.get(pc);
      const entry: FakePc = { server_id: pc, label: body.label, public_key: body.public_key as string, relay: body.relay, added_at: before?.added_at ?? this.iso(), last_seen_at: before?.last_seen_at ?? null,
        ...(before?.new_until == null ? {} : { new_until: before.new_until, admitted_at: before.admitted_at ?? null, exempt: before.exempt ?? false }) };
      directory.set(pc, entry);
      if (fresh) this.ring(account, session.family);
      return json({ pc: entry });
    }
    if (pc !== undefined && request.method === "DELETE") {
      directory.delete(pc);
      this.pcAdmissions.delete(box(pc, account));
      this.usedAccounts.add(account);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/records" && request.method === "POST") {
      const body = await request.json() as { server_ids?: unknown; record?: unknown };
      if (!Array.isArray(body.server_ids) || body.server_ids.length > ACCOUNT_RECORDS_MAX || !body.server_ids.every((id) => typeof id === "string" && directory.has(id))) {
        return problem(400, "unknown_pc", "List PCs of this account only");
      }
      const record = await readAccountRecord(body.record);
      if (!record) return problem(400, "signature_invalid", "The signature does not hold");
      if (record.account !== account) return problem(403, "account_mismatch", "The record is for another account");
      const targets = [...new Set(body.server_ids as string[])];
      this.expire();
      if (targets.some((id) => (this.mailboxes.get(box(id, account))?.length ?? 0) >= MAILBOX_MAX)) return problem(429, "mailbox_full", "That PC has not collected its records");
      for (const id of targets) {
        const queue = this.mailboxes.get(box(id, account)) ?? [];
        queue.push({ seq: ++this.seq, record, at: this.now() });
        this.mailboxes.set(box(id, account), queue);
      }
      return json({ queued: new Set(body.server_ids).size });
    }
    if (path === "/v1/safety-records" && request.method === "POST" && this.opensAll) return await this.safetyRecord(account, await request.json());
    if (path === "/v1/admissions" && request.method === "GET") {
      // what the approving client checks the key PC X shows it against, before it signs an add
      const admissions = this.admissionList
        .filter((a) => a.account === account && this.now() - Date.parse(a.at) < ADMISSION_TTL_MS)
        .map(({ key, label, server_id, at, os, country, city }) => ({ key, label, server_id, at, os, country, city }));
      return json({ admissions });
    }
    if (path === "/v1/admissions" && request.method === "POST") {
      const body = await request.json() as { server_id?: unknown; label?: unknown; key?: unknown; os?: unknown; quiet?: unknown };
      if (body.quiet !== undefined && typeof body.quiet !== "boolean") return problem(400, "invalid_request", "quiet is true or false");
      if (typeof body.server_id !== "string" || !directory.has(body.server_id) || typeof body.label !== "string") return problem(400, "unknown_pc", "List PCs of this account only");
      if (!isAccountKeyEncoding(body.key)) return problem(400, "invalid_key", "Name the waiting device's account key");
      // quiet only for an app's own sign-in: one a typed device code opened gets the ordinary kind
      const quiet = body.quiet === true && !this.deviceFamilies.has(session.family);
      if (!this.withinRateLimit(quiet ? `quiet_admissions:${account}` : `admissions:${account}`, quiet ? QUIET_ADMISSIONS_PER_WINDOW : ADMISSIONS_PER_WINDOW)) return problem(429, "too_many_admissions", "Too many requests; try again later");
      const admission = { id: randomHex(16), server_id: body.server_id, account, label: body.label, key: body.key, at: this.iso(), os: accountOsOf(body.os), ...this.requestPlace };
      (quiet ? this.quietList : this.admissionList).push(admission);
      if (!quiet) this.ring(account, session.family);
      return json({ id: admission.id });
    }
    return problem(404, "not_found", "Unknown request");
  }

  private async pc(request: Request, path: string): Promise<Response> {
    if (request.method !== "POST") return problem(404, "not_found", "Unknown request");
    const body = await request.json() as Record<string, unknown>;
    if (path === "/v1/pc/challenge") {
      const key = proofKey(body.public_key);
      if (!key || typeof body.server_id !== "string" || deriveServerId(key) !== body.server_id) return problem(401, "server_key_mismatch", "That key does not give that server_id");
      const challengeId = randomHex(16);
      const { expected, frame } = serverChallenge(key, { server_id: body.server_id, role: "account", connection_id: challengeId });
      this.challenges.set(challengeId, { server_id: body.server_id, expected, expires: this.now() + CHALLENGE_TTL_MS });
      return json({ challenge_id: challengeId, frame });
    }
    if (path === "/v1/pc/mailbox" || (path === "/v1/pc/admission" && this.opensAll)
      || (path === "/v1/pc/snapshot" && (this.opensAll || this.reportsStep2Off))) {
      const challenge = typeof body.challenge_id === "string" ? this.challenges.get(body.challenge_id) : undefined;
      if (typeof body.challenge_id === "string") this.challenges.delete(body.challenge_id);
      if (!challenge || challenge.server_id !== body.server_id || this.now() > challenge.expires || !verifyServerProof(body.proof, challenge.expected)) {
        return problem(401, "proof_invalid", "Ask for a new challenge and answer it");
      }
      if (typeof body.account !== "string") return problem(400, "invalid_account", "Name the account this PC belongs to");
      if (path === "/v1/pc/admission") {
        // G1: only the named account's own admission, while that account lists the PC; any other account's is invisible
        const open = this.pcAdmissions.get(box(challenge.server_id, body.account));
        const entry = this.directories.get(body.account)?.get(challenge.server_id);
        // retry-safe for 10 minutes, inclusive; it ends with the sign-in that made it
        if (open === undefined || this.now() - open.at > ADMISSION_TTL_MS || this.revokedFamilies.has(open.family) || entry?.new_until == null) return problem(404, "no_admission", "No account added this PC in one press");
        open.taken = true;
        return json({ account: body.account, admitted_at: new Date(open.at).toISOString(), new_until: entry.new_until });
      }
      if (path === "/v1/pc/snapshot") {
        // P6: only a PC the account lists reads the account's devices and records
        if (!this.opensAll) return this.directories.get(body.account)?.has(challenge.server_id) === true
          ? problem(404, "step2_off", "Step 2 is off for this account")
          : problem(404, "not_found", "Unknown request");
        if (this.directories.get(body.account)?.has(challenge.server_id) !== true) return problem(403, "not_listed", "This PC is not one of the account's");
        return this.snapshotPage(challenge.server_id, body.account, body.snapshot, body.page);
      }
      this.expire();
      const key = box(challenge.server_id, body.account);
      const queue = this.mailboxes.get(key) ?? [];
      const ack = typeof body.ack === "number" ? body.ack : null;
      const rest = ack === null ? queue : queue.filter(({ seq }) => seq > ack);
      this.mailboxes.set(key, rest);
      // only the account the PC says it belongs to learns that it came by
      const entry = this.directories.get(body.account)?.get(challenge.server_id);
      if (entry) entry.last_seen_at = this.iso();
      const admissions = this.admissionList
        .filter((a) => a.server_id === challenge.server_id && a.account === body.account && this.now() - Date.parse(a.at) < ADMISSION_TTL_MS)
        .map(({ key, label, at }) => ({ key, label, at }));
      // the quiet ones in a field of their own, and only while the account still lists the PC
      const quiet = entry === undefined ? [] : this.quietList
        .filter((a) => a.server_id === challenge.server_id && a.account === body.account && this.now() - Date.parse(a.at) < ADMISSION_TTL_MS)
        .map(({ key, label, at }) => ({ key, label, at }));
      return json({ records: rest.slice(0, MAILBOX_PAGE).map(({ seq, record }) => ({ seq, record })), more: rest.length > MAILBOX_PAGE, admissions, quiet_admissions: quiet });
    }
    return problem(404, "not_found", "Unknown request");
  }

  /**
   * Device table P6, G1: page 0 freezes the account's state under a new snapshot id; every later page is
   * asked by that id and served from the same state, or answered `snapshot_gone`.
   */
  private snapshotPage(serverId: string, account: string, id: unknown, page: unknown): Response {
    let state: SnapshotState | undefined;
    if (id === undefined && (page === undefined || page === 0)) {
      const registry = this.registry(account);
      const entries = [...registry.devices].sort(([, a], [, b]) => a.no - b.no);
      state = {
        snapshot: randomHex(16), account, server_id: serverId, version: registry.version, methods_version: registry.methods_version,
        // P16, G12: a key above a standing freeze line is not list-eligible
        devices: entries.filter(([, d]) => !d.removed).map(([key, { no, eligible, label }]) => ({ key, no, eligible: eligible && !this.frozen(registry, no), label })),
        removed: entries.filter(([, d]) => d.removed).map(([key, { no }]) => ({ key, no })),
        blocks: [...registry.blocks], lifts: [...registry.lifts], freezes: [...registry.freezes],
      };
      this.snapshots.set(state.snapshot, state);
    } else if (typeof id === "string") {
      state = this.snapshots.get(id);
      if (state === undefined || state.account !== account || state.server_id !== serverId) return problem(410, SNAPSHOT_GONE, "Start the read again");
    }
    if (state === undefined || !Number.isSafeInteger(page ?? 0) || (page ?? 0) as number < 0) return problem(400, "invalid_request", "Ask page 0 with no snapshot, then each page by its snapshot id");
    const index = (page ?? 0) as number;
    // every list is paged on its own, so no page holds more than SNAPSHOT_PAGE entries of any list
    const lists = [state.devices, state.removed, state.blocks, state.lifts, state.freezes];
    const pages = Math.max(1, ...lists.map((list) => Math.ceil(list.length / SNAPSHOT_PAGE)));
    if (index >= pages) return problem(400, "invalid_request", "No such page");
    const slice = <T>(list: readonly T[]) => list.slice(index * SNAPSHOT_PAGE, (index + 1) * SNAPSHOT_PAGE);
    const body: AccountSnapshotPage = {
      v: ACCOUNT_SNAPSHOT_V, snapshot: state.snapshot, account, server_id: serverId, version: state.version, methods_version: state.methods_version, page: index, last: index === pages - 1,
      devices: slice(state.devices), removed: slice(state.removed), blocks: slice(state.blocks), lifts: slice(state.lifts), freezes: slice(state.freezes),
    };
    return json(body);
  }

  /**
   * Device table P16, P21, T52 (service effect): a block commits whole (target removed, freeze line, record
   * kept); a lift ends that block's service line. Each signer must be a registered member older than the target.
   */
  private frozen(registry: { freezes: readonly SnapshotFreezeLine[] }, no: number): boolean {
    return registry.freezes.some((line) => no > line.after);
  }

  private async safetyRecord(account: string, body: { record?: unknown }): Promise<Response> {
    let record: SafetyRecord;
    try {
      record = parseSafetyRecord(body.record);
    } catch (error) {
      if (error instanceof AccountRecordError) return problem(400, "record_invalid", error.message);
      throw error;
    }
    if (!isDeviceSafetyRecord(record)) return problem(400, "record_invalid", "Send a block or a device's lift");
    if (!await verifySafetyRecord(record)) return problem(400, "signature_invalid", "The signature does not hold");
    if (record.account !== account) return problem(403, "account_mismatch", "The record is for another account");
    const registry = this.registry(account);
    const signer = registry.devices.get(record.signer);
    if (signer && this.frozen(registry, signer.no)) return problem(403, "frozen", "A key a block freezes signs nothing");
    if (!signer || signer.removed || signer.no !== record.signer_no) return problem(403, "signer_not_member", "The signer is not a device of this account");
    if (record.kind === "block") {
      const target = registry.devices.get(record.target);
      if (!target || target.no !== record.target_no) return problem(403, "unknown_target", "The target is not where the block says");
      if (signer.no >= target.no) return problem(403, "signer_not_older", "Only a device older than the target blocks it");
      if (!registry.blocks.some((held) => held.id === record.id)) {
        if (target.removed) return problem(409, "target_removed", "The target is already removed");
        target.removed = true;
        registry.blocks.push(record);
        registry.freezes.push({ block: record.id, target: record.target, after: record.target_no });
        registry.version += 1;
      }
      return json({ id: record.id });
    }
    const block = registry.blocks.find((held) => held.id === record.target);
    if (!block) return problem(404, "not_found", "No such block");
    if (record.signer_no >= block.target_no) return problem(403, "signer_not_older", "Only a device older than the blocked one lifts it");
    // T52: as the service, only a list-eligible device lifts
    if (!signer.eligible) return problem(403, "not_eligible", "This device cannot lift a block yet");
    if (!registry.lifts.some((held) => held.id === record.id)) {
      registry.lifts.push(record);
      registry.freezes = registry.freezes.filter((line) => line.block !== block.id);
      registry.version += 1;
    }
    return json({ id: record.id });
  }

  private expire(): void {
    const cutoff = this.now() - MAILBOX_TTL_MS;
    for (const [id, box] of this.mailboxes) this.mailboxes.set(id, box.filter(({ at }) => at > cutoff));
  }

  private iso(): string { return new Date(this.now()).toISOString(); }
}

/** One mailbox per PC and account: another account's records can neither fill nor hide this account's. */
function box(serverId: string, account: string): string {
  return `${serverId}\0${account}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function problem(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
