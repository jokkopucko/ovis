import { describe, expect, it } from "bun:test";

import { formatWorkDuration, runNames, splitTurn, todoGroups, turnSegments, visibleWorkParts, workBlockStartsOpen, workFailed, workStartsOpen, workSummary, type ToolPart } from "./workBlocks.ts";
import type { ConversationPart } from "../../shared/protocol.ts";

const tool = (name: string, summary = name): Extract<ConversationPart, { kind: "tool" }> => ({ kind: "tool", name, summary, input: "{}", output: "" });
const text = (value: string): Extract<ConversationPart, { kind: "text" }> => ({ kind: "text", text: value });
const thinking = (value: string): Extract<ConversationPart, { kind: "thinking" }> => ({ kind: "thinking", text: value });

describe("splitTurn", () => {
  it("folds actions and explicit narration into work while every assistant response stays in the answer", () => {
    const narration = { ...text("looking…"), phase: "commentary" as const };
    const split = splitTurn([thinking("hm"), tool("read"), narration, tool("edit"), text("done"), text("really")]);
    expect(split.work).toEqual([thinking("hm"), tool("read"), narration, tool("edit")]);
    expect(split.answer).toEqual([text("done"), text("really")]);
  });

  it("is all answer when the agent only spoke, and drops whitespace-only prose", () => {
    expect(splitTurn([text("  \n"), text("hi")])).toEqual({ work: [], answer: [text("hi")] });
  });

  it("keeps an unphased response visible when a tool follows it", () => {
    expect(splitTurn([text("The substantive answer"), tool("bash")])).toEqual({ work: [tool("bash")], answer: [text("The substantive answer")] });
  });

  it("keeps Codex commentary inside work even after the last tool or with no tools", () => {
    const narration = { ...text("Still investigating"), phase: "commentary" as const };
    expect(splitTurn([tool("exec_command"), narration]).answer).toEqual([]);
    expect(splitTurn([narration])).toEqual({ work: [narration], answer: [] });
  });

  it("honors an explicit final answer even if a later record contains an action", () => {
    const final = { ...text("Done"), phase: "final_answer" as const };
    expect(splitTurn([tool("exec_command"), final, tool("cleanup")])).toEqual({ work: [tool("exec_command"), tool("cleanup")], answer: [final] });
  });

  it("keeps a multi-step answer and later closing sentence outside the work block", () => {
    const answer = text("The report contains three sections.\n\n1. Summary.\n2. Details.\n3. Next steps.");
    const check = { ...tool("bash"), summary: "bun test report" };
    const closing = text("The report is ready.");
    const parts = [answer, check, closing];
    expect(splitTurn(parts)).toEqual({ work: [check], answer: [answer, closing] });
    expect(workStartsOpen(true, parts)).toBe(true);
    expect(workStartsOpen(false, parts)).toBe(false);
  });
});

describe("turnSegments", () => {
  it("keeps words written before a tool above it, and each run of work where it happened", () => {
    const parts = [thinking("hm"), text("I'll check."), tool("eval"), tool("eval"), text("  \n"), text("Found it."), tool("edit"), text("Done.")];
    expect(turnSegments(parts)).toEqual([
      { kind: "work", start: 0, parts: [thinking("hm")] },
      { kind: "answer", start: 1, parts: [text("I'll check.")] },
      { kind: "work", start: 2, parts: [tool("eval"), tool("eval")] },
      { kind: "answer", start: 5, parts: [text("Found it.")] },
      { kind: "work", start: 6, parts: [tool("edit")] },
      { kind: "answer", start: 7, parts: [text("Done.")] },
    ]);
  });

  it("names each run by its first part, so a run that splits keeps the later run's name", () => {
    const before = turnSegments([tool("A"), text(""), tool("B"), text("between"), tool("C")]);
    const after = turnSegments([tool("A"), text("arrived"), tool("B"), text("between"), tool("C")]);
    const runs = (segments: typeof before) => segments.flatMap((segment) => segment.kind === "work" ? [segment.start] : []);
    expect(runs(before)).toEqual([0, 4]);
    expect(runs(after)).toEqual([0, 2, 4]);
  });

  it("keeps commentary inside its run of work and a tools-then-answer turn as one run", () => {
    const narration = { ...text("looking\u2026"), phase: "commentary" as const };
    expect(turnSegments([tool("read"), narration, tool("edit"), text("done")])).toEqual([
      { kind: "work", start: 0, parts: [tool("read"), narration, tool("edit")] },
      { kind: "answer", start: 3, parts: [text("done")] },
    ]);
    expect(turnSegments([])).toEqual([]);
  });
});

