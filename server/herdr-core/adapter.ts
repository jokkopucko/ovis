import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, sep } from "node:path";
import { createConnection } from "node:net";
import type { Socket } from "bun";
import { AGENT_LABELS } from "../agents-routes.ts";
import { LINE_BYTES } from "../herdr/client.ts";
import { makeLineReader } from "../herdr/line-reader.ts";
import { cmdQuote, powershellNativeArgs, SHELL_AGENTS, shellCommandLine } from "../shell-agent.ts";
import { descendantProcesses, type ProcessRow, windowsProcessTable } from "../windows-processes.ts";
import { jobProcessesBelow } from "../foreground-job.ts";
import { type HcConnection, HcError } from "./connection.ts";
import { foreignLayout, OVIS_LAYOUT_DOC, type PaneDirection } from "./layout-doc.ts";
import { isHermesInstalledLauncher, paneSession } from "../agent-identity.ts";
import { AGENT_CATALOG } from "../../shared/agent-catalog.ts";
import { agentInfoOf, agentOfStatus, agyPlanReview, type CoreHost, coreHost, type FirstTurn, opencodeRecords, type SessionOf, type HcStatus, type HcTerminal, hcKeyName, HERDR_PROTOCOL, isRecord, keyBytes, LAYOUT_DOC, onOtherMachine, OTHER_WORKSPACE_ID, processInfoOf, runsCommandString, SPACE_LABEL, TAB_LABEL, WORKSPACE_NAME_LABEL } from "./snapshot.ts";
import { type CoreChange, coreModel, type SessionNote } from "./core-model.ts";
import { EVENT_LINE_BYTES, openEventStream } from "./event-stream.ts";
import { AdapterError } from "./errors.ts";
import { layoutCalls, LayoutStore, moveBesideEdit, newLayoutId, ownsLayout, ratioEdit, readCore, RESIZE_STEP, resizeEdit, swapEdit, zoomEdit } from "./layout-ops.ts";
import { checkoutHolding, defaultCheckoutPath, factsOf, git, gitDirIdentity, labeledWorktree, realPath, type Checkout, type Repository, repositoryOf, type RepositoryReads, WORKTREE_LABEL, WorktreeError, worktreeFolder, worktreeLabel } from "./worktrees.ts";
import type { SessionSnapshot, WorkspaceWorktreeInfo } from "../../shared/herdr-api.generated.ts";
import type { WorktreeInfo } from "../herdr/worktree-info.ts";
import type { HerdrWorkspaceWorktree } from "../../shared/protocol.ts";

/**
 * herdr's socket API, answered from herdr-core. The server talks to herdr through one client
 * (server/herdr/client.ts) whose callers read herdr's session snapshot, panes, screens and status
 * events; this adapter listens where that client connects (HERDR_SOCKET) and answers the methods a
 * terminal view needs from hc, so none of those callers learns a second runtime:
 *
 * - `ping`, `session.snapshot`, `pane.get`, `agent.get`, `pane.process_info` and `pane.read` from
 *   hc's terminal records, the app's layout document and `terminal.read`;
 * - `pane.send_text` as bytes typed into the terminal, over a short attach stream at the
 *   terminal's own grid (hc has no other way to type raw bytes, and a viewer at the current size
 *   resizes nothing);
 * - `pane.send_keys` as those keys' bytes in the same way, or hc's `terminal.keys` for a key that
 *   only hc can encode for the program's keyboard mode;
 * - `agent.prompt` as hc's `terminal.send` (paste and Enter, refused while the program is blocked, but for
 *   agy's plan review, whose input box takes the reply: snapshot.ts `agyPlanReview`);
 * - `events.subscribe` from hc's own event stream: status changes per pane, and terminal and layout
 *   changes as herdr's lifecycle events.
 *
 * On a core no Herdr app arranges (its document was never written: the desktop app's own core),
 * Ovis keeps names and a pane's workspace and tab in terminal labels, and the order of workspaces
 * and tabs, each tab's splits and its zoom in a document of its own, `ovis-layout`
 * (layout-doc.ts; `ping` says which in `layout`). Where the app arranges them, they are the app's.
 * hc has no worktrees: `worktree.*` runs git itself and opens a checkout as a workspace of its own
 * (worktrees.ts). Everything else (focus, plugins) is refused as `unsupported`.
 * The live terminal itself is `hc attach`, which the server
 * runs in place of `herdr terminal attach` (server/core/terminal-process.ts).
 *
 * As herdr does, each request has a connection of its own that ends with its answer; only an
 * events subscription stays open.
 */

interface Request { id: string; method: string; params: Record<string, unknown> }
type Reply = { result: unknown } | { error: { code: string; message: string } };

/** Ovis's subscription types that are status, not structure. */
const STATUS_EVENT = "pane.agent_status_changed";
const NOT_STRUCTURE = new Set([STATUS_EVENT, "pane.focused", "pane.output_matched"]);

interface ConnectionState {
  read: (chunk: Uint8Array) => void;
  /** bytes the kernel did not take yet */
  queue: Uint8Array[];
  /** end once the queue is out */
  ending: boolean;
  /** an events subscription this connection holds on hc */
  unsubscribe: (() => void) | null;
  closed: boolean;
}

export interface HerdrCoreAdapter {
  /** where it listens: the server's HERDR_SOCKET */
  socketPath: string;
  stop: (options?: { drain?: boolean }) => void | Promise<void>;
}

/**
 * `observeSeen`: told each terminal's turn and labels as the events subscription learns them, so the
 * server knows a turn some client marked seen before Ovis is told of a look (seen-label.ts SeenMarker).
 */
export type SeenObserver = (address: string, turn: number, labels: Record<string, string>) => void;

/**
 * `otherMachine`: the terminals are another machine's, reached through this PC's core (machine-scope.ts):
 * their processes and folders are not this PC's, so no process facts are told and no checkout opened,
 * and a Windows PC, which reads what runs in a pane off its own processes, starts no agent there.
 */
export interface AdapterOptions {
  acp?: import("../acp/children.ts").AcpChildren | null;
  otherMachine?: boolean;
  /** the OpenCode sessions whose terminal title this is (opencode.ts `opencodeSessionsTitled`); unset, no OpenCode pane shows a session */
  opencodeTitled?: (terminalTitle: string) => readonly string[];
  /** the PC this server runs on; a test names another */
  platform?: NodeJS.Platform;
  /** this PC's process table, read afresh within `timeoutMs` each time; a test stands in for it */
  processTable?: (timeoutMs: number) => Promise<ProcessRow[]>;
  /** what every shell the adapter starts runs in, over the core's own and under a call's `env` (terminal-env.ts) */
  terminalEnv?: () => Promise<Record<string, string>>;
}

/** The sessions a terminal named that it keeps as candidates, the newest last. */
const NAMED_SESSIONS = 32;
const LABEL_DRAIN_MS = 500;
/**
 * A terminal's named OpenCode sessions, space separated, kept on it through a restart of Ovis (docs/herdr-core-layout.md):
 * all of its candidates, about 1 KB at most, since the pane may still show any of them, not only the newest.
 */
export const OPENCODE_SESSIONS_LABEL = "ovis.opencode";

/**
 * Writes a terminal's named OpenCode sessions to its label when they change from what it holds, one
 * terminal's writes in order. A write that fails is tried again on the next change. Once stopped, a
 * write still queued is dropped rather than open a new line to hc after the server closed it.
 */
export function sessionLabeler(hc: Pick<HcConnection, "call">) {
  const written = new Map<string, string>();
  const queue = new Map<string, Promise<void>>();
  let accepting = true;
  let stopped = false;
  let draining: Promise<void> | undefined;
  const label = (address: string, kept: string, named: readonly string[]) => {
    const value = named.join(" ");
    if (!accepting || value === (written.get(address) ?? kept)) return;
    written.set(address, value);
    const run = (queue.get(address) ?? Promise.resolve())
      .then(async () => { if (!stopped) await hc.call("terminal.label", { terminal: address, labels: { [OPENCODE_SESSIONS_LABEL]: value } }); })
      .then(() => {}, () => { if (written.get(address) === value) written.delete(address); });
    queue.set(address, run);
    void run.then(() => { if (queue.get(address) === run) queue.delete(address); });
  };
  const stop: HerdrCoreAdapter["stop"] = (options) => {
    accepting = false;
    if (!options?.drain || queue.size === 0) { stopped = true; return; }
    if (stopped) return;
    draining ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(queue.values()),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, LABEL_DRAIN_MS); }),
        ]);
      } finally {
        stopped = true;
        clearTimeout(timer);
      }
    })();
    return draining;
  };
  return { label, forget: (address: string) => written.delete(address), stop };
}

