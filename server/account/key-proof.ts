/**
 * Pairing by proving a key (docs/account.md, "Confirmed on this PC"), for a relay session on a PC with screen proof:
 * the device names its key with the code, the code is checked and one use of it held for that key, the PC then makes a
 * challenge, the device proves the key over it once, and waits until the PC's screen approves that very key by its
 * fingerprint. Only then is a row written, through Track A's admission (admitConfirmed), which sets the row's origin
 * from where the approval came. Every other ending gives the held use back.
 */
import type { DeviceMatch } from "../devices.ts";
import type { LocalConfirms } from "./local-confirm.ts";
import type { PendingRedemption, PendingRedemptions, PendingVia } from "./pending.ts";
import { PendingLimitError } from "./pending.ts";

/** The admission seams of server/devices.ts this flow uses (Track A, S2-08). */
export interface RedeemSeams {
  redeemCode(code: string, how: "code" | "qr", key: string): { ok: true; codeId: string; origin: "pc" | "relay" } | { ok: false; reason: string };
  releaseRedemption(codeId: string, key: string): void;
  /** whether the code `codeId` is still in force, even before its expiry timer has run (S13-1) */
  codeLive(codeId: string): boolean;
  admitConfirmed(confirm: { codeId: string; key: string; label: string; source: "screen" | "recover" }): DeviceMatch | null;
}

export type PairStart = { session: string; challenge: string } | { refuse: "unsupported_version" | "auth_failed" };
export type ProveResult = { pending: PendingRedemption } | { refuse: "auth_failed" };
export interface Decision { admitted: DeviceMatch | null }

interface Session {
  readonly challenge: string;
  readonly codeId: string;
  readonly key: string;
  readonly canAdmit: (() => boolean) | undefined;
  pendingId?: string;
  decide(decision: Decision): void;
  readonly decided: Promise<Decision>;
}

export class KeyProofPairings {
  readonly #pending: PendingRedemptions;
  readonly #seams: RedeemSeams;
  readonly #sessions = new Map<string, Session>();
  readonly #byPending = new Map<string, string>();
  // DeviceStore holds one use per (codeId, key), not one use per relay session.
  readonly #uses = new Map<string, number>();

  constructor(options: { pending: PendingRedemptions; seams: RedeemSeams }) {
    this.#pending = options.pending;
    this.#seams = options.seams;
  }

