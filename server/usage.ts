/**
 * The plan limits of the AI subscriptions this PC's CLIs are signed in to, read with each CLI's
 * own sign-in: how much of the 5-hour session, the week or the billing month is used, and when it
 * starts over.
 *
 * Where each sign-in lives and which endpoint states its limits follows OpenUsage
 * (github.com/robinebers/openusage, MIT, at 2d2eabe).
 *
 * Read only, on purpose: an OAuth token is never refreshed here. Claude, Codex, Cursor and Grok
 * rotate refresh tokens, so a refresh the CLI did not make logs the CLI out. An expired token is
 * reported as `expired` instead; the CLI refreshes its own file the next time it runs.
 * Antigravity uses its official CLI only when HTTP omits Gemini quotas; the CLI owns its authentication.
 *
 * Nothing runs in the background: a provider is asked only when a client asks this server, at
 * most every FRESH_MS unless the client forces it, which is still limited to one ask per
 * MIN_REFRESH_MS. A provider that answered 429 is not asked again before it said to.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readStatusline, type StatuslinePayload } from "./statusline.ts";
import { installStatusline, removeStatusline, StatuslineInstallError, statuslineInstallState, type StatuslineInstallState } from "./statusline-install.ts";
import type { ProviderUsage, UsageProblem, UsageProviderId, UsageReport, UsageWindow } from "../shared/protocol.ts";
import { jsonResponse } from "./http.ts";
import { opencodeDatabasePath } from "./opencode.ts";

export const FRESH_MS = 5 * 60_000;
export const MIN_REFRESH_MS = 30_000;
/** after a failure or an expired sign-in: soon enough to pick up the CLI's next refresh */
export const RETRY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 5_000;
const USER_AGENT = "ovis";
/** the most a credential file, a command's output or a provider's answer may hold; more is unreadable */
export const MAX_READ_BYTES = 1024 * 1024;

export type KeychainRead = { status: "found"; value: string } | { status: "missing" } | { status: "locked" };

/** Everything a provider touches outside this file, so tests can stand in for it. */
export interface UsageContext {
  home: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  fetch(url: string, init: RequestInit): Promise<Response>;
  keychain(service: string, account?: string): Promise<KeychainRead>;
  /** a command's trimmed stdout, or null when it is missing, fails or hangs */
  run(argv: string[], timeoutMs?: number): Promise<string | null>;
  /** whether a command is installed on this server's PATH */
  has(command: string): boolean;
  now(): number;
}

/** Who a sign-in belongs to: `id` tells accounts apart, `label` is how its owner knows it (an email, a login). */
interface Account {
  id: string;
  label: string | null;
}

interface SignIn {
  token: string;
  /** epoch ms; null when the sign-in does not say */
  expiresAt: number | null;
  plan?: string | null;
  /** the ChatGPT workspace Codex asks for */
  chatgptAccount?: string | null;
  /** further tokens of the same account, tried in order when the service refuses the one before */
  fallbacks?: string[];
  /** null when the sign-in does not say whose it is */
  account?: Account | null;
  /** Copilot: found only through the GitHub CLI, never signed in to Copilot in an editor */
  cliOnly?: boolean;
  /** Copilot: named editor accounts to match when an older CLI cannot identify its token */
  editorAccounts?: string[];
}

/**
 * A sign-in where it was found. `source` names the place (a directory, a keychain item), stable
 * across reads; one PC can hold several, each of its own account. `locked`: a keychain item this
 * session cannot read.
 */
type Found = { source: string; home?: CredentialHome } & (SignIn | { locked: true; account?: Account | null });

/**
 * Where a Claude or Codex sign-in lives, as its CLI is told to sign in there again: the default home
 * (no variable set, the keychain item the CLI names by default), or a directory, as it was configured.
 * A tag, not a source string: a configured directory may well be named `default` or `keychain`.
 */
export type CredentialHome = { readonly kind: "default" } | { readonly kind: "dir"; readonly dir: string };

interface Reading {
  plan: string | null;
  windows: UsageWindow[];
  /** whose numbers these are, when the answer says and the sign-in did not */
  account?: Account | null;
  /** when a local reading was taken (epoch ms); an endpoint's answer is taken now */
  checkedAt?: number;
}

export interface UsageProvider {
  id: UsageProviderId;
  /** every sign-in of this provider on this PC; none when not signed in here */
  signIns(ctx: UsageContext): Promise<Found[]>;
  /** A token-free reading matched to this sign-in; checked before endpoint expiry/backoff gates. */
  readLocal?(ctx: UsageContext, signIn: SignIn): Reading | null;
  /** null: signed in, but to an account without this plan */
  read(ctx: UsageContext, signIn: SignIn): Promise<Reading | null>;
  /** the command a sign-in may be kept behind that this PC lacks, so `signIns` could not look there; null when none */
  missingCommand?(ctx: UsageContext): string | null;
}

/** an answer past MAX_READ_BYTES */
class UsageTooLarge extends Error {}

export class UsageHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number | null) {
    super(`HTTP ${status}`);
  }
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
/** a number, or a proto-JSON int64 (sent as a string) */
const number = (value: unknown): number | null => {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
};
const percent = (value: number): number => Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;

