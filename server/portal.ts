/**
 * Portal (github.com/gosuda/portal-tunnel): an optional public HTTPS address for this server,
 * started and stopped from Settings → Phone & devices with the `portal` already on this PC; the
 * app never installs it. Tailscale stays the private route and is only ever read (tailscale.ts).
 * Whatever a request asks, the guide's rules for a public proxy hold (docs/guide.md, Behind a
 * reverse proxy):
 *
 * - no address without a token, and none while OVIS_TAILSCALE_SERVE_ONLY says tailscale serve
 *   is the only way in, not even one an earlier server left running;
 * - routed mode, which keeps the browser's Host and sends X-Forwarded-For and
 *   X-Forwarded-Proto: https, and drops a visitor's Tailscale-User-Login;
 * - one relay the user picked, discovery off, hidden from the relay's list; the identity file kept
 *   here holds the name, and with it the address, across restarts;
 * - only the relay's origin comes from the request, and Portal gets none of this server's
 *   environment beyond what running and reaching the relay need: the token stays here.
 *
 * Who may open the address is the user's choice (shared/portal.ts PortalAuth): only the app's own
 * token or a paired device, as before, or Portal's own sign-in in front of everything, a private
 * link, an Ethereum wallet or an OIDC account (Google or a company's). The choice is saved with the
 * rest of the state and a relaunch goes ahead only while it is unchanged. Two secrets reach the
 * Portal's environment and nothing else: the OIDC client secret, OVIS_PORTAL_OIDC_CLIENT_SECRET,
 * read at each start, and a proof made at each launch of a Portal with a sign-in, which Portal sends
 * with the identity it vouches for (`vouches`, server/access.ts). Neither is in an argument (`ps`
 * shows those), a saved file, a log or an answer.
 *
 * Portal keeps retrying a relay it cannot use and never exits for it (v2.6.1), so the relay's
 * version is asked first and readiness has a deadline of its own.
 *
 * A Portal that was serving and then ends on its own is started again once, on the same relay,
 * port and identity, after this server's own guards and the saved state say it still may; a
 * second exit, or one before it was ever ready, is an error the user acts on.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkEntry, checkPortalAuth, NO_PORTAL_AUTH, PORTAL_AUTH_PROBLEMS, PORTAL_INVITE_DAYS, PORTAL_OIDC_SECRET_VARIABLE, type PortalAuth, type PortalSignIn } from "../shared/portal.ts";
import type { DeviceRole, PortalStatus } from "../shared/protocol.ts";
import { errorResponse, isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import { chunksOf } from "./remote-bundle.ts";
import { updateRequestAllowed } from "./update-api.ts";
import { windowsArgv, windowsProcessTable } from "./windows-processes.ts";

/** the first release with `--strip-request-header` and an address tied to the identity */
const PORTAL_VERSION = "v2.6.1";
/** a relay that answers but will not take the tunnel is only ever retried, never refused */
const READY_TIMEOUT_MS = 60_000;
/** Portal unregisters from the relay on SIGTERM; one still running after this is killed, within the 6 s the supervisor gives this server to stop */
const STOP_GRACE_MS = 4_000;
const PROCESS_POLL_MS = 100;
const KILL_CONFIRM_MS = 1_000;
const VERSION_TIMEOUT_MS = 2_500;
/** the panel polls the status; `portal version` and `portal expose --help` are a process each time */
const PROBE_CACHE_MS = 5_000;
const RELAY_TIMEOUT_MS = 5_000;
/** what is still in Portal's pipes when it exits: its last words */
const PIPE_GRACE_MS = 250;
/** Portal's last words kept for the panel */
const OUTPUT_LINES = 30;
/** `portal auth issue` reads the identity file and signs: a local call */
const ISSUE_TIMEOUT_MS = 10_000;
/** how long a stream of a visitor Portal signed in stays open before it must come through Portal's sign-in again (`recheckMs`) */
const PORTAL_RECHECK_MS = 5 * 60_000;
/** what Portal may keep of this server's environment: enough to run and to reach the relay */
const PORTAL_ENV = ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TMPDIR", "TEMP", "TMP", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"];

type Phase = PortalStatus["phase"];
type Child = ReturnType<typeof Bun.spawn>;
interface Guards {
  /** OVIS_TOKEN is set */
  tokenSet: boolean;
  /** OVIS_TAILSCALE_SERVE_ONLY: tailscale serve is declared the only way in */
  serveOnly: boolean;
}
interface StartRequest extends Guards {
  relay: string;
  /** this server's port, Portal's upstream */
  port: number;
  /** who may open the address; unset, only the app's own token or a paired device */
  auth?: PortalAuth;
}
/** a start as it runs: the sign-in settled */
type Launch = Required<StartRequest>;
/** what a relaunch must find unchanged: the exited child's saved pid and the identity it served with */
interface Recovery {
  pid: number;
  identity: string;
  /** how the exited child ended, for the error a failed relaunch leaves */
  stopped: string;
}
interface SavedState {
  enabled: boolean;
  relay: string | null;
  /** the server that started it: another one on this state directory leaves its Portal alone */
  port: number | null;
  /** the Portal last started, so the next server can stop it if it is still running */
  pid: number | null;
  /** who may open the address, for a start that comes from this file (the boot's resume, a relaunch) */
  auth: PortalAuth;
  /** Names and roles only, never the bearer links. Older state has none and defaults to watch. */
  invites?: readonly { readonly name: string; readonly role: DeviceRole }[];
}

