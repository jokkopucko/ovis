import { join } from "node:path";
import { MAX_SEEN, MAX_SEEN_BYTES, mergeSeen, seenFinishBody, seenFinishKey, seenPresentationOf, type SeenFinish, type SeenPresentation } from "../shared/seen.ts";
import { badRequest, jsonResponse } from "./http.ts";
import { damagedCopy, readStateDocument, writeStateDocument } from "./state-document.ts";

export class SeenStore {
  private readonly finishes = new Map<string, SeenFinish>();
  private readonly path: string;
  private readonly listeners = new Set<(finish: SeenFinish, presented?: SeenPresentation) => void>();
  private readonly presentations = new Set<(finish: SeenFinish) => void>();
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

  record(finish: SeenFinish, presented?: SeenPresentation): SeenFinish {
    if (this.over(finish)) return finish;
    const kept = this.keep(finish, presented);
    if (presented === "new") for (const listener of [...this.presentations]) listener(finish);
    return kept;
  }

  private keep(finish: SeenFinish, presented: SeenPresentation | undefined): SeenFinish {
    let base = this.finishes;
    let keepDamaged = false;
    if (this.unsettled) {
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
   * browser is told.
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
