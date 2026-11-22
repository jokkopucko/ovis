/**
 * herdr lays out its screen with current Unicode widths: an emoji takes two cells, and so
 * does a whole emoji sequence (ZWJ family, skin tone, flag, keycap, an emoji-presentation
 * selector after a text symbol like ⚠️). Its attach stream counts on the browser's xterm
 * advancing the cursor exactly as far. xterm defaults to Unicode 6 widths, where most emoji
 * take one cell and a ZWJ sequence takes one per emoji, so the rest of the line shifted:
 * emoji overlapped the next letter, and parts of a sequence were overwritten (👨‍👩‍👧 lost the
 * 👧) or left behind as stale characters.
 *
 * xterm's grapheme addon brings Unicode 15 widths and emoji sequences, and it agrees with
 * herdr in all but four places, each corrected here:
 * - it joins a spacing mark (Thai SARA AM in น้ำ, a Devanagari vowel sign) to the letter
 *   before it as one cell, where herdr gives the mark its own cell, so a spacing mark starts
 *   a cell of its own;
 * - its tables predate Unicode 14 emoji (🫠), which it counts as one cell, so an emoji the
 *   browser knows as emoji-presentation takes two cells, and joins like any other emoji;
 * - it gives invisible format characters (zero-width space, direction marks, word joiner,
 *   Hangul filler) a cell, where herdr gives them none, so they join the cell before them.
 *   Characters that build emoji sequences (ZWJ, variation selectors, tags) and the Hangul
 *   jamo stay with the addon;
 * - it keeps an emoji two cells wide when the text-presentation selector (U+FE0E) follows,
 *   where herdr and herdr-core give an emoji that has a text form (⚽︎, ⌚︎; not 😀︎) one cell,
 *   and keep it at one through any selector after it (a ZWJ sequence after it is two cells,
 *   a skin tone after it a cell of its own). The cell narrows on the selector, as
 *   the patched xterm then gives back the second column (patches/@xterm%2Fxterm@6.0.0.patch).
 */
import type { IUnicodeVersionProvider, Terminal } from "@xterm/xterm";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";

export const HERDR_UNICODE_VERSION = "15-herdr";

const SPACING_MARK = /[\p{Mc}\u0e33\u0eb3]/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const INVISIBLE = /(?![\u00ad\u1100-\u11ff\u200d\ufe00-\ufe0f\u{e0000}-\u{e0fff}])\p{Default_Ignorable_Code_Point}/u;
const FIRST_INVISIBLE = 0x034f;
const FIRST_SPACING_MARK = 0x0903;
const FIRST_EMOJI_PRESENTATION = 0x231a;
/** Regional indicators are emoji-presentation one at a time, but only a pair is a (two-cell) flag. */
const REGIONAL_INDICATORS = [0x1f1e6, 0x1f1ff] as const;
/** A two-cell emoji the addon's tables know, standing in for a newer one with the same joining. */
const KNOWN_WIDE_EMOJI = 0x1f600;
/** A zero-width character the addon joins to the cell before it, standing in for one it does not. */
const KNOWN_INVISIBLE = 0x200c;
const TEXT_PRESENTATION = 0xfe0e;
const EMOJI_PRESENTATION_SELECTOR = 0xfe0f;
const isSkinTone = (codepoint: number): boolean => codepoint >= 0x1f3fb && codepoint <= 0x1f3ff;
/**
 * The two-cell emoji with a text-presentation sequence (Unicode's emoji-variation-sequences.txt),
 * as hex ranges: herdr gives each one cell when U+FE0E follows it.
 */
const TEXT_FORM_EMOJI = new Set(
  ("231a-231b 23e9-23ec 23f0 23f3 25fd-25fe 2614-2615 2648-2653 267f 2693 26a1 26aa-26ab 26bd-26be 26c4-26c5 "
    + "26ce 26d4 26ea 26f2-26f3 26f5 26fa 26fd 2705 270a-270b 2728 274c 274e 2753-2755 2757 2795-2797 27b0 27bf "
    + "2b1b-2b1c 2b50 2b55 1f004 1f21a 1f22f 1f30d-1f30f 1f315 1f31c 1f378 1f393 1f3a7 1f3ac-1f3ae 1f3c2 1f3c4 "
    + "1f3c6 1f3ca 1f3e0 1f3ed 1f408 1f415 1f41f 1f426 1f442 1f446-1f449 1f44d-1f44e 1f453 1f46a 1f47d 1f4a3 "
    + "1f4b0 1f4b3 1f4bb 1f4bf 1f4cb 1f4da 1f4df 1f4e4-1f4e6 1f4ea-1f4ed 1f4f7 1f4f9-1f4fb 1f508 1f50d "
    + "1f512-1f513 1f550-1f567 1f610 1f687 1f68d 1f691 1f694 1f698 1f6ad 1f6b2 1f6b9-1f6ba 1f6bc")
    .split(" ").flatMap((range) => {
      const [first = 0, last = first] = range.split("-").map((hex) => parseInt(hex, 16));
      return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
    }),
);
/** The same character properties with another width (xterm's packing: join flag, then two width bits). */
const withWidth = (properties: number, width: number): number => (properties & ~0b110) | (width << 1);

