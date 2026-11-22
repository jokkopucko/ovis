export type ActiveTrigger = {
  kind: "slash" | "file";
  /** `$`: a skill token (`$name` for Codex, `$skill:name` for omo); absent for `/` */
  prefix?: "$";
  query: string;
  start: number;
  end: number;
};

const SLASH_QUERY = /^[\p{L}\p{N}_-]*$/u;
const FILE_QUERY = /^\S+$/u;

function tokenEnd(text: string, from: number, part: RegExp = /\S/u): number {
  let end = from;
  while (end < text.length && part.test(text[end] ?? "")) end += 1;
  return end;
}
const SKILL_CHAR = /[\p{L}\p{N}_-]/u;

/**
 * With `skills`, `$skill` also completes (Codex's syntax).
 * With `atSkills` the pane's `@` skills (OpenCode v2) are listed with the files, so a bare `@`
 * opens the menu too; otherwise a file needs at least one query character.
 */
export function activeTrigger(text: string, caret: number, options: { skills?: boolean; namespaced?: boolean; atSkills?: boolean } = {}): ActiveTrigger | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;

  const queryPattern = options.namespaced ? /^[\p{L}\p{N}_:-]*$/u : SLASH_QUERY;
  const skillChar = options.namespaced ? /[\p{L}\p{N}_:-]/u : SKILL_CHAR;
  const lineStart = text.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
  if (options.skills) {
    const dollar = text.lastIndexOf("$", Math.max(0, caret - 1));
    const query = dollar >= lineStart ? text.slice(dollar + 1, caret) : "";
    if (dollar >= lineStart && (dollar === 0 || /\s/u.test(text[dollar - 1] ?? "")) && queryPattern.test(query)) {
      return { kind: "slash", prefix: "$", query, start: dollar, end: tokenEnd(text, caret, skillChar) };
    }
  }
  const slash = text.lastIndexOf("/", Math.max(0, caret - 1));
  if (slash >= lineStart && (slash === 0 || /\s/u.test(text[slash - 1] ?? ""))) {
    const query = text.slice(slash + 1, caret);
    if (queryPattern.test(query)) {
      return { kind: "slash", query, start: slash, end: tokenEnd(text, caret, skillChar) };
    }
  }

  const at = text.lastIndexOf("@", Math.max(0, caret - 1));
  if (at < lineStart) return null;
  const query = text.slice(at + 1, caret);
  if (query.length === 0) {
    if (!options.atSkills || !(at === 0 || /\s/u.test(text[at - 1] ?? ""))) return null;
  } else if (!FILE_QUERY.test(query)) return null;
  return { kind: "file", query, start: at, end: tokenEnd(text, caret) };
}

export function applyCompletion(
  text: string,
  trigger: ActiveTrigger,
  replacement: string,
): { text: string; caret: number } {
  const after = text.slice(trigger.end);
  const punctuated = replacement.endsWith(" ") && /^\p{P}/u.test(after);
  const inserted = replacement.endsWith(" ") && (after.startsWith(" ") || punctuated) ? replacement.slice(0, -1) : replacement;
  return { text: text.slice(0, trigger.start) + inserted + after, caret: trigger.start + (punctuated ? inserted : replacement).length };
}
