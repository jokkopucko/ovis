import { randomBytes, randomInt } from "node:crypto";
import { existsSync, readFileSync, rmSync, truncateSync } from "node:fs";
import type { PairingIntent, RelayPairingRequest, RemotePairingRequest } from "../../shared/machines.ts";
import type { DeviceMatch } from "../devices.ts";
import { writePrivateState } from "../private-state.ts";

/** Comparisons waiting on the owner at once; a phone past them is refused (`auth_failed`), so prompts cannot pile up. */
export const MAX_PENDING_APPROVALS = 3;
/** How long after the owner copies a link without a code this PC takes comparisons, as a Bluetooth device in pairing mode. */
export const PAIRING_WINDOW_MS = 10 * 60_000;

/** The file calls that take the saved window away, swappable in tests. */
export const pairingWindowFs = { rmSync, truncateSync };

/** How a waiting comparison ended: approved (by this PC when `by` is absent, else by that account member) or not. */
export type PairingDecision = { approved: true; by?: DeviceMatch } | { approved: false };

/** What a remote approval came to: done, nothing waiting under that id, or the wrong digits picked (which ends it). */
export type RemoteDecision = { outcome: "decided"; device_id: string } | { outcome: "gone" | "wrong_digits" };

interface Waiting {
  request: RelayPairingRequest & { intent: PairingIntent };
  /** when the comparison runs out, on this PC's clock */
  expiresAt: number;
  /** the new device's key, and the id its row will have (accountDeviceId) */
  key: string;
  deviceId: string;
  /** an account join taken outside the pairing window: shown to account members only (docs/account.md, design 5.3) */
  membersOnly: boolean;
  /** asked while this PC's own screen waited to be added to an account: decided on this PC only, never by a member */
  localOnly: boolean;
  choices: [string, string, string];
  finish: (decision: PairingDecision) => void;
}

function decoys(digits: string): [string, string, string] {
  const picked = new Set([digits]);
  while (picked.size < 3) picked.add(String(randomInt(0, 1_000_000)).padStart(6, "0"));
  const choices = [...picked];
  for (let index = choices.length - 1; index > 0; index--) {
    const other = randomInt(0, index + 1);
    [choices[index], choices[other]] = [choices[other]!, choices[index]!];
  }
  return choices as [string, string, string];
}

/**
 * The phones waiting for approval after both screens showed the same digits (server/relay/session.ts).
 * Held in memory only: a restart drops them with their sessions. The PC's own windows hear of every
 * change with the digits (`relay-pairings`); drive account members connected through the relay hear
 * of it with three candidates instead (`remote-pairings`, docs/account.md "Who may admit a device").
 *
 * The pairing window itself is kept in `path` when one is given, so a PC that restarts (an update)
 * while it waits to be added still takes the comparison it asked for: never past the ten minutes it
 * was opened for, and closed again by closeWindow.
 */
export class RelayPairingApprovals {
  private readonly waiting = new Map<string, Waiting>();
  private readonly listeners = new Set<(pairings: RelayPairingRequest[]) => void>();
  private readonly remoteListeners = new Set<(pairings: RemotePairingRequest[]) => void>();
  private windowUntil = 0;
  private localOnlyUntil = 0;
  private readonly path: string | undefined;
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => () => void;
  private cancelExpiry: (() => void) | undefined;
  private closeCount = 0;

  constructor(options: { path?: string; now?: () => number; setTimer?: (run: () => void, ms: number) => () => void } = {}) {
    this.path = options.path;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((run, ms) => {
      const timer = setTimeout(run, ms);
      timer.unref();
      return () => clearTimeout(timer);
    });
    this.load();
  }

  /** How many times the window was closed on purpose: a comparison taken before a close is not shown after it (session.ts). */
  get closes(): number { return this.closeCount; }

  /**
   * Writes the window closed once it has run out, so the file never holds a deadline a later start
   * could land inside (a clock that went back). Nothing waits on it: the timer does not keep the server up.
   */
  private watchExpiry(): void {
    this.cancelExpiry?.();
    this.cancelExpiry = undefined;
    if (!this.path) return;
    const until = Math.max(this.windowUntil, this.localOnlyUntil);
    if (until === 0) return;
    this.cancelExpiry = this.setTimer(() => {
      this.cancelExpiry = undefined;
      if (this.now() < Math.max(this.windowUntil, this.localOnlyUntil)) { this.watchExpiry(); return; }
      this.windowUntil = 0;
      this.localOnlyUntil = 0;
      // a file that is gone already reads as closed: nothing is written into a state directory that was removed
      if (this.path && existsSync(this.path) && !this.save()) this.forget();
      // never longer than a window: a clock set far back would overflow the timer and fire it at once, over and over
    }, Math.min(PAIRING_WINDOW_MS, Math.max(0, until - this.now())));
  }

