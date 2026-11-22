import { describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inputRowState, screenFromAnsi } from "../../shared/input-row.ts";
import { GROK_QUEUED_MESSAGE, GROK_SEND_UNCONFIRMED_MESSAGE, grokQueuedBehindMessage } from "../../shared/submit-outcome.ts";
import { HerdrError } from "../herdr/client.ts";
import { grokEcho, grokQueue, sendGrokQueuedNow, showsMessage } from "./grok-queue.ts";
import { grokScreen, type GrokScreenState } from "./grok-screen.fake.ts";

const recorded = (name: string): string => readFileSync(join(import.meta.dir, "../../src/lib/fixtures-input-rows/grok-1.0.77", `${name}-119.txt`), "utf8");
const promptState = (screen: string) => inputRowState("grok", screenFromAnsi(screen));

describe("Grok's queue and prompt on recorded screens", () => {
  it.each([
    ["idle", { mode: "fullscreen", rows: [], enterSendsNow: false }, "ready"],
    ["working", { mode: "fullscreen", rows: [], enterSendsNow: false }, "ready"],
    ["queued-1-hint", { mode: "fullscreen", rows: ["first follow-up please"], enterSendsNow: true }, "ready"],
    ["queued-1", { mode: "fullscreen", rows: ["fourth follow-up please"], enterSendsNow: true }, "ready"],
    ["queued-3", { mode: "fullscreen", rows: ["first follow-up please", "second follow-up please", "third follow-up please"], enterSendsNow: true }, "ready"],
    ["after-send-now", { mode: "fullscreen", rows: ["second follow-up please", "third follow-up please"], enterSendsNow: true }, "ready"],
    ["queued-multiline", { mode: "fullscreen", rows: [
      "a long queued follow-up part1 part2 part3 part4 part5 part6 part7 part8 part9 part10 part11 part12 part13 par…", "multi line A (+1 line)"], enterSendsNow: true }, "ready"],
    ["queue-pane-focused", null, "draft"],
    ["scrollback-focused", { mode: "fullscreen", rows: [], enterSendsNow: false }, "draft"],
    ["permission", null, "gone"],
    ["draft-lines", { mode: "fullscreen", rows: [], enterSendsNow: false }, "draft"],
    ["draft-second-line", { mode: "fullscreen", rows: [], enterSendsNow: false }, "draft"],
    ["minimal-working", { mode: "minimal", count: 0 }, "gone"],
    ["minimal-queued-1", { mode: "minimal", count: 1 }, "gone"],
    ["minimal-queued-2", { mode: "minimal", count: 2 }, "gone"],
  ] as const)("%s", (name, queue, prompt) => {
    const screen = recorded(name);
    expect(grokQueue(screen)).toEqual(queue);
    expect(promptState(screen)).toBe(prompt);
  });

  it("knows each queued row Grok drew for the message it was typed from", () => {
    const long = `a long queued follow-up ${Array.from({ length: 30 }, (_, index) => `part${index + 1}`).join(" ")}`;
    expect(showsMessage("first follow-up please", "first follow-up please")).toBe(true);
    expect(showsMessage("multi line A (+1 line)", "multi line A\nmulti line B")).toBe(true);
    expect(showsMessage("a long queued follow-up part1 part2 part3 part4 part5 part6 part7 part8 part9 part10 part11 part12 part13 par…", long)).toBe(true);
    expect(showsMessage("first follow-up please", "first follow-up")).toBe(false);
    expect(showsMessage("multi line A", "multi line A\nmulti line B")).toBe(false);
    expect(showsMessage("multi line A (+1 line)", "multi line A")).toBe(false);
    expect(showsMessage("…", "first follow-up please")).toBe(false);
  });
});

