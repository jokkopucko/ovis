import type { StreamSource } from "./conversation-shared.ts";
import { claudePeerNotice, piMessage, piPromptImages } from "./transcript-records.ts";
import type { TranscriptEntry } from "./claude-transcript.ts";
import { claudeImages, isCommandEntry, senpiPrompt, withoutPictureBytes } from "./claude-transcript.ts";
import { copilotPromptOpens, copilotRootRecord } from "./copilot.ts";
import { musePrompt } from "./muse.ts";
import { lettaPrompt } from "./letta.ts";

/**
 * A Claude session's branch, followed as the file is scanned. Claude Code links each record to the
 * one before it (`parentUuid`) and never rewrites the file: a /rewind (or a send cancelled and sent
 * again) leaves the turns it went back over in place, and the next prompt hangs from the record it
 * went back to (null: from before the first message), not from the last one written (recorded on
 * 2.1.304). Such a prompt forks the session: what lies between that record and the prompt is off
 * the branch, when an answer lies there too. A send cancelled
 * before any reply and sent again is a sibling of the same kind, and stays with the cancelled-prompt
 * rule (pushPrompt, turnStarts): it moves no history. Only a prompt forks, or a slash command's echo
 * (a /context sent first after a Restore hangs from the record gone back to, and the prompts after it
 * follow it on the chain, recorded on 2.1.304), once the conversation goes on from that echo: other records off the
 * chain (a hook's progress) hide nothing, and a parent the scan does not know (a record too long to
 * read here) hides nothing either.
 */
export interface ClaudeBranch {
  /** the last record on the chain, null when it could not be read */
  last: string | null;
  /** where each record seen ends, by uuid */
  ends: Map<string, number>;
  /** where each assistant record starts, ascending */
  answers: number[];
  forks: [number, number][];
  /**
   * a slash command's echo that left the chain, and the records hanging from it so far: it forks
   * only once the conversation goes on from it (a prompt hangs from one of them, or one of them is
   * the chain's tip); a prompt hanging from anywhere else drops it
   */
  echo?: { range: [number, number]; line: Set<string> };
}

/** the branch's forks, with an echo's while the chain's tip still hangs from it */
export function claudeForks(branch: ClaudeBranch): [number, number][] {
  return branch.echo && branch.last !== null && branch.echo.line.has(branch.last) ? [...branch.forks, branch.echo.range] : branch.forks;
}

/** whether an assistant record starts in [from, to) */
function answeredBetween(answers: readonly number[], from: number, to: number): boolean {
  let low = 0, high = answers.length;
  while (low < high) { const middle = (low + high) >> 1; if (answers[middle]! < from) low = middle + 1; else high = middle; }
  return low < answers.length && answers[low]! < to;
}

/** a slash command the user ran, as Claude Code echoes it: a local_command record, or a user one on older versions */
function claudeCommandEchoRecord(entry: { type?: unknown; subtype?: unknown; isMeta?: unknown; content?: unknown; message?: { content?: unknown } }): boolean {
  const text = entry.type === "system" && entry.subtype === "local_command" ? entry.content : entry.type === "user" && !entry.isMeta ? entry.message?.content : undefined;
  return typeof text === "string" && /^\s*(?:<command-message>[^<]*<\/command-message>\s*)?<command-name>\//.test(text);
}

/** a record longer than this, its pictures' bytes left out, is not parsed for its links: it leaves the chain unknown */
const CLAUDE_CHAIN_LINE_BYTES = 1024 * 1024;

