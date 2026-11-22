import { describe, expect, it } from "bun:test";

import type { InteractivePrompt } from "../../shared/protocol.ts";
import { setCurrentLanguage, translate } from "./i18n.ts";
import { CASE_FOLDING_DATA } from "./caseFolding.generated.ts";
import { CONFUSABLES_DATA } from "./confusables.generated.ts";
import { answerFromText, answerHint, answerRefusal, blocksStepNavigation, focusFollowsAnswer, needsConfirmation, pressOrigin, sendsChecksWithText, skeleton, type PressOrigin, type TypedAnswer } from "./promptAnswer.ts";

const prompt = (options: string[], custom: number | null, multi = false): InteractivePrompt => ({
  id: "p", agent: "claude", kind: "question", title: "Question", question: "?", body: null,
  options: options.map((label) => ({ label, description: null })), multi_select: multi, custom_option_index: custom,
});

describe("a multi-select's checks and typed answer", () => {
  it("go together where the server says so, and on OpenCode's native form from any server", () => {
    const multi = prompt(["Unit tests", "Browser QA", "Type your own answer"], 2, true);
    expect(sendsChecksWithText({ ...multi, agent: "pi", checks_with_text: true })).toBe(true);
    expect(sendsChecksWithText({ ...multi, agent: "opencode" })).toBe(true);
    // pi's own screen-read forms keep one answer per press
    expect(sendsChecksWithText({ ...multi, agent: "pi" })).toBe(false);
    expect(sendsChecksWithText({ ...multi, agent: "opencode", fallback: true })).toBe(false);
    expect(sendsChecksWithText({ ...prompt(["A", "B"], 1), agent: "pi", checks_with_text: true })).toBe(false);
  });

  it("never hold a step button back on a card that saves its edits as it moves", () => {
    const card = { ...prompt(["A", "B"], 1), agent: "pi", steps: [{ label: "One", answered: false, current: true }, { label: "Two", answered: true, current: false, can_navigate: true }] };
    // pi's own tabs drop edits that were not sent, so the button waits for them
    expect(blocksStepNavigation(card, new Set(), "typed")).toBe(true);
    expect(blocksStepNavigation({ ...card, drafts_saved: true }, new Set(), "typed")).toBe(false);
    // so do Claude Code's question tabs: a move with ←/→ leaves what the card alone holds
    expect(blocksStepNavigation({ ...card, agent: "claude" }, new Set(), "typed")).toBe(true);
  });
});

