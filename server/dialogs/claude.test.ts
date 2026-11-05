import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { InteractivePrompt } from "../../shared/protocol.ts";
import { answerKeys, claudeRewindOpen, parseInteractivePrompt } from "../prompt.ts";
import { executeInteractionPlan } from "./interaction-plan.ts";
import { registry } from "./registry.ts";
import { ANSI_RE, parsedByPublicPrompt, type AnswerStep } from "./shared.ts";

const fixture = (state: string, width: number): string =>
  readFileSync(new URL(`../fixtures/claude-goal-2.1.304-${state}-${width}.txt`, import.meta.url), "utf8");

/** Claude Code 2.1.304's /rewind, recorded over a resumed apple/banana session (fixtures named by state and width) */
const rewind = (state: string, width: number): string =>
  readFileSync(new URL(`../fixtures/claude-rewind-2.1.304-${state}-${width}.txt`, import.meta.url), "utf8");

describe("Claude Code's terminal rewind", () => {
  test("does not block sends for a quoted panel above Claude's input box", () => {
    expect(claudeRewindOpen(`${rewind("confirm-apple-restore", 40)}\n${rewind("closed", 40)}`)).toBe(false);
  });

  test("holds sends when an earlier input box is above the live rewind panel", () => {
    expect(claudeRewindOpen(`${rewind("closed", 40)}\n${rewind("confirm-apple-summarize-from", 40)}`)).toBe(true);
  });

  for (const width of [40, 120]) {
    test(`protects terminal rewind fields without offering cards at ${width} columns`, () => {
      for (const state of ["confirm-apple-restore", "confirm-apple-summarize-from", "confirm-apple-summarize-up-to", "confirm-apple-never-mind", "confirm-apple-restore-esc", "confirm-apple-summarize-from-esc", "confirm-long-610"]) {
        const screen = rewind(state, width);
        expect(claudeRewindOpen(screen), state).toBe(true);
        expect(parseInteractivePrompt("claude", screen), state).toBeNull();
      }
      expect(claudeRewindOpen(rewind("confirm-apple-esc-esc", width))).toBe(false);
    });
  }

  test("protects the rewind's message list, the screen it opens on, without offering a card", () => {
    const screen = rewind("select-banana", 40);
    expect(claudeRewindOpen(screen)).toBe(true);
    expect(parseInteractivePrompt("claude", screen)).toBeNull();
  });
});

/** Claude Code 2.1.311's /effort, recorded through an isolated herdr's pane.read from the command down (fixtures named by Ultracode's state and width; none: a model without it) */
const effort = (state: string, width: number): string =>
  readFileSync(new URL(`../fixtures/claude-effort-2.1.311-${state}-${width}.txt`, import.meta.url), "utf8");

const LEVELS = ["low", "medium", "high", "xhigh", "max"];

const labels = (prompt: InteractivePrompt | null) => prompt?.options.map((option) => option.label);

