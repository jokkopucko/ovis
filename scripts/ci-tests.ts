/**
 * Every test belongs to one suite; newly added unit tests are picked up automatically.
 *
 * The unit suite runs its files in parallel processes: UNIT_TEST_WORKERS sets the count
 * (default: min(cores/2, 8) locally, 2-4 in CI). Files run independently with no shared
 * state; each process gets a subset balanced by file size. Each file runs in a process group of
 * its own: a test that signals its own group (kill(0), kill(-pgid)) ends only its file, which then
 * fails by that signal, instead of the whole run, which `bun run check` runs in one group and
 * which would otherwise end with no failure named. What a file leaves running is ended with it.
 *
 * The integration suite runs its files side by side: a few workers take files off one
 * queue, each worker on a herdr session of its own (`<session>-<n>`), so no two files
 * ever share a herdr, and none shares the plain `<session>` with the browser scripts.
 * HERDR_TEST_SHARDS sets the worker count; 1 is the old serial run.
 */
import { availableParallelism } from "node:os";

const suite = process.argv[2];
if (suite !== "unit" && suite !== "integration") throw new Error("Usage: bun scripts/ci-tests.ts unit|integration");
const files = [...new Bun.Glob("{src,shared,server,scripts,telemetry,push-relay,relay,integrations}/**/*.test.{ts,tsx}").scanSync({ cwd: process.cwd() })].sort();
// The legacy updater suite mixes Git-only cases with real bridge restart/rollback cases.
const needsHerdr = (file: string) => file.endsWith(".contract.test.ts") || file === "server/updater.test.ts" || file.startsWith("server/herdr/") || file.startsWith("server/pty/");
const selected = files.filter((file) => needsHerdr(file) === (suite === "integration"));
if (!selected.length) throw new Error(`No ${suite} tests found`);
const herdr = process.env["OVIS_HERDR_BIN"] || "herdr";
if (suite === "integration" && !Bun.which(herdr)) {
  throw new Error("Integration tests require herdr on PATH (or OVIS_HERDR_BIN)");
}
if (suite === "integration" && process.env["HERDR_TEST_LIVE"] === "1") {
  throw new Error("CI integration tests must use an isolated herdr session");
}
console.log(`${suite}: ${selected.length} test files`);

