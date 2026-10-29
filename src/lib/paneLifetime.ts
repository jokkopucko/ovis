import { LOCAL_MACHINE, type Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { restoreDraft } from "./draft.ts";

/**
 * herdr gives pane IDs out again once it is replaced (#1608), and a pane's unsent state is stored
 * under its PC and pane ID alone (`paneStorageId`): the message draft and its sending lease, the
 * terminal line, the input held for the terminal, and the lens. So each PC's stored state says
 * which herdr it belongs to (`ovis:pane-lifetime:<PC>`, the snapshot's `herdr_lifetime`). When a
 * snapshot names another one, the earlier herdr's text leaves its panes for Recover unsent text
 * (`ovis:unsent:`), never deleted and never sent, and its lenses and leases go. A server restart
 * alone keeps the lifetime, and the state with it. Text stored before any record was (an earlier
 * release) names no herdr: it goes to recovery on the first load, and its lenses stay.
 *
 * A PC whose snapshot names no lifetime (an older bridge) keeps its pane state in this page only:
 * it survives reconnects, never reaches storage, and reads none of it. So does a PC whose stored
 * state another tab already gave to a herdr this page has not seen yet.
 */
export type UnsentKind = "message" | "line" | "held" | "pending";
export interface UnsentText { id: string; machine_id: string; pane_id: string; pane_title?: string; kind: UnsentKind; text: string; at: number }

const KINDS: readonly (readonly [string, UnsentKind])[] = [
  ["ovis:composer-draft:", "message"], ["ovis:terminal-line:", "line"], ["ovis:terminal-draft:", "held"],
  // messages held for a pane, or not confirmed (lib/pendingMessages.ts, and the older lib/messageQueue.ts)
  ["ovis:pending:", "pending"], ["ovis:queue:", "pending"],
];
const LEASE_PREFIX = "ovis:composer-sending:";
const VIEW_PREFIX = "ovis:view:";
/** comments on a pane's replies (lib/replyComments.ts): no text of the user's own to recover, they go with the herdr whose replies they quote */
export const REPLY_COMMENTS_PREFIX = "ovis:reply-comments:";
/** a message box's agent-only mark (lib/composerDraft.ts), which goes with its draft */
const AGENT_ONLY_PREFIX = "ovis:composer-agent-only:";
const RECORD_PREFIX = "ovis:pane-lifetime:";
/** each PC's lifetimes the record held before: a snapshot naming one of them is older than the record */
const RETIRED_PREFIX = "ovis:pane-lifetimes-retired:";
const RETIRED_KEPT = 16;
export const UNSENT_PREFIX = "ovis:unsent:";
type PaneStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The PC and pane a pane-state key is about, and the kind of text it holds (null: a lens or a lease), or null for any other key. */
export function paneStateKey(key: string): { machineId: string; paneId: string; kind: UnsentKind | null } | null {
  const lease = key.startsWith(LEASE_PREFIX);
  const rest = lease ? key.slice(LEASE_PREFIX.length) : key;
  const draft = KINDS.find(([prefix]) => rest.startsWith(prefix));
  const prefix = draft?.[0] ?? (lease ? null : [VIEW_PREFIX, REPLY_COMMENTS_PREFIX, AGENT_ONLY_PREFIX].find((other) => rest.startsWith(other)) ?? null);
  if (prefix === null) return null;
  const owner = rest.slice(prefix.length);
  const kind = lease || !draft ? null : draft[1];
  // paneStorageId: a local pane's ID as it is, another PC's `remote:<PC>:<pane>` with both encoded
  if (!owner.startsWith("remote:")) return owner ? { machineId: LOCAL_MACHINE, paneId: owner, kind } : null;
  const parts = owner.split(":");
  if (parts.length !== 3) return null;
  try { return { machineId: decodeURIComponent(parts[1]!), paneId: decodeURIComponent(parts[2]!), kind }; } catch { return null; }
}

function parseUnsent(id: string, raw: string | null): UnsentText | null {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const { machine_id, pane_id, pane_title, kind, text, at } = value as Partial<UnsentText>;
    if (typeof machine_id !== "string" || typeof pane_id !== "string" || typeof text !== "string" || typeof at !== "number"
      || (kind !== "message" && kind !== "line" && kind !== "held" && kind !== "pending")) return null;
    return { id, machine_id, pane_id, ...(typeof pane_title === "string" && pane_title ? { pane_title } : {}), kind, text, at };
  } catch { return null; }
}

