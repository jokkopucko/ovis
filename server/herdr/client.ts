import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { ConnectionDiagnostics, transportFailureCode } from "../connection-diagnostics.ts";
import type {
  AgentIntegration,
  PaneDirection,
  PaneReadResult,
  ReadFormat,
  ReadSource,
  SessionSnapshot,
  SplitPaneDirection,
  PaneFindRequest,
  PaneFindResponse,
  PaneFindMatch,
} from "../../shared/protocol.ts";
import type { AgentInfo, AgentManifestInfo, AgentStartParams, PaneInfo, PaneLayoutSnapshot, PaneProcessInfo, PaneScrollInfo, TabInfo, WorkspaceInfo } from "../../shared/herdr-api.generated.ts";
import type { HerdrMethod, HerdrMethods, SingleHerdrMethod, UntypedHerdrMethod } from "./methods.ts";
import type { HerdrIdentity } from "../../shared/machines.ts";
import { runtimeIdentity } from "../runtime/capabilities.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const diagnostics = new ConnectionDiagnostics("herdr.rpc");
let pendingRpcs = 0;

/** herdr's default socket: ~/.config/herdr on Unix, %APPDATA%\herdr on Windows. */
export function herdrSocketPath(): string {
  if (process.env.HERDR_SOCKET) return process.env.HERDR_SOCKET;
  if (process.platform === "win32") return `${process.env.APPDATA ?? ""}\\herdr\\herdr.sock`;
  return `${process.env.HOME ?? ""}/.config/herdr/herdr.sock`;
}

/**
 * Whether this process asked for an isolated herdr (HERDR_TEST_SESSION) and did not say the user's own
 * session is meant (OVIS_ALLOW_LIVE_HERDR=1, or the tests' HERDR_TEST_LIVE=1): its herdr and herdr-core
 * connections then never reach the user's own sessions.
 */
export function liveSessionsRefused(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env["HERDR_TEST_SESSION"]) && env["OVIS_ALLOW_LIVE_HERDR"] !== "1" && env["HERDR_TEST_LIVE"] !== "1";
}

/** One spelling of a socket: absolute, through the links of its folder, and on Windows the pipe's name in one case. */
export function sameSocket(path: string): string {
  // Windows resolves `..` and `.` in a \\.\ device path, a pipe's too: one name, in one case
  if (process.platform === "win32") return win32.normalize(path.replace(/^\\\\\.\\pipe\\/i, "")).toLowerCase();
  const absolute = resolve(path);
  try { return join(realpathSync(dirname(absolute)), basename(absolute)); } catch { return absolute; }
}

/**
 * A process that names a test session never reaches herdr's default socket, the user's own session:
 * a script whose scripts/test-herdr.ts import Bun dropped (its binding unused) would otherwise create,
 * type into and close panes there. Both homes count (HOME may be changed for a fixture after the
 * socket was chosen), and every spelling of the same socket.
 * The XDG_CONFIG_HOME that counts is the one the test run started with (scripts/test-herdr.ts records
 * it in OVIS_TEST_USER_XDG_CONFIG_HOME, and children inherit it), not one a test gave a child of its
 * own: refusing that would refuse the test's own herdr. Without the record, this process's own counts.
 */
function refuseLiveHerdr(socketPath: string, env: Record<string, string | undefined> = process.env): void {
  if (!liveSessionsRefused(env)) return;
  const homes = [...new Set([env["HOME"], homedir()].filter((home): home is string => Boolean(home)))];
  const config = env["OVIS_TEST_USER_XDG_CONFIG_HOME"] ?? env["XDG_CONFIG_HOME"];
  const defaults = [
    ...homes.map((home) => join(home, ".config", "herdr", "herdr.sock")),
    ...(config ? [join(config, "herdr", "herdr.sock")] : []),
    ...(process.platform === "win32" && env["APPDATA"] ? [`${env["APPDATA"]}\\herdr\\herdr.sock`] : []),
  ].map(sameSocket);
  if (defaults.includes(sameSocket(socketPath))) {
    throw new HerdrError("live_herdr_refused", `HERDR_TEST_SESSION=${env["HERDR_TEST_SESSION"]} is set, but this call would reach the user's own herdr at ${socketPath}: import scripts/test-herdr.ts for its effect (import "./test-herdr.ts"), or set OVIS_ALLOW_LIVE_HERDR=1`);
  }
}

/**
 * On Windows herdr.sock is a marker file (`pid:start`), and the server listens on a named
 * pipe of the same name: `\\.\pipe\C:\Users\…\herdr.sock` (live-verified, herdr 0.9.3).
 */