describe("answering a prompt from the chat", () => {
  it("keeps GJC's native numbers when Other precedes a numbered clarification choice", () => {
    const question = { ...prompt(["1. Read only", "2. Other (type your own)", "3. Ask about these choices", "Esc"], 1), agent: "gjc", kind: "menu" as const };
    const answer = answerFromText(question, "3");
    expect(answer).toEqual({ option_index: 2 });
    expect(needsConfirmation(question, answer!)).toBe(true);
    expect(answerFromText(question, "2")).toEqual({ custom_text: "2" });
    expect(answerFromText(question, "4")).toEqual({ option_index: 3 });
  });
  it("reads the agent's option numbers, labels and bound letters, else the typed reply", () => {
    const question = prompt(["LM-O (Recommended)", "YCB-V"], 2);
    expect(answerFromText(question, "2")).toEqual({ option_index: 1 });
    expect(answerFromText(question, " lm-o ")).toEqual({ option_index: 0 });
    expect(answerFromText(question, "LM-O (Recommended)")).toEqual({ option_index: 0 });
    expect(answerFromText(question, "3")).toEqual({ custom_text: "3" });
    expect(answerFromText(question, "use T-LESS instead")).toEqual({ custom_text: "use T-LESS instead" });
    expect(answerHint(question)).toBe("Type 1–2 or your own reply…");
  });

  it("takes a label the bridge wrote as the card shows it, in the reader's language or in English (#1482)", () => {
    const keys: InteractivePrompt = { ...prompt(["Yes (y)", "No (n)", "Enter", "Esc"], null), kind: "menu", own_text: { labels: { 0: { key: "Yes (y)" }, 1: { key: "No (n)" } } } };
    setCurrentLanguage("ko");
    try {
      expect(translate("ko", "No (n)")).not.toBe("No (n)");
      expect(answerFromText(keys, translate("ko", "No (n)"))).toEqual({ option_index: 1 });
      expect(answerFromText(keys, "No (n)")).toEqual({ option_index: 1 });
      expect(answerFromText(keys, "y")).toEqual({ option_index: 0 });
      const drawn: InteractivePrompt = { ...prompt(["Cancel", translate("ko", "Cancel")], null), kind: "menu", own_text: { labels: { 0: { key: "Cancel" } } } };
      expect(answerFromText(drawn, translate("ko", "Cancel"))).toEqual({ option_index: 1 });
      expect(answerFromText(drawn, "Cancel")).toEqual({ option_index: 0 });
    } finally {
      setCurrentLanguage("en");
    }
  });

  it("takes an omp option in Markdown by the words its card shows (#1644)", () => {
    const question = { ...prompt(["Use `local` socket", "Go through **[the relay](https://example.com)**"], 2), agent: "omp", text_format: "markdown" as const };
    expect(answerFromText(question, "use local socket")).toEqual({ option_index: 0 });
    expect(answerFromText(question, "Go through the relay")).toEqual({ option_index: 1 });
    expect(answerFromText(question, "use a local socket")).toEqual({ custom_text: "use a local socket" });
    const twins = { ...prompt(["*main*", "`*main*`"], 2), agent: "omp", text_format: "markdown" as const };
    expect(answerFromText(twins, "*main*")).toEqual({ custom_text: "*main*" });
    expect(answerFromText(twins, "main")).toEqual({ custom_text: "main" });
  });
  it("picks no option for words that name two of them, on any card (#2220 review)", () => {
    const globs = { ...prompt(["Keep *.log and *.tmp", "Keep .log and .tmp"], 2), agent: "omp", text_format: "markdown" as const };
    expect(answerFromText(globs, "Keep .log and .tmp")).toEqual({ custom_text: "Keep .log and .tmp" });
    expect(answerFromText(globs, "2")).toEqual({ option_index: 1 });
    const spaced = { ...prompt(["Keep **production**", "Keep  **production**"], 2), agent: "omp", text_format: "markdown" as const };
    expect(answerFromText(spaced, "Keep production")).toEqual({ custom_text: "Keep production" });
    const linked = { ...prompt(["Keep [production](recommended)", "Keep [production]"], 2), agent: "omp", text_format: "markdown" as const };
    expect(answerFromText(linked, "Keep production")).toEqual({ custom_text: "Keep production" });
    expect(answerFromText(linked, "Keep [production]")).toEqual({ custom_text: "Keep [production]" });
    const numeral = { ...prompt(["`2`", "Keep production"], 2), agent: "omp", text_format: "markdown" as const };
    expect(answerFromText(numeral, "2")).toEqual({ option_index: 0 });
    expect(answerFromText(numeral, "1")).toEqual({ option_index: 0 });
    const numerals = { ...prompt(["`2`", "**2**"], 2), agent: "omp", text_format: "markdown" as const };
    expect(answerFromText(numerals, "2")).toEqual({ custom_text: "2" });
    expect(answerFromText({ ...numeral, custom_option_index: null, options: numeral.options.slice(0, 2) }, "2")).toEqual({ option_index: 0 });
    expect(answerFromText(prompt(["1", "2"], null), "2")).toEqual({ option_index: 1 });
    const multiNumeral = { ...prompt(["`2`", "Keep production"], null, true), agent: "omp", text_format: "markdown" as const };
    expect(answerFromText(multiNumeral, "2")).toEqual({ option_indices: [0] });
    expect(answerFromText(multiNumeral, "1 2")).toBeNull();
    const multiNumerals = { ...prompt(["`2`", "**2**"], null, true), agent: "omp", text_format: "markdown" as const };
    expect(answerFromText(multiNumerals, "2")).toBeNull();
    expect(answerFromText({ ...multiNumeral, custom_option_index: 2, options: [...multiNumeral.options, { label: "Other", description: null }] }, "1 2")).toEqual({ custom_text: "1 2" });
    expect(answerFromText(prompt(["Desktop", "Phone", "Tablet"], null, true), "1 3")).toEqual({ option_indices: [0, 2] });
    expect(answerFromText(prompt(["1", "2"], null, true), "2")).toEqual({ option_indices: [1] });
    const alike = prompt(["Retry", "retry"], null);
    expect(answerFromText(alike, "retry")).toBeNull();
    expect(answerFromText(alike, "1")).toEqual({ option_index: 0 });
  });
  it("matches the whole typed text to the shown names first, and reads numbers only from text that names no row (#2220 review)", () => {
    type Case = [name: string, labels: string[], multi: boolean, other: boolean, typed: string, expected: TypedAnswer | null];
    const custom = (text: string): TypedAnswer => ({ custom_text: text });
    const cases: Case[] = [
      ["multi: `1 2` named whole", ["Keep production", "`1 2`"], true, false, "1 2", { option_indices: [1] }],
      ["multi: `1,2` named whole", ["Keep production", "`1,2`"], true, false, "1,2", { option_indices: [1] }],
      ["single: `2` named whole", ["`2`", "Keep production"], false, true, "2", { option_index: 0 }],
      ["single: a row's own number", ["1", "2"], false, false, "2", { option_index: 1 }],
      ["multi: a row's own number", ["1", "2"], true, false, "2", { option_indices: [1] }],
      ["multi: `1 2` beside **1 2**", ["`1 2`", "**1 2**"], true, false, "1 2", null],
      ["single: `2` beside **2**", ["`2`", "**2**"], false, true, "2", custom("2")],
      ["multi: `2` beside **2**", ["`2`", "**2**"], true, false, "2", null],
      ["single: spacing twins", ["Keep **production**", "Keep  **production**"], false, true, "Keep production", custom("Keep production")],
      ["single: case twins", ["Retry", "retry"], false, false, "retry", null],
      ["single: decomposed typed", ["Keep **cafe\u0301**", "Keep **caf\u00e9**"], false, true, "Keep cafe\u0301", custom("Keep cafe\u0301")],
      ["single: composed typed", ["Keep **cafe\u0301**", "Keep **caf\u00e9**"], false, true, "Keep caf\u00e9", custom("Keep caf\u00e9")],
      ["multi: decomposed typed", ["Keep **cafe\u0301**", "Keep **caf\u00e9**"], true, false, "Keep cafe\u0301", null],
      ["multi: composed typed", ["Keep **cafe\u0301**", "Keep **caf\u00e9**"], true, false, "Keep caf\u00e9", null],
      ...([["zero-width space", "pro\u200Bduction"], ["word joiner", "pro\u2060duction"], ["soft hyphen", "pro\u00ADduction"],
        ["combining grapheme joiner", "pro\u034Fduction"], ["variation selector-16", "pro\uFE0Fduction"]] as const).flatMap(([kind, word]): Case[] => [
        [`single: ${kind}`, [`Keep **${word}**`, "Keep **production**"], false, true, "Keep production", custom("Keep production")],
        [`multi: ${kind}`, [`Keep **${word}**`, "Keep **production**"], true, false, "Keep production", null],
      ]),
      ["single: a ligature", ["Keep **\uFB01le**", "Keep **file**"], false, true, "Keep file", custom("Keep file")],
      ["multi: a ligature", ["Keep **\uFB01le**", "Keep **file**"], true, false, "Keep \uFB01le", null],
      ["single: the other spelling of one row's name", ["Keep **caf\u00e9**", "Remote relay"], false, true, "keep cafe\u0301", { option_index: 0 }],
      ["multi: plain numbers", ["Desktop", "Phone", "Tablet"], true, false, "1 3", { option_indices: [0, 2] }],
      ["multi: numbers with a comma", ["Desktop", "Phone", "Tablet"], true, false, "1,3", { option_indices: [0, 2] }],
      ["multi: a number that is another row's name", ["`2`", "Keep production"], true, false, "1 2", null],
      ["single: a plain number", ["Desktop", "Phone"], false, true, "2", { option_index: 1 }],
      ["single: a number past the rows", ["Desktop", "Phone"], false, true, "5", custom("5")],
      ["single: a glob pair", ["Keep *.log and *.tmp", "Keep .log and .tmp"], false, true, "Keep .log and .tmp", custom("Keep .log and .tmp")],
      ["single: a link to `recommended`", ["Keep [production](recommended)", "Keep [production]"], false, true, "Keep [production]", custom("Keep [production]")],
      ["single: emphasis beside code", ["*main*", "`*main*`"], false, true, "*main*", custom("*main*")],
      ...([["a braille blank", "Keep **production**\u2800"], ["a DEL", "Keep **pro\u007Fduction**"], ["a full stop", "Keep **production**."]] as const).flatMap(([kind, label]): Case[] => [
        [`single: ${kind}`, [label, "Keep **production**"], false, true, "Keep production", custom("Keep production")],
        [`multi: ${kind}`, [label, "Keep **production**"], true, false, "Keep production", null],
      ]),
      ["single: a braille blank typed", ["Keep **production**\u2800", "Keep **production**"], false, true, "Keep production\u2800", custom("Keep production\u2800")],
      ["single: the number of a skeleton twin", ["Keep **production**\u2800", "Keep **production**", "Remote relay"], false, true, "1", { option_index: 0 }],
      ["single: the number of a distinct row beside twins", ["Keep **production**\u2800", "Keep **production**", "Remote relay"], false, true, "3", { option_index: 2 }],
      ["multi: numbers that take a skeleton twin", ["Keep **production**\u2800", "Keep **production**", "Remote relay"], true, false, "1 3", { option_indices: [0, 2] }],
      ["multi: numbers of distinct rows only", ["Keep **production**\u2800", "Keep **production**", "Remote relay"], true, false, "3", { option_indices: [2] }],
      ...([["ß and SS", "Keep **Straße**", "Keep **STRASSE**"], ["ẞ and ss", "Keep **STRAẞE**", "Keep **strasse**"], ["ς and σ", "Keep **οδος**", "Keep **οδοσ**"],
        ["ẞ and SS under an acute", "Keep **STRA\u1E9E\u0301E**", "Keep **STRASS\u0301E**"],
        ["ᾀ under an acute and ἄι", "Keep **\u1F80\u0301**", "Keep **\u1F04\u03B9**"], ["Ŀ and L under an acute", "Keep **\u013F\u0301**", "Keep **L\u0301**"]] as const).flatMap(([kind, a, b]): Case[] => {
        const rows = [a, b, "Remote relay"];
        const [typedA, typedB] = [a, b].map((label) => label.replaceAll("**", ""));
        return [
          [`single: ${kind}, the first name`, rows, false, true, typedA!, custom(typedA!)],
          [`single: ${kind}, the second name`, rows, false, true, typedB!, custom(typedB!)],
          [`single: ${kind}, by number`, rows, false, true, "2", { option_index: 1 }],
          [`multi: ${kind}, the first name`, rows, true, false, typedA!, null],
          [`multi: ${kind}, by number`, rows, true, false, "1", { option_indices: [0] }],
          [`multi: ${kind}, in a mixed list`, rows, true, false, "1 2", { option_indices: [0, 1] }],
          [`multi: ${kind}, a distinct row beside them`, rows, true, false, "3", { option_indices: [2] }],
        ];
      }),
      ...([["Cyrillic о", "Keep **pr\u043Eduction**", "Keep **production**"], ["Greek ο", "Keep **sc\u03BFpe**", "Keep **scope**"],
        ["Cyrillic capitals", "Keep **\u0420ROD**", "Keep **PROD**"], ["Cyrillic І beside a Latin I", "Keep **\u0406ndex**", "Keep **Index**"], ["a digit 0", "Keep **r00t**", "Keep **root**"]] as const).flatMap(([kind, a, b]): Case[] => {
        const rows = [a, b, "Remote relay"];
        const [typedA, typedB] = [a, b].map((label) => label.replaceAll("**", ""));
        return [
          [`single: ${kind}, the first name`, rows, false, true, typedA!, custom(typedA!)],
          [`single: ${kind}, the second name`, rows, false, true, typedB!, custom(typedB!)],
          [`single: ${kind}, by number`, rows, false, true, "1", { option_index: 0 }],
          [`multi: ${kind}, the second name`, rows, true, false, typedB!, null],
          [`multi: ${kind}, by numbers`, rows, true, false, "2 3", { option_indices: [1, 2] }],
        ];
      }),
      ["single: case twins with a capital I", ["Keep **Index.**", "Keep **index**"], false, true, "Keep index", custom("Keep index")],
      ["single: ß and SS twins with a capital I", ["Keep **Straße Index**", "Keep **STRASSE index**"], false, true, "Keep STRASSE index", custom("Keep STRASSE index")],
      ["multi: ß and SS twins with a capital I", ["Keep **Straße Index**", "Keep **STRASSE index**"], true, false, "Keep STRASSE index", null],
      ["no typed answer: case twins with punctuation", ["Keep API.", "Keep api!"], false, false, "Keep API.", null],
      ["single: a number beside rows that look like it", ["l", "\uFF4C"], false, false, "1", { option_index: 0 }],
      ["multi: numbers beside rows that look like them", ["I", "l"], true, false, "1 2", { option_indices: [0, 1] }],
      ["single: a number beside I and l", ["I", "l"], false, false, "1", { option_index: 0 }],
      ["single: a Cyrillic row beside Latin ones", ["Keep **\u043F\u0440\u043E\u0434**", "Keep **production**"], false, true, "Keep \u043F\u0440\u043E\u0434", { option_index: 0 }],
      ["multi: separators alone", ["Desktop", "Phone"], true, false, ",,,", null],
      ["multi: separators alone with a typed answer", ["Desktop", "Phone"], true, true, " , ,", custom(", ,")],
      ["single: ᾀ under an acute beside ἀι under an acute", ["Keep **\u1F80\u0301**", "Keep **\u1F00\u03B9\u0301**"], false, true, "Keep \u1F80\u0301", { option_index: 0 }],
      ["multi: words that read as two rows", ["Keep production.", "Keep production!"], true, false, "keep production", null],
      ["single: shown words, not raw Markdown", ["Use `local` socket", "Remote relay"], false, true, "use local socket", { option_index: 0 }],
    ];
    for (const [name, labels, multi, other, typed, expected] of cases) {
      const card: InteractivePrompt = {
        ...prompt(other ? [...labels, "Other"] : labels, other ? labels.length : null, multi), agent: "omp", text_format: "markdown",
      };
      expect(answerFromText(card, typed), name).toEqual(expected);
    }
  });
  it("gives every case-folded letter, alone or under marks, a skeleton that is its own skeleton (#2220 review)", () => {
    const letters = CASE_FOLDING_DATA.split(";").flatMap((entry) => entry.split("=")[0]!.split(" ").concat(entry.split("=")[1]!.split(" ")))
      .map((hex) => String.fromCodePoint(parseInt(hex, 16)));
    expect(letters.length).toBeGreaterThan(2000);
    const unstable = letters.flatMap((letter) => ["", "\u0301", "\u0345\u0301", "\u0301\u0345", "\u00B7\u0301", "\u0323\u0301"].map((marks) => letter + marks))
      .filter((text) => skeleton(skeleton(text)) !== skeleton(text));
    expect(unstable).toEqual([]);
  });
  it("gives every letter Unicode draws like a Latin letter or digit a skeleton that is its own skeleton, the Latin one's (#2233)", () => {
    const pairs = CONFUSABLES_DATA.split(";").map((entry) => entry.split("=").map((hex) => String.fromCodePoint(parseInt(hex, 16))) as [string, string]);
    expect(pairs.length).toBeGreaterThan(1000);
    expect(pairs.filter(([from]) => skeleton(skeleton(from)) !== skeleton(from)).map(([from]) => from)).toEqual([]);
    const folded = new Set(CASE_FOLDING_DATA.split(";").map((entry) => String.fromCodePoint(parseInt(entry.split("=")[0]!, 16))));
    const own = ([from]: [string, string]) => folded.has(from) || from.normalize("NFKD") !== from.normalize("NFD");
    expect(pairs.filter((pair) => own(pair) && skeleton(pair[0]) !== skeleton(pair[0].normalize("NFKD").toLowerCase())).map(([from]) => from)).toEqual([]);
    expect(pairs.filter((pair) => !own(pair) && skeleton(pair[0]) !== skeleton(pair[1])).map(([from]) => from)).toEqual([]);
  });
  it("gives a name and its case folding one skeleton (#2233 review)", () => {
    const pairs = CASE_FOLDING_DATA.split(";").map((entry) => entry.split("=").map((hex) => String.fromCodePoint(...hex.split(" ").map((code) => parseInt(code, 16)))) as [string, string]);
    expect(pairs.filter(([from, to]) => skeleton(from) !== skeleton(to)).map(([from]) => from)).toEqual([]);
  });
  it("answers a free-form question (Codex's queue) with the text itself, numbers included", () => {
    const freeForm = prompt([], 0);
    expect(answerFromText(freeForm, "1")).toEqual({ custom_text: "1" });
    expect(answerFromText(freeForm, "keep the logs")).toEqual({ custom_text: "keep the logs" });
    expect(answerHint(freeForm)).toBe("Type your reply…");
    expect(answerHint(prompt(["A", "B", "C"], null, true))).toBe("Type the numbers you choose, e.g. 1 3");
    expect(answerHint(prompt(["LM-O"], 1))).toBe("Type 1 or your own reply…");
  });

  it("takes only an option for an approval", () => {
    const approval = { ...prompt(["Yes, proceed (y)", "Yes, and don't ask again (p)", "No, and tell Codex what to do differently (esc)"], null), kind: "approval" as const };
    expect(answerFromText(approval, "y")).toEqual({ option_index: 0 });
    expect(answerFromText(approval, "P")).toEqual({ option_index: 1 });
    expect(answerFromText(approval, "no, and tell codex what to do differently")).toEqual({ option_index: 2 });
    expect(answerFromText(approval, "4")).toBeNull();
    expect(answerFromText(approval, "maybe later")).toBeNull();
    expect(answerHint(approval)).toBe("Type 1–3 to choose…");
    expect(answerRefusal(approval)).toBe("Choose one of the options above: type 1–3.");
    // typed, an approval's pick waits for Confirm; a question's does not
    expect(needsConfirmation(approval, { option_index: 0 })).toBe(true);
    expect(needsConfirmation(prompt(["LM-O"], 1), { option_index: 0 })).toBe(false);
    expect(needsConfirmation({ ...prompt(["Yes", "No", "Tell Claude what to change"], 2), kind: "plan" }, { custom_text: "shorter" })).toBe(false);
    // Claude's review submits every answer, a Codex menu continues or stops: a typed pick waits too
    expect(needsConfirmation({ ...prompt(["Submit answers", "Cancel"], null), kind: "menu" }, { option_index: 0 })).toBe(true);
  });

  it("skips a plan's custom row inside the options and reads several numbers for a multiple choice", () => {
    const plan = prompt(["Yes, auto-accept edits", "Yes, manually approve edits", "No", "Tell Claude what to change"], 3);
    expect(answerFromText(plan, "4")).toEqual({ custom_text: "4" });
    expect(answerFromText(plan, "keep the intro")).toEqual({ custom_text: "keep the intro" });
    const multi = prompt(["LM-O", "YCB-V", "T-LESS"], null, true);
    expect(answerFromText(multi, "1, 3")).toEqual({ option_indices: [0, 2] });
    expect(answerFromText(multi, "1 1 2")).toEqual({ option_indices: [0, 1] });
    expect(answerFromText(multi, "1 and 3")).toBeNull();
    const open = prompt(["Manzana", "Pera"], 2, true);
    expect(answerFromText(open, "1 2")).toEqual({ option_indices: [0, 1] });
    expect(answerFromText(open, "Kiwi")).toEqual({ custom_text: "Kiwi" });
  });
});

