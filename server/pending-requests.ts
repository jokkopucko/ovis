import { PendingInputError } from "./pending-input.ts";

interface Entry<T> { fingerprint: string; reply: Promise<T>; resolved: boolean; value?: T }

/** Recent idempotency receipts stay bounded; retired IDs cannot execute again after eviction. */
export class PendingRequestBook<T> {
  private readonly entries = new Map<number, Entry<T>>();
  private retiredThrough = -1;
  constructor(private readonly pinned: (reply: T) => boolean = () => false, private readonly limit = 256) {}
  get size(): number { return this.entries.size; }
  has(id: number): boolean { return this.entries.has(id); }

  get(id: number, fingerprint: string): Promise<T> | undefined {
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new PendingInputError("invalid_submit_id", "This submit id already belongs to another message");
      return existing.reply;
    }
    if (id <= this.retiredThrough) throw new PendingInputError("retired_submit_id", "This submit id is older than the retained receipt history; use a new id");
    return undefined;
  }

  run(id: number, fingerprint: string, task: () => Promise<T>): Promise<T> {
    const previous = this.get(id, fingerprint);
    if (previous) return previous;
    for (const [known, entry] of this.entries) {
      if (this.entries.size < this.limit) break;
      if (!entry.resolved || (entry.value !== undefined && this.pinned(entry.value))) continue;
      this.entries.delete(known); this.retiredThrough = Math.max(this.retiredThrough, known);
    }
    if (this.entries.size >= this.limit) throw new PendingInputError("pending_limit", "Too many pending-message requests are still active on this connection");
    const entry: Entry<T> = { fingerprint, resolved: false, reply: undefined! };
    entry.reply = Promise.resolve().then(task).then((value) => { entry.resolved = true; entry.value = value; return value; }, (error) => { entry.resolved = true; throw error; });
    this.entries.set(id, entry);
    return entry.reply;
  }
}
