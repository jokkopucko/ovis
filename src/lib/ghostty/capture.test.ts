import { afterEach, expect, test } from "bun:test";
import { GHOSTTY_ONLY_KEY, ghosttyOnly } from "./capture.ts";

const stored = new Map<string, string>();
Object.assign(globalThis, { localStorage: { getItem: (key: string) => stored.get(key) ?? null } });
afterEach(() => stored.clear());

test("libghostty alone parses every attached pane by default, and a mirrored one keeps xterm's parse", () => {
  expect([ghosttyOnly(false), ghosttyOnly(true)]).toEqual([true, false]);
});

test("a stored choice decides over the default", () => {
  stored.set(GHOSTTY_ONLY_KEY, "off");
  expect(ghosttyOnly(false)).toBe(false);
  stored.set(GHOSTTY_ONLY_KEY, "on");
  expect(ghosttyOnly(true)).toBe(true);
});
