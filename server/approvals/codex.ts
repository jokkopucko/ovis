/**
 * Codex on its own app server, with the real TUI on it: what an agent Ovis starts in a herdr-core pane runs, so that
 * Ovis answers Codex's approvals as data rather than as keys read off the screen.
 *
 * The pane runs a launcher Ovis writes for the launch (launcherScript): `codex app-server --listen unix://<socket>` in a
 * folder of this account only (0700, made by mkdtemp; Codex makes the socket 0600), then the real TUI on it with
 * `codex --remote unix://<socket>`. No other account can reach the socket, so it needs no token. The launcher stops
 * the server and removes the folder when the TUI ends or the pane hangs up. Both start from the pane's shell, with its
 * PATH and environment, and with the launch's own arguments: nothing of the user's Codex settings is written.
 *
 * Ovis connects to the same server (CodexServers) and subscribes to each thread once it runs (`thread/resume`, which
 * also brings back any request already waiting). Codex sends an approval to every subscribed client, the TUI draws its
 * own dialog for it, and whichever answers first wins: the server tells both with `serverRequest/resolved`, which
 * releases the card's held request, and a later answer is ignored (measured on 0.169.0 and 0.171.0). The held request
 * goes through the approval hub (hub.ts `hold`): its card is the dialog the screen reader finds (dialogs/codex.ts),
 * with the command as Codex runs it, its `/bin/bash -lc` taken off, where the screen may have cut or wrapped it.
 * A turn's end comes from `turn/completed` (servedTurnEnd), a subagent's aside. What the server says of the pane's own
 * thread as it runs, its context, a model it moved a turn to and the questions it waits on, is kept read only
 * (codex-status.ts, servedStatus).
 *
 * Whatever is not sure goes the old way, the plain TUI and the screen reader: a Codex version not measured, arguments
 * the launcher does not know, a server that does not come up (the launcher then starts plain `codex`), a connection
 * that fails or ends, and a request this file does not take.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readlinkSync, realpathSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { meetsMinVersion } from "../../shared/agent-catalog.ts";
import type { PaneContext } from "../../shared/protocol.ts";
import { shellCommandLine } from "../shell-agent.ts";
import { askOf, tokenContext, type CodexAsk, type ServedStatus } from "./codex-status.ts";
import type { ApprovalDecision, ApprovalHub, ApprovalRequest, ApprovalSource } from "./hub.ts";

/** The Codex versions measured with a TUI on its own server; any other runs as before. */
export const CODEX_SERVER_MIN_VERSION = "0.169.0";
export const CODEX_SERVER_BELOW_VERSION = "0.172.0";

export function supportsCodexServer(version: string): boolean {
  return meetsMinVersion(version, CODEX_SERVER_MIN_VERSION) && !meetsMinVersion(version, CODEX_SERVER_BELOW_VERSION);
}

/** How long the server may take to come up before Ovis stops waiting for it (the launcher waits 8 s). */
const CONNECT_MS = 30_000;
/** How long a command sent as data waits for the server's answer before it counts as unknown. */
const COMMAND_MS = 5_000;
/** How often a socket that is there but not yet up is looked at again. */
const SOCKET_LOOK_MS = 50;
const SOCKET_NAME = "codex.sock";
const LAUNCH_PREFIX = "ovis-codex-";
/** A path a `unix://` address and a `ws+unix://` URL both take as it is, and under the shortest limit on one. */
const PLAIN_PATH = /^[A-Za-z0-9._/-]{1,100}$/;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value : null;

/**
 * The words of a POSIX shell line, as `sh` splits them (quotes, backslashes, white space), or null for one it would read
 * otherwise (an unclosed quote, or anything that would expand).
 */
