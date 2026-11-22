import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { answerKeys, parseInteractivePrompt } from "../prompt.ts";
import { lettaSearchShown } from "./letta.ts";
import { registry } from "./registry.ts";
import { KEY, parsedByPublicPrompt } from "./shared.ts";

// Screens of letta-code 0.34.31's /model, recorded with colour in a herdr pane 120 columns wide
// (local backend, Claude subscription providers for Anthropic and Amazon Bedrock).
const screen = (name: string) => readFileSync(new URL(`../fixtures/letta/${name}-0.34.31.txt`, import.meta.url), "utf8");
const card = (shown: string) => {
  const prompt = parseInteractivePrompt("letta", shown);
  return prompt && { question: prompt.question, options: prompt.options.map((option) => option.label) };
};

describe("Letta Code's /model", () => {
  it("offers the models the picker draws, the tabs beside the one shown, and a search", () => {
    // Recents is shown: → is Recommended, ← wraps to All models
    expect(card(screen("model-recents"))).toEqual({
      question: "Select model for this session",
      options: ["Claude Opus 5.5 · Anthropic", "Claude Sonnet 5.5 · Anthropic", "openai-codex/gpt-6.1-sol", "Claude Opus 5.5 · Amazon Bedrock", "Claude Sonnet 5.5 · Amazon Bedrock",
        "Show the Recommended [12] tab", "Show the All models [21] tab", "Search models", "Cancel"],
    });
    expect(card(screen("model-recommended"))).toMatchObject({
      question: "Select model for this session. 5 more models in this tab: search, or show another tab.",
      options: ["Claude Opus 5.5 · Anthropic", "Claude Sonnet 5.5 · Anthropic", "Claude Haiku 4.5 · Anthropic", "Claude Fable 5.1 · Anthropic",
        "Claude Opus 4.8 · Anthropic", "Claude Sonnet 4.6 · Anthropic", "Claude Opus 5.5 · Amazon Bedrock", "Show the All models [21] tab", "Show the Recents [5] tab", "Search models", "Cancel"],
    });
  });

  it("switches a tab with one key, and searches a key at a time", () => {
    const prompt = parseInteractivePrompt("letta", screen("model-recents"))!;
    expect(answerKeys(prompt, { option_index: 5 })).toEqual([{ keys: [KEY.right] }]);
    expect(answerKeys(prompt, { option_index: 6 })).toEqual([{ keys: [KEY.left] }]);
    expect(prompt.custom_option_index).toBe(7);
    expect(answerKeys(prompt, { custom_text: "son" })).toEqual([{ text: "s" }, { text: "o" }, { text: "n" }]);
    // with the search empty, `r` would refresh the list: its capital goes in, and Letta matches without case
    expect(answerKeys(prompt, { custom_text: "ri" })).toEqual([{ text: "R" }, { text: "i" }]);
    // Cancel is Esc, which closes the picker
    expect(answerKeys(prompt, { option_index: 8 })).toEqual([{ keys: [KEY.escape] }]);
  });

  it("picks a row with the arrows from the cursor, then Enter", () => {
    const shown = screen("model-recents-cursor");
    const prompt = parseInteractivePrompt("letta", shown)!;
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: [KEY.up] }, { keys: [KEY.up] }, { keys: [KEY.enter] }]);
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ keys: [KEY.enter] }]);
    expect(answerKeys(prompt, { option_index: 4 })).toEqual([{ keys: [KEY.down] }, { keys: [KEY.down] }, { keys: [KEY.enter] }]);
  });

  it("offers the reasoning level the next step shows, and leaves the others to the terminal", () => {
    const prompt = parseInteractivePrompt("letta", screen("effort"))!;
    expect(prompt.question).toBe("Select reasoning level for openai-codex/gpt-6.1-sol for this session (currently Medium). More levels are listed in the terminal.");
    expect(prompt.options.map((option) => option.label)).toEqual(["Medium", "Cancel"]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: [KEY.enter] }]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: [KEY.escape] }]);
  });

  it("refuses a search Letta would not type: control characters, and characters it drops", () => {
    const prompt = parseInteractivePrompt("letta", screen("model-recents"))!;
    // Letta's search takes one UTF-16 unit per key: an emoji never reaches it, and a cut one is a lone surrogate
    for (const text of ["son\rnet", "so\u001bhi", "a\u0000b", "a\u009fb", `${"a".repeat(39)}🙂`]) {
      expect(() => answerKeys(prompt, { custom_text: text }), JSON.stringify(text)).toThrow();
    }
  });

  it("answers a row only on the tab its card was read on", () => {
    const recents = screen("model-recents");
    const plan = registry.readerFor("letta-model")!.interaction!(parsedByPublicPrompt.get(parseInteractivePrompt("letta", recents)!)!)!;
    expect(plan.matches(recents)).toBe(true);
    expect(plan.matches(screen("model-recommended"))).toBe(false);
  });

  it("puts a capital R first whenever it goes into an emptied search", () => {
    const prompt = parseInteractivePrompt("letta", screen("model-recents").replace("(type to filter)", "old"))!;
    expect(answerKeys(prompt, { custom_text: "ri" })).toEqual([{ keys: [KEY.backspace] }, { keys: [KEY.backspace] }, { keys: [KEY.backspace] }, { text: "R" }, { text: "i" }]);
  });

  it("tells a card apart by its search", () => {
    const recents = screen("model-recents");
    expect(parseInteractivePrompt("letta", recents.replace("(type to filter)", "o"))!.id).not.toBe(parseInteractivePrompt("letta", recents)!.id);
  });

  it("keeps a card for a search that matches nothing: the tabs, another search, and Cancel", () => {
    // letta-code draws no footer under an empty list (ModelSelector.tsx), only its line saying so
    const shown = screen("model-recents").replace("(type to filter)", "xyz");
    const noMatch = `${shown.slice(0, shown.indexOf("Claude Opus 5.5 · Anthropic"))}`.replace(/\n[^\n]*$/, "") + "\n\u001b[2m  No models match your search.\u001b[0m\n";
    const prompt = parseInteractivePrompt("letta", noMatch)!;
    expect(prompt.options.map((option) => option.label)).toEqual(["Show the Recommended [12] tab", "Show the All models [21] tab", "Search models", "Cancel"]);
    expect(answerKeys(prompt, { custom_text: "son" })).toEqual([{ keys: [KEY.backspace] }, { keys: [KEY.backspace] }, { keys: [KEY.backspace] }, { text: "s" }, { text: "o" }, { text: "n" }]);
    expect(parseInteractivePrompt("letta", `${noMatch}\n› \n`)).toBeNull();
  });

  it("offers no row for the lines Letta draws above its rows while it refreshes", () => {
    const lines = screen("model-recents").replace("R to refresh list", "refreshing...").split("\n");
    // under the search line's blank, above the rows (ModelSelector.tsx)
    lines.splice(lines.findIndex((line) => line.includes("Search: ")) + 2, 0, "  Refreshing list...");
    const refreshing = lines.join("\n");
    expect(card(refreshing)?.options).not.toContain("Refreshing list...");
    expect(card(refreshing)?.options[0]).toBe("Claude Opus 5.5 · Anthropic");
  });

  it("refuses a search longer than Letta's search line takes, rather than cut it", () => {
    const prompt = parseInteractivePrompt("letta", screen("model-recents"))!;
    expect(answerKeys(prompt, { custom_text: "a".repeat(40) })).toHaveLength(40);
    expect(() => answerKeys(prompt, { custom_text: "a".repeat(41) })).toThrow();
  });

  it("lets a search go on only on its own tab, or the first one Letta moved to when the search emptied it", () => {
    const recents = screen("model-recents");
    const card = parsedByPublicPrompt.get(parseInteractivePrompt("letta", recents)!)!;
    const on = (bar: string, tab: string) => parsedByPublicPrompt.get(parseInteractivePrompt("letta",
      recents.replace("(type to filter)", "o").replace(/Recents \[5\].*All models \[21\]/, bar).replace("Models you've recently used", tab))!)!;
    const recommended = "Recommended models currently available for this account";
    const all = "All models currently available for this account";
    expect(lettaSearchShown(on("Recents [2]    Recommended [3]    All models [4]", "Models you've recently used"), card, "o")).toBe(true);
    expect(lettaSearchShown(on("Recents [2]    Recommended [3]    All models [4]", recommended), card, "o")).toBe(false);
    // Recents emptied: Letta moves to the first tab left, never another
    expect(lettaSearchShown(on("Recommended [3]    All models [4]", recommended), card, "o")).toBe(true);
    expect(lettaSearchShown(on("Recommended [3]    All models [4]", all), card, "o")).toBe(false);
    // a search matching nothing anywhere draws no tabs, and Letta stays on its tab
    const lines = recents.replace("(type to filter)", "o").replace("Models you've recently used", recommended).replace(/Recents \[5\].*All models \[21\]/, "").split("\n");
    const noMatch = [...lines.slice(0, lines.findIndex((line) => line.includes("Search: ")) + 1), "", "  No models match your search."].join("\n");
    expect(lettaSearchShown(parsedByPublicPrompt.get(parseInteractivePrompt("letta", noMatch)!)!, card, "o")).toBe(false);
  });

  it("offers no card on a tab it cannot name", () => {
    // free tier: both Letta API tabs are drawn with this one line under them
    expect(parseInteractivePrompt("letta", screen("model-recents").replace("Models you've recently used", "Upgrade your account to access more models"))).toBeNull();
  });

  it("reads no picker once output follows it, nor another agent's screen", () => {
    expect(parseInteractivePrompt("letta", `${screen("model-recents")}\n• Model switched\n`)).toBeNull();
    expect(parseInteractivePrompt("letta", `${screen("effort")}\n› \n`)).toBeNull();
    expect(parseInteractivePrompt("claude", screen("model-recents"))?.question ?? null).not.toBe("Select model for this session");
  });
});
