export interface OmoDetachedCell {
  readonly id: string;
  readonly at: number;
}

// The runtime's own wording. A cell detaches while it runs, while it waits for its kernel, or
// queued behind other cells (a list that can be empty); one notice can report several cells
// that ended together, each on its own line.
export const DETACHED = /^Eval cell (\S+) (?:detached and is (?:still )?running in the (?:js|py) kernel|is detached and waiting for the (?:js|py) kernel to be ready|is queued behind [^\n]*? in the (?:js|py) kernel and detached)/;
const ENDED = /(?:^|\n)(?:<system-reminder>)?Detached eval cell (\S+) \((?:js|py)\) (?:completed|failed|cancelled|was killed[^\n]*)\./g;

/** A notification's text: a string, or the text parts of a list that also carries images. */
export function notificationText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => typeof part === "object" && part !== null && "type" in part && part.type === "text"
    && "text" in part && typeof part.text === "string" ? [part.text] : []).join("\n");
}

/** Detached cells outlive an assistant's stop; only their own runtime notice settles them. */
export function omoDetachedAfter(open: readonly OmoDetachedCell[], entry: unknown): readonly OmoDetachedCell[] {
  if (typeof entry !== "object" || entry === null || !("type" in entry)) return open;
  if (entry.type === "custom_message" && "customType" in entry && entry.customType === "senpi-codemode:notification" && "content" in entry) {
    const ended = new Set([...notificationText(entry.content).matchAll(ENDED)].map((match) => match[1]!));
    return ended.size > 0 ? open.filter((cell) => !ended.has(cell.id)) : open;
  }
  if (entry.type !== "message" || !("message" in entry) || typeof entry.message !== "object" || entry.message === null) return open;
  const message = entry.message;
  if (!("role" in message) || message.role !== "toolResult" || !("toolName" in message) || message.toolName !== "eval"
    || !("content" in message) || !Array.isArray(message.content)) return open;
  const at = "timestamp" in entry && typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  if (!Number.isFinite(at)) return open;
  let cells = open;
  for (const part of message.content) {
    if (typeof part !== "object" || part === null || !("type" in part) || part.type !== "text" || !("text" in part) || typeof part.text !== "string") continue;
    const id = part.text.match(DETACHED)?.[1];
    if (id && !cells.some((cell) => cell.id === id)) cells = [...cells, { id, at }];
  }
  return cells;
}