function shellWords(line: string): string[] | null {
  const words: string[] = [];
  let word: string | null = null;
  for (let at = 0; at < line.length; at++) {
    const char = line[at]!;
    if (char === "'") {
      const end = line.indexOf("'", at + 1);
      if (end < 0) return null;
      word = (word ?? "") + line.slice(at + 1, end);
      at = end;
    } else if (char === '"') {
      let inner = "";
      for (at++; at < line.length && line[at] !== '"'; at++) {
        if (line[at] === "\\" && line[at + 1] === "\n") at++;
        else if (line[at] === "\\" && at + 1 < line.length && '$`"\\'.includes(line[at + 1]!)) inner += line[++at];
        else if (line[at] === "$" || line[at] === "`") return null;
        else inner += line[at];
      }
      if (at >= line.length) return null;
      word = (word ?? "") + inner;
    } else if (char === "\\") {
      if (at + 1 >= line.length) return null;
      if (line[at + 1] === "\n") at++;
      else word = (word ?? "") + line[++at];
    } else if (char === " " || char === "\t" || char === "\n") {
      if (word !== null) words.push(word);
      word = null;
    } else if (/[$`;&|<>(){}*?[\]~#]/.test(char)) {
      return null;
    } else {
      word = (word ?? "") + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

const SHELL = /^(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|sh)$/;

/** The script a `/bin/bash -lc '<script>'` command runs, as the shell gets it; any other command as it is. */
export function shellScript(command: string): string {
  const words = shellWords(command);
  return words !== null && words.length === 3 && SHELL.test(words[0]!) && (words[1] === "-lc" || words[1] === "-c") ? words[2]! : command;
}

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

/** A file change Codex announced (item/started), for the card of its approval. */
export interface FileChange { path: string; kind: string; diff: string; movePath?: string }

/** The permissions spelled out, one line each (none for an empty profile), or null for any the card could not spell out. */
const permissionLines = (permissions: unknown): string[] | null => {
  if (!isObject(permissions)) return null;
  const lines: string[] = [];
  const network = permissions["network"];
  if (isObject(network) && network["enabled"] === true) lines.push("network: on");
  const files = permissions["fileSystem"];
  if (isObject(files)) {
    for (const access of ["read", "write"] as const) {
      const paths = files[access];
      if (Array.isArray(paths) && paths.every((path) => typeof path === "string") && paths.length) lines.push(`${access}: ${paths.join(", ")}`);
    }
    if (Array.isArray(files["entries"]) && files["entries"].length) return null;
  }
  return lines;
};

/**
 * The card of an approval Codex asks (`method` and its params), or null for one Ovis leaves to the TUI's own dialog and
 * the screen reader: a command of another kind than a plain one (writing to a running command's input, a network
 * approval), a file change whose edits were not announced, and permissions it cannot spell out. An MCP server's
 * elicitation is no approval here: Codex's TUI draws it as a form of its own, which stays the TUI's.
 */
export function codexCard(method: string, params: unknown, changes?: ReadonlyMap<string, FileChange[]>): ApprovalRequest | null {
  if (!isObject(params)) return null;
  const reason = text(params["reason"]);
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const command = text(params["command"]);
      if (command === null || (params["kind"] !== undefined && params["kind"] !== "command") || params["networkApprovalContext"] != null) return null;
      const extra = params["additionalPermissions"] == null ? [] : permissionLines(params["additionalPermissions"]);
      // permissions the card cannot spell out are the terminal's to show
      if (extra === null) return null;
      const where = [
        ...(typeof params["cwd"] === "string" ? [`in ${params["cwd"]}`] : []),
        ...(typeof params["environmentId"] === "string" && params["environmentId"] !== "local" ? [`environment: ${params["environmentId"]}`] : []),
        ...extra.map((line) => `with ${line}`),
      ];
      const description = [reason, ...where].filter((line): line is string => line !== null).join("\n");
      return { command: shellScript(command), description: description === "" ? null : description, dialog: "command" };
    }
    case "item/fileChange/requestApproval": {
      const edits = typeof params["itemId"] === "string" ? changes?.get(params["itemId"]) : undefined;
      if (edits === undefined || edits.length === 0) return null;
      return { command: edits.map((edit) => `${edit.kind} ${edit.path}${edit.movePath === undefined ? "" : ` -> ${edit.movePath}`}\n${edit.diff}`.trimEnd()).join("\n"), description: reason, dialog: "edit" };
    }
    case "item/permissions/requestApproval": {
      const lines = permissionLines(params["permissions"]);
      return lines === null || lines.length === 0 ? null : { command: lines.join("\n"), description: reason, dialog: "grant" };
    }
    default:
      return null;
  }
}

/** What Codex takes as the answer to `method` for a card's decision, as its TUI answers: No stops the turn (cancel). */
export function codexAnswer(method: string, params: unknown, decision: ApprovalDecision): Json | null {
  const input = isObject(params) ? params : {};
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval": {
      if (decision === "allow") return { decision: "accept" };
      const offered = Array.isArray(input["availableDecisions"]) ? input["availableDecisions"] : null;
      return { decision: offered === null || offered.includes("cancel") || !offered.includes("decline") ? "cancel" : "decline" };
    }
    case "item/permissions/requestApproval": {
      const asked = isObject(input["permissions"]) ? input["permissions"] : {};
      const granted = Object.fromEntries(Object.entries(asked).filter(([, value]) => value !== null));
      return { permissions: decision === "allow" ? granted : {}, scope: "turn" };
    }
    default:
      return null;
  }
}

/**
 * Yes allows once (for a grant, `Yes, grant these permissions for this turn`, the answer codexAnswer sends), No stops
 * the turn; any other option (don't ask again, a grant for the session or with strict auto review) goes to the TUI's
 * dialog as its keys. The labels are Codex 0.171.0's.
 */
export function codexDecision(label: string): ApprovalDecision | null {
  return /^Yes, proceed\b/.test(label) || /^Yes, grant these permissions for this turn\b/.test(label) ? "allow" : /^No\b/.test(label) ? "deny" : null;
}

const SOURCE: ApprovalSource = { kind: "codex", decision: codexDecision };

/** The flags the server takes as they are; the TUI gets them too. */
const SHARED_FLAGS = new Set(["-c", "--config", "--enable", "--disable"]);
/** The TUI's own flags that take a value. */
const TUI_FLAGS = new Set(["-m", "--model", "-s", "--sandbox", "-a", "--ask-for-approval"]);

/**
 * A Codex launch's arguments split for its server and its TUI, or null for arguments the launcher does not know (a
 * subcommand, a flag it has not seen, an address of its own): that launch runs as before.
 */
export function serverArgs(args: readonly string[]): { server: string[]; tui: string[] } | null {
  const server: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "--") break;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (!SHARED_FLAGS.has(flag) && !TUI_FLAGS.has(flag)) return null;
    const value = inline ?? args[++at];
    if (value === undefined) return null;
    if (SHARED_FLAGS.has(flag)) server.push(flag, value);
  }
  return { server, tui: [...args] };
}

/** The launcher the pane runs: the server, then the real TUI on it, or plain `codex` when the server does not come up. */
export function launcherScript(dir: string, server: readonly string[], tui: readonly string[], plain: readonly string[]): string {
  const words = (args: readonly string[]) => args.length ? ` ${shellCommandLine("posix", args[0]!, args.slice(1))}` : "";
  return [
    "#!/bin/sh",
    "# Written by Ovis for one Codex launch (server/approvals/codex.ts); removed with its folder when Codex ends.",
    `dir=${shellCommandLine("posix", dir, [])}`,
    `socket="$dir/${SOCKET_NAME}"`,
    "server=",
    'stop() { if [ -n "$server" ]; then kill "$server" 2>/dev/null; server=; fi; rm -rf "$dir"; }',
    "trap stop EXIT",
    "trap 'stop; exit 129' HUP",
    "trap 'stop; exit 143' TERM",
    // job control: the server in a process group of its own, the TUI in front of the terminal alone
    "set -m",
    `codex${words(["app-server", ...server])} --listen "unix://$socket" </dev/null >/dev/null 2>&1 &`,
    "server=$!",
    "tries=0",
    'while [ ! -S "$socket" ] && kill -0 "$server" 2>/dev/null && [ "$tries" -lt 160 ]; do sleep 0.05; tries=$((tries + 1)); done',
    'if [ ! -S "$socket" ]; then',
    "  stop",
    "  trap - EXIT HUP TERM",
    `  exec codex${words(plain)}`,
    "fi",
    `codex --remote "unix://$socket"${words(tui)}`,
    "",
  ].join("\n");
}

/**
 * Whether `path` is the server's socket, of this account: the socket itself (0.169), or as 0.171 makes it, a link to
 * `<dir>/<sha256 of path>` in a folder of this account only (Codex's own rendezvous, as for its daemon: codex-daemon.ts).
 */
export function serverSocket(path: string): boolean {
  const uid = process.getuid?.();
  try {
    let entry = lstatSync(path);
    if (entry.isSymbolicLink()) {
      const target = resolve(dirname(path), readlinkSync(path));
      const folder = lstatSync(dirname(target));
      if (!folder.isDirectory() || folder.uid !== uid || (folder.mode & 0o777) !== 0o700) return false;
      if (basename(target) !== createHash("sha256").update(path).digest("hex")) return false;
      entry = lstatSync(target);
    }
    return entry.isSocket() && entry.uid === uid;
  } catch {
    return false;
  }
}

/**
 * Whether only `uid` can rename what is in the last of `folders`, each given from the root down with its owner and
 * mode. Each is that account's or root's. One another account can reach (every folder above it lets others pass) and
 * write in, by its group or by all, must be sticky (as /tmp), where only an entry's owner may rename it; whose group
 * it is does not matter, as another account may share it.
 */
export function privateChain(folders: readonly { uid: number; mode: number }[], uid: number | undefined): boolean {
  let reachable = true;
  for (const entry of folders) {
    if (entry.uid !== uid && entry.uid !== 0) return false;
    if (reachable && (entry.mode & 0o022) !== 0 && (entry.mode & 0o1000) === 0) return false;
    reachable &&= (entry.mode & 0o011) !== 0;
  }
  return true;
}

/** `folder` as the kernel resolves it, when only this account can rename what is in it (privateChain), else null. */
export function privateFolder(folder: string): string | null {
  try {
    const resolved = realpathSync(folder);
    const up: string[] = [];
    for (let at = resolved; ; at = dirname(at)) {
      up.unshift(at);
      if (at === dirname(at)) break;
    }
    return privateChain(up.map((at) => statSync(at)), process.getuid?.()) ? resolved : null;
  } catch {
    return null;
  }
}

type TurnEnd = "running" | "answered" | "failed";



/** Ovis's connection to one pane's Codex server. */
class Connection {
  private readonly socket: WebSocket;
  private next = 1;
  private readonly calls = new Map<number, (message: Json) => void>();
  private readonly held = new Map<string, () => void>();
  private readonly subscribed = new Set<string>();
  /** Threads the server answered Ovis's subscription for: it sent any question of theirs still waiting by then. */
  private readonly resumed = new Set<string>();
  /** Threads that are not the pane's own: subagents, and the ephemeral ones Codex runs aside (it titles a thread in one). */
  private readonly subagents = new Set<string>();
  private readonly changes = new Map<string, FileChange[]>();
  private readonly asks = new Map<string, CodexAsk>();
  turn: TurnEnd | null = null;
  /**
   * The pane's own thread, the last one Codex started or ran a turn in that is no subagent's; `sure` once Codex said so,
   * not when only guessed from the threads loaded as Ovis connected.
   */
  private thread: string | null = null;
  private sure = false;
  /** The turn the pane's own thread runs or ran last. */
  private turnId: string | null = null;
  private toldFailedTurn: string | null = null;
  private resumedActive = false;
  private context: PaneContext | null = null;
  private rerouted: { turnId: string; model: string } | null = null;
  /** The model the pane's own thread runs, as the server said on resume or in its settings. */
  private model: string | null = null;
  /** Whether the pane's own thread is known to run no turn: what the server said of it last, never assumed. */
  private idle = false;
  closed = false;

  /**
   * `done`: the questions of this pane answered lately, by Ovis or the terminal, and when, newest last (at most
   * DONE_KEPT); the pane's, so they outlast this connection.
   */
  constructor(path: string, private readonly paneId: string, private readonly hub: ApprovalHub, private readonly onClose: () => void,
    private readonly done: Done[] = []) {
    this.socket = new WebSocket(`ws+unix://${path}:/`);
    this.socket.onopen = () => void this.start();
    this.socket.onmessage = (event) => this.receive(String(event.data));
    this.socket.onclose = () => this.end();
    this.socket.onerror = () => this.end();
  }

  private call(method: string, params: Json): Promise<Json> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.calls.set(id, resolve);
      this.send({ id, method, params });
    });
  }

  /**
   * The TUI's bare `/plan` for the pane's own thread `threadId`: Plan mode with Plan's own effort (Codex's
   * `plan_mode_reasoning_effort` where its config sets one, else the mode's preset, measured medium on 0.171.0) and the
   * thread's model as it is when the request goes. Only while that thread is the pane's, the only one loaded, and idle, as Codex's own
   * dispatcher allows `/plan` only between tasks. `unsent` when nothing went (any of that not known, a refusal, or
   * `mayWrite` saying no right before the request), `unknown` when it went and no answer came in time.
   */
  async plan(threadId: string, mayWrite: () => boolean): Promise<"unsent" | "applied" | "unknown"> {
    const ready = (): boolean => !this.closed && this.thread === threadId && this.idle && this.model !== null;
    if (!ready()) return "unsent";
    const [modes, config] = await Promise.all([this.within("collaborationMode/list", {}), this.within("config/read", {})]);
    const plan = modes !== "unknown" && isObject(modes["result"]) && Array.isArray(modes["result"]["data"])
      ? modes["result"]["data"].find((mode): mode is Json => isObject(mode) && mode["mode"] === "plan") : undefined;
    // a config that could not be read may set Plan's effort: the TUI would use it, so nothing goes
    const settings = config !== "unknown" && isObject(config["result"]) && isObject(config["result"]["config"]) ? config["result"]["config"] : null;
    if (plan === undefined || settings === null || !ready()) return "unsent";
    // last, right before the request: the TUI's thread is the only one loaded besides subagents (a /resume or /new in
    // the TUI loads another without telling Ovis which one it shows)
    const loaded = await this.within("thread/loaded/list", {});
    const ids = loaded !== "unknown" && isObject(loaded["result"]) && Array.isArray(loaded["result"]["data"]) ? loaded["result"]["data"] : null;
    const alone = ids !== null && ids.includes(threadId) && ids.every((id) => id === threadId || (typeof id === "string" && this.subagents.has(id)));
    // read again after the lookups: the thread, its state or its model may have moved meanwhile
    if (!alone || !ready() || !mayWrite()) return "unsent";
    const configured = text(settings["plan_mode_reasoning_effort"]);
    const answer = await this.within("thread/settings/update", { threadId, collaborationMode: { mode: "plan", settings: {
      model: this.model, reasoning_effort: configured ?? text(plan["reasoning_effort"]), developer_instructions: null,
    } } });
    if (answer === "unknown") return "unknown";
    return answer["error"] === undefined ? "applied" : "unsent";
  }

  /** A call answered within COMMAND_MS, or `unknown` when the connection ended or the time ran out after it went. */
  private async within(method: string, params: Json): Promise<Json | "unknown"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"unknown">((resolve) => { timer = setTimeout(() => resolve("unknown"), COMMAND_MS); });
    try {
      const answer = await Promise.race([this.call(method, params), late]);
      return answer === "unknown" || answer["closed"] === true ? "unknown" : answer;
    } finally { clearTimeout(timer); }
  }

  /** Steer only the pane's one loaded thread. The RPC id acknowledges this request, not a TUI echo. */
  async steer(threadId: string, input: string, clientId: string, checkPane: () => Promise<void>, writing: () => void): Promise<"accepted" | "unsent" | "changed" | "unknown"> {
    const turn = this.turnId;
    const ready = () => !this.closed && this.sure && this.thread === threadId && turn !== null && turn === this.turnId
      && this.turn === "running" && !this.idle && this.waitsOnNone() && this.held.size === 0;
    if (!ready()) return "unsent";
    await checkPane();
    const loaded = await this.within("thread/loaded/list", {});
    const result = loaded !== "unknown" && isObject(loaded["result"]) ? loaded["result"] : null;
    if (result?.["nextCursor"] !== null || !Array.isArray(result["data"]) || !result["data"].includes(threadId)
      || !result["data"].every((id) => id === threadId || (typeof id === "string" && this.subagents.has(id)))
      || this.thread !== threadId || this.closed) return "changed";
    if (!ready()) return "unsent";
    writing();
    const reply = await this.within("turn/steer", { threadId, expectedTurnId: turn, clientUserMessageId: clientId, input: [{ type: "text", text: input, text_elements: [] }] });
    return reply !== "unknown" && reply["error"] === undefined && isObject(reply["result"]) && reply["result"]["turnId"] === turn ? "accepted" : "unknown";
  }

  private send(message: Json): void {
    if (!this.closed) this.socket.send(JSON.stringify(message));
  }

  private async start(): Promise<void> {
    const answer = await this.call("initialize", { clientInfo: { name: "ovis", title: "Ovis", version: "0" }, capabilities: { experimentalApi: true } });
    const agent = isObject(answer["result"]) ? answer["result"]["userAgent"] : undefined;
    const version = typeof agent === "string" ? /\/(\d+\.\d+\.\d+)/.exec(agent)?.[1] : undefined;
    // a server of a version not measured is left to the TUI and the screen reader
    if (version === undefined || !supportsCodexServer(version)) return this.close();
    this.send({ method: "initialized" });
    const loaded = await this.call("thread/loaded/list", {});
    const ids = isObject(loaded["result"]) && Array.isArray(loaded["result"]["data"]) ? loaded["result"]["data"] : [];
    for (const id of ids) if (typeof id === "string") void this.subscribe(id);
  }

  /** A thread's requests come only to its subscribers; Codex refuses one that has not run yet (no rollout), tried again as it runs. */
  private async subscribe(threadId: string): Promise<void> {
    if (this.subscribed.has(threadId)) return;
    this.subscribed.add(threadId);
    const answer = await this.call("thread/resume", { threadId, excludeTurns: true });
    if (answer["error"] !== undefined) this.subscribed.delete(threadId);
    else this.resumed.add(threadId);
    // a thread already running as Ovis connects is known by what the server answers of it
    const thread = isObject(answer["result"]) && isObject(answer["result"]["thread"]) ? answer["result"]["thread"] : null;
    if (thread !== null) this.started(thread, false);
    if (thread !== null && thread["id"] === this.thread && isObject(answer["result"])) {
      this.model = text(answer["result"]["model"]) ?? this.model;
      this.idle = isObject(thread["status"]) && thread["status"]["type"] === "idle";
      this.resumedActive = isObject(thread["status"]) && thread["status"]["type"] === "active";
    }
  }

  /**
   * A thread Codex started (`announced`) or Ovis subscribed to. One started anew becomes the pane's own; of the threads
   * loaded as Ovis connected, the first, or one that runs over one only guessed.
   */
  private started(thread: Json, announced: boolean): void {
    if (typeof thread["id"] !== "string") return;
    if (typeof thread["parentThreadId"] === "string" || thread["ephemeral"] === true) this.subagents.add(thread["id"]);
    else if (announced) this.own(thread["id"], true);
    else if (this.thread === null || (!this.sure && isObject(thread["status"]) && thread["status"]["type"] === "active")) this.own(thread["id"], false);
  }

  /** `threadId` is the pane's own thread: what was known of another, its turn's end too, goes. */
  private own(threadId: string, sure: boolean): void {
    if (this.subagents.has(threadId)) return;
    if (this.thread === threadId) { this.sure ||= sure; return; }
    this.thread = threadId;
    this.sure = sure;
    this.turn = null;
    this.turnId = null;
    this.toldFailedTurn = null;
    this.resumedActive = false;
    this.context = null;
    this.rerouted = null;
    this.model = null;
    this.idle = false;
    changed(this.paneId);
  }

  /** Whether a turn of `threadId` is the pane's: its own thread's, or any but a subagent's before Codex named one. */
  private ownTurn(threadId: string | null): threadId is string {
    return threadId !== null && !this.subagents.has(threadId) && (this.thread === null || threadId === this.thread);
  }

  private tellFailure(turnId: string): void {
    if (this.toldFailedTurn === turnId) return;
    this.toldFailedTurn = turnId;
    this.hub.tellTurn(this.paneId, SOURCE.kind, { turn: "ended", prompt: turnId, failed: true });
  }

  status(): ServedStatus | null {
    return this.thread === null ? null : { threadId: this.thread, context: this.context, model: this.rerouted?.model ?? null };
  }

  questions(): CodexAsk[] {
    return [...this.asks.values()].filter((ask) => ask.threadId === this.thread);
  }

  /** Whether the server is known to wait on no question of the pane's own thread. */
  waitsOnNone(): boolean {
    return this.thread !== null && this.resumed.has(this.thread) && this.questions().length === 0;
  }

  /** Sends `answers` to question `key` of the pane's own thread, once, while the server still waits on it. */
  answer(key: string, answers: Record<string, { answers: string[] }>): boolean {
    const ask = this.asks.get(key);
    if (ask === undefined || ask.threadId !== this.thread || this.closed) return false;
    this.finish(key);
    this.send({ id: JSON.parse(key) as unknown, result: { answers } });
    return true;
  }

  /** Question `key` takes no answer any more. */
  private finish(key: string): void {
    const ask = this.asks.get(key);
    if (ask === undefined) return;
    this.asks.delete(key);
    this.done.push({ ask, at: Date.now() });
    this.done.splice(0, this.done.length - DONE_KEPT);
  }

  private receive(data: string): void {
    let message: unknown;
    try { message = JSON.parse(data); } catch { return; }
    if (!isObject(message)) return;
    const method = message["method"];
    const params = isObject(message["params"]) ? message["params"] : {};
    if (typeof method !== "string") {
      if (typeof message["id"] === "number") {
        const resolve = this.calls.get(message["id"]);
        this.calls.delete(message["id"]);
        resolve?.(message);
      }
      return;
    }
    if (message["id"] !== undefined) return this.request(message["id"], method, params);
    const threadId = typeof params["threadId"] === "string" ? params["threadId"] : null;
    switch (method) {
      case "thread/started":
        if (isObject(params["thread"])) this.started(params["thread"], true);
        break;
      case "thread/status/changed": {
        const status = isObject(params["status"]) ? params["status"] : {};
        if (threadId !== null && threadId === this.thread) this.idle = status["type"] === "idle";
        if (threadId === null || status["type"] !== "active") break;
        if (this.ownTurn(threadId) && this.turn !== "running") this.turn = "running";
        void this.subscribe(threadId);
        break;
      }
      case "turn/started": {
        const turn = isObject(params["turn"]) ? params["turn"] : {};
        // a subagent's turn names the parent's turn it runs under as its root (0.171.0)
        if (threadId !== null && typeof turn["rootTurnId"] === "string" && turn["rootTurnId"] !== turn["id"]) this.subagents.add(threadId);
        if (threadId === null || this.subagents.has(threadId)) break;
        this.own(threadId, true);
        const before = this.turnId;
        this.turn = "running";
        this.idle = false;
        this.turnId = typeof turn["id"] === "string" ? turn["id"] : null;
        // A new turn drops the previous failure from display and dedupe, even without a new herdr title.
        if (this.turnId === null || (this.turnId !== before && this.turnId !== this.toldFailedTurn)) {
          this.toldFailedTurn = null;
          this.hub.tellTurn(this.paneId, SOURCE.kind, { turn: "began", prompt: this.turnId });
        }
        if (this.rerouted !== null && this.rerouted.turnId !== this.turnId) { this.rerouted = null; changed(this.paneId); }
        break;
      }
      case "thread/settings/updated": {
        const settings = isObject(params["threadSettings"]) ? params["threadSettings"] : {};
        if (threadId === this.thread) this.model = text(settings["model"]) ?? this.model;
        break;
      }
      case "thread/tokenUsage/updated": {
        const context = threadId === this.thread ? tokenContext(params) : null;
        if (context === null || JSON.stringify(context) === JSON.stringify(this.context)) break;
        this.context = context;
        changed(this.paneId);
        break;
      }
      case "model/rerouted":
        // only the turn the pane's thread runs now: a late one for a turn before it names no model of this one
        if (threadId !== this.thread || typeof params["turnId"] !== "string" || (this.turnId !== null && params["turnId"] !== this.turnId)
          || typeof params["toModel"] !== "string" || params["toModel"].trim() === "") break;
        this.rerouted = { turnId: params["turnId"], model: params["toModel"] };
        changed(this.paneId);
        break;
      case "error": {
        // 0.171.0's ErrorNotification includes retryable notices. A terminal one (including usageLimitExceeded)
        // can precede turn/completed and is the same turn's failure, not another alert.
        const error = params["error"];
        if (threadId !== null && threadId === this.thread && this.ownTurn(threadId)
          && (this.turn === "running" || (this.turn === null && this.resumedActive))
          && params["willRetry"] === false && typeof params["turnId"] === "string"
          && (this.turnId === null || params["turnId"] === this.turnId) && isObject(error) && typeof error["message"] === "string") {
          this.tellFailure(params["turnId"]);
        }
        break;
      }
      case "turn/completed": {
        const turn = isObject(params["turn"]) ? params["turn"] : {};
        const id = typeof turn["id"] === "string" ? turn["id"] : null;
        if (this.ownTurn(threadId)) {
          this.turn = turn["status"] === "failed" ? "failed" : "answered";
          if (threadId === this.thread && this.turn === "failed" && id !== null && (this.turnId === null || this.turnId === id)) this.tellFailure(id);
        }
        if (threadId !== null && threadId === this.thread) this.idle = true;
        break;
      }
      case "item/started": {
        const item = isObject(params["item"]) ? params["item"] : {};
        // a subagent Codex starts is told on the parent's thread before its own thread runs; a client that did not
        // start it gets no thread/started for it (0.171.0)
        if (item["type"] === "subAgentActivity" && typeof item["agentThreadId"] === "string" && item["agentThreadId"] !== threadId) {
          this.subagents.add(item["agentThreadId"]);
          // its turn came first and was taken for the pane's: the parent, which runs a turn now, is
          if (this.thread === item["agentThreadId"] && threadId !== null) { this.own(threadId, true); this.turn = "running"; }
        }
        if (item["type"] !== "fileChange" || typeof item["id"] !== "string" || !Array.isArray(item["changes"])) break;
        const edits = item["changes"].flatMap((change): FileChange[] => {
          if (!isObject(change) || typeof change["path"] !== "string" || typeof change["diff"] !== "string") return [];
          const kind = isObject(change["kind"]) && typeof change["kind"]["type"] === "string" ? change["kind"]["type"] : "update";
          const movePath = isObject(change["kind"]) && typeof change["kind"]["move_path"] === "string" ? change["kind"]["move_path"] : undefined;
          return [{ path: change["path"], kind, diff: change["diff"], ...(movePath === undefined ? {} : { movePath }) }];
        });
        this.changes.set(item["id"], edits);
        break;
      }
      case "item/completed": {
        const item = isObject(params["item"]) ? params["item"] : {};
        if (typeof item["id"] === "string") this.changes.delete(item["id"]);
        break;
      }
      case "serverRequest/resolved": {
        const key = JSON.stringify(params["requestId"]);
        this.held.get(key)?.();
        this.held.delete(key);
        this.finish(key);
        break;
      }
    }
  }

  /**
   * An approval goes to the hub as a card; a question of the pane's own thread is kept by its id until the server says
   * it was answered; any other request is the TUI's to answer.
   */
  private request(id: unknown, method: string, params: Json): void {
    const key = JSON.stringify(id);
    if (method === "item/tool/requestUserInput") {
      const ask = params["threadId"] === this.thread ? askOf(key, params) : null;
      if (ask !== null) this.asks.set(key, ask);
      return;
    }
    if (!APPROVAL_METHODS.has(method)) return;
    if (this.held.has(key)) return;
    const card = codexCard(method, params, this.changes);
    if (card === null) return;
    const release = this.hub.hold(this.paneId, SOURCE, card, (decision) => {
      this.held.delete(key);
      const result = decision === null ? null : codexAnswer(method, params, decision);
      if (result !== null) this.send({ id, result });
    });
    if (release !== null) this.held.set(key, release);
  }

  private end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const release of this.held.values()) release();
    this.held.clear();
    this.asks.clear();
    if (this.thread !== null) changed(this.paneId);
    for (const resolve of this.calls.values()) resolve({ error: { message: "closed" }, closed: true });
    this.calls.clear();
    this.onClose();
  }

  close(): void {
    try { this.socket.close(); } catch {}
    this.end();
  }
}

