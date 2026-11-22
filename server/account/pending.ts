/**
 * Pending redemptions (docs/account.md, "Confirmed on this PC"): a code redeemed on a PC with screen proof admits
 * nobody. The device names its key first; only then does the PC make a challenge, so the key cannot be chosen to show
 * a wanted fingerprint. The device proves the key over that challenge once, and waits in memory until the PC's screen
 * approves that one key by its fingerprint, declines it, or it runs out. A restart ends them all.
 */
import { randomBytes } from "node:crypto";
import type { PendingKey } from "../../shared/machines.ts";
import { PENDING_MS, pairChallenge, pairFingerprint, verifyPairProof } from "../../shared/pair-fingerprint.ts";

export { PENDING_MS } from "../../shared/pair-fingerprint.ts";
export const PENDING_PER_CODE = 5;
export const PENDING_TOTAL = 8;

/** How the redeemer reached the PC: through the relay, or at this PC's own address. */
export type PendingVia = "relay" | "address";

export interface PendingRedemption {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly via: PendingVia;
  readonly redeemedAt: number;
  /** the use of its code this redemption holds (Track A's redeemCode); given back unless it is approved */
  readonly codeId?: string;
}

interface Reservation {
  readonly codeId: string;
  readonly serverId?: string;
  readonly release?: () => void;
  /** whether its code is still in force now: one that ran out before its timer ended it puts nothing on the screen (S13-1) */
  readonly live?: () => boolean;
}

interface Named { code: string; label: string; key: string; via: PendingVia; at: number; reservation?: Reservation & { readonly release: () => void } }

export class PendingLimitError extends Error {}

export class PendingRedemptions {
  readonly #serverId: () => string | null;
  readonly #now: () => number;
  readonly #journalDrop: (entry: { key: string; label: string; reason: string }) => void;
  readonly #release: (codeId: string, key: string) => void;
  /** challenges sent and not yet answered, each for the one key named before it was made */
  readonly #named = new Map<string, Named>();
  /** answered challenges whose proof is still being checked: a code or key that ends meanwhile ends them too (S13-1) */
  readonly #proving = new Map<string, Named>();
  readonly #waiting = new Map<string, PendingRedemption>();
  readonly #releaseWaiting = new WeakMap<PendingRedemption, () => void>();
  readonly #listeners = new Set<() => void>();

  constructor(options: {
    serverId: string | (() => string | null);
    now?: () => number;
    journalDrop(entry: { key: string; label: string; reason: string }): void;
    /** gives a held use of a code back (Track A's releaseRedemption) */
    release?(codeId: string, key: string): void;
  }) {
    const serverId = options.serverId;
    this.#serverId = typeof serverId === "string" ? () => serverId : serverId;
    this.#now = options.now ?? Date.now;
    this.#journalDrop = options.journalDrop;
    this.#release = options.release ?? (() => {});
  }

