import { expect, it } from "bun:test";
import { labelledAgent } from "./supported-agents.ts";

it("reads a pane herdr labels gentle-shell as the pi it runs, and every other label as it is (#4198)", () => {
  expect(labelledAgent("gentle-shell")).toBe("pi");
  for (const label of ["pi", "claude", "omo", "toString", "constructor", "__proto__", ""]) expect(labelledAgent(label)).toBe(label);
  expect(labelledAgent(null)).toBeNull();
  expect(labelledAgent(undefined)).toBeUndefined();
});
