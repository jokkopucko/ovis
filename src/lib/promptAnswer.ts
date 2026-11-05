/**
 * A message typed in the chat while an agent's prompt waits answers that prompt,
 * the way the agent's own menu reads keys: an option's number, its label, or the
 * letter it binds ("Yes, proceed (y)"); several numbers for a multiple choice.
 * Anything else is the prompt's own "type something" answer when it has one.
 */
import type { InteractivePrompt, PromptAnswer } from "../../shared/protocol.ts";
import { CASE_FOLDING_DATA } from "./caseFolding.generated.ts";
import { CONFUSABLES_DATA } from "./confusables.generated.ts";
import { t } from "./i18n.ts";
import { optionName, promptWords } from "./promptText.ts";

/** The agents whose own keys move between a form's questions (pi's tabs, Claude Code's question tabs, omo's Tab, omp's Tab, Codex's ←/→, Hermes's Tab): a move carries none of the card's edits. */
const KEYED_STEPS = new Set(["pi", "claude", "omo", "omp", "codex", "hermes"]);

export type TypedAnswer = Pick<PromptAnswer, "option_index" | "option_indices" | "custom_text">;

/** The options a typed number can pick, by the number the agent shows (index + 1). */
function choices(prompt: InteractivePrompt): number[] {
  return prompt.options.flatMap((_, index) => index === prompt.custom_option_index ? [] : [index]);
}

/** "Yes, proceed (y)" binds y; "No, and tell Codex what to do differently (esc)" binds nothing typeable. */
function boundLetter(label: string): string | null {
  return label.match(/\(([a-z])\)$/i)?.[1]?.toLowerCase() ?? null;
}

/**
 * text as a page shows it, for comparing what is typed with what a card shows (never what is sent): one
 * Unicode form by look (NFKC: `e` and a combining accent is `é`, the ligature `ﬁ` is `fi`), without
 * the marks a page does not draw (format characters and every default-ignorable code point: zero-width
 * space and joiners, word joiner, soft hyphen, byte order mark, the combining grapheme joiner, variation
 * selectors, Hangul fillers; a visible accent stays), its spacing collapsed. Rows that read alike then name each other (#2220).
 */
const spaced = (text: string): string => text.normalize("NFKC").replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "").replace(/\s+/g, " ").trim().toLowerCase();

const caseFolds = new Map(CASE_FOLDING_DATA.split(";").map((entry) => {
  const [from, to] = entry.split("=") as [string, string];
  return [String.fromCodePoint(parseInt(from, 16)), String.fromCodePoint(...to.split(" ").map((hex) => parseInt(hex, 16)))];
}));
/** Unicode's full case folding (CaseFolding.txt C and F): `Straße`, `STRASSE` and `STRAẞE` all fold to `strasse` */
const toCasefold = (text: string): string => Array.from(text, (char) => caseFolds.get(char) ?? char).join("");

const confusables = new Map(CONFUSABLES_DATA.split(";").map((entry) => {
  const [from, to] = entry.split("=") as [string, string];
  return [String.fromCodePoint(parseInt(from, 16)), String.fromCodePoint(parseInt(to, 16))];
}));
/** Each letter Unicode draws like an ASCII letter or digit (confusables.txt, UTS #39) as that one: Cyrillic `о` and Greek `ο` as `o`, `1` as `l` */
const unconfused = (text: string): string => Array.from(text, (char) => confusables.get(char) ?? char).join("");

/**
 * What a name reads as, for telling rows apart (#2220): Unicode's compatibility caseless form (Unicode 3.13,
 * D146: NFKD(toCasefold(NFKD(toCasefold(NFD(x)))))), then its letters, marks and digits alone. Marks a page
 * does not draw, spacing, punctuation, blanks such as U+2800 and controls such as U+007F all go; the last
 * NFD puts the marks left in canonical order again, so a skeleton is its own skeleton. Then a letter drawn
 * like a Latin one is that Latin letter (unconfused), folded again (#2233): only after the case folding, so a
 * capital `I` stays `i` and every name keeps the skeleton of its other case. Two rows with one skeleton may
 * look the same, so a typed name picks neither (their numbers and a click still do). That over-refuses pairs
 * like `production.` and `production`.
 */
