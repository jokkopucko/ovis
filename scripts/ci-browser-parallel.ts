/**
 * Parallel browser lane: runs browser regression scripts concurrently with a worker pool.
 * Workers are isolated by temp dir and evidence subdirectory. The demo build is shared read-only.
 * The script list is read from scripts/ci-browser.sh, the serial lane, so the two cannot drift.
 * Every script's full output goes to <CHECK_DIR or .ci>/browser-logs/<script>.log.
 *
 * BROWSER_WORKERS: worker count (default: min(cores/2, 6))
 * BROWSER_SCRIPTS: comma-separated list of scripts to run (default: all from ci-browser.sh)
 * BROWSER_EXCLUDE: comma-separated list of scripts to leave out of that list
 * BROWSER_RETRY: 0 runs a failed script once only (default: a failed script runs a second time)
 * BROWSER_ORDER: listed starts the scripts in ci-browser.sh's order (default: the scripts that
 *   scripts/ci-browser-timings.json does not time yet, then the others longest first, so a slow
 *   script never starts last and runs on alone)
 * BROWSER_SHARD: "k/n" runs only shard k of n of the selected scripts, so n jobs split one lane
 *   (default: every selected script)
 * BROWSER_SCRIPT_TIMEOUT_SECONDS: how long one run of a script may take (default 600), so a hung
 *   script fails and names itself instead of using up the job's timeout. At the bound the script's
 *   process tree is stopped, its last log lines are printed at once, and it is not run again.
 *
 * A script that fails and then passes is reported as flaky, not hidden: its first log is kept as
 * <script>.attempt-1.log and printed, summary.json lists it, and under GitHub Actions it gets a
 * warning annotation and a line in the job summary. A script that fails twice fails the lane.
 */
import { availableParallelism } from "node:os";
import { basename, join } from "node:path";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const repo = join(import.meta.dir, "..");
const FAILURE_TAIL_LINES = 400;
const HEARTBEAT_MS = 60_000;
/** The longest run seen on a loaded CI host was about 6 minutes (security-summary, 2026-10-28). */
const DEFAULT_SCRIPT_TIMEOUT_SECONDS = 600;
/** How long a stopped script gets to exit after SIGTERM, and again after SIGKILL. */
const STOP_GRACE_MS = 5_000;
const TIMEOUT_TAIL_LINES = 40;
/** The exit code a timed-out script is given, as timeout(1) does. */
export const TIMEOUT_EXIT_CODE = 124;

/** The longest delay setTimeout takes; a longer one fires at once. */
const MAX_TIMEOUT_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

/** BROWSER_SCRIPT_TIMEOUT_SECONDS: a positive number of seconds up to about 24 days; unset or empty is the default. */
export function scriptTimeoutSeconds(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_SCRIPT_TIMEOUT_SECONDS;
  const seconds = Number(value);
  if (!(Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_TIMEOUT_SECONDS)) throw new Error(`BROWSER_SCRIPT_TIMEOUT_SECONDS must be a positive number of seconds up to ${MAX_TIMEOUT_SECONDS}, not "${value}"`);
  return seconds;
}

/** The scripts the serial lane runs, in its order (the demo build, which takes an argument, is not one). */
export function serialBrowserScripts(source = readFileSync(join(repo, "scripts/ci-browser.sh"), "utf8")): string[] {
  return [...source.matchAll(/^run_script (scripts\/[\w.-]+\.ts)\s*$/gm)].map((match) => match[1]!);
}

const list = (value: string | undefined): string[] => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Applies BROWSER_SCRIPTS and BROWSER_EXCLUDE to the serial list; a name it does not hold is an error. */
export function selectBrowserScripts(all: string[], include?: string, exclude?: string): string[] {
  const included = include?.trim() ? list(include) : all;
  const excluded = list(exclude);
  const unknown = [...included, ...excluded].filter((script) => !all.includes(script));
  if (unknown.length > 0) throw new Error(`Not in scripts/ci-browser.sh: ${[...new Set(unknown)].join(", ")}`);
  return [...new Set(included)].filter((script) => !excluded.includes(script));
}

/** The scripts by `seconds`, most first; the same seconds keep the listed order. */
function mostFirst(scripts: string[], seconds: (script: string) => number): string[] {
  return scripts.map((script, index) => ({ script, index, seconds: seconds(script) }))
    .sort((a, b) => (a.seconds === b.seconds ? 0 : b.seconds - a.seconds) || a.index - b.index)
    .map(({ script }) => script);
}