describe("pressOrigin", () => {
  it("takes the pointer a click names", () => {
    for (const pointerType of ["mouse", "touch", "pen"] as const) {
      expect(pressOrigin({ pointerType, detail: 1, keyed: false })).toBe(pointerType);
      expect(pressOrigin({ pointerType, detail: 1, keyed: true })).toBe(pointerType);
    }
  });

  it("takes the pointer that went down on the button, and a finger or a pen over a mouse", () => {
    for (const downType of ["mouse", "touch", "pen"] as const) expect(pressOrigin({ downType, detail: 1, keyed: false })).toBe(downType);
    // iOS Safari has called a tap's click a mouse's
    expect(pressOrigin({ downType: "touch", pointerType: "mouse", detail: 1, keyed: false })).toBe("touch");
    expect(pressOrigin({ downType: "pen", pointerType: "mouse", detail: 1, keyed: false })).toBe("pen");
    expect(pressOrigin({ downType: "mouse", pointerType: "touch", detail: 1, keyed: false })).toBe("touch");
    expect(pressOrigin({ downType: "mouse", pointerType: "mouse", detail: 1, keyed: false })).toBe("mouse");
  });

  it("calls a click a key only with no click count and its keydown on the button", () => {
    // Chromium and Firefox: a PointerEvent with an empty pointer type; Safari: a MouseEvent with none
    expect(pressOrigin({ pointerType: "", detail: 0, keyed: true })).toBe("keyboard");
    expect(pressOrigin({ detail: 0, keyed: true })).toBe("keyboard");
    // a script's click() or an assistive technology's activation: no key went down
    expect(pressOrigin({ pointerType: "", detail: 0, keyed: false })).toBe("unknown");
    expect(pressOrigin({ detail: 0, keyed: false })).toBe("unknown");
  });

  it("does not guess at a counted click that names no pointer", () => {
    expect(pressOrigin({ detail: 1, keyed: false })).toBe("unknown");
    expect(pressOrigin({ pointerType: "", detail: 1, keyed: true })).toBe("unknown");
    expect(pressOrigin({ keyed: true })).toBe("unknown");
  });

  it("reads Enter in the card's own field, which has no click, as a key", () => {
    expect(pressOrigin(undefined)).toBe("keyboard");
  });
});

