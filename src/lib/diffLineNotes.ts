import type { AgentStatus, RepoDiffFilePatch } from "../../shared/protocol.ts";
import { MAX_COMPOSER_CHARS } from "./compose.ts";
import type { Translate } from "./i18n.ts";
import { messageWithComments, type ReplyComment } from "./replyComments.ts";
import type { DiffFindLine } from "./repoDiffFind.ts";

/**
 * A note on one line of a file's diff (#1603): it waits with the reply comments (lib/replyComments.ts)
 * for the next message of the pane the diff was opened from, and goes first in it as a quote. The
 * quote holds what was captured when the note was begun, so a diff that changes later does not move it.
 */
export interface DiffNoteCapture {
  /** the PC's name */
  machine: string;
  /** the repository's top folder on that PC */
  repository: string;
  /** capturedComparison's words */
  comparison: string;
  path: string;
  line: DiffFindLine;
}

/** A fence of backticks longer than the longest run in `text` (at least three): no line of it can close the fence. */
export function codeFence(text: string): string {
  // counted in a loop: a line of a megabyte holds more runs than a spread into Math.max takes in V8
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** The patch's identity: 64-bit FNV-1a of its text, in hex. The same patch, the same identity. */
export function patchIdentity(patch: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < patch.length; index++) {
    hash ^= BigInt(patch.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * The comparison as it was read: two full commits; a branch's HEAD, base and merge base and the
 * patch's identity (it compares the working tree, which changes under the same commits); or (the
 * working tree and the index, which have no commit of their own) HEAD and the patch's identity.
 */
export function capturedComparison(answer: RepoDiffFilePatch, patch: string): string {
  const head = answer.repository.head;
  const onHead = head === null ? "before the first commit" : `on HEAD ${head}`;
  switch (answer.scope) {
    case "workspace": return `working tree ${onHead}, patch ${patchIdentity(patch)}`;
    case "staged": return `staged ${onHead}, patch ${patchIdentity(patch)}`;
    case "commit": return `commits ${answer.base ?? ""}..${answer.head ?? head ?? "HEAD"}`;
    case "branch": {
      const pinned = answer.comparison;
      if (pinned === null) return `branch since ${answer.base ?? ""} ${onHead}, patch ${patchIdentity(patch)}`;
      return `branch since ${answer.base ?? pinned.base_oid}: HEAD ${pinned.head_oid}, base ${pinned.base_oid}, merge base ${pinned.merge_base_oid}, patch ${patchIdentity(patch)}`;
    }
  }
}

const KIND_WORD = { addition: "added", deletion: "removed", context: "unchanged" } as const;

/**
 * A name as a JSON string: one line whatever it holds, and two names that differ stay two (a newline
 * is not a space). JSON leaves U+2028, U+2029 and U+0085 raw, which some viewers break a line at:
 * they are escaped too, and the string still parses to the same name.
 */
const named = (text: string): string => JSON.stringify(text).replace(/[\u2028\u2029\u0085]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

/**
 * The quote the note goes with: where the line is (the path, PC and repository as JSON strings),
 * what was compared, and the line's text in a fence. A line of whitespace alone would lose it to the
 * message's quote lines, so it is written as a JSON string, and the quote says so.
 */
export function diffNoteQuote(capture: DiffNoteCapture): string {
  const { line } = capture;
  // U+0085 is no whitespace to trim(), though a viewer may break a line at it
  const whitespace = /^[\s\u0085]+$/.test(line.text);
  const text = whitespace ? named(line.text) : line.text;
  const fence = codeFence(text);
  return [
    `Diff note on ${named(capture.path)}, ${line.side} side, line ${line.line} (${KIND_WORD[line.kind]})`,
    `PC ${named(capture.machine)}, repository ${named(capture.repository)}`,
    `Compared as captured: ${capture.comparison.replace(/[\r\n\u2028\u2029\u0085]+/g, " ")}`,
    ...(whitespace ? ["The line holds only whitespace, written below as a JSON string."] : []),
    fence,
    text,
    fence,
  ].join("\n");
}

/**
 * The logical line of a row the diff drew (lib/repoDiffFind.ts): a row on the old side by its old
 * number (a removed line, or in split an unchanged one), a row on the new side by its new number.
 */
export function lineAtRow(lines: readonly DiffFindLine[], side: "deletions" | "additions", lineNumber: number): DiffFindLine | null {
  return lines.find((line) => (side === "deletions" ? line.oldLine : line.newLine) === lineNumber) ?? null;
}

/** Whether the next message would pass the composer's limit with this note and the draft typed so far. */
export function noteOverflows(waiting: readonly ReplyComment[], draft: string, quote: string, note: string, reserved: ReadonlySet<string> = new Set()): boolean {
  // a comment a send on its way carries is not in the next message (Composer's `unreserved`)
  const next = waiting.filter((item) => !reserved.has(item.id));
  return messageWithComments([...next, { id: "", quote, comment: note.trim() }], draft).length > MAX_COMPOSER_CHARS;
}

export type NoteBlock = "no-pane" | "pc-offline" | "pane-gone" | "watching" | "pane-not-open" | "observing" | "no-agent";

/**
 * Why the diff's own pane cannot take a note, or null when it can. Only that pane ever does: never
 * one on another PC, nor whichever is selected now.
 */
export function noteBlock({ paneId, pane, watching, observing = false, mounted = true, reachable = true }: { paneId: string | null; reachable?: boolean; mounted?: boolean; pane: { agent?: string | null; agent_status: AgentStatus } | undefined; watching: boolean; observing?: boolean }): NoteBlock | null {
  if (paneId === null) return "no-pane";
  if (!reachable) return "pc-offline";
  if (pane === undefined) return "pane-gone";
  if (watching) return "watching";
  // a pane this window shows no terminal of: whether it may type there is not known yet
  if (!mounted) return "pane-not-open";
  if (observing) return "observing";
  if (pane.agent === null || pane.agent === undefined || pane.agent === "") return "no-agent";
  return null;
}

/** A NoteBlock in the user's words, shown where the note would be begun. */
export function noteBlockWord(t: Translate, block: NoteBlock): string {
  switch (block) {
    case "no-pane": return t("Notes go to the pane this diff came from, and it has none.");
    case "pc-offline": return t("That PC is not reachable right now.");
    case "pane-gone": return t("The pane this diff came from has closed, so a note has nowhere to go.");
    case "watching": return t("This device can only watch.");
    case "pane-not-open": return t("Open the pane this diff came from first, so this window knows it can type there.");
    case "observing": return t("This window only watches the pane while another one types in it. Click the pane to type, then add the note.");
    case "no-agent": return t("No agent is running in the pane this diff came from.");
  }
}