/** The text a stored pane-state value holds: held input keeps only its printable text, a message list each message's. */
function texts(kind: UnsentKind, value: string | null, now: number): string[] {
  if (kind === "held") return [restoreDraft(value, now).text];
  if (kind !== "pending") return [value ?? ""];
  try {
    const data: unknown = JSON.parse(value ?? "null");
    const messages = typeof data === "object" && data !== null && "messages" in data && Array.isArray(data.messages) ? data.messages as unknown[] : null;
    if (messages === null) return [value ?? ""];
    return messages.flatMap((message) => typeof message === "object" && message !== null && "text" in message && typeof message.text === "string" ? [message.text] : []);
  } catch { return [value ?? ""]; }
}

export class PaneLifetimes {
  /** the herdr each PC's panes are drawn under on this page: its latest snapshot's lifetime, null when that names none */
  private readonly generations = new Map<string, string | null>();
  /** the last lifetime this page saw a snapshot name for each PC */
  private readonly proven = new Map<string, string>();
  /** lifetimes this page drew a PC under and then left: a replaced herdr never comes back */
  private readonly outlived = new Map<string, Set<string>>();
  /** each PC's pane titles in its latest snapshot, for the text it leaves to recovery */
  private readonly titles = new Map<string, Map<string, string>>();
  /** the pane state of PCs this page keeps out of storage */
  private readonly memory = new Map<string, string>();
  /** text that storage refused to keep for recovery: offered from this page while it is open */
  private pageUnsent: UnsentText[] = [];
  private readonly retired = new Set<(machineId: string) => void>();
  private readonly listeners = new Set<() => void>();
  private unsentCache: { raw: string; list: readonly UnsentText[] } | null = null;

