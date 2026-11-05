/**
 * @eko24ive/pi-ask's ask_user form as a chat card (#1202), through the web UI's pi extension
 * (integrations/pi-ask.ts, shared/pi-ask-bridge.ts). pi-ask draws its own widget, which no screen
 * reader follows, and its only supported answer channel is its `pi.events` submit event: the card
 * is read from the extension and answered through it, never with keys.
 *
 * A card is shown only when every fact agrees: the pane's one foreground process with a bridge
 * socket answers for its own pid, writes the session file herdr reports for the pane, has exactly
 * one form open, and that form's ask_user call is still open in that session file (pi-ask's own
 * rule, src/pending-ask.ts). Anything else, and pi without the extension, keeps the terminal.
 * Windows has no socket: the terminal there too.
 *
 * pi-ask takes every answer at once, so the card asks one question per step and keeps the earlier
 * steps' answers here until the last one is given, as OpenCode's form does (prompt.ts).
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  PI_ASK_BRIDGE_DIRECTORY,
  type PiAskBridgeState,
  type PiAskFlow,
  type PiAskQuestion,
  type PiAskRemoteAnswer,
  type PiAskSubmitReply,
  type PiAskSubmitRequest,
} from "../shared/pi-ask-bridge.ts";
import type { PromptAnswer } from "../shared/protocol.ts";
import { finishPrompt, own, type ParsedPrompt, type PromptDraft } from "./dialogs/shared.ts";
import { paneProcessInfo } from "./herdr/client.ts";
import { badRequest, jsonResponse } from "./http.ts";
import { piPaneAgentDirs, piTranscriptPath } from "./pi.ts";

const STATE_READ_MS = 1_000;
/** The extension gives pi-ask 3 s to confirm; this covers that and the socket round trip. */
const SUBMIT_MS = 4_000;
const MAX_QUESTIONS = 20;
const MAX_OPTIONS = 50;
const MAX_TEXT = 12_000;
const MAX_ANSWERS_JSON = 65_536;

export interface PiAskUserForm {
  socket: string;
  pid: number;
  /** The session file as the extension names it: it checks the same string before it submits. */
  sessionFile: string;
  transcript: string;
  flow: PiAskFlow;
  stepIndex: number;
  revision: number;
}

const isString = (value: unknown, max = MAX_TEXT): value is string => typeof value === "string" && value.length <= max;
const optionalString = (value: unknown): boolean => value === undefined || isString(value);

function validQuestion(value: unknown): value is PiAskQuestion {
  if (typeof value !== "object" || value === null) return false;
  const question = value as Record<string, unknown>;
  const options = question["options"];
  if (!isString(question["id"], 256) || !question["id"] || !isString(question["prompt"]) || !optionalString(question["label"])
    || !(question["type"] === undefined || question["type"] === "single" || question["type"] === "multi" || question["type"] === "preview")
    || !Array.isArray(options) || options.length > MAX_OPTIONS) return false;
  const values = new Set<string>();
  for (const option of options as unknown[]) {
    if (typeof option !== "object" || option === null) return false;
    const { value: id, label, description, preview, recommended } = option as Record<string, unknown>;
    if (!isString(id, 1_024) || !isString(label) || !optionalString(description) || !optionalString(preview)
      || !(recommended === undefined || typeof recommended === "boolean") || values.has(id)) return false;
    values.add(id);
  }
  return true;
}

/** The form as the extension reports it, when it has the shape pi-ask 1.2.0 sends. */
function validFlow(value: unknown): PiAskFlow | null {
  if (typeof value !== "object" || value === null) return null;
  const flow = value as Record<string, unknown>;
  const questions = flow["questions"];
  if (!isString(flow["flowId"], 1_024) || !isString(flow["toolCallId"], 1_024) || !flow["toolCallId"] || !optionalString(flow["title"])
    || typeof flow["createdAt"] !== "number" || !Array.isArray(questions) || questions.length === 0 || questions.length > MAX_QUESTIONS
    || !questions.every(validQuestion) || new Set(questions.map((question) => question.id)).size !== questions.length) return null;
  return value as PiAskFlow;
}

