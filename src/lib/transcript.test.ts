import { describe, expect, it } from "bun:test";

import { toTranscriptMessages } from "./transcript.ts";

const CLAUDE_READ = [
  "  미리보기를 보시고 어색한 부분을 알려주시면 이어서 작업하겠습니다.",
  "",
  "──────────────────────────────────────────",
  "❯ 작업은 하고있는",
  "──────────────────────────────────────────",
  "  [Fable 5.1] │ ea git:(main)",
  "  Context ███░░░░░░░ 34% │ Usage █░░░░░░░░░ 6%",
  "  ⏵⏵ bypass permissions on · 1 shell",
].join("\n");

describe("toTranscriptMessages", () => {
  it("splits a Claude Code read into agent prose, the user prompt and dimmed chrome", () => {
    const messages = toTranscriptMessages(CLAUDE_READ);
    expect(messages).toEqual([
      { role: "agent", text: "  미리보기를 보시고 어색한 부분을 알려주시면 이어서 작업하겠습니다." },
      { role: "user", text: "작업은 하고있는" },
      { role: "status", text: "  [Fable 5.1] │ ea git:(main)\n  Context ███░░░░░░░ 34% │ Usage █░░░░░░░░░ 6%\n  ⏵⏵ bypass permissions on · 1 shell" },
    ]);
  });

  it("splits agent output into paragraph bubbles on blank lines", () => {
    const messages = toTranscriptMessages("first line\nsecond line\n\nthird line");
    expect(messages).toEqual([
      { role: "agent", text: "first line\nsecond line" },
      { role: "agent", text: "third line" },
    ]);
  });
  it("drops rule separators between turns instead of rendering them", () => {
    expect(toTranscriptMessages("──────\nhello\n──────")).toEqual([{ role: "agent", text: "hello" }]);
  });

  it("dims turn metadata (✳ Brewed, ※ recap) as status, not bubbles", () => {
    const brewed = toTranscriptMessages("✳ Brewed for 17s · done");
    const recap = toTranscriptMessages("※ recap: 3 lines");
    expect(brewed[0]?.role).toBe("status");
    expect(recap[0]?.role).toBe("status");
  });

  it("keeps an empty prompt as nothing rather than an empty user bubble", () => {
    expect(toTranscriptMessages("❯")).toEqual([]);
  });

  it("degrades unknown output to agent bubbles instead of guessing a speaker", () => {
    expect(toTranscriptMessages("$ ls\nfile.txt")).toEqual([
      { role: "agent", text: "$ ls\nfile.txt" },
    ]);
  });

  it("returns nothing for an empty read", () => {
    expect(toTranscriptMessages("")).toEqual([]);
    expect(toTranscriptMessages("\n\n")).toEqual([]);
  });

  it("does not let leading or trailing blank lines leak into a bubble", () => {
    expect(toTranscriptMessages("\n\n  output\n\n")).toEqual([{ role: "agent", text: "  output" }]);
  });
});
