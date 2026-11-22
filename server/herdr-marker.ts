/**
 * On Windows herdr.sock is a marker file `pid:start` that a killed daemon leaves behind;
 * `start` is the daemon's start as Unix nanoseconds (live-verified, herdr 0.9.3:
 * `26540:1790829888292852700`, 56 ms after the process's creation time). The pid alone
 * does not say whether the daemon is there: Windows hands a dead process's pid to the next
 * one, so after a reboot another program, or another session's herdr, can hold it.
 */
/**
 * On Linux and macOS a herdr that was killed, or lost to a reboot, leaves its socket file
 * behind, and the kernel refuses a connection to it (live-verified, herdr 0.9.0 and 0.9.3;
 * `herdr server` starts over such a file). Any other failure, a daemon that is slow or a
 * file that may not be read, is not proof that the daemon is gone.
 */
export async function refusedSocket(path: string): Promise<boolean> {
  try { (await Bun.connect({ unix: path, socket: { data() {} } })).end(); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ECONNREFUSED"; }
}

export interface MarkerOwner { pid: number; startedMs: number | null }
export function markerOwner(marker: string): MarkerOwner | null {
  const [pidText, startText] = marker.trim().split(":");
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid < 1) return null;
  const startedMs = /^\d{16,}$/.test(startText ?? "") ? Number(BigInt(startText!) / 1_000_000n) : null;
  return { pid, startedMs };
}

export interface RunningProcess { name: string; startedMs: number | null }
export function parseProcessLine(output: string): RunningProcess | null {
  const match = /^([^|\r\n]+)\|(\d+)\s*$/m.exec(output);
  return match ? { name: match[1]!.trim(), startedMs: Number(match[2]) } : null;
}

export const MARKER_START_SLACK_MS = 30_000;

/**
 * A marker nobody stands behind: its pid is gone, belongs to a program that is not herdr,
 * or to a herdr that started at another time (a later daemon, or another session's). A
 * marker that cannot be read is not called stale: replacing a daemon needs proof it is gone.
 */
export function staleMarker(marker: string, processOf: (pid: number) => RunningProcess | null): boolean {
  const owner = markerOwner(marker);
  if (owner === null) return false;
  const running = processOf(owner.pid);
  if (running === null || !/^herdr(\.exe)?$/i.test(running.name)) return true;
  return owner.startedMs !== null && running.startedMs !== null && Math.abs(owner.startedMs - running.startedMs) > MARKER_START_SLACK_MS;
}
