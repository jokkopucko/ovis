import "./ProgressBar.css";

import type { ReactNode } from "react";

import { useT } from "../lib/i18n.ts";

/** A wait's thin bar: filled to `percent`, or sliding while how far it is cannot be told (null). */
export function ProgressBar({ label, percent, valueText }: { readonly label: string; readonly percent: number | null; readonly valueText?: string | undefined }) {
  return <div className="bridge-progress-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} {...(percent === null ? {} : { "aria-valuenow": percent })} {...(valueText === undefined ? {} : { "aria-valuetext": valueText })}>
    <span className={percent === null ? "is-indeterminate" : undefined} style={percent === null ? undefined : { width: `${percent}%` }} />
  </div>;
}

/** What a wait is doing now, how far along it is beside it (`count`), and its bar under it. */
export function ProgressLine({ label, count = null, percent, valueText, className, children }: {
  readonly label: string; readonly count?: string | null; readonly percent: number | null; readonly valueText?: string; readonly className?: string; readonly children?: ReactNode;
}) {
  return <div className={className === undefined ? "bridge-progress" : `bridge-progress ${className}`}>
    <p className="bridge-progress-step"><span>{label}</span>{count !== null && <span className="bridge-progress-count">{count}</span>}</p>
    <ProgressBar label={label} percent={percent} valueText={valueText} />
    {children}
  </div>;
}

/**
 * A wait made of known stages: the stage's own words, "Step n of total" beside them, and the bar filled halfway into
 * that stage, as a stage under way is not done: a full bar only once the wait ended.
 */
export function StageProgress({ label, stage, total, children }: { readonly label: string; readonly stage: number; readonly total: number; readonly children?: ReactNode }) {
  const t = useT();
  const count = t("Step {n} of {total}", { n: stage, total });
  return <ProgressLine label={label} count={count} percent={Math.round((stage - 0.5) / total * 100)} valueText={count}>{children}</ProgressLine>;
}
