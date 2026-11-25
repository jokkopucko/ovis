import { describe, expect, it } from "bun:test";

import type { ConversationTurn, InteractivePrompt } from "../../shared/protocol.ts";
import { type Language, translate } from "./i18n.ts";
import { approvalScope, optionName, polledPrompt, promptWords, screenWordsToShow } from "./promptText.ts";

const inLanguage = (language: Language) => (key: string, vars?: Record<string, string | number>) => translate(language, key, vars);

const goal: InteractivePrompt = {
  id: "g", agent: "claude", kind: "menu", title: "Goal active", question: "the file hello.txt exists", body: "running 25s · 0 tokens",
  options: [{ label: "Close", description: null }], multi_select: false, custom_option_index: null,
  own_text: { title: { key: "Goal active" }, labels: { 0: { key: "Close" } } },
};

describe("a polled prompt card (#2220 review)", () => {
  const plain: InteractivePrompt = {
    id: "a", agent: "omp", kind: "question", title: "Question", question: "Which route should carry it? See the guide (https://example.com).", body: null,
    options: [{ label: "Use local socket", description: null }, { label: "Remote relay", description: null }], multi_select: false, custom_option_index: 2,
  };
  const markdown: InteractivePrompt = {
    ...plain, text_format: "markdown", question: "Which **route** should carry it? See [the guide](https://example.com).",
    options: [{ label: "Use `local` socket", description: null }, { label: "Remote relay", description: null }],
  };

  it("takes the agent's own Markdown that arrives for the same card, and lets it go again", () => {
    const upgraded = polledPrompt(plain, markdown);
    expect(upgraded).toMatchObject({ id: "a", text_format: "markdown", question: markdown.question, options: markdown.options });
    const fallen = polledPrompt(markdown, plain)!;
    expect(fallen.text_format).toBeUndefined();
    expect(fallen).toMatchObject({ question: plain.question, options: plain.options });
  });

  it("takes the body that goes with the words of the same card: gjc's whole question takes the rows its screen read put in the body", () => {
    const screen = { ...plain, agent: "gjc", question: "Which one?", body: "First paragraph.\n- item" };
    const rebound = { ...screen, question: "First paragraph.\n\n- item\n\nWhich one?", body: null, text_format: "markdown" as const };
    expect(polledPrompt(screen, rebound)).toMatchObject({ question: rebound.question, body: null, text_format: "markdown" });
    const fallen = polledPrompt(rebound, screen)!;
    expect(fallen).toMatchObject({ question: "Which one?", body: "First paragraph.\n- item" });
    expect(fallen.text_format).toBeUndefined();
  });

  it("uses the explicit recommended flag on Markdown options and keeps literal (Recommended) text untouched", () => {
    const card = {
      ...markdown,
      agent: "gjc",
      options: [
        { label: "Keep `local` socket", description: null, recommended: true as const },
        { label: "Literal (Recommended)", description: null },
      ],
    };
    expect(optionName(card, card.options[0]!)).toEqual({ text: "Keep `local` socket", recommended: true, words: "Keep local socket" });
    expect(optionName(card, card.options[1]!)).toEqual({ text: "Literal (Recommended)", recommended: false, words: "Literal (Recommended)" });
    expect(optionName(card, "[x](recommended)")).toMatchObject({ recommended: false, words: "x" });
    const ompCard = { ...markdown, agent: "omp", options: [{ label: "Use local socket (Recommended)", description: null }] };
    expect(optionName(ompCard, ompCard.options[0]!)).toEqual({ text: "Use local socket (Recommended)", recommended: false, words: "Use local socket (Recommended)" });
  });

  it("takes the words read off the screen over the same card as they change (#2088)", () => {
    const worded = polledPrompt(plain, { ...plain, screen_words: "There are two ways to fix it." })!;
    expect(worded.screen_words).toBe("There are two ways to fix it.");
    expect(polledPrompt(worded, plain)!.screen_words).toBeUndefined();
  });

  it("takes the preview Claude redraws as its cursor moves over the same card (#1212)", () => {
    const first = polledPrompt(plain, { ...plain, option_preview: { option_index: 0, text: "+--+" } })!;
    expect(first.option_preview).toEqual({ option_index: 0, text: "+--+" });
    const moved = polledPrompt(first, { ...plain, option_preview: { option_index: 1, text: "row 1", hidden_lines: 31 } })!;
    expect(moved.option_preview).toEqual({ option_index: 1, text: "row 1", hidden_lines: 31 });
    expect(polledPrompt(moved, plain)!.option_preview).toBeUndefined();
  });

  it("keeps the same object for a card that did not change, and gives another card as it is", () => {
    expect(polledPrompt(markdown, { ...markdown })).toBe(markdown);
    const other = { ...plain, id: "b" };
    expect(polledPrompt(markdown, other)).toBe(other);
    expect(polledPrompt(markdown, null)).toBeNull();
    expect(polledPrompt(null, plain)).toBe(plain);
  });
});

