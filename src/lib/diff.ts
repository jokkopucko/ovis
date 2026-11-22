export interface DiffLine {
  kind: "same" | "del" | "add";
  text: string;
}

const MAX_CELLS = 250_000;

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length * b.length > MAX_CELLS) return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { lines.push({ kind: "same", text: a[i]! }); i++; j++; }
    else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) lines.push({ kind: "del", text: a[i++]! });
    else lines.push({ kind: "add", text: b[j++]! });
  }
  while (i < a.length) lines.push({ kind: "del", text: a[i++]! });
  while (j < b.length) lines.push({ kind: "add", text: b[j++]! });
  return lines;
}
