import type { AgentStatus } from "../../shared/protocol.ts";
import { knownStatus, type KnownStatus } from "../../shared/attention.ts";

export { knownStatus, rollupStatus, type KnownStatus } from "../../shared/attention.ts";

export const STATUS_WORD: Readonly<Record<KnownStatus, string>> = {
  idle: "READY",
  working: "RUN",
  blocked: "INPUT",
  done: "DONE",
  waiting: "BG",
  unknown: "—",
};

/** herdr's two status indicator sets, its `[ui] status_indicators` ("dots" is herdr's default). */
export type HerdrIndicators = "dots" | "symbols";
export type StatusIndicators = "classic" | HerdrIndicators;

/**
 * The glyph herdr's TUI draws for each state (its client/shell.rs `status_icon`). BG is not a herdr
 * state: it takes RUN's glyph, held still.
 */
const INDICATOR_GLYPH: Readonly<Record<HerdrIndicators, Readonly<Record<KnownStatus, string>>>> = {
  dots: { idle: "\u25CB", working: "\u25CF", blocked: "\u25CF", done: "\u25CF", waiting: "\u25CF", unknown: "\u00B7" },
  symbols: { idle: "\u25CB", working: "\u25D0", blocked: "\u00D7", done: "\u2713", waiting: "\u25D0", unknown: "\u00B7" },
};

export function indicatorGlyph(status: KnownStatus, style: HerdrIndicators): string {
  return INDICATOR_GLYPH[style][status];
}

export function paneStatus(pane: { agent_status?: AgentStatus; background_wait?: true }): KnownStatus {
  const known = knownStatus(pane.agent_status);
  return pane.background_wait && known !== "working" && known !== "blocked" ? "waiting" : known;
}

/**
 * Whether a pushed status change should read the conversation now instead of waiting for a
 * transcript push or the backstop: a turn starts or ends when the pane enters or leaves
 * `working`, and the chat's last block follows the status while the transcript it holds is
 * older than that status (a chat without pushes reads only every 2 s).
 */
export function statusEdgeRead(previous: AgentStatus | undefined, next: AgentStatus | undefined): boolean {
  return previous !== next && (previous === "working" || next === "working");
}