/**
 * How many answered questions a pane keeps, and for how long, so a card of one its TUI still draws is not answered
 * again (codex-question.ts).
 */
const DONE_KEPT = 16;
const DONE_MS = 10_000;

interface Done { ask: CodexAsk; at: number }

interface Served { dir: string; connection: Connection | null; stopWaiting: () => void; done: Done[] }

const instances = new Set<CodexServers>();

/**
 * The last turn's end of the Codex Ovis started on its own server in `paneId`, as the server said (`turn/completed`):
 * null where Ovis has no connection to one there.
 */
export function servedTurnEnd(paneId: string): TurnEnd | null {
  for (const servers of instances) {
    const end = servers.turnEnd(paneId);
    if (end !== null) return end;
  }
  return null;
}

/**
 * What the Codex server Ovis started in `paneId` said of the pane's own thread (codex-status.ts): null where Ovis has
 * no connection to one there, or the server has named no thread yet.
 */
export function servedStatus(paneId: string): ServedStatus | null {
  for (const servers of instances) {
    const status = servers.connection(paneId)?.status() ?? null;
    if (status !== null) return status;
  }
  return null;
}

/**
 * Answers question `key` the Codex server Ovis started in `paneId` waits on, as data, once: false where it waits on
 * it no more (answered from the terminal, or by Ovis already) or Ovis has no connection there. Codex takes the first
 * answer and ignores a later one (serverRequest/resolved tells every client).
 */