/**
 * The order the workers take the scripts in. A script `timings` does not hold starts first, in the
 * listed order: nobody has measured it, so it may be the longest, and counted as a typical script
 * it would start late and run on alone after every other worker is done. The scripts the table
 * holds follow, longest first (seconds a script took on CI), so the slow ones start while every
 * worker is still busy and the lane ends with short ones; ties keep the listed order.
 */
export function longestFirst(scripts: string[], timings: Record<string, number>): string[] {
  return mostFirst(scripts, (script) => Number.isFinite(timings[script]) ? timings[script]! : Infinity);
}

/** A script's seconds by `timings`; one the table does not hold counts as the table's median. */
function timingEstimate(timings: Record<string, number>): (script: string) => number {
  const known = Object.values(timings).filter((seconds) => Number.isFinite(seconds)).sort((a, b) => a - b);
  const middle = Math.floor(known.length / 2);
  const typical = known.length === 0 ? 0 : known.length % 2 === 1 ? known[middle]! : (known[middle - 1]! + known[middle]!) / 2;
  return (script) => Number.isFinite(timings[script]) ? timings[script]! : typical;
}

/**
 * BROWSER_SHARD "k/n": the scripts shard k of n runs, in their listed order. Longest first by
 * `timings`, each script goes to the shard with the least estimated time so far (at least a second
 * a script, so an empty table still deals them out in turn), so the shards end near the same time.
 * A script the table does not hold counts here as the table's median, the best guess at its share
 * of a shard's load (within its shard it still starts first). Every job computes the same split
 * from the same table and list. Unset or empty keeps every script.
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
  /** the log of the run that failed before this one passed or failed again */
  firstLog?: string;
  site?: string;
  message?: string;
  /** the run was stopped at its deadline */
  stopped?: boolean;
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
  [result.site, result.message].filter(Boolean).join(": ");

const workflowData = (message: string): string =>
  message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

