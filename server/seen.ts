import { join } from "node:path";
import { MAX_SEEN, MAX_SEEN_BYTES, mergeSeen, seenFinishBody, seenFinishKey, seenPresentationOf, type SeenFinish, type SeenPresentation } from "../shared/seen.ts";
import { badRequest, jsonResponse } from "./http.ts";
import { damagedCopy, readStateDocument } from "./state-document.ts";

import { persistSeen } from "./seen-persistence.ts";

/** A listener may return the work it starts (a Promise): close() waits for it. */
type Listener = (finish: SeenFinish, presented?: SeenPresentation) => unknown;
type Settle<T> = ReturnType<typeof Promise.withResolvers<T>>;
type Pending =
  | { kind: "record"; finish: SeenFinish; presented: SeenPresentation | undefined; settle: Settle<SeenFinish> }
  | { kind: "move"; pc: string; from: string; to: string; renumber: (id: number) => number; settle: Settle<SeenFinish | undefined> };

/** MAX_SEEN acknowledgements wait already: the browser retries this one later (503). */
export class SeenBusyError extends Error {
  constructor() { super("Seen writer queue is full; retry the acknowledgement"); }
}

export class SeenStore {
  private readonly finishes = new Map<string, SeenFinish>();
  private readonly path: string;
  private readonly listeners = new Set<Listener>();
  private readonly presentations = new Set<(finish: SeenFinish) => unknown>();
  /** What listeners still do for committed receipts (herdr-core's `herdr.seen`): close() waits for it. */
  private readonly followUps = new Set<Promise<unknown>>();
  private unsettled = true;
  private queue: Pending[] = [];
  private writing: Promise<void> | null = null;
  private pendingRecords = 0;
  private closed = false;

  /**
   * `ended`: whether this server knows a PC's finish epoch has ended. A record of any other epoch is
   * kept, the one a PC's snapshot names now or not: a late read can name a run that is over (#2206).
   */
  constructor(stateDir: string, private readonly ended: (pc: string, epoch: string) => boolean = () => false, private readonly persist = persistSeen) {
    this.path = join(stateDir, "seen.json");
    try {
      const disk = this.readDisk();
      if (disk) for (const [k, v] of disk.finishes) this.finishes.set(k, v);
    } catch (error) {
      // a missing file is a server that has recorded nothing yet; an unreadable one is not, and is never written over
      console.error(`Cannot read ${this.path} (${(error as NodeJS.ErrnoException).code ?? "error"}); read finishes start empty and are not saved until it can be read`);
    }
  }

  private readDisk(): { finishes: Map<string, SeenFinish>; damaged: boolean } | undefined {
    const read = readStateDocument(this.path);
    if (read.kind === "missing") return undefined;
    const finishes = new Map<string, SeenFinish>();
    const rows = read.kind === "json" && Array.isArray(read.value) ? read.value as unknown[] : null;
    let damaged = rows === null;
    for (const raw of rows ?? []) {
      const finish = seenFinishBody(raw);
      if (finish) finishes.set(seenFinishKey(finish), finish);
      else damaged = true;
    }
    if (damaged) console.error(`${this.path} is ${read.kind === "malformed" ? "not JSON" : "not a list of read finishes"}; the next change keeps it as ${damagedCopy(this.path)}`);
    return { finishes, damaged };
  }

  list(): SeenFinish[] {
    return [...this.finishes.values()].filter((finish) => !this.over(finish));
  }

  /**
   * Everything that arrives while a write runs goes into the next one, as a single file replacement: a slow disk
   * costs at most two writes however many receipts wait, so a drain at shutdown fits the time it has.
   */
  private enqueue(item: Pending): void {
    this.queue.push(item);
    if (this.writing) return;
    this.writing = (async () => {
      while (this.queue.length > 0) await this.commit(this.queue.splice(0));
      this.writing = null;
    })();
  }

