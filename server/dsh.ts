import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { readdir, readlink, realpath, open, stat, lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { answerVersion, ConversationNotStarted, ConversationUnavailable, HistoryChanged, TRANSCRIPT_WINDOW_BYTES, type ConversationPage, type RecognizedConversation } from "./conversation-shared.ts";
import { ompProcessMemory, processStartTicks } from "./omp-process.ts";
import { processAlive } from "./process-start.ts";
import { trimOutput } from "./tool-output.ts";

type Processes = { foreground_processes?: { pid?: number; argv?: unknown }[] };
const unavailable = (): never => { throw new ConversationUnavailable("dsh_transcript_unavailable"); };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

const boundProcesses = new Set<string>();
/**
 * This server's own start, in the same clock ticks as a process's: a TUI idle long enough releases its lock, so
 * a lock-free dsh that started before this server, or in the same clock tick, may have held one before we looked
 * and is no proven new chat.
 */
const serverStartTicks = processStartTicks(process.pid);
const SERVER_START = serverStartTicks === null ? null : BigInt(serverStartTicks);

export type DshTranscript = { path: string; root: string; identity: string };

/** dsh-home-paths resolves DSH_HOME before ~/.dsh. Relative homes cannot be pinned after chdir. */
export function dshSessionsDirectory(environ: readonly string[]): string | null {
  const home = environ.find(word => word.startsWith("HOME="))?.slice(5);
  const override = environ.find(word => word.startsWith("DSH_HOME="))?.slice(9);
  let base = override !== undefined && override.trim() !== "" ? override : undefined;
  if (base === undefined || base === "~" || base.startsWith("~/") || base.startsWith("~\\")) {
    if (!home || !isAbsolute(home)) return null;
    base = base === undefined ? join(home, ".dsh") : join(home, base.slice(2));
  }
  return isAbsolute(base) ? join(resolve(base), "sessions") : null;
}

/** Authorize both physical encodings inside the canonical store before opening their bytes. */
export async function authorizeDshTranscript(path: string, sessions: string): Promise<DshTranscript | null> {
  try {
    const root = await realpath(sessions);
    const canonical = await realpath(path);
    const inside = relative(root, canonical);
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)
      || !/^session\.v4\.jsonl(?:\.zstd)?$/.test(basename(canonical))) return null;
    const file = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile() || (process.getuid !== undefined && stat.uid !== BigInt(process.getuid()))) return null;
      return { path: canonical, root, identity: `${stat.dev}:${stat.ino}` };
    } finally { await file.close(); }
  } catch { return null; }
}

const NODE = /(?:^|\/)node$/;
/** The npm bin link (`…/bin/dsh`) or the package entry it points at (`…/@deepseek-ai/dsh/lib/bin.js`); a file merely named dsh is not one. */
const DSH_LAUNCHER = /\/bin\/dsh$|\/@deepseek-ai\/dsh\/lib\/bin\.js$/;
/** dsh-tui's host process, which `dsh-tui` starts behind its two launcher shims and which holds the session lock. */
const DSH_TUI_HOST = /\/@deepseek-harness-tui\/dsh-tui\/lib\/(?:[\w.-]+\/)*host-entry\.js$/;
/** Shipped profiles that serve a browser or a protocol client, not a chat in this terminal. */
const SERVICE_PROFILES = new Set(["web", "sdk", "sdk-minimal", "acp"]);
/** Launcher modes that print or install and exit without booting a session. */
const NOT_A_SESSION = new Set(["--dump-config", "--dump-default-config", "--dump-config-schema", "--help", "-h", "--version", "-V"]);

/**
 * The dsh launcher booting a chat profile, exactly as herdr reports it: `node <…/bin/dsh | …/@deepseek-ai/dsh/lib/bin.js>`,
 * then `--profile <name>`, `--profile=<name>` or the profile name; or dsh-tui's host process
 * (`node …/@deepseek-harness-tui/dsh-tui/lib/…/host-entry.js`). Another program that only
 * mentions dsh, plugin management, a config dump and the web/SDK/ACP service profiles do not match.
 */
