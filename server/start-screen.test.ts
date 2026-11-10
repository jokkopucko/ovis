import { describe, expect, it } from "bun:test";

import { agyStartScreenUnused, codexStartScreenUnused, readsStartScreen, startScreenMetadata } from "./start-screen.ts";

const AGY = [
  "❯ agy",
  "",
  "       ▄▀▀▄         Antigravity CLI 1.4.4",
  "      ▀▀▀▀▀▀        user@example.test (Demo plan    )",
  "     ▀▀▀▀▀▀▀▀       Gemini 3.8 Flash (High)",
  "    ▄▀▀     ▀▀▄      /tmp/test-project",
  "   ▄▀▀       ▀▀▄",
  "",
  " ⚠ Warning",
  "  ⎿   \"Gemini 3.1 Pro (Low)\" is no longer available. Using \"Gemini 3.8 Flash (High)\".",
  "",
  " ────────────────────────────────────────",
  " >",
  " ────────────────────────────────────────",
  " ? for shortcuts   Gemini 3.8 Flash · high",
].join("\n");

const CLAUDE = [
  " ▐▛███▛█   Claude Code v2.1.296",
  "▝▜██████▀  Haiku 5.5 · Claude Max",
  " ▝▝   ▝▝   ~/workspace/test-project",
  "────────────────────────────────────────",
  "❯ Try \"fix lint errors\"",
  "────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");

const CODEX = [
  "  >_ OpenAI Codex (v0.162.1)",
  "     /tmp/test-project",
  "  permissions: YOLO mode",
  "  /model - choose what model and reasoning effort to use",
  "› Ask Codex to do anything",
  "  GPT-6-Luna medium fast · /tmp/test-project",
  "  ← for agents · ? for shortcuts",
].join("\n");

const GJC = [
  "│                 [ ⬢ Anthropic Opus 5.5 ]                 │ ─────────────── │",
  "╰──────────────────────────────────────────────────────────┴─────────────────╯",
  " ⬢ opus-5.5 · ◉ xhigh · 1.5% / ⑂ main / 📁 …/test-project ───── (sub) / v0.17.7",
  "│ > Type your message... ⌥Q: Queue (busy) · ⇧⇥: Thinking │",
].join("\n");

const PI = [
  "\u2500".repeat(80),
  "",
  "\u2500".repeat(80),
  "~/code/project (main)",
  "0.0%/262k (auto)                                    zorro-davidau-3.8-flash-next \u2022 xhigh",
].join("\n");