describe("runNames", () => {
  // what Turn keeps between draws: each part's run name, by part index
  const draw = (parts: ConversationPart[], previous: ReadonlyMap<number, string>) => {
    const runs = turnSegments(parts).flatMap((segment) => segment.kind === "work" ? [segment] : []);
    const names = runNames(runs, new Map(parts.map((part, index) => [part, index])), previous);
    return { names, next: new Map(runs.flatMap((run, index) => run.parts.map((part) => [parts.indexOf(part), names[index]!] as const))) };
  };

  it("names a run by its first part the first time, and keeps the name while its parts change", () => {
    const narration = { ...text("Checking."), phase: "commentary" as const };
    const first = draw([text("Checking."), tool("ls")], new Map());
    expect(first.names).toEqual(["work:1"]);
    expect(draw([narration, tool("ls")], first.next).names).toEqual(["work:1"]);
  });

  it("gives a split run's first part the old name and never hands a shown name to a new run", () => {
    const shown = draw([tool("A"), text(""), tool("B"), text("between"), tool("C")], new Map());
    expect(shown.names).toEqual(["work:0", "work:4"]);
    expect(draw([tool("A"), text("arrived"), tool("B"), text("between"), tool("C")], shown.next).names).toEqual(["work:0", "work:2", "work:4"]);
    // the run named work:0 now starts at 2; a new run at 0 must not take its name
    expect(draw([tool("new"), text("between"), tool("A")], new Map([[2, "work:0"]])).names).toEqual(["work:0+", "work:0"]);
  });
});

describe("workStartsOpen", () => {
  const commentary = (value: string) => ({ ...text(value), phase: "commentary" as const });
  const final = (value: string) => ({ ...text(value), phase: "final_answer" as const });

  it("is open while the turn runs, whatever it holds", () => {
    expect(workStartsOpen(true, [tool("read"), text("done")])).toBe(true);
    expect(workStartsOpen(true, [tool("bash")])).toBe(true);
  });

  it("folds a settled turn: its answer stays outside the fold", () => {
    expect(workStartsOpen(false, [thinking("hm"), tool("read"), text("looking…"), tool("edit"), text("done")])).toBe(false);
    expect(workStartsOpen(false, [commentary("Checking."), tool("exec_command"), final("All good.")])).toBe(false);
    // an action after the answer hides no words
    expect(workStartsOpen(false, [commentary("Checking."), tool("exec_command"), final("Done"), tool("cleanup")])).toBe(false);
  });

  it("folds a settled turn when an unphased answer is followed by an action because the answer remains visible", () => {
    expect(workStartsOpen(false, [text("The answer"), tool("bash")])).toBe(false);
    // a todo update after the closing summary is not even counted in the header
    expect(workStartsOpen(false, [tool("read"), text("Here is the full answer."), tool("TodoWrite")])).toBe(false);
  });

  it("keeps a settled turn open when it ends in Codex commentary: folding would hide its last text", () => {
    expect(workStartsOpen(false, [tool("exec_command"), commentary("Still investigating")])).toBe(true);
    expect(workStartsOpen(false, [commentary("Checking the second request.")])).toBe(true);
    // reasoning recorded after the last words does not hide them either
    expect(workStartsOpen(false, [tool("exec_command"), commentary("Still investigating"), thinking("hm")])).toBe(true);
  });

  it("keeps a settled turn open when commentary comes after its final answer: the answer is not the end", () => {
    expect(workStartsOpen(false, [tool("exec_command"), final("Done."), commentary("Resumed: still looking")])).toBe(true);
    expect(workStartsOpen(false, [tool("exec_command"), final("Done."), commentary("Resumed"), tool("exec_command")])).toBe(true);
  });

  it("stays folded when the turn did nothing readable", () => {
    expect(workStartsOpen(false, [])).toBe(false);
    expect(workStartsOpen(false, [thinking("hm")])).toBe(false);
    expect(workStartsOpen(false, [tool("bash"), text("  ")])).toBe(false);
  });
});