export interface PortalServiceOptions {
  /** Portal's identity and on/off choice live in its portal/ */
  stateDir: string;
  /** the portal to run; unset, `portal` from PATH, read at each start */
  bin?: string;
  fetch?: typeof fetch;
  /** READY_TIMEOUT_MS and STOP_GRACE_MS; tests shorten them */
  readyTimeoutMs?: number;
  stopGraceMs?: number;
  /** PORTAL_RECHECK_MS; tests shorten it */
  recheckMs?: number;
}

/** "v2.6.1" → [2, 6, 1]; null for anything else. */
function parseVersion(text: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function atLeast(version: string, minimum: string): boolean {
  const have = parseVersion(version);
  const need = parseVersion(minimum);
  if (have === null || need === null) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i]! > need[i]!;
  return true;
}

/** A relay as the user gave it, as an https origin; null for anything with a path, a query, credentials or a second host. */
export function relayOrigin(input: unknown): string | null {
  if (typeof input !== "string" || input.trim() === "") return null;
  const text = input.trim();
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  // `--relays` takes a comma-separated list, which a URL's host does not refuse
  return /^[a-z0-9.-]+$/i.test(url.hostname) ? url.origin : null;
}

/** The address on Portal's "service ready at" line, without the default port; null for any other line. */
export function readyUrl(line: string): string | null {
  const match = /service ready at (https:\/\/\S+)/.exec(line);
  if (!match) return null;
  try { return new URL(match[1]!).origin; } catch { return null; }
}

/**
 * The short address Portal also serves for a `--name` (`<name>.<relay>`), printed on the same ready line as
 * `(short URL: …)`, without the default port; null when the line has none. A provider that matches redirect
 * addresses exactly (Google) needs this host's callback registered too.
 */
export function shortReadyUrl(line: string): string | null {
  if (readyUrl(line) === null) return null;
  const match = /\(short URL: (https:\/\/[^\s)]+)\)/.exec(line);
  if (!match) return null;
  try { return new URL(match[1]!).origin; } catch { return null; }
}

function blockedBy({ tokenSet, serveOnly }: Guards): PortalStatus["blocked"] {
  if (!tokenSet) return "token_required";
  if (serveOnly) return "serve_only";
  return null;
}

function oidcSecret(): string | null {
  const value = process.env[PORTAL_OIDC_SECRET_VARIABLE]?.trim();
  return value ? value : null;
}

/** Portal's environment: what running and reaching the relay need, and the secrets of a start that has them. */
function portalEnv(secrets: { oidcSecret?: string | null; proof?: string | null } = {}): Record<string, string> {
  const env: Record<string, string> = { NO_COLOR: "1" };
  for (const name of PORTAL_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  // the names Portal reads; this server's own for the first is OVIS_PORTAL_OIDC_CLIENT_SECRET
  if (secrets.oidcSecret) env["AUTH_OIDC_CLIENT_SECRET"] = secrets.oidcSecret;
  if (secrets.proof) env["AUTH_IDENTITY_PROOF"] = secrets.proof;
  return env;
}

/**
 * Whether `given`, a request's X-Portal-Proof, is the proof of the running Portal. Compared in
 * constant time, and a length that differs is no match rather than a throw: the proof is always as
 * long as the one made here, so its length is nothing to keep secret.
 */
export function proofMatches(proof: string | null, given: string | null): boolean {
  if (proof === null || given === null) return false;
  const expected = Buffer.from(proof);
  const offered = Buffer.from(given);
  return expected.length === offered.length && timingSafeEqual(expected, offered);
}

/**
 * Who may open the address, as `portal expose` takes it. With no sign-in, a visitor's own
 * X-Portal-* headers are dropped before they reach this server, so none can ever pass for Portal's.
 * With one, Portal drops them itself and sets both from the sign-in it verified
 * (`--auth-identity-headers`), which is all server/access.ts trusts; Portal refuses to strip them
 * as well. Values join their flag with `=`, so none can read as another flag. The OIDC client secret
 * and the proof are not here: arguments show in `ps`.
 */
export function authArgs(auth: PortalAuth): string[] {
  if (auth.method === "none") return ["--strip-request-header", "X-Portal-User", "--strip-request-header", "X-Portal-Auth"];
  return [
    `--auth=${auth.method}`,
    "--auth-identity-headers=true",
    ...auth.allow.map((entry) => `--auth-allow=${entry}`),
    ...(auth.issuer === null ? [] : [`--auth-oidc-issuer=${auth.issuer}`]),
    ...(auth.client_id === null ? [] : [`--auth-oidc-client-id=${auth.client_id}`]),
  ];
}

function sameAuth(a: PortalAuth, b: PortalAuth): boolean {
  return a.method === b.method && a.issuer === b.issuer && a.client_id === b.client_id
    && a.allow.length === b.allow.length && a.allow.every((entry, index) => entry === b.allow[index]);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function processErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function processPresence(pid: number): "alive" | "gone" | "unknown" {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const end = stat.lastIndexOf(")");
      // A zombie still has a PID but cannot be running or signaled.
      if (end >= 0 && stat.slice(end + 1).trimStart().startsWith("Z")) return "gone";
    } catch { /* process.kill below distinguishes a gone pid from an unreadable one */ }
  }
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = processErrorCode(error);
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

function portalExecutable(value: string | undefined): boolean {
  return /^(?:portal)(?:\.exe)?$/i.test(value?.split(/[\\/]/).at(-1) ?? "");
}

function scriptInterpreter(value: string | undefined): boolean {
  return /^(?:sh|bash|dash|zsh|ksh|ash)(?:\.exe)?$/i.test(value?.split(/[\\/]/).at(-1) ?? "");
}

/** `ps` has no argv mode on every supported Unix, so parse its quoted command conservatively. */
function splitCommandLine(command: string): string[] | null {
  const args: string[] = [];
  let arg = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  for (const char of command.trim()) {
    if (escaped) {
      arg += char;
      escaped = false;
      started = true;
    } else if (char === "\\") {
      escaped = true;
      started = true;
    } else if (quote !== null) {
      if (char === quote) quote = null;
      else arg += char;
      started = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(arg);
        arg = "";
        started = false;
      }
    } else {
      arg += char;
      started = true;
    }
  }
  if (quote !== null || escaped) return null;
  if (started) args.push(arg);
  return args.length > 0 ? args : null;
}

