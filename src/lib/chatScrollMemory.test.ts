import { beforeEach, describe, expect, test } from "bun:test";

import type { ConversationTurn } from "../../shared/protocol.ts";
import { chatRestoreIndex, chatTurnAnchor, forgetChatPositions, moveChatPosition, readChatPosition, rememberChatPosition } from "./chatScrollMemory.ts";

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
