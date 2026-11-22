import { expect, test } from "bun:test";
import type { OmoRun, OmoTask } from "../../shared/protocol.ts";
import { clockOffsetMs, endedSummary, formatElapsed, runGoing, taskCallItems, taskElapsedMs, taskResultMarkdown } from "./omoTasks.ts";

const task = (over: Partial<OmoTask>): OmoTask => ({ id: "st_1", title: "t", category: null, model: null, status: "running", started_at: "2026-10-02T05:00:00Z", ended_at: null, turns: null, tool_calls: null, tokens: null, ...over });
const at = Date.parse("2026-10-02T05:04:12Z");

test("a running task counts to now, an ended one to its end", () => {
  expect(taskElapsedMs(task({}), at)).toBe(252_000);
  expect(taskElapsedMs(task({ status: "completed", ended_at: "2026-10-02T05:01:00Z" }), at)).toBe(60_000);
});

test("no start, no end, or an end before the start: unknown", () => {
  expect(taskElapsedMs(task({ started_at: null }), at)).toBeNull();
  expect(taskElapsedMs(task({ status: "lost" }), at)).toBeNull();
  expect(taskElapsedMs(task({ status: "completed", ended_at: "2026-10-02T04:00:00Z" }), at)).toBeNull();
});

test("the folded line counts what ended, and what of it went wrong", () => {
  const run = (status: OmoRun["status"]): OmoRun => ({ id: status, name: status, status, started_at: null, ended_at: null, waves: [] });
  const tasks = [task({}), task({ status: "completed" }), task({ status: "failed" }), task({ status: "cancelled" }), task({ status: "lost" })];
  const runs = [run("running"), run("pending"), run("paused"), run("completed"), run("failed"), run("cancelled")];
  expect(runs.filter(runGoing).map((item) => item.status)).toEqual(["running", "pending", "paused"]);
  expect(endedSummary(tasks, runs)).toEqual({ ended: 7, failed: 3 });
  expect(endedSummary([task({})], [run("running")])).toEqual({ ended: 0, failed: 0 });
});

test("a task call reads as the tasks it starts: OmO's one and batch, omp's batch", () => {
  expect(taskCallItems({ description: "short", task_summary: "What it is for", subagent_type: "explore", prompt: "TASK: look" })).toEqual([
    { title: "What it is for", agent: "explore", prompt: "TASK: look" },
  ]);
  expect(taskCallItems({ category: "quick", tasks: [{ description: "one", prompt: "a" }, { task_summary: "two", category: "deep", prompt: "b" }, "junk", {}] })).toEqual([
    { title: "one", agent: "quick", prompt: "a" },
    { title: "two", agent: "deep", prompt: "b" },
  ]);
  expect(taskCallItems({ agent: "task", tasks: [{ id: "Auth", description: "Check the login", assignment: "read auth.ts" }, { assignment: "untitled" }] })).toEqual([
    { title: "Check the login", agent: "task", prompt: "read auth.ts" },
    { title: "#2", agent: "task", prompt: "untitled" },
  ]);
  expect(taskCallItems({ run_in_background: true })).toBeNull();
});

test("a task's answer framed in section tags reads as named sections, its own tags and code kept", () => {
  const answer = [
    "<analysis>", "**Need**: find it", "</analysis>", "", "<results>", "<next_steps>", "Run it.", "</next_steps>", "</results>",
    "```html", "<div>", "```", "use <b> here", "  <files>  ",
  ].join("\n");
  expect(taskResultMarkdown(answer)).toBe([
    "**Analysis**", "**Need**: find it", "", "**Results**", "**Next steps**", "Run it.",
    "```html", "<div>", "```", "use <b> here", "**Files**",
  ].join("\n"));
  expect(taskResultMarkdown("plain answer")).toBe("plain answer");
});

test("a task's answer keeps a code block whole as the chat draws it, a fence line naming a language inside it too", () => {
  const answer = ["```md", "```ts", "<analysis>", "", "", "</analysis>", "```", "<answer>"].join("\n");
  expect(taskResultMarkdown(answer)).toBe(["```md", "```ts", "<analysis>", "", "", "</analysis>", "```", "**Answer**"].join("\n"));
});

test("a fence after a tab is no fence to the chat, so the block it would open is read as the chat reads it", () => {
  const answer = ["intro", "\t```ts", "<analysis>", "x", "</analysis>", "```", "<results>"].join("\n");
  expect(taskResultMarkdown(answer)).toBe(["intro", "\t```ts", "**Analysis**", "x", "```", "<results>"].join("\n"));
});

test("elapsed time reads in seconds, minutes, then hours", () => {
  expect([formatElapsed(8_400), formatElapsed(252_000), formatElapsed(3_780_000)]).toEqual(["8s", "4m 12s", "1h 3m"]);
});

test("a PC whose clock runs an hour ahead: its offset puts a running task's time right", () => {
  const browser = Date.parse("2026-10-02T04:04:12Z");
  const offset = clockOffsetMs("2026-10-02T05:04:12Z", browser);
  expect(offset).toBe(3_600_000);
  expect(taskElapsedMs(task({}), browser)).toBeNull();
  expect(taskElapsedMs(task({}), browser + offset)).toBe(252_000);
  expect(clockOffsetMs(null, browser)).toBe(0);
  expect(clockOffsetMs("not a time", browser)).toBe(0);
});