describe("workBlockStartsOpen", () => {
  const commentary = (value: string) => ({ ...text(value), phase: "commentary" as const });
  const running = { live: true, waiting: false, last: true };
  const settled = { live: false, waiting: false, last: true };
  const endsInWords = [tool("exec_command"), commentary("Still investigating")];

  it("starts as it always has while Collapse work is off", () => {
    expect(workBlockStartsOpen(running, [tool("bash")], false)).toBe(true);
    expect(workBlockStartsOpen({ ...running, waiting: true }, [tool("bash")], false)).toBe(true);
    expect(workBlockStartsOpen(settled, [tool("read"), text("done")], false)).toBe(false);
    expect(workBlockStartsOpen(settled, endsInWords, false)).toBe(true);
    // a run before the turn's last part: what follows it is still to read
    expect(workBlockStartsOpen({ ...settled, last: false }, endsInWords, false)).toBe(false);
    expect(workBlockStartsOpen({ ...running, live: false, last: false }, [tool("bash")], false)).toBe(false);
  });

  it("folds every block with Collapse work on, the running one and one ending in the agent's words included (#2228)", () => {
    expect(workBlockStartsOpen(running, [tool("bash")], true)).toBe(false);
    expect(workBlockStartsOpen(settled, endsInWords, true)).toBe(false);
    expect(workBlockStartsOpen(settled, [tool("read"), text("done")], true)).toBe(false);
  });

  it("keeps the block that waits on the user open with Collapse work on: it may hold what they answer", () => {
    expect(workBlockStartsOpen({ ...running, waiting: true }, [tool("bash")], true)).toBe(true);
  });
});

describe("workSummary", () => {
  it("counts by what the reader cares about, singular and plural", () => {
    expect(workSummary([tool("Edit"), tool("Write"), tool("read"), tool("Bash"), tool("WebFetch")])).toBe("2 edits · 1 file read · 1 command · 1 other tool");
  });

  it("is empty for reasoning and prose alone", () => {
    expect(workSummary([thinking("x"), text("y")])).toBe("");
  });

  it("leaves todo updates out of the counts", () => {
    expect(workSummary([tool("TodoWrite"), tool("Edit"), tool("update_plan"), tool("todo_write"), tool("Read")])).toBe("1 edit · 1 file read");
  });
});

describe("formatWorkDuration", () => {
  it("formats seconds, minutes and rejects unknown or negative spans", () => {
    expect(formatWorkDuration("2026-01-01T00:00:00Z", "2026-01-01T00:00:07.4Z")).toBe("7s");
    expect(formatWorkDuration("2026-01-01T00:00:00Z", "2026-01-01T00:01:12Z")).toBe("1m 12s");
    expect(formatWorkDuration("2026-01-01T00:00:10Z", "2026-01-01T00:00:00Z")).toBeNull();
    expect(formatWorkDuration(null, "2026-01-01T00:00:00Z")).toBeNull();
  });
});

describe("workFailed", () => {
  const failed: ConversationPart = { kind: "tool", name: "Bash", summary: "", input: "", output: "", error: true };

  it("counts the calls that failed, apart from the summary a narrow header cuts short", () => {
    const parts = [tool("Edit"), failed, failed];
    expect(workSummary(parts)).toBe("1 edit · 2 commands");
    expect(workFailed(parts)).toBe(2);
    expect(workFailed([tool("Edit"), thinking("x"), text("y")])).toBe(0);
  });

  it("counts a failed call the summary does not count", () => {
    const parts: ConversationPart[] = [{ ...failed, name: "TodoWrite" }];
    expect(workSummary(parts)).toBe("");
    expect(workFailed(parts)).toBe(1);
  });
});


it("keeps an approval-blocked assistant turn live, including with a last-activity timestamp", async () => {
  const { isLiveWorkTurn } = await import("./workBlocks.ts");
  const turn = { role: "assistant" as const, ts: null, parts: [], end_ts: "2026-09-28T00:00:00Z" };
  expect(isLiveWorkTurn(turn, true, "blocked")).toBe(true);
  expect(isLiveWorkTurn({ ...turn, end_ts: undefined }, true, "blocked")).toBe(true);
  expect(isLiveWorkTurn(turn, true, "working")).toBe(true);
  expect(isLiveWorkTurn(turn, false, "blocked")).toBe(false);
  expect(isLiveWorkTurn(turn, true, "idle")).toBe(false);
  expect(isLiveWorkTurn({ ...turn, role: "user" }, true, "blocked")).toBe(false);
});

