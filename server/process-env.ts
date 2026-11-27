import { readFile } from "node:fs/promises";

/**
 * Read a Linux process's NUL-delimited `/proc/<pid>/environ` entries.
 * Returns null when the file cannot be read (non-Linux, gone process, or another user's process).
 */
export async function readLinuxEnviron(pid: number): Promise<string[] | null> {
  if (process.platform !== "linux") return null;
  try {
    return (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0");
  } catch {
    return null;
  }
}

/** Look up `NAME=value` in a NUL-split environment array; returns null when absent or empty. */
export function envEntry(entries: readonly string[], name: string): string | null {
  const prefix = `${name}=`;
  return entries.find((entry) => entry.startsWith(prefix))?.slice(prefix.length) || null;
}

/**
 * A process's `ps -E -ww -o command=` line on macOS: its arguments followed by its environment
 * when owned by this user. Returns null when `ps` exits non-zero or times out.
 */
export async function psEnvironmentLine(pid: number, timeoutMs = 3000): Promise<string | null> {
  const child = Bun.spawn(["/bin/ps", "-E", "-ww", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const text = await new Response(child.stdout).text();
    return (await child.exited) === 0 ? text : null;
  } finally {
    clearTimeout(timer);
  }
}