if (suite === "unit") {
  const requestedWorkers = Number(process.env["UNIT_TEST_WORKERS"]);
  const isCI = !!process.env["CI"];
  const defaultWorkers = isCI ? 4 : Math.min(Math.floor(availableParallelism() / 2), 8);
  const workers = requestedWorkers >= 1 ? Math.floor(requestedWorkers) : defaultWorkers;
  // Each parallel worker merges a file's stdout and stderr through `sh`; without one (native
  // Windows), the files run serially in one bun process instead.
  const effectiveWorkers = Bun.which("sh") ? Math.min(workers, selected.length) : 1;

  if (effectiveWorkers <= 1) {
    const child = Bun.spawn([process.execPath, "test", ...selected.map((file) => `./${file}`)], {
      env: { ...process.env, HERDR_TEST_MODE: suite },
      windowsHide: true, stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
    process.exit(await child.exited);
  }

  console.log(`Running with ${effectiveWorkers} parallel workers`);
  const queue = [...selected].sort((a, b) => Bun.file(b).size - Bun.file(a).size);
  const totals = { pass: 0, fail: 0, skip: 0 };
  const failed: string[] = [];
  const unread: string[] = [];
  const startedAt = Date.now();
  // The files' groups are not this process's: a Ctrl+C, or check.ts ending its step, reaches only
  // this one, and check.ts cannot reach them either. It passes the signal on to every file still
  // running, gives them a moment to end, then kills whatever is left in their groups, and only
  // then ends itself.
  const running = new Map<number, Promise<number>>();
  let stopping = false;
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      // no file starts after this
      queue.length = 0;
      const groups = [...running];
      for (const [group] of groups) try { process.kill(-group, signal); } catch { /* already gone */ }
      let grace: ReturnType<typeof setTimeout> | undefined;
      void Promise.race([
        Promise.all(groups.map(([, exited]) => exited)),
        new Promise((resolve) => { grace = setTimeout(resolve, 5_000); }),
      ]).then(() => {
        clearTimeout(grace);
        for (const [group] of groups) try { process.kill(-group, "SIGKILL"); } catch { /* already gone */ }
        process.exit(code);
      });
    });
  }

  async function unitWork(workerId: number): Promise<void> {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const fileStartedAt = Date.now();
      const child = Bun.spawn(["sh", "-c", 'exec "$@" 2>&1', "sh", process.execPath, "test", "--timeout", "60000", `./${file}`], {
        env: { ...process.env, HERDR_TEST_MODE: suite! },
        // Windows (Git's sh on PATH) has no process groups for the kills below to reach
        stdin: "ignore", stdout: "pipe", stderr: "inherit", detached: process.platform !== "win32",
      });
      running.set(child.pid, child.exited);
      const read = new Response(child.stdout).text();
      const code = await child.exited;
      // what the file left in its group, which may still hold its output open
      let leftover = false;
      try { process.kill(-child.pid, "SIGKILL"); leftover = true; } catch { /* the group is gone */ }
      running.delete(child.pid);
      const output = (await read) + (leftover ? "\nci-tests: ended processes the file left running" : "")
        + (child.signalCode ? `\nci-tests: the file's test process was ended by ${child.signalCode}` : "");
      const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
      const count = (word: keyof typeof totals) => Number(new RegExp(`^\\s*(\\d+) ${word}$`, "m").exec(plain)?.[1] ?? 0);
      for (const word of ["pass", "fail", "skip"] as const) totals[word] += count(word);
      if (!/^\s*\d+ pass$/m.test(plain) && !/^\s*\d+ fail$/m.test(plain)) unread.push(file);
      if (code !== 0) failed.push(file);
      console.log(`\n--- ${file} (worker-${workerId}, ${((Date.now() - fileStartedAt) / 1000).toFixed(1)}s, exit ${code})\n${output.trimEnd()}`);
    }
  }

  await Promise.all(Array.from({ length: effectiveWorkers }, (_, i) => unitWork(i)));
  console.log(`\nunit: ${totals.pass} pass, ${totals.fail} fail, ${totals.skip} skip in ${selected.length} files, ${effectiveWorkers} at a time, ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  for (const file of failed) console.log(`FAILED ${file}`);
  for (const file of unread) console.log(`NO RESULT ${file}`);
  process.exit(failed.length || unread.length ? 1 : 0);
}

const requested = Number(process.env["HERDR_TEST_SHARDS"]);
const shards = Math.min(selected.length, requested >= 1 ? Math.floor(requested) : Math.min(4, availableParallelism()));
const baseSession = process.env["HERDR_TEST_SESSION"] || "ovis-test";
// Always `<session>-<n>`, also for one worker: the plain session belongs to the browser scripts,
// which run beside this suite in CI (scripts/ci-lanes.ts) and must never share a herdr with it.
const sessions = Array.from({ length: shards }, (_, index) => `${baseSession}-${index + 1}`);
// Largest first: the long files are the large ones, and one started last would run on alone.
const queue = [...selected].sort((a, b) => Bun.file(b).size - Bun.file(a).size);
const totals = { pass: 0, fail: 0, skip: 0 };
const failed: string[] = [];
const unread: string[] = [];
const startedAt = Date.now();

async function work(session: string): Promise<void> {
  for (let file = queue.shift(); file; file = queue.shift()) {
    const fileStartedAt = Date.now();
    // Live process/pane probes can poll for 10s; Bun's 5s default would cut them off early.
    // One stream, so a file's output reads in the order it was written.
    // bun colours its counts when anything in the environment asks for colour (FORCE_COLOR
    // outranks NO_COLOR), and a count line then reads `\e[0m\e[32m 13 pass\e[0m` — which the
    // patterns below cannot match. Every file came back unreadable and the run failed with
    // nothing having failed, so the colour is stripped here rather than trusted away.
    const child = Bun.spawn(["sh", "-c", 'exec "$@" 2>&1', "sh", process.execPath, "test", "--timeout", "15000", `./${file}`], {
      env: { ...process.env, HERDR_TEST_MODE: suite!, HERDR_TEST_SESSION: session },
      stdin: "ignore", stdout: "pipe", stderr: "inherit",
    });
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
    const count = (word: keyof typeof totals) => Number(new RegExp(`^\\s*(\\d+) ${word}$`, "m").exec(plain)?.[1] ?? 0);
    for (const word of ["pass", "fail", "skip"] as const) totals[word] += count(word);
    // a run that never printed its counts cannot be told from one that ran nothing
    if (!/^\s*\d+ pass$/m.test(plain) && !/^\s*\d+ fail$/m.test(plain)) unread.push(file);
    if (code !== 0) failed.push(file);
    console.log(`\n--- ${file} (${session}, ${((Date.now() - fileStartedAt) / 1000).toFixed(1)}s, exit ${code})\n${output.trimEnd()}`);
  }
}

await Promise.all(sessions.map(work));
// The sessions `<session>-<n>` exist for this run only.
await Promise.all(sessions.map((session) => Bun.spawn([herdr, "--session", session, "server", "stop"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited));
console.log(`\nintegration: ${totals.pass} pass, ${totals.fail} fail, ${totals.skip} skip in ${selected.length} files, ${shards} at a time, ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
for (const file of failed) console.log(`FAILED ${file}`);
for (const file of unread) console.log(`NO RESULT ${file}`);
process.exit(failed.length || unread.length ? 1 : 0);
