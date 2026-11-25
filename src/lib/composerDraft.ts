import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { RECEIPT_RESUME_ID } from "../../shared/receipt-resume.ts";
import { COMMAND_PREFIX, paneLifetimes, paneStateKey, type PaneLifetimes } from "./paneLifetime.ts";
import { newReceiptId } from "./receiptResume.ts";

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
interface Draft { text: string; sending: boolean }
interface InFlight { sent: string; at: number }
/**
 * How long another tab's in-flight send is honoured before it is read as abandoned (a tab that
 * closed mid-send never clears it). Longer than the 90s submit timeout in ws.ts, so a send that
 * is still legitimately on its way is never seconded by a second tab.
 */
export const SEND_LEASE_MS = 120_000;
const SENDING_PREFIX = "ovis:composer-sending:";
const DRAFT_PREFIX = "ovis:composer-draft:";
export const composerDraftKey = (paneKey: string): string => DRAFT_PREFIX + paneKey;
/** a draft that holds an agent-only message put back by Edit (#511): it is sent `agent_only` until the box is emptied */
export const AGENT_ONLY_PREFIX = "ovis:composer-agent-only:";
const agentOnlyKey = (key: string): string => AGENT_ONLY_PREFIX + (key.startsWith(DRAFT_PREFIX) ? key.slice(DRAFT_PREFIX.length) : key);
export function sendLease(storage: Pick<Storage, "getItem">, key: string): InFlight | null {
  try {
    const raw = storage.getItem(SENDING_PREFIX + key);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { sent, at } = value as Partial<InFlight>;
    if (typeof sent !== "string" || typeof at !== "number" || !Number.isFinite(at)) return null;
    return Date.now() - at > SEND_LEASE_MS ? null : { sent, at };
  } catch {
    return null;
  }
}
export const isSendLeaseKey = (key: string): boolean => key.startsWith(SENDING_PREFIX);
export class ComposerDraftStore {
  private drafts = new Map<string, Draft>();
  private saved = new Map<string, string | null>();
  private unsaved = new Set<string>();
  private agentOnly = new Set<string>();
  private pending = new Map<string, { sent: string; edited: boolean }>();
  private commands = new Map<string, { message: string; id: string; shared: boolean }>();
  private listeners = new Set<() => void>();
  private own = new Set<string>();
  private expiries = new Map<string, unknown>();
  private sends = new Map<string, { id: number; lifetime: string | null | undefined }>();
  private sendCount = 0;
  constructor(
    private storage: () => DraftStorage = () => paneLifetimes.paneStorage,
    private schedule: (run: () => void, ms: number) => unknown = (run, ms) => setTimeout(run, ms),
    private lifetimeOf: (key: string) => string | null | undefined = (key) => {
      const pane = paneStateKey(key);
      return pane ? paneLifetimes.generation(pane.machineId) : undefined;
    },
  ) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify(): void { for (const listener of this.listeners) listener(); }
  read(key: string): Draft {
    let draft = this.drafts.get(key);
    if (!draft) {
      let text: string | null = null;
      try { text = this.storage().getItem(key); } catch {}
      this.saved.set(key, text);
      if (text) this.adoptMark(key, text);
      draft = { text: text ?? "", sending: false };
      this.drafts.set(key, draft);
    }
    return draft;
  }
  private inFlight(key: string): InFlight | null {
    try { return sendLease(this.storage(), key); } catch { return null; }
  }
  refresh(key: string): void {
    if (this.unsaved.has(key)) return;
    const draft = this.read(key);
    // another tab's send is on its way: its draft must not be sent a second time from here
    const lease = this.inFlight(key);
    const sending = this.own.has(key) || lease !== null;
    if (lease !== null && !this.own.has(key) && !this.expiries.has(key)) {
      this.expiries.set(key, this.schedule(() => { this.expiries.delete(key); this.refresh(key); }, lease.at + SEND_LEASE_MS - Date.now() + 1));
    }
    let text: string | null = null;
    try { text = this.storage().getItem(key); } catch { return; }
    this.adoptMark(key, text);
    if (text === this.saved.get(key) && sending === draft.sending) return;
    if (text !== this.saved.get(key)) {
      this.commands.delete(key);
      const pending = this.pending.get(key);
      if (pending && !(text ?? "").startsWith(pending.sent)) pending.edited = true;
      this.saved.set(key, text);
    }
    this.drafts.set(key, { text: text ?? "", sending });
    this.notify();
  }
  set(key: string, value: string | ((previous: string) => string)): void {
    const draft = this.read(key);
    const text = typeof value === "string" ? value : value(draft.text);
    if (text !== draft.text) {
      this.commands.delete(key);
      try { this.storage().removeItem(COMMAND_PREFIX + key); } catch {}
    }
    // cleared and retyped while on its way, a draft can end up starting with the sent text
    // again: once it stopped extending it, the whole of it is the user's own
    const pending = this.pending.get(key);
    if (pending && !text.startsWith(pending.sent)) pending.edited = true;
    this.drafts.set(key, { ...draft, text });
    if (!text) this.agentOnly.delete(key);
    try {
      if (text) {
        // an agent-only draft is stored only with its mark: another tab or a reload never reads it unmarked
        if (this.agentOnly.has(key)) this.storage().setItem(agentOnlyKey(key), "1");
        this.storage().setItem(key, text);
      } else { this.storage().removeItem(key); this.storage().removeItem(agentOnlyKey(key)); }
      this.saved.set(key, text || null);
      this.unsaved.delete(key);
    } catch { this.unsaved.add(key); }
    this.notify();
  }
  /** Never truncate recovered input: an oversized draft can be edited down. */
  restorePending(key: string, text: string, agentOnly = false): void {
    // its `> quote` lines must never reach a shell: the box stays agent-only until it is emptied, in this
    // page whatever storage does, and marked before the text is there to send (set stores the mark first)
    this.refresh(key);
    if (agentOnly) this.markAgentOnly(key);
    this.set(key, (draft) => draft ? `${draft}\n\n${text}` : text);
  }
  /** The draft's next text is a message for an agent alone (#511): set stores it only with the mark. */
  markAgentOnly(key: string): void {
    this.agentOnly.add(key);
  }
  /** A marked draft read from storage stays agent-only in this page, also if another tab clears it meanwhile and
   * this one edits it before hearing so; one read empty is no longer. */
  private adoptMark(key: string, text: string | null): void {
    if (!text) { this.agentOnly.delete(key); return; }
    try { if (this.storage().getItem(agentOnlyKey(key)) !== null) this.agentOnly.add(key); } catch {}
  }
  isAgentOnly(key: string): boolean {
    if (this.agentOnly.has(key)) return true;
    try { return this.storage().getItem(agentOnlyKey(key)) !== null; } catch { return false; }
  }
  begin(key: string, sent?: string): boolean {
    const draft = this.read(key);
    if (this.own.has(key) || this.inFlight(key) !== null) return false;
    this.own.add(key);
    this.sends.set(key, { id: ++this.sendCount, lifetime: this.lifetimeOf(key) });
    if (sent !== undefined) this.pending.set(key, { sent, edited: false });
    this.drafts.set(key, { ...draft, sending: true });
    try { this.storage().setItem(SENDING_PREFIX + key, JSON.stringify({ sent: sent ?? "", at: Date.now() })); }
    catch {}
    this.notify();
    return true;
  }
  claim(key: string, sent: string): boolean {
    // the lease is read before the text: a tab's acknowledgement clears the text and only then ends its
    // lease, so a claim sees either that send still on its way or the draft it settled
    if (this.own.has(key) || this.inFlight(key) !== null) return false;
    this.refresh(key);
    return this.read(key).text === sent && this.begin(key, sent);
  }
  sendOf(key: string): number | undefined { return this.sends.get(key)?.id; }
  /** Only a claimed composer draft, never a terminal line or a saved queue action. */
  commandKey(key: string, message: string): string | undefined {
    const claim = this.pending.get(key);
    if (!claim) return undefined;
    const prior = this.commands.get(key);
    // Edits and acknowledgements remove the marker, even when the same words are
    // retyped before another tab sees a storage event. Bind any added quote too.
    const prefix = bytesToHex(sha256(utf8ToBytes(JSON.stringify([claim.sent, message])))) + ":";
    let shareable = false;
    try {
      const storage = this.storage();
      shareable = !this.unsaved.has(key) && (storage.getItem(key) ?? "") === claim.sent;
      if (shareable) {
        const marker = storage.getItem(COMMAND_PREFIX + key);
        const id = marker?.startsWith(prefix) ? marker.slice(prefix.length) : "";
        if (RECEIPT_RESUME_ID.test(id)) {
          this.commands.set(key, { message, id, shared: true });
          return id;
        }
      }
    } catch { if (prior?.message === message) return prior.id; }
    if (!shareable && prior?.message === message && !prior.shared) return prior.id;
    const id = newReceiptId();
    let shared = false;
    if (shareable) try { this.storage().setItem(COMMAND_PREFIX + key, prefix + id); shared = true; } catch {}
    this.commands.set(key, { message, id, shared });
    return id;
  }
  end(key: string, send?: number): void {
    if (send !== undefined && this.sends.get(key)?.id !== send) return;
    this.sends.delete(key);
    this.pending.delete(key);
    this.own.delete(key);
    try { this.storage().removeItem(SENDING_PREFIX + key); } catch {}
    this.drafts.set(key, { ...this.read(key), sending: false });
    this.notify();
  }
  /**
   * herdr gave the draft's pane a new ID (lib/paneMove.ts): the text goes to the new key. A send of
   * it on its way, from this tab or another, stays with the ID it went under, and a new key that
   * holds a draft already keeps its own.
   */
  move(from: string, to: string): void {
    this.refresh(from);
    this.refresh(to);
    const text = this.read(from).text;
    if (text === "" || this.own.has(from) || this.inFlight(from) !== null || this.read(to).text !== "") return;
    if (this.isAgentOnly(from)) this.markAgentOnly(to);
    this.set(to, text);
    this.set(from, "");
  }
  /** Another herdr took the PC's pane IDs: its drafts are read again from where they now are. */
  forget(machineId: string, lifetimes: Pick<PaneLifetimes, "keep"> = paneLifetimes): void {
    // a send begun for the earlier herdr's pane settles nothing in the draft that pane ID holds now,
    // and does not hold the new pane's box as sending
    for (const [key, send] of [...this.sends]) {
      if (paneStateKey(key)?.machineId !== machineId || send.lifetime === this.lifetimeOf(key)) continue;
      this.sends.delete(key);
      this.own.delete(key);
      this.pending.delete(key);
    }
    for (const [key, draft] of [...this.drafts]) {
      const pane = paneStateKey(key);
      if (pane?.machineId !== machineId) continue;
      if (this.unsaved.has(key)) lifetimes.keep(machineId, pane.paneId, "message", draft.text, false, this.isAgentOnly(key));
      this.drafts.delete(key);
      this.commands.delete(key);
      this.saved.delete(key);
      this.unsaved.delete(key);
      this.agentOnly.delete(key);
    }
    this.notify();
  }
  isUnsaved(key: string): boolean { return this.unsaved.has(key); }
  /**
   * Remove only the acknowledged prefix; edits within the sent text stay unsent. `send`: the one
   * sendOf named; null when that send was for a pane another herdr's has replaced, whose draft it
   * leaves alone.
   */
  settle(key: string, sent: string): { text: string; edited: boolean };
  settle(key: string, sent: string, send: number | undefined): { text: string; edited: boolean } | null;
  settle(key: string, sent: string, send?: number): { text: string; edited: boolean } | null {
    if (send !== undefined && this.sends.get(key)?.id !== send) return null;
    this.commands.delete(key);
    try { this.storage().removeItem(COMMAND_PREFIX + key); } catch {}
    this.refresh(key);
    const current = this.read(key).text;
    const editedMeanwhile = this.pending.get(key)?.edited === true;
    this.pending.delete(key);
    const edited = editedMeanwhile || current !== sent && !current.startsWith(sent);
    const text = edited ? current : current.slice(sent.length);
    this.set(key, text);
    return { text, edited };
  }
}
export const composerDrafts = new ComposerDraftStore();
/**
 * Runs `section` as the one cross-tab critical section of the draft `key`'s sends (#2369): a send's
 * claim (reading what goes, its lease, its payload) and its acknowledgement, and a pane move that
 * rekeys the draft, see no other tab's in between. localStorage has no compare-and-swap, so a
 * lease read and then written leaves two tabs a window to both send. Web Locks exist only in a
 * secure context: on plain HTTP (a LAN or Tailscale address) `section` runs at once, the lease
 * alone guarding as before. What `section` returned when it ran at once, else true (queued).
 */
export function underSendLock(key: string, section: () => boolean | void): boolean {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return section() !== false;
  let ran = false;
  // a lock manager that refuses the request (the spec allows a SecurityError) leaves the lease alone guarding, as plain HTTP does
  void locks.request(`ovis-send:${key}`, () => { ran = true; section(); }).catch((error: unknown) => {
    if (ran) throw error;
    section();
  });
  return true;
}
paneLifetimes.onRetire((machineId) => composerDrafts.forget(machineId));
export function storageEventDraft(key: string | null): string | null {
  if (key === null) return null;
  if (key.startsWith(SENDING_PREFIX)) return key.slice(SENDING_PREFIX.length);
  return key.startsWith("ovis:composer-draft:") ? key : null;
}
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  const key = storageEventDraft(event.key);
  if (key !== null) composerDrafts.refresh(key);
});