/** `home`'s directories whose names start with `prefix` (".codex-work"), in name order */
function siblingDirs(home: string, prefix: string): string[] {
  try {
    return readdirSync(home, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => join(home, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/** a keychain read as found sign-ins: none, the one, or a locked item */
function keychainFound(result: SignIn | "locked" | null, source: string, account: Account | null = null): Found[] {
  if (result === null) return [];
  return [result === "locked" ? { source, locked: true, account } : { ...result, account: result.account ?? account, source }];
}

/**
 * A keychain item and a credentials file for the same sign-in. A CLI refreshes the file alone when it
 * cannot write the keychain (started outside the desktop session), so the item can hold a token that
 * expired hours ago: the later one wins. An item that names no expiry is not known to be older, and stays.
 */
function keychainOrFile(keychain: SignIn | "locked" | null, file: SignIn | null, source: string, account: Account | null = null): Found[] {
  const item = keychain && keychain !== "locked" ? keychain : null;
  const fileIsLater = file != null && item != null && file.expiresAt != null && item.expiresAt != null && file.expiresAt > item.expiresAt;
  if (item && !fileIsLater) return keychainFound(item, source, account);
  return file ? [{ ...file, account: file.account ?? account, source }] : keychainFound(keychain, source, account);
}

function parseJson(source: string | null): unknown {
  if (source === null) return null;
  try { return JSON.parse(source); } catch { return null; }
}

function readText(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(MAX_READ_BYTES + 1);
    let size = 0;
    for (let read = 1; read > 0 && size <= MAX_READ_BYTES; size += read) read = readSync(fd, buffer, size, buffer.length - size, null);
    return size > MAX_READ_BYTES ? null : buffer.toString("utf8", 0, size);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A stream's text up to MAX_READ_BYTES; null past it, the rest left unread. */
async function readCapped(stream: ReadableStream<Uint8Array> | null): Promise<string | null> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_READ_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** ISO 8601 from an ISO string or epoch seconds or milliseconds */
function isoTime(value: unknown): string | null {
  const n = number(value);
  if (n !== null && n > 0) return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  const s = text(value);
  if (!s) return null;
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function epochMs(value: unknown): number | null {
  const iso = isoTime(value);
  return iso === null ? null : Date.parse(iso);
}

function jwtClaims(token: string): Json {
  const payload = token.split(".")[1];
  if (!payload) return {};
  try { return record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))); } catch { return {}; }
}

function jwtExpiry(token: string): number | null {
  const exp = number(jwtClaims(token)["exp"]);
  return exp === null ? null : exp * 1000;
}

/** The span a limit counts over, from its length in seconds. */
function kindOf(seconds: number | null, fallback: UsageWindow["kind"]): UsageWindow["kind"] {
  if (seconds === null || seconds <= 0) return fallback;
  if (seconds <= 6 * 3600) return "session";
  if (seconds <= 36 * 3600) return "day";
  if (seconds <= 8 * 86400) return "week";
  return "month";
}

const FIVE_HOURS = 5 * 3600;
const SEVEN_DAYS = 7 * 86400;

/** When a window `seconds` long that resets at `resetsAt` began; null when either is unknown. */
function startOf(resetsAt: string | null, seconds: number | null): string | null {
  return resetsAt === null || seconds === null || seconds <= 0 ? null : new Date(Date.parse(resetsAt) - seconds * 1000).toISOString();
}

function retryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

async function requestJson(ctx: UsageContext, url: string, init: RequestInit): Promise<Json> {
  const response = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new UsageHttpError(response.status, retryAfter(response.headers.get("retry-after")));
  }
  const body = await readCapped(response.body);
  if (body === null) throw new UsageTooLarge(`${new URL(url).host} answered more than ${MAX_READ_BYTES} bytes`);
  return record(JSON.parse(body));
}

/** The first keychain item that yields a sign-in; "locked" when one exists but could not be read. */
async function fromKeychain(ctx: UsageContext, service: string, accounts: Array<string | undefined>, parse: (value: string) => SignIn | null): Promise<SignIn | "locked" | null> {
  if (ctx.platform !== "darwin") return null;
  for (const account of accounts) {
    const found = await ctx.keychain(service, account);
    if (found.status === "locked") return "locked";
    if (found.status === "found") {
      const signIn = parse(found.value);
      if (signIn) return signIn;
    }
  }
  return null;
}

// ---- Claude Code: keychain `Claude Code-credentials` on macOS, else ~/.claude/.credentials.json ----

/** the account a Claude Code config file says is signed in: `oauthAccount` in .claude.json */
function claudeAccount(path: string): Account | null {
  const oauth = record(record(parseJson(readText(path)))["oauthAccount"]);
  const id = text(oauth["accountUuid"]);
  return id ? { id, label: text(oauth["emailAddress"]) } : null;
}

/**
 * Where Claude Code keeps each sign-in: the default one, then one per config directory it was
 * pointed at (CLAUDE_CONFIG_DIR, and ~/.claude-* for the usual second account). For such a
 * directory it names the keychain item after the directory's hash, and keeps .claude.json in it.
 */
function claudeHomes(ctx: UsageContext): ClaudeHome[] {
  const dirs = [ctx.env["CLAUDE_CONFIG_DIR"], ...siblingDirs(ctx.home, ".claude-")].filter((dir): dir is string => Boolean(dir));
  return [claudeHome(ctx, { kind: "default" }), ...[...new Set(dirs)].map((dir) => claudeHome(ctx, { kind: "dir", dir }))];
}

interface ClaudeHome { source: string; service: string; dir: string; config: string; home: CredentialHome }

function claudeHome(ctx: UsageContext, home: CredentialHome): ClaudeHome {
  if (home.kind === "default") return { source: "default", service: "Claude Code-credentials", dir: join(ctx.home, ".claude"), config: join(ctx.home, ".claude.json"), home };
  const hash = createHash("sha256").update(home.dir).digest("hex").slice(0, 8);
  return { source: home.dir, service: `Claude Code-credentials-${hash}`, dir: home.dir, config: join(home.dir, ".claude.json"), home };
}

/** the sign-in one Claude home holds: its keychain item or its credentials file, whichever is later */
async function claudeFound(ctx: UsageContext, home: ClaudeHome): Promise<Found[]> {
  const user = ctx.env["USER"];
  const account = claudeAccount(home.config);
  const keychain = await fromKeychain(ctx, home.service, user ? [user, undefined] : [undefined], claudeSignIn);
  const file = claudeSignIn(readText(join(home.dir, ".credentials.json")));
  return keychainOrFile(keychain, file, home.source, account).map((found) => ({ ...found, home: home.home }));
}

function claudeSignIn(source: string | null): SignIn | null {
  const oauth = record(record(parseJson(source))["claudeAiOauth"]);
  const token = text(oauth["accessToken"]);
  return token ? { token, expiresAt: number(oauth["expiresAt"]), plan: text(oauth["subscriptionType"]) } : null;
}

/** `seconds`: the window's length, which Claude names in the key (`five_hour`, `seven_day`) */
function claudeWindow(value: unknown, kind: UsageWindow["kind"], scope: string | null, seconds: number): UsageWindow | null {
  const window = record(value);
  const used = number(window["utilization"]);
  const resetsAt = isoTime(window["resets_at"]);
  return used === null ? null : { kind, scope, used_percent: percent(used), resets_at: resetsAt, starts_at: startOf(resetsAt, seconds) };
}

/**
 * Claude's windows from the payload its own status line draws (server/statusline.ts): the five-hour
 * session and the week, exactly the numbers the CLI shows, with no request and no token. The API
 * below stays the fallback for a machine whose status line has not written a payload yet.
 */
function claudeStatuslineWindows(payload: StatuslinePayload): UsageWindow[] {
  const windows: UsageWindow[] = [];
  if (payload.fiveHour) windows.push({ kind: "session", scope: null, used_percent: percent(payload.fiveHour.usedPercent), resets_at: payload.fiveHour.resetsAt, starts_at: startOf(payload.fiveHour.resetsAt, FIVE_HOURS) });
  if (payload.sevenDay) windows.push({ kind: "week", scope: null, used_percent: percent(payload.sevenDay.usedPercent), resets_at: payload.sevenDay.resetsAt, starts_at: startOf(payload.sevenDay.resetsAt, SEVEN_DAYS) });
  return windows;
}

const claude: UsageProvider = {
  id: "claude",
  async signIns(ctx) {
    return (await Promise.all(claudeHomes(ctx).map((home) => claudeFound(ctx, home)))).flat();
  },
  readLocal(ctx, signIn) {
    const local = readStatusline(ctx.home, ctx.now());
    if (!local?.account || local.account.id !== signIn.account?.id) return null;
    const windows = claudeStatuslineWindows(local);
    return windows.length > 0 ? { plan: signIn.plan ?? null, windows, checkedAt: local.readAt } : null;
  },
  async read(ctx, signIn) {
    const body = await requestJson(ctx, "https://api.anthropic.com/api/oauth/usage", {
      headers: { authorization: `Bearer ${signIn.token}`, accept: "application/json", "anthropic-beta": "oauth-2025-04-20", "user-agent": USER_AGENT },
    });
    const windows = [
      claudeWindow(body["five_hour"], "session", null, FIVE_HOURS),
      claudeWindow(body["seven_day"], "week", null, SEVEN_DAYS),
      claudeWindow(body["seven_day_opus"], "week", "Opus", SEVEN_DAYS),
      claudeWindow(body["seven_day_sonnet"], "week", "Sonnet", SEVEN_DAYS),
    ].filter((window): window is UsageWindow => window !== null);
    // a model with a weekly limit of its own (Fable) is only in `limits`; the flat fields win
    for (const limit of (Array.isArray(body["limits"]) ? body["limits"] : []).map(record)) {
      const model = text(record(record(limit["scope"])["model"])["display_name"]);
      const used = number(limit["percent"]);
      if (limit["kind"] !== "weekly_scoped" || !model || used === null || windows.some((window) => window.scope === model)) continue;
      windows.push({ kind: "week", scope: model, used_percent: percent(used), resets_at: isoTime(limit["resets_at"]), starts_at: null });
    }
    return { plan: null, windows };
  },
};

// ---- Codex: auth.json under CODEX_HOME, ~/.config/codex or ~/.codex; keychain `Codex Auth` ----

function codexSignIn(source: string | null): SignIn | null {
  const tokens = record(record(parseJson(source))["tokens"]);
  const token = text(tokens["access_token"]);
  if (!token) return null;
  const claims = jwtClaims(token);
  const auth = record(claims["https://api.openai.com/auth"]);
  const workspace = text(tokens["account_id"]) ?? text(auth["chatgpt_account_id"]);
  const email = text(record(claims["https://api.openai.com/profile"])["email"]) ?? text(jwtClaims(text(tokens["id_token"]) ?? "")["email"]);
  // limits are per person in a workspace: the same email in a team workspace is another plan
  const user = text(auth["chatgpt_user_id"]) ?? text(auth["user_id"]);
  const id = text(auth["chatgpt_account_user_id"]) ?? (user || workspace ? [user, workspace].filter(Boolean).join("__") : email);
  return { token, expiresAt: jwtExpiry(token), plan: text(auth["chatgpt_plan_type"]), chatgptAccount: workspace, account: id ? { id, label: email } : null };
}

function codexWindow(value: unknown, now: number): UsageWindow | null {
  const window = record(value);
  const used = number(window["used_percent"]);
  if (used === null) return null;
  const after = number(window["reset_after_seconds"]);
  const seconds = number(window["limit_window_seconds"]);
  const resetsAt = isoTime(window["reset_at"]) ?? (after === null ? null : new Date(now + after * 1000).toISOString());
  return { kind: kindOf(seconds, "session"), scope: null, used_percent: percent(used), resets_at: resetsAt, starts_at: startOf(resetsAt, seconds) };
}

/** the sign-in a Codex home's auth.json holds, listed as that directory */
function codexFileFound(home: string): Found[] {
  const signIn = codexSignIn(readText(join(home, "auth.json")));
  return signIn ? [{ ...signIn, source: home, home: { kind: "dir", dir: home } }] : [];
}

/** the `Codex Auth` keychain item, which Codex's default home may keep its sign-in in instead of a file */
async function codexKeychainFound(ctx: UsageContext): Promise<Found[]> {
  return keychainFound(await fromKeychain(ctx, "Codex Auth", [undefined], codexSignIn), "keychain")
    .map((found): Found => ({ ...found, home: { kind: "default" } }));
}

const codex: UsageProvider = {
  id: "codex",
  async signIns(ctx) {
    // CODEX_HOME points Codex elsewhere; ~/.codex-* is where a second account usually lives
    const homes = [ctx.env["CODEX_HOME"], join(ctx.home, ".config", "codex"), join(ctx.home, ".codex"), ...siblingDirs(ctx.home, ".codex-")];
    const found = [...new Set(homes.filter((home): home is string => Boolean(home)))].flatMap(codexFileFound);
    return found.length ? found : codexKeychainFound(ctx);
  },
  async read(ctx, signIn) {
    const body = await requestJson(ctx, "https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        authorization: `Bearer ${signIn.token}`, accept: "application/json", "user-agent": USER_AGENT,
        ...(signIn.chatgptAccount ? { "chatgpt-account-id": signIn.chatgptAccount } : {}),
      },
    });
    const limits = record(body["rate_limit"]);
    const now = ctx.now();
    const windows = [codexWindow(limits["primary_window"], now), codexWindow(limits["secondary_window"], now)]
      .filter((window): window is UsageWindow => window !== null);
    return { plan: text(body["plan_type"]), windows };
  },
};