export function isDshProcess(argv: readonly unknown[]): boolean {
  if (!argv.every((word) => typeof word === "string")) return false;
  const words = argv as readonly string[];
  // the npm launcher is a node script: herdr reports node in front of it, never the script alone
  if (!NODE.test(words[0] ?? "")) return false;
  if (DSH_TUI_HOST.test(words[1] ?? "")) return true;
  if (!DSH_LAUNCHER.test(words[1] ?? "")) return false;
  const rest = words.slice(2);
  if (rest.some((word) => NOT_A_SESSION.has(word))) return false;
  const profile = rest[0] === "--profile" ? rest[1] : rest[0]?.startsWith("--profile=") ? rest[0].slice(10) : rest[0];
  return profile !== undefined && profile !== "plugin" && /^[A-Za-z0-9][\w.-]*$/.test(profile) && !SERVICE_PROFILES.has(profile);
}

/**
 * A launch that names the session it continues: the TUIs' `--resume`/`--fork`, headless `--session-id`, or
 * dsh-tui's launcher, which hands `dsh-tui --resume` over in DSH_TUI_RESUME_SESSION. Such a process is never
 * shown as a new empty chat before its lock is seen.
 */
function explicitResume(argv: readonly unknown[], environ: readonly string[]): boolean {
  return argv.some((word) => typeof word === "string" && /^(?:--resume|--fork|--session|--session-id|-r)(?:=|$)/.test(word))
    || environ.some((word) => /^DSH_TUI_RESUME_SESSION=\S/.test(word));
}

/** Reset process history between independent fixture sessions. */
export function forgetDshProcesses(): void { boundProcesses.clear(); }

/** A held lock binds the foreground process to its session; modification times do not. */
/** `serverStart`: this server's start tick, or unknown; a lock-free dsh counts as new only when it started strictly after it. */
export async function resolveDshTranscript(info: Processes | null | undefined, serverStart: bigint | null = SERVER_START): Promise<DshTranscript> {
  if (process.platform !== "linux") return unavailable();
  const found = new Map<string, DshTranscript>();
  /** every session a dsh process holds locked, readable or not: more than one is no binding */
  const lockedSessions = new Set<string>();
  const fresh: string[] = [];
  let inspected = 0;
  for (const proc of info?.foreground_processes ?? []) {
    if (!Array.isArray(proc.argv) || !isDshProcess(proc.argv)) continue;
    if (!proc.pid) return unavailable();
    const start = processStartTicks(proc.pid);
    if (!start) {
      if (!processAlive(proc.pid)) continue;
      return unavailable();
    }
    try {
      if ((await stat(`/proc/${proc.pid}`)).uid !== process.getuid?.()) return unavailable();
      const memory = await ompProcessMemory(proc.pid, false);
      if (memory === null) return unavailable();
      const sessions = dshSessionsDirectory(memory.environ);
      if (sessions === null) return unavailable();
      const candidates: DshTranscript[] = [];
      const processLocks = new Set<string>();
      let held = false;
      const descriptors = await readdir(`/proc/${proc.pid}/fd`);
      if (descriptors.length > 4096) return unavailable();
      for (const fd of descriptors) {
        const target = await readlink(`/proc/${proc.pid}/fd/${fd}`).catch((error: NodeJS.ErrnoException) => {
          // readdir itself can leave a closed descriptor in our own process's listing.
          if (error.code === "ENOENT") return "";
          throw error;
        });
        if (basename(target) !== "session.lock" || !/^(?:session-)?[0-9a-f-]{36}$/i.test(basename(dirname(target)))) continue;
        held = true;
        const folder = dirname(await realpath(target));
        processLocks.add(folder);
        for (const name of ["session.v4.jsonl.zstd", "session.v4.jsonl"]) {
          const path = join(folder, name);
          // Only an absent encoding permits trying the older one, never an unreadable or linked log.
          const present = await lstat(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (present === null) continue;
          const authorized = await authorizeDshTranscript(path, sessions);
          // the log must be the locked session's own, not a link into another session of the store
          if (authorized === null || dirname(authorized.path) !== folder) return unavailable();
          candidates.push(authorized);
          break;
        }
      }
      const currentStart = processStartTicks(proc.pid);
      if (currentStart === null) return unavailable();
      if (currentStart === start) {
        inspected++;
        for (const folder of processLocks) lockedSessions.add(folder);
        const identity = `${proc.pid}:${start}`;
        if (held) {
          if (boundProcesses.size >= 256) boundProcesses.delete(boundProcesses.values().next().value!);
          boundProcesses.add(identity);
        }
        for (const transcript of candidates) found.set(transcript.path, transcript);
        if (!held && !boundProcesses.has(identity) && serverStart !== null && BigInt(start) > serverStart && !explicitResume(proc.argv, memory.environ)) fresh.push(identity);
      }
    } catch {
      // An unread recognized process still vetoes selection unless it demonstrably exited or was replaced.
      const currentStart = processStartTicks(proc.pid);
      if (!processAlive(proc.pid) || (currentStart !== null && currentStart !== start)) continue;
      return unavailable();
    }
  }
  if (found.size === 0 && inspected === 1 && fresh.length === 1) throw new ConversationNotStarted(fresh[0]!, "dsh-transcript", fresh[0]!);
  if (found.size !== 1 || lockedSessions.size !== 1) return unavailable();
  return [...found.values()][0]!;
}

/** Ignore an unfinished final append, but reject malformed complete frames. */
export function completeDshFrames(bytes: Buffer): number {
  let end = 0;
  while (end < bytes.length) {
    let at = end;
    if (bytes.length - at < 5) return end;
    if (bytes.readUInt32LE(at) !== 0xfd2fb528) return unavailable();
    const descriptor = bytes[at + 4]!;
    if (descriptor & 24) return unavailable();
    const flag = descriptor >>> 6;
    const single = !!(descriptor & 32);
    at += 5 + (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3]! + (flag ? 1 << flag : single ? 1 : 0);
    if (at > bytes.length) return end;
    for (;;) {
      if (bytes.length - at < 3) return end;
      const block = bytes.readUIntLE(at, 3); at += 3;
      const type = (block >>> 1) & 3;
      if (type === 3) return unavailable();
      at += type === 1 ? 1 : block >>> 3;
      if (at > bytes.length) return end;
      if (block & 1) break;
    }
    if (descriptor & 4) at += 4;
    if (at > bytes.length) return end;
    end = at;
  }
  return end;
}

async function readDsh(binding: DshTranscript): Promise<{ text: string; identity: string }> {
  const authorized = await authorizeDshTranscript(binding.path, binding.root);
  if (authorized === null || authorized.path !== binding.path || authorized.identity !== binding.identity) return unavailable();
  const path = authorized.path;
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)).catch(() => unavailable());
  try {
    const identity = await file.stat({ bigint: true });
    if (`${identity.dev}:${identity.ino}` !== binding.identity) return unavailable();
    const s = await file.stat();
    if (!s.isFile() || (process.getuid !== undefined && s.uid !== process.getuid()) || s.size > TRANSCRIPT_WINDOW_BYTES) return unavailable();
    const bytes = Buffer.alloc(s.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) return unavailable();
      offset += bytesRead;
    }
    let text: string;
    if (path.endsWith(".zstd")) {
      const complete = completeDshFrames(bytes);
      if (!complete) return unavailable();
      const reader = new Blob([bytes.subarray(0, complete)]).stream().pipeThrough(new DecompressionStream("zstd" as CompressionFormat)).getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > TRANSCRIPT_WINDOW_BYTES) { await reader.cancel(); return unavailable(); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      text = Buffer.concat(chunks).toString("utf8");
    } else text = bytes.toString("utf8");
    return { text: text.slice(0, text.lastIndexOf("\n") + 1), identity: binding.identity };
  } catch { return unavailable(); } finally { await file.close(); }
}

