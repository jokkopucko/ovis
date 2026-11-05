import { createContext } from "react";

/**
 * File paths in the chat, as agents write them ("saved to docs/demo.mp4", `~/out/x.png`),
 * opened in the file viewer. A bare path needs a folder in it and an extension, so words
 * like "and/or" or "e.g." stay text; code spans need only look like one file name.
 * Line references stay on the target until the viewer splits them with `fileLineTarget`.
 */

/** The terminal's matcher takes the same line, column and range suffixes. */
const LINE_SUFFIX = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/;
/** what a name is made of, as in the terminal's matcher: any script's letters, digits and marks */
const NAME = "\\p{L}\\p{N}\\p{M}_";
const ROOT = "(?:~\\/|\\.{1,2}\\/|\\/)";
const EXTENSION = "\\.[A-Za-z0-9]{1,8}";
const LINE = "(?::\\d+(?::\\d+)?|#L\\d+(?:-L?\\d+)?)?";
const SEGMENT = `[${NAME}@.+-]+`;
const FILE_NAME = `[${NAME}@+-][${NAME}@.+-]*${EXTENSION}`;
// a path starts where a run of its characters starts, `+` among them: a line of plus signs is
// otherwise tried as a path from every one of them, to its end. `~/` still starts one after a
// plus sign (`+~/notes/a.md`, a line of a diff). It ends at an ASCII word character only, so a
// particle written onto it in Korean or Japanese prose is not taken as part of the name.
// What comes before it is matched too, not looked behind at (shared/lookbehind.ts): that
// character is never the end of the path before, which ends in a name's own character.
const BARE_PATH = new RegExp(`(?:^|[^${NAME}/.@~+-]|\\+(?=~))(${ROOT}?(?:${SEGMENT}\\/)+${FILE_NAME}${LINE})(?![\\w/])`, "gu");
// A code span is delimited, so a path in it may hold single spaces (`.senpi/pages/a b.html`):
// after a root (`~/My Docs/a.md`) or past a first folder, never in a bare name or a first word,
// so a command (`bun scripts/check.ts`) or a phrase (`run a.ts`) is not one
const SPACED = `${SEGMENT}(?: ${SEGMENT})*`;
const SPACED_NAME = `[${NAME}@+-](?:[${NAME}@.+-]| (?=[${NAME}@.+-]))*${EXTENSION}`;
const CODE_PATH = new RegExp(`^(?:${ROOT}(?:${SPACED}\\/)*${SPACED_NAME}|${SEGMENT}\\/(?:${SPACED}\\/)*${SPACED_NAME}|${FILE_NAME})${LINE}$`, "u");

/**
 * A bare dotted name that is code or a host, not a file: what agents write in backticks all the
 * time (`process.env`, `Math.random`, `tool.monitor`). Named one
 * by one, not by the word before the dot: `tool.vue`, `os.conf` and `std.lock` are files, and
 * so is anything else with an extension, as a list of extensions always misses some.
 */
const CODE_NAME = /^(?:process\.(?:env|argv|cwd|exit|platform|stdout|stderr|stdin)(?:\.\w+)?|Math\.(?:random|floor|ceil|round|max|min|abs|pow|sqrt|trunc|sign)|JSON\.(?:parse|stringify)|console\.(?:log|error|warn|info|debug)|Object\.(?:keys|values|entries|assign|freeze)|Array\.(?:from|isArray)|Promise\.(?:all|race|any|allSettled|resolve|reject)|Number\.(?:isFinite|isInteger|parseInt|parseFloat)|tool\.(?:monitor|read|bash|grep|write|edit)|os\.(?:path|environ|getcwd|getenv)|sys\.(?:argv|path|exit|stdout|stderr)|window\.(?:location|history|open)|document\.(?:body|title|cookie))$/;
export function isCodeName(name: string): boolean {
  return !name.includes("/") && CODE_NAME.test(name);
}

