import type { Terminal } from "@xterm/xterm";
import { promptHasCursor, secretPrompt } from "../../shared/secret-prompt.ts";

/**
 * One asking of a prompt: its words, and how many lines of the same words stand directly above it (`cut`: they reach
 * the screen's first line, so there may have been more). A script that asks twice prints its second prompt under
 * the first, and that is all that tells the two apart. Nothing else on the screen is part of an asking: the lines
 * above a prompt change with the pane's width, scroll away, or are a clock.
 */
interface Asking { prompt: string; repeats: number; cut: boolean }

/** Whether `now` is the asking `seen` was: the same words under as many of themselves, or under fewer once some scrolled off. */
function sameAsking(seen: Asking, now: Asking): boolean {
  return seen.prompt === now.prompt && (seen.repeats === now.repeats || (now.cut && now.repeats < seen.repeats));
}

/**
 * The masked prompt a terminal's screen shows now, if any (shared/secret-prompt.ts), read off xterm's screen for
 * `pane`. `cursorKnown`: whether the screen's cursor is the program's (an attached pane). A mirrored pane's
 * repaints carry none, so its prompt counts while it is the last text; so does one not known to be attached.
 *
 * With the cursor known, a prompt whose cursor was seen on its line and then left has been answered: the program
 * printed its line break and works on, the prompt still the last text, and an answer sent again would wait in the
 * terminal for whatever reads next. A prompt whose cursor was never seen on it asks while it is the last text: a
 * script that prints its prompt with a line break and reads below it (`echo "Password:"; read -s`), or a screen
 * first seen after the answer. What was seen is one pane's: it is kept while that pane's screen is drawn again (a
 * reconnect, a phone that let the pane go while hidden), and dropped when the terminal shows another pane.
 */
export function createSecretScreen(term: Terminal, cursorKnown: () => boolean): { read: (pane: string) => string | null } {
  // the asking last seen with the cursor on its line, and the pane it was seen on
  let seen: Asking | null = null;
  let seenOn: string | null = null;
  return {
    read(pane: string): string | null {
      if (pane !== seenOn) { seen = null; seenOn = pane; }
      const lines: string[] = [];
      // each line's first screen row
      const starts: number[] = [];
      const buffer = term.buffer.active;
      // the screen only: a prompt is on its last lines, and a herdr-core pane's history (syncHistory) would
      // cost every output frame a pass over its 2,000 lines
      for (let row = buffer.baseY; row < buffer.length; row++) {
        const line = buffer.getLine(row);
        // As wide as the terminal and no wider: on the alternate screen, which herdr's attach draws on, a row keeps
        // the cells of a wider grid past the new edge, and herdr's redraw for a narrower one does not clear them
        const text = line?.translateToString(!buffer.getLine(row + 1)?.isWrapped, 0, term.cols) ?? "";
        if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
        else { lines.push(text); starts.push(row); }
      }
      const prompt = secretPrompt(lines.join("\n"), term.cols);
      if (!cursorKnown()) return prompt;
      if (prompt === null) { seen = null; return null; }
      let last = lines.length - 1;
      while (last >= 0 && !lines[last]!.trim()) last--;
      const words = lines[last]!.trimEnd();
      let first = last;
      while (first > 0 && lines[first - 1]!.trimEnd() === words) first--;
      const asking: Asking = { prompt, repeats: last - first, cut: first === 0 };
      if (promptHasCursor(lines, starts, buffer.baseY + buffer.cursorY, buffer.cursorX, term.cols)) { seen = asking; return prompt; }
      return seen !== null && sameAsking(seen, asking) ? null : prompt;
    },
  };
}
