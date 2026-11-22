import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n.ts";
import { outOfReachWord } from "./relayPcState.tsx";
import "./Machines.css";

/** How long Check again stays held after a press: a burst of presses is one check (the server's own floor is 5 s too). */
export const RECHECK_HOLD_MS = 5_000;

// per PC and per page, not per row: a row drawn again (the inbox and back, a filter) keeps its hold
const heldUntil = new Map<string, number>();
const held = (key: string): number => Math.max(0, (heldUntil.get(key) ?? 0) - performance.now());

/**
 * Check again for one PC, held RECHECK_HOLD_MS from its press by the monotonic clock. `run` only asks: what it
 * finds arrives as the PC's next state. A failed ask is told on the off row; it goes with the next press, and when
 * the PC stops being away (`away` false), as does any ask still unanswered then. The hold stays either way.
 */
export function useRecheck(key: string, run: () => Promise<void>, away: boolean): { checking: boolean; failure: string | null; check(): void } {
  const [checking, setChecking] = useState(() => held(key) > 0);
  const [failure, setFailure] = useState<string | null>(null);
  const asked = useRef(0);
  useEffect(() => {
    if (away) return;
    asked.current++;
    setFailure(null);
  }, [away]);
  useEffect(() => {
    if (!checking) return;
    const timer = setTimeout(() => setChecking(false), held(key));
    return () => clearTimeout(timer);
  }, [checking, key]);
  const check = () => {
    if (held(key) > 0) return;
    heldUntil.set(key, performance.now() + RECHECK_HOLD_MS);
    setChecking(true);
    setFailure(null);
    const ask = ++asked.current;
    // only the latest ask may say it failed: an earlier one answering late is old news
    run().catch((e: unknown) => { if (ask === asked.current) setFailure(e instanceof Error ? e.message : String(e)); });
  };
  return { checking, failure, check };
}

/**
 * A PC that does not answer, on its sidebar row: one word for its state, why under it, and Check again (the
 * account's PCs list and Needs you say the same, relayPcState.tsx). `off`: nothing answered for the PC;
 * `unreachable`: it could not be reached, so it may be on. Without `onCheck` (a device that only watches) the
 * row explains and offers nothing.
 */
export function MachineOffLine({ state, reason, title, checking, failure = null, onCheck, returnFocus }: { state: "off" | "unreachable"; reason: string | null; title?: string; checking: boolean; failure?: string | null; onCheck?: () => void; returnFocus?: () => HTMLElement | null }) {
  const t = useT();
  const button = useRef<HTMLButtonElement>(null);
  const focusBack = useRef(returnFocus);
  focusBack.current = returnFocus;
  // the PC answering takes this row away: a focused Check again hands the focus on while it is still in the page
  useLayoutEffect(() => () => { if (document.activeElement === button.current) focusBack.current?.()?.focus({ preventScroll: true }); }, []);
  return <div className="machine-off">
    <p className="machine-state is-off" role="status" title={title}>
      <span className="machine-state-word">{state === "off" ? t("Switched off") : outOfReachWord("unreachable", t)}</span>
      {reason !== null && <span className="machine-state-detail">{reason}</span>}
    </p>
    {onCheck !== undefined && <button ref={button} type="button" className="btn machine-recheck" aria-disabled={checking || undefined} aria-busy={checking || undefined} onClick={() => { if (!checking) onCheck(); }}>{t(checking ? "Checking…" : "Check again")}</button>}
    {failure !== null && <p className="machine-error machine-recheck-failure" role="alert">{failure}</p>}
  </div>;
}
