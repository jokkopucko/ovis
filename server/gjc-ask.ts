import { askedQuestions } from "../shared/askQuestions.ts";
import type { InteractivePrompt } from "../shared/protocol.ts";
import { paneTranscript } from "./conversation.ts";
import { ConversationUnavailable } from "./conversation-shared.ts";
import { gjcMenuShown } from "./dialogs/fallback.ts";
import { gjcRecord } from "./dialogs/gjc-record.ts";
import { commandCut } from "./dialogs/record.ts";
import { parsedByPublicPrompt, publicPrompt } from "./dialogs/shared.ts";
import { OmoAskReader, ompAsksAfter, type OmoAsks } from "./omo-ask.ts";
import { alike, cardDrawn, drawn, shows } from "./omp-ask.ts";
import { withGjcRecordAt } from "./record-cards.ts";

/** the row gjc's ask (0.22) adds under a question's options (tools/ask.ts `OTHER_OPTION`); it numbers it, and adds a
 * clarification row, only for a deep-interview question, which this does not read */
const OTHER = "Other (type your own)";
/** gjc adds this to the recommended option's label before it draws it (tools/ask.ts `RECOMMENDED_SUFFIX`) */
const RECOMMENDED = " (Recommended)";
/** the rows gjc's selector draws over and under a title taller than its rows (hook-selector.ts `ScrollableTitle`) */
const MORE_ABOVE = "▲ more";
const MORE_BELOW = "▼ more";

const flat = (text: string): string => text.replace(/\s+/gu, " ").trim();

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const COMBINING_RE = /^[\p{Mark}\p{Cf}]+$/u;
const WIDE_GRAPHEME_RE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|[\u1100-\u115F\u2329\u232A\u2E80-\u303E\u3040-\u33FF\u3400-\u4DBF\u4E00-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

function graphemeCells(grapheme: string): number {
  if (COMBINING_RE.test(grapheme)) return 0;
  return WIDE_GRAPHEME_RE.test(grapheme) ? 2 : 1;
}

function cellWidth(text: string): number {
  let width = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) width += graphemeCells(segment);
  return width;
}

function firstCharWidth(text: string): number {
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
    const w = graphemeCells(segment);
    if (w > 0) return w;
  }
  return 1;
}

/**
 * Whether the selector's title rows draw `markdown` whole. Truncated titles (`▲ more` / `▼ more`)
 * are never bound because another call can share the same visible prefix. Mid-word soft wraps
 * (e.g. CJK or long unspaced tokens wrapped at the pane width) are joined without a space only
 * when the previous row was full enough that the next character could not have fit on it.
 */
function titleShown(rows: readonly string[], markdown: string, width?: number): boolean {
  if (rows.length === 0 || rows[0] === MORE_ABOVE || rows.at(-1) === MORE_BELOW) return false;
  const expected = drawn(markdown, true);
  if (expected === null) return false;
  if (shows(rows.join("\n"), expected)) return true;
  if (width === undefined || rows.length < 2) return false;
  // gjc indents title lines by one space on the left inside the pane border
  const maxCols = Math.max(1, width - 2);
  const asked = flat(expected);
  const cleaned = rows.map((row) => flat(row));
  if (cleaned.some((row) => row === "")) return false;
  let positions = new Set([0]);
  for (let i = 0; i < cleaned.length; i++) {
    const row = cleaned[i]!;
    const next = new Set<number>();
    const prev = i > 0 ? cleaned[i - 1]! : "";
    const canJoinTight = i > 0 && cellWidth(prev) + firstCharWidth(row) > maxCols;
    for (const pos of positions) {
      if (i === 0) {
        if (asked.startsWith(row, pos)) next.add(pos + row.length);
        continue;
      }
      if (asked[pos] === " " && asked.startsWith(row, pos + 1)) next.add(pos + 1 + row.length);
      if (canJoinTight && asked.startsWith(row, pos)) next.add(pos + row.length);
    }
    positions = next;
    if (positions.size === 0) return false;
  }
  return positions.has(asked.length);
}

