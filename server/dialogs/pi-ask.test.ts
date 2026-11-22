import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { answerKeys, parseInteractivePrompt } from "../prompt.ts";
import fixtures from "../fixtures/pi-ask-2.13.9.json";

// Actual rpiv-ask-user-question 2.13.9 rendering in a fake Pi TUI, with fictional questions.
// Cursor APC sequences are removed as in pane.read.
const footer = "\n────────────────────────────────────────\nC:\\project (main)\n0.0%/215k (auto)                 some-model • medium\n";
const read = (name: keyof typeof fixtures) => parseInteractivePrompt("pi", fixtures[name] + footer);
const labels = ["允许结构化单元格", "只允许普通单值"];

describe("Pi rpiv ask questionnaires", () => {
  test("reads a real inline pane whose Pi footer follows the hint without another rule", () => {
    const screen = readFileSync(new URL("../fixtures/pi-ask-inline-pane.txt", import.meta.url), "utf8");
    const prompt = parseInteractivePrompt("pi", screen);
    expect(prompt).not.toBeNull();
    expect(prompt?.options.map(option => option.label)).toEqual(["看到中文选项", "仍只有按键"]);
    expect(parseInteractivePrompt("pi", screen + "another program's output")).toBeNull();
  });
  test("accepts an inline footer with thinking disabled", () => {
    const screen = readFileSync(new URL("../fixtures/pi-ask-thinking-off-pane.txt", import.meta.url), "utf8");
    const prompt = parseInteractivePrompt("pi", screen);
    expect(prompt).not.toBeNull();
    expect(prompt?.options.map(option => option.label)).toEqual(["看到中文选项", "仍只有按键"]);
    expect(prompt?.fallback).toBeUndefined();
  });

  test.each(["some-model • thinking off", "a-working-model • medium", "working-model • medium"])("treats model footer text as data: %s", model => {
    expect(parseInteractivePrompt("pi", fixtures.single + footer.replace("some-model • medium", model))?.id).toBe(read("single")!.id);
  });

  test("shows actual answers and descriptions instead of fallback keyboard controls", () => {
    const prompt = read("single")!;
    expect(prompt).not.toBeNull();
    expect(prompt.fallback).toBeUndefined();
    expect(prompt.question).toBe("结果表是否允许结构化单元格？");
    expect(prompt.title).toBe("单元格内容");
    expect(prompt.options.map(option => option.label)).toEqual(labels);
    expect(prompt.options[0]!.description).toBe("单元格可包含列表或对象。");
    expect(prompt.custom_option_index).toBe(2);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test.each(["single", "tabs-first", "multi"] as const)("keeps the complete multi-paragraph question in %s", name => {
    const question = "问题第一段？\n\n 第二段说明。\n 这是第二段的换行。\n\n 第三段说明。";
    const screen = fixtures[name].replace("结果表是否允许结构化单元格？", question) + footer;
    const prompt = parseInteractivePrompt("pi", screen);
    expect(prompt).not.toBeNull();
    expect(prompt?.question).toBe("问题第一段？ 第二段说明。 这是第二段的换行。 第三段说明。");
    expect(prompt?.title).toBe(name === "tabs-first" ? "" : "单元格内容");
    expect(prompt?.options.map(option => option.label)).toEqual(labels);
    const changed = parseInteractivePrompt("pi", screen.replace("第三段说明。", "另一段说明。"));
    expect(changed).not.toBeNull();
    expect(changed?.id).not.toBe(prompt?.id);
  });

  test("does not mistake a headerless question's first paragraph for a badge", () => {
    const screen = fixtures.single.replace(/^ {2}单元格内容[^\S\r\n]*\r?\n/m, "")
      .replace("结果表是否允许结构化单元格？", "问题第一段？\n\n 第二段说明。") + footer;
    const prompt = parseInteractivePrompt("pi", screen);
    expect(prompt).not.toBeNull();
    expect(prompt?.title).toBe("");
    expect(prompt?.question).toBe("问题第一段？ 第二段说明。");
  });

  test("uses the actual cursor and keeps identity stable during navigation", () => {
    const first = read("single")!;
    const second = read("single-second")!;
    expect(second).not.toBeNull();
    expect(second.id).toBe(first.id);
    expect(answerKeys(second, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
    expect(answerKeys(second, { option_index: 1 })).toEqual([{ keys: ["enter"] }]);
  });

  test("types into Other on focus, without the Enter that would prematurely submit it", () => {
    const prompt = read("single")!;
    const focused = read("single-custom-empty")!;
    expect(focused).not.toBeNull();
    expect(focused.id).toBe(prompt.id);
    expect(answerKeys(prompt, { custom_text: "my answer" })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["ctrl+u"] }, { text: "my answer" }, { keys: ["enter"] },
    ]);
    expect(answerKeys(read("single-custom-draft")!, { custom_text: "replacement" })).toEqual([
      { keys: ["ctrl+u"] }, { text: "replacement" }, { keys: ["enter"] },
    ]);
  });

  test("rejects every C0/DEL/C1 control in a typed answer before producing any input steps", () => {
    const prompt = read("single")!;
    const controls = [...Array.from({ length: 32 }, (_, code) => code), ...Array.from({ length: 33 }, (_, code) => code + 127)];
    for (const code of controls) {
      for (const text of [`first${String.fromCharCode(code)}second`, `${String.fromCharCode(code)}answer`, `answer${String.fromCharCode(code)}`]) {
        expect(() => answerKeys(prompt, { custom_text: text })).toThrow("control characters");
      }
    }
    expect(answerKeys(prompt, { custom_text: "中文 café 🙂" })).toContainEqual({ text: "中文 café 🙂" });
  });

  test("toggles multiple choices with Space and submits only on its separate Submit row", () => {
    const prompt = read("multi")!;
    expect(prompt).not.toBeNull();
    expect(prompt.multi_select).toBe(true);
    expect(prompt.options.map(option => option.label)).toEqual(labels);
    expect(prompt.custom_option_index).toBeNull();
    expect(answerKeys(prompt, { option_indices: [0, 1] })).toEqual([
      { keys: ["space"] }, { keys: ["down"] }, { keys: ["space"] },
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] },
    ]);
    expect(answerKeys(read("multi-checked")!, { option_indices: [1] })).toEqual([
      { keys: ["space"] }, { keys: ["down"] }, { keys: ["space"] },
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] },
    ]);
    // Terminal-owned custom drafts cannot be silently preserved, replaced, or submitted by a web multi-pick.
    expect(read("multi-custom-draft")).toBeNull();
    expect(read("multi-next")).toBeNull();
  });

  test("advances each question and exposes the explicit final review separately", () => {
    const first = read("tabs-first")!;
    const second = read("tabs-second")!;
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second.id).not.toBe(first.id);
    expect(first.question).toBe("结果表是否允许结构化单元格？");
    expect(second.question).toBe("结果使用哪种类型？");
    const review = read("review")!;
    expect(review).not.toBeNull();
    expect(review.body).toBeNull();
    expect(review.answers?.[0]?.answer).toBe("允许结构化单元格");
    expect(review.options.map(option => option.label)).toEqual(["Submit answers", "Cancel"]);
    expect(review.own_text).toEqual({ title: { key: "Review your answers" }, question: { key: "Submit these answers?" } });
    expect(review.id).toBe("ba1bee6d9951");
    expect(answerKeys(review, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(review, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(read("review-cancel")!, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
  });

  test("reads a clipped narrow hint but not an incomplete option list", () => {
    expect(read("narrow")?.options.map(option => option.label)).toEqual(labels);
    expect(read("overflow")).toBeNull();
    expect(read("notes")).toBeNull();
    expect(read("preview")).toBeNull();
  });

  test("rejects stale, quoted, malformed and other agents' copies", () => {
    const screen = fixtures.single;
    expect(parseInteractivePrompt("pi", screen + "\n❯ a new message")).toBeNull();
    expect(parseInteractivePrompt("pi", screen + footer + "\nworking")).toBeNull();
    expect(parseInteractivePrompt("pi", screen + footer + "\narbitrary later output")).toBeNull();
    expect(parseInteractivePrompt("pi", screen.split("\n").map(line => "> " + line).join("\n"))).toBeNull();
    expect(parseInteractivePrompt("pi", screen.replace("  2. 只允许", "  4. 只允许"))).toBeNull();
    expect(parseInteractivePrompt("pi", screen.replace("  2. 只允许", "❯ 2. 只允许"))).toBeNull();
    expect(parseInteractivePrompt("pi", screen.replace("  3. Type something.", ""))).toBeNull();
    expect(parseInteractivePrompt("codex", screen + footer)).toBeNull();
    expect(parseInteractivePrompt("pi", screen.replace("单元格可包含列表或对象。", "different description"))!.id).not.toBe(read("single")!.id);
  });

  test("ignores Pi footer counters, but binds the complete question including long text", () => {
    expect(parseInteractivePrompt("pi", fixtures.single + footer.replace("0.0%", "22.3%"))!.id).toBe(read("single")!.id);
    const prefix = "x".repeat(12_010);
    const one = parseInteractivePrompt("pi", fixtures.single.replace("结果表是否允许结构化单元格？", prefix + "a"))!;
    const two = parseInteractivePrompt("pi", fixtures.single.replace("结果表是否允许结构化单元格？", prefix + "b"))!;
    expect(one.id).not.toBe(two.id);
  });
});
