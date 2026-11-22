export type TodoStatus = "pending" | "in_progress" | "completed" | "blocked" | "dropped";

export interface TodoItem {
  label: string;
  phase: string | null;
  status: TodoStatus;
  note?: string;
}

const EMPTY_ANSWER = /^(?:Todo list is empty\.|Todo list cleared\.)/m;

/**
 * The whole list from a `todo` answer, when it has one:
 *   `  Phase:` then `    - [X] item`, `    - [ ] item (in progress)`, `    - [ ] item (dropped)` (omp, omo)
 *   or `    ✓ item`, `    → item`, `    ○ item` (gjc).
 * Null when the answer has no list, or was cut before its end.
 */
export function parseTodoAnswer(output: string): TodoItem[] | null {
  if (output.endsWith("… trimmed")) return null;
  if (EMPTY_ANSWER.test(output) && !/^ {4}\S/m.test(output)) return [];
  const items: TodoItem[] = [];
  let phase: string | null = null;
  for (const line of output.split("\n")) {
    const heading = /^ {2}(\S.*):$/.exec(line);
    if (heading) { phase = heading[1]!; continue; }
    const box = /^ {4}- \[(X| )\] (.+)$/.exec(line);
    if (box) {
      let label = box[2]!;
      let status: TodoStatus = box[1] === "X" ? "completed" : "pending";
      let note: string | undefined;
      const suffix = / \((in progress|dropped|blocked)(?:: (.*))?\)$/.exec(label);
      if (suffix) {
        label = label.slice(0, suffix.index);
        status = suffix[1] === "in progress" ? "in_progress" : suffix[1] === "dropped" ? "dropped" : "blocked";
        note = suffix[2];
      }
      items.push(note === undefined ? { label, phase, status } : { label, phase, status, note });
      continue;
    }
    const glyph = /^ {4}([✓→○✗⊘!]) (.+)$/.exec(line);
    if (glyph) {
      const mark = glyph[1];
      items.push({ label: glyph[2]!, phase, status: mark === "✓" ? "completed" : mark === "→" ? "in_progress" : mark === "○" ? "pending" : mark === "!" ? "blocked" : "dropped" });
    }
  }
  if (items.length === 0) return null;
  // `Overall: 9/11 done` counts every item: a list shorter than that was cut
  const overall = /^Overall: \d+\/(\d+) done/m.exec(output);
  if (overall && Number(overall[1]) > items.length) return null;
  return items;
}
