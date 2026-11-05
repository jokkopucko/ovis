import { describe, expect, it } from "bun:test";
import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import { ComposerDraftStore } from "./composerDraft.ts";
import { PaneLifetimes } from "./paneLifetime.ts";
import { PendingMessageStore } from "./pendingMessages.ts";

class MemoryStorage implements Storage {
  readonly data = new Map<string, string>();
  /** writes to keys with this prefix throw, as a full or blocked storage does */
  refuse: string | null = null;
  get length(): number { return this.data.size; }
  key(index: number): string | null { return [...this.data.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (this.refuse !== null && key.startsWith(this.refuse)) throw new DOMException("full", "QuotaExceededError");
    this.data.set(key, value);
  }
  removeItem(key: string): void { this.data.delete(key); }
  clear(): void { this.data.clear(); }
}

const pane = (pane_id: string, label: string): HerdrPane => ({ pane_id, label } as HerdrPane);
const pc = (id: string, lifetime: string | undefined, panes: HerdrPane[] = [pane("w1:p1", "api")]): Machine =>
  ({ id, name: id, snapshot: { panes, ...(lifetime === undefined ? {} : { herdr_lifetime: lifetime }) } as unknown as SessionSnapshot } as Machine);
const title = (item: HerdrPane): string => item.label ?? item.pane_id;
let ids = 0;
const page = (storage: Storage): PaneLifetimes => new PaneLifetimes(() => storage, () => 1_000, () => `id-${++ids}`);

const DRAFT = "ovis:composer-draft:w1:p1";

describe("pane state per herdr lifetime", () => {
  it("keeps a pane's state across server restarts on one herdr, and leaves a replaced herdr's text to recovery", () => {
    const storage = new MemoryStorage();
    const first = page(storage);
    first.observe([pc("local", "herdr-a")], title);
    first.paneStorage.setItem(DRAFT, "for the old pane");
    first.paneStorage.setItem("ovis:view:w1:p1", "chat");
    first.paneStorage.setItem("ovis:terminal-draft:w1:p1", JSON.stringify({ text: "echo ", at: 1_000 }));
    first.paneStorage.setItem(`ovis:composer-sending:${DRAFT}`, JSON.stringify({ sent: "x", at: 1_000 }));
    storage.setItem("ovis:terminal-line:remote:pc2:w1%3Ap1", "another PC's line");
    // a server restart on the same herdr: a new page, the same lifetime
    const reloaded = page(storage);
    reloaded.observe([pc("local", "herdr-a")], title);
    expect(reloaded.paneStorage.getItem(DRAFT)).toBe("for the old pane");
    expect(reloaded.paneStorage.getItem("ovis:view:w1:p1")).toBe("chat");
    expect(reloaded.unsent()).toEqual([]);

    reloaded.observe([pc("local", "herdr-b", [pane("w1:p1", "a shell")])], title);
    for (const key of [DRAFT, "ovis:view:w1:p1", "ovis:terminal-draft:w1:p1", `ovis:composer-sending:${DRAFT}`]) {
      expect(reloaded.paneStorage.getItem(key)).toBeNull();
      expect(storage.getItem(key)).toBeNull();
    }
    expect(reloaded.unsent().map(({ machine_id, pane_id, pane_title, kind, text }) => ({ machine_id, pane_id, pane_title, kind, text })).sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { machine_id: "local", pane_id: "w1:p1", pane_title: "api", kind: "held", text: "echo " },
      { machine_id: "local", pane_id: "w1:p1", pane_title: "api", kind: "message", text: "for the old pane" },
    ]);
    expect(storage.getItem("ovis:terminal-line:remote:pc2:w1%3Ap1")).toBe("another PC's line");
    // the new herdr's panes write where they are read again
    reloaded.paneStorage.setItem(DRAFT, "for the new pane");
    expect(page(storage).paneStorage.getItem(DRAFT)).toBeNull();
    const next = page(storage);
    next.observe([pc("local", "herdr-b")], title);
    expect(next.paneStorage.getItem(DRAFT)).toBe("for the new pane");
  });

  it("keeps a PC whose snapshots name no lifetime in the page: never stored, kept across reconnects, recoverable once one is named", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    lifetimes.observe([pc("local", undefined)], title);
    lifetimes.paneStorage.setItem(DRAFT, "typed under an older bridge");
    lifetimes.paneStorage.setItem("ovis:view:w1:p1", "chat");
    expect([...storage.data.keys()]).toEqual([]);
    lifetimes.observe([pc("local", undefined)], title);
    expect(lifetimes.paneStorage.getItem(DRAFT)).toBe("typed under an older bridge");
    // the PC's server now names its herdr: what was typed before can no longer be told to be its panes'
    lifetimes.observe([pc("local", "herdr-a")], title);
    expect(lifetimes.paneStorage.getItem(DRAFT)).toBeNull();
    expect(lifetimes.unsent().map(({ kind, text }) => ({ kind, text }))).toEqual([{ kind: "message", text: "typed under an older bridge" }]);
  });

