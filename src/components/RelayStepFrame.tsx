import "./RelayStepFrame.css";

import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

import { useT } from "../lib/i18n.ts";

export interface RelayStepBack { readonly label: string; readonly onClick: () => void }

/**
 * One step of a pairing on a plain page: Back at the top left, a thin bar for how far the pairing is,
 * an optional note of what it waits for, then the step's own content, whose actions sit at the foot.
 */
export function RelayStepFrame({ step, back, note, children }: {
  readonly step: 1 | 2 | 3 | null; readonly back: RelayStepBack | null; readonly note: string | null; readonly children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="relay-step">
      {note !== null && <div className="relay-step-note" aria-hidden="true"><span>{note}</span><span className="boot-spinner" /></div>}
      <div className="relay-step-top">
        {back && <button type="button" className="relay-step-back" aria-label={back.label} onClick={back.onClick}><ChevronLeft aria-hidden="true" /></button>}
      </div>
      {step !== null && <div className="relay-step-progress" role="progressbar" aria-label={t("Pair")} aria-valuemin={1} aria-valuemax={3} aria-valuenow={step} aria-valuetext={t("Step {n} of {total}", { n: String(step), total: "3" })} data-step={step}><span /></div>}
      {children}
    </div>
  );
}
