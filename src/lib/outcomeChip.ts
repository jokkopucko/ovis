/**
 * A command the transcript keeps no
 * turn for (Claude's /btw, an informational command) gets a provisional sent row of its own, placed
 * by send time; a later user turn matching the text takes the chip over and the row goes, so nothing
 * shows twice.
 */
import type { CommandOutcome, ConversationTurn } from "../../shared/protocol.ts";
import { sameMessage } from "./compose.ts";
import type { Translate } from "./i18n.ts";

export type OutcomeState = CommandOutcome["state"];
export type OutcomeEvidence = CommandOutcome["evidence"][number]["kind"];

export interface OutcomeChip {
  readonly state: OutcomeState;
  readonly evidence: OutcomeEvidence | null;
  readonly action: "answer" | "terminal" | null;
}

export function outcomeChip(outcome: CommandOutcome): OutcomeChip {
  const evidence = outcome.state === "result-observed" ? outcome.evidence.at(-1)?.kind ?? null : null;
  const action = outcome.state === "interaction-required" ? "answer" : outcome.state === "terminal-required" ? "terminal" : null;
  return { state: outcome.state, evidence, action };
}

export function outcomeLabel(t: Translate, chip: OutcomeChip): string {
  switch (chip.state) {
    case "accepted": return t("Accepted");
    case "interaction-required": return t("Waiting for your answer");
    case "result-observed": return chip.evidence === null ? t("Done") : t("Done · {evidence}", { evidence: evidenceWord(t, chip.evidence) });
    case "terminal-required": return t("Runs in the terminal");
    case "unknown": return t("No result seen");
  }
}

/** Why the command went as plain text, when the agent did not attach a skill it names (OpenCode v2); null otherwise. */
export function outcomeNote(t: Translate, outcome: CommandOutcome): string | null {
  const skills = outcome.unattached_skills ?? [];
  if (skills.length === 0) return null;
  return t("Not attached, sent as plain text: {skills}", { skills: skills.map((id) => `@${id}`).join(", ") });
}

function evidenceWord(t: Translate, kind: OutcomeEvidence): string {
  switch (kind) {
    case "transcript": return t("transcript");
    case "dialog": return t("card answered");
    case "recognized-result": return t("result on screen");
    case "native": return t("agent event");
    case "side-store": return t("saved state");
  }
}