describe("Claude Code's /effort with Ultracode (#2232)", () => {
  test("offers the switch beside the slider, 70 columns or more, as a row that turns it the other way", () => {
    for (const [state, width] of [["off", 120], ["off-max", 120]] as const) {
      const prompt = parseInteractivePrompt("claude", effort(state, width));
      expect(labels(prompt), state).toEqual([...LEVELS, "Turn Ultracode on"]);
      expect(prompt?.own_text?.labels, state).toEqual({ 5: { key: "Turn Ultracode on" } });
      expect(prompt?.own_text?.descriptions, state).toEqual({ 5: { key: "Keeps the effort level, for this session only" } });
    }
    // on: Claude's own line under the names, where the slider drew a blank line before
    for (const [state, width] of [["on", 120], ["on-max", 120], ["on", 70]] as const) {
      expect(labels(parseInteractivePrompt("claude", effort(state, width))), `${state} ${width}`).toEqual([...LEVELS, "Turn Ultracode off"]);
    }
  });

  test("reads the slider of a pane under 70 columns, where the switch has two lines of its own under it", () => {
    expect(labels(parseInteractivePrompt("claude", effort("off", 60)))).toEqual([...LEVELS, "Turn Ultracode on"]);
    for (const [state, width] of [["on", 69], ["on", 60], ["on-max", 60]] as const) {
      expect(labels(parseInteractivePrompt("claude", effort(state, width))), `${state} ${width}`).toEqual([...LEVELS, "Turn Ultracode off"]);
    }
  });

  test("is one card for each state of the switch, wherever ▲ is and at any width", () => {
    const id = (state: string, width: number) => parseInteractivePrompt("claude", effort(state, width))?.id;
    const off = id("off", 120);
    const on = id("on", 120);
    expect(off).toBeDefined();
    expect(on).toBeDefined();
    expect(on).not.toBe(off);
    for (const [state, width] of [["off-max", 120], ["off", 60]] as const) expect(id(state, width), `${state} ${width}`).toBe(off);
    for (const [state, width] of [["on-max", 120], ["on", 70], ["on", 69], ["on", 60], ["on-max", 60]] as const) expect(id(state, width), `${state} ${width}`).toBe(on);
  });

  test("moves ▲ from the level it is over, and turns the switch with Tab, then s", () => {
    // ▲ over xhigh, as the session started
    const atXhigh = parseInteractivePrompt("claude", effort("on", 60))!;
    expect(answerKeys(atXhigh, { option_index: 1 })).toEqual([{ keys: ["left"] }, { keys: ["left"] }, { text: "s" }]);
    expect(answerKeys(atXhigh, { option_index: 3 })).toEqual([{ text: "s" }]);
    expect(answerKeys(atXhigh, { option_index: 5 })).toEqual([{ keys: ["tab"] }, { text: "s" }]);
    // ▲ over max, its description between the names and the switch
    const atMax = parseInteractivePrompt("claude", effort("on-max", 60))!;
    expect(answerKeys(atMax, { option_index: 3 })).toEqual([{ keys: ["left"] }, { text: "s" }]);
    expect(answerKeys(atMax, { option_index: 5 })).toEqual([{ keys: ["tab"] }, { text: "s" }]);
  });

  test("offers the levels alone for a model without Ultracode, which draws no switch", () => {
    for (const width of [120, 60]) {
      const prompt = parseInteractivePrompt("claude", effort("none", width));
      expect(labels(prompt), String(width)).toEqual(LEVELS);
      expect(() => answerKeys(prompt!, { option_index: 5 })).toThrow();
    }
  });

  test("reads the slider at max for a model without Ultracode, max's description right under the names", () => {
    // 2.1.311 keeps the line under the names for the switch only: without one, ▲ over max puts
    // the level's description there (as off-max-120 draws it under that line)
    const none = effort("none", 120);
    const description = effort("off-max", 120).split("\n").find((line) => line.includes("May use excessive tokens"))!;
    const atMax = none
      .replace(`${"─".repeat(30)}▲${"─".repeat(11)}`, `${"─".repeat(40)}▲─`)
      .replace("max\n\n", `max\n${description}\n\n`);
    expect(atMax).not.toBe(none);
    const prompt = parseInteractivePrompt("claude", atMax)!;
    expect(labels(prompt)).toEqual(LEVELS);
    expect(prompt.id).toBe(parseInteractivePrompt("claude", none)!.id);
    expect(answerKeys(prompt, { option_index: 3 })).toEqual([{ keys: ["left"] }, { text: "s" }]);
    expect(parsedByPublicPrompt.get(prompt)?.claudeUltracode).toBeNull();
    // names a narrow pane wrapped are still not read, with no blank line under them to tell: the
    // line of names under them is the rest of them
    const wrapped = none
      .replace(`${"─".repeat(30)}▲`, `${"─".repeat(20)}▲${"─".repeat(10)}`)
      .replace("high     xhigh      max", `high\n${" ".repeat(39)}xhigh      max`);
    expect(parseInteractivePrompt("claude", wrapped.replace(`high\n${" ".repeat(39)}xhigh`, "high     xhigh"))!.id).toBe(prompt.id);
    expect(parseInteractivePrompt("claude", wrapped)).toBeNull();
    expect(registry.waits("claude", wrapped)).toBe(true);
  });

  test("offers the levels alone where the user unbound the switch's key, and Claude draws its state alone", () => {
    // {"context": "EffortSlider", "bindings": {"tab": null}}: Claude names no key, so draws no key's line
    const unbound = [
      [effort("off", 120).replace("      Tab to toggle", ""), false],
      [effort("off", 60).replace("                       Tab to toggle\n", ""), false],
      [effort("on", 120).replace("      Tab to toggle", ""), true],
    ] as const;
    for (const [screen, drawn] of unbound) {
      expect(screen).not.toContain("to toggle");
      const prompt = parseInteractivePrompt("claude", screen)!;
      expect(labels(prompt), screen).toEqual(LEVELS);
      expect(answerKeys(prompt, { option_index: 1 }), screen).toEqual([{ keys: ["left"] }, { keys: ["left"] }, { text: "s" }]);
      expect(() => answerKeys(prompt, { option_index: 5 }), screen).toThrow();
      // the state drawn still guards a level's s
      expect(parsedByPublicPrompt.get(prompt)?.claudeUltracode, screen).toBe(drawn);
    }
  });

  test("sends no level's s where the unbound switch shows another state than the card was read from", async () => {
    const reader = registry.readerFor("claude-effort")!;
    const off = effort("off", 120).replace("      Tab to toggle", "");
    const on = effort("on", 120).replace("      Tab to toggle", "");
    for (const [shown, result] of [[off, "answered"], [on, "prompt_changed"]] as const) {
      const plan = reader.interaction!(parsedByPublicPrompt.get(parseInteractivePrompt("claude", off)!)!);
      const sent: AnswerStep[] = [];
      const outcome = await executeInteractionPlan(plan, 3, {
        rereadMoves: true,
        active: () => true,
        cancelled: () => false,
        read: async () => shown,
        send: async (step) => { sent.push(step); },
      });
      expect(outcome).toBe(result);
      expect(sent).toEqual(result === "answered" ? [{ text: "s" }] : []);
    }
  });

  test("keeps the switch's drawn state for the answer's last look, out of the card it sends", () => {
    for (const [state, width, drawn] of [["on", 120, true], ["off", 60, false], ["none", 120, null]] as const) {
      const prompt = parseInteractivePrompt("claude", effort(state, width))!;
      expect(parsedByPublicPrompt.get(prompt)?.claudeUltracode, `${state} ${width}`).toBe(drawn);
      expect(prompt, `${state} ${width}`).not.toHaveProperty("claudeUltracode");
    }
  });

  test("offers no card once s applied the switch, and holds nothing", () => {
    const set = effort("set", 120);
    expect(parseInteractivePrompt("claude", set)).toBeNull();
    expect(registry.waits("claude", set)).toBe(false);
  });

  test("sends the switch's s only once the slider shows it flipped at the same level", async () => {
    const reader = registry.readerFor("claude-effort")!;
    for (const [shown, result] of [[effort("on", 60), "answered"], [effort("off", 60), "prompt_changed"], [effort("on-max", 60), "prompt_changed"]] as const) {
      const plan = reader.interaction!(parsedByPublicPrompt.get(parseInteractivePrompt("claude", effort("off", 60))!)!);
      const sent: AnswerStep[] = [];
      const outcome = await executeInteractionPlan(plan, 5, {
        rereadMoves: true,
        active: () => true,
        cancelled: () => false,
        read: async () => shown,
        send: async (step) => { sent.push(step); },
      });
      expect(outcome).toBe(result);
      expect(sent).toEqual(result === "answered" ? [{ keys: ["tab"] }, { text: "s" }] : [{ keys: ["tab"] }]);
    }
  });
});

