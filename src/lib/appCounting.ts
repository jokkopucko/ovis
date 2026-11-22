import type { TelemetryAction, TelemetryActionSource, TelemetryCounter } from "../../shared/telemetry.ts";
import type { AppActions } from "./actions.ts";
import { actionsCan, actionUse, tally, usageCounters } from "./usageCounters.ts";

export interface AppCountingState {
  actions: Pick<AppActions, "splitPane" | "closePane" | "openFiles">;
  machineId: string;
  inbox: { readonly shown: boolean };
  inMode: boolean;
  tabTarget: boolean;
}

export function appCounted(read: () => AppCountingState, count: (name: TelemetryCounter) => void = (name) => usageCounters.count(name)): (action: TelemetryAction, source: TelemetryActionSource) => void {
  return (action, source) => {
    const state = read();
    const { actions } = state;
    const name = actionUse(action, source, { machineId: state.machineId, can: actionsCan({
      split: actions.splitPane !== null, closePane: actions.closePane !== null, files: actions.openFiles !== null,
      inboxShown: state.inbox.shown, inMode: state.inMode, tabTarget: state.tabTarget,
    }) });
    if (name) tally(() => count(name));
  };
}

type PaneItems<T> = ((target: T, options?: { counted?: boolean }) => { id: string; disabled?: boolean; run: () => void }[]) | null | undefined;

export function closeFromPaneMenu<T>(items: PaneItems<T>, target: T): void {
  items?.(target, { counted: false }).find((item) => item.id === "close" && !item.disabled)?.run();
}

export function moreFilesRun(counted: AppActions["counted"], open: () => void): () => void {
  return () => { tally(() => counted?.("files", "menu")); open(); };
}