// ---- Cursor: the app's state.vscdb, or the cursor-agent CLI's keychain item ----

function cursorDatabase(ctx: UsageContext): string {
  return ctx.platform === "darwin"
    ? join(ctx.home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
    : join(ctx.env["XDG_CONFIG_HOME"] || join(ctx.home, ".config"), "Cursor", "User", "globalStorage", "state.vscdb");
}

function cursorAppSignIn(path: string): SignIn | null {
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const value = (key: string) => text(db!.query<{ value: unknown }, [string, number]>("SELECT value FROM ItemTable WHERE key = ? AND length(value) <= ?").get(key, MAX_READ_BYTES)?.value);
    const token = value("cursorAuth/accessToken");
    return token ? { token, expiresAt: jwtExpiry(token), plan: value("cursorAuth/stripeMembershipType"), account: cursorAccount(token, value("cursorAuth/cachedEmail")) } : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** a Cursor account by its token's subject, named by the email Cursor keeps beside it */
function cursorAccount(token: string, email: string | null): Account | null {
  const id = text(jwtClaims(token)["sub"]);
  return id ? { id, label: email } : null;
}

const cursor: UsageProvider = {
  id: "cursor",
  async signIns(ctx) {
    const app = cursorAppSignIn(cursorDatabase(ctx));
    const cliEmail = text(record(record(parseJson(readText(join(ctx.home, ".cursor", "cli-config.json"))))["authInfo"])["email"]);
    const cli = await fromKeychain(ctx, "cursor-access-token", [undefined], (value) => {
      const token = text(value);
      return token ? { token, expiresAt: jwtExpiry(token), account: cursorAccount(token, cliEmail) } : null;
    });
    if (!app) return keychainFound(cli, "cli");
    if (!cli || cli === "locked") return [{ ...app, source: "app" }];
    // two accounts are two plans; one account signed in to both is used through the longer-lived token
    if (app.account?.id !== cli.account?.id) return [{ ...app, source: "app" }, { ...cli, source: "cli" }];
    return (cli.expiresAt ?? 0) > (app.expiresAt ?? 0) ? [{ ...cli, plan: app.plan ?? null, account: app.account, source: "cli" }] : [{ ...app, source: "app" }];
  },
  async read(ctx, signIn) {
    const body = await requestJson(ctx, "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
      method: "POST",
      headers: { authorization: `Bearer ${signIn.token}`, "content-type": "application/json", "connect-protocol-version": "1", "user-agent": USER_AGENT },
      body: "{}",
    });
    const plan = record(body["planUsage"]);
    const limit = number(plan["limit"]);
    const remaining = number(plan["remaining"]);
    const used = number(plan["totalPercentUsed"]) ?? (limit && remaining !== null ? (limit - remaining) / limit * 100 : null);
    const resetsAt = isoTime(body["billingCycleEnd"]);
    // the plan-wide share, then the two allowances inside it: Cursor's own models (Auto) and the rest (API)
    const windows = [[used, null], [number(plan["autoPercentUsed"]), "Cursor models"], [number(plan["apiPercentUsed"]), "Other models"]]
      .filter((entry): entry is [number, string | null] => entry[0] !== null)
      .map(([share, scope]): UsageWindow => ({ kind: "month", scope, used_percent: percent(share), resets_at: resetsAt, starts_at: null }));
    return { plan: null, windows };
  },
};

// ---- GitHub Copilot: the editor plugin's sign-in, else the GitHub CLI's ----

interface GitHubToken {
  token: string;
  /** the GitHub login it belongs to, when the file or the CLI says */
  login: string | null;
  /** from an editor's Copilot sign-in, not the GitHub CLI */
  editor: boolean;
}

function copilotFileTokens(source: string | null): GitHubToken[] {
  return Object.entries(record(parseJson(source))).flatMap(([host, entry]) => {
    const token = host.startsWith("github.com") ? text(record(entry)["oauth_token"]) : null;
    return token ? [{ token, login: text(record(entry)["user"]), editor: true }] : [];
  });
}

/** every github.com account the GitHub CLI holds a working sign-in for; the active one alone on an older CLI */
async function ghTokens(ctx: UsageContext): Promise<GitHubToken[]> {
  // only github.com: status checks every host it lists with that host's own credentials
  const accounts = record(record(parseJson(await ctx.run(["gh", "auth", "status", "--hostname", "github.com", "--json", "hosts"])))["hosts"])["github.com"];
  if (!Array.isArray(accounts)) {
    const token = text(await ctx.run(["gh", "auth", "token", "--hostname", "github.com"]));
    return token ? [{ token, login: null, editor: false }] : [];
  }
  const tokens = await Promise.all(accounts.map(async (entry): Promise<GitHubToken | null> => {
    const account = record(entry);
    const login = text(account["login"]);
    // gh has already found a sign-in in error (a revoked token) refused
    if (!login || account["state"] !== "success") return null;
    // a GH_TOKEN/GITHUB_TOKEN sign-in has no stored token: a per-user lookup finds nothing
    const fromEnv = ["GH_TOKEN", "GITHUB_TOKEN"].includes(text(account["tokenSource"]) ?? "");
    const token = text(await ctx.run(["gh", "auth", "token", "--hostname", "github.com", ...(fromEnv ? [] : ["--user", login])]));
    return token ? { token, login, editor: false } : null;
  }));
  return tokens.filter((token): token is GitHubToken => token !== null);
}

function copilotWindow(value: unknown, scope: string, resetsAt: string | null): UsageWindow | null {
  const quota = record(value);
  const entitlement = number(quota["entitlement"]);
  const left = number(quota["percent_remaining"]);
  if (quota["unlimited"] === true || entitlement === null || entitlement <= 0 || left === null) return null;
  return { kind: "month", scope, used_percent: percent(100 - left), resets_at: resetsAt, starts_at: null };
}

const copilot: UsageProvider = {
  id: "copilot",
  async signIns(ctx) {
    const dir = join(ctx.env["XDG_CONFIG_HOME"] || join(ctx.home, ".config"), "github-copilot");
    const tokens = [...copilotFileTokens(readText(join(dir, "apps.json"))), ...copilotFileTokens(readText(join(dir, "hosts.json"))), ...await ghTokens(ctx)];
    const editorAccounts = tokens.flatMap(({ login, editor }) => editor && login ? [login.toLowerCase()] : []);
    // One sign-in per GitHub account. An editor sign-in can outlive its token by years: the same
    // account's next token (the GitHub CLI's) is tried after it. A token of no known login is a
    // sign-in of its own: it may be anyone's, and the first to answer would hide the others.
    const accounts = new Map<string, { login: string | null; tokens: string[]; editor: boolean }>();
    const seen = new Set<string>();
    let unknown = 0;
    for (const { token, login, editor } of tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      const id = login?.toLowerCase() ?? `#${++unknown}`;
      const account = accounts.get(id) ?? { login, tokens: [], editor: false };
      account.tokens.push(token);
      account.editor ||= editor;
      accounts.set(id, account);
    }
    return [...accounts].map(([id, { login, tokens: [token, ...fallbacks], editor }]): Found => ({
      source: login ? `github:${id}` : `github${id}`, token: token!, expiresAt: null, fallbacks, account: login ? { id, label: login } : null, cliOnly: !editor, editorAccounts,
    }));
  },
  async read(ctx, signIn) {
    // The tokens may belong to different GitHub accounts: the first one with Copilot answers. A 404
    // is an account without it; only when every token says so is Copilot left out.
    let body: Json | null = null;
    let refusal: UsageHttpError | null = null;
    for (const token of [signIn.token, ...signIn.fallbacks ?? []]) {
      try {
        body = await requestJson(ctx, "https://api.github.com/copilot_internal/user", {
          headers: {
            authorization: `token ${token}`, accept: "application/json", "user-agent": "GitHubCopilotChat/0.26.7",
            "editor-version": "vscode/1.96.2", "editor-plugin-version": "copilot-chat/0.26.7", "x-github-api-version": "2025-04-01",
          },
        });
        break;
      } catch (error) {
        if (!(error instanceof UsageHttpError) || ![401, 403, 404].includes(error.status)) throw error;
        if (error.status !== 404) refusal = error;
      }
    }
    if (body === null) {
      if (refusal) throw refusal;
      return null;
    }
    const resetsAt = isoTime(body["quota_reset_date"]);
    const snapshots = record(body["quota_snapshots"]);
    const windows = [
      copilotWindow(snapshots["premium_interactions"], "Premium", resetsAt),
      copilotWindow(snapshots["chat"], "Chat", resetsAt),
      copilotWindow(snapshots["completions"], "Completions", resetsAt),
    ].filter((window): window is UsageWindow => window !== null);
    // Copilot Free states what is left of a monthly allowance instead
    const left = record(body["limited_user_quotas"]);
    const monthly = record(body["monthly_quotas"]);
    for (const [key, scope] of [["chat", "Chat"], ["completions", "Completions"]] as const) {
      const total = number(monthly[key]);
      const remaining = number(left[key]);
      if (total && total > 0 && remaining !== null && !windows.some((window) => window.scope === scope)) {
        windows.push({ kind: "month", scope, used_percent: percent((total - remaining) / total * 100), resets_at: isoTime(body["limited_user_reset_date"]) ?? resetsAt, starts_at: null });
      }
    }
    // Copilot Free reports its plan as "individual"; only the SKU tells them apart
    const plan = text(body["access_type_sku"])?.includes("free") ? "free" : text(body["copilot_plan"]);
    const login = text(body["login"]);
    // GitHub grants Copilot Free to every account: a GitHub CLI sign-in alone is no sign of
    // using Copilot. An unnamed CLI token can still answer for a known editor account.
    const editorAccount = login !== null && signIn.editorAccounts?.includes(login.toLowerCase());
    if (plan === "free" && signIn.cliOnly && !editorAccount) return null;
    return { plan, windows, account: login ? { id: login.toLowerCase(), label: login } : null };
  },
};

// ---- Grok CLI: ~/.grok/auth.json ----

const PERIOD_KINDS: Record<string, UsageWindow["kind"]> = {
  USAGE_PERIOD_TYPE_DAILY: "day", USAGE_PERIOD_TYPE_WEEKLY: "week", USAGE_PERIOD_TYPE_MONTHLY: "month",
};

const grok: UsageProvider = {
  id: "grok",
  async signIns(ctx) {
    // one entry per account signed in
    return Object.entries(record(parseJson(readText(join(ctx.home, ".grok", "auth.json"))))).flatMap(([source, entry]): Found[] => {
      const value = record(entry);
      const token = text(value["key"]);
      const id = text(value["user_id"]) ?? text(value["principal_id"]) ?? source;
      return token ? [{ source, token, expiresAt: epochMs(value["expires_at"] ?? value["expires"]), account: { id, label: text(value["email"]) } }] : [];
    });
  },
  async read(ctx, signIn) {
    const body = await requestJson(ctx, "https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
      headers: { authorization: `Bearer ${signIn.token}`, "x-xai-token-auth": "xai-grok-cli", accept: "application/json", "user-agent": USER_AGENT },
    });
    const config = record(body["config"]);
    const period = record(config["currentPeriod"]);
    const stated = number(config["creditUsagePercent"]);
    const knownKind = PERIOD_KINDS[text(period["type"]) ?? ""];
    // an answer that states neither is not a plan's usage, whatever its status
    if (stated === null && knownKind === undefined) return { plan: null, windows: [] };
    const start = epochMs(period["start"]);
    const end = epochMs(period["end"]);
    const kind = knownKind ?? kindOf(start !== null && end !== null ? (end - start) / 1000 : null, "month");
    // proto-JSON leaves a zero out: a stated period without a percent is nothing used
    return { plan: null, windows: [{ kind, scope: null, used_percent: percent(stated ?? 0), resets_at: isoTime(period["end"]), starts_at: isoTime(period["start"]) }] };
  },
};

