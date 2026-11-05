/** WSL can block procfs memory reads during agent exit. Keep them outside the bridge. */
import { readFileSync } from "node:fs";

export interface ProcessMemory { argv: string[]; environ: string[] }
const MAX_OUTPUT = 1024 * 1024;
const MAX_CACHED = 64;
/** The most of a process environment the helper reads; Linux allows a few MiB, real ones are KiB. */
const ENVIRON_MAX = 1024 * 1024;
/**
 * The variables the agent store and terminal lookups read (omp.ts, gjcTerminal, dsh.ts; dsh-tui's resume
 * handoff is a session id, not a secret): the
 * rest of the environment may hold secrets, so nothing else leaves the read.
 */
const ROUTING = /^(?:HOME|OMP_PROFILE|PI_PROFILE|PI_CONFIG_DIR|PI_CODING_AGENT_DIR|PI_CODING_AGENT_SESSION_DIR|DSH_HOME|DSH_TUI_RESUME_SESSION|XDG_DATA_HOME|XDG_STATE_HOME|TMUX|TMUX_PANE)=/;

/**
 * The routing words of a process's environment, or null when it could not be read. An environment
 * read empty is a process gone or not ours to read, not one without the variables.
 */
export function ompRoutingEnviron(environ: readonly string[] | null): string[] | null {
  if (environ === null || !environ.some((word) => word !== "")) return null;
  return environ.filter((word) => ROUTING.test(word));
}

/**
 * The helper's first line, written once it runs and before it touches the target: only the read after
 * it has the read deadline, since starting a bun can take over a second on a loaded PC (#2648).
 */
export const PROBE_STARTED = "omp-process-probe: reading";

const SCRIPT = `
const fs = require("node:fs"), pid = process.argv[1];
console.log(${JSON.stringify(PROBE_STARTED)});
try {
  const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (/^[DZXx]$/.test(fields[0])) process.exit(1);
  // each word ends in a NUL: drop only the empty entry after the last one, since an empty argument counts
  const read = name => {
    const words = fs.readFileSync("/proc/" + pid + "/" + name, "utf8").split("\\0");
    if (words.at(-1) === "") words.pop();
    return words;
  };
  // read at most ENVIRON_MAX bytes: a larger environment is no answer rather than an unbounded read
  const fd = fs.openSync("/proc/" + pid + "/environ", "r");
  const buffer = Buffer.alloc(${ENVIRON_MAX} + 1);
  let size = 0;
  try {
    for (let n; size < buffer.length && (n = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0;) size += n;
  } finally { fs.closeSync(fd); }
  if (size > ${ENVIRON_MAX}) process.exit(1);
  const raw = buffer.subarray(0, size).toString("utf8").split("\\0");
  if (raw.at(-1) === "") raw.pop();
  if (!raw.some(word => word !== "")) process.exit(1);
  const environ = raw.filter(word => ${ROUTING}.test(word));
  console.log(JSON.stringify({ start: fields[19], argv: process.argv[2] === "1" ? read("cmdline") : [], environ }));
} catch { process.exit(1); }
`;

/**
 * A process's start time in clock ticks after boot, /proc/<pid>/stat field 22. stat takes no mm
 * lock, so it answers even while cmdline or environ would block. null once the process is gone.
 */
export function processStartTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return start && /^\d+$/.test(start) ? start : null;
  } catch { return null; }
}

