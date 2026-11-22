/**
 * Kimi Code keeps one append-only wire log per agent session:
 * `~/.kimi-code/sessions/wd_<dir>_<hash>/<session>/agents/<agent>/wire.jsonl`.
 * This file reads the main agent's log into conversation turns for the chat view.
 *
 * The pane's session is proven, never guessed: a session lock the CLI wrote for one of the
 * pane's own processes (`~/.kimi-code/locks/sessions/<id>.lock`, held from the session's first
 * write while it works), else, on Linux, the main wire log one of them holds open; an idle Kimi
 * keeps the session its same process proved last. With no such proof, or with two sessions, the
 * chat falls back to the terminal: no picking by creation time or newest mtime, on any OS.
 */
import { closeSync, openSync, opendirSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import type { HerdrPane } from "../shared/protocol.ts";
import { openBound } from "./conversation-shared.ts";
import { paneProcessInfo } from "./herdr/client.ts";
import { processAlive, processStartedAt, processStartUpperBound } from "./process-start.ts";
import { trimOutput } from "./tool-output.ts";

function wireLogsHeld(pid: number, sessions: string): string[] {
  let dir: ReturnType<typeof opendirSync>;
  try { dir = opendirSync(`/proc/${pid}/fd`); } catch { return []; }
  const held: string[] = [];
  try {
    let count = 0;
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (++count > 4096) return [];
      let path: string;
      try { path = realpathSync(readlinkSync(`/proc/${pid}/fd/${entry.name}`)); } catch { continue; }
      if (path.startsWith(sessions + sep) && path.endsWith(`${sep}agents${sep}main${sep}wire.jsonl`)) held.push(path);
    }
  } finally { dir.closeSync(); }
  return held;
}

/** A lock is a small JSON object; anything larger is not the CLI's. */
const LOCK_BYTES = 4096;

/**
 * Whether one of `own` wrote this lock and still holds it: the CLI writes
 * `{ pid, hostname, startedAt }` when it takes the session and removes the file when it lets go,
 * but a crash leaves it behind, and its pid can come to name another process later. A lock
 * written before its pid's process started (by the latest that start can be) is that leftover.
 */
function lockOwner(path: string, own: Set<number>): { pid: number; since: number } | null {
  let lock: unknown;
  try {
    if (statSync(path).size > LOCK_BYTES) return null;
    lock = JSON.parse(readFileSync(path, "utf8"));
  } catch { return null; }
  if (lock === null || typeof lock !== "object") return null;
  const { pid, hostname: host, startedAt } = lock as { pid?: unknown; hostname?: unknown; startedAt?: unknown };
  if (typeof pid !== "number" || !own.has(pid)) return null;
  if (typeof host === "string" && host !== "" && host !== hostname()) return null;
  if (typeof startedAt !== "number" || !processAlive(pid)) return null;
  const started = processStartUpperBound(pid);
  return started !== null && startedAt >= started ? { pid, since: startedAt } : null;
}

/** The main agent's wire log of the session with this id, in whichever folder's store holds it. */
function wireOfSession(sessionId: string, sessions: string): string | null {
  let stores: string[];
  try { stores = readdirSync(sessions); } catch { return null; }
  for (const store of stores) {
    // a folder's sessions (wd_) and managed workspaces' (wm_)
    if (!store.startsWith("wd_") && !store.startsWith("wm_")) continue;
    const path = join(sessions, store, sessionId, "agents", "main", "wire.jsonl");
    try { if (statSync(path).isFile()) return path; } catch {}
  }
  return null;
}

type Proof = { path: string; pid: number; since?: number } | "none" | "ambiguous";

/**
 * The session these processes (a pane's shell and foreground processes) own right now: the one a
 * live lock of theirs names, else on Linux the main log they hold open, which a session has before
 * its lock.
 */
