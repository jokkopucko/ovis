import { describe, expect, it } from "bun:test";
import { commentsWait, messageWithComments, quoteBlock, ReplyCommentStore } from "./replyComments.ts";

function memoryStorage() {
  const map = new Map<string, string>();
  return { map, storage: { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } } };
}

describe("reply comments", () => {
  it("sends each comment as its quote and then the comment, in the order written, before the typed text", () => {
    const comments = [
      { id: "a", quote: "backfill it from updated_at", comment: "Backfill in batches of 1,000, the table has 40 million rows." },
      { id: "b", quote: "replay the local edit on top of it", comment: "If both sides changed the same field, ask instead of replaying." },
    ];
    expect(messageWithComments(comments, "Go ahead with step 1.")).toBe(
      "> backfill it from updated_at\nBackfill in batches of 1,000, the table has 40 million rows.\n\n"
      + "> replay the local edit on top of it\nIf both sides changed the same field, ask instead of replaying.\n\n"
      + "Go ahead with step 1.");
    expect(messageWithComments(comments.slice(0, 1), "  ")).toBe("> backfill it from updated_at\nBackfill in batches of 1,000, the table has 40 million rows.");
  });

  it("quotes every line of a selection across paragraphs, its blank lines kept inside the quote", () => {
    expect(quoteBlock("First item\r\nSecond item\n\nNext paragraph.\n")).toBe("> First item\n> Second item\n>\n> Next paragraph.");
  });

  it("leaves the comments for the next message under a slash command or an answer", () => {
    expect(commentsWait("  /compact", false)).toBe(true);
    expect(commentsWait("!git status", false)).toBe(true);
    expect(commentsWait("Go ahead", true)).toBe(true);
    expect(commentsWait("Go ahead with /tmp/x", false)).toBe(false);
  });

  it("keeps a pane's comments, removes one or the sent ones by id, and reads the same list until it changes", () => {
    const { map, storage } = memoryStorage();
    let next = 0;
    const store = new ReplyCommentStore(() => storage, () => `c${++next}`);
    let heard = 0;
    store.subscribe(() => { heard++; });
    expect(store.add("k", "quote one", "  first  ")).toBe(true);
    expect(heard).toBe(1);
    expect(store.add("k", "quote two", "second")).toBe(true);
    expect(store.add("k", " ", "empty quote")).toBe(false);
    expect(store.add("k", "quote", " ")).toBe(false);
    const list = store.read("k");
    expect(store.read("k")).toBe(list);
    expect(list.map((item) => [item.id, item.comment])).toEqual([["c1", "first"], ["c2", "second"]]);
    const sent = list.slice(0, 1);
    store.add("k", "quote three", "written while the first was on its way");
    store.removeSent("k", sent);
    expect(store.read("k").map((item) => item.id)).toEqual(["c2", "c3"]);
    store.remove("k", "c2");
    store.clear("k");
    expect(store.read("k")).toEqual([]);
    expect(map.has("k")).toBe(false);
  });

  it("reads a stored list another tab wrote, and nothing from a value that is not one", () => {
    const { map, storage } = memoryStorage();
    const store = new ReplyCommentStore(() => storage);
    map.set("k", JSON.stringify([{ id: "x", quote: "q", comment: "c" }, { id: 1, quote: "q", comment: "c" }, { id: "y", quote: "", comment: "c" }]));
    expect(store.read("k")).toEqual([{ id: "x", quote: "q", comment: "c" }]);
    map.set("k", "{not json");
    expect(store.read("k")).toEqual([]);
  });
});
