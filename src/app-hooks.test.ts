import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Every later App refactor lowers this to its new count; it never goes up.
const APP_HOOK_CEILING = 22;

const HOOK = /\buse(State|Ref|Reducer|Effect|LayoutEffect|Memo|Callback|SyncExternalStore)\b/g;

function countHookCalls(source: string): number {
  let count = 0;
  for (const match of source.matchAll(HOOK)) {
    let i = match.index + match[0].length;
    while (/\s/.test(source[i] ?? "")) i++;
    if (source[i] === "<") {
      let depth = 0;
      for (; i < source.length; i++) {
        const ch = source[i];
        if (ch === "<") depth++;
        else if (ch === ">" && source[i - 1] !== "=") depth--;
        if (depth === 0) { i++; break; }
      }
      while (/\s/.test(source[i] ?? "")) i++;
    }
    if (source[i] === "(") count++;
  }
  return count;
}

test("App.tsx keeps its hook calls under the ceiling", () => {
  const count = countHookCalls(readFileSync(new URL("./App.tsx", import.meta.url), "utf8"));
  expect(
    count <= APP_HOOK_CEILING,
    `App.tsx has ${count} hook calls, over the ceiling of ${APP_HOOK_CEILING}: move the new state into a hook under src/lib, or lower the ceiling only together with a move`,
  ).toBe(true);
});
