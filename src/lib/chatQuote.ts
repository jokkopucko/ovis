import { MAX_COMPOSER_CHARS } from "./compose.ts";
import { composerDraftKey as draftKeyOf, composerDrafts } from "./composerDraft.ts";
import { quoteBlock } from "./replyComments.ts";

/**
 * Quote a selection into the composer (as Antigravity does): the selected words of a reply go into
 * the pane's draft as a Markdown `> ` blockquote with a blank line after it, after whatever the
 * draft holds, kept as it is, and nothing is sent. Quotes stack in the order they were taken.
 */
export function draftWithQuote(draft: string, quote: string): string {
  if (quote.trim() === "") return draft;
  const gap = draft === "" || draft.endsWith("\n\n") ? "" : draft.endsWith("\n") ? "\n" : "\n\n";
  return `${draft}${gap}${quoteBlock(quote)}\n\n`;
}

const listeners = new Map<string, Set<() => void>>();

/** Whether the quote fits in the pane's draft under the composer's limit: one that does not is refused, never cut. */
export function quoteFits(draft: string, quote: string): boolean {
  return draftWithQuote(draft, quote).length <= MAX_COMPOSER_CHARS;
}

/** The pane's composer takes the keyboard, its caret after the draft, once a quote went into it. */
export function onQuoted(paneKey: string, listener: () => void): () => void {
  let set = listeners.get(paneKey);
  if (set === undefined) listeners.set(paneKey, set = new Set());
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(paneKey);
  };
}

/**
 * Puts `quote` into the draft of the pane `paneKey` (its `paneStorageId`) and hands the keyboard to
 * its composer. The draft goes to an agent alone from then on, as a draft carrying comments does
 * (#511): a shell would read its `>` lines as redirects. False: it would not fit, and nothing changed.
 */
export function quoteIntoComposer(paneKey: string, quote: string): boolean {
  const key = draftKeyOf(paneKey);
  const draft = composerDrafts.read(key).text;
  const next = draftWithQuote(draft, quote);
  if (!quoteFits(draft, quote)) return false;
  if (next === draft) return true;
  composerDrafts.markAgentOnly(key);
  composerDrafts.set(key, next);
  for (const listener of listeners.get(paneKey) ?? []) listener();
  return true;
}