export function socketAddress(socketPath: string): string {
  refuseLiveHerdr(socketPath);
  return process.platform === "win32" && !socketPath.startsWith("\\\\.\\pipe\\") ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

/** herdr's `terminal attach` exists on Unix only (herdrdev/herdr#4821); its ping does not say so yet. */
export function terminalAttachSupported(capabilities?: Record<string, unknown>): boolean {
  const declared = capabilities?.["direct_terminal_attach"];
  return typeof declared === "boolean" ? declared : process.platform !== "win32";
}

export class HerdrError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

let requestCounter = 0;
function nextId(): string {
  requestCounter += 1;
  return `br-${Date.now().toString(36)}-${requestCounter}`;
}

/**
 * The most bytes one herdr line may hold before its newline, checked before anything is decoded.
 * herdr's schema sets no finite maximum for a reply (`PaneReadResult.text` is an unbounded string,
 * `PaneReadParams.lines` a uint32, and a snapshot grows with every pane), so these are the bridge's
 * supported ceilings, not herdr's. Sizing evidence: the largest ANSI pane fixture
 * (server/fixtures/opencode-autocomplete-2.0.32-ansi-third-selected.ansi, 40 rows) is 10,466 bytes,
 * 12,742 once JSON-escaped (about 319 bytes a row); the bridge's largest fixed read is 400 recent rows
 * (server/codex.ts), about 128 KB at that rate. A schema-complete snapshot of 25 workspaces, 200 tabs
 * and 2,000 panes, with every pane's agent and every tab's layout, is 3,598,115 bytes of JSON; its
 * reply line adds 58 bytes of envelope, the request id and the newline, 3,598,174 bytes plus the id
 * (under 3,598,200; about 1,800 bytes a pane; server/herdr/seam.test.ts builds it and checks this sum).
 * Twice each of those stays far below the floors, so the floors stand: 64 MiB for pane.read,
 * pane.selection.read (any range of the same history pane.read reads) and session.snapshot
 * (server/herdr/seam.test.ts answers each at exactly that size), 16 MiB for every other reply and
 * for each line of an event stream. A subscription has no lifetime total: only each of its lines
 * is bounded.
 */
export const LARGE_REPLY_BYTES = 64 * 1024 * 1024;
export const LINE_BYTES = 16 * 1024 * 1024;
const LARGE_REPLY_METHODS = new Set(["pane.read", "pane.selection.read", "session.snapshot"]);

/**
 * Splits incoming bytes into newline-terminated lines of at most `limit` bytes each.
 * herdr frames arrive split across reads, so a partial tail is kept as bytes and decoded only
 * once its line is complete, which keeps a UTF-8 character split between reads whole. A line
 * that passes `limit` before its newline is reported once through `onOversize`, its bytes are
 * dropped, and the reader ignores everything after it. A chunk is split, and its partial tail kept,
 * before any callback runs, so a callback that throws loses no other line: every line of the chunk
 * is still delivered, and the first throw is rethrown after the last. Exported for
 * server/herdr/seam.test.ts.
 */
export function makeLineReader(
  limit: number,
  onLine: (line: string, bytes: number) => void,
  onOversize: (bytes: number) => void,
): (chunk: Uint8Array) => void {
  const decoder = new TextDecoder();
  let parts: Uint8Array[] = [];
  let held = 0;
  let failed = false;
  return (chunk: Uint8Array) => {
    const lines: Uint8Array[] = [];
    let oversize: number | null = null;
    let start = 0;
    while (!failed && start < chunk.length) {
      const end = chunk.indexOf(0x0a, start);
      const piece = chunk.subarray(start, end === -1 ? chunk.length : end);
      if (held + piece.length > limit) {
        failed = true;
        oversize = held + piece.length;
        parts = [];
        held = 0;
        break;
      }
      if (end === -1) {
        // the socket may reuse its read buffer: keep a copy
        parts.push(piece.slice());
        held += piece.length;
        break;
      }
      lines.push(held === 0 ? piece : Buffer.concat([...parts, piece]));
      parts = [];
      held = 0;
      start = end + 1;
    }
    let thrown: { error: unknown } | null = null;
    for (const bytes of lines) {
      const line = decoder.decode(bytes).trim();
      if (line.length === 0) continue;
      try {
        onLine(line, bytes.length);
      } catch (error) {
        thrown ??= { error };
      }
    }
    if (oversize !== null) {
      try {
        onOversize(oversize);
      } catch (error) {
        thrown ??= { error };
      }
    }
    if (thrown) throw thrown.error;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Reply = { result: unknown } | { error: { code: string; message: string } };

/**
 * Whether `replyId` is how herdr 0.9.0 and 0.9.1, still supported, address an error to request
 * `id`: they answer a request they cannot deserialize with an empty id, and refuse an
 * events.subscribe with `<id>:sub:<n>:probe`; 0.9.2 and later echo the request's id. One connection
 * carries one request, so such an error can only answer it.
 */
function isOlderHerdrErrorId(replyId: unknown, id: string): boolean {
  return replyId === "" || (typeof replyId === "string" && replyId.startsWith(`${id}:sub:`));
}

/**
 * The reply to request `id` in a parsed line, or why the line is not one: herdr's envelope is an
 * object whose string `id` is the request's, with exactly one of `result` (which may be null) and
 * `error` (an object with string `code` and `message`). An error may also carry an id of herdr
 * 0.9.0 or 0.9.1 (isOlderHerdrErrorId). Fields herdr adds later are allowed.
 */
function readReply(frame: unknown, id: string): Reply | string {
  if (!isRecord(frame)) return "not an object";
  const hasResult = Object.hasOwn(frame, "result");
  const hasError = Object.hasOwn(frame, "error");
  if (frame["id"] !== id && !(hasError && !hasResult && isOlderHerdrErrorId(frame["id"], id))) return "reply to another request";
  if (hasResult === hasError) return hasResult ? "both result and error" : "neither result nor error";
  if (hasResult) return { result: frame["result"] };
  const error = frame["error"];
  if (!isRecord(error) || typeof error["code"] !== "string" || typeof error["message"] !== "string") return "malformed error";
  return { error: { code: error["code"], message: error["message"] } };
}

/**
 * One request, one connection.
 * The herdr server closes the connection after a single response, so a pooled
 * or reused socket would never see a second reply.
 *
 * `guard`, when given, is asked before every write of the request (a large one goes out over
 * several drains): the connect is awaited, and a caller's right to send can lapse meanwhile. A
 * guard that answers false before the first byte sends nothing and rejects with `cancelled`;
 * one that answers false mid-request ends the connection with the request cut short, which
 * herdr cannot act on, and rejects with `socket_error`.
 */
export function herdrRpc<M extends HerdrMethod>(
  method: SingleHerdrMethod<M>,
  params: HerdrMethods[M]["params"],
  socketPath?: string,
  timeoutMs?: number,
  guard?: () => boolean,
): Promise<HerdrMethods[M]["result"]>;
/**
 * Untyped fallback for a method `HerdrMethods` does not list yet. Outside server/herdr/ only
 * tests, scripts and the files in HERDR_RPC_ALLOWED (server/conventions.test.ts) may call it;
 * server code adds a typed wrapper here instead. It rejects a typed method only when `M` is
 * inferred from a literal: with an explicit result type (`herdrRpc<T>("pane.process_info", …)`)
 * or a method typed as plain `string`, `M` is `string` and any params compile. Closing that
 * needs this fallback under its own name, left to the follow-up PR that moves the
 * HERDR_RPC_ALLOWED files to the wrappers once their open PRs land.
 */
export function herdrRpc<T = unknown, M extends string = string>(
  method: UntypedHerdrMethod<M>,
  params: Record<string, unknown>,
  socketPath?: string,
  timeoutMs?: number,
  guard?: () => boolean,
): Promise<T>;
export async function herdrRpc(
  method: string,
  params: object,
  socketPath: string = herdrSocketPath(),
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  guard?: () => boolean,
): Promise<unknown> {
  const id = nextId();
  const started = performance.now();
  const key = JSON.stringify([socketPath, method]); // private bookkeeping only; never logged
  let connectedAt: number | undefined;
  pendingRpcs++;
  const fields = () => ({
    operation: method, request_id: id, elapsed_ms: performance.now() - started,
    connect_ms: connectedAt === undefined ? undefined : connectedAt - started,
    timeout_ms: timeoutMs, pending: Math.max(0, pendingRpcs - 1),
    phase: connectedAt === undefined ? "connect" as const : "response" as const,
  });
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let socket: { end: () => void; write: (data: Uint8Array) => number } | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let request: Buffer | null = null;
      let written = 0;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try {
          socket?.end();
        } catch {
          /* the server may already have closed it */
        }
        fn();
      };

      timer = setTimeout(
        () => finish(() => reject(new HerdrError("timeout", `herdr ${method} timed out after ${timeoutMs}ms`))),
        timeoutMs,
      );

      // A reply that breaks the protocol fails this request alone, as `bad_frame`: it says nothing
      // about whether herdr is running. The message names the method, the reason and the size,
      // never the reply's text.
      const invalid = (reason: string, bytes: number) =>
        finish(() => reject(new HerdrError("bad_frame", `herdr sent an invalid reply to ${method} (${reason}, ${bytes} bytes)`)));

      const handleLine = (line: string, bytes: number) => {
        if (settled) return;
        let frame: unknown;
        try {
          frame = JSON.parse(line);
        } catch {
          invalid("unparseable frame", bytes);
          return;
        }
        const reply = readReply(frame, id);
        if (typeof reply === "string") invalid(reply, bytes);
        else if ("error" in reply) finish(() => reject(new HerdrError(reply.error.code, reply.error.message)));
        else finish(() => resolve(reply.result));
      };

      const limit = LARGE_REPLY_METHODS.has(method) ? LARGE_REPLY_BYTES : LINE_BYTES;
      const onData = makeLineReader(limit, handleLine, (bytes) => invalid(`over the ${limit}-byte line limit`, bytes));
      const connectFailed = (err: Error) => finish(() =>
        reject(new HerdrError("connect_failed", `cannot reach herdr at ${socketPath}: ${err.message}`)));
      const writeRequest = () => {
        if (settled || socket === null || request !== null && written === request.length) return;
        try {
          // The sender's authority is asked before every write. Before the first byte a revoked
          // sender cancels. Once a frame has started it is never changed or replayed; if authority
          // lapses mid-frame the connection ends with the frame cut short, which herdr cannot act
          // on, and the outcome is reported as uncertain rather than as not sent
          if (guard && !guard()) {
            finish(() => reject(written === 0
              ? new HerdrError("cancelled", `herdr ${method} was not sent: the sender may no longer send`)
              : new HerdrError("socket_error", `herdr ${method} was cut short: the sender lost the right to send mid-request`)));
            return;
          }
          request ??= Buffer.from(`${JSON.stringify({ id, method, params })}\n`);
          // Bun sockets are unbuffered: a partial write (or zero) leaves the suffix for drain.
          // Offsets are UTF-8 bytes, never string indices; -1 means this connection is closed.
          const accepted = socket.write(request.subarray(written));
          if (accepted === -1) {
            finish(() => reject(new HerdrError("closed", `herdr closed the connection before answering ${method}`)));
            return;
          }
          written += accepted;
        } catch (error) {
          // A connected failure must not be mistaken for proof that no request was sent:
          // prompt answers treat connect_failed as permission to retry the same asking.
          finish(() => reject(new HerdrError("socket_error", (error as Error)?.message ?? "herdr socket error")));
        }
      };

      Bun.connect({
        unix: socketAddress(socketPath),
        socket: {
          data(_sock, chunk) {
            onData(chunk);
          },
          drain() {
            writeRequest();
          },
          error(_sock, err) {
            finish(() => reject(new HerdrError("socket_error", err?.message ?? "herdr socket error")));
          },
          close() {
            finish(() => reject(new HerdrError("closed", `herdr closed the connection before answering ${method}`)));
          },
        },
      })
        .then((sock) => {
          connectedAt = performance.now();
          socket = sock;
          if (settled) {
            try {
              sock.end();
            } catch {
              /* already gone */
            }
            return;
          }
          writeRequest();
        }, connectFailed);
    });
    diagnostics.recovered(key, fields());
    return result;
  } catch (error) {
    const code = error instanceof HerdrError ? transportFailureCode(error.code) : null;
    if (code !== null) diagnostics.failed(key, code, fields());
    throw error;
  } finally {
    pendingRpcs--;
  }
}