export const skeleton = (text: string): string => toCasefold(unconfused(toCasefold(toCasefold(text.normalize("NFD")).normalize("NFKD")).normalize("NFKD"))).normalize("NFKD")
  .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "").replace(/[^\p{L}\p{M}\p{N}]/gu, "").normalize("NFD");

function bareLabel(label: string): string {
  return spaced(label.replace(/\s*\((?:[a-z]|esc|recommended)\)$/i, ""));
}

/** null: the prompt only takes its options, and the text names none of them. */
export function answerFromText(prompt: InteractivePrompt, text: string): TypedAnswer | null {
  const value = text.trim();
  if (!value) return null;
  const valid = choices(prompt);
  const byNumber = (token: string): number | null => {
    if (!/^\d+$/.test(token)) return null;
    const index = Number(token) - 1;
    return valid.includes(index) ? index : null;
  };
  const typed = (): TypedAnswer | null => prompt.custom_option_index !== null ? { custom_text: value } : null;
  // a label the bridge wrote is named as the card shows it, in the user's language, or in English
  const words = promptWords(prompt);
  /**
   * the one option `said` names as the card shows the options; null for words that name several (rows that read alike), undefined for none.
   * `literal`: only a row's own name counts, not words that merely look like one (a typed row number, which `1` beside rows `I` and `l` still is)
   */
  const nameOf = (said: string, literal = false): number | null | undefined => {
    const lower = spaced(said);
    const names = (label: string): boolean => spaced(label) === lower || bareLabel(label) === lower || boundLetter(label) === lower;
    const only = (label: (index: number) => string, named = names): number | null | undefined => {
      const found = valid.filter((index) => named(label(index)));
      if (found.length > 1) return null;
      // rows that may look the same pick none: the one named shares its skeleton with another row, or the
      // words read as two rows' names
      const alike = (shape: string): number => valid.filter((index) => skeleton(label(index)) === shape).length;
      if (found.length === 1) return alike(skeleton(label(found[0]!))) > 1 ? null : found[0];
      return !literal && alike(skeleton(said)) > 1 ? null : undefined;
    };
    // an option's own words first: a translated label never takes the words another option shows
    // an omp card in Markdown is named by the words it shows alone (optionName, as the card draws them):
    // its raw Markdown may be another option's words (`*main*` beside `` `*main*` ``)
    if (prompt.text_format === "markdown") return only((index) => optionName(prompt, prompt.options[index]!.label).words, (shown) => spaced(shown) === lower);
    const own = only((index) => prompt.options[index]!.label);
    return own !== undefined ? own : only((index) => words.label(index));
  };
  // One rule for a single and a multiple choice. The whole text first: a row's shown name picks that row
  // alone, words several rows show pick none. Only words no row shows are read as numbers, and each number
  // must then name no other row: an omp card's `` `2` `` or `` `1 2` ``, typed, is that row, never rows 2 or 1 and 2
  const whole = nameOf(value, /^[\d\s,]+$/.test(value));
  if (whole === null) return typed();
  if (whole !== undefined) return prompt.multi_select ? { option_indices: [whole] } : { option_index: whole };
  const tokens = prompt.multi_select ? value.split(/[\s,]+/).filter(Boolean) : [value];
  const indices = tokens.map(byNumber);
  // a number is the row the card shows it on, as a click on that row is, also where the row's name looks like
  // another row's (#2233)
  const own = (token: string, index: number | null): boolean => {
    const named = nameOf(token, true);
    return index !== null && (named === undefined || named === index);
  };
  // separators alone (`,,,`) are no numbers but the text itself (#2233)
  if (tokens.length === 0 || !tokens.every((token, at) => own(token, indices[at]!))) return typed();
  return prompt.multi_select ? { option_indices: [...new Set(indices as number[])] } : { option_index: indices[0]! };
}

function range(prompt: InteractivePrompt): string {
  const numbers = choices(prompt).map((index) => index + 1);
  return numbers.length > 1 ? `${numbers[0]}–${numbers.at(-1)}` : String(numbers[0] ?? 1);
}

/** A multi-select whose checks and typed answer go together: Submit and Send both send the whole step. */
export function sendsChecksWithText(prompt: InteractivePrompt): boolean {
  return prompt.multi_select && !prompt.fallback && (prompt.checks_with_text === true || prompt.agent === "opencode");
}

