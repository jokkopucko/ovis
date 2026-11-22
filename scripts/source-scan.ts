import { readFileSync } from "node:fs";
import { join } from "node:path";

export const repo = join(import.meta.dir, "..");

export const read = (file: string): string => readFileSync(join(repo, file), "utf8");

export const files = (pattern: string): string[] =>
  [...new Bun.Glob(pattern).scanSync({ cwd: repo })].filter((file) => !file.split("/").includes("node_modules")).sort();

export function fail(offenders: string[], instruction: string): void {
  if (offenders.length) throw new Error(`${instruction}\n  ${offenders.join("\n  ")}`);
}

/**
 * A `/` that starts a regular expression literal is not told apart from division, which only
 * matters for a regex holding a quote or `//`; the files these tests read have none that matter.
 */
export function stripComments(text: string, { strings = false } = {}): string {
  let out = "";
  for (let i = 0; i < text.length;) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === "/" && (next === "/" || next === "*")) {
      const close = next === "/" ? text.indexOf("\n", i) : text.indexOf("*/", i + 2);
      const end = close < 0 ? text.length : next === "/" ? close : close + 2;
      out += text.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch && (ch === "`" || text[j] !== "\n")) j += text[j] === "\\" ? 2 : 1;
      out += strings ? ch + text.slice(i + 1, j).replace(/[^\n]/g, " ") + text.slice(j, j + 1) : text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;