/** Whether the selector's rows (Esc left out) are the call's labels as drawn, then gjc's Other row. */
function optionsShown(rows: readonly string[], labels: readonly string[]): boolean {
  return rows.length === labels.length + 1 && rows.at(-1) === OTHER
    && labels.every((label, index) => shows(rows[index]!, drawn(label, false)));
}

export function gjcOpenCall(open: OmoAsks, session: string): string | null {
  return open.length === 1 && session ? JSON.stringify([session, open[0]!.id]) : null;
}

/**
 * gjc's ask in the agent's own Markdown. gjc asks through its selector (`ctx.ui.select`), which the generic card reads off
 * the screen (dialogs/fallback.ts): it takes the title's last row for the question and the rows above it for a body,
 * and the Markdown gjc drew is lost. The session's one open `ask` call gives the question back whole when the selector
 * on screen provably draws one of its single-choice questions whole (never a truncated `▼ more`/`▲ more` title): its
 * title rows are that question as gjc draws it (with its `(n/m)` when the call asks more than one), and its rows are
 * that question's labels, the recommended one with gjc's ` (Recommended)`, in order, then Other. Anything else leaves
 * the card as read. When a session path is provided, the card binds that open call identity (`gjcCall`) so a replacement
 * ask cannot consume a stale answer.
 */
export function gjcAskPrompt(prompt: InteractivePrompt, open: OmoAsks, session = ""): InteractivePrompt {
  const parsed = parsedByPublicPrompt.get(prompt);
  const title = parsed?.gjcTitleRows;
  if (parsed?.responder !== "fallback-gjc-menu" || title === undefined || open.length !== 1) return prompt;
  const rows = parsed.menuLabels.slice(0, -1);
  const questions = askedQuestions("ask", open[0]!.args) ?? [];
  const matches = questions.flatMap((asked, index) => {
    if (asked.multi || asked.options.length === 0) return [];
    const markdown = questions.length > 1 ? `${asked.question} (${index + 1}/${questions.length})` : asked.question;
    // gjc takes no recommendation on a question of one option (tools/ask.ts `validRecommendedIndex`)
    const recommended = asked.options.length > 1 ? asked.recommended : null;
    const screenLabels = asked.options.map((option, at) => at === recommended && !option.label.endsWith(RECOMMENDED) ? `${option.label}${RECOMMENDED}` : option.label);
    return titleShown(title, markdown, parsed.gjcTitleWidth) && optionsShown(rows, screenLabels)
      ? [{ index, markdown, rawOptions: asked.options, recommended, screenLabels }]
      : [];
  });
  if (matches.length !== 1) return prompt;
  const { index, markdown, rawOptions, recommended, screenLabels } = matches[0]!;
  // labels the card or terminal would show alike are told apart by place alone: the card stays as drawn (#2233)
  const shown = rawOptions.map((option) => alike(cardDrawn(option.label, false) ?? option.label));
  const drawnScreen = screenLabels.map((label) => alike(cardDrawn(label, false) ?? label));
  if (new Set(shown).size !== shown.length || new Set(drawnScreen).size !== drawnScreen.length) return prompt;
  const gjcCall = session ? JSON.stringify([session, open[0]!.id, index]) : undefined;
  return publicPrompt(gjcMenuShown(parsed, {
    question: markdown, body: null, text_format: "markdown",
    ...(gjcCall === undefined ? {} : { gjcCall }),
    options: [
      ...rawOptions.map((option, at) => ({
        label: option.label,
        description: null,
        ...(at === recommended ? { recommended: true as const } : {}),
      })),
      ...parsed.options.slice(rawOptions.length),
    ],
  }));
}

const reader = new OmoAskReader(ompAsksAfter);
const unreadable = new Set<string>();

