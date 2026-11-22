import { beforeEach, describe, expect, test } from "bun:test";

import type { ConversationTurn } from "../../shared/protocol.ts";
import { chatRestoreIndex, chatTurnAnchor, drawnMatch, type DrawnSpan, forgetChatPositions, moveChatPosition, readChatPosition, rememberChatPosition } from "./chatScrollMemory.ts";

const turn = (role: "user" | "assistant", ts: string | null, text = "hi"): ConversationTurn => ({ role, ts, parts: [{ kind: "text", text }] });

describe("chatScrollMemory", () => {
  beforeEach(() => forgetChatPositions());

  test("a turn is named by role, time and its beginning, the same across new objects", () => {
    const at = "2026-01-01T00:00:00Z";
    expect(chatTurnAnchor(turn("user", at, "hi"))).toBe(chatTurnAnchor(turn("user", at, "hi")));
    expect(chatTurnAnchor(turn("assistant", at, `${"a".repeat(80)} streaming`))).toBe(chatTurnAnchor(turn("assistant", at, `${"a".repeat(80)} streaming on`)));
    expect(chatTurnAnchor(turn("user", at))).not.toBe(chatTurnAnchor(turn("assistant", at)));
    expect(chatTurnAnchor(turn("user", at, "one"))).not.toBe(chatTurnAnchor(turn("user", at, "two")));
    expect(chatTurnAnchor(turn("user", null, "a"))).toBe(chatTurnAnchor(turn("user", null, "a")));
    expect(chatTurnAnchor(turn("user", null, "a"))).not.toBe(chatTurnAnchor(turn("user", null, "b")));
  });

  test("positions are kept per pane and the latest wins", () => {
    rememberChatPosition("p1", { historyId: "h", turn: "a", offset: -10, atEnd: false });
    rememberChatPosition("remote:pc:p1", { historyId: "h", turn: "b", offset: 0, atEnd: true });
    rememberChatPosition("p1", { historyId: "h", turn: "c", offset: 4, atEnd: false });
    expect(readChatPosition("p1")?.turn).toBe("c");
    expect(readChatPosition("remote:pc:p1")?.atEnd).toBe(true);
    expect(readChatPosition("p2")).toBeUndefined();
  });

  test("the cache is bounded, oldest first", () => {
    for (let index = 0; index <= 100; index++) rememberChatPosition(`p${index}`, { historyId: null, turn: "a", offset: 0, atEnd: true });
    expect(readChatPosition("p0")).toBeUndefined();
    expect(readChatPosition("p100")).toBeDefined();
  });

  test("a save that comes due after the window is gone writes nothing and does not throw", () => {
    let due: (() => void) | undefined;
    const written: string[] = [];
    const handle = setTimeout(() => {}, 2 ** 31 - 1);
    const storage = { getItem: () => null, setItem: (_key: string, value: string) => { written.push(value); }, removeItem() {} };
    const original = Object.getOwnPropertyDescriptor(globalThis, "window");
    try {
      Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { setTimeout: (run: () => void) => { due = run; return handle; }, clearTimeout() {}, sessionStorage: storage } });
      rememberChatPosition("p1", { historyId: "h", turn: "a", offset: 0, atEnd: true });
      Reflect.deleteProperty(globalThis, "window");
      expect(due).toBeDefined();
      expect(() => due?.()).not.toThrow();
      expect(written).toEqual([]);
    } finally {
      clearTimeout(handle);
      if (original) Object.defineProperty(globalThis, "window", original);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("restores the saved row, else the end", () => {
    const anchors = ["x", "y", "z"];
    const saved = { historyId: "h", turn: "y", offset: -20, atEnd: false };
    expect(chatRestoreIndex(saved, "h", anchors)).toBe(1);
    expect(chatRestoreIndex({ ...saved, atEnd: true }, "h", anchors)).toBeNull();
    expect(chatRestoreIndex(saved, "other", anchors)).toBeNull();
    expect(chatRestoreIndex({ ...saved, turn: "gone" }, "h", anchors)).toBeNull();
    expect(chatRestoreIndex(undefined, "h", anchors)).toBeNull();
  });
});

describe("a pane moved under a new ID (#1503)", () => {
  beforeEach(() => forgetChatPositions());
  test("reads on where the reader left the pane, and keeps what the new ID has already", () => {
    const left = { historyId: "h", turn: "t", offset: -4, atEnd: false };
    rememberChatPosition("w1:p1", left);
    moveChatPosition("w1:p1", "w2:p1");
    expect(readChatPosition("w2:p1")).toEqual(left);
    expect(readChatPosition("w1:p1")).toBeUndefined();
    const own = { historyId: "h2", turn: "u", offset: 0, atEnd: true };
    rememberChatPosition("w1:p3", left);
    rememberChatPosition("w2:p3", own);
    moveChatPosition("w1:p3", "w2:p3");
    expect(readChatPosition("w2:p3")).toEqual(own);
  });
});

interface Drawn { nodeType: number; nodeName: string; nodeValue: string | null; childNodes: Drawn[] }
const text = (value: string): Drawn => ({ nodeType: 3, nodeName: "#text", nodeValue: value, childNodes: [] });
const element = (name: string, ...childNodes: Drawn[]): Drawn => ({ nodeType: 1, nodeName: name, nodeValue: null, childNodes });

describe("a search match in the drawn message", () => {
  test.each<[string, () => { root: Drawn; span: DrawnSpan<Drawn> }]>([
    ["one text node (control)", () => { const words = text("we deploy service now"); return { root: element("P", words), span: { start: words, startOffset: 3, end: words, endOffset: 17 } }; }],
    ["deploy **service**", () => { const lead = text("deploy "), bold = text("service"); return { root: element("P", lead, element("STRONG", bold)), span: { start: lead, startOffset: 0, end: bold, endOffset: 7 } }; }],
    ["deploy\\nservice", () => { const one = text("deploy"), two = text("service"); return { root: element("P", element("SPAN", one, element("BR")), element("SPAN", two)), span: { start: one, startOffset: 0, end: two, endOffset: 7 } }; }],
    ["deploy   service", () => { const words = text("deploy   service"); return { root: element("P", words), span: { start: words, startOffset: 0, end: words, endOffset: 16 } }; }],
  ])("%s", (_, drawn) => {
    const { root, span } = drawn();
    expect(drawnMatch(root, "deploy service")).toEqual(span);
  });

  test("words run together across a text-node boundary with no break between are no match", () => {
    expect(drawnMatch(element("P", text("deploy"), element("STRONG", text("service"))), "deploy service")).toBeNull();
  });
});
