import { expect, test } from "bun:test";
import fixture from "../fixtures/pi-questionnaire.json";
import { answerKeys, parseInteractivePrompt } from "../prompt.ts";
import { isPiQuestionnaireScreen, MAX_QUESTIONNAIRE_SCREEN_CHARS, parsePiQuestionnaire, piQuestionnaireInputMatches, piQuestionnaireOf } from "./pi-questionnaire.ts";
import { ANSI_RE, publicPrompt } from "./shared.ts";

const single = piQuestionnaireOf("single-call", fixture.single)!;
const multi = piQuestionnaireOf("multi-call", fixture.multi)!;
const read = (name: keyof typeof fixture.screens, source = single) => parsePiQuestionnaire(fixture.screens[name], source)!;

test("installed questionnaire reads exact renderer fixtures, hard wraps and descriptions", () => {
  for (const name of ["single", "single-narrow"] as const) {
    const parsed = read(name);
    expect(parsed.question).toBe(fixture.single.questions[0]!.prompt);
    expect(parsed.options).toEqual(fixture.single.questions[0]!.options.map(o => ({ label: o.label, description: o.description })));
    expect(parsed.custom_option_index).toBe(2);
    expect(parsed.selectedIndex).toBe(0);
  }
  expect(read("second").id).toBe(read("single").id);
  expect(read("second").selectedIndex).toBe(1);
  expect(read("other").selectedIndex).toBe(2);
});

test("allowOther false and custom-only questions preserve native cursor indices", () => {
  const noOther = piQuestionnaireOf("no-other", { questions: [{ ...fixture.single.questions[0], allowOther: false }] })!;
  const parsed = read("no-other", noOther);
  expect(parsed.customMenuIndex).toBeNull();
  expect(() => answerKeys(publicPrompt(parsed), { custom_text: "no" })).toThrow();
  const onlyOther = piQuestionnaireOf("custom", { questions: [{ id: "custom", prompt: "What should we call it?", options: [] }] })!;
  expect(read("only-other", onlyOther).options).toEqual([]);
  expect(read("only-other", onlyOther).custom_option_index).toBe(0);
});

test("input mode is explicit, tied to the same question and cannot be answered as a menu", () => {
  expect(read("input-empty").piQuestionnaireInput).toBe("");
  expect(read("input-text").piQuestionnaireInput).toBe("custom response");
  expect(read("input-text-narrow").piQuestionnaireInput).toBe("custom response");
  expect(read("input-empty").id).toBe(read("single").id);
  expect(() => answerKeys(publicPrompt(read("input-text")), { option_index: 0 })).toThrow();
  expect(parsePiQuestionnaire(fixture.screens["input-empty"].replace("Your answer:", "Another editor:"), single)).toBeNull();
});

test("multi-question tabs read actual active styles, not answered status or assumed progress", () => {
  for (const name of ["multi-first", "multi-first-narrow", "multi-second", "multi-second-answered", "back-second"] as const) {
    const parsed = read(name, multi);
    expect(parsed.piAskForm?.index).toBe(name.startsWith("multi-first") ? 0 : 1);
    expect(parsed.title).toBe(name.startsWith("multi-first") ? "Scope" : "Verification");
    expect(parsed.steps?.length).toBe(3);
    expect(parsePiQuestionnaire(fixture.screens[name].split("\n").map(line => `\x1b[0m${line}`).join("\n"), multi)?.piAskForm?.index)
      .toBe(parsed.piAskForm?.index);
  }
  expect(read("multi-second", multi).custom_option_index).toBeNull();
  expect(parsePiQuestionnaire(fixture.screens["multi-first"].replace(ANSI_RE, ""), multi)).toBeNull();
});