type Kind = "plain" | "newer-emoji" | "spacing-mark" | "invisible";

export function herdrWidthProvider(): IUnicodeVersionProvider {
  // the addon hands its providers only to terminal.unicode.register, so it registers into this
  let graphemes: IUnicodeVersionProvider | undefined;
  const collector = {
    unicode: {
      register: (provider: IUnicodeVersionProvider) => {
        if (provider.version === "15-graphemes") graphemes = provider;
      },
      activeVersion: "",
    },
  };
  // the addon reads nothing but `unicode` off the terminal it activates on
  const registrar = collector as unknown as Terminal;
  new UnicodeGraphemesAddon().activate(registrar);
  if (!graphemes) throw new Error("the grapheme addon registered no 15-graphemes provider");
  const inner = graphemes;
  const kinds = new Map<number, Kind>();
  const kindOf = (codepoint: number): Kind => {
    if (codepoint < FIRST_INVISIBLE) return "plain";
    let kind = kinds.get(codepoint);
    if (kind === undefined) {
      const char = String.fromCodePoint(codepoint);
      if (INVISIBLE.test(char)) kind = "invisible";
      else if (codepoint >= FIRST_SPACING_MARK && SPACING_MARK.test(char)) kind = "spacing-mark";
      else if (
        codepoint >= FIRST_EMOJI_PRESENTATION
        && (codepoint < REGIONAL_INDICATORS[0] || codepoint > REGIONAL_INDICATORS[1])
        && inner.wcwidth(codepoint) === 1
        && EMOJI_PRESENTATION.test(char)
      ) kind = "newer-emoji";
      else kind = "plain";
      kinds.set(codepoint, kind);
    }
    return kind;
  };

  const properties = (codepoint: number, preceding: number): number => {
    switch (kindOf(codepoint)) {
      case "newer-emoji":
        return inner.charProperties(KNOWN_WIDE_EMOJI, preceding);
      case "spacing-mark":
        return inner.charProperties(codepoint, 0);
      case "invisible":
        // at the start of a line there is no cell to join; the addon's answer stands there
        return inner.charProperties(preceding === 0 ? codepoint : KNOWN_INVISIBLE, preceding);
      case "plain":
        return inner.charProperties(codepoint, preceding);
    }
  };
  // xterm asks for each character it prints in order, handing back the answer for the one before:
  // what that answer was for (a lone text-form emoji, or a cell U+FE0E narrowed) is kept beside it
  let textFormEmoji: number | undefined;
  let narrowed: number | undefined;

  return {
    version: HERDR_UNICODE_VERSION,
    wcwidth: (codepoint) => {
      const kind = kindOf(codepoint);
      return kind === "newer-emoji" ? 2 : kind === "invisible" ? 0 : inner.wcwidth(codepoint);
    },
    charProperties: (codepoint, preceding) => {
      // herdr starts a new cell for a skin tone after a narrowed emoji
      const afterNarrowed = preceding === narrowed;
      let answer = afterNarrowed && isSkinTone(codepoint) ? properties(codepoint, 0) : properties(codepoint, preceding);
      const joins = (answer & 1) === 1;
      const narrows = joins && (codepoint === TEXT_PRESENTATION ? preceding === textFormEmoji || afterNarrowed : codepoint === EMOJI_PRESENTATION_SELECTOR && afterNarrowed);
      if (narrows) answer = withWidth(answer, 1);
      narrowed = narrows ? answer : undefined;
      textFormEmoji = !joins && TEXT_FORM_EMOJI.has(codepoint) ? answer : undefined;
      return answer;
    },
  };
}

export function matchHerdrWidths(term: Terminal): void {
  term.unicode.register(herdrWidthProvider());
  term.unicode.activeVersion = HERDR_UNICODE_VERSION;
}
