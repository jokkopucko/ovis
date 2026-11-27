/**
 * Fixed sleeps: waits that pass a set time instead of waiting for what they are after
 * (AGENTS.md: "Wait with bounded polls and deadlines, never fixed sleeps"). A fixed sleep is
 * too short on a slow CI runner and too long everywhere else.
 *
 * Not counted:
 * - the pause between reads of a loop bounded by a deadline or a try count
 *   (`while (!done() && Date.now() < deadline) await Bun.sleep(25)`, `for (let i = 0; i < 40 && …; i++)`,
 *   or a loop whose body throws, asserts, returns or breaks on a deadline);
 * - a timeout raced against the real event (`Promise.race([event, Bun.sleep(ms)])`);
 * - `setTimeout(resolve, 0)`, which yields a turn rather than waiting;
 * - a wait that is fixed on purpose and says so on its line or the line above:
 *   `// fixed wait: <why>` (proving that nothing arrives, a settle gap herdr needs).
 *
 * A local sleep helper (`const sleep = (ms) => new Promise(…setTimeout…)`, an alias of Bun.sleep,
 * or setTimeout from node:timers/promises) is not counted where it is defined; each call of it is.
 *
 * scripts/conventions.test.ts holds every file to its count in scripts/fixed-sleeps.json, and to its
 * count of waits a `// fixed wait:` excuses in scripts/fixed-waits.json: both may only shrink, so the
 * marker is no way around the first. `bun scripts/fixed-sleeps.ts` prints the current counts of fixed
 * sleeps, `bun scripts/fixed-sleeps.ts --marked` those of marked waits.
 *
 * Turn waits: a test or browser script that waits one turn of the event loop (`setImmediate(resolve)`,
 * `setTimeout(resolve, 0)`) for work to finish. Work that waits on a file, a timer or a socket ends
 * turns later on a busy machine, and an assertion that something did not happen then passes before it
 * could. Counted in scripts/turn-waits.json, which may only shrink (`bun scripts/fixed-sleeps.ts --turns`);
 * not counted: a turn inside a loop that polls a condition, and one raced against the event.
 */
import { files, lineOf, read, stripComments } from "./source-scan.ts";

