import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { capturePiDeliveryAnchor, capturePiDeliveryAnchorAttempt, capturePiDeliveryAnchorRetrying, matchPiDeliveries, PiReceiptCapacity, piRecordText, type PiDeliveryAnchor, type PiDeliveryCandidate } from "./pi-delivery.ts";

const roots: string[] = [];
const dir = () => { const root = mkdtempSync(join(tmpdir(), "ovis-pi-delivery-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
/** `stamp` is the time Pi gave the message when it was submitted, before it was written. */
const entry = (id: string, parentId: string | null, role: string, text: string, stamp = Date.now()) => JSON.stringify({
  type: "message", id, parentId, timestamp: "2026-10-24T00:00:00.000Z",
  message: { role, content: [{ type: "text", text }], timestamp: stamp },
}) + "\n";
const header = (id = crypto.randomUUID()) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-24T00:00:00.000Z", cwd: "/tmp" }) + "\n";
const candidate = (id: string, text: string, anchor: NonNullable<ReturnType<typeof capturePiDeliveryAnchor>>): PiDeliveryCandidate => ({ id, text, anchor });
const template = (id: string, text: string, anchor: NonNullable<ReturnType<typeof capturePiDeliveryAnchor>>): PiDeliveryCandidate => ({ id, text, template: true, anchor });

describe("Pi receipt capacity", () => {
  it("reserves synchronously across panes for one owner", () => {
    const owner = {}, capacity = new PiReceiptCapacity<object>(1);
    const firstPane = capacity.reserve(owner);
    expect(firstPane).not.toBeNull();
    expect(capacity.reserve(owner)).toBeNull();
    capacity.release(firstPane);
  });

  it("releases a failed send's reservation", () => {
    const owner = {}, capacity = new PiReceiptCapacity<object>(1);
    const failed = capacity.reserve(owner);
    capacity.release(failed);
    expect(capacity.reserve(owner)).not.toBeNull();
  });

  it("guards record-time retention even without a reservation", () => {
    const owner = {}, capacity = new PiReceiptCapacity<object>(1);
    expect(capacity.retain(owner)).toBe(true);
    expect(capacity.retain(owner)).toBe(false);
    capacity.remove(owner);
    const reserved = capacity.reserve(owner);
    expect(capacity.retain(owner, reserved)).toBe(true);
  });
});

describe("Pi delivery transcript matching", () => {
  it.each(["append bytes", "complete record", "partial record", "retention", "entry count"])("settles permanent %s budget exhaustion without retry or partial consumption", (budget) => {
    const path = join(dir(), "budget.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    const receipts = [candidate("one", "ours", anchor), candidate("two", "next", anchor)];
    const consumed = new Set<string>();
    if (budget === "retention") {
      appendFileSync(path, entry("large", "base", "user", "x".repeat(9 * 1024 * 1024)));
      expect(matchPiDeliveries(path, receipts, consumed).retry).toBe(false);
      appendFileSync(path, entry("larger", "large", "user", "x".repeat(9 * 1024 * 1024)));
    } else if (budget === "entry count") {
      for (let index = 0; index < 100_001; index++) appendFileSync(path, entry(`e${index}`, index ? `e${index - 1}` : "base", "assistant", ""));
    } else {
      appendFileSync(path, entry("ours", "base", "user", "ours"));
      appendFileSync(path, budget === "append bytes" ? "x".repeat(32 * 1024 * 1024)
        : budget === "complete record" ? entry("large", "ours", "assistant", "x".repeat(16 * 1024 * 1024))
        : "x".repeat(16 * 1024 * 1024 + 1));
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(matchPiDeliveries(path, receipts, consumed)).toEqual({ consumed: [], changed: [], unavailable: ["one", "two"], retry: false });
      expect(consumed.size).toBe(0);
    }
  });

  it("reads a skill Pi recorded as its whole SKILL.md back as typed, so the receipts behind it confirm too", () => {
    const path = join(dir(), "skill.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    // as pi 1.4 records `/skill:commit and push`, then `/skill:commit`
    const skill = (request: string) => `<skill name="commit" location="/home/me/.agents/skills/committing/SKILL.md">\nReferences are relative to /home/me/.agents/skills/committing.\n\nCommit the changes.\n</skill>${request ? `\n\n${request}` : ""}`;
    appendFileSync(path, entry("s1", "base", "user", skill("and push")) + entry("a1", "s1", "assistant", "done")
      + entry("s2", "a1", "user", skill("")) + entry("a2", "s2", "assistant", "done") + entry("u3", "a2", "user", "plain"));
    const receipts = [candidate("one", "/skill:commit and push", anchor), candidate("two", "/skill:commit", anchor), candidate("three", "plain", anchor)];
    expect(matchPiDeliveries(path, receipts).consumed).toEqual(["one", "two", "three"]);
  });

  it("matches a skill sent with extra white space as Pi trims its request", () => {
    const path = join(dir(), "skill-spaces.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    appendFileSync(path, entry("s1", "base", "user", `<skill name="commit" location="/s/SKILL.md">\nReferences are relative to /s.\n\nCommit.\n</skill>\n\nand push`));
    // Pi pastes the tab as four spaces, then trims the request after the first one
    appendFileSync(path, entry("s2", "s1", "user", `<skill name="commit" location="/s/SKILL.md">\nReferences are relative to /s.\n\nCommit.\n</skill>\n\nand push`));
    expect(matchPiDeliveries(path, [candidate("one", piRecordText("/skill:commit  and push "), anchor),
      candidate("two", piRecordText("/skill:commit\tand push"), anchor)]).consumed).toEqual(["one", "two"]);
  });

  it("matches a /skill: text Pi sends as typed, where it knows no such skill or the name runs past a line", () => {
    const path = join(dir(), "skill-verbatim.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    appendFileSync(path, entry("u1", "base", "user", "/skill:nope  x") + entry("u2", "u1", "user", "/skill:commit\nand  push"));
    expect(matchPiDeliveries(path, [candidate("one", piRecordText("/skill:nope  x"), anchor),
      candidate("two", piRecordText("/skill:commit\nand  push"), anchor)]).consumed).toEqual(["one", "two"]);
  });

  it("matches a send with CRLF or CR line ends as Pi's paste handler records it, with LF", () => {
    const path = join(dir(), "crlf.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    // Pi's editor turns CRLF and a lone CR into LF and drops other control characters
    appendFileSync(path, entry("u1", "base", "user", "line one\nline two\nline three") + entry("u2", "u1", "user", "after"));
    expect(matchPiDeliveries(path, [candidate("one", piRecordText("line one\r\nline two\rline\u0007 three\r\n"), anchor),
      candidate("two", "after", anchor)]).consumed).toEqual(["one", "two"]);
  });

  it("settles a /name send Pi ran as a template or command, so the receipts behind it confirm too", () => {
    const path = join(dir(), "template.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    // `/review the parser` and `/review the lexer` recorded only as their expansions; `/deploy`, an
    // extension's command, recorded as nothing; `/plain`, a name Pi has not loaded, recorded as typed
    appendFileSync(path, entry("e1", "base", "user", "Review this code: the parser") + entry("a1", "e1", "assistant", "done")
      + entry("e2", "a1", "user", "Review this code: the lexer") + entry("a2", "e2", "assistant", "done")
      + entry("u3", "a2", "user", "after") + entry("u4", "u3", "user", "/plain"));
    const receipts = [template("one", "/review the parser", anchor), template("two", "/review the lexer", anchor),
      candidate("three", "/deploy", anchor), candidate("four", "after", anchor), candidate("five", "/plain", anchor)];
    expect(matchPiDeliveries(path, receipts).consumed).toEqual(["one", "two", "three", "four", "five"]);
  });

  it("leaves a skill's record to its own receipt behind a command Pi recorded as nothing", () => {
    const path = join(dir(), "command-skill.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    appendFileSync(path, entry("s1", "base", "user", `<skill name="commit" location="/s/SKILL.md">\nReferences are relative to /s.\n\nCommit.\n</skill>\n\nand push`));
    expect(matchPiDeliveries(path, [candidate("one", "/deploy", anchor), candidate("two", "/skill:commit and push", anchor)]).consumed).toEqual(["one", "two"]);
  });

  it("leaves every copy of a record to the later receipts that claim them all", () => {
    const path = join(dir(), "command-skills.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    const skill = `<skill name="commit" location="/s/SKILL.md">\nReferences are relative to /s.\n\nCommit.\n</skill>\n\nand push`;
    appendFileSync(path, entry("s1", "base", "user", skill) + entry("s2", "s1", "user", skill));
    expect(matchPiDeliveries(path, [candidate("one", "/deploy", anchor), candidate("two", "/skill:commit and push", anchor),
      candidate("three", "/skill:commit and push", anchor)]).consumed).toEqual(["one", "two", "three"]);
  });

  it("gives a template's expansion to it where a later message of the same text has its own record", () => {
    const path = join(dir(), "template-same-text.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    appendFileSync(path, entry("e1", "base", "user", "hello") + entry("u2", "e1", "user", "hello") + entry("u3", "u2", "user", "hello"));
    const consumed = new Set<string>();
    expect(matchPiDeliveries(path, [template("one", "/review", anchor), candidate("two", "hello", anchor)], consumed).consumed).toEqual(["one", "two"]);
    // the third record is left for a later receipt
    expect(consumed.size).toBe(2);
  });

  it("settles a /name Pi recorded as typed but stamped before the capture as ambiguous", () => {
    const path = join(dir(), "template-earlier.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    appendFileSync(path, entry("u1", "base", "user", "/plain", anchor.at - 60_000));
    expect(matchPiDeliveries(path, [candidate("one", "/plain", anchor)])).toMatchObject({ consumed: [], ambiguous: ["one"] });
  });

  it("settles a template the pane's catalog did not list once a later send's record follows its expansion", () => {
    const path = join(dir(), "template-unlisted.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    appendFileSync(path, entry("e1", "base", "user", "Review this code: the parser"));
    const receipts = [candidate("one", "/review the parser", anchor), candidate("two", "after", anchor)];
    expect(matchPiDeliveries(path, receipts).consumed).toEqual([]);
    appendFileSync(path, entry("a1", "e1", "assistant", "done") + entry("u2", "a1", "user", "after"));
    expect(matchPiDeliveries(path, receipts).consumed).toEqual(["one", "two"]);
  });

  it("skips a record no Ovis send claims for a /name message, which may still be recorded as typed", () => {
    const path = join(dir(), "slash-message.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    // typed in the terminal before Pi recorded the Ovis send
    appendFileSync(path, entry("t1", "base", "user", "from the terminal"));
    const receipts = [candidate("one", "/home/me/file explain this", anchor)];
    expect(matchPiDeliveries(path, receipts).consumed).toEqual([]);
    appendFileSync(path, entry("u2", "t1", "user", "/home/me/file explain this"));
    expect(matchPiDeliveries(path, receipts).consumed).toEqual(["one"]);
  });

  it("keeps a /name receipt waiting until Pi records something after it", () => {
    const path = join(dir(), "template-wait.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    expect(matchPiDeliveries(path, [candidate("one", "/review", anchor), candidate("two", "after", anchor)]).consumed).toEqual([]);
  });

  it("never lets a literal record confirm a different /skill: send", () => {
    const path = join(dir(), "skill-literal.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    // Pi knows no `missing` skill, so it records each text as sent: this record is another message
    appendFileSync(path, entry("u1", "base", "user", "/skill:missing hello"));
    expect(matchPiDeliveries(path, [candidate("one", piRecordText("/skill:missing  hello"), anchor)]).consumed).toEqual([]);
  });

  it.each([
    ["without Pi's references line", `<skill name="commit" location="/s/commit/SKILL.md">\nCommit.\n</skill>\n\nhello`],
    ["naming another directory than its file's", `<skill name="commit" location="/s/commit/SKILL.md">\nReferences are relative to /elsewhere.\n\nCommit.\n</skill>\n\nhello`],
    ["of another skill", `<skill name="review" location="/s/review/SKILL.md">\nReferences are relative to /s/review.\n\nReview.\n</skill>\n\nhello`],
  ])("does not take a message shaped like a skill block %s as Pi's expansion", (_, text) => {
    const path = join(dir(), "skill-shaped.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    appendFileSync(path, entry("u1", "base", "user", text));
    expect(matchPiDeliveries(path, [candidate("one", "/skill:commit hello", anchor)]).consumed).toEqual([]);
  });

  it.each([
    ["no request", "", "/skill:commit hello\n</skill>"],
    ["a request", "\n\nmore", "/skill:commit hello\n</skill>\n\nmore"],
  ])("does not confirm another request from a skill whose body closes its tag early, with %s", (_, request, other) => {
    const path = join(dir(), "skill-body-tag.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    // a SKILL.md body of `Example:\n</skill>\n\nhello`: where the block ends is not provable from the record
    appendFileSync(path, entry("s1", "base", "user", `<skill name="commit" location="/s/commit/SKILL.md">\nReferences are relative to /s/commit.\n\nExample:\n</skill>\n\nhello\n</skill>${request}`));
    expect(matchPiDeliveries(path, [candidate("one", other, anchor)]).consumed).toEqual([]);
    expect(matchPiDeliveries(path, [candidate("two", `/skill:commit${request ? " more" : ""}`, anchor)]).consumed).toEqual([]);
  });

  it.each([
    ["a Unix root", "/SKILL.md", "/"],
    ["a Windows drive root", "C:\\SKILL.md", "C:\\"],
    ["a nested Windows directory", "C:\\skills\\commit\\SKILL.md", "C:\\skills\\commit"],
    ["a nested Unix directory", "/home/me/skills/commit/SKILL.md", "/home/me/skills/commit"],
  ])("reads back a skill whose file is in %s", (_, location, baseDir) => {
    const path = join(dir(), "skill-root.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    appendFileSync(path, entry("s1", "base", "user", `<skill name="commit" location="${location}">\nReferences are relative to ${baseDir}.\n\nCommit.\n</skill>\n\nhello`));
    expect(matchPiDeliveries(path, [candidate("one", "/skill:commit hello", anchor)]).consumed).toEqual(["one"]);
  });

  it("confirms one of two identical skill sends against one expanded record", () => {
    const path = join(dir(), "skill-twice.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    appendFileSync(path, entry("s1", "base", "user", `<skill name="commit" location="/s/commit/SKILL.md">\nReferences are relative to /s/commit.\n\nCommit.\n</skill>\n\nhello`));
    const consumed = new Set<string>();
    const receipts = [candidate("one", "/skill:commit hello", anchor), candidate("two", "/skill:commit hello", anchor)];
    expect(matchPiDeliveries(path, receipts, consumed).consumed).toEqual(["one"]);
    expect(matchPiDeliveries(path, receipts.slice(1), consumed).consumed).toEqual([]);
  });

  it("confirms a message that only looks like a skill's record by its own text", () => {
    const path = join(dir(), "skill-lookalike.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    const text = `<skill name="x" location="/x.md">\nwhat does this block do?\n</skill>`;
    appendFileSync(path, entry("u1", "base", "user", text) + entry("u2", "u1", "user", "next"));
    expect(matchPiDeliveries(path, [candidate("one", piRecordText(text), anchor), candidate("two", "next", anchor)]).consumed).toEqual(["one", "two"]);
  });

  it("retries a transient read failure and later confirms the same receipt", () => {
    const path = join(dir(), "transient.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    appendFileSync(path, entry("ours", "base", "user", "ours"));
    const receipts = [candidate("one", "ours", anchor)];
    const read = spyOn(fs, "readSync").mockImplementation(() => { throw new Error("transient read"); });
    try { expect(matchPiDeliveries(path, receipts)).toEqual({ consumed: [], changed: [], retry: true }); }
    finally { read.mockRestore(); }
    expect(matchPiDeliveries(path, receipts).consumed).toEqual(["one"]);
  });
  it("reads bounded tails on a 200 MiB history and parses only appended records", () => {
    const path = join(dir(), "large.jsonl");
    writeFileSync(path, header());
    // A sparse hole stands in for 200 MiB of older history: a reader that scanned it would count
    // every byte, while the disk stores none of them.
    fs.truncateSync(path, 200 * 1024 * 1024);
    appendFileSync(path, "\n" + entry("baseline", "old-24", "assistant", "done"));
    const original = fs.readSync;
    let read = 0;
    const spy = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const got = original(...args); read += got; return got;
    }) as typeof fs.readSync);
    try {
      const anchor = capturePiDeliveryAnchor(path)!;
      expect(anchor.leaf).toBe("baseline");
      expect(read).toBeLessThan(768 * 1024);
      read = 0;
      appendFileSync(path, entry("ours", "baseline", "user", "same"));
      const consumed = new Set<string>();
      expect(matchPiDeliveries(path, [candidate("one", "same", anchor)], consumed).consumed).toEqual(["one"]);
      expect(read).toBeLessThan(768 * 1024);
      read = 0;
      expect(matchPiDeliveries(path, [candidate("two", "same", anchor)], consumed).consumed).toEqual([]);
      expect(read).toBeLessThan(768 * 1024);
    } finally { spy.mockRestore(); }
  });

  it("accepts append growth during a bounded snapshot without starving confirmation", () => {
    const path = join(dir(), "growing.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    appendFileSync(path, entry("ours", "base", "user", "follow up"));
    const original = fs.readSync;
    let grew = false;
    const spy = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const got = original(...args);
      if (!grew) { grew = true; appendFileSync(path, entry("work", "ours", "assistant", "still working")); }
      return got;
    }) as typeof fs.readSync);
    try {
      expect(matchPiDeliveries(path, [candidate("one", "follow up", anchor)])).toEqual({ consumed: ["one"], changed: [], retry: false });
      expect(grew).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it("does not commit receipts or cache progress through concurrent truncation", () => {
    const path = join(dir(), "truncated.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    appendFileSync(path, entry("ours", "base", "user", "same"));
    const original = fs.readSync, consumed = new Set<string>();
    let truncated = false;
    const spy = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const got = original(...args);
      if (!truncated) { truncated = true; fs.truncateSync(path, anchor.size); }
      return got;
    }) as typeof fs.readSync);
    try {
      expect(matchPiDeliveries(path, [candidate("one", "same", anchor)], consumed)).toEqual({ consumed: [], changed: [], retry: true });
      expect(consumed.size).toBe(0);
    } finally { spy.mockRestore(); }
    appendFileSync(path, entry("ours", "base", "user", "same"));
    expect(matchPiDeliveries(path, [candidate("one", "same", anchor)], consumed).consumed).toEqual(["one"]);
  });

  it("rejects an inode replacement even with the same session, leaf and boundary tail", () => {
    const root = dir(), path = join(root, "session.jsonl"), replacement = join(root, "replacement.jsonl");
    const before = header() + entry("base", null, "assistant", "working");
    writeFileSync(path, before);
    const anchor = capturePiDeliveryAnchor(path)!;
    writeFileSync(replacement, before + entry("ours", "base", "user", "same"));
    fs.renameSync(replacement, path);
    expect(matchPiDeliveries(path, [candidate("one", "same", anchor)])).toEqual({ consumed: [], changed: ["one"], retry: false });
  });

  it("does not accept a partial line as an anchor or matching turn", () => {
    const path = join(dir(), "partial.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    const line = entry("ours", "base", "user", "same");
    appendFileSync(path, line.slice(0, -1));
    expect(capturePiDeliveryAnchor(path)).toBeNull();
    expect(matchPiDeliveries(path, [candidate("one", "same", anchor)]).consumed).toEqual([]);
    appendFileSync(path, "\n");
    expect(matchPiDeliveries(path, [candidate("one", "same", anchor)]).consumed).toEqual(["one"]);
  });

  it("confirms the first append after an already-written header-only session", () => {
    const path = join(dir(), "header-only.jsonl");
    writeFileSync(path, header());
    const anchor = capturePiDeliveryAnchor(path)!;
    expect(anchor.leaf).toBeNull();
    appendFileSync(path, entry("ours", null, "user", "first"));
    expect(matchPiDeliveries(path, [candidate("one", "first", anchor)]).consumed).toEqual(["one"]);
  });
  it("retries a capture invalidated by a concurrent append, then uses the stable anchor", async () => {
    const anchor: PiDeliveryAnchor = { path: "session.jsonl", file: "1:2", session: "s1", leaf: "a0", size: 12, prefix: "abc", at: 1 };
    let captures = 0, waits = 0;
    const result = await capturePiDeliveryAnchorRetrying(anchor.path, false, undefined,
      () => ++captures < 3 ? { anchor: null, retry: true } : { anchor, retry: false },
      async () => { waits++; });
    expect(result).toEqual(anchor);
    expect({ captures, waits }).toEqual({ captures: 3, waits: 2 });
  });

  it.each(["empty file", "partial header", "partial entry"])("retries capture with %s already present until the writer completes it", async (kind) => {
    const path = join(dir(), "in-flight.jsonl");
    const start = header(), message = entry("base", null, "assistant", "working");
    const complete = start + message;
    const prefix = kind === "empty file" ? "" : kind === "partial header" ? start.slice(0, -1) : complete.slice(0, -1);
    writeFileSync(path, prefix);
    // No write occurs during the attempt: equal before/after stats do not prove the writer is done.
    expect(capturePiDeliveryAnchorAttempt(path)).toEqual({ anchor: null, retry: true });
    let waits = 0;
    const anchor = await capturePiDeliveryAnchorRetrying(path, false, undefined, capturePiDeliveryAnchorAttempt,
      async () => { waits++; appendFileSync(path, complete.slice(prefix.length)); });
    expect(waits).toBe(1);
    expect(anchor?.leaf).toBe("base");
    appendFileSync(path, entry("ours", "base", "user", "after the write"));
    expect(matchPiDeliveries(path, [candidate("one", "after the write", anchor!)])).toEqual({ consumed: ["one"], changed: [], retry: false });
  });

  it("bounds retries for a partial record that never completes", async () => {
    const path = join(dir(), "stalled.jsonl");
    writeFileSync(path, header() + entry("base", null, "assistant", "working").slice(0, -1));
    let captures = 0, waits = 0;
    const anchor = await capturePiDeliveryAnchorRetrying(path, false, undefined,
      (...args) => { captures++; return capturePiDeliveryAnchorAttempt(...args); }, async () => { waits++; });
    expect(anchor).toBeNull();
    expect({ captures, waits }).toEqual({ captures: 3, waits: 2 });
  });

  it("does not retry a complete malformed record or a mismatching session", () => {
    const path = join(dir(), "invalid.jsonl"), session = crypto.randomUUID();
    writeFileSync(path, header(session) + "not JSON\n");
    expect(capturePiDeliveryAnchorAttempt(path)).toEqual({ anchor: null, retry: false });
    writeFileSync(path, header(session) + entry("base", null, "assistant", "working"));
    expect(capturePiDeliveryAnchorAttempt(path, false, "other-session")).toEqual({ anchor: null, retry: false });
  });

  it("does not retry a genuinely unreadable transcript capture", async () => {
    let captures = 0, waits = 0;
    const result = await capturePiDeliveryAnchorRetrying("missing.jsonl", false, undefined,
      () => { captures++; return { anchor: null, retry: false }; },
      async () => { waits++; });
    expect(result).toBeNull();
    expect({ captures, waits }).toEqual({ captures: 1, waits: 0 });
  });

  it("waits through assistant work and consumes only the durable matching user append", () => {
    const path = join(dir(), "session.jsonl");
    writeFileSync(path, header() + entry("u0", null, "user", "before") + entry("a0", "u0", "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path);
    expect(anchor?.leaf).toBe("a0");
    expect(matchPiDeliveries(path, [candidate("r1", "later", anchor!)])).toEqual({ consumed: [], changed: [], retry: false });
    appendFileSync(path, entry("u1", "a0", "user", "later"));
    expect(matchPiDeliveries(path, [candidate("r1", "later", anchor!)])).toEqual({ consumed: ["r1"], changed: [], retry: false });
  });

  it("matches duplicate Ovis text by FIFO occurrence and consumes one receipt per entry", () => {
    const path = join(dir(), "session.jsonl");
    writeFileSync(path, header() + entry("a0", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    const receipts = [candidate("r1", "same", anchor), candidate("r2", "same", anchor)];
    appendFileSync(path, entry("u1", "a0", "user", "same"));
    expect(matchPiDeliveries(path, receipts)).toEqual({ consumed: ["r1"], changed: [], retry: false });
    appendFileSync(path, entry("u2", "u1", "user", "same"));
    expect(matchPiDeliveries(path, receipts)).toEqual({ consumed: ["r1", "r2"], changed: [], retry: false });
  });

  it("ignores unrelated external user entries without advancing an Ovis receipt", () => {
    const path = join(dir(), "session.jsonl");
    writeFileSync(path, header() + entry("a0", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    appendFileSync(path, entry("external", "a0", "user", "from the terminal") + entry("ours", "external", "user", "from Ovis"));
    expect(matchPiDeliveries(path, [candidate("r1", "from Ovis", anchor)])).toEqual({ consumed: ["r1"], changed: [], retry: false });
  });

  it("does not let a same-text record Pi stamped before the capture confirm the receipt", () => {
    const path = join(dir(), "stamped.jsonl");
    writeFileSync(path, header() + entry("a0", null, "assistant", "working"));
    // Typed into Pi's own terminal and queued while it worked, before Ovis pressed Enter.
    const typedEarlier = Date.now() - 1000;
    const anchor = capturePiDeliveryAnchor(path)!;
    appendFileSync(path, entry("external", "a0", "user", "same", typedEarlier));
    expect(matchPiDeliveries(path, [candidate("r1", "same", anchor)])).toEqual({ consumed: [], changed: [], ambiguous: ["r1"], retry: false });
  });

  it("prefers the record stamped after the capture when an earlier one has the same text", () => {
    const path = join(dir(), "both.jsonl");
    writeFileSync(path, header() + entry("a0", null, "assistant", "working"));
    const typedEarlier = Date.now() - 1000;
    const anchor = capturePiDeliveryAnchor(path)!;
    const consumed = new Set<string>();
    appendFileSync(path, entry("external", "a0", "user", "same", typedEarlier) + entry("ours", "external", "user", "same"));
    const receipts = [candidate("r1", "same", anchor), candidate("r2", "same", anchor)];
    // the earlier record lies before the first receipt's match, so it cannot settle the second
    expect(matchPiDeliveries(path, receipts, consumed)).toEqual({ consumed: ["r1"], changed: [], retry: false });
    // nor in a later reconciliation, which scans the branch from the anchor again
    expect(matchPiDeliveries(path, [receipts[1]!], consumed)).toEqual({ consumed: [], changed: [], retry: false });
    appendFileSync(path, entry("ours-2", "ours", "user", "same"));
    expect(matchPiDeliveries(path, [receipts[1]!], consumed)).toEqual({ consumed: ["r2"], changed: [], retry: false });
  });

  it("keeps a later receipt's own record when a clock set back between captures put it before a match", () => {
    const path = join(dir(), "captures.jsonl");
    writeFileSync(path, header() + entry("a0", null, "assistant", "working"));
    const first = capturePiDeliveryAnchor(path)!;
    // the clock is set back a minute before Ovis's first record, then restored
    appendFileSync(path, entry("own-1", "a0", "user", "same", first.at - 60_000));
    const second = { ...capturePiDeliveryAnchor(path)!, at: first.at - 59_000 };
    appendFileSync(path, entry("own-2", "own-1", "user", "same", first.at - 58_000)
      + entry("external", "own-2", "user", "same", first.at + 1000));
    const receipts = [candidate("r1", "same", first), candidate("r2", "same", second)];
    const consumed = new Set<string>();
    expect(matchPiDeliveries(path, receipts, consumed)).toEqual({ consumed: ["r1"], changed: [], retry: false });
    expect(matchPiDeliveries(path, [receipts[1]!], consumed)).toEqual({ consumed: ["r2"], changed: [], retry: false });
  });

  it("does not keep a skipped record for a later receipt with other text", () => {
    const path = join(dir(), "other-text.jsonl");
    writeFileSync(path, header() + entry("a0", null, "assistant", "working"));
    const first = capturePiDeliveryAnchor(path)!;
    // the clock is set back a minute after the first capture
    appendFileSync(path, entry("own-1", "a0", "user", "same", first.at - 60_000));
    const second = { ...capturePiDeliveryAnchor(path)!, at: first.at - 59_000 };
    appendFileSync(path, entry("own-2", "own-1", "user", "other", first.at - 58_500));
    const third = { ...capturePiDeliveryAnchor(path)!, at: first.at - 57_000 };
    appendFileSync(path, entry("external-early", "own-2", "user", "same", first.at - 58_000)
      + entry("external-late", "external-early", "user", "same", first.at + 1000));
    const receipts = [candidate("r1", "same", first), candidate("r2", "other", second), candidate("r3", "same", third)];
    const consumed = new Set<string>();
    expect(matchPiDeliveries(path, receipts, consumed)).toEqual({ consumed: ["r1"], changed: [], retry: false });
    // the earlier external copy predates r3's capture and was passed over: it must not settle r3
    expect(matchPiDeliveries(path, receipts.slice(1), consumed)).toEqual({ consumed: ["r2"], changed: [], retry: false });
    appendFileSync(path, entry("own-3", "external-late", "user", "same", first.at - 56_000 + 60_000));
    expect(matchPiDeliveries(path, [receipts[2]!], consumed)).toEqual({ consumed: ["r3"], changed: [], retry: false });
  });

  it("settles, rather than strands, Ovis's own record stamped while the wall clock was set back", () => {
    const path = join(dir(), "clock.jsonl");
    writeFileSync(path, header() + entry("a0", null, "assistant", "working"));
    const first = capturePiDeliveryAnchor(path)!;
    // a clock corrected a minute back between the capture and Pi's stamp, and forward again
    appendFileSync(path, entry("u1", "a0", "user", "first", first.at - 60_000));
    const second = capturePiDeliveryAnchor(path)!;
    appendFileSync(path, entry("u2", "u1", "user", "second"));
    expect(matchPiDeliveries(path, [candidate("r1", "first", first), candidate("r2", "second", second)]))
      .toEqual({ consumed: ["r2"], changed: [], ambiguous: ["r1"], retry: false });
  });

  it("does not reuse a consumed transcript entry across reconciliation calls", () => {
    const path = join(dir(), "reconcile.jsonl");
    writeFileSync(path, header() + entry("a0", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    const consumed = new Set<string>();
    appendFileSync(path, entry("u1", "a0", "user", "same"));
    expect(matchPiDeliveries(path, [candidate("r1", "same", anchor), candidate("r2", "same", anchor)], consumed))
      .toEqual({ consumed: ["r1"], changed: [], retry: false });
    expect(matchPiDeliveries(path, [candidate("r2", "same", anchor)], consumed))
      .toEqual({ consumed: [], changed: [], retry: false });
    appendFileSync(path, entry("u2", "u1", "user", "same"));
    expect(matchPiDeliveries(path, [candidate("r2", "same", anchor)], consumed))
      .toEqual({ consumed: ["r2"], changed: [], retry: false });
  });

  it("does not cross ordered Ovis receipts when a later text appears first", () => {
    const path = join(dir(), "session.jsonl");
    writeFileSync(path, header() + entry("a0", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    appendFileSync(path, entry("u1", "a0", "user", "second"));
    expect(matchPiDeliveries(path, [candidate("r1", "first", anchor), candidate("r2", "second", anchor)])).toEqual({ consumed: [], changed: [], retry: false });
    appendFileSync(path, entry("u2", "u1", "user", "first") + entry("u3", "u2", "user", "second"));
    expect(matchPiDeliveries(path, [candidate("r1", "first", anchor), candidate("r2", "second", anchor)])).toEqual({ consumed: ["r1", "r2"], changed: [], retry: false });
  });

  it("accepts an unwritten session only when that exact path becomes its first file", () => {
    const path = join(dir(), "session.jsonl");
    const session = crypto.randomUUID();
    const anchor = capturePiDeliveryAnchor(path, true, session)!;
    expect(anchor).toMatchObject({ leaf: null, file: null, session });
    writeFileSync(path, header(session) + entry("u1", null, "user", "first"));
    expect(matchPiDeliveries(path, [candidate("r1", "first", anchor)])).toEqual({ consumed: ["r1"], changed: [], retry: false });
  });

  it("does not consume a pre-anchor identical turn that a later branch switch makes active", () => {
    const path = join(dir(), "branches.jsonl");
    writeFileSync(path, header() + entry("root", null, "assistant", "root")
      + entry("captured", "root", "assistant", "captured")
      + entry("old-same", "root", "user", "ours")
      + entry("current", "captured", "assistant", "current"));
    const anchor = capturePiDeliveryAnchor(path)!;
    appendFileSync(path, entry("switch", "old-same", "assistant", "switch"));
    expect(matchPiDeliveries(path, [candidate("r1", "ours", anchor)]))
      .toEqual({ consumed: [], changed: ["r1"], retry: false });
  });

  it("fails closed when the same inode is rewritten before the captured append boundary", () => {
    const path = join(dir(), "rewrite.jsonl"), session = crypto.randomUUID();
    const original = header(session) + entry("a0", null, "assistant", "old");
    writeFileSync(path, original);
    const anchor = capturePiDeliveryAnchor(path)!;
    const rewritten = header(session) + entry("b0", null, "assistant", "new");
    expect(rewritten.length).toBe(original.length);
    writeFileSync(path, rewritten);
    appendFileSync(path, entry("u1", "b0", "user", "ours"));
    expect(matchPiDeliveries(path, [candidate("r1", "ours", anchor)]))
      .toEqual({ consumed: [], changed: ["r1"], retry: false });
  });

  it("fails closed when the file or active branch no longer contains the captured leaf", () => {
    const root = dir(), path = join(root, "session.jsonl");
    writeFileSync(path, header() + entry("a0", null, "assistant", "working"));
    const replaced = capturePiDeliveryAnchor(path)!;
    writeFileSync(path, header() + entry("u1", null, "user", "ours"));
    expect(matchPiDeliveries(path, [candidate("replace", "ours", replaced)])).toEqual({ consumed: [], changed: ["replace"], retry: false });

    const branchPath = join(root, "branch.jsonl");
    writeFileSync(branchPath, header() + entry("root", null, "assistant", "root") + entry("old", "root", "assistant", "old"));
    const branched = capturePiDeliveryAnchor(branchPath)!;
    appendFileSync(branchPath, entry("new", "root", "user", "ours"));
    expect(matchPiDeliveries(branchPath, [candidate("branch", "ours", branched)])).toEqual({ consumed: [], changed: ["branch"], retry: false });
  });
});