export function answerServedQuestion(paneId: string, key: string, answers: Record<string, { answers: string[] }>): boolean {
  for (const servers of instances) {
    const connection = servers.connection(paneId);
    if (connection) return connection.answer(key, answers);
  }
  return false;
}

/**
 * The questions of the Codex Ovis started in `paneId` answered in the last DONE_MS, by Ovis or from the terminal, also
 * where Ovis lost its connection to the server since; oldest first.
 */
export function servedAnswered(paneId: string): CodexAsk[] {
  for (const servers of instances) {
    const done = servers.answered(paneId);
    if (done !== null) return done.filter(({ at }) => Date.now() - at < DONE_MS).map(({ ask }) => ask);
  }
  return [];
}

/** Whether the Codex server Ovis is connected to in `paneId` is known to wait on no question of the pane's own thread. */
export function servedWaitsOnNone(paneId: string): boolean {
  for (const servers of instances) {
    const connection = servers.connection(paneId);
    if (connection) return connection.waitsOnNone();
  }
  return false;
}

/**
 * Runs the bare `/plan` for thread `threadId` through the Codex server Ovis started in `paneId` (Connection.plan):
 * `unsent` where Ovis has no connection there.
 */
export async function servedPlan(paneId: string, threadId: string, mayWrite: () => boolean): Promise<"unsent" | "applied" | "unknown"> {
  for (const servers of instances) {
    const connection = servers.connection(paneId);
    if (connection) return await connection.plan(threadId, mayWrite);
  }
  return "unsent";
}

