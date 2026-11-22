import { ANSI_RE } from "./dialogs/shared.ts";

const plainRow = (row: string): string => row.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").replace(ANSI_RE, "");

/** The screen's bottom-most row with a `❯`: Hermes' input, below every message it echoes. */
function hermesInputRow(screen: string): string | null {
  const rows = screen.split(/\r?\n/);
  for (let index = rows.length - 1; index >= 0; index--) if (plainRow(rows[index]!).includes("❯")) return rows[index]!;
  return null;
}

/**
 * Whether Hermes' input is not known to be empty, so that a paste would join what is there and the
 * Enter send both as one message (measured on Hermes 0.21.5, classic CLI and TUI). The input is the
 * bottom-most `❯` row, empty when nothing follows the `❯`. Hermes' own hint there is not a draft:
 * the classic CLI draws its placeholder italic (its skin's `placeholder: "{dim} italic"`), and the TUI
 * starts its hint with a synthetic cursor, a cell with a background color (ui-tui textInput.tsx
 * `hintCursorCell`); typed text has neither.
 */
export function hermesInputDraft(live: string, colors: string | null): boolean {
  const row = hermesInputRow(live);
  if (row === null) return true;
  const plain = plainRow(row);
  // the row's first `❯` is the prompt: one after it is typed text
  if (plain.slice(plain.indexOf("❯") + 1).replace(/\u00a0/g, " ").trim() === "") return false;
  const shown = colors === null ? null : hermesInputRow(colors);
  if (shown === null || plainRow(shown).trimEnd() !== plain.trimEnd()) return true;
  const after = plainRow(shown).indexOf("❯");
  let column = 0;
  let italic = false;
  let background = false;
  // the first character after the `❯` decides: a TUI hint's cursor chip, or typed (not italic) text
  let decided: boolean | null = null;
  const visit = (text: string): void => {
    for (const character of text) {
      const at = column;
      column += character.length;
      if (decided !== null) return;
      if (at <= after || character.trim() === "" || character === "\u00a0") continue;
      if (background) { decided = false; return; }
      if (!italic) { decided = true; return; }
    }
  };
  const escape = /\u001b(?:\[([0-?]*)[ -/]*([@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
  let offset = 0;
  for (const match of shown.matchAll(escape)) {
    visit(shown.slice(offset, match.index));
    offset = match.index! + match[0].length;
    if (match[2] !== "m") continue;
    const codes = (match[1] || "0").split(";").map((code) => Number(code || 0));
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index]!;
      if (code === 38 || code === 58) index += codes[index + 1] === 5 ? 2 : codes[index + 1] === 2 ? 4 : 0;
      else if (code === 48) { background = true; index += codes[index + 1] === 5 ? 2 : codes[index + 1] === 2 ? 4 : 0; }
      else if (code === 0) { italic = false; background = false; }
      else if (code === 3) italic = true;
      else if (code === 23) italic = false;
      else if (code === 49) background = false;
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) background = true;
    }
  }
  visit(shown.slice(offset));
  // every character italic: the classic CLI's placeholder
  return decided ?? false;
}