it("does not title a turn that ended on its final answer as running when the agent begins another by itself", async () => {
  const { isLiveWorkTurn } = await import("./workBlocks.ts");
  const answered = { role: "assistant" as const, ts: null, parts: [tool("Glob"), { kind: "text" as const, text: "The subagent is still running.", phase: "final_answer" as const }] };
  // a background task ended: herdr says working, the new turn has no row yet, and nothing was sent from here
  expect(isLiveWorkTurn(answered, true, "working")).toBe(false);
  // words that are no final answer yet are the running turn's own
  expect(isLiveWorkTurn({ ...answered, parts: [answered.parts[0]!, { kind: "text" as const, text: "Let me look." }] }, true, "working")).toBe(true);
});

it("does not title a finished turn as running after a message was sent over it", async () => {
  const { isLiveWorkTurn } = await import("./workBlocks.ts");
  const finished = { role: "assistant" as const, ts: "2026-09-29T00:00:00Z", parts: [], end_ts: "2026-09-29T00:00:06Z" };
  // sent over it, status already `working`, transcript not yet holding the new message
  expect(isLiveWorkTurn(finished, true, "working", finished)).toBe(false);
  expect(isLiveWorkTurn(finished, true, "blocked", finished)).toBe(false);
  // a turn without a recorded time is still the one sent over
  const untimed = { ...finished, ts: null };
  expect(isLiveWorkTurn(untimed, true, "working", untimed)).toBe(false);
  // the turn that answers the message is a different one and is live again, even with the same time
  const next = { ...finished, end_ts: undefined };
  expect(isLiveWorkTurn(next, true, "working", finished)).toBe(true);
  expect(isLiveWorkTurn({ ...untimed }, true, "working", untimed)).toBe(true);
  // nothing sent over keeps following the status
  expect(isLiveWorkTurn(finished, true, "working", null)).toBe(true);
  expect(isLiveWorkTurn(finished, true, "working")).toBe(true);
});

it("says the open block waits for the user while the agent is blocked, and only then", async () => {
  const { isWaitingWorkTurn } = await import("./workBlocks.ts");
  expect(isWaitingWorkTurn(true, "blocked")).toBe(true);
  // a question in Codex's queue: Codex keeps working
  expect(isWaitingWorkTurn(true, "working")).toBe(false);
  // a settled turn keeps "Worked for …" whatever the pane's status
  expect(isWaitingWorkTurn(false, "blocked")).toBe(false);
  expect(isWaitingWorkTurn(true, undefined)).toBe(false);
});

describe("visibleWorkParts", () => {
  it("draws no rows for skills, nor for thinking unless it is shown", () => {
    const skill: ConversationPart = { kind: "skill", skill: { name: "review", evidence: "invocation", status: "loaded" } };
    expect(visibleWorkParts([skill, thinking("hm")], false)).toEqual([]);
    expect(visibleWorkParts([skill, thinking("hm")], true)).toEqual([thinking("hm")]);
    expect(visibleWorkParts([tool("read")], false)).toEqual([tool("read")]);
  });
});