function sameFlow(live: PiAskFlow | null, read: PiAskFlow): boolean {
  return live !== null && live.flowId === read.flowId && live.toolCallId === read.toolCallId && live.createdAt === read.createdAt
    && (live.title ?? null) === (read.title ?? null) && JSON.stringify(live.questions) === JSON.stringify(read.questions);
}

/**
 * Only a socket this user owns, in a directory only this user can enter, speaks for a pi: a
 * PI_CODING_AGENT_DIR another user can write to must not let them show a card or read its answer.
 */
function ownSocket(socket: string): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  try {
    const directory = lstatSync(dirname(socket));
    const file = lstatSync(socket);
    return directory.isDirectory() && directory.uid === uid && (directory.mode & 0o077) === 0 && file.isSocket() && file.uid === uid;
  } catch { return false; }
}

function sameFile(left: string, right: string): boolean {
  try { return realpathSync(left) === realpathSync(right); } catch { return false; }
}

async function bridgeState(socket: string, signal?: AbortSignal): Promise<PiAskBridgeState | null> {
  try {
    const timeout = AbortSignal.timeout(STATE_READ_MS);
    const response = await fetch("http://localhost/v1/state", { unix: socket, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) return null;
    const state = await response.json() as PiAskBridgeState;
    return typeof state === "object" && state !== null && state.version === 1 && Array.isArray(state.flows) ? state : null;
  } catch {
    return null; // no extension listening (a socket a crashed pi left), or too slow: the terminal
  }
}

/** pi-ask's reply, or null when it is not known whether pi took the answer. */
async function submit(socket: string, request: PiAskSubmitRequest, signal: AbortSignal): Promise<PiAskSubmitReply | null> {
  try {
    const response = await fetch("http://localhost/v1/submit", {
      unix: socket, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
      signal: AbortSignal.any([signal, AbortSignal.timeout(SUBMIT_MS)]),
    });
    const reply = await response.json() as PiAskSubmitReply;
    if (reply?.ok === true) return { ok: true };
    return reply?.ok === false && reply.error !== "timeout" && typeof reply.message === "string" ? reply : null;
  } catch {
    return null;
  }
}

export interface BoundPiAskFlow { socket: string; pid: number; sessionFile: string; flow: PiAskFlow }


async function foregroundPids(paneId: string): Promise<number[]> {
  return ((await paneProcessInfo(paneId).catch(() => undefined))?.foreground_processes ?? [])
    .flatMap((process) => typeof process.pid === "number" ? [process.pid] : []);
}


/**
 * Whether the pane's foreground pi has a pi-ask form open, as its extension says, with no session
 * needed: pi writes no session file before its first answer, and a form from `/answer` needs no
 * tool call. "active": a form pi-ask reported open, or an ask_user call still open on pi's live
 * branch (a pi-ask that sends no started event still has its call there). "inactive": the
 * extension answered with neither, from pi's live state (a /tree move that writes nothing leaves
 * the session file behind it). "absent": no extension serves the pane's pi, or pi could not say
 * which calls are open: the session file decides. "unknown" (the pane's processes
 * unreadable, a socket that is not this user's alone, a read that failed or answers for another
 * pid) is never room for keys. Every candidate socket is asked: more than one is no reason to stop.
 */
export type PiAskActivity = "active" | "inactive" | "absent" | "unknown";
export async function piAskActivity(paneId: string, signal?: AbortSignal): Promise<PiAskActivity> {
  if (process.platform === "win32") return "absent";
  const { pids, agentDirs } = await piPaneAgentDirs(paneId);
  const directories = agentDirs.map((agentDir) => join(agentDir, PI_ASK_BRIDGE_DIRECTORY)).filter((directory) => existsSync(directory));
  if (directories.length === 0) return "absent";
  if (pids === null) return "unknown";
  // the strongest answer wins: active, then unknown, then inactive; absent only when no socket answered
  let unknown = false;
  let answered = false;
  for (const directory of directories) {
    for (const pid of pids) {
      const socket = join(directory, `${pid}.sock`);
      try { lstatSync(socket); } catch { continue; }
      if (!ownSocket(socket)) { unknown = true; continue; }
      const state = await bridgeState(socket, signal);
      if (!state || state.pid !== pid) unknown = true;
      else if (state.flows.length > 0 || Array.isArray(state.openCalls) && state.openCalls.length > 0) return "active";
      else answered = true;
    }
  }
  if (unknown) return "unknown";
  // the answer is for the pis in front when the reads began: another one in front now is not known
  const after = await foregroundPids(paneId).catch(() => null);
  if (after === null || [...new Set(after)].sort().join() !== [...new Set(pids)].sort().join()) return "unknown";
  return answered ? "inactive" : "absent";
}

/**
 * The pane's pi-ask forms, as the pane's pi tells the extension. `transcript`: the pane's session
 * file and the agent directory of its pi process (piTranscriptPath).
 */
export async function bindPiAsk(
  paneId: string,
  transcript: { path: string; agentDir: string | null },
  signal?: AbortSignal,
): Promise<BoundPiAskFlow | null> {
  if (process.platform === "win32" || transcript.agentDir === null) return null;
  const directory = join(transcript.agentDir, PI_ASK_BRIDGE_DIRECTORY);
  // without the extension, nothing more is asked of herdr
  if (!existsSync(directory)) return null;
  const sockets = [...new Set(await foregroundPids(paneId))].map((pid) => ({ pid, socket: join(directory, `${pid}.sock`) })).filter(({ socket }) => ownSocket(socket));
  if (sockets.length !== 1) return null;
  const { pid, socket } = sockets[0]!;
  const state = await bridgeState(socket, signal);
  if (!state || state.pid !== pid) return null;
  if (typeof state.sessionFile !== "string" || !sameFile(state.sessionFile, transcript.path) || !Array.isArray(state.openCalls)) return null;
  // pi's live branch, not the file's last line: a /tree move writes nothing. Only a form whose call
  // pi-ask still waits on there counts: one it dropped without a completed event has its call
  // settled, and one with no call (`/answer`, `/ask:replay`) is never a card
  const open = state.openCalls;
  const waiting = state.flows.filter((flow) => {
    const toolCallId = (flow as { toolCallId?: unknown } | null)?.toolCallId;
    return typeof toolCallId === "string" && open.includes(toolCallId);
  });
  const flow = waiting.length === 1 ? validFlow(waiting[0]) : null;
  return flow ? { socket, pid, sessionFile: state.sessionFile, flow } : null;
}

interface Draft { flowId: string; identity: string; stepIndex: number; answers: Record<string, PiAskRemoteAnswer>; revision: number }

/** Answers by question id with no prototype: an id like `__proto__` is an answer, not a setter. */
function answerMap(from?: Record<string, PiAskRemoteAnswer>): Record<string, PiAskRemoteAnswer> {
  return Object.assign(Object.create(null) as Record<string, PiAskRemoteAnswer>, from);
}

/** Each pane's answers to the steps before the one the card asks. */
const drafts = new Map<string, Draft>();

export function piAskUserPrompt(paneId: string, transcript: string, bound: BoundPiAskFlow): ParsedPrompt {
  const { flow } = bound;
  let draft = drafts.get(paneId);
  const identity = `${flow.createdAt}:${JSON.stringify([flow.title ?? null, flow.questions])}`;
  if (!draft || draft.flowId !== flow.flowId || draft.identity !== identity) {
    draft = { flowId: flow.flowId, identity, stepIndex: 0, answers: answerMap(), revision: (draft?.revision ?? 0) + 1 };
    drafts.delete(paneId);
    drafts.set(paneId, draft);
    if (drafts.size > 64) drafts.delete(drafts.keys().next().value!);
  }
  const stepIndex = Math.min(draft.stepIndex, flow.questions.length - 1);
  const question = flow.questions[stepIndex]!;
  const options: PromptDraft["options"] = question.options.map((option) => ({
    // the card shows a menu's own "(Recommended)" as a tag (PromptCard labelOf)
    label: option.recommended === true ? `${option.label} (Recommended)` : option.label,
    description: [option.description, option.preview].filter((text) => !!text).join("\n") || null,
  }));
  // pi-ask adds "Type your own" to every question (src/state/create.ts)
  options.push({ label: own("Type your own answer"), description: null });
  const custom = options.length - 1;
  const saved = Object.hasOwn(draft.answers, question.id) ? draft.answers[question.id] : undefined;
  const indices = (saved?.values ?? []).map((value) => question.options.findIndex((option) => option.value === value)).filter((index) => index >= 0);
  const multi = question.type === "multi";
  return finishPrompt(
    "pi",
    {
      kind: "question",
      title: flow.title || own("Question"),
      question: question.prompt,
      body: null,
      options,
      multi_select: multi,
      // pi-ask takes checks and typed text together, and never requires an answer (`required` is advisory)
      ...(multi ? { checks_with_text: true as const } : {}),
      optional: true,
      drafts_saved: true,
      custom_option_index: custom,
      steps: flow.questions.length > 1
        ? flow.questions.map((step, index) => ({ label: step.label || own("Question {n}", { n: index + 1 }), answered: Object.hasOwn(draft.answers, step.id), current: index === stepIndex,
          // Native moveTab cycles every question, including unanswered later ones.
          ...(index !== stepIndex ? { can_navigate: true } : {}) }))
        : undefined,
      can_step_back: stepIndex > 0,
      can_step_next: stepIndex < flow.questions.length - 1,
      default_option_index: !multi && indices.length === 1 ? indices[0]! : null,
      default_option_indices: multi && indices.length ? indices : undefined,
      default_custom_text: saved?.customText,
    },
    {
      responder: "pi-ask-user",
      menuLabels: [],
      selectedIndex: 0,
      checkedOptionIndices: [],
      customMenuIndex: custom,
      rejectWithEscapeIndex: null,
      piAskUser: { socket: bound.socket, pid: bound.pid, sessionFile: bound.sessionFile, transcript, flow, stepIndex, revision: draft.revision },
    },
    { call: `${flow.flowId}:${flow.createdAt}:${draft.revision}` },
  );
}

const changed = (): Response => jsonResponse({ error: { code: "prompt_changed", message: "The prompt changed before the answer was sent." } }, 409);
const invalid = (message: string): Response => badRequest("invalid_answer", message);

/**
 * One step's answer, by option value: what pi-ask takes (docs/remote-events.md). null: skipped,
 * which pi-ask allows for every question. A string: why the answer is refused.
 */
function stepAnswer(question: PiAskQuestion, indices: unknown, text: unknown): PiAskRemoteAnswer | null | string {
  const multi = question.type === "multi";
  if (text !== undefined && (typeof text !== "string" || text.length > MAX_TEXT)) return "Custom text must be a string.";
  const customText = (text as string | undefined)?.trim() || undefined;
  if (indices !== undefined && (!Array.isArray(indices) || indices.some((index) => !Number.isInteger(index) || index < 0 || index >= question.options.length))) {
    return "An option index is outside the displayed range.";
  }
  const values = [...new Set((indices ?? []) as number[])].map((index) => question.options[index]!.value);
  if (!multi && (values.length > 1 || values.length === 1 && customText)) return "This question takes one choice.";
  if (values.length === 0 && !customText) return null;
  if (!multi) return customText ? { customText } : { values };
  return customText ? { values, customText } : { values };
}

/**
 * Answers the card's step: earlier steps are kept, the last one sends every answer to pi-ask.
 * `answered`: pi-ask took the answers and closed its form.
 */
export async function answerPiAskUser(paneId: string, parsed: ParsedPrompt, body: PromptAnswer, signal: AbortSignal): Promise<{ response: Response; answered: boolean }> {
  const form = parsed.piAskUser!;
  const done = (response: Response, answered = false) => ({ response, answered });
  const draft = drafts.get(paneId);
  if (!draft || draft.flowId !== form.flow.flowId || draft.revision !== form.revision) return done(changed());
  const question = form.flow.questions[form.stepIndex]!;

  if (body.step_back === true || body.step_next === true || body.step_index !== undefined) {
    if (body.option_index !== undefined || body.option_indices !== undefined || body.custom_text !== undefined
      || [body.step_back === true, body.step_next === true, body.step_index !== undefined].filter(Boolean).length !== 1) {
      return done(invalid("Exactly one supported navigation action is required."));
    }
    const target = body.step_index ?? form.stepIndex + (body.step_next === true ? 1 : -1);
    const reachable = Number.isInteger(target) && target >= 0 && target < form.flow.questions.length && target !== form.stepIndex;
    if (!reachable) return done(invalid("Invalid question to navigate to."));
    if (body.draft !== undefined) {
      if (typeof body.draft !== "object" || body.draft === null || !Array.isArray(body.draft.option_indices) || typeof body.draft.custom_text !== "string") return done(invalid("Invalid draft."));
      // the card keeps a typed answer over a single question's saved pick
      const indices = question.type !== "multi" && body.draft.custom_text.trim() ? [] : body.draft.option_indices;
      const edits = stepAnswer(question, indices, body.draft.custom_text);
      if (typeof edits === "string") return done(invalid(edits));
      if (edits === null) delete draft.answers[question.id];
      else draft.answers[question.id] = edits;
    }
    draft.stepIndex = target;
    draft.revision++;
    return done(jsonResponse({ ok: true }));
  }
  if (body.draft !== undefined) return done(invalid("Exactly one answer is required."));

  let answer: PiAskRemoteAnswer | null | string;
  if (body.option_index !== undefined) {
    answer = body.option_indices !== undefined || body.custom_text !== undefined || question.type === "multi"
      ? "A valid option index is required."
      : stepAnswer(question, [body.option_index], undefined);
  } else {
    // a typed answer alone (the composer, or an older card's Send) keeps the checks the card shows as saved
    const saved = question.type === "multi" && body.option_indices === undefined
      ? ((Object.hasOwn(draft.answers, question.id) ? draft.answers[question.id]!.values : undefined) ?? []).map((value) => question.options.findIndex((option) => option.value === value)).filter((index) => index >= 0)
      : body.option_indices;
    answer = body.option_indices !== undefined && question.type !== "multi"
      ? "This question takes one choice."
      : stepAnswer(question, saved, body.custom_text);
  }
  if (typeof answer === "string") return done(invalid(answer));
  const answers = answerMap(draft.answers);
  if (answer === null) delete answers[question.id];
  else answers[question.id] = answer;
  if (JSON.stringify(answers).length > MAX_ANSWERS_JSON) return done(invalid("The form answers are too large."));
  draft.answers = answers;

  if (form.stepIndex < form.flow.questions.length - 1) {
    draft.stepIndex = form.stepIndex + 1;
    draft.revision++;
    return done(jsonResponse({ ok: true }));
  }

  // the card was read a moment ago: bind it again from the pane, as a read does. The same session
  // herdr reports for the pane, the same pi in its foreground and the very form the card was read
  // from (pi-ask reopens a call's form under the same flowId); a pi pushed into the background
  // still answers on its socket with its own form and session, so the foreground is read again
  // last, right before the answer leaves
  const transcript = await piTranscriptPath(paneId).catch(() => null);
  const card = transcript && "path" in transcript && sameFile(transcript.path, form.transcript) ? await bindPiAsk(paneId, transcript, signal) : null;
  if (!card || card.socket !== form.socket || card.pid !== form.pid || !sameFlow(card.flow, form.flow) || !(await foregroundPids(paneId)).includes(form.pid)) {
    drafts.delete(paneId);
    return done(changed());
  }
  // the extension checks createdAt and the session again as it hands the answer to pi-ask
  const reply = await submit(form.socket, { flowId: form.flow.flowId, createdAt: form.flow.createdAt, sessionFile: form.sessionFile, response: { kind: "answer", mode: "submit", answers } }, signal);
  if (reply === null) {
    return done(jsonResponse({ error: { code: "bridge_unconfirmed", message: "pi did not confirm the answer. Check the question in the terminal before sending again." } }, 504));
  }
  if (reply.ok) {
    drafts.delete(paneId);
    return done(jsonResponse({ ok: true }), true);
  }
  if (reply.error === "flow_not_found") {
    drafts.delete(paneId);
    return done(changed());
  }
  return done(jsonResponse({ error: { code: "reply_failed", message: `pi-ask did not take the answer: ${reply.message}` } }, 502));
}
