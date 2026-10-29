import { paneLifetimes, paneStateKey, type PaneLifetimes } from "./paneLifetime.ts";

/** Drafts and in-flight sends belong to their pane, even while its composer is unmounted. */
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
/** a draft that holds an agent-only message put back by Edit (#511): it is sent `agent_only` until the box is emptied */
export const AGENT_ONLY_PREFIX = "ovis:composer-agent-only:";
const agentOnlyKey = (key: string): string => AGENT_ONLY_PREFIX + (key.startsWith(DRAFT_PREFIX) ? key.slice(DRAFT_PREFIX.length) : key);
export class ComposerDraftStore {
  private drafts = new Map<string, Draft>();
  private saved = new Map<string, string | null>();
  private unsaved = new Set<string>();
  /** drafts this page put back as agent-only messages (#511): kept here even when storage refuses the mark */
  private agentOnly = new Set<string>();
  /** the text each pending send carries, and whether the draft stopped extending it meanwhile */
  private pending = new Map<string, { sent: string; edited: boolean }>();
  private listeners = new Set<() => void>();
  /** the drafts this tab itself is sending: another tab's lease is read from storage */
  private own = new Set<string>();
  /** one wake-up per draft at the end of another tab's lease: an abandoned lease ends silently */
  private expiries = new Map<string, unknown>();
  /** this tab's send on each draft, and the herdr its pane was drawn under when it began */
  private sends = new Map<string, { id: number; lifetime: string | null | undefined }>();
  private sendCount = 0;
  constructor(
    // the pane's herdr's storage, or this page's memory (lib/paneLifetime.ts)
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
      try { text = this.storage().getItem(key); } catch { /* private mode */ }
      this.saved.set(key, text);
      draft = { text: text ?? "", sending: false };
      this.drafts.set(key, draft);
    }
    return draft;
  }
  /** The send another tab has in flight, or null: absent, expired, or this tab's own. */
  private inFlight(key: string): InFlight | null {
    try {
      const raw = this.storage().getItem(SENDING_PREFIX + key);
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
    if (text === this.saved.get(key) && sending === draft.sending) return;
    if (text !== this.saved.get(key)) {
      // another tab changed it while a send was on its way: the same rule as a local edit
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
    // cleared and retyped while on its way, a draft can end up starting with the sent text
    // again: once it stopped extending it, the whole of it is the user's own
    const pending = this.pending.get(key);
    if (pending && !text.startsWith(pending.sent)) pending.edited = true;
    this.drafts.set(key, { ...draft, text });
    if (!text) this.agentOnly.delete(key);
    try {
      if (text) this.storage().setItem(key, text);
      else { this.storage().removeItem(key); this.storage().removeItem(agentOnlyKey(key)); }
      this.saved.set(key, text || null);
      this.unsaved.delete(key);
    } catch { this.unsaved.add(key); }
    this.notify();
  }
  /** A withdrawn queue row joins the latest draft without replacing attachment mentions or
   * concurrent typing. Never truncate recovered input: an oversized draft can be edited down. */
  restorePending(key: string, text: string, agentOnly = false): void {
    // its `> quote` lines must never reach a shell: the box stays agent-only until it is emptied, in this
    // page whatever storage does, and marked before the text is there to send
    if (agentOnly) this.markAgentOnly(key);
    this.refresh(key);
    this.set(key, (draft) => draft ? `${draft}\n\n${text}` : text);
  }
  private markAgentOnly(key: string): void {
    this.agentOnly.add(key);
    try { this.storage().setItem(agentOnlyKey(key), "1"); } catch { /* storage refused: this page's mark still holds */ }
  }
  /** The draft holds a message for an agent alone, put back by Edit (here or in another tab). */
  isAgentOnly(key: string): boolean {
    if (this.agentOnly.has(key)) return true;
    try { return this.storage().getItem(agentOnlyKey(key)) !== null; } catch { return false; }
  }
  /** `sent`: the draft text this send carries, settled once it is acknowledged */
  begin(key: string, sent?: string): boolean {
    const draft = this.read(key);
    // a send another tab has in flight is a send, not a draft: it blocks this one too, until its
    // lease runs out (a tab that closed mid-send never ends it)
    if (this.own.has(key) || this.inFlight(key) !== null) return false;
    this.own.add(key);
    this.sends.set(key, { id: ++this.sendCount, lifetime: this.lifetimeOf(key) });
    if (sent !== undefined) this.pending.set(key, { sent, edited: false });
    this.drafts.set(key, { ...draft, sending: true });
    // the lease, so a second tab on this pane sees the send instead of the text it carries
    try { this.storage().setItem(SENDING_PREFIX + key, JSON.stringify({ sent: sent ?? "", at: Date.now() })); }
    catch { /* private mode: the flag stays this tab's alone */ }
    this.notify();
    return true;
  }
  /** The send this tab began on the draft: its settle and end name it (lib/paneLifetime.ts, #1608). */
  sendOf(key: string): number | undefined { return this.sends.get(key)?.id; }
  /** `send`: the one sendOf named; a send another herdr's pane outlived ends nothing here */
  end(key: string, send?: number): void {
    if (send !== undefined && this.sends.get(key)?.id !== send) return;
    this.sends.delete(key);
    this.pending.delete(key);
    this.own.delete(key);
    try { this.storage().removeItem(SENDING_PREFIX + key); } catch { /* private mode */ }
    this.drafts.set(key, { ...this.read(key), sending: false });
    this.notify();
  }
  /**
   * herdr gave the draft's pane a new ID (lib/paneMove.ts): the text goes to the new key. A send of
   * it on its way, from this tab or another, stays with the ID it went under, and a new key that
   * holds a draft already keeps its own.
   */
  move(from: string, to: string): void {
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
      // an edit storage refused lives only here: it goes to recovery, not away
      if (this.unsaved.has(key)) lifetimes.keep(machineId, pane.paneId, "message", draft.text);
      this.drafts.delete(key);
      this.saved.delete(key);
      this.unsaved.delete(key);
      this.agentOnly.delete(key);
    }
    this.notify();
  }
  /** The draft's latest text could not be saved: it is in this page only. */
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
paneLifetimes.onRetire((machineId) => composerDrafts.forget(machineId));
/**
 * The draft a `storage` event from another tab concerns, or null. A send is begun and ended as
 * well as edited, so both keys reconcile the one draft: a sending key names it after its prefix,
 * a draft key is the draft's own.
 */
export function storageEventDraft(key: string | null): string | null {
  if (key === null) return null;
  if (key.startsWith(SENDING_PREFIX)) return key.slice(SENDING_PREFIX.length);
  return key.startsWith("ovis:composer-draft:") ? key : null;
}
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  const key = storageEventDraft(event.key);
  if (key !== null) composerDrafts.refresh(key);
});