async function processArgv(pid: number, timeoutMs: number): Promise<string[] | null> {
  try {
    if (process.platform === "win32") {
      const row = (await windowsProcessTable(timeoutMs)).find((entry) => entry.pid === pid);
      if (row?.commandLine === null || row?.commandLine === undefined) return null;
      const argv = windowsArgv(row.commandLine);
      if (argv.length === 0) return null;
      if (row.path !== null) argv[0] = row.path;
      return argv;
    }
    if (process.platform === "linux") {
      const text = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const argv = text.split("\0");
      if (argv.at(-1) === "") argv.pop();
      return argv.length > 0 && argv[0] !== "" ? argv : null;
    }
    const ps = Bun.spawn(["ps", "-ww", "-o", "command=", "-p", String(pid)], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: timeoutMs, killSignal: "SIGKILL",
    });
    const [code, text] = await Promise.all([ps.exited, new Response(ps.stdout as ReadableStream<Uint8Array>).text()]);
    return code === 0 ? splitCommandLine(text) : null;
  } catch { return null; }
}

function isPortalExpose(argv: readonly string[], identityPath: string): boolean {
  const direct = portalExecutable(argv[0]) && argv[1] === "expose";
  // A shebang script (including the shell stand-in used by tests) appears as interpreter, script, argv.
  const script = scriptInterpreter(argv[0]) && portalExecutable(argv[1]) && argv[2] === "expose";
  if (!direct && !script) return false;
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "--identity-path" && argv[i + 1] === identityPath) return true;
  }
  return false;
}

/** Portal's last warning or error, else its last line, for a failure that has no words of its own. */
function lastWords(lines: readonly string[]): string {
  const line = [...lines].reverse().find((candidate) => /\b(WRN|ERR|FTL)\b/.test(candidate)) ?? lines.at(-1);
  return line === undefined ? "" : ` Portal said: ${line}`;
}