/** follows the branch over one record; the record as parsed, when it was (the scan reads its settings from it) */
export function followClaudeBranch(branch: ClaudeBranch, line: Buffer, start: number, end: number, floor: number): unknown {
  if (!line.includes('"uuid"')) return undefined;
  const text = line.length > CLAUDE_CHAIN_LINE_BYTES ? withoutPictureBytes(line.toString("utf8")) : line.toString("utf8");
  if (text.length > CLAUDE_CHAIN_LINE_BYTES) {
    // too long to follow, but the model and effort it names still count
    branch.last = null;
    try { return JSON.parse(text) as unknown; } catch { return undefined; }
  }
  let entry: TranscriptEntry & { isSidechain?: unknown; logicalParentUuid?: unknown };
  try { entry = JSON.parse(text) as typeof entry; } catch { branch.last = null; return undefined; }
  if (entry === null || typeof entry !== "object" || typeof entry.uuid !== "string" || entry.isSidechain === true) return entry;
  // a compaction's boundary starts a chain of its own, and names the record it continues
  const parent = entry.parentUuid === null ? typeof entry.logicalParentUuid === "string" ? entry.logicalParentUuid : null
    : typeof entry.parentUuid === "string" ? entry.parentUuid : undefined;
  const prompt = opensTurn("claude-transcript", text, null);
  const echo = !prompt && claudeCommandEchoRecord(entry as Parameters<typeof claudeCommandEchoRecord>[0]);
  if (branch.echo && typeof parent === "string" && branch.echo.line.has(parent)) {
    if (prompt) { branch.forks.push(branch.echo.range); branch.echo = undefined; } else branch.echo.line.add(entry.uuid);
  } else if (prompt) branch.echo = undefined;
  if (branch.last !== null && parent !== undefined && parent !== branch.last && (prompt || echo)) {
    const from = parent === null ? floor : branch.ends.get(parent);
    if (from !== undefined && Math.max(from, floor) < start && answeredBetween(branch.answers, Math.max(from, floor), start)) {
      const range: [number, number] = [Math.max(from, floor), start];
      if (prompt) branch.forks.push(range);
      else branch.echo = { range, line: new Set([entry.uuid]) };
    }
  }
  if (entry.type === "assistant") branch.answers.push(start);
  branch.ends.set(entry.uuid, end);
  branch.last = entry.uuid;
  return entry;
}

/** Bytes that every line opening a turn contains: a cheap filter before JSON.parse. */
/** the mark of another session's message in a Claude record, in either of its forms (claudePeerNotice) */
const PEER_MARK = Buffer.from('"kind":"peer"');
const TURN_MARK: Record<StreamSource, Buffer> = {
  "copilot-transcript": Buffer.from('"user.message"'),
  "grok-transcript": Buffer.from('"user_message_chunk"'),
  "agy-transcript": Buffer.from('"USER_INPUT"'),
  "muse-transcript": Buffer.from('"payload_type":"runtime.user_intent.accepted"'),
  "letta-transcript": Buffer.from('"kind":"user"'),
  "codex-transcript": Buffer.from('"task_started"'),
  "claude-transcript": Buffer.from('"user"'),
  "omp-transcript": Buffer.from('"user"'),
  "omo-transcript": Buffer.from('"user"'),
  "gjc-transcript": Buffer.from('"user"'),
  "pi-transcript": Buffer.from('"user"'),
  "cmd-transcript": Buffer.from('"user"'),
};

/**
 * Does this line open a turn? "inline": a prompt that opens no page (a message senpi sent along with
 * host tool results, which stay on the page of the calls they answer); it still forks the branch and
 * starts a prompt chain. Pages start at the others, so a page never splits
 * a turn: a Codex task (its prompt, duplicate records and tool calls all follow
 * task_started), a Claude or omp prompt (tool results answer the turn before it),
 * and the same for pi, whose prompts are `message` records with a user role.
 */
