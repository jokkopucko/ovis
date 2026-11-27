import { describe, expect, it } from "bun:test";
import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import { ComposerDraftStore } from "./composerDraft.ts";
import { DRAFT_TTL_MS } from "./draft.ts";
import { PaneLifetimes, UNSENT_UNDO_WINDOW_MS, type UndoTimers } from "./paneLifetime.ts";
import { PendingMessageStore } from "./pendingMessages.ts";
import { messageWithComments } from "./replyComments.ts";

class MemoryStorage implements Storage {
  readonly data = new Map<string, string>();
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

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const undoTimers: UndoTimers = {
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id as number); },
  };
  return {
    timers: undoTimers,
    pending: () => timers.size,
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = until;
    },
  };
}

const page = (storage: Storage, timers: UndoTimers = fakeClock().timers): PaneLifetimes => new PaneLifetimes(() => storage, () => 1_000, () => `id-${++ids}`, timers);

const DRAFT = "ovis:composer-draft:w1:p1";

describe("pane state per herdr lifetime", () => {
  it("keeps a pane's reply comments for Recover unsent text when herdr is replaced, as the message they would have gone with (#3259)", () => {
    const storage = new MemoryStorage();
    const lifetimes = new PaneLifetimes(() => storage, () => 1_000, () => `id-${++ids}`);
    lifetimes.observe([pc("local", "herdr-a")], title);
    lifetimes.paneStorage.setItem("ovis:composer-draft:w1:p1", "please look at these");
    lifetimes.paneStorage.setItem("ovis:reply-comments:w1:p1", JSON.stringify([{ id: "c1", quote: "the retry loop", comment: "this should back off" }, { id: "c2", quote: "line 2", comment: "and this" }]));
    lifetimes.observe([pc("local", "herdr-b")], title);
    expect(storage.getItem("ovis:reply-comments:w1:p1")).toBeNull();
    const comments = [{ id: "c1", quote: "the retry loop", comment: "this should back off" }, { id: "c2", quote: "line 2", comment: "and this" }];
    expect(lifetimes.unsent().map(({ kind, text }) => ({ kind, text }))).toEqual(expect.arrayContaining([
      { kind: "message", text: "please look at these" },
      { kind: "message", text: messageWithComments(comments, "") },
    ]));
    expect(lifetimes.unsent()).toHaveLength(2);
  });

  it("keeps nothing for a pane with no reply comments, or a list that holds none", () => {
    const storage = new MemoryStorage();
    const lifetimes = new PaneLifetimes(() => storage, () => 1_000, () => `id-${++ids}`);
    lifetimes.observe([pc("local", "herdr-a")], title);
    lifetimes.paneStorage.setItem("ovis:reply-comments:w1:p1", "[]");
    lifetimes.observe([pc("local", "herdr-b")], title);
    expect(lifetimes.unsent()).toEqual([]);
  });

  it("keeps display-dismissed IDs on the same herdr without recovering their text, then retires only that lifetime's marks", () => {
    const storage = new MemoryStorage(), lifetimes = page(storage);
    lifetimes.observe([pc("local", "dismiss-herdr-a")], title);
    const store = new PendingMessageStore(() => lifetimes.paneStorage, lifetimes);
    lifetimes.onRetire(machine => store.forget(machine));
    const copy = { id: "dismissed-id", request_id: 1, text: "already sent", state: "uncertain" as const, created_at: "2026-11-17T00:00:00Z" };
    lifetimes.paneStorage.setItem(DRAFT, "keep this draft");
    store.accept("w1:p1", copy, "scope");
    expect(store.dismissCopy("w1:p1", copy.id)).toBe(true);
    const reloaded = page(storage); reloaded.observe([pc("local", "dismiss-herdr-a")], title);
    const restored = new PendingMessageStore(() => reloaded.paneStorage, reloaded);
    restored.accept("w1:p1", copy, null);
    expect(restored.read("w1:p1")).toEqual([]);
    expect(reloaded.paneStorage.getItem(DRAFT)).toBe("keep this draft");
    lifetimes.observe([pc("local", "dismiss-herdr-b")], title);
    expect(lifetimes.unsent().map(item => item.text)).toEqual(["keep this draft"]);
    // The recycled pane ID in another herdr does not inherit display tombstones.
    store.accept("w1:p1", copy, null);
    expect(store.read("w1:p1")).toMatchObject([{ id: copy.id }]);
  });
  it("never offers a dismissed ID's text for recovery, also once a connection listed that row again", () => {
    const storage = new MemoryStorage(), lifetimes = page(storage);
    lifetimes.observe([pc("local", "dismiss-live-a")], title);
    const store = new PendingMessageStore(() => lifetimes.paneStorage, lifetimes);
    lifetimes.onRetire(machine => store.forget(machine));
    const copy = { id: "dismissed-live", request_id: 1, text: "dismissed once", state: "uncertain" as const, created_at: "2026-11-17T00:00:00Z" };
    store.accept("w1:p1", copy, "scope");
    expect(store.dismissCopy("w1:p1", copy.id)).toBe(true);
    store.publish("w1:p1", [copy, { ...copy, id: "still-queued", text: "never dismissed", state: "queued" }], [], "scope");
    expect(store.read("w1:p1").map(row => row.id)).toEqual([copy.id, "still-queued"]);
    lifetimes.observe([pc("local", "dismiss-live-b")], title);
    expect(lifetimes.unsent().map(item => item.text)).toEqual(["never dismissed"]);
  });
  it("keeps a pane's state across server restarts on one herdr, and leaves a replaced herdr's text to recovery", () => {
    const storage = new MemoryStorage();
    const first = page(storage);
    first.observe([pc("local", "herdr-a")], title);
    first.paneStorage.setItem(DRAFT, "for the old pane");
    first.paneStorage.setItem("ovis:view:w1:p1", "chat");
    first.paneStorage.setItem("ovis:terminal-draft:w1:p1", JSON.stringify({ text: "echo ", at: 1_000 }));
    first.paneStorage.setItem(`ovis:composer-sending:${DRAFT}`, JSON.stringify({ sent: "x", at: 1_000 }));
    storage.setItem("ovis:terminal-line:remote:pc2:w1%3Ap1", "another PC's line");
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
    reloaded.paneStorage.setItem(DRAFT, "for the new pane");
    expect(page(storage).paneStorage.getItem(DRAFT)).toBeNull();
    const next = page(storage);
    next.observe([pc("local", "herdr-b")], title);
    expect(next.paneStorage.getItem(DRAFT)).toBe("for the new pane");
  });

  it("offers a replaced herdr's card text in recovery after a reload, and a tab behind another never overwrites the current herdr's", () => {
    const CARD = "ovis:card-text:w1:p1";
    const card = (text: string): string => JSON.stringify({ machineId: "local", paneId: "w1:p1", session: "session-a", promptId: "q1", text });
    const storage = new MemoryStorage();
    const old = page(storage);
    old.observe([pc("local", "herdr-a")], title);
    old.paneStorage.setItem(CARD, card("my unsent card answer"));
    const reloaded = page(storage);
    reloaded.observe([pc("local", "herdr-b")], title);
    expect(reloaded.paneStorage.getItem(CARD)).toBeNull();
    expect(reloaded.unsent().map(({ pane_id, kind, text }) => ({ pane_id, kind, text }))).toEqual([{ pane_id: "w1:p1", kind: "message", text: "my unsent card answer" }]);
    reloaded.paneStorage.setItem(CARD, card("new runtime answer"));
    old.paneStorage.setItem(CARD, card("stale tab answer"));
    expect(storage.getItem(CARD)).toBe(card("new runtime answer"));
    expect(old.paneStorage.getItem(CARD)).toBe(card("stale tab answer"));
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
    lifetimes.observe([pc("local", "herdr-a")], title);
    expect(lifetimes.paneStorage.getItem(DRAFT)).toBeNull();
    expect(lifetimes.unsent().map(({ kind, text }) => ({ kind, text }))).toEqual([{ kind: "message", text: "typed under an older bridge" }]);
  });

  it("leaves an older bridge's pane state to recovery in the next page when the app replaces this one, never sent, taken once", () => {
    const storage = new MemoryStorage();
    const HELD = "ovis:terminal-draft:remote:pc2:w1%3Ap1";
    const leaving = page(storage);
    leaving.observe([pc("local", undefined), pc("pc2", undefined)], title);
    leaving.paneStorage.setItem(DRAFT, "typed under an older bridge");
    leaving.paneStorage.setItem("ovis:terminal-line:w1:p1", "git status");
    leaving.paneStorage.setItem(HELD, JSON.stringify({ text: "echo ", at: 1_000 }));
    leaving.carry();
    expect(storage.getItem(DRAFT)).toBeNull();

    // back on the PC, whose server still names no herdr: nothing proves it is the herdr the text was typed under
    const back = page(storage);
    const drafts = new ComposerDraftStore(() => back.paneStorage);
    back.onRetire((machineId) => drafts.forget(machineId));
    back.observe([pc("local", undefined)], title);
    expect(drafts.read(DRAFT)).toEqual({ text: "", sending: false });
    expect(back.paneStorage.getItem("ovis:terminal-line:w1:p1")).toBeNull();
    expect(back.unsent().map(({ machine_id, kind, text }) => ({ machine_id, kind, text })).sort((x, y) => x.kind.localeCompare(y.kind))).toEqual([
      { machine_id: "local", kind: "line", text: "git status" },
      { machine_id: "local", kind: "message", text: "typed under an older bridge" },
    ]);
    back.observe([pc("pc2", "herdr-a")], title);
    expect(back.paneStorage.getItem(HELD)).toBeNull();
    expect(back.unsent().filter((item) => item.machine_id === "pc2").map(({ kind, text }) => ({ kind, text }))).toEqual([{ kind: "held", text: "echo " }]);
    expect([...storage.data.keys()].filter((key) => key.startsWith("ovis:pane-carried:"))).toEqual([]);
    const again = page(storage);
    again.observe([pc("local", undefined), pc("pc2", undefined)], title);
    expect(again.unsent()).toHaveLength(3);
  });

  it("says whether a replaced page's pane state reached storage: nothing to hand over is done, and a refused write leaves it with this page", () => {
    const storage = new MemoryStorage();
    storage.refuse = "ovis:pane-carried:";
    const leaving = page(storage);
    expect(leaving.carry()).toBe(true);
    leaving.observe([pc("local", undefined)], title);
    leaving.paneStorage.setItem(DRAFT, "typed under an older bridge");
    expect(leaving.carry()).toBe(false);
    expect(leaving.paneStorage.getItem(DRAFT)).toBe("typed under an older bridge");
    storage.refuse = null;
    expect(leaving.carry()).toBe(true);
  });

  it("never puts a carried draft into the pane that reuses its ID after herdr was replaced under a PC naming no herdr", () => {
    const storage = new MemoryStorage();
    const leaving = page(storage);
    leaving.observe([pc("local", undefined, [pane("w1:p1", "claude on repo-a")])], title);
    leaving.paneStorage.setItem(DRAFT, "rm -rf build and redeploy repo-a");
    leaving.carry();
    // herdr restarted meanwhile: w1:p1 is another program now, and the snapshot still names no herdr
    const back = page(storage);
    const drafts = new ComposerDraftStore(() => back.paneStorage);
    back.onRetire((machineId) => drafts.forget(machineId));
    back.observe([pc("local", undefined, [pane("w1:p1", "codex on repo-b")])], title);
    expect(drafts.read(DRAFT).text).toBe("");
    expect(back.unsent().map(({ pane_id, kind, text }) => ({ pane_id, kind, text }))).toEqual([{ pane_id: "w1:p1", kind: "message", text: "rm -rf build and redeploy repo-a" }]);
  });

  it("brings a carried message an older bridge took with no receipt back once, in recovery, never in the reused pane id (#2172)", () => {
    const storage = new MemoryStorage();
    const leaving = page(storage);
    const pending = new PendingMessageStore(() => leaving.paneStorage, leaving);
    leaving.onRetire((machineId) => pending.forget(machineId));
    leaving.observe([pc("local", undefined)], title);
    pending.keepUnconfirmed("w1:p1", "deploy the fix");
    leaving.carry();
    const back = page(storage);
    const after = new PendingMessageStore(() => back.paneStorage, back);
    back.onRetire((machineId) => after.forget(machineId));
    back.observe([pc("local", undefined)], title);
    expect(after.read("w1:p1")).toEqual([]);
    expect(back.unsent().map(({ pane_id, kind, text }) => ({ pane_id, kind, text }))).toEqual([{ pane_id: "w1:p1", kind: "pending", text: "deploy the fix" }]);
  });

  it("brings two carried held messages with the same words back as two recovery items (#3990)", () => {
    const storage = new MemoryStorage();
    const leaving = page(storage);
    leaving.observe([pc("local", undefined)], title);
    leaving.paneStorage.setItem("ovis:pending:w1:p1", JSON.stringify({ version: 1, messages: [{ id: "one", text: "yes" }, { id: "two", text: "yes" }] }));
    leaving.carry();
    const back = page(storage);
    const after = new PendingMessageStore(() => back.paneStorage, back);
    back.onRetire((machineId) => after.forget(machineId));
    back.observe([pc("local", undefined)], title);
    expect(after.read("w1:p1")).toEqual([]);
    expect(back.unsent().map(({ kind, text }) => `${kind}:${text}`)).toEqual(["pending:yes", "pending:yes"]);
  });

  it("keeps two held messages with the same text, stored before any herdr was named, as two recovery items once one is (#3990)", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    // rows an earlier release stored with no lifetime record: the first herdr named retires them (settle, retireStored)
    lifetimes.observe([pc("local", undefined)], title);
    storage.setItem("ovis:pending:w1:p1", JSON.stringify({ version: 1, messages: [{ id: "one", text: "yes" }, { id: "two", text: "yes" }] }));
    storage.setItem("ovis:queue:w1:p1", "carry this too");
    // The next herdr takes over: both pending rows are archived in one pass.
    lifetimes.observe([pc("local", "herdr-a")], title);

    // Both rows come back, one recovery record per message, not one for the shared text.
    expect(storage.getItem("ovis:pending:w1:p1")).toBeNull();
    expect(lifetimes.unsent().filter((item) => item.kind === "pending" && item.text === "yes")).toHaveLength(2);
  });

  it("keeps the record an unconfirmed row already has, and makes one more for a second row with the same text (#3990)", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    const pending = new PendingMessageStore(() => lifetimes.paneStorage, lifetimes);
    lifetimes.onRetire((machineId) => pending.forget(machineId));
    lifetimes.observe([pc("local", undefined)], title);
    pending.keepUnconfirmed("w1:p1", "yes");
    const [kept] = lifetimes.unsent();
    pending.accept("w1:p1", { id: "two", request_id: 1, text: "yes", state: "queued", created_at: "2026-10-06T00:00:00Z" }, null);
    lifetimes.observe([pc("local", "herdr-a")], title);
    expect(pending.read("w1:p1")).toEqual([]);
    expect(lifetimes.unsent().map(({ kind, text }) => `${kind}:${text}`)).toEqual(["pending:yes", "pending:yes"]);
    expect(lifetimes.unsent().map(({ id }) => id)).toContain(kept!.id);
  });

  it("keeps no held input past its age in the carry, when the page leaves or when the next one takes it", () => {
    const storage = new MemoryStorage();
    const carried = (): string => storage.getItem("ovis:pane-carried:") ?? "";
    const leaving = page(storage);
    leaving.observe([pc("local", undefined), pc("pc2", undefined)], title);
    leaving.paneStorage.setItem("ovis:terminal-draft:w1:p1", JSON.stringify({ text: "typed a day ago", at: 1_000 - DRAFT_TTL_MS - 1 }));
    leaving.paneStorage.setItem("ovis:terminal-draft:remote:pc2:w1%3Ap1", JSON.stringify({ text: "typed just now", at: 1_000 }));
    leaving.carry();
    expect(carried()).not.toContain("typed a day ago");
    expect(carried()).toContain("typed just now");
    const later = new PaneLifetimes(() => storage, () => 1_001 + DRAFT_TTL_MS, () => `id-${++ids}`);
    later.observe([pc("local", undefined)], title);
    expect(storage.getItem("ovis:pane-carried:")).toBeNull();
    expect(later.unsent()).toEqual([]);
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
    const reloaded = page(storage);
    const after = new PendingMessageStore(() => reloaded.paneStorage, reloaded);
    reloaded.observe([pc("local", undefined)], title);
    expect(after.read("w1:p1")).toEqual([]);
    expect(reloaded.unsent().map(({ machine_id, pane_id, pane_title, kind, text }) => ({ machine_id, pane_id, pane_title, kind, text }))).toEqual([
      { machine_id: "local", pane_id: "w1:p1", pane_title: "api", kind: "pending", text: "deploy the fix" },
    ]);
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
    expect(lifetimes.unsent().map(({ pane_id, text }) => `${pane_id}=${text}`).sort()).toEqual(["w1:p1=yes", "w1:p1=yes", "w1:p2=no"]);
    const [first, second] = pending.read("w1:p1");
    pending.removeCopy("w1:p1", first!.id);
    expect(lifetimes.unsent().map(({ pane_id, text }) => `${pane_id}=${text}`).sort()).toEqual(["w1:p1=yes", "w1:p2=no"]);
    pending.removeCopy("w1:p1", second!.id);
    expect(lifetimes.unsent().map(({ pane_id, text }) => `${pane_id}=${text}`)).toEqual(["w1:p2=no"]);
    expect(lifetimes.undoable()).toEqual([]);

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
    storage.refuse = null;
    pending.keepUnconfirmed("w1:p1", "second");
    expect(lifetimes.unsent()).toEqual([]);
    // the row is saved now: an Undo in an open Recover unsent text would offer its words a second time
    expect(lifetimes.undoable()).toEqual([]);
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
    const stale = page(storage);
    stale.observe([pc("local", "herdr-a")], title);
    expect(storage.getItem(DRAFT)).toBe("for herdr-b's pane");
    expect(stale.paneStorage.getItem(DRAFT)).toBeNull();
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
    lifetimes.observe([pc("local", "herdr-a")], title);
    expect(lifetimes.generation("local")).toBe("herdr-b");
  });

  it("settles a send begun for a pane of the herdr before nothing in the draft its pane ID holds now", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    const drafts = new ComposerDraftStore(() => lifetimes.paneStorage, undefined, () => lifetimes.generation("local"));
    lifetimes.onRetire((machineId) => drafts.forget(machineId, lifetimes));
    lifetimes.observe([pc("local", "herdr-a")], title);
    drafts.set(DRAFT, "deploy", "replace");
    expect(drafts.begin(DRAFT, "deploy")).toBe(true);
    const send = drafts.sendOf(DRAFT);
    lifetimes.observe([pc("local", "herdr-b")], title);
    expect(drafts.read(DRAFT).sending).toBe(false);
    drafts.set(DRAFT, "deploy new target", "replace");
    expect(drafts.begin(DRAFT, "deploy new target")).toBe(true);
    const next = drafts.sendOf(DRAFT);
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
    drafts.set(DRAFT, "an edit storage refused", "replace");
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
    expect(lifetimes.unsent().map(({ text }) => text).sort()).toEqual(["typed on core p1", "typed on herdr p1"]);
  });

  it("lets another page follow a switch back too, once storage says the switching page cleared its history", () => {
    const storage = new MemoryStorage();
    const clicked = page(storage);
    const other = page(storage);
    for (const lifetimes of [clicked, other]) lifetimes.observe([pc("local", "herdr-tui")], title);
    for (const lifetimes of [clicked, other]) lifetimes.observe([pc("local", "herdr-core")], title);
    other.paneStorage.setItem(DRAFT, "core draft");
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
    device.runtimeChanged("local");
    device.observe([pc("local", "herdr-tui")], title);
    expect([device.generation("local"), device.stored("local"), device.paneStorage.getItem(DRAFT)]).toEqual(["herdr-tui", true, null]);
    device.paneStorage.setItem(DRAFT, "for tui");
    expect(page(storage).paneStorage.getItem(DRAFT) ?? storage.getItem(DRAFT)).toBe("for tui");
    expect(device.unsent().map(({ text }) => text)).toEqual(["for core"]);
  });

  it("follows a switch back on another device when its roster comes before its health", () => {
    const storage = new MemoryStorage();
    const device = page(storage);
    device.observe([pc("local", "herdr-tui")], title);
    device.observe([pc("local", "herdr-core")], title);
    device.paneStorage.setItem(DRAFT, "core draft");
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
    lifetimes.observe([pc("local", "herdr-b")]);
    lifetimes.paneStorage.setItem(DRAFT, "for herdr b's pane");
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
    drafts.set(DRAFT, "half a sentence", "replace");
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

it("allows restoring a discarded unsent text record so an accidental discard can be undone (G-007)", () => {
  const storage = new MemoryStorage();
  const lifetimes = page(storage);
  lifetimes.observe([pc("local", "herdr-a")], title);
  lifetimes.paneStorage.setItem(DRAFT, "recover me after discard");
  lifetimes.observe([pc("local", "herdr-b")], title);
  const [item] = lifetimes.unsent();
  expect(item?.text).toBe("recover me after discard");
  const removed = lifetimes.discard(item!.id);
  expect(removed?.id).toBe(item!.id);
  expect(lifetimes.unsent()).toEqual([]);
  expect(lifetimes.undoable().map((u) => u.id)).toEqual([item!.id]);
  expect(lifetimes.restore(item!.id)).toBe(true);
  expect(lifetimes.undoable()).toEqual([]);
  expect(lifetimes.unsent().map((u) => u.text)).toEqual(["recover me after discard"]);
});

it("keeps a discarded draft restorable in place for the undo window, then drops it for good (G-007)", () => {
  const storage = new MemoryStorage();
  for (const n of [1, 2, 3, 4]) {
    storage.setItem(`ovis:unsent:qa-${n}`, JSON.stringify({ machine_id: "local", pane_id: `w1:p${n}`, kind: "message", text: `draft ${n}`, at: n * 1_000 }));
  }
  const clock = fakeClock();
  const lifetimes = page(storage, clock.timers);
  const target = lifetimes.unsent().find((item) => item.id === "qa-2")!;
  expect(target.text).toBe("draft 2");

  lifetimes.discard(target.id);
  expect(lifetimes.unsent()).toHaveLength(3);
  expect(storage.getItem("ovis:unsent:qa-2")).toBeNull();
  expect(lifetimes.undoable().map(({ id, text }) => ({ id, text }))).toEqual([{ id: "qa-2", text: "draft 2" }]);

  clock.advance(UNSENT_UNDO_WINDOW_MS - 1);
  expect(lifetimes.undoable()).toHaveLength(1);
  expect(lifetimes.restore(target.id)).toBe(true);
  expect(clock.pending()).toBe(0);
  expect(lifetimes.undoable()).toEqual([]);
  const restored = lifetimes.unsent().find((item) => item.id === "qa-2");
  expect(restored).toEqual(target);
  expect(lifetimes.unsent()).toHaveLength(4);

  lifetimes.discard(target.id);
  const changes: number[] = [];
  lifetimes.subscribe(() => changes.push(lifetimes.undoable().length));
  clock.advance(UNSENT_UNDO_WINDOW_MS - 1);
  expect(lifetimes.undoable()).toHaveLength(1);
  clock.advance(1);
  expect(changes).toEqual([0]);
  expect(lifetimes.undoable()).toEqual([]);
  expect(lifetimes.restore(target.id)).toBe(false);
  expect(lifetimes.unsent().map((item) => item.id)).toEqual(["qa-4", "qa-3", "qa-1"]);
  expect(storage.getItem("ovis:unsent:qa-2")).toBeNull();

  lifetimes.discard("qa-3", 0);
  expect(lifetimes.undoable()).toEqual([]);
  expect(clock.pending()).toBe(0);
  expect(lifetimes.unsent()).toHaveLength(2);
});
