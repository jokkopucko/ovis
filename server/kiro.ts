import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { open, readdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { ConversationUnavailable, paginateTurns, TRANSCRIPT_WINDOW_BYTES, type ConversationPage, type RecognizedConversation } from "./conversation-shared.ts";
import { ompProcessMemory } from "./omp-process.ts";
import { processStartedAt, processStartUpperBound } from "./process-start.ts";
import { trimOutput } from "./tool-output.ts";

type Processes = { foreground_processes?: { pid?: number; argv?: unknown }[] };
const unavailable = (): never => { throw new ConversationUnavailable("kiro_transcript_unavailable"); };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const V3_SESSION_ID = /^sess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** More session lock files or workspace session groups than this in one store is no answer, rather than an unbounded scan. */
const MAX_LOCKS = 256;
const MAX_V3_GROUPS = 512;
const LOCK_BYTES = 4096;
const V3_RECORD_TAIL_BYTES = 1024 * 1024;

export type KiroTranscript = { path: string; root: string; identity: string; session: string };

/** Kiro CLI's state directory: `$KIRO_HOME`, else `~/.kiro`. Relative homes cannot be pinned after chdir. */
export function kiroHomeDirectory(environ: readonly string[]): string | null {
  const home = environ.find((word) => word.startsWith("HOME="))?.slice(5);
  const override = environ.find((word) => word.startsWith("KIRO_HOME="))?.slice(10);
  const base = override !== undefined && override.trim() !== "" ? override : home && isAbsolute(home) ? join(home, ".kiro") : undefined;
  return base !== undefined && isAbsolute(base) ? resolve(base) : null;
}

/** Kiro CLI's V2 store: `$KIRO_HOME/sessions/cli`, else `~/.kiro/sessions/cli`. Relative homes cannot be pinned after chdir. */
export function kiroSessionsDirectory(environ: readonly string[]): string | null {
  const base = kiroHomeDirectory(environ);
  return base === null ? null : join(base, "sessions", "cli");
}

const KIRO_TUI_NON_CHAT = new Set(["-h", "--help", "-V", "--version", "validate-theme", "theme", "powers", "login", "logout", "whoami", "mcp", "update", "settings", "agent", "profile", "diagnostic", "issue", "crew", "integrations", "help"]);

/**
 * Kiro CLI's chat TUI as herdr reports its foreground group: the `kiro-cli` launcher, the `kiro-cli-chat chat`
 * binary, or the bundled `bun … /kiro-cli/tui.js [chat …]` the binary starts. Another program is not one.
 */
export function isKiroChatProcess(argv: readonly unknown[]): boolean {
  if (!argv.every((word) => typeof word === "string")) return false;
  const words = argv as readonly string[];
  const program = basename(words[0] ?? "");
  if (program === "kiro-cli" && (words.length === 1 || words[1] === "chat")) return true;
  if (program === "kiro-cli-chat" && words[1] === "chat") return true;
  const tui = words.findIndex((word, index) => index > 0 && /\/kiro-cli\/tui\.js$/.test(word));
  if (tui <= 0) return false;
  const next = words[tui + 1];
  return next === undefined || next === "chat"
    || (next.startsWith("-") && !words.slice(tui + 1).some((word) => KIRO_TUI_NON_CHAT.has(word)));
}

export function isKiroAcpProcess(argv: readonly string[]): boolean {
  return basename(argv[0] ?? "") === "kiro-cli-chat" && argv[1] === "acp";
}

/** Kiro CLI V3's stdio ACP engine child (`node …/@kiro/agent/dist/server/acp-server.js --transport=stdio …`). */
export function isKiroV3AcpProcess(argv: readonly unknown[]): boolean {
  if (!argv.every((word) => typeof word === "string")) return false;
  const words = argv as readonly string[];
  return basename(words[0] ?? "") === "node"
    && words.some((word, index) => index > 0 && /\/@kiro\/agent\/dist\/server\/acp-server\.js$/.test(word))
    && words.includes("--transport=stdio");
}

async function children(pid: number): Promise<number[]> {
  const found: number[] = [];
  for (const task of await readdir(`/proc/${pid}/task`)) {
    const text = await readFile(`/proc/${pid}/task/${task}/children`, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    for (const word of text.split(" ")) if (/^\d+$/.test(word)) found.push(Number(word));
  }
  return found;
}

async function commandLine(pid: number): Promise<string[]> {
  const words = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
  if (words.at(-1) === "") words.pop();
  return words;
}

async function parentOf(pid: number): Promise<number> {
  return Number((await readFile(`/proc/${pid}/stat`, "utf8")).split(") ").pop()!.split(" ")[1]);
}

/** A lock as Kiro wrote it, read from the opened entry itself: a link, a FIFO or a grown file is no lock. */
async function readLock(sessions: string, id: string): Promise<{ pid: number; opened: number } | null> {
  const file = await open(join(sessions, `${id}.lock`), constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (file === null) return null;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (process.getuid !== undefined && stat.uid !== process.getuid())) return null;
    const bytes = Buffer.alloc(LOCK_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > LOCK_BYTES) return null;
    const lock = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    const opened = typeof lock?.started_at === "string" ? Date.parse(lock.started_at) : NaN;
    return Number.isSafeInteger(lock?.pid) && Number.isFinite(opened) ? { pid: lock.pid, opened } : null;
  } catch { return null; } finally { await file.close(); }
}

/** Authorize the session log inside the canonical store before opening its bytes. */
export async function authorizeKiroTranscript(path: string, sessions: string): Promise<KiroTranscript | null> {
  try {
    const root = await realpath(sessions);
    const canonical = await realpath(path);
    const inside = relative(root, canonical);
    const name = basename(canonical);
    const session = name.slice(0, -".jsonl".length);
    if (!inside || inside !== name || !name.endsWith(".jsonl") || !SESSION_ID.test(session)) return null;
    const file = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile() || (process.getuid !== undefined && stat.uid !== BigInt(process.getuid()))) return null;
      return { path: canonical, root, identity: `${stat.dev}:${stat.ino}`, session };
    } finally { await file.close(); }
  } catch { return null; }
}

