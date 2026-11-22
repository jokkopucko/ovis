/**
 * The app's controls as the anonymous usage counts see them (shared/telemetry.ts TelemetryCounts): a
 * handler names what was used, from TELEMETRY_COUNTERS only (a name not in it does not compile), and a
 * control that is not always drawn says once a day that it was shown. Nothing else is told: no text,
 * no pane, no time. A batch goes to this page's server (POST /api/telemetry `counts`) about once a
 * minute and when the page is hidden; the server adds it to today's counts and sends a day only after
 * it has ended, as buckets.
 *
 * Nothing is counted in a build whose notice does not say so (shared/telemetry-notice.ts COUNTS_ON).
 * Counting follows the server's word: only while its counts are on, not blocked, and its current
 * notice was shown. Until the page has heard that, a use is not kept, so nothing pressed before the
 * notice is ever told. A pane on another PC is not counted, and neither is a switch the app makes by
 * itself. A window at most SHEET_QUERY wide counts as narrow, any other as wide.
 */
import { useCallback, useEffect } from "react";
import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { COUNTS_ON } from "../../shared/telemetry-notice.ts";
import { harnessOf, type TelemetryAction, type TelemetryActionSource, type TelemetryCounter, type TelemetryCountsChange, type TelemetryShown, type TelemetryStatus, type TelemetryViewSource, type TelemetryWidth } from "../../shared/telemetry.ts";
import type { PaneView } from "./actions.ts";
import { changeTelemetry, fetchTelemetry, onTelemetryStatus } from "./api.ts";
import { SHEET_QUERY } from "./sheets.ts";

export const FLUSH_MS = 60_000;

interface Pending { add: Partial<Record<TelemetryCounter, number>>; shown: Set<TelemetryShown>; keys: string[]; day: string | null }

export interface UsageCountersOptions {
  /** whether this build counts at all (COUNTS_ON): off, nothing is kept, asked or told */
  on: boolean;
  send: (counts: TelemetryCountsChange, keepalive: boolean) => Promise<TelemetryStatus | null>;
  status: () => Promise<TelemetryStatus | null>;
  narrow: () => boolean;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => () => void;
}

/**
 * the server's word: counting is on only while all of these hold. A server that takes counts says its counting
 * generation; an older one (whose notice said nothing of counts, though its notice_seen is true) never does, so a
 * newer page reaching it (the hosted app on an older PC) counts nothing there
 */
export function countingAllowed(status: TelemetryStatus | null): boolean {
  return status !== null && status.enabled && !status.blocked_by_env && status.notice_seen && status.counts_generation !== undefined;
}

export function createUsageCounters(options: UsageCountersOptions) {
  let allowed: boolean | null = null;
  /** the server refused a batch (a device that can only watch): no later answer turns counting on for this page */
  let refused = false;
  /** the server's counting generation as last heard: every batch names it, and a new one drops what was kept */
  let generation: number | undefined;
  let asking = false;
  const empty = (): Pending => ({ add: {}, shown: new Set(), keys: [], day: null });
  const today = (): string => new Date(options.now()).toISOString().slice(0, 10);
  const batchFor = (width: TelemetryWidth): Pending => {
    const day = today();
    const batch = pending[width];
    if (batch.day !== null && batch.day !== day) flush(false);
    if (pending[width].day === null) pending[width].day = day;
    return pending[width];
  };
  const pending: Record<TelemetryWidth, Pending> = { narrow: empty(), wide: empty() };
  const toldShownByDayAndWidth = new Set<string>();
  const drawn = new Map<TelemetryShown, number>();
  const forget = (keys: readonly string[]): void => { for (const key of keys) toldShownByDayAndWidth.delete(key); };
  let cancelTimer: (() => void) | null = null;

  const heard = (status: TelemetryStatus | null): void => {
    // a late answer from before an off (an older generation) says nothing about now: it neither turns counting on nor back
    if (status?.counts_generation !== undefined && generation !== undefined && status.counts_generation < generation) return;
    const was = allowed;
    let renewed = false;
    // another tab turned the counts off (and maybe on again): what this page kept from before is not sent, and the
    // off cleared the PC's day, so a control still drawn is told as shown again
    if (status?.counts_generation !== undefined && status.counts_generation !== generation) {
      if (generation !== undefined) { drop(); toldShownByDayAndWidth.clear(); renewed = true; }
      generation = status.counts_generation;
    }
    allowed = countingAllowed(status);
    if (!allowed) drop();
    else if (was !== true || renewed) reshow();
  };
  const ask = (): void => {
    if (asking || allowed !== null) return;
    asking = true;
    options.status().then(heard, () => { /* not heard: nothing is kept, and the next use asks again */ }).finally(() => { asking = false; });
  };
  const drop = (): void => {
    for (const width of ["narrow", "wide"] as const) { forget(pending[width].keys); pending[width] = empty(); }
    cancelTimer?.();
    cancelTimer = null;
  };
  const schedule = (): void => {
    if (cancelTimer === null) cancelTimer = options.setTimer(() => { cancelTimer = null; flush(false); }, FLUSH_MS);
  };
  const ready = (): boolean => {
    if (!options.on || refused) return false;
    if (allowed === null) ask();
    return allowed === true;
  };

  const markShown = (name: TelemetryShown): void => {
    const width = options.narrow() ? "narrow" : "wide";
    const key = `${new Date(options.now()).toISOString().slice(0, 10)}:${width}:${name}`;
    if (toldShownByDayAndWidth.has(key)) return;
    toldShownByDayAndWidth.add(key);
    const batch = batchFor(width);
    batch.shown.add(name);
    batch.keys.push(key);
    schedule();
  };
  const reshow = (): void => { if (ready()) for (const name of drawn.keys()) markShown(name); };

  function flush(keepalive: boolean): void {
    if (allowed !== true || refused) { drop(); return; }
    reshow();
    cancelTimer?.();
    cancelTimer = null;
    for (const width of ["narrow", "wide"] as const) {
      const { add, shown, keys, day } = pending[width];
      if (Object.keys(add).length === 0 && shown.size === 0) continue;
      pending[width] = empty();
      // a batch that is not taken is not tried again: a count told twice would be worse than one lost. Its shown
      // controls are forgotten, so the next batch tells them again; a refusal (a watching device) stops counting here
      options.send({ width, add, shown: [...shown].sort(), ...(generation === undefined ? {} : { generation }), ...(day === null ? {} : { day }) }, keepalive).then((status) => { if (status) heard(status); }, (error: unknown) => {
        forget(keys);
        // refused: what was counted while this batch was on its way goes nowhere either
        if ((error as { status?: unknown } | null)?.status === 403) { refused = true; allowed = false; drop(); } else allowed = null;
      });
    }
  }

  return {
    heard,
    count(name: TelemetryCounter): void {
      if (!ready()) return;
      const batch = batchFor(options.narrow() ? "narrow" : "wide");
      batch.add[name] = (batch.add[name] ?? 0) + 1;
      schedule();
    },
    shown(name: TelemetryShown): void {
      if (ready()) markShown(name);
    },
    draw(name: TelemetryShown): () => void {
      drawn.set(name, (drawn.get(name) ?? 0) + 1);
      const undo = () => {
        const left = (drawn.get(name) ?? 1) - 1;
        if (left > 0) drawn.set(name, left); else drawn.delete(name);
      };
      if (ready()) tally(() => markShown(name));
      return undo;
    },
    reshow,
    /**
     * A chat/terminal switch a person asked for, on a pane of `machineId` running `agent`, counted under
     * the pane's kind and under where it was asked. `source` null is a switch the app made by itself: not counted.
     */
    viewSwitch(to: PaneView, agent: string | null | undefined, source: TelemetryViewSource | null, machineId: string): void {
      if (source === null || machineId !== LOCAL_MACHINE) return;
      this.count(`view_${to}_${harnessOf(agent) ?? "shell"}`);
      this.count(`view_${to}_by_${source}`);
    },
    /** a use on a pane of `machineId`: counted only on this PC's own panes */
    paneUse(name: TelemetryCounter, machineId: string): void {
      if (machineId === LOCAL_MACHINE) this.count(name);
    },
    flush,
  };
}

