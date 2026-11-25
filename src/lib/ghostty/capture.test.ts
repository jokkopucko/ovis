import { afterEach, expect, test } from "bun:test";
import { GHOSTTY_ONLY_KEY, ghosttyOnly } from "./capture.ts";

const stored = new Map<string, string>();
Object.assign(globalThis, { localStorage: { getItem: (key: string) => stored.get(key) ?? null } });
afterEach(() => stored.clear());

test("libghostty alone parses by default only on a phone or tablet", () => {
  expect([ghosttyOnly(true), ghosttyOnly(false)]).toEqual([true, false]);
});

test("a stored choice decides over the device's default", () => {
  stored.set(GHOSTTY_ONLY_KEY, "off");
  expect(ghosttyOnly(true)).toBe(false);
  stored.set(GHOSTTY_ONLY_KEY, "on");
  expect(ghosttyOnly(false)).toBe(true);
});
