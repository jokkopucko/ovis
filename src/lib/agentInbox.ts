import type { Machine } from "../../shared/machines.ts";
import { parseInline, shownText } from "../../shared/markdown.ts";
import type { AgentStatus, PlanSummary } from "../../shared/protocol.ts";
import { agentGroup, agentRoster, groupAgentRows, type AgentGroup, type AgentRow } from "./agentRoster.ts";
import { fileFromLink, type AppLink } from "./deepLink.ts";
import type { Translate } from "./i18n.ts";
import type { AgentGroupSort } from "./settings.ts";
import type { SidebarActivity } from "./sidebarActivity.tsx";
import type { RowSummary } from "./useInboxSummaries.ts";
import { capped } from "./promptText.ts";
import { machineFilter, sidebarFilter } from "./sidebarFilter.ts";
import { sidebarPinKey } from "./sidebarPins.ts";

export const INBOX_FILTERS = ["all", "blocked", "working", "done"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

export function inboxKey(row: AgentRow): string {
  return sidebarPinKey(row.machine.id, row.entry.pane.pane_id);
}

export function inboxStatus(row: AgentRow, activity: SidebarActivity): AgentStatus | undefined {
  return row.machine.state === "connected" ? activity.status(row.machine.id, row.entry.pane) : undefined;
}

export function inboxOrder(machines: readonly Machine[], activity: SidebarActivity, { sort = "wait", name = () => "" }: { sort?: AgentGroupSort; name?: (row: AgentRow) => string } = {}): AgentRow[] {
  const rows = agentRoster(machines, { byActivity: false, seqs: activity.seqs, pinned: [] }).rest;
  return groupAgentRows(rows, { sort, status: (row) => inboxStatus(row, activity), name, seqs: activity.seqs })
    .flatMap((group) => group.rows);
}

export function inboxFiltered(rows: readonly AgentRow[], filter: InboxFilter, activity: SidebarActivity): AgentRow[] {
  return filter === "all" ? [...rows] : rows.filter((row) => agentGroup(inboxStatus(row, activity)) === filter);
}

export function inboxSearched(rows: readonly AgentRow[], query: string, machines: readonly Machine[], t: Translate, words: (row: AgentRow) => string | null): AgentRow[] {
  const filter = sidebarFilter(query, machines, { machineId: "", paneId: null }, t);
  if (!filter.active) return [...rows];
  const typed = query.trim().toLowerCase();
  return rows.filter((row) => machineFilter(filter, row.machine.id)?.panes.has(row.entry.pane.pane_id) === true || (words(row)?.toLowerCase().includes(typed) ?? false));
}

export function heldOrder<T>(rows: readonly T[], keyOf: (row: T) => string, held: readonly string[]): T[] {
  const place = new Map(held.map((key, index) => [key, index]));
  const rank = (row: T): number => place.get(keyOf(row)) ?? held.length;
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

export function inboxEmpty(machines: readonly Machine[], total: number, shown: number): "loading" | "none" | "no-match" | null {
  if (total === 0) return machines.length === 0 || machines.some((machine) => machine.state === "connected" && machine.snapshot === null) ? "loading" : "none";
  return shown === 0 ? "no-match" : null;
}

export function plainWords(text: string): string | null {
  const bare = text.trim();
  const shown = (bare === "" ? "" : shownText(parseInline(bare, false)) ?? bare).trim();
  return shown === "" ? null : shown;
}

export function questionWords(words: { question: string; body: string | null }): string {
  const first = words.body?.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
  return capped([words.question.trim(), first].filter((part) => part !== "").join("\n"), 240);
}

export function inboxWords(input: { group: AgentGroup; blocked: string | null; question: string | null; plan: PlanSummary | undefined; last: string | null }): string | null {
  if (input.group === "blocked") return input.blocked ?? input.question ?? input.last;
  if (input.group === "working") return input.plan?.current?.trim() || input.last;
  return input.last;
}

/**
 * Since when a row is in its state (ms): a waiting agent since this device saw it begin to wait (`waitStart`, the
 * stamp the Agents list reads too, lib/agentStateSince.ts), else since its last message (herdr tells no time of a
 * state change: the summary's time of its last words, which a done or ready row draws too, where the Agents list says
 * none); a working agent since the user last asked it, any other since its last words.
 */
export function inboxSinceAt(group: AgentGroup, summary: RowSummary | null | undefined, waitStart: number | null): number | null {
  if (group === "blocked") return waitStart ?? summary?.at ?? null;
  if (!summary) return null;
  return group === "working" ? summary.askedAt ?? summary.at : summary.at;
}

export function inboxStartsOpen(enabled: boolean, link: AppLink | null): boolean {
  return enabled && !(link !== null && Boolean(link.pane || link.workspace || fileFromLink(link)));
}