/**
 * Whether Ovis started Codex on its own server in `paneId`, connected or still coming up: the pane whose `/plan` can go
 * as data (until the connection knows the thread, it is typed).
 */
export function servesCommands(paneId: string): boolean {
  for (const servers of instances) if (servers.launchedHere(paneId)) return true;
  return false;
}

/** The questions the Codex server Ovis started in `paneId` waits on for the pane's own thread, oldest first. */
export function servedQuestions(paneId: string): CodexAsk[] {
  for (const servers of instances) {
    const connection = servers.connection(paneId);
    if (connection) return connection.questions();
  }
  return [];
}

const listeners = new Set<(paneId: string) => void>();

/** Calls `listener` with a pane whose servedStatus changed; the returned function stops that. */
export function onServedStatus(listener: (paneId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(paneId: string): void {
  for (const listener of listeners) listener(paneId);
}

/** The Codex servers of the panes Ovis started Codex in, and its connection to each. */
export class CodexServers {
  private readonly panes = new Map<string, Served>();
  private stopped = false;

  constructor(private readonly hub: ApprovalHub, private readonly options: { tmp?: string; connectMs?: number } = {}) {
    instances.add(this);
  }

  /**
   * The launcher `paneId` runs for Codex at `version` with `args`, written for this launch, or null for a launch that
   * runs as before. Ovis connects to its server as it comes up.
   */
  launch(paneId: string, args: readonly string[] | undefined, version: string | null): string | null {
    this.forget(paneId);
    if (this.stopped || version === null || !supportsCodexServer(version)) return null;
    const split = serverArgs(args ?? []);
    if (split === null) return null;
    // the pane runs the launcher by its path: a folder another account may rename entries in is no place for it. The
    // folder is made under the very path that was checked, not under a link to it
    const tmp = privateFolder(this.options.tmp ?? tmpdir());
    if (tmp === null) return null;
    let dir: string;
    try {
      dir = mkdtempSync(join(tmp, LAUNCH_PREFIX));
    } catch (error) {
      console.error(`codex server: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    const socket = join(dir, SOCKET_NAME);
    const program = join(dir, "launch");
    try {
      if (!PLAIN_PATH.test(socket)) throw new Error(`${socket} is not a plain path`);
      writeFileSync(program, launcherScript(dir, split.server, split.tui, args ?? []), { mode: 0o700 });
    } catch (error) {
      console.error(`codex server: ${error instanceof Error ? error.message : String(error)}`);
      rmSync(dir, { recursive: true, force: true });
      return null;
    }
    const served: Served = { dir, connection: null, stopWaiting: () => {}, done: [] };
    this.panes.set(paneId, served);
    this.await(paneId, served, socket);
    return program;
  }

  /** Waits for the server's socket in the launch's own folder (serverSocket), then connects to it. */
  private await(paneId: string, served: Served, socket: string): void {
    let done = false;
    let look: ReturnType<typeof setTimeout> | undefined;
    const finish = (connect: boolean) => {
      if (done) return;
      done = true;
      watcher?.close();
      clearTimeout(timer);
      clearTimeout(look);
      if (connect && this.panes.get(paneId) === served) served.connection = new Connection(socket, paneId, this.hub, () => { if (served.connection?.closed) served.connection = null; }, served.done);
    };
    // the link can come before the socket it names is up
    const check = () => {
      clearTimeout(look);
      if (serverSocket(socket)) finish(true);
      else if (!done) look = setTimeout(check, SOCKET_LOOK_MS);
    };
    served.stopWaiting = () => finish(false);
    const timer = setTimeout(() => finish(false), this.options.connectMs ?? CONNECT_MS);
    let watcher: ReturnType<typeof watch> | undefined;
    try {
      watcher = watch(served.dir, (_event, name) => { if (name === SOCKET_NAME) check(); });
      watcher.on("error", () => finish(false));
    } catch {
      return finish(false);
    }
  }

  launchedHere(paneId: string): boolean {
    return this.panes.has(paneId);
  }

  /** A call bound to this launch, not just its reusable pane id. */
  steerTarget(paneId: string, argv: readonly string[]) {
    const served = this.panes.get(paneId);
    const connection = served?.connection;
    const threadId = connection?.status()?.threadId;
    if (!served || !connection || !threadId || connection.closed || !argv.some((arg, i) =>
      arg === "--remote" && argv[i + 1] === `unix://${join(served.dir, SOCKET_NAME)}`)) return null;
    return { threadId, send: (input: string, clientId: string, checkPane: () => Promise<void>, writing: () => void) => connection.steer(threadId, input, clientId, checkPane, writing) };
  }

  turnEnd(paneId: string): TurnEnd | null {
    return this.panes.get(paneId)?.connection?.turn ?? null;
  }

  answered(paneId: string): readonly Done[] | null {
    return this.panes.get(paneId)?.done ?? null;
  }

  connection(paneId: string): Connection | null {
    const connection = this.panes.get(paneId)?.connection;
    return connection && !connection.closed ? connection : null;
  }

  /** `paneId` no longer runs that Codex (it moved, ended or closed, or another agent starts there): its connection goes. */
  forget(paneId: string): void {
    const served = this.panes.get(paneId);
    if (served === undefined) return;
    this.panes.delete(paneId);
    served.stopWaiting();
    served.connection?.close();
  }

  /**
   * The launch of `program` never ran: its folder goes, and Ovis stops waiting for its server while `paneId` is still
   * that launch's (another launch there since is left as it is).
   */
  abandon(paneId: string, program: string): void {
    const dir = dirname(program);
    if (this.panes.get(paneId)?.dir === dir) this.forget(paneId);
    // only a folder launch made: its name, in the folder launchers go in
    if (basename(dir).startsWith(LAUNCH_PREFIX) && privateFolder(this.options.tmp ?? tmpdir()) === dirname(dir)) rmSync(dir, { recursive: true, force: true });
  }

  stop(): void {
    this.stopped = true;
    for (const paneId of [...this.panes.keys()]) this.forget(paneId);
    instances.delete(this);
  }
}
