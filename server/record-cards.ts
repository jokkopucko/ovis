import type { InteractivePrompt } from "../shared/protocol.ts";
import { paneTranscript, type NativeTranscript } from "./conversation.ts";
import { ConversationUnavailable } from "./conversation-shared.ts";
import { lettaMessagesPath } from "./letta-store.ts";
import { grokHeldTranscript } from "./grok-store.ts";
import { paneProcessInfo, sessionSnapshot } from "./herdr/client.ts";
import { readKiroV3MessagesTail } from "./kiro.ts";
import { FileBusyError, fileTask } from "./file-pool.ts";
import { AgyUnavailable, agyPendingStepsOffThread } from "./agy.ts";
import { hermesPendingMessagesOffThread } from "./hermes.ts";
import { SnapshotUnavailable } from "./sqlite-snapshot.ts";
import { type AgentRecord, type RecordRequest, commandCut, withRecord } from "./dialogs/record.ts";
import { parsedByPublicPrompt, publicPrompt } from "./dialogs/shared.ts";
import { gjcRecord } from "./dialogs/gjc-record.ts";
import { lettaRecord } from "./dialogs/letta-record.ts";
import { grokRecord } from "./dialogs/grok-record.ts";
import { copilotRecord } from "./dialogs/copilot-record.ts";
import { museRecord } from "./dialogs/muse-record.ts";
import { agyRecord } from "./dialogs/agy-record.ts";
import { hermesRecord } from "./dialogs/hermes-record.ts";
import { kiroRecord } from "./dialogs/kiro-record.ts";

/**
 * Where an agent's record of a pane's session says which command waits (`read`), and the dialog that shows it.
 */
interface RecordSource {
  readonly record: Omit<AgentRecord, "pending">;
  /** The request the record holds open, null when it holds none, undefined when no record of the pane's session was found. */
  read(paneId: string): Promise<RecordRequest | null | undefined>;
}

/** A request named by the record it is read from too, so the same call id in another session is another request. */
function within(record: string, request: RecordRequest | null): RecordRequest | null {
  return request === null ? null : { ...request, id: `${record}\0${request.id}` };
}

/** A record kept in a session file the agent appends to, found as the pane's conversation is: its last lines are read. */
function sessionFile(record: AgentRecord, file: (transcript: NativeTranscript) => string | null): RecordSource {
  return { record, read: async (paneId) => { const path = file(await paneTranscript(paneId)); return path === null ? undefined : within(path, record.pending(await tail(path))); } };
}

/** Grok's session as herdr names it, or else the one its process holds (grok-store.ts `grokHeldTranscript`). */
async function grokSessionFile(paneId: string): Promise<string | null> {
  try {
    const found = await paneTranscript(paneId);
    if (found.source === "grok-transcript") return found.path;
  } catch (error) {
    if (!(error instanceof ConversationUnavailable)) throw error;
  }
  const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
  return pane === undefined ? null : await grokHeldTranscript(pane);
}

/** The agents that answer their approvals in their own dialog only (no hook Ovis can hold them with). */
const RECORDS: Readonly<Record<string, RecordSource>> = {
  gjc: sessionFile(gjcRecord, (found) => found.source === "gjc-transcript" ? found.path : null),
  muse: sessionFile(museRecord, (found) => found.source === "muse-transcript" ? found.path : null),
  copilot: sessionFile(copilotRecord, (found) => found.source === "copilot-transcript" ? found.path : null),
  // the local backend's messages, which Letta appends to as the turn goes; its transcript waits for the turn's end
  letta: sessionFile(lettaRecord, (found) => found.source === "letta-transcript" && found.letta ? lettaMessagesPath(found.letta.store, found.letta.agent, found.letta.conversation) : null),
  grok: { record: grokRecord, read: async (paneId) => { const path = await grokSessionFile(paneId); return path === null ? undefined : within(path, grokRecord.pending(await tail(path))); } },
  // the conversation database, read from a private copy on a file thread (agy.ts)
  agy: { record: agyRecord, read: async (paneId) => {
    const found = await paneTranscript(paneId);
    return found.source === "agy-transcript" ? within(found.path, agyRecord.pending(await agyPendingStepsOffThread(found.path))) : undefined;
  } },
  // state.db, read the same way (hermes.ts)
  // its own dangerous-command panel card takes it (prompt.ts), the generic card too
  hermes: { record: hermesRecord, read: async (paneId) => {
    const found = await paneTranscript(paneId);
    return found.source === "hermes-transcript"
      ? within(`${found.path}\0${found.sessionId}`, hermesRecord.pending(await hermesPendingMessagesOffThread(found.path, found.sessionId))) : undefined;
  } },
  // Kiro CLI V3's messages.jsonl, read under a single lease- and inode-verified binding (kiro.ts)
  // its own approval card takes it (prompt.ts), the generic card too
  kiro: { record: kiroRecord, read: async (paneId) => {
    const info = await paneProcessInfo(paneId).catch(() => null);
    const found = await readKiroV3MessagesTail(info);
    return found === null ? undefined : within(`${found.path}\0${found.identity}`, kiroRecord.pending(found.text));
  } },
};

