import type { PendingMessage, PendingRemoval } from "../../shared/protocol.ts";
import { paneLifetimes, paneStateKey, type PaneLifetimes } from "./paneLifetime.ts";

/**
 * `heldUntil`: held only on this page, by a held receipt, until this time (Date.now); saved, and once it passes, the copy is uncertain.
 * `heldBy`: the connection whose receipt holds it (its scope: one per PC and connection). The proof ends with that
 * connection, not with another PC's.
 * `heldByRequest`: its sender held it on purpose (`delivery: "hold"`: Alt+Enter, or a follow-up with automatic sending off). The
 * bridge never sends such a message by itself, so its saved copy stays held, with Send now, through a lost connection, a reload
 * and a restart of the server; it needs no receipt and takes no `heldUntil`.
 */
export interface PendingMessageView extends PendingMessage { serverOwned: boolean; resendInFlight?: true; resendGeneration?: number; heldUntil?: number; heldBy?: string; heldByRequest?: true }
/**
 * Whether the bridge's own message says its sender asked for the hold: the bridge holds that one with no reason, and every
 * other hold names its reason (a lost connection, a turn that never started, a refused send; server/pending-input.ts).
 */
const requestedHold = (message: PendingMessage): boolean => message.state === "held" && message.error === undefined;
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** a resumed `held` ID (the frame's own `held` field) travels with the removals */
export type Removal = PendingRemoval | { id: string; outcome: "held"; resumed: true; /** when (Date.now) the bridge's receipt ends */ until: number };
/** a frame field's value for one ID, from whatever the frame carries */
const byId = (value: unknown, id: string): unknown => typeof value === "object" && value !== null && Object.hasOwn(value, id) ? Reflect.get(value, id) : undefined;
/**
 * A pending-messages frame's removals and its resumed `held` IDs, as `publish` takes them. A held ID is a proof only
 * when the frame names its end on the PC's clock (`held_until`) and that clock as it sent the frame (`server_time`),
 * no more than ten minutes apart (and a valid `held_ms`); anything else proves nothing. The end is reckoned on this
 * page's clock by `offset` (this page's clock less the PC's), the least of this frame's own arrival offset and
 * `lowest`, the least any earlier frame of the connection gave: a frame's delay only raises its offset, so the end is
 * never later than this frame's arrival plus the time the bridge said was left.
 */
export const frameRemovals = (frame: { removed?: PendingRemoval[]; held?: unknown; held_ms?: unknown; held_until?: unknown; server_time?: unknown }, lowest?: number): Removal[] => {
  const ids: unknown = frame.held;
  const held = Array.isArray(ids) && ids.every((id): id is string => typeof id === "string") ? ids : [];
  const sentAt = frame.server_time;
  const own = typeof sentAt === "number" && Number.isFinite(sentAt) ? Date.now() - sentAt : undefined;
  const offset = own === undefined ? undefined : lowest !== undefined && Number.isFinite(lowest) ? Math.min(own, lowest) : own;
  return [...frame.removed ?? [], ...(offset === undefined ? [] : held.flatMap((id) => {
    const left = byId(frame.held_ms, id), until = byId(frame.held_until, id);
    if (typeof left !== "number" || !Number.isFinite(left) || left <= 0 || left > HELD_RECEIPT_MS) return [];
    if (typeof until !== "number" || !Number.isFinite(until) || until - (sentAt as number) <= 0 || until - (sentAt as number) > HELD_RECEIPT_MS) return [];
    return [{ id, outcome: "held" as const, resumed: true as const, until: until + offset }];
  }))];
};
const PREFIX = "ovis:pending:";
/** the bridge keeps a held receipt this long (server/core/pending.ts PI_RESUME_MS), at most: a bridge that names no time gets this */
const HELD_RECEIPT_MS = 10 * 60 * 1000;
/** a held receipt's proof, by the time it ends */
const freshReceipt = (until: number | undefined): until is number => until !== undefined && Date.now() < until;
const piReceipt = (message: PendingMessage): boolean => message.id.startsWith("pi:")
  && (message.error?.code === "pi_transcript_pending" || message.error?.code === "transcript_unconfirmed");

/** A row's error for a message an older bridge took with no receipt (SubmitResult `unconfirmed`). */
export const UNCONFIRMED_SEND = { code: "submit_unconfirmed", message: "This PC sent no receipt, so nothing confirmed the pane took this message" };

/** Connection proof stays in memory. A saved copy can never resume automatic delivery. */
export class PendingMessageStore {
  private rows = new Map<string, PendingMessageView[]>();
  private scopes = new Map<string, Map<string, string>>();
  private removed = new Map<string, Map<string, Set<string>>>();
  /** ids an exact resumed receipt settled (a consumed Pi id, or a resumed sent/discarded one): no saved copy brings them back */
  private settledResumed = new Map<string, Set<string>>();
  /** ids an exact resumed receipt confirmed held without typing: a saved copy from before the drop stays held */
  private heldResumed = new Map<string, Map<string, { until: number; scope: string }>>();
  /** ids this page discarded: a later resumed held ID never offers them for an explicit send again */
  private discarded = new Map<string, Set<string>>();
  private receiptOrder: Array<{ owner: string; id: string; scope: string }> = [];
  private saved = new Map<string, string | null>();
  private unsaved = new Set<string>();
  private busy = new Set<string>();
  /** rows saved as not confirmed while they are shown as they were (unconfirm) */
  private unconfirmed = new Set<string>();
  /** the recovery record kept for a row this page alone holds (keepUnconfirmed), by owner and row */
  private recovery = new Map<string, string>();
  private listeners = new Set<() => void>();
  /** rows moved off an owner (move), by id: the server lists them under the pane's new ID now */
  private movedAway = new Map<string, Set<string>>();
  /** rows a move left while this page had their send on its way, with the ID they go to once it ends */
  private afterSend = new Map<string, string>();
  // the pane's herdr's storage, or this page's memory (lib/paneLifetime.ts)
  constructor(
    private storage: () => StoragePort = () => paneLifetimes.paneStorage,
    private lifetimes: Pick<PaneLifetimes, "stored" | "keep" | "discard"> = paneLifetimes,
  ) {}
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private notify(): void {
    for (const listener of this.listeners) listener();
    this.scheduleExpiry();
  }
  private expiry: ReturnType<typeof setTimeout> | undefined;
  /** One timer, to the end of the first page-only proof: its copy is uncertain again then (read also checks, for a tab that slept). */
  private scheduleExpiry(): void {
    if (this.expiry !== undefined) clearTimeout(this.expiry);
    this.expiry = undefined;
    let first = Infinity;
    // a copy being sent ends with its send (end() tells the page, and this runs again)
    for (const [owner, rows] of this.rows) for (const message of rows) {
      if (message.heldUntil !== undefined && message.state === "held" && !this.isBusy(owner, message.id)) first = Math.min(first, message.heldUntil);
    }
    if (first === Infinity) return;
    this.expiry = setTimeout(() => {
      this.expiry = undefined;
      for (const owner of [...this.rows.keys()]) this.read(owner);
      this.notify();
    }, Math.max(0, first - Date.now()));
  }
  /** a page-only held copy whose proof has ended is uncertain again (saved, it already is); one being sent ends with its send */
  private dropExpired(owner: string, rows: PendingMessageView[]): PendingMessageView[] {
    const ended = (message: PendingMessageView): boolean => message.state === "held" && message.heldUntil !== undefined
      && !freshReceipt(message.heldUntil) && !this.isBusy(owner, message.id);
    if (!rows.some(ended)) return rows;
    // the ended time stays on the row: a late held answer for it is not a proof again
    const next = rows.map((message) => ended(message) ? { ...message, state: "uncertain" as const } : message);
    this.rows.set(owner, next);
    // a read during a render or a press must not tell the page synchronously: the next turn does
    queueMicrotask(() => this.notify());
    return next;
  }
  isUnsaved(owner: string): boolean { return this.unsaved.has(owner); }
  isOwned(owner: string, id: string, scope: string | null): boolean { return scope !== null && this.scopes.get(owner)?.get(id) === scope; }
  isBusy(owner: string, id: string): boolean { return this.busy.has(`${owner}\0${id}`); }
  /** `saved`: the rows as saved (a held one held); otherwise as shown: a saved copy has no proof, so held is uncertain */
  private restored(raw: string | null, saved = false): PendingMessageView[] {
    try {
      const data: unknown = JSON.parse(raw ?? "null");
      if (!data || typeof data !== "object" || !("messages" in data) || !Array.isArray(data.messages)) return [];
      const ids = new Set<string>();
      return data.messages.flatMap((item: unknown) => {
        if (!item || typeof item !== "object") return [];
        const message = item as PendingMessage & { resendInFlight?: unknown; resendGeneration?: unknown; heldByRequest?: unknown };
        if (typeof message.id !== "string" || !message.id || ids.has(message.id) || typeof message.text !== "string" || typeof message.created_at !== "string"
          || !Number.isSafeInteger(message.request_id) || !["queued", "sending", "held", "uncertain"].includes(message.state)) return [];
        ids.add(message.id);
        const error = message.error && typeof message.error.code === "string" && typeof message.error.message === "string" ? message.error : undefined;
        const restoredError = error?.code === "pi_transcript_pending"
          ? { code: "transcript_unconfirmed", message: "The bridge connection ended before Pi's transcript append was confirmed" } : error;
        // a hold its sender asked for is held on its saved copy's word, as before; any other needs a receipt.
        // A copy an older release saved has no mark: held with no reason, it is one too (requestedHold)
        const heldByRequest = message.heldByRequest === true || (message.state === "held" && error === undefined);
        return [{ id: message.id, request_id: message.request_id, text: message.text, created_at: message.created_at,
          state: (saved || heldByRequest) && message.state === "held" && message.resendInFlight !== true ? "held" as const : "uncertain" as const,
          ...(heldByRequest ? { heldByRequest: true as const } : {}),
          ...(typeof message.resendGeneration === "number" && Number.isSafeInteger(message.resendGeneration) && message.resendGeneration >= 0 ? { resendGeneration: message.resendGeneration } : {}),
          ...(message.resendInFlight === true ? { resendInFlight: true as const } : {}), ...(restoredError ? { error: restoredError } : {}),
          ...(message.agent_only === true ? { agent_only: true as const } : {}), serverOwned: false }];
      });
    } catch { return []; }
  }
  private canHoldResumed(owner: string, message: PendingMessageView): boolean {
    return !message.serverOwned && this.scopes.get(owner)?.get(message.id) === undefined
      && !piReceipt(message) && !message.resendInFlight && !this.unconfirmed.has(`${owner}\0${message.id}`);
  }
  /** A resumed held ID applies once, to the copy saved when it came: a later send of that copy (another tab's too) is never held again. */
  private applyHeldResumed(owner: string, message: PendingMessageView): PendingMessageView {
    const receipt = this.heldResumed.get(owner)?.get(message.id);
    this.heldResumed.get(owner)?.delete(message.id);
    const at = receipt?.until;
    if (receipt === undefined || !freshReceipt(at) || !this.canHoldResumed(owner, message)) return message;
    // a later receipt that ends sooner (a first frame that came late) shortens the proof, never lengthens it
    if (message.state === "held") return message.heldUntil !== undefined && at < message.heldUntil ? { ...message, heldUntil: at, heldBy: receipt.scope } : message;
    const { sending_at: _, ...rest } = message;
    return { ...rest, state: "held", heldUntil: at, heldBy: receipt.scope };
  }
  read(owner: string): PendingMessageView[] {
    const cached = this.rows.get(owner);
    if (cached) return this.dropExpired(owner, cached);
    let raw: string | null = null;
    try { raw = this.storage().getItem(PREFIX + owner); } catch { /* keep a memory-only copy */ }
    const restored = this.restored(raw);
    const messages = restored.map((message) => this.applyHeldResumed(owner, message));
    this.saved.set(owner, raw);
    this.rows.set(owner, messages);
    // a copy held again is saved so: its ID applied once
    if (messages.some((message, at) => message !== restored[at])) this.write(owner, messages);
    return messages;
  }
  refresh(owner: string): void {
    try {
      const raw = this.storage().getItem(PREFIX + owner);
      if (this.saved.get(owner) === raw) return;
      const loaded = this.restored(raw).filter((message) => !this.settledResumed.get(owner)?.has(message.id))
        .map((message) => message.state === "held" && this.discarded.get(owner)?.has(message.id) ? { ...message, state: "uncertain" as const } : message);
      // this page's receipt proof stays with its copy while another tab saves the list (saved, it is uncertain)
      // only while the saved copy is the one this page wrote: another tab that acted on it (sent it, an error) ends the proof
      const savedStates = new Map<string, unknown>();
      try {
        const data: unknown = JSON.parse(raw ?? "null");
        if (data && typeof data === "object" && "messages" in data && Array.isArray(data.messages)) {
          for (const item of data.messages as Array<{ id?: unknown; state?: unknown }>) if (typeof item?.id === "string") savedStates.set(item.id, item.state);
        }
      } catch { /* nothing saved proves this page's copy */ }
      const proven = new Map((this.rows.get(owner) ?? []).filter((message) => message.state === "held" && freshReceipt(message.heldUntil))
        .map((message) => [message.id, { text: message.text, until: message.heldUntil!, by: message.heldBy, error: message.error?.code }]));
      // A tab still on a bundle that predates the mark saves the list without it (it drops fields it does not know),
      // so a requested hold it refused once would read here as a hold of the bridge's own. This page knows better
      // from its own row of the same ID and text: the mark is kept, and with it the state as that tab saved it.
      const mine = new Map((this.rows.get(owner) ?? []).filter((message) => message.heldByRequest === true).map((message) => [message.id, message.text]));
      const next = loaded.map((loadedMessage) => {
        const message = loadedMessage.heldByRequest !== true && mine.get(loadedMessage.id) === loadedMessage.text
          ? { ...loadedMessage, heldByRequest: true as const,
            state: savedStates.get(loadedMessage.id) === "held" && !loadedMessage.resendInFlight && !this.discarded.get(owner)?.has(loadedMessage.id) ? "held" as const : loadedMessage.state }
          : loadedMessage;
        // a hold its sender asked for is held as it is saved: it takes no receipt's end
        if (message.heldByRequest === true && message.state === "held") return message;
        const kept = proven.get(message.id);
        return kept?.text === message.text && ["uncertain", "held"].includes(String(savedStates.get(message.id))) && !message.resendInFlight && message.error?.code === kept.error
          ? { ...message, state: "held" as const, heldUntil: kept.until, ...(kept.by !== undefined ? { heldBy: kept.by } : {}) } : this.applyHeldResumed(owner, message);
      });
      const heldAgain = next.some((message, at) => message !== loaded[at]);
      // Another tab cannot alter or discard a live connection's authoritative rows.
      for (const own of this.read(owner).filter((message) => this.unsaved.has(owner) || message.serverOwned || this.isBusy(owner, message.id))) {
        const at = next.findIndex((message) => message.id === own.id);
        if (at < 0) next.push(own);
        else if ((next[at]!.resendGeneration ?? 0) > (own.resendGeneration ?? 0)) {
          const { resendInFlight: _, ...previous } = own;
          next[at] = { ...previous, resendGeneration: next[at]!.resendGeneration, state: next[at]!.state,
            ...(next[at]!.resendInFlight ? { resendInFlight: true } : {}) };
        } else next[at] = next[at]?.resendInFlight
          ? { ...own, resendGeneration: next[at]!.resendGeneration ?? own.resendGeneration, resendInFlight: true,
            state: this.unconfirmed.has(`${owner}\0${own.id}`) ? own.state : "uncertain" } : own;
      }
      if (heldAgain) { this.write(owner, next); return; }
      this.saved.set(owner, raw);
      this.rows.set(owner, next);
      this.notify();
    } catch { /* retain text when storage is unavailable */ }
  }
  private write(owner: string, messages: PendingMessageView[]): void {
    this.rows.set(owner, messages);
    try {
      const raw = messages.length ? JSON.stringify({ version: 1, messages: messages.map(({ serverOwned: _, heldUntil, heldBy: _by, ...message }) =>
        this.unconfirmed.has(`${owner}\0${message.id}`) || message.resendInFlight
          ? { ...message, state: "uncertain", resendInFlight: true }
          // a receipt's proof is this page's alone: saved, the copy waits for the next one
          : heldUntil !== undefined && message.state === "held" ? { ...message, state: "uncertain" } : message) }) : null;
      if (raw === null) this.storage().removeItem(PREFIX + owner); else this.storage().setItem(PREFIX + owner, raw);
      this.saved.set(owner, raw);
      this.unsaved.delete(owner);
      this.settleRecovery(owner, messages);
    } catch { this.unsaved.add(owner); }
    this.notify();
  }
  /**
   * Rows this page alone held (keepUnconfirmed), now saved where a reload reads them: their
   * recovery copies go, or the text would be offered twice. Not while the PC's state is in this
   * page's memory, which a reload does not keep; another row's or tab's copy is never touched.
   */
  private settleRecovery(owner: string, messages: readonly PendingMessageView[]): void {
    if (this.recovery.size === 0) return;
    const pane = paneStateKey(PREFIX + owner);
    if (pane === null || !this.lifetimes.stored(pane.machineId)) return;
    for (const message of messages) {
      const kept = this.recovery.get(`${owner}\0${message.id}`);
      if (kept === undefined) continue;
      this.recovery.delete(`${owner}\0${message.id}`);
      this.lifetimes.discard(kept, 0);
    }
  }
  accept(owner: string, message: PendingMessage, scope: string | null): void {
    if (this.movedAway.get(owner)?.has(message.id)) return;
    const seen = this.removed.get(owner)?.get(message.id);
    if (this.settledResumed.get(owner)?.has(message.id) || (scope === null ? (seen?.size ?? 0) > 0 : seen?.has(scope))) return;
    if (scope !== null || message.state === "uncertain") this.heldResumed.get(owner)?.delete(message.id);
    this.refresh(owner);
    const proofs = this.scopes.get(owner) ?? new Map<string, string>();
    this.scopes.set(owner, proofs);
    if (scope === null) proofs.delete(message.id); else proofs.set(message.id, scope);
    const previous = this.read(owner);
    const resendInFlight = previous.find((item) => item.id === message.id)?.resendInFlight;
    const resendGeneration = previous.find((item) => item.id === message.id)?.resendGeneration;
    // once the bridge told it so, for as long as the copy lives: a refused Send now gives it a reason, not another kind
    const heldByRequest = previous.find((item) => item.id === message.id)?.heldByRequest === true || requestedHold(message);
    const receipt = this.heldResumed.get(owner)?.get(message.id);
    const heldByReceipt = !heldByRequest && scope === null && !resendInFlight && !this.unconfirmed.has(`${owner}\0${message.id}`)
      && !piReceipt(message) && freshReceipt(receipt?.until);
    const prior = previous.find((item) => item.id === message.id)?.heldUntil;
    const priorBy = previous.find((item) => item.id === message.id)?.heldBy;
    const view: PendingMessageView = { ...message, serverOwned: scope !== null,
      ...(heldByRequest ? { heldByRequest: true as const } : {}),
      ...(resendInFlight ? { resendInFlight } : {}),
      ...(resendGeneration !== undefined ? { resendGeneration } : {}),
      state: resendInFlight ? "uncertain" : heldByReceipt ? "held"
        : scope === null && (message.state === "queued" || message.state === "sending"
          || message.state === "held" && this.discarded.get(owner)?.has(message.id) === true) ? "uncertain" : message.state };
    if (heldByReceipt) { delete view.sending_at; view.heldUntil = receipt!.until; view.heldBy = receipt!.scope; this.heldResumed.get(owner)?.delete(message.id); }
    // a late held answer for a copy this page holds on a receipt keeps that proof this page's alone
    // (and once its proof has ended, the copy is uncertain)
    // a held answer with no connection left to prove it holds only on a live receipt: otherwise it is uncertain
    // (a hold its sender asked for stays held: nothing sends it but its Send now)
    else if (scope === null && view.state === "held" && !heldByRequest) {
      if (freshReceipt(prior)) { view.heldUntil = prior; if (priorBy !== undefined) view.heldBy = priorBy; } else view.state = "uncertain";
    }
    const at = previous.findIndex((item) => item.id === message.id);
    const next = [...previous];
    if (at < 0) next.push(view); else next[at] = view;
    this.write(owner, next);
  }
  publish(owner: string, messages: PendingMessage[], removed: Removal[], scope: string): void {
    for (const message of messages) this.accept(owner, message, scope);
    const proofs = this.scopes.get(owner);
    // a receipt settles a row this connection proves. A create request's first message (request_id < 0, no
    // connection's own) is the bridge's, told to every connection: its receipt also settles the copy kept since
    // a dropped connection (suspend), which no connection proves any more
    this.refresh(owner);
    const unproved = new Set(this.read(owner).filter((message) => message.request_id < 0 && !message.serverOwned && proofs?.get(message.id) === undefined).map((message) => message.id));
    // A consumed Pi ID is an exact server-attested receipt, replayed only to the same
    // browser/device on attach. It can settle a saved non-authoritative copy across
    // connection epochs; text, request IDs, and empty snapshots never can. A `resumed` sent or discarded
    // receipt is the same for any follow-up's saved copy (#2421).
    const saved = (message: PendingMessage & { serverOwned: boolean }): boolean => !message.serverOwned && proofs?.get(message.id) === undefined;
    const resumed = new Set(this.read(owner).filter((message) => piReceipt(message) && saved(message)).map((message) => message.id));
    const copies = new Set(this.read(owner).filter(saved).map((message) => message.id));
    const terminal = removed.filter((item) => item.outcome !== "held");
    const deleted = new Set(terminal.filter((item) => proofs?.get(item.id) === scope || unproved.has(item.id)
      || item.outcome === "consumed" && resumed.has(item.id) || item.resumed === true && copies.has(item.id)).map((item) => item.id));
    // A resumed receipt is remembered even before its copy is saved (another tab may save it later), but
    // never for a row a live connection here proves under another scope.
    for (const item of terminal) {
      this.heldResumed.get(owner)?.delete(item.id);
      if (item.outcome === "consumed" && deleted.has(item.id) && item.id.startsWith("pi:")
        || item.resumed === true && (proofs?.get(item.id) === undefined || proofs.get(item.id) === scope)) {
        const settled = this.settledResumed.get(owner) ?? new Set<string>();
        settled.add(item.id);
        if (settled.size > 1024) settled.delete(settled.values().next().value!);
        this.settledResumed.set(owner, settled);
      }
    }
    for (const item of removed) if (item.outcome === "held" && item.resumed === true
      && !this.settledResumed.get(owner)?.has(item.id) && !this.discarded.get(owner)?.has(item.id)
      && (proofs?.get(item.id) === undefined || proofs.get(item.id) === scope)) {
      const held = this.heldResumed.get(owner) ?? new Map<string, { until: number; scope: string }>();
      // until the bridge's receipt ends: never longer than its window, whatever a frame says; and for as long as
      // the connection that brought it lives
      held.set(item.id, { until: Math.min(item.until, Date.now() + HELD_RECEIPT_MS), scope });
      if (held.size > 1024) held.delete(held.keys().next().value!);
      this.heldResumed.set(owner, held);
    }
    const receipts = this.removed.get(owner) ?? new Map<string, Set<string>>();
    this.removed.set(owner, receipts);
    for (const item of terminal) {
      const seen = receipts.get(item.id) ?? new Set<string>();
      if (!seen.has(scope)) {
        seen.add(scope); receipts.set(item.id, seen);
        this.receiptOrder.push({ owner, id: item.id, scope });
      }
    }
    while (this.receiptOrder.length > 1024) {
      const oldest = this.receiptOrder.shift()!;
      const ownerReceipts = this.removed.get(oldest.owner), seen = ownerReceipts?.get(oldest.id);
      seen?.delete(oldest.scope);
      if (seen?.size === 0) ownerReceipts?.delete(oldest.id);
      if (ownerReceipts?.size === 0) this.removed.delete(oldest.owner);
    }
    // An empty new-connection snapshot is not evidence that saved text was delivered.
    const heldIds = this.heldResumed.get(owner);
    const heldChanged = heldIds !== undefined && this.read(owner).some((message) => !deleted.has(message.id) && heldIds.has(message.id));
    if (deleted.size || heldChanged) {
      // another tab may have saved a message since this one last read the list: the write below keeps it
      this.refresh(owner);
      for (const id of deleted) proofs?.delete(id);
      if (proofs?.size === 0) this.scopes.delete(owner);
      this.write(owner, this.read(owner).filter((message) => !deleted.has(message.id))
        .map((message) => this.applyHeldResumed(owner, message)));
    }
  }
  suspend(owner: string, scope: string): void {
    this.refresh(owner);
    const proofs = this.scopes.get(owner);
    let changed = false;
    // a connection ended: every receipt it brought ends with it, and only a receipt on the next connection proves
    // a copy again. Another PC's connection that still lives keeps the proofs it brought (a page holds several PCs)
    this.forgetReceipts(owner, scope);
    const next = this.read(owner).map((message) => {
      if (message.heldUntil !== undefined && (message.heldBy === undefined || message.heldBy === scope) && proofs?.get(message.id) === undefined) {
        changed = true;
        const { heldUntil: _, heldBy: _by, ...rest } = message;
        return rest.state === "held" ? { ...rest, state: "uncertain" as const } : rest;
      }
      if (proofs?.get(message.id) !== scope) return message;
      proofs.delete(message.id);
      changed = true;
      return message.error?.code === "pi_transcript_pending"
        ? { ...message, serverOwned: false, state: "uncertain" as const, error: { code: "transcript_unconfirmed", message: "The connection ended before Pi's transcript append was confirmed" } }
        // held only while a connection proved it: past that, a receipt must prove it again. A hold its sender
        // asked for stays held: the bridge never sends it by itself, so only an ambiguous Send now makes it uncertain
        : { ...message, serverOwned: false, state: message.heldByRequest && message.state === "held" && !message.resendInFlight ? "held" as const : "uncertain" as const };
    });
    if (proofs?.size === 0) this.scopes.delete(owner);
    if (changed) this.write(owner, next);
  }
  /**
   * Another herdr took the PC's pane IDs: the copies kept here go (their saved text went to
   * recovery), and only rows a live connection proves stay until the bridge settles them.
   */
  forget(machineId: string): void {
    for (const [owner, rows] of [...this.rows]) {
      const pane = paneStateKey(PREFIX + owner);
      if (pane?.machineId !== machineId) continue;
      const kept = rows.filter((message) => message.serverOwned);
      if (this.unsaved.has(owner)) for (const message of rows) if (!message.serverOwned) this.lifetimes.keep(machineId, pane.paneId, "pending", message.text, false, message.agent_only === true);
      // a row storage took on the same herdr (lib/paneLifetime.ts storeMemory) is offered again after a
      // reload, so its recovery copy goes; a row left to recovery has only its record now
      let durable = new Set<string>();
      try { durable = new Set(this.restored(this.storage().getItem(PREFIX + owner)).map((message) => message.id)); } catch { /* none is */ }
      for (const [key, record] of [...this.recovery]) {
        if (!key.startsWith(`${owner}\0`)) continue;
        this.recovery.delete(key);
        if (durable.has(key.slice(owner.length + 1))) this.lifetimes.discard(record, 0);
      }
      if (kept.length > 0) this.rows.set(owner, kept); else this.rows.delete(owner);
      this.saved.delete(owner);
      this.unsaved.delete(owner);
      this.heldResumed.delete(owner);
      this.discarded.delete(owner);
    }
    this.notify();
  }
  /**
   * herdr moved the pane under a new ID (#1503): its rows go there as they are (the server holds its own for an
   * explicit send and lists them under the new ID), with the proof of the connection that has them; one settled
   * there already does not come back. A row whose send this page has on its way follows once that send ends
   * (`end`), as its answer looks for it under the old ID. `only`: that row alone.
   */
  move(from: string, to: string, only?: string): void {
    if (from === to) return;
    this.refresh(from);
    this.refresh(to);
    const rows = this.read(from).filter((message) => only === undefined || message.id === only);
    // rows still waiting on a send under an earlier ID that moved here go on to the new one
    for (const [key, next] of this.afterSend) if (next === from) this.afterSend.set(key, to);
    for (const message of rows) if (this.isBusy(from, message.id)) this.afterSend.set(`${from}\0${message.id}`, to);
    const moving = rows.filter((message) => !this.isBusy(from, message.id));
    if (moving.length === 0) return;
    const target = this.read(to);
    const have = new Set(target.map((message) => message.id));
    const fromProofs = this.scopes.get(from), toProofs = this.scopes.get(to) ?? new Map<string, string>();
    // settled there as publish settles a row: an exact resumed receipt, or a receipt of the connection that proves it
    const settled = (id: string): boolean => {
      const proof = fromProofs?.get(id);
      return this.settledResumed.get(to)?.has(id) === true || (proof !== undefined && this.removed.get(to)?.get(id)?.has(proof) === true);
    };
    const carried = moving.filter((message) => !have.has(message.id) && !settled(message.id));
    const carriedIds = new Set(carried.map((message) => message.id));
    const away = this.movedAway.get(from) ?? new Set<string>();
    // moved back to an ID it left before: the server's lists there count for it again
    const back = this.movedAway.get(to);
    for (const message of moving) back?.delete(message.id);
    if (back?.size === 0) this.movedAway.delete(to);
    for (const message of moving) {
      // the server's lists under the old ID, told before or as it moved the row, bring none back here
      away.add(message.id);
      const proof = fromProofs?.get(message.id);
      fromProofs?.delete(message.id);
      if (proof !== undefined && carriedIds.has(message.id) && !toProofs.has(message.id)) toProofs.set(message.id, proof);
      const kept = this.recovery.get(`${from}\0${message.id}`);
      if (kept === undefined) continue;
      this.recovery.delete(`${from}\0${message.id}`);
      if (carriedIds.has(message.id)) this.recovery.set(`${to}\0${message.id}`, kept); else this.lifetimes.discard(kept, 0);
    }
    while (away.size > 1024) away.delete(away.values().next().value!);
    this.movedAway.set(from, away);
    if (fromProofs?.size === 0) this.scopes.delete(from);
    if (toProofs.size > 0) this.scopes.set(to, toProofs);
    const gone = new Set(moving.map((message) => message.id));
    this.write(to, [...target, ...carried]);
    this.write(from, this.read(from).filter((message) => !gone.has(message.id)));
  }
  /** the held IDs remembered for `owner` that the connection `scope` brought end with it */
  private forgetReceipts(owner: string, scope: string): void {
    const remembered = this.heldResumed.get(owner);
    if (remembered === undefined) return;
    for (const [id, receipt] of remembered) if (receipt.scope === scope) remembered.delete(id);
    if (remembered.size === 0) this.heldResumed.delete(owner);
  }
  suspendScope(scope: string): void {
    // remembered held IDs of owners not read yet end too
    for (const owner of [...this.heldResumed.keys()]) if (!this.rows.has(owner)) this.forgetReceipts(owner, scope);
    for (const owner of this.rows.keys()) this.suspend(owner, scope);
  }
  begin(owner: string, id: string): boolean {
    if (this.isBusy(owner, id) || !this.read(owner).some((message) => message.id === id)) return false;
    this.busy.add(`${owner}\0${id}`);
    this.rows.set(owner, [...this.read(owner)]);
    this.notify();
    return true;
  }
  /**
   * Saves a row as not confirmed while what is shown stays as it is. A held copy sent again is
   * a stable-ID resend: a reload before its answer must not offer it once more.
   * false: the mark could not be saved over a copy still saved as held, so the send must not start.
   */
  unconfirm(owner: string, id: string): boolean {
    try {
      const saved = this.restored(this.storage().getItem(PREFIX + owner)).find((message) => message.id === id);
      if (saved?.resendInFlight && !this.unconfirmed.has(`${owner}\0${id}`)) return false;
    } catch { this.unsaved.add(owner); this.notify(); return false; }
    // another tab may have saved a message since this one last read the list
    this.refresh(owner);
    this.heldResumed.get(owner)?.delete(id);
    // every write until the answer keeps the mark, also one made for another row
    this.unconfirmed.add(`${owner}\0${id}`);
    this.write(owner, this.read(owner));
    if (!this.unsaved.has(owner)) return true;
    // with nothing saved (storage that never worked) there is no copy a reload could offer again
    try { return !this.restored(this.storage().getItem(PREFIX + owner), true).some((message) => message.id === id && message.state === "held"); } catch { return false; }
  }
  end(owner: string, id: string): void {
    this.unconfirmed.delete(`${owner}\0${id}`);
    this.busy.delete(`${owner}\0${id}`);
    this.rows.set(owner, [...this.read(owner)]);
    this.notify();
    // its pane moved while the send was on its way: the row follows now
    const to = this.afterSend.get(`${owner}\0${id}`);
    if (to === undefined) return;
    this.afterSend.delete(`${owner}\0${id}`);
    this.move(owner, to, id);
  }
  fail(owner: string, id: string, error: { code: string; message: string }, uncertain: boolean, attemptedGeneration?: number): void {
    this.unconfirmed.delete(`${owner}\0${id}`);
    if (uncertain) this.heldResumed.get(owner)?.delete(id);
    // another tab's rows and marks as they are saved now: this write is the whole list
    this.refresh(owner);
    this.write(owner, this.read(owner).map((message) => {
      if (message.id !== id) return message;
      if (attemptedGeneration !== undefined && (message.resendGeneration ?? 0) > attemptedGeneration) return message;
      const { resendInFlight: _, heldUntil, heldBy, ...settled } = message;
      // a saved copy refused with nothing typed is held again only while its receipt's proof lasts: after a
      // disconnect ended that proof, the refusal leaves it uncertain until a receipt proves it again.
      // One its sender held on purpose needs no proof: the refusal typed nothing, so it is held as it was
      const proven = !uncertain && !message.serverOwned && (message.heldByRequest === true || freshReceipt(heldUntil));
      return { ...settled, error,
        ...(uncertain ? { resendInFlight: true as const } : {}),
        ...(proven && heldUntil !== undefined ? { heldUntil, ...(heldBy !== undefined ? { heldBy } : {}) } : {}),
        ...(attemptedGeneration !== undefined ? { resendGeneration: uncertain ? attemptedGeneration : attemptedGeneration + 1 } : {}),
        state: uncertain ? "uncertain" : message.serverOwned ? (attemptedGeneration !== undefined ? "held" : message.state) : proven ? "held" : "uncertain" };
    }));
  }
  /**
   * Keeps a message an older bridge took with no receipt as a row not confirmed: it may or may not
   * have reached the pane, so its text stays to copy or discard and is never sent again from here.
   */
  keepUnconfirmed(owner: string, text: string): void {
    const id = `unconfirmed:${[...crypto.getRandomValues(new Uint32Array(2))].map((part) => part.toString(36)).join("-")}`;
    this.refresh(owner);
    this.write(owner, [...this.read(owner), { id, request_id: 0, text, created_at: new Date().toISOString(), state: "uncertain", error: UNCONFIRMED_SEND, serverOwned: false }]);
    // a PC whose pane state is not stored (a bridge that names no herdr, storage that refused its
    // record, a tab behind another), or storage that refused the row, keeps it in this page alone,
    // and the message box is already empty: a copy in Recover unsent text outlives a reload, until a
    // later write saves the row (settleRecovery). It is
    // offered for a pane the user picks, never put back under this pane ID, which a later herdr may
    // reuse (#2172). The row's own record: discarding the row takes no other tab's copy of the same words
    const pane = paneStateKey(PREFIX + owner);
    if (pane === null || this.lifetimes.stored(pane.machineId) && !this.unsaved.has(owner)) return;
    const kept = this.lifetimes.keep(pane.machineId, pane.paneId, "pending", text, true);
    if (kept !== null) this.recovery.set(`${owner}\0${id}`, kept);
  }
  removeCopy(owner: string, id: string): void {
    if (this.read(owner).some((message) => message.id === id && message.serverOwned)) return;
    this.scopes.get(owner)?.delete(id);
    this.heldResumed.get(owner)?.delete(id);
    const discarded = this.discarded.get(owner) ?? new Set<string>();
    discarded.add(id);
    if (discarded.size > 1024) discarded.delete(discarded.values().next().value!);
    this.discarded.set(owner, discarded);
    this.unconfirmed.delete(`${owner}\0${id}`);
    this.refresh(owner);
    this.write(owner, this.read(owner).filter((message) => message.id !== id));
    // its recovery copy goes with it
    const kept = this.recovery.get(`${owner}\0${id}`);
    if (kept === undefined) return;
    this.recovery.delete(`${owner}\0${id}`);
    this.lifetimes.discard(kept, 0);
  }
}

export const pendingMessages = new PendingMessageStore();
paneLifetimes.onRetire((machineId) => pendingMessages.forget(machineId));
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key?.startsWith(PREFIX)) pendingMessages.refresh(event.key.slice(PREFIX.length));
});