describe("startScreenMetadata", () => {
  it("reads Claude Code's model under its title, as the id its transcript records", () => {
    expect(startScreenMetadata("claude-transcript", CLAUDE)).toEqual({ model: "claude-haiku-5-5", reasoning_effort: null });
    expect(startScreenMetadata("claude-transcript", CLAUDE.replace("Haiku 5.5", "Sonnet 5"))).toEqual({ model: "claude-sonnet-5", reasoning_effort: null });
  });

  it("names no Claude model it cannot give an id for certain", () => {
    expect(startScreenMetadata("claude-transcript", CLAUDE.replace("Haiku 5.5", "Opus 5.5 (1M context)")).model).toBeNull();
    expect(startScreenMetadata("claude-transcript", CLAUDE.replace("Haiku 5.5", "Default")).model).toBeNull();
    expect(startScreenMetadata("claude-transcript", "Accessing workspace\nIs this a project you created or one you trust?").model).toBeNull();
  });

  it("reads Codex's model and effort from the line under its composer", () => {
    expect(startScreenMetadata("codex-transcript", CODEX)).toEqual({ model: "gpt-6-luna", reasoning_effort: "medium" });
    expect(startScreenMetadata("codex-transcript", CODEX.replace("GPT-6-Luna medium fast", "GPT-5.6 xhigh"))).toEqual({ model: "gpt-5.6", reasoning_effort: "xhigh" });
  });

  it("reads the model a custom provider names in Codex's footer, as written (#3263)", () => {
    for (const [footer, model, effort] of [
      ["DeepSeek4.1flash(OpenCode) low fast", "DeepSeek4.1flash(OpenCode)", "low"],
      ["gpt-6.1-terra high", "gpt-6.1-terra", "high"],
      ["opus5.5(AG) medium", "opus5.5(AG)", "medium"],
      ["qwen3-coder:30b xhigh", "qwen3-coder:30b", "xhigh"],
    ] as const) {
      const screen = CODEX.replace("GPT-6-Luna medium fast", footer);
      expect(startScreenMetadata("codex-transcript", screen)).toEqual({ model, reasoning_effort: effort });
      // a new pane's start screen, so its chat is an empty new conversation (regression: fails on main)
      expect(codexStartScreenUnused(screen)).toBeTrue();
    }
    // still no model without an effort, and none from a line that is no footer
    expect(startScreenMetadata("codex-transcript", CODEX.replace("GPT-6-Luna medium fast", "DeepSeek4.1flash(OpenCode)"))).toEqual({ model: null, reasoning_effort: null });
    expect(startScreenMetadata("codex-transcript", CODEX.replace("GPT-6-Luna medium fast", "some words high"))).toEqual({ model: null, reasoning_effort: null });
    expect(codexStartScreenUnused(CODEX.replace("GPT-6-Luna medium fast", "DeepSeek4.1flash(OpenCode) low").replace("  \u2190 for agents \u00b7 ? for shortcuts", ""))).toBeFalse();
  });

  it("reads Codex's start screen at Ultra reasoning effort, where the composer's mark is » (Codex 0.164 on)", () => {
    const ultra = CODEX.replace("› Ask Codex to do anything", "» Ask Codex to do anything").replace("GPT-6-Luna medium fast", "GPT-6-Sol ultra");
    expect(startScreenMetadata("codex-transcript", ultra)).toEqual({ model: "gpt-6-sol", reasoning_effort: "ultra" });
    // a new pane's start screen, so its chat is an empty new conversation
    expect(codexStartScreenUnused(ultra)).toBeTrue();
    expect(codexStartScreenUnused(ultra.replace("» Ask Codex to do anything", "» fix the\n  build"))).toBeTrue();
    // a conversation above the composer still says it is used
    expect(codexStartScreenUnused(ultra.replace("» Ask", "› hello\n\n• Hi! What should we work on?\n\n» Ask"))).toBeFalse();
  });

  it("reads nothing of a Codex screen without its header or its status line", () => {
    expect(startScreenMetadata("codex-transcript", "  GPT-6-Luna medium fast · /tmp/test-project")).toEqual({ model: null, reasoning_effort: null });
    expect(startScreenMetadata("codex-transcript", "  >_ OpenAI Codex (v0.162.1)\n  Trust this folder?\n› 1. Trust and continue")).toEqual({ model: null, reasoning_effort: null });
  });

  it("takes the model only from the live footer, never from a quoted picker, a draft or a popup", () => {
    const header = "  >_ OpenAI Codex (v0.162.1)";
    const quoted = CODEX.replace(header, `${header}\n• Run /model. You will see:\n  Select Model\n  1. gpt-evil (current)`);
    expect(startScreenMetadata("codex-transcript", quoted)).toEqual({ model: "gpt-6-luna", reasoning_effort: "medium" });
    const draft = CODEX.replace("› Ask Codex to do anything", "› note\n  Select Model\n  1. gpt-typed (current)");
    expect(startScreenMetadata("codex-transcript", draft)).toEqual({ model: "gpt-6-luna", reasoning_effort: "medium" });
    const picker = [header, "  Select Model and Effort", "› 1. GPT-6.1-Sol (default) (current)", "  2. GPT-6-Astra", "  Press enter to select · esc to go back"].join("\n");
    expect(startScreenMetadata("codex-transcript", picker)).toEqual({ model: null, reasoning_effort: null });
    expect(startScreenMetadata("codex-transcript", `${header}\n  GPT-6-Sol high · /tmp/project`)).toEqual({ model: null, reasoning_effort: null });
  });

  it("tells a Codex start screen with nothing said yet from one with a conversation", () => {
    const header = "  >_ OpenAI Codex (v0.162.1)";
    expect(codexStartScreenUnused(CODEX)).toBeTrue();
    // a draft in the composer is not a message
    expect(codexStartScreenUnused(CODEX.replace("\u203a Ask Codex to do anything", "\u203a fix the\n  build"))).toBeTrue();
    // a message sent, its answer, an error; or a resumed conversation shown under its header
    const said = (cells: string) => CODEX.replace("\u203a Ask Codex to do anything", `${cells}\n\n\u203a Ask Codex to do anything`);
    expect(codexStartScreenUnused(said("\u203a hello\n\n\u2022 Hi! What should we work on?"))).toBeFalse();
    expect(codexStartScreenUnused(said("\u203a hello"))).toBeFalse();
    expect(codexStartScreenUnused(said("\u25a0 stream disconnected before completion"))).toBeFalse();
    expect(codexStartScreenUnused(CODEX.replace(header, `${header}\n\u2022 Explored\n  \u2514 Read app.ts`))).toBeFalse();
    // no header, no footer, or a popup over the footer: nothing to tell by
    expect(codexStartScreenUnused(CODEX.replace(header, ""))).toBeFalse();
    expect(codexStartScreenUnused(CODEX.replace("  \u2190 for agents \u00b7 ? for shortcuts", ""))).toBeFalse();
    expect(codexStartScreenUnused([header, "  Select Model and Effort", "\u203a 1. GPT-6.1-Sol (default) (current)"].join("\n"))).toBeFalse();
    // a header drawn under a conversation (a command's card, a second session in the same terminal)
    expect(codexStartScreenUnused(`\u203a hello\n\n\u2022 Hi there\n\n${CODEX}`)).toBeFalse();
    // an answer that only mentions the banner is no header, with the real one scrolled away
    expect(codexStartScreenUnused(CODEX.replace(header, "  the tail of an answer\n\u2022 OpenAI Codex (v0.163.0)"))).toBeFalse();
    // the banner boxed, as some versions draw it
    expect(codexStartScreenUnused(CODEX.replace(header, "\u2502 >_ OpenAI Codex (v0.163.0) \u2502"))).toBeTrue();
  });

  it("tells an Agy start screen with nothing said yet from one with a conversation or an open panel", () => {
    expect(agyStartScreenUnused(AGY)).toBeTrue();
    // narrow layout with logo rows above the title and a multi-line draft in the composer
    const narrow = [
      "❯ agy",
      "       ▄▀▀▄",
      "      ▀▀▀▀▀▀",
      "   Antigravity CLI 1.4.4",
      "   user@example.test (Demo plan    )",
      "   Gemini 3.8 Flash (High)",
      "   /tmp/test-project",
      " ────────────────────────────────────────",
      " > fix the",
      "   build",
      " ────────────────────────────────────────",
      " ? for shortcuts   Gemini 3.8 Flash · high",
    ].join("\n");
    expect(agyStartScreenUnused(narrow)).toBeTrue();
    // a prompt, command, or assistant response above the composer
    const said = (cells: string) => AGY.replace(" ────────────────────────────────────────\n >", `${cells}\n\n ────────────────────────────────────────\n >`);
    expect(agyStartScreenUnused(said(" > hello\n\n ✦ Hi! How can I help?"))).toBeFalse();
    expect(agyStartScreenUnused(said(" > /model\n  ⎿   Exited /model command"))).toBeFalse();
    expect(agyStartScreenUnused(said(" ● Read(README.md)"))).toBeFalse();
    // a panel open under the composer (/model, /codesearch) or a missing header/footer
    expect(agyStartScreenUnused(`${AGY}\n Switch Model`)).toBeFalse();
    expect(agyStartScreenUnused(AGY.replace(" ? for shortcuts   Gemini 3.8 Flash · high", " Code Search:\n ? for shortcuts   Gemini 3.8 Flash · high"))).toBeFalse();
    expect(agyStartScreenUnused(AGY.replace("       ▄▀▀▄         Antigravity CLI 1.4.4", ""))).toBeFalse();
    expect(agyStartScreenUnused(` > hello\n\n ✦ Hi there\n\n${AGY}`)).toBeFalse();
  });

  it("reads gjc's status line, keeping a model it has no id for as gjc wrote it", () => {
    expect(startScreenMetadata("gjc-transcript", GJC)).toEqual({ model: "claude-opus-5-5", reasoning_effort: "xhigh" });
    expect(startScreenMetadata("gjc-transcript", GJC.replace("opus-5.5", "kimi-k3"))).toEqual({ model: "kimi-k3", reasoning_effort: "xhigh" });
  });

  it("reads Pi's model id and thinking level from its footer's stats row", () => {
    expect(startScreenMetadata("pi-transcript", PI)).toEqual({ model: "zorro-davidau-3.8-flash-next", reasoning_effort: "xhigh" });
    // several providers: Pi names the provider in front
    expect(startScreenMetadata("pi-transcript", PI.replace("zorro", "(openrouter) zorro"))).toEqual({ model: "zorro-davidau-3.8-flash-next", reasoning_effort: "xhigh" });
    expect(startScreenMetadata("pi-transcript", PI.replace("\u2022 xhigh", "\u2022 thinking off"))).toEqual({ model: "zorro-davidau-3.8-flash-next", reasoning_effort: "off" });
    // a model that does not reason states no level
    expect(startScreenMetadata("pi-transcript", PI.replace(" \u2022 xhigh", ""))).toEqual({ model: "zorro-davidau-3.8-flash-next", reasoning_effort: null });
    expect(startScreenMetadata("pi-transcript", PI.replace("0.0%/262k (auto)", "?/1.0M"))).toEqual({ model: "zorro-davidau-3.8-flash-next", reasoning_effort: "xhigh" });
  });

  it("names no Pi model without one, or from a line that is not its footer", () => {
    expect(startScreenMetadata("pi-transcript", PI.replace("zorro-davidau-3.8-flash-next \u2022 xhigh", "no-model"))).toEqual({ model: null, reasoning_effort: null });
    expect(startScreenMetadata("pi-transcript", "about 50% of the 262k window is used by model-x")).toEqual({ model: null, reasoning_effort: null });
    // a narrow pane: Pi cut the id down to two columns after the stats, so the whole id is unknown
    expect(startScreenMetadata("pi-transcript", "~\n0.0%/262k (auto)  claude-sonnet-4-5-2025")).toEqual({ model: null, reasoning_effort: null });
  });

  it("reads only the agents whose screen it knows", () => {
    expect(readsStartScreen("codex-transcript")).toBeTrue();
    expect(readsStartScreen("opencode-transcript")).toBeFalse();
    expect(startScreenMetadata("omo-transcript", CODEX)).toEqual({ model: null, reasoning_effort: null });
    expect(startScreenMetadata("claude-transcript", CODEX)).toEqual({ model: null, reasoning_effort: null });
  });
});

