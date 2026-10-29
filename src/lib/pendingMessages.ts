import type { PendingMessage } from "../../shared/protocol.ts";
import { paneLifetimes, paneStateKey, type PaneLifetimes } from "./paneLifetime.ts";

export interface PendingMessageView extends PendingMessage { serverOwned: boolean; resendInFlight?: true; resendGeneration?: number }
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Removal = { id: string; outcome: "sent" | "discarded" | "consumed" | "dismissed" };
const PREFIX = "ovis:pending:";
const piReceipt = (message: PendingMessage): boolean => message.id.startsWith("pi:")
  && (message.error?.code === "pi_transcript_pending" || message.error?.code === "transcript_unconfirmed");

/** A row's error for a message an older bridge took with no receipt (SubmitResult `unconfirmed`). */
export const UNCONFIRMED_SEND = { code: "submit_unconfirmed", message: "This PC sent no receipt, so nothing confirmed the pane took this message" };

/** Connection proof stays in memory. A saved copy can never resume automatic delivery. */
export class PendingMessageStore {
  private rows = new Map<string, PendingMessageView[]>();
  private scopes = new Map<string, Map<string, string>>();
  private removed = new Map<string, Map<string, Set<string>>>();
  private settledPi = new Map<string, Set<string>>();
  private receiptOrder: Array<{ owner: string; id: string; scope: string }> = [];
  private saved = new Map<string, string | null>();
  private unsaved = new Set<string>();
  private busy = new Set<string>();
  /** rows saved as not confirmed while they are shown as they were (unconfirm) */
  private unconfirmed = new Set<string>();
  /** the recovery record kept for a row this page alone holds (keepUnconfirmed), by owner and row */
  private recovery = new Map<string, string>();
  private listeners = new Set<() => void>();
  // the pane's herdr's storage, or this page's memory (lib/paneLifetime.ts)
  constructor(
    private storage: () => StoragePort = () => paneLifetimes.paneStorage,
    private lifetimes: Pick<PaneLifetimes, "stored" | "keep" | "discard"> = paneLifetimes,
  ) {}
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private notify(): void { for (const listener of this.listeners) listener(); }
  isUnsaved(owner: string): boolean { return this.unsaved.has(owner); }
  isOwned(owner: string, id: string, scope: string | null): boolean { return scope !== null && this.scopes.get(owner)?.get(id) === scope; }
  isBusy(owner: string, id: string): boolean { return this.busy.has(`${owner}\0${id}`); }
  private restored(raw: string | null): PendingMessageView[] {
    try {
      const data: unknown = JSON.parse(raw ?? "null");
      if (!data || typeof data !== "object" || !("messages" in data) || !Array.isArray(data.messages)) return [];
      const ids = new Set<string>();
      return data.messages.flatMap((item: unknown) => {
        if (!item || typeof item !== "object") return [];
        const message = item as PendingMessage & { resendInFlight?: unknown; resendGeneration?: unknown };
        if (typeof message.id !== "string" || !message.id || ids.has(message.id) || typeof message.text !== "string" || typeof message.created_at !== "string"
          || !Number.isSafeInteger(message.request_id) || !["queued", "sending", "held", "uncertain"].includes(message.state)) return [];
        ids.add(message.id);
        const error = message.error && typeof message.error.code === "string" && typeof message.error.message === "string" ? message.error : undefined;
        const restoredError = error?.code === "pi_transcript_pending"
          ? { code: "transcript_unconfirmed", message: "The bridge connection ended before Pi's transcript append was confirmed" } : error;
        return [{ id: message.id, request_id: message.request_id, text: message.text, created_at: message.created_at,
          state: message.state === "held" && message.resendInFlight !== true ? "held" as const : "uncertain" as const,
          ...(typeof message.resendGeneration === "number" && Number.isSafeInteger(message.resendGeneration) && message.resendGeneration >= 0 ? { resendGeneration: message.resendGeneration } : {}),
          ...(message.resendInFlight === true ? { resendInFlight: true as const } : {}), ...(restoredError ? { error: restoredError } : {}),
          ...(message.agent_only === true ? { agent_only: true as const } : {}), serverOwned: false }];
      });
    } catch { return []; }
  }
  read(owner: string): PendingMessageView[] {
    const cached = this.rows.get(owner);
    if (cached) return cached;
    let raw: string | null = null;
    try { raw = this.storage().getItem(PREFIX + owner); } catch { /* keep a memory-only copy */ }
    const messages = this.restored(raw);
    this.saved.set(owner, raw);
    this.rows.set(owner, messages);
    return messages;
  }
  refresh(owner: string): void {
    try {
      const raw = this.storage().getItem(PREFIX + owner);
      if (this.saved.get(owner) === raw) return;
      const next = this.restored(raw).filter((message) => !piReceipt(message) || !this.settledPi.get(owner)?.has(message.id));
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
      this.saved.set(owner, raw);
      this.rows.set(owner, next);
      this.notify();
    } catch { /* retain text when storage is unavailable */ }
  }
  private write(owner: string, messages: PendingMessageView[]): void {
    this.rows.set(owner, messages);
    try {
      const raw = messages.length ? JSON.stringify({ version: 1, messages: messages.map(({ serverOwned: _, ...message }) =>
        this.unconfirmed.has(`${owner}\0${message.id}`) || message.resendInFlight
          ? { ...message, state: "uncertain", resendInFlight: true } : message) }) : null;
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
      this.lifetimes.discard(kept);
    }
  }
  accept(owner: string, message: PendingMessage, scope: string | null): void {
    const seen = this.removed.get(owner)?.get(message.id);
    if (piReceipt(message) && this.settledPi.get(owner)?.has(message.id) || (scope === null ? (seen?.size ?? 0) > 0 : seen?.has(scope))) return;
    this.refresh(owner);
    const proofs = this.scopes.get(owner) ?? new Map<string, string>();
    this.scopes.set(owner, proofs);
    if (scope === null) proofs.delete(message.id); else proofs.set(message.id, scope);
    const previous = this.read(owner);
    const resendInFlight = previous.find((item) => item.id === message.id)?.resendInFlight;
    const resendGeneration = previous.find((item) => item.id === message.id)?.resendGeneration;
    const view: PendingMessageView = { ...message, serverOwned: scope !== null,
      ...(resendInFlight ? { resendInFlight } : {}),
      ...(resendGeneration !== undefined ? { resendGeneration } : {}),
      state: resendInFlight || scope === null && (message.state === "queued" || message.state === "sending") ? "uncertain" : message.state };
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
    // connection epochs; text, request IDs, and empty snapshots never can.
    const resumed = new Set(this.read(owner).filter((message) => piReceipt(message) && !message.serverOwned && proofs?.get(message.id) === undefined).map((message) => message.id));
    const deleted = new Set(removed.filter((item) => proofs?.get(item.id) === scope || unproved.has(item.id)
      || item.outcome === "consumed" && resumed.has(item.id)).map((item) => item.id));
    for (const item of removed) if (item.outcome === "consumed" && deleted.has(item.id) && item.id.startsWith("pi:")) {
      const settled = this.settledPi.get(owner) ?? new Set<string>();
      settled.add(item.id);
      if (settled.size > 1024) settled.delete(settled.values().next().value!);
      this.settledPi.set(owner, settled);
    }
    const receipts = this.removed.get(owner) ?? new Map<string, Set<string>>();
    this.removed.set(owner, receipts);
    for (const item of removed) {
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
    if (deleted.size) {
      // another tab may have saved a message since this one last read the list: the write below keeps it
      this.refresh(owner);
      for (const id of deleted) proofs?.delete(id);
      if (proofs?.size === 0) this.scopes.delete(owner);
      this.write(owner, this.read(owner).filter((message) => !deleted.has(message.id)));
    }
  }
  suspend(owner: string, scope: string): void {
    this.refresh(owner);
    const proofs = this.scopes.get(owner);
    let changed = false;
    const next = this.read(owner).map((message) => {
      if (proofs?.get(message.id) !== scope) return message;
      proofs.delete(message.id);
      changed = true;
      return message.error?.code === "pi_transcript_pending"
        ? { ...message, serverOwned: false, state: "uncertain" as const, error: { code: "transcript_unconfirmed", message: "The connection ended before Pi's transcript append was confirmed" } }
        : { ...message, serverOwned: false, state: message.state === "held" && !message.resendInFlight ? "held" as const : "uncertain" as const };
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
      if (this.unsaved.has(owner)) for (const message of rows) if (!message.serverOwned) this.lifetimes.keep(machineId, pane.paneId, "pending", message.text);
      // a row storage took on the same herdr (lib/paneLifetime.ts storeMemory) is offered again after a
      // reload, so its recovery copy goes; a row left to recovery has only its record now
      let durable = new Set<string>();
      try { durable = new Set(this.restored(this.storage().getItem(PREFIX + owner)).map((message) => message.id)); } catch { /* none is */ }
      for (const [key, record] of [...this.recovery]) {
        if (!key.startsWith(`${owner}\0`)) continue;
        this.recovery.delete(key);
        if (durable.has(key.slice(owner.length + 1))) this.lifetimes.discard(record);
      }
      if (kept.length > 0) this.rows.set(owner, kept); else this.rows.delete(owner);
      this.saved.delete(owner);
      this.unsaved.delete(owner);
    }
    this.notify();
  }
  suspendScope(scope: string): void { for (const owner of this.rows.keys()) this.suspend(owner, scope); }
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
    // every write until the answer keeps the mark, also one made for another row
    this.unconfirmed.add(`${owner}\0${id}`);
    this.write(owner, this.read(owner));
    if (!this.unsaved.has(owner)) return true;
    // with nothing saved (storage that never worked) there is no copy a reload could offer again
    try { return !this.restored(this.storage().getItem(PREFIX + owner)).some((message) => message.id === id && message.state === "held"); } catch { return false; }
  }
  end(owner: string, id: string): void {
    this.unconfirmed.delete(`${owner}\0${id}`);
    this.busy.delete(`${owner}\0${id}`);
    this.rows.set(owner, [...this.read(owner)]);
    this.notify();
  }
  fail(owner: string, id: string, error: { code: string; message: string }, uncertain: boolean, attemptedGeneration?: number): void {
    this.unconfirmed.delete(`${owner}\0${id}`);
    // another tab's rows and marks as they are saved now: this write is the whole list
    this.refresh(owner);
    this.write(owner, this.read(owner).map((message) => {
      if (message.id !== id) return message;
      if (attemptedGeneration !== undefined && (message.resendGeneration ?? 0) > attemptedGeneration) return message;
      const { resendInFlight: _, ...settled } = message;
      return { ...settled, error,
        ...(uncertain ? { resendInFlight: true as const } : {}),
        ...(attemptedGeneration !== undefined ? { resendGeneration: uncertain ? attemptedGeneration : attemptedGeneration + 1 } : {}),
        state: uncertain ? "uncertain" : attemptedGeneration !== undefined ? "held" : message.serverOwned ? message.state : "held" };
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
    this.unconfirmed.delete(`${owner}\0${id}`);
    this.refresh(owner);
    this.write(owner, this.read(owner).filter((message) => message.id !== id));
    // its recovery copy goes with it
    const kept = this.recovery.get(`${owner}\0${id}`);
    if (kept === undefined) return;
    this.recovery.delete(`${owner}\0${id}`);
    this.lifetimes.discard(kept);
  }
}

export const pendingMessages = new PendingMessageStore();
paneLifetimes.onRetire((machineId) => pendingMessages.forget(machineId));
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key?.startsWith(PREFIX)) pendingMessages.refresh(event.key.slice(PREFIX.length));
});
