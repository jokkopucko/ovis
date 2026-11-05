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
  drafts.set("ovis:composer-draft:w1:p1", "unsent question");
  data.set("ovis:terminal-draft:w1:p1", JSON.stringify({ text: "echo held", at: 1 }));
  data.set("ovis:view:w1:p1", "terminal");
  data.set("ovis:reply-comments:w1:p1", JSON.stringify([{ id: "c1", quote: "q", comment: "c" }]));
  // another pane's state, and the same pane ID on another PC, stay where they are
  data.set("ovis:view:w1:p2", "chat");
  drafts.set("ovis:composer-draft:remote:pc:w1%3Ap1", "other PC");
  carryPaneState("local", "w1:p1", "w2:p4", drafts, storage, comments);
  expect(drafts.read("ovis:composer-draft:w2:p4")).toEqual({ text: "unsent question", sending: false });
  expect(drafts.read("ovis:composer-draft:w1:p1").text).toBe("");
  expect(data.get("ovis:terminal-draft:w2:p4")).toBe(JSON.stringify({ text: "echo held", at: 1 }));
  expect(data.get("ovis:view:w2:p4")).toBe("terminal");
  // the comments waiting on its replies go with it (#511)
  expect(data.get("ovis:reply-comments:w2:p4")).toBe(JSON.stringify([{ id: "c1", quote: "q", comment: "c" }]));
  expect([...data.keys()].filter((key) => key.endsWith(":w1:p1"))).toEqual([]);
  expect(data.get("ovis:view:w1:p2")).toBe("chat");
  expect(drafts.read("ovis:composer-draft:remote:pc:w1%3Ap1").text).toBe("other PC");
});
it("carries no draft another tab sent before this one heard of it (#2369)", () => {
  const { data, drafts, storage } = fixture();
  drafts.set("ovis:composer-draft:w1:p1", "deploy");
  data.delete("ovis:composer-draft:w1:p1");
  carryPaneState("local", "w1:p1", "w2:p4", drafts, storage);
  expect(data.has("ovis:composer-draft:w2:p4")).toBe(false);
  expect(drafts.read("ovis:composer-draft:w2:p4").text).toBe("");
});
it("leaves a draft whose send is on its way, and keeps what the new ID holds already", () => {
  const { data, drafts, storage } = fixture();
  drafts.set("ovis:composer-draft:w1:p1", "on its way");
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
  // saved while that message is on its way: it waits for the next one
  comments.add(before, "selected second", "save for next message");
  carryPaneState("local", "w1:p1", "w2:p4", drafts, storage, comments);
  expect(comments.read(after).map((item) => item.comment)).toEqual(["send this", "save for next message"]);
  // the send is acknowledged under the ID it went with
  comments.removeSent(before, carried);
  expect(comments.read(after).map((item) => item.comment)).toEqual(["save for next message"]);
  expect(comments.read(before)).toEqual([]);
});
it("removes the comments a send carried after another tab moved the pane during it (#2356)", () => {
  const { data, storage } = fixture();
  // two tabs of one browser: each has its own stores over the same storage
  const sender = { drafts: new ComposerDraftStore(storage), comments: new ReplyCommentStore(storage) };
  const mover = { drafts: new ComposerDraftStore(storage), comments: new ReplyCommentStore(storage) };
  const before = "ovis:reply-comments:w1:p1", after = "ovis:reply-comments:w2:p4";
  sender.comments.add(before, "selected", "carried");
  sender.drafts.set("ovis:composer-draft:w1:p1", "go");
  expect(sender.drafts.claim("ovis:composer-draft:w1:p1", "go")).toBe(true);
  const carried = sender.comments.read(before);
  sender.comments.reserve(carried);
  mover.comments.add(before, "later", "for the next message");
  carryPaneState("local", "w1:p1", "w2:p4", mover.drafts, storage, mover.comments);
  // the moved pane's next message in the tab that moved it carries none of them while that send is on its way
  expect(mover.comments.unreserved(mover.comments.read(after))).toEqual([]);
  // acknowledged in the tab that sent it, under the ID it went with
  sender.comments.removeSent(before, carried);
  sender.drafts.end("ovis:composer-draft:w1:p1", sender.drafts.sendOf("ovis:composer-draft:w1:p1"));
  // its storage event reaches the tab that moved the pane
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
  // as Composer's Send: the free comments, claimed with the draft and reserved for the send
  function send(tab: { drafts: ComposerDraftStore; comments: ReplyCommentStore }, pane: string, text: string) {
    const carried = tab.comments.unreserved(tab.comments.read(list(pane)));
    tab.drafts.set(draft(pane), text);
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
    // that send ends too: the comment is free
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
    // an older bridge names no herdr: its panes' state lives in the page (lib/paneLifetime.ts)
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
  // the moved pane's own next message, before the first is acknowledged, carries none of them
  expect(drafts.read("ovis:composer-draft:w2:p4").sending).toBe(false);
  expect(comments.unreserved(comments.read(after))).toEqual([]);
  comments.add(after, "later", "for the next message");
  expect(comments.unreserved(comments.read(after)).map((item) => item.comment)).toEqual(["for the next message"]);
  // refused: they are free again, on the moved pane, none lost (as Composer ends a send: its lease, then its reservation)
  drafts.end("ovis:composer-draft:w1:p1", drafts.sendOf("ovis:composer-draft:w1:p1"));
  comments.release(carried);
  expect(comments.unreserved(comments.read(after)).map((item) => item.comment)).toEqual(["carried", "for the next message"]);
});

it("takes the view of a pane moved elsewhere to its new ID in either half, and nothing the user went to meanwhile (#1503)", () => {
  const split = { other: { machineId: "pc", paneId: "w1:p1" }, ratio: 0.5 };
  expect(movedView({ machineId: "pc", paneId: "w1:p1" }, split, "pc", "w1:p1", "w2:p1"))
    .toEqual({ selection: "w2:p1", split: { other: { machineId: "pc", paneId: "w2:p1" }, ratio: 0.5 } });
  // the same pane ID on another PC is another pane
  expect(movedView({ machineId: "other", paneId: "w1:p1" }, null, "pc", "w1:p1", "w2:p1")).toEqual({ selection: null, split: null });
  expect(movedView({ machineId: "pc", paneId: "w3:p1" }, null, "pc", "w1:p1", "w2:p1")).toEqual({ selection: null, split: null });
});
