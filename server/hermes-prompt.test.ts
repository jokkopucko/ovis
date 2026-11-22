import { describe, expect, it } from "bun:test";
import { answerKeys, parseInteractivePrompt } from "./prompt.ts";

// screens as Hermes 0.x's Ink TUI draws its clarify question, read off a live herdr pane
const STATUS = " ─ (⌐■_■) deliberating…  · 10s │ opus 5.5 │ 39.9k/500k │ [█░░░░░░░░░] 8%";
const HINT = " 0/1 answered · ↑/↓ select · Enter confirm and continue · Tab/Shift+Tab switch question · Esc/Ctrl+C cancel";
const choice = [
  "   └─ ● Clarify(\"Pick a colour for the test card\") (3.0s)",
  " ask 1 question",
  " ▸ Pick a colour for the test card",
  "   ▸ 1. Red (Recommended)",
  "     2. Blue",
  "     3. Other (type your answer)",
  HINT,
  STATUS,
].join("\n");

describe("hermes clarify", () => {
  it("reads choices and answers by moving the cursor", () => {
    const prompt = parseInteractivePrompt("hermes", choice)!;
    expect(prompt.question).toBe("Pick a colour for the test card");
    expect(prompt.options.map((option) => option.label)).toEqual(["Red", "Blue"]);
    expect(prompt.custom_option_index).toBe(2);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt, { custom_text: "Green" })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }, { keys: ["ctrl+k"] }, { keys: ["ctrl+u"] }, { text: "Green" }, { keys: ["enter"] }]);
  });

  it("reads an open question in a batch as a typed answer", () => {
    const screen = [
      " ask 2 questions",
      " ✓ Pick a colour",
      "   Red",
      " ▸ Name one fruit that grows on",
      " trees",
      "   > ",
      HINT.replace("0/1", "1/2"),
      STATUS,
    ].join("\n");
    const prompt = parseInteractivePrompt("hermes", screen)!;
    expect(prompt.question).toBe("Name one fruit that grows on trees");
    expect(prompt.body).toBe("1/2 answered");
    // what is already on the `>` line goes first, or the answer would join it
    expect(answerKeys(prompt, { custom_text: "Apple" })).toEqual([{ keys: ["ctrl+k"] }, { keys: ["ctrl+u"] }, { text: "Apple" }, { keys: ["enter"] }]);
  });

  it("drops the card once the question is answered", () => {
    expect(parseInteractivePrompt("hermes", `${choice}\n ❯ Pick a colour → Red\n ┊ Red\n x\n y\n z`)).toBeNull();
  });

  it("ticks a multi-select question's rows with Space and locks them with Enter", () => {
    const multi = choice.replace("▸ 1. Red", "▸ [ ] 1. Red").replace("  2. Blue", "  [x] 2. Blue").replace("0/1 answered · ", "0/1 answered · Space toggle · ");
    const prompt = parseInteractivePrompt("hermes", multi)!;
    expect(prompt.multi_select).toBe(true);
    expect(prompt.custom_option_index).toBeNull();
    expect(prompt.options.map((option) => option.label)).toEqual(["Red", "Blue"]);
    expect(answerKeys(prompt, { option_indices: [0, 1] })).toEqual([{ keys: ["space"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_indices: [0] })).toEqual([{ keys: ["space"] }, { keys: ["down"] }, { keys: ["space"] }, { keys: ["enter"] }]);
    // the cursor on Other: back up to a choice, since Enter there opens the text line
    const onOther = multi.replace("▸ [ ] 1. Red", "  [ ] 1. Red").replace("  3. Other", "▸ 3. Other");
    expect(answerKeys(parseInteractivePrompt("hermes", onOther)!, { option_indices: [1] })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
  });
});
