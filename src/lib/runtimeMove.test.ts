import { describe, expect, test } from "bun:test";

import type { MoveNode, MovePane, MovePlan, MoveVerdict } from "../../shared/runtime-move.ts";
import { translate } from "./i18n.ts";
import { blockingPanes, moveStepText, paneTitle, tabPaneIds, verdictTag } from "./runtimeMove.ts";

const en = (key: string, vars?: Record<string, string | number>): string => translate("en", key, vars);

const RESUME: MoveVerdict = { kind: "resume", agent: "claude", session_id: "s1", argv: ["claude", "--resume", "s1"], ended: false };
const FRESH: MoveVerdict = { kind: "fresh", agent: "copilot" };
const SHELL: MoveVerdict = { kind: "shell" };
const WORKING: MoveVerdict = { kind: "busy", reason: "agent_working", agent: "codex", command: null };
const WAITING: MoveVerdict = { kind: "busy", reason: "agent_waiting", agent: "codex", command: null };
const COMMAND: MoveVerdict = { kind: "busy", reason: "command_running", agent: null, command: "npm run dev" };
const NEEDS_YOU: MoveVerdict = { kind: "needs_you", agent: "devin" };

const pane = (pane_id: string, verdict: MoveVerdict, name: string | null = null): MovePane => ({ pane_id, cwd: "/home/me/ovis", name, verdict });

function plan(panes: MovePane[]): MovePlan {
  return { workspaces: [], panes, ready: panes.every((entry) => entry.verdict.kind !== "busy" && entry.verdict.kind !== "needs_you"), revision: "r1" };
}

describe("verdictTag", () => {
  test("gives every verdict its own words and tone, a busy one by its reason", () => {
    const tags = [RESUME, FRESH, SHELL, WORKING, WAITING, COMMAND, NEEDS_YOU].map((verdict) => verdictTag(en, verdict));
    expect(new Set(tags.map((tag) => tag.text)).size).toBe(tags.length);
    expect(tags.map((tag) => tag.tone)).toEqual(["ok", "warn", "plain", "wait", "wait", "wait", "you"]);
    expect(verdictTag(en, COMMAND).text).toBe("npm run dev running");
    expect(verdictTag(en, { ...COMMAND, command: null }).text).toBe("A command is running");
  });
});

describe("paneTitle", () => {
  test("takes the given name, else the agent's product name, else Shell", () => {
    expect(paneTitle(en, pane("p1", RESUME, "Maru"))).toBe("Maru");
    expect(paneTitle(en, pane("p1", RESUME))).toBe("Claude Code");
    expect(paneTitle(en, pane("p1", NEEDS_YOU))).toBe("Devin CLI");
    expect(paneTitle(en, pane("p1", { kind: "fresh", agent: "unknown-agent" }))).toBe("unknown-agent");
    expect(paneTitle(en, pane("p1", COMMAND))).toBe("Shell");
    expect(paneTitle(en, pane("p1", SHELL))).toBe("Shell");
  });
});

describe("blockingPanes", () => {
  test("keeps the busy and needs_you panes, in plan order", () => {
    const held = blockingPanes(plan([pane("p1", RESUME), pane("p2", WORKING), pane("p3", SHELL), pane("p4", NEEDS_YOU), pane("p5", COMMAND)]));
    expect(held.map((entry) => entry.pane_id)).toEqual(["p2", "p4", "p5"]);
    expect(blockingPanes(plan([pane("p1", RESUME), pane("p2", FRESH)]))).toEqual([]);
  });
});


describe("tabPaneIds", () => {
  test("walks a split's first side before its second, at every depth", () => {
    const root: MoveNode = { split: "right", ratio: 0.5, first: { pane: "a" }, second: { split: "down", ratio: 0.3, first: { pane: "b" }, second: { pane: "c" } } };
    expect(tabPaneIds(root)).toEqual(["a", "b", "c"]);
    expect(tabPaneIds({ pane: "only" })).toEqual(["only"]);
  });
});

describe("moveStepText", () => {
  test("gives every step its own sentence", () => {
    const steps = ["ending_agents", "building", "starting_agents", "switching"] as const;
    expect(new Set(steps.map((step) => moveStepText(en, step))).size).toBe(steps.length);
  });
});