export async function startHerdrCoreAdapter(hc: HcConnection, socketPath: string, observeSeen?: SeenObserver, options: AdapterOptions = {}): Promise<HerdrCoreAdapter> {
  if (existsSync(socketPath)) {
    const live = await new Promise<boolean>((resolve, reject) => {
      const probe = createConnection(socketPath);
      probe.once("connect", () => { probe.destroy(); resolve(true); });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
        else reject(error);
      });
    });
    if (live) throw new Error("Another Ovis owns this state directory: the herdr-core socket is still listening");
    rmSync(socketPath, { force: true });
  }
  // the turn each terminal had when this server first saw it: without `herdr.seen`, a turn that
  // ended since is done, in the snapshot and the events alike (snapshot.ts `shownStatusOf`)
  const firstTurns = new Map<string, number>();
  const firstTurn = (terminal: { address: string; turn?: number }): number => {
    if (!firstTurns.has(terminal.address)) firstTurns.set(terminal.address, terminal.turn ?? 0);
    return firstTurns.get(terminal.address)!;
  };
  // the OpenCode sessions each terminal named while they were pending (snapshot.ts `opencodeRecords`),
  // in every snapshot and status event, so a turn that ended between two snapshots is still one. A
  // terminal first seen running OpenCode starts from the sessions its `ovis.opencode` label kept, so
  // one that rests through a restart of Ovis still shows its session; an empty entry is a terminal
  // seen without OpenCode, whose label is cleared and never read again.
  const sessions = new Map<string, string[]>();
  const sessionLabels = sessionLabeler(hc);
  const noteSession = (address: string, status: HcStatus | null | undefined, records: unknown, labels: Readonly<Record<string, string>> | undefined): readonly string[] => {
    const kept = labels?.[OPENCODE_SESSIONS_LABEL] ?? "";
    if (agentOfStatus(status) !== "opencode") {
      sessions.set(address, []);
      sessionLabels.label(address, kept, []);
      return [];
    }
    const pending = opencodeRecords(records);
    const before = sessions.get(address) ?? kept.split(" ").filter((id) => id !== "");
    const named = [...before.filter((id) => !pending.includes(id)), ...pending].slice(-NAMED_SESSIONS);
    sessions.set(address, named);
    sessionLabels.label(address, kept, named);
    return named;
  };
  // the sessions a terminal named and those whose title it shows, decided in agent-identity.ts `paneSession`
  const sessionOf: SessionOf = (terminal) => {
    const named = noteSession(terminal.address, terminal.status, terminal.records, terminal.labels);
    const titled = named.length === 0 || !terminal.title || !options.opencodeTitled ? [] : options.opencodeTitled(terminal.title);
    return paneSession(agentOfStatus(terminal.status), { named, titled });
  };
  const forgetTurns = (live: ReadonlySet<string>) => {
    for (const address of firstTurns.keys()) if (!live.has(address)) firstTurns.delete(address);
    for (const address of sessions.keys()) {
      if (live.has(address)) continue;
      sessions.delete(address);
      sessionLabels.forget(address);
    }
  };
  // every events subscription open now, told when the layout changed without an hc event
  const layoutWatchers = new Set<() => void>();
  const answers = createAnswers(hc, firstTurn, forgetTurns, options, () => { for (const watcher of layoutWatchers) watcher(); }, sessionOf);
  const listener = Bun.listen<ConnectionState>({
    unix: socketPath,
    socket: {
      open(socket) {
        let first = true;
        socket.data = {
          queue: [],
          ending: false,
          unsubscribe: null,
          closed: false,
          read: makeLineReader(LINE_BYTES, (line) => {
            // one request per connection, as herdr reads it
            if (!first) return;
            first = false;
            const request = parseRequest(line);
            if (!request) { send(socket, `${JSON.stringify({ id: "", error: { code: "bad_frame", message: "not a herdr request" } })}\n`, true); return; }
            if (request.method === "events.subscribe") { void subscribe(hc, socket, request, firstTurn, coreHost(options.otherMachine, options.platform), layoutWatchers, observeSeen, noteSession, options.acp); return; }
            void answers(request).then((reply) => send(socket, `${JSON.stringify({ id: request.id, ...reply })}\n`, true));
          }, () => socket.end()),
        };
      },
      data(socket, chunk) {
        socket.data.read(chunk);
      },
      drain(socket) {
        flush(socket);
      },
      close(socket) {
        socket.data.closed = true;
        socket.data.unsubscribe?.();
      },
      error(socket) {
        socket.data.closed = true;
        socket.data.unsubscribe?.();
      },
    },
  });
  return {
    socketPath,
    stop: (options) => {
      listener.stop(true);
      rmSync(socketPath, { force: true });
      return sessionLabels.stop(options);
    },
  };
}

function parseRequest(line: string): Request | null {
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(frame) || typeof frame["id"] !== "string" || typeof frame["method"] !== "string") return null;
  return { id: frame["id"], method: frame["method"], params: isRecord(frame["params"]) ? frame["params"] : {} };
}

function send(socket: Socket<ConnectionState>, text: string, end = false): void {
  const state = socket.data;
  if (state.closed) return;
  state.queue.push(new TextEncoder().encode(text));
  if (end) state.ending = true;
  flush(socket);
}

function flush(socket: Socket<ConnectionState>): void {
  const state = socket.data;
  while (state.queue.length > 0) {
    const next = state.queue[0]!;
    const written = socket.write(next);
    if (written < next.length) {
      state.queue[0] = next.subarray(Math.max(0, written));
      return;
    }
    state.queue.shift();
  }
  if (state.ending) socket.end();
}

/**
 * The label a move from herdr (server/runtime-move-run.ts) puts on every terminal it starts, in the
 * terminal's first `terminal.run`, so a move that cannot finish finds and ends exactly those.
 */
