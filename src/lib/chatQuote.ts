import { MAX_COMPOSER_CHARS } from "./compose.ts";
import { composerDraftKey as draftKeyOf, composerDrafts } from "./composerDraft.ts";
import { quoteBlock } from "./replyComments.ts";

export function draftWithQuote(draft: string, quote: string): string {
  return quote.trim() === "" ? draft : draftWithBlock(draft, quoteBlock(quote));
}

function draftWithBlock(draft: string, block: string): string {
  const gap = draft === "" || draft.endsWith("\n\n") ? "" : draft.endsWith("\n") ? "\n" : "\n\n";
  return `${draft}${gap}${block}\n\n`;
}

const listeners = new Map<string, Set<() => void>>();

export function quoteFits(draft: string, quote: string): boolean {
  return draftWithQuote(draft, quote).length <= MAX_COMPOSER_CHARS;
}

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
  return quote.trim() === "" || blockIntoComposer(paneKey, quoteBlock(quote));
}

export function blockIntoComposer(paneKey: string, block: string): boolean {
  const key = draftKeyOf(paneKey);
  const draft = composerDrafts.read(key).text;
  const next = draftWithBlock(draft, block);
  if (next.length > MAX_COMPOSER_CHARS) return false;
  composerDrafts.markAgentOnly(key);
  composerDrafts.set(key, next, "append");
  for (const listener of listeners.get(paneKey) ?? []) listener();
  return true;
}
