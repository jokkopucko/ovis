import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { createConnection } from "node:net";
import type { Socket } from "bun";
import { AGENT_LABELS } from "../agents-routes.ts";
import { LINE_BYTES, makeLineReader } from "../herdr/client.ts";
import { cmdQuote, powershellNativeArgs, SHELL_AGENTS, shellCommandLine } from "../shell-agent.ts";
import { descendantProcesses, type ProcessRow, windowsProcessTable } from "../windows-processes.ts";
import { type HcConnection, HcError } from "./connection.ts";
import { foreignLayout, leaves, neighbour, OVIS_LAYOUT_DOC, type OvisLayout, type PaneDirection, resizeLeaf, setRatio, splitLeaf, swapLeaves, type TabLayout } from "./layout-doc.ts";
import { paneSession, titleStatus } from "../agent-identity.ts";
import { agentInfoOf, agentOf, agentOfStatus, type CoreHost, coreHost, agentStatusOf, foregroundOf, type HcForeground, buildSnapshot, type FirstTurn, keptLayout, opencodeRecords, type SessionOf, reportedFacts, type HcStatus, type HcTerminal, hcKeyName, HERDR_PROTOCOL, isRecord, keyBytes, LAYOUT_DOC, onOtherMachine, OTHER_WORKSPACE_ID, PANE_NAME_LABEL, processInfoOf, SEEN_LABEL, shownStatusOf, SPACE_LABEL, TAB_LABEL, TAB_NAME_LABEL, WORKSPACE_NAME_LABEL } from "./snapshot.ts";
import { checkoutHolding, defaultCheckoutPath, factsOf, git, gitDirIdentity, labeledWorktree, realPath, type Checkout, type Repository, repositoryOf, WORKTREE_LABEL, WorktreeError, worktreeFolder, worktreeLabel } from "./worktrees.ts";
import type { AgentStatus, SessionSnapshot } from "../../shared/herdr-api.generated.ts";
import type { WorktreeInfo } from "../herdr/client.ts";

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
 * - `agent.prompt` as hc's `terminal.send` (paste and Enter, refused while the program is blocked);
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

class AdapterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Ovis's subscription types that are status, not structure. */
const STATUS_EVENT = "pane.agent_status_changed";
const NOT_STRUCTURE = new Set([STATUS_EVENT, "pane.focused", "pane.output_matched"]);
/**
 * What of a status the rows draw beyond its state, as `subscribe` compares reports: the kind and
 * message of a blocked agent, and its progress, which the rows print as its exact percent.
 */