export function outcomeCommand(text: string): string {
  const token = /(?:^|\s)([/$][^\s]+)/.exec(text)?.[1];
  if (token !== undefined) return token;
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

export type OutcomeRow =
  | { readonly kind: "turn"; readonly index: number; readonly outcome: CommandOutcome | null }
  | { readonly kind: "sent"; readonly outcome: CommandOutcome };

export interface OutcomeRowOptions {
  readonly restored?: string | null;
  readonly beginningLoaded?: boolean;
}

const SEND_SKEW_MS = 2_000;

function turnText(turn: ConversationTurn): string {
  // a bash-mode command was sent as `!` and the command
  return turn.parts.flatMap((part) => part.kind === "text" ? [part.text] : part.kind === "shell" ? [`!${part.command}`] : []).join("\n\n");
}

function turnTime(turn: ConversationTurn): number | null {
  const time = turn.ts === null ? Number.NaN : Date.parse(turn.ts);
  return Number.isNaN(time) ? null : time;
}

export function outcomeRows(turns: readonly ConversationTurn[], outcomes: readonly CommandOutcome[], options: OutcomeRowOptions = {}): OutcomeRow[] {
  const { restored = null, beginningLoaded = false } = options;
  const onTurn = new Map<number, CommandOutcome>();
  const sentBefore: { outcome: CommandOutcome; before: number }[] = [];
  const times = turns.map(turnTime);
  const firstKnown = times.find((time): time is number => time !== null);
  const bounds: (number | null)[] = [];
  for (let index = turns.length - 1, next: number | null = null; index >= 0; index -= 1) bounds[index] = next = times[index] ?? next;
  const ordered = [...outcomes].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const cancelled = restored === null ? undefined : [...ordered].reverse().find((outcome) => sameMessage(outcome.text, restored));
  for (const outcome of ordered) {
    if (outcome === cancelled) continue;
    const sentAt = Date.parse(outcome.created_at);
    const match = turns.findIndex((turn, index) => {
      const bound = bounds[index] ?? null;
      return turn.role === "user" && !onTurn.has(index) && (bound === null || bound >= sentAt - SEND_SKEW_MS) && sameMessage(turnText(turn), outcome.text);
    });
    if (match >= 0) { onTurn.set(match, outcome); continue; }
    if (!beginningLoaded && firstKnown !== undefined && sentAt < firstKnown - SEND_SKEW_MS) continue;
    const before = times.findIndex((time) => time !== null && time > sentAt);
    sentBefore.push({ outcome, before: before < 0 ? turns.length : before });
  }
  const rows: OutcomeRow[] = [];
  for (let index = 0; index <= turns.length; index += 1) {
    for (const sent of sentBefore) if (sent.before === index) rows.push({ kind: "sent", outcome: sent.outcome });
    if (index < turns.length) rows.push({ kind: "turn", index, outcome: onTurn.get(index) ?? null });
  }
  return rows;
}

export function outcomeResultText(outcome: CommandOutcome, dismissed: boolean): string | null {
  if (dismissed || outcome.state !== "result-observed" || outcome.evidence.at(-1)?.kind !== "recognized-result") return null;
  return outcome.result_text || null;
}

const SESSION_CHANGE = /^\/(?:clear|new|reset|resume)(?:\s|$)/iu;

export function isSessionChange(outcome: CommandOutcome): boolean {
  return SESSION_CHANGE.test(outcome.text.trim());
}

export interface HistoryMove {
  readonly held: readonly CommandOutcome[];
  readonly entered: ReadonlySet<string>;
  readonly seenAt: number;
}

export function moveCommand(outcomes: readonly CommandOutcome[], move: HistoryMove): CommandOutcome | null {
  const changes = (list: readonly CommandOutcome[]) => list.filter((outcome) => isSessionChange(outcome) && !move.entered.has(outcome.id))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  return changes(move.held).at(-1)
    ?? changes(outcomes).find((outcome) => Date.parse(outcome.created_at) <= move.seenAt + SEND_SKEW_MS) ?? null;
}

/**
 * The outcomes of a conversation the chat moved to, without the sends to the one it left. `made` is the
 * send that made the move (moveCommand). Every send before it, by the server's send times, is the old
 * conversation's, also one a later poll lists first, except after a /resume: a send whose turn the
 * resumed conversation recorded before the /resume was sent there. /clear, /new and /reset start an
 * empty conversation, which records none of them.
 */
export function afterMove(outcomes: readonly CommandOutcome[], move: HistoryMove, made: CommandOutcome | null, turns: readonly ConversationTurn[]): readonly CommandOutcome[] {
  if (made === null) return outcomes === move.held ? [] : outcomes;
  const at = Date.parse(made.created_at);
  const resumed = /^\/resume(?:\s|$)/iu.test(made.text.trim());
  const before = turns.filter((turn) => turn.ts !== null && Date.parse(turn.ts) < at);
  const earlier = outcomes.filter((outcome) => Date.parse(outcome.created_at) < at);
  const recorded = new Set(resumed ? outcomeRows(before, earlier, { beginningLoaded: true })
    .flatMap((row) => row.kind === "turn" && row.outcome !== null ? [row.outcome.id] : []) : []);
  return outcomes.filter((outcome) => Date.parse(outcome.created_at) >= at || recorded.has(outcome.id));
}

export function noteCatalogChanges(outcomes: readonly CommandOutcome[], noted: Set<string>, invalidate: () => void): void {
  for (const outcome of outcomes) {
    if (outcome.catalog_changed !== true || noted.has(outcome.id)) continue;
    noted.add(outcome.id);
    invalidate();
  }
}
