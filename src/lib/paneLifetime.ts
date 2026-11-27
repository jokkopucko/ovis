import { LOCAL_MACHINE, type Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { looksLikeKey } from "../../shared/secret-prompt.ts";
import { restoreDraft } from "./draft.ts";
import { serverIdOfPath } from "./shellMode.ts";

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
 * state another tab already gave to a herdr this page has not seen yet. When the app replaces the
 * page (PAGE_LEAVING_EVENT), that state waits in storage for the next page of this address, which
 * leaves its text to recovery (carry): nothing proves the herdr it comes back to is the one it was
 * typed under, whose pane IDs another herdr may have given out again meanwhile.
 */
export type UnsentKind = "message" | "line" | "held" | "pending";
/** `agent_only`: a message box's draft that was for an agent alone (#511), which goes back into a box as one */
export interface UnsentText { id: string; machine_id: string; pane_id: string; pane_title?: string; kind: UnsentKind; text: string; at: number; agent_only?: true }

export const CARD_TEXT_PREFIX = "ovis:card-text:";
export const REPLY_COMMENTS_PREFIX = "ovis:reply-comments:";
let commentsText: (raw: string | null) => string | null = (raw) => raw;
export function readReplyCommentsWith(read: (raw: string | null) => string): void { commentsText = read; }
const KINDS: readonly (readonly [string, UnsentKind])[] = [
  ["ovis:composer-draft:", "message"], ["ovis:terminal-line:", "line"], ["ovis:terminal-draft:", "held"],
  ["ovis:pending:", "pending"], ["ovis:queue:", "pending"],
  [CARD_TEXT_PREFIX, "message"], [REPLY_COMMENTS_PREFIX, "message"],
];
const LEASE_PREFIX = "ovis:composer-sending:";
export const COMMAND_PREFIX = "ovis:composer-command:";
const VIEW_PREFIX = "ovis:view:";
/** a message box's agent-only mark (lib/composerDraft.ts), which goes with its draft */
const AGENT_ONLY_PREFIX = "ovis:composer-agent-only:";
const RECORD_PREFIX = "ovis:pane-lifetime:";
const RETIRED_PREFIX = "ovis:pane-lifetimes-retired:";
const RETIRED_KEPT = 16;
export const UNSENT_PREFIX = "ovis:unsent:";
export const PAGE_LEAVING_EVENT = "ovis-page-leaving";
/** the pane state a replaced page kept in memory, by key (carry); a relay PC's shares the hosted shell's origin, so it is its own */
const carriedKey = (): string => `ovis:pane-carried:${typeof location === "undefined" ? "" : serverIdOfPath(location.pathname) ?? ""}`;
type PaneStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function paneStateKey(key: string): { machineId: string; paneId: string; kind: UnsentKind | null } | null {
  const marker = [LEASE_PREFIX, COMMAND_PREFIX].find((prefix) => key.startsWith(prefix));
  const lease = marker !== undefined;
  const rest = marker ? key.slice(marker.length) : key;
  const draft = KINDS.find(([prefix]) => rest.startsWith(prefix));
  const prefix = draft?.[0] ?? (lease ? null : [VIEW_PREFIX, AGENT_ONLY_PREFIX].find((other) => rest.startsWith(other)) ?? null);
  if (prefix === null) return null;
  const owner = rest.slice(prefix.length);
  const kind = lease || !draft ? null : draft[1];
  if (!owner.startsWith("remote:")) return owner ? { machineId: LOCAL_MACHINE, paneId: owner, kind } : null;
  const parts = owner.split(":");
  if (parts.length !== 3) return null;
  try { return { machineId: decodeURIComponent(parts[1]!), paneId: decodeURIComponent(parts[2]!), kind }; } catch { return null; }
}

function agentOnlyMark(key: string): string | null {
  const prefix = KINDS[0]![0];
  return key.startsWith(prefix) ? AGENT_ONLY_PREFIX + key.slice(prefix.length) : null;
}

function parseUnsent(id: string, raw: string | null): UnsentText | null {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const { machine_id, pane_id, pane_title, kind, text, at, agent_only } = value as Partial<UnsentText>;
    if (typeof machine_id !== "string" || typeof pane_id !== "string" || typeof text !== "string" || typeof at !== "number"
      || (kind !== "message" && kind !== "line" && kind !== "held" && kind !== "pending")) return null;
    return { id, machine_id, pane_id, ...(typeof pane_title === "string" && pane_title ? { pane_title } : {}), kind, text, at, ...(agent_only === true ? { agent_only } : {}) };
  } catch { return null; }
}