  constructor(
    private readonly storage: () => Storage = () => window.localStorage,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** The lifetime this page draws a PC's panes under: undefined before its first snapshot, null when snapshots name none. */
  generation(machineId: string): string | null | undefined { return this.generations.get(machineId); }

  /** Whether this page keeps the PC's pane state in storage: its herdr is proven, and the stored state is that herdr's. */
  stored(machineId: string): boolean {
    const lifetime = this.generations.get(machineId);
    if (typeof lifetime !== "string") return false;
    try { return this.storage().getItem(RECORD_PREFIX + machineId) === lifetime; } catch { return false; }
  }

  private routed(key: string): boolean {
    const pane = paneStateKey(key);
    return pane === null || this.stored(pane.machineId);
  }

  /** Storage for the pane-state keys: the PC's own when it is stored, else this page's memory. */
  readonly paneStorage: PaneStorage = {
    getItem: (key) => this.routed(key) ? this.storage().getItem(key) : this.memory.get(key) ?? null,
    setItem: (key, value) => { if (this.routed(key)) this.storage().setItem(key, value); else this.memory.set(key, value); },
    removeItem: (key) => { if (this.routed(key)) this.storage().removeItem(key); else this.memory.delete(key); },
  };

  /** Called with a PC once its generation changed: the stores drop what they read for it. */
  onRetire(forget: (machineId: string) => void): () => void { this.retired.add(forget); return () => { this.retired.delete(forget); }; }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify(): void { this.unsentCache = null; for (const listener of this.listeners) listener(); }
  storageChanged(key: string | null): void { if (key === null || key.startsWith(UNSENT_PREFIX)) this.notify(); }

  /**
   * Each roster before it is drawn (useMachineRoster): a PC whose snapshot names another herdr than
   * the page drew it under leaves its pane state to recovery in this same render. Only the page
   * that saw the stored herdr go retires the stored state; a page that is behind another tab
   * leaves it alone, and keeps its own state in memory until it catches up. A snapshot that names
   * no herdr after one was proven proves neither: the panes it draws get none of the stored state,
   * which stays where it is until a snapshot names a herdr again, and what is typed meanwhile goes
   * to recovery then. A PC's connection reports its
   * snapshot here too (lib/machineSession.ts), before its panes hear of it, with no titles: the
   * roster's next read brings them.
   */
  observe(machines: readonly Pick<Machine, "id" | "snapshot">[], title?: (pane: HerdrPane) => string): void {
    const changed: string[] = [];
    for (const machine of machines) {
      if (!machine.snapshot) continue;
      const titles = this.titles.get(machine.id) ?? new Map<string, string>();
      const named = machine.snapshot.herdr_lifetime;
      // a read from before the herdr this page already moved to (a roster the connection overtook)
      if (named !== undefined && this.outlived.get(machine.id)?.has(named)) continue;
      const next = named ?? null;
      const proven = this.proven.get(machine.id);
      if (!this.generations.has(machine.id) || this.generations.get(machine.id) !== next) {
        // what the page kept for the panes it drew until now goes to recovery: typed while no read
        // proved their herdr, even the same herdr named again proves nothing about it
        this.retireMemory(machine.id, titles);
        if (next !== null && proven !== undefined && proven !== next) this.outlived.set(machine.id, new Set([...this.outlived.get(machine.id) ?? [], proven].slice(-RETIRED_KEPT)));
        this.generations.set(machine.id, next);
        if (next !== null) this.settle(machine.id, next, titles);
        changed.push(machine.id);
      } else if (next !== null && (!this.stored(machine.id) || this.holds(machine.id))) {
        // behind another tab, or refused by storage: tried again with each roster. Storage that took
        // another tab's record meanwhile still leaves this page's own text to move
        this.settle(machine.id, next, titles);
        if (this.stored(machine.id)) {
          // what this page kept meanwhile was made under this same herdr: it goes to storage, as the
          // stores read it from there now, and only text storage holds otherwise is left to recovery
          this.storeMemory(machine.id, titles);
          changed.push(machine.id);
        }
      }
      if (next !== null) this.proven.set(machine.id, next);
      if (title) this.titles.set(machine.id, new Map(machine.snapshot.panes.map((pane) => [pane.pane_id, title(pane)])));
    }
    for (const machineId of changed) for (const forget of this.retired) forget(machineId);
    if (changed.length > 0) this.notify();
  }

  private settle(machineId: string, next: string, titles: ReadonlyMap<string, string>): void {
    try {
      const storage = this.storage();
      const record = storage.getItem(RECORD_PREFIX + machineId);
      if (record === next) return;
      let retired: string[] = [];
      try { const list: unknown = JSON.parse(storage.getItem(RETIRED_PREFIX + machineId) ?? "[]"); if (Array.isArray(list)) retired = list.filter((item): item is string => typeof item === "string"); } catch { /* unreadable: no history */ }
      // a herdr the stored state already outlived: this page is behind another tab, and leaves that state alone
      if (retired.includes(next)) return;
      if (record !== null) {
        this.retireStored(storage, machineId, titles);
        storage.setItem(RETIRED_PREFIX + machineId, JSON.stringify([...retired.filter((item) => item !== record), record].slice(-RETIRED_KEPT)));
      } else {
        // no record: the text was stored before lifetimes were (an earlier release), for a herdr
        // nothing proves is this one. It goes to recovery; a lens is no text, and stays
        this.retireStored(storage, machineId, new Map(), true);
      }
      storage.setItem(RECORD_PREFIX + machineId, next);
    } catch { /* storage refused: the PC's state stays in this page */ }
  }

  private retireStored(storage: Storage, machineId: string, titles: ReadonlyMap<string, string>, keepLenses = false): void {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key !== null) keys.push(key);
    }
    for (const key of keys) {
      const pane = paneStateKey(key);
      if (pane?.machineId !== machineId) continue;
      if (keepLenses && key.startsWith(VIEW_PREFIX)) continue;
      if (pane.kind !== null) this.archive(storage, pane.machineId, pane.paneId, pane.kind, texts(pane.kind, storage.getItem(key), this.now()), titles);
      storage.removeItem(key);
    }
  }

  private retireMemory(machineId: string, titles: ReadonlyMap<string, string>): void {
    let storage: Storage | null = null;
    try { storage = this.storage(); } catch { /* no storage: the text is kept in this page */ }
    for (const [key, value] of [...this.memory]) {
      const pane = paneStateKey(key);
      if (pane?.machineId !== machineId) continue;
      this.memory.delete(key);
      if (pane.kind !== null) this.archive(storage, pane.machineId, pane.paneId, pane.kind, texts(pane.kind, value, this.now()), titles);
    }
  }

  /** whether this page keeps any of the PC's pane state in its memory */
  private holds(machineId: string): boolean {
    for (const key of this.memory.keys()) if (paneStateKey(key)?.machineId === machineId) return true;
    return false;
  }

  private storeMemory(machineId: string, titles: ReadonlyMap<string, string>): void {
    let storage: Storage | null = null;
    try { storage = this.storage(); } catch { /* no storage: the text is kept in this page */ }
    for (const [key, value] of [...this.memory]) {
      const pane = paneStateKey(key);
      if (pane?.machineId !== machineId) continue;
      this.memory.delete(key);
      try {
        const stored = storage?.getItem(key) ?? null;
        if (stored === value) continue;
        if (stored === null && storage) { storage.setItem(key, value); continue; }
      } catch { /* storage refused it: recovery below */ }
      // another tab's text for the pane, or storage refused this one: neither is lost
      if (pane.kind !== null) this.archive(storage, pane.machineId, pane.paneId, pane.kind, texts(pane.kind, value, this.now()), titles);
    }
  }

  /**
   * Text a store held only in this page for a PC whose herdr was just replaced (an edit storage
   * refused, input held but not yet saved), or only in this page while its herdr is not proven:
   * kept for recovery with the rest. The ID of the record that holds it, null for blank text.
   * `own`: a record of its own, never one already kept for the same words, so whoever discards it
   * takes no other tab's or earlier page's copy with it.
   */
  keep(machineId: string, paneId: string, kind: UnsentKind, text: string, own = false): string | null {
    let storage: Storage | null = null;
    try { storage = this.storage(); } catch { /* no storage: the text is kept in this page */ }
    const [id] = this.archive(storage, machineId, paneId, kind, [text], this.titles.get(machineId) ?? new Map(), own);
    this.notify();
    return id ?? null;
  }

  /** the IDs of the records holding the texts, an earlier one for a text already kept */
  private archive(storage: Storage | null, machineId: string, paneId: string, kind: UnsentKind, values: readonly string[], titles: ReadonlyMap<string, string>, own = false): string[] {
    const title = titles.get(paneId);
    const ids: string[] = [];
    for (const text of values) {
      if (text.trim() === "") continue;
      // the same text of the same pane is kept once (two tabs, or a store and storage, can both hand it over)
      const same = own ? undefined : this.unsent().find((item) => item.machine_id === machineId && item.pane_id === paneId && item.kind === kind && item.text === text);
      if (same !== undefined) { ids.push(same.id); continue; }
      const record: UnsentText = { id: this.newId(), machine_id: machineId, pane_id: paneId, ...(title && title !== paneId ? { pane_title: title } : {}), kind, text, at: this.now() };
      const { id, ...stored } = record;
      try {
        if (storage === null) throw new Error("no storage");
        storage.setItem(UNSENT_PREFIX + id, JSON.stringify(stored));
      } catch { this.pageUnsent = [...this.pageUnsent, record]; }
      this.unsentCache = null;
      ids.push(record.id);
    }
    return ids;
  }

  /** The text earlier herdrs' panes left, newest first. */
  unsent = (): readonly UnsentText[] => {
    const found: [string, string][] = [];
    try {
      const storage = this.storage();
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (key?.startsWith(UNSENT_PREFIX)) found.push([key.slice(UNSENT_PREFIX.length), storage.getItem(key) ?? ""]);
      }
    } catch { /* storage refused: there is nothing kept */ }
    found.sort(([a], [b]) => a.localeCompare(b));
    const raw = JSON.stringify([found, this.pageUnsent.map((item) => item.id)]);
    if (this.unsentCache?.raw === raw) return this.unsentCache.list;
    const list = [...found.flatMap(([id, value]) => parseUnsent(id, value) ?? []), ...this.pageUnsent].sort((a, b) => b.at - a.at);
    this.unsentCache = { raw, list };
    return list;
  };

  discard(id: string): void {
    this.pageUnsent = this.pageUnsent.filter((item) => item.id !== id);
    try { this.storage().removeItem(UNSENT_PREFIX + id); } catch { /* storage refused */ }
    this.notify();
  }
}

export const paneLifetimes = new PaneLifetimes();
if (typeof window !== "undefined") window.addEventListener("storage", (event) => paneLifetimes.storageChanged(event.key));