/**
 * The session a pane's Kiro TUI has open. Kiro writes `<id>.lock` = `{pid, started_at}` beside the session its
 * `kiro-cli-chat acp` process has open (a setsid child of the TUI, so herdr does not list it): written when a
 * session opens, moved on `/chat new` and `/chat <id>`, deleted on `/quit`. The pane binds the one lock naming
 * the acp child of its own foreground TUI, opened after that process started; nothing else (folder, recency)
 * picks a session. Linux only: it needs procfs.
 */
export async function resolveKiroTranscript(info: Processes | null | undefined): Promise<KiroTranscript> {
  if (process.platform !== "linux") return unavailable();
  const tui = (info?.foreground_processes ?? []).filter((proc) => Array.isArray(proc.argv) && isKiroChatProcess(proc.argv));
  if (tui.length === 0 || tui.some((proc) => typeof proc.pid !== "number")) return unavailable();
  try {
    // each process is pinned by its start (stable on every read) and checked again after the lock is read
    const fronts: { pid: number; start: number }[] = [];
    for (const proc of tui) {
      const start = processStartedAt(proc.pid!);
      if (start === null || !isKiroChatProcess(await commandLine(proc.pid!))) return unavailable();
      fronts.push({ pid: proc.pid!, start });
    }
    const acp: { pid: number; parent: number; start: number; startedBy: number }[] = [];
    for (const front of fronts) {
      for (const child of await children(front.pid)) {
        const argv = await commandLine(child).catch(() => []);
        if (!isKiroAcpProcess(argv)) continue;
        const start = processStartedAt(child);
        const startedBy = processStartUpperBound(child);
        if (start === null || startedBy === null) return unavailable();
        acp.push({ pid: child, parent: front.pid, start, startedBy });
      }
    }
    if (acp.length !== 1) return unavailable();
    const [server] = acp as [typeof acp[number]];
    const memory = await ompProcessMemory(server.pid, false);
    const sessions = memory === null ? null : kiroSessionsDirectory(memory.environ);
    if (sessions === null) return unavailable();
    const locks = (await readdir(sessions)).filter((name) => name.endsWith(".lock") && SESSION_ID.test(name.slice(0, -5)));
    if (locks.length > MAX_LOCKS) return unavailable();
    // a lock left by an earlier process that had this pid was written before this one surely started
    const ours = (lock: { pid: number; opened: number } | null) => lock !== null && lock.pid === server.pid && lock.opened >= server.startedBy;
    const held: string[] = [];
    for (const name of locks) if (ours(await readLock(sessions, name.slice(0, -5)))) held.push(name.slice(0, -5));
    if (held.length !== 1) return unavailable();
    const [id] = held as [string];
    const transcript = await authorizeKiroTranscript(join(sessions, `${id}.jsonl`), sessions);
    // the log is that session's own, not a link to another session of the store
    if (transcript === null || transcript.session !== id) return unavailable();
    // nothing changed while it was read: the same processes, and the lock not moved to another session
    const same = ours(await readLock(sessions, id))
      && processStartedAt(server.pid) === server.start && isKiroAcpProcess(await commandLine(server.pid)) && await parentOf(server.pid) === server.parent
      && fronts.every((front) => processStartedAt(front.pid) === front.start);
    return same ? transcript : unavailable();
  } catch (error) {
    if (error instanceof ConversationUnavailable) throw error;
    return unavailable();
  }
}

