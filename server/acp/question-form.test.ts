import { expect, it } from "bun:test";
import { questionForm } from "./question-form.ts";

// Minimal fields from the native v1 probes. The labels and wire values are not interchangeable.
const color = "Red or blue?";
const choice = (value: string) => ({ const: value, title: "Blue" });
const select = (value: string) => ({ type: "string", oneOf: [choice(value)] });
const form = (properties: object) => ({ mode: "form", toolCallId: "tool-1", message: color, requestedSchema: { type: "object", properties } });

it.each([
  ["claude", form({ question_0: select("Blue"), question_0_custom: { type: "string" } }), "Blue"],
  ["agy", form({ q1: { ...select("2"), title: color }, q1_other: { type: "string" } }), "2"],
  ["gjc", { ...form({ value: select("option:0") }), toolCallId: undefined }, "option:0"],
  ["codex", { ...form({ color: { ...select("Blue"), title: color, _meta: { codex: { isSecret: false, isOther: false } } } }), _meta: { codex: { autoResolutionMs: null } } }, "Blue"],
] as const)("keeps the %s question's wire value behind its display label", (harness, request, value) => {
  expect(questionForm(harness, request)).toMatchObject({ audience: harness === "gjc" ? "person" : "parent", fields: [{ prompt: color, choices: [{ label: "Blue", value }] }] });
});

it("does not expose Codex secret input even in an otherwise supported free-text field", () => {
  const input = (isSecret: boolean) => ({ ...form({ secret: { type: "string", title: "Your reply", _meta: { codex: { isSecret, isOther: false } } } }), _meta: { codex: { autoResolutionMs: null } } });
  expect(questionForm("codex", input(false))?.audience).toBe("parent");
  expect(questionForm("codex", input(true))).toBeNull();
});

it("presents OpenCode fields in numerical order after the keeper sorts object keys", () => {
  const keys = Array.from({ length: 11 }, (_, n) => `q${n}`);
  const properties = Object.fromEntries([...keys].sort().map(key => [key, { ...select(key), description: key }]));
  expect(questionForm("opencode", form(properties))?.fields.map(f => f.prompt)).toEqual(keys);
});

it("keeps GJC's free-text follow-up with the person who chose Other", () => {
  const request = { mode: "form", message: "What color?", requestedSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
  expect(questionForm("gjc", request)).toMatchObject({ audience: "person", fields: [{ prompt: "What color?", choices: [], custom: "value" }] });
});