function proveWire(own: Set<number>, home: string): Proof {
  const sessions = join(home, ".kimi-code", "sessions");
  const locks = join(home, ".kimi-code", "locks", "sessions");
  let names: string[] = [];
  try { names = readdirSync(locks); } catch {}
  const locked = new Map<string, { pid: number; since: number }>();
  for (const name of names) {
    if (!name.endsWith(".lock")) continue;
    const owner = lockOwner(join(locks, name), own);
    if (owner !== null) locked.set(name.slice(0, -".lock".length), owner);
  }
  if (locked.size > 1) return "ambiguous";
  if (locked.size === 1) {
    const [sessionId, owner] = [...locked][0]!;
    const path = wireOfSession(sessionId, sessions);
    return path === null ? "none" : { path, ...owner };
  }
  if (process.platform !== "linux") return "none";
  let root: string;
  try { root = realpathSync(sessions); } catch { return "none"; }
  const held = new Map<string, number>();
  for (const pid of own) for (const path of wireLogsHeld(pid, root)) held.set(path, pid);
  if (held.size > 1) return "ambiguous";
  const [first] = [...held];
  return first === undefined ? "none" : { path: first[0], pid: first[1] };
}

/** What names a running program: its start, and on Linux its command line, which an exec replaces. */
function programOf(pid: number): string | null {
  const started = processStartedAt(pid);
  if (started === null) return null;
  if (process.platform !== "linux") return String(started);
  try { return `${started}\0${readFileSync(`/proc/${pid}/cmdline`, "utf8")}`; } catch { return null; }
}

/** The most input history read at once: more typed since the last proof is no answer. */
const HISTORY_BYTES = 1024 * 1024;

/**
 * The input history of the folder a session runs in, as Kimi keeps it
 * (`user-history/<md5(cwd)>.jsonl`, one `{ content }` line per input, slash commands too).
 */
function historyPath(sessionDir: string, home: string): string | undefined {
  let cwd: unknown;
  try {
    const state = join(sessionDir, "state.json");
    if (statSync(state).size > HISTORY_BYTES) return undefined;
    cwd = (JSON.parse(readFileSync(state, "utf8")) as { cwd?: unknown } | null)?.cwd;
  } catch { return undefined; }
  if (typeof cwd !== "string" || cwd === "") return undefined;
  return join(home, ".kimi-code", "user-history", `${createHash("md5").update(cwd, "utf8").digest("hex")}.jsonl`);
}

/** How far apart the CLI's history write and its lock for one prompt may lie. */
const PROMPT_WRITE_MS = 250;

/** A command that moves a Kimi to another session: picking an existing one writes nothing to it. */
const SWITCH_COMMAND = /^\/(?:sessions|resume|new|clear)(?:\s|$)/;

function readHistory(path: string, from: number): { end: number; switched: boolean; changed: number } | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch (error) { return from === 0 && (error as NodeJS.ErrnoException).code === "ENOENT" ? { end: 0, switched: false, changed: 0 } : null; }
  try {
    const { size, mtimeMs } = statSync(path);
    if (from < 0 || size < from || size - from > HISTORY_BYTES) return null;
    const bytes = Buffer.alloc(size - from);
    if (readSync(fd, bytes, 0, bytes.length, from) !== bytes.length) return null;
    const whole = bytes.lastIndexOf(0x0a) + 1;
    let switched = false;
    for (const line of bytes.subarray(0, whole).toString("utf8").split("\n")) {
      let content: unknown;
      try { content = (JSON.parse(line) as { content?: unknown } | null)?.content; } catch { continue; }
      if (typeof content === "string" && SWITCH_COMMAND.test(content.trim())) switched = true;
    }
    return { end: from + whole, switched, changed: mtimeMs };
  } catch { return null; } finally { closeSync(fd); }
}

function historyEnd(path: string): number | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null; }
  try {
    const { size } = statSync(path);
    const tail = Buffer.alloc(Math.min(size, 64 * 1024));
    if (readSync(fd, tail, 0, tail.length, size - tail.length) !== tail.length) return null;
    return size - tail.length + tail.lastIndexOf(0x0a) + 1;
  } catch { return null; } finally { closeSync(fd); }
}

/**
 * The CLI writes a prompt to the history as it takes the lock (the same few milliseconds, either one
 * first), and a turn's lock lingers a few seconds.
 */
