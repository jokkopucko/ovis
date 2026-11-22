import type { SystemDisk, SystemReport } from "../../shared/system.ts";
import type { Translate } from "./i18n.ts";

export const SYSTEM_HIGH_PERCENT = 85;

export function fullestDisk(disks: readonly SystemDisk[]): SystemDisk | null {
  return disks.reduce<SystemDisk | null>((fullest, disk) => fullest === null || disk.percent > fullest.percent ? disk : fullest, null);
}

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];
/** 1536 -> "1.5 KB"; one decimal below 10, none above; powers of 1024, as `df -h` writes them. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit += 1; }
  const text = unit === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${UNITS[unit]}`;
}

export function formatUptime(seconds: number, t: Translate): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days > 0 ? t("{days}d {hours}h", { days, hours }) : hours > 0 ? t("{hours}h {minutes}m", { hours, minutes }) : t("{minutes}m", { minutes });
}

export function formatPercentValue(percent: number | null): string {
  return percent === null ? "—" : `${Math.round(percent)}%`;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const percentOf = (value: unknown): value is number => finite(value) && value >= 0 && value <= 100;
const MAX_DISKS = 4;

/**
 * What another PC's bridge said, checked: a bridge of another version, or a broken one, must not
 * be able to throw while the sidebar draws. Null when anything the UI reads is missing or of the
 * wrong kind; a list longer than a PC can have is cut.
 */
export function parseSystemReport(value: unknown): SystemReport | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  if (!finite(r["sampled_at"]) || !finite(r["uptime_s"]) || !finite(r["cpu_count"]) || r["cpu_count"] < 1) return null;
  if (r["cpu_percent"] !== null && !percentOf(r["cpu_percent"])) return null;
  const memory = r["memory"];
  if (memory !== null) {
    const m = memory as Record<string, unknown> | undefined;
    if (typeof m !== "object" || !finite(m["used"]) || !finite(m["total"]) || !percentOf(m["percent"])) return null;
  }
  const load = r["load"];
  if (load !== null && !(Array.isArray(load) && load.length === 3 && load.every(finite))) return null;
  if (!Array.isArray(r["disks"])) return null;
  const disks: SystemDisk[] = [];
  for (const item of r["disks"].slice(0, MAX_DISKS)) {
    const d = item as Record<string, unknown> | null;
    if (typeof d !== "object" || d === null || typeof d["path"] !== "string" || !finite(d["used"]) || !finite(d["total"]) || !percentOf(d["percent"])) return null;
    disks.push({ path: d["path"], used: d["used"], total: d["total"], percent: d["percent"] });
  }
  const platform = r["platform"];
  return {
    sampled_at: r["sampled_at"], uptime_s: r["uptime_s"], cpu_count: r["cpu_count"], cpu_percent: r["cpu_percent"] as number | null,
    platform: platform === "linux" || platform === "darwin" || platform === "win32" ? platform : "other",
    memory: memory as SystemReport["memory"], load: load as SystemReport["load"], disks,
  };
}