const SLEEP = /\bBun\.sleep(?:Sync)?\s*\(|\b\w+(?:\.\w+)*\.waitForTimeout\s*\(|\bnew Promise(?:<[^>]*>)?\(\s*(?:async\s*)?(?:function\s*)?\(?\s*(\w+)\s*\)?\s*(?:=>)?\s*\{?\s*(?:window\.|globalThis\.)?setTimeout\(\s*(?:\1|\(\s*\)\s*=>\s*\{?\s*\1\s*\(\s*\)\s*;?\s*\}?)\s*,(?!\s*0\s*\))/g;
const BOUND = /Date\.now\(\)|performance\.now\(\)|[Dd]eadline|\b\w+\s*<=?\s*(?:\d|[A-Z][A-Z0-9_]*\b|\w*(?:[Tt]ries|[Aa]ttempts|[Rr]etries|[Mm]ax|[Ll]imit)\w*)/;
/** `// fixed wait:` followed by the reason. */
const MARKER = /\/\/\s*fixed wait:\s*\S/;

export const sleepFiles = (): string[] => files("{server,src,shared,scripts,site,telemetry,tui}/**/*.{ts,tsx,mjs,js}")
  .filter((file) => !file.startsWith("scripts/film/") && !file.startsWith("scripts/readme-media/") && file !== "scripts/fixed-sleeps.ts" && file !== "scripts/conventions.test.ts");

/** The innermost loop whose braces hold `at`: its condition line (a do's `while`) and body. Null outside one, or in a function inside one. */
function loopAround(code: string, at: number): { head: string; body: string } | null {
  for (let from = at; ;) {
    let open = -1;
    for (let i = from - 1, depth = 0; i >= 0; i--) {
      if (code[i] === "}") depth += 1;
      else if (code[i] === "{") { if (depth === 0) { open = i; break; } depth -= 1; }
    }
    if (open < 0) return null;
    let close = open + 1;
    for (let depth = 1; depth > 0 && close < code.length; close++) depth += code[close] === "{" ? 1 : code[close] === "}" ? -1 : 0;
    const head = code.slice(code.lastIndexOf("\n", open - 1) + 1, open).trim();
    const body = code.slice(open, close);
    const doWhile = /(?:^|[\s;}])do$/.test(head) ? /^\s*while\s*\(([^\n]*)/.exec(code.slice(close))?.[1] ?? "" : null;
    if (doWhile !== null || /\b(?:while|for)\s*\(/.test(head)) return { head: doWhile === null ? head : `while (${doWhile}`, body };
    if (/=>$|\)\s*(?::[^{]*)?$/.test(head) && !/\b(?:if|switch|catch|with)\s*\(/.test(head)) return null;
    from = open;
  }
}

function inBoundedLoop(code: string, at: number): boolean {
  const loop = loopAround(code, at);
  return loop !== null && (BOUND.test(loop.head)
    || (/Date\.now\(\)|performance\.now\(\)|deadline/i.test(loop.body) && /\b(?:throw|return|break|assert|expect)\b/.test(loop.body)));
}

function sleepHelpers(code: string, source: string): { names: Set<string>; definitions: Set<number>; yields: Set<string> } {
  const names = new Set<string>();
  const definitions = new Set<number>();
  const yields = new Set<string>();
  const define = /(?:\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(\([^)]*\)|\w+)\s*(?::[^=;\n]*)?=>\s*(?:\{\s*return\s+)?|\bfunction\s+(\w+)\s*(\([^)]*\))[^{;]*\{\s*return\s+)(?=\bBun\.sleep|\bnew Promise|\w+(?:\.\w+)*\.waitForTimeout\b)/g;
  for (const match of code.matchAll(define)) {
    const at = match.index + match[0].length;
    if (new RegExp(SLEEP.source, "y").exec(code.slice(at)) === null && !/^Bun\.sleep(?:Sync)?\s*\(/.test(code.slice(at))) continue;
    const name = match[1] ?? match[3]!;
    names.add(name);
    definitions.add(at);
    if (/=\s*0\s*\)$/.test(match[2] ?? match[4]!)) yields.add(name);
  }
  for (const match of code.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=[^;\n]*\bBun\.sleep(?:Sync)?\b(?!\s*\()/g)) names.add(match[1]!);
  for (const match of source.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*["'](?:node:)?timers\/promises["']/g)) {
    const named = /\bsetTimeout(?:\s+as\s+(\w+))?\b/.exec(match[1]!);
    if (named) names.add(named[1] ?? "setTimeout");
  }
  return { names, definitions, yields };
}

/** The waits in `file` that pass a set time: `fixed` ones, and `marked` ones a `// fixed wait:` excuses. */
function setWaits(file: string, text: string): { fixed: string[]; marked: string[] } {
  const code = stripComments(text, { strings: true });
  const lines = text.split("\n");
  const fixed: string[] = [];
  const marked: string[] = [];
  const helpers = sleepHelpers(code, stripComments(text));
  const calls = helpers.names.size ? [...code.matchAll(new RegExp(`(?<![\\w.])(?:${[...helpers.names].join("|")})\\s*\\((?!\\s*0\\s*\\))`, "g"))] : [];
  const sleeps = [...code.matchAll(SLEEP)].filter((match) => !helpers.definitions.has(match.index));
  const waits = [...sleeps, ...calls.filter((match) => !/\bfunction\s+$/.test(code.slice(Math.max(0, match.index - 20), match.index))
    && !(helpers.yields.has(match[0].replace(/\s*\($/, "")) && /^\(\s*\)/.test(code.slice(match.index + match[0].length - 1))))]
    .sort((a, b) => a.index - b.index);
  for (const match of waits) {
    const line = lineOf(code, match.index);
    const codeLine = code.split("\n")[line - 1]!;
    if (/\bPromise\.race\s*\(/.test(codeLine)) continue;
    const before = codeLine.slice(0, match.index - (code.lastIndexOf("\n", match.index) + 1));
    if (/^\s*(?:while|for)\s*\(/.test(before) && BOUND.test(before)) continue;
    if (inBoundedLoop(code, match.index)) continue;
    const found = MARKER.test(lines[line - 1]!) || MARKER.test(lines[line - 2] ?? "") ? marked : fixed;
    found.push(`${file}:${line}: ${lines[line - 1]!.trim().slice(0, 160)}`);
  }
  return { fixed, marked };
}

export const fixedSleeps = (file: string, text = read(file)): string[] => setWaits(file, text).fixed;

export const markedWaits = (file: string, text = read(file)): string[] => setWaits(file, text).marked;

function countsOf(find: (file: string) => string[], within = sleepFiles()): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of within) {
    const count = find(file).length;
    if (count) counts[file] = count;
  }
  return counts;
}

export const fixedSleepCounts = (): Record<string, number> => countsOf(fixedSleeps);

export const markedWaitCounts = (): Record<string, number> => countsOf(markedWaits);

/** A promise that one turn of the event loop resolves: `new Promise((r) => setImmediate(r))`, `setTimeout(r, 0)`, `new Promise(setImmediate)`. */
const TURN = /\bnew Promise(?:<[^>]*>)?\(\s*(?:(?:async\s*)?(?:function\s*)?\(?\s*(\w+)\s*\)?\s*(?::\s*\w+\s*)?(?:=>)?\s*\{?\s*(?:window\.|globalThis\.)?(?:setImmediate\(\s*(?:\1|\(\s*\)\s*=>\s*\{?\s*\1\s*\(\s*\)\s*;?\s*\}?)\s*\)|setTimeout\(\s*(?:\1|\(\s*\)\s*=>\s*\{?\s*\1\s*\(\s*\)\s*;?\s*\}?)\s*(?:,\s*0\s*)?\))|setImmediate\s*\))/g;

export const turnWaitFiles = (): string[] => files("{server,src,shared,scripts,site,telemetry,tui,integrations,push-relay,relay,app}/**/*.{ts,tsx,mjs,js}")
  .filter((file) => file !== "scripts/conventions.test.ts" && (/\.test\.[cm]?[jt]sx?$/.test(file) || /^scripts\/(?:.*\/)?[^/]*-(?:regression|qa)\.ts$/.test(file)));

/** Where the bracket opened at `open` closes. */
function closing(code: string, open: number): number {
  const [up, down] = code[open] === "{" ? ["{", "}"] : ["(", ")"];
  let close = open + 1;
  for (let depth = 1; close < code.length; close++) {
    depth += code[close] === up ? 1 : code[close] === down ? -1 : 0;
    if (depth === 0) break;
  }
  return close;
}

/** `body` without the functions inside it: a `return` there leaves the function, not the loop. */
function ownCode(body: string): string {
  for (let inner = /=>\s*\{|\bfunction\b[^{;]*\{/.exec(body); inner !== null; inner = /=>\s*\{|\bfunction\b[^{;]*\{/.exec(body)) {
    body = body.slice(0, inner.index) + body.slice(closing(body, inner.index + inner[0].length - 1) + 1);
  }
  return body;
}

/** A loop polls when its condition tests more than a counter (`turn < 50 && !seen()`, `!done()`), or its own body can leave it early. */
function polls(head: string, body = ""): boolean {
  const at = /\b(for|while)\s*\(/.exec(head);
  if (at === null) return false;
  const open = at.index + at[0].length - 1;
  const inside = head.slice(open + 1, closing(head, open));
  const condition = (at[1] === "for" ? inside.split(";")[1] ?? "" : inside).trim();
  return (condition !== "" && condition !== "true" && !/^\w+\s*[<>]=?\s*[\w.]+$/.test(condition)) || /\b(?:break|return|throw)\b/.test(ownCode(body));
}

/** The turn waits in `file`: each that is no poll, and each call of a helper that only returns one. */
export function turnWaits(file: string, text = read(file)): string[] {
  const code = stripComments(text, { strings: true });
  const lines = text.split("\n");
  const helpers = new Set<string>();
  const definitions = new Set<number>();
  for (const match of code.matchAll(/(?:\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=;\n]*)?=>\s*(?:\{\s*return\s+)?|\bfunction\s+(\w+)\s*\([^)]*\)[^{;]*\{\s*return\s+)(?=\bnew Promise\b)/g)) {
    const at = match.index + match[0].length;
    if (new RegExp(TURN.source, "y").exec(code.slice(at)) === null) continue;
    helpers.add(match[1] ?? match[2]!);
    definitions.add(at);
  }
  // node:timers/promises: its setImmediate() is one turn, and so is its setTimeout() for no time
  const zeroTimers = new Set<string>();
  for (const match of stripComments(text).matchAll(/\bimport\s*(?:\{([^}]*)\}|\*\s*as\s+(\w+))\s*from\s*["'](?:node:)?timers\/promises["']/g)) {
    if (match[2] !== undefined) { helpers.add(`${match[2]}.setImmediate`); zeroTimers.add(`${match[2]}.setTimeout`); continue; }
    const immediate = /\bsetImmediate(?:\s+as\s+(\w+))?\b/.exec(match[1]!);
    if (immediate) helpers.add(immediate[1] ?? "setImmediate");
    const timeout = /\bsetTimeout(?:\s+as\s+(\w+))?\b/.exec(match[1]!);
    if (timeout) zeroTimers.add(timeout[1] ?? "setTimeout");
  }
  const called = (names: Set<string>, args: string) => names.size === 0 ? []
    : [...code.matchAll(new RegExp(`(?<![\\w.])(?<!\\bfunction\\s+)(?:${[...names].map((name) => name.replace(".", "\\.")).join("|")})\\s*\\(${args}`, "g"))];
  const calls = [...called(helpers, ""), ...called(zeroTimers, "\\s*(?:0\\s*)?[,)]")];
  const waits = [...[...code.matchAll(TURN)].filter((match) => !definitions.has(match.index)), ...calls].sort((a, b) => a.index - b.index);
  // a turn raced against the event is a timeout for it, not a wait
  const races = [...code.matchAll(/\bPromise\.race\s*\(/g)].map((race) => [race.index, closing(code, race.index + race[0].length - 1)] as const);
  const found: string[] = [];
  for (const match of waits) {
    if (races.some(([from, to]) => match.index > from && match.index < to)) continue;
    const line = lineOf(code, match.index);
    const codeLine = code.split("\n")[line - 1]!;
    const before = codeLine.slice(0, match.index - (code.lastIndexOf("\n", match.index) + 1));
    // a loop without braces holds the wait on its own line: `for (…) await …`
    const single = /\b(?:for|while)\s*\((?!.*\b(?:for|while)\s*\().*\)\s*(?:await\s+)?$/.exec(before)?.[0];
    const loop = single === undefined ? loopAround(code, match.index) : { head: single, body: "" };
    if (loop !== null && polls(loop.head, loop.body)) continue;
    found.push(`${file}:${line}: ${lines[line - 1]!.trim().slice(0, 160)}`);
  }
  return found;
}

export const turnWaitCounts = (): Record<string, number> => countsOf(turnWaits, turnWaitFiles());

if (import.meta.main) {
  const counts = process.argv.includes("--turns") ? turnWaitCounts() : process.argv.includes("--marked") ? markedWaitCounts() : fixedSleepCounts();
  console.log(JSON.stringify(counts, null, 2));
}
