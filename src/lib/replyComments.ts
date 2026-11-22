import { isSendLeaseKey, SEND_LEASE_MS, sendLease } from "./composerDraft.ts";
import { paneLifetimes, readReplyCommentsWith, REPLY_COMMENTS_PREFIX } from "./paneLifetime.ts";

export interface ReplyComment {
  id: string;
  quote: string;
  comment: string;
  source?: "diff";
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
  private cache = new Map<string, { raw: string | null; list: readonly ReplyComment[] }>();
  private listeners = new Set<() => void>();
  private forwards = new Map<string, string>();
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
  add(key: string, quote: string, comment: string, source?: "diff"): boolean {
    if (quote.trim() === "" || comment.trim() === "") return false;
    return this.write(key, [...this.read(key), { id: this.newId(), quote, comment: comment.trim(), ...(source === undefined ? {} : { source }) }]);
  }
  remove(key: string, id: string): void {
    const list = this.read(key);
    if (list.some((item) => item.id === id)) this.write(key, list.filter((item) => item.id !== id));
  }
  reservation = (): number => this.reservations;
  reserve(sent: readonly ReplyComment[]): void {
    if (sent.length === 0) return;
    for (const item of sent) this.reserved.add(item.id);
    this.reservations++;
    this.notify();
  }
  release(sent: readonly ReplyComment[]): void {
    let changed = false;
    for (const item of sent) changed = this.reserved.delete(item.id) || changed;
    if (!changed) return;
    this.reservations++;
    this.notify();
  }
  unreserved(list: readonly ReplyComment[]): readonly ReplyComment[] {
    const free = list.filter((item) => !this.reserved.has(item.id) && !this.held(item));
    return free.length === list.length ? list : free;
  }
  private held(item: ReplyComment): boolean {
    const hold = item.heldFor;
    if (typeof hold !== "object" || hold === null || typeof hold.draft !== "string") return false;
    try { return sendLease(this.storage(), hold.draft)?.at === hold.at; } catch { return false; }
  }
  removeSent(key: string, sent: readonly ReplyComment[]): void {
    const ids = new Set(sent.map((item) => item.id));
    for (const at of this.chain(key)) {
      const list = this.read(at);
      if (list.some((item) => ids.has(item.id))) this.write(at, list.filter((item) => !ids.has(item.id)));
    }
  }
  private chain(key: string): string[] {
    const keys = [key];
    const next = (at: string): string | null => this.forwards.get(at) ?? this.storedForward(at);
    for (let to = next(key); to !== null && !keys.includes(to); to = next(to)) keys.push(to);
    return keys;
  }
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
  move(from: string, to: string, sending: SendHold | null = null): void {
    const moving = this.read(from);
    if (moving.length === 0 || from === to) return;
    const there = this.read(to);
    const ids = new Set(there.map((item) => item.id));
    const moved = moving.filter((item) => !ids.has(item.id)).map((item) => sending === null || this.held(item) ? item : { ...item, heldFor: sending });
    if (!this.write(to, [...there, ...moved])) return;
    let recorded = false;
    if (sending !== null || moving.some((item) => this.held(item))) {
      try { this.storage().setItem(from, JSON.stringify({ movedTo: to, at: Date.now() })); recorded = true; } catch {}
    }
    if (recorded) this.notify();
    else this.write(from, NONE);
    this.forwards.set(from, to);
  }
  clear(key: string): void {
    if (this.read(key).length > 0) this.write(key, NONE);
  }
  refresh(): void {
    this.reservations++;
    this.notify();
  }
}

export const replyComments = new ReplyCommentStore();
paneLifetimes.onRetire(() => replyComments.refresh());
readReplyCommentsWith(storedCommentsText);
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key === null || event.key.startsWith(REPLY_COMMENTS_PREFIX) || isSendLeaseKey(event.key)) replyComments.refresh();
});

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

export function messageWithComments(comments: readonly ReplyComment[], text: string): string {
  const parts = comments.map((item) => `${quoteBlock(item.quote)}\n${item.comment.trim()}`);
  if (text.trim() !== "") parts.push(text);
  return parts.join("\n\n");
}

export function storedCommentsText(raw: string | null): string {
  const list = parse(raw);
  return list.length > 0 ? messageWithComments(list, "") : "";
}

/**
 * Whether a send leaves the waiting comments for the next message: a slash command or a `!` shell line
 * (the agent runs them, and a quote before one would turn it into prose), or the answer to the agent's
 * open question.
 */
export function commentsWait(text: string, answering: boolean): boolean {
  return answering || /^[/!]/.test(text.trimStart());
}