const withTopRow = (name: string, row: string): string => recorded(name).replace(/^ {4}#1 .*$/m, `    #1 ${row}`);
const withRows = (...rows: string[]): string => recorded("queued-1").replace(/^ {4}#1 .*$/m, rows.map((row, index) => `    #${index + 1} ${row}`).join("\n"));
const withEcho = (...lines: string[]): string => recorded("working").replace(/^ {5}❯ .*$/m, [`     ❯ ${lines[0]!.padEnd(98)}7:22 PM`, ...lines.slice(1).map((line) => `       ${line}`)].join("\n"));
const parts = Array.from({ length: 13 }, (_, index) => `part${index + 1}`).join(" ");

describe("Send now's one more Enter, decided on recorded screens", () => {
  it.each([
    ["the message alone on top of a queue empty before it", "working", "queued-1", "fourth follow-up please", null],
    ["an older row cut to the same drawn prefix", "queued-long", "queued-long", `a long queued follow-up ${parts} partial rewrite of the rest`, GROK_QUEUED_MESSAGE],
    ["an older row with the same first line and line count", withTopRow("queued-1", "fix config (+1 line)"), withTopRow("queued-1", "fix config (+1 line)"), "fix config\nuse dev", GROK_QUEUED_MESSAGE],
    ["an older row of the same words", withTopRow("queued-1", "yes"), withTopRow("queued-1", "yes"), "yes", GROK_QUEUED_MESSAGE],
    ["an older row cut to its ellipsis", withTopRow("queued-1", "…"), withTopRow("queued-1", "…"), "fourth follow-up please", GROK_SEND_UNCONFIRMED_MESSAGE],
    ["a queue not read before the send", "permission", "queued-1", "fourth follow-up please", GROK_SEND_UNCONFIRMED_MESSAGE],
  ] as const)("%s", async (_, before, after, message, outcome) => {
    const screen = (name: string): string => name.includes("\n") ? name : recorded(name);
    const sendEnter = mock(async () => {});
    const failed = await sendGrokQueuedNow({
      message, before: { working: true, queue: grokQueue(screen(before)), echo: grokEcho(screen(before)) }, delayMs: 0, sendEnter,
      look: async () => ({ status: "working", screen: screen(after) }),
    }).then(() => null, (error: unknown) => error as HerdrError);
    expect(sendEnter).toHaveBeenCalledTimes(outcome === null ? 1 : 0);
    expect(failed === null ? null : [failed.code, failed.message]).toEqual(outcome === null ? null : ["submit_changed", outcome]);
  });

  it.each([
    ["the same one row on both reads", [withRows("fix config (+1 line)"), withRows("fix config (+1 line)")], "fix config\nuse dev", null],
    ["another client's row of the same first line and line count, then the message's", [withRows("fix config (+1 line)"), withRows("fix config (+1 line)", "fix config (+1 line)")], "fix config\nuse dev", GROK_QUEUED_MESSAGE],
    ["another client's row of the same words, then the message's", [withRows("yes"), withRows("yes", "yes")], "yes", GROK_QUEUED_MESSAGE],
    ["the message's row, then another client's under it", [withRows("fourth follow-up please"), withRows("fourth follow-up please", "fix config (+1 line)")], "fourth follow-up please", GROK_QUEUED_MESSAGE],
    ["another row in place of the one read first", [withRows("continue"), withRows("continue later")], "continue", grokQueuedBehindMessage(1)],
  ] as const)("%s", async (_, screens, message, outcome) => {
    const sendEnter = mock(async () => {});
    let reads = 0;
    const failed = await sendGrokQueuedNow({
      message, before: { working: true, queue: grokQueue(recorded("working")), echo: grokEcho(recorded("working")) }, delayMs: 0, sendEnter,
      look: async () => ({ status: "working", screen: screens[Math.min(reads++, screens.length - 1)]! }),
    }).then(() => null, (error: unknown) => error as HerdrError);
    expect(sendEnter).toHaveBeenCalledTimes(outcome === null ? 1 : 0);
    expect(failed === null ? null : [failed.code, failed.message]).toEqual(outcome === null ? null : ["submit_changed", outcome]);
  });

  it.each([
    ["the message echoed as the newest prompt", "idle", withEcho("fourth follow-up please"), "fourth follow-up please", null],
    ["the message's lines echoed one per row", "idle", withEcho("fix config", "use dev"), "fix config\nuse dev", null],
    ["another client's prompt echoed", "idle", recorded("working"), "fourth follow-up please", GROK_SEND_UNCONFIRMED_MESSAGE],
    ["only the first line echoed of a message of two", "idle", withEcho("fix config", "use prod"), "fix config\nuse dev", GROK_SEND_UNCONFIRMED_MESSAGE],
    ["the queue not read before the send", "queue-pane-focused", withEcho("fourth follow-up please"), "fourth follow-up please", GROK_SEND_UNCONFIRMED_MESSAGE],
    ["an earlier prompt of the same words echoed before the send", withEcho("continue"), withEcho("continue"), "continue", GROK_SEND_UNCONFIRMED_MESSAGE],
    ["the same words echoed once more since the send", withEcho("continue"),
      withEcho("continue").replace(/^( {5}word1 .*)$/m, `$1\n\n     ❯ ${"continue".padEnd(98)}7:23 PM`), "continue", null],
  ] as const)("%s", async (_, before, after, message, outcome) => {
    const sendEnter = mock(async () => {});
    const screen = before.includes("\n") ? before : recorded(before);
    const failed = await sendGrokQueuedNow({
      message, before: { working: false, queue: grokQueue(screen), echo: grokEcho(screen) }, delayMs: 0, sendEnter,
      look: async () => ({ status: "working", screen: after }),
    }).then(() => null, (error: unknown) => error as HerdrError);
    expect(sendEnter).not.toHaveBeenCalled();
    expect(failed === null ? null : [failed.code, failed.message]).toEqual(outcome === null ? null : ["submit_changed", outcome]);
  });
});

it("draws the stand-in Grok's screens as the recorded ones read", () => {
  const states: Record<string, GrokScreenState> = {
    idle: { status: "done", output: ["Turn cancelled by user in 1.7s."], prompt: "", queue: [] },
    working: { status: "working", output: ["word1 word2"], prompt: "", queue: [] },
    "queued-3": { status: "working", output: ["word1 word2"], prompt: "", queue: ["first follow-up please", "second follow-up please", "third follow-up please"] },
    "draft-second-line": { status: "working", output: ["word1 word2"], prompt: "\nsecond row only", queue: [] },
    permission: { status: "blocked", output: ["◆ Running scratch command"], prompt: "", queue: [], card: true },
    "minimal-queued-2": { status: "working", output: ["word1 word2"], prompt: "", queue: ["minimal follow-up one", "minimal follow-up two"], minimal: true },
  };
  for (const [name, state] of Object.entries(states)) {
    const read = (screen: string) => ({ queue: grokQueue(screen), prompt: promptState(screen) });
    expect([name, read(grokScreen(state))]).toEqual([name, read(recorded(name))]);
  }
});
