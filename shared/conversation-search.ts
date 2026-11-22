import type { ConversationTurn } from "./protocol.ts";

/**
 * GET /api/pane/conversation/search?pane_id=&q=[&before=&history_id=]: the pane's conversation
 * searched for `q`, newest first, over what the chat shows as messages: what the user wrote and
 * the agent's answers, never a tool's input or output, its thinking or its progress notes. One
 * answer searches a few pages at most; `cursor` goes on from where it stopped.
 */
export interface ConversationSearchResponse {
  /** the history the pages were read from: pass it back with `cursor`, a changed one answers 409 history_changed */
  history_id?: string;
  /** newest first, one per turn */
  matches: ConversationSearchMatch[];
  /** pass as `before` to search the pages before these; null once the conversation's first page was searched */
  cursor: string | null;
}

/** One turn that holds the query, with the words around its first match. */
export interface ConversationSearchMatch {
  /** the turn's identity, as the chat names its rows (conversationTurnAnchor) */
  turn: string;
  role: "user" | "assistant";
  ts: string | null;
  /**
   * the turn's whole searched text, Markdown marks and all, when it was searched, as a digest (textDigest):
   * which of turns that share the name is the one, and whether it changed since. An older server
   * sends none.
   */
  text_digest?: string;
  /**
   * the store row the match begins in (ConversationTurn.text_rows), for an agent whose turns have
   * them: the pick opens the turn shown with that row, whatever either was named from
   */
  row?: number;
  /** the text before the match, the match and the text after it, each with whitespace runs as one space */
  before: string;
  match: string;
  after: string;
}

/** a query longer than this is refused: no message is found by a paragraph of it */
export const MAX_SEARCH_QUERY = 200;
const SNIPPET_BEFORE = 32;
const SNIPPET_AFTER = 160;
const WORD_CUT = 16;

/**
 * A turn's identity that survives a remount and another page size: row keys are browser slots
 * that a new mount allocates again, so the turn is named by what it is: its role, its time and
 * how its first part begins. Only the beginning counts: a turn still streaming keeps the name it had.
 * A Codex picture names a turn only when nothing else is in it: Codex pairs a prompt's inline copy
 * of a picture with its file a moment later, and the picture's ref (`codex-<hash>`) changes then
 * (server/codex.ts). Any other agent's picture keeps its ref, so it still tells two prompts apart.
 */
export function conversationTurnAnchor(turn: ConversationTurn): string {
  const first = turn.parts.find((part) => part.kind !== "image" || !part.ref.startsWith("codex-")) ?? turn.parts[0];
  const head = first === undefined ? "" : "text" in first ? first.text.slice(0, 80) : JSON.stringify(first).slice(0, 80);
  return `${turn.role}|${turn.ts ?? ""}|${first?.kind ?? ""}|${head}`;
}

