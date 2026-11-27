import { readFileSync } from "node:fs";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { isWssOrigin } from "../../shared/relay-offer.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { writePrivateState } from "../private-state.ts";

/** How long an introduction waits for its device: a device that is off for weeks still learns of a PC enrolled meanwhile. */
export const INTRODUCTION_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_PCS = 32;
const MAX_KEYS = 256;

export interface IntroducedPc { server_id: string; server_public_key: string; relay: string; name: string }

/**
 * Where the member that introduced a device says that device stands in the account's signed list: the list's id and
 * the place of the device's own entry. This PC only carries it, form checked: the device reads the list up to that
 * place itself and takes nothing on this PC's word (docs/account.md, "Introductions").
 */
export interface IntroducedList { id: string; seq: number; hash: string }

const LIST_ID = /^[0-9a-f]{64}$/;

/** Null unless `value` is a list id and a place, each in its form. */
export function parseIntroducedList(value: unknown): IntroducedList | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { id, seq, hash, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof id !== "string" || !LIST_ID.test(id) || typeof hash !== "string" || !LIST_ID.test(hash)) return null;
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 ? { id, seq, hash } : null;
}

/** Null unless `value` is a list of PCs whose ids derive from their keys (docs/account.md, "Introductions"). */
export function parseIntroducedPcs(value: unknown): IntroducedPc[] | null {
  if (!Array.isArray(value) || value.length > MAX_PCS) return null;
  const pcs: IntroducedPc[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { server_id, server_public_key, relay, name } = entry as Record<string, unknown>;
    if (typeof server_id !== "string" || typeof server_public_key !== "string" || typeof relay !== "string" || typeof name !== "string") return null;
    if (name.length < 1 || name.length > 48 || !isWssOrigin(relay)) return null;
    try { if (deriveServerId(importPublicKey(server_public_key)) !== server_id) return null; } catch { return null; }
    pcs.push({ server_id, server_public_key, relay, name });
  }
  return pcs;
}

type Waiting = Map<string, { pcs: IntroducedPc[]; expires: number; list?: IntroducedList }>;

/** What `path` holds, or nothing: an introduction is only a hint the member gives again, so an unreadable file is an empty one. */
function readWaiting(path: string | undefined): Waiting {
  const waiting: Waiting = new Map();
  if (!path) return waiting;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { introductions?: unknown };
    for (const entry of Array.isArray(value.introductions) ? value.introductions : []) {
      const { key, pcs, expires, list } = entry as { key?: unknown; pcs?: unknown; expires?: unknown; list?: unknown };
      const parsed = parseIntroducedPcs(pcs);
      const place = parseIntroducedList(list);
      if (typeof key === "string" && parsed && typeof expires === "number") waiting.set(key, { pcs: parsed, expires, ...(place ? { list: place } : {}) });
    }
  } catch {}
  return waiting;
}

export class AccountIntroductions {
  private readonly waiting: Waiting;

  constructor(private readonly now: () => number = Date.now, private readonly path?: string) {
    this.waiting = readWaiting(path);
  }

  /** `list`: the latest one a member named stays; an introduction that names none keeps the one before. */
  set(key: string, pcs: IntroducedPc[], list?: IntroducedList): void {
    this.prune();
    const before = this.waiting.get(key);
    const merged = new Map((before?.pcs ?? []).map((pc) => [pc.server_id, pc]));
    for (const pc of pcs) { merged.delete(pc.server_id); merged.set(pc.server_id, pc); }
    const place = list ?? before?.list;
    this.waiting.delete(key);
    this.waiting.set(key, { pcs: [...merged.values()].slice(-MAX_PCS), expires: this.now() + INTRODUCTION_TTL_MS, ...(place ? { list: place } : {}) });
    while (this.waiting.size > MAX_KEYS) this.waiting.delete(this.waiting.keys().next().value!);
    this.save();
  }

  get(key: string): IntroducedPc[] | null {
    this.prune();
    return this.waiting.get(key)?.pcs ?? null;
  }

  /** The place in the account's signed list that the member who introduced `key` named for it, or null. */
  list(key: string): IntroducedList | null {
    this.prune();
    return this.waiting.get(key)?.list ?? null;
  }

  private prune(): void {
    const now = this.now();
    let changed = false;
    for (const [key, { expires }] of this.waiting) if (now >= expires) { this.waiting.delete(key); changed = true; }
    if (changed) this.save();
  }

  private save(): void {
    if (this.path) writePrivateState(this.path, { introductions: [...this.waiting].map(([key, { pcs, expires, list }]) => ({ key, pcs, expires, ...(list ? { list } : {}) })) });
  }
}