type Row = { type: string; seq?: number; time?: number; [key: string]: any };
type Tool = Extract<ConversationPart, { kind: "tool" }>;
export function projectDsh(text: string, identity: string, expectedSession?: string) {
  let rows: Row[];
  try { rows = text.trimEnd().split("\n").map((line) => JSON.parse(line)); } catch { return unavailable(); }
  const header = rows.shift();
  if (header?.type !== "session" || header.version !== 4 || typeof header.id !== "string" || (expectedSession && header.id !== expectedSession) || header.delegationDepth > 0) return unavailable();
  const history = digest(`${identity}\0${header.id}`);
  const turns: ConversationTurn[] = [];
  const tools = new Map<string, Tool>();
  const outputs = new Map<string, string>();
  let assistant: ConversationTurn | undefined;
  let model: string | null = null;
  let reasoning: string | null = null;
  const time = (row: Row) => typeof row.time === "number" && Number.isFinite(row.time) && Math.abs(row.time) <= 8.64e15 ? new Date(row.time).toISOString() : null;
  const ensureAssistant = (row: Row) => assistant ??= (turns.push({ role: "assistant", ts: time(row), parts: [] }), turns.at(-1)!);
  const blocks = (content: any): ConversationPart[] => {
    if (!Array.isArray(content)) return unavailable();
    return content.flatMap((block): ConversationPart[] => {
      if (block === null || typeof block !== "object") return unavailable();
      if (block.type === "text" && typeof block.text === "string") return [{ kind: "text", text: block.text }];
      if (block.type === "reasoning" && typeof block.text === "string") return block.text ? [{ kind: "thinking", text: block.text }] : [];
      if (block.type === "image" || block.type === "file") return [{ kind: "notice", text: `${block.type} attachment (view in terminal)` }];
      if (block.type === "tool-call") return [];
      return unavailable();
    });
  };
  let seq = -1;
  for (const row of rows) {
    if (row === null || typeof row !== "object") return unavailable();
    if (row.seq !== ++seq || typeof row.type !== "string") return unavailable();
    const data = row.data;
    if (row.type === "request/header") {
      const config = data?.header?.config;
      if (typeof config?.model === "string") model = config.model;
      if (typeof config?.reasoningEffort === "string") reasoning = config.reasoningEffort;
    } else if (row.type === "user/message") {
      if (data?.source?.kind === "user") {
        turns.push({ role: "user", ts: time(row), parts: blocks(data.content) }); assistant = undefined;
      } else if (data?.source?.kind === "compact-checkpoint") {
        ensureAssistant(row).parts.push({ kind: "compact", text: blocks(data.content).filter((p) => p.kind === "text").map((p) => p.text).join("\n") });
      }
    } else if (row.type === "assistant/message") {
      if (data?.message?.role !== "assistant") return unavailable();
      ensureAssistant(row).parts.push(...blocks(data.message.content));
    } else if (row.type === "tool/call") {
      if (typeof data?.callId !== "string" || typeof data.name !== "string" || typeof data.arguments !== "string" || tools.has(data.callId)) return unavailable();
      const tool: Tool = { kind: "tool", name: data.name, summary: data.name, input: data.arguments, output: "", call_id: data.callId, state: "pending" };
      tools.set(data.callId, tool); ensureAssistant(row).parts.push(tool);
    } else if (row.type === "tool/result") {
      const message = data?.message;
      const tool = tools.get(message?.toolCallId);
      if (!tool) return unavailable();
      const output = blocks(message.content).map((part) => part.kind === "text" ? part.text : "[attachment]").join("\n");
      const ref = digest(`${history}\0${message.toolCallId}`);
      outputs.set(ref, output); trimOutput(tool, output, ref);
      tool.error = message.isError === true; tool.state = tool.error ? "error" : "ok";
    } else if (row.type === "turn/end") {
      // a turn that failed before any reply (a provider error) still says so
      if (!assistant && data?.reason?.kind !== "completed" && turns.at(-1)?.role === "user") ensureAssistant(row);
      if (assistant) {
        const ts = time(row); if (ts) assistant.end_ts = ts;
        if (data?.reason?.kind === "completed") {
          const part = [...assistant.parts].reverse().find((p) => p.kind === "text"); if (part?.kind === "text") part.phase = "final_answer";
        } else assistant.parts.push({ kind: "notice", text: `Turn ended: ${typeof data?.reason?.kind === "string" ? data.reason.kind : "unknown"}` });
      }
      assistant = undefined;
    } else if (row.surfaceOp !== undefined && row.type !== "system/message" && row.type !== "developer/message") {
      return unavailable();
    }
  }
  return { turns, history, outputs, metadata: { model, reasoning_effort: reasoning } };
}