describe("a prompt card's words", () => {
  it("shows the bridge's own words in the reader's language, and the agent's as written (#1482)", () => {
    for (const language of ["ko", "ja", "zh"] as const) {
      const words = promptWords(goal, inLanguage(language));
      expect(words.title).toBe(translate(language, "Goal active"));
      expect(words.title).not.toBe("Goal active");
      expect(words.label(0)).toBe(translate(language, "Close"));
      expect(words.question).toBe("the file hello.txt exists");
      expect(words.body).toBe("running 25s · 0 tokens");
    }
  });

  it("translates a value that is the bridge's words too, and keeps the agent's value in it", () => {
    const model: InteractivePrompt = {
      ...goal, title: "", question: "Select model for this session (currently Opus). 2 more models are listed in the terminal.", body: null,
      own_text: { question: { key: "{question}. {count} more models are listed in the terminal.", vars: {
        question: { key: "Select model for this session (currently {model})", vars: { model: "Opus" } }, count: 2,
      } } },
    };
    const question = promptWords(model, inLanguage("ko")).question;
    expect(question).toBe(translate("ko", "{question}. {count} more models are listed in the terminal.", {
      question: translate("ko", "Select model for this session (currently {model})", { model: "Opus" }), count: 2,
    }));
    expect(question).toContain("Opus");
    expect(promptWords(model, inLanguage("en")).question).toBe(model.question);
  });

  it("caps a translated body as the bridge caps the English one", () => {
    const long: InteractivePrompt = { ...goal, body: "x".repeat(12_000), own_text: { body: { key: "Comment: {comment}", vars: { comment: "x".repeat(20_000) } } } };
    expect(promptWords(long, inLanguage("ko")).body).toHaveLength(12_000);
    const prefix = translate("ko", "Comment: {comment}", { comment: "" }).length;
    const split: InteractivePrompt = { ...long, own_text: { body: { key: "Comment: {comment}", vars: { comment: `${"x".repeat(11_999 - prefix)}\u{1F600}` } } } };
    const body = promptWords(split, inLanguage("ko")).body!;
    expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(body).toHaveLength(11_999);
  });

  it("shows an older bridge's card, which names no words of its own, as it came", () => {
    const { own_text: _, ...older } = goal;
    const words = promptWords(older, inLanguage("ko"));
    expect([words.title, words.label(0)]).toEqual(["Goal active", "Close"]);
  });

  it("strips both leading and trailing (Recommended) tags from plain option labels", () => {
    expect(optionName(goal, "(Recommended) Bun test")).toEqual({ text: "Bun test", recommended: true, words: "Bun test" });
    expect(optionName(goal, "Bun test (Recommended)")).toEqual({ text: "Bun test", recommended: true, words: "Bun test" });
    expect(optionName(goal, "Vitest")).toEqual({ text: "Vitest", recommended: false, words: "Vitest" });
  });
});

