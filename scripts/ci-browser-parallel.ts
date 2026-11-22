/**
 * BROWSER_SCRIPT_TIMEOUT_SECONDS: how long one run of a script may take (default 600), so a hung
 * script fails and names itself instead of using up the job's timeout. At the bound the script's
 * process tree is stopped, its last log lines are printed at once, and it is not run again.
 */
import { availableParallelism } from "node:os";
import { basename, join } from "node:path";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { QUARANTINE, QUARANTINE_MAX_DAYS, type QuarantineEntry } from "./ci-browser-quarantine.ts";

const repo = join(import.meta.dir, "..");
const FAILURE_TAIL_LINES = 400;
const HEARTBEAT_MS = 60_000;
/** The longest run seen on a loaded CI host was about 6 minutes (security-summary, 2026-10-28). */
const DEFAULT_SCRIPT_TIMEOUT_SECONDS = 600;
const STOP_GRACE_MS = 5_000;
const TIMEOUT_TAIL_LINES = 40;
/** The exit code a timed-out script is given, as timeout(1) does. */
export const TIMEOUT_EXIT_CODE = 124;

/** The longest delay setTimeout takes; a longer one fires at once. */
const MAX_TIMEOUT_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

export function scriptTimeoutSeconds(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_SCRIPT_TIMEOUT_SECONDS;
  const seconds = Number(value);
  if (!(Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_TIMEOUT_SECONDS)) throw new Error(`BROWSER_SCRIPT_TIMEOUT_SECONDS must be a positive number of seconds up to ${MAX_TIMEOUT_SECONDS}, not "${value}"`);
  return seconds;
}

export function serialBrowserScripts(source = readFileSync(join(repo, "scripts/ci-browser.sh"), "utf8")): string[] {
  return [...source.matchAll(/^run_script (scripts\/[\w.-]+\.ts)\s*$/gm)].map((match) => match[1]!);
}

const list = (value: string | undefined): string[] => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function selectBrowserScripts(all: string[], include?: string, exclude?: string): string[] {
  const included = include?.trim() ? list(include) : all;
  const excluded = list(exclude);
  const unknown = [...included, ...excluded].filter((script) => !all.includes(script));
  if (unknown.length > 0) throw new Error(`Not in scripts/ci-browser.sh: ${[...new Set(unknown)].join(", ")}`);
  return [...new Set(included)].filter((script) => !excluded.includes(script));
}

function mostFirst(scripts: string[], seconds: (script: string) => number): string[] {
  return scripts.map((script, index) => ({ script, index, seconds: seconds(script) }))
    .sort((a, b) => (a.seconds === b.seconds ? 0 : b.seconds - a.seconds) || a.index - b.index)
    .map(({ script }) => script);
}

export function longestFirst(scripts: string[], timings: Record<string, number>): string[] {
  return mostFirst(scripts, (script) => Number.isFinite(timings[script]) ? timings[script]! : Infinity);
}

function timingEstimate(timings: Record<string, number>): (script: string) => number {
  const known = Object.values(timings).filter((seconds) => Number.isFinite(seconds)).sort((a, b) => a - b);
  const middle = Math.floor(known.length / 2);
  const typical = known.length === 0 ? 0 : known.length % 2 === 1 ? known[middle]! : (known[middle - 1]! + known[middle]!) / 2;
  return (script) => Number.isFinite(timings[script]) ? timings[script]! : typical;
}

/**
 * Longest first by `timings`, each script goes to the shard with the least estimated time so far
 * (at least a second a script, so an empty table still deals them out in turn), so the shards end
 * near the same time.
 */
export function shardScripts(scripts: string[], timings: Record<string, number>, shard: string | undefined): string[] {
  if (shard === undefined || shard.trim() === "") return scripts;
  const match = shard.trim().match(/^(\d+)\/(\d+)$/);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || !(total >= 1 && index >= 1 && index <= total)) throw new Error(`BROWSER_SHARD must be "k/n" with 1 <= k <= n, not "${shard}"`);
  const estimate = timingEstimate(timings);
  const loads = new Array<number>(total).fill(0);
  const mine = new Set<string>();
  for (const script of mostFirst(scripts, estimate)) {
    const target = loads.indexOf(Math.min(...loads));
    loads[target]! += Math.max(estimate(script), 1);
    if (target === index - 1) mine.add(script);
  }
  return scripts.filter((script) => mine.has(script));
}

