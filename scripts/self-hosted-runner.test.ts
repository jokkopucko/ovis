import { describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./self-hosted-runner/run.sh", import.meta.url));
const jobStarted = fileURLToPath(new URL("./self-hosted-runner/job-started.sh", import.meta.url));

/** Runs the hook as the runner does, under a process named Runner.Worker (a copy of bash) that goes on after it. */
function runJobStarted(eventName: string, payload: unknown, event: { raw?: string; path?: "missing" | "directory" | "unset"; repository?: "unset"; closedOutput?: boolean } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "herdr-runner-hook-test-"));
  try {
    let eventPath: string | undefined = join(tempDir, "event.json");
    writeFileSync(eventPath, event.raw ?? JSON.stringify(payload));
    if (event.path === "missing") eventPath = join(tempDir, "no-such-event.json");
    if (event.path === "directory") eventPath = tempDir;
    if (event.path === "unset") eventPath = undefined;
    const worker = join(tempDir, "Runner.Worker");
    copyFileSync(spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim(), worker);
    chmodSync(worker, 0o755);
    // closedOutput: the hook's stdout and stderr are a pipe nobody reads any more (a FIFO whose only
    // reader is closed before the hook starts), so its first write, even an error message, raises SIGPIPE
    const hook = event.closedOutput
      ? 'mkfifo "$1" && exec 4<>"$1" 5>"$1" 4<&- && bash "$0" >&5 2>&5; echo "next step ran"'
      : 'bash "$0"; echo "next step ran"';
    const result = spawnSync(worker, ["-c", hook, jobStarted, join(tempDir, "output.fifo")], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        PATH: process.env.PATH ?? "",
        GITHUB_EVENT_NAME: eventName,
        ...(event.repository === "unset" ? {} : { GITHUB_REPOSITORY: "devswha/ovis" }),
        ...(eventPath === undefined ? {} : { GITHUB_EVENT_PATH: eventPath }),
      },
    });
    expect(result.error).toBeUndefined();
    return result;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runRunner(options: {
  count?: number;
  ghTokenExitCode?: number;
  dockerExitCode?: number;
  failedSlot?: number;
  /** "present" writes a host env file and passes it, "missing" passes a path that does not exist */
  envFile?: "present" | "missing" | "bare" | "secret" | "nul";
  /** a grep on PATH that fails with a read error (exit 2), as on a file that passes -r but cannot be read */
  grepReadError?: boolean;
  /** more launcher arguments, after --count */
  args?: string[];
  /** XDG_CACHE_HOME for the launcher, kept after the run; a fresh one inside the run's temp dir otherwise */
  cacheHome?: string;
  /** XDG_STATE_HOME for the launcher (the build cache's outboxes), kept after the run; fresh otherwise */
  stateHome?: string;
  gitFetchExitCode?: number;
  /** exit status of the container that builds the Bun cache */
  cacheBuildExitCode?: number;
  /** "fetch" makes the mirror's git fetch, "ls-remote" its default-branch query, "build" the Bun cache build, wait until killed; each writes a byte to the FIFO <tempDir>/hung first */
  hang?: "fetch" | "ls-remote" | "build";
  /** the hung stub ignores SIGTERM, as a git or docker client that will not stop; "helper": the git stub
   * stops, but leaves a child (a transport helper) that ignores it */
  stubborn?: boolean | "helper";
  repo?: string;
  /** what GitHub names as the default branch: a branch, "" for no answer, or "fail" for a failed ls-remote */
  defaultBranch?: string;
  /** branches the mirror holds; main's commit and lock are commitSha and lockBlob, any other branch's otherCommit and otherLock */
  branches?: string[];
} = {}) {
  const { tempDir, args, env, logPath, envFile } = prepareRunner(options);
  try {
    const result = spawnSync("bash", args, { encoding: "utf8", timeout: 10_000, env });
    expect(result.error).toBeUndefined();
    // a launcher that refused its arguments ran no gh or docker command, so wrote no log
    return { result, calls: existsSync(logPath) ? readFileSync(logPath, "utf8") : "", envFile };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

type RunnerOptions = NonNullable<Parameters<typeof runRunner>[0]>;

/**
 * How long a launcher may take to reach its stub's hang, or to end after it, on a loaded host. A
 * bound, not a wait: each wait ends at its event. The hung stub (120 s) outlasts it, so a launcher
 * that waits for the hang still ends late.
 */
const LOADED_BOUND_MS = 30_000;
/** The longest one runRunnerUntilHung call can take: the hang, the end, and its stderr closing. */
const HUNG_RUN_MS = 3 * LOADED_BOUND_MS;
/** A stop "at once": under the 5 s after which run.sh's timeouts kill what ignored the stop. */
const STOP_AT_ONCE_MS = 4_000;

/** Runs `argv` until it ends, or kills it after `ms`: whether it ended by itself with status 0. */
async function endsWithin(argv: string[], ms: number) {
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
  const status = await Promise.race([proc.exited, Bun.sleep(ms).then(() => null)]);
  if (status === null) proc.kill("SIGKILL");
  await proc.exited;
  return status === 0;
}

/**
 * Starts the launcher as runRunner does, waits until its stub hangs (options.hang), then sends it
 * `signal` (none: lets it go on, and lets a runner have its token). Returns how it ended, within
 * `endMs` of the hang.
 */
async function runRunnerUntilHung(options: RunnerOptions & { hang: "fetch" | "ls-remote" | "build" }, signal: NodeJS.Signals | null, endMs = LOADED_BOUND_MS) {
  const { tempDir, args, env, logPath } = prepareRunner(options);
  const child = Bun.spawn(["bash", ...args], { env, stdout: "ignore", stderr: "pipe" });
  // read as it comes: a process left holding stderr must not hold the test past its bound
  const stderrText = new Response(child.stderr).text();
  let release: ReturnType<typeof Bun.spawn> | undefined;
  try {
    // the hanging stub writes a byte to this FIFO as it hangs: reading it blocks until then
    if (!await endsWithin(["head", "-c", "1", env.RUNNER_TEST_HUNG!], LOADED_BOUND_MS)) throw new Error("the stub never hung");
    // the gh stub hands out a token once this FIFO opens: only now, so no runner starts before the hang
    if (!signal) release = Bun.spawn(["sh", "-c", 'echo go > "$0"', env.RUNNER_TEST_TOKEN_GATE!], { stdout: "ignore", stderr: "ignore" });
    if (signal) child.kill(signal);
    const ended = await Promise.race([child.exited, Bun.sleep(endMs).then(() => "still running" as const)]);
    const stuck = spawnSync("pgrep", ["-f", tempDir], { encoding: "utf8" }).stdout.trim();
    return { ended, stderr: await Promise.race([stderrText, Bun.sleep(LOADED_BOUND_MS).then(() => "")]), calls: existsSync(logPath) ? readFileSync(logPath, "utf8") : "", stuck, cacheHome: env.XDG_CACHE_HOME! };
  } finally {
    release?.kill("SIGKILL");
    child.kill("SIGKILL");
    spawnSync("pkill", ["-KILL", "-f", tempDir]);
    await child.exited;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function prepareRunner(options: RunnerOptions) {
  const tempDir = mkdtempSync(join(tmpdir(), "herdr-self-hosted-runner-test-"));
  const binDir = join(tempDir, "bin");
  const logPath = join(tempDir, "commands.log");
  const path = [binDir, process.env.PATH].filter(Boolean).join(delimiter);

  {
    mkdirSync(binDir);
    writeFileSync(join(binDir, "gh"), `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$RUNNER_TEST_LOG"
case " $* " in
  *registration-token*)
    # a refresh set to hang hangs before any runner starts, however soon --cache-wait runs out: the
    # test opens this FIFO once it has seen the hang
    if [ -n "\${RUNNER_TEST_TOKEN_GATE:-}" ]; then read -r go < "$RUNNER_TEST_TOKEN_GATE"; fi
    if [ "\${GH_TOKEN_EXIT_CODE:-0}" -ne 0 ]; then
      exit "$GH_TOKEN_EXIT_CODE"
    fi
    printf '%s\\n' mock-token
    ;;
esac
`);
    // one line per call: the Bun cache build's script spans several
    writeFileSync(join(binDir, "docker"), `#!/bin/sh
printf 'docker %s\\n' "$(printf '%s' "$*" | tr '\\n' ' ')" >> "$RUNNER_TEST_LOG"
case "$1" in
  image) exit 0 ;;
  # a slot's container an earlier launcher left running, while this file exists
  # (its State.Running is the file's content: true while it runs its job, false once it stopped)
  container) [ "$2" = inspect ] && [ -n "\${RUNNER_TEST_SLOT_HELD:-}" ] && [ -e "$RUNNER_TEST_SLOT_HELD" ] && { cat "$RUNNER_TEST_SLOT_HELD"; exit 0; }; exit 1 ;;
  # removing slot 1's own container (the launcher's other docker rm calls name the Bun cache build's)
  rm) for last; do :; done; case "$last" in *-1) [ -n "\${RUNNER_TEST_SLOT_HELD:-}" ] && rm -f "$RUNNER_TEST_SLOT_HELD" ;; esac; exit 0 ;;
  run)
    # docker's own refusal of a CPU list the host does not have
    case " $* " in *" --cpuset-cpus 0-500 "*) echo "docker: Requested CPUs are not available" >&2; exit 125 ;; esac
    # the launcher's check of its CPU list, and the shared network namespace container: neither reads a token
    case " $* " in *" --entrypoint true "*|*" -d "*) exit 0 ;; esac
    shift
    name=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --name ]; then
        name="$2"
        shift 2
      elif [ "$1" = -v ] && [ "\${2%:/cache/bun}" != "$2" ]; then
        touch "\${2%:/cache/bun}/package@1.0.0"
        shift 2
      else
        shift
      fi
    done
    # the Bun cache build (it filled the directory mounted at /cache/bun above) reads no token
    case "$name" in *-cache)
      if [ -n "\${RUNNER_TEST_HANG_BUILD:-}" ]; then
        [ -n "\${RUNNER_TEST_STUBBORN:-}" ] && trap '' TERM
        printf x > "$RUNNER_TEST_HUNG"; exec "$(dirname "$0")/hang-sleep" 120
      fi
      exit "\${DOCKER_CACHE_EXIT:-0}" ;;
    esac
    IFS= read -r token || exit 1
    if [ "\${name##*-}" = "\${DOCKER_FAIL_SLOT:-}" ]; then
      exit "\${DOCKER_EXIT_CODE:-42}"
    fi
    exit 0
    ;;
  *) exit 0 ;;
esac
`);
    // the launcher's git mirror: no network, and HEAD resolves once symbolic-ref has named the branch
    writeFileSync(join(binDir, "git"), `#!/bin/sh
printf 'git %s\\n' "$*" >> "$RUNNER_TEST_LOG"
dir=""
while :; do
  case "$1" in
    -C) dir="$2"; shift 2 ;;
    -c) shift 2 ;;
    *) break ;;
  esac
done
for last; do :; done
case "$1" in
  init) mkdir -p "$last/objects/pack" ;;
  config)
    shift
    [ "$1" = --add ] && shift
    if [ "$#" -ge 2 ]; then printf '%s\\n' "$2" >> "$dir/config.$1"; else head -n 1 "$dir/config.$1" 2>/dev/null; fi ;;
  fetch)
    if [ -n "\${RUNNER_TEST_HANG_FETCH:-}" ]; then
      if [ "\${RUNNER_TEST_STUBBORN:-}" = helper ]; then
        (trap '' TERM; exec "$(dirname "$0")/hang-sleep" 120) &
      elif [ -n "\${RUNNER_TEST_STUBBORN:-}" ]; then
        trap '' TERM
      fi
      printf x > "$RUNNER_TEST_HUNG"; exec "$(dirname "$0")/hang-sleep" 120
    fi
    exit "\${GIT_FETCH_EXIT:-0}" ;;
  ls-remote)
    if [ -n "\${RUNNER_TEST_HANG_LSREMOTE:-}" ]; then
      [ -n "\${RUNNER_TEST_STUBBORN:-}" ] && trap '' TERM
      printf x > "$RUNNER_TEST_HUNG"; exec "$(dirname "$0")/hang-sleep" 120
    fi
    case "$RUNNER_TEST_DEFAULT_BRANCH" in
      fail) exit 128 ;;
      '') ;;
      *) printf 'ref: refs/heads/%s\\tHEAD\\n' "$RUNNER_TEST_DEFAULT_BRANCH" ;;
    esac ;;
  # a new bare repository's HEAD names refs/heads/main (init.defaultBranch), as with real git
  symbolic-ref)
    if [ "$2" = -q ]; then cat "$dir/head" 2>/dev/null || echo refs/heads/main; else printf '%s\\n' "$last" > "$dir/head"; fi ;;
  rev-parse)
    rev="$last"
    case "$rev" in HEAD*) rev="$(cat "$dir/head" 2>/dev/null || echo refs/heads/main)\${rev#HEAD}" ;; esac
    for branch in $RUNNER_TEST_BRANCHES; do
      if [ "$branch" = main ]; then commit=${commitSha} lock=${lockBlob}; else commit=${otherCommit} lock=${otherLock}; fi
      case "$rev" in
        "refs/heads/$branch"|"refs/heads/$branch^{commit}") echo "$commit"; exit 0 ;;
        "refs/heads/$branch:bun.lock") echo "$lock"; exit 0 ;;
      esac
    done
    exit 1 ;;
esac
exit 0
`);
    chmodSync(join(binDir, "gh"), 0o755);
    chmodSync(join(binDir, "docker"), 0o755);
    chmodSync(join(binDir, "git"), 0o755);
    // a sleep named by its path in this run's directory, so a test can find one left running
    copyFileSync(spawnSync("bash", ["-c", "command -v sleep"], { encoding: "utf8" }).stdout.trim(), join(binDir, "hang-sleep"));
    chmodSync(join(binDir, "hang-sleep"), 0o755);
    // FIFOs: the test waits for the hang, and the gh stub for the test, by blocking on them, not polling
    if (options.hang) spawnSync("mkfifo", [join(tempDir, "hung"), join(tempDir, "token-gate")]);
    const envFile = join(tempDir, "host.env");
    if (options.envFile === "present") writeFileSync(envFile, "# P620\n\nCHECK_HOST_MAX_RUNS=6\nCHECK_HOST_BROWSER_WORKERS=10\n");
    if (options.envFile === "bare") writeFileSync(envFile, "CHECK_HOST_MAX_RUNS=6\nGH_TOKEN\n");
    if (options.envFile === "secret") writeFileSync(envFile, "# P620\nCHECK_HOST_MAX_RUNS=6\nGH_TOKEN=ghp_synthetic_secret\n");
    if (options.envFile === "nul") writeFileSync(envFile, "CHECK_HOST_MAX_RUNS=6\nCHECK_HOST_TEST_SHARDS=6\u0000\n");
    if (options.grepReadError) {
      writeFileSync(join(binDir, "grep"), "#!/bin/sh\necho 'grep: read error' >&2\nexit 2\n");
      chmodSync(join(binDir, "grep"), 0o755);
    }

    const args = [
      script,
      "--repo",
      options.repo ?? "owner/repo",
      "--once",
      "--count",
      String(options.count ?? 1),
      ...(options.args ?? []),
      ...(options.envFile ? ["--env-file", envFile] : []),
    ];
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PATH: path,
      RUNNER_TEST_LOG: logPath,
      RUNNER_TEST_HUNG: join(tempDir, "hung"),
      ...(options.hang ? { RUNNER_TEST_TOKEN_GATE: join(tempDir, "token-gate") } : {}),
      ...(options.hang === "fetch" ? { RUNNER_TEST_HANG_FETCH: "1" } : {}),
      ...(options.hang === "build" ? { RUNNER_TEST_HANG_BUILD: "1" } : {}),
      ...(options.hang === "ls-remote" ? { RUNNER_TEST_HANG_LSREMOTE: "1" } : {}),
      ...(options.stubborn ? { RUNNER_TEST_STUBBORN: options.stubborn === "helper" ? "helper" : "1" } : {}),
      RUNNER_TEST_DEFAULT_BRANCH: options.defaultBranch ?? "main",
      RUNNER_TEST_BRANCHES: (options.branches ?? ["main"]).join(" "),
      XDG_CACHE_HOME: options.cacheHome ?? join(tempDir, "cache"),
      XDG_STATE_HOME: options.stateHome ?? join(tempDir, "state"),
      GIT_FETCH_EXIT: String(options.gitFetchExitCode ?? 0),
      DOCKER_CACHE_EXIT: String(options.cacheBuildExitCode ?? 0),
      GH_TOKEN_EXIT_CODE: String(options.ghTokenExitCode ?? 0),
      DOCKER_EXIT_CODE: String(options.dockerExitCode ?? 42),
      DOCKER_FAIL_SLOT: String(options.failedSlot ?? ""),
    };
    return { tempDir, args, env, logPath, envFile };
  }
}

/** A runner container: it reads its registration token on stdin. */
const runnerRun = /^docker run (?:--cpuset-cpus \S+ )?--rm -i /;
/** What the git stub reports for the mirror's default branch and its bun.lock. */
const commitSha = "1".repeat(40);
const lockBlob = "2".repeat(40);
const otherCommit = "3".repeat(40);
const otherLock = "4".repeat(40);
const cacheBuild = /^docker run --rm --init --name herdr-ci-.+-cache /;

describe.skipIf(process.platform === "win32")("self-hosted runner launcher", () => {
  it("runs without CPU or memory quotas by default", () => {
    const { result, calls } = runRunner();
    expect(result.status).toBe(0);
    const dockerRun = calls.split("\n").find((call) => runnerRun.test(call));
    expect(dockerRun).toBeDefined();
    expect(dockerRun).not.toContain("--cpus");
    expect(dockerRun).not.toContain("--memory");
    expect(dockerRun).toContain("--shm-size 2g");
  });

  it("puts each runner container's checkout and /tmp in RAM only when asked", () => {
    const tmpfsCalls = (args: string[]) => {
      const { result, calls } = runRunner({ count: 2, args });
      expect(result.status).toBe(0);
      return calls.split("\n").filter((call) => runnerRun.test(call));
    };
    for (const run of tmpfsCalls([])) expect(run).not.toContain("--tmpfs");
    const runs = tmpfsCalls(["--work-tmpfs", "16g"]);
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      // the runner registers with --work /w as uid 1001 (entrypoint.sh), so the mount must be its own
      expect(run).toContain("--tmpfs /w:rw,exec,nosuid,size=16g,uid=1001,gid=1001,mode=0755");
      expect(run).toContain("--tmpfs /tmp:rw,exec,nosuid,size=16g,mode=1777");
    }
    for (const size of ["16", "0g", "16t", "1,uid=0g", "123456g", "g"]) {
      expect(runRunner({ args: ["--work-tmpfs", size] }).result.status).toBe(2);
    }
  });

  it("turns core dumps off in every runner container, so a crash leaves no file in the checkout", () => {
    const { result, calls } = runRunner({ count: 2 });
    expect(result.status).toBe(0);
    const runs = calls.split("\n").filter((call) => runnerRun.test(call));
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(run).toContain("--ulimit core=0");
  });

  it("hands a host env file to every runner container, never to the network namespace one", () => {
    const { result, calls, envFile } = runRunner({ count: 2, envFile: "present" });
    expect(result.status).toBe(0);
    const lines = calls.split("\n");
    const runners = lines.filter((call) => runnerRun.test(call));
    expect(runners).toHaveLength(2);
    // before the image: after it, docker would take it as the container's command
    for (const call of runners) expect(call).toContain(`--env-file ${envFile} herdr-ci-runner:local`);
    expect(lines.filter((call) => call.startsWith("docker run -d ")).every((call) => !call.includes("--env-file"))).toBe(true);
    expect(runRunner().calls).not.toContain("--env-file");
  });

  it("mounts the build cache read-only in every runner container, with only its own outbox to write", () => {
    const home = mkdtempSync(join(tmpdir(), "herdr-runner-build-cache-test-"));
    try {
      const stateHome = join(home, "state");
      const { result, calls } = runRunner({ count: 2, stateHome, args: ["--build-cache", join(home, "shm"), "--build-cache-writer", "devswha"] });
      expect(result.status).toBe(0);
      const root = join(home, "shm/owner/repo");
      const outboxes = join(stateHome, "ovis-ci-runner/build-outbox/owner/repo");
      const lines = calls.split("\n");
      const host = spawnSync("hostname", ["-s"], { encoding: "utf8" }).stdout.trim();
      const locks = `herdr-ci-${host}-build-cache-locks`;
      expect(lines).toContain(`docker volume create --driver local --opt type=tmpfs --opt device=tmpfs --opt o=size=16m,mode=1777 ${locks}`);
      const runners = lines.filter((call) => runnerRun.test(call));
      expect(runners).toHaveLength(2);
      for (const call of runners) {
        const name = /--name (\S+)/.exec(call)![1]!;
        expect(call).toContain(`-v ${root}/entries:/build-cache:ro -v ${locks}:/build-cache-locks -v ${outboxes}/${name}:/build-cache-outbox `);
        expect(call).toContain("-e OVIS_BUILD_CACHE_DIR=/build-cache -e OVIS_BUILD_CACHE_LOCKS=/build-cache-locks -e OVIS_BUILD_CACHE_OUTBOX=/build-cache-outbox -e OVIS_BUILD_CACHE_WRITER=devswha ");
        // the cache itself is never mounted writable, nor anything under it
        expect(call).not.toMatch(/entries:\/build-cache(?!:ro)/);
        expect(call).not.toContain(`-v ${root}/used`);
      }
      expect(lines.filter((call) => call.startsWith("docker run -d ")).every((call) => !call.includes("build-cache"))).toBe(true);
      const mode = (path: string) => spawnSync("stat", ["-c", "%a", path], { encoding: "utf8" }).stdout.trim();
      const first = join(outboxes, `herdr-ci-${host}-1`);
      expect([mode(join(root, "entries")), mode(join(root, "used")), mode(first)]).toEqual(["755", "755", "1777"]);
      // what the launcher hands a runner for the cache, not the words: the temp directory's own name may hold them
      expect(runRunner().calls).not.toMatch(/:\/build-cache|OVIS_BUILD_CACHE_|build-cache-locks/);
      // what an earlier job left in a directory of its outbox, the host user cannot delete: a container as the runners' user does
      mkdirSync(join(first, "junk"), { recursive: true });
      writeFileSync(join(first, "junk/blob"), "x");
      mkdirSync(join(outboxes, ".taken", "left"), { recursive: true });
      const again = runRunner({ stateHome, args: ["--build-cache", join(home, "shm")] });
      expect(again.calls.split("\n").filter((call) => call.includes(`-v ${first}:/outbox `) && call.includes("--user 1001:1001"))).toHaveLength(1);
      expect(again.calls.split("\n").filter((call) => call.includes(`--cap-add DAC_OVERRIDE --user 0:0 -v ${outboxes}/.taken:/taken `)).length).toBeGreaterThanOrEqual(1);
      // an outbox that cannot be emptied (here: one this user may not write) still holds the earlier job's claim:
      // its runner starts without the build cache, so nothing reads that claim as the new job's
      writeFileSync(join(first, `${"a".repeat(64)}.claim`), "7 1\n");
      chmodSync(first, 0o555);
      try {
        const kept = runRunner({ stateHome, args: ["--build-cache", join(home, "shm")] });
        expect(kept.result.stderr).toContain("its build cache outbox could not be emptied: starting it without the build cache");
        const started = kept.calls.split("\n").filter((call) => call.includes(`--name herdr-ci-${host}-1 `));
        expect(started).toHaveLength(1);
        expect(started[0]).not.toMatch(/:\/build-cache|OVIS_BUILD_CACHE_|build-cache-locks/);
      } finally {
        chmodSync(first, 0o1777);
      }
      for (const mb of ["0", "00", "0000"]) expect(runRunner({ args: ["--build-cache", join(home, "shm"), "--build-cache-mb", mb] }).result.status).toBe(2);
      expect(runRunner({ args: ["--build-cache", join(home, "shm"), "--build-cache-writer", "a b"] }).result.status).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("pins every container it starts to --cpuset-cpus, and none without it", () => {
    const { result, calls } = runRunner({ count: 2, args: ["--cpuset-cpus", "0-95"] });
    expect(result.status).toBe(0);
    const runs = calls.split("\n").filter((call) => call.startsWith("docker run "));
    // the network namespace container (the stub never reports it running, so each runner starts it again) and both runners, each pinned
    expect(runs.filter((call) => call.startsWith("docker run --cpuset-cpus 0-95 -d ")).length).toBeGreaterThanOrEqual(1);
    expect(runs.filter((call) => runnerRun.test(call))).toHaveLength(2);
    for (const call of runs) expect(call).toContain("--cpuset-cpus 0-95 ");
    expect(runRunner().calls).not.toContain("--cpuset-cpus");
  });

  it("refuses a CPU list docker cannot give before starting anything", () => {
    const { result, calls } = runRunner({ count: 2, args: ["--cpuset-cpus", "0-500"] });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--cpuset-cpus 0-500");
    expect(calls).not.toContain("registration-token");
    expect(calls.split("\n").filter((call) => runnerRun.test(call) || call.includes(" -d "))).toEqual([]);
  });

  it("starts a slot's runner only once the container an earlier launcher left in that slot has ended", async () => {
    const { tempDir, args, env, logPath } = prepareRunner({});
    const held = join(tempDir, "slot-held");
    writeFileSync(held, "true\n");
    const child = Bun.spawn(["bash", ...args], { env: { ...env, RUNNER_TEST_SLOT_HELD: held }, stdout: "ignore", stderr: "ignore" });
    try {
      const calls = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
      // it asks about the slot's container before anything else of the slot
      const deadline = Date.now() + LOADED_BOUND_MS;
      while (!/docker container inspect .*herdr-ci-\S+-1/.test(calls()) && Date.now() < deadline) await Bun.sleep(25);
      expect(calls()).toMatch(/docker container inspect .*herdr-ci-\S+-1/);
      expect(calls()).not.toContain("registration-token");
      expect(calls().split("\n").filter((call) => runnerRun.test(call))).toEqual([]);
      rmSync(held);
      expect(await Promise.race([child.exited, Bun.sleep(LOADED_BOUND_MS).then(() => "still running")])).toBe(0);
      expect(calls().split("\n").filter((call) => runnerRun.test(call))).toHaveLength(1);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, HUNG_RUN_MS);

  it("removes a stopped container left in a slot's name, instead of waiting on it forever", () => {
    const { tempDir, args, env, logPath } = prepareRunner({});
    try {
      const held = join(tempDir, "slot-held");
      writeFileSync(held, "false\n");
      const result = spawnSync("bash", args, { encoding: "utf8", timeout: LOADED_BOUND_MS, env: { ...env, RUNNER_TEST_SLOT_HELD: held } });
      expect(result.status).toBe(0);
      const calls = readFileSync(logPath, "utf8").split("\n");
      expect(calls.some((call) => /^docker rm -f herdr-ci-\S+-1$/.test(call))).toBe(true);
      expect(calls.filter((call) => runnerRun.test(call))).toHaveLength(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses a host env file it cannot read before starting anything", () => {
    const { result, calls } = runRunner({ envFile: "missing" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--env-file");
    expect(calls).not.toContain("docker run");
  });

  it("refuses a host env file line that would copy the launcher's own environment into the jobs", () => {
    const { result, calls } = runRunner({ envFile: "bare" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("refused line(s): 2\n");
    expect(calls).not.toContain("docker run");
  });

  it("names a refused line by its number only, never its value", () => {
    const { result, calls } = runRunner({ envFile: "secret" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("refused line(s): 3\n");
    expect(result.stderr).not.toContain("ghp_synthetic_secret");
    expect(result.stderr).not.toContain("GH_TOKEN");
    expect(calls).not.toContain("docker run");
  });

  it("refuses a NUL byte in the host env file and names its line", () => {
    const { result, calls } = runRunner({ envFile: "nul" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("refused line(s): 2\n");
    expect(calls).not.toContain("docker run");
  });

  it("checks a host env file named - as that file, never the launcher's stdin", () => {
    const cwd = mkdtempSync(join(tmpdir(), "herdr-runner-dash-"));
    try {
      writeFileSync(join(cwd, "-"), "GH_TOKEN\n");
      // stubs first on PATH: a launcher that wrongly went on must never reach the real gh or docker
      const bin = join(cwd, "bin");
      mkdirSync(bin);
      for (const tool of ["gh", "docker"]) {
        writeFileSync(join(bin, tool), "#!/bin/sh\nexit 1\n");
        chmodSync(join(bin, tool), 0o755);
      }
      const result = spawnSync("bash", [script, "--repo", "owner/repo", "--once", "--env-file", "-"], {
        cwd, encoding: "utf8", timeout: 10_000, input: "",
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("refused line(s): 1\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("refuses to start when it cannot read the host env file to check it", () => {
    const { result, calls } = runRunner({ envFile: "present", grepReadError: true });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("could not read");
    expect(calls).not.toContain("docker run");
  });

  it("propagates a one-shot Docker failure status", () => {
    const { result } = runRunner({ dockerExitCode: 42, failedSlot: 1 });
    expect(result.status).toBe(42);
  });

  it("returns failure when registration-token retrieval fails", () => {
    const { result, calls } = runRunner({ ghTokenExitCode: 1 });
    expect(result.status).toBe(1);
    expect(calls.split("\n").filter((call) => runnerRun.test(call))).toEqual([]);
  });

  it("starts every runner in one shared network namespace, never the host's, and stops it last", () => {
    const { result, calls } = runRunner({ count: 2 });
    expect(result.status).toBe(0);
    const lines = calls.split("\n");
    const namespace = lines.findIndex((call) => /^docker run -d .*--entrypoint sleep .* infinity$/.test(call));
    expect(namespace).toBeGreaterThanOrEqual(0);
    const name = lines[namespace]!.match(/--name (\S+)/)![1]!;
    expect(name).toMatch(/^herdr-ci-.+-net$/);
    expect(lines[namespace]).toContain("--cap-drop ALL");
    expect(lines[namespace]).not.toContain("--network");
    const runners = lines.map((call, index) => ({ call, index })).filter(({ call }) => runnerRun.test(call));
    expect(runners).toHaveLength(2);
    for (const { call, index } of runners) {
      expect(index).toBeGreaterThan(namespace);
      expect(call).toContain(`--network container:${name}`);
      expect(call).not.toContain("--network host");
    }
    const stopped = lines.findIndex((call) => call.startsWith(`docker stop`) && call.endsWith(` ${name}`));
    expect(stopped).toBeGreaterThan(Math.max(...lines.map((call, index) => (call.startsWith("docker stop") && !call.endsWith(` ${name}`) ? index : -1))));
  });

  it("registers the reserved slots with their own labels and every other slot with --labels", () => {
    const labelsBySlot = (args: string[], count = 3) => {
      const { result, calls } = runRunner({ count, args });
      expect(result.status).toBe(0);
      return Object.fromEntries(calls.split("\n").filter((call) => runnerRun.test(call))
        .map((call) => [call.match(/--name herdr-ci-.+-(\d+) /)![1], call.match(/-e RUNNER_LABELS=(\S+) /)![1]]));
    };
    expect(labelsBySlot([])).toEqual({ 1: "self-hosted-ovis", 2: "self-hosted-ovis", 3: "self-hosted-ovis" });
    expect(labelsBySlot(["--reserved", "2"])).toEqual({ 1: "self-hosted-ovis-main", 2: "self-hosted-ovis-main", 3: "self-hosted-ovis" });
    expect(labelsBySlot(["--reserved", "1", "--reserved-labels", "main-only", "--labels", "pr-only"]))
      .toEqual({ 1: "main-only", 2: "pr-only", 3: "pr-only" });
    expect(labelsBySlot(["--reserved", "2"], 2)).toEqual({ 1: "self-hosted-ovis-main", 2: "self-hosted-ovis-main" });
  });

  it("refuses a --reserved it cannot honour before starting anything", () => {
    // 2^64 wraps to 0 in shell arithmetic
    for (const reserved of ["x", "-1", "1.5", "4", "18446744073709551616"]) {
      const { result, calls } = runRunner({ count: 3, args: ["--reserved", reserved] });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--reserved");
      expect(calls).toBe("");
    }
  });

  it.skipIf(process.platform !== "linux")("refreshes the host caches before the first runner and hands them to every runner read-only", () => {
    const cacheHome = mkdtempSync(join(tmpdir(), "herdr-runner-cache-"));
    try {
      const { result, calls } = runRunner({ count: 2, cacheHome });
      expect(result.status).toBe(0);
      const lines = calls.split("\n");
      // one directory per repository
      const cacheDir = join(cacheHome, "ovis-ci-runner/owner/repo");
      const mirror = join(cacheDir, "git/repo.git");
      // this repository's branches and tags only, from GitHub
      // set up under another name, then moved into place whole
      const setup = lines.find((call) => call.includes(" config remote.origin.url "))!.match(/^git -C (\S+) /)![1]!;
      expect(setup).toStartWith(join(cacheDir, "git/.new-"));
      expect(lines).toContain(`git -C ${setup} config remote.origin.url https://github.com/owner/repo.git`);
      // a job reads the mirror's objects in place: git never collects one on its own
      for (const setting of ["gc.pruneExpire never", "gc.auto 0", "maintenance.auto false", "fetch.unpackLimit 1"]) expect(lines).toContain(`git -C ${setup} config ${setting}`);
      expect(existsSync(join(mirror, "objects"))).toBe(true);
      expect(existsSync(setup)).toBe(false);
      expect(lines.filter((call) => call.includes("remote.origin.fetch")).map((call) => call.split(" ").at(-1)))
        .toEqual(["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"]);
      // bounded: a stalled transfer gives up instead of holding the refresh
      const fetched = lines.findIndex((call) => call.startsWith(`git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 -C ${mirror} fetch `));
      const runners = lines.map((call, index) => ({ call, index })).filter(({ call }) => runnerRun.test(call));
      expect(runners).toHaveLength(2);
      for (const { call, index } of runners) {
        expect(index).toBeGreaterThan(fetched);
        expect(fetched).toBeGreaterThanOrEqual(0);
        expect(call).toContain(`-v ${cacheDir}:/cache:ro `);
        expect(call).toContain("-e GIT_ALTERNATE_OBJECT_DIRECTORIES=/cache/git/repo.git/objects ");
        expect(call.match(/-v \S+/g)).toEqual([`-v ${cacheDir}:/cache:ro`]);
        expect(call).toContain("--security-opt no-new-privileges --cap-drop ALL --pids-limit 8192 ");
        expect(call).toEndWith(" herdr-ci-runner:local");
      }
      expect(readlinkSync(join(cacheDir, "bun/current"))).toBe(lockBlob);
      expect(readdirSync(join(cacheDir, "bun", lockBlob))).toEqual(["package@1.0.0"]);
    } finally {
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("builds the Bun cache from the default branch's lockfile only, hardened, read-only to it and without package scripts", () => {
    const { result, calls } = runRunner();
    expect(result.status).toBe(0);
    const builds = calls.split("\n").filter((call) => cacheBuild.test(call));
    expect(builds).toHaveLength(1);
    const build = builds[0]!;
    // --init: a PID 1 that passes the deadline's SIGTERM on to the build
    expect(build).toMatch(/^docker run --rm --init --name /);
    expect(build).toContain("--security-opt no-new-privileges --cap-drop ALL --pids-limit 8192 ");
    expect(build).toContain(`-e COMMIT=${commitSha} `);
    expect(build).toMatch(/-v \S+\/git\/repo\.git:\/cache\/git\/repo\.git:ro /);
    expect(build).toContain("bun install --frozen-lockfile --ignore-scripts");
    expect(build).not.toContain("--network");
    expect(build).not.toContain("docker.sock");
  });

  it.skipIf(process.platform !== "linux")("mounts no cache and touches no mirror with --no-cache", () => {
    const { result, calls } = runRunner({ args: ["--no-cache"] });
    expect(result.status).toBe(0);
    expect(calls).not.toContain("git ");
    expect(calls).not.toContain("/cache");
    expect(calls.split("\n").filter((call) => runnerRun.test(call))).toHaveLength(1);
  });

  it.skipIf(process.platform !== "linux")("still starts the runners when a refresh or a build fails, builds nothing after a failed refresh, and retries a failed build only after 30 minutes", () => {
    const cacheHome = mkdtempSync(join(tmpdir(), "herdr-runner-cache-"));
    try {
      // a refresh that failed builds nothing: what the mirror holds was not confirmed this time
      const unfetched = runRunner({ cacheHome, gitFetchExitCode: 1 });
      expect(unfetched.result.status).toBe(0);
      expect(unfetched.result.stderr).toContain("[cache] could not refresh the git mirror");
      expect(unfetched.calls.split("\n").filter((call) => cacheBuild.test(call))).toEqual([]);
      expect(unfetched.calls.split("\n").filter((call) => runnerRun.test(call))).toHaveLength(1);
      const first = runRunner({ cacheHome, cacheBuildExitCode: 1 });
      expect(first.result.status).toBe(0);
      expect(first.result.stderr).toContain("[cache] could not build the Bun cache");
      expect(first.calls.split("\n").filter((call) => cacheBuild.test(call))).toHaveLength(1);
      expect(first.calls.split("\n").filter((call) => runnerRun.test(call))).toHaveLength(1);
      const bun = join(cacheHome, "ovis-ci-runner/owner/repo/bun");
      // nothing half-built is left for a runner to read
      expect(readdirSync(bun)).toEqual([`.failed-${lockBlob}`]);
      const again = runRunner({ cacheHome });
      expect(again.result.status).toBe(0);
      expect(again.calls.split("\n").filter((call) => cacheBuild.test(call))).toEqual([]);
      const past = new Date(Date.now() - 31 * 60_000);
      utimesSync(join(bun, `.failed-${lockBlob}`), past, past);
      const later = runRunner({ cacheHome });
      expect(later.calls.split("\n").filter((call) => cacheBuild.test(call))).toHaveLength(1);
      expect(readdirSync(bun).sort()).toEqual([lockBlob, "current"]);
    } finally {
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("waits 30 minutes after a crashed Bun cache build as after any other failure", () => {
    const cacheHome = mkdtempSync(join(tmpdir(), "herdr-runner-cache-"));
    try {
      // the OOM killer or the pids limit ends the build with 137, a crash with 139
      for (const status of [137, 139]) {
        rmSync(join(cacheHome, "ovis-ci-runner"), { recursive: true, force: true });
        const { result } = runRunner({ cacheHome, cacheBuildExitCode: status });
        expect(result.status).toBe(0);
        expect(readdirSync(join(cacheHome, "ovis-ci-runner/owner/repo/bun"))).toEqual([`.failed-${lockBlob}`]);
      }
    } finally {
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("starts the runners after --cache-wait when the first refresh hangs, and leaves nothing of it running", async () => {
    for (const hang of ["fetch", "build"] as const) {
      const { ended, stderr, calls, stuck } = await runRunnerUntilHung({ hang, args: ["--cache-wait", "1"] }, null);
      // --once: its one runner ran its job, so the launcher ended, stopping the hung refresh
      expect(ended).toBe(0);
      expect(stderr).toContain("[cache] the caches are not ready after 1s");
      expect(calls).toContain("registration-token");
      expect(calls.split("\n").filter((call) => runnerRun.test(call))).toHaveLength(1);
      expect(stuck).toBe("");
    }
  }, 2 * HUNG_RUN_MS);

  it.skipIf(process.platform !== "linux")("stops at once on SIGTERM during the first refresh, and records no failure for a build it stopped", async () => {
    for (const hang of ["fetch", "build"] as const) {
      const cacheHome = mkdtempSync(join(tmpdir(), "herdr-runner-cache-"));
      try {
        const { ended, calls, stuck } = await runRunnerUntilHung({ hang, cacheHome }, "SIGTERM", STOP_AT_ONCE_MS);
        expect(ended).toBe(143);
        expect(calls).not.toContain("registration-token");
        expect(stuck).toBe("");
        if (hang === "build") expect(readdirSync(join(cacheHome, "ovis-ci-runner/owner/repo/bun")).filter((name) => name.startsWith(".failed-"))).toEqual([]);
      } finally {
        rmSync(cacheHome, { recursive: true, force: true });
      }
    }
  }, 2 * HUNG_RUN_MS);

  it.skipIf(process.platform !== "linux")("keeps each repository's caches apart, and sets up again a mirror of anything else", () => {
    const cacheHome = mkdtempSync(join(tmpdir(), "herdr-runner-cache-"));
    try {
      const first = runRunner({ cacheHome });
      const second = runRunner({ cacheHome, repo: "other/repo" });
      expect(first.result.status).toBe(0);
      expect(second.result.status).toBe(0);
      const mount = (calls: string) => calls.split("\n").find((call) => runnerRun.test(call))!.match(/-v (\S+):\/cache:ro/)![1];
      expect(mount(first.calls)).toBe(join(cacheHome, "ovis-ci-runner/owner/repo"));
      expect(mount(second.calls)).toBe(join(cacheHome, "ovis-ci-runner/other/repo"));
      expect(second.calls).toContain("config remote.origin.url https://github.com/other/repo.git");
      // a mirror whose origin is another repository's is not reused
      const mirror = join(cacheHome, "ovis-ci-runner/owner/repo/git/repo.git");
      writeFileSync(join(mirror, "config.remote.origin.url"), "https://github.com/someone/else.git\n");
      const again = runRunner({ cacheHome });
      expect(again.result.stderr).toContain("does not mirror https://github.com/owner/repo.git");
      expect(readFileSync(join(mirror, "config.remote.origin.url"), "utf8")).toBe("https://github.com/owner/repo.git\n");
    } finally {
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("builds the Bun cache from the branch GitHub names as the default, not the mirror's initial HEAD", () => {
    const cacheHome = mkdtempSync(join(tmpdir(), "herdr-runner-cache-"));
    try {
      const { result, calls } = runRunner({ cacheHome, defaultBranch: "stable", branches: ["main", "stable"] });
      expect(result.status).toBe(0);
      expect(calls.split("\n").find((call) => cacheBuild.test(call))).toContain(`-e COMMIT=${otherCommit} `);
      expect(readlinkSync(join(cacheHome, "ovis-ci-runner/owner/repo/bun/current"))).toBe(otherLock);
    } finally {
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("builds no Bun cache when GitHub names no default branch the mirror holds", () => {
    for (const github of [{ defaultBranch: "fail" }, { defaultBranch: "" }, { defaultBranch: "stable", branches: ["main"] }]) {
      const cacheHome = mkdtempSync(join(tmpdir(), "herdr-runner-cache-"));
      try {
        const { result, calls } = runRunner({ cacheHome, ...github });
        expect(result.status).toBe(0);
        expect(result.stderr).toContain("[cache] could not refresh the git mirror");
        // never the mirror's initial HEAD (main) nor any other branch
        expect(calls.split("\n").filter((call) => cacheBuild.test(call))).toEqual([]);
        expect(existsSync(join(cacheHome, "ovis-ci-runner/owner/repo/bun/current"))).toBe(false);
        expect(calls.split("\n").filter((call) => runnerRun.test(call))).toHaveLength(1);
      } finally {
        rmSync(cacheHome, { recursive: true, force: true });
      }
    }
  });

  it.skipIf(process.platform !== "linux")("outlives no git or Bun cache build that ignores SIGTERM, and removes the build container last", async () => {
    for (const [hang, stubborn] of [["fetch", true], ["fetch", "helper"], ["ls-remote", true], ["build", true]] as const) {
      const { ended, calls, stuck } = await runRunnerUntilHung({ hang, stubborn }, "SIGTERM");
      expect(ended).toBe(143);
      // checked the moment the launcher ended: nothing of the refresh may be left
      expect(stuck).toBe("");
      if (hang === "build") {
        const cacheCalls = calls.split("\n").filter((call) => /^docker \S+ .*herdr-ci-.+-cache\b/.test(call));
        expect(cacheCalls.at(-1)).toMatch(/^docker rm -f herdr-ci-.+-cache$/);
      }
    }
  }, 4 * HUNG_RUN_MS);

  it.skipIf(process.platform !== "linux")("starts the runners without caches when the cache directory or the repository name cannot hold them", () => {
    const cacheHome = mkdtempSync(join(tmpdir(), "herdr-runner-cache-"));
    try {
      writeFileSync(join(cacheHome, "ovis-ci-runner"), "not a directory");
      for (const run of [runRunner({ cacheHome }), runRunner({ repo: "owner/../escape" })]) {
        expect(run.result.status).toBe(0);
        expect(run.result.stderr).toContain("[cache]");
        expect(run.calls).not.toContain("/cache:ro");
        expect(run.calls.split("\n").filter((call) => runnerRun.test(call))).toHaveLength(1);
      }
    } finally {
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("keeps a replaced Bun cache for an hour after it was replaced, then removes it", () => {
    const cacheHome = mkdtempSync(join(tmpdir(), "herdr-runner-cache-"));
    try {
      const bun = join(cacheHome, "ovis-ci-runner/owner/repo/bun");
      const hoursAgo = new Date(Date.now() - 2 * 3_600_000);
      for (const version of ["replaced-earlier", "replaced-now"]) {
        mkdirSync(join(bun, version), { recursive: true });
        utimesSync(join(bun, version), hoursAgo, hoursAgo);
      }
      // a symlink as the launcher writes it: the default branch's lockfile was replaced-now's until this run
      spawnSync("ln", ["-s", "replaced-now", join(bun, "current")]);
      const { result } = runRunner({ cacheHome });
      expect(result.status).toBe(0);
      expect(readlinkSync(join(bun, "current"))).toBe(lockBlob);
      expect(readdirSync(bun).sort()).toEqual([lockBlob, "current", "replaced-now"]);
    } finally {
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  it("propagates a failed slot's status when multiple one-shot slots run", () => {
    for (const failedSlot of [1, 2]) {
      const { result } = runRunner({ count: 2, dockerExitCode: 42, failedSlot });
      expect(result.status).toBe(42);
    }
  });
});

// the runner image is Linux, and the hook finds the worker through /proc
describe.skipIf(process.platform !== "linux")("self-hosted runner job-started hook", () => {
  it("runs a job from this repository", () => {
    for (const [event, payload] of [
      ["push", { ref: "refs/heads/main" }],
      ["pull_request", { pull_request: { head: { repo: { full_name: "devswha/ovis" } } } }],
      ["workflow_run", { workflow_run: { head_repository: { full_name: "devswha/ovis" } } }],
    ] as const) {
      const result = runJobStarted(event, payload);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("next step ran");
    }
  });

  it("refuses a job carrying another repository's code before it runs", () => {
    for (const [event, payload] of [
      ["pull_request", { pull_request: { head: { repo: { full_name: "someone/ovis" } } } }],
      ["pull_request_target", { pull_request: { head: { repo: { full_name: "someone/ovis" } } } }],
      ["pull_request", { pull_request: { head: { repo: null } } }],
      ["workflow_run", { workflow_run: { head_repository: { full_name: "someone/ovis" } } }],
    ] as const) {
      const result = runJobStarted(event, payload);
      // a failing hook alone would let `if: always()` steps run: the worker itself is killed
      expect(result.signal).toBe("SIGKILL");
      expect(result.stdout).toContain("::error::");
      expect(result.stdout).not.toContain("next step ran");
    }
  });

  it("refuses a job it cannot check: fails closed on an unreadable or broken event", () => {
    const forkless = { ref: "refs/heads/main" };
    for (const event of [
      { path: "missing" },
      { path: "directory" },
      { path: "unset" },
      { raw: '{"pull_request": {"head":' },
      { raw: "not json" },
      { raw: '{"pull_request": "someone/ovis"}' },
      { repository: "unset" },
      { path: "missing", closedOutput: true },
      // the shell's own `${VAR:?}` message on a closed stderr
      { path: "unset", closedOutput: true },
      { repository: "unset", closedOutput: true },
    ] as const) {
      const result = runJobStarted("push", forkless, event);
      expect(result.signal).toBe("SIGKILL");
      // a closed output takes the refusal with it: the kill alone is the evidence there
      if (!("closedOutput" in event)) expect(result.stdout).toContain("::error::");
      expect(result.stdout).not.toContain("next step ran");
    }
  });
});

describe.skipIf(process.platform === "win32")("build cache promotion", () => {
  const promoteScript = fileURLToPath(new URL("./self-hosted-runner/build-cache-promote.sh", import.meta.url));
  const key = "a".repeat(64);
  const slot = "herdr-ci-host-3";

  /**
   * A job's outbox holding one build, promoted against a GitHub that answers as `github` says. The
   * slot's container registered runner 31, and the run's job started on it ten seconds after the
   * container did. `jobStarted` starts the job that many seconds after the container instead (a
   * negative number: before it, as an earlier container's job), `runnerId` puts it on another
   * runner, `registered` names the runner registered under the slot's name now (null: none), and
   * `container` says what docker answers for the slot: nothing at all, one that never started, one
   * that has stopped, one that started after the build was left in the outbox, or another
   * container by the time GitHub has answered about the jobs. `older` has the system say that the
   * claim, or the build, was last changed one millisecond before the container started. `linked`
   * gives files a second name (a hard link): "marker" the claim and the build, as restore markers,
   * which the promoter removes, in an outbox whose container started just after they were written;
   * "claim" or "tar" that file alone, under a name nothing removes.
   */
  function promote(github: { event?: string; branch?: string; headRepo?: string; actor?: string; author?: string; prSha?: string; runner?: string; status?: string; fail?: boolean; runnerId?: number; jobStarted?: number; registered?: number | null; container?: "none" | "created" | "stopped" | "younger" | "changes"; older?: "claim" | "tar"; linked?: "marker" | "claim" | "tar" } = {}, build: "files" | "link" | "sealed" = "files", writer = "devswha", junkSlot: false | "claim" | "tar" = false, used = false, claim = "7 1\n", extraClaims = 0, ownManifest = false, later: string[] = [], slotHeldOffUntilNow = false, thenGithub?: typeof github) {
    const dir = mkdtempSync(join(tmpdir(), "herdr-build-cache-promote-test-"));
    try {
      const bin = join(dir, "bin");
      const root = join(dir, "root");
      const outboxes = join(dir, "outboxes");
      const outbox = join(outboxes, slot);
      for (const path of [bin, join(root, "entries"), outbox]) mkdirSync(path, { recursive: true });
      const dist = join(dir, "dist");
      mkdirSync(join(dist, "assets"), { recursive: true });
      writeFileSync(join(dist, "index.html"), "<p>");
      writeFileSync(join(dist, "assets/a.js"), "a");
      if (build === "link") symlinkSync("/etc/hostname", join(dist, "leak"));
      if (ownManifest) writeFileSync(join(dist, ".manifest"), "the app's own");
      // a directory nothing can be removed from as it is, beside a file nobody may read
      if (build === "sealed") chmodSync(join(dist, "assets"), 0o555);
      spawnSync("tar", ["-cf", join(outbox, `${key}.tar`), "-C", dist, "."]);
      if (build === "sealed") {
        writeFileSync(join(dir, "secret"), "s");
        spawnSync("tar", ["--mode=0000", "-rf", join(outbox, `${key}.tar`), "-C", dir, "./secret"]);
        chmodSync(join(dist, "assets"), 0o755);
      }
      writeFileSync(join(outbox, `${key}.claim`), claim);
      // more claims in the same outbox: a job flooding the launcher's GitHub quota
      for (let i = 0; i < extraClaims; i++) {
        const other = String(i).padStart(64, "e");
        spawnSync("tar", ["-cf", join(outbox, `${other}.tar`), "-C", dist, "."]);
        writeFileSync(join(outbox, `${other}.claim`), "7 1\n");
      }
      // an earlier slot whose job left a directory named like a claim
      if (junkSlot === "claim") mkdirSync(join(outboxes, "herdr-ci-host-1", `${"b".repeat(64)}.claim`), { recursive: true });
      // or a "tar" that is a directory this user cannot delete, as one of the runners' user is
      if (junkSlot === "tar") {
        const junk = join(outboxes, "herdr-ci-host-1", `${"b".repeat(64)}.tar`);
        mkdirSync(join(junk, "x"), { recursive: true });
        writeFileSync(join(junk, "x", "f"), "");
        chmodSync(join(junk, "x"), 0o000);
        writeFileSync(join(outboxes, "herdr-ci-host-1", `${"b".repeat(64)}.claim`), "7 1\n");
      }
      // a restore's use of an entry in another run's directory, and a used marker that is a link
      if (used) {
        mkdirSync(join(root, "entries", "3", "c".repeat(64)), { recursive: true });
        writeFileSync(join(outbox, `used-${"c".repeat(64)}`), "");
        symlinkSync("/etc/hostname", join(outbox, `used-${"d".repeat(64)}`));
      }
      const sha = "5".repeat(40);
      const answer = (github: NonNullable<Parameters<typeof promote>[0]>) => {
      if (github.fail) writeFileSync(join(dir, "fail"), ""); else rmSync(join(dir, "fail"), { force: true });
      // what docker names as the slot's container, and whether it is another once GitHub was asked about the jobs
      // When the slot's container started. The build above was written just now: the fixed day is before
      // it, an hour from now after it, and with "marker" it started 20 ms after the claim was written.
      let started = Date.UTC(2026, 10, 10, 12, 0, 0) + 123;
      if (github.container === "younger") started = Date.now() + 3_600_000;
      if (github.linked === "marker") for (const [index, file] of [`${key}.claim`, `${key}.tar`].entries()) linkSync(join(outbox, file), join(outbox, `used-${String(index + 1).repeat(64)}`));
      else if (github.linked) linkSync(join(outbox, `${key}.${github.linked}`), join(outbox, "spare"));
      if (github.linked === "marker") {
        started = Math.ceil(statSync(join(outbox, `${key}.claim`)).ctimeMs) + 20;
        // the pass comes after that start: the system's time for a file is only as fine as its clock's tick
        while (Date.now() < started + 20);
      }
      // as `docker container inspect -f '{{.Id}} {{.State.Running}} {{.State.StartedAt}}'` prints it
      if (github.container === "none") rmSync(join(dir, "container"), { force: true });
      else if (github.container === "created") writeFileSync(join(dir, "container"), "c1 false 0001-01-01T00:00:00Z\n");
      else writeFileSync(join(dir, "container"), `c1 ${github.container !== "stopped"} ${new Date(started).toISOString()}\n`);
      if (github.container === "changes") writeFileSync(join(dir, "next-container"), `c2 true ${new Date(started + 30_000).toISOString()}\n`); else rmSync(join(dir, "next-container"), { force: true });
      if (github.older) writeFileSync(join(dir, "older"), `${github.older} ${((started - 1) / 1000).toFixed(3)}\n`); else rmSync(join(dir, "older"), { force: true });
      const registered = github.registered === undefined ? 31 : github.registered;
      const jobStarted = new Date(Math.floor(started / 1000) * 1000 + (github.jobStarted ?? 10) * 1000).toISOString().replace(/\.\d+Z$/, "Z");
      const answers: Record<string, unknown> = {
        jobs: { jobs: [{ runner_name: github.runner ?? slot, status: github.status ?? "in_progress", runner_id: github.runnerId ?? 31, started_at: jobStarted }] },
        runners: { runners: [{ name: "herdr-ci-host-9", id: 9 }, ...(registered === null ? [] : [{ name: slot, id: registered }])] },
        run: { event: github.event ?? "pull_request", head_branch: github.branch ?? "feature", head_sha: sha, head_repository: { full_name: github.headRepo ?? "owner/repo" }, triggering_actor: { login: github.actor ?? "devswha" }, pull_requests: [{ number: 5 }] },
        pull: { user: { login: github.author ?? "devswha" }, head: { sha: github.prSha ?? sha } },
      };
      for (const [name, value] of Object.entries(answers)) writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
      };
      answer(github);
      writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$2" >> "\${0%/bin/gh}/gh.log"
# GitHub failing for a moment
[ -e "\${0%/bin/gh}/fail" ] && exit 1
case "$2" in
  repos/owner/repo/actions/runs/7/attempts/[12]/jobs*)
    cat "\${0%/bin/gh}/jobs.json"
    # the slot's job ended and its next container started while GitHub answered
    if [ -e "\${0%/bin/gh}/next-container" ]; then mv "\${0%/bin/gh}/next-container" "\${0%/bin/gh}/container"; fi ;;
  repos/owner/repo/actions/runners) cat "\${0%/bin/gh}/runners.json" ;;
  repos/owner/repo/actions/runs/7) cat "\${0%/bin/gh}/run.json" ;;
  repos/owner/repo/pulls/5) cat "\${0%/bin/gh}/pull.json" ;;
  repos/owner/repo) echo main ;;
  # as GitHub answers for a run or pull request that does not exist
  *) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
esac
`);
      chmodSync(join(bin, "gh"), 0o755);
      // docker container inspect <slot>: the slot's container, when it has one
      writeFileSync(join(bin, "docker"), `#!/bin/sh
[ "$1 $2" = "container inspect" ] && [ -f "\${0%/bin/docker}/container" ] || { echo "Error: No such container" >&2; exit 1; }
cat "\${0%/bin/docker}/container"
`);
      chmodSync(join(bin, "docker"), 0o755);
      // stat -c %.3Z <file>: when the file was last changed, which the test says for the claim or the build; the system's stat otherwise
      writeFileSync(join(bin, "stat"), `#!/bin/sh
if [ "$1 $2" = "-c %.3Z" ] && [ -f "\${0%/bin/stat}/older" ]; then
  read -r which at < "\${0%/bin/stat}/older"
  case "$3" in *."$which") echo "$at"; exit 0 ;; esac
fi
PATH="\${PATH#*:}" exec stat "$@"
`);
      chmodSync(join(bin, "stat"), 0o755);
      const pass = () => spawnSync("bash", [promoteScript, "owner/repo", root, outboxes, writer, "2048", ...(junkSlot ? ["herdr-ci-host-1"] : []), slot], { encoding: "utf8", env: { ...process.env, PATH: [bin, process.env.PATH].join(delimiter) } });
      const result = pass();
      // later passes, each after the job claimed again (the claim's run and attempt), each for another build
      const callsBefore: number[] = [];
      later.forEach((again, i) => {
        const other = String(i).padStart(64, "f");
        spawnSync("tar", ["-cf", join(outbox, `${other}.tar`), "-C", dist, "."]);
        writeFileSync(join(outbox, `${other}.claim`), again);
        callsBefore.push(existsSync(join(dir, "gh.log")) ? readFileSync(join(dir, "gh.log"), "utf8").split("\n").filter(Boolean).length : 0);
        if (thenGithub) answer(thenGithub);
        // the slot's ten minutes are over
        if (slotHeldOffUntilNow) {
          const old = new Date(Date.now() - 20 * 60_000);
          for (const name of readdirSync(join(outboxes, ".refused")).filter((name) => name.startsWith("slot-"))) utimesSync(join(outboxes, ".refused", name), old, old);
        }
        pass();
      });
      // an entry is filed under the run GitHub confirmed for the claim: 7 in every claim taken in here
      const entry = join(root, "entries", "7", key);
      const runs = readdirSync(join(root, "entries"));
      return {
        status: result.status,
        stderr: result.stderr,
        outbox: readdirSync(outbox),
        /** what entries/ holds itself: a directory per run with an entry */
        runs,
        /** every entry, as `<run id>/<key>` */
        entries: runs.flatMap((run) => readdirSync(join(root, "entries", run)).map((name) => `${run}/${name}`)),
        manifest: existsSync(join(entry, ".manifest")) ? readFileSync(join(entry, ".manifest"), "utf8") : null,
        used: existsSync(join(root, "used")) ? readdirSync(join(root, "used")) : [],
        ghCalls: existsSync(join(dir, "gh.log")) ? readFileSync(join(dir, "gh.log"), "utf8").split("\n").filter(Boolean) : [],
        callsBefore,
      };
    } finally {
      spawnSync("chmod", ["-R", "u+rwX", dir]);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

  it("takes in the build of a pull request the writer opened and pushed, with the manifest readers check", () => {
    const run = promote();
    expect(run.status).toBe(0);
    expect(run.entries).toEqual([`7/${key}`]);
    expect(run.manifest).toBe(`${sha("a")}  ./assets/a.js\n${sha("<p>")}  ./index.html\n`);
    expect(run.outbox).toEqual([`judged-${key}`]);
  });

  it("goes on to the other slots past a slot whose outbox holds a directory named like a claim", () => {
    const run = promote({}, "files", "devswha", "claim");
    expect(run.status).toBe(0);
    expect(run.entries).toEqual([`7/${key}`]);
  });

  it("goes on taking in trusted builds past a tar this user cannot delete", () => {
    const run = promote({}, "files", "devswha", "tar");
    expect(run.status).toBe(0);
    expect(run.entries).toEqual([`7/${key}`]);
  });

  it("stamps an entry's use from a restore's marker in the host's own directory, and drops the marker", () => {
    const run = promote({}, "files", "devswha", false, true);
    expect(run.used).toEqual(["c".repeat(64)]);
    expect(run.outbox).toEqual([`judged-${key}`]);
  });

  it("judges one claim per outbox per pass, and deletes the rest unread", () => {
    const run = promote({}, "files", "devswha", false, false, "7 1\n", 5);
    expect(run.entries).toHaveLength(1);
    expect(run.ghCalls.filter((call) => call.includes("/jobs"))).toHaveLength(1);
    expect(run.outbox.filter((name) => !name.startsWith("judged-"))).toEqual([]);
    expect(run.outbox).toHaveLength(6);
  });

  it("asks GitHub about a refused run once: its claims after that are refused without a call", () => {
    const run = promote({ author: "someone" }, "files", "devswha", false, false, "7 1\n", 0, false, ["7 1\n", "7 1\n", "7 1\n"]);
    expect(run.runs).toEqual([]);
    expect(run.callsBefore[0]).toBeGreaterThan(0);
    expect(run.ghCalls).toHaveLength(run.callsBefore[0]!);
    expect(run.outbox.filter((name) => !name.startsWith("judged-"))).toEqual([]);
  });

  it("holds off a slot whose claim was refused, whatever run its next claims name", () => {
    const run = promote({ author: "someone" }, "files", "devswha", false, false, "7 1\n", 0, false, ["8 1\n", "9 1\n", "7 2\n"]);
    expect(run.runs).toEqual([]);
    expect(run.ghCalls).toHaveLength(run.callsBefore[0]!);
  });

  it("remembers a refused run for longer than it holds off its slot", () => {
    const same = promote({ author: "someone" }, "files", "devswha", false, false, "7 1\n", 0, false, ["7 1\n"], true);
    expect(same.ghCalls).toHaveLength(same.callsBefore[0]!);
    const other = promote({ author: "someone" }, "files", "devswha", false, false, "7 1\n", 0, false, ["8 1\n"], true);
    expect(other.ghCalls.length).toBeGreaterThan(other.callsBefore[0]!);
  });

  it("never lets a claim from another slot refuse a trusted run's own claims", () => {
    // another slot's job names run 7, whose job runs on this slot only once GitHub says so below
    const run = promote({ runner: "herdr-ci-host-9" }, "files", "devswha", false, false, "7 1\n", 0, false, ["7 1\n"], true, { runner: slot });
    expect(run.entries).toHaveLength(1);
  });

  it("holds off a slot whose claims name runs that do not exist", () => {
    const run = promote({}, "files", "devswha", false, false, "99999991 1\n", 0, false, ["99999992 1\n", "99999993 1\n", "99999994 1\n"]);
    expect(run.callsBefore[0]).toBe(1);
    expect(run.ghCalls).toHaveLength(1);
  });

  it("refuses a stale run of the writer's pull request without holding off its slot", () => {
    // the pull request moved on to another head while run 7's job was still running
    const run = promote({ prSha: "6".repeat(40) }, "files", "devswha", false, false, "7 1\n", 0, false, ["7 2\n"], false, {});
    // its re-run on the same slot, at the pull request's head, is taken in
    expect(run.entries).toHaveLength(1);
  });

  it("remembers no refusal when GitHub failed to answer", () => {
    const run = promote({ fail: true }, "files", "devswha", false, false, "7 1\n", 0, false, ["7 1\n"], false, {});
    expect(run.entries).toHaveLength(1);
  });

  it("goes on asking about trusted runs: only refusals are remembered", () => {
    const run = promote({}, "files", "devswha", false, false, "7 1\n", 0, false, ["7 1\n"]);
    expect(run.entries).toHaveLength(2);
    expect(run.ghCalls.length).toBeGreaterThan(run.callsBefore[0]!);
  });

  it("refuses a build holding a file named like the manifest", () => {
    expect(promote({}, "files", "devswha", false, false, "7 1\n", 0, true).runs).toEqual([]);
  });

  it("takes in the build of a push to the default branch", () => {
    expect(promote({ event: "push", branch: "main", actor: "someone" }).entries).toEqual([`7/${key}`]);
  });

  it("never takes in a build from a job it cannot trust, and deletes it", () => {
    const refused = [
      promote({ author: "someone" }),
      promote({ actor: "someone" }),
      promote({ prSha: "6".repeat(40) }),
      promote({ headRepo: "fork/repo" }),
      promote({ runner: "herdr-ci-host-4" }),
      promote({ status: "completed" }),
      promote({ event: "push", branch: "other" }),
      promote({ event: "workflow_dispatch" }),
      promote({}, "files", ""),
      promote({}, "link"),
      // a claim too big to be one: never read
      promote({}, "files", "devswha", false, false, `7 1${" ".repeat(100)}\n`),
    ];
    for (const run of refused) {
      expect(run.status).toBe(0);
      // no entry, and no directory left for the run either
      expect(run.runs).toEqual([]);
      expect(run.outbox).toEqual([`judged-${key}`]);
    }
  });

  it("takes in a build only while the container whose job wrote its claim is still the slot's", () => {
    // the slot's job ended and its next container started while GitHub answered: its word is about that one's job
    const moved = promote({ container: "changes" }, "files", "devswha", false, false, "7 1\n", 0, false, ["7 1\n"], false, {});
    expect(moved.stderr).toContain("the container that built it is no longer the slot's");
    expect(moved.callsBefore[0]).toBeGreaterThan(0);
    // the next container's own claim is taken in: the slot was not held off
    expect(moved.entries).toEqual([`7/${"0".padStart(64, "f")}`]);
    // a slot without a running container: nothing GitHub says could be about the claim's job, so it is not asked
    for (const container of ["none", "created", "stopped"] as const) {
      const none = promote({ container });
      expect(none.status).toBe(0);
      expect(none.runs).toEqual([]);
      expect(none.ghCalls).toEqual([]);
      expect(none.outbox).toEqual([`judged-${key}`]);
    }
  });

  it("refuses a build an earlier job left in the outbox, which the slot's container did not write", () => {
    // the launcher could not empty the outbox before it started this container: the claim names a run this container's job is of
    const left = promote({ container: "younger" }, "files", "devswha", false, false, "7 1\n", 0, false, ["7 1\n"], false, {});
    expect(left.stderr).toContain("written before the slot's container started");
    // GitHub was not asked about it, and the slot is not held off: the container's own build, written after it started, is taken in
    expect(left.callsBefore[0]).toBe(0);
    expect(left.entries).toEqual([`7/${"0".padStart(64, "f")}`]);
    expect(left.outbox.sort()).toEqual([`judged-${"0".padStart(64, "f")}`, `judged-${key}`].sort());
    // by the claim's time and by the build's, each to the millisecond (the container started at 12:00:00.123)
    for (const older of ["claim", "tar"] as const) {
      const one = promote({ older });
      expect(one.stderr).toContain("written before the slot's container started");
      expect(one.runs).toEqual([]);
      expect(one.ghCalls).toEqual([]);
    }
  });

  it("is not told a leftover is new by a second name of it: removing one changes the file's time", () => {
    // the earlier job gave its claim and its build a second name each, as restore markers, which the promoter removes
    const marked = promote({ linked: "marker" });
    expect(marked.status).toBe(0);
    expect(marked.runs).toEqual([]);
    expect(marked.ghCalls).toEqual([]);
    expect(marked.outbox).toEqual([`judged-${key}`]);
    // and a claim or a build with a second name is not taken at all, whenever it was written
    for (const linked of ["claim", "tar"] as const) {
      const spare = promote({ linked });
      expect(spare.runs).toEqual([]);
      expect(spare.ghCalls).toEqual([]);
      expect(spare.outbox.sort()).toEqual([`judged-${key}`, "spare"]);
    }
  });

  it("refuses a claim naming the run of a killed container's job, which GitHub still lists as running on the runner the next container took over", () => {
    // the container before was killed 13.5 minutes ago with its job running; this one registered over its
    // runner and kept the id (config.sh --replace), so the name, the status and the runner all fit
    const dead = promote({ jobStarted: -810 }, "files", "devswha", false, false, "7 1\n", 0, false, ["8 1\n"]);
    expect(dead.stderr).toContain("started before the slot's container did");
    expect(dead.runs).toEqual([]);
    // the claim is at fault, so its slot is held off: the next claim costs no call
    expect(dead.callsBefore[0]).toBe(1);
    expect(dead.ghCalls).toHaveLength(1);
    // to the second: run.sh waits two before a slot's next container, so a job even one second older than
    // this container is the one before's, and one that started in the container's own second is its own
    expect(promote({ jobStarted: -2 }).runs).toEqual([]);
    expect(promote({ jobStarted: -1 }).runs).toEqual([]);
    expect(promote({ jobStarted: 0 }).entries).toEqual([`7/${key}`]);
  });

  it("refuses a claim naming a run whose job under the slot's name is on another runner than the one registered now", () => {
    // a job of an earlier registration, which GitHub still lists as running
    const stale = promote({ runnerId: 30 }, "files", "devswha", false, false, "7 1\n", 0, false, ["8 1\n"]);
    expect(stale.runs).toEqual([]);
    // the claim is at fault, so its slot is held off: the next claim costs no call
    expect(stale.callsBefore[0]).toBe(2);
    expect(stale.ghCalls).toHaveLength(2);
    // no runner under the name any more (the job ended while GitHub was asked): refused, and the slot is not held off
    const ended = promote({ registered: null }, "files", "devswha", false, false, "7 1\n", 0, false, ["7 1\n"], false, {});
    expect(ended.stderr).toContain("no runner is registered as");
    expect(ended.entries).toEqual([`7/${"0".padStart(64, "f")}`]);
  });

  it("leaves nothing in the cache of a refused build whose directories cannot be emptied as they are", () => {
    const run = promote({}, "sealed");
    expect(run.status).toBe(0);
    expect(run.runs).toEqual([]);
    expect(run.outbox).toEqual([`judged-${key}`]);
  });
});