// ---- Antigravity (Google's Gemini and third-party model quota): keychain `gemini` / `antigravity`,
// or the CLI's `antigravity-oauth-token` file where there is no keychain (Linux) ----

function antigravitySignIn(value: string | null): SignIn | null {
  if (value === null) return null;
  const encoded = value.startsWith("go-keyring-base64:") ? Buffer.from(value.slice("go-keyring-base64:".length), "base64").toString("utf8") : value;
  const root = record(parseJson(encoded));
  const token = record(root["token"]);
  const access = text(token["access_token"]);
  if (!access) return null;
  const idToken = text(root["id_token"]);
  const claims = idToken ? jwtClaims(idToken) : {};
  const email = text(claims["email"]);
  const sub = text(claims["sub"]);
  const account = sub || email ? { id: sub ?? email!, label: email } : null;
  return { token: access, expiresAt: epochMs(token["expiry"]), account };
}

const ANTIGRAVITY_BUCKETS: Record<string, { kind: UsageWindow["kind"]; scope: string | null }> = {
  "gemini-5h": { kind: "session", scope: null },
  "gemini-weekly": { kind: "week", scope: null },
  "3p-5h": { kind: "session", scope: "Other models" },
  "3p-weekly": { kind: "week", scope: "Other models" },
};

function antigravityWindows(groups: unknown): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    const buckets = record(group)["buckets"];
    for (const bucket of Array.isArray(buckets) ? buckets : []) {
      const value = record(bucket);
      const shape = ANTIGRAVITY_BUCKETS[text(value["bucketId"] ?? value["id"]) ?? ""];
      const remaining = number(value["remainingFraction"] ?? value["remaining_fraction"]);
      // Missing fractions are unknown, not exhausted; bucket names do not state a start time.
      if (shape && remaining !== null) windows.push({ ...shape, used_percent: percent((1 - remaining) * 100), resets_at: isoTime(value["resetTime"] ?? value["reset_time"]), starts_at: null });
    }
  }
  return windows;
}