async function readVersion(bin: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([bin, "version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: portalEnv(), windowsHide: true, timeout: VERSION_TIMEOUT_MS, killSignal: "SIGKILL" });
    const [text, code] = await Promise.all([new Response(proc.stdout as ReadableStream<Uint8Array>).text(), proc.exited]);
    const tag = /\bv?\d+\.\d+\.\d+\S*/.exec(text)?.[0];
    return code === 0 && tag !== undefined ? tag : null;
  } catch { return null; }
}

/**
 * The sign-ins this `portal` offers, by the flags its `expose --help` lists (`  -auth string`, single
 * dash). A version cannot say: a build from source has a flag before any release does. None is
 * offered without `-auth-identity-proof`: a Portal that signs visitors in but cannot prove the
 * identity it states would leave the app to believe a header anyone could type. credential and siwe
 * share those flags; OIDC adds its own.
 */
async function readSignIns(bin: string): Promise<PortalSignIn[]> {
  try {
    const proc = Bun.spawn([bin, "expose", "--help"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: portalEnv(), windowsHide: true, timeout: VERSION_TIMEOUT_MS, killSignal: "SIGKILL" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    if (code !== 0) return [];
    const listed = new Set([...`${out}\n${err}`.matchAll(/^ +-([a-z][\w-]*)/gm)].map((match) => match[1]));
    const has = (...flags: string[]) => flags.every((flag) => listed.has(flag));
    if (!has("auth", "auth-allow", "auth-identity-headers", "auth-identity-proof")) return [];
    return has("auth-oidc-issuer", "auth-oidc-client-id") ? ["credential", "siwe", "oidc"] : ["credential", "siwe"];
  } catch { return []; }
}

/** What a `portal` subcommand said, and when and of which `portal`. */
interface Probe<T> { at: number; bin: string | null; value: Promise<T> }

/** `last` while it is recent and of the same `bin`, else a new question: the panel polls, and each one is a process. */
function ask<T>(last: Probe<T> | null, bin: string | null, fresh: boolean, read: (bin: string) => Promise<T>, none: T): Probe<T> {
  const now = Date.now();
  if (!fresh && last !== null && last.bin === bin && now - last.at < PROBE_CACHE_MS) return last;
  return { at: now, bin, value: bin === null ? Promise.resolve(none) : read(bin) };
}

export class PortalService {
  private phase: Phase = "idle";
  private relay: string | null = null;
  private url: string | null = null;
  private error: string | null = null;
  private lines: string[] = [];
  private child: Child | null = null;
  /** a start between its request and its process, or the boot's cleanup: one at a time */
  private launching = false;
  /** invalidates starts/resumes that are still waiting on a version, relay or old process */
  private operation = 0;
  /** shutdown is final for this server instance, even if a start has not spawned yet */
  private shutdownRequested = false;
  private cleanup: Promise<void> | null = null;
  /** a child asked to end, once: its exit is no failure */
  private ending: Child | null = null;
  private versionRead: Probe<string | null> | null = null;
  private signInsRead: Probe<PortalSignIn[]> | null = null;
  /** who may open the address: the running Portal's, else the saved choice the next start uses */
  private auth: PortalAuth = NO_PORTAL_AUTH;
  private invites: NonNullable<SavedState["invites"]> = [];
  /** the short host of the address being served (`shortReadyUrl`), reported only while `url` is */
  private shortUrl: string | null = null;
  /** the port this service represents; a service for another port must not change the owner's saved choice */
  private serverPort: number | null = null;
  /** this server's own token and serve-only answer, bound by createServer; a relaunch asks it, never a request */
  private guards: (() => Guards) | null = null;
  /** what the running Portal, started with a sign-in, sends with the identity it vouches for; made at its launch, kept here and nowhere else */
  private proof: string | null = null;
  /** the child that printed its address, and the identity file it served with */
  private readyChild: Child | null = null;
  private readyIdentity: string | null = null;
  /** the one relaunch an explicit start, a stop or the boot's resume allows has been used */
  private recovered = false;
  private readonly dir: string;

  constructor(private readonly options: PortalServiceOptions) {
    this.dir = join(options.stateDir, "portal");
  }

  /**
   * How long a stream of a visitor this Portal signed in (the terminal's WebSocket, the PCs' event stream) stays
   * open. Portal checks its sign-in on every request, so a link that expired, a sign-out or a list without the
   * name ends a visitor's next request; a stream opened before that is one request, and would watch the
   * terminals for as long as it stayed open. Closed after this, the page reconnects through Portal, which
   * lets it in again only while the sign-in still holds.
   */
  get recheckMs(): number {
    return this.options.recheckMs ?? PORTAL_RECHECK_MS;
  }

  private get identityPath(): string { return join(this.dir, "identity.json"); }
  private get statePath(): string { return join(this.dir, "state.json"); }

  /** Binds what this server allows now, which a relaunch checks before it does anything and again before it spawns. */
  authorize(guards: () => Guards): void {
    this.guards = guards;
  }

  private bin(): string | null {
    return this.options.bin ?? Bun.which("portal");
  }

  private version(fresh = false): Promise<string | null> {
    this.versionRead = ask(this.versionRead, this.bin(), fresh, readVersion, null);
    return this.versionRead.value;
  }

  private signIns(fresh = false): Promise<PortalSignIn[]> {
    this.signInsRead = ask(this.signInsRead, this.bin(), fresh, readSignIns, []);
    return this.signInsRead.value;
  }

  async status(guards: Guards): Promise<PortalStatus> {
    const version = await this.version();
    const usable = version !== null && atLeast(version, PORTAL_VERSION);
    const methods = usable ? await this.signIns() : [];
    return {
      supported: true,
      version,
      min_version: PORTAL_VERSION,
      usable,
      phase: this.phase,
      relay: this.relay,
      url: this.url,
      short_url: this.url === null ? null : this.shortUrl,
      blocked: blockedBy(guards),
      error: this.error,
      output: this.lines.length > 0 ? this.lines.join("\n") : null,
      auth: this.auth,
      auth_methods: methods,
      oidc_secret: oidcSecret() !== null,
    };
  }

  /**
   * At the server's start. A Portal the last server left running is stopped whatever comes next,
   * so a server that may not open the address does not keep one open; an address that was on
   * comes back, so an app update does not take it down for good.
   */
  async resume(request: Omit<StartRequest, "relay">): Promise<void> {
    if (this.shutdownRequested || this.child !== null || this.launching) return;
    const saved = this.saved();
    this.relay = saved.relay;
    this.auth = saved.auth;
    this.invites = saved.invites ?? [];
    this.serverPort = request.port;
    // a server on another port shares this state directory: what runs is its own
    if (saved.port !== null && saved.port !== request.port) return;
    const operation = ++this.operation;
    this.launching = true;
    try { await this.cleanLeftover(saved.pid); } finally { this.launching = false; }
    if (this.shutdownRequested || this.operation !== operation) return;
    if (saved.enabled && saved.relay !== null && blockedBy(request) === null) this.start({ ...request, relay: saved.relay, auth: saved.auth });
  }

  start(request: StartRequest): "started" | "busy" | "token_required" | "serve_only" | "state_in_use" {
    const blocked = blockedBy(request);
    if (blocked !== null) return blocked;
    if (this.shutdownRequested || this.child !== null || this.launching) return "busy";
    const saved = this.saved();
    this.serverPort = request.port;
    if (saved.port !== null && saved.port !== request.port) return "state_in_use";
    this.invites = saved.invites ?? [];
    this.phase = "starting";
    this.relay = request.relay;
    this.auth = request.auth ?? NO_PORTAL_AUTH;
    this.url = null;
    this.error = null;
    this.lines = [];
    this.recovered = false;
    this.run({ ...request, auth: this.auth }, ++this.operation, null);
    return "started";
  }

  /**
   * Whether a request's X-Portal-Proof is the proof of the Portal running now with a sign-in. Only
   * such a request carries an identity this server believes (server/access.ts): Portal sends the
   * proof with the identity it vouches for and drops a visitor's copy, and nothing else has it.
   */
  vouches(given: string | null): boolean {
    return proofMatches(this.proof, given);
  }

  /** Only private links have invite records; every unrecorded Portal identity may watch. */
  roleFor(user: string | null, method: string | null): DeviceRole {
    return method === "credential" ? this.invites.find((invite) => invite.name === user)?.role ?? "watch" : "watch";
  }

  /**
   * A private link for `name`, good for `days`: `portal auth issue` for this app's own identity and
   * address, which prints the credential and the URL that redeems it. The link is a bearer secret:
   * it is read from the process's output and handed back once, never kept, logged or put in an error.
   */
  async invite(name: string, days: number): Promise<{ redeem_url: string } | { refused: "unavailable" | "not_listed" } | { failed: string }> {
    const bin = this.bin();
    if (bin === null || this.auth.method !== "credential" || this.url === null) return { refused: "unavailable" };
    // a link for a name the list does not hold would be one Portal turns away
    if (this.auth.allow.length > 0 && !this.auth.allow.includes(name)) return { refused: "not_listed" };
    const host = new URL(this.url).host;
    try {
      const proc = Bun.spawn([bin, "auth", "issue", host, `--subject=${name}`, `--expires=${days * 24}h`, "--identity-path", this.identityPath], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe", env: portalEnv(), windowsHide: true, timeout: ISSUE_TIMEOUT_MS, killSignal: "SIGKILL",
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);
      const redeem = /^Redeem URL: (https:\/\/\S+)$/m.exec(out)?.[1];
      if (code === 0 && redeem?.startsWith(`https://${host}/_portal/auth/login#credential=`)) {
        const invites: NonNullable<SavedState["invites"]> = [...this.invites.filter((invite) => invite.name !== name), { name, role: "watch" }];
        this.save({ invites });
        this.invites = invites;
        return { redeem_url: redeem };
      }
      const said = err.trim().split("\n").at(-1);
      return { failed: `Portal could not issue the link (exit ${code}).${said ? ` Portal said: ${said}` : ""}` };
    } catch (error) {
      return { failed: `Portal could not issue the link (${messageOf(error)}).` };
    }
  }

  private run(request: Launch, operation: number, recovery: Recovery | null): void {
    this.launching = true;
    void this.launch(request, operation, recovery)
      // a start stopped meanwhile failed for no one
      .catch((error: unknown) => {
        if (this.isCurrentStart(operation)) this.fail(recovery === null ? messageOf(error) : `${recovery.stopped} It was not restarted: ${messageOf(error)}${lastWords(this.lines)}`);
      })
      .finally(() => { this.launching = false; });
  }

  /** Takes this server's address down and remembers that it is off when this server owns the saved state. */
  stop(): void {
    this.operation++;
    this.url = null;
    this.error = null;
    this.recovered = false;
    if (this.child !== null) {
      this.phase = "stopping";
      this.end(this.child);
    } else if (this.phase === "starting" || this.phase === "recovering" || this.phase === "error") {
      // a start still asking its relay ends there
      this.phase = "idle";
    }
    const saved = this.saved();
    if (saved.port === null || saved.port === this.serverPort) this.save({ enabled: false });
  }

  /** The server is going away: Portal goes with it, and the saved choice stays for the next server. Settles once Portal has exited. */
  shutdown(): Promise<void> {
    this.shutdownRequested = true;
    this.operation++;
    // resume already fails the startup gate closed; a cleanup error must not strand shutdown.
    const cleanup = this.cleanup?.catch((error: unknown) => {
      console.error(`Portal cleanup failed during shutdown: ${messageOf(error)}`);
    });
    const child = this.child;
    if (child === null) {
      if (this.phase === "starting" || this.phase === "recovering") this.phase = "idle";
      return cleanup ?? Promise.resolve();
    }
    this.end(child);
    return Promise.all([child.exited, cleanup]).then(() => undefined);
  }

  private end(child: Child): void {
    if (this.ending === child) return;
    this.ending = child;
    this.proof = null;
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), this.options.stopGraceMs ?? STOP_GRACE_MS);
    void child.exited.finally(() => clearTimeout(killer));
  }

  private fail(text: string): void {
    this.phase = "error";
    this.error = text;
    this.url = null;
    if (this.child !== null) this.end(this.child);
  }

  private isCurrentStart(operation: number): boolean {
    return !this.shutdownRequested && this.operation === operation && (this.phase === "starting" || this.phase === "recovering");
  }

  /** The identity file's digest; null when it is missing or unreadable, which no relaunch accepts. */
  private identityDigest(): string | null {
    try { return createHash("sha256").update(readFileSync(this.identityPath)).digest("hex"); } catch { return null; }
  }

  /** A relaunch goes ahead only while this server may open the address and the saved state is still the exited child's. */
  private checkRecovery({ relay, port, auth }: Launch, recovery: Recovery): void {
    const guards = this.guards?.() ?? null;
    if (guards === null) throw new Error("this server gave no authority to restart it. Start it again.");
    const blocked = blockedBy(guards);
    if (blocked === "token_required") throw new Error("OVIS_TOKEN is not set. Set it and restart the app before you start Portal again.");
    if (blocked === "serve_only") throw new Error("OVIS_TAILSCALE_SERVE_ONLY says tailscale serve is the only way in. Turn it off and restart the app before you start Portal again.");
    const saved = this.saved();
    if (!saved.enabled || saved.relay !== relay || saved.port !== port || saved.pid !== recovery.pid) throw new Error("its saved state changed meanwhile. Start it again.");
    if (!sameAuth(saved.auth, auth)) throw new Error("its saved sign-in settings changed meanwhile, so it would let in someone else. Start it again.");
    if (this.identityDigest() !== recovery.identity) throw new Error("its identity file changed or is missing, so the address would not be the same. Start it again.");
  }

  private async launch(request: Launch, operation: number, recovery: Recovery | null): Promise<void> {
    const { relay, port, auth } = request;
    if (recovery !== null) this.checkRecovery(request, recovery);
    const bin = this.bin();
    const version = bin === null ? null : await this.version(true);
    if (!this.isCurrentStart(operation)) return;
    if (bin === null || version === null) throw new Error("Portal is not installed on this PC.");
    if (!atLeast(version, PORTAL_VERSION)) throw new Error(`This PC has Portal ${version}; the app needs ${PORTAL_VERSION} or later.`);
    if (auth.method !== "none") {
      const offered = await this.signIns(true);
      if (!this.isCurrentStart(operation)) return;
      if (!offered.includes(auth.method)) throw new Error(`The Portal on this PC does not support --auth ${auth.method} yet. Update it, or choose another sign-in.`);
    }
    await this.checkRelay(relay);
    if (!this.isCurrentStart(operation)) return;
    // a relaunch must not stop a Portal that another server recorded meanwhile
    if (recovery !== null) this.checkRecovery(request, recovery);
    // another server of this app on this identity: two Portals keep taking the address from each other
    await this.cleanLeftover(this.saved().pid);
    if (!this.isCurrentStart(operation)) return;
    // what was true before the awaits may not be now
    if (recovery !== null) this.checkRecovery(request, recovery);
    // Portal needs its identity parent before it starts; it contains the saved address.
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // a Portal with a sign-in gets a proof of its own at each launch, in its environment alone
    const proof = auth.method === "none" ? null : randomBytes(32).toString("hex");
    this.proof = proof;
    let child: Child;
    try {
      child = Bun.spawn([
        bin, "expose",
        "--http-route", `/=${port}`,
        "--strip-request-header", "Tailscale-User-Login",
        ...authArgs(auth),
        // a name counts only when the identity file is created; later runs keep the saved one
        "--name", `herdr-${randomBytes(8).toString("hex")}`,
        "--identity-path", this.identityPath,
        "--relays", relay, "--discovery=false",
        "--hide",
      ], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: portalEnv({ oidcSecret: auth.method === "oidc" ? oidcSecret() : null, proof }), windowsHide: true });
    } catch (error) {
      this.proof = null;
      throw error;
    }
    this.child = child;
    // a Portal whose pid cannot be kept is one the next server could not stop: it ends before its address can show
    try {
      this.save({ enabled: true, relay, port, pid: child.pid, auth });
    } catch (error) {
      this.end(child);
      await child.exited;
      if (this.child === child) this.child = null;
      if (this.ending === child) this.ending = null;
      if (this.phase === "stopping") this.phase = "idle";
      throw new Error(`Portal could not record its process, so it was stopped (${messageOf(error)}).`);
    }
    const readyTimeoutMs = this.options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    const deadline = setTimeout(() => {
      if (this.child === child && (this.phase === "starting" || this.phase === "recovering")) this.fail(`${relay} did not take the tunnel within ${Math.round(readyTimeoutMs / 1000)} seconds.${lastWords(this.lines)}`);
    }, readyTimeoutMs);
    const output = Promise.all([this.follow(child.stdout as ReadableStream<Uint8Array>, child), this.follow(child.stderr as ReadableStream<Uint8Array>, child)]);
    void child.exited.then(async (code) => {
      clearTimeout(deadline);
      await Promise.race([output, Bun.sleep(PIPE_GRACE_MS)]);
      this.exited(child, code, request, operation);
    });
  }

  private exited(child: Child, code: number | null, request: Launch, operation: number): void {
    if (this.child !== child) return;
    this.child = null;
    this.url = null;
    this.proof = null;
    const wasReady = this.readyChild === child;
    const identity = this.readyIdentity;
    this.readyChild = null;
    this.readyIdentity = null;
    if (this.ending === child) {
      this.ending = null;
      if (this.phase !== "error") this.phase = "idle";
      return;
    }
    const stopped = `Portal stopped on its own (exit ${code}).`;
    if (wasReady && this.recovered) {
      this.phase = "error";
      this.error = `Portal stopped on its own again after one restart (exit ${code}).${lastWords(this.lines)}`;
      return;
    }
    if (!wasReady || this.shutdownRequested || this.operation !== operation) {
      this.phase = "error";
      this.error = `${stopped}${lastWords(this.lines)}`;
      return;
    }
    if (identity === null) {
      this.phase = "error";
      this.error = `${stopped} It was not restarted: its identity file could not be read. Start it again.${lastWords(this.lines)}`;
      return;
    }
    // the one relaunch is spent before anything is awaited, so no second exit can take another
    this.recovered = true;
    this.phase = "recovering";
    this.error = null;
    this.run(request, operation, { pid: child.pid, identity, stopped });
  }

  /** Portal writes one event a line: the address once a relay takes the tunnel, and why it gave up on one. */
  private async follow(stream: ReadableStream<Uint8Array>, child: Child): Promise<void> {
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for await (const chunk of chunksOf(stream)) {
        pending += decoder.decode(chunk, { stream: true });
        for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
          this.line(pending.slice(0, end), child);
          pending = pending.slice(end + 1);
        }
      }
      this.line(pending + decoder.decode(), child);
    } catch { /* the pipe closes with the process */ }
  }

  private line(raw: string, child: Child): void {
    // NO_COLOR is set; a terminal's codes would be no use here either way
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (line === "" || this.child !== child) return;
    this.lines = [...this.lines, line].slice(-OUTPUT_LINES);
    const url = readyUrl(line);
    if (url !== null) {
      if (this.phase === "starting" || this.phase === "recovering" || this.phase === "running") {
        if (this.readyChild !== child) {
          this.readyChild = child;
          this.readyIdentity = this.identityDigest();
        }
        this.url = url;
        this.shortUrl = shortReadyUrl(line);
        this.phase = "running";
      }
      return;
    }
    // the relay refused for good (a name it will not take, an incompatible relay): the process would stay up serving nothing
    if (line.includes("relay operation failed permanently") && (this.phase === "starting" || this.phase === "recovering" || this.phase === "running")) this.fail(line);
  }

  /** A relay Portal cannot use is retried for good and silently: ask the relay first. */
  private async checkRelay(relay: string): Promise<void> {
    let body: unknown;
    try {
      const response = await (this.options.fetch ?? fetch)(`${relay}/sdk/domain`, { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS), redirect: "error" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = await response.json();
    } catch (error) {
      throw new Error(`${relay} did not answer as a Portal relay (${messageOf(error)}).`);
    }
    const data = isJsonObject(body) && isJsonObject(body["data"]) ? body["data"] : {};
    const release = typeof data["release_version"] === "string" ? data["release_version"] : "an unknown version";
    if (!atLeast(release, PORTAL_VERSION)) throw new Error(`${relay} runs Portal ${release}; the tunnel needs a relay on ${PORTAL_VERSION} or later.`);
  }

  /**
   * A Portal on this identity that this server did not start: one a server killed outright left
   * running, or one another server of this app runs. A pid outlives its process, so only the one
   * recorded here, and only while its command line is `portal expose` on this identity, is stopped.
   */
  private async cleanLeftover(pid: number | null): Promise<void> {
    const cleanup = this.stopLeftover(pid);
    this.cleanup = cleanup;
    try { await cleanup; } finally {
      if (this.cleanup === cleanup) this.cleanup = null;
    }
  }

  private async stopLeftover(pid: number | null): Promise<void> {
    if (pid === null || pid === this.child?.pid) return;
    // All inspection and termination fits inside the supervisor's six-second shutdown budget.
    const deadline = Date.now() + STOP_GRACE_MS + KILL_CONFIRM_MS;
    const argv = await this.identifyProcess(pid, deadline);
    if (argv === null || !isPortalExpose(argv, this.identityPath)) return;
    if (!this.signalLeftover(pid, "SIGTERM")) return;
    const queryBudget = process.platform === "linux" ? 0 : VERSION_TIMEOUT_MS;
    const graceDeadline = Math.min(Date.now() + (this.options.stopGraceMs ?? STOP_GRACE_MS), deadline - queryBudget - KILL_CONFIRM_MS);
    while (Date.now() < graceDeadline) {
      await Bun.sleep(Math.min(PROCESS_POLL_MS, graceDeadline - Date.now()));
      if (this.processIsGone(pid)) return;
    }
    // The pid may have been recycled while Portal was given its grace period.
    const currentArgv = await this.identifyProcess(pid, deadline);
    if (currentArgv === null || !isPortalExpose(currentArgv, this.identityPath)) return;
    if (!this.signalLeftover(pid, "SIGKILL")) return;
    const killDeadline = Math.min(Date.now() + KILL_CONFIRM_MS, deadline);
    for (;;) {
      if (this.processIsGone(pid)) return;
      if (Date.now() >= killDeadline) throw new Error(`Portal process ${pid} did not exit after SIGKILL.`);
      await Bun.sleep(Math.min(PROCESS_POLL_MS, killDeadline - Date.now()));
    }
  }

  private processArgv(pid: number, timeoutMs: number): Promise<string[] | null> {
    return processArgv(pid, timeoutMs);
  }

  private async identifyProcess(pid: number, deadline: number): Promise<string[] | null> {
    if (this.processIsGone(pid)) return null;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Timed out inspecting recorded Portal process ${pid}.`);
    const argv = await this.processArgv(pid, Math.min(VERSION_TIMEOUT_MS, remaining));
    if (argv !== null) return argv;
    if (this.processIsGone(pid)) return null;
    throw new Error(`Could not verify the identity of recorded Portal process ${pid}.`);
  }

  private processIsGone(pid: number): boolean {
    const presence = processPresence(pid);
    if (presence === "unknown") throw new Error(`Could not determine whether recorded Portal process ${pid} is running.`);
    return presence === "gone";
  }

  private signalLeftover(pid: number, signal: NodeJS.Signals): boolean {
    try {
      process.kill(pid, signal);
      return true;
    } catch (error) {
      if (processErrorCode(error) === "ESRCH") return false;
      throw new Error(`Could not send ${signal} to recorded Portal process ${pid} (${messageOf(error)}).`);
    }
  }

  private saved(): SavedState {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.statePath, "utf8"));
    } catch (error) {
      if (processErrorCode(error) === "ENOENT") return { enabled: false, relay: null, port: null, pid: null, auth: NO_PORTAL_AUTH };
      throw new Error("Could not read saved Portal state; refusing to assume its tunnel is stopped.", { cause: error });
    }
    if (!isJsonObject(value)) throw new Error("Saved Portal state is invalid.");
    const { enabled, relay, port, pid } = value;
    const origin = relayOrigin(relay);
    // a file from before the choice existed has none: the app's own token or a paired device
    const auth = checkPortalAuth(value["auth"]);
    if ("problem" in auth) throw new Error("Saved Portal state is invalid.");
    const invites: { name: string; role: DeviceRole }[] = [];
    const rawInvites = value["invites"];
    if (rawInvites !== undefined) {
      if (!Array.isArray(rawInvites)) throw new Error("Saved Portal invites are invalid.");
      for (const invite of rawInvites) {
        if (!isJsonObject(invite) || typeof invite["name"] !== "string") throw new Error("Saved Portal invites are invalid.");
        const name = checkEntry("credential", invite["name"]);
        const role = invite["role"] ?? "watch";
        if ("problem" in name || (role !== "drive" && role !== "watch") || invites.some((entry) => entry.name === name.entry)) throw new Error("Saved Portal invites are invalid.");
        invites.push({ name: name.entry, role });
      }
    }
    if (typeof enabled !== "boolean"
      || (relay !== null && origin === null)
      || (port !== null && !(typeof port === "number" && Number.isSafeInteger(port) && port > 0 && port <= 65535))
      || (pid !== null && !(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0))
      || (enabled && (origin === null || port === null || pid === null))) {
      throw new Error("Saved Portal state is invalid.");
    }
    return { enabled, relay: origin, port: port as number | null, pid: pid as number | null, auth: auth.auth, ...(invites.length > 0 ? { invites } : {}) };
  }

  /** at once, not awaited: a stop and a start's own save never interleave */
  private save(change: Partial<SavedState>): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temp = `${this.statePath}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify({ ...this.saved(), ...change }), { mode: 0o600 });
    renameSync(temp, this.statePath);
  }
}

