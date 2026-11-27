import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { ConversationTurn } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import * as clipboard from "../lib/clipboard.ts";
import * as plainTextModule from "../lib/plainText.ts";
import { Turn } from "./ChatTurn.tsx";

/** One assistant turn whose words are its whole content; `ts` null keeps its row free of clocks. */
const assistantTurn = (textParts?: string[]): ConversationTurn => ({ role: "assistant", ts: null, parts: textParts === undefined ? [{ kind: "text", text: "An answer." }] : textParts.map((text) => ({ kind: "text", text })) });

const turnProps = (turn: ConversationTurn) => ({ paneId: "p1", turn, rowKey: "row", live: false, waiting: false, showThinking: false });

describe("an assistant turn's TXT copy derives its words only when copied", () => {
  let page: Page;
  const copySelector = (label: string) => `button[aria-label="${label}"]`;
  let plainTextSpy: ReturnType<typeof spyOn>;
  let copyTextSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    page = openPage();
    // Keep the copy affordance's reset timer inside this fixture.
    Object.defineProperty(page.window, "setTimeout", { configurable: true, value: () => 0 });
    const realPlainText = plainTextModule.plainText; // the original implementation, captured before any spy is installed; the spy counts while delegating to it byte-for-byte
    plainTextSpy = spyOn(plainTextModule, "plainText").mockImplementation((markdown) => realPlainText(markdown));
    copyTextSpy = spyOn(clipboard, "copyText").mockImplementation(() => Promise.resolve(true)); // the clipboard write is observed, not performed (no live browser here)
  });

  afterEach(async () => {
    await page.close();
    plainTextSpy.mockRestore();
    copyTextSpy.mockRestore();
  });

  const renderTurn = async (turn: ConversationTurn): Promise<void> => {
    await page.render(<SettingsProvider><Turn {...turnProps(turn)} /></SettingsProvider>);
  };

  const clickCopy = async (label: string): Promise<void> => {
    // onClick is `void copy()`: its synchronous part - deriving plain text and calling copyText - runs
    // inside this act; only its state update (setCopied) settles later as a microtask, which no assertion
    // here depends on
    await act(async () => { page.one(copySelector(label)).click(); });
  };
  it("renders an answer without deriving its plain text (baseline)", async () => {
    await renderTurn(assistantTurn(["# Plan\n\n**One** step:\n\n```\nrun tests\n```\n\nSee [the docs](https://example.com/docs) for more."])); // markdown with a heading, bold, a code fence and a link (AC-002 content shapes)
    expect(page.container.querySelector(copySelector("Copy as markdown"))).not.toBeNull(); // both copy buttons are drawn beside the answer's words
    expect(page.container.querySelector(copySelector("Copy as plain text"))).not.toBeNull();
    expect(plainTextSpy).toHaveBeenCalledTimes(0); // RED before TASK-002: the row derived it on every render; GREEN after: zero until a TXT copy is asked for (AC-002)
  });

  it("streams new words into the answer without deriving its plain text", async () => {
    await renderTurn(assistantTurn(["First words."]));
    await renderTurn(assistantTurn(["First words.", "More words arrive while the turn runs."])); // a streaming update just before the click (AC-002)
    expect(plainTextSpy).toHaveBeenCalledTimes(0); // nothing derived while the words streamed in or settled into their row
    await clickCopy("Copy as plain text");
    expect(copyTextSpy).toHaveBeenCalledTimes(1); // one clipboard write for one click: the gesture semantics are unchanged (AC-006)
    expect(copyTextSpy).toHaveBeenCalledWith("First words.\n\nMore words arrive while the turn runs."); // the words visible at activation; a settled answer has no markdown to strip here, so plain and markdown agree byte-for-byte (AC-002)
    expect(plainTextSpy).toHaveBeenCalledTimes(1); // derived once, in the click itself - never earlier than that (AC-002)
  });

  it("copies the answer as markdown without deriving its plain text", async () => {
    const answer = "**Bold** and [a link](https://example.com) and `code`."; // a markdown answer whose plain form differs from it (AC-002)
    await renderTurn(assistantTurn([answer])); // a TXT copy beside it must not pay for a plain-text pass either (AC-006)
    await clickCopy("Copy as markdown"); // the MD copy needs no plain-text pass at all (AC-002)
    expect(copyTextSpy).toHaveBeenCalledTimes(1); // one clipboard write for one click (AC-006)
    expect(copyTextSpy).toHaveBeenCalledWith(answer); // byte-for-byte what the MD copy always copied (AC-002)
    expect(plainTextSpy).toHaveBeenCalledTimes(0); // nothing derived on render and nothing needed for markdown (AC-002)
  });

  it("starts the plain-text clipboard write inside the click gesture", async () => {
    await renderTurn(assistantTurn(["# Heading\n\n> quoted\n~~gone~~ and **kept**."]));
    await act(async () => {
      page.one(copySelector("Copy as plain text")).click();
      // Check before act flushes microtasks: the browser may require an active user gesture.
      expect(copyTextSpy.mock.calls).toEqual([["Heading\n\nquoted\ngone and kept."]]);
    });
    expect(copyTextSpy).toHaveBeenCalledTimes(1);
    expect(plainTextSpy).toHaveBeenCalledTimes(1);
  });

  const brackets = "[".repeat(96 * 1024);
  it.each([
    { kind: "unmatched brackets", answer: `\`\`\`text\n${brackets}\n\`\`\``, expected: `${brackets}\n` },
    { kind: "backticks without a fence newline", answer: "```".repeat(32 * 1024), expected: "" },
  ])("does not stall the clipboard write on a long run of $kind", async ({ answer, expected }) => {
    await renderTurn(assistantTurn([answer]));
    await act(async () => {
      const button = page.one(copySelector("Copy as plain text"));
      const start = process.cpuUsage();
      button.click();
      const { user, system } = process.cpuUsage(start);
      expect(copyTextSpy.mock.calls).toEqual([[expected]]);
      // Legacy rescanning used seconds of CPU. Allow a full second for the synchronous write.
      expect((user + system) / 1_000_000).toBeLessThan(1);
    });
  }, 30_000);

  it("shows no copy buttons for an empty answer, so nothing is derived", async () => {
    await renderTurn({ role: "assistant", ts: null, parts: [{ kind: "text", text: "" }] }); // an answer with no words (AC-002 boundary)
    expect(page.container.querySelector(copySelector("Copy as markdown"))).toBeNull(); // the copy row is drawn only beside words (AC-006)
    expect(page.container.querySelector(copySelector("Copy as plain text"))).toBeNull();
    expect(plainTextSpy).toHaveBeenCalledTimes(0); // nothing derived for an empty answer (AC-002)
  });

  it("copies a large answer with CJK, emoji, code and links byte-for-byte, deriving once in the click", async () => {
    const tail = "tail".repeat(4096);
    const answer = ["# 計畫 Plan", "", "**重點** key points:", "", "```", "const n = 42; // 計算", "console.log(n);", "```", "", "- [文件](https://example.com/docs) 🎉", "- 中文與 emoji 🚀 mixed", "", tail].join("\n");
    await renderTurn(assistantTurn([answer])); // a long answer must not pay a plain-text pass while it renders (AC-002)
    expect(plainTextSpy).toHaveBeenCalledTimes(0); // nothing derived while the row rendered (AC-002)
    await clickCopy("Copy as plain text"); // one click: derive once, write once (AC-006)
    expect(copyTextSpy).toHaveBeenCalledTimes(1); // one clipboard write for one click (AC-006)
    expect(copyTextSpy).toHaveBeenCalledWith(`計畫 Plan\n\n重點 key points:\n\nconst n = 42; // 計算\nconsole.log(n);\n\n\n- 文件 🎉\n- 中文與 emoji 🚀 mixed\n\n${tail}`);
    expect(plainTextSpy).toHaveBeenCalledTimes(1); // derived exactly once, in the click itself (AC-002)
  });
});