test("review has semantic summaries and incomplete forms can only cancel or navigate back", () => {
  for (const name of ["review-empty", "review-missing"] as const) {
    const parsed = read(name, multi);
    expect(parsed.options.map(o => o.label)).toEqual(["Cancel"]);
    expect(answerKeys(publicPrompt(parsed), { option_index: 0 })).toEqual([{ keys: ["esc"] }]);
    expect(parsed.steps?.[0]?.can_navigate).toBe(true);
    expect(() => answerKeys(publicPrompt(parsed), { option_index: 1 })).toThrow();
  }
  for (const name of ["review", "review-narrow"] as const) {
    const parsed = read(name, multi);
    expect(parsed.answers).toEqual([
      { question: "Scope", answer: "Small compatibility fix" },
      { question: "Verification", answer: "Focused tests" },
    ]);
    expect(answerKeys(publicPrompt(parsed), { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(publicPrompt(parsed), { option_index: 1 })).toEqual([{ keys: ["esc"] }]);
  }
  expect(parsePiQuestionnaire(fixture.screens.review.replace("Press Enter to submit", "Unanswered: Scope"), multi)).toBeNull();
});

test("incomplete, stale, conflicting, unrelated or unsafe drawings fail closed", () => {
  const screen = fixture.screens.single.replace(ANSI_RE, "");
  expect(parsePiQuestionnaire(screen)).toBeNull();
  for (const modified of [
    screen + "\n> composer", screen + "\n/home/fixture\n> 12.0%/200k", screen + "\nnew output", screen.replace("1. Small", "2. Small"),
    screen.replace("Reuse the existing", "Different description"), screen.replace("Which implementation", "Different prompt"),
    screen.replace("> 1.", "  1."), screen.replace("  2.", "> 2."),
    screen.split("\n").slice(1).join("\n"), screen.replace("3. Type something.", "3. Ordinary choice"),
  ]) expect(parsePiQuestionnaire(modified, single)).toBeNull();
  expect(parsePiQuestionnaire(screen + "\n/home/fixture\n12.0%/200k some-model", single)).not.toBeNull();
  expect(parsePiQuestionnaire(fixture.screens["multi-first"].replace(" Scope ", " Changed "), multi)).toBeNull();
  const source = { ...fixture.single, questions: [{ ...fixture.single.questions[0], prompt: "Other question" }] };
  expect(parsePiQuestionnaire(screen, piQuestionnaireOf("other", source)!)).toBeNull();
  expect(read("single", piQuestionnaireOf("new-call", fixture.single)!).id).not.toBe(read("single").id);
});

test("native source validation rejects ambiguous identifiers, tab labels and malformed options", () => {
  expect(piQuestionnaireOf("x", { questions: [] })).toBeNull();
  expect(piQuestionnaireOf("x", { questions: [fixture.single.questions[0], fixture.single.questions[0]] })).toBeNull();
  for (const patch of [{ id: "\u001b" }, { allowOther: "yes" }, { options: [{ label: "x" }] }, { options: [], allowOther: false }]) {
    expect(piQuestionnaireOf("x", { questions: [{ ...fixture.single.questions[0], ...patch }] })).toBeNull();
  }
});

test("custom draft verification preserves every word across narrow editor wraps", () => {
  const draft = "custom response with a longer sentence that wraps across multiple editor rows on a narrow pane";
  const parsed = read("input-long-narrow");
  expect(piQuestionnaireInputMatches(parsed, draft)).toBe(true);
  expect(piQuestionnaireInputMatches(parsed, draft.replace("response", "response changed"))).toBe(false);
  expect(piQuestionnaireInputMatches(parsed, draft.replace("custom response", "customresponse"))).toBe(false);
  expect(piQuestionnaireInputMatches(parsed, draft + " leftover")).toBe(false);
});

test("long tab labels, hard-wrapped CJK choices and custom summaries survive narrow review", () => {
  const source = piQuestionnaireOf("long-tabs", fixture.longTabs)!;
  expect(read("long-tabs-first", source).piAskForm?.index).toBe(0);
  expect(read("long-tabs-review", source).answers).toEqual(fixture.longTabs.questions.map(q => ({ question: q.label, answer: q.options[0]!.label })));
  expect(read("review-custom", multi).answers?.[0]).toEqual({ question: "Scope", answer: "(wrote) A custom scope" });
});

test("review distinguishes exact whitespace-colliding labels and refuses ambiguous wraps", () => {
  const source = piQuestionnaireOf("colliding", { questions: fixture.multi.questions.map((q, at) => at ? q : {
    ...q, options: [{ value: "spaced", label: "Save file" }, { value: "unspaced", label: "Savefile" }],
  }) })!;
  for (const label of ["Savefile", "Save file"]) {
    const screen = fixture.screens.review.replace("Small compatibility fix", label);
    expect(parsePiQuestionnaire(screen, source)?.answers?.[0]?.answer).toBe(label);
  }
  for (const label of ["Save\n file", "Sav\n efile"]) {
    expect(parsePiQuestionnaire(fixture.screens.review.replace("Small compatibility fix", label), source)).toBeNull();
  }
  const duplicate = { ...source, questions: source.questions.map((q, at) => at ? q : {
    ...q, options: [{ value: "first", label: "Savefile" }, { value: "second", label: "Savefile" }],
  }) };
  expect(parsePiQuestionnaire(fixture.screens.review.replace("Small compatibility fix", "Savefile"), duplicate)).toBeNull();
});

test("old questionnaire hints above a live native Pi menu do not suppress its card", () => {
  const menu = "────────────────────────\n Choose a color\n\n → Red\n   Blue\n\n ↑↓ navigate  enter select  escape/ctrl+c cancel";
  for (const old of [fixture.screens.single, fixture.screens["multi-first-narrow"], fixture.screens["input-empty"]]) {
    for (const footer of ["", "\n/home/fixture\n12.0%/200k some-model"]) {
      const screen = `${old}\n${menu}${footer}`;
      expect(isPiQuestionnaireScreen(screen)).toBe(false);
      const prompt = parseInteractivePrompt("pi", screen);
      expect(prompt?.question).toBe("Choose a color");
      expect(prompt?.options.map(option => option.label)).toEqual(["Red", "Blue"]);
    }
  }
});

test("active questionnaire hints remain reserved when the drawing is malformed or clipped", () => {
  for (const name of ["single-narrow", "multi-first-narrow", "input-empty", "review-narrow"] as const) {
    for (const footer of ["", "\n/home/fixture\n12.0%/200k some-model"]) {
      const screen = fixture.screens[name].split("\n").slice(1).join("\n") + footer;
      expect(isPiQuestionnaireScreen(screen)).toBe(true);
      expect(parseInteractivePrompt("pi", screen)).toBeNull();
    }
  }
  expect(isPiQuestionnaireScreen("↑↓ navigate • Enter select • Esc")).toBe(true);
  expect(isPiQuestionnaireScreen(fixture.screens.single + "\nUnrelated newer output")).toBe(false);
});

test("questionnaire parser rejects oversized adversarial input before reading source or scanning suffixes", () => {
  const padding = "malformed review summary\n".repeat(Math.ceil(MAX_QUESTIONNAIRE_SCREEN_CHARS / 24));
  const oversized = fixture.screens.review.replace("Press Enter to submit", padding);
  expect(oversized.length).toBeGreaterThan(MAX_QUESTIONNAIRE_SCREEN_CHARS);
  const unreadableSource = new Proxy(multi, { get() { throw new Error("oversized input must be rejected before reading the form"); } });
  expect(parsePiQuestionnaire(oversized, unreadableSource)).toBeNull();
  expect(isPiQuestionnaireScreen(oversized)).toBe(true);
  expect(parseInteractivePrompt("pi", oversized)).toBeNull();
  // Many short lines stay below the character cap but exceed the independent line budget.
  expect(parsePiQuestionnaire(fixture.screens.review.replace("Press Enter to submit", "x\n".repeat(600)), multi)).toBeNull();
  // Also exercise a missing caption inside both budgets: no growing suffix copies are needed.
  const bounded = fixture.screens.review.replace("Press Enter to submit", `${"x".repeat(80)}\n`.repeat(400));
  expect(bounded.length).toBeLessThan(MAX_QUESTIONNAIRE_SCREEN_CHARS);
  expect(parsePiQuestionnaire(bounded, multi)).toBeNull();
});

test("an extension's status line under pi's footer keeps the questionnaire's card", () => {
  const footer = "\n/home/fixture\n12.0%/200k some-model";
  const status = "\nworktree: main · usage 12%";
  const card = (prompt: ReturnType<typeof parsePiQuestionnaire>) => prompt && { id: prompt.id, question: prompt.question, options: prompt.options, selectedIndex: prompt.selectedIndex };
  for (const name of ["single", "single-narrow"] as const) {
    const screen = fixture.screens[name] + footer + status;
    expect(isPiQuestionnaireScreen(screen)).toBe(true);
    expect(card(parsePiQuestionnaire(screen, single))).toEqual(card(read(name)));
    // only directly under pi's footer, never a prompt in its place, and no more output after it
    expect(parsePiQuestionnaire(fixture.screens[name] + status, single)).toBeNull();
    for (const prompt of ["\n❯ a new message", "\nuser@host:~/app$"]) expect(parsePiQuestionnaire(fixture.screens[name] + footer + prompt, single)).toBeNull();
    expect(parsePiQuestionnaire(`${screen}\nSome later output`, single)).toBeNull();
  }
});