function historyAfterProof(path: string | undefined, previous: { path: string; size: number } | undefined, since: number | undefined, sinceBefore: number | undefined, wire: string): { history?: { path: string; size: number }; stale: boolean } {
  if (path === undefined) return { stale: false };
  if (previous?.path === path) {
    const read = readHistory(path, previous.size);
    if (read !== null && !read.switched) return { history: { path, size: read.end }, stale: false };
    let changed = read?.changed;
    try { changed ??= statSync(path).mtimeMs; } catch {}
    let written = -Infinity;
    try { written = statSync(wire).mtimeMs; } catch {}
    const postdated = since !== undefined && since !== sinceBefore && changed !== undefined && since + PROMPT_WRITE_MS >= changed;
    if (!postdated && !(changed !== undefined && written > changed)) return { history: previous, stale: true };
  }
  // a history that cannot be read now is read from nowhere: the binding then holds only while a lock proves it
  return { history: { path, size: historyEnd(path) ?? -1 }, stale: false };
}

/**
 * The CLI lets go of its lock a few seconds after a turn ends and opens its log only to append, so
 * an idle Kimi proves nothing; while that same program still runs in the pane, holds no other
 * session, no other process has locked this one, the folder has started no session since and
 * nobody has typed /sessions or /resume there (which switch to an existing session without a write
 * or a lock until its next prompt), its last session is still the one it shows.
 */
const proven = new Map<string, { path: string; pid: number; since?: number; program: string; store: number; history?: { path: string; size: number } }>();

export function kimiWireForPane(paneId: string, pids: number[], home = homedir()): string | null {
  const own = new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 1));
  const proof = proveWire(own, home);
  if (typeof proof === "object") {
    const program = programOf(proof.pid);
    let store: number | null = null;
    try { store = statSync(dirname(dirname(dirname(dirname(proof.path))))).mtimeMs; } catch {}
    if (program === null || store === null) proven.delete(paneId);
    else {
      const previous = proven.get(paneId);
      const { history, stale } = historyAfterProof(historyPath(dirname(dirname(dirname(proof.path))), home), previous?.path === proof.path ? previous.history : undefined, proof.since, previous?.since, proof.path);
      proven.set(paneId, { path: proof.path, pid: proof.pid, since: proof.since, program, store, history });
      if (stale) return null;
    }
    return proof.path;
  }
  const last = proven.get(paneId);
  proven.delete(paneId);
  if (proof !== "none" || last === undefined || !own.has(last.pid) || !processAlive(last.pid) || programOf(last.pid) !== last.program) return null;
  // a lock on this session now is another process's (the pane's own would have proved it)
  const session = dirname(dirname(dirname(last.path)));
  try { statSync(join(home, ".kimi-code", "locks", "sessions", `${basename(session)}.lock`)); return null; } catch {}
  // a session the folder got since (`/new`) may be the one this Kimi has switched to before it writes
  try { if (statSync(dirname(session)).mtimeMs !== last.store) return null; } catch { return null; }
  if (last.history !== undefined) {
    const read = readHistory(last.history.path, last.history.size);
    if (read === null || read.switched) return null;
    last.history = { path: last.history.path, size: read.end };
  }
  proven.set(paneId, last);
  return last.path;
}

export async function kimiTranscriptPathForPane(pane: HerdrPane, home = homedir()): Promise<string | null> {
  const info = await paneProcessInfo(pane.pane_id).catch(() => null);
  if (!info) return null;
  const pids = [info.shell_pid, ...(info.foreground_processes ?? []).map((process) => process.pid)];
  return kimiWireForPane(pane.pane_id, pids.filter((pid): pid is number => typeof pid === "number"), home);
}

/** The text of a user message: Kimi stores content as parts, older ones as a plain string. */
function kimiUserText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter((part): part is { type: "text"; text: string } =>
    part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string");
  return texts.length === 0 ? null : texts.map((part) => part.text).join("\n");
}

/**
 * The CLI tags every stored message with its origin: injections (AGENTS.md, system reminders), task
 * notifications and cron firings are not the user's and open no turn; records from older CLIs
 * without an origin still count.
 */
