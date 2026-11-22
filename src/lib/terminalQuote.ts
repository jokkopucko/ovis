export interface TerminalQuote {
  label: string;
  range: { start: number; end: number } | null;
  text: string;
}

export function quotedText(text: string): string | null {
  const normalized = text.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
  return normalized.trim() === "" ? null : normalized;
}

export function quoteHeading(label: string, range: TerminalQuote["range"]): string {
  if (!range) return label;
  const start = Math.max(1, Math.floor(range.start) + 1);
  const end = Math.max(start, Math.floor(range.end) + 1);
  return start === end ? `${label} line ${start}` : `${label} lines ${start}-${end}`;
}

/** A heading and the text in a code fence that no backtick run inside the text can close. */
export function formatTerminalQuote(quote: TerminalQuote): string | null {
  const text = quotedText(quote.text);
  if (text === null) return null;
  const label = quote.label.replace(/\s+/g, " ").trim() || "terminal";
  let fence = "```";
  for (const run of text.match(/`{3,}/g) ?? []) if (run.length >= fence.length) fence = "`".repeat(run.length + 1);
  return `${quoteHeading(label, quote.range)}:\n${fence}\n${text}\n${fence}`;
}

export function appendQuote(draft: string, block: string, max: number): string | null {
  const gap = draft === "" ? "" : draft.endsWith("\n\n") ? "" : draft.endsWith("\n") ? "\n" : "\n\n";
  const next = `${draft}${gap}${block}\n`;
  return next.length > max ? null : next;
}