export async function dshConversation(binding: DshTranscript, page: ConversationPage = {}): Promise<RecognizedConversation> {
  const { text, identity } = await readDsh(binding);
  const projection = projectDsh(text, identity, basename(dirname(binding.path)));
  const { turns, history } = projection;
  const cursor = (index: number) => `${history}:${index}:${digest(JSON.stringify(turns.slice(0, index))).slice(0, 16)}`;
  const parse = (value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    const index = Number(value.split(":")[1]);
    if (!Number.isSafeInteger(index) || index < 0 || index > turns.length || value !== cursor(index)) throw new HistoryChanged();
    return index;
  };
  const end = parse(page.before, turns.length);
  const since = parse(page.since, 0);
  const from = parse(page.from, Math.max(since, end - 50));
  const start = Math.max(since, Math.min(from, end));
  return { source: "dsh-transcript", turns: turns.slice(start, end), metadata: projection.metadata, cursor: start > 0 ? cursor(start) : null, history_id: history, version: answerVersion(history, `${digest(text)}\0${start}\0${end}`) };
}

export async function dshToolOutput(binding: DshTranscript, ref: string): Promise<string | null> {
  const { text, identity } = await readDsh(binding);
  return projectDsh(text, identity, basename(dirname(binding.path))).outputs.get(ref)?.slice(0, 1_000_000) ?? null;
}