/** A V3 lease as Kiro's ACP server wrote it, read from the opened entry itself: a link, a FIFO or a grown file is none. */
async function readV3Lease(leasesDir: string, id: string): Promise<{ pid: number; parentPid: number; acquired: number } | null> {
  const file = await open(join(leasesDir, `${id}.lease`), constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (file === null) return null;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (process.getuid !== undefined && stat.uid !== process.getuid())) return null;
    const bytes = Buffer.alloc(LOCK_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > LOCK_BYTES) return null;
    const lease = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    const acquired = typeof lease?.acquiredAt === "string" ? Date.parse(lease.acquiredAt) : NaN;
    return Number.isSafeInteger(lease?.pid) && Number.isSafeInteger(lease?.parentPid) && Number.isFinite(acquired)
      ? { pid: lease.pid, parentPid: lease.parentPid, acquired } : null;
  } catch { return null; } finally { await file.close(); }
}

/** Locate `<home>/sessions/<group>/<id>/messages.jsonl` inside the canonical store; ambiguous duplicates or symlinks fail closed. */
export async function authorizeKiroV3Messages(sessionsDir: string, id: string): Promise<{ path: string; identity: string } | null> {
  if (!V3_SESSION_ID.test(id)) return null;
  try {
    const root = await realpath(sessionsDir);
    const entries = await readdir(root, { withFileTypes: true });
    if (entries.length > MAX_V3_GROUPS) return null;
    let found: { path: string; identity: string } | null = null;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "cli") continue;
      const candidate = join(root, entry.name, id, "messages.jsonl");
      const canonical = await realpath(candidate).catch(() => null);
      if (canonical === null || canonical !== candidate) continue;
      const parts = relative(root, canonical).split("/");
      if (parts.length !== 3 || parts[0] !== entry.name || parts[1] !== id || parts[2] !== "messages.jsonl") continue;
      const file = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
      if (file === null) continue;
      let identity: string;
      try {
        const stat = await file.stat({ bigint: true });
        if (!stat.isFile() || (process.getuid !== undefined && stat.uid !== BigInt(process.getuid()))) continue;
        identity = `${stat.dev}:${stat.ino}`;
      } finally { await file.close(); }
      if (found !== null) return null;
      found = { path: canonical, identity };
    }
    return found;
  } catch { return null; }
}

