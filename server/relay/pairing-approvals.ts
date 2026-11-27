import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync, truncateSync } from "node:fs";
import type { OwnJoinRequest, PairingIntent, RelayPairingRequest, RemotePairingRequest } from "../../shared/machines.ts";
import type { DeviceMatch } from "../devices.ts";
import { writePrivateState } from "../private-state.ts";

/** Comparisons waiting on the owner at once; a phone past them is refused (`auth_failed`), so prompts cannot pile up. */
export const MAX_PENDING_APPROVALS = 3;
/** How long after the owner copies a link without a code this PC takes comparisons, as a Bluetooth device in pairing mode. */
export const PAIRING_WINDOW_MS = 10 * 60_000;

export const pairingWindowFs = { rmSync, truncateSync };

/** How a waiting comparison ended: approved (by this PC when `by` is absent, else by that account member) or not. */
/** `own`: the approval came from this PC's own window or its local command (dispatch.ts ownWindow), the only place a person at this PC decides. */
export type PairingDecision = { approved: true; by?: DeviceMatch; pcLabel?: string; own?: true } | { approved: false };

/** What a remote approval came to: done, nothing waiting under that id, or the wrong digits picked (which ends it). */
/**
 * `not_confirmed`: a join into the list whose new device has not said yet that the digits match; nothing was decided, and
 * the request waits as it did. `list_unknown`: an approval of a join this PC cannot let in (an app that knows no join into
 * a list, on a pinned PC); nothing was decided either, and the request waits until it is declined or ends.
 */
export type RemoteDecision = { outcome: "decided"; device_id: string } | { outcome: "gone" | "wrong_digits" | "not_confirmed" | "list_unknown" };

/**
 * What the owner's typed digits came to on this PC's own window: approved, nothing such waiting, wrong (which ends it), or
 * a join this PC cannot let in (`list_unknown`), which no approval decides: it waits until it is declined or ends.
 */
export type TypedDecision = "decided" | "gone" | "wrong_digits" | "list_unknown";

/** What a tap on this PC's own window came to: decided, nothing such waiting, a join a member could approve, which is typed, or one no approval decides (`list_unknown`). */
export type TapDecision = "decided" | "gone" | "typed_only" | "list_unknown";

interface Waiting {
  request: RelayPairingRequest & { intent: PairingIntent };
  askedAt: number;
  expiresAt: number;
  key: string;
  deviceId: string;
  /** an account join taken outside the pairing window: shown to account members only (docs/account.md, design 5.3) */
  membersOnly: boolean;
  /** asked while this PC's own screen waited to be added to an account: decided on this PC only, never by a member */
  localOnly: boolean;
  /** another PC of the account vouched for by an admission: members are told, so their app checks it (RemotePairingRequest) */
  vouched: boolean;
  provenServerId?: string;
  /**
   * an account join asked while this PC had no member to approve it (a PC added in one press, its owner's first phone):
   * this PC's own window alone lists it with its digits and decides it by a tap (`decideOwn`), never a member
   */
  firstJoin: boolean;
  /** the join brought the device's card for the account's signed list (session.ts listCard) */
  list: boolean;
  /** a join into the account on a PC pinned to its list, from an app that knows no join into a list: nothing lets it in here */
  listUnknown: boolean;
  /** such a join that a device of the list may decide from afar (listJoins): not one asked under this PC's own add-me screen */
  listRemote: boolean;
  /** the new device's person said the digits match */
  confirmed: boolean;
  choices: [string, string, string];
  finish: (decision: PairingDecision) => void;
}