const antigravity: UsageProvider = {
  id: "antigravity",
  async signIns(ctx) {
    const dir = ctx.env["ANTIGRAVITY_APP_DATA_DIR"] || join(ctx.home, ".gemini", "antigravity-cli");
    const file = antigravitySignIn(readText(join(dir, "antigravity-oauth-token")));
    const keychain = ctx.platform === "linux"
      ? antigravitySignIn(await ctx.run(["secret-tool", "lookup", "service", "gemini", "username", "antigravity"]))
      : await fromKeychain(ctx, "gemini", ["antigravity"], antigravitySignIn);
    return keychainOrFile(keychain, file, "keychain");
  },
  // Linux: the CLI keeps its sign-in in the Secret Service keyring, read here only through secret-tool
  missingCommand: (ctx) => ctx.platform === "linux" && !ctx.has("secret-tool") ? "secret-tool" : null,
  async read(ctx, signIn) {
    const init: RequestInit = {
      method: "POST",
      headers: { authorization: `Bearer ${signIn.token}`, accept: "application/json", "content-type": "application/json", "user-agent": "antigravity" },
      body: "{}",
    };
    let body: Json;
    try {
      body = await requestJson(ctx, "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", init);
    } catch (error) {
      if (error instanceof UsageHttpError && (error.status === 401 || error.status === 403 || error.status === 429)) throw error;
      body = await requestJson(ctx, "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", init);
    }
    const windows = antigravityWindows(body["groups"] ?? record(body["response"])["groups"]);
    if (windows.some((window) => window.scope === null)) return { plan: null, windows };
    // Only pay the CLI startup cost when HTTP omits Gemini quotas for this account.
    const cli = record(parseJson(await ctx.run(["agy", "--print", "/usage", "--output-format", "json", "--print-timeout", "30s"], 35_000).catch(() => null)));
    if (cli["status"] === "SUCCESS") {
      const cliWindows = antigravityWindows(record(record(cli["command"])["data"])["groups"]);
      if (cliWindows.length > 0) return { plan: null, windows: cliWindows };
    }
    return { plan: null, windows };
  },
};

// ---- OpenCode Go: the key OpenCode 2 keeps in its own store, else <XDG data>/opencode/auth.json, else OPENCODE_API_KEY ----

/** OpenCode's service may hold the write lock for a moment; a read waits this long, never more. */
const OPENCODE_DB_BUSY_TIMEOUT_MS = 250;

/**
 * OpenCode 2 keeps provider credentials itself, in the `credential` table of the store
 * `server/opencode.ts` reads: the live one is the active row whose value is `{"type":"key","key":…}`.
 * `auth.json` is the file OpenCode 1 wrote and 2 leaves standing, holding the key the service has
 * since replaced, so reading it alone reports a signed-in CLI as expired. The Go key is read first,
 * then the Zen key: the Go endpoint takes any console key, and answers 403 for one without a Go
 * subscription. A row is chosen as OpenCode chooses it: the active one, else the newest (rows it
 * imported from `auth.json` carry no flag). The store is OpenCode 2's when it has `session_v2`, as
 * `server/opencode.ts` tells them apart: 1.x stores have an empty `credential` table too. Null when
 * the file is not OpenCode 2's store (absent, OpenCode 1's, unreadable); `key` is null when the
 * store holds no key of its own (signed out, or an OAuth sign-in) or, once it is known to be
 * OpenCode 2's, cannot be read: the file it left standing holds a key it no longer uses either way.
 * A value past MAX_READ_BYTES is not read, as for the files.
 */
function opencodeStore(path: string | null): { key: string | null } | null {
  if (path === null) return null;
  let db: Database | undefined;
  let known = false;
  try {
    db = new Database(path, { readonly: true, create: false });
    db.exec(`PRAGMA busy_timeout = ${OPENCODE_DB_BUSY_TIMEOUT_MS}`);
    const tables = db.query("select count(*) as n from sqlite_master where type = 'table' and name in ('session_v2', 'credential')").get() as { n: number };
    if (tables.n < 2) return null;
    known = true;
    const selected = db.query("select case when length(value) <= ? then value end as value from credential where integration_id = ? order by active desc, time_created desc, id desc limit 1");
    for (const provider of ["opencode-go", "opencode"]) {
      const row = selected.get(MAX_READ_BYTES, provider) as { value?: unknown } | null;
      const entry = record(parseJson(text(row?.value ?? null)));
      const key = entry["type"] === "key" ? text(entry["key"]) : null;
      if (key) return { key };
    }
    return { key: null };
  } catch {
    // no file or not a database: not a store this reader knows; OpenCode 2's store that will not
    // answer now (busy past the timeout, damaged) still holds no key its old auth.json can stand in for
    return known ? { key: null } : null;
  } finally {
    db?.close();
  }
}

/**
 * OpenCode keeps every sign-in in that one file, keyed by provider id; an API key is
 * `{ type: "api", key }` and names no account.
 */
function opencodeSignIn(source: string | null): SignIn | null {
  const root = record(parseJson(source));
  for (const provider of ["opencode-go", "opencode"]) {
    const entry = record(root[provider]);
    const token = entry["type"] === "api" ? text(entry["key"]) : null;
    if (token) return { token, expiresAt: null };
  }
  return null;
}

const opencode: UsageProvider = {
  id: "opencode",
  async signIns(ctx) {
    // xdg-basedir, as OpenCode resolves it: XDG_DATA_HOME, else ~/.local/share, on macOS too
    const dir = join(ctx.env["XDG_DATA_HOME"] || join(ctx.home, ".local", "share"), "opencode");
    // the key OpenCode 2 signs its own requests with, ahead of the file it no longer writes; the
    // place stays `dir` either way, so one account keeps one identity whichever store answered
    const store = opencodeStore(opencodeDatabasePath(ctx.env, ctx.home));
    if (store?.key) return [{ token: store.key, expiresAt: null, source: dir }];
    // OpenCode 2 imports auth.json once, when it takes over a 1.x store, and never reads it again:
    // a store without a key is a sign-out the file it left standing must not undo
    const file = store ? null : opencodeSignIn(readText(join(dir, "auth.json")));
    if (file) return [{ ...file, source: dir }];
    // the variable OpenCode itself reads for both providers (models.dev)
    const token = text(ctx.env["OPENCODE_API_KEY"]);
    return token ? [{ token, expiresAt: null, source: "env" }] : [];
  },
  async read(ctx, signIn) {
    let body: Json;
    try {
      body = await requestJson(ctx, "https://opencode.ai/zen/go/v1/usage", {
        headers: { authorization: `Bearer ${signIn.token}`, accept: "application/json", "user-agent": USER_AGENT },
      });
    } catch (error) {
      if (error instanceof UsageHttpError && error.status === 403) return null;
      throw error;
    }
    const usage = record(body["usage"]);
    const windows: UsageWindow[] = [];
    const rolling = record(usage["rolling"]);
    const rollingPercent = number(rolling["percent"]);
    if (rollingPercent !== null) {
      windows.push({ kind: "session", scope: null, used_percent: percent(rollingPercent), resets_at: isoTime(rolling["resetsAt"]), starts_at: null });
    }
    const weekly = record(usage["weekly"]);
    const weeklyPercent = number(weekly["percent"]);
    if (weeklyPercent !== null) {
      windows.push({ kind: "week", scope: null, used_percent: percent(weeklyPercent), resets_at: isoTime(weekly["resetsAt"]), starts_at: null });
    }
    const monthly = record(usage["monthly"]);
    const monthlyPercent = number(monthly["percent"]);
    if (monthlyPercent !== null) {
      windows.push({ kind: "month", scope: null, used_percent: percent(monthlyPercent), resets_at: isoTime(monthly["resetsAt"]), starts_at: null });
    }
    return { plan: text(body["plan"]) ?? "Go", windows };
  },
};

export const USAGE_PROVIDERS: readonly UsageProvider[] = [claude, codex, cursor, copilot, grok, antigravity, opencode];

/** Keychain services whose read hung (an access prompt nobody answered): not asked again. */
const promptedServices = new Set<string>();

