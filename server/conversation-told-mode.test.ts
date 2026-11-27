import { expect, it } from "bun:test";
import { withToldMode } from "./conversation.ts";

const answer = { metadata: { model: "claude-haiku-5-5", reasoning_effort: null, permission_mode: "default" }, version: "v1" };

it("takes the mode a hook told in the transcript's own session, and changes the answer's version with it", () => {
  const told = withToldMode(answer, { mode: "plan", session: "s1" }, "s1");
  expect(told.metadata.permission_mode).toBe("plan");
  expect(told.version).not.toBe(answer.version);
  expect(withToldMode(answer, { mode: "default", session: "s1" }, "s1")).toBe(answer);
});

it("keeps the transcript's mode for a mode told in another session or none", () => {
  // the hook told plan in s1; the pane now reads s2 (a /resume, a /clear, or a Claude started there without the hook)
  expect(withToldMode(answer, { mode: "plan", session: "s1" }, "s2")).toBe(answer);
  expect(withToldMode(answer, null, "s1")).toBe(answer);
});