/** Read the tail of an already-authorized V3 `messages.jsonl` while verifying its `dev:ino` identity on the open handle. */
async function readAuthorizedV3Tail(path: string, identity: string): Promise<string | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (file === null) return null;
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || `${stat.dev}:${stat.ino}` !== identity) return null;
    if (process.getuid !== undefined && stat.uid !== BigInt(process.getuid())) return null;
    const size = Number(stat.size);
    const length = Math.min(size, V3_RECORD_TAIL_BYTES);
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await file.read(bytes, offset, length - offset, size - length + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const text = bytes.subarray(0, offset).toString("utf8");
    return length < size ? text.slice(text.indexOf("\n") + 1) : text;
  } catch { return null; } finally { await file.close(); }
}

/**
 * Resolve and read the tail of a pane's active Kiro CLI V3 `messages.jsonl` under one lease-verified binding.
 * Kiro 3.x writes `<home>/session-leases/<sess_id>.lease` holding `{ pid, parentPid, acquiredAt }` for the stdio
 * `acp-server.js` child of the foreground `tui.js` process. The bytes are read from an `O_NOFOLLOW` handle whose
 * `dev:ino` matches the authorized file, and both processes and the lease are re-verified *after* reading the bytes
 * so a file replacement or lease handoff during the read cannot bind stale data. Linux only: it needs procfs.
 */
export async function readKiroV3MessagesTail(info: Processes | null | undefined): Promise<{ path: string; identity: string; text: string } | null> {
  if (process.platform !== "linux") return null;
  const tui = (info?.foreground_processes ?? []).filter((proc) => Array.isArray(proc.argv) && isKiroChatProcess(proc.argv));
  if (tui.length === 0 || tui.some((proc) => typeof proc.pid !== "number")) return null;
  try {
    const fronts: { pid: number; start: number }[] = [];
    for (const proc of tui) {
      const start = processStartedAt(proc.pid!);
      if (start === null || !isKiroChatProcess(await commandLine(proc.pid!))) return null;
      fronts.push({ pid: proc.pid!, start });
    }
    const acp: { pid: number; parent: number; start: number; startedBy: number }[] = [];
    for (const front of fronts) {
      for (const child of await children(front.pid)) {
        const argv = await commandLine(child).catch(() => []);
        if (!isKiroV3AcpProcess(argv)) continue;
        const start = processStartedAt(child);
        const startedBy = processStartUpperBound(child);
        if (start === null || startedBy === null) return null;
        acp.push({ pid: child, parent: front.pid, start, startedBy });
      }
    }
    if (acp.length !== 1) return null;
    const [server] = acp as [typeof acp[number]];
    const memory = await ompProcessMemory(server.pid, false);
    const home = memory === null ? null : kiroHomeDirectory(memory.environ);
    if (home === null) return null;
    const leasesDir = join(home, "session-leases");
    const leases = (await readdir(leasesDir)).filter((name) => name.endsWith(".lease") && V3_SESSION_ID.test(name.slice(0, -6)));
    if (leases.length > MAX_LOCKS) return null;
    const ours = (lease: { pid: number; parentPid: number; acquired: number } | null) =>
      lease !== null && lease.pid === server.pid && lease.parentPid === server.parent && lease.acquired >= server.startedBy;
    const held: string[] = [];
    for (const name of leases) if (ours(await readV3Lease(leasesDir, name.slice(0, -6)))) held.push(name.slice(0, -6));
    if (held.length !== 1) return null;
    const [id] = held as [string];
    const messages = await authorizeKiroV3Messages(join(home, "sessions"), id);
    if (messages === null) return null;
    const text = await readAuthorizedV3Tail(messages.path, messages.identity);
    if (text === null) return null;
    const same = ours(await readV3Lease(leasesDir, id))
      && processStartedAt(server.pid) === server.start && isKiroV3AcpProcess(await commandLine(server.pid)) && await parentOf(server.pid) === server.parent
      && fronts.every((front) => processStartedAt(front.pid) === front.start);
    return same ? { path: messages.path, identity: messages.identity, text } : null;
  } catch { return null; }
}

/** The canonical path of the pane's active Kiro V3 `messages.jsonl`, or null when unbound. */
export async function resolveKiroV3MessagesPath(info: Processes | null | undefined): Promise<string | null> {
  return (await readKiroV3MessagesTail(info))?.path ?? null;
}