export function kimiPrompt(record: unknown): ConversationPart[] | null {
  if (record === null || typeof record !== "object") return null;
  const { type, message } = record as { type?: unknown; message?: { role?: unknown; content?: unknown; origin?: { kind?: unknown } } };
  if (type !== "context.append_message" || message === null || typeof message !== "object" || message.role !== "user") return null;
  const originKind = message.origin?.kind;
  if (typeof originKind === "string" && originKind !== "user") return null;
  const text = kimiUserText(message.content);
  return text === null ? [] : [{ kind: "text", text }];
}

/**
 * Kimi never rewrites the log: a `context.undo` record (with `count`, after the `agent.switched` record newer CLIs write beside it)
 * withdraws the last `count` prompts the user sent and everything after the first of them, but
 * never past a compaction or a clear.
 */
export interface KimiUndo { anchors: number[]; undone: [number, number][] }

const KIMI_UNDO_MARKS = ['"context.append_message"', '"context.undo"', '"context.apply_compaction"', '"context.clear"'];

export function followKimiUndo(undo: KimiUndo, line: Buffer, start: number, end: number): void {
  if (!KIMI_UNDO_MARKS.some((mark) => line.includes(mark))) return;
  let record: { type?: unknown; count?: unknown; message?: { origin?: { inTurn?: unknown } } } | null;
  try { record = JSON.parse(line.toString("utf8")) as typeof record; } catch { return; }
  if (record === null || typeof record !== "object") return;
  if (record.type === "context.apply_compaction" || record.type === "context.clear") undo.anchors = [];
  else if (record.type === "context.undo") {
    const count = record.count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > undo.anchors.length) return;
    let start = undo.anchors[undo.anchors.length - count]!;
    undo.anchors.length -= count;
    while (undo.undone.length > 0 && undo.undone.at(-1)![1] >= start) start = Math.min(start, undo.undone.pop()![0]);
    undo.undone.push([start, end]);
  } else if (kimiPrompt(record) !== null && record.message?.origin?.inTurn !== true) undo.anchors.push(start);
}

function kimiWireTs(time: unknown): string | null {
  return typeof time === "number" && Number.isSafeInteger(time) && Math.abs(time) <= 8.64e15 ? new Date(time).toISOString() : null;
}

function kimiToolSummary(event: { name?: unknown; display?: { kind?: unknown; command?: unknown } }): string {
  const display = event.display;
  if (display?.kind === "command" && typeof display.command === "string" && display.command.length > 0) return display.command;
  return typeof event.name === "string" ? event.name : "tool";
}

/** tool.result records name the call by Kimi's own toolCallId. */
type PendingTool = Extract<ConversationPart, { kind: "tool" }> & { state: "pending" | "ok" | "error" };

/**
 * wire.jsonl records, one per line: user prompts are `context.append_message`
 * records; the answer loop is `context.append_loop_event` records — `content.part`
 * (text or think), `tool.call` and its later `tool.result`, all carrying the loop's
 * `time`.
 */