function opensTurn(source: StreamSource, line: string, blobs: string | null): boolean | "inline" {
  let entry: { type?: unknown; uuid?: unknown; origin?: unknown; permissionMode?: unknown; data?: { content?: unknown }; isMeta?: unknown; isCompactSummary?: unknown; payload?: { type?: unknown }; message?: { role?: unknown; content?: unknown } };
  try { entry = JSON.parse(line); } catch { return false; }
  if (entry === null || typeof entry !== "object") return false;
  if (source === "copilot-transcript") return entry.type === "user.message" && copilotRootRecord(entry) && copilotPromptOpens(entry.data);
  if (source === "codex-transcript") return entry.type === "event_msg" && entry.payload?.type === "task_started";
  if (source === "muse-transcript") return musePrompt(entry as Record<string, unknown>) !== null;
  if (source === "letta-transcript") return lettaPrompt(entry as Record<string, unknown>) !== null;
  if (source !== "claude-transcript") {
    const message = piMessage(entry);
    if (message?.role !== "user") return false;
    if ((message.content as Record<string, unknown>[]).some((part) => part.type === "text" && typeof part.text === "string" && part.text.length > 0)) return true;
    // a pi or omp prompt that is only pictures is drawn as a turn of its own, so it opens one (omp's
    // pictures in its blob store `blobs`, as the parser names them)
    if (source === "omp-transcript") return piPromptImages(entry, message, blobs).length > 0;
    return (source === "pi-transcript" || source === "cmd-transcript") && piPromptImages(entry, message).length > 0;
  }
  // another session's message opens a turn in either of its forms, the meta entry and the queued attachment
  if (claudePeerNotice(entry) !== null) return true;
  if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary) return false;
  const content = entry.message?.content;
  if (typeof content === "string") return !isCommandEntry(content, entry);
  if (!Array.isArray(content)) return false;
  // senpi's host tool results answer the calls before them and its notices are no one's typing: only a
  // message sent along with them is a prompt, and with host results it stays on those calls' page
  const sent = senpiPrompt(entry as Parameters<typeof senpiPrompt>[0], content);
  const own = sent.own.filter((block) => block !== null) as ({ type?: unknown; text?: unknown } | null)[];
  // a prompt that is only a picture is one too, as the parser draws it; a picture beside a tool's
  // result opens nothing: the result must stay on the page of the call it answers
  const prompt = own.some((block) =>
    block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0 && !isCommandEntry(block.text.trim(), entry))
    || (!content.some((block: { type?: unknown } | null) => block?.type === "tool_result") && claudeImages(entry.uuid, own).length > 0);
  return prompt && sent.hosts.length > 0 ? "inline" : prompt;
}

/**
 * Where the last turn-opening Claude prompt hangs, and whether an assistant entry has
 * answered it since. A prompt Claude Code cancelled before any reply is written again as
 * the re-send's sibling (same parentUuid): it continues the cancelled prompt's turn rather
 * than opening a new one, so the cancelled record never settles into a page that reparses
 * without it — the same sibling rule parseClaudeTranscript applies to the bytes.
 */
export interface PromptChain { parent: string | null; answered: boolean }

export function turnStarts(bytes: Buffer, source: StreamSource, chain: PromptChain = { parent: null, answered: true }, blobs: string | null = null): number[] {
  const starts: number[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const newline = bytes.indexOf(0x0a, offset);
    const end = newline === -1 ? bytes.length : newline;
    const line = bytes.subarray(offset, end);
    if (source === "claude-transcript" && line.includes('"type":"assistant"')) chain.answered = true;
    // a queued attachment carrying another session's message has no "user" in it: its own mark
    const candidate = line.includes(TURN_MARK[source]) || (source === "claude-transcript" && line.includes(PEER_MARK));
    const opens = candidate ? opensTurn(source, line.toString("utf8"), blobs) : false;
    if (opens) {
      if (source === "claude-transcript") {
        let parent: string | null = null;
        let peer = false;
        try {
          const entry = JSON.parse(line.toString("utf8")) as TranscriptEntry | null;
          const uuid: unknown = entry?.parentUuid;
          parent = typeof uuid === "string" ? uuid : null;
          peer = claudePeerNotice(entry) !== null;
        } catch { /* opensTurn already read the line as JSON */ }
        // another session's message is never a re-send of this session's prompt: it opens a turn and
        // leaves the prompt chain as it was, so the human re-send rule below still sees its own prompts
        if (peer) { starts.push(offset); offset = end + 1; continue; }
        // a re-send of an unanswered prompt opens no turn of its own
        if (opens === true && (chain.answered || parent === null || parent !== chain.parent)) starts.push(offset);
        chain.parent = parent;
        chain.answered = false;
      } else {
        starts.push(offset);
      }
    }
    offset = end + 1;
  }
  return starts;
}