describe("Claude Code's bare /goal", () => {
  for (const width of [40, 120]) {
    test(`reads the goal dialog with a goal at ${width} columns`, () => {
      const prompt = parseInteractivePrompt("claude", fixture("active", width));
      expect(prompt?.title).toBe("Goal active");
      expect(prompt?.question).toBe("the file hello.txt exists in the project directory");
      expect(prompt?.body).toMatch(/^running \d+s · 0 tokens$/);
      expect(prompt?.options.map((option) => option.label)).toEqual(["Close"]);
      expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["esc"] }]);
      // the bridge's own words go as keys the client translates (#1482); the goal and its status are Claude's
      expect(prompt?.own_text).toEqual({ title: { key: "Goal active" }, labels: { 0: { key: "Close" } } });
    });

    test(`reads the goal dialog without a goal at ${width} columns`, () => {
      const prompt = parseInteractivePrompt("claude", fixture("none", width));
      expect(prompt?.title).toBe("Goal");
      expect(prompt?.question).toBe("No goal set");
      expect(prompt?.body).toBeNull();
      expect(prompt?.options.map((option) => option.label)).toEqual(["Close"]);
      expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["esc"] }]);
      expect(prompt?.own_text).toEqual({ title: { key: "Goal" }, question: { key: "No goal set" }, labels: { 0: { key: "Close" } } });
    });
  }

  test("a card for the same goal keeps its identity while the elapsed time ticks", () => {
    const shown = fixture("active", 120);
    const later = shown.replace(/running \d+s/, "running 4m 12s");
    expect(later).not.toBe(shown);
    expect(parseInteractivePrompt("claude", later)?.id).toBe(parseInteractivePrompt("claude", shown)?.id);
  });

  test("keeps the id an earlier bridge gave the card, so an answer to a card read before an update still lands (#1482)", () => {
    // the id main's bridge gave this card before its words went as keys (own_text is not part of it)
    expect(parseInteractivePrompt("claude", fixture("none", 120))?.id).toBe("d4c74b031221");
  });

  test("a different goal is a different card", () => {
    const shown = fixture("active", 120);
    expect(parseInteractivePrompt("claude", shown.replaceAll("hello.txt", "other.txt"))?.id).not.toBe(parseInteractivePrompt("claude", shown)?.id);
  });

  test("a running row that is not the recorded shape gets no card", () => {
    const shown = fixture("active", 120);
    for (const row of ["running a new unrecorded status", "running 25s", "running 25s · 0 tokens left", "running soon · 0 tokens"]) {
      expect(parseInteractivePrompt("claude", shown.replace(/running \d+s · 0 tokens/, row)), row).toBeNull();
    }
    expect(parseInteractivePrompt("claude", shown.replace(/running \d+s · 0 tokens/, "running 1h 2m 3s · 1,204 tokens"))?.title).toBe("Goal active");
  });

  test("a layout the dialog does not draw gets no card", () => {
    const shown = fixture("active", 120);
    expect(parseInteractivePrompt("claude", shown.replace("◎ Goal active", "◎ Goal achieved"))).toBeNull();
    expect(parseInteractivePrompt("claude", shown.replace("Esc to dismiss", "Esc to dismiss\n\n   Clear goal"))).toBeNull();
    expect(parseInteractivePrompt("claude", `${shown}\n❯ hello`)).toBeNull();
    expect(parseInteractivePrompt("claude", fixture("none", 120).replace("No goal set", "Goal paused"))).toBeNull();
  });
});

