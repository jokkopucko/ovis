import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { answerKeys, parseInteractivePrompt } from "../prompt.ts";
import { parsedByPublicPrompt } from "./shared.ts";
import { registry } from "./registry.ts";
import { dshFreeTextRow } from "./dsh.ts";

// recorded from dsh-tui 0.20.0 in a 100x50 tmux pane (narrow: 52 columns), ask_user_question asked by dsh-deepseek-flash
const screen = (name: string) => readFileSync(join(import.meta.dir, "..", "fixtures", `dsh-question-0.20.0-${name}.txt`), "utf8");
const MIXED = "用WDA方案先在真机上跑通，然后把预发环境的接口当作夜间任务的后备，手机离线时自动切换，两条路径都记日志，这样两周后可以比较哪条更稳定一些。";
const CHINESE = "先在真机上跑通方案然后把预发环境的接口当作夜间任务的后备手机离线时自动切换两条路径都记日志这样两周后可以比较哪条更稳定一些";
const oneLineHint = (panel: string) => panel.replace("Esc cancel ·\n    Ctrl+K", "Esc cancel · Ctrl+K");
const onFreeText = (panel: string) => panel.replace(/❯([○◉])/, " $1").replace(" ✎ Custom answer： Type directly…", "❯✎ Custom answer：")
  .replace(/↑\/↓ select[^]*?click the header/, "Type answer · Ctrl+V paste · Enter submit · ↑ back to options · Esc cancel · ←/→ at the text edge switches question · Ctrl+K to fold\n    / click the header");

const HEADLESS = [
  { label: "Device + WebDriverAgent (Recommended)", description: "Uses iphone172 and the MacBook; no App Attest workaround, no ToS risk, durable." },
  { label: "Dev API + Firebase token", description: "No hardware, but depends on an unprotected staging API." },
];