/**
 * Synchronous final check right before sending a key to a record-bound Kiro card (zero yields before write):
 * verifies the already-authorized `messages.jsonl` still has the same `dev:ino` identity and still holds `recordId` open.
 */
export function kiroRecordStillOpenInFile(recordId: string, pending: (text: string) => { id: string } | null): boolean {
  const firstNull = recordId.indexOf("\0");
  if (firstNull <= 0) return false;
  const secondNull = recordId.indexOf("\0", firstNull + 1);
  if (secondNull <= firstNull + 1) return false;
  const path = recordId.slice(0, firstNull);
  const expectedIdentity = recordId.slice(firstNull + 1, secondNull);
  const expectedRequest = recordId.slice(secondNull + 1);
  if (!isAbsolute(path) || !expectedRequest) return false;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  } catch { return false; }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || `${stat.dev}:${stat.ino}` !== expectedIdentity) return false;
    if (process.getuid !== undefined && stat.uid !== BigInt(process.getuid())) return false;
    const size = Number(stat.size);
    const length = Math.min(size, V3_RECORD_TAIL_BYTES);
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const bytesRead = readSync(fd, bytes, offset, length - offset, size - length + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const text = bytes.subarray(0, offset).toString("utf8");
    const whole = length < size ? text.slice(text.indexOf("\n") + 1) : text;
    return pending(whole)?.id === expectedRequest;
  } catch { return false; } finally {
    closeSync(fd);
  }
}

async function readKiro(binding: KiroTranscript): Promise<string> {
  const authorized = await authorizeKiroTranscript(binding.path, binding.root);
  if (authorized === null || authorized.path !== binding.path || authorized.identity !== binding.identity) return unavailable();
  const file = await open(authorized.path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)).catch(() => unavailable());
  try {
    const stat = await file.stat({ bigint: true });
    if (`${stat.dev}:${stat.ino}` !== binding.identity || !stat.isFile() || stat.size > BigInt(TRANSCRIPT_WINDOW_BYTES)) return unavailable();
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) return unavailable();
      offset += bytesRead;
    }
    const text = bytes.toString("utf8");
    return text.slice(0, text.lastIndexOf("\n") + 1);
  } catch { return unavailable(); } finally { await file.close(); }
}

type Tool = Extract<ConversationPart, { kind: "tool" }>;
type Block = { kind?: unknown; data?: any };

/**
 * Kiro records a command that exited non-zero as a `success`: only its `exit_status` says it failed.
 */
function toolResult(content: unknown): { output: string; failed: boolean } {
  if (!Array.isArray(content)) return unavailable();
  let failed = false;
  const output = content.map((block: Block) => {
    if (block?.kind === "text" && typeof block.data === "string") return block.data;
    if (block?.kind === "json") {
      const data = block.data;
      if (typeof data?.exit_status === "string" && data.exit_status !== "exit status: 0") failed = true;
      if (typeof data?.stdout === "string" && typeof data?.stderr === "string") return [data.stdout, data.stderr].filter(Boolean).join("\n");
      return JSON.stringify(data, null, 2);
    }
    return unavailable();
  }).join("\n");
  return { output, failed };
}