function readTimings(): Record<string, number> {
  try {
    const table: unknown = JSON.parse(readFileSync(join(repo, "scripts/ci-browser-timings.json"), "utf8"));
    if (table === null || typeof table !== "object" || Array.isArray(table)) throw new Error("not an object of script seconds");
    return table as Record<string, number>;
  } catch (error) {
    console.log(`[setup] No script timings (${(error as Error).message}): scripts start in ci-browser.sh's order`);
    return {};
  }
}

interface ScriptResult {
  script: string;
  seconds: number;
  code: number;
  log: string;
  firstLog?: string;
  site?: string;
  message?: string;
  stopped?: boolean;
  stop?: StopOutcome;
}

/**
 * Where a script's log says it failed: the first error line, and the first stack frame after it
 * that is one of this repository's scripts (a Playwright error's own frames come before it).
 * Either is null when the log does not hold it.
 */
export function failureSite(log: string): { site: string | null; message: string | null } {
  const lines = log.split(/\r?\n/).map((line) => line.replace(/^\[[^\]]+\] /, ""));
  const index = lines.findIndex((line) => /^\s*[A-Za-z_$][\w.$]*Error:/.test(line));
  if (index < 0) return { site: null, message: null };
  const message = lines[index]?.trim() ?? null;
  for (const line of lines.slice(index + 1)) {
    if (!/^\s*at\s/.test(line) || line.includes("node_modules")) continue;
    const match = line.match(/\/(scripts\/[\w.-]+\.ts:\d+)(?=[:)\s]|$)/);
    if (match) return { site: match[1] ?? null, message };
  }
  return { site: null, message };
}

const failureDetail = (result: ScriptResult): string =>
  [result.site, result.stop ? stopReport(result.message!, result.stop) : result.message].filter(Boolean).join(": ");

const workflowData = (message: string): string =>
  message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

export function scriptOutcome(code: number, secondRun: boolean): "pass" | "flaky" | "fail" {
  if (code !== 0) return "fail";
  return secondRun ? "flaky" : "pass";
}

export type QuarantineStatus =
  | { readonly state: "quarantined"; readonly entry: QuarantineEntry }
  | { readonly state: "ended"; readonly entry: QuarantineEntry }
  | { readonly state: "unlisted" };

/** `today` is a UTC date, YYYY-MM-DD; an entry still holds on its end date. */
export function quarantineStatus(script: string, list: Readonly<Record<string, QuarantineEntry>>, today: string): QuarantineStatus {
  const entry = list[script];
  if (entry === undefined) return { state: "unlisted" };
  return today <= entry.until ? { state: "quarantined", entry } : { state: "ended", entry };
}

export function quarantineNote(status: QuarantineStatus): string {
  if (status.state === "quarantined") return `It is quarantined until ${status.entry.until} (#${status.entry.issue}), so it does not fail the lane.`;
  if (status.state === "ended") return `Its quarantine ran out after ${status.entry.until}, so it fails the lane: fix the race in the script or the app, or move its end date in QUARANTINE in scripts/ci-browser-quarantine.ts, at most ${QUARANTINE_MAX_DAYS} days ahead.`;
  return `It is not quarantined, so it fails the lane: fix the race in the script or the app, or give it an entry in QUARANTINE in scripts/ci-browser-quarantine.ts with an issue about it and an end date at most ${QUARANTINE_MAX_DAYS} days ahead.`;
}

class ChromiumSetupError extends Error {
  constructor(readonly exitCode: number) {
    super(`Chromium setup failed with exit code ${exitCode}`);
  }
}