describe("DeepSeek Harness ask_user_question panel", () => {
  it("is read for dsh-tui panes only", () => {
    expect(registry.readersFor("dsh-tui").map((reader) => reader.id)).toContain("dsh-question");
    expect(registry.readersFor("claude").map((reader) => reader.id)).not.toContain("dsh-question");
  });

  it.each(["q1", "narrow-52"])("reads the question, its options with their descriptions and the free-text row (%s)", (name) => {
    const prompt = parseInteractivePrompt("dsh-tui", screen(name));
    expect(prompt).toMatchObject({
      kind: "question", question: "Which headless approach should I build?", multi_select: false,
      options: HEADLESS, custom_option_index: 2,
    });
    expect(prompt?.fallback).toBeUndefined();
    expect(parsedByPublicPrompt.get(prompt!)?.responder).toBe("dsh-question");
  });

  it("tells a multiple choice by its rows' marks, never by a ◉ in an option's words", () => {
    const prompt = parseInteractivePrompt("dsh-tui", screen("q1").replace("no ToS risk", "no ◉ ToS risk").replace("Dev API + Firebase token", "Dev API ◉ Firebase token"))!;
    expect(prompt).toMatchObject({ multi_select: false, custom_option_index: 2 });
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    const described = screen("q1").replace("No hardware, but depends on an unprotected staging API.", "No hardware; shows ◉ when the API is up.");
    expect(parseInteractivePrompt("dsh-tui", described)).toMatchObject({ multi_select: false, custom_option_index: 2 });
  });

  it("has no card while dsh folds part of a long question out of view (recorded at 118x40): the card would show it cut short", () => {
    expect(screen("q1-folded")).toContain("… 16 lines outside view");
    expect(parseInteractivePrompt("dsh-tui", screen("q1-folded"))).toBeNull();
  });

  it("keeps the card for a question whose own words start a line with …: only dsh's fold line folds it", () => {
    const own = screen("q1").replace("    Which headless approach should I build?\n", "    Which headless approach should I build?\n    … or skip headless runs for now.\n");
    expect(parseInteractivePrompt("dsh-tui", own)?.question).toBe("Which headless approach should I build? … or skip headless runs for now.");
  });

  it("shows the header chip over the question", () => {
    expect(parseInteractivePrompt("dsh-tui", screen("q1"))?.body).toBe("Choose Approach");
  });

  it("answers from wherever the cursor stands: moves, then Enter", () => {
    expect(answerKeys(parseInteractivePrompt("dsh-tui", screen("q1"))!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(parseInteractivePrompt("dsh-tui", screen("q1-down"))!, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
  });

  it("has no card with the cursor on the free-text row and nothing ticked: a multiple choice draws there as a single choice does", () => {
    expect(parseInteractivePrompt("dsh-tui", screen("q1-custom"))).toBeNull();
    expect(parseInteractivePrompt("dsh-tui", onFreeText(screen("multi-q1")))).toBeNull();
    expect(parseInteractivePrompt("dsh-tui", onFreeText(screen("multi-q1-checked")))).toMatchObject({ multi_select: true, default_option_indices: [0, 2] });
  });

  it("types a custom answer on the free-text row, never Enter first (it would only ask for text)", () => {
    expect(answerKeys(parseInteractivePrompt("dsh-tui", screen("q1"))!, { custom_text: "node --test" }))
      .toEqual([{ keys: ["down"] }, { keys: ["down"] }, { text: "node --test" }, { keys: ["enter"] }]);
    expect(answerKeys(parseInteractivePrompt("dsh-tui", screen("q1-down"))!, { custom_text: "a\nb" }))
      .toEqual([{ keys: ["down"] }, { text: "a b" }, { keys: ["enter"] }]);
  });

  it.each(["x\u001b[By", "x\u0003y", "\u001b", "a\rb", "a\tb"])("refuses a custom answer dsh would read as keys (%j) before any key", (text) => {
    expect(() => answerKeys(parseInteractivePrompt("dsh-tui", screen("q1"))!, { custom_text: text })).toThrow("control characters");
  });

  it("reads a typed answer back from its row, the label squeezed into a column once the text wraps (recorded at 118 columns)", () => {
    const card = parsedByPublicPrompt.get(parseInteractivePrompt("dsh-tui", screen("q1"))!)!;
    const typed = "Use the device with WebDriverAgent first, then keep the staging API as a fallback for nightly runs when the phone is offline, and log both paths so we can compare flakiness over two weeks";
    expect(dshFreeTextRow(screen("q1-typed-wrapped"), card, typed)).toBe("typed");
    expect(dshFreeTextRow(screen("q1-typed-wrapped"), card, typed.slice(0, 50))).toBeNull();
    expect(dshFreeTextRow(screen("q1-typed-wrapped"), card, `${typed} too`)).toBe("typing");
  });

  it("reads a wrap back as dsh draws it: one space, or none or one under a line that reaches the row's end (recorded at 118 columns)", () => {
    const card = parsedByPublicPrompt.get(parseInteractivePrompt("dsh-tui", screen("q1"))!)!;
    const typed = "Use the device with WebDriverAgent first, then keep the staging API as a fallback for nightly runs when the phone is offline, and log both paths so we can compare flakiness over two weeks";
    expect(dshFreeTextRow(screen("q1-typed-wrapped"), card, typed.replace("nightly runs", "nightlyruns"))).toBeNull();
    expect(dshFreeTextRow(screen("q1-typed-url"), card, `see https://example.com/${"a".repeat(140)} ok`)).toBe("typed");
    expect(dshFreeTextRow(screen("q1-typed-edge"), card, typed.replace("nightly runs", "nightlyy runs"))).toBe("typed");
  });

  it.each([
    ["q1-typed-mixed", MIXED], ["q1-typed-mixed-111", MIXED],
    ["q1-typed-chinese-111", CHINESE], ["q1-typed-chinese-107", CHINESE], ["q1-typed-chinese-101", CHINESE],
  ])("reads back a Chinese answer whose row ends a cell short, its next character too wide to fit, the `：` kept or squeezed out (%s, recorded)", (name, text) => {
    const card = parsedByPublicPrompt.get(parseInteractivePrompt("dsh-tui", screen("q1"))!)!;
    expect(dshFreeTextRow(screen(name), card, text)).toBe("typed");
  });

  it("refuses the panel once text was typed into its free-text row in the terminal", () => {
    // typed on an option row: dsh-tui attaches that option's label to the text (recorded on 0.20.0)
    const typed = screen("q1").replace("✎ Custom answer： Type directly…", "✎ Custom answer(attached: Device + WebDriverAgent (Recommended))：node▏");
    expect(parseInteractivePrompt("dsh-tui", typed)).toBeNull();
  });

  it("reads the panel as dsh-tui draws it in Chinese", () => {
    const zh = screen("q1").replace("📋 Question 1/1 ", "📋 提问 · 第 1/1 题 ")
      .replace("✎ Custom answer： Type directly…", "✎ 自定义回答： 直接输入…")
      .replace(/↑\/↓ select[^]*?click the header/, "↑/↓ 选择 · Ctrl+V 粘贴 · 输入文字附带回答 · Enter 提交 · Esc 中断 · Ctrl+K 折叠 / 点标题行收起");
    const prompt = parseInteractivePrompt("dsh-tui", zh)!;
    expect(prompt).toMatchObject({ question: "Which headless approach should I build?", multi_select: false, options: HEADLESS, custom_option_index: 2 });
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    const multi = screen("multi-q1").replace(/↑\/↓ select[^]*?click the header/, "↑/↓ 选择 · Space 多选 · Enter 提交 · Esc 中断 · Ctrl+K 折叠 / 点标题行收起");
    expect(parseInteractivePrompt("dsh-tui", multi)?.multi_select).toBe(true);
  });

  it("reads a multiple choice of a batch, its ticks and its question switch", () => {
    const first = parseInteractivePrompt("dsh-tui", screen("multi-q1"))!;
    expect(first).toMatchObject({
      question: "Which platforms should we test?", body: "Platforms", multi_select: true, custom_option_index: null,
      options: [{ label: "iOS" }, { label: "Android" }, { label: "Web" }], can_step_next: true,
    });
    expect(first.can_step_back).toBeUndefined();
    expect(answerKeys(first, { option_indices: [0, 2] }))
      .toEqual([{ keys: ["space"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["space"] }, { keys: ["enter"] }]);
    const ticked = parseInteractivePrompt("dsh-tui", screen("multi-q1-checked"))!;
    expect(ticked.default_option_indices).toEqual([0, 2]);
    expect(answerKeys(ticked, { option_indices: [0, 2] })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(ticked, { option_indices: [1] })).toEqual([
      { keys: ["up"] }, { keys: ["up"] }, { keys: ["space"] }, { keys: ["down"] }, { keys: ["space"] },
      { keys: ["down"] }, { keys: ["space"] }, { keys: ["enter"] },
    ]);
  });

  it("reads the batch's last question with a way back", () => {
    expect(parseInteractivePrompt("dsh-tui", screen("multi-q2"))).toMatchObject({
      question: "Which runner?", multi_select: false, custom_option_index: 2, can_step_back: true,
      options: [{ label: "Bun test" }, { label: "Vitest" }],
    });
  });

  it("is no card once the panel is answered and the conversation goes on under it", () => {
    expect(parseInteractivePrompt("dsh-tui", `${screen("q1")}\n  ● Answers received.\n  ╭────╮\n  ⌸ ❯\n  ╰────╯\n${"  more output\n".repeat(10)}`)).toBeNull();
  });

  it("is no card for a panel answered on a wide pane, its hint one line, with dsh's input box or any output under it", () => {
    const [panel, footer] = [oneLineHint(screen("q1")).split("\n").slice(0, 45), screen("q1").split("\n").slice(46)];
    expect(parseInteractivePrompt("dsh-tui", [...panel, "  ╭────╮", "  ⌸ ❯", "  ╰────╯", ...footer.slice(0, 2)].join("\n"))).toBeNull();
    expect(parseInteractivePrompt("dsh-tui", [...panel, "  ● Done.", ...footer].join("\n"))).toBeNull();
    expect(parseInteractivePrompt("dsh-tui", [...screen("q1").split("\n").slice(0, 46), "  ● Done.", ...footer].join("\n"))).toBeNull();
  });

  it.each(["default", "not compact", "no ctx field", "a wake on the hint row", "a hover's detail", "idle", "a background job and no model field"])("reads the live panel under dsh-tui's footer set to %s, on a wide, a 100- and a 52-column pane", (setting) => {
    for (const panel of [oneLineHint(screen("q1")), screen("q1"), screen("narrow-52")]) {
      const lines = panel.split("\n");
      const status = lines.findIndex((line) => line.includes("ctx 1.1% (11k/1.0m)"));
      const hint = lines.findIndex((line) => line.trim() === "esc to interrupt");
      if (setting === "not compact") lines[status] = "   dsh-deepseek-flash · high · ctx 11k/1.0m (1.1%)        dshq";
      if (setting === "no ctx field") lines[status] = "   dsh-deepseek-flash · high · dshq";
      if (setting === "a wake on the hint row") lines[hint] = "   esc to interrupt                      ▁▂▃";
      if (setting === "a hover's detail") lines[hint] = "   1.1% · 11k/1.0m · free 989k · used 11k";
      if (setting === "idle") lines.splice(hint, 1);
      if (setting === "a background job and no model field") lines[status] = "   ● 1 · high · cache 97.5% · ≈ unpriced 11.2k tok · dshq   ctx 1.1% (11k/1.0m)";
      expect(parseInteractivePrompt("dsh-tui", lines.join("\n"))?.question).toBe("Which headless approach should I build?");
    }
  });

  it("is no card with anything but dsh-tui's own footer under the hint", () => {
    const [panel, footer] = [screen("q1").split("\n").slice(0, 46), screen("q1").split("\n").slice(46)];
    expect(parseInteractivePrompt("dsh-tui", [...panel, "  ● Done.", "  a", "  b", ...footer].join("\n"))).toBeNull();
    expect(parseInteractivePrompt("dsh-tui", [...panel, "  ╭────╮", "  ⌸ ❯", "  ╰────╯", ...footer.slice(0, 2)].join("\n"))).toBeNull();
  });
});