function shownFacts(report: unknown): string {
  if (!isRecord(report) || typeof report["state"] !== "string") return NO_FACTS;
  const facts = reportedFacts({
    state: report["state"],
    ...(typeof report["kind"] === "string" ? { kind: report["kind"] } : {}),
    ...(typeof report["msg"] === "string" ? { msg: report["msg"] } : {}),
    ...(typeof report["progress"] === "number" ? { progress: report["progress"] } : {}),
  });
  return JSON.stringify([facts.agent_kind ?? null, facts.agent_message ?? null, facts.agent_progress ?? null]);
}
const NO_FACTS = JSON.stringify([null, null, null]);
/** A status or layout notification must fit in 4 MiB, even across hc frames. */
const EVENT_LINE_BYTES = 4 * 1024 * 1024;

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
  stop: () => void;
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
  // in every snapshot and status event, so a turn that ended between two snapshots is still one
  const sessions = new Map<string, string[]>();
  const noteSession = (address: string, status: HcStatus | null | undefined, records: unknown): readonly string[] => {
    if (agentOfStatus(status) !== "opencode") { sessions.delete(address); return []; }
    const pending = opencodeRecords(records);
    const named = [...(sessions.get(address) ?? []).filter((id) => !pending.includes(id)), ...pending].slice(-NAMED_SESSIONS);
    sessions.set(address, named);
    return named;
  };
  // the sessions a terminal named and those whose title it shows, decided in agent-identity.ts `paneSession`
  const sessionOf: SessionOf = (terminal) => {
    const named = noteSession(terminal.address, terminal.status, terminal.records);
    const titled = named.length === 0 || !terminal.title || !options.opencodeTitled ? [] : options.opencodeTitled(terminal.title);
    return paneSession(agentOfStatus(terminal.status), { named, titled });
  };
  const forgetTurns = (live: ReadonlySet<string>) => {
    for (const address of firstTurns.keys()) if (!live.has(address)) firstTurns.delete(address);
    for (const address of sessions.keys()) if (!live.has(address)) sessions.delete(address);
  };
  const answers = createAnswers(hc, firstTurn, forgetTurns, options, sessionOf);
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
            if (request.method === "events.subscribe") { void subscribe(hc, socket, request, firstTurn, coreHost(options.otherMachine, options.platform), observeSeen, noteSession); return; }
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
    stop: () => {
      listener.stop(true);
      rmSync(socketPath, { force: true });
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
/** How long a watch-only attach may take to bring its first paint: within the 1.5s a prompt poll gives its colored read. */
const PAINT_MS = 1_000;
/** Any escape sequence: CSI, OSC, a DCS/SOS/PM/APC string, or a short escape (HTS, a charset designation). */
const ESCAPE_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[PX^_][^\u001b]*\u001b\\|[ -/]*[0-~])/g;
const SGR_RE = /^\u001b\[[0-9;:]*m$/;

/**
 * What hc's text read of the screen (`terminal.read`, no history) shows, with its colors, from the
 * first paint of an attach that asked for `rows` lines of history: one line per row with its SGR
 * attributes and no other escape (cursor moves, modes, tab stops, title). hc's read trims the
 * spaces at the end of each row (a U+00A0 stays), drops the screen's blank rows at the bottom and
 * takes as many history lines in at the top, so this does too, but for a space drawn in a color:
 * that one tells input from padding (OpenCode's Tab space), and a text compare trims it anyway. hc paints after a
 * clear (`CSI H CSI 2J`): the history, pushed up by an SGR reset, a line break and one more per
 * screen row, then a second clear and the screen, which ends where the win32-input-mode state
 * follows (herdr-core ghostty-vt `paint`, viewers.rs `first_paint`). null for a paint not shaped
 * so. A row the terminal soft-wrapped stays a line of its own, as on the screen, where hc's text
 * read joins it with the next.
 */
export function paintedScreen(paint: string, rows: number): string | null {
  const end = paint.indexOf(PAINT_END);
  const parts = paint.slice(0, Math.max(end, 0)).split("\u001b[H\u001b[2J");
  if (end === -1 || parts.length < 2 || parts.length > 3) return null;
  const text = (part: string): string => part.replace(ESCAPE_RE, (sequence) => (SGR_RE.test(sequence) ? sequence : ""))
    .replace(/\r\n/g, "\n").replace(/\r/g, "");
  const pushed = "\n".repeat(rows + 1);
  const history = parts.length === 3 ? text(parts[1]!) : "";
  if (history !== "" && !history.endsWith(pushed)) return null;
  const lines = [...(history === "" ? [] : history.slice(0, -pushed.length).split("\n")), ...text(parts.at(-1)!).split("\n")]
    .map(withoutPlainTrailingSpaces);
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

function createAnswers(hc: HcConnection, firstTurn: FirstTurn, forgetTurns: (live: ReadonlySet<string>) => void, options: AdapterOptions, sessionOf?: SessionOf): (request: Request) => Promise<Reply> {
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

  /** herdr's snapshot of the core, and whether Ovis keeps its layout (ownsLayout), from one read of the app's document */
  const read = async (): Promise<{ shown: SessionSnapshot; own: boolean }> => {
    const [list, doc, ovis, hello] = await Promise.all([
      hc.call("terminal.list", {}),
      hc.call("doc.get", { name: LAYOUT_DOC }),
      hc.call("doc.get", { name: OVIS_LAYOUT_DOC }),
      hc.hello(),
    ]);
    forgetTurns(new Set(list.terminals.map((terminal) => terminal.address)));
    return { shown: buildSnapshot(list.terminals, doc.value, hello.version, firstTurn, ovis.value, sessionOf, coreHost(options.otherMachine, platform)), own: ownsLayout(doc.value) };
  };
  const snapshot = async (): Promise<SessionSnapshot> => (await read()).shown;
  /** The snapshot, for a call that changes the layout Ovis keeps in labels: refused where the Herdr app arranges this core. */
  const ownLayout = async (): Promise<SessionSnapshot> => {
    const { shown, own } = await read();
    if (!own) throw new AdapterError("unsupported", "the Herdr app arranges this core's workspaces, tabs and panes");
    return shown;
  };
  const label = async (addresses: string[], labels: Record<string, string>): Promise<void> => {
    await Promise.all(addresses.map((address) => hc.call("terminal.label", { terminal: address, labels })));
  };
  /** A name asked for, as herdr's rename takes it: the workspace-routes refuse an empty one first. */
  const nameOf = (params: Record<string, unknown>): string => {
    const name = params["label"];
    if (typeof name !== "string" || name === "") throw new AdapterError("invalid_params", "label is required");
    return name;
  };

  /**
   * One change to Ovis's layout document: read, edit what the snapshot shows (layout-doc.ts
   * `reconcile`), write back at the version read, read again and redo the edit once if another
   * writer came first. `edit` answers null for no change, and nothing is written. Refused where the
   * Herdr app arranges the core, where hc cannot write a document (its hello names no `doc.set`),
   * and where a newer Ovis wrote it in a schema this one does not know.
   */
  const editLayout = async (edit: (layout: OvisLayout) => OvisLayout | null): Promise<boolean> => {
    if (!layoutCalls(await hc.hello())) throw new AdapterError("unsupported", "this herdr-core keeps no documents Ovis can write");
    for (let attempt = 0; ; attempt++) {
      // the document before the terminals: a list read after it holds every terminal a writer of that version had
      const doc = await hc.call("doc.get", { name: OVIS_LAYOUT_DOC });
      const [list, app] = await Promise.all([hc.call("terminal.list", {}), hc.call("doc.get", { name: LAYOUT_DOC })]);
      if (!ownsLayout(app.value)) throw new AdapterError("unsupported", "the Herdr app arranges this core's workspaces, tabs and panes");
      if (foreignLayout(doc.value)) throw new AdapterError("unsupported", "a newer Ovis keeps this core's layout");
      const next = edit(keptLayout(list.terminals, doc.value));
      if (!next) return false;
      try {
        await hc.call("doc.set", { name: OVIS_LAYOUT_DOC, value: next, version: doc.version });
        return true;
      } catch (error) {
        if (error instanceof HcError && error.kind === "conflict" && attempt === 0) continue;
        throw error;
      }
    }
  };
  /** The kept tab holding the pane, in a layout being edited; refused for a pane in a tab Ovis does not lay out (Other terminals, a helper's). */
  const tabHolding = (layout: OvisLayout, paneId: string): TabLayout => {
    for (const workspace of layout.workspaces) for (const tab of workspace.tabs) if (leaves(tab.root).includes(paneId)) return tab;
    throw new AdapterError("unsupported", `pane ${paneId} is in a tab of its own terminal: it has no splits`);
  };
  /** A layout with one tab's tree or zoom changed. */
  const withTab = (layout: OvisLayout, tabId: string, change: Partial<TabLayout>): OvisLayout => ({
    ...layout,
    workspaces: layout.workspaces.map((workspace) => ({ ...workspace, tabs: workspace.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...change } : tab)) })),
  });
  /** How herdr answers a layout call: the tab's layout after it, and its focused pane. */
  const outcome = async (paneId: string, changed: boolean, reason: string | null) => {
    const shown = await snapshot();
    const tabId = shown.panes.find((pane) => pane.pane_id === paneId)?.tab_id;
    const layout = shown.layouts.find((candidate) => candidate.tab_id === tabId);
    if (!layout) throw new AdapterError("pane_not_found", `pane ${paneId} not found`);
    return { changed, reason: changed ? null : reason, focused_pane_id: layout.focused_pane_id, layout };
  };
  /**
   * herdr's insertion boundary in the list as shown (an index before the item is taken out) as the
   * entry of the document it goes before: the first one at or after the boundary the document orders
   * (not a helper's tab, not Other terminals), null for the end.
   */
  const anchorOf = (shown: readonly string[], id: string, boundary: unknown, ordered: ReadonlySet<string>): string | null => {
    if (typeof boundary !== "number" || !Number.isInteger(boundary) || boundary < 0 || boundary > shown.length) throw new AdapterError("invalid_params", "insert_index is out of range");
    return shown.slice(boundary).find((candidate) => candidate !== id && ordered.has(candidate)) ?? null;
  };
  /** The entry moved before `anchor` (to the end for null), in the order as it is now: another writer's move stays. */
  const moveBefore = <T extends { id: string }>(items: readonly T[], id: string, anchor: string | null): T[] => {
    const item = items.find((candidate) => candidate.id === id)!;
    const rest = items.filter((candidate) => candidate.id !== id);
    const at = anchor === null ? -1 : rest.findIndex((candidate) => candidate.id === anchor);
    rest.splice(at === -1 ? rest.length : at, 0, item);
    return rest;
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
   * PAINT_MS of hc answering the attach, or a stream that ended first.
   */
  const watchedPaint = async (paneId: string, history?: number): Promise<{ paint: string | null; rows: number }> => {
    const record = await terminal(paneId);
    const decoder = new TextDecoder();
    let paint = "";
    const { promise, resolve } = Promise.withResolvers<string | null>();
    const { result, channel } = await hc.open("terminal.attach", { terminal: paneId, cols: record.cols, rows: record.rows, history: history ?? record.rows, observe: true }, {
      onData: (payload) => {
        paint += decoder.decode(payload, { stream: true });
        if (paint.includes(PAINT_END)) resolve(paint);
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
   * paints its reset, which ends in a clear, then the alternate screen first if the program is on it
   * (herdr-core ghostty-vt `paint`). No paint, or an attach hc refused (a kept terminal whose
   * program is lost, whose stored screen hc still reads), counts as the alternate screen.
   */
  const onAlternateScreen = async (paneId: string): Promise<boolean> => {
    const { paint } = await watchedPaint(paneId, 0).catch((error: unknown) => {
      if (error instanceof HcError) return { paint: null };
      throw error;
    });
    if (paint === null) return true;
    const cleared = paint.indexOf("\u001b[H\u001b[2J");
    return cleared === -1 || paint.startsWith("\u001b[?1049h", cleared + "\u001b[H\u001b[2J".length);
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

  /**
   * A shell hc keeps (a lost program comes back as a shell), labeled `labels`, answered as herdr
   * answers a new one: the workspace, tab and pane it shows as in the snapshot right after.
   */
  const startShell = async (params: Record<string, unknown>, labels: Record<string, string>) => {
    const asked = isRecord(params["env"]) ? Object.fromEntries(Object.entries(params["env"]).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : undefined;
    const given = { ...await options.terminalEnv?.(), ...asked };
    const env = Object.keys(given).length > 0 ? given : undefined;
    // a terminal a client starts has had nothing finish yet (herdr-app docs/labels.md)
    const record = await hc.call("terminal.run", { keep: true, labels: { [SEEN_LABEL]: "0", ...labels }, ...(typeof params["cwd"] === "string" ? { cwd: params["cwd"] } : {}), ...(env ? { env } : {}) });
    const shown = await snapshot();
    const root_pane = shown.panes.find((pane) => pane.pane_id === record.address);
    const tab = root_pane && shown.tabs.find((candidate) => candidate.tab_id === root_pane.tab_id);
    const workspace = root_pane && shown.workspaces.find((candidate) => candidate.workspace_id === root_pane.workspace_id);
    if (!root_pane || !tab || !workspace) throw new AdapterError("internal", `hc started ${record.address}, but it is not in the snapshot`);
    return { workspace, tab, root_pane };
  };

  /**
   * Ends each terminal and removes its record, as closing a herdr pane does: all at once (a program
   * can take seconds to end), every one tried before the first failure is answered.
   */
  const end = async (addresses: string[]): Promise<void> => {
    const ended = await Promise.allSettled(addresses.map(async (address) => {
      await hc.call("terminal.kill", { terminal: address });
      await hc.call("terminal.rm", { terminal: address });
    }));
    const failed = ended.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failed) throw failed.reason;
  };

  /** The repository a workspace works in: the checkout its facts name, or its first pane's folder. */
  const inRepository = async (workspaceId: string): Promise<{ shown: SessionSnapshot; repository: Repository }> => {
    // a checkout opens as a workspace Ovis places: refused where the Herdr app arranges the core, as ping says
    const shown = await ownLayout();
    const workspace = shown.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
    if (!workspace) throw new AdapterError("workspace_not_found", `workspace ${workspaceId} not found`);
    const folder = workspace.worktree?.checkout_path ?? shown.panes.find((pane) => pane.workspace_id === workspaceId)?.cwd;
    if (!folder) throw new AdapterError("not_git_worktree", `workspace ${workspaceId} has no folder`);
    return { shown, repository: await repositoryOf(folder) };
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
      const folder = facts ? (facts.repo_key === repository.repo_key ? facts.checkout_path : null) : shown.panes.find((pane) => pane.workspace_id === workspace.workspace_id)?.cwd;
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
    if (head && !shown.workspaces.find((workspace) => workspace.workspace_id === head)?.worktree) {
      await label(shown.panes.filter((pane) => pane.workspace_id === head).map((pane) => pane.pane_id), { [WORKTREE_LABEL]: worktreeLabel(factsOf(repository, repository.repo_root), repository.repo_key) });
    }
    const own = checkout === repository.repo_root ? repository.repo_key : (await repositoryOf(checkout)).git_dir;
    return startShell({ cwd: checkout }, {
      [SPACE_LABEL]: `ovis-${crypto.randomUUID()}`,
      [TAB_LABEL]: `ovis-${crypto.randomUUID()}`,
      [WORKSPACE_NAME_LABEL]: name,
      [WORKTREE_LABEL]: worktreeLabel(factsOf(repository, checkout), own),
    });
  };
  /** The worktree label of a workspace's terminals as written, for a terminal joining it; none for a workspace outside git. */
  const worktreeLabelOf = async (shown: SessionSnapshot, workspaceId: string): Promise<Record<string, string>> => {
    if (!shown.workspaces.find((workspace) => workspace.workspace_id === workspaceId)?.worktree) return {};
    for (const pane of shown.panes.filter((candidate) => candidate.workspace_id === workspaceId)) {
      const raw = (await terminal(pane.pane_id)).labels?.[WORKTREE_LABEL];
      if (labeledWorktree({ [WORKTREE_LABEL]: raw ?? "" })) return { [WORKTREE_LABEL]: raw! };
    }
    return {};
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
      return { type: "pane_process_info", process_info: processInfoOf(found) };
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
        const line = startLine(shell, command, args);
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
        const programs = await running(await terminal(paneId), Math.max(500, deadline - Date.now()));
        if (programs?.length) {
          left = true;
          if (programs.flat().some((part) => part === command || part.startsWith(`${command}-`) || part.startsWith(`${command}.`))) return { type: "agent_started", pane_id: paneId };
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
      if (!(await paneOf(paneId, "agent_not_found")).agent) throw new AdapterError("agent_not_found", `no agent in pane ${paneId}`);
      await inTurn(paneId, () => hc.call("terminal.send", { terminal: paneId, text }, 30_000));
      return { type: "ok" };
    },
    // A new workspace or tab is a shell hc starts, labeled with its space and tab as the Herdr app
    // labels its own: the app adopts it there (herdr-app src/window.rs `reconcile`), and until
    // then, or without the app, the snapshot groups it by those labels (snapshot.ts `groups`).
    // Names live in the app's document, which Ovis never writes: a name given here is a label.
    async "workspace.create"(params) {
      const spaceId = `ovis-${crypto.randomUUID()}`;
      const label: Record<string, string> = typeof params["label"] === "string" && params["label"] ? { [WORKSPACE_NAME_LABEL]: params["label"] } : {};
      const pane = await startShell(params, { [SPACE_LABEL]: spaceId, [TAB_LABEL]: `ovis-${crypto.randomUUID()}`, ...label, ...moveLabel(params) });
      return { type: "workspace_created", ...pane };
    },
    async "tab.create"(params) {
      const workspaceId = paneIdOf(params, "workspace_id");
      const shown = await snapshot();
      const workspace = shown.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
      if (!workspace && workspaceId !== OTHER_WORKSPACE_ID) throw new AdapterError("workspace_not_found", `workspace ${workspaceId} not found`);
      // a tab in a workspace starts where that workspace's first pane works, as herdr's does
      const cwd = typeof params["cwd"] === "string" ? params["cwd"] : shown.panes.find((pane) => pane.workspace_id === workspaceId)?.cwd ?? undefined;
      const label: Record<string, string> = typeof params["label"] === "string" && params["label"] ? { [TAB_NAME_LABEL]: params["label"] } : {};
      // "Other terminals" is no space of the app's: a tab there is a terminal of its own
      // with the workspace's name, which stays when the tab the name was given in closes (snapshot.ts `groups`)
      const space: Record<string, string> = workspaceId === OTHER_WORKSPACE_ID ? {} : { [SPACE_LABEL]: workspaceId, [TAB_LABEL]: `ovis-${crypto.randomUUID()}`, [WORKSPACE_NAME_LABEL]: workspace!.label, ...(await worktreeLabelOf(shown, workspaceId)) };
      const { tab, root_pane } = await startShell({ ...params, ...(cwd ? { cwd } : {}) }, { ...space, ...label, ...moveLabel(params) });
      return { type: "tab_created", tab, root_pane };
    },
    async "pane.close"(params) {
      await end([await paneOf(paneIdOf(params))].map((pane) => pane.pane_id));
      return { type: "ok" };
    },
    async "tab.close"(params) {
      const tabId = paneIdOf(params, "tab_id");
      const panes = (await snapshot()).panes.filter((pane) => pane.tab_id === tabId);
      if (panes.length === 0) throw new AdapterError("tab_not_found", `tab ${tabId} not found`);
      await end(panes.map((pane) => pane.pane_id));
      return { type: "ok" };
    },
    async "workspace.close"(params) {
      const workspaceId = paneIdOf(params, "workspace_id");
      // "Other terminals" is no workspace anyone made: its jobs and agents' workers close one by one
      if (workspaceId === OTHER_WORKSPACE_ID) throw new AdapterError("unsupported", "Other terminals holds terminals no workspace made: close them one by one");
      const shown = await snapshot();
      const panes = shown.panes.filter((pane) => pane.workspace_id === workspaceId);
      if (panes.length === 0) throw new AdapterError("workspace_not_found", `workspace ${workspaceId} not found`);
      // as herdr: a repository's workspace closes over its open worktrees only when the group is meant
      const facts = shown.workspaces.find((candidate) => candidate.workspace_id === workspaceId)?.worktree;
      const group = facts && !facts.is_linked_worktree ? shown.workspaces.filter((candidate) => candidate.worktree?.is_linked_worktree && candidate.worktree.repo_key === facts.repo_key).map((candidate) => candidate.workspace_id) : [];
      if (group.length > 0 && params["close_group"] !== true) throw new AdapterError("workspace_group_close_required", `workspace ${workspaceId} has open worktree workspaces: close the group`);
      await end([...panes, ...shown.panes.filter((pane) => group.includes(pane.workspace_id))].map((pane) => pane.pane_id));
      return { type: "ok" };
    },
    // A name Ovis gives is a label on each of the workspace's or tab's terminals, so it stays when
    // the first one closes (snapshot.ts `groups` names a group by its first terminal).
    async "workspace.rename"(params) {
      const workspaceId = paneIdOf(params, "workspace_id");
      const name = nameOf(params);
      if (workspaceId === OTHER_WORKSPACE_ID) throw new AdapterError("unsupported", "Other terminals holds terminals no workspace made: it has no name to change");
      const panes = (await ownLayout()).panes.filter((pane) => pane.workspace_id === workspaceId);
      if (panes.length === 0) throw new AdapterError("workspace_not_found", `workspace ${workspaceId} not found`);
      await label(panes.map((pane) => pane.pane_id), { [WORKSPACE_NAME_LABEL]: name });
      return { type: "ok" };
    },
    async "tab.rename"(params) {
      const tabId = paneIdOf(params, "tab_id");
      const name = nameOf(params);
      const panes = (await ownLayout()).panes.filter((pane) => pane.tab_id === tabId);
      if (panes.length === 0) throw new AdapterError("tab_not_found", `tab ${tabId} not found`);
      await label(panes.map((pane) => pane.pane_id), { [TAB_NAME_LABEL]: name });
      return { type: "ok" };
    },
    async "pane.rename"(params) {
      const paneId = paneIdOf(params);
      const name = params["label"];
      if (name !== null && typeof name !== "string") throw new AdapterError("invalid_params", "label must be a string or null");
      if (!(await ownLayout()).panes.some((pane) => pane.pane_id === paneId)) throw new AdapterError("pane_not_found", `pane ${paneId} not found`);
      // `key: ""` takes a label off (hc terminal.label): the terminal's own name shows again
      await label([paneId], { [PANE_NAME_LABEL]: name ?? "" });
      return { type: "ok" };
    },
    // A split is one more shell labeled with the pane's workspace and tab, then the pane's leaf in
    // Ovis's document turned into a split holding both. hc has no focus to move: `focus` changes nothing.
    async "pane.split"(params) {
      const paneId = paneIdOf(params, "target_pane_id");
      const direction = params["direction"];
      if (direction !== "right" && direction !== "down") throw new AdapterError("invalid_params", "direction must be right or down");
      const shown = await ownLayout();
      const pane = shown.panes.find((candidate) => candidate.pane_id === paneId);
      if (!pane) throw new AdapterError("pane_not_found", `pane ${paneId} not found`);
      const labels = (await terminal(paneId)).labels ?? {};
      // only a tab its labels make takes another pane: one in Other terminals, or a helper's under its parent's tab, is one terminal's own
      if (labels[SPACE_LABEL] !== pane.workspace_id || labels[TAB_LABEL] !== pane.tab_id) throw new AdapterError("unsupported", `pane ${paneId} is in a tab of its own terminal: it does not split`);
      if (!layoutCalls(await hc.hello())) throw new AdapterError("unsupported", "this herdr-core keeps no documents Ovis can write");
      // no shell for a split the document cannot hold
      if (foreignLayout((await hc.call("doc.get", { name: OVIS_LAYOUT_DOC })).value)) throw new AdapterError("unsupported", "a newer Ovis keeps this core's layout");
      // the workspace's name as shown, and the tab's own where it has one, stay when the split pane closes
      const workspaceName = shown.workspaces.find((candidate) => candidate.workspace_id === pane.workspace_id)?.label;
      const names = { ...(workspaceName ? { [WORKSPACE_NAME_LABEL]: workspaceName } : {}), ...(labels[TAB_NAME_LABEL] ? { [TAB_NAME_LABEL]: labels[TAB_NAME_LABEL] } : {}), ...(labels[WORKTREE_LABEL] ? { [WORKTREE_LABEL]: labels[WORKTREE_LABEL] } : {}) };
      // a move from herdr (runtime-move-run.ts) names the folder the new side had there
      const cwd = typeof params["cwd"] === "string" && params["cwd"] !== "" ? params["cwd"] : startFolder(pane.cwd ?? undefined);
      const { root_pane } = await startShell({ ...(cwd ? { cwd } : {}) }, { [SPACE_LABEL]: pane.workspace_id, [TAB_LABEL]: pane.tab_id, ...names, ...moveLabel(params) });
      try {
        await editLayout((layout) => {
          const tab = tabHolding(layout, paneId);
          const root = splitLeaf(tab.root, paneId, root_pane.pane_id, direction);
          // a zoomed tab shows every pane again, so the new one is in view
          return root && withTab(layout, tab.id, { root, zoomed: null });
        });
      } catch (error) {
        // the shell runs and shows to the right of the tab (layout-doc.ts `reconcile`): said, so nobody splits again for it
        const reason = error instanceof AdapterError || error instanceof HcError ? error.message : String(error);
        throw new AdapterError("layout_not_saved", `pane ${root_pane.pane_id} started, but could not be placed ${direction === "right" ? "right of" : "below"} ${paneId} (${reason}); it shows at the right of the tab`);
      }
      return { pane: (await snapshot()).panes.find((candidate) => candidate.pane_id === root_pane.pane_id) ?? root_pane };
    },
    async "layout.set_split_ratio"(params) {
      const tabId = paneIdOf(params, "tab_id");
      const path = params["path"];
      const ratio = params["ratio"];
      if (!Array.isArray(path) || !path.every((step) => typeof step === "boolean")) throw new AdapterError("invalid_params", "path must be a list of booleans");
      if (typeof ratio !== "number" || !Number.isFinite(ratio)) throw new AdapterError("invalid_params", "ratio must be a number");
      let found = false;
      await editLayout((layout) => {
        const tab = layout.workspaces.flatMap((workspace) => workspace.tabs).find((candidate) => candidate.id === tabId);
        const root = tab && setRatio(tab.root, path, ratio);
        found = Boolean(root);
        return root ? withTab(layout, tabId, { root }) : null;
      });
      if (!found) throw new AdapterError("split_not_found", `tab ${tabId} has no split at that path`);
      return { type: "ok" };
    },
    async "pane.resize"(params) {
      const paneId = paneIdOf(params);
      const direction = paneDirection(params["direction"]);
      const amount = typeof params["amount"] === "number" && Number.isFinite(params["amount"]) ? params["amount"] : 0.05;
      const changed = await editLayout((layout) => {
        const tab = tabHolding(layout, paneId);
        const root = resizeLeaf(tab.root, paneId, direction, amount);
        return root && withTab(layout, tab.id, { root });
      });
      return { resize: await outcome(paneId, changed, "unchanged") };
    },
    async "pane.swap"(params) {
      const source = typeof params["source_pane_id"] === "string" ? params["source_pane_id"] : paneIdOf(params);
      const explicit = typeof params["target_pane_id"] === "string" ? params["target_pane_id"] : null;
      const direction = explicit === null ? paneDirection(params["direction"]) : null;
      let target: string | null = explicit;
      let reason: string | null = null;
      const changed = await editLayout((layout) => {
        const tab = tabHolding(layout, source);
        if (direction) target = neighbour(tab.root, source, direction);
        if (target === null) { reason = "no_neighbor"; return null; }
        if (target === source) { reason = "same_pane"; return null; }
        if (!leaves(tab.root).includes(target)) { reason = "cross_tab"; return null; }
        return withTab(layout, tab.id, { root: swapLeaves(tab.root, source, target) });
      });
      return { swap: { ...(await outcome(source, changed, reason)), target_pane_id: target } };
    },
    async "pane.zoom"(params) {
      const paneId = paneIdOf(params);
      const mode = params["mode"] ?? "toggle";
      if (mode !== "toggle" && mode !== "on" && mode !== "off") throw new AdapterError("invalid_params", "mode must be toggle, on or off");
      let reason: string | null = null;
      const changed = await editLayout((layout) => {
        const tab = tabHolding(layout, paneId);
        if (leaves(tab.root).length < 2) { reason = "single_pane"; return null; }
        const on = mode === "toggle" ? tab.zoomed === null : mode === "on";
        if (on && tab.zoomed === paneId) { reason = "already_zoomed"; return null; }
        if (!on && tab.zoomed === null) { reason = "already_unzoomed"; return null; }
        return withTab(layout, tab.id, { zoomed: on ? paneId : null });
      });
      const after = await outcome(paneId, changed, reason);
      return { zoom: { ...after, zoomed: after.layout.zoomed } };
    },
    // Order lives in Ovis's document; Other terminals and a helper's tab follow what they follow
    async "tab.move"(params) {
      const tabId = paneIdOf(params, "tab_id");
      const shown = await ownLayout();
      const tab = shown.tabs.find((candidate) => candidate.tab_id === tabId);
      if (!tab) throw new AdapterError("tab_not_found", `tab ${tabId} not found`);
      const siblings = shown.tabs.filter((candidate) => candidate.workspace_id === tab.workspace_id).map((candidate) => candidate.tab_id);
      await editLayout((layout) => {
        const workspace = layout.workspaces.find((candidate) => candidate.id === tab.workspace_id);
        if (!workspace?.tabs.some((candidate) => candidate.id === tabId)) throw new AdapterError("unsupported", `tab ${tabId} follows the terminal that started it: it has no place of its own`);
        const anchor = anchorOf(siblings, tabId, params["insert_index"], new Set(workspace.tabs.map((candidate) => candidate.id)));
        return { ...layout, workspaces: layout.workspaces.map((candidate) => (candidate === workspace ? { ...candidate, tabs: moveBefore(candidate.tabs, tabId, anchor) } : candidate)) };
      });
      return { type: "tab_list", tabs: (await snapshot()).tabs.filter((candidate) => candidate.workspace_id === tab.workspace_id) };
    },
    async "workspace.move"(params) {
      const workspaceId = paneIdOf(params, "workspace_id");
      if (workspaceId === OTHER_WORKSPACE_ID) throw new AdapterError("unsupported", "Other terminals stays last");
      const shown = await ownLayout();
      if (!shown.workspaces.some((candidate) => candidate.workspace_id === workspaceId)) throw new AdapterError("workspace_not_found", `workspace ${workspaceId} not found`);
      const listed = shown.workspaces.map((candidate) => candidate.workspace_id);
      await editLayout((layout) => {
        if (!layout.workspaces.some((candidate) => candidate.id === workspaceId)) throw new AdapterError("unsupported", `workspace ${workspaceId} holds no tab Ovis places`);
        const anchor = anchorOf(listed, workspaceId, params["insert_index"], new Set(layout.workspaces.map((candidate) => candidate.id)));
        return { ...layout, workspaces: moveBefore(layout.workspaces, workspaceId, anchor) };
      });
      return { type: "ok" };
    },
    // A pane goes to a new tab of another workspace by its labels alone: its terminal, its program and
    // its id stay. It takes that workspace's name with it, so it never renames the workspace by
    // becoming its first terminal. Beside another pane of its own tab it moves in one edit of the
    // document, where herdr moves only into another tab (client.ts `paneMoveBeside`): its leaf leaves
    // the tree and the target's becomes a split holding both, as a split makes it. `new_tab` and
    // that are the destinations Ovis asks for.
    async "pane.move"(params) {
      const paneId = paneIdOf(params);
      const destination = params["destination"];
      if (isRecord(destination) && destination["type"] === "tab") {
        const targetId = paneIdOf(destination, "target_pane_id");
        const split = destination["split"];
        if (split !== "right" && split !== "down") throw new AdapterError("invalid_params", "split must be right or down");
        let reason: string | null = null;
        const changed = await editLayout((layout) => {
          const tab = tabHolding(layout, paneId);
          if (tab.id !== destination["tab_id"]) throw new AdapterError("unsupported", "herdr-core moves a pane into a tab only beside a pane of its own tab");
          if (!leaves(tab.root).includes(targetId)) throw new AdapterError("pane_not_found", `pane ${targetId} not found in tab ${tab.id}`);
          if (targetId === paneId) { reason = "same_pane"; return null; }
          const root = splitLeaf(tab.root, targetId, paneId, split);
          // a zoomed tab shows every pane again, so the moved one is in view
          return root && withTab(layout, tab.id, { root, zoomed: null });
        });
        const moved = (await snapshot()).panes.find((candidate) => candidate.pane_id === paneId);
        if (!moved) throw new AdapterError("pane_not_found", `pane ${paneId} not found`);
        return { move_result: { changed, reason: changed ? null : reason, pane: moved, closed_tab_id: null, closed_workspace_id: null } };
      }
      if (!isRecord(destination) || destination["type"] !== "new_tab") throw new AdapterError("unsupported", "herdr-core moves a pane only to a new tab or beside a pane of its own tab");
      const workspaceId = paneIdOf(destination, "workspace_id");
      const before = await ownLayout();
      const pane = before.panes.find((candidate) => candidate.pane_id === paneId);
      if (!pane) throw new AdapterError("pane_not_found", `pane ${paneId} not found`);
      const workspace = before.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
      if (!workspace && workspaceId !== OTHER_WORKSPACE_ID) throw new AdapterError("workspace_not_found", `workspace ${workspaceId} not found`);
      // a helper with no labels shows under its parent's tab (snapshot.ts `groups`), never in Other terminals
      const parent = workspaceId === OTHER_WORKSPACE_ID ? (await terminal(paneId)).parent : undefined;
      if (parent && parent !== paneId && before.panes.some((candidate) => candidate.pane_id === parent)) throw new AdapterError("unsupported", `pane ${paneId} shows under the terminal that started it: it cannot go to Other terminals`);
      const tabName = typeof destination["label"] === "string" ? destination["label"] : "";
      // `key: ""` takes a label off (hc terminal.label)
      const place = workspaceId === OTHER_WORKSPACE_ID
        ? { [SPACE_LABEL]: "", [TAB_LABEL]: "", [WORKSPACE_NAME_LABEL]: "", [WORKTREE_LABEL]: "" }
        : { [SPACE_LABEL]: workspaceId, [TAB_LABEL]: `ovis-${crypto.randomUUID()}`, [WORKSPACE_NAME_LABEL]: workspace!.label, [WORKTREE_LABEL]: "", ...(await worktreeLabelOf(before, workspaceId)) };
      await label([paneId], { ...place, [TAB_NAME_LABEL]: tabName });
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
    const workspaceId = paneIdOf(params, "workspace_id");
    const branch = textOf(params, "branch");
    if (!branch) throw new AdapterError("invalid_params", "branch is required");
    const base = textOf(params, "base");
    const { shown, repository } = await inRepository(workspaceId);
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
    const workspaceId = paneIdOf(params, "workspace_id");
    const shown = await ownLayout();
    const workspace = shown.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
    if (!workspace) throw new AdapterError("workspace_not_found", `workspace ${workspaceId} not found`);
    const facts = workspace.worktree;
    if (!facts?.is_linked_worktree) throw new AdapterError("not_linked_worktree", `workspace ${workspaceId} is not a linked worktree`);
    // the folder the label names must still be a linked checkout of that repository, not one moved away or replaced by another
    const now = await repositoryOf(facts.checkout_path).catch(() => null);
    let gitId: string | null = null;
    for (const pane of shown.panes.filter((candidate) => candidate.workspace_id === workspaceId)) {
      gitId = labeledWorktree((await terminal(pane.pane_id)).labels)?.gitId ?? null;
      if (gitId) break;
    }
    if (!now || now.repo_key !== facts.repo_key || now.checkout !== facts.checkout_path || now.checkout === now.repo_root || (gitId !== null && gitDirIdentity(now.git_dir) !== gitId)) {
      throw new AdapterError("worktree_not_found", `${facts.checkout_path} is no longer a worktree of ${facts.repo_name}`);
    }
    const force = params["force"] === true;
    // git refuses a checkout with changes before it deletes anything: the workspace stays open then
    const removed = await git(facts.repo_root, ["worktree", "remove", ...(force ? ["--force"] : []), "--", facts.checkout_path]);
    if (!removed.ok) throw new AdapterError(/contains modified or untracked files/u.test(removed.stderr) ? "dirty_worktree_requires_force" : "worktree_remove_failed", removed.stderr || `git could not remove ${facts.checkout_path}`);
    await end(shown.panes.filter((pane) => pane.workspace_id === workspaceId).map((pane) => pane.pane_id));
    return { type: "worktree_removed", workspace_id: workspaceId, path: facts.checkout_path, forced: force };
  });

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

/**
 * Whether Ovis keeps this core's workspace and tab names and places in labels: only where no Herdr app
 * arranges them, its `herdr-app` document never written (or deleted: hc keeps a null value).
 */
function ownsLayout(doc: unknown): boolean {
  return doc === null || doc === undefined;
}

/** Whether this core writes documents, by what its hello names (never its version): Ovis's layout needs `doc.set`. */
function layoutCalls(hello: { methods: readonly string[] }): boolean {
  return hello.methods.includes("doc.set");
}

function paneDirection(value: unknown): PaneDirection {
  if (value !== "left" && value !== "right" && value !== "up" && value !== "down") throw new AdapterError("invalid_params", "direction must be left, right, up or down");
  return value;
}

/** One hc event notification (herdr-core schema/README.md, Events). */
/** `machine`: the other machine an event is about (a `doc` there names no terminal); none for this core's own */
interface HcEvent { type: string; terminal?: string; machine?: string; data?: Record<string, unknown> }

/** A status report as hc sends it in a record or a `status` event; null when it is none. */
function statusOf(reported: unknown): HcStatus | null {
  return isRecord(reported) && typeof reported["state"] === "string"
    ? { state: reported["state"], ...(typeof reported["app"] === "string" ? { app: reported["app"] } : {}) }
    : null;
}

/** A terminal's labels as hc sends them, its string values only. */
function labelsOf(labels: unknown): Record<string, string> {
  if (!isRecord(labels)) return {};
  return Object.fromEntries(Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/**
 * An events subscription: herdr's acknowledgement once hc's own stream is open, so nothing that
 * happens after the server's next snapshot is missed, then herdr's frames for what hc reports. A
 * subscriber that fell behind on hc (`missed`), or a line to hc that ended, ends this connection:
 * the status collector reopens it and reads what it missed from a fresh snapshot.
 */
/** What an event says of a terminal's OpenCode session (startHerdrCoreAdapter `noteSession`), so a turn too short for any read is still remembered. */
type SessionNote = (address: string, status: HcStatus | null | undefined, records: unknown) => unknown;

async function subscribe(hc: HcConnection, socket: Socket<ConnectionState>, request: Request, firstTurn: FirstTurn, host: CoreHost, observeSeen?: SeenObserver, noteSession?: SessionNote): Promise<void> {
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
  const lifecycle = (event: string, type: string, paneId?: string) => {
    if (structure) emit(event, { type, ...(paneId ? { pane_id: paneId } : {}) });
  };
  /**
   * What each terminal's status is shown from, as the snapshot shows it (snapshot.ts
   * `shownStatusOf`): its program's word, its turn and its labels, from hc's snapshot and then its
   * events, with the status last told. Until hc's snapshot is in, events wait in `early`.
   */
  type Known = { status: HcStatus | null; front: HcForeground | null; cwd: string | undefined; argv: string[] | undefined; pid: number | null; title: string | null; turn: number; first: number; labels: Record<string, string>; shown: AgentStatus };
  const known = new Map<string, Known>();
  /** the agent a terminal runs, read as the snapshot reads it (snapshot.ts `agentOf`) */
  const agentNow = (status: HcStatus | null, entry: Known | undefined) => agentOf({ status, foreground: entry?.front ?? null, cwd: entry?.cwd, argv: entry?.argv, pid: entry?.pid }, host);
  let early: HcEvent[] | null = [];
  const remember = (record: unknown) => {
    if (!isRecord(record) || typeof record["address"] !== "string") return;
    const status = statusOf(record["status"]);
    const turn = typeof record["turn"] === "number" ? record["turn"] : 0;
    const labels = labelsOf(record["labels"]);
    const first = firstTurn({ address: record["address"], turn });
    noteSession?.(record["address"], status, record["records"]);
    known.set(record["address"], { status, front: foregroundOf(record["foreground"]), cwd: typeof record["cwd"] === "string" ? record["cwd"] : undefined, argv: Array.isArray(record["argv"]) && record["argv"].every((word) => typeof word === "string") ? record["argv"] : undefined, pid: typeof record["pid"] === "number" ? record["pid"] : null, title: typeof record["title"] === "string" ? record["title"] : null, turn, first, labels, shown: shownStatusOf(status, turn, labels, first) });
    observeSeen?.(record["address"], turn, labels);
  };
  const tell = (paneId: string, status: HcStatus | null, shown: AgentStatus) => {
    const entry = known.get(paneId);
    emit(STATUS_EVENT, { pane_id: paneId, agent_status: shown, agent: agentNow(status, entry) });
  };
  /** A turn or a look (the `herdr.seen` label) that changes what a terminal shows is told as its status. */
  const retell = (paneId: string) => {
    const entry = known.get(paneId);
    if (!entry) return;
    const shown = shownStatusOf(entry.status, entry.turn, entry.labels, entry.first);
    if (shown === entry.shown) return;
    entry.shown = shown;
    if (statusPanes.has(paneId)) tell(paneId, entry.status, shown);
  };
  /** what each terminal's last report said beyond its state (kind, message, progress), which only a snapshot carries */
  const reported = new Map<string, string>();
  const onEvent = (event: HcEvent) => {
    // another machine's terminal is none of this PC's panes (snapshot.ts `onOtherMachine`)
    if (event.machine !== undefined || (event.terminal !== undefined && onOtherMachine(event.terminal))) return;
    if (early) { early.push(event); return; }
    const paneId = event.terminal;
    switch (event.type) {
      case "status": {
        if (!paneId) return;
        const report = event.data?.["status"];
        // a new kind, message or progress step (or one gone) reaches the rows through a fresh snapshot
        const facts = shownFacts(report);
        const before = reported.get(paneId) ?? NO_FACTS;
        reported.set(paneId, facts);
        if (facts !== before) lifecycle("pane.updated", "pane_updated", paneId);
        const status = statusOf(report);
        noteSession?.(paneId, status, event.data?.["records"]);
        const entry = known.get(paneId);
        if (!entry) {
          if (statusPanes.has(paneId)) tell(paneId, status, agentStatusOf(status));
          return;
        }
        const was = entry.status?.state;
        entry.status = status;
        const shown = shownStatusOf(status, entry.turn, entry.labels, entry.first);
        // a turn ends with this status, then the `turn` event that counts it: whether it is done
        // is decided there (herdr-app docs/labels.md)
        if (was === "working" && (shown === "idle" || shown === "done")) return;
        entry.shown = shown;
        if (statusPanes.has(paneId)) tell(paneId, status, shown);
        return;
      }
      case "turn": {
        const entry = paneId ? known.get(paneId) : undefined;
        if (!entry || typeof event.data?.["turn"] !== "number") return;
        entry.turn = event.data["turn"];
        observeSeen?.(paneId!, entry.turn, entry.labels);
        retell(paneId!);
        return;
      }
      case "created":
        remember(event.data);
        lifecycle("pane.created", "pane_created", paneId);
        return;
      case "finished":
        // herdr says pane_exited only for a program that ended by itself; a pane someone closed is
        // pane_closed alone, so it raises no "terminal ended" alert. hc's `killed` is a
        // terminal.kill (the Herdr app closing a tab, Ovis's pane.close, `hc kill`); a signal sent
        // from anywhere else finishes as `exited`
        if (event.data?.["reason"] !== "killed") lifecycle("pane.exited", "pane_exited", paneId);
        lifecycle("pane.closed", "pane_closed", paneId);
        return;
      case "removed":
        if (paneId) { known.delete(paneId); reported.delete(paneId); }
        lifecycle("pane.closed", "pane_closed", paneId);
        return;
      case "lost":
      case "restarted":
        lifecycle("pane.updated", "pane_updated", paneId);
        return;
      case "labels": {
        const entry = paneId ? known.get(paneId) : undefined;
        if (entry) {
          entry.labels = labelsOf(event.data?.["labels"]);
          observeSeen?.(paneId!, entry.turn, entry.labels);
          retell(paneId!);
        }
        lifecycle("layout.updated", "layout_updated");
        return;
      }
      case "foreground": {
        // a program that reports nothing is named from the process in front of it (snapshot.ts `agentOf`)
        const entry = paneId ? known.get(paneId) : undefined;
        if (!entry) return;
        const before = agentNow(entry.status, entry);
        entry.front = foregroundOf(event.data);
        if (agentNow(entry.status, entry) === before) return;
        lifecycle("pane.updated", "pane_updated", paneId);
        if (statusPanes.has(paneId!)) tell(paneId!, entry.status, entry.shown);
        return;
      }
      case "title": {
        // an agent that reports nothing may say in its own title whether it works (agent-identity.ts `titleStatus`):
        // a change there reaches the rows through a fresh snapshot; any other title shows in the next one
        const entry = paneId ? known.get(paneId) : undefined;
        if (!entry) return;
        const title = typeof event.data?.["title"] === "string" ? event.data["title"] : null;
        // only where no report gives a status: none, or a word that says nothing (an error)
        const agent = agentStatusOf(entry.status) === "unknown" ? agentNow(entry.status, entry) : null;
        const before = titleStatus(agent, entry.title);
        entry.title = title;
        if (titleStatus(agent, title) !== before) lifecycle("pane.updated", "pane_updated", paneId);
        return;
      }
      case "doc":
        if (event.data?.["name"] === LAYOUT_DOC || event.data?.["name"] === OVIS_LAYOUT_DOC) lifecycle("layout.updated", "layout_updated");
        return;
      default:
        // size changes many times a second and shows in the next snapshot
        return;
    }
  };
  const read = makeLineReader(EVENT_LINE_BYTES, (line) => {
    if (ended) return;
    let message: unknown;
    try { message = JSON.parse(line); } catch { end(); return; }
    if (!isRecord(message)) return;
    if (message["method"] === "missed") { end(); return; }
    const params = message["params"];
    if (message["method"] !== "event" || !isRecord(params) || typeof params["type"] !== "string") return;
    onEvent({ type: params["type"], ...(typeof params["terminal"] === "string" ? { terminal: params["terminal"] } : {}), ...(typeof params["machine"] === "string" ? { machine: params["machine"] } : {}), ...(isRecord(params["data"]) ? { data: params["data"] } : {}) });
  }, () => {
    socket.data.unsubscribe?.();
    send(socket, `${JSON.stringify({ id: request.id, error: { code: "bad_frame", message: `hc event line exceeds ${EVENT_LINE_BYTES} bytes` } })}\n`, true);
  });
  try {
    const { result, channel } = await hc.open("events.subscribe", {}, { onData: read, onClose: end });
    // what each terminal reported as the stream starts: a first event that drops a message or progress is a change
    const here = (Array.isArray(result.terminals) ? result.terminals : []).filter((terminal) => !isRecord(terminal) || typeof terminal["address"] !== "string" || !onOtherMachine(terminal["address"]));
    for (const terminal of here) {
      if (!isRecord(terminal) || typeof terminal["address"] !== "string" || reported.has(terminal["address"])) continue;
      reported.set(terminal["address"], shownFacts(terminal["status"]));
    }
    for (const record of here) remember(record);
    const waiting = early ?? [];
    early = null;
    for (const event of waiting) onEvent(event);
    // the herdr side went, or hc's stream did (`missed` can come with the answer), before the
    // acknowledgement: nothing is started, and hc's stream goes too
    if (ended || socket.data.closed || socket.data.ending) {
      void channel.close();
      end();
      return;
    }
    socket.data.unsubscribe = () => { void channel.close(); };
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