/**
 * Whether herdr may be listening on its socket; sends no request. Only proof says it is stopped: no
 * socket, or one that refuses the connect (the file a killed herdr leaves behind, #2670). Anything
 * else, a connect that does not settle within a second too, counts as listening.
 */
export function herdrMayListen(socketPath: string = herdrSocketPath()): Promise<boolean> {
  return new Promise((resolve) => {
    const settle = (listening: boolean) => { clearTimeout(timer); resolve(listening); };
    const timer = setTimeout(() => settle(true), 1000);
    const failed = (error: Error) => settle(!new Set(["ECONNREFUSED", "ENOENT"]).has((error as NodeJS.ErrnoException).code ?? ""));
    Bun.connect({ unix: socketAddress(socketPath), socket: { open(socket) { socket.end(); settle(true); }, data() {}, connectError(_socket, error) { failed(error); } } })
      .catch(failed);
  });
}

/** Discovery offers only a socket this account actually connected to, never a permission error. */
export async function herdrAcceptsConnection(socketPath: string): Promise<boolean> {
  try {
    const socket = await Bun.connect({ unix: socketAddress(socketPath), socket: { data() {} } });
    socket.end();
    return true;
  } catch { return false; }
}

export async function ping(socketPath?: string): Promise<HerdrIdentity> {
  const result = await herdrRpc<{ version: string; protocol: number; capabilities?: Record<string, unknown> }>("ping", {}, socketPath);
  const attach = terminalAttachSupported(result.capabilities);
  // without attach the web server repaints the pane's screen instead (server/mirror.ts)
  return { version: result.version, protocol: result.protocol, terminal_attach: attach, ...(attach ? {} : { terminal_mirror: true }), ...runtimeIdentity(result.capabilities) };
}

export async function sessionSnapshot(socketPath?: string, timeoutMs?: number): Promise<SessionSnapshot> {
  const result = await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {}, socketPath, timeoutMs);
  return result.snapshot;
}

/** One pane's metadata; an unknown pane rejects with herdr's `pane_not_found`. */
export async function paneGet(paneId: string, socketPath?: string): Promise<PaneInfo> {
  const result = await herdrRpc<{ pane: PaneInfo }>("pane.get", { pane_id: paneId }, socketPath);
  return result.pane;
}

export async function agentManifests(socketPath?: string): Promise<{ manifests: AgentManifestInfo[] }> {
  return herdrRpc("server.agent_manifests", {}, socketPath);
}

/** herdr's `InstalledPluginInfo`, the fields the bridge reads. */
export interface InstalledPluginInfo {
  plugin_id: string;
  name: string;
  version: string;
  description?: string | null;
  enabled: boolean;
}

/** herdr's `PluginActionInfo`. `platforms` null or absent: every platform. */
export interface PluginActionInfo {
  plugin_id: string;
  action_id: string;
  title: string;
  description?: string | null;
  contexts?: string[];
  command: string[];
  platforms?: string[] | null;
}

/**
 * herdr's `PluginInvocationContext`. herdr takes each field as given and fills a missing one
 * from its own focus, never from the pane or workspace another field names (measured on 0.9.3:
 * `focused_pane_id` alone came back with the focused workspace's ID and label).
 */
export interface PluginInvocationContext {
  workspace_id?: string;
  workspace_label?: string;
  workspace_cwd?: string;
  worktree?: unknown;
  tab_id?: string;
  tab_label?: string;
  focused_pane_id?: string;
  focused_pane_cwd?: string;
  focused_pane_agent?: string;
  focused_pane_status?: string;
  invocation_source?: string;
}

/** herdr's `PluginCommandLogInfo`. */
export interface PluginCommandLog {
  log_id: string;
  plugin_id: string;
  action_id?: string | null;
  status: "running" | "succeeded" | "failed" | (string & {});
  exit_code?: number | null;
  error?: string | null;
  stdout?: string | null;
  stderr?: string | null;
}

export async function pluginList(socketPath?: string): Promise<InstalledPluginInfo[]> {
  return (await herdrRpc<{ plugins: InstalledPluginInfo[] }>("plugin.list", {}, socketPath)).plugins;
}

/** Every plugin's manifest actions, a disabled plugin's and another platform's included. */
export async function pluginActionList(socketPath?: string): Promise<PluginActionInfo[]> {
  return (await herdrRpc<{ actions: PluginActionInfo[] }>("plugin.action.list", {}, socketPath)).actions;
}

/** Starts the action's command and answers at once: its log entry is still `running`. */
export async function pluginActionInvoke(
  pluginId: string,
  actionId: string,
  context?: PluginInvocationContext,
  socketPath?: string,
): Promise<{ log: PluginCommandLog }> {
  return herdrRpc("plugin.action.invoke", { plugin_id: pluginId, action_id: actionId, ...(context === undefined ? {} : { context }) }, socketPath);
}

export async function pluginLogList(pluginId: string, limit: number, socketPath?: string, timeoutMs?: number): Promise<PluginCommandLog[]> {
  return (await herdrRpc<{ logs: PluginCommandLog[] }>("plugin.log.list", { plugin_id: pluginId, limit }, socketPath, timeoutMs)).logs;
}

/** herdr's built-in agent integrations and whether each is installed. Read only: this bridge never installs one. */
export async function integrationList(socketPath?: string): Promise<AgentIntegration[]> {
  return (await herdrRpc<{ integrations: AgentIntegration[] }>("integration.list", {}, socketPath)).integrations;
}