/** Pi and Claude Code switch native tabs, not web-owned drafts. Keep edits visible until sent or cleared. */
export function blocksStepNavigation(prompt: InteractivePrompt, selected: ReadonlySet<number>, custom: string): boolean {
  if (!KEYED_STEPS.has(prompt.agent) || prompt.drafts_saved || !(prompt.can_step_next || prompt.can_step_back || prompt.steps?.some(step => step.can_navigate))) return false;
  return custom !== (prompt.default_custom_text ?? "") || prompt.multi_select
    && JSON.stringify([...selected].sort((a, b) => a - b)) !== JSON.stringify(prompt.default_option_indices ?? []);
}

/** How a typed message answers this prompt: the composer's placeholder while it waits. */
export function answerHint(prompt: InteractivePrompt): string {
  if (prompt.multi_select) return t("Type the numbers you choose, e.g. 1 3");
  // a free-form question (Codex's queue) has no options to number
  if (choices(prompt).length === 0) return t("Type your reply…");
  return prompt.custom_option_index !== null
    ? t("Type {range} or your own reply…", { range: range(prompt) })
    : t("Type {range} to choose…", { range: range(prompt) });
}

/** Why a message was not sent: the prompt takes only its options (answerFromText gave null). */
export function answerRefusal(prompt: InteractivePrompt): string {
  return prompt.multi_select
    ? t("Choose with the option numbers above, e.g. 1 3.")
    : t("Choose one of the options above: type {range}.", { range: range(prompt) });
}

/**
 * A typed message picking an approval's option (or a plan's, or a menu's: Claude's
 * "Review your answers" submits every answer at once, Codex's menus continue or stop)
 * could act on a stray "yes" or "1": the card asks for a tap on Confirm first. A tap on
 * an option in the card is explicit already, and a plan's own reply is feedback.
 */
export function needsConfirmation(prompt: InteractivePrompt, answer: TypedAnswer): boolean {
  return (prompt.kind === "approval" || prompt.kind === "plan" || prompt.kind === "menu") && answer.option_index !== undefined;
}

/** What pressed an answer in the card; `unknown` when the browser's click does not say. */
export type PressOrigin = "keyboard" | "mouse" | "touch" | "pen" | "unknown";

/**
 * What made the click that answered. Asked of the press itself and not of the device: a laptop
 * with a touch screen reports a fine pointer and is still tapped, and a tablet with a keyboard
 * reports a coarse one. A click names its pointer in `pointerType`, and so does the pointerdown on
 * that button before it (`downType`): a finger or a pen in either one wins, since iOS Safari has
 * called a tap's click a mouse's (WebKit bug 282988). A key's click (Enter, Space) has no pointer
 * and a `detail` of 0, and so has a script's `click()` or an assistive technology's activation,
 * which is why a key also needs its keydown on that button (`keyed`). No `press` at all is Enter
 * in the card's own field.
 */
export function pressOrigin(press: { pointerType?: string; downType?: string; detail?: number; keyed: boolean } | undefined): PressOrigin {
  if (press === undefined) return "keyboard";
  for (const pointer of ["touch", "pen", "mouse"] as const) {
    if (press.downType === pointer || press.pointerType === pointer) return pointer;
  }
  return press.detail === 0 && press.keyed ? "keyboard" : "unknown";
}

/**
 * After an answer pressed in the card went out: may the keyboard's focus go on to the message box?
 * Only if the card is still there and nothing else took the focus while the answer was on its way
 * (a palette, a held message being edited, another pane): `inCard` and `onPage` say where it is now.
 * After a key or a mouse press, on any device: the card goes, and the focus would fall to the page.
 * Never after a tap or a pen: focus in the message box would raise the on-screen keyboard. A press
 * of unknown origin is a tap where the device's pointer is `coarse`.
 */
export function focusFollowsAnswer({ fromCard, origin, coarse, cardMounted, inCard, onPage }: { fromCard: boolean; origin: PressOrigin; coarse: boolean; cardMounted: boolean; inCard: boolean; onPage: boolean }): boolean {
  const pressed = origin === "keyboard" || origin === "mouse" || (origin === "unknown" && !coarse);
  return fromCard && pressed && cardMounted && (inCard || onPage);
}