function storedText(key: string, value: string | null): string | null {
  if (key.startsWith(REPLY_COMMENTS_PREFIX)) return commentsText(value);
  if (value === null || !key.startsWith(CARD_TEXT_PREFIX)) return value;
  try {
    const card: unknown = JSON.parse(value);
    return typeof card === "object" && card !== null && "text" in card && typeof card.text === "string" ? card.text : null;
  } catch { return null; }
}

interface Unsent { text: string; agentOnly: boolean }

/**
 * The text a stored pane-state value holds: held input keeps only its printable text, a message list each
 * message's.
 */
function texts(kind: UnsentKind, value: string | null, now: number, marked = false): Unsent[] {
  if (kind === "held") return [{ text: restoreDraft(value, now).text, agentOnly: false }];
  if (kind !== "pending") return [{ text: value ?? "", agentOnly: marked }];
  try {
    const data: unknown = JSON.parse(value ?? "null");
    const messages = typeof data === "object" && data !== null && "messages" in data && Array.isArray(data.messages) ? data.messages as unknown[] : null;
    if (messages === null) return [{ text: value ?? "", agentOnly: false }];
    // a dismissed ID is saved while a live connection still holds its row, never as text to recover
    const listed = (data as { dismissed?: unknown }).dismissed;
    const dismissed = new Set(Array.isArray(listed) ? listed as unknown[] : []);
    return messages.flatMap((message) => typeof message === "object" && message !== null && "text" in message && typeof message.text === "string"
      && !("id" in message && dismissed.has(message.id))
      ? [{ text: message.text, agentOnly: "agent_only" in message && message.agent_only === true }] : []);
  } catch { return [{ text: value ?? "", agentOnly: false }]; }
}

export const UNSENT_UNDO_WINDOW_MS = 5_000;

export interface UndoTimers {
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}

const defaultTimers: UndoTimers = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (timer) => globalThis.clearTimeout(timer as number),
};

export class PaneLifetimes {
  private readonly generations = new Map<string, string | null>();
  private readonly proven = new Map<string, string>();
  /** lifetimes this page drew a PC under and then left: a replaced herdr never comes back */
  private readonly outlived = new Map<string, Set<string>>();
  private readonly skipped = new Map<string, { machine: Pick<Machine, "id" | "snapshot">; title?: (pane: HerdrPane) => string }>();
  private readonly titles = new Map<string, Map<string, string>>();
  private readonly memory = new Map<string, string>();
  private pageUnsent: UnsentText[] = [];
  private readonly discarded = new Map<string, { record: UnsentText; timer: unknown }>();
  private undoableList: readonly UnsentText[] = [];
  private readonly retired = new Set<(machineId: string) => void>();
  private readonly listeners = new Set<() => void>();
  private unsentCache: { raw: string; list: readonly UnsentText[] } | null = null;

  constructor(
    private readonly storage: () => Storage = () => window.localStorage,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => crypto.randomUUID(),
    private readonly timers: UndoTimers = defaultTimers,
  ) {}

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

  readonly paneStorage: PaneStorage = {
    getItem: (key) => this.routed(key) ? this.storage().getItem(key) : this.memory.get(key) ?? null,
    setItem: (key, value) => { if (this.routed(key)) this.storage().setItem(key, value); else this.memory.set(key, value); },
    removeItem: (key) => { if (this.routed(key)) this.storage().removeItem(key); else this.memory.delete(key); },
  };

  runtimeSwitched(machineId: string): void {
    try { this.storage().removeItem(RETIRED_PREFIX + machineId); } catch {}
    this.release(machineId);
  }