describe("Claude's words read off the screen over its question (#2088)", () => {
  const asked: InteractivePrompt = {
    id: "q", agent: "claude", kind: "question", title: "Fix", question: "Which fix do you want?", body: null,
    options: [{ label: "Patch", description: null }, { label: "Rewrite", description: null }], multi_select: false, custom_option_index: 2,
    screen_words: "There are two ways to fix it.",
  };
  const call = (state: "pending" | "ok", question = "Which fix do you want?", options = ["Patch", "Rewrite"], header = "Fix"): ConversationTurn => ({
    role: "assistant", ts: null,
    parts: [{ kind: "text", text: "There are two ways to fix it." }, {
      kind: "tool", name: "AskUserQuestion", summary: "", output: "", call_id: "toolu_1", state,
      input: JSON.stringify({ questions: [{ question, header, options: options.map((label) => ({ label })) }] }, null, 2),
    }],
  });
  const asking: ConversationTurn = { role: "user", ts: null, parts: [{ kind: "text", text: "fix a.txt" }] };

  it("shows them while the transcript has nothing of the turn (Claude Code 2.1.311)", () => {
    expect(screenWordsToShow(asked, [asking])).toBe("There are two ways to fix it.");
    expect(screenWordsToShow(asked, [])).toBe("There are two ways to fix it.");
  });

  it("leaves them to the chat once the transcript holds the question's call, still waiting", () => {
    expect(screenWordsToShow(asked, [asking, call("pending")])).toBeNull();
  });

  it("shows them while the waiting call in the transcript asks another question", () => {
    expect(screenWordsToShow(asked, [asking, call("pending", "Which color?")])).toBe("There are two ways to fix it.");
    expect(screenWordsToShow(asked, [asking, { ...call("pending"), parts: [{ kind: "tool", name: "AskUserQuestion", summary: "", input: "not json", output: "", state: "pending" }] }])).toBe("There are two ways to fix it.");
  });

  it("shows them while the same question asked in an earlier, interrupted turn still waits there", () => {
    expect(screenWordsToShow(asked, [asking, call("pending"), asking])).toBe("There are two ways to fix it.");
  });

  it("shows them while the waiting call asks the same words with other options or another header", () => {
    expect(screenWordsToShow(asked, [asking, call("pending", "Which fix do you want?", ["Patch", "Revert"])])).toBe("There are two ways to fix it.");
    expect(screenWordsToShow(asked, [asking, call("pending", "Which fix do you want?", ["Patch", "Rewrite"], "Scope")])).toBe("There are two ways to fix it.");
  });

  it("matches a form's question under its header and place", () => {
    expect(screenWordsToShow({ ...asked, title: "Fix · 1 of 2" }, [asking, call("pending")])).toBeNull();
  });

  it("shows them over an earlier question answered in the transcript", () => {
    expect(screenWordsToShow(asked, [asking, call("ok")])).toBe("There are two ways to fix it.");
  });

  it("shows nothing for a card without them", () => {
    const { screen_words: _, ...plain } = asked;
    expect(screenWordsToShow(plain, [asking])).toBeNull();
  });
});

describe("what an approval option grants, read off its own words (G-071)", () => {
  const approval = (agent: string, ...labels: string[]): InteractivePrompt => ({
    id: "p", agent, kind: "approval", title: "Allow command?", question: "Allow command?", body: "git push",
    options: labels.map((label) => ({ label, description: null })), multi_select: false, custom_option_index: null,
  });
  const scopes = (prompt: InteractivePrompt) => prompt.options.map((_, index) => approvalScope(prompt, index));

  it("reads Codex's, Claude's and pi's menus as they are drawn", () => {
    expect(scopes(approval("codex", "Yes", "Yes, and don't ask again for git push", "No, and tell Codex what to do differently"))).toEqual(["once", "always", "deny"]);
    expect(scopes(approval("codex", "Yes, proceed (y)", "Yes, and don't ask again for commands that start with curl", "No, and tell Codex what to do differently (esc)"))).toEqual(["once", "always", "deny"]);
    expect(scopes(approval("claude", "Yes", "Yes, allow all edits this session [shift+tab]", "No, and tell Claude what to do differently (esc)"))).toEqual(["once", "always", "deny"]);
    expect(scopes(approval("claude", "Yes", "Yes, don't ask again for `printf` commands in this project", "No"))).toEqual(["once", "always", "deny"]);
    expect(scopes(approval("pi", "Allow once", "Always allow", "Block"))).toEqual(["once", "always", "deny"]);
  });

  it("states no scope a label does not: a lone Yes, other wording, another kind of card", () => {
    expect(scopes(approval("codex", "Yes, proceed (y)", "No, and tell Codex what to do differently (esc)"))).toEqual([null, "deny"]);
    expect(scopes(approval("gemini", "Yes, allow once", "Yes, allow always", "Modify with external editor", "No, suggest changes (esc)"))).toEqual(["once", "always", null, "deny"]);
    expect(scopes(approval("codex", "Yes, and run it in the sandbox", "Yes, and don't ask again", "Abort"))).toEqual([null, "always", null]);
    expect(scopes({ ...approval("claude", "Yes", "Yes, allow all edits this session", "No"), kind: "question" })).toEqual([null, null, null]);
  });
});
