import { describe, expect, it } from "bun:test";

import { PANE_SUMMARY_TEXT_MAX, summaryOf } from "./pane-summary.ts";
import type { ConversationPart, ConversationTurn } from "./protocol.ts";

const user = (text: string, ts: string): ConversationTurn => ({ role: "user", ts, parts: [{ kind: "text", text }] });
const assistant = (parts: ConversationPart[], ts: string, end_ts?: string): ConversationTurn =>
  ({ role: "assistant", ts, ...(end_ts ? { end_ts } : {}), parts });
const tool: ConversationPart = { kind: "tool", name: "Bash", summary: "ls", input: "{}", output: "" };

describe("summaryOf", () => {
  it("picks the final answer after the tool parts, timed by the turn's end", () => {
    const summary = summaryOf([
      user("Fix the build", "2026-11-12T10:00:00Z"),
      assistant([{ kind: "text", text: "Looking", phase: "commentary" }, tool, { kind: "text", text: "Fixed  it\n now.", phase: "final_answer" }, tool, { kind: "text", text: "One more note", phase: "commentary" }],
        "2026-11-12T10:00:05Z", "2026-11-12T10:03:00Z"),
    ]);
    expect(summary).toEqual({ role: "assistant", text: "Fixed it now.", at: "2026-11-12T10:03:00Z", asked_at: "2026-11-12T10:00:00Z" });
  });

  it("gives the user's words when the newest turn is theirs and nobody answered", () => {
    const summary = summaryOf([
      user("first", "2026-11-12T09:00:00Z"),
      assistant([{ kind: "text", text: "done" }], "2026-11-12T09:01:00Z"),
      { role: "user", ts: "2026-11-12T10:00:00Z", parts: [{ kind: "text", text: "  and now this  " }, { kind: "text", text: "pasted context" }] },
      assistant([{ kind: "thinking", text: "hmm" }, tool], "2026-11-12T10:00:02Z"),
    ]);
    expect(summary).toEqual({ role: "user", text: "and now this", at: "2026-11-12T10:00:00Z", asked_at: "2026-11-12T10:00:00Z" });
  });

  it("is null when only tool and thinking parts were said", () => {
    expect(summaryOf([assistant([{ kind: "thinking", text: "plan" }, tool, { kind: "text", text: "   " }], "2026-11-12T10:00:00Z")])).toBeNull();
    expect(summaryOf([])).toBeNull();
  });

  it("cuts a long text to the limit without splitting a surrogate pair", () => {
    const text = `${"a".repeat(PANE_SUMMARY_TEXT_MAX - 1)}😀${"b".repeat(400 - PANE_SUMMARY_TEXT_MAX - 1)}`;
    expect(text).toHaveLength(400);
    const summary = summaryOf([assistant([{ kind: "text", text }], "2026-11-12T10:00:00Z")]);
    expect(summary!.text).toBe("a".repeat(279));
    const plain = summaryOf([assistant([{ kind: "text", text: "c".repeat(400) }], "2026-11-12T10:00:00Z")]);
    expect(plain!.text).toHaveLength(280);
  });

  it("cuts between graphemes: an emoji sequence or a letter with its combining marks is never split", () => {
    const words = (text: string) => summaryOf([assistant([{ kind: "text", text }], "2026-11-12T10:00:00Z")])!.text;
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
    expect(words(`${"a".repeat(PANE_SUMMARY_TEXT_MAX - 5)}${family}b`)).toBe("a".repeat(PANE_SUMMARY_TEXT_MAX - 5));
    expect(words(`${"a".repeat(PANE_SUMMARY_TEXT_MAX - 11)}${family}b`)).toBe(`${"a".repeat(PANE_SUMMARY_TEXT_MAX - 11)}${family}`);
    const flag = "\u{1F1F0}\u{1F1F7}";
    expect(words(`${"a".repeat(PANE_SUMMARY_TEXT_MAX - 3)}${flag}b`)).toBe("a".repeat(PANE_SUMMARY_TEXT_MAX - 3));
    const marked = "e\u0301\u0323";
    expect(words(`${"a".repeat(PANE_SUMMARY_TEXT_MAX - 2)}${marked}b`)).toBe("a".repeat(PANE_SUMMARY_TEXT_MAX - 2));
    expect(words("a".repeat(PANE_SUMMARY_TEXT_MAX))).toHaveLength(PANE_SUMMARY_TEXT_MAX);
  });

  it("loads and cuts by code points where the runtime has no Intl.Segmenter, never inside a surrogate pair", async () => {
    const segmenter = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
    Reflect.deleteProperty(Intl, "Segmenter");
    try {
      // a copy of the module of its own, loaded while the API is missing, as an older browser loads the bundle
      const copy = "./pane-summary.ts?without-segmenter";
      const bare = await import(copy) as typeof import("./pane-summary.ts");
      const text = `${"a".repeat(PANE_SUMMARY_TEXT_MAX - 1)}\u{1F600}b`;
      const words = bare.summaryOf([assistant([{ kind: "text", text }], "2026-11-12T10:00:00Z")])!.text;
      expect(words).toBe("a".repeat(PANE_SUMMARY_TEXT_MAX - 1));
      expect(bare.summaryOf([assistant([{ kind: "text", text: "c".repeat(400) }], "2026-11-12T10:00:00Z")])!.text).toHaveLength(PANE_SUMMARY_TEXT_MAX);
    } finally {
      if (segmenter) Object.defineProperty(Intl, "Segmenter", segmenter);
    }
    expect(typeof Intl.Segmenter).toBe("function");
  });

  it("leaves a call such as handlers[0](event) as written: a link's target names a path, a file or an address", () => {
    const words = (text: string) => summaryOf([assistant([{ kind: "text", text }], "2026-11-12T10:00:00Z")])!.text;
    expect(words("Then handlers[0](event) runs.")).toBe("Then handlers[0](event) runs.");
    expect(words("Read [docs](https://example.com/a) and [here](./README.md), see [top](#top).")).toBe("Read docs and here, see top.");
  });

  it("leaves a label longer than a link's bound as written", () => {
    const words = (text: string) => summaryOf([assistant([{ kind: "text", text }], "2026-11-12T10:00:00Z")])!.text;
    const label = "x".repeat(201);
    expect(words(`[${label}](https://example.com/a)`)).toBe(`[${label}](https://example.com/a)`);
    expect(words(`[${"x".repeat(200)}](https://example.com/a)`)).toBe("x".repeat(200));
  });

  it("reads an inline link as its label before the cut", () => {
    const words = (text: string) => summaryOf([assistant([{ kind: "text", text }], "2026-11-12T10:00:00Z")])!.text;
    expect(words("See [the run](https://example.com/run) and [docs](https://example.com/d \"Docs\").")).toBe("See the run and docs.");
    const url = `https://example.com/${"x".repeat(400)}`;
    expect(words(`${"a".repeat(PANE_SUMMARY_TEXT_MAX - 10)} [the run](${url})`)).toBe(`${"a".repeat(PANE_SUMMARY_TEXT_MAX - 10)} the run`);
  });

  it("keeps a line that is only an inline code span as words, not a fence", () => {
    const words = (text: string) => summaryOf([assistant([{ kind: "text", text }], "2026-11-12T10:00:00Z")])!.text;
    expect(words("```npm test```")).toBe("```npm test```");
    expect(words("Run\n```npm test```\nnow")).toBe("Run ```npm test``` now");
  });

  it("times asked_at by the newest user turn and is null when there is none", () => {
    const turns = [user("a", "2026-11-12T08:00:00Z"), user("b", "2026-11-12T09:00:00Z"), assistant([{ kind: "text", text: "ok" }], "2026-11-12T09:00:01Z")];
    expect(summaryOf(turns)!.asked_at).toBe("2026-11-12T09:00:00Z");
    expect(summaryOf([assistant([{ kind: "text", text: "hi" }], "2026-11-12T09:00:01Z")])!.asked_at).toBeNull();
  });

  it("times asked_at by the newest turn the user wrote, past the turns the runtime put in the user's seat", () => {
    const runtime = (parts: ConversationPart[], ts: string): ConversationTurn => ({ role: "user", ts, parts });
    const turns = [
      user("Fix the build", "2026-11-12T10:00:00Z"),
      assistant([{ kind: "text", text: "On it" }], "2026-11-12T10:00:05Z"),
      runtime([{ kind: "compact", text: "Earlier: the build" }], "2026-11-12T10:20:00Z"),
      runtime([{ kind: "notice", text: "model unavailable", source: "informational" }], "2026-11-12T10:21:00Z"),
      runtime([{ kind: "task_result", tasks: [] }], "2026-11-12T10:22:00Z"),
      runtime([{ kind: "goal_wait", due_at: "2026-11-12T10:30:00Z", waiting_on: { tasks: 1, monitors: 0, terminals: 0, dags: 0, cells: 0 } }], "2026-11-12T10:23:00Z"),
      assistant([{ kind: "text", text: "Still on it" }], "2026-11-12T10:24:00Z"),
    ];
    expect(summaryOf(turns)!.asked_at).toBe("2026-11-12T10:00:00Z");
    expect(summaryOf(turns.slice(2))!.asked_at).toBeNull();
  });

  it("drops Markdown block marks and fence lines, keeping marks inside a line", () => {
    const words = (text: string) => summaryOf([assistant([{ kind: "text", text }], "2026-11-12T10:00:00Z")])!.text;
    expect(words("## 2.0\n### Added\n- --retries retries a failed upload (#48)\n- Flags can live in cli-tools.toml"))
      .toBe("2.0 Added --retries retries a failed upload (#48) Flags can live in cli-tools.toml");
    expect(words("Run this:\n```bash\nbun test\n```\nDone.")).toBe("Run this: bun test Done.");
    expect(words("Run this:\n~~~\nbun test\n~~~\nDone.")).toBe("Run this: bun test Done.");
    expect(words("See:\n```js title=x\nlet a = 1;\n```")).toBe("See: let a = 1;");
    expect(words("1. Read the file\n2) Edit it\n> quoted\n* star + plus")).toBe("Read the file Edit it quoted star + plus");
    expect(words("a - b, issue #48, `code` and **bold**")).toBe("a - b, issue #48, `code` and **bold**");
  });

  it("marks words from a failed request", () => {
    const summary = summaryOf([assistant([{ kind: "text", text: "Error: rate limited", failed: true }], "2026-11-12T10:00:00Z")]);
    expect(summary).toEqual({ role: "assistant", text: "Error: rate limited", at: "2026-11-12T10:00:00Z", asked_at: null, failed: true });
  });

  it("is null for words that clean to nothing, and looks at the next older turn", () => {
    const fences = "```\n```ts\n```";
    expect(summaryOf([assistant([{ kind: "text", text: fences }], "2026-11-12T10:00:00Z")])).toBeNull();
    const summary = summaryOf([
      assistant([{ kind: "text", text: "Earlier words" }], "2026-11-12T09:00:00Z"),
      assistant([{ kind: "text", text: fences, phase: "final_answer" }], "2026-11-12T10:00:00Z"),
    ]);
    expect(summary).toEqual({ role: "assistant", text: "Earlier words", at: "2026-11-12T09:00:00Z", asked_at: null });
  });
});
