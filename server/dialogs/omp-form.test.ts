import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { answerKeys, parseInteractivePrompt } from "../prompt.ts";
import { ompFormPrompt } from "../omp-ask.ts";
import { formChoiceGroups } from "./omp-form-html.ts";
import { KEY, parsedByPublicPrompt } from "./shared.ts";
import type { InteractivePrompt } from "../../shared/protocol.ts";

// omp 19.1.0's Ask form (HtmlFormDialog), recorded in an isolated omp home with a fake model provider whose `ask`
// call carries an HTML form: radio, checkbox and dropdown groups, a number input, a textarea and a lone checkbox at 100
// columns; a narrower form with a wrapped question, an open dropdown and a required input at 60; the symbol presets
// at 80. The file name says the field under the cursor.
const form = (name: string): string => readFileSync(new URL(`../fixtures/omp-form-19.1.0-${name}.txt`, import.meta.url), "utf8");
const card = (name: string) => {
  const prompt = parseInteractivePrompt("omp", form(name));
  expect(prompt, name).not.toBeNull();
  return prompt!;
};
const keys = (name: string, answer: Parameters<typeof answerKeys>[1]): (string | undefined)[] =>
  answerKeys(card(name), answer).flatMap((step) => step.keys ?? [step.text]);
const PASTE = (text: string): string => `\u001b[200~${text}\u001b[201~`;

