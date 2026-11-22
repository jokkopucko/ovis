import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { registry, type ReaderContext } from "./registry.ts";
import { executeInteractionPlan, pickerPlan } from "./interaction-plan.ts";
import type { AnswerStep } from "./shared.ts";

const context: ReaderContext = {
  agent: "", omoAsk: null, omoTrusted: true, omoOpen: [], sent: null, working: false,
};
const wrap = (text: string, width: number): string => {
  const lines = [""];
  for (const word of text.split(" ")) {
    const last = lines.length - 1;
    if (lines[last] && lines[last]!.length + word.length + 1 > width) lines.push(word);
    else lines[last] += `${lines[last] ? " " : ""}${word}`;
  }
  return lines.join("\n");
};

function claudeModel(width: number, at: number): string {
  return [
    "Select model", "", "─".repeat(width),
    ...["Opus 5.5", "Sonnet 5.5", "Haiku 4.5"].map((label, row) =>
      ` ${row === at ? "❯" : " "} ${row + 1}. ${label.padEnd(12)}  Fast answers`),
    "", wrap("Enter to set as default · s to use this session only · Esc to cancel", width),
  ].join("\n");
}

function claudeEffort(width: number, at: number): string {
  const columns = [2, 9, 17];
  return ["Effort", "", "Faster                  Smarter",
    "─".repeat(columns[at]!) + "▲" + "─".repeat(25 - columns[at]!),
    "low   medium   high", "", "",
    wrap("←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel", width),
  ].join("\n");
}

/** Claude Code 2.1.311's slider with Ultracode's switch beside it, as recorded, ▲ moved over level `at` */
function claudeEffortSwitch(at: number, on: boolean): string {
  const arrow = [0, 10, 20, 30, 41][at]!;
  return readFileSync(new URL(`../fixtures/claude-effort-2.1.311-${on ? "on" : "off"}-120.txt`, import.meta.url), "utf8")
    .replace(/─*▲─*/, `${"─".repeat(arrow)}▲${"─".repeat(41 - arrow)}`);
}

function codexModel(width: number, at: number, footer = "enter select · esc back", title = "Select Model and Effort"): string {
  return [title, "",
    ...["GPT-6-Astra", "GPT-6-Sol", "GPT-5.5"].map((label, row) =>
      `${row === at ? "›" : " "} ${row + 1}. ${label.padEnd(12)}  Fast answers`),
    "", wrap(footer, width),
  ].join("\n");
}

function providerModel(kind: "pi" | "omo", width: number, at: number): string {
  const rows = ["gpt-6.1-sol-ultrafast", "claude-opus-4-8", "gpt-5.5"].map((label, row) =>
    `${row === at ? "→" : " "}   ${label}${width === 40 ? "\n" : " "}[chatgpt-subscription]`);
  const rule = "─".repeat(width);
  return kind === "pi"
    ? [rule, "", ">", "", ...rows, "", wrap("Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel", width), rule, "/tmp/fixture", "0.0%/215k (auto)"].join("\n")
    : [wrap("enter select ctrl+s select as default ctrl+f favorite", width), "", "> gpt", "", ...rows, rule, "/tmp/fixture", "(OmO Native)"].join("\n");
}

const fixtures = [
  { id: "claude-model", draw: claudeModel, move: "down", commit: { text: "s" } },
  { id: "claude-effort", draw: claudeEffort, move: "right", commit: { text: "s" } },
  { id: "codex-model", draw: codexModel, move: "down", commit: { keys: ["enter"] } },
  { id: "pi-model", draw: (width: number, at: number) => providerModel("pi", width, at), move: "down", commit: { keys: ["enter"] } },
  { id: "omo-model", draw: (width: number, at: number) => providerModel("omo", width, at), move: "down", commit: { keys: ["enter"] } },
];

function planFor(id: string, screen: string) {
  const reader = registry.readerFor(id);
  const parsed = reader?.parse(screen, context);
  if (!parsed || !reader?.interaction) throw new Error(`No interaction plan for ${id}`);
  return reader.interaction(parsed);
}