async function readKeychain(service: string, account?: string): Promise<KeychainRead> {
  if (promptedServices.has(service)) return { status: "locked" };
  const child = Bun.spawn(["security", "find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"], {
    stdin: "ignore", stdout: "pipe", stderr: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, COMMAND_TIMEOUT_MS);
  try {
    const output = await readCapped(child.stdout);
    if (output === null) child.kill();
    const code = await child.exited;
    // the command is over: its timer must not fire during the login-session read below and pass for a prompt
    clearTimeout(timer);
    if (output === null) return { status: "missing" };
    if (code === 0) return { status: "found", value: output.trim() };
    // 44: errSecItemNotFound. Anything else found an item it could not read (36: a locked keychain).
    if (code === 44 && !timedOut) return { status: "missing" };
    // 36 without a prompt: this server runs outside the login (Aqua) session - started over SSH or by a
    // detached multiplexer - where the login keychain refuses any read. Ask from the login session instead.
    if (code === 36 && !timedOut) {
      const gui = await readKeychainInLoginSession(service, account);
      if (gui !== null) return { status: "found", value: gui };
    }
    if (timedOut) promptedServices.add(service);
    return { status: "locked" };
  } catch {
    return { status: "missing" };
  } finally {
    clearTimeout(timer);
  }
}

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** launchd labels must be unique per call: concurrent reads for different config dirs can start in the same millisecond. */
let loginSessionJobs = 0;

/** `launchctl <args>`'s exit code, killed after COMMAND_TIMEOUT_MS so a stalled launchctl cannot hold up the caller. */
async function launchctl(args: string[]): Promise<number> {
  const child = Bun.spawn(["launchctl", ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
  try { return await child.exited; } finally { clearTimeout(timer); }
}

/**
 * Reads a keychain item through a one-shot launchd job in the user's gui/<uid> domain, which runs in the
 * login session where the keychain is unlocked. The value comes back through a FIFO, never a file on disk.
 * null when not on macOS, the job cannot be loaded, or nothing came back in time.
 *
 * The FIFO is opened for reading and writing: that open never waits for the job, and since a FIFO read
 * cannot be cancelled, a newline of our own ends one the job never answers. `security -w` ends the
 * value with a newline, so the first line is the value.
 */
async function readKeychainInLoginSession(service: string, account?: string): Promise<string | null> {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") return null;
  const args = ["/usr/bin/security", "find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"];
  const domain = `gui/${process.getuid()}`;
  const label = `dev.ovis.keychain.${process.pid}.${Date.now()}.${++loginSessionJobs}`;
  const dir = mkdtempSync(join(tmpdir(), "ovis-keychain-"));
  const fifo = join(dir, "out");
  const plist = join(dir, "job.plist");
  let pipe: FileHandle | undefined;
  try {
    // awaited, not waited for: a stalled mkfifo must not hold every other request (#1404)
    const mkfifo = Bun.spawn(["mkfifo", "-m", "600", fifo], { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: COMMAND_TIMEOUT_MS, killSignal: "SIGKILL" });
    if (await mkfifo.exited !== 0) return null;
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array><key>StandardOutPath</key><string>${xml(fifo)}</string><key>StandardErrorPath</key><string>/dev/null</string><key>RunAtLoad</key><true/></dict></plist>
`, { mode: 0o600 });
    const handle = pipe = await open(fifo, "r+");
    let gaveUp = false;
    const giveUp = () => {
      gaveUp = true;
      try { writeSync(handle.fd, "\n"); } catch { /* nothing reads any more */ }
    };
    const reading = (async () => {
      const buffer = Buffer.alloc(MAX_READ_BYTES + 1);
      let size = 0;
      let line = -1;
      while (line === -1 && size <= MAX_READ_BYTES) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (bytesRead === 0) break;
        size += bytesRead;
        line = buffer.subarray(0, size).indexOf(0x0a);
      }
      return line === -1 ? null : buffer.toString("utf8", 0, line).trim();
    })().catch(() => null);
    const timer = setTimeout(giveUp, COMMAND_TIMEOUT_MS);
    try {
      if (await launchctl(["bootstrap", domain, plist]).catch(() => -1) !== 0) giveUp();
      const value = await reading;
      return gaveUp || !value ? null : value;
    } finally { clearTimeout(timer); }
  } catch {
    return null;
  } finally {
    await launchctl(["bootout", `${domain}/${label}`]).catch(() => undefined);
    await pipe?.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runCommand(argv: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<string | null> {
  if (!Bun.which(argv[0]!)) return null;
  try {
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    try {
      const output = await readCapped(child.stdout);
      if (output === null) child.kill();
      const code = await child.exited;
      return code === 0 && output !== null ? output.trim() : null;
    } finally { clearTimeout(timer); }
  } catch {
    return null;
  }
}

export function systemUsageContext(): UsageContext {
  return {
    home: homedir(),
    env: process.env,
    platform: process.platform,
    fetch: (url, init) => fetch(url, init),
    keychain: readKeychain,
    run: runCommand,
    has: (command) => Bun.which(command) !== null,
    now: Date.now,
  };
}

/** one sign-in's last reading */
interface Entry {
  /** null: signed in without this plan */
  usage: ProviderUsage | null;
  readAt: number;
  nextAt: number;
}

/** when a provider's sign-ins were last looked for, and the sources found then */
interface Search {
  readAt: number;
  nextAt: number;
  sources: string[];
}

export class UsageService {
  /** A local CLI login ended: rediscover sign-ins, preserving account rate-limit backoffs. */
  invalidate(): void { this.searches.clear(); this.entries.clear(); }
  /** Whether Claude's status line is wrapped here (server/statusline-install.ts), on this server's home and CLAUDE_CONFIG_DIR. */
  statusline(): StatuslineInstallState {
    return statuslineInstallState(this.statuslineOptions());
  }

  /** Turns the status-line reading on or off; Claude's next reading comes from where it now can. */
  setStatusline(enabled: boolean): StatuslineInstallState {
    try {
      if (enabled) installStatusline(this.statuslineOptions());
      else removeStatusline(this.statuslineOptions());
    } finally {
      this.invalidate();
    }
    return this.statusline();
  }

/** Whether a Claude sign-in found at `source` (claudeHomes) lives in the config directory the switch changes. */
  private switchesConfigOf(source: string): boolean {
    const configured = this.ctx.env["CLAUDE_CONFIG_DIR"]?.trim();
    // "default" is ~/.claude: the same sign-in found there and under CLAUDE_CONFIG_DIR is kept once, as "default"
    const defaultDir = join(this.ctx.home, ".claude");
    // the label "default" is a source's only: a configured directory is a path, whatever its name
    return resolve(source === "default" ? defaultDir : source) === resolve(configured || defaultDir);
  }

  private statuslineOptions() {
    return { home: this.ctx.home, configDir: this.ctx.env["CLAUDE_CONFIG_DIR"] };
  }
  private readonly searches = new Map<UsageProviderId, Search>();
  /** by provider and source */
  private readonly entries = new Map<string, Entry>();
  /** when each account may be asked again after a 429, wherever its sign-in is found next */
  private readonly backoffs = new Map<string, number>();
  private pending: Promise<UsageReport> | null = null;
  private pendingRefresh = false;

  constructor(private readonly ctx: UsageContext = systemUsageContext(), private readonly providers: readonly UsageProvider[] = USAGE_PROVIDERS,
    private readonly additional: (refresh: boolean) => Promise<readonly ProviderUsage[]> = async () => []) {}

  /**
   * `refresh` asks again sooner than FRESH_MS. Concurrent callers share one pass; a refresh that
   * arrives during a plain pass runs after it, so no provider it could force is answered from cache.
   */
  report(refresh = false): Promise<UsageReport> {
    if (this.pending && (!refresh || this.pendingRefresh)) return this.pending;
    const pass: Promise<UsageReport> = (this.pending ?? Promise.resolve())
      .then(() => this.collect(refresh))
      .finally(() => { if (this.pending === pass) { this.pending = null; this.pendingRefresh = false; } });
    this.pending = pass;
    this.pendingRefresh = refresh;
    return pass;
  }

  private async collect(refresh: boolean): Promise<UsageReport> {
    const now = this.ctx.now();
    const missing = new Map(this.providers.flatMap((provider) => { const command = provider.missingCommand?.(this.ctx) ?? null; return command === null ? [] : [[provider.id, command] as const]; }));
    const usages = await Promise.all(this.providers.map((provider) => this.collectProvider(provider, now, refresh, missing.has(provider.id))));
    // one account found in two places is listed once: the reading without a problem, else the first
    const byKey = new Map<string, ProviderUsage>();
    for (const usage of usages.flat()) {
      const held = byKey.get(usage.key);
      if (!held || (held.problem !== null && usage.problem === null)) byKey.set(usage.key, usage);
    }
    // two sign-ins of one provider that name no account are told apart by a number, in key order
    const unnamed = new Map<UsageProviderId, ProviderUsage[]>();
    for (const usage of byKey.values()) if (usage.account === null) unnamed.set(usage.id, [...unnamed.get(usage.id) ?? [], usage]);
    for (const group of unnamed.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => a.key.localeCompare(b.key)).forEach((usage, i) => byKey.set(usage.key, { ...usage, account: `#${i + 1}` }));
    }
    // a provider with an account found here needs nothing more; one with none names what it could not look with (a hub's accounts are not this PC's)
    const missingCommands = [...missing].filter(([id]) => !usages.flat().some((usage) => usage.id === id)).map(([provider, command]) => ({ provider, command }));
    return { providers: [...byKey.values(), ...await this.additional(refresh)], ...(missingCommands.length > 0 ? { missing_commands: missingCommands } : {}) };
  }

  /** `incomplete`: a command it looks with is missing, so the search is not kept: the next report looks again, finding a sign-in once it is installed */
  private async collectProvider(provider: UsageProvider, now: number, refresh: boolean, incomplete: boolean): Promise<ProviderUsage[]> {
    const search = this.searches.get(provider.id);
    // an account's readAt is never later than its provider's, so a forced search may ask each again
    const forced = refresh && search !== undefined && now - search.readAt >= MIN_REFRESH_MS;
    const usages = (sources: readonly string[]) => sources.map((source) => this.entries.get(source)?.usage ?? null).filter((usage): usage is ProviderUsage => usage !== null);
    if (search && now < search.nextAt && !forced && !incomplete) return usages(search.sources);

    let found: Found[];
    try { found = await provider.signIns(this.ctx); } catch { found = []; }
    // the same token in two places is one sign-in
    const tokens = new Set<string>();
    found = found.filter((signIn) => "locked" in signIn || (!tokens.has(signIn.token) && Boolean(tokens.add(signIn.token))));
    const read = await Promise.all(found.map(async (signIn): Promise<[string, Entry]> => {
      const source = `${provider.id}|${signIn.source}`;
      const entry = this.entries.get(source);
      const current = entry !== undefined && now < entry.nextAt && !(forced && entry.usage?.problem !== "rate_limited");
      return [source, current ? entry : await this.read(provider, signIn, entry?.usage ?? null, now)];
    }));
    for (const source of search?.sources ?? []) if (!read.some(([found]) => found === source)) this.entries.delete(source);
    for (const [source, entry] of read) this.entries.set(source, entry);
    const sources = read.map(([source]) => source);
    this.searches.set(provider.id, { readAt: now, nextAt: incomplete ? now : Math.min(now + FRESH_MS, ...read.map(([, entry]) => entry.nextAt)), sources });
    return usages(sources);
  }

  private async read(provider: UsageProvider, found: Found, previous: ProviderUsage | null, now: number): Promise<Entry> {
    const settle = (usage: ProviderUsage | null, wait: number): Entry => ({ usage, readAt: now, nextAt: now + wait });
    // an account is known by its id; one the sign-in does not name, by where it was found (hashed:
    // the key reaches the browser, the credential's path must not)
    const identity = (account: Account | null | undefined) => {
      const known = account ?? found.account ?? null;
      return { key: accountKey(provider.id, known, found.source), account: known?.label ?? null };
    };
    // the last numbers stay, named by what went wrong since - unless the place now holds another
    // account's sign-in: those numbers and that name were someone else's
    const kept = previous !== null && (!found.account || previous.key === identity(null).key) ? previous : null;
    const keep = (problem: UsageProblem, plan: string | null, wait: number) => settle({
      id: provider.id, ...(kept ? { key: kept.key, account: kept.account } : identity(null)),
      plan: kept?.plan ?? plan, windows: kept?.windows ?? [], problem, checked_at: kept?.checked_at ?? null,
    }, wait);
    if ("locked" in found) return keep("locked", null, FRESH_MS);
    const signIn: SignIn = found;
    const local = provider.readLocal?.(this.ctx, signIn) ?? null;
    const fromLocal = (reading: Reading): Entry => {
      const resets = reading.windows.flatMap((window) => window.resets_at === null ? [] : [Date.parse(window.resets_at)]);
      return settle({ id: provider.id, ...identity(reading.account), plan: reading.plan ?? signIn.plan ?? null,
        windows: reading.windows, problem: null, checked_at: new Date(reading.checkedAt ?? now).toISOString() }, Math.min(FRESH_MS, ...resets.map((reset) => reset - now)));
    };
    // a local reading as recent as the endpoint's own cache stands for it; an older one only when the
    // endpoint cannot answer (an expired token, a refusal, a blocked network), with its own time
    if (local && now - (local.checkedAt ?? now) < FRESH_MS) return fromLocal(local);
    // a fallback never replaces a newer endpoint answer kept from before: that one stays, named by the problem
    const fallback = local !== null && !(kept?.checked_at && Date.parse(kept.checked_at) > (local.checkedAt ?? now)) ? local : null;
    if (signIn.expiresAt !== null && signIn.expiresAt <= now) return fallback ? fromLocal(fallback) : keep("expired", signIn.plan ?? null, RETRY_MS);
    // a 429 holds for the account, not the place: a sign-in moved or copied elsewhere waits too
    const backoff = found.account ? `${provider.id}:${found.account.id}` : `${provider.id}#${createHash("sha256").update(signIn.token).digest("hex")}`;
    const until = this.backoffs.get(backoff);
    if (until !== undefined && now < until) return fallback ? fromLocal(fallback) : keep("rate_limited", signIn.plan ?? null, until - now);
    this.backoffs.delete(backoff);
    try {
      const reading = await provider.read(this.ctx, signIn);
      if (reading === null) return settle(null, FRESH_MS);
      return settle({
        id: provider.id, ...identity(reading.account), plan: reading.plan ?? signIn.plan ?? null, windows: reading.windows, problem: null, checked_at: new Date(now).toISOString(),
      }, FRESH_MS);
    } catch (error) {
      const wait = Math.max(RETRY_MS, error instanceof UsageHttpError ? error.retryAfterMs ?? FRESH_MS : 0);
      if (error instanceof UsageHttpError && error.status === 429) this.backoffs.set(backoff, now + wait);
      if (fallback) return fromLocal(fallback);
      if (error instanceof UsageHttpError && (error.status === 401 || error.status === 403)) {
        const expired = keep("expired", signIn.plan ?? null, RETRY_MS);
        // a 403 for a token that has not expired is a refusal, not an expiry: the status line can stand in
        const refused = provider.id === "claude" && error.status === 403 && (signIn.expiresAt === null || signIn.expiresAt > now);
        const statusline = this.statusline();
        // offered only where it can be turned on (never on Windows, never once it is on), and only for the
        // sign-in in the config directory the switch changes: another one's status line is not wrapped
        if (refused && expired.usage && statusline.supported && !statusline.installed && this.switchesConfigOf(found.source)) {
          expired.usage = { ...expired.usage, statusline_offer: true };
        }
        return expired;
      }
      if (error instanceof UsageHttpError && error.status === 429) return keep("rate_limited", signIn.plan ?? null, wait);
      console.warn(`usage: ${provider.id} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return keep("failed", signIn.plan ?? null, RETRY_MS);
    }
  }
}

/** The key an account is listed by: its id, or, for a sign-in that names none, where it was found, hashed. */
function accountKey(id: UsageProviderId, account: Account | null | undefined, source: string): string {
  return account ? `${id}:${account.id}` : `${id}@${createHash("sha256").update(source).digest("hex").slice(0, 12)}`;
}

/**
 * Where the Claude or Codex account listed as `key` keeps its sign-in now (its CredentialHome),
 * read from its files without asking any provider: a key is all the browser names,
 * never a place. Their reading names no account, so the key the list showed is the one its files
 * give. Null when no sign-in here has that key now: a hub's, another provider's, or one whose home
 * holds another account since. One account signed in in several homes (each its own token) is
 * `ambiguous`: the list shows it once, so which home the user meant cannot be told.
 */
export async function localSignInPlace(ctx: UsageContext, key: string): Promise<{ provider: "claude" | "codex"; home: CredentialHome } | { provider: "claude" | "codex"; ambiguous: true } | null> {
  for (const provider of [claude, codex]) {
    const id = provider.id === "claude" ? "claude" : "codex";
    if (!key.startsWith(`${id}:`) && !key.startsWith(`${id}@`)) continue;
    // the same token in two places is one sign-in, as the list counts it
    const tokens = new Set<string>();
    const places = (await provider.signIns(ctx))
      .filter((found) => "locked" in found || (!tokens.has(found.token) && Boolean(tokens.add(found.token))))
      .filter((found) => accountKey(id, found.account, found.source) === key);
    if (places.length > 1) return { provider: id, ambiguous: true };
    if (places[0]?.home) return { provider: id, home: places[0].home };
  }
  return null;
}

/** Whether a credential's text is JSON at all: one that is not cannot be told from a sign-in. */
function isJson(text: string): boolean {
  try { JSON.parse(text); return true; } catch { return false; }
}

/**
 * A credential file's sign-in; none when there is no file or it holds no sign-in (a Codex API key, a Claude
 * file with only MCP sign-ins); "unknown" when it will not read, is too large or is not JSON.
 */
function credentialFile(path: string, parse: (source: string | null) => SignIn | null): SignIn | "unknown" | null {
  try { statSync(path); }
  catch (error) { return error instanceof Error && "code" in error && error.code === "ENOENT" ? null : "unknown"; }
  const text = readText(path);
  return text === null || !isJson(text) ? "unknown" : parse(text);
}

/**
 * A keychain service's sign-ins, read under each account name the CLI may use: `inUse` the first that holds
 * one (as fromKeychain takes it), `all` every one found, whichever is in use; "unknown" when any item is
 * locked or is not JSON, even if another one reads.
 */
async function keychainState(ctx: UsageContext, service: string, accounts: Array<string | undefined>, parse: (value: string) => SignIn | null): Promise<{ inUse: SignIn | null; all: SignIn[] } | "unknown"> {
  const all: SignIn[] = [];
  if (ctx.platform !== "darwin") return { inUse: null, all };
  for (const account of accounts) {
    const found = await ctx.keychain(service, account);
    if (found.status === "locked") return "unknown";
    if (found.status !== "found") continue;
    if (!isJson(found.value)) return "unknown";
    const signIn = parse(found.value);
    if (signIn !== null) all.push(signIn);
  }
  return { inUse: all[0] ?? null, all };
}

const tokenDigest = (token: string): string => createHash("sha256").update(token).digest("hex");

/** A followed sign-in's home as its CLI left it: the account as the list keys and names it, never a token or a path. */
export interface HomeSignIn {
  readonly key: string;
  readonly label: string | null;
  /** a digest of the token in use: a sign-in the CLI wrote has a token of its own, one it left keeps one from before */
  readonly digest: string;
  /** the digests of every token the home's sources hold (its file and its keychain item), the one in use among them */
  readonly digests: readonly string[];
  readonly expiresAt: number | null;
}

/**
 * The sign-in a Claude or Codex CLI keeps in `home`, read from there alone as that CLI writes it, never
 * refreshed: Claude's default home or directory, each with its keychain item; Codex's default home
 * (~/.codex, or its keychain item when that has no auth.json) or directory. Null when it holds none;
 * "unknown" when any of its sources cannot be read (a keychain item locked or not JSON, a credential file
 * that will not read, is too large or is not JSON), even when another source reads: then it can be told
 * from neither none nor another sign-in. A source that reads but holds no sign-in holds none.
 * Other homes are not looked at: their sign-ins are no login's into this one.
 */
export async function homeSignIn(ctx: UsageContext, provider: "claude" | "codex", home: CredentialHome): Promise<HomeSignIn | "unknown" | null> {
  // every source of the home is read on its own: one that cannot be read leaves the home unknown, whatever
  // another gives, and only then are they weighed as the list weighs them
  let signIn: (SignIn & { source: string }) | undefined;
  // every token a source holds, whichever one is in use: a token only moved between sources is not new
  const held: SignIn[] = [];
  if (provider === "claude") {
    const claudeAt = claudeHome(ctx, home);
    const user = ctx.env["USER"];
    const keychain = await keychainState(ctx, claudeAt.service, user ? [user, undefined] : [undefined], claudeSignIn);
    const file = credentialFile(join(claudeAt.dir, ".credentials.json"), claudeSignIn);
    if (keychain === "unknown" || file === "unknown") return "unknown";
    held.push(...keychain.all, ...(file === null ? [] : [file]));
    signIn = keychainOrFile(keychain.inUse, file, claudeAt.source, claudeAccount(claudeAt.config)).find((entry): entry is Found & SignIn => !("locked" in entry));
  } else {
    const dir = home.kind === "dir" ? home.dir : join(ctx.home, ".codex");
    const file = credentialFile(join(dir, "auth.json"), codexSignIn);
    // the default home's keychain item is read too, file or not: a file in use does not make it readable
    const keychain = home.kind === "default" ? await keychainState(ctx, "Codex Auth", [undefined], codexSignIn) : { inUse: null, all: [] };
    if (file === "unknown" || keychain === "unknown") return "unknown";
    held.push(...(file === null ? [] : [file]), ...keychain.all);
    if (file !== null) signIn = { ...file, source: dir };
    else if (keychain.inUse !== null) signIn = { ...keychain.inUse, source: "keychain" };
  }
  if (signIn === undefined) return null;
  return {
    key: accountKey(provider, signIn.account, signIn.source),
    label: signIn.account?.label ?? signIn.account?.id ?? null,
    digest: tokenDigest(signIn.token),
    digests: held.map((entry) => tokenDigest(entry.token)),
    expiresAt: signIn.expiresAt,
  };
}

export async function handleUsageRequest(request: Request, url: URL, service: Pick<UsageService, "report">): Promise<Response> {
  if (request.method !== "GET") return jsonResponse({ error: { code: "method_not_allowed", message: "Use GET /api/usage" } }, 405, { allow: "GET" });
  return jsonResponse(await service.report(url.searchParams.get("refresh") === "1"), 200, { "cache-control": "no-store" });
}

/**
 * GET /api/usage/statusline: whether Claude's limits are read from its status line on this PC.
 * POST /api/usage/statusline `{ "enabled": boolean }`: turns that on or off. The body names nothing
 * else (no path, no command): what is installed and where is this server's own decision.
 */
export async function handleStatuslineRequest(request: Request, service: UsageService): Promise<Response> {
  if (request.method === "GET") return jsonResponse(service.statusline(), 200, { "cache-control": "no-store" });
  if (request.method !== "POST") return jsonResponse({ error: { code: "method_not_allowed", message: "Use GET or POST /api/usage/statusline" } }, 405, { allow: "GET, POST" });
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as Record<string, unknown>)["enabled"] !== "boolean") {
    return jsonResponse({ error: { code: "invalid_body", message: "Send { \"enabled\": true } or { \"enabled\": false }" } }, 400);
  }
  try {
    return jsonResponse(service.setStatusline((body as { enabled: boolean }).enabled), 200, { "cache-control": "no-store" });
  } catch (error) {
    // only the installer's own refusals are told: anything else (a settings.json that will not parse, a
    // filesystem error) could quote the user's settings, and a saved command can carry a secret
    if (error instanceof StatuslineInstallError) return jsonResponse({ error: { code: "statusline_failed", message: error.message } }, 409);
    console.warn(`usage: Claude's status line could not be changed: ${error instanceof Error ? error.message : String(error)}`);
    return jsonResponse({ error: { code: "statusline_failed", message: "Claude's status line could not be changed; the server's log says why" } }, 500);
  }
}