describe("focusFollowsAnswer", () => {
  const still = { fromCard: true, origin: "mouse" as PressOrigin, coarse: false, cardMounted: true, inCard: false, onPage: true };

  it("hands the focus on when the pressed button lost it to the page, or still has it", () => {
    expect(focusFollowsAnswer(still)).toBe(true);
    expect(focusFollowsAnswer({ ...still, inCard: true, onPage: false })).toBe(true);
  });

  it("leaves the focus where the user put it while the answer was on its way", () => {
    expect(focusFollowsAnswer({ ...still, onPage: false })).toBe(false);
    expect(focusFollowsAnswer({ ...still, origin: "keyboard", coarse: true, onPage: false })).toBe(false);
  });

  it("does nothing for a card that is gone, or an answer that did not start in the card", () => {
    expect(focusFollowsAnswer({ ...still, cardMounted: false })).toBe(false);
    expect(focusFollowsAnswer({ ...still, fromCard: false })).toBe(false);
    expect(focusFollowsAnswer({ ...still, origin: "keyboard", coarse: true, cardMounted: false })).toBe(false);
    expect(focusFollowsAnswer({ ...still, origin: "keyboard", coarse: true, fromCard: false })).toBe(false);
  });

  // fine: a desktop, or a touch-screen laptop; coarse: a phone, or a tablet with a keyboard or a mouse
  const follows: Record<PressOrigin, { fine: boolean; coarse: boolean }> = {
    keyboard: { fine: true, coarse: true },
    mouse: { fine: true, coarse: true },
    touch: { fine: false, coarse: false },
    pen: { fine: false, coarse: false },
    unknown: { fine: true, coarse: false },
  };
  for (const [origin, expected] of Object.entries(follows) as [PressOrigin, { fine: boolean; coarse: boolean }][]) {
    it(`${expected.fine ? "hands the focus on" : "stays out of the message box"} after a ${origin} press on a fine pointer`, () => {
      expect(focusFollowsAnswer({ ...still, origin, coarse: false })).toBe(expected.fine);
    });
    it(`${expected.coarse ? "hands the focus on" : "stays out of the message box"} after a ${origin} press on a coarse pointer`, () => {
      expect(focusFollowsAnswer({ ...still, origin, coarse: true })).toBe(expected.coarse);
    });
  }
});

describe("moving between questions with the agent's own keys", () => {
  it("waits for the card's unsent edits on omo, omp, Codex and Hermes, whose keys carry none of them over", () => {
    const steps = [{ label: "One", answered: false, current: true }, { label: "Two", answered: false, current: false, can_navigate: true }];
    for (const agent of ["omo", "omp", "hermes"]) {
      const card = { ...prompt(["A", "B"], 2), agent, steps };
      expect(blocksStepNavigation(card, new Set(), "typed")).toBe(true);
      expect(blocksStepNavigation(card, new Set(), "")).toBe(false);
    }
    // Codex has Back and Next, no steps to tap
    const codex = { ...prompt(["A", "B"], 2), agent: "codex", can_step_next: true };
    expect(blocksStepNavigation(codex, new Set(), "typed")).toBe(true);
    // its last question has only Back, which drops them too
    expect(blocksStepNavigation({ ...codex, can_step_next: false, can_step_back: true }, new Set(), "typed")).toBe(true);
    expect(blocksStepNavigation({ ...codex, can_step_next: false }, new Set(), "typed")).toBe(false);
  });
});