  /**
   * The saved window, when the file holds both deadlines: one without the other reads as closed, since
   * a window that came back without its local-only half would show what it takes to account members.
   * A deadline further ahead than a window opened now is not a window this clock opened (the clock ran
   * ahead when it was saved, or went back since): it reads as closed, never as a fresh ten minutes at
   * every start. Whatever is not open now is written back as closed, so a clock that later goes back
   * cannot reopen it.
   */
  private load(): void {
    if (!this.path) return;
    let saved: unknown;
    try { saved = JSON.parse(readFileSync(this.path, "utf8")); } catch { return; }
    if (typeof saved !== "object" || saved === null) return;
    const { v, window_until: windowUntil, local_only_until: localOnlyUntil } = saved as Record<string, unknown>;
    if (v !== 1) return;
    if (typeof windowUntil !== "number" || !Number.isFinite(windowUntil)) return;
    if (typeof localOnlyUntil !== "number" || !Number.isFinite(localOnlyUntil)) return;
    const now = this.now();
    const latest = now + PAIRING_WINDOW_MS;
    if (windowUntil > now && windowUntil <= latest && localOnlyUntil <= latest) {
      this.windowUntil = windowUntil;
      this.localOnlyUntil = localOnlyUntil;
      this.watchExpiry();
      return;
    }
    if (windowUntil === 0 && localOnlyUntil === 0) return;
    if (!this.save()) this.forget();
  }

  /** Both deadlines in one write, so the file never holds one without the other. False when it could not be written. */
  private save(): boolean {
    if (!this.path) return true;
    try {
      writePrivateState(this.path, { v: 1, window_until: this.windowUntil, local_only_until: this.localOnlyUntil });
      return true;
    } catch (error) {
      console.warn(JSON.stringify({ event: "relay.pairing_window.save_failed", error: error instanceof Error ? error.message : String(error) }));
      return false;
    }
  }

  /**
   * The owner asked for a link without a code: comparisons are taken for PAIRING_WINDOW_MS from now.
   * `localOnly`: this PC's own screen waits to be added to an account (docs/account.md, "Adding a PC"),
   * so what is asked until then is decided here only, even once the PC has members who could approve.
   */
  openWindow(now = this.now(), options: { localOnly?: boolean } = {}): void {
    this.windowUntil = now + PAIRING_WINDOW_MS;
    if (options.localOnly) this.localOnlyUntil = now + PAIRING_WINDOW_MS;
    // a window that could not be saved still works until this process ends, but the file it could not
    // replace must not stand in for it at the next start (an older window without its local-only half)
    if (!this.save()) this.forget();
    this.watchExpiry();
  }

  /**
   * Takes the saved window away when it could not be rewritten: absent reads as closed, and so does
   * an empty file, which is what is left when the file cannot be removed either. False when neither worked.
   */
  private forget(): boolean {
    if (!this.path) return true;
    try { pairingWindowFs.rmSync(this.path, { force: true }); return true; } catch { /* truncated below */ }
    try { pairingWindowFs.truncateSync(this.path, 0); return true; }
    catch (error) {
      console.warn(JSON.stringify({ event: "relay.pairing_window.forget_failed", error: error instanceof Error ? error.message : String(error) }));
      return false;
    }
  }

  /**
   * Ends the window now: the owner stopped waiting, revoked every device, reset the relay identity or
   * turned the relay off. A comparison this PC's own windows were shown under that window ends
   * unapproved with it, so nothing asked before the close can be approved after it; a join shown to
   * account members only never depended on the window and stays. False when the saved window could
   * neither be rewritten nor taken away: it is closed for this process, but a restart could bring it back.
   */
  closeWindow(): boolean {
    const open = this.windowUntil !== 0 || this.localOnlyUntil !== 0;
    this.windowUntil = 0;
    this.localOnlyUntil = 0;
    this.closeCount += 1;
    this.cancelExpiry?.();
    this.cancelExpiry = undefined;
    for (const entry of [...this.waiting.values()]) if (!entry.membersOnly) entry.finish({ approved: false });
    // nothing was open and what is saved already reads as closed: nothing to write, whatever the disk allows
    if (!this.path || (!open && this.savedClosed())) return true;
    // a file that cannot be rewritten must not bring the window back at the next start: absent reads as closed
    return this.save() || this.forget();
  }

  /** Whether the file is absent or holds no window a start would open: closed deadlines, or nothing load() reads. */
  private savedClosed(): boolean {
    if (!this.path || !existsSync(this.path)) return true;
    try {
      const saved = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (typeof saved !== "object" || saved === null) return true;
      const { v, window_until: windowUntil, local_only_until: localOnlyUntil } = saved as Record<string, unknown>;
      return v !== 1 || typeof windowUntil !== "number" || typeof localOnlyUntil !== "number" || (windowUntil === 0 && localOnlyUntil === 0);
    } catch (error) {
      // an empty or damaged file is what load() reads as closed; one that cannot be read at all is not known to be
      return error instanceof SyntaxError;
    }
  }