export interface WorkspaceCreateResult {
  type: "workspace_created";
  workspace: WorkspaceInfo;
  tab: TabInfo;
  root_pane: PaneInfo;
}

export async function workspaceCreate(
  options: { cwd?: string; label?: string; env?: Record<string, string>; move?: string },
  socketPath?: string,
): Promise<WorkspaceCreateResult> {
  return herdrRpc(
    "workspace.create",
    { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), ...(options.label === undefined ? {} : { label: options.label }), ...(options.env === undefined ? {} : { env: options.env }), ...moveParam(options.move), focus: false },
    socketPath,
  );
}

export interface TabCreateResult {
  type: "tab_created";
  tab: TabInfo;
  root_pane: PaneInfo;
}

/** Another tab in an existing workspace. Without `cwd` herdr uses the workspace's folder. */
export async function tabCreate(
  options: { workspaceId: string; cwd?: string; label?: string; env?: Record<string, string>; move?: string },
  socketPath?: string,
): Promise<TabCreateResult> {
  return herdrRpc(
    "tab.create",
    { workspace_id: options.workspaceId, ...(options.cwd === undefined ? {} : { cwd: options.cwd }), ...(options.label === undefined ? {} : { label: options.label }), ...(options.env === undefined ? {} : { env: options.env }), ...moveParam(options.move), focus: false },
    socketPath,
  );
}

/** herdr keeps the label as given: an empty one leaves the tab without a name, so callers refuse it. */
export async function tabRename(tabId: string, label: string, socketPath?: string): Promise<void> {
  await herdrRpc("tab.rename", { tab_id: tabId, label }, socketPath);
}

/** Native insertion boundary (before removal), within this tab's workspace; focus is unchanged. */
export async function tabMove(tabId: string, insertIndex: number, socketPath?: string): Promise<{
  type: "tab_list"; tabs: TabInfo[];
}> {
  return herdrRpc("tab.move", { tab_id: tabId, insert_index: insertIndex }, socketPath);
}

/**
 * The pane leaves for a new tab of another workspace, its process running; herdr gives it a new
 * ID there and closes the tab (and a workspace) it leaves empty. Focus stays where it is.
 */
export async function paneMoveToNewTab(paneId: string, workspaceId: string, label: string | null, socketPath?: string): Promise<{
  pane: PaneInfo; closed_tab_id?: string | null; closed_workspace_id?: string | null;
}> {
  const result = await herdrRpc<{ move_result: { pane: PaneInfo; closed_tab_id?: string | null; closed_workspace_id?: string | null } }>("pane.move", {
    pane_id: paneId, destination: { type: "new_tab", workspace_id: workspaceId, label }, focus: false,
  }, socketPath);
  return result.move_result;
}

/** Closes the tab and every pane in it; a workspace's last tab takes the workspace with it. */
export async function tabClose(tabId: string, socketPath?: string): Promise<void> {
  await queueHerdrFocus(socketPath, (socket) => herdrRpc("tab.close", { tab_id: tabId }, socket));
}

export async function agentStart(
  options: { name: string; kind: string; paneId: string; args?: string[]; timeoutMs?: number },
  socketPath?: string,
): Promise<unknown> {
  return herdrRpc(
    "agent.start",
    {
      name: options.name,
      kind: options.kind,
      pane_id: options.paneId,
      ...(options.args === undefined ? {} : { args: options.args }),
      ...(options.timeoutMs === undefined ? {} : { timeout_ms: options.timeoutMs }),
    } satisfies AgentStartParams,
    socketPath,
    options.timeoutMs,
  );
}

export async function paneRename(paneId: string, label: string | null, socketPath?: string): Promise<void> {
  await herdrRpc("pane.rename", { pane_id: paneId, label }, socketPath);
}

/**
 * The live name other tools address the agent in the pane by (`herdr agent prompt <name>`); null
 * clears it. herdr keeps the rule: invalid_agent_name for a name outside it, agent_name_taken for
 * one another live agent holds, agent_not_found for a pane without a live agent.
 */
export async function agentRename(paneId: string, name: string | null, socketPath?: string): Promise<AgentInfo> {
  const answer = await herdrRpc<{ type: "agent_info"; agent: AgentInfo }>("agent.rename", { target: paneId, name }, socketPath);
  return answer.agent;
}

export async function workspaceRename(workspaceId: string, label: string, socketPath?: string): Promise<void> {
  await herdrRpc("workspace.rename", { workspace_id: workspaceId, label }, socketPath);
}

export async function workspaceMove(workspaceId: string, insertIndex: number, socketPath?: string): Promise<void> {
  await herdrRpc("workspace.move", { workspace_id: workspaceId, insert_index: insertIndex }, socketPath);
}

/** closeGroup takes a repository workspace's open worktree workspaces with it; herdr refuses otherwise. */
export async function workspaceClose(workspaceId: string, socketPath?: string, closeGroup = false): Promise<void> {
  await queueHerdrFocus(socketPath, (socket) => herdrRpc("workspace.close", { workspace_id: workspaceId, ...(closeGroup ? { close_group: true } : {}) }, socket));
}

/** `git worktree add` or `remove` on a large checkout can take well over the default 10 s. */
const WORKTREE_GIT_TIMEOUT_MS = 60_000;

/** `git worktree remove` of the workspace's checkout; herdr closes the workspace with it and keeps the branch. */
export async function worktreeRemove(workspaceId: string, force: boolean, socketPath?: string): Promise<{ type: "worktree_removed"; workspace_id: string; path: string; forced: boolean }> {
  return queueHerdrFocus(socketPath, (socket) => herdrRpc("worktree.remove", { workspace_id: workspaceId, force }, socket, WORKTREE_GIT_TIMEOUT_MS));
}

/** herdr's view of one git checkout: `worktree.list` entries, and what create/open hand back. */
export interface WorktreeInfo {
  path: string;
  branch: string | null;
  label: string;
  is_linked_worktree: boolean;
  is_bare: boolean;
  is_detached: boolean;
  is_prunable: boolean;
  open_workspace_id: string | null;
}

export interface WorktreeSourceInfo {
  repo_key: string;
  repo_name: string;
  repo_root: string;
  source_checkout_path: string;
  source_workspace_id: string | null;
}

export interface WorktreeOpenResult {
  type: "worktree_created" | "worktree_opened";
  workspace: WorkspaceInfo;
  tab: TabInfo;
  root_pane: PaneInfo;
  worktree: WorktreeInfo;
  /** worktree_opened only: the checkout was a workspace before the call */
  already_open?: boolean;
}

/** A git worktree of the workspace's repository, opened as a new workspace grouped with it. */
export async function worktreeCreate(
  options: { workspaceId: string; branch: string; base?: string; label?: string; path?: string },
  socketPath?: string,
): Promise<WorktreeOpenResult> {
  return herdrRpc("worktree.create", {
    workspace_id: options.workspaceId,
    branch: options.branch,
    ...(options.base === undefined ? {} : { base: options.base }),
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.path === undefined ? {} : { path: options.path }),
    focus: false,
  }, socketPath, WORKTREE_GIT_TIMEOUT_MS);
}

export async function worktreeList(workspaceId: string, socketPath?: string): Promise<{ source: WorktreeSourceInfo; worktrees: WorktreeInfo[] }> {
  return herdrRpc("worktree.list", { workspace_id: workspaceId }, socketPath);
}