describe("Claude's question beside its fullscreen diff panel", () => {
  // live-captured from Claude Code 2.1.303 (`"tui": "fullscreen"`, /diff shown) in a 180x52 pane, the
  // session's text reworded: every row carries the panel's left edge in column 99 and the panel's own text after it
  const panel = (state: string) => readFileSync(new URL(`../fixtures/claude-diff-panel-2.1.303-${state}-180.txt`, import.meta.url), "utf8");
  const labels = (prompt: InteractivePrompt | null) => prompt?.options.map((option) => option.label);

  test("reads one question with long Korean descriptions, the panel's text left out", () => {
    const prompt = parseInteractivePrompt("claude", panel("one-korean"));
    expect(prompt).toMatchObject({
      kind: "question", title: "메뉴", question: "사이드바 메뉴를 어떻게 처리할까요?", custom_option_index: 3,
      options: [
        { label: "항상 펼쳐 두기", description: "사이드바를 화면 왼쪽에 고정해서 늘 펼쳐 둡니다. 메뉴 항목을 한눈에 볼 수 있어 찾기 쉽지만, 본문 영역이 그만큼 좁아집니다." },
        { label: "접이식으로 만들기" },
        { label: "상단 메뉴로 옮기기" },
      ],
    });
    expect(answerKeys(prompt!, { option_index: 2 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt!, { custom_text: "직접 입력" })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] }, { text: "직접 입력" }, { keys: ["enter"] },
    ]);
  });

  test("reads each of two questions and the review, with the panel's changes on screen", () => {
    const first = parseInteractivePrompt("claude", panel("two-first"));
    expect(first).toMatchObject({ kind: "question", title: "Scope · 1 of 2", question: "How far should the change go?", custom_option_index: 3 });
    expect(labels(first)).toEqual(["Only a.txt", "All modified files", "Whole repository"]);
    expect(answerKeys(first!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    const second = parseInteractivePrompt("claude", panel("two-second"));
    expect(second).toMatchObject({ kind: "question", title: "Tests · 2 of 2", question: "Add a regression test?", custom_option_index: 2 });
    expect(labels(second)).toEqual(["Add", "Skip"]);
    expect(answerKeys(second!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    const review = parseInteractivePrompt("claude", panel("two-review"));
    expect(review).toMatchObject({
      kind: "menu", title: "Review your answers", question: "Ready to submit your answers?",
      answers: [{ question: "How far should the change go?", answer: "Only a.txt" }, { question: "Add a regression test?", answer: "Skip" }],
    });
    expect(labels(review)).toEqual(["Submit answers", "Cancel"]);
  });

  test("reads short English options", () => {
    const prompt = parseInteractivePrompt("claude", panel("english"));
    expect(prompt).toMatchObject({ kind: "question", title: "Color", question: "Which color?", custom_option_index: 3 });
    expect(prompt?.options).toEqual([
      { label: "Red", description: "A warm, bold color." },
      { label: "Green", description: "A calm, natural color." },
      { label: "Blue", description: "A cool, steady color." },
    ]);
  });

  test("keeps a plan's table whole when no panel is beside it", () => {
    // a markdown table scrolled above the plan's top border: a `│` in one column on the first rows only
    const table = Array.from({ length: 8 }, (_, row) => `${`Task ${row}`.padEnd(40)}│ preserve requirement ${row}`);
    const screen = [
      ...table,
      "Claude has written up a plan and is ready to execute. Would you like to proceed?",
      "❯ 1. Yes",
      "  2. No",
      "  3. Tell Claude what to change",
      "ctrl+g to edit",
    ].join("\n");
    const prompt = parseInteractivePrompt("claude", screen);
    expect(prompt).not.toBeNull();
    for (let row = 0; row < 8; row += 1) expect(JSON.stringify(prompt), `row ${row}`).toContain(`preserve requirement ${row}`);
  });

  test("finds the panel's edge past a table divider that stops above the question", () => {
    // a table scrolled to the top of the session, its divider left of the panel's edge in column 99
    const lines = panel("english").split("\n");
    for (let row = 0; row < 8; row += 1) lines[row] = `${`Task ${row}`.padEnd(40)}${"\u2502 preserve requirement".padEnd(59)}\u2502`;
    const prompt = parseInteractivePrompt("claude", lines.join("\n"));
    expect(prompt).toMatchObject({ kind: "question", title: "Color", question: "Which color?" });
    expect(labels(prompt)).toEqual(["Red", "Green", "Blue"]);
  });

  test("an answered question beside the panel is not read as open", () => {
    // later output in the hint's place, the panel's edge still beside it
    const hint = "Enter to select · ↑/↓ to navigate · Esc to cancel";
    expect(parseInteractivePrompt("claude", panel("english").replace(hint, "● Done.".padEnd(hint.length)))).toBeNull();
  });
});

describe("Claude's words over its question (#2088)", () => {
  // live-captured from Claude Code 2.1.311 in a 119- and a 40-column pane while the question waited;
  // its session file had neither the words nor the call until the answer
  const asked = (width: number) => readFileSync(new URL(`../fixtures/claude-question-words-2.1.311-${width}.txt`, import.meta.url), "utf8");
  /** the screen with the words' lines (from their `●` line down to the panel's rule) replaced by `lines` */
  const withAbove = (screen: string, lines: string[]): string => {
    const rows = screen.split("\n");
    const start = rows.findIndex((row) => row.startsWith("● The file"));
    const rule = rows.findIndex((row, index) => index > start && /^─{8,}$/.test(row));
    return [...rows.slice(0, start), ...lines, ...rows.slice(rule)].join("\n");
  };

  test("reads the words over the question at 119 columns, the pane's wrapping joined back", () => {
    const prompt = parseInteractivePrompt("claude", asked(120));
    expect(prompt).toMatchObject({ kind: "question", title: "Fix", question: "Which fix do you want?" });
    expect(prompt?.screen_words).toBe([
      "The file a.txt has a made-up bug: its last line is missing a trailing newline, so the file doesn't end cleanly. I haven't opened or changed the file.",
      "There are two ways to fix it. Patch adds the missing newline to the end of the last line, a minimal edit. Rewrite regenerates the whole file from scratch, which is heavier and riskier.",
    ].join("\n\n"));
  });

  test("reads the words over the question at 40 columns", () => {
    expect(parseInteractivePrompt("claude", asked(40))?.screen_words).toBe([
      "The file a.txt has a made-up bug: its last line is missing a trailing newline, so the final line doesn't end properly. It's a contrived example, so I haven't checked or changed anything yet.",
      "There are two ways to fix it. You can patch the file by adding the missing newline, or rewrite the file from scratch. Which one do you want?",
    ].join("\n\n"));
  });

  test("keeps the card's id whatever the words are: they are not part of the question", () => {
    const quiet = parseInteractivePrompt("claude", withAbove(asked(40), []));
    expect(quiet?.screen_words).toBeUndefined();
    expect(parseInteractivePrompt("claude", asked(40))?.id).toBe(quiet!.id);
  });

  test("reads no words when the user's prompt is right over the question", () => {
    const panel = readFileSync(new URL("../fixtures/claude-diff-panel-2.1.303-english-180.txt", import.meta.url), "utf8");
    const prompt = parseInteractivePrompt("claude", panel);
    expect(prompt).toMatchObject({ kind: "question", title: "Color" });
    expect(prompt?.screen_words).toBeUndefined();
  });

  test("reads no words when a tool's output is right over the question", () => {
    const prompt = parseInteractivePrompt("claude", withAbove(asked(120), ["● Read(a.txt)", "  ⎿  Read 3 lines", ""]));
    expect(prompt).toMatchObject({ kind: "question", title: "Fix" });
    expect(prompt?.screen_words).toBeUndefined();
  });

  test("reads no words whose start is above the screen's top: they read as the user's wrapped prompt does", () => {
    const rows = asked(40).split("\n");
    const cut = rows.slice(rows.findIndex((row) => row.startsWith("● The file")) + 1).join("\n");
    const prompt = parseInteractivePrompt("claude", cut);
    expect(prompt).toMatchObject({ kind: "question", title: "Fix" });
    expect(prompt?.screen_words).toBeUndefined();
  });

  test("reads no words over a collapsed group of tool calls, its bullet drawn or not (live 2.1.311, 43 columns)", () => {
    const tools = readFileSync(new URL("../fixtures/claude-question-tools-2.1.311-43.txt", import.meta.url), "utf8");
    for (const screen of [tools, tools.replace("  Read 2 files (ctrl+o to expand)", "● Read 2 files (ctrl+o to expand)")]) {
      const prompt = parseInteractivePrompt("claude", screen);
      expect(prompt).toMatchObject({ kind: "question", title: "File", question: "Which file should I fix?" });
      expect(prompt?.screen_words).toBeUndefined();
    }
    // the hint wrapped by a narrow pane, and a group whose bullet is drawn above Claude's own line
    expect(parseInteractivePrompt("claude", withAbove(asked(40), ["● Searched for 2 patterns, read 1 file (ctrl+o", "  to expand)", ""]))?.screen_words).toBeUndefined();
  });

  test("reads no words over a plugin's MCP call", () => {
    expect(parseInteractivePrompt("claude", withAbove(asked(40), ["● plugin/thing - do (MCP)(x: 1)", ""]))?.screen_words).toBeUndefined();
  });

  test("reads no words of an earlier turn over a rule that is not the question's own", () => {
    const rows = asked(40).split("\n");
    const start = rows.findIndex((row) => row.startsWith("● The file"));
    const rule = rows.findIndex((row, index) => index > start && /^─{8,}$/.test(row));
    const screen = [...rows.slice(0, start), "● Earlier task: Rewrite is safest.", "─".repeat(40), "❯ New task: use Patch.", "", ...rows.slice(rule + 1)].join("\n");
    const prompt = parseInteractivePrompt("claude", screen);
    expect(prompt).toMatchObject({ kind: "question", title: "Fix" });
    expect(prompt?.screen_words).toBeUndefined();
  });

  test("keeps the breaks of a command, a path or a URL: joining them could change what they say", () => {
    expect(parseInteractivePrompt("claude", withAbove(asked(40), [
      "● Use this shell snippet:",
      "  # Safety: do not remove saved backups.",
      "  rm -rf backups",
      "",
    ]))?.screen_words).toBe("Use this shell snippet:\n# Safety: do not remove saved backups.\nrm -rf backups");
    expect(parseInteractivePrompt("claude", withAbove(asked(40), [
      "● See https://example.com/docs/very/long",
      "  /path/to/the/page for the details.",
      "",
    ]))?.screen_words).toBe("See https://example.com/docs/very/long\n/path/to/the/page for the details.");
  });

  test("keeps two commands on their lines", () => {
    expect(parseInteractivePrompt("claude", withAbove(asked(40), ["● Run these:", "  git log --oneline --decorate --graph", "  git status", ""]))?.screen_words)
      .toBe("Run these:\ngit log --oneline --decorate --graph\ngit status");
  });

  test("keeps commands without options on their lines, though the first one fills the pane", () => {
    // "  git merge experimental-feature-branch" is 39 columns: "git" would not have fit after it
    expect(parseInteractivePrompt("claude", withAbove(asked(40), ["● Merge and push:", "", "  git merge experimental-feature-branch", "  git push", ""]))?.screen_words)
      .toBe("Merge and push:\n\ngit merge experimental-feature-branch\ngit push");
  });

  test("keeps command lines apart in a paragraph that ends in a path with a period", () => {
    expect(parseInteractivePrompt("claude", withAbove(asked(40), ["● Merge and push:", "", "  git merge experimental-feature-branch", "  git push", "  docs/release-notes.md.", ""]))?.screen_words)
      .toBe("Merge and push:\n\ngit merge experimental-feature-branch\ngit push\ndocs/release-notes.md.");
  });

  test("keeps command lines apart when text follows them with no blank line", () => {
    expect(parseInteractivePrompt("claude", withAbove(asked(40), ["● Merge and push:", "", "  git merge experimental-feature-branch", "  git push", "  Then the branch is on the remote.", ""]))?.screen_words)
      .toBe("Merge and push:\n\ngit merge experimental-feature-branch\ngit push\nThen the branch is on the remote.");
  });

  test("reads Korean prose with a word in parentheses as Claude's words, not a tool call", () => {
    expect(parseInteractivePrompt("claude", withAbove(asked(40), ["● 패치(Patch)는 기존 내용을 보존합니다.", ""]))?.screen_words).toBe("패치(Patch)는 기존 내용을 보존합니다.");
  });

  test("joins Korean at its spaces, and Chinese without one only where the line was full", () => {
    expect(parseInteractivePrompt("claude", withAbove(asked(40), ["● 마지막 줄에 줄바꿈이 빠져 있어서", "  파일이 깔끔하게 끝나지 않습니다.", ""]))?.screen_words)
      .toBe("마지막 줄에 줄바꿈이 빠져 있어서 파일이 깔끔하게 끝나지 않습니다.");
    expect(parseInteractivePrompt("claude", withAbove(asked(40), ["● 文件最后一行缺少换行符所以文件没有正常", "  地结束。", ""]))?.screen_words)
      .toBe("文件最后一行缺少换行符所以文件没有正常地结束。");
    expect(parseInteractivePrompt("claude", withAbove(asked(40), ["● 文件缺少换行符。", "  请选择修复方式。", ""]))?.screen_words)
      .toBe("文件缺少换行符。\n请选择修复方式。");
  });

  test("keeps a list's items on lines of their own", () => {
    const prompt = parseInteractivePrompt("claude", withAbove(asked(40), [
      "● Two ways to fix it:",
      "  - Patch: add the missing newline to",
      "    the end of the last line.",
      "  - Rewrite: rewrite the whole file.",
      "",
    ]));
    expect(prompt?.screen_words).toBe("Two ways to fix it:\n- Patch: add the missing newline to the end of the last line.\n- Rewrite: rewrite the whole file.");
  });
});

/** Claude Code 2.1.312's question panel at 120 columns, colors kept: two questions and the review (#2465) */
const tabsPanel = (state: string): string =>
  readFileSync(new URL(`../fixtures/claude-tabs-2.1.312-${state}-120.ansi`, import.meta.url), "utf8");

describe("Claude Code's question tabs as the card's steps", () => {
  const steps = (prompt: InteractivePrompt | null) => prompt?.steps?.map(({ label, answered, current, can_navigate }) => [label, answered, current, can_navigate ?? false]);

  test("offers the other tabs from the one drawn on a background, and Back from all but the first", () => {
    const first = parseInteractivePrompt("claude", tabsPanel("first"));
    expect(first).toMatchObject({ title: "Device · 1 of 2", question: "Which device do you use?" });
    expect(steps(first)).toEqual([["Device", false, true, false], ["Symptoms", false, false, true], ["Submit", false, false, true]]);
    expect(first?.can_step_back).toBeUndefined();
    // back on an answered question: its own name, not the first question still open
    const back = parseInteractivePrompt("claude", tabsPanel("first-answered"));
    expect(back).toMatchObject({ title: "Device · 1 of 2", question: "Which device do you use?" });
    expect(steps(back)).toEqual([["Device", true, true, false], ["Symptoms", false, false, true], ["Submit", false, false, true]]);
    const second = parseInteractivePrompt("claude", tabsPanel("second"));
    expect(second).toMatchObject({ title: "Symptoms · 2 of 2", can_step_back: true });
    expect(steps(second)).toEqual([["Device", true, false, true], ["Symptoms", false, true, false], ["Submit", false, false, true]]);
  });

  test("tells two tabs apart that ask the same question with the same options", () => {
    // the same label, question and options on both tabs: only the tab shown says which is asked
    const bar = (lit: number) => "← " + [" ☐ Device ", " ☐ Device ", " ✔ Submit "]
      .map((tab, at) => at === lit ? `\u001b[38;2;0;0;0m\u001b[48;2;177;185;249m${tab}\u001b[0m` : tab).join("") + " →";
    const on = (lit: number) => tabsPanel("first").split("\n").map((line) => line.replace(ANSI_RE, "").startsWith("←") ? bar(lit) : line).join("\n");
    const first = parseInteractivePrompt("claude", on(0));
    const second = parseInteractivePrompt("claude", on(1));
    expect(first?.question).toBe(second?.question);
    expect(first?.steps?.[0]?.current).toBe(true);
    expect(second?.steps?.[1]?.current).toBe(true);
    // a stale answer for one never reads as an answer for the other
    expect(first?.id).not.toBe(second?.id);
  });

  test("gives the review its steps and Back", () => {
    const review = parseInteractivePrompt("claude", tabsPanel("review"));
    expect(review).toMatchObject({ kind: "menu", title: "Review your answers", can_step_back: true });
    expect(steps(review)).toEqual([["Device", true, false, true], ["Symptoms", true, false, true], ["Submit", false, true, false]]);
    const reviewBack = parseInteractivePrompt("claude", tabsPanel("review-back"));
    expect(reviewBack).toMatchObject({ title: "Symptoms · 2 of 2", question: "Which problems do you see?", can_step_back: true });
  });

  test("offers no steps when the colors do not say which tab is shown, and keeps the card's id while it answers in order", () => {
    for (const state of ["first", "first-answered", "second", "review", "review-back"]) {
      const colored = parseInteractivePrompt("claude", tabsPanel(state));
      const plain = parseInteractivePrompt("claude", tabsPanel(state).replace(ANSI_RE, ""));
      expect(plain?.steps, state).toBeUndefined();
      expect(plain?.can_step_back, state).toBeUndefined();
      // on the first question still open, a poll whose colors could not be read is the same card;
      // back on an answered one it is another, as the tab shown is part of the card (#2465)
      expect(colored?.id === plain?.id, state).toBe(["first", "second", "review"].includes(state));
    }
    // two tabs on a background, or a bar the pane cut off at its edge: no tab to go from
    const twoLit = tabsPanel("first").replace("\u001b[0m ☐ Symptoms ", "\u001b[0m\u001b[48;2;177;185;249m ☐ Symptoms \u001b[0m");
    expect(parseInteractivePrompt("claude", twoLit)?.steps).toBeUndefined();
    // no tab on a background, one in the default color among dimmed ones: a style, not the tab shown
    const plainBar = "\u001b[2m←  \u001b[22m ☐ Device \u001b[2m ☐ Symptoms  ✔ Submit  →\u001b[0m";
    const noBackground = tabsPanel("first").split("\n").map((line) => line.replace(ANSI_RE, "").startsWith("←") ? plainBar : line).join("\n");
    expect(parseInteractivePrompt("claude", noBackground)?.question).toBe("Which device do you use?");
    expect(parseInteractivePrompt("claude", noBackground)?.steps).toBeUndefined();
    const cut = tabsPanel("first").replace("✔ Submit  →", "✔ Su");
    expect(parseInteractivePrompt("claude", cut)?.steps).toBeUndefined();
  });
});
