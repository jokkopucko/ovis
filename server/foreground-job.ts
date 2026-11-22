/**
 * The processes of a terminal's foreground job below the one herdr-core names (#3009). herdr names
 * every process of the job in front of a pane; herdr-core's `foreground` is only its first one, so a
 * launcher that runs Claude as its child, or a shell script, hides the agent. The kernel answers the
 * rest: /proc on Linux, sysctl on macOS (darwin-process.ts), in the server's own thread, starting no
 * process. Only processes below `pid` and in its process group count: what the terminal's keyboard
 * reaches. Elsewhere (Windows has no foreground job) nothing is read.
 */
import { readdir, readFile } from "node:fs/promises";
import { darwinArgv, darwinProcessGroup } from "./darwin-process.ts";

export interface JobProcess { pid: number; name: string; argv: string[] }

/**
 * past this many processes found, the Linux lookup goes no level deeper, but it ends the level it is
 * on, however wide: a terminal's foreground job, not a whole PC
 */
const JOB_MAX = 256;

/** A Linux process's parent, group and command name from /proc/<pid>/stat; the name may hold spaces and parentheses. */
async function linuxStat(pid: number): Promise<{ parent: number; group: number; name: string }> {
  const text = await readFile(`/proc/${pid}/stat`, "utf8");
  const close = text.lastIndexOf(") ");
  const fields = text.slice(close + 2).split(" ");
  return { name: text.slice(text.indexOf("(") + 1, close), parent: Number(fields[1]), group: Number(fields[2]) };
}

/** The children of every thread of a Linux process (/proc/<pid>/task/<tid>/children). */
async function linuxThreadChildren(pid: number): Promise<number[]> {
  const tasks = await readdir(`/proc/${pid}/task`);
  const lists = await Promise.all(tasks.map((task) => readFile(`/proc/${pid}/task/${task}/children`, "utf8")));
  return lists.flatMap((list) => list.split(" ").filter((word) => word !== "").map(Number));
}

/**
 * A thread that ended while it was read hands its children to another thread, maybe one read already:
 * the whole process is read once more, never only the threads that answered, or a child is lost.
 */
async function linuxChildren(pid: number): Promise<number[]> {
  return linuxThreadChildren(pid).catch(() => linuxThreadChildren(pid));
}

async function linuxBelow(pid: number): Promise<JobProcess[]> {
  const { group } = await linuxStat(pid);
  const found: JobProcess[] = [];
  const seen = new Set<number>([pid]);
  let level = [pid];
  while (level.length > 0 && found.length < JOB_MAX) {
    const next: number[] = [];
    for (const parent of level) {
      for (const child of await linuxChildren(parent).catch(() => [])) {
        if (seen.has(child)) continue;
        seen.add(child);
        const stat = await linuxStat(child).catch(() => null);
        if (stat === null || stat.group !== group) continue;
        const argv = (await readFile(`/proc/${child}/cmdline`, "utf8").catch(() => "")).split("\0");
        if (argv.at(-1) === "") argv.pop();
        found.push({ pid: child, name: stat.name, argv });
        next.push(child);
      }
    }
    level = next;
  }
  return found;
}

function darwinBelow(pid: number): JobProcess[] | null {
  const group = darwinProcessGroup(pid);
  if (group === null) return null;
  const found: JobProcess[] = [];
  let level = [pid];
  while (level.length > 0) {
    const children = group.filter((entry) => level.includes(entry.parent) && entry.pid !== pid);
    for (const child of children) found.push({ pid: child.pid, name: child.name, argv: darwinArgv(child.pid) ?? [] });
    level = children.map((child) => child.pid);
  }
  return found;
}

/**
 * The processes below `pid` in its foreground job, nearest first; null when they cannot be read
 * (`pid` gone, a platform without a foreground job), which is no proof that none runs there.
 */
export async function jobProcessesBelow(pid: number, platform: string = process.platform): Promise<JobProcess[] | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "linux") return await linuxBelow(pid);
    if (platform === "darwin") return darwinBelow(pid);
  } catch { /* the process ended, or its /proc entry is not ours to read */ }
  return null;
}
