import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PromptCard } from "./PromptCard.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { blocksStepNavigation } from "../lib/promptAnswer.ts";
import system from "../../server/fixtures/pi-ask-system-theme.json";
import { parseInteractivePrompt } from "../../server/prompt.ts";
import fixtures from "../../server/fixtures/pi-ask-navigation.json";

const render = (screen: string, agent = "pi", typedAnswer: { option_index: number } | null = null): string => {
  const prompt = parseInteractivePrompt(agent, screen)!;
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(PromptCard, {
      paneId: "fictional-pi-pane", prompt, onAnswered() {}, onPromptChanged() {}, typedAnswer,
    }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

test("Pi's first question shows its labels and a real button for the next unanswered tab", () => {
  const html = render(fixtures.first);
  expect(html).toContain('aria-label="Questions"');
  expect(html).toContain('aria-label="输出类型"');
  expect(html).not.toContain('aria-label="Back"');
  expect(html).not.toContain('aria-label="Submit"');
});

test("Pi's second question and review expose Back and previously answered question buttons", () => {
  for (const screen of [fixtures.second, fixtures.review]) {
    const html = render(screen);
    expect(html).toContain('aria-label="Back"');
    expect(html).toContain('aria-label="单元格内容"');
  }
});

test("the first answered tab can switch forward without resubmitting its answer", () => {
  expect(render(fixtures["first-answered"])).toContain('aria-label="输出类型"');
});

test("Pi review uses Ovis's existing answer-summary typography and missing-answer state", () => {
  for (const name of ["review", "review-incomplete"]) {
    const html = render(system.states.find(state => state.name === name)!.screen);
    expect(html).toContain('class="prompt-card-answers"');
    expect(html).not.toContain("<pre");
    if (name === "review-incomplete") expect(html).toContain("Not answered");
  }
});

test("navigation never silently discards web-only edits, but saved native values are not dirty", () => {
  const prompt = parseInteractivePrompt("pi", fixtures.first)!;
  expect(blocksStepNavigation(prompt, new Set(), "")).toBe(false);
  expect(blocksStepNavigation(prompt, new Set(), "unsent")).toBe(true);
  expect(blocksStepNavigation({ ...prompt, default_custom_text: "saved" }, new Set(), "saved")).toBe(false);
  const multi = { ...prompt, multi_select: true, default_option_indices: [0] };
  expect(blocksStepNavigation(multi, new Set([0]), "")).toBe(false);
  expect(blocksStepNavigation(multi, new Set([0, 1]), "")).toBe(true);
  expect(blocksStepNavigation({ ...prompt, agent: "opencode" }, new Set(), "unsent")).toBe(false);
});

test("Claude's steps and Back wait while a typed answer waits for Confirm, which a move would drop", () => {
  const review = readFileSync(new URL("../../server/fixtures/claude-tabs-2.1.312-review-120.ansi", import.meta.url), "utf8");
  const back = (html: string) => /<button[^>]*class="btn btn-ghost prompt-card-back"[^>]*>/.exec(html)?.[0] ?? "";
  expect(back(render(review, "claude"))).not.toContain("disabled");
  expect(back(render(review, "claude", { option_index: 0 }))).toContain("disabled");
});