const NO_PORTAL: PortalStatus = { supported: false, version: null, min_version: PORTAL_VERSION, usable: false, phase: "idle", relay: null, url: null, blocked: null, error: null, output: null, auth: NO_PORTAL_AUTH, auth_methods: [], oidc_secret: false };

/**
 * /api/portal and its actions. What this server is (its port, token and serve-only setting) comes
 * from index.ts, which also keeps a visitor Portal's own sign-in let in away from the actions.
 */
export async function handlePortalRequest(request: Request, pathname: string, portal: PortalService | undefined, context: Omit<StartRequest, "relay">): Promise<Response> {
  const reply = (body: unknown, code = 200) => jsonResponse(body, code, { "cache-control": "no-store" });
  const fail = (code: string, message: string, http: number) => reply({ error: { code, message } }, http);
  if (pathname === "/api/portal" && request.method === "GET") {
    setRequestRoute(pathname);
    // a server started without the service (tests, an embedding) offers nothing
    return reply(portal ? await portal.status(context) : NO_PORTAL);
  }
  const action = pathname.slice("/api/portal/".length);
  if (request.method !== "POST" || (action !== "start" && action !== "stop" && action !== "invite")) {
    return fail("method_not_allowed", "Use GET /api/portal, or POST /api/portal/start, /stop or /invite", 405);
  }
  setRequestRoute(action === "start" ? "/api/portal/start" : action === "stop" ? "/api/portal/stop" : "/api/portal/invite");
  if (!updateRequestAllowed(request)) return fail("invalid_portal_request", "Use the Portal controls from this app.", 403);
  if (!portal) return fail("portal_unsupported", "This server offers no Portal.", 409);
  if (action === "stop") {
    try { portal.stop(); } catch (error) { return errorResponse(error); }
    return reply({ accepted: true }, 202);
  }
  let body: unknown = null;
  try { body = await request.json(); } catch { /* checked below */ }
  if (action === "invite") {
    const fields = isJsonObject(body) ? body : {};
    const name = checkEntry("credential", typeof fields["name"] === "string" ? fields["name"] : "");
    if ("problem" in name) return fail("invalid_invite", PORTAL_AUTH_PROBLEMS[name.problem], 400);
    const days = PORTAL_INVITE_DAYS.find((choice) => choice === fields["days"]);
    if (days === undefined) return fail("invalid_invite", `Choose ${PORTAL_INVITE_DAYS.join(", ")} days.`, 400);
    const issued = await portal.invite(name.entry, days);
    if ("refused" in issued) {
      return issued.refused === "unavailable"
        ? fail("portal_not_credential", "Private links need Portal running with the private-link sign-in.", 409)
        : fail("invite_name_not_listed", "That name is not on the list of allowed link names.", 400);
    }
    if ("failed" in issued) return fail("portal_invite_failed", issued.failed, 502);
    return reply(issued);
  }
  const relay = relayOrigin(isJsonObject(body) ? body["relay"] : undefined);
  if (relay === null) return fail("invalid_relay", "Give the relay as an https address, such as https://relay.example.com.", 400);
  const auth = checkPortalAuth(isJsonObject(body) ? body["auth"] : undefined);
  if ("problem" in auth) return fail("invalid_portal_auth", PORTAL_AUTH_PROBLEMS[auth.problem], 400);
  let started: ReturnType<PortalService["start"]>;
  try { started = portal.start({ ...context, relay, auth: auth.auth }); } catch (error) { return errorResponse(error); }
  if (started === "token_required") return fail("token_required", "Set OVIS_TOKEN and restart the app before you start Portal: anyone on the internet can open its address.", 409);
  if (started === "serve_only") return fail("serve_only", "Turn off OVIS_TAILSCALE_SERVE_ONLY and restart the app before you start Portal: it says tailscale serve is the only way in.", 409);
  if (started === "busy") return fail("portal_busy", "Portal is busy; try again once it is idle.", 409);
  if (started === "state_in_use") return fail("portal_state_in_use", "Another server owns this Portal state directory. Give this server its own OVIS_STATE_DIR.", 409);
  return reply({ accepted: true }, 202);
}