let wsl: boolean | undefined;
/** WSL's kernel names itself in osrelease; read once, it cannot change while we run. */
export function isWsl(): boolean {
  if (wsl === undefined) {
    try { wsl = /microsoft/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf8")); } catch { wsl = false; }
  }
  return wsl;
}

/**
 * Concurrent polls share a probe; timed-out children retain their slot until they exit. A
 * successful answer is kept per pid and start time, so polling one process spawns one helper and
 * a reused pid misses; a failed one is never kept, so the next poll tries again. `timeoutMs` bounds
 * the read, from the helper's PROBE_STARTED line on; `startMs` bounds the helper's own start.
 */
export function createOmpProcessProbe({ timeoutMs = 1000, startMs = 10_000, maxProcesses = 4, startTicks = processStartTicks, command = (pid, argv) => [process.execPath, "-e", SCRIPT, String(pid), argv ? "1" : "0"] }: {
  timeoutMs?: number;
  startMs?: number;
  maxProcesses?: number;
  startTicks?: (pid: number) => string | null;
  command?: (pid: number, argv: boolean) => string[];
} = {}): (pid: number, argv: boolean) => Promise<ProcessMemory | null> {
  /** Answers still being read, shared by concurrent polls of one process. */
  const pending = new Map<string, Promise<ProcessMemory | null>>();
  /** Helpers not yet exited, answered or not: a kernel-blocked one keeps its slot. */
  let live = 0;
  const cache = new Map<number, { start: string; argv: boolean; memory: ProcessMemory }>();
  let warned = false;
  return (pid, argv) => {
    if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
    const start = startTicks(pid);
    if (start === null) { cache.delete(pid); return Promise.resolve(null); }
    const cached = cache.get(pid);
    if (cached && cached.start !== start) cache.delete(pid);
    else if (cached && (cached.argv || !argv)) return Promise.resolve(cached.memory);
    const key = `${pid}:${argv}`;
    const existing = pending.get(key);
    if (existing) return existing;
    if (live >= maxProcesses) {
      if (!warned) {
        warned = true;
        console.warn(`omp: ${maxProcesses} process reads are still starting or stuck in the kernel; omp chat cannot find transcripts until they exit or the server restarts`);
      }
      return Promise.resolve(null);
    }
    let child: Bun.Subprocess<"ignore", "pipe", "ignore">;
    try { child = Bun.spawn(command(pid, argv), { stdin: "ignore", stdout: "pipe", stderr: "ignore" }); }
    catch { return Promise.resolve(null); }
    child.unref();
    live++;
    const reader = child.stdout.getReader();
    const answer = new Promise<ProcessMemory | null>((resolve) => {
      let finished = false;
      const finish = (value: ProcessMemory | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        pending.delete(key);
        // A kernel-blocked child may not exit promptly even after SIGKILL. Never await it here.
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
        void reader.cancel().catch(() => {});
        resolve(value);
      };
      let timer = setTimeout(() => finish(null), startMs);
      void (async () => {
        let output = "", bytes = 0, started = false;
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done || finished) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_OUTPUT) { finish(null); return; }
            output += decoder.decode(chunk.value, { stream: true });
            const end = started ? -1 : output.indexOf("\n");
            if (end >= 0) {
              if (output.slice(0, end) !== PROBE_STARTED) { finish(null); return; }
              // the helper runs: from here on only its read of the target is timed
              started = true;
              output = output.slice(end + 1);
              // the bound is on the answer alone, as before the start line
              bytes = Buffer.byteLength(output);
              clearTimeout(timer);
              timer = setTimeout(() => finish(null), timeoutMs);
            }
          }
          if (!started) { finish(null); return; }
          output += decoder.decode();
          const value: unknown = JSON.parse(output);
          const words = (v: unknown): v is string[] => Array.isArray(v) && v.every((word) => typeof word === "string");
          if (value === null || typeof value !== "object" || !("argv" in value) || !("environ" in value) || !words(value.argv) || !words(value.environ)) { finish(null); return; }
          // a different start time: the pid was reused, and the helper read another process
          if (!("start" in value) || value.start !== start) { finish(null); return; }
          const memory = { argv: value.argv, environ: value.environ };
          if (cache.size >= MAX_CACHED && !cache.has(pid)) cache.delete(cache.keys().next().value!);
          cache.set(pid, { start, argv, memory });
          finish(memory);
        } catch { finish(null); }
      })();
    });
    pending.set(key, answer);
    void child.exited.then(() => { live--; }, () => { live--; });
    return answer;
  };
}

export const ompProcessMemory = createOmpProcessProbe();
