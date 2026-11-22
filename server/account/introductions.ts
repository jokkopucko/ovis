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

type Waiting = Map<string, { pcs: IntroducedPc[]; expires: number }>;

/** What `path` holds, or nothing: an introduction is only a hint the member gives again, so an unreadable file is an empty one. */
function readWaiting(path: string | undefined): Waiting {
  const waiting: Waiting = new Map();
  if (!path) return waiting;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { introductions?: unknown };
    for (const entry of Array.isArray(value.introductions) ? value.introductions : []) {
      const { key, pcs, expires } = entry as { key?: unknown; pcs?: unknown; expires?: unknown };
      const parsed = parseIntroducedPcs(pcs);
      if (typeof key === "string" && parsed && typeof expires === "number") waiting.set(key, { pcs: parsed, expires });
    }
  } catch {}
  return waiting;
}

export class AccountIntroductions {
  private readonly waiting: Waiting;

  constructor(private readonly now: () => number = Date.now, private readonly path?: string) {
    this.waiting = readWaiting(path);
  }

  set(key: string, pcs: IntroducedPc[]): void {
    this.prune();
    const merged = new Map((this.waiting.get(key)?.pcs ?? []).map((pc) => [pc.server_id, pc]));
    for (const pc of pcs) { merged.delete(pc.server_id); merged.set(pc.server_id, pc); }
    this.waiting.delete(key);
    this.waiting.set(key, { pcs: [...merged.values()].slice(-MAX_PCS), expires: this.now() + INTRODUCTION_TTL_MS });
    while (this.waiting.size > MAX_KEYS) this.waiting.delete(this.waiting.keys().next().value!);
    this.save();
  }

  get(key: string): IntroducedPc[] | null {
    this.prune();
    return this.waiting.get(key)?.pcs ?? null;
  }

  private prune(): void {
    const now = this.now();
    let changed = false;
    for (const [key, { expires }] of this.waiting) if (now >= expires) { this.waiting.delete(key); changed = true; }
    if (changed) this.save();
  }

  private save(): void {
    if (this.path) writePrivateState(this.path, { introductions: [...this.waiting].map(([key, { pcs, expires }]) => ({ key, pcs, expires })) });
  }
}
