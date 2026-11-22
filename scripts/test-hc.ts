import { readFileSync } from "node:fs";

/**
 * A herdr-core of a test's own: its session, state, config and runtime folders under `root`, and the
 * environment hc runs in holds nothing of this process's (no inherited HC_*, HOME or XDG_*), so no
 * hc call of the test can reach the user's own core.
 */
export function isolatedHcEnv(root: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: `${root}/home`,
    // short names: hc's socket path under a long TMPDIR must stay within the OS's limit (107 bytes)
    HC_SESSION: `t${process.pid}`,
    XDG_STATE_HOME: `${root}/state`,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_RUNTIME_DIR: `${root}/run`,
    HC_SOCKET: `${root}/run/hc.sock`,
    ...extra,
  };
}

/** A test's own core: the environment it was started in, and the pids of its core and holder known so far. */
export interface TestCore {
  env: Record<string, string>;
  pids: number[];
}

/**
 * The pids of the core `env` names and of its holder, as `hc server status --json` there answers,
 * each recorded with its start time. Right after a start the holder is still null: read them again
 * later. Ask only a core that runs, since status starts one when none does.
 */
export async function corePids(bin: string, env: Record<string, string>): Promise<number[]> {
  const proc = Bun.spawn([bin, "server", "status", "--json"], { env, stdout: "pipe", stderr: "ignore" });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const status = JSON.parse(out) as { pid: number; holder?: { pid: number } | null };
  return record([status.pid, ...(status.holder ? [status.holder.pid] : [])]);
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** when `pid` started (field 22 of /proc/<pid>/stat, after the command name, which may hold spaces), or null without /proc */
function startTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/** Every pid a status read named, with its start time then: a process that later gets the same number has another one. */
const recordedStarts = new Map<number, string>();

function record(pids: number[]): number[] {
  for (const pid of pids) {
    const start = startTime(pid);
    if (start !== null) recordedStarts.set(pid, start);
  }
  return pids;
}

/**
 * Whether `pid` is still the process a status of the core at `socket` named: its start time is the one
 * recorded with it, and the environment it was started in, which a core and its holder keep, names that
 * socket as HC_SOCKET. A pid no status named, a process that got a recorded pid's number later and a
 * process of another core are not proven; without /proc nothing is.
 */
function provenCore(pid: number, socket: string | undefined): boolean {
  const recorded = recordedStarts.get(pid);
  if (socket === undefined || recorded === undefined || startTime(pid) !== recorded) return false;
  try {
    return readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(`HC_SOCKET=${socket}`);
  } catch {
    return false;
  }
}

/**
 * Stops a test's own cores in the order given, each in its own environment: a core that dials
 * another goes first, as while it runs it starts that one again. Before each stop the core's holder
 * is read again (an orphaned holder starts a new core about 3 s later); then its pids are waited for,
 * because hc's stop returns while they live and a detached daemon's exit has no event. Whatever of a
 * core outlives `waitMs` is killed by its recorded pid, and gone, before the next core is stopped, so
 * it cannot start that one again; it is named in `killed`, but only once provenCore shows it is still
 * that core's process. Any other pid alive is named in `unproven` and left alone (record pids with
 * corePids: a pid no status named is never proven). The test asserts both are empty, so a leak fails it.
 * Delete a core's folder only after this: a late hc child would otherwise run whatever hc PATH finds.
 */
export async function stopTestCores(bin: string, cores: TestCore[], waitMs = 5000): Promise<{ stopped: number[]; killed: number[]; unproven: number[] }> {
  const stopped: number[] = [];
  const killed: number[] = [];
  const unproven: number[] = [];
  for (const core of cores) {
    if (core.pids.some(alive)) {
      // a status that fails keeps the pids recorded so far
      core.pids = [...new Set([...core.pids, ...(await corePids(bin, core.env).catch(() => []))])];
    }
    stopped.push(await Bun.spawn([bin, "server", "stop"], { env: core.env, stdout: "ignore", stderr: "ignore" }).exited);
    const deadline = Date.now() + waitMs;
    while (core.pids.some(alive) && Date.now() < deadline) await Bun.sleep(25);
    const ended: number[] = [];
    for (const pid of core.pids.filter(alive)) {
      if (!provenCore(pid, core.env["HC_SOCKET"])) {
        unproven.push(pid);
        continue;
      }
      ended.push(pid);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // it ended right after the proof: a leak all the same, as it outlived the wait
      }
    }
    killed.push(...ended);
    const killDeadline = Date.now() + waitMs;
    while (ended.some(alive) && Date.now() < killDeadline) await Bun.sleep(25);
  }
  return { stopped, killed, unproven };
}

/** Stops the core `env` names, only when it names one of its own (an HC_SOCKET); run in that environment alone. */
export async function stopIsolatedCore(bin: string, env: Record<string, string>): Promise<void> {
  if (!env["HC_SOCKET"] || !env["HC_SESSION"]) return;
  await Bun.spawn([bin, "server", "stop"], { env, stdout: "ignore", stderr: "ignore" }).exited;
}