  /** A PAIR on a PC that needs the proof. A device that did not offer key-proof-1 is refused, never left waiting. */
  pair(request: { code: string; label: string; publicKey: string; how: "code" | "qr"; via: PendingVia; keyProof: boolean; serverId?: string; canAdmit?: () => boolean }): PairStart {
    // an app without the proof is told to update, in a code every released decoder knows
    if (!request.keyProof) return { refuse: "unsupported_version" };
    const redeemed = this.#seams.redeemCode(request.code, request.how, request.publicKey);
    if (!redeemed.ok) return { refuse: "auth_failed" };
    const session = crypto.randomUUID();
    const use = JSON.stringify([redeemed.codeId, request.publicKey]);
    this.#uses.set(use, (this.#uses.get(use) ?? 0) + 1);
    let named: { challenge: string };
    try {
      named = this.#pending.name(request.code, request.label, request.publicKey, request.via, undefined, {
        codeId: redeemed.codeId, ...(request.serverId === undefined ? {} : { serverId: request.serverId }),
        release: () => this.#finish(session, null),
        live: () => this.#seams.codeLive(redeemed.codeId),
      });
    }
    catch (error) {
      this.#releaseUse(redeemed.codeId, request.publicKey, null);
      if (!(error instanceof PendingLimitError)) throw error;
      return { refuse: "auth_failed" };
    }
    const { promise: decided, resolve: decide } = Promise.withResolvers<Decision>();
    this.#sessions.set(session, { challenge: named.challenge, codeId: redeemed.codeId, key: request.publicKey, canAdmit: request.canAdmit, decide, decided });
    return { session, challenge: named.challenge };
  }

  /** The device's one proof over its challenge; a wrong one, or any second one, ends the pairing. */
  async prove(sessionId: string, signature: string): Promise<ProveResult> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.pendingId !== undefined) return this.#end(sessionId);
    const entry = await this.#pending.prove(session.challenge, signature);
    if (entry === null) return this.#end(sessionId);
    // the session ended in the turn its entry was published, before this one could name it: the entry goes too
    if (!this.#sessions.has(sessionId)) { this.#pending.decline(entry.id); return { refuse: "auth_failed" }; }
    session.pendingId = entry.id;
    this.#byPending.set(entry.id, sessionId);
    return { pending: entry };
  }

  /** How the wait ends: the admitted row, or null. */
  decision(sessionId: string): Promise<Decision> {
    return this.#sessions.get(sessionId)?.decided ?? Promise.resolve({ admitted: null });
  }

  /**
   * The screen approved a waiting key by the fingerprint it showed (a confirm the caller has already used up). The
   * admission re-runs every guard; a refusal there admits nobody.
   */
  approve(pendingId: string, fingerprint: string, source: "screen" | "recover"): DeviceMatch | null {
    const sessionId = this.#byPending.get(pendingId);
    if (sessionId === undefined) return null;
    const entry = this.#pending.take(pendingId, fingerprint);
    const session = this.#sessions.get(sessionId);
    if (entry === null || entry.codeId === undefined || session === undefined) return null;
    let admitted: DeviceMatch | null = null;
    try {
      if (session.canAdmit?.() !== false) admitted = this.#seams.admitConfirmed({ codeId: entry.codeId, key: entry.key, label: entry.label, source });
    } catch (error) {
      console.error("Confirmed key admission failed", { pendingId, error: error instanceof Error ? error.message : "Non-Error thrown" });
    } finally {
      this.#finish(sessionId, admitted);
    }
    return admitted;
  }

  decline(pendingId: string): void {
    this.#pending.decline(pendingId);
  }

  /** The session ended (closed, timed out): whatever it held goes. */
  leave(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    if (session.pendingId !== undefined) this.#pending.decline(session.pendingId);
    else this.#pending.forget(session.challenge);
    this.#finish(sessionId, null);
  }

  /** Whether `pendingId` still waits for the screen. */
  isWaiting(pendingId: string): boolean {
    return this.#pending.list().some((entry) => entry.id === pendingId);
  }

  onChange(listener: () => void): () => void {
    return this.#pending.onChange(listener);
  }

  #end(sessionId: string): { refuse: "auth_failed" } {
    this.leave(sessionId);
    return { refuse: "auth_failed" };
  }

  #finish(sessionId: string, admitted: DeviceMatch | null): void {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    this.#sessions.delete(sessionId);
    if (session.pendingId !== undefined) this.#byPending.delete(session.pendingId);
    this.#releaseUse(session.codeId, session.key, admitted);
    session.decide({ admitted });
  }

  #releaseUse(codeId: string, key: string, admitted: DeviceMatch | null): void {
    const use = JSON.stringify([codeId, key]);
    const count = this.#uses.get(use);
    if (count === 1) {
      this.#uses.delete(use);
      if (admitted === null) this.#seams.releaseRedemption(codeId, key);
    } else if (count !== undefined) {
      this.#uses.set(use, count - 1);
    }
  }
}

/**
 * Puts a waiting key on this PC's screen. Only the screen's approval of exactly that key, used up once, admits it;
 * a decline, or a confirm that runs out, ends the wait.
 */
export function askScreenForKey(confirms: LocalConfirms, pairings: KeyProofPairings, entry: PendingRedemption): void {
  // ended between the proof and this call (its code, key or session): nothing goes on the screen
  if (!pairings.isWaiting(entry.id)) return;
  const action = { kind: "approve_key" as const, pending: entry.id, fingerprint: entry.fingerprint };
  let id: string;
  try {
    id = confirms.request(action, { title: "Approve this device", lines: [`${entry.label} (the name it gives itself)`, "Compare these characters with the ones shown on the device you mean to add."], fingerprint: entry.fingerprint }).id;
  } catch {
    pairings.decline(entry.id);
    return;
  }
  // the waiting entry dropped (declined, its session gone, its code ended, its key removed): the prompt leaves the screen
  const stop = pairings.onChange(() => { if (!pairings.isWaiting(entry.id)) { stop(); confirms.withdraw(id); } });
  void confirms.answer(id).then((answer) => {
    stop();
    if (answer === "approved" && confirms.consume(id, action)) pairings.approve(entry.id, entry.fingerprint, "screen");
    else pairings.decline(entry.id);
  });
}