  it("leaves the stored state alone in a page that is behind another tab, and keeps that page's own typing for recovery", () => {
    const storage = new MemoryStorage();
    const ahead = page(storage), behind = page(storage);
    for (const tab of [ahead, behind]) tab.observe([pc("local", "herdr-a")], title);
    ahead.observe([pc("local", "herdr-b")], title);
    ahead.observe([pc("local", "herdr-c")], title);
    ahead.paneStorage.setItem(DRAFT, "for herdr-c's pane");
    // still drawing herdr-a's panes, the page behind neither reads nor writes herdr-c's state
    behind.observe([pc("local", "herdr-a")], title);
    expect(behind.paneStorage.getItem(DRAFT)).toBeNull();
    behind.paneStorage.setItem(DRAFT, "typed while behind");
    // nor does a herdr it reaches on its way take the state of the one the other tab is on
    behind.observe([pc("local", "herdr-b")], title);
    expect(storage.getItem(DRAFT)).toBe("for herdr-c's pane");
    behind.observe([pc("local", "herdr-c")], title);
    expect(behind.paneStorage.getItem(DRAFT)).toBe("for herdr-c's pane");
    expect(behind.unsent().map(({ text }) => text)).toEqual(["typed while behind"]);
  });

  it("leaves held and unconfirmed chat messages to recovery too, one record per message", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    lifetimes.observe([pc("local", "herdr-a")], title);
    storage.setItem("ovis:pending:w1:p1", JSON.stringify({ version: 1, messages: [{ id: "1", text: "deploy it" }, { id: "2", text: "and tag it" }] }));
    storage.setItem("ovis:queue:w1:p1", "an older queued line");
    lifetimes.observe([pc("local", "herdr-b")], title);
    expect(storage.getItem("ovis:pending:w1:p1")).toBeNull();
    expect(storage.getItem("ovis:queue:w1:p1")).toBeNull();
    expect(lifetimes.unsent().map(({ kind, text }) => `${kind}:${text}`).sort()).toEqual(["pending:an older queued line", "pending:and tag it", "pending:deploy it"]);
  });

  it("keeps a message an older bridge took with no receipt for recovery across a reload, never back in the reused pane id (#2172)", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    const pending = new PendingMessageStore(() => lifetimes.paneStorage, lifetimes);
    lifetimes.onRetire((machineId) => pending.forget(machineId));
    lifetimes.observe([pc("local", undefined)], title);
    pending.keepUnconfirmed("w1:p1", "deploy the fix");
    expect(pending.read("w1:p1")).toMatchObject([{ text: "deploy the fix", state: "uncertain" }]);
    // the composer is empty and the row is in this page alone: a reload keeps the text in recovery
    const reloaded = page(storage);
    const after = new PendingMessageStore(() => reloaded.paneStorage, reloaded);
    reloaded.observe([pc("local", undefined)], title);
    expect(after.read("w1:p1")).toEqual([]);
    expect(reloaded.unsent().map(({ machine_id, pane_id, pane_title, kind, text }) => ({ machine_id, pane_id, pane_title, kind, text }))).toEqual([
      { machine_id: "local", pane_id: "w1:p1", pane_title: "api", kind: "pending", text: "deploy the fix" },
    ]);
    // the PC's server names its herdr later: the page's row goes to recovery, where its text already is
    lifetimes.observe([pc("local", "herdr-a")], title);
    expect(pending.read("w1:p1")).toEqual([]);
    expect(lifetimes.unsent().map(({ text }) => text)).toEqual(["deploy the fix"]);
  });

  it("gives each unconfirmed row its own recovery record: discarding one never takes another tab's, or an older one with the same words", () => {
    const storage = new MemoryStorage();
    const [a, b] = [page(storage), page(storage)];
    const [pendingA, pendingB] = [new PendingMessageStore(() => a.paneStorage, a), new PendingMessageStore(() => b.paneStorage, b)];
    for (const tab of [a, b]) tab.observe([pc("local", undefined)], title);
    storage.setItem("ovis:unsent:older", JSON.stringify({ machine_id: "local", pane_id: "w1:p1", kind: "pending", text: "yes", at: 1 }));
    pendingA.keepUnconfirmed("w1:p1", "yes");
    pendingB.keepUnconfirmed("w1:p1", "yes");
    expect(a.unsent()).toHaveLength(3);
    pendingA.removeCopy("w1:p1", pendingA.read("w1:p1")[0]!.id);
    // tab B's row and the older record still have their text after a reload
    const reloaded = page(storage);
    reloaded.observe([pc("local", undefined)], title);
    expect(reloaded.unsent().map(({ text }) => text)).toEqual(["yes", "yes"]);
    expect(reloaded.unsent().some((item) => item.id === "older")).toBe(true);
  });

  it("drops the recovery copy of an unconfirmed row discarded in the same page, and makes one for a stored PC only when storage refuses the row", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    const pending = new PendingMessageStore(() => lifetimes.paneStorage, lifetimes);
    lifetimes.observe([pc("local", undefined, [pane("w1:p1", "api"), pane("w1:p2", "web")])], title);
    pending.keepUnconfirmed("w1:p1", "yes");
    pending.keepUnconfirmed("w1:p1", "yes");
    pending.keepUnconfirmed("w1:p2", "no");
    // the same words sent twice are two messages: one record each
    expect(lifetimes.unsent().map(({ pane_id, text }) => `${pane_id}=${text}`).sort()).toEqual(["w1:p1=yes", "w1:p1=yes", "w1:p2=no"]);
    const [first, second] = pending.read("w1:p1");
    pending.removeCopy("w1:p1", first!.id);
    expect(lifetimes.unsent().map(({ pane_id, text }) => `${pane_id}=${text}`).sort()).toEqual(["w1:p1=yes", "w1:p2=no"]);
    pending.removeCopy("w1:p1", second!.id);
    expect(lifetimes.unsent().map(({ pane_id, text }) => `${pane_id}=${text}`)).toEqual(["w1:p2=no"]);

    // storage that refuses the row on a stored PC: the row is in this page alone, its text in recovery
    const full = new MemoryStorage();
    const refusing = page(full);
    const unsaved = new PendingMessageStore(() => refusing.paneStorage, refusing);
    refusing.observe([pc("local", "herdr-a")], title);
    full.refuse = "ovis:pending:";
    unsaved.keepUnconfirmed("w1:p1", "deploy the fix");
    expect(unsaved.isUnsaved("w1:p1")).toBe(true);
    expect(refusing.unsent().map(({ kind, text }) => `${kind}:${text}`)).toEqual(["pending:deploy the fix"]);

    const stored = new MemoryStorage();
    const proven = page(stored);
    const kept = new PendingMessageStore(() => proven.paneStorage, proven);
    proven.observe([pc("local", "herdr-a")], title);
    kept.keepUnconfirmed("w1:p1", "deploy the fix");
    expect(proven.unsent()).toEqual([]);
    expect(new PendingMessageStore(() => proven.paneStorage, proven).read("w1:p1")).toMatchObject([{ text: "deploy the fix", state: "uncertain" }]);
  });

  it("drops an unconfirmed row's recovery copy once storage takes the row on the same herdr, so a reload offers it once", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    const pending = new PendingMessageStore(() => lifetimes.paneStorage, lifetimes);
    lifetimes.onRetire((machineId) => pending.forget(machineId));
    storage.refuse = "ovis:pane-lifetime:";
    lifetimes.observe([pc("local", "herdr-a")], title);
    pending.keepUnconfirmed("w1:p1", "deploy the fix");
    expect(lifetimes.unsent().map(({ text }) => text)).toEqual(["deploy the fix"]);
    storage.refuse = null;
    lifetimes.observe([pc("local", "herdr-a")], title);
    expect(lifetimes.stored("local")).toBe(true);
    const reloaded = page(storage);
    reloaded.observe([pc("local", "herdr-a")], title);
    expect(new PendingMessageStore(() => reloaded.paneStorage, reloaded).read("w1:p1")).toMatchObject([{ text: "deploy the fix", state: "uncertain" }]);
    expect(reloaded.unsent()).toEqual([]);
  });

  it("drops the recovery copy of a row storage refused once a later write saves it, so a reload offers it once", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    const pending = new PendingMessageStore(() => lifetimes.paneStorage, lifetimes);
    lifetimes.onRetire((machineId) => pending.forget(machineId));
    lifetimes.observe([pc("local", "herdr-a")], title);
    storage.refuse = "ovis:pending:";
    pending.keepUnconfirmed("w1:p1", "first");
    expect(lifetimes.unsent().map(({ text }) => text)).toEqual(["first"]);
    // storage has room again: the next message's write saves the whole list, the first row with it
    storage.refuse = null;
    pending.keepUnconfirmed("w1:p1", "second");
    expect(lifetimes.unsent()).toEqual([]);
    const reloaded = page(storage);
    reloaded.observe([pc("local", "herdr-a")], title);
    const after = new PendingMessageStore(() => reloaded.paneStorage, reloaded);
    const [first] = after.read("w1:p1");
    expect(after.read("w1:p1").map(({ text }) => text)).toEqual(["first", "second"]);
    after.removeCopy("w1:p1", first!.id);
    expect(after.read("w1:p1").map(({ text }) => text)).toEqual(["second"]);
    expect(reloaded.unsent()).toEqual([]);
  });

  it("never rolls the stored state back to a herdr it outlived, and follows one that came after", () => {
    const storage = new MemoryStorage();
    const ahead = page(storage);
    ahead.observe([pc("local", "herdr-a")], title);
    ahead.observe([pc("local", "herdr-b")], title);
    ahead.paneStorage.setItem(DRAFT, "for herdr-b's pane");
    // a fresh tab handed an older roster: it keeps to the page, herdr-b's text stays where it is
    const stale = page(storage);
    stale.observe([pc("local", "herdr-a")], title);
    expect(storage.getItem(DRAFT)).toBe("for herdr-b's pane");
    expect(stale.paneStorage.getItem(DRAFT)).toBeNull();
    // a tab that missed herdr-b, once the tab that saw it is gone, still follows herdr-c
    stale.observe([pc("local", "herdr-c")], title);
    expect(stale.stored("local")).toBe(true);
    expect(stale.unsent().map(({ text }) => text)).toEqual(["for herdr-b's pane"]);
  });

  it("sends text an earlier release stored, for a herdr nothing proves, to recovery, and keeps its lenses", () => {
    const storage = new MemoryStorage();
    storage.setItem(DRAFT, "typed before this release");
    storage.setItem("ovis:view:w1:p1", "chat");
    storage.setItem("ovis:terminal-draft:w1:p1", JSON.stringify({ text: "echo ", at: 1_000 }));
    storage.setItem(`ovis:composer-sending:${DRAFT}`, JSON.stringify({ sent: "x", at: 1_000 }));
    const lifetimes = page(storage);
    lifetimes.observe([pc("local", "herdr-a")], title);
    expect(lifetimes.paneStorage.getItem(DRAFT)).toBeNull();
    expect(storage.getItem(`ovis:composer-sending:${DRAFT}`)).toBeNull();
    expect(lifetimes.paneStorage.getItem("ovis:view:w1:p1")).toBe("chat");
    expect(storage.getItem("ovis:pane-lifetime:local")).toBe("herdr-a");
    expect(lifetimes.unsent().map(({ kind, text }) => `${kind}:${text}`).sort()).toEqual(["held:echo ", "message:typed before this release"]);
    // a reload on the same herdr finds the record: nothing more leaves the panes
    const reloaded = page(storage);
    reloaded.observe([pc("local", "herdr-a")], title);
    reloaded.paneStorage.setItem(DRAFT, "typed after");
    page(storage).observe([pc("local", "herdr-a")], title);
    expect(storage.getItem(DRAFT)).toBe("typed after");
    expect(reloaded.unsent()).toHaveLength(2);
  });

  it("gives the panes of a snapshot naming no herdr none of the stored state, gives the proven state back once that herdr is named again, and leaves what was typed meanwhile to recovery", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    lifetimes.observe([pc("local", "herdr-a")], title);
    lifetimes.paneStorage.setItem(DRAFT, "for herdr a's pane");
    // a read that could not prove its herdr: its panes may be a replacement's under the same IDs
    lifetimes.observe([pc("local", undefined)], title);
    expect(lifetimes.paneStorage.getItem(DRAFT)).toBeNull();
    lifetimes.paneStorage.setItem("ovis:terminal-line:w1:p1", "typed meanwhile");
    expect(storage.getItem(DRAFT)).toBe("for herdr a's pane");
    expect(storage.getItem("ovis:terminal-line:w1:p1")).toBeNull();
    // herdr a named again: its own text is back, and what was typed with no proof of the panes' herdr is not adopted
    lifetimes.observe([pc("local", "herdr-a")], title);
    expect(lifetimes.paneStorage.getItem(DRAFT)).toBe("for herdr a's pane");
    expect(lifetimes.paneStorage.getItem("ovis:terminal-line:w1:p1")).toBeNull();
    expect(lifetimes.unsent().map(({ text }) => text)).toEqual(["typed meanwhile"]);
    // unproven again, then another herdr named: neither the stored text nor what was typed meanwhile reaches its panes
    lifetimes.observe([pc("local", undefined)], title);
    lifetimes.paneStorage.setItem("ovis:terminal-line:w1:p2", "typed while unproven");
    lifetimes.observe([pc("local", "herdr-b")], title);
    expect(lifetimes.paneStorage.getItem(DRAFT)).toBeNull();
    expect(lifetimes.paneStorage.getItem("ovis:terminal-line:w1:p1")).toBeNull();
    expect(lifetimes.paneStorage.getItem("ovis:terminal-line:w1:p2")).toBeNull();
    expect(lifetimes.unsent().map(({ text }) => text).sort()).toEqual(["for herdr a's pane", "typed meanwhile", "typed while unproven"]);
    // a late read naming herdr a is stale
    lifetimes.observe([pc("local", "herdr-a")], title);
    expect(lifetimes.generation("local")).toBe("herdr-b");
  });

  it("settles a send begun for a pane of the herdr before nothing in the draft its pane ID holds now", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    const drafts = new ComposerDraftStore(() => lifetimes.paneStorage, undefined, () => lifetimes.generation("local"));
    lifetimes.onRetire((machineId) => drafts.forget(machineId, lifetimes));
    lifetimes.observe([pc("local", "herdr-a")], title);
    drafts.set(DRAFT, "deploy");
    expect(drafts.begin(DRAFT, "deploy")).toBe(true);
    const send = drafts.sendOf(DRAFT);
    lifetimes.observe([pc("local", "herdr-b")], title);
    // the new pane's box is free, and what is typed there is its own
    expect(drafts.read(DRAFT).sending).toBe(false);
    drafts.set(DRAFT, "deploy new target");
    expect(drafts.begin(DRAFT, "deploy new target")).toBe(true);
    const next = drafts.sendOf(DRAFT);
    // the earlier herdr's acknowledgement and end arrive late
    expect(drafts.settle(DRAFT, "deploy", send)).toBeNull();
    drafts.end(DRAFT, send);
    expect(drafts.read(DRAFT)).toEqual({ text: "deploy new target", sending: true });
    expect(drafts.settle(DRAFT, "deploy new target", next)).toEqual({ text: "", edited: false });
    drafts.end(DRAFT, next);
    expect(drafts.read(DRAFT).sending).toBe(false);
  });

  it("keeps text in this page for recovery when storage refuses its record, or refused the edit itself", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    const drafts = new ComposerDraftStore(() => lifetimes.paneStorage);
    lifetimes.onRetire((machineId) => drafts.forget(machineId, lifetimes));
    lifetimes.observe([pc("local", "herdr-a")], title);
    storage.setItem("ovis:terminal-line:w1:p1", "make release");
    storage.refuse = DRAFT;
    drafts.set(DRAFT, "an edit storage refused");
    storage.refuse = "ovis:unsent:";
    lifetimes.observe([pc("local", "herdr-b")], title);
    expect(storage.getItem("ovis:terminal-line:w1:p1")).toBeNull();
    expect(lifetimes.unsent().map(({ kind, text }) => `${kind}:${text}`).sort()).toEqual(["line:make release", "message:an edit storage refused"]);
    lifetimes.discard(lifetimes.unsent()[0]!.id);
    expect(lifetimes.unsent()).toHaveLength(1);
  });

  it("stores what the page kept while storage refused its record once storage takes it on the same herdr, leaving only another tab's text to recovery", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    storage.refuse = "ovis:pane-lifetime:";
    lifetimes.observe([pc("local", "herdr-a", [pane("w1:p1", "api"), pane("w1:p2", "web")])], title);
    expect(lifetimes.stored("local")).toBe(false);
    lifetimes.paneStorage.setItem("ovis:terminal-draft:w1:p1", JSON.stringify({ text: "echo held", at: 1_000 }));
    lifetimes.paneStorage.setItem("ovis:view:w1:p1", "chat");
    lifetimes.paneStorage.setItem("ovis:terminal-line:w1:p2", "typed here");
    storage.refuse = null;
    // meanwhile another tab, whose storage took the record, kept its own line for that pane under the same herdr
    storage.setItem("ovis:pane-lifetime:local", "herdr-a");
    storage.setItem("ovis:terminal-line:w1:p2", "typed in another tab");
    lifetimes.observe([pc("local", "herdr-a", [pane("w1:p1", "api"), pane("w1:p2", "web")])], title);
    expect(lifetimes.stored("local")).toBe(true);
    expect(storage.getItem("ovis:terminal-draft:w1:p1")).toBe(JSON.stringify({ text: "echo held", at: 1_000 }));
    expect(storage.getItem("ovis:view:w1:p1")).toBe("chat");
    expect(storage.getItem("ovis:terminal-line:w1:p2")).toBe("typed in another tab");
    expect(lifetimes.unsent().map(({ kind, text }) => `${kind}:${text}`)).toEqual(["line:typed here"]);
  });

  it("follows a runtime switch back to a herdr the page left, and never shows one runtime's draft in the other's pane", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    lifetimes.observe([pc("local", "herdr-tui")], title);
    lifetimes.runtimeSwitched("local");
    lifetimes.observe([pc("local", "herdr-core")], title);
    lifetimes.paneStorage.setItem(DRAFT, "typed on core p1");
    // switched back in place: the TUI's snapshot is no stale read
    lifetimes.runtimeSwitched("local");
    lifetimes.observe([pc("local", "herdr-tui")], title);
    expect(lifetimes.generation("local")).toBe("herdr-tui");
    expect(lifetimes.stored("local")).toBe(true);
    expect(lifetimes.paneStorage.getItem(DRAFT)).toBeNull();
    lifetimes.paneStorage.setItem(DRAFT, "typed on herdr p1");
    lifetimes.runtimeSwitched("local");
    lifetimes.observe([pc("local", "herdr-core")], title);
    expect(lifetimes.generation("local")).toBe("herdr-core");
    expect(lifetimes.paneStorage.getItem(DRAFT)).toBeNull();
    // neither text is lost: both wait in recovery
    expect(lifetimes.unsent().map(({ text }) => text).sort()).toEqual(["typed on core p1", "typed on herdr p1"]);
  });

  it("lets another page follow a switch back too, once storage says the switching page cleared its history", () => {
    const storage = new MemoryStorage();
    const clicked = page(storage);
    const other = page(storage);
    for (const lifetimes of [clicked, other]) lifetimes.observe([pc("local", "herdr-tui")], title);
    for (const lifetimes of [clicked, other]) lifetimes.observe([pc("local", "herdr-core")], title);
    other.paneStorage.setItem(DRAFT, "core draft");
    // the page that switched back clears the history; the other hears of it as a storage event
    clicked.runtimeSwitched("local");
    other.storageChanged("ovis:pane-lifetimes-retired:local");
    for (const lifetimes of [clicked, other]) lifetimes.observe([pc("local", "herdr-tui")], title);
    expect(other.generation("local")).toBe("herdr-tui");
    expect(other.paneStorage.getItem(DRAFT)).toBeNull();
    expect(other.unsent().map(({ text }) => text)).toEqual(["core draft"]);
  });

  it("lets a page on another device follow a switch back once its health names the runtime, in storage too", () => {
    const storage = new MemoryStorage();
    const device = page(storage);
    device.observe([pc("local", "herdr-tui")], title);
    device.observe([pc("local", "herdr-core")], title);
    device.paneStorage.setItem(DRAFT, "for core");
    // another device switched back: this one's health names herdr's TUI again before its roster does
    device.runtimeChanged("local");
    device.observe([pc("local", "herdr-tui")], title);
    expect([device.generation("local"), device.stored("local"), device.paneStorage.getItem(DRAFT)]).toEqual(["herdr-tui", true, null]);
    device.paneStorage.setItem(DRAFT, "for tui");
    // kept in storage, so a reload still has it
    expect(page(storage).paneStorage.getItem(DRAFT) ?? storage.getItem(DRAFT)).toBe("for tui");
    expect(device.unsent().map(({ text }) => text)).toEqual(["for core"]);
  });

  it("follows a switch back on another device when its roster comes before its health", () => {
    const storage = new MemoryStorage();
    const device = page(storage);
    device.observe([pc("local", "herdr-tui")], title);
    device.observe([pc("local", "herdr-core")], title);
    device.paneStorage.setItem(DRAFT, "core draft");
    // the TUI's snapshot first, taken for a stale read; then the health read names the TUI
    device.observe([pc("local", "herdr-tui")], title);
    device.runtimeChanged("local");
    expect([device.generation("local"), device.paneStorage.getItem(DRAFT)]).toEqual(["herdr-tui", null]);
    expect(device.unsent().map(({ text }) => text)).toEqual(["core draft"]);
  });

  it("takes a read from a herdr the page already moved on from as stale, not as a herdr to go back to", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    lifetimes.observe([pc("local", "herdr-a")], title);
    lifetimes.paneStorage.setItem(DRAFT, "for herdr a's pane");
    // the PC's connection names the new herdr first (lib/machineSession.ts), without titles
    lifetimes.observe([pc("local", "herdr-b")]);
    lifetimes.paneStorage.setItem(DRAFT, "for herdr b's pane");
    // then a roster read before the replacement arrives
    lifetimes.observe([pc("local", "herdr-a")], title);
    expect(lifetimes.generation("local")).toBe("herdr-b");
    expect(lifetimes.stored("local")).toBe(true);
    expect(storage.getItem(DRAFT)).toBe("for herdr b's pane");
    expect(lifetimes.unsent().map(({ text, pane_title }) => `${pane_title}:${text}`)).toEqual(["api:for herdr a's pane"]);
  });

  it("empties a draft store's copy in the render that names another herdr, and Discard removes recovered text", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    const drafts = new ComposerDraftStore(() => lifetimes.paneStorage);
    lifetimes.onRetire((machineId) => drafts.forget(machineId, lifetimes));
    lifetimes.observe([pc("local", "herdr-a")], title);
    drafts.set(DRAFT, "half a sentence");
    expect(drafts.read(DRAFT).text).toBe("half a sentence");
    lifetimes.observe([pc("local", "herdr-b")], title);
    expect(drafts.read(DRAFT).text).toBe("");
    const [kept] = lifetimes.unsent();
    expect(kept?.text).toBe("half a sentence");
    lifetimes.discard(kept!.id);
    expect(lifetimes.unsent()).toEqual([]);
  });
});

// #511: a herdr restart keeps a message for an agent alone for recovery as one, edited or queued
it("keeps the agent-only flag of a retired draft and of each retired queued message", () => {
  const storage = new MemoryStorage();
  const lifetimes = page(storage);
  lifetimes.observe([pc("local", "herdr-a")], title);
  lifetimes.paneStorage.setItem(DRAFT, "rm backup.txt");
  lifetimes.paneStorage.setItem("ovis:composer-agent-only:w1:p1", "1");
  lifetimes.paneStorage.setItem("ovis:pending:w1:p1", JSON.stringify({ version: 1, messages: [
    { id: "1", text: "queued for the agent", agent_only: true, state: "held", request_id: 1, created_at: "now" },
    { id: "2", text: "queued plainly", state: "held", request_id: 2, created_at: "now" },
  ] }));
  lifetimes.observe([pc("local", "herdr-b")], title);
  const flag = (text: string) => lifetimes.unsent().find((item) => item.text === text)?.agent_only;
  expect(flag("rm backup.txt")).toBe(true);
  expect(flag("queued for the agent")).toBe(true);
  expect(flag("queued plainly")).toBeUndefined();
});
