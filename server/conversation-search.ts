import type { ConversationSearchResponse } from "../shared/conversation-search.ts";
import { searchTurns } from "../shared/conversation-search.ts";
import { ConversationUnavailable, HistoryChanged, MAX_PAGE_PROMPTS, type ConversationPage, type RecognizedConversation } from "./conversation.ts";

/**
 * What one search answer may read before it says where to go on: a 1000-prompt Claude session of
 * 25 MB parses as 20 pages of 50 prompts in about 0.8 s on a desktop (2000 prompts, 2.3 s), so a
 * long session takes the browser a few answers, each one a little over a second at most.
 */
export const SEARCH_PAGES = 20;
export const SEARCH_MS = 1000;
export const SEARCH_MATCHES = 50;

export async function searchConversationPages(read: (page: ConversationPage) => Promise<RecognizedConversation>, pattern: RegExp,
  { before, historyId }: { before?: string; historyId?: string }, now: () => number = () => performance.now()): Promise<ConversationSearchResponse> {
  const started = now();
  const matches: ConversationSearchResponse["matches"] = [];
  let cursor = before;
  let history = historyId;
  for (let pages = 1; ; pages++) {
    const page = await read({ ...(cursor === undefined ? {} : { before: cursor }), prompts: MAX_PAGE_PROMPTS }).catch((error: unknown) => {
      throw error instanceof ConversationUnavailable && cursor !== undefined ? new HistoryChanged() : error;
    });
    if (history !== undefined && page.history_id !== history) throw new HistoryChanged();
    history = page.history_id;
    matches.push(...searchTurns(page.turns, pattern));
    if (page.cursor === null) return { history_id: history, matches, cursor: null };
    cursor = page.cursor;
    if (pages >= SEARCH_PAGES || matches.length >= SEARCH_MATCHES || now() - started >= SEARCH_MS) return { history_id: history, matches, cursor };
  }
}
