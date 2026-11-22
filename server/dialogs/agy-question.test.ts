import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { answerKeys, parseInteractivePrompt } from "../prompt.ts";
import { finishPrompt, publicPrompt } from "./shared.ts";
import { agyWriteInWaits } from "./agy.ts";

// Antigravity 1.5.6's ask_question, one question asked alone, as it drew it at 120 columns: its hint names Enter "Select"
const screen = readFileSync(new URL("../fixtures/agy-1.5.6-ask.txt", import.meta.url), "utf8");

test("reads Antigravity 1.5.6's single question, whose hint names Enter Select", () => {
  const prompt = parseInteractivePrompt("agy", screen)!;
  expect(prompt.question).toBe("Which file would you like to create?");
  expect(prompt.options.map((option) => option.label)).toEqual(["(Recommended) hello.txt", "bye.txt"]);
  expect(prompt.custom_option_index).toBe(2);
  expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
});

// A question Antigravity left on the screen when it exited, a shell's prompt under it: its keys would go to the shell
test.each(["agy-1.5.6-ask", "agy-1.5.6-ask-multi"])("reads no question once other output stands under %s's key hint", (name) => {
  const recorded = readFileSync(new URL(`../fixtures/${name}.txt`, import.meta.url), "utf8");
  expect(parseInteractivePrompt("agy", recorded)).not.toBeNull();
  expect(parseInteractivePrompt("agy", `${recorded.replace(/\s+$/, "")}\nuser@host:~$ echo pending\n`)).toBeNull();
  // Antigravity's own status row is the one row its screens keep there
  expect(recorded.replace(/\s+$/, "").split("\n").at(-1)).toMatch(/^esc to cancel\b/);
});

test("takes the write-in field for open only while it ends the screen", () => {
  const editor = "Question 1/1: Which environment?\n\n  1. Staging\n▸ 2. Write-in...\n\n  Your answer:\n  > \n\nenter Submit · esc Back\n";
  expect(agyWriteInWaits(editor)).toBe(true);
  expect(agyWriteInWaits(`${editor}user@host:~$ echo pending\n`)).toBe(false);
});

test("does not read the folder-trust picker as a question", () => {
  expect(parseInteractivePrompt("agy", readFileSync(new URL("../fixtures/agy-1.5.6-trust.txt", import.meta.url), "utf8"))).toBeNull();
});

test("ticks rows and types a write-in in one answer on Antigravity 1.5.6's multiple choice", () => {
  const prompt = parseInteractivePrompt("agy", readFileSync(new URL("../fixtures/agy-1.5.6-ask-multi.txt", import.meta.url), "utf8"))!;
  expect(prompt.multi_select).toBe(true);
  expect(prompt.checks_with_text).toBe(true);
  expect(prompt.options.map((option) => option.label)).toEqual(["(Recommended) Desktop", "Mobile", "Web"]);
  // Mobile ticked, then down to Write-in..., Enter opens its field, the text, Enter submits (sent to Antigravity 1.5.6: it answered "Mobile, TV")
  expect(answerKeys(prompt, { option_indices: [1], custom_text: "TV" })).toEqual([...["down", "space", "down", "down", "enter"].map((key) => ({ keys: [key] })), { text: "TV" }, { keys: ["enter"] }]);
});

test("gives a multiple choice a new card when its ticks change in the terminal", () => {
  const multi = readFileSync(new URL("../fixtures/agy-1.5.6-ask-multi.txt", import.meta.url), "utf8");
  const desktop = parseInteractivePrompt("agy", multi.replace("[ ] (Recommended) Desktop", "[x] (Recommended) Desktop"))!;
  const mobile = parseInteractivePrompt("agy", multi.replace("[ ] Mobile", "[x] Mobile"))!;
  expect(desktop.default_option_indices).toEqual([0]);
  expect(mobile.default_option_indices).toEqual([1]);
  // a card already shown with the first ticks would otherwise stay, and its answer would undo the terminal's
  expect(mobile.id).not.toBe(desktop.id);
});

test("refuses ticks with typed text for a card whose own steps cannot take both", () => {
  const parsed = finishPrompt("pi", { kind: "question", title: "Question", question: "Which?", body: null, options: [{ label: "A", description: null }, { label: "B", description: null }], multi_select: true, checks_with_text: true, custom_option_index: 2 },
    { responder: "pi-ask-question", menuLabels: ["A", "B", "Other"], selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: 2, rejectWithEscapeIndex: null });
  expect(() => answerKeys(publicPrompt(parsed), { option_indices: [0], custom_text: "C" })).toThrow("This prompt does not take ticks and typed text together.");
});