export async function worktreeOpen(
  options: { workspaceId: string; path?: string; branch?: string; label?: string },
  socketPath?: string,
): Promise<WorktreeOpenResult> {
  return herdrRpc("worktree.open", {
    workspace_id: options.workspaceId,
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    ...(options.label === undefined ? {} : { label: options.label }),
    focus: false,
  }, socketPath);
}

export interface PaneReadOptions {
  paneId: string;
  source?: ReadSource;
  format?: ReadFormat;
  lines?: number;
  stripAnsi?: boolean;
  /** how long the answer is waited for; herdrRpc's default otherwise */
  timeoutMs?: number;
}

export async function paneRead(options: PaneReadOptions, socketPath?: string): Promise<PaneReadResult> {
  const { paneId, source = "visible", format = "text", lines, stripAnsi, timeoutMs } = options;
  // Escape sequences must survive for xterm.js, so an ansi read defaults to strip_ansi:false.
  const strip = stripAnsi ?? format !== "ansi";
  // Recent text reads can scroll an idle agent's TUI to harvest history. ANSI reads
  // only snapshot stored rows, so automatic polling must convert those to text locally.
  const passiveText = format === "text" && (source === "recent" || source === "recent_unwrapped");
  const params: Record<string, unknown> = { pane_id: paneId, source, format: passiveText ? "ansi" : format, strip_ansi: strip };
  if (lines !== undefined) params["lines"] = lines;
  const result = await herdrRpc<{ read: PaneReadResult }>("pane.read", params, socketPath, timeoutMs);
  return passiveText ? { ...result.read, format, text: strip ? stripVTControlCharacters(result.read.text) : result.read.text } : result.read;
}

/** A cell in a pane's whole history: rows count from the top of the scrollback. */
export interface PaneTextPoint { row: number; col: number }

/** Where the pane's viewport sits in its scrollback; null when herdr reports none. */
export async function paneScrollInfo(paneId: string, socketPath?: string): Promise<PaneScrollInfo | null> {
  const pane = await paneGet(paneId, socketPath);
  return pane.scroll ?? null;
}

/** Where a screen read starts in the pane's history: rows scrolled off above it, counted by herdr. */
export function viewportTop(scroll: { max_offset_from_bottom: number; offset_from_bottom: number } | null | undefined): number | undefined {
  return scroll ? scroll.max_offset_from_bottom - scroll.offset_from_bottom : undefined;
}

/** Scrolls the pane's viewport; herdr redraws every attached terminal. */
export async function paneScroll(paneId: string, offsetFromBottom: number, socketPath?: string): Promise<PaneScrollInfo | null> {
  const result = await herdrRpc<{ pane: PaneInfo }>("pane.scroll", { pane_id: paneId, offset_from_bottom: offsetFromBottom }, socketPath);
  return result.pane.scroll ?? null;
}

/** Copy search is stateless; scrolling is the same shared viewport used by herdr's TUI. */
export async function paneFind(request: PaneFindRequest, socketPath?: string): Promise<PaneFindResponse> {
  const scroll = await paneScrollInfo(request.pane_id, socketPath);
  const row = viewportTop(scroll) ?? 0;
  // pane.read.revision is NOT copy_search's content_revision. copy_motion supplies the latter
  // without entering copy mode or changing any client's cursor.
  const motion = await herdrRpc<{ cursor: PaneTextPoint; content_revision: number }>("pane.copy_motion", {
    pane_id: request.pane_id, cursor: { row, col: 0 }, motion: "line_end",
  }, socketPath);
  if (request.previous && request.content_revision !== motion.content_revision) {
    throw new HerdrError("stale_content", "Pane changed. Search again.");
  }
  const previous = request.previous;
  const result = await herdrRpc<{
    matches: PaneFindMatch[]; total: number; current?: number | null; current_global?: number | null; content_revision: number;
  }>("pane.copy_search", {
    pane_id: request.pane_id, query: request.query, direction: request.direction,
    cursor: previous?.start ?? (request.direction === "backward" ? motion.cursor : { row, col: 0 }),
    content_revision: motion.content_revision, ...(previous ? { previous } : {}),
  }, socketPath);
  const match = result.current == null ? null : result.matches[result.current] ?? null;
  let finalScroll: PaneScrollInfo | null;
  if (match && request.jump !== false) {
    // A browser resize can reflow history while searching. Use the viewport herdr has now,
    // not the one read to choose the search's starting cursor.
    const currentScroll = await paneScrollInfo(request.pane_id, socketPath);
    // Let herdr reject a reflow or history eviction after copy_search before moving the view.
    await herdrRpc("pane.copy_motion", {
      pane_id: request.pane_id, cursor: match.start, motion: "line_end", content_revision: result.content_revision,
    }, socketPath);
    finalScroll = currentScroll;
    if (currentScroll) {
      finalScroll = await paneScroll(request.pane_id, Math.max(0, currentScroll.max_offset_from_bottom - match.start.row), socketPath);
      // herdr 0.9.3 cannot guard pane.scroll atomically. Refuse success if output or reflow
      // arrived after the pre-scroll check; the shared view may already have moved.
      await herdrRpc("pane.copy_motion", {
        pane_id: request.pane_id, cursor: match.start, motion: "line_end", content_revision: result.content_revision,
      }, socketPath);
    }
  } else {
    finalScroll = await paneScrollInfo(request.pane_id, socketPath);
    // Scrolling does not change content_revision. A no-jump refresh must still refuse
    // coordinates whose viewport moved while the native match window was being read.
    if (request.jump === false && (
      scroll?.offset_from_bottom !== finalScroll?.offset_from_bottom
      || scroll?.max_offset_from_bottom !== finalScroll?.max_offset_from_bottom
      || scroll?.viewport_rows !== finalScroll?.viewport_rows
    )) throw new HerdrError("stale_content", "Pane changed. Search again.");
    // No match is an answer about one revision too: output since copy_search may hold the text.
    await herdrRpc("pane.copy_motion", {
      pane_id: request.pane_id, cursor: { row, col: 0 }, motion: "line_end", content_revision: result.content_revision,
    }, socketPath);
  }
  return {
    total: result.total, current: result.current_global == null ? null : result.current_global + 1,
    match, content_revision: result.content_revision, matches: result.matches, scroll: finalScroll,
  };
}

/**
 * The text between two cells of the pane's whole history, both inclusive, in either
 * order. Rows count from the top of the scrollback; soft-wrapped lines come back joined.
 */
export async function paneSelectionRead(paneId: string, anchor: PaneTextPoint, cursor: PaneTextPoint, socketPath?: string): Promise<string> {
  const result = await herdrRpc<{ text: string }>("pane.selection.read", { pane_id: paneId, anchor, cursor }, socketPath);
  return result.text;
}

/** What herdr knows of the processes in a pane's terminal (`pane.process_info`). */
export type ProcessInfo = PaneProcessInfo;

/**
 * The pane's shell and foreground processes, or undefined when herdr names none. Always by
 * `pane_id`: given `target`, herdr silently answers for the focused pane. Rejects as herdrRpc does.
 */
export async function paneProcessInfo(paneId: string, socketPath?: string): Promise<ProcessInfo | undefined> {
  const askedAt = Date.now();
  const info = (await herdrRpc("pane.process_info", { pane_id: paneId }, socketPath)).process_info;
  if (info) processInfoAsks.set(info, askedAt);
  return info;
}