describe("omp 19 Ask form", () => {
  it("asks the field under the cursor, with the form's words before it", () => {
    const radio = card("radio-100");
    expect(radio).toMatchObject({
      kind: "question", title: "Question", question: "Q1 · Session store Where should sessions persist?",
      body: "Sessions live in memory and are lost on restart.", multi_select: false, custom_option_index: 2, default_option_index: 0,
      options: [{ label: "SQLite: one file, no new service", description: null }, { label: "Redis: shared across instances", description: null }],
    });
    expect(parsedByPublicPrompt.get(radio)?.responder).toBe("omp-form");
    // a wrapped label reads whole; the context above a scrolled form still reads
    expect(card("scrolled-60")).toMatchObject({
      question: "Transport Which route should carry the fictional session across a narrow terminal that wraps long lines?",
      options: [{ label: "Local socket that keeps the fictional session on this PC and wraps" }, { label: "Remote relay" }],
    });
  });

  it("reads each symbol preset", () => {
    expect(card("ascii-radio-80")).toMatchObject({ options: card("radio-100").options, default_option_index: 0, custom_option_index: 2 });
    expect(card("nerd-checkbox-80")).toMatchObject({ options: card("checkbox-100").options, default_option_indices: [0] });
    expect(card("ascii-number-80")).toMatchObject({ question: "Session lifetime (days)", default_custom_text: "30" });
  });

  it("lists the form's fields as steps while all of them show, and moves with Tab", () => {
    const radio = card("radio-100");
    expect(radio.steps?.map((step) => [step.label, step.answered, step.current])).toEqual([
      ["Q1 · Session store Where should sessions persist?", false, true], ["Q2 · Targets", true, false], ["Q3 · Region", true, false],
      ["Session lifetime (days)", true, false], ["Notes", false, false], ["Ship it today", false, false], ["Submit", false, false],
    ]);
    expect(radio).toMatchObject({ can_step_next: true });
    expect(radio.can_step_back).toBeUndefined();
    expect(parsedByPublicPrompt.get(radio)?.nativeSteps).toMatchObject({ index: 0, count: 7, next: KEY.tab, previous: KEY.backtab });
    expect(card("number-100").steps?.findIndex((step) => step.current)).toBe(3);
    // a form taller than its box hides fields: no steps to move by
    expect(card("scrolled-60").steps).toBeUndefined();
  });

  it("picks a radio option with Enter, which moves on, and types its Other answer", () => {
    expect(keys("radio-100", { option_index: 1 })).toEqual([KEY.down, KEY.enter]);
    expect(keys("radio-100", { custom_text: "MySQL 8" })).toEqual([KEY.down, KEY.down, "ctrl+k", "ctrl+u", PASTE("MySQL 8"), KEY.enter]);
    // typed into Other, the answer shows as the card's own text
    const typed = card("other-typed-100");
    expect(typed.default_custom_text).toBe("xyz");
    expect(typed.default_option_index).toBeUndefined();
  });

  it("ticks checkboxes with Space and leaves the group with Enter", () => {
    const checkbox = card("checkbox-100");
    expect(checkbox).toMatchObject({ title: "Multiple choice", question: "Q2 · Targets", multi_select: true, checks_with_text: true, custom_option_index: 3, default_option_indices: [0] });
    expect(keys("checkbox-100", { option_indices: [1, 2] })).toEqual([KEY.space, KEY.down, KEY.space, KEY.down, KEY.space, KEY.enter]);
    expect(keys("checkbox-100", { option_indices: [0], custom_text: "Watch" })).toEqual([KEY.down, KEY.down, KEY.down, "ctrl+k", "ctrl+u", PASTE("Watch"), KEY.enter]);
    expect(card("lone-100")).toMatchObject({ question: "Ship it today", multi_select: true, options: [{ label: "Ship it today" }], custom_option_index: null });
    expect(keys("lone-100", { option_indices: [0] })).toEqual([KEY.space, KEY.enter]);
    // Other holds text, so it is ticked: an answer without it empties the text, which unticks it (Space would type)
    expect(card("checkbox-other-100")).toMatchObject({ default_option_indices: [0], default_custom_text: "Watch" });
    expect(keys("checkbox-other-100", { option_indices: [1] })).toEqual([KEY.up, KEY.up, KEY.up, KEY.space, KEY.down, KEY.space, KEY.down, KEY.down, "ctrl+k", "ctrl+u", KEY.enter]);
  });

  it("keeps a dropdown's value with Enter or opens its list, whose card picks any option", () => {
    expect(card("dropdown-100")).toMatchObject({ question: "Q3 · Region", options: [{ label: "United States", description: "2/2" }, { label: "Show all choices" }] });
    expect(keys("dropdown-100", { option_index: 0 })).toEqual([KEY.enter]);
    expect(keys("dropdown-100", { option_index: 1 })).toEqual([KEY.space]);
    expect(card("dropdown-open-60")).toMatchObject({
      question: "Region", default_option_index: 0, options: [{ label: "Europe" }, { label: "United States" }, { label: "Asia Pacific" }],
    });
    expect(keys("dropdown-open-60", { option_index: 2 })).toEqual([KEY.down, KEY.down, KEY.enter]);
    // a label of wide characters takes two columns each, and a covered row's text shows past the list's border
    const wide = form("dropdown-open-60").replace("│ ❯ Europe        ✓ │  ", "│ ❯ 東京          ✓ │ x");
    expect(parseInteractivePrompt("omp", wide)?.options.map((option) => option.label)).toEqual(["東京", "United States", "Asia Pacific"]);
  });

  it("replaces a text field's value with the typed answer", () => {
    expect(card("number-100")).toMatchObject({ question: "Session lifetime (days)", body: "≥ 1", options: [{ label: "Type your answer" }], custom_option_index: 0, default_custom_text: "30" });
    expect(keys("number-100", { custom_text: "7\n" })).toEqual(["ctrl+k", "ctrl+u", PASTE("7"), KEY.enter]);
    // an input takes one line; a textarea keeps its lines, pasted so a newline is not omp's Enter
    expect(keys("required-60", { custom_text: "acme\nlabs" })).toEqual(["ctrl+k", "ctrl+u", PASTE("acme labs"), KEY.enter]);
    expect(keys("textarea-100", { custom_text: "line 1\r\nline 2" })).toEqual(["ctrl+k", "ctrl+u", PASTE("line 1\nline 2"), KEY.enter]);
    // the placeholder of an empty input is not its value
    expect(card("required-60").default_custom_text).toBeUndefined();
    expect(card("errors-60")).toMatchObject({ question: "Project name", body: "Required" });
  });

  it("reviews the answers on Submit and submits with Enter", () => {
    const submit = card("submit-60");
    expect(submit).toMatchObject({
      kind: "menu", title: "Review answers", question: "Submit these answers?", options: [{ label: "Submit" }],
      answers: [
        { question: "Which route should carry the fictional session across a narrow terminal that wraps long lines?", answer: "Other: MySQL…" },
        { question: "Targets", answer: null }, { question: "Region", answer: "United States" }, { question: "Project name", answer: "acme" },
      ],
    });
    expect(submit.steps?.at(-1)).toMatchObject({ label: "Submit", current: true });
    expect(submit.can_step_next).toBeUndefined();
    expect(keys("submit-60", { option_index: 0 })).toEqual([KEY.enter]);
    // at 46 columns (a phone's pane) the chosen Other pill is past the pane's edge: answered, its answer cut
    expect(card("submit-46").answers?.[0]).toEqual({ question: "Where should sessions persist?", answer: "…" });
  });

  it("answers only under the session's one open form call", () => {
    const radio = card("radio-100");
    const formCall = [{ id: "call-1", wait: true, args: { html: "<form></form>" } }];
    const bound = ompFormPrompt(radio, formCall, "/s.jsonl");
    if (!bound.prompt) throw new Error("Expected the complete radio card");
    expect(bound.unverified).toBeUndefined();
    expect(parsedByPublicPrompt.get(bound.prompt)?.ompCall).toBe(JSON.stringify(["/s.jsonl", "call-1"]));
    expect(bound.prompt.id).toBe(radio.id);
    // no call open, two of them, or one asked as 18.x questions: shown, but no key goes out
    expect(ompFormPrompt(radio, [], "/s.jsonl").unverified).toBe(true);
    expect(ompFormPrompt(radio, [...formCall, { ...formCall[0]!, id: "call-2" }], "/s.jsonl").unverified).toBe(true);
    expect(ompFormPrompt(radio, [{ id: "call-1", wait: true, args: { questions: [] } }], "/s.jsonl").unverified).toBe(true);
    // a pane whose runtime names no session proves no call: shown, but no key goes out
    expect(ompFormPrompt(radio, formCall, "").unverified).toBe(true);
  });

  it("reads no card while the form does not hold the keys, or once it is answered", () => {
    // an option's note editor has the keys
    expect(parseInteractivePrompt("omp", form("note-open-100"))).toBeNull();
    // the transcript's record of an answered form
    expect(parseInteractivePrompt("omp", form("settled-60"))).toBeNull();
    // more output under the form: it is not omp's live dialog
    expect(parseInteractivePrompt("omp", `${form("radio-100")}\n${"output\n".repeat(12)}`)).toBeNull();
  });
});