  /**
   * A device named its key for `code`: a fresh challenge for that key alone. Naming a key again (`previous`) spends the
   * challenge it had, so a key changed after a challenge was seen starts over with a new one. `reservation.serverId`:
   * the relay identity the device paired to; this PC's own by default.
   */
  name(code: string, label: string, key: string, via: PendingVia, previous?: string, reservation?: Reservation): { challenge: string } {
    this.#sweep();
    if (previous !== undefined) this.#forgetNamed(previous);
    const forCode = [...this.#waiting.values(), ...this.#named.values(), ...this.#proving.values()].filter((entry) => entry.code === code).length;
    if (forCode >= PENDING_PER_CODE) throw new PendingLimitError("This code has as many devices waiting as it may");
    if (this.#waiting.size + this.#named.size + this.#proving.size >= PENDING_TOTAL) throw new PendingLimitError("As many devices wait for this PC's screen as may");
    const challenge = pairChallenge();
    const use = reservation === undefined ? {} : {
      reservation: { ...reservation, release: reservation.release ?? (() => this.#release(reservation.codeId, key)) },
    };
    this.#named.set(challenge, { code, label, key, via, at: this.#now(), ...use });
    return { challenge };
  }

  /** The device's proof over its challenge; the challenge is spent by any answer, right or wrong. */
  async prove(challenge: string, signature: string): Promise<PendingRedemption | null> {
    this.#sweep();
    const named = this.#named.get(challenge);
    this.#named.delete(challenge);
    if (named === undefined) return null;
    this.#proving.set(challenge, named);
    const reservation = named.reservation;
    const serverId = reservation?.serverId ?? this.#serverId();
    const proved = serverId !== null && await verifyPairProof(serverId, challenge, named.key, signature);
    const fingerprint = proved ? await pairFingerprint(serverId, challenge, named.key) : null;
    // ended while it was checked: dropCode or dropKey already gave its use back
    if (!this.#proving.delete(challenge)) return null;
    if (fingerprint === null || reservation?.live?.() === false) {
      reservation?.release();
      return null;
    }
    const entry: PendingRedemption = Object.freeze({
      id: randomBytes(16).toString("hex"), code: named.code, label: named.label, key: named.key, via: named.via, redeemedAt: this.#now(),
      ...(reservation === undefined ? {} : { codeId: reservation.codeId }),
      fingerprint,
    });
    if (reservation !== undefined) this.#releaseWaiting.set(entry, reservation.release);
    this.#waiting.set(entry.id, entry);
    this.#changed();
    return entry;
  }

  list(): PendingRedemption[] {
    this.#sweep();
    return [...this.#waiting.values()];
  }

  /** The list as the PC's windows show it, each with how many of its code's slots are taken. */
  view(): PendingKey[] {
    const waiting = this.list();
    return waiting.map((entry) => ({
      id: entry.id, label: entry.label, fingerprint: entry.fingerprint, via: entry.via, redeemed_at: new Date(entry.redeemedAt).toISOString(),
      slots: { used: waiting.filter((other) => other.code === entry.code).length, of: PENDING_PER_CODE },
    }));
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch (error) { console.error(`A pending-redemption listener failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  /** The screen's approval of `id` by the fingerprint it showed: the redemption, taken out, or null. */
  take(id: string, fingerprint: string): PendingRedemption | null {
    this.#sweep();
    const entry = this.#waiting.get(id);
    if (entry === undefined || entry.fingerprint !== fingerprint) return null;
    this.#waiting.delete(id);
    this.#changed();
    return entry;
  }

  decline(id: string): void {
    this.#drop((entry) => entry.id === id, "declined");
  }

  /** A challenge whose device went away before its proof was taken in: its slot and its held use come back. */
  forget(challenge: string): void {
    this.#forgetNamed(challenge);
    this.#endProving((_named, at) => at === challenge);
  }

  /** A removal, block or Revoke of `key` drops its unanswered challenges and waiting entries. */
  dropKey(key: string, reason: string): void {
    for (const [challenge, named] of this.#named) if (named.key === key) this.#forgetNamed(challenge);
    this.#endProving((named) => named.key === key);
    this.#drop((entry) => entry.key === key, reason);
  }

  /** The code ended (cancelled, run out, used by an admission, Revoke all): what waits on it goes (DeviceStore.onPairingEnded). */
  dropCode(codeId: string): void {
    for (const [challenge, named] of this.#named) if (named.reservation?.codeId === codeId) this.#forgetNamed(challenge);
    this.#endProving((named) => named.reservation?.codeId === codeId);
    this.#drop((entry) => entry.codeId === codeId, "code_ended");
  }

  #endProving(which: (named: Named, challenge: string) => boolean): void {
    for (const [challenge, named] of this.#proving) {
      if (!which(named, challenge)) continue;
      this.#proving.delete(challenge);
      named.reservation?.release();
    }
  }

  #drop(which: (entry: PendingRedemption) => boolean, reason: string): void {
    let dropped = false;
    for (const entry of [...this.#waiting.values()]) {
      if (!which(entry)) continue;
      this.#waiting.delete(entry.id);
      this.#releaseWaiting.get(entry)?.();
      this.#journalDrop({ key: entry.key, label: entry.label, reason });
      dropped = true;
    }
    if (dropped) this.#changed();
  }

  #forgetNamed(challenge: string): void {
    const named = this.#named.get(challenge);
    this.#named.delete(challenge);
    named?.reservation?.release();
  }

  #sweep(): void {
    const now = this.#now();
    for (const [challenge, named] of this.#named) if (now - named.at >= PENDING_MS) this.#forgetNamed(challenge);
    this.#drop((entry) => now - entry.redeemedAt >= PENDING_MS, "expired");
  }
}