/** When each answer paneProcessInfo gave was asked for (Date.now, taken before the ask): herdr's sample is no older. */
const processInfoAsks = new WeakMap<ProcessInfo, number>();

/** When `info` was asked of herdr, or undefined for an answer paneProcessInfo did not give. */
export function processInfoAskedAt(info: ProcessInfo): number | undefined {
  return processInfoAsks.get(info);
}

/** The agent herdr tracks in a pane (`agent.get`), including the session it reported. */
export async function agentGet(paneId: string, socketPath?: string): Promise<AgentInfo> {
  return (await herdrRpc("agent.get", { target: paneId }, socketPath)).agent;
}

export async function paneSendText(paneId: string, text: string, socketPath?: string, guard?: () => boolean): Promise<void> {
  await herdrRpc("pane.send_text", { pane_id: paneId, text }, socketPath, undefined, guard);
}

/**
 * herdr's own agent.prompt: pastes `text` into the pane's agent (bracketed), then its
 * Enter 300ms later, and returns after the Enter. Refuses with agent_blocked while the
 * agent waits for an answer, agent_not_found / agent_not_ready without an agent in front.
 * `guard`, when given, is asked once connected, right before the prompt is written (herdrRpc).
 */
export async function agentPrompt(target: string, text: string, socketPath?: string, guard?: () => boolean): Promise<void> {
  await herdrRpc("agent.prompt", { target, text }, socketPath, undefined, guard);
}

export async function paneSendKeys(paneId: string, keys: string[], socketPath?: string, guard?: () => boolean): Promise<void> {
  await herdrRpc("pane.send_keys", { pane_id: paneId, keys }, socketPath, undefined, guard);
}

export async function paneClose(paneId: string, socketPath?: string): Promise<void> {
  await queueHerdrFocus(socketPath, (socket) => herdrRpc("pane.close", { pane_id: paneId }, socket));
}

const focusQueues = new Map<string, Promise<void>>();

/** One ordering for Ovis focus writers, including an explicit swap's snapshot and restore. */
function queueHerdrFocus<T>(socketPath: string | undefined, action: (socket: string) => Promise<T>): Promise<T> {
  const socket = socketAddress(socketPath ?? herdrSocketPath());
  const pending = (focusQueues.get(socket) ?? Promise.resolve()).then(() => action(socket));
  const settled = pending.then(() => {}, () => {});
  focusQueues.set(socket, settled);
  void settled.then(() => { if (focusQueues.get(socket) === settled) focusQueues.delete(socket); });
  return pending;
}

/** Focuses this exact pane, its tab and workspace, as a click in herdr's TUI does. */
export async function paneFocus(paneId: string, socketPath?: string): Promise<void> {
  await queueHerdrFocus(socketPath, (socket) => herdrRpc("pane.focus", { pane_id: paneId }, socket));
}

/**
 * A new pane beside `paneId` (herdr's prefix+v / prefix+-), answered as herdr's snapshot lists it.
 * herdr's focus stays where it is unless `focus` asks for the new pane, as its --focus does.
 */
/**
 * `move`: the id of a move from herdr (runtime-move-run.ts), which only Ovis's herdr-core adapter
 * reads: it labels the terminal it starts with it. herdr itself is never asked with one.
 */
const moveParam = (move: string | undefined): Record<string, string> => move === undefined ? {} : { move };

/** A split on Ovis's herdr-core adapter, its new side started in `cwd` and labeled with the move (adapter.ts pane.split). */
export async function paneSplitForMove(paneId: string, direction: SplitPaneDirection, options: { cwd?: string; move: string }, socketPath: string): Promise<PaneInfo> {
  const result = await herdrRpc<{ pane: PaneInfo }>("pane.split", { target_pane_id: paneId, direction, focus: false, ...(options.cwd === undefined ? {} : { cwd: options.cwd }), ...moveParam(options.move) }, socketPath);
  return result.pane;
}

export async function paneSplit(paneId: string, direction: SplitPaneDirection, focus: boolean, socketPath?: string): Promise<PaneInfo> {
  const result = await queueHerdrFocus(socketPath, (socket) => herdrRpc<{ pane: PaneInfo }>("pane.split", { target_pane_id: paneId, direction, focus }, socket));
  return result.pane;
}

/** How herdr answers a layout change: whether anything moved, why not, and the tab's layout after it. */
export interface PaneLayoutOutcome {
  changed: boolean;
  reason: string | null;
  focused_pane_id: string;
  layout: PaneLayoutSnapshot;
}

/** herdr's prefix+z: the tab shows the pane alone (and focuses it), or every pane again. */
export async function paneZoom(paneId: string, mode: "toggle" | "on" | "off", socketPath?: string): Promise<PaneLayoutOutcome & { zoomed: boolean }> {
  const result = await queueHerdrFocus(socketPath, (socket) => herdrRpc<{ zoom: PaneLayoutOutcome & { zoomed: boolean; reason?: string | null } }>("pane.zoom", { pane_id: paneId, mode }, socket));
  return { ...result.zoom, reason: result.zoom.reason ?? null };
}

/** herdr's prefix+shift+hjkl: the pane and its neighbour on that side change places; no_neighbor when it has none. */
export async function paneSwap(paneId: string, direction: PaneDirection, socketPath?: string): Promise<PaneLayoutOutcome & { target_pane_id: string | null }> {
  return queueHerdrFocus(socketPath, async (socket) => {
    const result = await herdrRpc<{ swap: PaneLayoutOutcome & { target_pane_id?: string | null; reason?: string | null } }>("pane.swap", { pane_id: paneId, direction }, socket);
    return { ...result.swap, reason: result.swap.reason ?? null, target_pane_id: result.swap.target_pane_id ?? null };
  });
}

/** Serialize explicit swaps per herdr so none snapshots another swap's temporary focus. */
export async function paneSwapWith(paneId: string, targetPaneId: string, socketPath?: string): Promise<PaneLayoutOutcome & { target_pane_id: string | null }> {
  return queueHerdrFocus(socketPath, async (socket) => {
    const focusedPaneId = (await sessionSnapshot(socket)).focused_pane_id;
    // Explicit swaps use source_pane_id, not the directional form's pane_id (PaneSwapParams).
    const result = await herdrRpc<{ swap: PaneLayoutOutcome & { target_pane_id?: string | null; reason?: string | null } }>("pane.swap", { source_pane_id: paneId, target_pane_id: targetPaneId }, socket);
    if (result.swap.changed && focusedPaneId && focusedPaneId !== paneId) {
      try {
        // A user may have selected something else while the swap was in flight.
        if ((await sessionSnapshot(socket)).focused_pane_id === paneId) {
          // Already inside the focus queue: do not enqueue recursively.
          await herdrRpc("pane.focus", { pane_id: focusedPaneId }, socket);
        }
      } catch (error) {
        // The layout is already committed. A failed restore must not invite a swap-back retry.
        console.warn("pane swap focus restore failed", error);
      }
    }
    return { ...result.swap, reason: result.swap.reason ?? null, target_pane_id: result.swap.target_pane_id ?? null };
  });
}

/**
 * The panes of a tab whose focused pane `paneMoveBeside` takes out and back in: herdr hands one of
 * them its focus for a moment (a pane_focused event, measured on 0.9.5) that the user never gave.
 * A hold lasts until herdr's focus lands on the moved pane, or the move ends without asking herdr
 * for that focus; a lost event costs it at most PASSING_FOCUS_MS.
 */
interface PassingFocus { moved: Set<string>; siblings: Set<string> }
const passingFocus = new Set<PassingFocus>();
const PASSING_FOCUS_MS = 5_000;