// omp 19.1.1 at 46 columns and 24 or 16 rows, as a phone's pane draws it: the box scrolls, and a choice group's long
// options run past its edges. `cut` is the form the agent asked with three radio groups (`.html`, its call's `html`),
// on Q2's first, second and Other rows; `cut-top` is one five-option group on its fourth row, with neither end shown.
const scrolledScreen = (name: string): string => readFileSync(new URL(`../fixtures/omp-form-19.1.1-${name}.txt`, import.meta.url), "utf8");
const scrolled = (name: string) => {
  const prompt = parseInteractivePrompt("omp", scrolledScreen(name));
  expect(prompt, name).not.toBeNull();
  return prompt!;
};
const html = (name: string): string => readFileSync(new URL(`../fixtures/omp-form-19.1.1-${name}.html`, import.meta.url), "utf8");
const bound = (prompt: InteractivePrompt, form: string): InteractivePrompt => {
  const { prompt: card } = ompFormPrompt(prompt, [{ id: "call-1", wait: true, args: { html: form } }], "/s.jsonl");
  if (!card) throw new Error("Expected a choice card");
  return card;
};
const pressed = (prompt: InteractivePrompt, answer: Parameters<typeof answerKeys>[1]): (string | undefined)[] =>
  answerKeys(prompt, answer).flatMap((step) => step.keys ?? [step.text]);
const SHIP = [
  "Implement, run the related tests, check it in the browser, commit, and push the branch to fork. No PR anywhere. Recommended because you said \"personal repo\".",
  "Do the same, then open a PR into tung-dnt/ovis main.",
  "Do the same, but commit locally only, with no push.",
] as const;