export function projectKiro(text: string, identity: string, session: string) {
  const history = digest(`${identity}\0${session}`);
  const turns: ConversationTurn[] = [];
  const tools = new Map<string, Tool>();
  const outputs = new Map<string, string>();
  let assistant: ConversationTurn | undefined;
  let working = false;
  // Kiro dates only prompts: a reply carries its prompt's time
  let asked: string | null = null;
  const ensureAssistant = () => assistant ??= (turns.push({ role: "assistant", ts: asked, parts: [] }), turns.at(-1)!);
  const finish = () => {
    if (assistant && !working) {
      const part = [...assistant.parts].reverse().find((p) => p.kind === "text" && p.text.trim() !== "");
      if (part?.kind === "text") part.phase = "final_answer";
    }
  };
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let row: { version?: unknown; kind?: unknown; data?: any };
    try { row = JSON.parse(line); } catch { return unavailable(); }
    if (row === null || typeof row !== "object" || row.version !== "v1") return unavailable();
    // `/clear` empties what the model sees; Kiro's own view keeps the earlier chat above a marker, and so does this one
    if (row.kind === "Clear") {
      finish();
      turns.push({ role: "user", ts: null, parts: [{ kind: "notice", text: "Conversation cleared", source: "clear" }] });
      assistant = undefined; working = false;
      continue;
    }
    if (row.data === null || typeof row.data !== "object") return unavailable();
    const data = row.data;
    if (row.kind === "Compaction") {
      if (typeof data.summary !== "string") return unavailable();
      finish();
      turns.push({ role: "user", ts: null, parts: [{ kind: "compact", text: data.summary }] });
      assistant = undefined; working = false;
    } else if (row.kind === "Prompt") {
      if (!Array.isArray(data.content)) return unavailable();
      const parts = data.content.map((block: Block): ConversationPart => {
        if (block?.kind === "text" && typeof block.data === "string") return { kind: "text", text: block.data };
        return unavailable();
      });
      const seconds = data.meta?.timestamp;
      const ts = typeof seconds === "number" && Number.isFinite(seconds) && Math.abs(seconds) <= 8.64e12 ? new Date(seconds * 1000).toISOString() : null;
      finish();
      asked = ts;
      turns.push({ role: "user", ts, parts });
      assistant = undefined; working = false;
    } else if (row.kind === "AssistantMessage") {
      if (!Array.isArray(data.content)) return unavailable();
      const turn = ensureAssistant();
      working = false;
      for (const block of data.content as Block[]) {
        if (block?.kind === "text" && typeof block.data === "string") {
          if (block.data !== "") turn.parts.push({ kind: "text", text: block.data });
        } else if (block?.kind === "thinking") {
          // reasoning Kiro keeps encrypted has no text to show, and none is made up
          if (typeof block.data?.text === "string" && block.data.text !== "") turn.parts.push({ kind: "thinking", text: block.data.text });
        } else if (block?.kind === "toolUse") {
          const call = block.data;
          if (typeof call?.toolUseId !== "string" || typeof call.name !== "string" || tools.has(call.toolUseId)) return unavailable();
          const { __tool_use_purpose: purpose, ...input } = call.input !== null && typeof call.input === "object" ? call.input : {} as Record<string, unknown>;
          const tool: Tool = { kind: "tool", name: call.name, summary: typeof purpose === "string" && purpose !== "" ? purpose : call.name, input: JSON.stringify(input), output: "", call_id: call.toolUseId, state: "pending" };
          tools.set(call.toolUseId, tool); turn.parts.push(tool);
          working = true;
        } else return unavailable();
      }
    } else if (row.kind === "ToolResults") {
      if (!Array.isArray(data.content)) return unavailable();
      for (const block of data.content as Block[]) {
        const result = block?.data;
        const tool = block?.kind === "toolResult" ? tools.get(result?.toolUseId) : undefined;
        if (!tool) return unavailable();
        const { output, failed } = toolResult(result.content);
        const ref = digest(`${history}\0${result.toolUseId}`);
        outputs.set(ref, output); trimOutput(tool, output, ref);
        tool.error = result.status === "error" || failed; tool.state = tool.error ? "error" : "ok";
      }
    } else return unavailable();
  }
  finish();
  return { turns, history, outputs };
}

export async function kiroConversation(binding: KiroTranscript, page: ConversationPage = {}): Promise<RecognizedConversation> {
  const text = await readKiro(binding);
  const { turns, history } = projectKiro(text, binding.identity, binding.session);
  return paginateTurns({ source: "kiro-transcript", turns, history, metadata: { model: null, reasoning_effort: null }, textDigest: digest(text), page, supportsPrompts: true });
}

export async function kiroToolOutput(binding: KiroTranscript, ref: string): Promise<string | null> {
  const text = await readKiro(binding);
  return projectKiro(text, binding.identity, binding.session).outputs.get(ref)?.slice(0, 1_000_000) ?? null;
}