// Chinese and Japanese prose writes a Latin path straight onto its words ("open src/app.ts"
// with no spaces): where CJK letters and ASCII letters meet with nothing between them, a name
// ends or starts, so each run between such seams is matched on its own
const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
const CJK_CHAR = new RegExp(`^[${CJK}]$`, "u");
const latin = (char: string): boolean => /^[A-Za-z]$/.test(char);

/** The text cut at each seam between a CJK letter and an ASCII letter, either way round. */
function scriptRuns(text: string): string[] {
  const runs: string[] = [];
  let start = 0;
  let index = 0;
  let previous = "";
  for (const char of text) {
    if ((latin(char) && CJK_CHAR.test(previous)) || (latin(previous) && CJK_CHAR.test(char))) {
      runs.push(text.slice(start, index));
      start = index;
    }
    previous = char;
    index += char.length;
  }
  runs.push(text.slice(start));
  return runs;
}

function* pathMatches(text: string): Generator<{ index: number; 0: string; 1: string }> {
  let start = 0;
  for (const run of scriptRuns(text)) {
    for (const match of run.matchAll(BARE_PATH)) {
      const path = match[1]!;
      yield { index: start + match.index! + match[0].length - path.length, 0: path, 1: path };
    }
    start += run.length;
  }
}

/** Text split into plain runs and the file paths in it. */
export function splitFilePaths(text: string): (string | { path: string })[] {
  const parts: (string | { path: string })[] = [];
  let offset = 0;
  for (const match of pathMatches(text)) {
    const index = match.index;
    // a version number or a domain is not a path: one of its segments must hold a letter
    if (!/\p{L}/u.test(match[1]!.replace(LINE_SUFFIX, "").replace(/\.[A-Za-z0-9]{1,8}$/, ""))) continue;
    if (index > offset) parts.push(text.slice(offset, index));
    parts.push({ path: match[1]! });
    offset = index + match[0].length;
  }
  if (offset < text.length) parts.push(text.slice(offset));
  return parts;
}

/** A code span that is a single file name or path (`README.md`, `src/app.ts`). */
export function codeIsFilePath(code: string): boolean {
  const name = code.replace(LINE_SUFFIX, "");
  return CODE_PATH.test(code) && !isCodeName(name) && /\p{L}/u.test(name.replace(/\.[A-Za-z0-9]{1,8}$/, "")) && !/^\d+(?:\.\d+)+$/.test(name)
    // two files listed in one span (`src/a.ts src/b.css`) are not one name with a space in it
    && code.split(" ").filter((word) => CODE_PATH.test(word)).length < 2;
}

/** Split a viewer target; columns and range ends are ignored, and only positive safe lines are marked. */
export function fileLineTarget(target: string): { path: string; line: number | null } {
  const suffix = LINE_SUFFIX.exec(target);
  if (suffix === null) return { path: target, line: null };
  const line = Number(suffix[1] ?? suffix[2]);
  return { path: target.slice(0, suffix.index), line: Number.isSafeInteger(line) && line >= 1 ? line : null };
}

/** Opens a path in the file viewer; null where nothing can open one (paths stay text). */
export const OpenFileContext = createContext<((path: string) => void) | null>(null);

/**
 * A path in the three parts a viewer shows apart: the folder (the root itself for a file in it,
 * empty for a bare name), and the name as stem and extension, so a long name can be cut inside the
 * stem and still show its type. A dotfile (`.gitignore`) or a name ending in a dot has no extension.
 */
export function pathParts(path: string): { folder: string; stem: string; extension: string } {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = path.slice(cut + 1);
  const head = cut < 0 ? "" : path.slice(0, cut);
  // "/c.md" and "C:\c.md" live in the root: keep its separator, or it reads as a relative folder
  const folder = cut >= 0 && (head === "" || /^[A-Za-z]:$/.test(head)) ? path.slice(0, cut + 1) : head;
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1
    ? { folder, stem: name.slice(0, dot), extension: name.slice(dot) }
    : { folder, stem: name, extension: "" };
}