export function recordFor(agent: string): Omit<AgentRecord, "pending"> | undefined {
  return RECORDS[agent]?.record;
}

/** A session file's last lines (record-tail.ts), read on a file thread. */
async function tail(path: string): Promise<string> {
  return await fileTask<string>({ op: "record-tail", path });
}

/**
 * The request the pane's agent's record holds open, or null when nothing proves one: no record for this agent, no
 * session found for the pane, or a record that cannot be read as expected (logged once per agent and error). The
 * card then stays the screen's own, and a key for a card read from the record is refused.
 */
const unreadable = new Set<string>();

export async function recordRequest(paneId: string, agent: string): Promise<RecordRequest | null> {
  return (await readRecord(paneId, agent)) ?? null;
}

/** The record's open request as `read` gives it; undefined for no record, one not found or one that cannot be read. */
async function readRecord(paneId: string, agent: string): Promise<RecordRequest | null | undefined> {
  const source = RECORDS[agent];
  if (source === undefined) return undefined;
  try {
    return await source.read(paneId);
  } catch (error) {
    if (error instanceof ConversationUnavailable || error instanceof FileBusyError || error instanceof AgyUnavailable || error instanceof SnapshotUnavailable
      || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    const kind = `${agent}\0${error instanceof Error ? error.name : typeof error}`;
    if (!unreadable.has(kind)) {
      unreadable.add(kind);
      console.warn(`prompt: ${agent}'s record could not be read for pane ${paneId}; its card stays the screen's (${error instanceof Error ? error.message : String(error)})`);
    }
    return undefined;
  }
}

/** What the record says of a request after its card's key went (recordSettled). */
export type RecordOutcome = "closed" | "open" | "unread";

const SETTLE_MS = 1_000;
const LOOK_MS = 100;

/**
 * Whether request `id`, which the record held when its card's key went, is closed now, looked at for at most a second:
 * "closed" when the record is read and holds no request or another one, "open" when it still holds that one by then (a
 * key that did not take, or an agent that leaves a refused request open in its record, as Letta does), "unread" when
 * no record could be read. None of them is a reason to send anything again.
 */
export async function recordSettled(paneId: string, agent: string, id: string, settleMs = SETTLE_MS, read = readRecord): Promise<RecordOutcome> {
  const deadline = Date.now() + settleMs;
  for (;;) {
    // a read still under way at the deadline proves nothing
    const request = await Promise.race([read(paneId, agent), Bun.sleep(Math.max(0, deadline - Date.now())).then(() => "late" as const)]);
    if (request === "late" || request === undefined) return "unread";
    if (request?.id !== id) return "closed";
    if (Date.now() + LOOK_MS > deadline) return "open";
    await Bun.sleep(LOOK_MS);
  }
}

/**
 * A generic card for the pane, with the command its agent's record holds when the dialog on the screen shows it whole;
 * none for a dialog that says it cut its command (`cut`), which the terminal answers.
 */
export async function withAgentRecord(paneId: string, agent: string, card: InteractivePrompt, screen: string): Promise<InteractivePrompt | null> {
  const source = RECORDS[agent];
  const parsed = parsedByPublicPrompt.get(card);
  if (source === undefined || parsed === undefined || !parsed.responder.startsWith("fallback")) return card;
  if (commandCut(screen, source.record)) return null;
  const shown = withRecord(parsed, await recordRequest(paneId, agent), screen, source.record);
  return shown === parsed ? card : publicPrompt(shown);
}

/** Same as `withAgentRecord`, reusing an already-resolved gjc session file path so callers avoid a second transcript lookup. */
export async function withGjcRecordAt(paneId: string, card: InteractivePrompt, screen: string, path: string | null): Promise<InteractivePrompt | null> {
  const parsed = parsedByPublicPrompt.get(card);
  if (parsed === undefined || !parsed.responder.startsWith("fallback")) return card;
  if (commandCut(screen, gjcRecord)) return null;
  if (path === null) return card;
  let request: RecordRequest | null = null;
  try {
    request = within(path, gjcRecord.pending(await tail(path)));
  } catch (error) {
    if (!(error instanceof FileBusyError) && (error as NodeJS.ErrnoException).code !== "ENOENT") {
      const kind = `gjc\0${error instanceof Error ? error.name : typeof error}`;
      if (!unreadable.has(kind)) {
        unreadable.add(kind);
        console.warn(`prompt: gjc's record could not be read for pane ${paneId}; its card stays the screen's (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }
  const shown = withRecord(parsed, request, screen, gjcRecord);
  return shown === parsed ? card : publicPrompt(shown);
}
