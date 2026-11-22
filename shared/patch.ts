/**
 * Codex's file edits: an `apply_patch` call carries the patch as its whole input, and the
 * `exec` tool's scripts carry it as the string argument of `tools.apply_patch(…)`.
 */

const BEGIN = "*** Begin Patch";

export function patchText(input: string): string | null {
  const trimmed = input.trimStart();
  if (trimmed.startsWith(BEGIN)) return trimmed;
  const call = /tools\.apply_patch\(\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/s.exec(input);
  if (call === null) return null;
  const literal = call[1]!;
  let text: string;
  if (literal.startsWith("`")) text = literal.slice(1, -1).replace(/\\`/g, "`");
  else {
    try { text = JSON.parse(literal) as string; } catch { return null; }
  }
  return text.trimStart().startsWith(BEGIN) ? text.trimStart() : null;
}

export function patchFiles(patch: string): string[] {
  const files: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
    const file = match[1]!.trim();
    if (!files.includes(file)) files.push(file);
  }
  return files;
}