  /** Whether a comparison taken now is this PC's own to decide: asked while its add-me screen waited. */
  localOnlyOpen(now = this.now()): boolean { return now < this.localOnlyUntil; }

  /** Outside the window a comparison is refused before any prompt, so nobody the owner did not invite can raise one. */
  windowOpen(now = this.now()): boolean { return now < this.windowUntil; }

  /** `left_ms` is counted on each telling, so a window whose clock differs from this PC's still counts down right. */
  list(now = this.now()): RelayPairingRequest[] {
    return [...this.waiting.values()].filter(({ membersOnly }) => !membersOnly)
      .map(({ request, expiresAt }) => ({ ...request, left_ms: Math.max(0, expiresAt - now) }));
  }

  private readonly joins: number[] = [];

  /** Counts one account join asked for outside the pairing window; false past 5 a minute. */
  takeAccountJoin(now = Date.now()): boolean {
    while (this.joins.length && now - this.joins[0]! >= 60_000) this.joins.shift();
    if (this.joins.length >= 5) return false;
    this.joins.push(now);
    return true;
  }

  remoteList(): RemotePairingRequest[] {
    return [...this.waiting.values()].filter(({ localOnly }) => !localOnly).map(({ request, choices, key }) => ({
      id: request.id, label: request.label, intent: request.intent, choices, expires_at: request.expires_at, key,
    }));
  }

  /** Told the whole list at once, so a window that reconnects drops what was decided meanwhile, then on every change. */
  subscribe(listener: (pairings: RelayPairingRequest[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.list());
    return () => { this.listeners.delete(listener); };
  }

  subscribeRemote(listener: (pairings: RemotePairingRequest[]) => void): () => void {
    this.remoteListeners.add(listener);
    listener(this.remoteList());
    return () => { this.remoteListeners.delete(listener); };
  }

  /** Null when MAX_PENDING_APPROVALS are already waiting. `withdraw` ends it unapproved (the phone left, or time ran out). */
  ask(label: string, digits: string, expiresAt: number, device: { intent: PairingIntent; key: string; deviceId: string; membersOnly?: boolean; localOnly?: boolean } = { intent: "pc", key: "", deviceId: "" }): { decision: Promise<PairingDecision>; withdraw: () => void } | null {
    if (this.waiting.size >= MAX_PENDING_APPROVALS) return null;
    const id = randomBytes(8).toString("hex");
    const decided = Promise.withResolvers<PairingDecision>();
    const finish = (decision: PairingDecision) => {
      if (!this.waiting.delete(id)) return;
      this.changed();
      decided.resolve(decision);
    };
    // fixed when the phone asked (session.ts), so a window that closes before its digits are shown changes nothing
    const localOnly = !(device.membersOnly ?? false) && (device.localOnly ?? this.localOnlyOpen());
    // the PC's own windows are told, so their prompt asks for the digits to be typed on the other device.
    // It follows this PC's window, not the other device's screen: a phone that pairs by an ordinary link
    // while the add-me window is still open shows digits to compare, and the prompt's words hold for both.
    this.waiting.set(id, { request: { id, label, digits, expires_at: new Date(expiresAt).toISOString(), intent: device.intent, ...(localOnly ? { local_only: true as const } : {}) },
      expiresAt, key: device.key, deviceId: device.deviceId, membersOnly: device.membersOnly ?? false, localOnly, choices: decoys(digits), finish });
    this.changed();
    return { decision: decided.promise, withdraw: () => finish({ approved: false }) };
  }

  /** On this PC. False for an id that is not waiting: never asked, already decided, withdrawn or expired. */
  decide(id: string, approved: boolean): boolean {
    const entry = this.waiting.get(id);
    // a join the PC's own windows were never shown is not theirs to decide
    if (!entry || entry.membersOnly) return false;
    entry.finish(approved ? { approved: true } : { approved: false });
    return true;
  }

  /**
   * From an account member through the relay, who must name the new device's digits. A wrong pick
   * declines it, so guessing among the three costs the comparison and counts as a failed pairing.
   */
  decideRemote(id: string, approved: boolean, digits: string, by: DeviceMatch): RemoteDecision {
    const entry = this.waiting.get(id);
    if (!entry || entry.localOnly) return { outcome: "gone" };
    if (!approved) { entry.finish({ approved: false }); return { outcome: "decided", device_id: entry.deviceId }; }
    if (digits !== entry.request.digits) { entry.finish({ approved: false }); return { outcome: "wrong_digits" }; }
    entry.finish({ approved: true, by });
    return { outcome: "decided", device_id: entry.deviceId };
  }

  private changed(): void {
    const pairings = this.list();
    for (const listener of this.listeners) listener(pairings);
    const remote = this.remoteList();
    for (const listener of this.remoteListeners) listener(remote);
  }
}
