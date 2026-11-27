import { describe, expect, it } from "bun:test";
import { paneStorageId, type Machine } from "../../shared/machines.ts";
import { ComposerDraftStore, SEND_LEASE_MS } from "./composerDraft.ts";
import { ReplyCommentStore } from "./replyComments.ts";
import { PaneLifetimes, paneLifetimes } from "./paneLifetime.ts";
import { carryPaneState, movedView } from "./paneMove.ts";
import { readTerminalDraft, setTerminalDraftSending, writeTerminalDraft } from "./terminalDraft.ts";
function fixture() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  return { data, drafts: new ComposerDraftStore(() => storage), storage: () => storage, comments: new ReplyCommentStore(() => storage) };
}
it("carries the chat draft, the held terminal input and the picked lens to the pane's new ID, sending nothing", () => {
  const { data, drafts, storage, comments } = fixture();
  drafts.set("ovis:composer-draft:w1:p1", "unsent question", "replace");
  data.set("ovis:terminal-draft:w1:p1", JSON.stringify({ text: "echo held", at: 1 }));
  data.set("ovis:view:w1:p1", "terminal");
  data.set("ovis:reply-comments:w1:p1", JSON.stringify([{ id: "c1", quote: "q", comment: "c" }]));
  // another pane's state, and the same pane ID on another PC, stay where they are
  data.set("ovis:view:w1:p2", "chat");
  drafts.set("ovis:composer-draft:remote:pc:w1%3Ap1", "other PC", "replace");
  carryPaneState("local", "w1:p1", "w2:p4", drafts, storage, comments);
  expect(drafts.read("ovis:composer-draft:w2:p4")).toEqual({ text: "unsent question", sending: false });
  expect(drafts.read("ovis:composer-draft:w1:p1").text).toBe("");
  expect(data.get("ovis:terminal-draft:w2:p4")).toBe(JSON.stringify({ text: "echo held", at: 1 }));
  expect(data.get("ovis:view:w2:p4")).toBe("terminal");
  expect(data.get("ovis:reply-comments:w2:p4")).toBe(JSON.stringify([{ id: "c1", quote: "q", comment: "c" }]));
  expect([...data.keys()].filter((key) => key.endsWith(":w1:p1"))).toEqual([]);
  expect(data.get("ovis:view:w1:p2")).toBe("chat");
  expect(drafts.read("ovis:composer-draft:remote:pc:w1%3Ap1").text).toBe("other PC");
});
it("carries no draft another tab sent before this one heard of it (#2369)", () => {
  const { data, drafts, storage } = fixture();
  drafts.set("ovis:composer-draft:w1:p1", "deploy", "replace");
  data.delete("ovis:composer-draft:w1:p1");
  carryPaneState("local", "w1:p1", "w2:p4", drafts, storage);
  expect(data.has("ovis:composer-draft:w2:p4")).toBe(false);
  expect(drafts.read("ovis:composer-draft:w2:p4").text).toBe("");
});
it("leaves a draft whose send is on its way, and keeps what the new ID holds already", () => {
  const { data, drafts, storage } = fixture();
  drafts.set("ovis:composer-draft:w1:p1", "on its way", "replace");
  expect(drafts.begin("ovis:composer-draft:w1:p1", "on its way")).toBe(true);
  data.set("ovis:view:w1:p1", "chat");
  data.set("ovis:view:w2:p4", "terminal");
  carryPaneState("local", "w1:p1", "w2:p4", drafts, storage);
  expect(drafts.read("ovis:composer-draft:w1:p1")).toEqual({ text: "on its way", sending: true });
  expect(drafts.read("ovis:composer-draft:w2:p4").text).toBe("");
  expect(data.get("ovis:view:w2:p4")).toBe("terminal");
  expect(data.get("ovis:view:w1:p1")).toBe("chat");
});
it("moves every waiting comment with the pane, and a send begun before the move removes only the ones it carried (#511)", () => {
  const { drafts, storage, comments } = fixture();
  const before = "ovis:reply-comments:w1:p1", after = "ovis:reply-comments:w2:p4";
  comments.add(before, "selected first", "send this");
  expect(drafts.begin("ovis:composer-draft:w1:p1", "go")).toBe(true);
  const carried = comments.read(before);
  comments.add(before, "selected second", "save for next message");
  carryPaneState("local", "w1:p1", "w2:p4", drafts, storage, comments);
  expect(comments.read(after).map((item) => item.comment)).toEqual(["send this", "save for next message"]);
  comments.removeSent(before, carried);
  expect(comments.read(after).map((item) => item.comment)).toEqual(["save for next message"]);
  expect(comments.read(before)).toEqual([]);
});
it("removes the comments a send carried after another tab moved the pane during it (#2356)", () => {
  const { data, storage } = fixture();
  const sender = { drafts: new ComposerDraftStore(storage), comments: new ReplyCommentStore(storage) };
  const mover = { drafts: new ComposerDraftStore(storage), comments: new ReplyCommentStore(storage) };
  const before = "ovis:reply-comments:w1:p1", after = "ovis:reply-comments:w2:p4";
  sender.comments.add(before, "selected", "carried");
  sender.drafts.set("ovis:composer-draft:w1:p1", "go", "replace");
  expect(sender.drafts.claim("ovis:composer-draft:w1:p1", "go")).toBe(true);
  const carried = sender.comments.read(before);
  sender.comments.reserve(carried);
  mover.comments.add(before, "later", "for the next message");
  carryPaneState("local", "w1:p1", "w2:p4", mover.drafts, storage, mover.comments);
  expect(mover.comments.unreserved(mover.comments.read(after))).toEqual([]);
  sender.comments.removeSent(before, carried);
  sender.drafts.end("ovis:composer-draft:w1:p1", sender.drafts.sendOf("ovis:composer-draft:w1:p1"));
  mover.drafts.refresh("ovis:composer-draft:w1:p1");
  expect(mover.comments.unreserved(mover.comments.read(after)).map((item) => item.comment)).toEqual(["for the next message"]);
  expect(mover.comments.read(after).map((item) => item.comment)).toEqual(["for the next message"]);
  expect(data.has("ovis:reply-comments:w2:p4")).toBe(true);
});
describe("comments moved while a send in another tab is on its way (#2356)", () => {
  const draft = (pane: string) => `ovis:composer-draft:${pane}`;
  const list = (pane: string) => `ovis:reply-comments:${pane}`;
  function tabs() {
    const { data, storage } = fixture();
    const tab = () => ({ drafts: new ComposerDraftStore(storage, () => 0), comments: new ReplyCommentStore(storage) });
    return { data, storage, tab };
  }
  function send(tab: { drafts: ComposerDraftStore; comments: ReplyCommentStore }, pane: string, text: string) {
    const carried = tab.comments.unreserved(tab.comments.read(list(pane)));
    tab.drafts.set(draft(pane), text, "replace");
    expect(tab.drafts.claim(draft(pane), text)).toBe(true);
    tab.comments.reserve(carried);
    return carried;
  }
  it("holds them for that send in every tab, not only the one that moved the pane", () => {
    const { storage, tab } = tabs();
    const a = tab(), b = tab(), c = tab();
    a.comments.add(list("w1:p1"), "q", "sent");
    send(a, "w1:p1", "first");
    carryPaneState("local", "w1:p1", "w2:p2", b.drafts, storage, b.comments);
    expect(b.comments.unreserved(b.comments.read(list("w2:p2")))).toEqual([]);
    expect(c.comments.unreserved(c.comments.read(list("w2:p2")))).toEqual([]);
  });
  it("follows a second move made before that send is acknowledged", () => {
    const { storage, tab } = tabs();
    const a = tab(), b = tab();
    a.comments.add(list("w1:p1"), "q", "sent");
    const carried = send(a, "w1:p1", "first");
    carryPaneState("local", "w1:p1", "w2:p2", b.drafts, storage, b.comments);
    carryPaneState("local", "w2:p2", "w3:p3", b.drafts, storage, b.comments);
    a.comments.removeSent(list("w1:p1"), carried);
    expect(b.comments.read(list("w3:p3"))).toEqual([]);
  });
  it("keeps each move's record for every send that may follow it", () => {
    const { storage, tab } = tabs();
    const a = tab(), b = tab();
    a.comments.add(list("w1:p1"), "q1", "first");
    const first = send(a, "w1:p1", "one");
    carryPaneState("local", "w1:p1", "w2:p2", b.drafts, storage, b.comments);
    b.comments.add(list("w2:p2"), "q2", "second");
    const second = send(b, "w2:p2", "two");
    expect(second.map((item) => item.comment)).toEqual(["second"]);
    carryPaneState("local", "w2:p2", "w3:p3", a.drafts, storage, a.comments);
    a.comments.removeSent(list("w1:p1"), first);
    b.comments.removeSent(list("w2:p2"), second);
    expect(b.comments.read(list("w3:p3"))).toEqual([]);
  });
  it("keeps one held for the earlier send when a later send it moved with ends first", () => {
    const { storage, tab } = tabs();
    const a = tab(), b = tab();
    a.comments.add(list("w1:p1"), "q1", "first");
    send(a, "w1:p1", "one");
    carryPaneState("local", "w1:p1", "w2:p2", b.drafts, storage, b.comments);
    b.comments.add(list("w2:p2"), "q2", "second");
    const second = send(b, "w2:p2", "two");
    carryPaneState("local", "w2:p2", "w3:p3", b.drafts, storage, b.comments);
    b.comments.removeSent(list("w2:p2"), second);
    b.drafts.end(draft("w2:p2"), b.drafts.sendOf(draft("w2:p2")));
    b.comments.release(second);
    expect(b.comments.unreserved(b.comments.read(list("w3:p3")))).toEqual([]);
    a.drafts.end(draft("w1:p1"), a.drafts.sendOf(draft("w1:p1")));
    expect(b.comments.unreserved(b.comments.read(list("w3:p3"))).map((item) => item.comment)).toEqual(["first"]);
  });
  it("lets a send for a retired herdr's pane leave the record a new send follows", () => {
    const data = new Map<string, string>();
    const shared = { get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null, getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); }, clear: () => { data.clear(); } } as Storage;
    const page = () => {
      const life = new PaneLifetimes(() => shared);
      const drafts = new ComposerDraftStore(() => life.paneStorage, () => 0, () => life.generation("local"));
      life.onRetire((id) => drafts.forget(id, life));
      return { life, drafts, comments: new ReplyCommentStore(() => life.paneStorage) };
    };
    const a = page(), b = page();
    const observe = (p: ReturnType<typeof page>, lifetime: string) => p.life.observe([{ id: "local", snapshot: { panes: [], herdr_lifetime: lifetime } } as unknown as Machine], (item) => item.pane_id);
    observe(a, "old"); observe(b, "old");
    a.comments.add(list("w1:p1"), "old quote", "old comment");
    const old = send(a, "w1:p1", "old");
    const oldSend = a.drafts.sendOf(draft("w1:p1"));
    observe(a, "new"); observe(b, "new");
    b.comments.add(list("w1:p1"), "new quote", "new comment");
    const fresh = send(b, "w1:p1", "new");
    carryPaneState("local", "w1:p1", "w2:p2", a.drafts, () => a.life.paneStorage, a.comments);
    expect(a.drafts.settle(draft("w1:p1"), "old", oldSend)).toBeNull();
    a.comments.removeSent(list("w1:p1"), old);
    b.comments.removeSent(list("w1:p1"), fresh);
    expect(b.comments.read(list("w2:p2"))).toEqual([]);
  });
});
it("follows no record of another tab's move once a send could no longer be on its way (#2356)", () => {
  const { data, storage } = fixture();
  const sender = new ReplyCommentStore(storage), mover = new ReplyCommentStore(storage);
  const before = "ovis:reply-comments:w1:p1", after = "ovis:reply-comments:w2:p4";
  sender.add(before, "selected", "carried");
  const carried = sender.read(before);
  data.set(before, JSON.stringify({ movedTo: after, at: Date.now() - SEND_LEASE_MS - 1 }));
  data.set(after, JSON.stringify(carried));
  sender.removeSent(before, carried);
  expect(mover.read(after)).toEqual(carried);
});
it("keeps the comments a refused send carried on the moved pane, after any it held already (#511)", () => {
  const { storage, drafts, comments } = fixture();
  comments.add("ovis:reply-comments:w2:p4", "its own", "already here");
  comments.add("ovis:reply-comments:w1:p1", "selected", "refused with its message");
  expect(drafts.begin("ovis:composer-draft:w1:p1", "go")).toBe(true);
  carryPaneState("local", "w1:p1", "w2:p4", drafts, storage, comments);
  expect(comments.read("ovis:reply-comments:w2:p4").map((item) => item.comment)).toEqual(["already here", "refused with its message"]);
});
it("carries a touch screen's unsent terminal line to the new ID, and leaves one on its way", () => {
  const { drafts, storage } = fixture();
  writeTerminalDraft("w7:p1", "git status");
  carryPaneState("local", "w7:p1", "w8:p2", drafts, storage);
  expect(readTerminalDraft("w8:p2")).toBe("git status");
  expect(readTerminalDraft("w7:p1")).toBe("");
  writeTerminalDraft("w7:p3", "make");
  setTerminalDraftSending("w7:p3", true);
  carryPaneState("local", "w7:p3", "w8:p4", drafts, storage);
  setTerminalDraftSending("w7:p3", false);
  expect(readTerminalDraft("w7:p3")).toBe("make");
  expect(readTerminalDraft("w8:p4")).toBe("");
});
it("carries what this page alone keeps for a PC that names no herdr, and writes none of it to storage", () => {
  const { data, storage } = fixture();
  const window = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage() } });
  try {
    paneLifetimes.observe([{ id: "older", snapshot: { panes: [] } } as unknown as Machine], (item) => item.pane_id);
    const before = paneStorageId("older", "w1:p1");
    const after = paneStorageId("older", "w2:p4");
    paneLifetimes.paneStorage.setItem(`ovis:terminal-draft:${before}`, JSON.stringify({ text: "echo held", at: 1 }));
    paneLifetimes.paneStorage.setItem(`ovis:view:${before}`, "terminal");
    carryPaneState("older", "w1:p1", "w2:p4", new ComposerDraftStore(() => paneLifetimes.paneStorage));
    expect(paneLifetimes.paneStorage.getItem(`ovis:terminal-draft:${after}`)).toBe(JSON.stringify({ text: "echo held", at: 1 }));
    expect(paneLifetimes.paneStorage.getItem(`ovis:view:${after}`)).toBe("terminal");
    expect(paneLifetimes.paneStorage.getItem(`ovis:view:${before}`)).toBeNull();
    expect([...data.keys()]).toEqual([]);
  } finally {
    if (window) Object.defineProperty(globalThis, "window", window);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
it("keeps the comments a send on its way carries out of a second send from the moved pane until the first settles (#511)", () => {
  const { drafts, storage, comments } = fixture();
  const before = "ovis:reply-comments:w1:p1", after = "ovis:reply-comments:w2:p4";
  comments.add(before, "quote", "carried");
  expect(drafts.begin("ovis:composer-draft:w1:p1", "first")).toBe(true);
  const carried = comments.read(before);
  comments.reserve(carried);
  carryPaneState("local", "w1:p1", "w2:p4", drafts, storage, comments);
  expect(drafts.read("ovis:composer-draft:w2:p4").sending).toBe(false);
  expect(comments.unreserved(comments.read(after))).toEqual([]);
  comments.add(after, "later", "for the next message");
  expect(comments.unreserved(comments.read(after)).map((item) => item.comment)).toEqual(["for the next message"]);
  drafts.end("ovis:composer-draft:w1:p1", drafts.sendOf("ovis:composer-draft:w1:p1"));
  comments.release(carried);
  expect(comments.unreserved(comments.read(after)).map((item) => item.comment)).toEqual(["carried", "for the next message"]);
});

it("takes the view of a pane moved elsewhere to its new ID in any slot, and nothing the user went to meanwhile (#1503)", () => {
  const split = { panes: { b: { machineId: "pc", paneId: "w1:p1" }, c: { machineId: "pc", paneId: "w4:p1" } }, active: "a" };
  expect(movedView({ machineId: "pc", paneId: "w1:p1" }, split, "pc", "w1:p1", "w2:p1"))
    .toEqual({ selection: "w2:p1", split: { panes: { b: { machineId: "pc", paneId: "w2:p1" }, c: { machineId: "pc", paneId: "w4:p1" } }, active: "a" } });
  expect(movedView({ machineId: "pc", paneId: "w9:p1" }, split, "pc", "w8:p1", "w2:p1")).toEqual({ selection: null, split: null });
  // the same pane ID on another PC is another pane
  expect(movedView({ machineId: "other", paneId: "w1:p1" }, null, "pc", "w1:p1", "w2:p1")).toEqual({ selection: null, split: null });
  expect(movedView({ machineId: "pc", paneId: "w3:p1" }, null, "pc", "w1:p1", "w2:p1")).toEqual({ selection: null, split: null });
});

it("carries unsent card text across pane moves with write-first and keep-on-conflict (#3458)", () => {
  const { data, drafts, storage } = fixture();
  const payload = (paneId: string, text: string) => JSON.stringify({ machineId: "local", paneId, session: "s1", promptId: "q1", text });
  data.set("ovis:card-text:w1:p1", payload("w1:p1", "draft answer"));
  carryPaneState("local", "w1:p1", "w2:p4", drafts, storage);
  expect(data.get("ovis:card-text:w1:p1")).toBeUndefined();
  expect(JSON.parse(data.get("ovis:card-text:w2:p4")!)).toEqual({ machineId: "local", paneId: "w2:p4", session: "s1", promptId: "q1", text: "draft answer" });

  // keep-on-conflict: if destination already holds card text, preserve both
  data.set("ovis:card-text:w3:p1", payload("w3:p1", "source"));
  data.set("ovis:card-text:w4:p2", payload("w4:p2", "existing dest"));
  carryPaneState("local", "w3:p1", "w4:p2", drafts, storage);
  expect(JSON.parse(data.get("ovis:card-text:w3:p1")!).text).toBe("source");
  expect(JSON.parse(data.get("ovis:card-text:w4:p2")!).text).toBe("existing dest");

  // write-first: if writing destination fails, keep source intact
  data.set("ovis:card-text:w5:p1", payload("w5:p1", "keep me"));
  const failingStorage = () => ({
    ...storage(),
    setItem(key: string, value: string) {
      if (key === "ovis:card-text:w6:p2") throw new DOMException("Quota exceeded", "QuotaExceededError");
      storage().setItem(key, value);
    },
  });
  carryPaneState("local", "w5:p1", "w6:p2", new ComposerDraftStore(failingStorage), failingStorage);
  expect(JSON.parse(data.get("ovis:card-text:w5:p1")!).text).toBe("keep me");
  expect(data.get("ovis:card-text:w6:p2")).toBeUndefined();
});

it("prefers fresher cached card text over stale storage and keeps concurrent source edits (#3458)", async () => {
  const { setCardText } = await import("./cardText.ts");
  const { data, drafts, storage } = fixture();
  const payload = (paneId: string, text: string) => JSON.stringify({ machineId: "local", paneId, session: "s1", promptId: "q1", text });

  // failed edit write leaves stale text in storage, fresher text in memory
  data.set("ovis:card-text:w7:p1", payload("w7:p1", "older stored"));
  const failSourceWrite = () => ({
    ...storage(),
    setItem(key: string, value: string) {
      if (key === "ovis:card-text:w7:p1") throw new DOMException("Quota exceeded", "QuotaExceededError");
      storage().setItem(key, value);
    },
  });
  setCardText("w7:p1", { machineId: "local", paneId: "w7:p1", session: "s1", promptId: "q1", text: "newer memory" }, failSourceWrite);
  carryPaneState("local", "w7:p1", "w8:p2", drafts, storage);
  expect(data.get("ovis:card-text:w7:p1")).toBeUndefined();
  expect(JSON.parse(data.get("ovis:card-text:w8:p2")!).text).toBe("newer memory");

  // concurrent source update during destination write is not deleted
  data.set("ovis:card-text:w9:p1", payload("w9:p1", "before race"));
  const racingStorage = () => ({
    ...storage(),
    setItem(key: string, value: string) {
      storage().setItem(key, value);
      if (key === "ovis:card-text:w10:p2") {
        data.set("ovis:card-text:w9:p1", payload("w9:p1", "written concurrently"));
      }
    },
  });
  carryPaneState("local", "w9:p1", "w10:p2", new ComposerDraftStore(racingStorage), racingStorage);
  expect(JSON.parse(data.get("ovis:card-text:w10:p2")!).text).toBe("before race");
  expect(JSON.parse(data.get("ovis:card-text:w9:p1")!).text).toBe("written concurrently");
});

it("carries the card text another tab stored over this tab's older cached copy, and drops the copy once it moved (#3458)", async () => {
  const { getMemoryCardText, heldCardTextFor } = await import("./cardText.ts");
  const { data, drafts, storage } = fixture();
  const payload = (paneId: string, text: string) => JSON.stringify({ machineId: "local", paneId, session: "s1", promptId: "q1", text });

  // this tab drew the card and cached its text; another tab then typed more under the same ID
  data.set("ovis:card-text:w11:p1", payload("w11:p1", "seen here"));
  expect(heldCardTextFor("w11:p1", storage)?.text).toBe("seen here");
  data.set("ovis:card-text:w11:p1", payload("w11:p1", "typed in another tab"));
  carryPaneState("local", "w11:p1", "w12:p2", drafts, storage);
  expect(JSON.parse(data.get("ovis:card-text:w12:p2")!).text).toBe("typed in another tab");
  expect(heldCardTextFor("w12:p2", storage)?.text).toBe("typed in another tab");
  expect(data.get("ovis:card-text:w11:p1")).toBeUndefined();

  // the other tab heard of the move first and carried it: this tab's cached copy under the old ID goes,
  // so a later herdr replacement does not offer the same words twice
  data.set("ovis:card-text:w13:p1", payload("w13:p1", "carried by the other tab"));
  expect(heldCardTextFor("w13:p1", storage)?.text).toBe("carried by the other tab");
  data.delete("ovis:card-text:w13:p1");
  data.set("ovis:card-text:w14:p2", payload("w14:p2", "carried by the other tab"));
  carryPaneState("local", "w13:p1", "w14:p2", drafts, storage);
  expect(getMemoryCardText("w13:p1")).toBeUndefined();
  expect(heldCardTextFor("w14:p2", storage)?.text).toBe("carried by the other tab");

  // another tab cleared the card (its prompt was answered): this tab's cached copy is not written back
  data.set("ovis:card-text:w15:p1", payload("w15:p1", "answered elsewhere"));
  expect(heldCardTextFor("w15:p1", storage)?.text).toBe("answered elsewhere");
  data.delete("ovis:card-text:w15:p1");
  carryPaneState("local", "w15:p1", "w16:p2", drafts, storage);
  expect(data.get("ovis:card-text:w16:p2")).toBeUndefined();
  expect(getMemoryCardText("w15:p1")).toBeUndefined();
  expect(getMemoryCardText("w16:p2")).toBeUndefined();
});