/** How a script ended, from its last exit code and whether that was its second run: a pass after a failure is flaky, never a plain pass. */
export function scriptOutcome(code: number, secondRun: boolean): "pass" | "flaky" | "fail" {
  if (code !== 0) return "fail";
  return secondRun ? "flaky" : "pass";
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
  const wanted = `${RUN_MARK}=${mark}`;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/environ`, "latin1").split("\0").includes(wanted)) found.add(Number(entry));
    } catch { /* gone, or another user's */ }
  }
  found.delete(process.pid);
  return [...found];
}

/** Every process below `root`, from `ps`; none when `ps` cannot run. */
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

const signal = (pids: number[], name: NodeJS.Signals): void => {
  for (const pid of pids) {
    try { process.kill(pid, name); } catch { /* already gone */ }
  }
};

/** Resolves true when `done` settles within `ms`, false at the bound. */
function within(done: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    done.then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Stops what is left of a run: SIGTERM, which lets Playwright close its browser, then, once the
 * run has ended or the grace is over, SIGKILL for whatever is still there, such as a child that
 * ignores SIGTERM and writes elsewhere. The processes are read again before each signal, so a pid
 * freed since is not signalled (on Linux the mark is checked on the process itself).
 */
async function stopRun(child: Parameters<typeof runProcesses>[0], mark: string, finished: Promise<unknown>): Promise<void> {
  signal(await runProcesses(child, mark), "SIGTERM");
  await within(finished, STOP_GRACE_MS);
  const left = await runProcesses(child, mark);
  if (left.length === 0) return;
  signal(left, "SIGKILL");
  await within(finished, STOP_GRACE_MS);
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
  // A hung script shows up as a repeated line instead of silence.
  const heartbeat = setInterval(() => {
    console.log(`[running] ${script} (${Math.round((Date.now() - started) / 1000)}s, log ${log})`);
  }, HEARTBEAT_MS);
  // The run ends when the script has exited and its output is read.
  const drained = Promise.all([timestampLog(child.stdout, log), timestampLog(child.stderr, log)]);
  const finished = Promise.all([child.exited, drained]);
  const stopped = (code: number, message: string): ScriptResult => {
    appendFileSync(log, `[${new Date().toISOString()}] ${message}: stopped by scripts/ci-browser-parallel.ts\n`);
    return { script, seconds: (Date.now() - started) / 1000, code, log, message, stopped: true };
  };
  try {
    if (!(await within(child.exited, timeoutSeconds * 1000))) {
      await stopRun(child, mark, finished);
      return stopped(TIMEOUT_EXIT_CODE, `Timed out after ${timeoutSeconds}s`);
    }
    const code = await child.exited;
    // A script's output ends with it, unless a process it started is still holding it open.
    if (await within(drained, STOP_GRACE_MS)) return { script, seconds: (Date.now() - started) / 1000, code, log };
    await stopRun(child, mark, drained);
    return stopped(code || 1, `Exited ${code}, but a process it started still held its output`);
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
  const timeoutSeconds = scriptTimeoutSeconds(process.env.BROWSER_SCRIPT_TIMEOUT_SECONDS);
  const queue = process.env.BROWSER_ORDER === "listed" ? [...scripts] : longestFirst(scripts, timings);
  const untimed = scripts.filter((script) => !Number.isFinite(timings[script]));
  // Said in every job's log, so a table that has fallen behind the list is seen and refreshed.
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
        console.log(`[worker-${workerId}] ${kind} ${script}: ${result.message}; what it started was stopped. Last ${Math.min(lines.length, TIMEOUT_TAIL_LINES)} lines of ${log}:`);
        console.log(lines.slice(-TIMEOUT_TAIL_LINES).join("\n"));
      }
      const outcome = scriptOutcome(result.code, result.firstLog !== undefined);
      // A stopped run already says why in its message; its first run's log, if it had one, is kept.
      if (outcome !== "pass" && !result.stopped) {
        const { site, message } = failureSite(readFileSync(outcome === "flaky" ? result.firstLog! : result.log, "utf8"));
        if (site) result.site = site;
        if (message) result.message = message;
      }
      results.push(result);
      const failure = outcome === "fail" ? ` exit=${result.code}, log ${log}` : outcome === "flaky" ? `, failed once: ${result.firstLog}` : "";
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
  for (const result of ordered) {
    const status = { pass: " ", flaky: "~", fail: "!" }[scriptOutcome(result.code, result.firstLog !== undefined)];
    console.log(`${status}${result.script.padEnd(59)}${result.seconds.toFixed(1).padStart(8)}${String(result.code).padStart(6)}`);
  }

  const totalSeconds = (Date.now() - startedAt) / 1000;
  const passed = results.filter((r) => r.code === 0).length;
  const failed = results.filter((r) => r.code !== 0);
  const flaky = ordered.filter((r) => scriptOutcome(r.code, r.firstLog !== undefined) === "flaky");

  console.log("-".repeat(80));
  console.log(`Total: ${passed}/${results.length} passed in ${totalSeconds.toFixed(1)}s with ${workers} workers${flaky.length > 0 ? `, ${flaky.length} only on a second run (~)` : ""}`);

  writeFileSync(join(logDir, "summary.json"), JSON.stringify({
    workers,
    seconds: totalSeconds,
    passed,
    total: results.length,
    flaky: flaky.map((r) => r.script),
    scripts: ordered.map(({ script, seconds, code, log, firstLog, site, message }) => ({
      script, seconds, code, log, ...(firstLog ? { firstLog } : {}),
      ...(site ? { site } : {}), ...(message ? { message } : {}),
    })),
  }, null, 2) + "\n");

  const tail = (path: string): void => {
    const lines = readFileSync(path, "utf8").split("\n");
    const shown = lines.slice(-FAILURE_TAIL_LINES);
    if (shown.length < lines.length) console.log(`(last ${shown.length} of ${lines.length} lines)`);
    console.log("=".repeat(80));
    console.log(shown.join("\n"));
  };

  // A pass on the second run is still a failure somebody has to read: say so where a green job is looked at.
  for (const result of flaky) {
    const detail = failureDetail(result);
    console.log(`\n${"=".repeat(80)}\nFLAKY ${result.script}: failed, then passed when run again; first log: ${result.firstLog}${detail ? `; ${detail}` : ""}`);
    tail(result.firstLog!);
    if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Flaky browser script::${workflowData(`${result.script}${detail ? `: ${detail}` : ""} failed once and passed when run again. Its first log is ${basename(result.firstLog!)} in the browser-logs artifact.`)}`);
  }
  if (flaky.length > 0 && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Flaky browser scripts\n\nFailed once, passed when run again:\n\n${flaky.map((r) => `- \`${r.script}\`${failureDetail(r) ? `: ${failureDetail(r)}` : ""} (first log \`${basename(r.firstLog!)}\`)`).join("\n")}\n`);
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

  process.exit(failed.length > 0 ? 1 : 0);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(error instanceof ChromiumSetupError ? error.exitCode : 1);
  });
}
