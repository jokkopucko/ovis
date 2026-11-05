import { isSendLeaseKey, SEND_LEASE_MS, sendLease } from "./composerDraft.ts";
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
  /** `diff`: a note on a line of a file's diff (#1603, lib/diffLineNotes.ts), its quote the line and where it is */
  source?: "diff";
  /**
   * moved to this pane while a send on the pane it came from was on its way, maybe from another tab
   * (#2356): that send may carry it, so no send takes it while that send's lease (the draft and the
   * time it began) holds
   */
  heldFor?: SendHold;
}
export interface SendHold { draft: string; at: number }

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
      && item.quote.trim() !== "" && item.comment.trim() !== "" && (item.source === undefined || item.source === "diff"));
    return list.length > 0 ? list : NONE;
  } catch {
    return NONE;
  }
}

export class ReplyCommentStore {
  /** what was read for each key, with the raw text it was read from: a read returns the same array until it changes */
  private cache = new Map<string, { raw: string | null; list: readonly ReplyComment[] }>();
  private listeners = new Set<() => void>();
  /** the pane ID each moved list went to (lib/paneMove.ts): a send begun under the old one settles there too */
  private forwards = new Map<string, string>();
  /** the comments a send on its way carries, by id: no other send takes them until it settles, wherever they moved */
  private reserved = new Set<string>();
  private reservations = 0;
  constructor(
    private storage: () => CommentStorage = () => paneLifetimes.paneStorage,
    // random, not a count of this tab's: another tab saving in the same millisecond must not share it, as a send removes by id
    private newId: () => string = () => `${Date.now().toString(36)}-${Array.from(crypto.getRandomValues(new Uint32Array(2)), (part) => part.toString(36)).join("")}`,
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
  add(key: string, quote: string, comment: string, source?: "diff"): boolean {
    if (quote.trim() === "" || comment.trim() === "") return false;
    return this.write(key, [...this.read(key), { id: this.newId(), quote, comment: comment.trim(), ...(source === undefined ? {} : { source }) }]);
  }
  remove(key: string, id: string): void {
    const list = this.read(key);
    if (list.some((item) => item.id === id)) this.write(key, list.filter((item) => item.id !== id));
  }
  /** Removes the comments a sent message carried, by id: one written meanwhile stays for the next. */
  /** Changes whenever a reservation does: a reader of `unreserved` reads again. */
  reservation = (): number => this.reservations;
  reserve(sent: readonly ReplyComment[]): void {
    if (sent.length === 0) return;
    for (const item of sent) this.reserved.add(item.id);
    this.reservations++;
    this.notify();
  }
  /** The send settled: what it carried is free again, here or wherever it moved (a sent one is gone already). */
  release(sent: readonly ReplyComment[]): void {
    let changed = false;
    for (const item of sent) changed = this.reserved.delete(item.id) || changed;
    if (!changed) return;
    this.reservations++;
    this.notify();
  }
  /** The comments no send on its way carries: none this tab's sends reserved, none held for another tab's. */
  unreserved(list: readonly ReplyComment[]): readonly ReplyComment[] {
    const free = list.filter((item) => !this.reserved.has(item.id) && !this.held(item));
    return free.length === list.length ? list : free;
  }
  /** whether the send `item` is held for is still on its way, as its lease in storage says */
  private held(item: ReplyComment): boolean {
    const hold = item.heldFor;
    if (typeof hold !== "object" || hold === null || typeof hold.draft !== "string") return false;
    try { return sendLease(this.storage(), hold.draft)?.at === hold.at; } catch { return false; }
  }
  /** a send settling under `key` follows every move since: a record of each stays until it lapses, as another send may follow it too */
  removeSent(key: string, sent: readonly ReplyComment[]): void {
    const ids = new Set(sent.map((item) => item.id));
    for (const at of this.chain(key)) {
      const list = this.read(at);
      if (list.some((item) => ids.has(item.id))) this.write(at, list.filter((item) => !ids.has(item.id)));
    }
  }
  /** `key` and every key its list moved on to since, by this tab or another */
  private chain(key: string): string[] {
    const keys = [key];
    const next = (at: string): string | null => this.forwards.get(at) ?? this.storedForward(at);
    for (let to = next(key); to !== null && !keys.includes(to); to = next(to)) keys.push(to);
    return keys;
  }
  /** Where another tab moved `key`'s list while a send was on its way (#2356): kept no longer than that send's lease. */
  private storedForward(key: string): string | null {
    try {
      const value: unknown = JSON.parse(this.storage().getItem(key) ?? "null");
      if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
      const { movedTo, at } = value as { movedTo?: unknown; at?: unknown };
      if (typeof movedTo !== "string" || typeof at !== "number" || !Number.isFinite(at)) return null;
      return Date.now() - at > SEND_LEASE_MS ? null : movedTo;
    } catch {
      return null;
    }
  }
  /**
   * herdr gave the pane a new ID: all its waiting comments go with it, after any the new ID holds
   * already, and a send begun under the old ID still removes the ones it carried once it is acknowledged.
   * `sending`: the lease of a send on the old ID on its way, maybe from another tab (#2356). The comments
   * are held for it, as any tab can see, and the move is also recorded under the old key, which reads as
   * no comments, so the tab that sent it follows it too. A move of comments still held for an earlier
   * send is recorded as well.
   */
  move(from: string, to: string, sending: SendHold | null = null): void {
    const moving = this.read(from);
    if (moving.length === 0 || from === to) return;
    const there = this.read(to);
    const ids = new Set(there.map((item) => item.id));
    // one held for an earlier send stays held for it: that send may carry it
    const moved = moving.filter((item) => !ids.has(item.id)).map((item) => sending === null || this.held(item) ? item : { ...item, heldFor: sending });
    if (!this.write(to, [...there, ...moved])) return;
    let recorded = false;
    if (sending !== null || moving.some((item) => this.held(item))) {
      try { this.storage().setItem(from, JSON.stringify({ movedTo: to, at: Date.now() })); recorded = true; } catch { /* storage refused: this tab still follows it */ }
    }
    if (recorded) this.notify();
    else this.write(from, NONE);
    this.forwards.set(from, to);
  }
  clear(key: string): void {
    if (this.read(key).length > 0) this.write(key, NONE);
  }
  /** Another tab or a retired herdr changed storage, or a send held for ended: readers read again. */
  refresh(): void {
    this.reservations++;
    this.notify();
  }
}

export const replyComments = new ReplyCommentStore();
paneLifetimes.onRetire(() => replyComments.refresh());
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  // a send's lease ending frees the comments held for it (#2356)
  if (event.key === null || event.key.startsWith(REPLY_COMMENTS_PREFIX) || isSendLeaseKey(event.key)) replyComments.refresh();
});

/** `> ` before each line of the quote; its blank lines stay inside the quote as a bare `>`. */
export function quoteBlock(quote: string): string {
  const lines = quote.replace(/\r\n?/g, "\n").replace(/^\s*\n|\s+$/g, "").split("\n");
  return lines.map((line) => line.trim() === "" ? ">" : `> ${line}`).join("\n");
}

/**
 * Whether text holds a `>` quote line, as a message that carries comments does (#511): put back in a box
 * from anywhere, it goes only to an agent, as a shell would read the line as a redirect.
 */
export function holdsQuoteLine(text: string): boolean {
  return /^>/m.test(text);
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
 * Whether a send leaves the waiting comments for the next message: a slash command or a `!` shell line
 * (the agent runs them, and a quote before one would turn it into prose), or the answer to the agent's
 * open question.
 */
export function commentsWait(text: string, answering: boolean): boolean {
  return answering || /^[/!]/.test(text.trimStart());
}