export type UsageCounters = ReturnType<typeof createUsageCounters>;

export const usageCounters: UsageCounters = createUsageCounters({
  on: COUNTS_ON,
  send: (counts, keepalive) => changeTelemetry({ counts }, { keepalive }),
  status: fetchTelemetry,
  narrow: () => typeof window !== "undefined" && window.matchMedia?.(SHEET_QUERY).matches === true,
  now: () => Date.now(),
  setTimer: (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
});

if (typeof document !== "undefined") {
  onTelemetryStatus(usageCounters.heard);
  // a phone's page is often closed by leaving it: what it used goes as it is hidden; back, what is drawn is told for today
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") usageCounters.flush(true); else usageCounters.reshow(); });
  window.matchMedia?.(SHEET_QUERY).addEventListener?.("change", () => usageCounters.reshow());
  window.addEventListener("pagehide", () => usageCounters.flush(true));
}

/** `name` is drawn while `drawn`, for a pane of `machineId`: told once a day per width while it stays, only for this PC's own panes */
export function useShownCount(name: TelemetryShown, drawn: boolean, machineId: string): void {
  useEffect(() => {
    if (!drawn || machineId !== LOCAL_MACHINE) return undefined;
    let undo: (() => void) | undefined;
    tally(() => { undo = usageCounters.draw(name); });
    return () => tally(() => undo?.());
  }, [name, drawn, machineId]);
}

export function useCountedInboxWays(enter: () => void, leave: () => void): { enter: () => void; leave: () => void } {
  return {
    enter: useCallback(() => { tally(() => usageCounters.count("inbox_enter")); enter(); }, [enter]),
    leave: useCallback(() => { tally(() => usageCounters.count("inbox_leave")); leave(); }, [leave]),
  };
}

/**
 * The counter an action taken by `source` goes to, or null: none when it would do nothing here (a shortcut or a
 * palette row for a split, a close or a new tab with nothing to act on), and none for a pane on another PC (split,
 * close, new tab and Files act on one).
 */
export function actionUse(action: TelemetryAction, source: TelemetryActionSource, here: { machineId: string; can: Partial<Record<TelemetryAction, boolean>> }): TelemetryCounter | null {
  if (here.can[action] === false) return null;
  if ((action === "split" || action === "close_pane" || action === "new_tab" || action === "files") && here.machineId !== LOCAL_MACHINE) return null;
  return `${action}_by_${source}`;
}

export function actionsCan(now: { split: boolean; closePane: boolean; files: boolean; inboxShown: boolean; inMode: boolean; tabTarget: boolean }): Partial<Record<TelemetryAction, boolean>> {
  return { split: now.split, close_pane: now.closePane, files: now.files, new_tab: !now.inboxShown && !now.inMode && now.tabTarget, sidebar: !now.inMode };
}

export function tally(count: () => void): void {
  try { count(); } catch (error) { console.error("usage counts", error); }
}
