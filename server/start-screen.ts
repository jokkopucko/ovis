import type { ConversationMetadata, ConversationResponse } from "../shared/protocol.ts";

/**
 * Models stated by the agent's own layout before its transcript exists.
 * omp is deliberately excluded: its display names require a catalog lookup, and listing
 * that catalog can refresh the CLI's OAuth credentials.
 */
type Screen = Pick<ConversationMetadata, "model" | "reasoning_effort">;
const NOTHING: Screen = { model: null, reasoning_effort: null };

/** Claude's model families and a version part, as its ids and display names write them (also conversation-metadata.ts) */
export const CLAUDE_FAMILY = "opus|sonnet|haiku|fable|mythos";
export const VERSION = "[1-9]\\d?";
const EFFORT = "none|minimal|low|medium|high|xhigh|max";

function lastMatch(lines: string[], pattern: RegExp): RegExpExecArray | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = pattern.exec(lines[index]!);
    if (match) return match;
  }
  return null;
}

/** `▝▜██████▀  Haiku 5.5 · Claude Max`, the line under `Claude Code v…`. */
function claudeScreen(lines: string[]): Screen {
  const title = lastMatch(lines, /Claude Code v\d/u);
  if (!title) return NOTHING;
  const named = new RegExp(`(?:^|\\s)(${CLAUDE_FAMILY}) (${VERSION})(?:\\.(0|${VERSION}))? · `, "iu").exec(lines[lines.indexOf(title.input) + 1] ?? "");
  if (!named) return NOTHING;
  return { model: `claude-${named[1]!.toLowerCase()}-${named[2]}${named[3] === undefined ? "" : `-${named[3]}`}`, reasoning_effort: null };
}

/** A prompt line of Codex's: one sent (`›`), or its composer, which it marks `»` at Ultra reasoning effort (0.164 on, its `prompt_glyph`). */
const CODEX_PROMPT = /^\s*[›»](?:\s|$)/u;

/** The lines under the last Codex session header down to its composer footer, the model and
 * effort that footer states, or null when the screen does not show both. */
function codexLayout(lines: string[]): { header: number; visible: string[]; end: number; model: RegExpExecArray } | null {
  let header = lines.length - 1;
  // the banner's own line, boxed or not: an answer that only mentions it is no header
  while (header >= 0 && !/^[\s\u2502|]*>_ OpenAI Codex \(v\d[^)]*\)[\s\u2502|]*$/u.test(lines[header]!)) header--;
  if (header < 0) return null;
  const visible = lines.slice(header + 1);
  // one word: OpenAI's `GPT-6-Luna`, or the name a custom model provider gives it (`gpt-6.1-terra`, `DeepSeek4.1flash(OpenCode)`, #3263)
  const footer = new RegExp(`^\\s*([^\\s·]+) (${EFFORT}|ultra)(?: \\w+)? · `, "u");
  let end = visible.length - 1;
  while (end >= 0 && visible[end]!.trim() === "") end--;
  if (end < 1 || !/^\s*[←?].*(?:for agents|shortcuts)/u.test(visible[end]!)) return null;
  const model = footer.exec(visible[end - 1]!);
  if (!model || !visible.slice(0, end - 1).some((line) => CODEX_PROMPT.test(line))) return null;
  return { header, visible, end, model };
}

/** Only the live composer footer owns a Codex model. Text above it (an answer quoting the
 * /model picker, a draft) never does, and while a popup hides the footer the model is unknown.
 * OpenAI's `GPT-…` is given as its id; a model another provider names is kept as written. */
function codexScreen(lines: string[]): Screen {
  const found = codexLayout(lines)?.model;
  if (!found) return NOTHING;
  return { model: /^GPT-/u.test(found[1]!) ? found[1]!.toLowerCase() : found[1]!, reasoning_effort: found[2]! };
}

/** A cell Codex draws for something said or done: an answer or a tool call, a warning, an error. */
const CODEX_CELL = /^\s*[•⚠■]/u;

/**
 * Whether a Codex screen is its start screen with nothing said in it yet: under the last session
 * header, its card and start tips, then the composer (the first prompt line, `›`) with what it
 * holds, then the footer. A message sent or a resumed conversation puts a prompt or an answer
 * above the composer, and a long one pushes the header off the screen; either way this says no.
 * So does one said above the header: the header may be a card a command drew (`/status`) after
 * a conversation, or a session started after another one in the same terminal.
 */