/** Synchronously checks whether the bound `gjcCall` is still the one open ask in its already-verified session file. */
export function gjcCallStillOpenInFile(gjcCall: string): boolean {
  let expected: [string, string, number];
  try { expected = JSON.parse(gjcCall) as [string, string, number]; } catch { return false; }
  if (!Array.isArray(expected) || typeof expected[0] !== "string" || typeof expected[1] !== "string") return false;
  try {
    const open = reader.read(expected[0]);
    return open.length === 1 && open[0]!.id === expected[1];
  } catch {
    return false;
  }
}

/** Whether the gjc ask call bound in `gjcCall` is still the pane's one open ask call. */
export async function gjcCallStillOpen(paneId: string, gjcCall: string): Promise<boolean> {
  let expected: [string, string, number];
  try { expected = JSON.parse(gjcCall) as [string, string, number]; } catch { return false; }
  if (!Array.isArray(expected) || typeof expected[0] !== "string" || typeof expected[1] !== "string") return false;
  try {
    const found = await paneTranscript(paneId);
    if (found.source !== "gjc-transcript" || found.path !== expected[0]) return false;
    const open = reader.read(found.path);
    return open.length === 1 && open[0]!.id === expected[1];
  } catch {
    return false;
  }
}

/**
 * Resolves a gjc selector's transcript once and applies either its pending shell-approval record
 * (`withGjcRecordAt`) or its open `ask` call Markdown (`gjcAskPrompt`), avoiding back-to-back
 * transcript lookups during prompt reads and answer verification. Record binding stays active
 * even when `enrich` is false (e.g. cursor-move rereads on a shell approval).
 */
export async function withGjcFallback(paneId: string, card: InteractivePrompt, screen: string, enrich = true): Promise<InteractivePrompt | null> {
  if (parsedByPublicPrompt.get(card)?.responder !== "fallback-gjc-menu") return card;
  if (commandCut(screen, gjcRecord)) return null;
  let path: string | null = null;
  try {
    const found = await paneTranscript(paneId);
    if (found.source === "gjc-transcript") path = found.path;
  } catch (error) {
    if (error instanceof ConversationUnavailable || (error as NodeJS.ErrnoException).code === "ENOENT") return card;
    const kind = error instanceof Error ? error.name : typeof error;
    if (!unreadable.has(kind)) {
      unreadable.add(kind);
      console.warn(`prompt: gjc's session could not be read for pane ${paneId}; its ask card stays the screen's (${error instanceof Error ? error.message : String(error)})`);
    }
    return card;
  }
  const recorded = await withGjcRecordAt(paneId, card, screen, path);
  if (!enrich || recorded === null || parsedByPublicPrompt.get(recorded)?.record !== undefined || path === null) return recorded;
  try {
    return gjcAskPrompt(recorded, reader.read(path), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return recorded;
    const kind = error instanceof Error ? error.name : typeof error;
    if (!unreadable.has(kind)) {
      unreadable.add(kind);
      console.warn(`prompt: gjc's session could not be read for pane ${paneId}; its ask card stays the screen's (${error instanceof Error ? error.message : String(error)})`);
    }
    return recorded;
  }
}

/** A gjc selector's card with its open ask call's Markdown (gjcAskPrompt), or as read when the pane's session cannot be found. */
export async function withGjcAsk(paneId: string, card: InteractivePrompt): Promise<InteractivePrompt> {
  if (parsedByPublicPrompt.get(card)?.responder !== "fallback-gjc-menu") return card;
  try {
    const found = await paneTranscript(paneId);
    return found.source === "gjc-transcript" ? gjcAskPrompt(card, reader.read(found.path), found.path) : card;
  } catch (error) {
    if (error instanceof ConversationUnavailable || (error as NodeJS.ErrnoException).code === "ENOENT") return card;
    const kind = error instanceof Error ? error.name : typeof error;
    if (!unreadable.has(kind)) {
      unreadable.add(kind);
      console.warn(`prompt: gjc's session could not be read for pane ${paneId}; its ask card stays the screen's (${error instanceof Error ? error.message : String(error)})`);
    }
    return card;
  }
}
