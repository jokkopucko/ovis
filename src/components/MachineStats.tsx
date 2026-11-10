import { useId, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Machine } from "../../shared/machines.ts";
import type { SystemDisk, SystemReport } from "../../shared/system.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { pcLoadOn, useSettings } from "../lib/settings.ts";
import { SettingsRow, Toggle } from "./SettingsControls.tsx";
import { useSystemStats } from "../lib/system.ts";
import { formatBytes, formatPercentValue, formatUptime, fullestDisk, SYSTEM_HIGH_PERCENT } from "../lib/systemReport.ts";
import "./MachineStats.css";

// on the figure as shown: 84.6 reads "85%", and so is red
const high = (percent: number | null): string => percent !== null && Math.round(percent) >= SYSTEM_HIGH_PERCENT ? " is-high" : "";

/** One figure with its bar. It is only drawn: the button around it carries the numbers for a screen reader. */
function Meter({ label, percent }: { label: string; percent: number | null }) {
  const value = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  return <span className={`stats-meter${high(percent)}`}>
    <span className="stats-meter-label">{label}</span>
    <span className="stats-meter-value">{formatPercentValue(percent)}</span>
    <span className="stats-bar" aria-hidden="true">
      {/* a sliver above 0 still shows as a bar, not a dot */}
      <span style={{ width: value > 0 ? `max(3px, ${value}%)` : 0 }} />
    </span>
  </span>;
}

function DiskRow({ disk }: { disk: SystemDisk }) {
  return <li className="stats-disk">
    <span className="stats-disk-path" title={disk.path}>{disk.path}</span>
    <span className="stats-disk-size">{formatBytes(disk.used)} / {formatBytes(disk.total)}</span>
    <span className={`stats-meter${high(disk.percent)}`}>
      <span className="stats-bar" role="meter" aria-label={disk.path} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(disk.percent)}><span style={{ width: `max(3px, ${disk.percent}%)` }} /></span>
    </span>
  </li>;
}

function Details({ report }: { report: SystemReport }) {
  const t = useT();
  return <div className="stats-detail">
    <dl className="stats-facts">
      {report.memory && <><dt>{t("Memory")}</dt><dd>{formatBytes(report.memory.used)} / {formatBytes(report.memory.total)}</dd></>}
      {report.load && <><dt title={t("Load average over 1, 5 and 15 minutes")}>{t("Load")}</dt><dd>{report.load.map((n) => n.toFixed(2)).join(" · ")}<span className="stats-cores"> · {t("{count} cores", { count: report.cpu_count })}</span></dd></>}
      <dt>{t("Uptime")}</dt><dd>{formatUptime(report.uptime_s, t)}</dd>
    </dl>
    {report.disks.length > 0 && <ul className="stats-disks" aria-label={t("Disks")}>{report.disks.map((disk) => <DiskRow key={disk.path} disk={disk} />)}</ul>}
  </div>;
}

/** "CPU 4%, Memory 22%, Disk 50%": what the button says aloud, since its meters are only drawn. */
function spoken(t: Translate, report: SystemReport): string {
  const disk = fullestDisk(report.disks);
  return [
    t("CPU {value}", { value: report.cpu_percent === null ? t("Not measured") : formatPercentValue(report.cpu_percent) }),
    ...(report.memory ? [t("Memory {value}", { value: formatPercentValue(report.memory.percent) })] : []),
    ...(disk ? [t("Disk {value}", { value: formatPercentValue(disk.percent) })] : []),
  ].join(", ");
}

/** "CPU 4% · Memory 22% · Disk 50%": one compact line for the status bar. */
export function formatPcLoad(t: Translate, report: SystemReport): string | null {
  const disk = fullestDisk(report.disks);
  const parts = [
    ...(report.cpu_percent !== null ? [t("CPU {value}", { value: formatPercentValue(report.cpu_percent) })] : []),
    ...(report.memory ? [t("Memory {value}", { value: formatPercentValue(report.memory.percent) })] : []),
    ...(disk ? [t("Disk {value}", { value: formatPercentValue(disk.percent) })] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The selected PC's CPU, memory and fullest disk as one compact status-bar line while `active` is on.
 * Asks only while `active` (lib/system.ts), and draws nothing for a herdr-core PC (whose server runs
 * on this PC and cannot read that machine's load: server/system-stats.ts) or a PC that cannot say.
 */
export function PcLoadStatus({ machine, active = true }: { machine: Machine | null; active?: boolean }) {
  const t = useT();
  const enabled = active && machine !== null && machine.state === "connected" && machine.kind !== "hc";
  const retryKey = machine ? `${machine.state}:${machine.source_boot_id ?? ""}:${machine.herdr?.version ?? ""}` : "";
  const { report, unavailable } = useSystemStats(machine?.id ?? "local", enabled, retryKey);
  if (!enabled || unavailable || report === null) return null;
  const line = formatPcLoad(t, report);
  if (line === null) return null;
  return <span className="status-bar-item status-bar-text status-bar-load">{line}</span>;
}

/**
 * The load of a PC under its name: CPU, memory and its fullest disk as three small meters, and
 * on a tap the numbers behind them. It asks only while `active` (the sidebar, the PCs list and this
 * PC are shown: lib/system.ts), and draws nothing for a PC that cannot say.
 */
export function MachineStats({ machine, active }: { machine: Machine; active: boolean }) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(`ovis:pc-stats:${machine.id}`) === "1"; } catch { return false; } });
  const { report, unavailable } = useSystemStats(machine.id, active, `${machine.state}:${machine.source_boot_id ?? ""}:${machine.herdr?.version ?? ""}`);
  if (unavailable || report === null) return null;
  const disk = fullestDisk(report.disks);
  const toggle = () => {
    setOpen(!open);
    try { localStorage.setItem(`ovis:pc-stats:${machine.id}`, open ? "0" : "1"); } catch {}
  };
  return <div className="machine-stats">
    <button type="button" className="machine-stats-summary" aria-expanded={open} aria-controls={id}
      aria-label={t(open ? "Hide system details for {name}" : "Show system details for {name}", { name: machine.name }) + ". " + spoken(t, report)} onClick={toggle}>
      <Meter label={t("CPU")} percent={report.cpu_percent} />
      {report.memory && <Meter label={t("Memory")} percent={report.memory.percent} />}
      {disk && <Meter label={t("Disk")} percent={disk.percent} />}
      {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
    </button>
    {open && <div id={id}><Details report={report} /></div>}
  </div>;
}

/**
 * Settings → Devices and PCs' switch for the selected PC's load in the status bar, on this device only.
 * It stays on until it is flipped.
 */
export function PcLoadSetting({ machines }: { machines: readonly Machine[] }) {
  const t = useT();
  const { settings, update } = useSettings();
  return <SettingsRow label={t("PC load in the status bar")} description={t("The selected PC's CPU, memory and fullest disk in the status bar, on this device only.")}>
    <Toggle label={t("PC load in the status bar")} checked={pcLoadOn(settings, machines)} onChange={(pcLoad) => update({ pcLoad })} />
  </SettingsRow>;
}