describe("todoGroups", () => {
  type State = ToolPart["state"];
  // a Claude TodoWrite: its list is its input; the native id and state as the server sends them
  const write = (id: string | undefined, state: State, todos: unknown = [{ content: "Read", status: "completed" }, { content: "Fix", status: "in_progress" }], output = ""): ToolPart =>
    ({ kind: "tool", name: "TodoWrite", summary: "TodoWrite", input: typeof todos === "string" ? todos : JSON.stringify({ todos }), output,
      ...(id === undefined ? {} : { call_id: id }), ...(state === undefined ? {} : { state }), ...(state === "error" ? { error: true } : {}) });
  const plan = (id: string | undefined, state: State, steps: string[]): ToolPart =>
    ({ kind: "tool", name: "update_plan", summary: "update_plan", input: JSON.stringify({ plan: steps.map((step) => ({ step, status: "completed" })) }), output: "Plan updated",
      ...(id === undefined ? {} : { call_id: id }), ...(state === undefined ? {} : { state }) });
  const only = (parts: ConversationPart[], row = "row") => {
    const groups = [...todoGroups(parts, row).values()];
    expect(groups).toHaveLength(1);
    return groups[0]!;
  };

  it("folds only contiguous todo snapshots; one item stays a normal row", () => {
    const a = write("a", "ok"), b = write("b", "ok"), c = write("c", "ok"), d = write("d", "ok");
    const groups = todoGroups([a, b, tool("Bash"), c, text("next"), d], "row");
    expect([...groups.keys()]).toEqual([a]);
    expect(groups.get(a)!.attempts.map((attempt) => attempt.part)).toEqual([a, b]);
    expect(todoGroups([write("solo", "ok")], "row").size).toBe(0);
  });

  it("ends a run at narration and at hidden thinking or skill parts", () => {
    const skill: ConversationPart = { kind: "skill", skill: { name: "x", evidence: "invocation", status: "loaded" } };
    for (const between of [text("Now the second half."), thinking("private"), skill]) {
      expect(todoGroups([write("a", "ok"), between, write("b", "ok")], "row").size).toBe(0);
    }
  });

  it("keeps the first call's identity through append and replacement", () => {
    const first = only([write("a", "pending"), write("b", "pending")]).id;
    // the next poll: a new object for every part, results recorded, a third call appended
    expect(only([write("a", "ok"), write("b", "error"), write("c", "pending")]).id).toBe(first);
    expect(only([write("a", "ok"), write("b", "ok")]).id).toBe(first);
    // the same call id in another turn's row is another run
    expect(only([write("a", "ok"), write("b", "ok")], "other row").id).not.toBe(first);
  });

  it("names a run without ids by its turn row and its first part's original index", () => {
    const parts = [text("intro"), write(undefined, undefined), write(undefined, undefined)];
    const id = only(parts).id;
    expect(id).toBe(JSON.stringify(["row", "#1"]));
    expect(only([text("intro"), write(undefined, undefined), write(undefined, undefined), write(undefined, undefined)]).id).toBe(id);
  });

  it("takes the latest ok list, counting a later pending and failed call apart", () => {
    const ok = write("a", "ok", [{ content: "Read", status: "completed" }]);
    const group = only([ok, write("b", "pending"), write("c", "error")]);
    expect(group.current?.part).toBe(ok);
    expect(group.current?.state).toBe("ok");
    expect(group.current?.items).toEqual([{ label: "Read", phase: null, status: "completed" }]);
    expect([group.pending, group.failed]).toEqual([1, 1]);
    expect(group.attempts.map((attempt) => attempt.state)).toEqual(["ok", "pending", "error"]);
  });

  it("says the latest ok list cannot be read instead of using an earlier one", () => {
    const group = only([write("a", "ok"), write("b", "ok", "{not json")]);
    expect(group.current?.part.call_id).toBe("b");
    expect(group.current?.items).toBeNull();
  });

  it("shows a completed Codex snapshot with omitted state without a success claim, even after an older ok", () => {
    const codex = plan("call_2", undefined, ["Ship"]);
    const group = only([write("toolu_1", "ok"), codex]);
    expect(group.current?.part).toBe(codex);
    expect(group.current?.state).toBe("unknown");
    expect(group.current?.items).toEqual([{ label: "Ship", phase: null, status: "completed" }]);
  });

  it("uses the latest snapshot of an all-undefined run without a success claim", () => {
    const group = only([write(undefined, undefined, [{ content: "Old", status: "pending" }]), write(undefined, undefined, [{ content: "New", status: "pending" }])]);
    expect(group.current?.state).toBe("unknown");
    expect(group.current?.items?.map((item) => item.label)).toEqual(["New"]);
    expect(group.attempts.some((attempt) => attempt.state === "ok")).toBe(false);
  });

  it("never takes a failed call without a recorded state for the list", () => {
    const earlier = write(undefined, undefined, [{ content: "Kept", status: "pending" }]);
    const group = only([earlier, { ...write(undefined, undefined, "{not json"), error: true }]);
    expect(group.current?.part).toBe(earlier);
    expect(group.failed).toBe(1);
  });

  it("invents no list from pending and failed calls alone", () => {
    const group = only([write("a", "pending"), write("b", "error")]);
    expect(group.current).toBeNull();
    expect([group.pending, group.failed]).toEqual([1, 1]);
  });

  it("infers no outcome from empty or nonempty output", () => {
    for (const output of ["", "Error: the update failed", "Todos have been modified successfully"]) {
      const group = only([write("a", "pending", undefined, output), write(undefined, undefined, undefined, output)]);
      expect(group.attempts.map((attempt) => attempt.state)).toEqual(["pending", "unknown"]);
      expect(group.failed).toBe(0);
    }
  });

  it("keeps repeated identical calls as distinct attempts", () => {
    const group = only([write("a", "ok"), write("b", "ok")]);
    expect(group.attempts.map((attempt) => attempt.part.call_id)).toEqual(["a", "b"]);
  });
});