export const MOVE_LABEL = "ovis.move";
const moveLabel = (params: Record<string, unknown>): Record<string, string> => typeof params["move"] === "string" && params["move"] !== "" ? { [MOVE_LABEL]: params["move"] } : {};
/** A new workspace's or tab's name asked for; an empty one is none. */
const shellName = (params: Record<string, unknown>): string | undefined => typeof params["label"] === "string" && params["label"] ? params["label"] : undefined;
/** The folder a call asks a new shell to start in, as given. */
const cwdOf = (params: Record<string, unknown>): string | undefined => typeof params["cwd"] === "string" ? params["cwd"] : undefined;
/** The environment a call asks a new shell to run in: its string values. */
const envOf = (params: Record<string, unknown>): Record<string, string> | undefined => isRecord(params["env"]) ? Object.fromEntries(Object.entries(params["env"]).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : undefined;

/** An agent whose command is not its kind, as the Herdr app runs it (herdr-app defaults/programs.json): the Cursor IDE is `cursor`. */
const AGENT_COMMANDS: Readonly<Record<string, string>> = { cursor: "cursor-agent" };

/**
 * A shell the start line is typed into, as hc reports a terminal started with no program
 * (`/bin/bash`, a login `-zsh`): the POSIX ones, and fish, which reads the same quoting for an
 * agent's name and plain arguments (nu does not).
 */
const SHELL = /(?:^|\/)-?(?:sh|bash|dash|zsh|ksh|mksh|ash|fish)$/u;
/** The flags a plain interactive shell may be started with; anything else (`-c`) runs a program in it. */
const SHELL_FLAGS = new Set(["-l", "--login", "-i"]);
const plainShell = (argv: readonly string[]): boolean => SHELL.test(argv[0] ?? "") && argv.slice(1).every((arg) => SHELL_FLAGS.has(arg));
/** The switches that leave PowerShell an interactive shell. */
const POWERSHELL_SWITCHES = new Set(["-nologo", "-noexit", "-noprofile", "-login"]);
/** How the `-Command` of hc's own PowerShell begins (a live record, hc 0.1.17): its prompt hook, which keeps the terminal's cwd current. */
const HC_PROMPT_HOOK = "$global:__hc_prompt = $function:prompt;";
/** What Windows may start below a shell for a console, which is no program of the pane's. */
const CONSOLE_HOSTS = new Set(["conhost", "openconsole"]);

/** A Windows program's name as its path ends: Windows takes it in any case, with or without its `.exe`. */
const windowsProgram = (program: string): string => (program.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");

/** A shell a start line is typed into, each quoted its own way: `powershell` is Windows PowerShell 5.1, `pwsh` PowerShell 7. */
type StartShell = "posix" | "powershell" | "pwsh" | "cmd";

/**
 * The shell a terminal's program is, or null for one that runs a program: `claude`, `sh -c claude`,
 * the app's `powershell.exe -NoExit -Command "& 'claude'"`. On Windows it is hc's own PowerShell
 * (its `-Command` is only its prompt hook), another PowerShell or cmd.exe, and no POSIX one: Git
 * Bash's MSYS turns an argument that looks like a path (`/review`) into a Windows path on its way
 * to the agent, and the variable that stops it would stay set for every command the agent runs
 * there; WSL's bash runs the agent where this PC's process table does not see it.
 */
function startShellOf(argv: readonly string[], platform: NodeJS.Platform): StartShell | null {
  if (platform !== "win32") return plainShell(argv) ? "posix" : null;
  const name = windowsProgram(argv[0] ?? "");
  const args = argv.slice(1);
  // cmd runs what follows a /c, /k or /r, even one run together with another switch (`/q/c`), and
  // its /v reads `!` in an argument, which nothing here quotes for
  if (name === "cmd") return args.every((arg) => !/\/[ckrv]/i.test(arg)) ? "cmd" : null;
  if (name !== "powershell" && name !== "pwsh") return null;
  const hooked = args.length >= 2 && /^-(?:command|c)$/i.test(args.at(-2)!) && args.at(-1)!.startsWith(HC_PROMPT_HOOK);
  return (hooked ? args.slice(0, -2) : args).every((arg) => POWERSHELL_SWITCHES.has(arg.toLowerCase())) ? name : null;
}

/**
 * The line that starts `command` with `args` in `shell`. Ctrl-U first in a POSIX shell: a line
 * someone left half typed is cleared, not run with the command after it. PowerShell's default
 * editing mode would type Ctrl-U into the line, and no key clears a line in each of its modes: a
 * PowerShell or cmd line goes alone, in PowerShell as a call (`& 'claude' …`), as a bare quoted
 * name is a string there, and in cmd with the name unquoted: a `.cmd` shim found on the PATH under
 * a quoted name reads the current folder as its own (`%~dp0`, live-verified), and the name is only
 * letters, digits and `-`. An argument the shell would not pass unchanged is refused.
 */
function startLine(shell: StartShell, command: string, args: readonly string[]): string {
  if (shell === "posix") return `\u0015${shellCommandLine("posix", command, args)}\r`;
  try {
    return `${shell === "cmd" ? [command, ...args.map(cmdQuote)].join(" ") : shellCommandLine("powershell", command, powershellNativeArgs(shell, args))}\r`;
  } catch (error) {
    throw new AdapterError("invalid_params", error instanceof Error ? error.message : String(error));
  }
}

/** How long a typed agent start may take to show in front of its shell. */
const AGENT_START_MS = 10_000;

/** What hc sends right after the screen in a first paint: the win32-input-mode state (herdr-core viewers.rs `first_paint`). */
const PAINT_END = "\u001b[?9001";
/** How a first paint begins: hc's CAN, then the soft reset of ghostty-vt `paint`. */
const PAINT_START = "\u0018\u001b[!p";
/** How long a watch-only attach may take to bring its first paint: within the 1.5s a prompt poll gives its colored read. */
const PAINT_MS = 1_000;
/** Any escape sequence: CSI, OSC, a DCS/SOS/PM/APC string, or a short escape (HTS, a charset designation). */
const ESCAPE_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[PX^_][^\u001b]*\u001b\\|[ -/]*[0-~])/g;
const SGR_RE = /^\u001b\[[0-9;:]*m$/;
/** The clear a first paint starts with, after hc's reset, and the one between its history and its screen. */
const PAINT_CLEAR = "\u001b[H\u001b[2J";
/** hc's switch to the alternate screen in a first paint, right before it paints that screen. */
const ALTERNATE_SCREEN = "\u001b[?1049h";

/**
 * Where the alternate screen's paint begins in a first paint, right after hc switches to it, or -1
 * when the program is on the main screen. hc paints the main screen first, then switches and paints
 * the alternate one (measured on hc 0.1.21), so the switch may come well after the first clear: a
 * program a shell started there (Claude Code typed at a prompt) has the shell's modes, tab stops and
 * lines painted before it.
 */
function alternateScreenAt(paint: string): number {
  const end = paint.indexOf(PAINT_END);
  const cleared = paint.indexOf(PAINT_CLEAR);
  const at = end === -1 || cleared === -1 ? -1 : paint.indexOf(ALTERNATE_SCREEN, cleared);
  return at === -1 || at > end ? -1 : at + ALTERNATE_SCREEN.length;
}

/**
 * What hc's text read of the screen (`terminal.read`, no history) shows, with its colors, from the
 * first paint of an attach that asked for `rows` lines of history: one line per row with its SGR
 * attributes and no other escape (cursor moves, modes, tab stops, title). hc's read trims the
 * spaces at the end of each row (a U+00A0 stays), drops the screen's blank rows at the bottom and
 * takes as many history lines in at the top, so this does too, but for a space drawn in a color:
 * that one tells input from padding (OpenCode's Tab space), and a text compare trims it anyway. hc paints after a
 * clear (`CSI H CSI 2J`): the history, pushed up by an SGR reset, a line break and one more per
 * screen row, then a second clear and the screen, which ends where the win32-input-mode state
 * follows (herdr-core ghostty-vt `paint`, viewers.rs `first_paint`). A program on the alternate
 * screen has no history there, and hc's read takes none in: its screen is what hc paints after the
 * switch to it (alternateScreenAt), never the main screen's lines before it. null for a paint not
 * shaped so. A row the terminal soft-wrapped stays a line of its own, as on the screen, where hc's
 * text read joins it with the next.
 */
export function paintedScreen(paint: string, rows: number): string | null {
  const end = paint.indexOf(PAINT_END);
  const parts = paint.slice(0, Math.max(end, 0)).split(PAINT_CLEAR);
  if (end === -1 || parts.length < 2) return null;
  const text = (part: string): string => part.replace(ESCAPE_RE, (sequence) => (SGR_RE.test(sequence) ? sequence : ""))
    .replace(/\r\n/g, "\n").replace(/\r/g, "");
  const alternate = alternateScreenAt(paint);
  let painted: string[];
  if (alternate !== -1) painted = text(paint.slice(alternate, end)).split("\n");
  else {
    if (parts.length > 3) return null;
    const pushed = "\n".repeat(rows + 1);
    const history = parts.length === 3 ? text(parts[1]!) : "";
    if (history !== "" && !history.endsWith(pushed)) return null;
    painted = [...(history === "" ? [] : history.slice(0, -pushed.length).split("\n")), ...text(parts.at(-1)!).split("\n")];
  }
  const lines = painted.map(withoutPlainTrailingSpaces);
  while (lines.length > 0 && lines.at(-1)!.replace(/\u001b\[[0-9;:]*m/g, "") === "") lines.pop();
  return lines.slice(-rows).join("\n");
}

/** A line with the spaces at its end taken out, but for those drawn in a foreground or background color; its SGR codes stay. */
function withoutPlainTrailingSpaces(line: string): string {
  const pieces = line.split(/(\u001b\[[0-9;:]*m)/);
  let fg = false;
  let bg = false;
  const colored = pieces.map((piece) => {
    if (!piece.startsWith("\u001b")) return fg || bg;
    const codes = piece.slice(2, -1).split(/[;:]/).map((code) => Number(code || 0));
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index]!;
      if (code === 0) { fg = false; bg = false; }
      else if (code === 39) fg = false;
      else if (code === 49) bg = false;
      else if (code === 38 || code === 48) { if (code === 38) fg = true; else bg = true; index += codes[index + 1] === 5 ? 2 : codes[index + 1] === 2 ? 4 : 0; }
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = true;
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) bg = true;
    }
    return false;
  });
  for (let index = pieces.length - 1; index >= 0; index--) {
    if (pieces[index]!.startsWith("\u001b")) continue;
    if (colored[index]) break;
    const kept = pieces[index]!.replace(/ +$/, "");
    pieces[index] = kept;
    if (kept !== "") break;
  }
  return pieces.join("");
}

function paneIdOf(params: Record<string, unknown>, field = "pane_id", missing = "pane_not_found"): string {
  const value = params[field];
  if (typeof value !== "string" || value === "") throw new AdapterError("invalid_params", `${field} is required`);
  // another machine's terminal is no pane here (snapshot.ts `onOtherMachine`): nothing reads or types into it
  if ((field === "pane_id" || field === "target") && onOtherMachine(value)) throw new AdapterError(missing, `pane ${value} not found`);
  return value;
}

/** hc's refusal in herdr's words, where the server acts on them. */
function herdrCode(error: HcError, missing: string): string {
  switch (error.kind) {
    case "not_found": return missing;
    case "blocked": return "agent_blocked";
    case "unavailable": return "server_unavailable";
    case "timeout": return "timeout";
    // the line to hc ended or never spoke its protocol: hc cannot be reached, as a herdr socket nobody answers
    case "closed":
    case "bad_hello":
    case "bad_frame":
      return "connect_failed";
    default: return error.kind;
  }
}

/** How long git's facts for a pane's folder are kept: a snapshot is read on every change in the core. */
const CHECKOUT_FACTS_MS = 5_000;
/** How long a snapshot waits on git for one folder's facts before drawing it without them. */
const CHECKOUT_FACTS_WAIT_MS = 2_000;

function acpChildOf(terminal: HcTerminal, registry: AdapterOptions["acp"]) {
  if (!terminal.labels?.["ovis.acp"]) return undefined;
  const child = registry?.forPane(terminal.address);
  return child && child.id === terminal.labels?.["ovis.acp"] ? child : undefined;
}

function createAnswers(hc: HcConnection, firstTurn: FirstTurn, forgetTurns: (live: ReadonlySet<string>) => void, options: AdapterOptions, layoutChanged: () => void, sessionOf?: SessionOf): (request: Request) => Promise<Reply> {
  const platform = options.platform ?? process.platform;
  const processTable = options.processTable ?? windowsProcessTable;
  /** A Windows pane's programs are read off this PC's process table, which says nothing of another machine's. */
  const programsUnseen = platform === "win32" && options.otherMachine === true;
  /** Where a shell starts in place of `folder`: hc refuses a folder since removed (a deleted worktree) with `spawn_failed`, so this PC's home instead; another machine's folders are not on this disk, so they go as they are. */
  const startFolder = (folder: string | undefined): string | undefined => !folder || options.otherMachine || existsSync(folder) ? folder : homedir();

  const terminal = async (address: string, missing = "pane_not_found"): Promise<HcTerminal> => {
    const found = await hc.call("terminal.get", { terminal: address }).catch((error: unknown) => {
      throw error instanceof HcError ? new AdapterError(herdrCode(error, missing), error.message) : error;
    });
    if (found.state !== "live") throw new AdapterError(missing, `terminal ${address} has finished`);
    return found;
  };

  /**
   * git run on the machine whose terminals these are, by the core (`hc exec --on`): read-only lookups of its checkouts,
   * in English as this PC's git (worktrees.ts gitEnvironment): an older git's refused -z is told by its message.
   * A repository its core was started inside is not the one asked about, and an answer cut short is none.
   */
  const gitOnMachine: typeof git = async (cwd, args) => {
    const unset = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"].flatMap((name) => ["-u", name]);
    const ran = await hc.call("machine.exec", { argv: ["/usr/bin/env", ...unset, "/usr/bin/git", "-C", cwd, ...args], env: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, timeout: 8 });
    const text = (base64: string) => Buffer.from(base64, "base64").toString("utf8");
    return { ok: ran.code === 0 && !ran.timed_out && !ran.truncated, stdout: text(ran.stdout), stderr: text(ran.stderr).trim() };
  };
  /** another machine's folders and git folders are not on this disk: git runs there, and no path is resolved or stat'ed here */
  const gitReads: RepositoryReads = options.otherMachine ? { run: gitOnMachine, real: (path) => path } : {};
  /**
   * git's answer per folder: the checkout's facts and its git folder's identity (as a label keeps it),
   * or null outside git. Kept a few seconds; past that the last answer still serves while git is asked
   * again, so a snapshot waits on git only for a folder it never answered for, once and at most a
   * moment: a slow git (a network folder, a huge repository) leaves that row flat rather than hold
   * every snapshot. Its late answer, and an answer that differs from the last one, asks the clients
   * for a fresh snapshot.
   */
  type GitAnswer = { facts: WorkspaceWorktreeInfo; gitId: string | null } | null;
  type GitEntry = { until: number; answer: GitAnswer; asking: Promise<GitAnswer> | null; first: Promise<GitAnswer> | null; waitedOut: boolean; used: number };
  const checkoutFacts = new Map<string, GitEntry>();
  const askGit = (folder: string, entry: GitEntry): Promise<GitAnswer> => {
    entry.asking = repositoryOf(folder, gitReads).then((repository) => ({ facts: factsOf(repository, repository.checkout), gitId: options.otherMachine ? null : gitDirIdentity(repository.git_dir) }), () => null).then((answer) => {
      const changed = entry.waitedOut ? answer !== null : entry.until !== 0 && JSON.stringify(answer) !== JSON.stringify(entry.answer);
      Object.assign(entry, { until: Date.now() + CHECKOUT_FACTS_MS, answer, asking: null, waitedOut: false });
      if (changed) layoutChanged();
      return answer;
    });
    return entry.asking;
  };
  const answerFor = (folder: string): Promise<GitAnswer> => {
    let entry = checkoutFacts.get(folder);
    if (!entry) checkoutFacts.set(folder, entry = { until: 0, answer: null, asking: null, first: null, waitedOut: false, used: 0 });
    entry.used = Date.now();
    // never answered: the first snapshot waits a moment for the first answer, and the ones after it share that wait
    if (entry.until === 0) {
      const waiting = entry;
      return waiting.first ??= Promise.race([waiting.asking ?? askGit(folder, waiting), Bun.sleep(CHECKOUT_FACTS_WAIT_MS).then(() => {
        if (waiting.until === 0) waiting.waitedOut = true;
        return null;
      })]);
    }
    if (entry.until <= Date.now() && !entry.asking) void askGit(folder, entry);
    return Promise.resolve(entry.answer);
  };
  /**
   * The folder each workspace's checkout is read from, and the git folder identity it had when first
   * seen from a fresh answer. It stays while a terminal of the workspace started there: a tab moved in
   * front does not change the checkout a confirmation names, and a checkout removed and added again at
   * that path since is not the one drawn, however often git is asked again.
   */
  const pinned = new Map<string, { folder: string; gitId: string | null; at: number }>();
  /** per snapshot, the folder each workspace without a label is read from, as its row is drawn */
  const homesOf = new WeakMap<SessionSnapshot, Map<string, string>>();
  /**
   * herdr's snapshot of the core, whether Ovis keeps its layout (ownsLayout), from one read of the
   * app's document, and the git folder identity behind each workspace's facts that git gave.
   */
  const read = async (): Promise<{ shown: SessionSnapshot; own: boolean; gitIds: Map<string, string | null>; started: Map<string, string> }> => {
    const began = Date.now();
    const { shown, own, terminals: listed } = await readCore(hc, {
      firstTurn, sessionOf, host: coreHost(options.otherMachine, platform),
      shown: (terminals) => {
        forgetTurns(new Set(terminals.map((terminal) => terminal.address)));
        return terminals.map(terminal => {
          const child = acpChildOf(terminal, options.acp);
          if (!child) return terminal;
          const name = terminal.name && terminal.name !== terminal.address ? terminal.name : AGENT_CATALOG.find(entry => entry.id === child.harness)?.name ?? child.harness;
          return { ...terminal, name, acp: { agent: child.client.agentGone ? null : child.harness, status: child.client.status, plan: child.client.history.plan, ...(child.client.holdGeneration === null ? {} : { hold: { child_id: child.id, generation: child.client.holdGeneration } }) } };
        });
      },
    });
    const gitIds = new Map<string, string | null>();
    const started = new Map(listed.map((terminal) => [terminal.address, terminal.cwd]));
    const homes = new Map<string, string>();
    homesOf.set(shown, homes);
    // herdr reports every workspace's checkout from git; hc has none, so a workspace no label claims (one
    // the app arranges, or a checkout Ovis did not open) gets git's facts for the folder its first
    // terminal started in: as herdr's stays with a workspace, a shell there going elsewhere (a `cd`, an
    // agent changing folder) does not move the row, before or after a restart of Ovis. Clients draw and
    // act on these as on herdr's: removing a checkout asks git again first. No label is written.
    // Another machine's folders are not on this disk: git runs there for them (gitOnMachine), and only draws:
    // its worktree.* calls are refused here.
    const asked = new Map<SessionSnapshot["workspaces"][number], string>();
    for (const workspace of shown.workspaces) {
      if (workspace.worktree || workspace.workspace_id === OTHER_WORKSPACE_ID) continue;
      const folders = shown.panes.filter((pane) => pane.workspace_id === workspace.workspace_id).map((pane) => started.get(pane.pane_id));
      const kept = pinned.get(workspace.workspace_id)?.folder;
      const folder = kept !== undefined && folders.includes(kept) ? kept : folders[0];
      if (!folder) continue;
      asked.set(workspace, folder);
      homes.set(workspace.workspace_id, folder);
    }
    // an older read finishing late does not forget what a newer one asked
    const folders = new Set(asked.values());
    for (const [folder, entry] of checkoutFacts) if (!folders.has(folder) && !entry.asking && entry.used < began) checkoutFacts.delete(folder);
    const ids = new Set(shown.workspaces.map((workspace) => workspace.workspace_id));
    for (const [id, pin] of pinned) if (!ids.has(id) && pin.at < began) pinned.delete(id);
    await Promise.all([...asked].map(async ([workspace, folder]) => {
      const answer = await answerFor(folder);
      if (!answer) return;
      let pin = pinned.get(workspace.workspace_id);
      // the folder drawn is kept from the first draw; a pin a newer read took stands over this older one
      if (!pin || (pin.folder !== folder && pin.at < began)) pinned.set(workspace.workspace_id, pin = { folder, gitId: null, at: Date.now() });
      // its identity only from an answer git gave since: a cached one may be of a checkout no longer there
      if (pin.folder === folder && pin.gitId === null && (checkoutFacts.get(folder)?.until ?? 0) > Date.now()) pin.gitId = answer.gitId;
      const gitId = pin.folder === folder ? pin.gitId ?? answer.gitId : answer.gitId;
      gitIds.set(workspace.workspace_id, gitId);
      // the row carries the identity it is drawn with, which a delete it confirms sends back (#4211)
      const drawn: HerdrWorkspaceWorktree = { ...answer.facts, ...(gitId ? { git_id: gitId } : {}) };
      workspace.worktree = drawn;
    }));
    return { shown, own, gitIds, started };
  };
  const snapshot = async (): Promise<SessionSnapshot> => (await read()).shown;
  /** The read, for a call that changes the layout Ovis keeps in labels: refused where the Herdr app arranges this core. */
  const ownRead = async (): Promise<Awaited<ReturnType<typeof read>>> => {
    const found = await read();
    if (!found.own) throw new AdapterError("unsupported", "the Herdr app arranges this core's workspaces, tabs and panes");
    return found;
  };
  const layouts = new LayoutStore(hc, { snapshot: read, newId: newLayoutId, terminal, terminalEnv: options.terminalEnv, startFolder });
  /** A name asked for, as herdr's rename takes it: the workspace-routes refuse an empty one first. */
  const nameOf = (params: Record<string, unknown>): string => {
    const name = params["label"];
    if (typeof name !== "string" || name === "") throw new AdapterError("invalid_params", "label is required");
    return name;
  };

  /** How herdr answers a layout call: the tab's layout after it, and its focused pane. */
  const outcome = async (paneId: string, changed: boolean, reason: string | null) => {
    const shown = await snapshot();
    const tabId = shown.panes.find((pane) => pane.pane_id === paneId)?.tab_id;
    const layout = shown.layouts.find((candidate) => candidate.tab_id === tabId);
    if (!layout) throw new AdapterError("pane_not_found", `pane ${paneId} not found`);
    return { changed, reason: changed ? null : reason, focused_pane_id: layout.focused_pane_id, layout };
  };

  const paneOf = async (paneId: string, missing = "pane_not_found") => {
    const found = (await snapshot()).panes.find((pane) => pane.pane_id === paneId);
    if (!found) throw new AdapterError(missing, `pane ${paneId} not found`);
    return found;
  };

  /**
   * Bytes typed into the terminal, as a person at it would: over an attach at the grid hc says the
   * terminal has (a viewer that typed sets the size, so it must set this one), answered once hc
   * took the close that follows them, so what the caller does next comes after the bytes.
   */
  const type = async (paneId: string, bytes: string): Promise<void> => {
    const record = await terminal(paneId);
    const { result, channel } = await hc.open("terminal.attach", { terminal: paneId, cols: record.cols, rows: record.rows }, { onData: () => {}, onClose: () => {} });
    // resized since it was looked up: type at the size it has now
    const now = result.terminal;
    if (now && (now.cols !== record.cols || now.rows !== record.rows)) channel.resize(now.cols, now.rows);
    channel.write(bytes);
    await channel.close();
  };

  /**
   * The first paint (with `history` lines, else a screen's worth) of an attach that only watches, which never types or
   * resizes, closed once the screen is in, and the rows it was painted at. null: no paint within
   * PAINT_MS of hc answering the attach, or a stream that ended first. Another machine's line may drop
   * in the middle of a paint: hc then attaches again on the same channel and paints afresh
   * (remote/viewers.rs `reattach`), so only the last paint that began before the screen's end counts.
   */
  const watchedPaint = async (paneId: string, history?: number): Promise<{ paint: string | null; rows: number }> => {
    const record = await terminal(paneId);
    const decoder = new TextDecoder();
    let paint = "";
    const { promise, resolve } = Promise.withResolvers<string | null>();
    const { result, channel } = await hc.open("terminal.attach", { terminal: paneId, cols: record.cols, rows: record.rows, history: history ?? record.rows, observe: true }, {
      onData: (payload) => {
        paint += decoder.decode(payload, { stream: true });
        const end = paint.indexOf(PAINT_END);
        if (end !== -1) resolve(paint.slice(Math.max(paint.lastIndexOf(PAINT_START, end), 0)));
      },
      onClose: () => resolve(null),
    });
    // from hc's answer on: opening may take longer itself (another machine's relayed attach)
    const timer = setTimeout(() => resolve(null), PAINT_MS);
    try {
      // resized since it was looked up: the paint has the rows it has now
      return { paint: await promise, rows: result.terminal?.rows ?? record.rows };
    } finally {
      clearTimeout(timer);
      await channel.close();
    }
  };

  /**
   * hc's text read of the screen with its colors (paintedScreen): hc reads text only, so this is the
   * first paint of a watch-only attach. No paint, or a paint of another shape, answers the plain
   * text, as a read without colors.
   */
  const coloredScreen = async (paneId: string): Promise<string> => {
    const { paint, rows } = await watchedPaint(paneId);
    const screen = paint === null ? null : paintedScreen(paint, rows);
    return screen ?? (await hc.call("terminal.read", { terminal: paneId, lines: 0 })).text;
  };

  /**
   * Whether the terminal's program is on the alternate screen, which hc's record does not say: hc
   * paints its reset, which ends in a clear, then the main screen, then switches to the alternate
   * screen and paints it if the program is on it (herdr-core ghostty-vt `paint`, alternateScreenAt).
   * No paint, a paint without that clear, or an attach hc refused (a kept terminal whose program is
   * lost, whose stored screen hc still reads), counts as the alternate screen.
   */
  const onAlternateScreen = async (paneId: string): Promise<boolean> => {
    const { paint } = await watchedPaint(paneId, 0).catch((error: unknown) => {
      if (error instanceof HcError) return { paint: null };
      throw error;
    });
    return paint === null || !paint.includes(PAINT_CLEAR) || alternateScreenAt(paint) !== -1;
  };

  /** Input to one pane in the order it was asked for: each attach and its bytes finish before the next. */
  const turns = new Map<string, Promise<unknown>>();
  const inTurn = <T>(paneId: string, work: () => Promise<T>): Promise<T> => {
    const run = (turns.get(paneId) ?? Promise.resolve()).then(work, work);
    const settled = run.then(() => {}, () => {});
    turns.set(paneId, settled);
    void settled.then(() => { if (turns.get(paneId) === settled) turns.delete(paneId); });
    return run;
  };

  /**
   * What runs in a pane's shell, each program by the parts of the words that name it (its name, then
   * argv), or null when that cannot be read. hc names the program in front of the shell, but on
   * Windows only ever the shell (live-verified, hc 0.1.17: a running claude.exe was the shell's
   * child, and the shell was in front): there it is what is below the shell in this PC's process
   * table, in lower case as Windows takes a name in any.
   */
  const running = async (record: HcTerminal, timeoutMs: number): Promise<string[][] | null> => {
    if (platform !== "win32") {
      const front = record.foreground;
      return front && front.pid !== record.pid ? [[front.name, ...(front.argv ?? []).slice(0, 2)].flatMap((part) => part.split("/"))] : [];
    }
    if (!record.pid) return null;
    const rows = await processTable(timeoutMs);
    // a PC runs hundreds of processes: none at all is a table that could not be read
    if (rows.length === 0) return null;
    return descendantProcesses(rows, record.pid).filter((entry) => !CONSOLE_HOSTS.has(windowsProgram(entry.argv[0] ?? "")))
      .map((entry) => entry.argv.slice(0, 2).flatMap((word) => word.toLowerCase().split(/[\\/]/)));
  };

  /** The repository a workspace works in: the checkout its facts name, or its first pane's folder. */
  const inRepository = async (workspaceId: string): Promise<{ shown: SessionSnapshot; repository: Repository }> => {
    // a checkout opens as a workspace Ovis places: refused where the Herdr app arranges the core, as ping says
    const shown = await layouts.ownLayout();
    const workspace = shown.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
    if (!workspace) throw new AdapterError("workspace_not_found", `workspace ${workspaceId} not found`);
    // where its row is read from, else where its shell is now: a shell gone into a repository from outside makes worktrees there
    const home = workspace.worktree?.checkout_path ?? homesOf.get(shown)?.get(workspaceId);
    const now = shown.panes.find((pane) => pane.workspace_id === workspaceId)?.cwd;
    const folder = home ?? now;
    if (!folder) throw new AdapterError("not_git_worktree", `workspace ${workspaceId} has no folder`);
    const repository = await repositoryOf(folder).catch((error: unknown) => {
      if (workspace.worktree || !now || now === folder) throw error;
      return repositoryOf(now);
    });
    return { shown, repository };
  };
  /**
   * Which workspace shows each checkout: the one its facts name, else the one whose first pane works
   * in it. A folder below a checkout's own is that checkout's only when git says so: it may be a
   * repository of its own nested in it.
   */
  const openWorkspaces = async (shown: SessionSnapshot, repository: Repository): Promise<Map<string, string>> => {
    const open = new Map<string, string>();
    for (const workspace of shown.workspaces) {
      if (workspace.workspace_id === OTHER_WORKSPACE_ID) continue;
      const facts = workspace.worktree;
      const folder = facts ? (facts.repo_key === repository.repo_key ? facts.checkout_path : null) : homesOf.get(shown)?.get(workspace.workspace_id) ?? shown.panes.find((pane) => pane.workspace_id === workspace.workspace_id)?.cwd;
      if (!folder) continue;
      const real = realPath(folder);
      const checkout = checkoutHolding(repository.checkouts, real);
      if (!checkout || open.has(checkout)) continue;
      if (checkout !== real) {
        const top = await git(real, ["rev-parse", "--show-toplevel"]);
        if (!top.ok || realPath(top.stdout.trim()) !== checkout) continue;
      }
      open.set(checkout, workspace.workspace_id);
    }
    return open;
  };
  /** create and open one at a time: two asking for the same checkout get one workspace */
  let opening: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(run: () => Promise<T>): Promise<T> => {
    const next = opening.then(run, run);
    opening = next.catch(() => undefined);
    return next;
  };
  const infoOf = (repository: Repository, checkout: Checkout, open: ReadonlyMap<string, string>): WorktreeInfo => ({
    ...checkout,
    label: checkout.branch ? worktreeFolder(checkout.branch) : basename(checkout.path),
    is_linked_worktree: checkout.path !== repository.repo_root,
    open_workspace_id: open.get(checkout.path) ?? null,
  });
  /**
   * Opens a checkout as a workspace of its own, a shell in its folder carrying its facts. The
   * repository's own workspace gets its facts too, so the new one is drawn under it.
   */
  const openCheckout = async (shown: SessionSnapshot, repository: Repository, checkout: string, name: string) => {
    const head = (await openWorkspaces(shown, repository)).get(repository.repo_root);
    // the repository's own checkout keeps its git folder in the common one
    // (a label: facts git gave only for drawing keep no git folder identity)
    if (head && !(await layouts.worktreeLabelOf(shown, head))[WORKTREE_LABEL]) {
      await layouts.label(shown.panes.filter((pane) => pane.workspace_id === head).map((pane) => pane.pane_id), { [WORKTREE_LABEL]: worktreeLabel(factsOf(repository, repository.repo_root), repository.repo_key) });
    }
    const own = checkout === repository.repo_root ? repository.repo_key : (await repositoryOf(checkout)).git_dir;
    return layouts.startShell({
      [SPACE_LABEL]: `ovis-${crypto.randomUUID()}`,
      [TAB_LABEL]: `ovis-${crypto.randomUUID()}`,
      [WORKSPACE_NAME_LABEL]: name,
      [WORKTREE_LABEL]: worktreeLabel(factsOf(repository, checkout), own),
    }, { cwd: checkout });
  };
  const textOf = (params: Record<string, unknown>, field: string): string | undefined => {
    const value = params[field];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };

  const methods: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
    async ping() {
      const [hello, doc, ovis] = await Promise.all([hc.hello(), hc.call("doc.get", { name: LAYOUT_DOC }), hc.call("doc.get", { name: OVIS_LAYOUT_DOC })]);
      const own = ownsLayout(doc.value);
      // splits, their ratios, zoom, swap and order live in Ovis's document: only where hc writes one this Ovis may write
      const arrange = own && layoutCalls(hello) && !foreignLayout(ovis.value);
      // a checkout opens as a workspace Ovis places: only where Ovis keeps the layout
      return { version: hello.version, protocol: HERDR_PROTOCOL, capabilities: { direct_terminal_attach: true, runtime: "herdr-core", layout: { rename: own, split: arrange, move: own, arrange, worktrees: own && !options.otherMachine } } };
    },
    async "session.snapshot"() {
      return { snapshot: await snapshot() };
    },
    async "pane.get"(params) {
      return { pane: await paneOf(paneIdOf(params)) };
    },
    async "agent.get"(params) {
      const pane = await paneOf(paneIdOf(params, "target", "agent_not_found"), "agent_not_found");
      if (!pane.agent) throw new AdapterError("agent_not_found", `no agent in pane ${pane.pane_id}`);
      return { type: "agent_info", agent: agentInfoOf(pane) };
    },
    async "pane.process_info"(params) {
      const found = await terminal(paneIdOf(params));
      // another machine's pids name nothing here: a reader must not take one of this PC's processes for it
      if (options.otherMachine) return { type: "pane_process_info", process_info: { pane_id: found.address, shell_pid: null, foreground_process_group_id: null, foreground_processes: [] } };
      // a template's program runs below the shell hc names in front: read the rest of that job (#4052)
      const job = runsCommandString(found.foreground) ? await jobProcessesBelow(found.foreground.pid) : null;
      return { type: "pane_process_info", process_info: processInfoOf(found, job) };
    },
    async "pane.read"(params) {
      const paneId = paneIdOf(params);
      const pane = await paneOf(paneId);
      const source = typeof params["source"] === "string" ? params["source"] : "visible";
      const format = typeof params["format"] === "string" ? params["format"] : "text";
      const recent = source === "recent" || source === "recent_unwrapped";
      const wanted = typeof params["lines"] === "number" && params["lines"] > 0 ? Math.floor(params["lines"]) : null;
      if (format === "ansi" && source === "visible" && params["strip_ansi"] !== true) {
        return { read: { pane_id: paneId, workspace_id: pane.workspace_id, tab_id: pane.tab_id, source, format, text: await coloredScreen(paneId), revision: pane.revision, truncated: false } };
      }
      // hc reads the screen plus `lines` of history above it; herdr's recent read is the last `lines` lines.
      // A program on the alternate screen keeps no history there, as on herdr: for one, hc would scroll
      // the program to read its own, then repaint every viewer, a drag in it included (#3128)
      const history = recent && !(await onAlternateScreen(paneId));
      const read = await hc.call("terminal.read", { terminal: paneId, lines: history ? wanted ?? 1000 : 0 });
      let text = read.text;
      if (recent && wanted !== null) {
        const rows = text.split("\n");
        if (rows.length > wanted) text = rows.slice(-wanted).join("\n");
      }
      // hc reads text only: plain text is an ANSI screen without colours
      return { read: { pane_id: paneId, workspace_id: pane.workspace_id, tab_id: pane.tab_id, source, format, text, revision: pane.revision, truncated: !read.complete || (recent && !history) } };
    },
    // herdr starts an agent by its kind (its command is its kind) from herdr's own manifests; hc has
    // none, so the kinds Ovis knows are offered, and the start types the command into the pane's
    // shell as a person would. Ovis's own shell-started agents are offered and started by the
    // server itself (shell-agent.ts), through pane.send_text. On Windows that shell is PowerShell or
    // cmd (startShellOf), and another machine's terminals, whose programs its table does not show,
    // are offered no kind; nor is Command Code, whose command `cmd` is cmd.exe there.
    async "server.agent_manifests"() {
      if (programsUnseen) return { manifests: [] };
      const manifests = Object.keys(AGENT_LABELS).filter((agent) => !Object.hasOwn(SHELL_AGENTS, agent) && !(platform === "win32" && agent === "cmd"))
        .map((agent) => ({ agent, source: "herdr-core", source_kind: "herdr-core", local_override_shadowing_remote: false }));
      return { manifests };
    },
    async "agent.start"(params) {
      const paneId = paneIdOf(params);
      const kind = params["kind"];
      if (typeof kind !== "string" || !/^[a-z][a-z0-9-]*$/.test(kind)) throw new AdapterError("invalid_params", "kind is required");
      // Command Code's command `cmd` is cmd.exe here, which would answer as a started agent
      if (platform === "win32" && kind === "cmd") throw new AdapterError("invalid_params", "Command Code's command is cmd.exe on Windows");
      const args = Array.isArray(params["args"]) ? params["args"].filter((arg): arg is string => typeof arg === "string") : [];
      // a control character could end the quoted line early and type something else
      if (args.some((arg) => /[\u0000-\u001f\u007f]/.test(arg))) throw new AdapterError("invalid_params", "an argument holds a control character");
      const command = AGENT_COMMANDS[kind] ?? kind;
      // a launcher Ovis wrote for this start (server/approvals/codex.ts) runs in place of the command, which it starts
      const program = params["program"];
      if (program !== undefined && (typeof program !== "string" || !isAbsolute(program) || /[\u0000-\u001f\u007f]/.test(program))) throw new AdapterError("invalid_params", "program must be an absolute path");
      // only into the pane's own shell, once hc has seen it in front: a running program would take
      // the line as its input (agent-launch.ts retries a busy pane while a new shell comes up). The
      // pane's input turn is held for the check and the typing only, so nothing typed after waits on the start.
      await inTurn(paneId, async () => {
        const ready = await terminal(paneId);
        if (programsUnseen) throw new AdapterError("agent_pane_unsupported", `pane ${paneId} is on another machine, whose programs this PC cannot see`);
        // the terminal's own program must be a plain shell: one the app started as a program (`claude`)
        // is in front of itself too, and `sh -c claude` (a template, a line) runs it under dash's pid.
        // Such a pane never takes a start: no retry
        const own = ready.argv ?? [];
        const shell = startShellOf(own, platform);
        if (shell === null) throw new AdapterError("agent_pane_unsupported", `pane ${paneId} runs no shell of its own to start an agent in`);
        // fish reads a backslash inside single quotes as an escape: the argument would change
        const front = ready.foreground;
        const frontArgv = front?.argv ?? (front ? [front.name] : []);
        if ([own[0], frontArgv[0]].some((program) => /(?:^|\/)-?fish$/u.test(program ?? "")) && args.some((arg) => arg.includes("\\"))) throw new AdapterError("invalid_params", "fish would read a backslash in an argument differently");
        const agentArgs = program === undefined ? args : [];
        const socket = params["ovis_agent_socket"], tokenFile = params["ovis_agent_token_file"];
        const door = socket !== undefined || tokenFile !== undefined;
        if (door && (platform === "win32" || typeof socket !== "string" || typeof tokenFile !== "string" || !isAbsolute(socket) || !isAbsolute(tokenFile)
          || /[\u0000-\u001f\u007f\\]/.test(socket + tokenFile))) throw new AdapterError("invalid_params", "invalid agent tool paths");
        const line = door ? startLine(shell, "/usr/bin/env", [`OVIS_AGENT_SOCKET=${socket}`, `OVIS_AGENT_TOKEN_FILE=${tokenFile}`, program ?? command, ...agentArgs])
          : startLine(shell, program ?? command, agentArgs);
        // and a plain shell in front now: a program it runs, or one it `exec`ed (same pid, `exec bash -c …` too), would take the line
        if (!ready.pid || front?.pid !== ready.pid || startShellOf(frontArgv, platform) === null) throw new AdapterError("agent_pane_busy", `pane ${paneId} has no idle shell in front`);
        // on Windows the shell is in front whatever it runs: what it runs is below it
        if (platform === "win32") {
          const programs = await running(ready, AGENT_START_MS);
          if (programs === null) throw new AdapterError("agent_pane_busy", `what runs in pane ${paneId} could not be read`);
          if (programs.length > 0) throw new AdapterError("agent_pane_busy", `pane ${paneId} has no idle shell in front`);
        }
        await type(paneId, line);
      });
      // started means the agent itself came up in front (hc samples it about twice a second), or
      // below the shell on Windows: a program or script named for the kind (`claude`,
      // `node …/claude-code/cli.js`, `codex-x86_64-…`, `claude.exe`). Not any program: a shell's
      // command-not-found handler runs in front too, and then the shell is back
      const deadline = Date.now() + AGENT_START_MS;
      let left = false;
      for (;;) {
        // a table that could not be read answers neither way
        const record = await terminal(paneId);
        const programs = await running(record, Math.max(500, deadline - Date.now()));
        if (programs?.length) {
          left = true;
          const installedHermes = kind === "hermes" && platform !== "win32" && isHermesInstalledLauncher(record.foreground?.argv ?? []);
          if (installedHermes || programs.flat().some((part) => part === command || part.startsWith(`${command}-`) || part.startsWith(`${command}.`))) return { type: "agent_started", pane_id: paneId };
        } else if (programs && left) throw new AdapterError("agent_start_failed", `${kind} did not start in pane ${paneId}`);
        if (Date.now() > deadline) throw new AdapterError("agent_start_failed", `${kind} did not come up in pane ${paneId}`);
        await Bun.sleep(100);
      }
    },
    async "pane.send_text"(params) {
      const text = params["text"];
      if (typeof text !== "string") throw new AdapterError("invalid_params", "text is required");
      const paneId = paneIdOf(params);
      await inTurn(paneId, () => type(paneId, text));
      return { type: "ok" };
    },
    async "pane.send_keys"(params) {
      const paneId = paneIdOf(params);
      const keys = Array.isArray(params["keys"]) ? params["keys"].filter((key): key is string => typeof key === "string") : [];
      await inTurn(paneId, async () => {
        // in order: a run of printable characters typed at once, a run of named keys and chords
        // through hc, which encodes them for the program's current keyboard modes
        let typed = "";
        let named: string[] = [];
        const sendRun = async () => {
          if (typed) { await type(paneId, typed); typed = ""; }
          if (named.length > 0) { await hc.call("terminal.keys", { terminal: paneId, keys: named }); named = []; }
        };
        for (const key of keys) {
          const bytes = keyBytes(key);
          if (bytes !== null ? named.length > 0 : typed !== "") await sendRun();
          if (bytes !== null) typed += bytes;
          else named.push(hcKeyName(key));
        }
        await sendRun();
      });
      return { type: "ok" };
    },
    async "agent.prompt"(params) {
      const paneId = paneIdOf(params, "target");
      const text = params["text"];
      if (typeof text !== "string") throw new AdapterError("invalid_params", "text is required");
      await inTurn(paneId, async () => {
        const pane = await paneOf(paneId, "agent_not_found");
        const current = await terminal(paneId, "agent_not_found");
        if (current.labels?.["ovis.acp"] && !acpChildOf(current, options.acp)?.client.terminalReady) {
          throw new AdapterError("acp_prompt_required", "This pane takes prompts through the ACP chat, not terminal input.");
        }
        if (!pane.agent) throw new AdapterError("agent_not_found", `no agent in pane ${paneId}`);
        const force = agyPlanReview(current.status);
        await hc.call("terminal.send", { terminal: paneId, text, ...(force ? { force } : {}) }, 30_000);
      });
      return { type: "ok" };
    },
    // A new workspace or tab is a shell hc starts, labeled into place (LayoutStore `createWorkspace`, `createTab`).
    async "workspace.create"(params) {
      const pane = await layouts.createWorkspace({ name: shellName(params), cwd: cwdOf(params), env: envOf(params), labels: moveLabel(params) });
      return { type: "workspace_created", ...pane };
    },
    async "tab.create"(params) {
      const { tab, root_pane } = await layouts.createTab(paneIdOf(params, "workspace_id"), { name: shellName(params), cwd: cwdOf(params), env: envOf(params), labels: moveLabel(params) });
      return { type: "tab_created", tab, root_pane };
    },
    async "pane.close"(params) {
      await layouts.close({ pane: paneIdOf(params) });
      return { type: "ok" };
    },
    async "tab.close"(params) {
      await layouts.close({ tab: paneIdOf(params, "tab_id") });
      return { type: "ok" };
    },
    async "workspace.close"(params) {
      await layouts.close({ workspace: paneIdOf(params, "workspace_id"), group: params["close_group"] === true });
      return { type: "ok" };
    },
    // A name Ovis gives is a label (LayoutStore `rename`).
    async "workspace.rename"(params) {
      const workspaceId = paneIdOf(params, "workspace_id");
      await layouts.rename({ workspace: workspaceId, name: nameOf(params) });
      return { type: "ok" };
    },
    async "tab.rename"(params) {
      const tabId = paneIdOf(params, "tab_id");
      await layouts.rename({ tab: tabId, name: nameOf(params) });
      return { type: "ok" };
    },
    async "pane.rename"(params) {
      const paneId = paneIdOf(params);
      const name = params["label"];
      if (name !== null && typeof name !== "string") throw new AdapterError("invalid_params", "label must be a string or null");
      await layouts.rename({ pane: paneId, name });
      return { type: "ok" };
    },
    // A split is one more shell and one edit of Ovis's document (LayoutStore `split`). hc has no focus to move: `focus` changes nothing.
    async "pane.split"(params) {
      const paneId = paneIdOf(params, "target_pane_id");
      const direction = params["direction"];
      if (direction !== "right" && direction !== "down") throw new AdapterError("invalid_params", "direction must be right or down");
      // a move from herdr (runtime-move-run.ts) names the folder the new side had there
      const cwd = typeof params["cwd"] === "string" && params["cwd"] !== "" ? params["cwd"] : undefined;
      const made = await layouts.split(paneId, direction, { cwd, labels: moveLabel(params) });
      return { pane: (await snapshot()).panes.find((candidate) => candidate.pane_id === made.pane_id) ?? made };
    },
    async "layout.set_split_ratio"(params) {
      const tabId = paneIdOf(params, "tab_id");
      const path = params["path"];
      const ratio = params["ratio"];
      if (!Array.isArray(path) || !path.every((step) => typeof step === "boolean")) throw new AdapterError("invalid_params", "path must be a list of booleans");
      if (typeof ratio !== "number" || !Number.isFinite(ratio)) throw new AdapterError("invalid_params", "ratio must be a number");
      const { changed } = await layouts.edit(ratioEdit(tabId, path, ratio));
      if (!changed) throw new AdapterError("split_not_found", `tab ${tabId} has no split at that path`);
      return { type: "ok" };
    },
    async "pane.resize"(params) {
      const paneId = paneIdOf(params);
      const direction = paneDirection(params["direction"]);
      const amount = typeof params["amount"] === "number" && Number.isFinite(params["amount"]) ? params["amount"] : RESIZE_STEP;
      const { changed, reason } = await layouts.edit(resizeEdit(paneId, direction, amount));
      return { resize: await outcome(paneId, changed, reason) };
    },
    async "pane.swap"(params) {
      const source = typeof params["source_pane_id"] === "string" ? params["source_pane_id"] : paneIdOf(params);
      const explicit = typeof params["target_pane_id"] === "string" ? params["target_pane_id"] : null;
      const direction = explicit === null ? paneDirection(params["direction"]) : null;
      const { changed, reason, target } = await layouts.edit(swapEdit(source, explicit, direction));
      return { swap: { ...(await outcome(source, changed, reason)), target_pane_id: target } };
    },
    async "pane.zoom"(params) {
      const paneId = paneIdOf(params);
      const mode = params["mode"] ?? "toggle";
      if (mode !== "toggle" && mode !== "on" && mode !== "off") throw new AdapterError("invalid_params", "mode must be toggle, on or off");
      const { changed, reason } = await layouts.edit(zoomEdit(paneId, mode));
      const after = await outcome(paneId, changed, reason);
      return { zoom: { ...after, zoomed: after.layout.zoomed } };
    },
    // Order lives in Ovis's document; Other terminals and a helper's tab follow what they follow
    async "tab.move"(params) {
      const { workspace } = await layouts.moveTab(paneIdOf(params, "tab_id"), params["insert_index"]);
      return { type: "tab_list", tabs: (await snapshot()).tabs.filter((candidate) => candidate.workspace_id === workspace) };
    },
    async "workspace.move"(params) {
      await layouts.moveWorkspace(paneIdOf(params, "workspace_id"), params["insert_index"]);
      return { type: "ok" };
    },
    // A pane goes to a new tab of another workspace by its labels alone (LayoutStore `moveToNewTab`), or
    // beside another pane of its own tab in one edit of the document (moveBesideEdit), where herdr moves
    // only into another tab (client.ts `paneMoveBeside`). `new_tab` and that are the destinations Ovis asks for.
    async "pane.move"(params) {
      const paneId = paneIdOf(params);
      const destination = params["destination"];
      if (isRecord(destination) && destination["type"] === "tab") {
        const targetId = paneIdOf(destination, "target_pane_id");
        const split = destination["split"];
        if (split !== "right" && split !== "down") throw new AdapterError("invalid_params", "split must be right or down");
        const tabId = typeof destination["tab_id"] === "string" ? destination["tab_id"] : undefined;
        const { changed, reason } = await layouts.edit(moveBesideEdit(paneId, tabId, targetId, split));
        const moved = (await snapshot()).panes.find((candidate) => candidate.pane_id === paneId);
        if (!moved) throw new AdapterError("pane_not_found", `pane ${paneId} not found`);
        return { move_result: { changed, reason: changed ? null : reason, pane: moved, closed_tab_id: null, closed_workspace_id: null } };
      }
      if (!isRecord(destination) || destination["type"] !== "new_tab") throw new AdapterError("unsupported", "herdr-core moves a pane only to a new tab or beside a pane of its own tab");
      const workspaceId = paneIdOf(destination, "workspace_id");
      const tabName = typeof destination["label"] === "string" ? destination["label"] : "";
      const pane = await layouts.moveToNewTab(paneId, workspaceId, tabName);
      const after = await snapshot();
      const moved = after.panes.find((candidate) => candidate.pane_id === paneId);
      if (!moved) throw new AdapterError("internal", `hc relabeled ${paneId}, but it is not in the snapshot`);
      return { move_result: {
        pane: moved,
        closed_tab_id: after.tabs.some((tab) => tab.tab_id === pane.tab_id) ? null : pane.tab_id,
        closed_workspace_id: after.workspaces.some((candidate) => candidate.workspace_id === pane.workspace_id) ? null : pane.workspace_id,
      } };
    },
  };

  methods["worktree.list"] = async (params) => {
    const { shown, repository } = await inRepository(paneIdOf(params, "workspace_id"));
    const open = await openWorkspaces(shown, repository);
    return {
      source: { repo_key: repository.repo_key, repo_name: repository.repo_name, repo_root: repository.repo_root, source_checkout_path: repository.checkout, source_workspace_id: open.get(repository.repo_root) ?? null },
      worktrees: repository.checkouts.map((checkout) => infoOf(repository, checkout, open)),
    };
  };
  methods["worktree.create"] = (params) => oneAtATime(async () => {
    if (params["expected_core"] !== undefined && params["expected_core"] !== (await hc.hello()).core.id) {
      throw new AdapterError("worktree_other_core", "The Ovis server serves another core");
    }
    const workspaceId = paneIdOf(params, "workspace_id");
    const branch = textOf(params, "branch");
    if (!branch) throw new AdapterError("invalid_params", "branch is required");
    const base = textOf(params, "base");
    const { shown, repository } = await inRepository(workspaceId);
    if (params["expected_repo"] !== undefined && params["expected_repo"] !== repository.repo_key) {
      throw new AdapterError("worktree_target_changed", "The workspace no longer names the selected repository");
    }
    // as herdr: a worktree starts from the repository's own checkout, which the caller can ask instead
    if (repository.checkout !== repository.repo_root) throw new AdapterError("linked_worktree_source", `workspace ${workspaceId} is on a linked checkout of ${repository.repo_name}`);
    const path = typeof params["path"] === "string" && params["path"] !== "" ? params["path"] : defaultCheckoutPath(repository.repo_name, branch);
    // a repository with no commit has nothing to start from: newer git would make an orphan branch, herdr refuses in git's words
    if (!base && !(await git(repository.repo_root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).ok) throw new AdapterError("worktree_create_failed", "fatal: invalid reference: HEAD");
    // an existing branch is checked out as it is, whatever base was asked (as herdr and the dialog say); a new one starts from `base`, or from HEAD
    const existing = (await git(repository.repo_root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
    const added = await git(repository.repo_root, existing ? ["worktree", "add", "--", path, branch] : ["worktree", "add", "-b", branch, "--", path, ...(base ? [base] : [])]);
    if (!added.ok) throw new AdapterError("worktree_create_failed", added.stderr || `git could not add a worktree at ${path}`);
    const checkout = realPath(path);
    // a checkout no workspace shows is undone, with the branch made for it, so the same name can be asked again
    const opened = await openCheckout(shown, repository, checkout, textOf(params, "label") ?? worktreeFolder(branch)).catch(async (error: unknown) => {
      await git(repository.repo_root, ["worktree", "remove", "--force", "--", checkout]);
      if (!existing) await git(repository.repo_root, ["branch", "-D", "--", branch]);
      throw error;
    });
    const made: Checkout = { path: checkout, branch, is_bare: false, is_detached: false, is_prunable: false };
    return { type: "worktree_created", ...opened, worktree: infoOf(repository, made, new Map([[checkout, opened.workspace.workspace_id]])) };
  });
  methods["worktree.open"] = (params) => oneAtATime(async () => {
    const workspaceId = paneIdOf(params, "workspace_id");
    // a path is taken as git names it, spaces and all
    const path = typeof params["path"] === "string" && params["path"] !== "" ? params["path"] : undefined;
    const branch = textOf(params, "branch");
    if (!path && !branch) throw new AdapterError("invalid_params", "path or branch is required");
    const { shown, repository } = await inRepository(workspaceId);
    const wanted = path ? realPath(path) : null;
    const matches = repository.checkouts.filter((checkout) => (wanted ? checkout.path === wanted : checkout.branch === branch));
    if (matches.length === 0) throw new AdapterError("worktree_not_found", `no checkout of ${repository.repo_name} at ${path ?? branch}`);
    if (matches.length > 1) throw new AdapterError("ambiguous_worktree_branch", `more than one checkout of ${repository.repo_name} has ${branch}`);
    const checkout = matches[0]!;
    const open = await openWorkspaces(shown, repository);
    const already = open.get(checkout.path);
    if (already) {
      const workspace = shown.workspaces.find((candidate) => candidate.workspace_id === already)!;
      const tab = shown.tabs.find((candidate) => candidate.tab_id === workspace.active_tab_id)!;
      const root_pane = shown.panes.find((pane) => pane.tab_id === tab.tab_id)!;
      return { type: "worktree_opened", workspace, tab, root_pane, worktree: infoOf(repository, checkout, open), already_open: true };
    }
    const opened = await openCheckout(shown, repository, checkout.path, textOf(params, "label") ?? (checkout.branch ? worktreeFolder(checkout.branch) : basename(checkout.path)));
    return { type: "worktree_opened", ...opened, worktree: infoOf(repository, checkout, new Map([[checkout.path, opened.workspace.workspace_id]])), already_open: false };
  });
  methods["worktree.remove"] = (params) => oneAtATime(async () => {
    if (params["expected_core"] !== undefined && params["expected_core"] !== (await hc.hello()).core.id) {
      throw new AdapterError("worktree_other_core", "The Ovis server serves another core");
    }
    const workspaceId = paneIdOf(params, "workspace_id");
    const { shown, gitIds, started } = await ownRead();
    const workspace = shown.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
    if (!workspace) throw new AdapterError("workspace_not_found", `workspace ${workspaceId} not found`);
    const facts = workspace.worktree;
    if (!facts?.is_linked_worktree) throw new AdapterError("not_linked_worktree", `workspace ${workspaceId} is not a linked worktree`);
    if ((params["expected_checkout"] !== undefined && params["expected_checkout"] !== facts.checkout_path)
      || (params["expected_repo"] !== undefined && params["expected_repo"] !== facts.repo_key)) {
      throw new AdapterError("worktree_target_changed", "The workspace no longer names the confirmed checkout");
    }
    // only this workspace closes with the checkout: another one open on it, or with a terminal in it
    // (started there or gone there since), would be left in a deleted folder
    const inCheckout = (folder: string | null | undefined): boolean => {
      if (!folder) return false;
      // git names the checkout by its real path; a terminal may have started through a link to it
      const below = relative(facts.checkout_path, realPath(folder));
      return below === "" || (below !== ".." && !below.startsWith(`..${sep}`) && !isAbsolute(below));
    };
    const sharing = shown.workspaces.filter((candidate) => candidate.workspace_id !== workspaceId && (candidate.worktree?.checkout_path === facts.checkout_path
      || shown.panes.some((pane) => pane.workspace_id === candidate.workspace_id && (inCheckout(pane.cwd) || inCheckout(started.get(pane.pane_id))))));
    if (sharing.length > 0) throw new AdapterError("worktree_in_use", `${facts.checkout_path} is also open in ${sharing.map((candidate) => JSON.stringify(candidate.label)).join(", ")}: close ${sharing.length === 1 ? "that workspace" : "those workspaces"} first`);
    // the folder the label names must still be a linked checkout of that repository, not one moved away or replaced by another
    const now = await repositoryOf(facts.checkout_path).catch(() => null);
    let gitId: string | null = null;
    for (const pane of shown.panes.filter((candidate) => candidate.workspace_id === workspaceId)) {
      gitId = labeledWorktree((await terminal(pane.pane_id)).labels)?.gitId ?? null;
      if (gitId) break;
    }
    gitId ??= gitIds.get(workspaceId) ?? null;
    if (params["expected_git_id"] !== undefined && (!now || params["expected_git_id"] !== gitDirIdentity(now.git_dir))) {
      throw new AdapterError("worktree_target_changed", "The confirmed checkout was replaced");
    }
    if (!now || now.repo_key !== facts.repo_key || now.checkout !== facts.checkout_path || now.checkout === now.repo_root || (gitId !== null && gitDirIdentity(now.git_dir) !== gitId)) {
      throw new AdapterError("worktree_not_found", `${facts.checkout_path} is no longer a worktree of ${facts.repo_name}`);
    }
    const force = params["force"] === true;
    // git refuses a checkout with changes before it deletes anything: the workspace stays open then
    const removed = await git(facts.repo_root, ["worktree", "remove", ...(force ? ["--force"] : []), "--", facts.checkout_path]);
    if (!removed.ok) throw new AdapterError(/contains modified or untracked files/u.test(removed.stderr) ? "dirty_worktree_requires_force" : "worktree_remove_failed", removed.stderr || `git could not remove ${facts.checkout_path}`);
    await layouts.end(shown.panes.filter((pane) => pane.workspace_id === workspaceId).map((pane) => pane.pane_id));
    return { type: "worktree_removed", workspace_id: workspaceId, path: facts.checkout_path, forced: force };
  });

  methods["worktree.create_checked"] = methods["worktree.create"];
  methods["worktree.remove_checked"] = methods["worktree.remove"];
  return async (request) => {
    const method = methods[request.method];
    // git runs here, and another machine's checkouts are there
    if (options.otherMachine && request.method.startsWith("worktree.")) return { error: { code: "unsupported", message: "worktrees open only on the PC that runs Ovis" } };
    if (!method) return { error: { code: "unsupported", message: `${request.method} is not available on herdr-core` } };
    try {
      return { result: await method(request.params) };
    } catch (error) {
      if (error instanceof AdapterError || error instanceof WorktreeError) return { error: { code: error.code, message: error.message } };
      if (error instanceof HcError) return { error: { code: herdrCode(error, "pane_not_found"), message: error.message } };
      // what failed is the server's own business: its log has it, the caller a plain reason
      console.error(`herdr-core adapter: ${request.method} failed:`, error);
      return { error: { code: "internal", message: `herdr-core could not answer ${request.method}` } };
    }
  };
}

function paneDirection(value: unknown): PaneDirection {
  if (value !== "left" && value !== "right" && value !== "up" && value !== "down") throw new AdapterError("invalid_params", "direction must be left, right, up or down");
  return value;
}

/** herdr's lifecycle event, and its `type`, for each change of a terminal or the layout. */
const LIFECYCLE = {
  created: ["pane.created", "pane_created"],
  exited: ["pane.exited", "pane_exited"],
  closed: ["pane.closed", "pane_closed"],
  updated: ["pane.updated", "pane_updated"],
  layout: ["layout.updated", "layout_updated"],
} as const;

/**
 * An events subscription: herdr's acknowledgement once hc's own stream is open, so nothing that
 * happens after the server's next snapshot is missed, then herdr's frames for what hc reports. A
 * subscriber that fell behind on hc (`missed`), or a line to hc that ended, ends this connection:
 * the status collector reopens it and reads what it missed from a fresh snapshot.
 */
async function subscribe(hc: HcConnection, socket: Socket<ConnectionState>, request: Request, firstTurn: FirstTurn, host: CoreHost, layoutWatchers: Set<() => void>, observeSeen?: SeenObserver, noteSession?: SessionNote, acp?: AdapterOptions["acp"]): Promise<void> {
  const subscriptions = Array.isArray(request.params["subscriptions"]) ? request.params["subscriptions"].filter(isRecord) : [];
  const statusPanes = new Set(subscriptions.flatMap((entry) => entry["type"] === STATUS_EVENT && typeof entry["pane_id"] === "string" ? [entry["pane_id"]] : []));
  const structure = subscriptions.some((entry) => typeof entry["type"] === "string" && !NOT_STRUCTURE.has(entry["type"]));
  const ack = () => send(socket, `${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
  if (statusPanes.size === 0 && !structure) {
    // focus only: hc has no focus to report, and the connection stays open as herdr's does
    ack();
    return;
  }
  let acknowledged = false;
  const queued: string[] = [];
  let ended = false;
  const emit = (event: string, data: Record<string, unknown>) => {
    const frame = `${JSON.stringify({ event, data })}\n`;
    if (acknowledged) send(socket, frame);
    else queued.push(frame);
  };
  /** Ends the subscription on both sides: hc's stream goes, and what was already written still reaches the reader. */
  const end = () => {
    if (ended) return;
    ended = true;
    socket.data.unsubscribe?.();
    socket.data.unsubscribe = null;
    if (!socket.data.closed) {
      socket.data.ending = true;
      flush(socket);
    }
  };
  const lifecycle = (change: Exclude<CoreChange, { type: "status" }>) => {
    const [event, type] = LIFECYCLE[change.type];
    if (structure) emit(event, { type, ...("terminal" in change && change.terminal ? { pane_id: change.terminal } : {}) });
  };
  const tell = (change: Extract<CoreChange, { type: "status" }>) => {
    if (!acp?.forPane(change.terminal) && statusPanes.has(change.terminal)) emit(STATUS_EVENT, { pane_id: change.terminal, agent_status: change.shown, agent: change.agent });
  };
  const deliver = (changes: readonly CoreChange[]) => {
    for (const change of changes) {
      if (change.type === "status") tell(change);
      else lifecycle(change);
    }
  };
  const model = coreModel({ firstTurn, host, observeSeen, noteSession });
  try {
    const { result, channel } = await openEventStream(hc, {
      event: (event) => { if (!ended) deliver(model.event(event)); },
      resync: end,
      tooLong: () => {
        socket.data.unsubscribe?.();
        send(socket, `${JSON.stringify({ id: request.id, error: { code: "bad_frame", message: `hc event line exceeds ${EVENT_LINE_BYTES} bytes` } })}\n`, true);
      },
    });
    deliver(model.seed(result.terminals));
    // the herdr side went, or hc's stream did (`missed` can come with the answer), before the
    // acknowledgement: nothing is started, and hc's stream goes too
    if (ended || socket.data.closed || socket.data.ending) {
      void channel.close();
      end();
      return;
    }
    // a change hc has no event for (a late git answer): the rows refresh as for a label
    const layoutChanged = () => lifecycle({ type: "layout" });
    const offAcp = acp?.onStatus(child => {
      if (statusPanes.has(child.terminal)) emit(STATUS_EVENT, { pane_id: child.terminal, agent_status: child.client.status, agent: child.client.agentGone ? null : child.harness });
      layoutChanged();
    });
    if (structure) layoutWatchers.add(layoutChanged);
    socket.data.unsubscribe = () => {
      offAcp?.();
      layoutWatchers.delete(layoutChanged);
      void channel.close();
    };
    ack();
    acknowledged = true;
    for (const frame of queued) send(socket, frame);
    queued.length = 0;
  } catch (error) {
    // whatever kept hc's stream from opening, the collector retries as it does for a herdr it cannot reach
    const message = error instanceof HcError ? error.message : "herdr-core could not open its event stream";
    if (!(error instanceof HcError)) console.error("herdr-core adapter: events.subscribe failed:", error);
    send(socket, `${JSON.stringify({ id: request.id, error: { code: "connect_failed", message } })}\n`, true);
  }
}
