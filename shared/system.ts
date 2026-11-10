/**
 * The wire shape of GET /api/system: what one PC says about its own load right now.
 * Types only (src/ imports nothing else from here); the numbers are read by server/system-stats.ts.
 */

/** One filesystem the user's files live on, with the numbers `df` prints for it. */
export interface SystemDisk {
  /** the mount the reading was taken at: `/`, or the home folder when it is on a disk of its own */
  path: string;
  /** bytes in use (df's Used) */
  used: number;
  /** bytes a normal user can fill: used plus what is still free to them, so a little under df's Size */
  total: number;
  /** df's Use%, from the same two numbers */
  percent: number;
}

export interface SystemReport {
  /** epoch ms of the reading; a client that holds an answer longer than a minute should call it old */
  sampled_at: number;
  platform: "linux" | "darwin" | "win32" | "other";
  uptime_s: number;
  cpu_count: number;
  /** the share of CPU time in use since the previous reading; null when there is nothing to compare yet */
  cpu_percent: number | null;
  /** memory in use without the file cache (Linux: total minus MemAvailable; macOS: from vm_stat) */
  memory: { used: number; total: number; percent: number } | null;
  /** 1, 5 and 15 minute load averages; null on Windows, which has none */
  load: [number, number, number] | null;
  disks: SystemDisk[];
}