const plainText = (markdown: string): string => linkLabels(markdown
  .replace(/^ {0,3}(?:```|~~~).*$/gm, "")
  .replace(/^ {0,3}(?:#{1,6}|>|[-*+]|\d{1,9}[.)])[ \t]+/gm, ""))
  .replace(/\*\*|`/g, "");

/**
 * `[label](address)` and `![alt](address)` as the label alone: what
 * `.replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")` gives, read in one pass. That pattern starts over
 * at every `[` and reads on to the line's end from each, so a long line of brackets that never
 * close (a log, minified text) took its length squared, on the server's only thread.
 */
function linkLabels(text: string): string {
  const pieces: string[] = [];
  let kept = 0;
  let open = text.indexOf("[");
  while (open >= 0) {
    let close = open + 1;
    while (close < text.length && text[close] !== "]" && text[close] !== "\n") close++;
    if (close === text.length) break;
    if (text[close] === "\n" || text[close + 1] !== "(") { open = text.indexOf("[", close + 1); continue; }
    let end = close + 2;
    while (end < text.length && text[end] !== ")" && text[end] !== "\n") end++;
    if (end === text.length) break;
    if (text[end] === "\n") { open = text.indexOf("[", end + 1); continue; }
    pieces.push(text.slice(kept, open > kept && text[open - 1] === "!" ? open - 1 : open), text.slice(open + 1, close));
    kept = end + 1;
    open = text.indexOf("[", kept);
  }
  return kept === 0 ? text : pieces.join("") + text.slice(kept);
}

export function searchableText(turn: ConversationTurn): string {
  return turn.parts.flatMap((part) => part.kind === "text" && (turn.role === "user" || part.phase !== "commentary") ? [plainText(part.text)] : []).join("\n\n");
}

/**
 * The query as a pattern: its words in order, any whitespace between them, case ignored. Null
 * for a blank one.
 */
export function searchPattern(query: string): RegExp | null {
  const words = query.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return null;
  return new RegExp(words.map((word) => word.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")).join("\\s+"), "iu");
}

const squash = (text: string): string => text.replace(/\s+/g, " ");

/**
 * The text parts a search reads (searchableText), as written: marks the search drops still tell two
 * turns apart. A 32-bit FNV-1a hash and its length (two texts can still collide).
 */
function textDigest(turn: ConversationTurn): string {
  const text = turn.parts.flatMap((part) => part.kind === "text" && (turn.role === "user" || part.phase !== "commentary") ? [part.text] : []).join("\n\n");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return `${text.length.toString(36)}.${(hash >>> 0).toString(36)}`;
}

const saysSearched = (turn: ConversationTurn, match: ConversationSearchMatch): boolean =>
  match.text_digest !== undefined && textDigest(turn) === match.text_digest;

const allText = (turn: ConversationTurn): string => turn.parts.flatMap((part) => part.kind === "text" ? [plainText(part.text)] : []).join("\n\n");

export function matchSnippet(text: string, pattern: RegExp): Pick<ConversationSearchMatch, "before" | "match" | "after"> | null {
  const found = pattern.exec(text);
  if (found === null) return null;
  const start = found.index, end = start + found[0].length;
  const lead = Array.from(squash(text.slice(Math.max(0, start - SNIPPET_BEFORE * 4), start).replace(/^[\uDC00-\uDFFF]/, "")).trimStart());
  const trail = Array.from(squash(text.slice(end, end + SNIPPET_AFTER * 4).replace(/[\uD800-\uDBFF]$/, "")).trimEnd());
  const kept = lead.slice(-SNIPPET_BEFORE).join(""), space = kept.indexOf(" ");
  const before = lead.length > SNIPPET_BEFORE || start > SNIPPET_BEFORE * 4 ? `…${space >= 0 && space < WORD_CUT ? kept.slice(space + 1) : kept}` : lead.join("");
  const shown = trail.slice(0, SNIPPET_AFTER).join(""), last = shown.lastIndexOf(" ");
  const after = trail.length > SNIPPET_AFTER || end + SNIPPET_AFTER * 4 < text.length ? `${last > shown.length - WORD_CUT ? shown.slice(0, last) : shown}…` : trail.join("");
  return { before, match: squash(found[0]), after };
}

/** Two answers of one time (Codex, when the user steers mid-task) can both pass: see pickedTurn. */
export function searchedTurnChanged(turn: ConversationTurn, match: ConversationSearchMatch): boolean {
  if (turn.role !== match.role || turn.ts !== match.ts) return false;
  const name = conversationTurnAnchor(turn);
  const prefix = `${turn.role}|${turn.ts ?? ""}|`;
  if (!match.turn.startsWith(prefix)) return false;
  const began = match.turn.slice(prefix.length), now = name.slice(prefix.length);
  const output = began.startsWith("tool|") ? began.indexOf('"output":') : -1;
  if (!now.startsWith(output < 0 ? began : began.slice(0, output))) return false;
  const pattern = searchPattern(match.match);
  const snippet = pattern === null ? null : matchSnippet(searchableText(turn), pattern);
  if (snippet === null || snippet.match !== match.match) return false;
  const words = (before: string): string => before.replace(/^…/, "").replace(/!?\[|[\]*`]/g, "");
  const was = words(match.before), after = words(snippet.before);
  const sameBefore = !match.before.startsWith("…") && !snippet.before.startsWith("…") ? was === after
    : was !== "" && after !== "" && (after.endsWith(was) || was.endsWith(after));
  const marks = (text: string): string => text.replace(/…$/, "").replace(/!?\[|[\]*`]/g, "");
  const went = marks(match.after), goes = marks(snippet.after);
  return sameBefore && (goes.startsWith(went) || went.startsWith(goes));
}

/**
 * Turns of its time that share the name (their first 80 characters agree, or their first tool call) go
 * by which still has the matched words anywhere in its text, a progress note's too: an answer's words
 * never leave it, though they can leave the search (Codex marks them commentary later). When several
 * still have them, the one that says exactly what was searched, unless another may have said it then
 * and changed since: any turn went on from the match's words (its name too may have changed), or a
 * turn of its role and time has a progress note (Codex marks an answer's parts commentary later, so
 * what it said then is not known). Turns without a time (Kimi's prompts) go by name and their whole
 * searched text: the first of the name that still says it, else the one of the name that changed
 * since; by name only for a match of an older server, which has no digest. A match with a store row
 * (Hermes) opens the turn with a text part read from it, whatever either was named from: a page
 * boundary may split one answer at another row.
 */
export function pickedTurn(turns: readonly (ConversationTurn | null)[], match: ConversationSearchMatch): number | "none" | "several" {
  if (match.row !== undefined) {
    const row = match.row;
    const index = turns.findIndex((turn) => turn?.text_rows?.includes(row) === true);
    if (index >= 0) return index;
    const { row: _, ...named } = match;
    return pickedTurn(turns.map((turn) => turn?.text_rows === undefined ? turn : null), named);
  }
  const names = turns.flatMap((turn, index) => turn != null && conversationTurnAnchor(turn) === match.turn ? [index] : []);
  if (match.ts === null) {
    if (match.text_digest === undefined) return names[0] ?? "none";
    const same = names.find((index) => saysSearched(turns[index]!, match));
    if (same !== undefined) return same;
    const changed = names.filter((index) => searchedTurnChanged(turns[index]!, match));
    return changed.length > 1 ? "several" : changed[0] ?? "none";
  }
  const pattern = searchPattern(match.match);
  const holds = (index: number): boolean => pattern !== null && pattern.test(allText(turns[index]!));
  let holding = names.length > 1 ? names.filter(holds) : names;
  if (holding.length > 1) {
    const same = holding.filter((index) => saysSearched(turns[index]!, match));
    const noted = (turn: ConversationTurn): boolean => turn.parts.some((part) => part.kind === "text" && part.phase === "commentary");
    if (same.length === 1 && turns.every((turn, index) => index === same[0] || turn == null
      || (turn.role !== match.role || turn.ts !== match.ts || !noted(turn)) && !searchedTurnChanged(turn, match))) holding = same;
  }
  if (holding.length > 1 || names.length > 1 && holding.length === 0) return "several";
  const named = holding[0] ?? -1;
  let changed: number | null = null;
  for (let index = 0; index < (named >= 0 ? named : turns.length); index++) {
    const turn = turns[index];
    if (turn == null || !searchedTurnChanged(turn, match)) continue;
    if (changed !== null || named >= 0) return "several";
    changed = index;
  }
  return named >= 0 ? named : changed ?? "none";
}

/**
 * A turn that changed since loses its name only to a later turn of its time (pickedTurn), so a pick
 * reads on until a turn before the named one is of an earlier time: turns come in time order, but for
 * answers dated by an earlier start (Codex, when the user steers mid-task), which all follow that
 * start. That holds only while a turn of the name still says what was searched: a clock that went
 * back (Hermes orders by its own ids) puts a turn of the match's time after an earlier one, so when
 * none does the pick reads to the beginning.
 */
export function pickSettled(turns: readonly ConversationTurn[], match: ConversationSearchMatch): boolean {
  if (match.row !== undefined) {
    const row = match.row, read = turns.flatMap((turn) => turn.text_rows ?? []);
    const { row: _, ...named } = match;
    if (read.length === 0) return pickSettled(turns, named);
    if (read.some((each) => each <= row)) return true;
    return pickSettled(turns.filter((turn) => turn.text_rows === undefined), named);
  }
  const named = turns.findIndex((turn) => conversationTurnAnchor(turn) === match.turn);
  if (named < 0) return false;
  if (match.text_digest !== undefined && !turns.some((turn) => conversationTurnAnchor(turn) === match.turn && saysSearched(turn, match))) return false;
  if (match.ts === null) return true;
  const at = Date.parse(match.ts);
  return turns.slice(0, named).some((turn) => turn.ts !== null && Date.parse(turn.ts) < at);
}

/**
 * Whether the search read a store row (Hermes) newer than every row the turns were read from: the
 * chat has not read its newest page since, or the row is gone (false when no turn has rows).
 */
export function pickAhead(turns: readonly (ConversationTurn | null)[], match: ConversationSearchMatch): boolean {
  const row = match.row, read = turns.flatMap((turn) => turn?.text_rows ?? []);
  return row !== undefined && read.length > 0 && read.every((each) => each < row);
}

export function matchPart(turn: ConversationTurn, pattern: RegExp): number | undefined {
  const found = pattern.exec(searchableText(turn));
  if (found === null) return undefined;
  let end = 0;
  for (const [index, part] of turn.parts.entries()) {
    if (part.kind !== "text" || turn.role !== "user" && part.phase === "commentary") continue;
    end += plainText(part.text).length + 2;
    if (found.index < end) return index;
  }
  return undefined;
}

function matchRow(turn: ConversationTurn, pattern: RegExp): number | undefined {
  const rows = turn.text_rows;
  const index = rows === undefined ? undefined : matchPart(turn, pattern);
  if (rows === undefined || index === undefined) return undefined;
  return rows[turn.parts.slice(0, index).filter((part) => part.kind === "text").length];
}

export function searchTurns(turns: readonly ConversationTurn[], pattern: RegExp): ConversationSearchMatch[] {
  const matches: ConversationSearchMatch[] = [];
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!;
    const snippet = matchSnippet(searchableText(turn), pattern);
    if (snippet === null) continue;
    const row = matchRow(turn, pattern);
    matches.push({ turn: conversationTurnAnchor(turn), role: turn.role, ts: turn.ts, text_digest: textDigest(turn), ...(row === undefined ? {} : { row }), ...snippet });
  }
  return matches;
}
