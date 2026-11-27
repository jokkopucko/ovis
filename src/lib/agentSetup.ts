import type { AgentCatalogRow, AgentTabStarted } from "../../shared/agent-catalog.ts";
import { agentRuns } from "../../shared/agent-names.ts";

/**
 * Where one agent's setup stands: its install runs in a terminal tab, Ovis reads
 * the catalog again until the agent is there, then its sign-in runs in a tab of its own. Installed
 * is decided by detection alone, never by the install tab's exit: an installer may end with an error
 * after installing (Devin's sign-in with no browser) or succeed without the agent on PATH yet.
 */
export type SetupStep =
  | { kind: "idle" }
  | { kind: "installing"; tab: AgentTabStarted }
  | { kind: "installed"; version: string | null; onPath: boolean }
  | { kind: "signing-in"; tab: AgentTabStarted; version: string | null }
  | { kind: "ready"; version: string | null }
  | { kind: "failed"; message: string | null; after: "install" | "sign-in" };

export type SetupEvent =
  | { type: "install-started"; tab: AgentTabStarted }
  | { type: "detected"; row: AgentCatalogRow }
  | { type: "sign-in-started"; tab: AgentTabStarted }
  | { type: "sign-in-done" }
  | { type: "skip-sign-in" }
  | { type: "failed"; message: string }
  | { type: "cancel" };

const installedRow = (row: AgentCatalogRow): boolean => row.state.installed === true;

export function setupStep(step: SetupStep, event: SetupEvent): SetupStep {
  switch (event.type) {
    case "install-started":
      return { kind: "installing", tab: event.tab };
    case "detected": {
      if (step.kind !== "idle" && step.kind !== "installing") return step;
      if (!installedRow(event.row)) return step;
      if (!agentRuns(event.row.state)) return step.kind === "installing" ? step : { kind: "failed", message: null, after: "install" };
      const version = event.row.state.version;
      return event.row.sign_in === null ? { kind: "ready", version } : { kind: "installed", version, onPath: event.row.state.on_path !== false };
    }
    case "sign-in-started":
      return step.kind === "installed" || step.kind === "failed" ? { kind: "signing-in", tab: event.tab, version: step.kind === "installed" ? step.version : null } : step;
    case "sign-in-done":
      return step.kind === "signing-in" ? { kind: "ready", version: step.version } : step;
    case "skip-sign-in":
      return step.kind === "installed" ? { kind: "ready", version: step.version } : step;
    case "failed":
      return { kind: "failed", message: event.message, after: step.kind === "signing-in" || step.kind === "installed" ? "sign-in" : "install" };
    case "cancel":
      return { kind: "idle" };
  }
}
