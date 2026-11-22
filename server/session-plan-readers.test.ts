import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { at, claude, file, json } from "./session-plan.fixture.ts";
import { planSummary, readPlan } from "./session-plan.ts";

const steps = (path: string) => (readPlan("claude-transcript", path) ?? []).map((step) => `${step.id}:${step.status}:${step.blocked_by.join(",")}`);

describe("readPlan (Claude Code task list)", () => {
  it("rebuilds the tasks, their order and their progress from the task calls", () => {
    const s = claude();
    const a = s.create("Study", 1, { activeForm: "Studying" });
    const b = s.create("Build", 1);
    const c = s.create("Ship", 1);
    s.update({ taskId: b, addBlockedBy: [a] }, 1);
    s.update({ taskId: b, addBlocks: [c] }, 1);
    s.update({ taskId: a, status: "in_progress" }, 2);
    s.update({ taskId: a, status: "completed" }, 5);
    s.update({ taskId: b, status: "in_progress", activeForm: "Building it" }, 6);
    expect(readPlan("claude-transcript", s.path)).toEqual([
      { id: "1", label: "Study", active: "Studying", status: "completed", blocked_by: [], owner: null, started_at: at(2), ended_at: at(5) },
      { id: "2", label: "Build", active: "Building it", status: "in_progress", blocked_by: ["1"], owner: null, started_at: at(6), ended_at: null },
      { id: "3", label: "Ship", active: null, status: "pending", blocked_by: ["2"], owner: null, started_at: null, ended_at: null },
    ]);
    expect(planSummary(readPlan("claude-transcript", s.path))).toEqual({ done: 1, total: 3, current: "Building it" });
  });

  it("reads only what was appended since, and follows a renamed, reassigned or deleted task", () => {
    const s = claude();
    const a = s.create("One");
    const b = s.create("Two");
    s.update({ taskId: b, addBlockedBy: [a] });
    expect(steps(s.path)).toEqual(["1:pending:", "2:pending:1"]);
    s.update({ taskId: a, subject: "First", owner: "researcher" });
    s.update({ taskId: a, status: "deleted" });
    expect(readPlan("claude-transcript", s.path)).toEqual([{ id: "2", label: "Two", active: null, status: "pending", blocked_by: [], owner: null, started_at: null, ended_at: null }]);
  });

  it("takes nothing from a failed call, an unknown task or a call never answered", () => {
    const s = claude();
    const a = s.create("One");
    s.update({ taskId: a, status: "completed" }, 2, { success: false });
    s.update({ taskId: a, status: "completed" }, 2, {}, true);
    s.update({ taskId: "99", status: "completed" }, 2);
    s.add({ type: "assistant", timestamp: at(3), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_x", name: "TaskUpdate", input: { taskId: a, status: "completed" } }] } });
    expect(steps(s.path)).toEqual(["1:pending:"]);
  });

  it("starts a new plan with the first task created after every task was done, as Claude empties its list", () => {
    const s = claude();
    const a = s.create("Old");
    s.update({ taskId: a, status: "completed" }, 2);
    expect(planSummary(readPlan("claude-transcript", s.path))).toEqual({ done: 1, total: 1, current: null });
    s.create("New A", 3);
    s.create("New B", 3);
    expect(steps(s.path)).toEqual(["2:pending:", "3:pending:"]);
  });

  it("takes the id from the answer's words when the structured result is missing, and numeric ids", () => {
    const s = claude();
    s.add({ type: "assistant", timestamp: at(1), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_a", name: "TaskCreate", input: { subject: "Plain" } }] } });
    s.add({ type: "user", timestamp: at(1), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: [{ type: "text", text: "Task #7 created successfully: Plain" }] }] } });
    s.add({ type: "assistant", timestamp: at(2), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_b", name: "TaskUpdate", input: { taskId: 7, status: "in_progress" } }] } });
    s.add({ type: "user", timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_b", content: "Updated task #7 status" }] } });
    expect(steps(s.path)).toEqual(["7:in_progress:"]);
  });

  it("has no plan for a session that never used the task tools, and starts over on another file at the same path", () => {
    const s = claude();
    expect(readPlan("claude-transcript", s.path)).toBeNull();
    s.create("One");
    expect(steps(s.path)).toEqual(["1:pending:"]);
    writeFileSync(s.path, json({ type: "user", timestamp: at(9), message: { role: "user", content: "fresh" } }));
    expect(readPlan("claude-transcript", s.path)).toBeNull();
  });
});

describe("readPlan (Codex checklist)", () => {
  it("takes the last explicit checklist, each step after the one before", () => {
    const f = file("rollout.jsonl");
    f.add({ timestamp: at(1), type: "response_item", payload: { type: "function_call", name: "update_plan", call_id: "c1", arguments: JSON.stringify({ plan: [{ step: "Read", status: "in_progress" }, { step: "Fix", status: "pending" }] }) } });
    expect((readPlan("codex-transcript", f.path) ?? []).map((step) => `${step.id}:${step.status}:${step.blocked_by.join(",")}:${step.label}`)).toEqual(["1:in_progress::Read", "2:pending:1:Fix"]);
    f.add({ timestamp: at(4), type: "response_item", payload: { type: "function_call", name: "update_plan", call_id: "c4", arguments: JSON.stringify({ plan: [{ step: "Read", status: "completed" }, { step: "Fix", status: "in_progress" }, { step: "Ship", status: "pending" }] }) } });
    expect(readPlan("codex-transcript", f.path)).toEqual([
      { id: "1", label: "Read", active: null, status: "completed", blocked_by: [], owner: null, started_at: at(1), ended_at: at(4) },
      { id: "2", label: "Fix", active: null, status: "in_progress", blocked_by: ["1"], owner: null, started_at: at(4), ended_at: null },
      { id: "3", label: "Ship", active: null, status: "pending", blocked_by: ["2"], owner: null, started_at: null, ended_at: null },
    ]);
  });

  it("leaves the plan as it was for malformed arguments", () => {
    const f = file("rollout.jsonl");
    f.add({ timestamp: at(1), type: "response_item", payload: { type: "function_call", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Only", status: "in_progress" }] }) } });
    f.add({ timestamp: at(2), type: "response_item", payload: { type: "function_call", name: "update_plan", arguments: "{plan: nope}" } });
    expect((readPlan("codex-transcript", f.path) ?? []).map((step) => step.label)).toEqual(["Only"]);
  });
});