describe("omp 19 Ask form cut by a scrolled box", () => {
  it("says more options are in the terminal rather than offering the rows that show as the whole group", () => {
    const first = scrolled("cut-46");
    expect(first).toMatchObject({
      question: "Q2 · How far should I go?. More options are listed in the terminal.",
      options: [{ label: SHIP[0] }], custom_option_index: null, default_option_index: 0,
      own_text: { question: { key: "{question}. More options are listed in the terminal.", vars: { question: "Q2 · How far should I go?" } } },
    });
    expect(pressed(first, { option_index: 0 })).toEqual([KEY.enter]);
    // no caption above the rows that show: the group may go on above as well
    expect(scrolled("cut-top-46")).toMatchObject({
      question: "Choose an option. More options are listed in the terminal.",
      options: [{ label: "United States, where the fictional billing runs" }, { label: "Asia Pacific, nearest the fictional support desk" }, { label: "South America & the fictional archive \"cold\" tier" }],
      custom_option_index: null,
    });
    // Other is the group's last row: shown, nothing of the group is past the bottom
    const other = scrolled("cut-other-46");
    expect(other).toMatchObject({ question: "Q2 · How far should I go?", options: SHIP.map((label) => ({ label })), custom_option_index: 3 });
    expect(pressed(other, { custom_text: "later" })).toEqual(["ctrl+k", "ctrl+u", PASTE("later"), KEY.enter]);
  });

  it("makes a cut radio group whole from its call's HTML with a different id for the new option indexes", () => {
    const first = scrolled("cut-46");
    const whole = bound(first, html("cut"));
    expect(whole.id).not.toBe(first.id);
    expect(whole).toMatchObject({ question: "Q2 · How far should I go?", options: SHIP.map((label) => ({ label })), custom_option_index: 3, default_option_index: 0 });
    expect(whole.own_text?.question).toBeUndefined();
    expect(pressed(whole, { option_index: 2 })).toEqual([KEY.down, KEY.down, KEY.enter]);
    expect(pressed(whole, { custom_text: "later" })).toEqual([KEY.down, KEY.down, KEY.down, "ctrl+k", "ctrl+u", PASTE("later"), KEY.enter]);
    // on the second option, the third and Other past the bottom
    expect(pressed(bound(scrolled("cut-down-46"), html("cut")), { option_index: 0 })).toEqual([KEY.up, KEY.enter]);
    // past both edges: the shown rows are the group's second to fourth, the cursor on its fourth
    const top = bound(scrolled("cut-top-46"), html("cut-top"));
    expect(top).toMatchObject({ question: "Choose an option", custom_option_index: 5 });
    expect(top.options.map((option) => option.label)).toEqual([
      "Europe, close to most of the fictional team and its data", "United States, where the fictional billing runs",
      "Asia Pacific, nearest the fictional support desk", "South America & the fictional archive \"cold\" tier", "Africa, for the fictional disaster-recovery copy",
    ]);
    expect(pressed(top, { option_index: 0 })).toEqual([KEY.up, KEY.up, KEY.up, KEY.enter]);
  });

  it("leaves a bottom-clipped label to the terminal even if it exactly matches another group's option", () => {
    const screen = scrolledScreen("cut-46").split("\n").filter((row) => !row.includes('said "personal repo".')).join("\n");
    const prompt = parseInteractivePrompt("omp", screen);
    if (!prompt) throw new Error("Expected the fixture's visible Q2 rows to parse");
    const prefix = SHIP[0].replace(' said "personal repo".', "");
    const overlapping = html("cut").replace("No. Leave the running build as it is.", prefix);
    const live = ompFormPrompt(prompt, [{ id: "call-1", wait: true, args: { html: overlapping } }], "/s.jsonl");
    expect(live.prompt).toBeNull();
  });

  it("keeps the cut card when the call's HTML does not place the shown rows in exactly one group", () => {
    const first = scrolled("cut-46");
    // another form: no group holds the shown option
    expect(bound(first, html("cut-top")).options).toHaveLength(1);
    // two groups both start with it: which one shows is not known
    const twice = `${html("cut")}<form><fieldset><legend>Again</legend>${html("cut").match(/<label><input type="radio" name="ship"[\s\S]*?<\/fieldset>/u)![0]!.replaceAll("name=\"ship\"", "name=\"again\"")}</form>`;
    expect(bound(first, twice).options).toHaveLength(1);
    // a disabled option: how omp draws it is not measured
    expect(bound(first, html("cut").replace("value=\"local-only\"", "value=\"local-only\" disabled")).options).toHaveLength(1);
  });

  it("labels each option as omp does", () => {
    expect(formChoiceGroups([
      "<label for=\"a1\">Named by for</label><input type=\"radio\" name=\"a\" id=\"a1\">",
      "<input type=\"radio\" name=\"a\" aria-label=\"Named by aria\">",
      "<input type=\"radio\" name=\"a\" value=\"by-value\">",
      "<label><input type=\"radio\" name=\"b\"> A <img alt=\"pic\"> &amp; <code>code</code><select><option>not this</option></select></label>",
      "<label><input type=\"radio\" name=\"b\"> Other place</label>",
      "<label><input type=\"checkbox\" name=\"c\" disabled> Lone</label>",
    ].join(""))).toEqual([
      { multi: false, labels: ["Named by for", "Named by aria", "by-value"], disabled: false, other: true },
      { multi: false, labels: ["A pic & code", "Other place"], disabled: false, other: false },
      { multi: true, labels: ["Lone"], disabled: true, other: false },
    ]);
  });
});