/** Whether herdr's focus on `paneId` is a move's passing one, not the user's. The moved pane's focus ends its hold. */
export function focusFromMove(paneId: string): boolean {
  let held = false;
  for (const hold of passingFocus) {
    if (hold.siblings.has(paneId)) held = true;
    else if (hold.moved.has(paneId)) passingFocus.delete(hold);
  }
  return held;
}

/**
 * The pane leaves its place for `side` of another pane of its own tab, its terminal running and its
 * ID kept. herdr 0.9.5 moves a pane into a tab only from another one (`same_tab` otherwise), and only
 * right of or below its target: the pane first goes to a tab of its own in its workspace, which herdr
 * closes again once the pane is back beside the target, and a swap then puts it left of or above
 * it. A herdr that moves within a tab, and herdr-core, take the first call. A pane herdr will not move
 * out of its tab (a zoomed tab, say) moves nothing, `changed: false`. A pane herdr will not
 * bring back beside its target goes back beside another pane of its tab, and the error says so, or
 * says where it waits. A swap herdr refuses, or that fails, leaves it moved, right of or below the
 * target: `reason` says why. Queued with the other focus writers: herdr's focus, which a focused
 * pane moved out or a swap takes, goes back where it was, unless something else took it meanwhile.
 */
export async function paneMoveBeside(paneId: string, targetPaneId: string, side: PaneDirection, socketPath?: string): Promise<{ changed: boolean; reason: string | null }> {
  return queueHerdrFocus(socketPath, async (socket) => {
    const before = await sessionSnapshot(socket);
    const pane = before.panes.find((candidate) => candidate.pane_id === paneId);
    const target = before.panes.find((candidate) => candidate.pane_id === targetPaneId);
    if (!pane || !target) throw new HerdrError("pane_not_found", `pane ${pane ? targetPaneId : paneId} not found`);
    if (paneId === targetPaneId) return { changed: false, reason: "same_pane" };
    if (pane.tab_id !== target.tab_id) return { changed: false, reason: "cross_tab" };
    type Moved = { changed?: boolean; reason?: string | null; pane: PaneInfo; source_layout?: { focused_pane_id?: string | null } };
    const move = async (id: string, destination: Record<string, unknown>) =>
      (await herdrRpc<{ move_result: Moved }>("pane.move", { pane_id: id, destination, focus: false }, socket)).move_result;
    const into = { type: "tab", tab_id: target.tab_id, target_pane_id: targetPaneId, split: side === "left" || side === "right" ? "right" : "down" };
    /** herdr's focus back on `wanted` where the move took it (`took`), never over a choice made meanwhile. */
    const restore = async (wanted: string | null, took: (at: string | null | undefined) => boolean): Promise<void> => {
      if (!wanted) return;
      try {
        const at = (await sessionSnapshot(socket)).focused_pane_id;
        // Already inside the focus queue: do not enqueue recursively.
        if (at !== wanted && took(at)) {
          await herdrRpc("pane.focus", { pane_id: wanted }, socket);
          if (hold?.moved.has(wanted)) refocused = true;
        }
      } catch (error) {
        // The layout is already committed, as after a swap.
        console.warn("pane move focus restore failed", error);
      }
    };
    // where herdr's focus went when the focused pane left its tab: the move's doing, not the user's
    let left: string | null = null;
    // the panes herdr's focus may pass over (`passingFocus`), and whether herdr was asked to focus
    // the moved pane, whose pane_focused then ends the hold
    let hold: PassingFocus | null = null;
    let refocused = false;
    /** Whether herdr's snapshot lists `out` in its tab again; false without one. */
    const inTab = (now: { panes: PaneInfo[] } | null, out: string) => now?.panes.some((candidate) => candidate.pane_id === out && candidate.tab_id === target.tab_id) === true;
    /** A pane out of its tab and not beside its target goes back beside the target, else beside any pane still there; the error says where it is. */
    const strayed = async (out: string, why: HerdrError): Promise<never> => {
      const now = await sessionSnapshot(socket).catch(() => null);
      // a move herdr made without its answer arriving may have brought it back already
      let back = inTab(now, out);
      const panes = back ? [] : (now?.panes ?? []).filter((candidate) => candidate.tab_id === target.tab_id && candidate.pane_id !== out);
      for (const beside of [...panes.filter((candidate) => candidate.pane_id === targetPaneId), ...panes.filter((candidate) => candidate.pane_id !== targetPaneId)]) {
        back = await move(out, { type: "tab", tab_id: target.tab_id, target_pane_id: beside.pane_id, split: "right" }).then((home) => home.changed !== false, () => false);
        if (back) break;
      }
      // or one of these moves did, so herdr answered the next same_tab
      let read = now;
      if (!back && panes.length > 0) {
        read = await sessionSnapshot(socket).catch(() => null);
        back = inTab(read, out);
      }
      if (!back) throw new HerdrError(why.code, `pane ${out} ${read === null ? "may wait" : "waits"} in a tab of its own: ${why.message}`);
      if (left !== null) await restore(out, (at) => at === left);
      throw new HerdrError(why.code, `pane ${out} went back into its tab: ${why.message}`);
    };
    const failed = (error: unknown) => error instanceof HerdrError ? error : new HerdrError("pane_not_moved", error instanceof Error ? error.message : String(error));
    try {
      let moved = await move(paneId, into);
      if (moved.changed === false && moved.reason === "same_tab") {
        // herdr moves no pane out of a zoomed tab (its PaneMoveReason zoomed_tab)
        if (before.layouts.find((layout) => layout.tab_id === target.tab_id)?.zoomed) return { changed: false, reason: "zoomed_tab" };
        if (before.focused_pane_id === paneId) {
          hold = { moved: new Set([paneId]), siblings: new Set(before.panes.filter((candidate) => candidate.tab_id === target.tab_id && candidate.pane_id !== paneId).map((candidate) => candidate.pane_id)) };
          passingFocus.add(hold);
        }
        let passing: Moved;
        try {
          passing = await move(paneId, { type: "new_tab", workspace_id: pane.workspace_id });
        } catch (error) {
          // herdr may have moved it before its answer was lost: then it comes back as from a refusal
          const now = await sessionSnapshot(socket).catch(() => null);
          const out = now?.panes.find((candidate) => candidate.pane_id === paneId && candidate.tab_id !== target.tab_id);
          if (!out) throw error;
          const at = now?.panes.find((candidate) => candidate.pane_id === now.focused_pane_id);
          if (before.focused_pane_id === paneId && at?.tab_id === target.tab_id) left = at.pane_id;
          hold?.moved.add(out.pane_id);
          // awaited, or the finally below would end the hold while the pane is still on its way back
          return await strayed(out.pane_id, failed(error));
        }
        if (passing.changed === false) return { changed: false, reason: passing.reason ?? null };
        const out = passing.pane.pane_id;
        hold?.moved.add(out);
        if (before.focused_pane_id === paneId) left = passing.source_layout?.focused_pane_id ?? null;
        try {
          moved = await move(out, into);
        } catch (error) {
          return await strayed(out, failed(error));
        }
        if (moved.changed === false) return await strayed(out, new HerdrError("pane_not_moved", `herdr answered ${moved.reason ?? "unchanged"}`));
      }
      if (moved.changed === false) return { changed: false, reason: moved.reason ?? null };
      const id = moved.pane.pane_id;
      if (side === "left" || side === "up") {
        // the focus just before the swap is the one kept, the move's own taken back to the moved pane;
        // without it the swap would take herdr's focus with nothing to give back, so the pane stays put,
        // its focus given back as after a move right or down
        const focused = await sessionSnapshot(socket).then((now) => now.focused_pane_id ?? null, (error: unknown) => failed(error));
        if (focused instanceof HerdrError) {
          if (left !== null) await restore(id, (at) => at === left);
          return { changed: true, reason: focused.code };
        }
        const kept = left !== null && focused === left ? id : focused;
        // the move is committed whatever the swap does: a swap that fails leaves the pane right of or
        // below its target, and one whose answer is lost is read from the layout
        const swap = await herdrRpc<{ swap: { changed: boolean; reason?: string | null } }>("pane.swap", { source_pane_id: id, target_pane_id: targetPaneId }, socket)
          .then((answer) => answer.swap, async (error: unknown) => {
            const layout = await sessionSnapshot(socket).then((now) => now.layouts.find((candidate) => candidate.tab_id === target.tab_id), () => undefined);
            const rect = (pane: string) => layout?.panes.find((candidate) => candidate.pane_id === pane)?.rect;
            const [mine, theirs] = [rect(id), rect(targetPaneId)];
            const first = mine !== undefined && theirs !== undefined && (side === "left" ? mine.x < theirs.x : mine.y < theirs.y);
            return first ? { changed: true, reason: null } : { changed: false, reason: failed(error).code };
          });
        // an explicit swap focuses its source, the moved pane
        if (swap.changed && hold !== null) {
          hold.moved.add(id);
          refocused = true;
        }
        await restore(kept, (at) => at === id || (left !== null && at === left));
        if (!swap.changed) return { changed: true, reason: swap.reason ?? "unchanged" };
      } else if (left !== null) await restore(id, (at) => at === left);
      return { changed: true, reason: null };
    } finally {
      // herdr's focus back outside the hold ends it with its pane_focused; else the move gave it nowhere
      const ended = hold;
      if (ended !== null) {
        if (!refocused) passingFocus.delete(ended);
        else setTimeout(() => passingFocus.delete(ended), PASSING_FOCUS_MS).unref();
      }
    }
  });
}

