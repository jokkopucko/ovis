import { join } from "node:path";
import { MAX_SEEN, MAX_SEEN_BYTES, mergeSeen, seenFinishBody, seenFinishKey, seenPresentationOf, type SeenFinish, type SeenPresentation } from "../shared/seen.ts";
import { badRequest, jsonResponse } from "./http.ts";
import { damagedCopy, readStateDocument, writeStateDocument } from "./state-document.ts";

/**
 * The finishes some browser of this server presented (shared/seen.ts), kept in the state directory
 * beside preferences.json, so a finish read on the phone is read on the desktop too. A change is
 * held, and told, only once it is on disk. A finish of a herdr run this server knows has ended
 * (MachineManager.finishEnded) is never handed out or taken, and the next write leaves it out of the file.
 */
export class SeenStore {
  /** insertion order is write order: the first entries are the oldest */
  private readonly finishes = new Map<string, SeenFinish>();
  private readonly path: string;
  private readonly listeners = new Set<(finish: SeenFinish, presented?: SeenPresentation) => void>();
  private readonly presentations = new Set<(finish: SeenFinish) => void>();
  /** Until this store has replaced the file, a write reads it again first: it may have been damaged or repaired since. */
  private unsettled = true;

  /**
   * `ended`: whether this server knows a PC's finish epoch has ended. A record of any other epoch is
   * kept, the one a PC's snapshot names now or not: a late read can name a run that is over (#2206).
   */
  constructor(stateDir: string, private readonly ended: (pc: string, epoch: string) => boolean = () => false) {
    this.path = join(stateDir, "seen.json");
    try {
      const disk = this.readDisk();
      if (disk) for (const [k, v] of disk.finishes) this.finishes.set(k, v);
    } catch (error) {
      // a missing file is a server that has recorded nothing yet; an unreadable one is not, and is never written over
      console.error(`Cannot read ${this.path} (${(error as NodeJS.ErrnoException).code ?? "error"}); read finishes start empty and are not saved until it can be read`);
    }
  }

  /**
   * The finishes on disk, undefined when there is no file. A document that is not a list, or holds
   * a row that is not a finish, is damaged: the valid rows are used, and the whole file is kept
   * aside before a write drops the others. Throws when it cannot be read.
   */
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

  /** `presented`: how the browser presented it (shared/seen.ts SeenPresentation), told with a change and not stored */
  record(finish: SeenFinish, presented?: SeenPresentation): SeenFinish {
    // answered as sent: a browser that still shows the run that ended has nothing to keep
    if (this.over(finish)) return finish;
    const kept = this.keep(finish, presented);
    // a pane brought into view is told even when its finish was already read: someone looked again
    if (presented === "new") for (const listener of [...this.presentations]) listener(finish);
    return kept;
  }

  private keep(finish: SeenFinish, presented: SeenPresentation | undefined): SeenFinish {
    let base = this.finishes;
    let keepDamaged = false;
    if (this.unsettled) {
      // the file as it is now, not as it was at start: a repair is kept and the finish merged into
      // it, and nothing of it is held until the write succeeds
      const disk = this.readDisk();
      if (disk) base = disk.finishes;
      keepDamaged = disk?.damaged ?? false;
    }
    const key = seenFinishKey(finish);
    const held = base.get(key);
    const next = mergeSeen(held, finish);
    if (!next) return held!;
    const finishes = new Map(base);
    finishes.delete(key);
    finishes.set(key, next);
    for (const [old, kept] of finishes) if (this.over(kept)) finishes.delete(old);
    for (const old of finishes.keys()) {
      if (finishes.size <= MAX_SEEN) break;
      finishes.delete(old);
    }
    writeStateDocument(this.path, `${JSON.stringify([...finishes.values()])}\n`, keepDamaged);
    this.unsettled = false;
    this.finishes.clear();
    for (const [k, v] of finishes) this.finishes.set(k, v);
    for (const listener of [...this.listeners]) listener(next, presented);
    return next;
  }

  /**
   * herdr moved a pane of `pc` under a new ID (#1503): what was read under the old ID is read under the new one,
   * each finish under the number the server counts it by there (`renumber`, server/finishes.ts moved), and every
   * browser is told. The old ID's records stay, as an ended pane's do.
   */
  moved(pc: string, from: string, to: string, renumber: (id: number) => number = (id) => id): void {
    if (from === to) return;
    for (const finish of this.list()) {
      if (finish.pc !== pc || finish.pane !== from) continue;
      this.keep({ ...finish, pane: to, id: renumber(finish.id) }, undefined);
    }
  }

  subscribe(listener: (finish: SeenFinish, presented?: SeenPresentation) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Every finish a browser presented as `new`, changed or not, after the change listeners. */
  onPresented(listener: (finish: SeenFinish) => void): () => void {
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
  try { return reply(store.record(finish, seenPresentationOf(raw))); }
  catch (error) { return reply({ error: { code: "seen_unwritable", message: error instanceof Error ? error.message : String(error) } }, 500); }
}