function installChromium(): string {
  const setup = Bun.spawnSync(["bash", "scripts/ci-chromium.sh"], {
    cwd: repo,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  if (setup.exitCode !== 0) throw new ChromiumSetupError(setup.exitCode ?? 1);
  const path = setup.stdout.toString().replace(/\r?\n$/, "");
  if (!path || path.includes("\n")) throw new Error("Chromium setup returned an invalid executable path");
  return path;
}

async function buildDemo(dir: string): Promise<void> {
  console.log("[setup] Building demo app...");
  const started = Date.now();
  const child = Bun.spawn(["bun", "scripts/demo-build.ts", dir], { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Demo build failed:\n${stdout}\n${stderr}`);
  console.log(`[setup] Demo build completed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function timestampLog(stream: ReadableStream<Uint8Array>, log: string): Promise<void> {
  let partial = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const lines = (partial + decoder.decode(chunk, { stream: true })).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) appendFileSync(log, `[${new Date().toISOString()}] ${line}\n`);
  }
  partial += decoder.decode();
  if (partial) appendFileSync(log, `[${new Date().toISOString()}] ${partial}\n`);
}

/** The variable every process of one script run inherits, so a process its parent left behind is still found. */
const RUN_MARK = "CI_BROWSER_PARALLEL_RUN";

/**
 * The processes of one run: on Linux every process whose environment carries the run's mark, which
 * also finds one whose parent exited and that was moved to init; and, while the script itself has
 * not exited (after that its pid may belong to another process), the script and its tree in `ps`
 * (Chromium and the servers a script starts are its children's children).
 */
async function runProcesses(child: { pid: number; exitCode: number | null; signalCode: string | null }, mark: string): Promise<number[]> {
  const running = () => child.exitCode === null && child.signalCode === null;
  const tree = running() ? [child.pid, ...(await descendants(child.pid))] : [];
  const found = new Set(running() ? tree : []);
  let entries: string[] = [];
  try { entries = readdirSync("/proc"); } catch { /* no /proc: the ps tree is all there is */ }
  for (const entry of entries) {
    if (/^\d+$/.test(entry) && carriesMark(Number(entry), mark)) found.add(Number(entry));
  }
  found.delete(process.pid);
  return [...found];
}

/** Whether `pid`'s environment carries the run's mark now; false for a process gone, another user's or without it. */
function carriesMark(pid: number, mark: string): boolean {
  try { return readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(`${RUN_MARK}=${mark}`); } catch { return false; }
}

async function descendants(root: number): Promise<number[]> {
  let table = "";
  try {
    const ps = Bun.spawn(["ps", "-A", "-o", "pid=,ppid="], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    [table] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
  } catch { return []; }
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const next = [root];
  while (next.length > 0) {
    for (const pid of children.get(next.pop()!) ?? []) { found.push(pid); next.push(pid); }
  }
  return found;
}

/** Signals `pids`; resolves with those the system refused (EPERM), which are not known to have stopped. */
const signal = (pids: number[], name: NodeJS.Signals): number[] => {
  const refused: number[] = [];
  for (const pid of pids) {
    try { process.kill(pid, name); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") refused.push(pid);
    }
  }
  return refused;
};

function within(done: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    done.then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export interface StopIo {
  processes(): Promise<number[]>;
  /** Sends `name` to `pids`; returns the ones the system refused (EPERM), which are not known to have stopped. */
  signal(pids: number[], name: NodeJS.Signals): number[];
  running(pid: number): boolean;
  /** Whether `pid` still carries this run's mark, read now: a pid found a moment ago may have been freed and reused. */
  marked(pid: number): boolean;
  command(pid: number): string;
  now(): number;
  graceMs: number;
}

const SURVIVOR_LIMIT = 20;

export interface StopOutcome {
  stopped: number;
  /** the processes it could not stop, as `<pid> (<program name>)` or `<pid>` alone: nothing of a command line is ever printed */
  survivors: string[];
  unsure: boolean;
}

/**
 * Stops what is left of a run: SIGTERM, which lets Playwright close its browser, then, once the
 * run has ended or the grace is over, SIGKILL for whatever is still there, such as a child that
 * ignores SIGTERM and writes elsewhere. The processes are read again before each signal, so a pid
 * freed since is not signalled (on Linux the mark is checked on the process itself). A killed
 * process ends when the kernel next runs it, which on a loaded machine is not at once, so it waits
 * one more grace for them to go, reading the run's processes again and killing any that appeared
 * since (a child forked while SIGKILL was landing), each only if its mark is still there just before
 * the signal; one that is not marked is not signalled, and is named as not stopped only if it still
 * runs at the last look (a short-lived process ends by itself between the read and the check). A
 * process that refused a signal (permission denied is not a stop) stays named even when a later read
 * no longer finds it. At most SURVIVOR_LIMIT are named, then "and N more". Resolves with what it
 * saw, not with a promise that nothing is left.
 */
export async function stopRun(io: StopIo, finished: Promise<unknown>): Promise<StopOutcome> {
  const seen = new Set<number>();
  // refused a signal: not known to have stopped, named whatever a later look finds
  const refused = new Set<number>();
  // found without the run's mark, so never signalled: named if it still runs at the last look
  const unmarked = new Set<number>();
  const send = (pids: number[], name: NodeJS.Signals): void => {
    for (const pid of pids) seen.add(pid);
    for (const pid of io.signal(pids, name)) refused.add(pid);
  };
  const outcome = (left: number[], unsure: boolean): StopOutcome => {
    const stillUnmarked = [...unmarked].filter(io.running);
    const named = [...new Set([...left.filter(io.running), ...refused, ...stillUnmarked])];
    const listed = named.slice(0, SURVIVOR_LIMIT).map((pid) => { const name = io.command(pid); return name === "" ? `${pid}` : `${pid} (${name})`; });
    if (named.length > SURVIVOR_LIMIT) listed.push(`and ${named.length - SURVIVOR_LIMIT} more`);
    return { stopped: Math.max(0, seen.size - named.length), survivors: listed, unsure: unsure || refused.size > 0 || stillUnmarked.length > 0 };
  };
  send(await io.processes(), "SIGTERM");
  await within(finished, io.graceMs);
  const first = await io.processes();
  if (first.length === 0 && refused.size === 0) return outcome([], false);
  send(first, "SIGKILL");
  await within(finished, io.graceMs);
  const killed = new Set(first);
  const deadline = io.now() + io.graceMs;
  for (;;) {
    const left = await io.processes();
    const fresh = left.filter((pid) => !killed.has(pid));
    for (const pid of fresh) { seen.add(pid); killed.add(pid); }
    // the mark is read again right before the signal: a pid freed and reused since the read is not ours to kill
    const ours = fresh.filter((pid) => io.marked(pid));
    for (const pid of fresh) if (!ours.includes(pid)) unmarked.add(pid);
    send(ours, "SIGKILL");
    const done = outcome(left, fresh.length > 0);
    if (io.now() >= deadline || (fresh.length === 0 && done.survivors.length === 0)) return done;
    if (fresh.length === 0) await Bun.sleep(25);
  }
}

/** Whether `pid` still runs; a zombie, ended but not yet reaped by its parent, does not, and a refused check (EPERM) is no proof of a stop. */
function running(pid: number): boolean {
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "")[0] !== "Z"; } catch { return true; }
}

const NAME_LIMIT = 64;

/**
 * The name of the program a process runs, from the path of its executable: the file's own name,
 * cut to the characters a program name has and to a short length. Nothing else about a process is
 * printed, and not argv[0], which a process sets to anything it likes (a credential, a URL): the
 * report goes into public logs and issues.
 */
export function programName(executable: string): string {
  const path = executable.replace(/ \(deleted\)$/, "");
  return path.slice(path.lastIndexOf("/") + 1).replace(/[^A-Za-z0-9._+-]/g, "?").slice(0, NAME_LIMIT);
}

/** A process's program name from /proc/<pid>/exe; empty where the link cannot be read (another user's process, no /proc): the report then names the pid alone. */
export function processName(pid: number): string {
  try { return programName(readlinkSync(`/proc/${pid}/exe`)); } catch { return ""; }
}

export function stopReport(message: string, { stopped, survivors, unsure }: StopOutcome): string {
  return [
    `${message}; stopped ${stopped} process${stopped === 1 ? "" : "es"}`,
    survivors.length ? `; could NOT stop: ${survivors.join("; ")}` : "",
    unsure ? "; processes started at the last moment may not be listed" : "",
    ".",
  ].join("");
}

async function runScript(script: string, env: Record<string, string>, log: string, timeoutSeconds: number): Promise<ScriptResult> {
  const started = Date.now();
  writeFileSync(log, "");
  const mark = `${process.pid}-${crypto.randomUUID()}`;
  const child = Bun.spawn(["bun", script], {
    cwd: repo,
    env: { ...process.env, ...env, [RUN_MARK]: mark },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const heartbeat = setInterval(() => {
    console.log(`[running] ${script} (${Math.round((Date.now() - started) / 1000)}s, log ${log})`);
  }, HEARTBEAT_MS);
  const drained = Promise.all([timestampLog(child.stdout, log), timestampLog(child.stderr, log)]);
  const finished = Promise.all([child.exited, drained]);
  const io: StopIo = { processes: () => runProcesses(child, mark), signal, running, marked: (pid) => carriesMark(pid, mark), command: processName, now: Date.now, graceMs: STOP_GRACE_MS };
  const stopped = (code: number, message: string, stop: StopOutcome): ScriptResult => {
    appendFileSync(log, `[${new Date().toISOString()}] ${stopReport(message, stop)}\n`);
    return { script, seconds: (Date.now() - started) / 1000, code, log, message, stopped: true, stop };
  };
  try {
    if (!(await within(child.exited, timeoutSeconds * 1000))) {
      return stopped(TIMEOUT_EXIT_CODE, `Timed out after ${timeoutSeconds}s`, await stopRun(io, finished));
    }
    const code = await child.exited;
    // A script's output ends with it, unless a process it started is still holding it open.
    if (await within(drained, STOP_GRACE_MS)) return { script, seconds: (Date.now() - started) / 1000, code, log };
    return stopped(code || 1, `Exited ${code}, but a process it started still held its output`, await stopRun(io, drained));
  } finally {
    clearInterval(heartbeat);
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const timings = readTimings();
  const shard = process.env.BROWSER_SHARD?.trim();
  const scripts = shardScripts(selectBrowserScripts(serialBrowserScripts(), process.env.BROWSER_SCRIPTS, process.env.BROWSER_EXCLUDE), timings, shard);
  if (scripts.length === 0) throw new Error("No browser scripts selected");

  const requested = Number(process.env.BROWSER_WORKERS);
  const workers = Math.max(1, Math.min(
    requested >= 1 ? Math.floor(requested) : Math.min(Math.floor(availableParallelism() / 2), 6),
    scripts.length
  ));
  const logDir = join(process.env.CHECK_DIR || ".ci", "browser-logs");
  mkdirSync(logDir, { recursive: true });

  console.log(`Browser lane: ${scripts.length} scripts${shard ? ` (shard ${shard})` : ""}, ${workers} workers, logs in ${logDir}`);

  const chromePath = installChromium();
  const demoBuild = mkdtempSync(join(tmpdir(), "herdr-demo-parallel-"));
  await buildDemo(demoBuild);

  const checkDir = process.env.CHECK_DIR;
  const baseEvidenceDir = checkDir ? join(checkDir, "browser-evidence") : process.env.CI ? ".ci/browser-evidence" : undefined;
  if (baseEvidenceDir) mkdirSync(baseEvidenceDir, { recursive: true });

  const retry = process.env.BROWSER_RETRY !== "0";
  const today = new Date().toISOString().slice(0, 10);
  const quarantine = (script: string): QuarantineStatus => quarantineStatus(script, QUARANTINE, today);
  const timeoutSeconds = scriptTimeoutSeconds(process.env.BROWSER_SCRIPT_TIMEOUT_SECONDS);
  const queue = process.env.BROWSER_ORDER === "listed" ? [...scripts] : longestFirst(scripts, timings);
  const untimed = scripts.filter((script) => !Number.isFinite(timings[script]));
  if (process.env.BROWSER_ORDER !== "listed" && Object.keys(timings).length > 0 && untimed.length > 0) {
    console.log(`[setup] Not in scripts/ci-browser-timings.json yet, so started first: ${untimed.join(", ")}`);
  }
  const results: ScriptResult[] = [];
  const lock = { active: 0 };

  async function work(workerId: number): Promise<void> {
    while (queue.length > 0) {
      const script = queue.shift();
      if (!script) break;
      lock.active++;
      const scriptName = basename(script, ".ts");
      const evidenceDir = baseEvidenceDir ? join(baseEvidenceDir, scriptName) : undefined;
      if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

      const shouldDisableEvidence = baseEvidenceDir && (
        script === "scripts/ui-regression.ts" ||
        script === "scripts/ui-terminal-regression.ts" ||
        script === "scripts/ui-ime-regression.ts" ||
        script === "scripts/ui-access-regression.ts" ||
        script === "scripts/ui-contexts-regression.ts" ||
        script === "scripts/ui-contexts-layout-regression.ts" ||
        script === "scripts/key-bar-customization-demo-regression.ts"
      );

      const log = join(logDir, `${scriptName}.log`);
      const env = {
        CHROME_PATH: chromePath,
        HERDR_DEMO_BUILD: demoBuild,
        UI_EVIDENCE_DIR: shouldDisableEvidence ? "" : (evidenceDir ?? ""),
        CHECK_BROWSER_EVIDENCE_DIR: evidenceDir ?? "",
      };
      console.log(`[worker-${workerId}] START ${script}`);
      let result = await runScript(script, env, log, timeoutSeconds);
      // A run that had to be stopped is not run again: a second hang would cost the same bound once more.
      if (result.code !== 0 && retry && !result.stopped) {
        const firstLog = join(logDir, `${scriptName}.attempt-1.log`);
        renameSync(log, firstLog);
        console.log(`[worker-${workerId}] FAIL ${script} (${result.seconds.toFixed(1)}s) exit=${result.code}, log ${firstLog}; running it once more`);
        const second = await runScript(script, env, log, timeoutSeconds);
        result = { ...second, seconds: result.seconds + second.seconds, firstLog };
      }
      if (result.stopped) {
        // Said now, not only in the summary: a hang is what the job's own timeout would otherwise end.
        const lines = readFileSync(log, "utf8").trimEnd().split("\n");
        const kind = result.code === TIMEOUT_EXIT_CODE ? "TIMEOUT" : "STOPPED";
        console.log(`[worker-${workerId}] ${kind} ${script}: ${stopReport(result.message!, result.stop!)} Last ${Math.min(lines.length, TIMEOUT_TAIL_LINES)} lines of ${log}:`);
        console.log(lines.slice(-TIMEOUT_TAIL_LINES).join("\n"));
      }
      const outcome = scriptOutcome(result.code, result.firstLog !== undefined);
      if (outcome !== "pass" && !result.stopped) {
        const { site, message } = failureSite(readFileSync(outcome === "flaky" ? result.firstLog! : result.log, "utf8"));
        if (site) result.site = site;
        if (message) result.message = message;
      }
      results.push(result);
      const failure = outcome === "fail" ? ` exit=${result.code}, log ${log}`
        : outcome === "flaky" ? `, failed once: ${result.firstLog}; ${quarantine(script).state === "quarantined" ? "quarantined" : "not quarantined, so the lane fails"}` : "";
      console.log(`[worker-${workerId}] ${outcome.toUpperCase()} ${script} (${result.seconds.toFixed(1)}s)${failure}`);
      lock.active--;
    }
  }

  await Promise.all(Array.from({ length: workers }, (_, i) => work(i)));

  rmSync(demoBuild, { recursive: true, force: true });

  console.log("\n" + "=".repeat(80));
  console.log("Browser script summary");
  console.log("=".repeat(80));
  console.log(String.prototype.padEnd.call("script", 60) + String.prototype.padStart.call("seconds", 8) + String.prototype.padStart.call("exit", 6));
  console.log("-".repeat(80));

  const ordered = scripts.map((s) => results.find((r) => r.script === s)!).filter(Boolean);
  const flaky = ordered.filter((r) => scriptOutcome(r.code, r.firstLog !== undefined) === "flaky");
  const unexcused = flaky.filter((r) => quarantine(r.script).state !== "quarantined");
  for (const result of ordered) {
    const outcome = scriptOutcome(result.code, result.firstLog !== undefined);
    const status = outcome === "flaky" && unexcused.includes(result) ? "!" : { pass: " ", flaky: "~", fail: "!" }[outcome];
    console.log(`${status}${result.script.padEnd(59)}${result.seconds.toFixed(1).padStart(8)}${String(result.code).padStart(6)}`);
  }

  const totalSeconds = (Date.now() - startedAt) / 1000;
  const passed = results.filter((r) => r.code === 0).length;
  const failed = results.filter((r) => r.code !== 0);

  console.log("-".repeat(80));
  const flakyNote = flaky.length === 0 ? "" : `, ${flaky.length} only on a second run (~)${unexcused.length > 0 ? `, ${unexcused.length} of them not quarantined (!), which fails the lane` : ""}`;
  console.log(`Total: ${passed}/${results.length} passed in ${totalSeconds.toFixed(1)}s with ${workers} workers${flakyNote}`);

  writeFileSync(join(logDir, "summary.json"), JSON.stringify({
    workers,
    seconds: totalSeconds,
    passed,
    total: results.length,
    flaky: flaky.map((r) => r.script),
    notQuarantined: unexcused.map((r) => r.script),
    scripts: ordered.map(({ script, seconds, code, log, firstLog, site, message, stop }) => ({
      script, seconds, code, log, ...(firstLog ? { firstLog } : {}),
      ...(site ? { site } : {}), ...(message ? { message } : {}), ...(stop ? { stop } : {}),
    })),
  }, null, 2) + "\n");

  const tail = (path: string): void => {
    const lines = readFileSync(path, "utf8").split("\n");
    const shown = lines.slice(-FAILURE_TAIL_LINES);
    if (shown.length < lines.length) console.log(`(last ${shown.length} of ${lines.length} lines)`);
    console.log("=".repeat(80));
    console.log(shown.join("\n"));
  };

  for (const result of flaky) {
    const detail = failureDetail(result);
    const status = quarantine(result.script);
    console.log(`\n${"=".repeat(80)}\nFLAKY ${result.script}: failed, then passed when run again; first log: ${result.firstLog}${detail ? `; ${detail}` : ""}. ${quarantineNote(status)}`);
    tail(result.firstLog!);
    const level = status.state === "quarantined" ? "warning" : "error";
    if (process.env.GITHUB_ACTIONS) console.log(`::${level} title=Flaky browser script::${workflowData(`${result.script}${detail ? `: ${detail}` : ""} failed once and passed when run again. Its first log is ${basename(result.firstLog!)} in the browser-logs artifact. ${quarantineNote(status)}`)}`);
  }
  if (flaky.length > 0 && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Flaky browser scripts\n\nFailed once, passed when run again:\n\n${flaky.map((r) => `- \`${r.script}\`${failureDetail(r) ? `: ${failureDetail(r)}` : ""} (first log \`${basename(r.firstLog!)}\`). ${quarantineNote(quarantine(r.script))}`).join("\n")}\n`);
  }

  for (const result of failed) {
    const detail = failureDetail(result);
    console.log(`\n${"=".repeat(80)}\nFAILED ${result.script} (exit ${result.code}${result.firstLog ? ", twice" : ""}), full log: ${result.log}${detail ? `; ${detail}` : ""}`);
    tail(result.log);
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=Browser script failed::${workflowData(`${result.script}${detail ? `: ${detail}` : ""} failed (exit ${result.code}${result.firstLog ? ", twice" : ""}). Full log: ${basename(result.log)} in the browser-logs artifact.`)}`);
  }
  if (failed.length > 0 && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Failed browser scripts\n\n${failed.map((r) => `- \`${r.script}\`${failureDetail(r) ? `: ${failureDetail(r)}` : ""} (full log \`${basename(r.log)}\`)`).join("\n")}\n`);
  }

  process.exit(failed.length > 0 || unexcused.length > 0 ? 1 : 0);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(error instanceof ChromiumSetupError ? error.exitCode : 1);
  });
}