/** A split's absolute ratio: [] is the root, false descends first, true descends second. */
export async function layoutSetSplitRatio(tabId: string, path: boolean[], ratio: number, socketPath?: string): Promise<void> {
  await herdrRpc("layout.set_split_ratio", { tab_id: tabId, path, ratio }, socketPath);
}

/**
 * herdr's resize mode: the border the pane shares with a neighbour moves `direction`-wards by
 * `amount` of the split that border belongs to, measured on the split's own extent rather than
 * the tab's (herdr's own 0.05 when undefined; herdr caps it at 0.5 and holds the ratio to
 * 0.1..0.9). Measured on 0.9.3: the direction is the border's, so the left pane of a split
 * shrinks on `left` and the right one grows.
 */
export async function paneResize(paneId: string, direction: PaneDirection, amount: number | undefined, socketPath?: string): Promise<PaneLayoutOutcome> {
  const result = await herdrRpc<{ resize: PaneLayoutOutcome & { reason?: string | null } }>("pane.resize", { pane_id: paneId, direction, ...(amount === undefined ? {} : { amount }) }, socketPath);
  return { ...result.resize, reason: result.resize.reason ?? null };
}

/** Clears the pane's terminal screen, as herdr's own `pane clear` does. */
export async function paneClear(paneId: string, socketPath?: string): Promise<void> {
  await herdrRpc("pane.clear", { pane_id: paneId }, socketPath);
}

export interface HerdrSubscription {
  type: string;
  pane_id?: string;
  [key: string]: unknown;
}

export interface EventFrame {
  event?: string;
  data?: Record<string, unknown>;
}

export interface SubscribeHandlers {
  onEvent: (frame: EventFrame) => void;
  onStarted?: () => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

export interface Subscription {
  close: () => void;
}

/**
 * Long-lived connection. Unlike ordinary RPC, events.subscribe keeps the socket
 * open and streams frames until the caller closes it.
 */
export function subscribeEvents(
  subscriptions: HerdrSubscription[],
  handlers: SubscribeHandlers,
  socketPath: string = herdrSocketPath(),
): Subscription {
  let closed = false;
  let socket: { end: () => void } | null = null;
  let started = false;
  const id = nextId();

  // A frame that breaks the protocol ends this subscription, reported once as `bad_frame` and
  // then closed; it is no proof that herdr stopped. The subscriber decides whether to reopen.
  const invalid = (reason: string, bytes: number) => {
    if (closed) return;
    closed = true;
    try {
      handlers.onError?.(new HerdrError("bad_frame", `herdr sent an invalid events.subscribe frame (${reason}, ${bytes} bytes)`));
    } finally {
      // a throwing onError must still end the socket and report the close, or a subscriber that
      // reopens on close never does
      try {
        socket?.end();
      } catch {
        /* already gone */
      }
      handlers.onClose?.();
    }
  };

  const onData = makeLineReader(LINE_BYTES, (line, bytes) => {
    // closed by the caller: frames still buffered belong to a subscription it replaced
    if (closed) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      invalid("unparseable frame", bytes);
      return;
    }
    // herdr's answer to the subscribe request itself: an error, or the acknowledgement. Once
    // started, a frame with a string `event` is an event whatever else it carries (an extra
    // `error: null` included); only a frame without one can be an error reply.
    const isEvent = started && isRecord(frame) && typeof frame["event"] === "string";
    if (!started || (!isEvent && isRecord(frame) && Object.hasOwn(frame, "error"))) {
      const reply = readReply(frame, id);
      if (typeof reply === "string") invalid(reply, bytes);
      else if ("error" in reply) handlers.onError?.(new HerdrError(reply.error.code, reply.error.message));
      else if (started || !isRecord(reply.result) || reply.result["type"] !== "subscription_started") invalid("unexpected acknowledgement", bytes);
      else {
        started = true;
        handlers.onStarted?.();
      }
      return;
    }
    // events carry no request id: an object with a string `event` and an object `data`
    if (!isRecord(frame) || typeof frame["event"] !== "string" || !isRecord(frame["data"])) {
      invalid("malformed event", bytes);
      return;
    }
    handlers.onEvent(frame as EventFrame);
  }, (bytes) => invalid(`over the ${LINE_BYTES}-byte line limit`, bytes));

  Bun.connect({
    unix: socketAddress(socketPath),
    socket: {
      data(_sock, chunk) {
        onData(chunk);
      },
      error(_sock, err) {
        if (!closed) handlers.onError?.(new HerdrError("socket_error", err?.message ?? "herdr socket error"));
      },
      close() {
        if (!closed) {
          closed = true;
          handlers.onClose?.();
        }
      },
    },
  })
    .then((sock) => {
      socket = sock;
      if (closed) {
        try {
          sock.end();
        } catch {
          /* already gone */
        }
        return;
      }
      sock.write(`${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } })}\n`);
    })
    .catch((err: Error) => {
      handlers.onError?.(new HerdrError("connect_failed", err.message));
      // a connect that never opened never closes either: report it as closed, or a
      // subscriber that retries on close (the status collector) waits forever after
      // one failed reconnect, e.g. while herdr restarts
      if (!closed) {
        closed = true;
        handlers.onClose?.();
      }
    });

  return {
    close() {
      if (closed) return;
      closed = true;
      try {
        socket?.end();
      } catch {
        /* already gone */
      }
    },
  };
}