/** An account device's join no pairing window invited: what this PC's own window may list and decide, never a vouched PC. */
const ownJoin = (entry: Waiting): boolean => entry.membersOnly && entry.request.intent === "account" && !entry.vouched;

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
  private windowId: string | null = null;
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
      this.windowId = null;
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
    const { v, window_until: windowUntil, local_only_until: localOnlyUntil, window_id: windowId } = saved as Record<string, unknown>;
    if (v !== 1) return;
    if (typeof windowUntil !== "number" || !Number.isFinite(windowUntil)) return;
    if (typeof localOnlyUntil !== "number" || !Number.isFinite(localOnlyUntil)) return;
    const now = this.now();
    const latest = now + PAIRING_WINDOW_MS;
    if (windowUntil > now && windowUntil <= latest && localOnlyUntil <= latest) {
      this.windowUntil = windowUntil;
      this.localOnlyUntil = localOnlyUntil;
      this.windowId = typeof windowId === "string" && /^[0-9a-f]{32}$/.test(windowId) ? windowId : null;
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
      writePrivateState(this.path, { v: 1, window_until: this.windowUntil, local_only_until: this.localOnlyUntil, ...(this.windowId === null ? {} : { window_id: this.windowId }) });
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
  openWindow(now = this.now(), options: { localOnly?: boolean } = {}): string {
    const id = randomBytes(16).toString("hex");
    this.windowId = id;
    this.windowUntil = now + PAIRING_WINDOW_MS;
    if (options.localOnly) this.localOnlyUntil = now + PAIRING_WINDOW_MS;
    // a window that could not be saved still works until this process ends, but the file it could not
    // replace must not stand in for it at the next start (an older window without its local-only half)
    if (!this.save()) this.forget();
    this.watchExpiry();
    return id;
  }

  /**
   * Takes the saved window away when it could not be rewritten: absent reads as closed, and so does
   * an empty file, which is what is left when the file cannot be removed either. False when neither worked.
   */
  private forget(): boolean {
    if (!this.path) return true;
    try { pairingWindowFs.rmSync(this.path, { force: true }); return true; } catch {}
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
  closeWindow(windowId?: string): boolean {
    if (windowId !== undefined && windowId !== this.windowId) return true;
    const open = this.windowUntil !== 0 || this.localOnlyUntil !== 0;
    this.windowUntil = 0;
    this.localOnlyUntil = 0;
    this.windowId = null;
    this.closeCount += 1;
    this.cancelExpiry?.();
    this.cancelExpiry = undefined;
    for (const entry of [...this.waiting.values()]) if (!entry.membersOnly) entry.finish({ approved: false });
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

  /**
   * Outside the window a comparison is refused before any prompt, so nobody the owner did not invite can raise one;
   * only a join the account service holds a fresh admission for is taken then, for account members alone (session.ts accountJoin).
   */
  windowOpen(now = this.now()): boolean { return now < this.windowUntil; }

  /** `left_ms` is counted on each telling, so a window whose clock differs from this PC's still counts down right. */
  list(now = this.now()): RelayPairingRequest[] {
    return [...this.waiting.values()].filter(({ membersOnly }) => !membersOnly)
      .map(({ request, expiresAt }) => ({ ...request, left_ms: Math.max(0, expiresAt - now) }));
  }

  private vouchedSession: string | undefined;

  reserveVouched(id: string): boolean {
    if (this.vouchedSession !== undefined) return false;
    this.vouchedSession = id;
    return true;
  }

  releaseVouched(id: string): void {
    if (this.vouchedSession === id) this.vouchedSession = undefined;
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
    return [...this.waiting.values()].filter(({ localOnly }) => !localOnly).map(({ request, choices, key, vouched, provenServerId, list, confirmed, listUnknown }) => ({
      id: request.id, label: request.label, intent: request.intent, choices: vouched ? [] : choices, expires_at: request.expires_at, key,
      ...(vouched ? { vouched: true as const, ...(provenServerId ? { proven_server_id: provenServerId } : {}) } : {}),
      // the join brought the device's card for the account's list: it is let in by an entry of the list, which its approver signs
      ...(list ? { list: true as const } : {}),
      ...(list && confirmed ? { confirmed: true as const } : {}),
      // one this PC cannot let in: no approval decides it (decideRemote), and the approver's card says to update that app
      ...(listUnknown ? { list_unknown: true as const } : {}),
    }));
  }

  /**
   * The joins into the account's list, for a device of that list which may add devices to it: also a first join,
   * since that device's right is the list's own word and no membership that could begin meanwhile. Never one asked
   * under this PC's own add-me screen, and never a pairing of this PC's own.
   */
  listJoins(): RemotePairingRequest[] {
    return [...this.waiting.values()].filter(({ listRemote }) => listRemote).map(({ request, choices, key, confirmed }) => ({
      id: request.id, label: request.label, intent: request.intent, choices, expires_at: request.expires_at, key, list: true as const,
      ...(confirmed ? { confirmed: true as const } : {}),
    }));
  }

  /** A device of the list decides a join into the list (listJoins): as decideRemote, for those joins alone. */
  decideForList(id: string, approved: boolean, digits: string, by: DeviceMatch): RemoteDecision {
    const entry = this.waiting.get(id);
    if (!entry || !entry.listRemote) return { outcome: "gone" };
    if (!approved) { entry.finish({ approved: false }); return { outcome: "decided", device_id: entry.deviceId }; }
    // the approver signs the device's entry, and signs it only for a device whose person said the digits match
    if (!entry.confirmed) return { outcome: "not_confirmed" };
    if (digits !== entry.request.digits) { entry.finish({ approved: false }); return { outcome: "wrong_digits" }; }
    entry.finish({ approved: true, by });
    return { outcome: "decided", device_id: entry.deviceId };
  }

  /** As subscribeRemote, of the joins into the list. */
  subscribeList(listener: (pairings: RemotePairingRequest[]) => void): () => void {
    const told = () => listener(this.listJoins());
    this.listListeners.add(told);
    told();
    return () => { this.listListeners.delete(told); };
  }
  private readonly listListeners = new Set<() => void>();

  /**
   * The account joins taken outside the pairing window, for this PC's own window alone (dispatch.ts, ownWindow): listed
   * without their digits, which the owner types from the new device's screen (`decideTyped`), so no prompt the owner did
   * not start can be waved through with a tap. A first join comes with its digits: nobody else could approve it, and its
   * owner compares them and taps (`decideOwn`).
   */
  ownJoins(now = this.now()): OwnJoinRequest[] {
    return [...this.waiting.values()].filter(ownJoin).map(({ request, askedAt, expiresAt, firstJoin, list, listUnknown }) => ({
      id: request.id, label: request.label, asked_at: new Date(askedAt).toISOString(), left_ms: Math.max(0, expiresAt - now),
      ...(firstJoin ? { digits: request.digits } : {}), ...(list ? { list: true as const } : {}), ...(listUnknown ? { list_unknown: true as const } : {}),
    }));
  }

  /** The key of the device a waiting request is of, or null for none waiting. */
  keyOf(id: string): string | null {
    return this.waiting.get(id)?.key ?? null;
  }

  /** On this PC's own window: Allow or Decline of a first join, and Decline of a join marked list_unknown. A join a member could approve is typed instead. */
  decideOwn(id: string, approved: boolean): TapDecision {
    const entry = this.waiting.get(id);
    if (!entry || !ownJoin(entry)) return "gone";
    // an app that knows no join into the list: this PC lets it in by nothing, so an Allow approves nothing; a Decline
    // ends it, first join or not (nothing of it is typed)
    if (entry.listUnknown) {
      if (approved) return "list_unknown";
      entry.finish({ approved: false });
      return "decided";
    }
    if (!entry.firstJoin) return "typed_only";
    entry.finish(approved ? { approved: true, own: true } : { approved: false });
    return "decided";
  }

  /** On this PC's own window: the digits the new device shows, typed by the owner. One wrong entry ends that join. */
  decideTyped(id: string, digits: string): TypedDecision {
    const entry = this.waiting.get(id);
    if (!entry || !ownJoin(entry)) return "gone";
    if (entry.listUnknown) return "list_unknown";
    const typed = Buffer.from(digits), shown = Buffer.from(entry.request.digits);
    if (typed.length !== shown.length || !timingSafeEqual(typed, shown)) { entry.finish({ approved: false }); return "wrong_digits"; }
    entry.finish({ approved: true, own: true });
    return "decided";
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
  ask(label: string, digits: string, expiresAt: number, device: { intent: PairingIntent; key: string; deviceId: string; membersOnly?: boolean; localOnly?: boolean; vouched?: boolean; provenServerId?: string; firstJoin?: boolean; list?: boolean; listUnknown?: boolean } = { intent: "pc", key: "", deviceId: "" }): { decision: Promise<PairingDecision>; withdraw: () => void; confirm: () => void } | null {
    if (this.waiting.size >= MAX_PENDING_APPROVALS) return null;
    const id = randomBytes(8).toString("hex");
    const decided = Promise.withResolvers<PairingDecision>();
    const finish = (decision: PairingDecision) => {
      if (!this.waiting.delete(id)) return;
      this.changed();
      decided.resolve(decision);
    };
    // fixed when the phone asked (session.ts), so a window that closes before its digits are shown changes nothing
    // a first join is this PC's own as well: no member that joins meanwhile may decide it
    const firstJoin = device.firstJoin ?? false;
    const ownScreen = device.localOnly ?? this.localOnlyOpen();
    const ownOnly = !(device.membersOnly ?? false) && ownScreen;
    const localOnly = firstJoin || ownOnly;
    this.waiting.set(id, { request: { id, label, digits, expires_at: new Date(expiresAt).toISOString(), intent: device.intent, ...(localOnly ? { local_only: true as const } : {}) },
      askedAt: this.now(), expiresAt, key: device.key, deviceId: device.deviceId, membersOnly: device.membersOnly ?? false, localOnly, vouched: device.vouched ?? false, ...(device.provenServerId ? { provenServerId: device.provenServerId } : {}), firstJoin, list: device.list ?? false, listUnknown: device.listUnknown ?? false, listRemote: (device.list ?? false) && !ownScreen, confirmed: false, choices: decoys(digits), finish });
    this.changed();
    return {
      decision: decided.promise, withdraw: () => finish({ approved: false }),
      // The new device's person said the digits match. For a join into the list that is told to whoever may approve
      // it, while it still waits: its approver signs the entry only then. For any other request it is kept and told
      // to nobody: a PC that follows no list tells and answers what it always did
      confirm: () => {
        const entry = this.waiting.get(id);
        if (entry === undefined || entry.confirmed) return;
        entry.confirmed = true;
        if (entry.list) this.changed();
      },
    };
  }

  /**
   * On this PC. False for an id that is not waiting: never asked, already decided, withdrawn or expired. `own`: the
   * caller is this PC's own window, which the decision keeps: a pairing is approved by any browser that drives this
   * PC, but only its own window signs for it (session.ts allowIntoList).
   */
  decide(id: string, approved: boolean, own = false): boolean {
    const entry = this.waiting.get(id);
    // a join the PC's own windows were never shown is not theirs to decide
    if (!entry || entry.membersOnly) return false;
    entry.finish(approved ? { approved: true, ...(own ? { own: true as const } : {}) } : { approved: false });
    return true;
  }

  /**
   * From an account member through the relay, who must name the new device's digits. A wrong pick
   * declines it, so guessing among the three costs the comparison and counts as a failed pairing.
   */
  decideRemote(id: string, approved: boolean, digits: string, by: DeviceMatch, pc?: { id: string; label: string }): RemoteDecision {
    const entry = this.waiting.get(id);
    if (!entry || entry.localOnly) return { outcome: "gone" };
    if (!approved) { entry.finish({ approved: false }); return { outcome: "decided", device_id: entry.deviceId }; }
    // an app that knows no join into the list, on a pinned PC: no approval lets it in, the right digits included
    if (entry.listUnknown) return { outcome: "list_unknown" };
    // a join into the list: the member signs the device's entry, and only once its person said the digits match. The
    // request stays as it was, for the approval that comes after the confirmation
    if (entry.list && !entry.confirmed) return { outcome: "not_confirmed" };
    if (entry.vouched ? !entry.provenServerId || pc?.id !== entry.provenServerId || digits !== "" : digits !== entry.request.digits || pc !== undefined) { entry.finish({ approved: false }); return { outcome: "wrong_digits" }; }
    entry.finish({ approved: true, by, ...(pc ? { pcLabel: pc.label } : {}) });
    return { outcome: "decided", device_id: entry.deviceId };
  }

  private changed(): void {
    const pairings = this.list();
    for (const listener of this.listeners) listener(pairings);
    const remote = this.remoteList();
    for (const listener of this.remoteListeners) listener(remote);
    for (const listener of this.listListeners) listener();
  }
}