export function parseKimiTranscript(text: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const pending = new Map<string, PendingTool>();
  let current: ConversationTurn | null = null;
  const ensureAssistant = (ts: string | null): ConversationTurn => {
    if (current === null) current = { role: "assistant", ts, parts: [] };
    if (current.ts === null && ts !== null) current.ts = ts;
    return current;
  };
  const flush = (): void => {
    if (current !== null && current.parts.length > 0) turns.push(current);
    current = null;
  };
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let record: {
      type?: unknown; time?: unknown;
      event?: {
        type?: unknown; part?: { type?: unknown; text?: unknown; think?: unknown };
        toolCallId?: unknown; name?: unknown; args?: unknown; display?: { kind?: unknown; command?: unknown };
        result?: { output?: unknown; isError?: unknown; error?: unknown };
      };
    } | null;
    try { record = JSON.parse(line) as typeof record; } catch { continue; }
    if (record === null || typeof record !== "object") continue;
    const ts = kimiWireTs(record.time);
    const prompt = kimiPrompt(record);
    if (prompt !== null) {
      flush();
      turns.push({ role: "user", ts, parts: prompt });
      continue;
    }
    if (record.type === "context.undo") {
      // `/undo`: Kimi drops the last `count` prompts and everything after each, as its own view does
      flush();
      const count = (record as { count?: unknown }).count;
      for (let undone = 0; typeof count === "number" && undone < count && turns.length > 0;) if (turns.pop()!.role === "user") undone += 1;
      pending.clear();
      continue;
    }
    if (record.type !== "context.append_loop_event" || record.event === null || typeof record.event !== "object") continue;
    const event = record.event;
    if (event.type === "content.part") {
      const part = event.part;
      if (part?.type === "text" && typeof part.text === "string" && part.text.length > 0) {
        ensureAssistant(ts).parts.push({ kind: "text", text: part.text });
      } else if (part?.type === "think" && typeof part.think === "string" && part.think.length > 0) {
        ensureAssistant(ts).parts.push({ kind: "thinking", text: part.think });
      }
    } else if (event.type === "tool.call") {
      const tool: PendingTool = {
        kind: "tool",
        name: typeof event.name === "string" ? event.name : "tool",
        summary: kimiToolSummary(event),
        input: typeof event.args === "string" ? event.args : JSON.stringify(event.args ?? {}),
        output: "",
        state: "pending",
      };
      if (typeof event.toolCallId === "string") tool.call_id = event.toolCallId;
      ensureAssistant(ts).parts.push(tool);
      if (tool.call_id !== undefined) pending.set(tool.call_id, tool);
    } else if (event.type === "tool.result") {
      const tool = typeof event.toolCallId === "string" ? pending.get(event.toolCallId) : undefined;
      if (tool === undefined) continue;
      const output = event.result?.output;
      trimOutput(tool, typeof output === "string" ? output : JSON.stringify(output ?? ""), event.toolCallId as string);
      tool.state = event.result?.isError === true || event.result?.error ? "error" : "ok";
      if (tool.state === "error") tool.error = true;
      pending.delete(event.toolCallId as string);
    }
  }
  flush();
  return turns;
}

const RECORD_BYTES = 64 * 1024 * 1024;

export function kimiToolOutput(path: string, ref: string, max: number): string | null {
  const id = Buffer.from(JSON.stringify(ref));
  let fd: number;
  // another file than the one the lookup is bound to (openBound) holds none of its calls
  try { fd = openBound(path); } catch { return null; }
  const result = (start: number, end: number): string | undefined => {
    if (end - start > RECORD_BYTES) return undefined;
    const bytes = Buffer.alloc(end - start);
    if (readSync(fd, bytes, 0, bytes.length, start) !== bytes.length) return undefined;
    let record: { type?: unknown; event?: { type?: unknown; toolCallId?: unknown; result?: { output?: unknown } } } | null;
    try { record = JSON.parse(bytes.toString("utf8")); } catch { return undefined; }
    const event = record?.event;
    if (record?.type !== "context.append_loop_event" || event?.type !== "tool.result" || event.toolCallId !== ref) return undefined;
    const output = event.result?.output;
    const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
    return text.length > max ? `${text.slice(0, max)}\n… trimmed` : text;
  };
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let lineStart = 0;
    let hit = false;
    let tail = Buffer.alloc(0);
    let position = 0;
    for (let got = 0; (got = readSync(fd, chunk, 0, chunk.length, position)) > 0; position += got) {
      const bytes = chunk.subarray(0, got);
      for (let from = 0; ;) {
        const newline = bytes.indexOf(0x0a, from);
        const end = newline === -1 ? got : newline;
        if (!hit) hit = (from === 0 && tail.length > 0 ? Buffer.concat([tail, bytes.subarray(0, end)]) : bytes.subarray(from, end)).includes(id);
        if (newline === -1) {
          tail = Buffer.from(bytes.subarray(Math.max(from, got - id.length + 1), got));
          break;
        }
        if (hit) {
          const found = result(lineStart, position + newline);
          if (found !== undefined) return found;
        }
        lineStart = position + newline + 1;
        hit = false;
        tail = Buffer.alloc(0);
        from = newline + 1;
      }
    }
    // the last record, whole when it parses, may not end in a newline yet
    return (hit ? result(lineStart, position) : undefined) ?? null;
  } catch { return null; } finally { closeSync(fd); }
}
