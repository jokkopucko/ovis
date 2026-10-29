import { paneLifetimes, REPLY_COMMENTS_PREFIX } from "./paneLifetime.ts";

/**
 * Comments on parts of an agent's replies (#511): the text a reader selected in one reply and what
 * they want to say about it. They wait on this device, per pane, until the next message the pane's
 * composer sends, which carries them first, each as a quote and then the comment.
 *
 * Stored under `ovis:reply-comments:<paneStorageId>` through the pane-state storage
 * (lib/paneLifetime.ts), like the message draft: a herdr that replaced the pane's takes them with
 * its panes, since the reply they quote is gone with it.
 */
export interface ReplyComment {
  id: string;
  /** the reply's words as the reader selected them, as a copy carries them */
  quote: string;
  comment: string;
}

type CommentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export { REPLY_COMMENTS_PREFIX };
export const replyCommentsKey = (paneStorageId: string): string => REPLY_COMMENTS_PREFIX + paneStorageId;
const NONE: readonly ReplyComment[] = [];

function parse(raw: string | null): readonly ReplyComment[] {
  if (raw === null) return NONE;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return NONE;
    const list = value.filter((item): item is ReplyComment => typeof item === "object" && item !== null
      && typeof item.id === "string" && typeof item.quote === "string" && typeof item.comment === "string"
      && item.quote.trim() !== "" && item.comment.trim() !== "");
    return list.length > 0 ? list : NONE;
  } catch {
    return NONE;
  }
}

export class ReplyCommentStore {
  /** what was read for each key, with the raw text it was read from: a read returns the same array until it changes */
  private cache = new Map<string, { raw: string | null; list: readonly ReplyComment[] }>();
  private listeners = new Set<() => void>();
  private count = 0;
  constructor(
    private storage: () => CommentStorage = () => paneLifetimes.paneStorage,
    private newId: () => string = () => `${Date.now().toString(36)}-${(++this.count).toString(36)}`,
  ) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify(): void { for (const listener of this.listeners) listener(); }
  read = (key: string): readonly ReplyComment[] => {
    let raw: string | null = null;
    try { raw = this.storage().getItem(key); } catch { /* private mode: none */ }
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.raw === raw) return cached.list;
    const list = parse(raw);
    this.cache.set(key, { raw, list });
    return list;
  };
  private write(key: string, list: readonly ReplyComment[]): boolean {
    try {
      if (list.length === 0) this.storage().removeItem(key);
      else this.storage().setItem(key, JSON.stringify(list));
    } catch {
      return false;
    }
    this.notify();
    return true;
  }
  /** false: an empty quote or comment, or storage refused it */
  add(key: string, quote: string, comment: string): boolean {
    if (quote.trim() === "" || comment.trim() === "") return false;
    return this.write(key, [...this.read(key), { id: this.newId(), quote, comment: comment.trim() }]);
  }
  remove(key: string, id: string): void {
    const list = this.read(key);
    if (list.some((item) => item.id === id)) this.write(key, list.filter((item) => item.id !== id));
  }
  /** Removes the comments a sent message carried, by id: one written meanwhile stays for the next. */
  removeSent(key: string, sent: readonly ReplyComment[]): void {
    const ids = new Set(sent.map((item) => item.id));
    const list = this.read(key);
    if (list.some((item) => ids.has(item.id))) this.write(key, list.filter((item) => !ids.has(item.id)));
  }
  clear(key: string): void {
    if (this.read(key).length > 0) this.write(key, NONE);
  }
  /** Another tab or a retired herdr changed storage: readers read again. */
  refresh(): void { this.notify(); }
}

export const replyComments = new ReplyCommentStore();
paneLifetimes.onRetire(() => replyComments.refresh());
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key === null || event.key.startsWith(REPLY_COMMENTS_PREFIX)) replyComments.refresh();
});

/** `> ` before each line of the quote; its blank lines stay inside the quote as a bare `>`. */
export function quoteBlock(quote: string): string {
  const lines = quote.replace(/\r\n?/g, "\n").replace(/^\s*\n|\s+$/g, "").split("\n");
  return lines.map((line) => line.trim() === "" ? ">" : `> ${line}`).join("\n");
}

/**
 * The message that carries the comments: each comment's quote and then the comment, in the order
 * they were written, a blank line between them, and the typed text after them. A message may be
 * comments alone.
 */
export function messageWithComments(comments: readonly ReplyComment[], text: string): string {
  const parts = comments.map((item) => `${quoteBlock(item.quote)}\n${item.comment.trim()}`);
  if (text.trim() !== "") parts.push(text);
  return parts.join("\n\n");
}

/**
 * Whether a send leaves the waiting comments for the next message: a slash command (the agent runs
 * it, and a quote before it would turn it into prose), or the answer to the agent's open question.
 */
export function commentsWait(text: string, answering: boolean): boolean {
  return answering || text.trimStart().startsWith("/");
}
