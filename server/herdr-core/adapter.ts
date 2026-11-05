import { existsSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import type { Socket } from "bun";
import { AGENT_LABELS } from "../agents-routes.ts";
import { LINE_BYTES, makeLineReader } from "../herdr/client.ts";
import { SHELL_AGENTS, shellCommandLine } from "../shell-agent.ts";
import { type HcConnection, HcError } from "./connection.ts";
import { agentInfoOf, agentOfStatus, agentStatusOf, buildSnapshot, type FirstTurn, reportedFacts, type HcStatus, type HcTerminal, hcKeyName, HERDR_PROTOCOL, isRecord, keyBytes, LAYOUT_DOC, onOtherMachine, OTHER_WORKSPACE_ID, processInfoOf, SEEN_LABEL, shownStatusOf, SPACE_LABEL, TAB_LABEL, TAB_NAME_LABEL, WORKSPACE_NAME_LABEL } from "./snapshot.ts";
import type { AgentStatus, SessionSnapshot } from "../../shared/herdr-api.generated.ts";

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
 * Ovis keeps workspace and tab names and a pane's move to another workspace in terminal labels
 * (`ping` says so in `layout`); where the app arranges them, they are the app's. Everything else
 * (splits, reordering, zoom, swap, resize, focus, worktrees, plugins) is refused as `unsupported`.
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

export async function startHerdrCoreAdapter(hc: HcConnection, socketPath: string, observeSeen?: SeenObserver): Promise<HerdrCoreAdapter> {
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
  const forgetTurns = (live: ReadonlySet<string>) => { for (const address of firstTurns.keys()) if (!live.has(address)) firstTurns.delete(address); };
  const answers = createAnswers(hc, firstTurn, forgetTurns);
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
            if (request.method === "events.subscribe") { void subscribe(hc, socket, request, firstTurn, observeSeen); return; }
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

function createAnswers(hc: HcConnection, firstTurn: FirstTurn, forgetTurns: (live: ReadonlySet<string>) => void): (request: Request) => Promise<Reply> {
  const terminal = async (address: string, missing = "pane_not_found"): Promise<HcTerminal> => {
    const found = await hc.call("terminal.get", { terminal: address }).catch((error: unknown) => {
      throw error instanceof HcError ? new AdapterError(herdrCode(error, missing), error.message) : error;
    });
    if (found.state !== "live") throw new AdapterError(missing, `terminal ${address} has finished`);
    return found;
  };

  /** herdr's snapshot of the core, and whether Ovis keeps its layout (ownsLayout), from one read of the app's document */
  const read = async (): Promise<{ shown: SessionSnapshot; own: boolean }> => {
    const [list, doc, hello] = await Promise.all([
      hc.call("terminal.list", {}),
      hc.call("doc.get", { name: LAYOUT_DOC }),
      hc.hello(),
    ]);
    forgetTurns(new Set(list.terminals.map((terminal) => terminal.address)));
    return { shown: buildSnapshot(list.terminals, doc.value, hello.version, firstTurn), own: ownsLayout(doc.value) };
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
   * hc's text read of the screen with its colors (paintedScreen): hc reads text only, so this is the
   * first paint of an attach that only watches, which never types or resizes, closed once the screen
   * is in. No paint within PAINT_MS, a stream that ends first, or a paint of another shape answers
   * the plain text, as a read without colors.
   */
  const coloredScreen = async (paneId: string): Promise<string> => {
    const record = await terminal(paneId);
    const decoder = new TextDecoder();
    let paint = "";
    const { promise, resolve } = Promise.withResolvers<string | null>();
    const timer = setTimeout(() => resolve(null), PAINT_MS);
    const { result, channel } = await hc.open("terminal.attach", { terminal: paneId, cols: record.cols, rows: record.rows, history: record.rows, observe: true }, {
      onData: (payload) => {
        paint += decoder.decode(payload, { stream: true });
        if (paint.includes(PAINT_END)) resolve(paint);
      },
      onClose: () => resolve(null),
    }).catch((error: unknown) => {
      clearTimeout(timer);
      throw error;
    });
    let screen: string | null;
    try {
      const painted = await promise;
      // resized since it was looked up: the paint has the rows it has now
      screen = painted === null ? null : paintedScreen(painted, result.terminal?.rows ?? record.rows);
    } finally {
      clearTimeout(timer);
      await channel.close();
    }
    return screen ?? (await hc.call("terminal.read", { terminal: paneId, lines: 0 })).text;
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
   * A shell hc keeps (a lost program comes back as a shell), labeled `labels`, answered as herdr
   * answers a new one: the workspace, tab and pane it shows as in the snapshot right after.
   */
  const startShell = async (params: Record<string, unknown>, labels: Record<string, string>) => {
    const env = isRecord(params["env"]) ? Object.fromEntries(Object.entries(params["env"]).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : undefined;
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

  const methods: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
    async ping() {
      const [hello, doc] = await Promise.all([hc.hello(), hc.call("doc.get", { name: LAYOUT_DOC })]);
      const own = ownsLayout(doc.value);
      // no split: a pane's rect is its terminal's own grid, which the attach then sizes to the pane's
      // cell, so panes Ovis split off would shrink each other until a layout of its own places them
      return { version: hello.version, protocol: HERDR_PROTOCOL, capabilities: { direct_terminal_attach: true, runtime: "herdr-core", layout: { rename: own, split: false, move: own } } };
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
      return { type: "pane_process_info", process_info: processInfoOf(await terminal(paneIdOf(params))) };
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
      // hc reads the screen plus `lines` of history above it; herdr's recent read is the last `lines` lines
      const read = await hc.call("terminal.read", { terminal: paneId, lines: recent ? wanted ?? 1000 : 0 });
      let text = read.text;
      if (recent && wanted !== null) {
        const rows = text.split("\n");
        if (rows.length > wanted) text = rows.slice(-wanted).join("\n");
      }
      // hc reads text only: plain text is an ANSI screen without colours
      return { read: { pane_id: paneId, workspace_id: pane.workspace_id, tab_id: pane.tab_id, source, format, text, revision: pane.revision, truncated: !read.complete } };
    },
    // herdr starts an agent by its kind (its command is its kind) from herdr's own manifests; hc has
    // none, so the kinds Ovis knows are offered, and the start types the command into the pane's
    // shell as a person would. Ovis's own shell-started agents are offered and started by the
    // server itself (shell-agent.ts), through pane.send_text.
    async "server.agent_manifests"() {
      const manifests = Object.keys(AGENT_LABELS).filter((agent) => !Object.hasOwn(SHELL_AGENTS, agent))
        .map((agent) => ({ agent, source: "herdr-core", source_kind: "herdr-core", local_override_shadowing_remote: false }));
      return { manifests };
    },
    async "agent.start"(params) {
      const paneId = paneIdOf(params);
      const kind = params["kind"];
      if (typeof kind !== "string" || !/^[a-z][a-z0-9-]*$/.test(kind)) throw new AdapterError("invalid_params", "kind is required");
      const args = Array.isArray(params["args"]) ? params["args"].filter((arg): arg is string => typeof arg === "string") : [];
      // a control character could end the quoted line early and type something else
      if (args.some((arg) => /[\u0000-\u001f\u007f]/.test(arg))) throw new AdapterError("invalid_params", "an argument holds a control character");
      const command = AGENT_COMMANDS[kind] ?? kind;
      // only into the pane's own shell, once hc has seen it in front: a running program would take
      // the line as its input (agent-launch.ts retries a busy pane while a new shell comes up). The
      // pane's input turn is held for the typing only, so nothing typed after waits on the start.
      await inTurn(paneId, async () => {
        const ready = await terminal(paneId);
        // the terminal's own program must be a plain shell: one the app started as a program (`claude`)
        // is in front of itself too, and `sh -c claude` (a template, a line) runs it under dash's pid.
        // Such a pane never takes a start: no retry
        const own = ready.argv ?? [];
        if (!plainShell(own)) throw new AdapterError("agent_pane_unsupported", `pane ${paneId} runs no shell of its own to start an agent in`);
        // fish reads a backslash inside single quotes as an escape: the argument would change
        const front = ready.foreground;
        const frontArgv = front?.argv ?? (front ? [front.name] : []);
        if ([own[0], frontArgv[0]].some((program) => /(?:^|\/)-?fish$/u.test(program ?? "")) && args.some((arg) => arg.includes("\\"))) throw new AdapterError("invalid_params", "fish would read a backslash in an argument differently");
        // and a plain shell in front now: a program it runs, or one it `exec`ed (same pid, `exec bash -c …` too), would take the line
        if (!ready.pid || front?.pid !== ready.pid || !plainShell(frontArgv)) throw new AdapterError("agent_pane_busy", `pane ${paneId} has no idle shell in front`);
        // Ctrl-U first: a line someone left half typed is cleared, not run with the command after it
        await type(paneId, `\u0015${shellCommandLine("posix", command, args)}\r`);
      });
      // started means the agent itself came up in front (hc samples it about twice a second): a
      // program or script named for the kind (`claude`, `node …/claude-code/cli.js`,
      // `codex-x86_64-…`). Not any program: a shell's command-not-found handler runs in front too,
      // and then the shell is back
      const deadline = Date.now() + AGENT_START_MS;
      let left = false;
      for (;;) {
        const now = await terminal(paneId);
        const front = now.foreground;
        if (front && front.pid !== now.pid) {
          left = true;
          const parts = [front.name, ...(front.argv ?? []).slice(0, 2)].flatMap((part) => part.split("/"));
          if (parts.some((part) => part === command || part.startsWith(`${command}-`) || part.startsWith(`${command}.`))) return { type: "agent_started", pane_id: paneId };
        } else if (left) throw new AdapterError("agent_start_failed", `${kind} did not start in pane ${paneId}`);
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
      const pane = await startShell(params, { [SPACE_LABEL]: spaceId, [TAB_LABEL]: `ovis-${crypto.randomUUID()}`, ...label });
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
      const space: Record<string, string> = workspaceId === OTHER_WORKSPACE_ID ? {} : { [SPACE_LABEL]: workspaceId, [TAB_LABEL]: `ovis-${crypto.randomUUID()}`, [WORKSPACE_NAME_LABEL]: workspace!.label };
      const { tab, root_pane } = await startShell({ ...params, ...(cwd ? { cwd } : {}) }, { ...space, ...label });
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
      const panes = (await snapshot()).panes.filter((pane) => pane.workspace_id === workspaceId);
      if (panes.length === 0) throw new AdapterError("workspace_not_found", `workspace ${workspaceId} not found`);
      await end(panes.map((pane) => pane.pane_id));
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
    // A pane goes to a new tab of another workspace by its labels alone: its terminal, its program and
    // its id stay. It takes that workspace's name with it, so it never renames the workspace by
    // becoming its first terminal. Only `new_tab` is a destination Ovis asks for.
    async "pane.move"(params) {
      const paneId = paneIdOf(params);
      const destination = params["destination"];
      if (!isRecord(destination) || destination["type"] !== "new_tab") throw new AdapterError("unsupported", "herdr-core moves a pane only to a new tab");
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
        ? { [SPACE_LABEL]: "", [TAB_LABEL]: "", [WORKSPACE_NAME_LABEL]: "" }
        : { [SPACE_LABEL]: workspaceId, [TAB_LABEL]: `ovis-${crypto.randomUUID()}`, [WORKSPACE_NAME_LABEL]: workspace!.label };
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

  return async (request) => {
    const method = methods[request.method];
    if (!method) return { error: { code: "unsupported", message: `${request.method} is not available on herdr-core` } };
    try {
      return { result: await method(request.params) };
    } catch (error) {
      if (error instanceof AdapterError) return { error: { code: error.code, message: error.message } };
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
async function subscribe(hc: HcConnection, socket: Socket<ConnectionState>, request: Request, firstTurn: FirstTurn, observeSeen?: SeenObserver): Promise<void> {
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
  const known = new Map<string, { status: HcStatus | null; turn: number; first: number; labels: Record<string, string>; shown: AgentStatus }>();
  let early: HcEvent[] | null = [];
  const remember = (record: unknown) => {
    if (!isRecord(record) || typeof record["address"] !== "string") return;
    const status = statusOf(record["status"]);
    const turn = typeof record["turn"] === "number" ? record["turn"] : 0;
    const labels = labelsOf(record["labels"]);
    const first = firstTurn({ address: record["address"], turn });
    known.set(record["address"], { status, turn, first, labels, shown: shownStatusOf(status, turn, labels, first) });
    observeSeen?.(record["address"], turn, labels);
  };
  const tell = (paneId: string, status: HcStatus | null, shown: AgentStatus) => {
    emit(STATUS_EVENT, { pane_id: paneId, agent_status: shown, agent: agentOfStatus(status) });
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
      case "doc":
        if (event.data?.["name"] === LAYOUT_DOC) lifecycle("layout.updated", "layout_updated");
        return;
      default:
        // title, size and foreground change many times a second and show in the next snapshot
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
