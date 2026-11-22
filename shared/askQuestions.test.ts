import { describe, expect, test } from "bun:test";

import { askedQuestions } from "./askQuestions.ts";

describe("a past question tool call", () => {
  test("reads omp's ask, with its recommended option by index", () => {
    expect(askedQuestions("ask", {
      i: "Picking the install path",
      questions: [{ id: "path", header: "Install path", question: "Which one should stay?", recommended: 1, options: [
        { label: "Homebrew only", description: "Drop the curl script section" },
        { label: "Both", description: "Keep both" },
      ] }],
    })).toEqual([{ header: "Install path", question: "Which one should stay?", multi: false, recommended: 1, options: [
      { label: "Homebrew only", description: "Drop the curl script section", preview: null },
      { label: "Both", description: "Keep both", preview: null },
    ] }]);
  });

  test("reads OmO's and Claude's multiSelect, a preview, and a question without options", () => {
    for (const tool of ["ask_user_question", "request_user_input", "AskUserQuestion"]) {
      expect(askedQuestions(tool, { questions: [
        { header: "Symptoms", question: "What goes wrong?", multiSelect: true, options: [{ label: "Layout", preview: "┌─┐" }, { label: "Answer", description: "" }] },
        { header: "Notes", question: "Anything else?" },
      ] })).toEqual([
        { header: "Symptoms", question: "What goes wrong?", multi: true, recommended: null, options: [
          { label: "Layout", description: null, preview: "┌─┐" },
          { label: "Answer", description: null, preview: null },
        ] },
        { header: "Notes", question: "Anything else?", multi: false, recommended: null, options: [] },
      ]);
    }
  });

  test("shows Copilot's recorded question and choices without offering an unverified answer path", () => {
    expect(askedQuestions("ask_user", { question: "Proceed?", choices: ["Yes", "No"], allowFreeform: true })).toEqual([{
      header: null, question: "Proceed?", multi: false, recommended: null, options: [
        { label: "Yes", description: null, preview: null }, { label: "No", description: null, preview: null },
      ],
    }]);
    expect(askedQuestions("ask_user", { question: "What next?" })?.[0]?.options).toEqual([]);
    for (const bad of [{ question: "" }, { question: "Proceed?", choices: [0] }, { question: "Proceed?", choices: [""] }]) {
      expect(askedQuestions("ask_user", bad)).toBeNull();
    }
  });

  test("reads agy's ask_question string options, (Recommended) prefix, and is_multi_select", () => {
    expect(askedQuestions("ask_question", { questions: [
      { question: "Which test runner?", options: ["(Recommended) Bun test", "Vitest"] },
      { question: "Which targets?", is_multi_select: true, options: ["Desktop", "Mobile"] },
    ] })).toEqual([
      { header: null, question: "Which test runner?", multi: false, recommended: 0, options: [
        { label: "Bun test", description: null, preview: null },
        { label: "Vitest", description: null, preview: null },
      ] },
      { header: null, question: "Which targets?", multi: true, recommended: null, options: [
        { label: "Desktop", description: null, preview: null },
        { label: "Mobile", description: null, preview: null },
      ] },
    ]);
    for (const bad of [{ questions: [{ question: "Q?", options: [""] }] }, { questions: [{ question: "Q?", options: ["(Recommended)   "] }] }]) {
      expect(askedQuestions("ask_question", bad)).toBeNull();
    }
  });

  test("ignores a recommendation that names no option", () => {
    for (const recommended of [2, -1, 0.5, "0"]) {
      expect(askedQuestions("ask", { questions: [{ question: "Q?", recommended, options: [{ label: "A" }, { label: "B" }] }] })?.[0]?.recommended).toBeNull();
    }
  });

  test("leaves other tools and shapes it does not know as their JSON", () => {
    expect(askedQuestions("Bash", { questions: [{ question: "Q?" }] })).toBeNull();
    for (const args of [null, "text", {}, { questions: [] }, { questions: "Q?" }, { questions: [null] }, { questions: [{ question: "" }] },
      { questions: [{ question: "Q?", header: 3 }] }, { questions: [{ question: "Q?", options: "A" }] },
      { questions: [{ question: "Q?", options: [{ label: "" }] }] }, { questions: [{ question: "Q?", options: [{ label: "A", description: 1 }] }] },
      { questions: [{ question: "Q?" }, { header: "no question" }] }]) {
      expect(askedQuestions("ask", args)).toBeNull();
    }
  });
});