  private release(machineId: string): void {
    this.outlived.delete(machineId);
    const skipped = this.skipped.get(machineId);
    if (skipped) {
      this.skipped.delete(machineId);
      this.observe([skipped.machine], skipped.title);
    }
  }

  runtimeChanged(machineId: string): void { this.runtimeSwitched(machineId); }

  onRetire(forget: (machineId: string) => void): () => void { this.retired.add(forget); return () => { this.retired.delete(forget); }; }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify(): void { this.unsentCache = null; for (const listener of this.listeners) listener(); }
  storageChanged(key: string | null): void {
    if (key === null) for (const machineId of [...this.outlived.keys()]) this.release(machineId);
    else if (key.startsWith(RETIRED_PREFIX)) {
      let gone = false;
      try { gone = this.storage().getItem(key) === null; } catch {}
      if (gone) this.release(key.slice(RETIRED_PREFIX.length));
    }
    if (key === null || key.startsWith(UNSENT_PREFIX)) this.notify();
  }

  /**
   * Only the page
   * that saw the stored herdr go retires the stored state; a page that is behind another tab
   * leaves it alone, and keeps its own state in memory until it catches up. A snapshot that names
   * no herdr after one was proven proves neither: the panes it draws get none of the stored state,
   * which stays where it is until a snapshot names a herdr again, and what is typed meanwhile goes
   * to recovery then.
   */
  observe(machines: readonly Pick<Machine, "id" | "snapshot">[], title?: (pane: HerdrPane) => string): void {
    const changed: string[] = [];
    for (const machine of machines) {
      if (!machine.snapshot) continue;
      const titles = this.titles.get(machine.id) ?? new Map<string, string>();
      const named = machine.snapshot.herdr_lifetime;
      if (named !== undefined && this.outlived.get(machine.id)?.has(named)) {
        this.skipped.set(machine.id, { machine, ...(title ? { title } : {}) });
        continue;
      }
      this.skipped.delete(machine.id);
      const next = named ?? null;
      const proven = this.proven.get(machine.id);
      const first = !this.generations.has(machine.id);
      if (first || this.generations.get(machine.id) !== next) {
        // what the page kept for the panes it drew until now goes to recovery: typed while no read
        // proved their herdr, even the same herdr named again proves nothing about it
        this.retireMemory(machine.id, titles);
        if (next !== null && proven !== undefined && proven !== next) this.outlived.set(machine.id, new Set([...this.outlived.get(machine.id) ?? [], proven].slice(-RETIRED_KEPT)));
        this.generations.set(machine.id, next);
        // what the page before this one kept for the PC (carry) was typed while no read proved its herdr,
        // and herdr may have been replaced since: to recovery, as any such text is, never into a pane
        if (first && this.takeCarried(machine.id)) this.retireMemory(machine.id, titles);
        if (next !== null) this.settle(machine.id, next, titles);
        changed.push(machine.id);
      } else if (next !== null && (!this.stored(machine.id) || this.holds(machine.id))) {
        this.settle(machine.id, next, titles);
        if (this.stored(machine.id)) {
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
      try { const list: unknown = JSON.parse(storage.getItem(RETIRED_PREFIX + machineId) ?? "[]"); if (Array.isArray(list)) retired = list.filter((item): item is string => typeof item === "string"); } catch {}
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
    } catch {}
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
      const mark = agentOnlyMark(key);
      if (pane.kind !== null) this.archive(storage, pane.machineId, pane.paneId, pane.kind, texts(pane.kind, storedText(key, storage.getItem(key)), this.now(), mark !== null && keys.includes(mark)), titles);
      storage.removeItem(key);
    }
  }

  private retireMemory(machineId: string, titles: ReadonlyMap<string, string>): void {
    let storage: Storage | null = null;
    try { storage = this.storage(); } catch {}
    const held = new Set(this.memory.keys());
    for (const [key, value] of [...this.memory]) {
      const pane = paneStateKey(key);
      if (pane?.machineId !== machineId) continue;
      this.memory.delete(key);
      const mark = agentOnlyMark(key);
      if (pane.kind !== null) this.archive(storage, pane.machineId, pane.paneId, pane.kind, texts(pane.kind, storedText(key, value), this.now(), mark !== null && held.has(mark)), titles);
    }
  }

  /**
   * The app is replacing this page (PAGE_LEAVING_EVENT): the pane state it keeps in memory alone waits
   * in storage for the next page of this address (takeCarried), with any an earlier page left there.
   * Nothing of it is sent. Storage that refuses it leaves it with this page, as before, and the answer
   * is false: true says it is in storage, or that this page held none. Two pages of one origin would
   * overwrite each other's carry for the same pane: a page carries only as it is replaced (the Android
   * app leaving it, a PC page moving to another PC, a page the phone app restored loading again,
   * lib/pageRestore.ts), one page at a time.
   */
  carry(): boolean {
    if (this.memory.size === 0) return true;
    try {
      const storage = this.storage();
      const carried = this.live([...Object.entries(readCarried(storage.getItem(carriedKey()))), ...this.memory]);
      storage.setItem(carriedKey(), JSON.stringify(Object.fromEntries(carried)));
      return true;
    } catch { return false; }
  }

  private takeCarried(machineId: string): boolean {
    try {
      const storage = this.storage();
      const all = Object.entries(readCarried(storage.getItem(carriedKey())));
      const carried = this.live(all);
      const mine = carried.filter(([key]) => paneStateKey(key)?.machineId === machineId);
      const rest = carried.filter(([key]) => paneStateKey(key)?.machineId !== machineId);
      if (rest.length === all.length) return false;
      for (const [key, value] of mine) this.memory.set(key, value);
      if (rest.length === 0) storage.removeItem(carriedKey());
      else storage.setItem(carriedKey(), JSON.stringify(Object.fromEntries(rest)));
      return mine.length > 0;
    } catch { return false; }
  }

  /** Carried pane state without held input past its age (lib/draft.ts DRAFT_TTL_MS), which is not kept in storage. */
  private live(entries: readonly (readonly [string, string])[]): [string, string][] {
    return entries.filter(([key, value]) => paneStateKey(key)?.kind !== "held" || restoreDraft(value, this.now()).text !== "").map(([key, value]) => [key, value]);
  }

  private holds(machineId: string): boolean {
    for (const key of this.memory.keys()) if (paneStateKey(key)?.machineId === machineId) return true;
    return false;
  }

  private storeMemory(machineId: string, titles: ReadonlyMap<string, string>): void {
    let storage: Storage | null = null;
    try { storage = this.storage(); } catch {}
    const held = new Set(this.memory.keys());
    for (const [key, value] of [...this.memory]) {
      const pane = paneStateKey(key);
      if (pane?.machineId !== machineId) continue;
      this.memory.delete(key);
      const mark = agentOnlyMark(key);
      try {
        const stored = storage?.getItem(key) ?? null;
        if (stored === value) continue;
        if (stored === null && storage) { storage.setItem(key, value); continue; }
      } catch {}
      if (pane.kind !== null) this.archive(storage, pane.machineId, pane.paneId, pane.kind, texts(pane.kind, storedText(key, value), this.now(), mark !== null && held.has(mark)), titles);
    }
  }

  /**
   * `own`: a record of its own, never one already kept for the same words, so whoever discards it
   * takes no other tab's or earlier page's copy with it.
   */
  keep(machineId: string, paneId: string, kind: UnsentKind, text: string, own = false, agentOnly = false): string | null {
    let storage: Storage | null = null;
    try { storage = this.storage(); } catch {}
    const [id] = this.archive(storage, machineId, paneId, kind, [{ text, agentOnly }], this.titles.get(machineId) ?? new Map(), own);
    this.notify();
    return id ?? null;
  }

  private archive(storage: Storage | null, machineId: string, paneId: string, kind: UnsentKind, values: readonly Unsent[], titles: ReadonlyMap<string, string>, own = false): string[] {
    const title = titles.get(paneId);
    const ids: string[] = [];
    // a record kept before this call stands for one of these texts at most: two messages with the same words keep two (#3990)
    const earlier = own ? [] : [...this.unsent()];
    for (const { text, agentOnly } of values) {
      if (text.trim() === "") continue;
      // the input line's key is never written down, by an earlier release's storage either (#2523)
      if (kind === "line" && looksLikeKey(text)) continue;
      const same = earlier.findIndex((item) => item.machine_id === machineId && item.pane_id === paneId && item.kind === kind && item.text === text && (item.agent_only === true) === agentOnly);
      if (same >= 0) { ids.push(earlier.splice(same, 1)[0]!.id); continue; }
      const record: UnsentText = { id: this.newId(), machine_id: machineId, pane_id: paneId, ...(title && title !== paneId ? { pane_title: title } : {}), kind, text, at: this.now(), ...(agentOnly ? { agent_only: true as const } : {}) };
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

  /** Input-line keys an earlier release kept (#2523): out of storage, recovery records too. */
  forgetLineKeys(): void {
    try {
      const storage = this.storage();
      const keys: string[] = [];
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (key !== null) keys.push(key);
      }
      for (const key of keys) {
        const value = storage.getItem(key) ?? "";
        const line = key.startsWith(UNSENT_PREFIX) ? parseUnsent(key.slice(UNSENT_PREFIX.length), value) : null;
        if (line ? line.kind === "line" && looksLikeKey(line.text) : paneStateKey(key)?.kind === "line" && looksLikeKey(value)) storage.removeItem(key);
      }
    } catch {}
    this.notify();
  }

  unsent = (): readonly UnsentText[] => {
    const found: [string, string][] = [];
    try {
      const storage = this.storage();
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (key?.startsWith(UNSENT_PREFIX)) found.push([key.slice(UNSENT_PREFIX.length), storage.getItem(key) ?? ""]);
      }
    } catch {}
    found.sort(([a], [b]) => a.localeCompare(b));
    const raw = JSON.stringify([found, this.pageUnsent.map((item) => item.id)]);
    if (this.unsentCache?.raw === raw) return this.unsentCache.list;
    const list = [...found.flatMap(([id, value]) => parseUnsent(id, value) ?? []), ...this.pageUnsent].sort((a, b) => b.at - a.at);
    this.unsentCache = { raw, list };
    return list;
  };

  undoable = (): readonly UnsentText[] => this.undoableList;

  private forget(id: string): void {
    const pending = this.discarded.get(id);
    if (pending === undefined) return;
    this.timers.clearTimeout(pending.timer);
    this.discarded.delete(id);
    this.undoableList = [...this.discarded.values()].map(({ record }) => record).sort((a, b) => b.at - a.at);
  }

  discard(id: string, undoWindowMs = UNSENT_UNDO_WINDOW_MS): UnsentText | null {
    const existing = this.unsent().find((item) => item.id === id) ?? null;
    this.forget(id);
    if (existing !== null && undoWindowMs > 0) {
      const timer = this.timers.setTimeout(() => { this.forget(id); this.notify(); }, undoWindowMs);
      this.discarded.set(id, { record: existing, timer });
      this.undoableList = [...this.discarded.values()].map(({ record }) => record).sort((a, b) => b.at - a.at);
    }
    this.pageUnsent = this.pageUnsent.filter((item) => item.id !== id);
    try { this.storage().removeItem(UNSENT_PREFIX + id); } catch {}
    this.notify();
    return existing;
  }

  restore(id: string): boolean {
    const record = this.discarded.get(id)?.record ?? null;
    if (record === null) return false;
    this.forget(id);
    const { id: key, ...stored } = record;
    try {
      this.storage().setItem(UNSENT_PREFIX + key, JSON.stringify(stored));
    } catch {
      this.pageUnsent = [...this.pageUnsent.filter((item) => item.id !== key), record];
    }
    this.notify();
    return true;
  }
}

function readCarried(raw: string | null): Record<string, string> {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return {}; }
}

export const paneLifetimes = new PaneLifetimes();
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => paneLifetimes.storageChanged(event.key));
  window.addEventListener(PAGE_LEAVING_EVENT, () => paneLifetimes.carry());
}
