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
 * scripts/conventions.test.ts holds every file to its count in scripts/fixed-sleeps.json, which
 * may only shrink. `bun scripts/fixed-sleeps.ts` prints the current counts.
 */
import { files, lineOf, read, stripComments } from "./source-scan.ts";

const SLEEP = /\bBun\.sleep(?:Sync)?\s*\(|\b\w+(?:\.\w+)*\.waitForTimeout\s*\(|\bnew Promise(?:<[^>]*>)?\(\s*(?:async\s*)?(?:function\s*)?\(?\s*(\w+)\s*\)?\s*(?:=>)?\s*\{?\s*(?:window\.|globalThis\.)?setTimeout\(\s*(?:\1|\(\s*\)\s*=>\s*\{?\s*\1\s*\(\s*\)\s*;?\s*\}?)\s*,(?!\s*0\s*\))/g;
const BOUND = /Date\.now\(\)|performance\.now\(\)|[Dd]eadline|\b\w+\s*<=?\s*(?:\d|[A-Z][A-Z0-9_]*\b|\w*(?:[Tt]ries|[Aa]ttempts|[Rr]etries|[Mm]ax|[Ll]imit)\w*)/;
/** `// fixed wait:` followed by the reason. */
const MARKER = /\/\/\s*fixed wait:\s*\S/;

export const sleepFiles = (): string[] => files("{server,src,shared,scripts,site,telemetry,tui}/**/*.{ts,tsx,mjs,js}")
  .filter((file) => !file.startsWith("scripts/film/") && !file.startsWith("scripts/readme-media/") && file !== "scripts/fixed-sleeps.ts" && file !== "scripts/conventions.test.ts");

function inBoundedLoop(code: string, at: number): boolean {
  for (let from = at; ;) {
    let open = -1;
    for (let i = from - 1, depth = 0; i >= 0; i--) {
      if (code[i] === "}") depth += 1;
      else if (code[i] === "{") { if (depth === 0) { open = i; break; } depth -= 1; }
    }
    if (open < 0) return false;
    let close = open + 1;
    for (let depth = 1; depth > 0 && close < code.length; close++) depth += code[close] === "{" ? 1 : code[close] === "}" ? -1 : 0;
    const head = code.slice(code.lastIndexOf("\n", open - 1) + 1, open).trim();
    const body = code.slice(open, close);
    const doWhile = /(?:^|[\s;}])do$/.test(head) ? /^\s*while\s*\(([^\n]*)/.exec(code.slice(close))?.[1] ?? "" : null;
    if (doWhile !== null || /\b(?:while|for)\s*\(/.test(head)) {
      return BOUND.test(doWhile ?? head) || (/Date\.now\(\)|performance\.now\(\)|deadline/i.test(body) && /\b(?:throw|return|break|assert|expect)\b/.test(body));
    }
    if (/=>$|\)\s*(?::[^{]*)?$/.test(head) && !/\b(?:if|switch|catch|with)\s*\(/.test(head)) return false;
    from = open;
  }
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

export function fixedSleeps(file: string, text = read(file)): string[] {
  const code = stripComments(text, { strings: true });
  const lines = text.split("\n");
  const found: string[] = [];
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
    if (MARKER.test(lines[line - 1]!) || MARKER.test(lines[line - 2] ?? "")) continue;
    const before = codeLine.slice(0, match.index - (code.lastIndexOf("\n", match.index) + 1));
    if (/^\s*(?:while|for)\s*\(/.test(before) && BOUND.test(before)) continue;
    if (inBoundedLoop(code, match.index)) continue;
    found.push(`${file}:${line}: ${lines[line - 1]!.trim().slice(0, 160)}`);
  }
  return found;
}

export function fixedSleepCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of sleepFiles()) {
    const count = fixedSleeps(file).length;
    if (count) counts[file] = count;
  }
  return counts;
}

if (import.meta.main) console.log(JSON.stringify(fixedSleepCounts(), null, 2));