export function codexStartScreenUnused(screen: string): boolean {
  const all = screen.split("\n");
  const layout = codexLayout(all);
  if (layout === null || all.slice(0, layout.header).some((line) => CODEX_PROMPT.test(line) || CODEX_CELL.test(line))) return false;
  const lines = layout.visible.slice(0, layout.end - 1);
  const composer = lines.findIndex((line) => CODEX_PROMPT.test(line));
  return composer >= 0 && !lines.slice(0, composer).some((line) => CODEX_CELL.test(line))
    && !lines.slice(composer + 1).some((line) => CODEX_PROMPT.test(line) || CODEX_CELL.test(line));
}

const AGY_HEADER = /^(?:\s*[▄▀]+)*\s*Antigravity CLI \d[\d.]*\s*$/u;
const AGY_RULE = /^\s*─{10,}\s*$/u;
const AGY_PROMPT = /^\s*>(?:\s|$)/u;
const AGY_CELL = /^\s*[✦●•■](?:\s|$)/u;

/**
 * Whether an Agy screen is its start screen with nothing said in it yet: under the last session
 * header, its banner and optional startup warning, then the composer (`>` between two full-width
 * rules) and its `? for shortcuts` footer, with no prompt, command, answer, or panel above or
 * below the composer.
 */
export function agyStartScreenUnused(screen: string): boolean {
  const all = screen.split("\n");
  let header = all.length - 1;
  while (header >= 0 && !AGY_HEADER.test(all[header]!)) header--;
  if (header < 0 || all.slice(0, header).some((line) => AGY_RULE.test(line) || AGY_PROMPT.test(line) || AGY_CELL.test(line))) return false;
  const visible = all.slice(header + 1);
  let end = visible.length - 1;
  while (end >= 0 && visible[end]!.trim() === "") end--;
  if (end < 3 || !/^\s*\? for shortcuts(?:\s|$)/u.test(visible[end]!)) return false;
  let lower = end - 1;
  while (lower >= 0 && visible[lower]!.trim() === "") lower--;
  if (lower < 2 || !AGY_RULE.test(visible[lower]!)) return false;
  let upper = lower - 1;
  while (upper >= 0 && !AGY_RULE.test(visible[upper]!)) upper--;
  if (upper < 0 || visible.slice(0, upper).some((line) => AGY_RULE.test(line) || AGY_PROMPT.test(line) || AGY_CELL.test(line))) return false;
  const box = visible.slice(upper + 1, lower).filter((line) => line.trim() !== "");
  return box.length > 0 && AGY_PROMPT.test(box[0]!) && box.slice(1).every((line) => /^\s{2,}\S/u.test(line));
}

/** ` ⬢ opus-5.5 · ◉ xhigh · 1.5% / …`, the status line over the composer. */
function gjcScreen(lines: string[]): Screen {
  const found = lastMatch(lines, new RegExp(`⬢ (\\S+) · ◉ (${EFFORT})(?: |$)`, "u"));
  if (!found) return NOTHING;
  const claude = new RegExp(`^(${CLAUDE_FAMILY})-(${VERSION})(?:\\.(0|${VERSION}))?$`, "u").exec(found[1]!);
  const model = claude ? `claude-${claude[1]}-${claude[2]}${claude[3] === undefined ? "" : `-${claude[3]}`}` : found[1]!;
  return { model, reasoning_effort: found[2]! };
}

/**
 * `0.0%/262k (auto)          (provider) model-id • high`, the stats row of Pi's footer: the context
 * figure on the left, the model id its transcript records on the right, then its thinking level
 * when the model reasons (` • thinking off` when that level is off). Pi cuts a right side too wide
 * to fit down to two columns after the stats, with no marker: a row padded by only two may hold a
 * cut-off id, so it names none.
 */
function piScreen(lines: string[]): Screen {
  const found = lastMatch(lines, new RegExp(`(?:\\d+(?:\\.\\d)?%|\\?)/\\d+(?:\\.\\d)?[kM]?(?: \\(auto\\))?(?: • xp)? {3,}(?:\\([^()\\s]+\\) )?(\\S+)(?: • (?:thinking (off)|(${EFFORT})))?(?: → \\S+(?: • \\S+)?)?\\s*$`, "u"));
  if (!found || found[1] === "no-model") return NOTHING;
  return { model: found[1]!, reasoning_effort: found[2] ?? found[3] ?? null };
}

const SCREENS: Partial<Record<ConversationResponse["source"], (lines: string[]) => Screen>> = {
  "claude-transcript": claudeScreen,
  "codex-transcript": codexScreen,
  "gjc-transcript": gjcScreen,
  "pi-transcript": piScreen,
};

export function readsStartScreen(source: ConversationResponse["source"]): boolean {
  return SCREENS[source] !== undefined;
}

export function startScreenMetadata(source: ConversationResponse["source"], screen: string): Screen {
  return SCREENS[source]?.(screen.split("\n")) ?? NOTHING;
}