  flush(): Promise<void> { return this.writing ?? Promise.resolve(); }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
    await Promise.allSettled([...this.followUps]);
  }

  record(finish: SeenFinish, presented?: SeenPresentation): Promise<SeenFinish> {
    if (this.closed) return Promise.reject(new Error("Seen store is closed"));
    if (this.pendingRecords >= MAX_SEEN) return Promise.reject(new SeenBusyError());
    this.pendingRecords++;
    const settle = Promise.withResolvers<SeenFinish>();
    this.enqueue({ kind: "record", finish, presented, settle });
    return settle.promise;
  }

  /**
   * herdr moved a pane of `pc` under a new ID (#1503): what was read under the old ID is read under the new one,
   * each finish under the number the server counts it by there (`renumber`, server/finishes.ts moved), and every
   * browser is told.
   */
  moved(pc: string, from: string, to: string, renumber: (id: number) => number = (id) => id): Promise<void> {
    if (from === to) return Promise.resolve();
    if (this.closed) return Promise.reject(new Error("Seen store is closed"));
    // A move is a one-shot topology event, not a browser request that can be retried: never refused as busy.
    const settle = Promise.withResolvers<SeenFinish | undefined>();
    this.enqueue({ kind: "move", pc, from, to, renumber, settle });
    return settle.promise.then(() => undefined);
  }

  private async commit(batch: Pending[]): Promise<void> {
    const results: Array<SeenFinish | undefined> = [];
    const told: Array<() => void> = [];
    try {
      let base = this.finishes;
      let keepDamaged = false;
      if (this.unsettled) {
        const disk = this.readDisk();
        if (disk) base = disk.finishes;
        keepDamaged = disk?.damaged ?? false;
      }
      const finishes = new Map(base);
      let changed = false;
      const keep = (finish: SeenFinish, presented: SeenPresentation | undefined): SeenFinish => {
        const key = seenFinishKey(finish);
        const held = finishes.get(key);
        const next = mergeSeen(held, finish);
        if (!next) return held!;
        finishes.delete(key);
        finishes.set(key, next);
        // trimmed per record, as one write each would: a later record of the batch merges with what that leaves
        for (const [old, kept] of finishes) if (this.over(kept)) finishes.delete(old);
        for (const old of finishes.keys()) {
          if (finishes.size <= MAX_SEEN) break;
          finishes.delete(old);
        }
        changed = true;
        told.push(() => { for (const listener of [...this.listeners]) this.follow(() => listener(next, presented)); });
        return next;
      };
      for (const item of batch) {
        if (item.kind === "record") {
          if (this.over(item.finish)) { results.push(item.finish); continue; }
          results.push(keep(item.finish, item.presented));
          if (item.presented === "new") told.push(() => { for (const listener of [...this.presentations]) this.follow(() => listener(item.finish)); });
          continue;
        }
        for (const finish of [...finishes.values()]) {
          if (this.over(finish) || finish.pc !== item.pc || finish.pane !== item.from) continue;
          keep({ ...finish, pane: item.to, id: item.renumber(finish.id) }, undefined);
        }
        results.push(undefined);
      }
      if (changed) {
        await this.persist(this.path, `${JSON.stringify([...finishes.values()])}\n`, keepDamaged);
        this.unsettled = false;
        this.finishes.clear();
        for (const [k, v] of finishes) this.finishes.set(k, v);
      }
    } catch (error) {
      // a failed write of many is tried again one by one: only what fails alone fails, as a move cannot be retried
      if (batch.length > 1) {
        for (const item of batch) await this.commit([item]);
        return;
      }
      for (const item of batch) {
        if (item.kind === "record") this.pendingRecords--;
        item.settle.reject(error);
      }
      return;
    }
    for (const tell of told) tell();
    batch.forEach((item, index) => {
      if (item.kind === "record") {
        this.pendingRecords--;
        item.settle.resolve(results[index]!);
      } else item.settle.resolve(undefined);
    });
  }

  /** Runs a listener for a saved change: one that throws must not stop the writer. */
  private follow(run: () => unknown): void {
    let work: unknown;
    try { work = run(); } catch (error) { console.error("seen: a listener failed:", error); return; }
    if (!(work instanceof Promise)) return;
    const tracked = work.catch(() => undefined).finally(() => { this.followUps.delete(tracked); });
    this.followUps.add(tracked);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onPresented(listener: (finish: SeenFinish) => unknown): () => void {
    this.presentations.add(listener);
    return () => { this.presentations.delete(listener); };
  }

  private over(finish: SeenFinish): boolean {
    return this.ended(finish.pc, finish.epoch);
  }
}

/** The body as text, or null past MAX_SEEN_BYTES: one announced over it is refused unread, one that lies about its length is cut off as it arrives. */
async function readSeenBody(request: Request): Promise<string | null> {
  const announced = Number(request.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > MAX_SEEN_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_SEEN_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** /api/seen: GET every record, POST one. A watching device's POST is refused before this (index.ts). */
export async function handleSeenRequest(request: Request, store: SeenStore): Promise<Response> {
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  if (request.method === "GET") return reply({ finishes: store.list() });
  if (request.method !== "POST") return reply({ error: { code: "method_not_allowed", message: "Use GET or POST /api/seen" } }, 405);
  const text = await readSeenBody(request);
  if (text === null) return reply({ error: { code: "too_large", message: "A read finish is at most 8 KB" } }, 413);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return badRequest("invalid_json", "The body is not JSON"); }
  const finish = seenFinishBody(raw);
  if (finish === null) return badRequest("invalid_body", "Send { pc, epoch, pane: string, id: positive integer, answer?: string }");
  try { return reply(await store.record(finish, seenPresentationOf(raw))); }
  catch (error) {
    if (error instanceof SeenBusyError) return reply({ error: { code: "seen_busy", message: error.message } }, 503);
    return reply({ error: { code: "seen_unwritable", message: error instanceof Error ? error.message : String(error) } }, 500);
  }
}
