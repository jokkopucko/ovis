import { UPDATE_STEPS, type UpdateStatus, type UpdateStep } from "../../shared/update.ts";
import { t } from "./i18n.ts";

export const STEPS: ReadonlyArray<{ step: UpdateStep; label: string }> = [
  { step: "download", label: "Downloading the update" },
  { step: "dependencies", label: "Installing dependencies" },
  { step: "typecheck", label: "Checking the new version" },
  { step: "build", label: "Building the app" },
  { step: "restart", label: "Restarting the app" },
];

export interface UpdateProgressView {
  step: string;
  label: string;
  percent: number;
}

export function describeUpdate(status: Pick<UpdateStatus, "phase" | "step"> | null | undefined): UpdateProgressView | null {
  if (!status?.step || (status.phase !== "building" && status.phase !== "restarting")) return null;
  const index = UPDATE_STEPS.indexOf(status.step);
  const label = STEPS.find((entry) => entry.step === status.step)?.label;
  if (index < 0 || !label) return null;
  return {
    step: t("Step {n} of {total}", { n: index + 1, total: UPDATE_STEPS.length }),
    label,
    percent: Math.round(((index + 0.5) / UPDATE_STEPS.length) * 100),
  };
}