describe("picker interaction plans", () => {
  for (const fixture of fixtures) {
    test(`${fixture.id} refuses a commit when the asking changes during the final read`, async () => {
      const screen = fixture.draw(120, 0);
      const plan = planFor(fixture.id, screen);
      const sent: AnswerStep[] = [];
      let active = true;
      const result = await executeInteractionPlan(plan, 0, {
        rereadMoves: true,
        active: () => active,
        cancelled: () => false,
        read: async () => {
          queueMicrotask(() => { active = false; });
          return screen;
        },
        send: async (step) => { sent.push(step); },
      });
      expect(sent, "an ended asking must not receive a stale picker commit").toEqual([]);
      expect(result).toBe("prompt_changed");
    });
  }

  for (const fixture of fixtures) for (const width of [40, 120]) {
    test(`${fixture.id} reads ${width} columns and commits only the row reached by its moves`, async () => {
      const plan = planFor(fixture.id, fixture.draw(width, 0));
      const sent: AnswerStep[] = [];
      let cursor = 0;
      const result = await executeInteractionPlan(plan, 1, {
        rereadMoves: true,
        active: () => true,
        cancelled: () => false,
        read: async () => fixture.draw(width, cursor),
        send: async (step, commit) => { sent.push(step); if (!commit) cursor += 1; },
      });
      expect(result).toBe("answered");
      expect(sent).toEqual([{ keys: [fixture.move] }, fixture.commit]);
      expect(plan.cursor).toBe(1);
      expect(plan.terminalFallback(1)).toBe(false);
    });
  }

  test("sends no s and reports prompt_changed when Claude's highlight moves between read and commit", async () => {
    const plan = planFor("claude-model", claudeModel(120, 0));
    const sent: AnswerStep[] = [];
    let screen = claudeModel(120, 0);
    const result = await executeInteractionPlan(plan, 1, {
      rereadMoves: true,
      active: () => true,
      cancelled: () => false,
      read: async () => screen,
      send: async (step) => { sent.push(step); screen = claudeModel(120, 2); },
    });
    expect(sent, "a changed highlight must not receive the session commit s").toEqual([{ keys: ["down"] }]);
    expect(result).toBe("prompt_changed");
  });

  test("Tab flips Claude's Ultracode switch without moving the cursor, and s waits for the switch to show it", async () => {
    const plan = planFor("claude-effort", claudeEffortSwitch(3, false));
    const sent: AnswerStep[] = [];
    let on = false;
    const result = await executeInteractionPlan(plan, 5, {
      rereadMoves: true,
      active: () => true,
      cancelled: () => false,
      read: async () => claudeEffortSwitch(3, on),
      send: async (step, commit) => { sent.push(step); if (!commit) on = !on; },
    });
    expect(result).toBe("answered");
    expect(sent).toEqual([{ keys: ["tab"] }, { text: "s" }]);
    expect(plan.cursor, "a Tab is no step back").toBe(3);
    expect(plan.toggles).toBe(1);
  });

  test("sends no s for Claude's switch when the slider still shows it as before, or shows it at another level", async () => {
    for (const shown of [claudeEffortSwitch(3, false), claudeEffortSwitch(2, true)]) {
      const plan = planFor("claude-effort", claudeEffortSwitch(3, false));
      const sent: AnswerStep[] = [];
      const result = await executeInteractionPlan(plan, 5, {
        rereadMoves: true,
        active: () => true,
        cancelled: () => false,
        read: async () => shown,
        send: async (step) => { sent.push(step); },
      });
      expect(result).toBe("prompt_changed");
      expect(sent).toEqual([{ keys: ["tab"] }]);
    }
  });

  test("a level's s waits for Claude's switch as it was drawn", () => {
    const plan = planFor("claude-effort", claudeEffortSwitch(3, true));
    expect(plan.matches(claudeEffortSwitch(3, true))).toBe(true);
    expect(plan.matches(claudeEffortSwitch(3, false)), "a Tab pressed in the terminal").toBe(false);
  });

  test("moves the cursor for the arrows alone", async () => {
    const parsed = registry.readerFor("codex-model")!.parse(codexModel(120, 1), context)!;
    const plan = pickerPlan(parsed, () => null, [[{ keys: ["down"] }, { keys: ["esc"] }, { keys: ["right"] }, { keys: ["tab"] }, { keys: ["up"] }, { keys: ["left"] }, { keys: ["left"] }, { keys: ["left"] }, { text: "s" }]],
      (shown, cursor) => shown.menuLabels[cursor]);
    const cursors: number[] = [];
    await executeInteractionPlan(plan, 0, {
      rereadMoves: false,
      active: () => true,
      cancelled: () => false,
      read: async () => null,
      send: async () => { cursors.push(plan.cursor); },
    });
    expect(cursors).toEqual([1, 2, 2, 3, 3, 2, 1, 0]);
    expect(plan.cursor).toBe(0);
    expect(plan.toggles).toBe(1);
  });

  test("Codex reads the session key from the nested reasoning row after moving", async () => {
    const plan = planFor("codex-model", codexModel(120, 0));
    const sent: AnswerStep[] = [];
    const result = await executeInteractionPlan(plan, 1, {
      rereadMoves: true,
      active: () => true,
      cancelled: () => false,
      read: async () => codexModel(120, 1, "enter default · s session · esc back"),
      send: async (step) => { sent.push(step); },
    });
    expect(result).toBe("answered");
    expect(sent).toEqual([{ keys: ["down"] }, { text: "s" }]);
  });

  test("Claude's plan ignores a redrawn task footer under the model list", () => {
    const plan = planFor("claude-model", claudeModel(120, 0));
    const tasks = "\n──────────────────────── Session ─\n\n  3 tasks (0 done, 3 open)\n  ◻ Read\n  ◻ Build\n  ◻ Verify\n";
    expect(plan.matches(claudeModel(120, 0) + tasks)).toBe(true);
    expect(plan.matches(claudeModel(120, 1) + tasks)).toBe(false);
  });

  test("OmO's plan requires the filter below its hint rather than an earlier input line", () => {
    const screen = providerModel("omo", 120, 0);
    const plan = planFor("omo-model", screen);
    expect(plan.matches(screen.replace("\n> gpt\n", "\nNot a filter\n"))).toBe(false);
  });

  test("Codex's model identity includes the model of the nested reasoning list", () => {
    const plan = planFor("codex-model", codexModel(120, 0, "enter default · s session · esc back", "Select Reasoning Level for GPT-6-Astra"));
    expect(plan.matches(codexModel(120, 0, "enter default · s session · esc back", "Select Reasoning Level for GPT-6-Sol"))).toBe(false);
  });

  test("Codex refuses a reasoning row with no safe commit key", async () => {
    const plan = planFor("codex-model", codexModel(120, 0, "enter default · s session · esc back", "Select Reasoning Level for GPT-6-Astra"));
    const sent: AnswerStep[] = [];
    const result = await executeInteractionPlan(plan, 1, {
      rereadMoves: true,
      active: () => true,
      cancelled: () => false,
      read: async () => codexModel(120, 1, "enter select · esc back", "Select Reasoning Level for GPT-6-Astra"),
      send: async (step) => { sent.push(step); },
    });
    expect(result).toBe("prompt_changed");
    expect(sent).toEqual([{ keys: ["down"] }]);
    expect(plan.terminalFallback(1)).toBe(true);
  });

  test("stops after a move when the asking ends under it, sending no further key", async () => {
    const plan = planFor("codex-model", codexModel(120, 0));
    const sent: AnswerStep[] = [];
    let active = true;
    let cursor = 0;
    const result = await executeInteractionPlan(plan, 2, {
      rereadMoves: true,
      active: () => active,
      cancelled: () => false,
      read: async () => codexModel(120, cursor),
      send: async (step, commit) => { sent.push(step); if (!commit) cursor += 1; active = false; },
    });
    expect(result).toBe("prompt_changed");
    expect(sent, "one move went out before the asking ended; nothing after it").toEqual([{ keys: ["down"] }]);
  });

  test("commits with the chosen answer's own last key, not the first answer's", async () => {
    const screen = codexModel(120, 0);
    const parsed = registry.readerFor("codex-model")!.parse(screen, context)!;
    const plan = pickerPlan(parsed, (shown) => registry.readerFor("codex-model")!.parse(shown, context),
      [[{ keys: ["enter"] }], [{ keys: ["down"] }, { text: "s" }]], (shown, cursor) => shown.menuLabels[cursor]);
    const sent: AnswerStep[] = [];
    let cursor = 0;
    const result = await executeInteractionPlan(plan, 1, {
      rereadMoves: true,
      active: () => true,
      cancelled: () => false,
      read: async () => codexModel(120, cursor),
      send: async (step, commit) => { sent.push(step); if (!commit) cursor += 1; },
    });
    expect(result).toBe("answered");
    expect(sent).toEqual([{ keys: ["down"] }, { text: "s" }]);
    expect(plan.commit(0)).toEqual({ keys: ["enter"] });
  });
});
