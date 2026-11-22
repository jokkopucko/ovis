import type { SetupProgress } from "../../shared/machines.ts";
import { t } from "./i18n.ts";

export const STAGES: ReadonlyArray<{ stage: SetupProgress["stage"]; label: string }> = [
  { stage: "download", label: "Downloading the bridge" },
  { stage: "upload", label: "Sending it to the PC" },
  { stage: "install", label: "Verifying and installing" },
  { stage: "restart", label: "Restarting the bridge" },
];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  // Below 10 MB, one decimal preserves useful size information.
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes < 10 ? Math.round(megabytes * 10) / 10 : Math.round(megabytes)} MB`;
}

export function formatRemaining(seconds: number): string {
  if (seconds >= 60) return `about ${Math.round(seconds / 60)} min`;
  return `about ${Math.max(5, Math.round(seconds / 5) * 5)} s`;
}

export interface ProgressView {
  step: string;
  label: string;
  percent: number | null;
  detail: string | null;
}

export function describeProgress(progress: SetupProgress | null | undefined): ProgressView | null {
  if (!progress) return null;
  const index = STAGES.findIndex((entry) => entry.stage === progress.stage);
  const step = t("Step {n} of {total}", { n: index + 1, total: STAGES.length });
  const label = STAGES[index]?.label ?? progress.stage;
  if (progress.total === null || progress.total <= 0) {
    return { step, label, percent: null, detail: progress.done > 0 ? formatBytes(progress.done) : null };
  }
  const done = Math.min(progress.done, progress.total);
  const percent = Math.floor((done / progress.total) * 100);
  const sizes = t("{done} of {total}", { done: formatBytes(done), total: formatBytes(progress.total) });
  const left = progress.rate && progress.rate > 0 && done < progress.total ? ` · ${t("{time} left", { time: formatRemaining((progress.total - done) / progress.rate) })}` : "";
  return { step, label, percent, detail: sizes + left };
}
