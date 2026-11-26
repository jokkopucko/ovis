import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { createPortal, flushSync } from "react-dom";
import { legacyEditText } from "../../shared/edit-output.ts";
import {
  ArrowDown, BookOpen, Check, ChevronDown, ChevronRight, Circle, CircleAlert, CircleCheck, CircleDot, CircleQuestionMark, CircleSlash, CircleX, Copy, Hourglass, Layers, SquareTerminal, Target,
  type LucideProps,
} from "lucide-react";

import "./ChatView.css";
// the timeline's styles stay in the entry: its chunk loads apart (chatTimelineLoader.ts), but
// .chat-frame and the loading state are drawn before it arrives
import "./ChatTimeline.css";

import { AgentMark } from "./AgentMark.tsx";
import { AnimatedHeight } from "./AnimatedHeight.tsx";
import { Markdown, ReservedImage } from "./Markdown.tsx";
import { ChatMarkdownImages } from "./ChatMarkdownImages.tsx";
import { ImageLightbox } from "./ImageLightbox.tsx";
import { PromptCard } from "./PromptCard.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { loadChatTimeline, loadedChatTimeline, useChatTimeline } from "./chatTimelineLoader.ts";
import { ChatMinimap } from "./ChatMinimap.tsx";
import { minimapTurns } from "../lib/chatMinimap.ts";
import type { LegendListRef } from "@legendapp/list/react";
import { continuesHistory, createChatRowSlots, growChatRowSlots, prependChatRowSlots } from "../lib/chatRows.ts";
import { ChatDetails, ChatRowMemoryContext, chatRowMemory, useChatRowToggle, useRowFocus, type ChatRowMemory } from "../lib/chatRowState.tsx";
import { turnRevision } from "../lib/turnRevision.ts";
import { conversationFinishEvidence, conversationFinishPresented } from "../lib/panePresentation.ts";
import { seenKey } from "../lib/seenFinishes.ts";
import { useWholeOutput as useScopedOutput } from "../lib/useWholeOutput.ts";
import { turnSkills } from "../lib/skillActivity.ts";
import { ApiError, pinPaneConversation, unpinPaneConversation } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { plainText } from "../lib/plainText.ts";
import type { GalleryImage } from "../lib/imageViewer.ts";
import { toolGalleryImage, userGalleryImages } from "../lib/chatImages.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { toTranscriptMessages, type TranscriptMessage } from "../lib/transcript.ts";
import { answerItems, endedOnAnswer, foldedRequestsMatch, isLiveWorkTurn, isWaitingWorkTurn, formatWorkDuration, runNames, splitTurn, turnSegments, type WorkSegment, todoGroups, visibleWorkParts, workBlockStartsOpen, workFailed, workSummary, type TodoAttempt, type TodoGroup, type ToolPart as ToolPartType } from "../lib/workBlocks.ts";
import { phaseRows, planRows, taskRows, todoRows, type ChecklistRow } from "../lib/checklist.ts";
import { isTodoTool, parseTodoAnswer, todoCallSummary, todoSnapshot, type TodoItem, type TodoStatus } from "../lib/todos.ts";
import { formatGoalTime, goalWaitSources, goalWaitUntil, turnGoal, type GoalState, type GoalStatus } from "../lib/goals.ts";
import { publishSessionStats, sessionStats } from "../lib/sessionStats.ts";
import { HISTORY_PROMPTS, useSettings } from "../lib/settings.ts";
import { learnFromConversation } from "../lib/tabLabels.ts";
import { PAGE_OVERLAP_ROWS, pageScrollDistance } from "../lib/pageScroll.ts";
import { dropPendingListScroll, listEndPadded } from "../lib/followScroll.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { statusEdgeRead } from "../lib/status.ts";
import { askedQuestions } from "../../shared/askQuestions.ts";
import { forgetWaitingBaseline, settleWaitingSends, waitingKey } from "../lib/sentWaiting.ts";
import { SentWaitingList, useWaitingSends } from "./SentWaiting.tsx";
import { ConversationRefresh } from "../lib/conversationRefresh.ts";
import { teammateMessageParts, type TeammateMessage } from "../lib/teammateMessage.ts";
import { usePageVisible } from "../lib/visibility.ts";
import { dismissKeyboardOn } from "../lib/keyboard.ts";
import { useFacesArrived } from "../lib/fontFaces.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { foldToolOutput } from "../../shared/markdown.ts";
import { FileNameLookupContext, useFileNameLookup } from "../lib/fileNameLookup.ts";
import { toolPathLabel, toolPathRoot } from "../lib/workspacePath.ts";
import { linkFilePaths } from "./FilePathLink.tsx";
import { patchText } from "../../shared/patch.ts";
import { workRowLabel } from "../lib/workRowLabel.ts";
import { toolDisplayName } from "../lib/toolVerbs.ts";
import { machinePath, paneStorageId } from "../../shared/machines.ts";
import { chatRestoreIndex, chatTurnAnchor, drawnMatch, readChatPosition, rememberChatPosition, type ChatPosition } from "../lib/chatScrollMemory.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { skillSyntax } from "../../shared/skill-syntax.ts";
import { createSkillMatcher, type SkillMatcher } from "../lib/skillMentions.ts";
import { lineDiff } from "../lib/diff.ts";
import { agentDisplayLabel, endsWithTurn, formatTokens, stoppedTurn, type TurnIdentity } from "../lib/compose.ts";
import { formatElapsed, taskCallItems, taskResultMarkdown } from "../lib/omoTasks.ts";
import { sendUserFileCall } from "../lib/sendUserFile.ts";
import { LINE_IMAGES_SHOWN, LINE_IMAGES_SHOWN_TOUCH, lineImages, linePictures, previewPlace, workImages, type WorkImage } from "../lib/workImages.ts";
import { shouldFoldUserMessage } from "../lib/userMessageFold.ts";
import { invalidatePaneCommands } from "../lib/paneCommandCache.ts";
import { agentName } from "../lib/runtimeMove.ts";
import { afterMove, isSessionChange, moveCommand, noteCatalogChanges, type HistoryMove, outcomeChip, outcomeCommand, outcomeLabel, outcomeNote, outcomeResultText, outcomeRows, type OutcomeState } from "../lib/outcomeChip.ts";
import { typedTerminalCommand } from "../lib/compose.ts";
import { usePaneCommands } from "../lib/usePaneCommands.ts";
import { commandScreenClosed, sentOutcome, type TerminalPeek } from "../lib/terminalPeek.ts";

const SCROLL_INPUT_MS = 500;
// How far the reader's own upward move may leave the end and still follow: only endpoint rounding.
const READER_ALLOWANCE_PX = 1;
// Without a reader input event or a known layout correction, an upward scroll must leave
// this much room below the view before it stops following (screen readers, Firefox scrollbars).
const LAYOUT_ALLOWANCE_PX = 48;
const LARGEST_PAGE = 50;
const ChatPaneContext = createContext<string | null>(null);
const ChatHistoryContext = createContext("");
/**
 * The viewer is held by ChatView, not by the row: a virtualized row unmounts once it scrolls out of
 * the render window (the transcript follows new output while the viewer is open), and it must not
 * take the open viewer with it.
 */
const ImageViewerContext = createContext<(images: GalleryImage[], index: number) => void>(() => {});
const ToolPathRootContext = createContext<string | null>(null);
import type { TypedAnswer } from "../lib/promptAnswer.ts";
import { polledPrompt, screenWordsToShow } from "../lib/promptText.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";
import { getMemoryCardText, heldCardTextFor, setCardText } from "../lib/cardText.ts";
import { composerDraftKey, composerDrafts } from "../lib/composerDraft.ts";
import type { ConversationSearchMatch } from "../../shared/conversation-search.ts";
import { pickAhead, pickedTurn, pickSettled } from "../../shared/conversation-search.ts";
import type { AgentStatus, CommandOutcome, ConversationMetadata, ConversationPart, ConversationResponse, ConversationTurn, InteractivePrompt, OmoTaskResult, PendingMessage, SlashCommand } from "../../shared/protocol.ts";
import { chatIsBlank, type ChatRead } from "../lib/greeting.ts";
import { TurnTime } from "./TurnTime.tsx";
import { currentLocale, useT } from "../lib/i18n.ts";
import { offersRetry, userFailure, type UserFailure } from "../lib/userError.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { replyCommentsKey } from "../lib/replyComments.ts";
import { ReplyCommentAction } from "./ReplyComments.tsx";
import { ConversationSearch, type RevealResult } from "./ConversationSearch.tsx";
import { useResourceUrl } from "../lib/useResourceUrl.ts";

/** Slow reads in a row the chat waits through quietly before it alarms: about 50 s at the local 15 s deadline. */
const SLOW_READS_BEFORE_ALARM = 3;

function FailureLine({ action, failure, onRetry }: { action: string; failure: UserFailure; onRetry: () => void }) {
  const t = useT();
  const slow = failure.kind === "slow";
  const line = slow ? t("The PC isn't responding") : failure.cause === null ? action : `${action} · ${failure.cause}`;
  return <div className="chat-inline-error chat-failure" role="alert">
    <span className="chat-failure-line">{line}</span>
    {offersRetry(failure) && <button type="button" className="btn chat-failure-retry" onClick={onRetry}>{t("Try again")}</button>}
    {(failure.advice !== null || failure.detail !== null) && <details className="chat-failure-details">
      <summary>{t("Details")}</summary>
      {failure.advice !== null && <p>{failure.advice}</p>}
      {failure.detail !== null && <code>{failure.detail}</code>}
    </details>}
  </div>;
}

const TRANSCRIPT_LINES = 400;
const PROMPT_POLL_MS = 2000;
/**
 * herdr can say blocked before the agent has drawn its question: while the pane waits and no read
 * has found the question yet, the next reads come this soon, this many times, before the poll's 2 s.
 */
const BLOCKED_PROMPT_READ_MS = 250;
const BLOCKED_PROMPT_READS = 6;
/**
 * How long herdr's status may still say working after a turn's final answer is drawn: it trailed the
 * transcript by 100–400 ms at the Claude Code turn ends measured. Twice the longest, and still short
 * enough that a turn the agent begins by itself shows its Working head within a second.
 */
const ANSWER_STATUS_LAG_MS = 800;
/**
 * How long a Claude turn stays "Working…" after herdr's status rests before its answer is read: the
 * transcript trailed the status by up to about 1 s at the turn ends measured (#2550).
 */
const ANSWER_READ_WAIT_MS = 2_000;
const PROMPT_STALE_READS = 2;
/** The prompt each pane's chat last read (by paneStorageId): a chat drawn again (back from the
 * Terminal lens) shows its card before paint, as it shows its turns, while its first read revalidates
 * it. Only while herdr still says the pane waits, and for the session it was read in: one answered in
 * the terminal, or asked by the pane's session before, is not drawn again. Another herdr's pane IDs
 * forget it (lib/paneLifetime.ts). */
const lastPrompts = new Map<string, { machineId: string; session: string | null; prompt: InteractivePrompt }>();
paneLifetimes.onRetire((machineId) => {
  for (const [key, kept] of lastPrompts) if (kept.machineId === machineId) lastPrompts.delete(key);
});
const keptPrompt = (kept: { session: string | null; prompt: InteractivePrompt } | undefined, session: string | null): InteractivePrompt | null =>
  kept !== undefined && kept.session === session ? kept.prompt : null;
const LOAD_OLDER_PX = 400;
// a kept row with no time to bound the search: at most this many earlier pages are read to find it
const RESTORE_PAGES = 10;

export interface ChatViewProps {
  presentationKey?: string;
  finishEpoch?: string;
  finishId?: number;
  paneId: string;
  active?: boolean;
  visible?: boolean;
  pageScroll?: { current: ((direction: -1 | 1) => void) | null };
  refreshKey: number;
  invalidationKey?: number;
  onConversationWatch?: (paneId: string, enabled: boolean) => void;
  conversationPushes?: boolean;
  onTerminalOutput?: (listener: (() => void) | null) => void;
  sentKey?: number;
  unsentKey?: number;
  pendingRows?: readonly Pick<PendingMessage, "id" | "state">[];
  localSend?: { key: number; navigationGeneration: number };
  navigation?: { current: number };
  connected: boolean;
  ended: boolean;
  agent: string | null;
  agentStatus?: AgentStatus;
  agentSession?: string | null;
  onMetadata?: (paneId: string, metadata: ConversationMetadata | null) => void;
  onRead?: (paneId: string, read: ChatRead | null) => void;
  greeted?: boolean;
  onPrompt?: (paneId: string, prompt: InteractivePrompt | null, answered?: boolean) => void;
  onSuggestion?: (paneId: string, suggestion: string | null) => void;
  onRestored?: (paneId: string, restored: string | null) => void;
  promptRefreshKey?: number;
  pendingAnswer?: { promptId: string; answer: TypedAnswer } | null;
  onPendingAnswerDone?: (paneId: string, promptId?: string) => void;
  promptDock?: HTMLElement | null;
  onPromptAnswered?: (toMessageBox: boolean) => void;
  title?: string | null;
  onOpenTerminal?: (text: string) => void;
  covered?: boolean;
  peek?: TerminalPeek | null;
  onCommandScreenClosed?: (peek: TerminalPeek) => void;
  onOutcomes?: (paneId: string, ids: readonly string[]) => void;
  /** this connection may type into the pane (it is no watching device or observer): only then can a message be rewound to */
  interactive?: boolean;
  /** this device may only watch (its pairing's permission, not a window that lets another type): the prompt card answers nothing */
  watching?: boolean;
  /** the pane's composer is there to take a quote of a selection: a secret prompt stands in its place */
  quotable?: boolean;
  cwd?: string | null;
  promptContext?: string | null;
  searchRequest?: number;
}



const userText = (turn: ConversationTurn): string => turn.parts.filter((part): part is Extract<ConversationPart, { kind: "text" }> => part.kind === "text").map((part) => part.text).join("\n\n");

function matchTop(row: HTMLElement, words: string): number | null {
  const found = drawnMatch<Node>(row, words);
  if (found === null) return null;
  const range = document.createRange();
  range.setStart(found.start, found.startOffset);
  range.setEnd(found.end, found.endOffset);
  return range.getBoundingClientRect().top - row.getBoundingClientRect().top;
}

interface ChatState {
  activity?: ConversationResponse["activity"];
  source: "conversation" | "scrollback";
  conversationSource?: ConversationResponse["source"];
  turns: ConversationTurn[];
  messages: TranscriptMessage[];
  scrollback?: string;
  truncated: boolean;
  hint?: ConversationResponse["hint"];
  unavailable?: ConversationResponse["unavailable"];
}

const EMPTY_STATE: ChatState = { source: "conversation", turns: [], messages: [], truncated: false };
const NO_ROWS: readonly Pick<PendingMessage, "id" | "state">[] = [];

type ChatRow = { key: string; beforeUser: boolean } & (
  | { turn: ConversationTurn; index: number; outcome: CommandOutcome | null }
  | { turn: null; outcome: CommandOutcome }
);

function conversationState(conversation: ConversationResponse): ChatState {
  return { source: "conversation", conversationSource: conversation.source, turns: conversation.turns, messages: [], truncated: false, activity: conversation.activity };
}


function CopyButton({ text, getText, label, className = "icon-button chat-copy", children, onResult }: { text?: string; getText?: () => string; label: string; className?: string; children?: React.ReactNode; onResult: (ok: boolean) => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    // Derive lazily when a getter is supplied (e.g. an answer's plain text): the conversion runs
    // synchronously inside the click gesture, never while the row renders (TASK-002).
    const ok = await copyText(getText !== undefined ? getText() : text!);
    setCopied(ok);
    onResult(ok);
    if (ok) window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" className={copied ? `${className} is-copied` : className} onClick={() => void copy()} aria-label={copied ? t("Copied") : label} title={copied ? t("Copied") : label}>
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {children}
    </button>
  );
}

function ChecklistView({ rows }: { rows: ChecklistRow[] }) {
  return <ul className="chat-checklist">{rows.map((row, index) => (
    <li key={index} className={row.heading ? "chat-checklist-phase" : row.done ? "is-done" : row.active ? "is-active" : undefined}>
      {!row.heading && <span className="chat-checklist-box" aria-hidden="true">{row.done ? "✓" : "•"}</span>}{row.label}
    </li>
  ))}</ul>;
}

const TODO_ICONS: Record<TodoStatus, ComponentType<LucideProps>> = {
  completed: CircleCheck, in_progress: CircleDot, pending: Circle, blocked: CircleAlert, dropped: CircleSlash,
};
const TODO_LABELS: Record<TodoStatus, string> = {
  completed: "done", in_progress: "in progress", pending: "to do", blocked: "blocked", dropped: "dropped",
};

function TodoList({ items }: { items: TodoItem[] }) {
  const groups: { phase: string | null; items: TodoItem[] }[] = [];
  for (const item of items) {
    const group = groups[groups.length - 1];
    if (group && group.phase === item.phase) group.items.push(item); else groups.push({ phase: item.phase, items: [item] });
  }
  return <div className="todo-list">{groups.map((group, index) => (
    <div key={index} className="todo-group">
      {group.phase !== null && <p className="todo-phase">{group.phase}</p>}
      <ul>{group.items.map((item, row) => {
        const Icon = TODO_ICONS[item.status];
        return <li key={row} className={`todo-item is-${item.status}`}>
          <Icon className="todo-icon" aria-hidden="true" />
          <span className="todo-label">{item.label}<span className="sr-only"> ({TODO_LABELS[item.status]})</span>{item.note && <span className="todo-note">{item.note}</span>}</span>
        </li>;
      })}</ul>
    </div>
  ))}</div>;
}

function ompEditLineClass(line: string): string | undefined {
  if (line.startsWith("+-") || line.startsWith("-") || /^(CUT|REM)\b/.test(line)) return "chat-diff-del";
  if (line.startsWith("+")) return "chat-diff-add";
  if (/^(PUT|MV)/.test(line) || line.startsWith("[")) return "chat-diff-head";
  return undefined;
}

function ToolFile({ path, suffix }: { path: string; suffix?: string }) {
  const t = useT();
  const open = useContext(OpenFileContext);
  const shown = toolPathLabel(path, useContext(ToolPathRootContext));
  if (open === null) return <p className="chat-tool-file" title={path}><span data-raw-path={path}>{shown}</span>{suffix}</p>;
  return <p className="chat-tool-file"><button type="button" className="chat-tool-file-link" title={t("Open {path}", { path })} data-raw-path={path} onClick={() => open(path)}>{shown}</button>{suffix}</p>;
}

function EditDiff({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after);
  return <pre className="chat-diff">{lines.map((line, index) =>
    <span key={index} className={line.kind === "add" ? "chat-diff-add" : line.kind === "del" ? "chat-diff-del" : undefined}>{line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}{line.text}{"\n"}</span>)}</pre>;
}

function PatchView({ patch }: { patch: string }) {
  const sections: Array<{ file: string | null; action: string; lines: string[] }> = [];
  for (const line of patch.split("\n")) {
    const file = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (file !== null) { sections.push({ file: file[2]!.trim(), action: file[1]!, lines: [] }); continue; }
    if (/^\*\*\* (Begin|End) Patch/.test(line)) continue;
    if (sections.length === 0) sections.push({ file: null, action: "", lines: [] });
    sections.at(-1)!.lines.push(line);
  }
  for (const section of sections) while (section.lines.at(-1)?.trim() === "") section.lines.pop();
  const lineClass = (line: string): string | undefined =>
    line.startsWith("@@") || line.startsWith("*** Move to:") ? "chat-diff-head" : line.startsWith("+") ? "chat-diff-add" : line.startsWith("-") ? "chat-diff-del" : undefined;
  return <div className="chat-tool-io">{sections.map((section, index) => <div key={index}>
    {section.file !== null && <ToolFile path={section.file} suffix={section.action === "Update" ? undefined : ` (${section.action.toLowerCase()})`} />}
    {section.lines.length > 0 && <pre className="chat-diff">{section.lines.map((line, at) => <span key={at} className={lineClass(line)}>{line}{"\n"}</span>)}</pre>}
  </div>)}</div>;
}

function ToolInputView({ part }: { part: ToolPartType }) {
  const open = useContext(OpenFileContext);
  const t = useT();
  if (part.edits?.length) return <div className="chat-tool-io">{part.edits.map((edit, index) => <div key={index}>
    <ToolFile path={edit.path} /><EditDiff before={edit.before} after={edit.after} />
  </div>)}</div>;
  if (part.arguments_omitted) return <pre className="chat-tool-io">{t("Arguments omitted (too large)")}</pre>;
  const after = isTodoTool(part.name) ? parseTodoAnswer(part.output) ?? todoSnapshot(part) : null;
  if (after !== null && after.length > 0) return <TodoList items={after} />;
  const patch = patchText(part.input);
  if (patch !== null) return <PatchView patch={patch} />;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(part.input) as Record<string, unknown>; }
  catch { return <pre className="chat-tool-io">{part.input}</pre>; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return <pre className="chat-tool-io">{part.input}</pre>;
  const asked = askedQuestions(part.name, parsed);
  if (asked !== null) return <ol className="chat-ask-questions">{asked.map((question, index) => <li key={index} className="chat-ask-question">
    {question.header !== null && <p className="chat-ask-header">{question.header}</p>}
    <p className="chat-ask-text">{question.question}</p>
    {question.multi && <p className="chat-ask-meta">{t("More than one could be picked")}</p>}
    {question.options.length > 0 && <ol className="chat-ask-options">{question.options.map((option, at) => <li key={at}>
      <p className="chat-ask-label">{option.label}{question.recommended === at && <> <span className="chat-ask-meta">({t("Recommended")})</span></>}</p>
      {option.description !== null && <p className="chat-ask-description">{option.description}</p>}
      {option.preview !== null && <pre className="chat-ask-preview">{option.preview}</pre>}
    </li>)}</ol>}
  </li>)}</ol>;
  const spawned = part.name === "task" ? taskCallItems(parsed) : null;
  if (spawned !== null) return <ol className="chat-task-calls">{spawned.map((item, index) => <li key={index} className="chat-task-call">
    <p className="chat-task-call-head"><span className="chat-task-call-title">{item.title}</span>{item.agent !== null && <span className="chat-task-call-agent">{item.agent}</span>}</p>
    {item.prompt.length > 0 && <pre className="chat-tool-io chat-task-call-prompt">{item.prompt}</pre>}
  </li>)}</ol>;
  const str = (key: string): string | undefined => typeof parsed[key] === "string" ? parsed[key] : undefined;
  const command = str("command") ?? str("cmd");
  if (command !== undefined) return <div className="chat-tool-io"><pre>{linkFilePaths(command, open)}</pre>{(str("cwd") ?? str("description")) !== undefined && <p className="chat-tool-io-meta">{str("cwd") ?? str("description")}</p>}</div>;
  const oldString = str("old_string");
  const newString = str("new_string");
  if (oldString !== undefined || newString !== undefined) return <div className="chat-tool-io">{str("file_path") !== undefined && <ToolFile path={str("file_path")!} />}<EditDiff before={oldString ?? ""} after={newString ?? ""} /></div>;
  if (Array.isArray(parsed["edits"]) && parsed["edits"].every((item) => item !== null && typeof item === "object")) {
    const edits = parsed["edits"] as Array<Record<string, unknown>>;
    return <div className="chat-tool-io">{str("file_path") !== undefined && <ToolFile path={str("file_path")!} />}{edits.map((item, index) =>
      <EditDiff key={index} before={typeof item["old_string"] === "string" ? item["old_string"] : ""} after={typeof item["new_string"] === "string" ? item["new_string"] : ""} />)}</div>;
  }
  const sendUserFile = sendUserFileCall(parsed);
  if (sendUserFile !== null) return <div className="chat-tool-io">
    {sendUserFile.caption.length > 0 && <p className="chat-tool-io-meta">{sendUserFile.caption}</p>}
    {sendUserFile.files.map((file, index) => <ToolFile key={`${index}:${file}`} path={file} />)}
  </div>;
  const editScript = str("input");
  if (editScript !== undefined) return <pre className="chat-tool-io chat-diff">{editScript.split("\n").map((line, index) => <span key={index} className={ompEditLineClass(line)}>{line}{"\n"}</span>)}</pre>;
  const content = str("content");
  if (content !== undefined) return <div className="chat-tool-io">{(str("file_path") ?? str("path")) !== undefined && <ToolFile path={(str("file_path") ?? str("path"))!} />}<pre>{content}</pre></div>;
  const path = str("file_path") ?? str("path");
  if (path !== undefined) return <div className="chat-tool-io"><ToolFile path={path} suffix={str("pattern") !== undefined ? ` — /${str("pattern")}/` : undefined} /></div>;
  for (const [key, toRows] of [["list", phaseRows], ["todos", todoRows], ["plan", planRows], ["tasks", taskRows]] as const) {
    const value = parsed[key];
    if (Array.isArray(value)) {
      const rows = toRows(value);
      if (rows.length > 0) return <ChecklistView rows={rows} />;
    }
  }
  return <pre className="chat-tool-io">{part.input}</pre>;
}

function RawToolInput({ part }: { part: ToolPartType }) {
  const t = useT();
  return <section className="chat-tool-output"><h4>{t("Input")}</h4>
    <pre className="chat-tool-io">{part.arguments_omitted ? t("Arguments omitted (too large)") : indentedJson(part.input)}</pre>
  </section>;
}

function indentedJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function useWholeOutput(ref: string | undefined): { text: string | null; state: "idle" | "loading" | "failed"; load: () => void } {
  const paneId = useContext(ChatPaneContext);
  const machineId = useMachineId();
  const history = useContext(ChatHistoryContext);
  const url = ref === undefined || paneId === null ? null : machinePath(machineId, `pane/conversation/tool-output?${new URLSearchParams({ pane_id: paneId, ref }).toString()}`);
  const memory = useContext(ChatRowMemoryContext);
  const saved = ref === undefined ? undefined : memory?.outputs.get(ref);
  const result = useScopedOutput(saved === undefined ? url : null, history);
  useLayoutEffect(() => {
    if (ref !== undefined && result.text !== null && memory && memory.outputs.get(ref) !== result.text) {
      memory.outputs.set(ref, result.text);
    }
  }, [ref, memory, result.text]);
  return saved === undefined ? result : { text: saved, state: "idle", load: result.load };
}

function ImageThumb({ image, onOpen }: { image: GalleryImage; onOpen: () => void }) {
  const t = useT();
  // the focus is placed on the thumbnail before the viewer opens, so the viewer's focus trap
  // records it as the opener and gives the focus back here on close (Safari does not focus a
  // clicked button on its own)
  return <button type="button" className="chat-user-image" title={t("Open image")} onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); onOpen(); }}>
    <ReservedImage src={image.src} alt={image.name} slot />
  </button>;
}

function ImageGallery({ images, className }: { images: GalleryImage[]; className: string }) {
  const openViewer = useContext(ImageViewerContext);
  return <div className={className}>
    {images.map((image, index) => <ImageThumb key={image.src} image={image} onOpen={() => openViewer(images, index)} />)}
  </div>;
}

/** Images a tool returned (pi reads a picture into the result), shown whole in the opened row. */
function ToolImages({ paneId, part }: { paneId: string; part: ToolPartType }) {
  const t = useT();
  const machineId = useMachineId();
  const images = workImages([part]);
  if (images.length === 0) return null;
  return <ImageGallery images={images.map((image) => toolGalleryImage(machineId, paneId, image, t))} className="chat-tool-images" />;
}

function LinePreview({ image, tool, place, anchor }: { image: GalleryImage; tool: string; place: string; anchor: HTMLElement }) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const own = box.current;
    if (own === null) return;
    const place = () => {
      const target = anchor.getBoundingClientRect();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      setAt(!anchor.isConnected || target.bottom < 0 || target.top > viewport.height ? null : previewPlace(target, own.getBoundingClientRect(), viewport));
    };
    place();
    window.addEventListener("scroll", place, { capture: true, passive: true });
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
    };
  }, [anchor]);
  return createPortal(<div ref={box} className="work-image-preview" aria-hidden="true" style={at === null ? { visibility: "hidden" } : { left: at.left, top: at.top }}>
    <ReservedImage src={image.src} alt="" slot />
    <div className="work-image-preview-bar"><span className="work-image-preview-tool">{tool}</span><span>{place}</span></div>
  </div>, document.body);
}

function LineThumb({ image, onOpen, onHover, onFocused, onFailed }: {
  image: GalleryImage; onOpen: (target: HTMLElement) => void; onHover: (anchor: HTMLElement | null) => void; onFocused: (target: HTMLElement) => void; onFailed: () => void;
}) {
  const src = useResourceUrl(image.src);
  return <button type="button" className="work-image" aria-label={image.name}
    onClick={(event) => onOpen(event.currentTarget)}
    onPointerEnter={(event) => { if (event.pointerType !== "touch") onHover(event.currentTarget); }}
    onPointerLeave={() => onHover(null)}
    onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) onFocused(event.currentTarget); }}
    onBlur={() => onHover(null)}>
    <img src={src ?? undefined} alt="" loading="lazy" onError={onFailed} />
  </button>;
}

function LineImages({ paneId, images }: { paneId: string; images: readonly WorkImage[] }) {
  const t = useT();
  const machineId = useMachineId();
  const openViewer = useContext(ImageViewerContext);
  const touch = useMediaQuery("(pointer: coarse)");
  const [preview, setPreview] = useState<{ src: string; anchor: HTMLElement } | null>(null);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const entries = useMemo(() => images.map((image) => ({ image: toolGalleryImage(machineId, paneId, image, t), tool: toolDisplayName(image.part.name) })), [images, machineId, paneId, t]);
  const usable = entries.filter((entry) => !failed.has(entry.image.src));
  if (usable.length === 0) return null;
  const gallery = usable.map((entry) => entry.image);
  const { hidden, shown } = lineImages(usable, touch ? LINE_IMAGES_SHOWN_TOUCH : LINE_IMAGES_SHOWN);
  const open = (index: number, target: HTMLElement) => { setPreview(null); target.focus({ preventScroll: true }); openViewer(gallery, index); };
  // a thumbnail takes back only its own preview: leaving one must not close the next one's
  const hide = (src: string) => setPreview((current) => current?.src === src ? null : current);
  const at = preview === null ? -1 : usable.findIndex((entry) => entry.image.src === preview.src);
  const previewed = at >= hidden ? usable[at] : undefined;
  return <div className="work-images" role="group" aria-label={t("Pictures from this work")}>
    {hidden > 0 && <button type="button" className="work-image is-more" aria-label={t("All {count} pictures", { count: usable.length })} onClick={(event) => open(0, event.currentTarget)}>+{hidden}</button>}
    {shown.map(({ image }, offset) => <LineThumb key={image.src} image={image}
      onOpen={(target) => open(hidden + offset, target)}
      onHover={(anchor) => anchor === null ? hide(image.src) : setPreview({ src: image.src, anchor })}
      onFocused={(target) => setPreview({ src: image.src, anchor: target })}
      onFailed={() => { hide(image.src); setFailed((current) => new Set(current).add(image.src)); }} />)}
    {preview !== null && previewed !== undefined && <LinePreview image={previewed.image} tool={previewed.tool} anchor={preview.anchor}
      place={t("{n} of {count}", { n: at + 1, count: usable.length })} />}
  </div>;
}

function ToolOutputText({ stateKey, output, whole }: { stateKey: string; output: string; whole: boolean }) {
  const t = useT();
  const openFile = useContext(OpenFileContext);
  const fold = useMemo(() => foldToolOutput(output), [output]);
  const [chosen, setExpanded] = useChatRowToggle(stateKey, false);
  const expanded = chosen === true;
  const folded = fold !== null && !expanded;
  // where the browser can find hidden text (hidden=until-found), a folded output's tail stays in the
  // page, drawn as nothing: its find reaches it and unfolds the output; elsewhere only the head is drawn
  // (rendered without a page, as to static markup, nothing is found)
  const findable = folded && typeof HTMLElement !== "undefined" && "onbeforematch" in HTMLElement.prototype;
  const tail = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = tail.current;
    if (node === null) return;
    // React writes `hidden` only as true or false
    node.setAttribute("hidden", "until-found");
    // unfolded before the browser scrolls to the match, so it lands where the unfolded text puts it
    const found = () => flushSync(() => setExpanded(true));
    node.addEventListener("beforematch", found);
    return () => node.removeEventListener("beforematch", found);
  }, [folded, setExpanded]);
  const box = useRef<HTMLPreElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const folding = useRef(false);
  // an unfold from the keyboard (a click with no pointer press: detail 0); a pointer's leaves the focus where it was
  const revealing = useRef(false);
  useLayoutEffect(() => {
    const node = box.current;
    const view = node?.closest(".chat-view");
    if (folding.current) {
      folding.current = false;
      const atEnd = view instanceof HTMLElement && view.scrollHeight - view.clientHeight - view.scrollTop <= 1;
      if (node && view && !atEnd && node.getBoundingClientRect().top < view.getBoundingClientRect().top) node.scrollIntoView({ block: "start" });
    }
    if (revealing.current) {
      revealing.current = false;
      const button = more.current;
      if (node && view && button && button.getBoundingClientRect().top >= view.getBoundingClientRect().bottom) node.focus({ preventScroll: false });
    }
  }, [expanded]);
  return <>
    {/* the head of a folded output links its paths as the whole text finds them: a path the fold cuts stays text */}
    <pre ref={box} tabIndex={-1} className={`chat-tool-io chat-tool-result${whole ? " is-whole" : ""}`}>{linkFilePaths(output, openFile, folded ? fold.head.length : output.length)}{folded && findable && <span ref={tail} className="chat-tool-result-tail">{output.slice(fold.head.length)}</span>}</pre>
    {fold !== null && <button ref={more} type="button" className="markdown-code-more chat-tool-result-more" aria-expanded={expanded}
      onClick={(event) => { folding.current = expanded; revealing.current = !expanded && event.detail === 0; setExpanded(!expanded); }}>
      {expanded ? t("Show less") : fold.lines !== null ? t("Show all {n} lines", { n: fold.lines }) : t("Show all {size} characters", { size: formatTokens(output.length) })}
    </button>}
  </>;
}

function WorkRow({ paneId, part, stateKey, state }: { paneId: string; part: ToolPartType; stateKey: string; state?: TodoAttempt["state"] }) {
  const t = useT();
  const [chosen, setOpen] = useChatRowToggle(stateKey, false);
  const open = chosen === true;
  const focus = useRowFocus<HTMLButtonElement>(stateKey);
  const attempt = state !== undefined;
  const whole = useWholeOutput(part.output_ref);
  const summary = part.arguments_omitted ? t("Arguments omitted (too large)") : todoCallSummary(part) ?? part.summary;
  const { verb, narration } = useMemo(() => workRowLabel({ name: part.name, input: part.input }, summary), [part.name, part.input, summary]);
  const name = toolDisplayName(part.name);
  const renamed = narration || verb !== null || name !== part.name;
  const legacy = useMemo(() => legacyEditText(part.edits), [part.edits]);
  const raw = whole.text ?? part.output;
  const clippedEdit = legacy && raw.endsWith("\n… trimmed") && legacy.startsWith(raw.slice(0, -"\n… trimmed".length));
  const output = raw === legacy || clippedEdit || (!attempt && isTodoTool(part.name) && parseTodoAnswer(part.output) !== null) ? ""
    : legacy && raw.startsWith(`${legacy}\n`) ? raw.slice(legacy.length + 1) : raw;
  const canLoad = part.output_ref !== undefined && whole.text === null && (!clippedEdit || (part.output_size ?? 0) > legacy.length + 1);
  const stateWord = state === undefined || part.error ? null
    : state === "ok" ? t("succeeded") : state === "pending" ? t("pending") : state === "error" ? t("failed") : t("outcome not recorded");
  const images = useMemo(() => linePictures([part]), [part]);
  return <div className={`work-row${part.error ? " is-error" : ""}`}>
    <div className="work-row-line">
      <button type="button" className="work-row-head" aria-expanded={open} title={renamed ? (summary.length > 0 ? `${part.name} · ${summary}` : part.name) : undefined} onClick={() => setOpen(!open)} {...focus}>
        <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
        {!narration && (verb !== null ? <span className="work-row-name is-verb">{t(verb)}</span> : <span className="work-row-name">{name}</span>)}
        {/* the spaces are for a screen reader: the row is read as words, not "Ranbun test" */}
        {!narration && part.error && verb === null && <>{" "}<span className="work-row-failed">{t("failed")}</span></>}
        {summary.length > 0 && summary !== part.name && <>{" "}<span className="work-row-summary">{summary}</span></>}
        {/* after a verb, or the agent's own sentence, the word follows it: "Ran pnpm test failed", not "Ran failed pnpm test" */}
        {part.error && (narration || verb !== null) && <>{" "}<span className="work-row-failed">{t("failed")}</span></>}
        {stateWord !== null && <>{" "}<span className={state === "error" ? "work-row-failed" : `work-row-state is-${state}`}>{stateWord}</span></>}
      </button>
      {/* opened, the row shows its pictures larger in its detail */}
      {!open && <LineImages paneId={paneId} images={images} />}
    </div>
    {open && <div className="work-row-detail">{(verb !== null || name !== part.name) && <p className="work-row-tool">{part.name}</p>}{attempt ? <RawToolInput part={part} /> : <ToolInputView part={part} />}<ToolImages paneId={paneId} part={part} />{(output.length > 0 || (clippedEdit && canLoad)) && <section className="chat-tool-output"><h4>{t(part.error ? "Error" : "Output")}</h4>{/* each whole output folds on its own, whatever the preview or an earlier one was: another element, another key */}
      {output.length > 0 && <ToolOutputText key={whole.text !== null ? `whole:${part.output_ref ?? ""}` : "preview"} stateKey={`${stateKey}:${whole.text !== null ? `whole:${part.output_ref ?? ""}` : "output"}`} output={output} whole={whole.text !== null} />}
      {canLoad && <button type="button" className="btn btn-ghost chat-tool-more" disabled={whole.state === "loading"} onClick={whole.load}>
        {t(whole.state === "loading" ? "Loading the whole output…" : whole.state === "failed" ? "Couldn't load the whole output — retry" : "Show the whole output ({size} characters)", { size: formatTokens(part.output_size ?? 0) })}
      </button>}</section>}</div>}
  </div>;
}

function TodoGroupRow({ paneId, group, stateKeyOf }: { paneId: string; group: TodoGroup; stateKeyOf: (part: ToolPartType) => string }) {
  const t = useT();
  const memory = useContext(ChatRowMemoryContext);
  const groupKey = `todo-group:${group.id}`;
  const [chosen, setOpen] = useChatRowToggle(groupKey, group.attempts.some((attempt) => memory?.toggles.get(stateKeyOf(attempt.part)) === true));
  const focus = useRowFocus<HTMLButtonElement>(groupKey, group.attempts.map((attempt) => stateKeyOf(attempt.part)));
  useLayoutEffect(() => { if (chosen === true && memory !== null && !memory.toggles.has(groupKey)) memory.toggles.set(groupKey, true); }, [chosen, memory, groupKey]);
  const open = chosen === true;
  const { current } = group;
  const items = current?.items ?? null;
  const done = items?.filter((item) => item.status === "completed").length ?? 0;
  const status = current === null ? t("no update completed")
    : items === null ? t("latest list unreadable")
      : current.state === "ok" ? t("{done}/{total} done", { done, total: items.length })
        : t("{done}/{total} done, outcome not recorded", { done, total: items.length });
  const caption = current === null ? t("No update has completed, so there is no current list.")
    : items === null ? t(current.state === "ok" ? "The latest successful update's list can't be read. An earlier list is not shown in its place." : "The latest update's list can't be read. An earlier list is not shown in its place.")
      : current.state === "ok" ? t("Current list") : t("Latest list. The transcript does not record whether this update succeeded.");
  return <div className="work-row work-todo-group" data-todo-group={group.id}>
    <button type="button" className="work-row-head" aria-expanded={open} onClick={() => setOpen(!open)} {...focus}>
      <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
      <span className="work-row-name is-verb">{t("Plan")}</span>
      {" "}<span className="work-row-summary">{t("{n} updates", { n: group.attempts.length })} · {status}</span>
      {/* the counts beside it are never the part a narrow row cuts */}
      {group.pending > 0 && <>{" "}<span className="work-row-state is-pending">{t("{n} pending", { n: group.pending })}</span></>}
      {group.failed > 0 && <>{" "}<span className="work-row-failed">{t("{n} failed", { n: group.failed })}</span></>}
    </button>
    {open && <div className="work-row-detail work-todo-detail">
      <p className="work-todo-caption">{caption}</p>
      {items !== null && (items.length > 0 ? <TodoList items={items} /> : <p className="work-todo-caption">{t("The list is empty.")}</p>)}
      <section className="work-todo-attempts" aria-label={t("Every update, in order")}>
        <h4>{t("Every update, in order")}</h4>
        {group.attempts.map((attempt) => <WorkRow key={stateKeyOf(attempt.part)} stateKey={stateKeyOf(attempt.part)} paneId={paneId} part={attempt.part} state={attempt.state} />)}
      </section>
    </div>}
  </div>;
}

function ThinkingRow({ text, stateKey, defaultOpen }: { text: string; stateKey: string; defaultOpen: boolean }) {
  const t = useT();
  const [chosen, setOpen] = useChatRowToggle(stateKey, null);
  const open = chosen ?? defaultOpen;
  return <div className="work-row work-row-thinking">
    <button type="button" className="work-row-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
      <span className="work-row-name">{t("thinking")}</span>
    </button>
    {open && <div className="work-row-detail work-thinking-text">{text}</div>}
  </div>;
}

function PendingWorkHead({ title, className = "", reserved = false }: { title: string; className?: string; reserved?: boolean }) {
  return <div className={`work-block is-live is-pending ${className}`} role="status" aria-hidden={reserved || undefined}>
    <div className="work-block-head"><span className="work-row-caret" aria-hidden="true" /><span className="work-block-title">{title}</span></div>
  </div>;
}

interface TurnWork {
  at: ReadonlyMap<ConversationPart, number>;
  groups: ReadonlyMap<ToolPartType, TodoGroup>;
  grouped: ReadonlySet<ConversationPart>;
}

function turnWork(parts: ConversationPart[], rowKey: string): TurnWork {
  const groups = todoGroups(parts, rowKey);
  return {
    at: new Map(parts.map((part, index) => [part, index])),
    groups,
    grouped: new Set([...groups.values()].flatMap((group) => group.attempts.slice(1).map((attempt) => attempt.part))),
  };
}

function useElapsed(startTs: string | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startTs === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startTs]);
  return startTs === null ? null : formatWorkDuration(startTs, new Date(now).toISOString());
}

function WorkBlockView({ paneId, parts, work, memoryKey, duration, startedAt = null, live, waiting, defaultOpen, showThinking, expandThinking, pendingHead }: { paneId: string; parts: ConversationPart[]; work: TurnWork; memoryKey: string; duration: string | null; startedAt?: string | null; live: boolean; waiting: boolean; defaultOpen: boolean; showThinking: boolean; expandThinking: boolean; pendingHead: boolean }) {
  const t = useT();
  const [chosenOpen, setOpen] = useChatRowToggle(memoryKey, null);
  const elapsed = useElapsed(live && !waiting ? startedAt : null);
  const open = chosenOpen ?? defaultOpen;
  // reading or working inside the block is a choice to keep it: the fold at the end of the turn
  // must not take the rows from under the reader's focus or close the row they opened
  const keepOpen = () => { if (chosenOpen === null) setOpen(true); };
  const { at, groups, grouped } = work;
  const toolKey = (part: ConversationPart) => `tool:${at.get(part)}`;
  const images = useMemo(() => linePictures(parts), [parts]);
  const visible = visibleWorkParts(parts, showThinking);
  if (visible.length === 0) return live && !waiting && pendingHead ? <PendingWorkHead title={t("Working…")} /> : null;
  const summary = workSummary(parts);
  const failed = workFailed(parts);
  const title = waiting ? t("Needs you") : live ? t("Working…") : duration !== null ? t("Worked for {duration}", { duration }) : t("Worked");
  return <section className={`work-block${live ? " is-live" : ""}${waiting ? " is-waiting" : ""}${open ? "" : " is-folded"}`}>
    <div className="work-block-line">
      <button type="button" className="work-block-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
        <span className="work-block-title">{title}</span>
        {elapsed !== null && <span className="work-block-elapsed">· {elapsed}</span>}
        {summary.length > 0 && <span className="work-block-summary">· {summary}</span>}
        {/* its own span: the counts before it are cut on a narrow screen, a failure never is */}
        {failed > 0 && <span className="work-block-failed">· {t("{n} failed", { n: failed })}</span>}
      </button>
      {/* folded, the block's line carries its tools' pictures the browser keeps (linePictures); opened, each row carries its own */}
      {!open && <LineImages paneId={paneId} images={images} />}
    </div>
    {/* the rows open and fold at the block's measured height; folded and settled, they are not drawn */}
    <AnimatedHeight open={open} animateContent={false}>
      <div className="work-block-rows" onFocus={keepOpen} onPointerDown={keepOpen}>{visible.map((part) =>
        part.kind === "thinking" ? <ThinkingRow key={`thinking:${at.get(part)}`} stateKey={`thinking:${at.get(part)}`} text={part.text} defaultOpen={expandThinking} />
          : part.kind === "text" ? <div key={`text:${at.get(part)}`} className="work-narration"><Markdown>{part.text}</Markdown></div>
            : part.kind === "tool" ? groups.has(part) ? <TodoGroupRow key={groups.get(part)!.id} paneId={paneId} group={groups.get(part)!} stateKeyOf={toolKey} />
              : grouped.has(part) ? null : <WorkRow key={toolKey(part)} stateKey={toolKey(part)} paneId={paneId} part={part} /> : null)}
      </div>
    </AnimatedHeight>
  </section>;
}

function SkillActivityList({ parts }: { parts: ConversationPart[] }) {
  const t = useT();
  const skills = turnSkills(parts);
  if (skills.length === 0) return null;
  return <div className="chat-skills" role="group" aria-label={t("Skill activity")}>
    {skills.map((skill) => <ChatDetails memoryKey={`skill:${skill.evidence}:${skill.path ?? skill.name}`} className={`chat-skill${skill.status === "failed" ? " is-error" : ""}`} key={`${skill.evidence}:${skill.path ?? skill.name}`}>
      <summary><BookOpen aria-hidden="true" /><span className="chat-skill-name">{skill.name}</span><span className="chat-skill-status">{
        skill.evidence === "invocation"
          ? skill.status === "failed" ? t("Skill invocation failed") : skill.status === "requested" ? t("Skill requested") : t("Skill invoked")
          : skill.status === "failed" ? t("Skill read failed") : skill.status === "requested" ? t("Reading skill requested") : t("Skill instructions loaded")
      }</span><ChevronDown className="chat-skill-caret" aria-hidden="true" /></summary>
      <div className="chat-skill-detail"><p>{skill.evidence === "invocation" ? t("Recorded by the agent's Skill tool. This does not mean the skill's work is complete.") : t("The transcript records loading this skill's instructions. This does not confirm every step was followed.")}</p>
        {skill.path && <code>{skill.path}</code>}
      </div>
    </ChatDetails>)}
  </div>;
}

function GoalActivity({ goal }: { goal: GoalState }) {
  const t = useT();
  const word: Record<GoalStatus, string> = {
    active: t("in progress"), paused: t("paused"), blocked: t("blocked"), complete: t("complete"), budget_limited: t("out of budget"),
  };
  const spent = [
    goal.timeUsedSeconds !== null && goal.timeUsedSeconds > 0 ? formatGoalTime(goal.timeUsedSeconds) : null,
    goal.tokensUsed !== null && goal.tokensUsed > 0 ? t("{n} tokens", { n: formatTokens(goal.tokensUsed) }) : null,
  ].filter((item) => item !== null).join(" · ");
  return <ChatDetails memoryKey="goal" className={`chat-goal is-${goal.status}`}>
    <summary><Target aria-hidden="true" /><span className="chat-goal-label">{t("Goal")}</span><span className="chat-goal-objective">{goal.objective}</span>
      <span className="chat-goal-status">{word[goal.status]}</span><ChevronDown className="chat-skill-caret" aria-hidden="true" /></summary>
    <div className="chat-goal-detail">
      <p className="chat-goal-text">{goal.objective}</p>
      {goal.blockedReason !== null && <p className="chat-goal-reason">{goal.blockedReason}</p>}
      {spent.length > 0 && <p className="chat-goal-spent">{t("Used so far: {spent}", { spent })}</p>}
    </div>
  </ChatDetails>;
}

function UserImages({ paneId, parts, text }: { paneId: string; parts: ConversationPart[]; text: string }) {
  const t = useT();
  const machineId = useMachineId();
  const images = userGalleryImages(machineId, paneId, parts, text, t);
  if (images.length === 0) return null;
  return <ImageGallery images={images} className="chat-user-images" />;
}

function UserMessage({ text, skills = null }: { text: string; skills?: SkillMatcher | null }) {
  const t = useT();
  const canFold = useMemo(() => shouldFoldUserMessage(text), [text]);
  const [chosen, setOpen] = useChatRowToggle("fold", false);
  const open = chosen === true;
  const capped = canFold && !open;
  const body = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const node = body.current;
    if (!capped || node === null) { setClipped(false); return; }
    const measure = (): void => setClipped(node.scrollHeight > node.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [capped]);
  const card = useRef<HTMLDivElement>(null);
  const folding = useRef(false);
  const toggle = (): void => {
    folding.current = open;
    setOpen(!open);
  };
  useLayoutEffect(() => {
    if (!folding.current) return;
    folding.current = false;
    const node = card.current;
    const view = node?.closest(".chat-view");
    if (node && view && node.getBoundingClientRect().top < view.getBoundingClientRect().top) node.scrollIntoView({ block: "start" });
  }, [open]);
  return <div ref={card} className={`chat-bubble${capped ? " is-capped" : ""}${clipped ? " is-folded" : ""}`}>
    <div ref={body} className="chat-bubble-body"><Markdown skills={skills}>{text}</Markdown></div>
    {(open || clipped) && <div className="chat-bubble-foot">
      <button type="button" className="chat-bubble-fold" aria-expanded={open} onClick={toggle}>{open ? t("Show less") : t("Show full message")}</button>
    </div>}
  </div>;
}

interface OutcomeActions {
  answer: (() => void) | null;
  terminal: ((text: string) => void) | null;
  commands?: readonly SlashCommand[];
}

function terminalOnlyOutcome(outcome: CommandOutcome, actions: OutcomeActions | null): boolean {
  return !outcome.result_text && !outcome.unattached_skills?.length
    && typedTerminalCommand(actions?.commands ?? [], outcome.text) !== null;
}

function TerminalCommandRow({ outcome, actions }: { outcome: CommandOutcome; actions: OutcomeActions | null }) {
  const t = useT();
  return <article className="chat-turn chat-turn-user chat-terminal-command" data-outcome-id={outcome.id}>
    <SquareTerminal aria-hidden="true" />
    <code title={outcome.text}>{outcomeCommand(outcome.text)}</code>
    <span>· {t("Ran in terminal")}</span>
    {actions?.terminal && <button type="button" className="chat-outcome-action" onClick={() => actions.terminal?.(outcome.text)}>{t("Open Terminal")}</button>}
  </article>;
}

const OUTCOME_ICONS: Record<OutcomeState, ComponentType<LucideProps>> = {
  accepted: Circle, "interaction-required": CircleAlert, "result-observed": CircleCheck, "terminal-required": SquareTerminal, unknown: CircleQuestionMark,
};

function OutcomeChip({ outcome, actions, snapshot }: { outcome: CommandOutcome; actions: OutcomeActions | null; snapshot?: string }) {
  const t = useT();
  const chip = outcomeChip(outcome);
  const Icon = OUTCOME_ICONS[chip.state];
  const terminal = actions?.terminal ?? null;
  const action = chip.action === "answer" ? actions?.answer ?? null : chip.action === "terminal" && terminal !== null ? () => terminal(outcome.text) : null;
  const lines = snapshot === undefined ? null : `\n${snapshot.replace(/[ \t]+$/gmu, "")}\n`;
  const resultShown = (text: string) => lines !== null && lines.includes(`\n${text.replace(/[ \t]+$/gmu, "").trim()}\n`);
  const preview = snapshot !== undefined || outcome.result_text ? "" : outcome.preview ?? "";
  const [dismissed, setDismissed] = useChatRowToggle(`outcome-result:${outcome.id}`, false);
  const recorded = outcomeResultText(outcome, dismissed === true);
  const result = recorded !== null && resultShown(recorded) ? null : recorded;
  const command = snapshot !== undefined ? outcome.text.trim().split("\n", 1)[0] ?? "" : "";
  const note = outcomeNote(t, outcome);
  return <div className="chat-outcome" data-outcome-state={chip.state}>
    <div className="chat-outcome-row">
      <span className="chat-outcome-state" role="status"><Icon aria-hidden="true" />{outcomeLabel(t, chip)}</span>
      {command !== "" && <span className="chat-outcome-command" title={outcome.text}>{command}</span>}
      {action !== null && <button type="button" className="chat-outcome-action" onClick={action}>{chip.action === "answer" ? t("Answer") : t("Open Terminal")}</button>}
    </div>
    {/* why it went as plain text, read with the state it explains */}
    {note !== null && <p className="chat-outcome-note">{note}</p>}
    {/* opened at the transcript's end, the screen text would sit under the input card: it is brought into view, clear of it */}
    {preview !== "" && <ChatDetails memoryKey={`outcome-preview:${outcome.id}`} className="chat-outcome-preview" onToggle={(event) => { if (event.currentTarget.open) event.currentTarget.scrollIntoView({ block: "nearest" }); }}>
      <summary><ChevronDown className="chat-outcome-caret" aria-hidden="true" /><span role="status">{t("Terminal output changed after {command}, not confirmed", { command: outcomeCommand(outcome.text) })}</span></summary>
      <pre className="chat-outcome-preview-text">{preview}</pre>
    </ChatDetails>}
    {/* the agent's own lines, verbatim; Dismiss only hides them here and sends nothing to the pane */}
    {result !== null && <section className="chat-outcome-result" role="status" aria-label={t("What {command} printed", { command: outcomeCommand(outcome.text) })}>
      <pre className="chat-outcome-result-text" tabIndex={0}>{result}</pre>
      <button type="button" className="chat-outcome-action" onClick={() => setDismissed(true)}>{t("Dismiss")}</button>
    </section>}
  </div>;
}

function OutcomeRow({ outcome, actions, skills = null }: { outcome: CommandOutcome; actions: OutcomeActions | null; skills?: SkillMatcher | null }) {
  const t = useT();
  const [copyFailed, setCopyFailed] = useChatRowToggle("copy-failed", false);
  if (terminalOnlyOutcome(outcome, actions)) return <TerminalCommandRow outcome={outcome} actions={actions} />;
  return <article className="chat-turn chat-turn-user chat-turn-sent" data-outcome-id={outcome.id}>
    <div className="chat-user-row">
      <UserMessage text={outcome.text} skills={skills} />
      <div className="chat-turn-meta"><TurnTime ts={outcome.created_at} /><CopyButton text={outcome.text} label={t("Copy message")} onResult={(ok) => setCopyFailed(!ok)} /></div>
    </div>
    {copyFailed && <p className="chat-copy-error" role="alert">{t("Couldn't copy. Select the text and copy it manually.")}</p>}
    <OutcomeChip outcome={outcome} actions={actions} />
  </article>;
}

interface TurnProps {
  paneId: string;
  turn: ConversationTurn;
  rowKey: string;
  live: boolean;
  waiting: boolean;
  showThinking: boolean;
  expandThinking?: boolean;
  foldWork?: boolean;
  requestDetails?: boolean;
  skills?: SkillMatcher | null;
  /** omo only: the user's own `$skill:x` and the `[skill: x]` omo leaves where one stood are chipped too */
  userSkills?: SkillMatcher | null;
  outcome?: CommandOutcome | null;
  outcomeActions?: OutcomeActions | null;
}

const TASK_RESULT_ICONS: Record<OmoTaskResult["status"], ComponentType<LucideProps>> = { completed: CircleCheck, failed: CircleX, cancelled: CircleSlash };

function TaskResultRow({ task }: { task: OmoTaskResult }) {
  const t = useT();
  const Icon = TASK_RESULT_ICONS[task.status];
  const word: Record<OmoTaskResult["status"], string> = { completed: t("done"), failed: t("failed"), cancelled: t("cancelled") };
  const meta = [
    task.agent, task.model, task.duration_ms === null ? null : formatElapsed(task.duration_ms),
    task.turns === null ? null : t(task.turns === 1 ? "{n} turn" : "{n} turns", { n: task.turns }),
    task.tool_calls === null ? null : t(task.tool_calls === 1 ? "{n} tool call" : "{n} tool calls", { n: task.tool_calls }),
    task.tokens === null || task.tokens === 0 ? null : t("{n} tokens", { n: formatTokens(task.tokens) }),
  ].filter((item) => item !== null).join(" · ");
  const [opened, setOpened] = useChatRowToggle(`task-loaded:${task.id}`, false);
  return <ChatDetails memoryKey={`task:${task.id}`} className={`chat-task-result is-${task.status}`} onToggle={(event) => { if (event.currentTarget.open) setOpened(true); }}>
    <summary>
      <Icon className="chat-task-result-icon" aria-hidden="true" />
      <span className="chat-task-result-main">
        <span className="chat-task-result-title">{task.title}</span>
        {meta.length > 0 && <span className="chat-task-result-meta">{meta}</span>}
      </span>
      <span className="chat-task-result-status">{word[task.status]}</span>
      <ChevronDown className="chat-skill-caret" aria-hidden="true" />
    </summary>
    {opened && <div className="chat-task-result-body">
      {task.result.length > 0 ? <Markdown>{taskResultMarkdown(task.result)}</Markdown> : <p className="chat-task-result-note">{t("The task reported no result")}</p>}
      {task.result_cut === true && <p className="chat-task-result-note">{t("This is the first part of a longer result")}</p>}
    </div>}
  </ChatDetails>;
}

/** A Claude agent team's teammate reporting back: who, and what it said on request. Idle is that it
 *  is free again, not a verdict on its task. */
function TeammateMessageRow({ message, stateKey }: { message: TeammateMessage; stateKey: string }) {
  const t = useT();
  const [opened, setOpened] = useChatRowToggle(`teammate-loaded:${stateKey}`, false);
  return <ChatDetails memoryKey={`teammate:${stateKey}`} className="chat-task-results chat-task-result chat-teammate-message" onToggle={(event) => { if (event.currentTarget.open) setOpened(true); }}>
    <summary>
      <Layers className="chat-task-result-icon" aria-hidden="true" />
      <span className="chat-task-result-main">
        <span className="chat-task-result-title">{message.name}</span>
        {message.summary && <span className="chat-task-result-meta chat-teammate-preview">{message.summary}</span>}
      </span>
      <span className="chat-task-result-status">{message.status === "idle" ? t("Teammate idle") : t("Teammate message")}</span>
      <ChevronDown className="chat-skill-caret" aria-hidden="true" />
    </summary>
    {opened && <div className="chat-task-result-body">
      {message.text ? <Markdown>{message.text}</Markdown> : <p className="chat-task-result-note">{t("The teammate is available; no result was included")}</p>}
      <ChatDetails memoryKey={`teammate-raw:${stateKey}`} className="chat-teammate-raw">
        <summary>{t("Original delivery")}</summary>
        <pre>{message.raw}</pre>
      </ChatDetails>
    </div>}
  </ChatDetails>;
}

function compactCounts(t: ReturnType<typeof useT>, part: Extract<ConversationPart, { kind: "compact" }>): string[] {
  return [
    part.tokens_before === undefined ? null : t("{n} tokens before", { n: formatTokens(part.tokens_before) }),
    part.tokens_after === undefined ? null : t("{n} tokens after", { n: formatTokens(part.tokens_after) }),
    part.tokens_saved === undefined ? null : t("{n} tokens saved", { n: formatTokens(part.tokens_saved) }),
  ].filter((count) => count !== null);
}

function FailedRequests({ parts, followed, at, live = false }: { parts: readonly Extract<ConversationPart, { kind: "text" }>[]; followed: boolean; at: number; live?: boolean }) {
  const t = useT();
  const n = parts.length;
  const label = followed
    ? t(n === 1 ? "Request failed, then tried again" : "{n} requests failed, then tried again", { n })
    : t(n === 1 ? "Request failed" : "{n} requests failed", { n });
  return <ChatDetails memoryKey={`failed:${at}`} defaultOpen={!followed && !live} data-failed-requests={at} className={`chat-skill${followed ? "" : " is-error"} chat-failed-requests`}>
    <summary><CircleAlert aria-hidden="true" /><span className="chat-skill-name">{label}</span><ChevronDown className="chat-skill-caret" aria-hidden="true" /></summary>
    <ol className="chat-skill-detail chat-failed-requests-list">{parts.map((part, index) => <li key={index}>{part.text.replace(/^Error: /, "")}</li>)}</ol>
  </ChatDetails>;
}

function noticeLabel(t: ReturnType<typeof useT>, notice: Extract<ConversationPart, { kind: "notice" }>): string {
  if (notice.source === undefined || notice.source === "async-result") return t("Background result delivered");
  if (notice.source === "goal-continuation") return t("Goal continues");
  if (notice.source.startsWith("peer:")) {
    const name = notice.source.slice(5);
    return name ? t("Message from another session: {name}", { name }) : t("Message from another session");
  }
  const first = notice.text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? notice.source;
  return first.length > 96 ? `${first.slice(0, 95)}…` : first;
}

type GoalWait = Extract<ConversationPart, { kind: "goal_wait" }>;

function goalWaitSource(t: ReturnType<typeof useT>, kind: keyof GoalWait["waiting_on"], n: number): string {
  switch (kind) {
    case "tasks": return n === 1 ? t("1 task") : t("{n} tasks", { n });
    case "monitors": return n === 1 ? t("1 monitor") : t("{n} monitors", { n });
    case "terminals": return n === 1 ? t("1 terminal") : t("{n} terminals", { n });
    case "dags": return n === 1 ? t("1 DAG run") : t("{n} DAG runs", { n });
    case "cells": return n === 1 ? t("1 code cell") : t("{n} code cells", { n });
  }
}

function GoalWaitRow({ wait }: { wait: GoalWait }) {
  const t = useT();
  const until = goalWaitUntil(wait);
  const [expired, setExpired] = useState<number | null>(() => Date.now() < until ? null : until);
  const [checks, setChecks] = useState(0);
  useEffect(() => {
    const left = until - Date.now();
    if (!(left > 0)) { setExpired(until); return; }
    // a timer holds at most 2^31-1 ms; a later due time is checked again then
    const timer = setTimeout(() => left > 2_147_483_647 ? setChecks((n) => n + 1) : setExpired(until), Math.min(left, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [until, checks]);
  if (expired === until) return null;
  const locale = currentLocale();
  const sources = goalWaitSources(wait).map(([kind, n]) => goalWaitSource(t, kind, n));
  const what = sources.length === 0 ? t("background work") : new Intl.ListFormat(locale, { type: "conjunction" }).format(sources);
  const time = new Date(wait.due_at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return <p className="chat-goal-wait"><span><Hourglass aria-hidden="true" />{t("Goal waits on {what} · continues around {time}", { what, time })}</span></p>;
}

export const Turn = memo(function Turn({ paneId, turn, rowKey, live, waiting, showThinking, expandThinking = false, foldWork = false, requestDetails = false, skills = null, userSkills = null, outcome = null, outcomeActions = null }: TurnProps) {
  const t = useT();
  const memory = useContext(ChatRowMemoryContext);
  const named = useRef<{ runs: Map<number, string>; dormant: Map<number, string> } | null>(null);
  named.current = null;
  useLayoutEffect(() => {
    if (memory === null || named.current === null) return;
    for (const key of ["runs", "dormant"] as const) {
      memory[key].clear();
      for (const [index, name] of named.current[key]) memory[key].set(index, name);
    }
  });
  const [copyFailed, setCopyFailed] = useChatRowToggle("copy-failed", false);
  const copyError = copyFailed && <p className="chat-copy-error" role="alert">{t("Couldn't copy. Select the text and copy it manually.")}</p>;
  const copied = (ok: boolean): void => setCopyFailed(!ok);
  const time = turn.ts === null ? null : <TurnTime ts={turn.ts} />;
  const wait = turn.parts.find((part): part is GoalWait => part.kind === "goal_wait");
  if (wait !== undefined) return <GoalWaitRow wait={wait} />;
  const compact = turn.parts.find((part): part is Extract<ConversationPart, { kind: "compact" }> => part.kind === "compact");
  if (compact !== undefined) {
    return <ChatDetails memoryKey="compact" className="chat-compact">
      {/* the divider hides the disclosure's own marker: a word at its end says what a click does, by the state (ChatView.css) */}
      <summary>{t("Conversation compacted")}{requestDetails && compactCounts(t, compact).map((count) => ` · ${count}`).join("")}{time !== null && <> · {time}</>}<span className="chat-compact-state"><span className="chat-compact-state-closed">{t("Show summary")}</span><span className="chat-compact-state-open">{t("Hide summary")}</span></span></summary>
      <div className="chat-compact-text"><Markdown>{compact.text}</Markdown></div>
    </ChatDetails>;
  }
  const ended = turn.parts.find((part): part is Extract<ConversationPart, { kind: "task_result" }> => part.kind === "task_result");
  if (ended !== undefined) {
    const heading = ended.tasks.length === 1 ? t("Background task ended") : t("{n} background tasks ended", { n: ended.tasks.length });
    return <section className="chat-task-results" aria-label={heading}>
      <p className="chat-task-results-head"><Layers aria-hidden="true" /><span>{heading}</span>{time !== null && <> · {time}</>}</p>
      {ended.tasks.map((task) => <TaskResultRow key={task.id} task={task} />)}
    </section>;
  }
  const notice = turn.parts.find((part): part is Extract<ConversationPart, { kind: "notice" }> => part.kind === "notice");
  // a stop (Esc): a quiet line where the turn stopped, as Claude Code's own terminal draws it
  if (notice?.source === "stopped") return <p className="chat-goal-wait chat-stopped"><span>{t("Stopped|chat")}{time !== null && <> · {time}</>}</span></p>;
  if (notice !== undefined) {
    return <ChatDetails memoryKey="notice" className="chat-compact chat-notice">
      <summary><span className="chat-notice-label">{noticeLabel(t, notice)}</span>{time !== null && <> · {time}</>}</summary>
      <pre className="chat-compact-text chat-notice-text">{notice.text}</pre>
    </ChatDetails>;
  }
  const shell = turn.parts.find((part): part is Extract<ConversationPart, { kind: "shell" }> => part.kind === "shell");
  if (shell !== undefined) {
    return <article className="chat-turn chat-turn-user chat-shell">
      <p className="chat-shell-command"><SquareTerminal aria-hidden="true" /><code>{shell.command}</code></p>
      {shell.stdout && <pre className="chat-tool-io">{shell.stdout}</pre>}
      {shell.stderr && <pre className="chat-tool-io chat-shell-stderr">{shell.stderr}</pre>}
      <div className="chat-turn-meta">{time}</div>
      {outcome !== null && <OutcomeChip outcome={outcome} actions={outcomeActions} />}
    </article>;
  }
  if (turn.role === "user") {
    if (outcome !== null && terminalOnlyOutcome(outcome, outcomeActions)) return <TerminalCommandRow outcome={outcome} actions={outcomeActions} />;
    const text = userText(turn);
    // a teammate's delivery is recorded as a user prompt, but nobody typed it here
    const teammateParts = teammateMessageParts(text);
    if (teammateParts !== null) return <section className="chat-turn chat-teammate-messages" aria-label={t("Claude teammate messages")}>
      {teammateParts.map((part, index) => part.kind === "teammate"
        ? <TeammateMessageRow key={index} message={part} stateKey={String(index)} />
        : <UserMessage key={index} text={part.text} skills={userSkills} />)}
      <div className="chat-turn-meta">{time}<CopyButton text={text} label={t("Copy message")} onResult={copied} /></div>
      {copyError}
    </section>;
    return <article className="chat-turn chat-turn-user">
      <UserImages paneId={paneId} parts={turn.parts} text={text} />
      {/* one row: with a mouse the time and copy sit beside the bubble, on touch under it */}
      <div className="chat-user-row">
        {text.length > 0 && <UserMessage text={text} skills={userSkills} />}
        <div className="chat-turn-meta">{time}{text.length > 0 && <CopyButton text={text} label={t("Copy message")} onResult={copied} />}</div>
      </div>
      {copyError}
      {outcome !== null && <OutcomeChip outcome={outcome} actions={outcomeActions} />}
      {/* the skill this message invoked (omp, omo, pi): the runtime recorded its instructions with it */}
      <SkillActivityList parts={turn.parts} />
    </article>;
  }
  const { answer } = splitTurn(turn.parts);
  const answerText = answer.filter((part) => !requestDetails || part.failed !== true).map((part) => part.text).join("\n\n");
  const goal = turnGoal(turn.parts);
  const segments = turnSegments(turn.parts);
  const runs = segments.filter((segment): segment is WorkSegment => segment.kind === "work");
  const head = runs.filter((run) => visibleWorkParts(run.parts, showThinking).length > 0).at(-1) ?? runs.at(-1);
  const work = turnWork(turn.parts, rowKey);
  const drawn = (run: WorkSegment): boolean => visibleWorkParts(run.parts, showThinking).length > 0;
  const names = runNames(runs, work.at, memory?.runs ?? new Map(), drawn, memory?.dormant ?? new Map());
  const partNames = (shown: boolean) => new Map(runs.flatMap((run, index) => drawn(run) === shown ? run.parts.map((part) => [work.at.get(part)!, names[index]!] as const) : []));
  named.current = { runs: partNames(true), dormant: partNames(false) };
  const block = (run: WorkSegment | null) => {
    const isHead = run === null || run === head;
    const key = run === null ? `work:${turn.parts.length}` : names[runs.indexOf(run)]!;
    return <WorkBlockView key={key} paneId={paneId} parts={run?.parts ?? []} work={work} memoryKey={key}
      duration={isHead ? formatWorkDuration(turn.ts, turn.end_ts ?? null) : null} startedAt={isHead ? turn.ts : null} live={live && isHead} waiting={waiting && isHead}
      defaultOpen={workBlockStartsOpen({ live: live && isHead, waiting: waiting && isHead, last: run !== null && run === segments.at(-1) }, turn.parts, foldWork)}
      showThinking={showThinking} expandThinking={expandThinking} pendingHead={isHead && answer.length === 0} />;
  };
  return <article className="chat-turn chat-turn-agent">
    <SkillActivityList parts={turn.parts} />
    {goal !== null && <GoalActivity goal={goal} />}
    {/* the pending head stands only above no answer: one above words would leave a gap when the turn ends */}
    {head === undefined && live && answer.length === 0 && block(null)}
    {segments.map((segment) => segment.kind === "work" ? block(segment)
      : answerItems(segment.parts, requestDetails).map((item) => item.kind === "text"
        ? <Markdown key={`answer:${work.at.get(item.part)}`} skills={skills} visualizations>{item.part.text}</Markdown>
        : <FailedRequests key={`failed:${work.at.get(item.parts[0]!)}`} at={work.at.get(item.parts[0]!)!} parts={item.parts} followed={work.at.get(item.parts.at(-1)!)! < turn.parts.length - 1} live={live} />))}
    {answerText.length > 0 && <div className="chat-turn-meta chat-agent-meta">
      {/* a mouse reads one copy glyph and the words "Plain text"; touch reads the two formats */}
      <CopyButton className="chat-meta-btn" text={answerText} label={t("Copy as markdown")} onResult={copied}><span className="chat-meta-fmt">MD</span></CopyButton>
      <CopyButton className="chat-meta-btn chat-meta-plain" getText={() => plainText(answerText)} label={t("Copy as plain text")} onResult={copied}><span className="chat-meta-fmt">TXT</span><span className="chat-meta-word">{t("Plain text")}</span></CopyButton>
      {time}
    </div>}
    {copyError}
  </article>;
});

function fallbackTurn(message: TranscriptMessage): ConversationTurn {
  return { role: message.role === "user" ? "user" : "assistant", ts: null, parts: [{ kind: "text", text: message.text }] };
}

export function ChatFallback({ paneId, agent, visible, messages, scrollback, outcomes, restored, actions, skills, unavailable, onOpenTerminal }: {
  paneId: string; agent: string | null; visible: boolean; messages: readonly TranscriptMessage[]; outcomes: readonly CommandOutcome[];
  scrollback?: string;
  unavailable?: ConversationResponse["unavailable"];
  onOpenTerminal?: () => void;
  restored: string | null; actions: OutcomeActions | null; skills: SkillMatcher | null;
}) {
  const turns = useMemo(() => messages.filter((message) => message.role !== "status").map(fallbackTurn), [messages]);
  const rows = useMemo(() => outcomeRows(turns, outcomes, { restored }), [turns, outcomes, restored]);
  if (agent === null && scrollback !== undefined) return <>
    {scrollback.trim() !== "" && <TerminalSnapshot text={scrollback} />}
    {rows.map((row) => row.outcome !== null && <OutcomeChip key={`outcome:${row.outcome.id}`} outcome={row.outcome} actions={actions} snapshot={scrollback} />)}
  </>;
  return <>
    {agent !== null && unavailable !== undefined && <UnavailableReason agent={agent} reason={unavailable} onOpenTerminal={onOpenTerminal} />}
    {agent !== null && <TerminalFallback key={paneId} paneId={paneId} visible={visible} explained={unavailable !== undefined} />}
    {rows.map((row) => row.kind === "sent"
      ? <OutcomeRow key={`outcome:${row.outcome.id}`} outcome={row.outcome} actions={actions} skills={skills} />
      : <Turn key={row.index} paneId={paneId} turn={turns[row.index]!} rowKey={`fallback:${row.index}`} live={false} waiting={false} showThinking={false} outcome={row.outcome} outcomeActions={actions} />)}
  </>;
}

function UnavailableReason({ agent, reason, onOpenTerminal }: { agent: string; reason: NonNullable<ConversationResponse["unavailable"]>; onOpenTerminal?: () => void }) {
  const t = useT();
  const listed = agentName(agent);
  const name = listed === agent ? agentDisplayLabel(agent) : listed;
  const words = (() => {
    switch (reason) {
      case "not_found": return t("{agent} has not recorded a conversation Ovis can find for this pane yet. Before the first message this is normal; if it stays, use the terminal.", { agent: name });
      case "no_reader": return t("Ovis can't read {agent} conversations yet. Use the terminal to work with it.", { agent: name });
      case "unreadable": return t("Ovis couldn't find or read the file {agent} keeps this conversation in. Use the terminal.", { agent: name });
      case "no_integration": return t("{agent} chat needs herdr's {agent} integration, which is not installed on this PC. Settings → Agents shows the command that installs it; then start {agent} again in this pane.", { agent: name });
      case "no_folder": return t("herdr has not said which folder this pane is in, so Ovis can't find its conversation. Use the terminal.");
    }
  })();
  return <p className="chat-inline-state chat-unavailable-reason" role="status">
    {words}
    {onOpenTerminal && <> <button type="button" className="chat-outcome-action" onClick={onOpenTerminal}>{t("Open Terminal")}</button></>}
  </p>;
}

function TerminalSnapshot({ text }: { text: string }) {
  const t = useT();
  const [copyFailed, setCopyFailed] = useState(false);
  const section = useRef<HTMLElement>(null);
  // a new read replaces the whole text and would drop a selection in it: while one touches the snapshot, the
  // text on screen is pinned and the newer read waits; otherwise each read renders at once, so the chat's
  // follow of its end measures the new height in the same commit
  const [pinned, setPinned] = useState<string | null>(null);
  const followOnRelease = useRef(false);
  useEffect(() => {
    const update = () => {
      const selection = document.getSelection();
      const node = section.current;
      const held = selection !== null && !selection.isCollapsed && node !== null && selection.containsNode(node, true);
      if (!held) {
        const view = node?.closest<HTMLElement>(".chat-view");
        followOnRelease.current = view != null && view.scrollHeight - view.scrollTop - view.clientHeight <= 2;
      }
      setPinned((current) => held ? current ?? node?.querySelector("pre")?.textContent ?? null : null);
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);
  const shown = pinned ?? text;
  useLayoutEffect(() => {
    if (pinned !== null || !followOnRelease.current) return;
    followOnRelease.current = false;
    const view = section.current?.closest<HTMLElement>(".chat-view");
    if (view) view.scrollTop = view.scrollHeight;
  }, [pinned]);
  return <section ref={section} className="chat-terminal-snapshot" aria-label={t("Terminal")} data-newer-read={shown !== text ? "" : undefined}>
    <div className="chat-terminal-snapshot-head"><span><SquareTerminal aria-hidden="true" />{t("Terminal")}</span>
      <CopyButton className="chat-meta-btn" text={shown} label={t("Copy as plain text")} onResult={(ok) => setCopyFailed(!ok)}><span>{t("Copy")}</span></CopyButton>
    </div>
    <pre>{shown}</pre>
    {copyFailed && <p className="chat-copy-error" role="alert">{t("Couldn't copy. Select the text and copy it manually.")}</p>}
  </section>;
}

/** Optional terminal output must never hold initial display or transcript polling. */
function TerminalFallback({ paneId, visible, explained = false }: { paneId: string; visible: boolean; explained?: boolean }) {
  const { fetchPaneTranscript } = useMachineApi();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<UserFailure | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  useEffect(() => {
    if (!open || !visible) return;
    let cancelled = false;
    let timer: number | undefined;
    const read = async (): Promise<void> => {
      try {
        const result = await fetchPaneTranscript(paneId, TRANSCRIPT_LINES);
        if (cancelled) return;
        setText(result.text);
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(userFailure(cause));
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void read(), PROMPT_POLL_MS);
      }
    };
    void read();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [paneId, open, visible, fetchPaneTranscript, retryKey]);
  return <details className="chat-terminal-fallback" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    {/* a snapshot of the terminal's last lines, read again every few seconds: not the live terminal the header's Terminal opens */}
    <summary>{explained ? t("Show a terminal output preview") : t("Conversation unavailable — show a terminal output preview")}</summary>
    {text !== null && <TerminalSnapshot text={text} />}
    {text === null && error === null && <p className="chat-inline-state" role="status">{t("Loading…")}</p>}
    {error !== null && <FailureLine action={t("Couldn't load the terminal output")} failure={error} onRetry={() => setRetryKey((key) => key + 1)} />}
  </details>;
}

export const ChatView = memo(function ChatView({ paneId, presentationKey, finishEpoch, finishId, active = true, visible: paneVisible = true, pageScroll, refreshKey, invalidationKey = 0, onConversationWatch, conversationPushes = false, onTerminalOutput, sentKey = 0, unsentKey = 0, pendingRows = NO_ROWS, localSend, navigation, connected, ended, agent, agentStatus, agentSession = null, onMetadata, onRead, greeted = false, onPrompt, onSuggestion, onRestored, promptRefreshKey = 0, pendingAnswer = null, onPendingAnswerDone, promptDock = null, onPromptAnswered, title = null, onOpenTerminal, covered = false, peek = null, onCommandScreenClosed, onOutcomes, interactive = false, watching = false, quotable = false, cwd = null, promptContext = null, searchRequest = 0 }: ChatViewProps) {
  const t = useT();
  const { fetchPaneConversation, peekPaneConversation, fetchPanePromptState, fetchPaneTranscript } = useMachineApi();
  const { settings } = useSettings();
  const pagePrompts = HISTORY_PROMPTS;
  const autoTabNames = useRef(settings.autoTabNames);
  autoTabNames.current = settings.autoTabNames;
  const machineId = useMachineId();
  useEffect(() => {
    pinPaneConversation(paneId, machineId);
    return () => unpinPaneConversation(paneId, machineId);
  }, [paneId, machineId]);
  const commands = usePaneCommands(paneId, agent);
  const skillMatcher = useMemo(() => createSkillMatcher(commands, skillSyntax(agent)), [commands, agent]);
  const pageVisible = usePageVisible();
  const visible = paneVisible && pageVisible;
  const lastAnswer = useRef<ConversationResponse | null>(null);
  const [conversationRefresh] = useState(() => new ConversationRefresh());
  const onMetadataRef = useRef(onMetadata);
  onMetadataRef.current = onMetadata;
  const [state, setState] = useState<ChatState>(EMPTY_STATE);
  const [screenRead, setScreenRead] = useState(false);
  // Native Grok/Agy events can arrive while Herdr still reports ready/done. This is display
  // feedback only: sending, queuing and stopping retain the server's input authority.
  const [answerWait, setAnswerWait] = useState<{ pane: string; page: ConversationTurn[] } | null>(null);
  const pageEnd = state.turns.at(-1);
  const awaitingAnswer = answerWait !== null && answerWait.pane === paneId && (agentStatus === "idle" || agentStatus === "done")
    && (answerWait.page === state.turns || (pageEnd?.role === "assistant" && !endedOnAnswer(pageEnd)));
  const shownStatus = awaitingAnswer ? "working" : agentStatus;
  const activity = state.activity ?? (shownStatus === "working" ? "working" : "idle");
  const workStatus = state.activity !== undefined && agentStatus !== "blocked" ? activity === "idle" ? "idle" : "working" : shownStatus;
  const [error, setError] = useState<UserFailure | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [failures, setFailures] = useState(0);
  const [stale, setStale] = useState(false);
  const [newMessages, setNewMessages] = useState(false);
  const [away, setAway] = useState(false);
  const [viewer, setViewer] = useState<{ images: GalleryImage[]; index: number } | null>(null);
  const openViewer = useCallback((images: GalleryImage[], index: number) => setViewer({ images, index }), []);
  const openMarkdownImage = useCallback((image: GalleryImage) => openViewer([image], 0), [openViewer]);
  const closeViewer = useCallback(() => setViewer(null), []);
  const fileNames = useFileNameLookup(paneId, cwd, finishId);
  const [searching, setSearching] = useState(false);
  const seenSearchRequest = useRef(searchRequest);
  useEffect(() => {
    if (seenSearchRequest.current === searchRequest) return;
    seenSearchRequest.current = searchRequest;
    if (searchRequest > 0) setSearching(true);
  }, [searchRequest]);
  useEffect(() => { if (!paneVisible || covered) setSearching(false); }, [paneVisible, covered]);
  const closeSearch = useCallback(() => setSearching(false), []);
  const [loaded, setLoaded] = useState(false);
  const presentationRef = useRef(presentationKey); presentationRef.current = presentationKey;
  const finishRef = useRef({ epoch: finishEpoch, id: finishId, status: agentStatus });
  finishRef.current = { epoch: finishEpoch, id: finishId, status: agentStatus };
  const validatedPresentation = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (finishEpoch !== undefined && finishId !== undefined) conversationFinishEvidence.observe(seenKey(machineId, finishEpoch, paneId), finishId);
  }, [machineId, paneId, finishEpoch, finishId]);
  const [readPresentation, setReadPresentation] = useState<string>();
  const [endPresentation, setEndPresentation] = useState<{ state: ChatState; key: string | undefined } | null>(null);
  const [prompt, setPrompt] = useState<InteractivePrompt | null>(null);
  const [answeredPrompt, setAnsweredPrompt] = useState<string | null>(null);
  const sessionRef = useRef(agentSession);
  sessionRef.current = agentSession;
  const promptNow = useRef(prompt);
  promptNow.current = prompt;
  const cardLifetime = paneLifetimes.generation(machineId);
  const heldCardText = heldCardTextFor(paneStorageId(machineId, paneId));
  const trackCardText = (promptId: string, lifetime: string | null | undefined, text: string, cardGone = false): void => {
    const key = paneStorageId(machineId, paneId);
    // typed for a herdr that has gone since: recovery offers it, the pane that took its ID never gets it
    if (paneLifetimes.generation(machineId) !== lifetime) {
      if (text.trim() !== "") paneLifetimes.keep(machineId, paneId, "message", text);
      return;
    }
    if (cardGone || promptNow.current?.id !== promptId) {
      if (text.trim() !== "") composerDrafts.restorePending(composerDraftKey(key), text);
      return;
    }
    const typed = { machineId, paneId, session: sessionRef.current, promptId, text };
    setCardText(key, typed);
  };
  const promptOccurrence = useRef<{ of: InteractivePrompt | null; count: number }>({ of: null, count: 0 });
  if (prompt === null) promptOccurrence.current.of = null;
  else if (promptOccurrence.current.of?.id !== prompt.id) promptOccurrence.current = { of: prompt, count: promptOccurrence.current.count + 1 };
  const [abandoned, setAbandoned] = useState<{ count: number; branches: number; summary: string | null } | null>(null);
  const [transcriptBytes, setTranscriptBytes] = useState<number | null>(null);
  // the suggestion is handed up from each read, with the pane that read it: never kept here,
  // where a pane switch or a send upstream could leave it stale
  const onSuggestionRef = useRef(onSuggestion);
  onSuggestionRef.current = onSuggestion;
  const onRestoredRef = useRef(onRestored);
  onRestoredRef.current = onRestored;
  const [restored, setRestored] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<CommandOutcome[]>([]);
  const [outcomesRead, setOutcomesRead] = useState(false);
  const outcomesNow = useRef(outcomes);
  outcomesNow.current = outcomes;
  const [historyMove, setHistoryMove] = useState<HistoryMove & { history: string | undefined } | null>(null);
  const moveMade = useRef<CommandOutcome | null>(null);
  const enteredMoves = useRef<Set<string> | null>(null);
  const shownAt = useRef(0);
  const onOutcomesRef = useRef(onOutcomes);
  onOutcomesRef.current = onOutcomes;
  const catalogNoted = useRef(new Set<string>());
  const sentKeyRef = useRef(sentKey);
  sentKeyRef.current = sentKey;
  const [promptPollKey, setPromptPollKey] = useState(0);
  const ownNavigation = useRef(0);
  const navigationRef = navigation ?? ownNavigation;
  const navigated = (): void => { navigationRef.current += 1; };
  const seenLocalSend = useRef(localSend?.key ?? 0);
  const scroller = useRef<HTMLDivElement>(null);
  const timeline = useRef<LegendListRef>(null);
  const ChatTimeline = useChatTimeline();
  const stickToBottom = useRef(true);
  const restoring = useRef<ChatPosition | null>(null);
  const restorePages = useRef(0);
  const manualLayout = useRef(false);
  const selecting = useRef(false);
  const pagingAway = useRef(false);
  const openedAway = useRef(false);
  const lastScrollTop = useRef(0);
  const lastScrollGeometry = useRef<{ readonly node: HTMLDivElement; readonly height: number; readonly viewport: number } | null>(null);
  const scrollUpInputAt = useRef(-Infinity);
  const scrollDownInputAt = useRef(-Infinity);
  const scrollbarInputAt = useRef(-Infinity);
  const markScrollInput = useCallback((direction: -1 | 1): void => {
    restoring.current = null;
    const now = performance.now();
    scrollUpInputAt.current = direction < 0 ? now : -Infinity;
    scrollDownInputAt.current = direction > 0 ? now : -Infinity;
    scrollbarInputAt.current = -Infinity;
  }, []);
  const scrollGesture = useCallback((direction: -1 | 1): void => {
    markScrollInput(direction);
    if (direction < 0) dropPendingListScroll(timeline.current);
  }, [markScrollInput]);
  const pointerDragAt = useRef(-Infinity);
  const scrollInputRead = useRef(-Infinity);
  // A primary press on the transcript's scrollbar, while held: where it went down, and whether the
  // transcript moved up since. No pointermove comes while its thumb is dragged.
  const scrollbarPress = useRef<{ y: number; movedUp: boolean } | null>(null);
  const onScrollRef = useRef<() => void>(() => undefined);
  const followed = useCallback((top: number) => { lastScrollTop.current = top; }, []);
  const signature = useRef("");
  const [older, setOlder] = useState<ConversationTurn[]>([]);
  const olderCount = useRef(0);
  const incarnation = useRef(0);
  const slots = useRef(createChatRowSlots({ machineId, paneId, historyId: null, incarnation: 0 }, 0));
  const slotsHistory = useRef<string | null>(null);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [olderState, setOlderState] = useState<"idle" | "loading" | "failed">("idle");
  const heldFrom = useRef<string | null>(null);
  const loadingOlder = useRef(false);
  const olderGeneration = useRef(0);
  const history = useRef<string | undefined>(undefined);
  const [historyId, setHistoryId] = useState<string | undefined>(undefined);
  const shownPane = useRef(paneId);
  const prependAnchor = useRef<{ key: string; offset: number } | null>(null);
  const revealing = useRef<{ match: ConversationSearchMatch; done: (result: RevealResult) => void } | null>(null);
  const [revealTick, setRevealTick] = useState(0);
  const newestFailed = useRef(false);
  const stopRestore = useRef<(() => void) | null>(null);
  const [pollKey, setPollKey] = useState(0);
  /**
   * The assistant turn that was last when a message went out, with the turns it was read from.
   * It holds only while those turns are unchanged: once the transcript moves at all, the status
   * applies again (a slash command Claude logs as no user turn continues the very same turn).
   */
  const [sentOver, setSentOver] = useState<{ turn: ConversationTurn; page: ConversationTurn[] } | null>(null);
  const [cancelledAtSend, setCancelledAtSend] = useState<TurnIdentity | null>(null);
  const lastStopped = useRef<TurnIdentity | null>(null);
  const [goingCancel, setGoingCancel] = useState<{ id: string; turn: TurnIdentity } | null>(null);
  const goingId = pendingRows.find((row) => row.state === "sending")?.id ?? null;
  const heldPage = useRef<ConversationTurn[]>([]);
  const seenSent = useRef(sentKey);
  const seenUnsent = useRef(unsentKey);
  const seenStatus = useRef<{ pane: string; status: AgentStatus | undefined }>({ pane: paneId, status: agentStatus });
  const seenSession = useRef({ pane: paneId, session: agentSession });
  const seenConnected = useRef(connected);
  const wasConnected = useRef(connected);
  const seenInvalidation = useRef({ pane: paneId, key: invalidationKey });

  const dropOlder = (): void => {
    olderGeneration.current += 1; loadingOlder.current = false;
    heldFrom.current = null; olderCount.current = 0; setOlder([]); setOlderCursor(undefined); setOlderState("idle");
    incarnation.current += 1;
    prependAnchor.current = null;
    slots.current = createChatRowSlots({ machineId, paneId, historyId: history.current ?? null, incarnation: incarnation.current }, 0);
    slotsHistory.current = history.current ?? null;
  };

  const showAnswerDetails = (conversation: ConversationResponse): void => {
    if (heldFrom.current === null) setOlderCursor(conversation.source === "scrollback" ? undefined : conversation.cursor);
    onMetadataRef.current?.(paneId, conversation.metadata ?? null);
    setScreenRead(conversation.screen === true);
    setAbandoned(conversation.abandoned ?? null);
    setTranscriptBytes(conversation.transcript_bytes ?? null);
  };

  const showAnswer = (conversation: ConversationResponse, next: ChatState, moved: readonly ConversationTurn[] = []): void => {
    setStale(false);
    if (next.source === "conversation") {
      const count = olderCount.current + next.turns.length;
      if (slotsHistory.current !== (history.current ?? null) || lastAnswer.current?.source === "scrollback") {
        slots.current = createChatRowSlots({ machineId, paneId, historyId: history.current ?? null, incarnation: ++incarnation.current }, count);
        slotsHistory.current = history.current ?? null;
      } else if (count > slots.current.rows.length) {
        const previous = lastAnswer.current;
        const shown = previous !== null && previous.history_id === conversation.history_id ? previous.turns : [];
        slots.current = growChatRowSlots(slots.current, olderCount.current - moved.length, shown, moved, next.turns);
      } else if (count < slots.current.rows.length) {
        slots.current = { ...slots.current, rows: slots.current.rows.slice(0, count) };
      }
    }
    const nextSignature = JSON.stringify(next);
    if (nextSignature !== signature.current) {
      if (signature.current !== "" && !stickToBottom.current) setNewMessages(true);
      signature.current = nextSignature;
      setState(next);
    }
    setError(null); setErrorStatus(null); setFailures(0); setLoaded(true);
    lastAnswer.current = conversation;
  };

  useLayoutEffect(() => {
    shownPane.current = paneId;
    stopRestore.current?.();
    const saved = readChatPosition(paneStorageId(machineId, paneId));
    restoring.current = saved?.atEnd === false ? saved : null;
    restorePages.current = 0;
    history.current = undefined; setHistoryId(undefined); enteredMoves.current = null; shownAt.current = Date.now();
    pagingAway.current = restoring.current !== null;
    stickToBottom.current = !pagingAway.current;
    signature.current = ""; setState(EMPTY_STATE); setNewMessages(false); setAway(pagingAway.current); setLoaded(false); setError(null); setErrorStatus(null); setFailures(0); setPrompt(agentStatus === "blocked" ? keptPrompt(lastPrompts.get(paneStorageId(machineId, paneId)), agentSession) : null); setAbandoned(null); setRestored(null); setOutcomes([]); setOutcomesRead(false); setScreenRead(false);
    dropOlder();
    lastAnswer.current = null;
    setSentOver(null);
    setCancelledAtSend(null); setGoingCancel(null); lastStopped.current = null;
    wasConnected.current = connected;
    const cached = peekPaneConversation(paneId, pagePrompts);
    if (cached !== undefined && cached.source !== "scrollback" && loadedChatTimeline() !== null) {
      history.current = cached.history_id; setHistoryId(cached.history_id);
      showAnswerDetails(cached);
      showAnswer(cached, conversationState(cached));
    }
  }, [paneId, machineId]);


  useEffect(() => {
    if (seenSent.current === sentKey) return;
    seenSent.current = sentKey;
    const page = heldPage.current;
    const last = page[page.length - 1];
    setSentOver(last?.role === "assistant" && agentStatus !== "working" && agentStatus !== "blocked" ? { turn: last, page } : null);
    setCancelledAtSend(lastStopped.current);
  }, [sentKey, agentStatus]);
  useEffect(() => {
    if (seenUnsent.current === unsentKey) return;
    seenUnsent.current = unsentKey;
    setCancelledAtSend(null);
  }, [unsentKey]);

  useEffect(() => {
    if (goingId !== null && lastStopped.current !== null) setGoingCancel({ id: goingId, turn: lastStopped.current });
  }, [goingId]);
  useEffect(() => {
    if (goingCancel !== null && pendingRows.some((row) => row.id === goingCancel.id && row.state !== "sending")) setGoingCancel(null);
  }, [goingCancel, pendingRows]);

  useEffect(() => {
    const seen = seenStatus.current;
    seenStatus.current = { pane: paneId, status: agentStatus };
    if (seen.pane === paneId && statusEdgeRead(seen.status, agentStatus)) setPollKey((key) => key + 1);
  }, [paneId, agentStatus]);
  useEffect(() => {
    const seen = seenSession.current;
    seenSession.current = { pane: paneId, session: agentSession };
    if (seen.pane === paneId && seen.session !== agentSession) { setPrompt(null); setPromptPollKey((key) => key + 1); }
    if (seen.pane === paneId && seen.session !== agentSession) setPollKey((key) => key + 1);
  }, [paneId, agentSession]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const turnsBetween = async (held: string | null, start: string, signal: AbortSignal): Promise<ConversationTurn[] | null> => {
      const pages: ConversationTurn[][] = [];
      let before = start;
      try {
        for (let step = 0; step < 32 && before !== held; step++) {
          if (cancelled) return null;
          const page = await fetchPaneConversation(paneId, { before, ...(held === null ? {} : { since: held }), prompts: pagePrompts, signal });
          if (page.cursor === held) {
            pages.unshift(page.turns);
            return pages.flat();
          }
          if (typeof page.cursor !== "string") return null;
          pages.unshift(page.turns);
          before = page.cursor;
        }
      } catch (cause) {
        if (!(cause instanceof ApiError) || cause.status !== 409) throw cause;
        return null;
      }
      return before === held ? pages.flat() : null;
    };
    const read = async (signal: AbortSignal): Promise<void> => {
      const readKey = presentationRef.current;
      const finish = finishRef.current;
      const previousAnswer = lastAnswer.current ?? undefined;
      const page = { ...(heldFrom.current === null ? {} : { from: heldFrom.current }), history_id: previousAnswer?.history_id, prompts: pagePrompts, fresh: readKey !== validatedPresentation.current, signal };
       let generation = olderGeneration.current;
      newestFailed.current = false;
      try {
        let conversation;
        try {
          conversation = await fetchPaneConversation(paneId, page);
        } catch (cause) {
          // a new session or a Codex backtrack replaced the transcript the older pages came from
          if (!(cause instanceof ApiError) || cause.status !== 409) throw cause;
          if (cancelled || generation !== olderGeneration.current) return;
          try {
            conversation = await fetchPaneConversation(paneId, { prompts: pagePrompts, signal });
          } finally {
            if (!cancelled && generation === olderGeneration.current) {
              dropOlder(); signature.current = ""; lastAnswer.current = null;
              if (conversation === undefined) setState(EMPTY_STATE);
              generation = olderGeneration.current;
            }
          }
        }
        if (cancelled || generation !== olderGeneration.current) return;
        if (conversation.recovery === "waiting" && lastAnswer.current?.source === "copilot-transcript") {
          setStale(true); setLoaded(true); setError(null); setErrorStatus(null); setFailures(0); setReadPresentation(undefined);
          return;
        }
        if (conversation !== previousAnswer) validatedPresentation.current = readKey;
        // a tab herdr still names by its number takes its label from the first message (#2019)
        if (autoTabNames.current) learnFromConversation(machineId, paneId, conversation);
        const proved = finish.status !== "done" || (readKey === presentationRef.current && finishRef.current.status === "done"
          && finish.epoch !== undefined && finish.id !== undefined
          && conversationFinishEvidence.accept(seenKey(machineId, finish.epoch, paneId), finish.id, conversation, previousAnswer));
        if (conversation.source !== "scrollback" && loadedChatTimeline() === null) {
          await loadChatTimeline();
          if (cancelled || generation !== olderGeneration.current) return;
        }
        if (history.current !== conversation.history_id) {
          // the same turns under a new ID (gjc rewrote its file): the rows, what the reader opened and
          // where they read stay, so it is no navigation.
          const continued = olderCount.current === 0 && history.current !== undefined && conversation.history_id !== undefined
            && continuesHistory(lastAnswer.current, conversation);
          if (continued) {
            slotsHistory.current = conversation.history_id ?? null;
            olderGeneration.current += 1; loadingOlder.current = false; setOlderState("idle");
            const storageId = paneStorageId(machineId, paneId);
            const kept = readChatPosition(storageId);
            if (kept !== undefined && kept.historyId === (history.current ?? null)) rememberChatPosition(storageId, { ...kept, historyId: conversation.history_id ?? null });
            if (restoring.current !== null && restoring.current.historyId === history.current) restoring.current = { ...restoring.current, historyId: conversation.history_id ?? null };
          }
          else {
            if (history.current !== undefined) {
              navigated();
              // the sends to the history left behind are no receipts of this one: the last prompt poll holds them,
              // and the server lists them until herdr names the new session, which can be a poll after this read
              moveMade.current = null;
              setHistoryMove({ history: conversation.history_id, held: outcomesNow.current, entered: new Set(enteredMoves.current), seenAt: Date.now() });
            }
            dropOlder();
          }
          generation = olderGeneration.current;
          history.current = conversation.history_id; setHistoryId(conversation.history_id);
          if (!continued) {
            pagingAway.current = conversation.source !== "scrollback" && restoring.current?.historyId === (conversation.history_id ?? null);
            stickToBottom.current = !pagingAway.current;
            setNewMessages(false); setAway(pagingAway.current);
          }
        }
        if (conversation.source === "scrollback" && restoring.current !== null) {
          // a pane that shows no transcript now has no row to come back to: it follows its end
          restoring.current = null; pagingAway.current = false; stickToBottom.current = true; setAway(false);
        }
        if (conversation === lastAnswer.current) { setStale(false); setError(null); setErrorStatus(null); setFailures(0); setReadPresentation(proved ? readKey : undefined); return; }
        const previous = lastAnswer.current;
        const held = heldFrom.current ?? (previous?.source !== "scrollback" && previous?.history_id === conversation.history_id ? previous?.cursor : undefined);
        let moved: ConversationTurn[] = [];
        if (held !== undefined && conversation.source !== "scrollback" && typeof conversation.cursor === "string" && conversation.cursor !== held) {
          const between = await turnsBetween(held, conversation.cursor, signal);
          if (cancelled || generation !== olderGeneration.current) return;
          if (between === null) {
            dropOlder(); setState(EMPTY_STATE); setLoaded(false); forgetWaitingBaseline(waitingKey(machineId, paneId)); signature.current = ""; lastAnswer.current = null;
            setPollKey((key) => key + 1); return;
          }
          else { moved = between; heldFrom.current = conversation.cursor; }
        }
        if (moved.length > 0) {
          olderCount.current += moved.length;
          setOlder((turns) => [...turns, ...moved]);
        }
        showAnswerDetails(conversation);
        let next: ChatState;
        if (conversation.source !== "scrollback") next = conversationState(conversation);
        else if (agent !== null) next = { source: "scrollback", turns: [], messages: [], truncated: false, hint: conversation.hint, unavailable: conversation.unavailable };
        else {
          // The reader has rejected this history. Hide it before the separate terminal
          // request, which may wait or fail; a transport error must not revive those turns.
          if (lastAnswer.current?.source !== "scrollback") {
            setState((previous) => previous.source === "conversation"
              ? { source: "scrollback", turns: [], messages: [], truncated: false } : previous);
            signature.current = ""; lastAnswer.current = null;
          }
          const result = await fetchPaneTranscript(paneId, TRANSCRIPT_LINES, signal);
          if (cancelled || generation !== olderGeneration.current) return;
          next = { source: "scrollback", turns: [], messages: toTranscriptMessages(result.text).filter((message) => message.role !== "status"), scrollback: result.text, truncated: result.truncated === true, hint: conversation.hint, unavailable: conversation.unavailable };
        }
        showAnswer(conversation, next, moved);
        setReadPresentation(proved ? readKey : undefined);
      } catch (cause) {
        if (cancelled || generation !== olderGeneration.current || (cause instanceof DOMException && cause.name === "AbortError")) return;
        newestFailed.current = true;
        setStale(false);
        setLoaded(true);
        setError(userFailure(cause));
        setErrorStatus(cause instanceof ApiError ? cause.status : null);
        setFailures((count) => count + 1);
      }
    };
    conversationRefresh.setRead(read);
    onConversationWatch?.(paneId, true);
    return () => {
      cancelled = true;
      // Older pages queued behind this reader must not start for a hidden/replaced screen.
      olderGeneration.current += 1;
      loadingOlder.current = false; setOlderState("idle");
      setStale(false);
      onConversationWatch?.(paneId, false);
      conversationRefresh.stop();
    };
  }, [paneId, pagePrompts, fetchPaneConversation, fetchPaneTranscript, conversationRefresh, visible, onConversationWatch, agent]);

  useEffect(() => {
    if (visible) conversationRefresh.refresh();
  }, [paneId, pagePrompts, presentationKey, refreshKey, pollKey, visible, fetchPaneConversation, fetchPaneTranscript, conversationRefresh, onConversationWatch, agent]);

  useEffect(() => {
    const seen = seenInvalidation.current;
    seenInvalidation.current = { pane: paneId, key: invalidationKey };
    if (seen.pane === paneId && seen.key !== invalidationKey && visible) conversationRefresh.invalidate();
  }, [paneId, invalidationKey, visible, conversationRefresh]);

  useEffect(() => {
    conversationRefresh.setWaiting(stale);
  }, [stale, conversationRefresh]);

  useEffect(() => {
    conversationRefresh.setPushes(conversationPushes && (agent !== "copilot" || state.source !== "scrollback"));
  }, [conversationPushes, state.source, conversationRefresh, agent]);

  useEffect(() => {
    if ((state.source !== "scrollback" && !screenRead && !stale) || !visible || onTerminalOutput === undefined) return;
    onTerminalOutput(() => conversationRefresh.invalidate());
    return () => onTerminalOutput(null);
  }, [state.source, screenRead, stale, visible, onTerminalOutput, conversationRefresh]);

  useEffect(() => {
    const before = seenConnected.current;
    seenConnected.current = connected;
    const reconnect = wasConnected.current;
    if (connected) wasConnected.current = true;
    if (!connected || before || !visible) return;
    if (!reconnect && conversationRefresh.reading) return;
    conversationRefresh.restart();
  }, [connected, visible, conversationRefresh]);

  const loadOlder = useCallback(async (from?: { before: string; prompts: number }): Promise<ConversationResponse | null> => {
    const node = scroller.current;
    const before = from?.before ?? olderCursor;
    if (node === null || loadingOlder.current || stale || typeof before !== "string") return null;
    const generation = olderGeneration.current;
    let laid: ConversationResponse | null = null;
    loadingOlder.current = true;
    setOlderState("loading");
    await conversationRefresh.page(async (signal) => {
      try {
        if (shownPane.current !== paneId || olderGeneration.current !== generation) return;
        const page = await fetchPaneConversation(paneId, { before, prompts: from?.prompts ?? pagePrompts, signal });
        if (shownPane.current !== paneId || olderGeneration.current !== generation) return;
        if (autoTabNames.current) learnFromConversation(machineId, paneId, page);
        if (page.history_id !== history.current) {
          dropOlder(); setState(EMPTY_STATE); setLoaded(false); forgetWaitingBaseline(waitingKey(machineId, paneId)); signature.current = ""; lastAnswer.current = null;
          setPollKey((key) => key + 1); return;
        }
        if (page.source === "scrollback" || page.cursor === undefined) { setOlderCursor(undefined); setOlderState("idle"); return; }
        if (page.cursor === before) { setOlderState("failed"); return; }
        const first = heldFrom.current === null;
        heldFrom.current ??= before;
        if (restoring.current === null) {
          const top = node.getBoundingClientRect().top;
          const anchor = [...node.querySelectorAll<HTMLElement>("[data-chat-row]")]
            .filter((row) => row.getBoundingClientRect().bottom > top)
            .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
          if (anchor?.dataset.chatRow) prependAnchor.current = { key: anchor.dataset.chatRow, offset: anchor.getBoundingClientRect().top - top };
        }
        slots.current = prependChatRowSlots(slots.current, page.turns.length);
        olderCount.current += page.turns.length;
        setOlder((turns) => [...page.turns, ...turns]);
        setOlderCursor(page.cursor);
        setOlderState("idle");
        laid = page;
        if (first) setPollKey((key) => key + 1);
      } catch (cause) {
        if (shownPane.current !== paneId || olderGeneration.current !== generation) return;
        if (cause instanceof ApiError && cause.status === 409) {
          dropOlder(); setState(EMPTY_STATE); setLoaded(false); forgetWaitingBaseline(waitingKey(machineId, paneId)); signature.current = ""; lastAnswer.current = null;
          setPollKey((key) => key + 1);
        }
        else setOlderState("failed");
      } finally {
        if (olderGeneration.current === generation) loadingOlder.current = false;
      }
    }).catch((cause: unknown) => {
      // A page still queued when its screen closes is cancelled before its callback runs, so its
      // finally never clears the loading flags: clear them here, or Load older stays disabled
      if (!(cause instanceof DOMException && cause.name === "AbortError")) throw cause;
      if (olderGeneration.current === generation) { loadingOlder.current = false; setOlderState("idle"); }
    });
    return laid;
  }, [fetchPaneConversation, olderCursor, paneId, pagePrompts, conversationRefresh, stale]);

  useLayoutEffect(() => {
    const anchor = prependAnchor.current;
    if (anchor === null) return;
    prependAnchor.current = null;
    const index = slots.current.rows.findIndex((row) => row.key === anchor.key);
    if (index >= 0) void timeline.current?.scrollToIndex({ index, viewPosition: 0, viewOffset: anchor.offset, animated: false });
  }, [older]);

  // Prompts belong to the visible screen, not the native transcript: a Codex directory-trust
  // menu can appear while idle without any file mutation. Keep their independent 2s poll.
  const [promptStale, setPromptStale] = useState(false);
  const failedPromptReads = useRef(0);
  const promptGone = ended || agent === null;
  const pollPrompt = connected && !promptGone;
  const blocked = agentStatus === "blocked";
  useEffect(() => {
    const promptKey = paneStorageId(machineId, paneId);
    // (the same question asked by another session is another question: its card does not get the text)
    const keepCardText = (shown: string | null, session: string | null): void => {
      const typed = getMemoryCardText(promptKey);
      if (typed === undefined || (typed.promptId === shown && typed.session === session)) return;
      setCardText(promptKey, null);
      if (typed.text.trim() !== "") composerDrafts.restorePending(composerDraftKey(promptKey), typed.text);
    };
    if (promptGone) { lastPrompts.delete(promptKey); keepCardText(null, null); setPrompt(null); }
    if (!pollPrompt) { setPromptStale(false); failedPromptReads.current = 0; setRestored(null); onSuggestionRef.current?.(paneId, null); onRestoredRef.current?.(paneId, null); return; }
    if (!visible) return;
    let cancelled = false;
    let timer = 0;
    let quickReads = blocked ? BLOCKED_PROMPT_READS : 0;
    const readPrompt = async (): Promise<void> => {
      const sent = sentKeyRef.current;
      const session = sessionRef.current;
      const lifetime = paneLifetimes.generation(machineId);
      let quick = false;
      try {
        const next = await fetchPanePromptState(paneId);
        if (!cancelled) {
          failedPromptReads.current = 0;
          setPromptStale(false);
          // a read begun under a herdr that has gone since draws no card and keeps nothing for the new one
          if (paneLifetimes.generation(machineId) === lifetime) {
            keepCardText(next.prompt?.id ?? null, session);
            setPrompt((current) => polledPrompt(current, next.prompt));
            if (next.prompt === null) lastPrompts.delete(promptKey); else lastPrompts.set(promptKey, { machineId, session, prompt: next.prompt });
          }
          if (next.prompt === null && quickReads > 0) { quickReads -= 1; quick = true; } else quickReads = 0;
          setAnsweredPrompt(null);
          setOutcomes((current) => JSON.stringify(current) === JSON.stringify(next.outcomes) ? current : next.outcomes);
          setOutcomesRead(true);
          enteredMoves.current ??= new Set(next.outcomes.filter((outcome) => isSessionChange(outcome)
            && Date.parse(outcome.created_at) < shownAt.current).map((outcome) => outcome.id));
          onOutcomesRef.current?.(paneId, next.outcomes.map((outcome) => outcome.id));
          noteCatalogChanges(next.outcomes, catalogNoted.current, () => invalidatePaneCommands(paneId, machineId));
          if (sentKeyRef.current === sent) {
            onSuggestionRef.current?.(paneId, next.suggestion);
            setRestored(next.restored);
            onRestoredRef.current?.(paneId, next.restored);
          }
        }
      }
      // a read that failed (a network error, a server hiccup) says nothing about the screen: the card,
      // the suggestion and the restored send stay as they are until the next read answers. Reads that
      // keep failing let the card say so (#1335): answering stays safe, the server re-reads first
      catch { if (!cancelled) { setOutcomesRead(true); failedPromptReads.current += 1; if (failedPromptReads.current >= PROMPT_STALE_READS) setPromptStale(true); } }
      finally { if (!cancelled) timer = window.setTimeout(() => void readPrompt(), quick ? BLOCKED_PROMPT_READ_MS : PROMPT_POLL_MS); }
    };
    void readPrompt();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [pollPrompt, promptGone, paneId, machineId, promptPollKey, promptRefreshKey, fetchPanePromptState, visible, blocked]);

  useEffect(() => {
    onPrompt?.(paneId, prompt, prompt !== null && answeredPrompt === prompt.id);
    return () => onPrompt?.(paneId, null);
  }, [onPrompt, paneId, prompt, answeredPrompt]);

  useEffect(() => () => { onSuggestionRef.current?.(paneId, null); onRestoredRef.current?.(paneId, null); }, [paneId]);

  // away from the page, the prompt is not read: it can be answered in the terminal and asked
  // again unseen, so a typed pick waiting for Confirm does not outlive the page being hidden
  useEffect(() => {
    if (!visible) onPendingAnswerDone?.(paneId);
  }, [visible, onPendingAnswerDone, paneId]);

  const measureEnd = (): void => {
    const node = scroller.current;
    if (!node) return;
    if (!visible || (restoring.current !== null && state.source === "conversation")) { setEndPresentation(null); return; }
    // Every measurement path must respect a pending restore/minimap/page navigation.
    // Only genuinely short content cannot be moved away from its end, unless the reader opened
    // something in it: the records that make it longer must not pull that away (readOpened).
    if (!pagingAway.current) openedAway.current = false;
    if (pagingAway.current && (node.scrollHeight > node.clientHeight || openedAway.current)) {
      setEndPresentation(null);
      return;
    }
    const lastKey = timelineRows.at(-1)?.key;
    const last = lastKey === undefined ? null : node.querySelector<HTMLElement>(`[data-chat-row="${CSS.escape(lastKey)}"]`);
    const viewport = node.getBoundingClientRect();
    const bottom = last?.getBoundingClientRect().bottom;
    const atEnd = node.clientHeight > 0 && node.scrollHeight - node.clientHeight - node.scrollTop <= 1
      && (lastKey === undefined || (bottom !== undefined && bottom >= viewport.top && bottom <= viewport.bottom + 1));
    setEndPresentation((before) => atEnd
      ? before?.state === state && before.key === presentationKey ? before : { state, key: presentationKey }
      : null);
    if (atEnd) {
      if (!stickToBottom.current) manualLayout.current = false;
      pagingAway.current = false; stickToBottom.current = true;
      if (Math.max(scrollUpInputAt.current, scrollDownInputAt.current, pointerDragAt.current, scrollbarInputAt.current) <= scrollInputRead.current) {
        scrollUpInputAt.current = -Infinity; scrollDownInputAt.current = -Infinity; pointerDragAt.current = -Infinity;
        scrollbarInputAt.current = -Infinity;
      }
      setAway(false); setNewMessages(false);
    }
  };
  const measureEndRef = useRef(measureEnd);
  measureEndRef.current = measureEnd;

  useLayoutEffect(() => {
    const node = scroller.current;
    if (node !== null && stickToBottom.current && !selecting.current) {
      if (state.source === "conversation") timeline.current?.scrollToEnd({ animated: false });
      else node.scrollTop = node.scrollHeight;
    }
  }, [state, prompt, agentStatus, connected, ended]);

  // A resized composer, a raised keyboard or a narrower window shrinks the view
  // without a scroll event; a reader at the end stays at the end, at once. So does a
  // conversation that rewraps inside an unchanged view: its width or its type changed
  // (Settings → Chat width, Chat font size, Chat font). One that only grew taller did so under
  // the reader's hand (a folded block opened, a whole output asked for): following the end there
  // would jump past what was just opened. New messages follow in the layout effect above, and a
  // footer that grew (a sent message's bubble) in ChatTimeline.
  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    let lane = "";
    const observer = new ResizeObserver((entries) => {
      let follow = false;
      for (const entry of entries) {
        if (entry.target === node) { follow = true; continue; }
        const style = getComputedStyle(entry.target);
        const next = `${entry.contentRect.width}|${style.fontSize}|${style.fontFamily}`;
        if (next !== lane) { lane = next; follow = true; }
      }
      if (follow && stickToBottom.current && !selecting.current) {
        // Put the view at the DOM end before paint. A deferred scroll to the list's measured
        // end could undo that write if some of the transcript is still unmeasured.
        dropPendingListScroll(timeline.current);
        node.scrollTop = node.scrollHeight;
        followed(node.scrollTop);
      }
      measureEndRef.current();
    });
    observer.observe(node);
    if (node.firstElementChild !== null) observer.observe(node.firstElementChild);
    const content = new MutationObserver(() => measureEndRef.current());
    content.observe(node, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["style"] });
    return () => { observer.disconnect(); content.disconnect(); };
  }, [state.source, ChatTimeline, followed]);
  // One of the app's faces arrived (font-display: swap; a unicode-range chunk on the first Korean
  // answer): the conversation rewraps with no width, size or family string changed, so the
  // observer above takes it for one that only grew taller. A reader at the end stays at the end.
  const faces = useFacesArrived();
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node !== null && stickToBottom.current && !selecting.current) {
      if (timeline.current) timeline.current.scrollToEnd({ animated: false });
      else node.scrollTo({ top: node.scrollHeight, behavior: "instant" });
    }
  }, [faces]);
  useEffect(() => {
    const node = scroller.current;
    return node === null ? undefined : dismissKeyboardOn(node);
  }, [state.source, ChatTimeline]);

  useEffect(() => {
    if (!visible) return;
    let pointer: { x: number; y: number } | null = null;
    let touchY: number | undefined;
    // Upward wheel and touch gestures cancel queued following before the scroll event (#2594).
    // Paging keys record their direction; the scroll event confirms they moved the transcript.
    const mark = (event: Event): void => {
      const node = scroller.current;
      if (event instanceof KeyboardEvent) {
        if (!active || event.isComposing || event.keyCode === 229) return;
        if (event.target instanceof Element) {
          if (event.target.closest("input, textarea, select, [contenteditable]")) return;
          // Space activates the focused control, including a retry of the pending restore.
          if (event.key === " " && event.target.closest("button, summary, [role='button'], [role='tab']")) return;
        }
        if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home" || (event.key === " " && event.shiftKey)) markScrollInput(-1);
        else if (event.key === "ArrowDown" || event.key === "PageDown" || event.key === "End" || event.key === " ") markScrollInput(1);
        return;
      }
      if (event instanceof PointerEvent && (event.type === "pointerup" || event.type === "pointercancel")) {
        const press = scrollbarPress.current;
        if (event.type === "pointercancel") scrollbarInputAt.current = -Infinity;
        const dragged = press !== null && event.type === "pointerup" && event.clientY !== press.y;
        if (node !== null && node.scrollTop < lastScrollTop.current) {
          scrollUpInputAt.current = Math.max(scrollUpInputAt.current, dragged ? performance.now() : pointerDragAt.current);
          if (dragged) navigated();
        } else if (node !== null && dragged && press.movedUp && node.scrollHeight - node.clientHeight - node.scrollTop > READER_ALLOWANCE_PX) {
          navigated();
          if (stickToBottom.current) {
            pagingAway.current = true;
            dropPendingListScroll(timeline.current);
            onScrollRef.current();
          }
        }
        pointer = null; pointerDragAt.current = -Infinity; scrollbarPress.current = null; return;
      }
      // a press released where this page saw no pointerup has no button down by the next pointer
      // event, and a new press is a new gesture
      if (event instanceof PointerEvent && (event.type === "pointerdown" || (event.buttons === 0 && scrollbarPress.current !== null))) {
        scrollbarPress.current = null;
        scrollbarInputAt.current = -Infinity;
      }
      if (node === null || !(event.target instanceof Node) || !node.contains(event.target)) return;
      if (event instanceof WheelEvent && event.deltaY !== 0) scrollGesture(event.deltaY < 0 ? -1 : 1);
      if (event instanceof PointerEvent) {
        if (event.type === "pointerdown") {
          pointer = { x: event.clientX, y: event.clientY };
          pointerDragAt.current = -Infinity;
          // Track and arrow presses can scroll in either direction, even after pointerup.
          if (event.button === 0 && event.target === node && event.clientX >= node.getBoundingClientRect().left + node.clientWidth) {
            restoring.current = null;
            scrollbarInputAt.current = performance.now();
            scrollbarPress.current = { y: event.clientY, movedUp: false };
          }
        }
        else if (pointer !== null && event.buttons !== 0 && (event.clientX !== pointer.x || event.clientY !== pointer.y)) pointerDragAt.current = performance.now();
      }
      if ((event.type === "touchstart" || event.type === "touchmove") && event instanceof TouchEvent) {
        const y = event.touches[0]?.clientY;
        if (event.type === "touchmove" && y !== undefined && touchY !== undefined && y !== touchY) scrollGesture(y > touchY ? -1 : 1);
        touchY = y;
      }
    };
    const options = { capture: true, passive: true } as const;
    const types = ["wheel", "touchstart", "touchmove", "pointerdown", "pointermove", "pointerup", "pointercancel", "keydown"] as const;
    for (const type of types) document.addEventListener(type, mark, options);
    const letGo = (): void => { scrollbarPress.current = null; scrollbarInputAt.current = -Infinity; };
    const hidden = (): void => { if (document.visibilityState === "hidden") letGo(); };
    window.addEventListener("blur", letGo);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      for (const type of types) document.removeEventListener(type, mark, options);
      window.removeEventListener("blur", letGo);
      document.removeEventListener("visibilitychange", hidden);
      letGo();
    };
  }, [active, visible, markScrollInput, scrollGesture]);
  const onScroll = (listCorrected = false): void => {
    const node = scroller.current;
    if (node === null || !visible || (restoring.current !== null && state.source === "conversation")) return;
    const distanceFromBottom = node.scrollHeight - node.clientHeight - node.scrollTop;
    const movedBy = node.scrollTop - lastScrollTop.current;
    const scrollingDown = movedBy > 0;
    const scrollingUp = movedBy < 0;
    lastScrollTop.current = node.scrollTop;
    const geometry = lastScrollGeometry.current;
    lastScrollGeometry.current = { node, height: node.scrollHeight, viewport: node.clientHeight };
    const shrank = geometry?.node === node
      && (geometry.height - node.scrollHeight > READER_ALLOWANCE_PX || node.clientHeight < geometry.viewport);
    if (scrollingUp && scrollbarPress.current !== null) scrollbarPress.current.movedUp = true;
    const directionalInput = scrollingDown ? scrollDownInputAt : scrollUpInputAt;
    if (scrollingUp || scrollingDown) {
      directionalInput.current = Math.max(directionalInput.current, pointerDragAt.current, scrollbarInputAt.current);
      scrollbarInputAt.current = -Infinity;
      scrollInputRead.current = Math.max(scrollInputRead.current, directionalInput.current);
    }
    const byReader = performance.now() - directionalInput.current < SCROLL_INPUT_MS;
    const allowance = byReader ? READER_ALLOWANCE_PX : LAYOUT_ALLOWANCE_PX;
    // On first open the list can scroll down to the old end before the transcript grows.
    const stoppedShort = scrollingDown && timeline.current !== null;
    // A held selection can be trimmed by a pixel even when the rounded transcript height is unchanged.
    const selectionTrimmed = selecting.current && -movedBy <= READER_ALLOWANCE_PX;
    const layoutMoved = !byReader && (listCorrected || stoppedShort || (scrollingUp && (shrank || selectionTrimmed)));
    const readingUp = scrollingUp && (byReader || (!layoutMoved && distanceFromBottom > LAYOUT_ALLOWANCE_PX));
    if (readingUp) navigated();
    if ((!pagingAway.current || scrollingDown) && distanceFromBottom <= 1) pagingAway.current = false;
    if (readingUp && distanceFromBottom > allowance && stickToBottom.current && !pagingAway.current) {
      pagingAway.current = true;
      dropPendingListScroll(timeline.current);
    }
    // A held scrollbar thumb may not send any pointermove: let pointerup resolve that gesture
    // before correcting the view.
    if (layoutMoved && stickToBottom.current && !pagingAway.current && !manualLayout.current && !selecting.current
      && scrollbarPress.current === null && distanceFromBottom > READER_ALLOWANCE_PX) {
      if (!listEndPadded(node)) {
        node.scrollTop = node.scrollHeight;
        followed(node.scrollTop);
      }
      else if (scrollingUp && distanceFromBottom > LAYOUT_ALLOWANCE_PX) timeline.current?.scrollToEnd({ animated: false });
    }
    if (!stickToBottom.current || readingUp || pagingAway.current) {
      const following = !pagingAway.current && distanceFromBottom <= allowance;
      if (following && !stickToBottom.current) manualLayout.current = false;
      stickToBottom.current = following;
    }
    setAway(!stickToBottom.current);
    measureEnd();
    if (stopRestore.current !== null) return;
    if (loaded && state.source === "conversation") rememberPlace(node);
    if (node.scrollTop < LOAD_OLDER_PX && olderState === "idle") void loadOlder();
  };
  onScrollRef.current = onScroll;
  const rememberPlace = (node: HTMLDivElement): void => {
    if (stickToBottom.current) {
      rememberChatPosition(paneStorageId(machineId, paneId), {
        historyId: history.current ?? null, turn: "", offset: 0, atEnd: true,
      });
      return;
    }
    const { top, bottom } = node.getBoundingClientRect();
    let first: { key: string; top: number } | null = null;
    for (const row of node.querySelectorAll<HTMLElement>("[data-chat-row]")) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > top && rect.top < bottom && (first === null || rect.top < first.top)) first = { key: row.dataset.chatRow ?? "", top: rect.top };
    }
    const row = first === null ? undefined : timelineRows.find((candidate) => candidate.key === first.key);
    if (row === undefined || first === null) return;
    rememberChatPosition(paneStorageId(machineId, paneId), {
      historyId: history.current ?? null,
      turn: row.turn === null ? `outcome|${row.outcome.id}` : chatTurnAnchor(row.turn),
      offset: first.top - top,
      atEnd: false,
    });
  };
  const readOpened = useCallback((): void => {
    navigationRef.current += 1;
    restoring.current = null;
    if (!stickToBottom.current) return;
    pagingAway.current = true; stickToBottom.current = false; openedAway.current = true;
    dropPendingListScroll(timeline.current);
    const node = scroller.current;
    if (node !== null) node.scrollTo({ top: node.scrollTop, behavior: "instant" });
    setAway(true);
  }, [navigationRef]);
  const scrollToBottom = (): void => {
    const node = scroller.current;
    if (node === null) return;
    restoring.current = null;
    stopRestore.current?.();
    pagingAway.current = false; stickToBottom.current = true;
    manualLayout.current = false;
    rememberPlace(node);
    if (timeline.current) timeline.current.scrollToEnd({ animated: false });
    else node.scrollTo({ top: node.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    measureEnd();
  };
  useLayoutEffect(() => {
    if (localSend === undefined || seenLocalSend.current === localSend.key) return;
    seenLocalSend.current = localSend.key;
    if (localSend.navigationGeneration === navigationRef.current) scrollToBottom();
  }, [localSend]);
  useEffect(() => { if (!paneVisible) navigationRef.current += 1; }, [paneVisible, navigationRef]);
  useEffect(() => () => { navigationRef.current += 1; }, [navigationRef]);
  useLayoutEffect(() => {
    if (!pageScroll || covered) return;
    const scroll = (direction: -1 | 1) => {
      const node = scroller.current;
      if (!node) return;
      const prose = node.querySelector<HTMLElement>(".chat-turn-agent > .markdown, .chat-bubble") ?? node;
      const style = getComputedStyle(prose);
      const lineHeight = parseFloat(style.lineHeight);
      const rowHeight = Number.isFinite(lineHeight) ? lineHeight : parseFloat(style.fontSize);
      const distance = pageScrollDistance(node.clientHeight, rowHeight, PAGE_OVERLAP_ROWS);
      const before = node.scrollTop;
      node.scrollTo({ top: before + direction * distance, behavior: "instant" });
      const moved = node.scrollTop !== before;
      const gap = node.scrollHeight - node.clientHeight - node.scrollTop;
      // PageUp may already be clamped at the start, with the scroll that got there still undelivered.
      const pageUp = direction < 0 && (moved || (stickToBottom.current && gap > READER_ALLOWANCE_PX));
      if (moved || (pageUp && before < lastScrollTop.current)) markScrollInput(direction);
      if (pageUp) {
        pagingAway.current = true;
        dropPendingListScroll(timeline.current);
      }
      if (moved) lastScrollTop.current = before;
      // A physical end may still report a positive subpixel gap, even with no movement.
      if (direction > 0 && gap <= READER_ALLOWANCE_PX) pagingAway.current = false;
      onScroll();
    };
    pageScroll.current = scroll;
    return () => { if (pageScroll.current === scroll) pageScroll.current = null; };
  });
  const turns = useMemo(() => older.length > 0 ? [...older, ...state.turns] : state.turns, [older, state.turns]);
  const stopped = useMemo(() => stoppedTurn(turns, restored), [turns, restored]);
  if (stopped !== null) lastStopped.current = stopped;
  const goneOut = goingCancel !== null && !pendingRows.some((row) => row.id === goingCancel.id && row.state !== "sending");
  const hiddenTurn = stopped ?? (endsWithTurn(turns, cancelledAtSend) ? cancelledAtSend : null)
    ?? (goneOut && endsWithTurn(turns, goingCancel.turn) ? goingCancel.turn : null);
  const hiddenSend = restored ?? hiddenTurn?.text ?? null;
  const shownTurns = useMemo(() => hiddenTurn !== null ? turns.slice(0, -1) : turns, [turns, hiddenTurn]);
  heldPage.current = state.turns;
  const finishedBeforeSend = sentOver !== null && sentOver.page === state.turns ? sentOver.turn : null;
  const lastShownTurn = state.source === "conversation" ? shownTurns.at(-1) : undefined;
  const stats = useMemo(() => loaded && state.source === "conversation" ? sessionStats(shownTurns, olderCursor === null, transcriptBytes) : null,
    [loaded, state.source, shownTurns, olderCursor, transcriptBytes]);
  const statsView = useRef(Symbol("chat view")).current;
  useEffect(() => { publishSessionStats(machineId, paneId, statsView, stats); }, [machineId, paneId, statsView, stats]);
  useEffect(() => () => publishSessionStats(machineId, paneId, statsView, null), [machineId, paneId, statsView]);
  // Claude Code's activity is herdr's status, which can rest before a read holds the turn's answer:
  // the turn stays at work until one does. Before paint, so no frame shows it ended with no answer.
  const answerEdge = useRef<{ pane: string; status: AgentStatus | undefined }>({ pane: paneId, status: agentStatus });
  useLayoutEffect(() => {
    const seen = answerEdge.current;
    answerEdge.current = { pane: paneId, status: agentStatus };
    if (seen.pane !== paneId || seen.status !== "working" || (agentStatus !== "idle" && agentStatus !== "done")) return;
    if (state.conversationSource !== "claude-transcript" || state.activity !== undefined || lastShownTurn === undefined) return;
    if (lastShownTurn.role === "assistant" && endedOnAnswer(lastShownTurn)) return;
    setAnswerWait({ pane: paneId, page: state.turns });
  }, [paneId, agentStatus]);
  const awaitedPage = awaitingAnswer ? state.turns : null;
  useEffect(() => {
    if (answerWait === null) return;
    const timer = window.setTimeout(() => setAnswerWait(null), ANSWER_READ_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [answerWait, awaitedPage]);
  const lastSplit = lastShownTurn !== undefined && isLiveWorkTurn(lastShownTurn, true, workStatus, finishedBeforeSend) ? splitTurn(lastShownTurn.parts) : null;
  const workBlockLive = lastSplit !== null && (visibleWorkParts(lastSplit.work, settings.showThinking).length > 0 || lastSplit.answer.length === 0);
  const answerOnlyLive = lastSplit !== null && !workBlockLive;
  const answeredRow = lastShownTurn?.role === "assistant" && endedOnAnswer(lastShownTurn) ? slots.current.rows[shownTurns.length - 1]?.key ?? null : null;
  const restedUnder = useRef<string | null>(null);
  useLayoutEffect(() => {
    if ((workStatus === "idle" || workStatus === "done") && answeredRow !== null) restedUnder.current = answeredRow;
  }, [workStatus, answeredRow]);
  const afterAnswer = workStatus === "working" && lastShownTurn !== finishedBeforeSend && answeredRow !== null;
  const answerTurn = afterAnswer && restedUnder.current === answeredRow ? answeredRow : null;
  const [lagOutFor, setLagOutFor] = useState<string | null>(null);
  useEffect(() => {
    if (answerTurn === null) { setLagOutFor(null); return; }
    const timer = window.setTimeout(() => setLagOutFor(answerTurn), ANSWER_STATUS_LAG_MS);
    return () => window.clearTimeout(timer);
  }, [answerTurn, paneId]);
  const answerLagOut = answerTurn !== null && lagOutFor === answerTurn;
  const activityReserved = afterAnswer && !answerLagOut;
  const activityClass = activityReserved ? "chat-activity-reserved" : "chat-activity";
  const empty = state.source === "conversation" ? turns.length === 0 : agent === null && (state.scrollback ?? "").trim() === "";
  const blank = !ended && chatIsBlank({ loaded, failed: error !== null, transcript: state.source === "conversation", turns: turns.length, older: typeof olderCursor === "string", abandoned: abandoned?.count ?? 0, prompt: prompt !== null, agent });
  const known = loaded && error === null && !ended && state.source === "conversation";
  const held = turns.length + (abandoned?.count ?? 0);
  useLayoutEffect(() => {
    onRead?.(paneId, known ? { blank, turns: held, history: historyId } : null);
  }, [onRead, paneId, known, blank, held, historyId]);
  useLayoutEffect(() => () => onRead?.(paneId, null), [onRead, paneId]);

  const rowSlots = slots.current.rows;
  const timelineScope = JSON.stringify(slots.current.scope);
  useEffect(() => setViewer(null), [timelineScope]);
  const rowMemories = useMemo(() => new Map<string, ChatRowMemory>(), [timelineScope]);
  const shownOutcomes = useMemo(() => {
    if (historyMove === null || historyMove.history !== historyId) return outcomes;
    if (moveMade.current === null) {
      moveMade.current = moveCommand(outcomes, historyMove);
      if (moveMade.current !== null) enteredMoves.current?.add(moveMade.current.id);
    }
    return afterMove(outcomes, historyMove, moveMade.current, shownTurns);
  }, [outcomes, historyMove, historyId, shownTurns]);
  const withOutcomes = useMemo(() => outcomeRows(shownTurns, shownOutcomes, { restored: hiddenSend, beginningLoaded: olderCursor === null }), [shownTurns, shownOutcomes, hiddenSend, olderCursor]);
  const timelineRows = useMemo((): ChatRow[] => {
    const rows = withOutcomes.map((row): ChatRow => {
      if (row.kind === "sent") return { key: `outcome:${row.outcome.id}`, turn: null, outcome: row.outcome, beforeUser: false };
      const slot = rowSlots[row.index];
      if (!slot) throw new Error("A loaded chat turn has no row identity");
      return { key: slot.key, turn: shownTurns[row.index]!, index: row.index, outcome: row.outcome, beforeUser: false };
    });
    return rows.map((row, index) => {
      const next = rows[index + 1];
      return { ...row, beforeUser: row.turn?.role === "assistant" && next !== undefined && (next.turn === null || next.turn.role === "user") };
    });
  }, [withOutcomes, shownTurns, rowSlots]);
  const placeRow = (list: LegendListRef, node: HTMLDivElement, index: number, offset: number): void => {
    stopRestore.current?.();
    const key = timelineRows[index]!.key;
    pagingAway.current = true; stickToBottom.current = false; setAway(true);
    navigated();
    void list.scrollToIndex({ index, viewPosition: 0, viewOffset: offset, animated: false });
    const olderAt = olderCount.current;
    let frame = 0, frames = 0, stable = 0;
    const stop = (): void => {
      cancelAnimationFrame(frame);
      for (const type of ["wheel", "touchmove", "pointerdown"]) node.removeEventListener(type, stop);
      document.removeEventListener("keydown", stop, true);
      if (stopRestore.current === stop) stopRestore.current = null;
    };
    const settle = (): void => {
      if (++frames > 30 || timeline.current !== list || olderCount.current !== olderAt || prependAnchor.current !== null) { stop(); return; }
      const row = node.querySelector<HTMLElement>(`[data-chat-row="${CSS.escape(key)}"]`);
      if (row !== null) {
        const delta = row.getBoundingClientRect().top - node.getBoundingClientRect().top - offset;
        if (Math.abs(delta) > 1) { stable = 0; void list.scrollToOffset({ offset: node.scrollTop + delta, animated: false }); }
        else if (++stable >= 2) { stop(); rememberPlace(node); return; }
      }
      frame = requestAnimationFrame(settle);
    };
    for (const type of ["wheel", "touchmove", "pointerdown"]) node.addEventListener(type, stop, { passive: true });
    document.addEventListener("keydown", stop, true);
    stopRestore.current = stop;
    frame = requestAnimationFrame(settle);
  };
  // A retained pane can scroll during its hidden layout. Only a visible chat supplies a place.
  useLayoutEffect(() => {
    if (visible) return;
    stopRestore.current?.();
    // a restore on its way keeps going; a chat at its end (reached without a scroll too, when the whole
    // transcript came to fit) or with no transcript has no place to come back to
    if (restoring.current !== null || stickToBottom.current || state.source !== "conversation") return;
    const saved = readChatPosition(paneStorageId(machineId, paneId));
    restoring.current = saved?.atEnd === false ? saved : null;
    restorePages.current = 0;
  }, [visible, machineId, paneId]);
  // Where a kept row missing from the loaded rows can still come from: outcome rows come with the prompt
  // state, turns with earlier pages, until the loaded turns reach back past the row's time.
  const restoreReach = (saved: ChatPosition): "wait" | "older" | "gone" => {
    const outcome = saved.turn.startsWith("outcome|");
    if (outcome && pollPrompt && !outcomesRead) return "wait";
    const at = outcome ? outcomes.find((item) => `outcome|${item.id}` === saved.turn)?.created_at : saved.turn.split("|")[1];
    if ((outcome && at === undefined) || typeof olderCursor !== "string") return "gone";
    const time = Date.parse(at ?? "");
    const first = Date.parse(shownTurns.find((turn) => turn.ts !== undefined)?.ts ?? "");
    if (Number.isFinite(time)) return Number.isFinite(first) && first < time ? "gone" : "older";
    return restorePages.current < RESTORE_PAGES ? "older" : "gone";
  };
  useLayoutEffect(() => {
    const saved = restoring.current;
    if (saved === null || !visible || !loaded || error !== null || state.source !== "conversation") return;
    const list = timeline.current, node = scroller.current;
    if (node === null || list === null) return;
    if (saved.historyId !== (history.current ?? null)) {
      scrollToBottom();
      return;
    }
    const index = chatRestoreIndex(saved, history.current ?? null, timelineRows.map((row) => row.turn === null ? `outcome|${row.outcome.id}` : chatTurnAnchor(row.turn)));
    if (index !== null) {
      restoring.current = null;
      placeRow(list, node, index, saved.offset);
    } else if (restoreReach(saved) !== "gone") {
      // Remounts initially have only the newest page. Keep the place until its row is loaded.
      dropPendingListScroll(list);
      pagingAway.current = true; stickToBottom.current = false; setAway(true);
    } else scrollToBottom();
  }, [visible, loaded, error, state.source, timelineRows, olderCursor, outcomesRead, pollPrompt]);
  useEffect(() => {
    const saved = restoring.current;
    if (!visible || !loaded || error !== null || state.source !== "conversation" || saved === null || olderState !== "idle" || restoreReach(saved) !== "older") return;
    restorePages.current += 1;
    void loadOlder();
  }, [visible, loaded, error, state.source, olderState, olderCursor, loadOlder, outcomes, outcomesRead, pollPrompt]);
  useLayoutEffect(() => {
    const pick = revealing.current;
    const list = timeline.current, node = scroller.current;
    if (pick === null) return;
    revealing.current = null;
    if (list === null || node === null) { pick.done("failed"); return; }
    const index = pickedTurn(timelineRows.map((row) => row.turn), pick.match);
    if (typeof index !== "number") { pick.done("missing"); return; }
    placeRow(list, node, index, 0);
    const { turn, key } = timelineRows[index]!;
    const folded = turn !== null ? foldedRequestsMatch(turn, pick.match.match) : null;
    if (folded !== null) {
      chatRowMemory(rowMemories, key).toggles.set(`failed:${folded}`, true);
      const row = node.querySelector<HTMLDetailsElement>(`[data-chat-row="${CSS.escape(key)}"] details[data-failed-requests="${folded}"]`);
      if (row !== null) row.open = true;
    }
    if (turn !== null && turn.role === "user" && shouldFoldUserMessage(userText(turn))) {
      chatRowMemory(rowMemories, key).toggles.set("fold", true);
      node.querySelector<HTMLButtonElement>(`[data-chat-row="${CSS.escape(key)}"] .chat-bubble.is-capped .chat-bubble-fold`)?.click();
      const words = pick.match.match;
      requestAnimationFrame(() => {
        if (timeline.current !== list) return;
        const row = node.querySelector<HTMLElement>(`[data-chat-row="${CSS.escape(key)}"]`);
        const at = row === null ? null : matchTop(row, words);
        if (at !== null && at > node.clientHeight / 3) placeRow(list, node, index, Math.round(node.clientHeight / 3 - at));
      });
    }
    pick.done("shown");
  }, [timelineRows, revealTick]);
  const revealTurn = async (match: ConversationSearchMatch): Promise<RevealResult> => {
    restoring.current = null;
    stopRestore.current?.();
    const reveal = (): Promise<RevealResult> => new Promise((done) => {
      revealing.current?.done("missing");
      revealing.current = { match, done };
      setRevealTick((tick) => tick + 1);
    });
    let read: readonly ConversationTurn[] = shownTurns;
    const generation = olderGeneration.current;
    const revealNewest = async (): Promise<RevealResult> => {
      await conversationRefresh.refreshed();
      if (olderGeneration.current !== generation) return "missing";
      return newestFailed.current ? "failed" : reveal();
    };
    if (pickAhead(read, match)) return revealNewest();
    if (pickSettled(read, match)) return reveal();
    for (let before = olderCursor; typeof before === "string";) {
      const page = await loadOlder({ before, prompts: LARGEST_PAGE });
      if (olderGeneration.current !== generation) return "missing";
      if (page === null) return "failed";
      read = [...page.turns, ...read];
      if (pickAhead(read, match)) return revealNewest();
      if (pickSettled(read, match)) return reveal();
      before = page.cursor;
    }
    return match.row !== undefined ? revealNewest() : reveal();
  };
  useLayoutEffect(() => { measureEnd(); });
  useEffect(() => () => stopRestore.current?.(), []);
  const minimap = useMemo(() => {
    const rowOfTurn = new Map(timelineRows.flatMap((row, index) => row.turn === null ? [] : [[row.index, index] as const]));
    return minimapTurns(shownTurns).map((tick) => ({ ...tick, row: rowOfTurn.get(tick.row) ?? tick.row }));
  }, [shownTurns, timelineRows]);
  const rowKeys = useMemo(() => timelineRows.map((row) => row.key), [timelineRows]);
  const jumpToTurn = useCallback((index: number) => {
    restoring.current = null;
    stopRestore.current?.();
    pagingAway.current = true; stickToBottom.current = false; setAway(true);
    navigationRef.current += 1;
    void timeline.current?.scrollToIndex({ index, animated: false, viewPosition: 0 });
  }, [navigationRef]);
  const minimapWheel = useCallback((deltaY: number) => {
    if (deltaY !== 0) scrollGesture(deltaY < 0 ? -1 : 1);
  }, [scrollGesture]);
  const focusPrompt = useCallback(() => {
    const card = promptDock?.querySelector<HTMLElement>(".prompt-card");
    if (!card) return;
    const control = card.querySelector<HTMLElement>(".prompt-card-options button:not([disabled]), .prompt-card-options input:not([disabled])") ?? card.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled])");
    control?.focus();
  }, [promptDock]);
  const promptUp = prompt !== null;
  const peekSentAt = useRef<{ peek: TerminalPeek; at: string } | null>(null);
  useEffect(() => {
    if (peek === null || onCommandScreenClosed === undefined) return;
    let at = peekSentAt.current?.peek === peek ? peekSentAt.current.at : null;
    if (at === null) {
      at = sentOutcome(peek, outcomes)?.created_at ?? null;
      if (at === null) return;
      peekSentAt.current = { peek, at };
    }
    if (commandScreenClosed(peek, agent, at, turns)) onCommandScreenClosed(peek);
  }, [peek, outcomes, turns, agent, onCommandScreenClosed]);
  const openTerminal = useMemo(() => onOpenTerminal ? () => onOpenTerminal("") : undefined, [onOpenTerminal]);
  const outcomeActions = useMemo((): OutcomeActions => ({ answer: promptUp ? focusPrompt : null, terminal: onOpenTerminal ?? null, commands }), [promptUp, focusPrompt, onOpenTerminal, commands]);
  const renderTurn = useCallback((row: ChatRow) => {
    if (row.turn === null) return <OutcomeRow outcome={row.outcome} actions={outcomeActions} skills={skillMatcher} />;
    const { turn } = row;
    const live = isLiveWorkTurn(turn, row.index === shownTurns.length - 1, workStatus, finishedBeforeSend);
    return <RenderBoundary resetKey={turnRevision(turn, true)} fallback={() => <p className="chat-inline-state chat-inline-error" data-pane-content-error>{t("This message can't be shown here. The terminal has it.")}</p>}>
      <Turn paneId={paneId} turn={turn} rowKey={row.key} live={live} waiting={isWaitingWorkTurn(live, agentStatus)} showThinking={settings.showThinking}
        expandThinking={settings.expandThinking} foldWork={settings.foldWork} requestDetails skills={skillMatcher} userSkills={skillMatcher} outcome={row.outcome} outcomeActions={outcomeActions} />
    </RenderBoundary>;
  }, [shownTurns.length, workStatus, finishedBeforeSend, t, paneId, agentStatus, settings.showThinking, settings.expandThinking, settings.foldWork, skillMatcher, outcomeActions]);
  const shownTitle = title?.trim() ?? "";
  const logLabel = shownTitle !== "" && shownTitle !== paneId ? t("conversation of {pane}", { pane: shownTitle }) : t("Conversation");
  const header = <>
      {/* the conversation below is not all the file holds: a /tree left these behind, and pi moved
          its leaf without writing anything, so nothing here could say they were ever there. First
          in the transcript, because paging back would otherwise drop them under their own heading */}
      {state.source === "conversation" && abandoned !== null && abandoned.count > 0 && (
        <details className="chat-compact chat-abandoned">
          <summary>{t(abandoned.branches > 1
            ? abandoned.count === 1 ? "{n} earlier turn on {b} branches you navigated away from" : "{n} earlier turns on {b} branches you navigated away from"
            : abandoned.count === 1 ? "{n} earlier turn on a branch you navigated away from" : "{n} earlier turns on a branch you navigated away from",
            { n: abandoned.count, b: abandoned.branches })}</summary>
          {abandoned.summary !== null
            ? <div className="chat-compact-text"><Markdown>{abandoned.summary}</Markdown></div>
            : <p className="chat-abandoned-note">{t("pi kept them in the session file but answers from the branch you chose. Use /tree in the terminal to go back.")}</p>}
        </details>
      )}
      {/* one button in every state: swapping it for a status line of another height would shift the reader */}
      {state.source === "conversation" && typeof olderCursor === "string" && (
        <button type="button" className="btn btn-ghost chat-older" disabled={olderState === "loading" || stale} onClick={() => void loadOlder()}>
          {t(olderState === "loading" ? "Loading earlier messages…" : olderState === "failed" ? "Couldn't load earlier messages — retry" : "Earlier messages")}
        </button>
      )}
      {state.source === "conversation" && olderCursor === null && older.length > 0 && <p className="chat-endcap">{t("beginning of conversation")}</p>}
  </>;
  // the chat's one wait is a live region in the footer from the view's first render, clipped while
  // empty (never display: none); its words land a frame after it (lib/useAnnouncedText.ts).
  const waiting = error !== null && error.kind === "slow" && failures < SLOW_READS_BEFORE_ALARM;
  // A message this browser sent that the pane has not written as a turn yet: Claude records the user
  // turn only when its next turn starts, so without this the chat would show nothing at all.
  const waitKey = waitingKey(machineId, paneId);
  const sentWaiting = useWaitingSends(machineId, paneId, connected);
  const turnsRead = loaded && error === null && !stale && state.source === "conversation";
  useLayoutEffect(() => {
    settleWaitingSends(waitKey, state.turns, Date.now(), turnsRead, state.conversationSource);
  }, [sentWaiting, state.conversationSource, state.turns, turnsRead, waitKey]);
  const waitWords = useAnnouncedText(!loaded && error === null ? t("Loading conversation…") : waiting ? t("Waiting for the PC…") : null);
  const retryRead = useCallback(() => { setFailures(0); conversationRefresh.refresh(); }, [conversationRefresh]);
  const footer = <>
      <p className={waitWords === null ? "visually-hidden" : "chat-inline-state"} role="status">{waitWords}</p>
      {sentWaiting.length > 0 && state.source === "conversation" && <SentWaitingList sends={sentWaiting} paneKey={waitKey} agent={agent}
        resting={workStatus === "idle" || workStatus === "done"} onOpenTerminal={openTerminal} />}
      {error !== null && !waiting && (errorStatus === 401
        ? <p className="chat-inline-state chat-inline-error" role="alert">{t("locked — the token gate is asking again")}</p>
        : <FailureLine action={t("Couldn't load the conversation")} failure={error} onRetry={retryRead} />)}
      {stale && error === null && <p className="chat-inline-state" role="status">{t("Updates paused — waiting for the agent's next activity")}</p>}
      {loaded && error === null && agent === "grok" && state.source !== "conversation" && state.unavailable === undefined && <p className="chat-inline-state" role="status">{t("Grok chat is unavailable. Open Terminal to see activity and tool calls.")}</p>}
      {loaded && error === null && agent === "agy" && state.source !== "conversation" && state.unavailable === undefined && <p className="chat-inline-state" role="status">{t("Antigravity chat is unavailable. Open Terminal to see activity and tool calls.")}</p>}
      {loaded && error === null && agent === "copilot" && state.source === "scrollback" && state.hint === "copilot_ui_server" && <p className="chat-inline-state" role="status">{t("Copilot chat is unavailable. On Linux, starting Copilot with copilot --ui-server --port=0 may help. Its local API has no authentication: any program on this PC can control that session.")}</p>}
      {/* The agent's activity, where no open work block says it: before the turn has an assistant or
          tool row (Claude Code's spinner writes nothing to the transcript), and while a native turn
          thinks (a work block's head says Working). Without native activity the pane status stands
          in. One Working at a time, so none before the first read: its rows may hold the running
          turn's own head. None seen under an answer while the status may still be catching up with it. */}
      {connected && loaded && !ended && activity !== "idle" && agentStatus !== "blocked" && prompt === null && !(greeted && blank) && (activity === "thinking" || !workBlockLive) && (workBlockLive
        ? <p className={`${activityClass} chat-activity-line`} role="status" aria-hidden={activityReserved || undefined}><CircleDot aria-hidden="true" />{t("Thinking…")}</p>
        : answerOnlyLive
          ? <p className={`${activityClass} chat-activity-line`} role="status" aria-hidden={activityReserved || undefined}><CircleDot aria-hidden="true" />{activity === "thinking" ? t("Thinking…") : t("Working…")}</p>
          : <PendingWorkHead className={activityClass} reserved={activityReserved} title={activity === "thinking" ? t("Thinking…") : t("Working…")} />)}
      {loaded && empty && error === null && prompt === null && activity === "idle" && !(greeted && blank) && sentWaiting.length === 0 && <div className="chat-empty"><AgentMark agent={agent ?? "agent"} size={32} /><p>{t("No conversation yet — say something below")}</p></div>}
      {ended && <p className="chat-endcap">{t("terminal ended")}</p>}
  </>;
  const jump = newMessages ? <button type="button" className="btn chat-new-messages chat-virtual-jump" onClick={scrollToBottom}>{t("New messages")} <ArrowDown aria-hidden="true" /></button>
    : away && <button type="button" className="btn chat-new-messages chat-virtual-jump is-icon" aria-label={t("Jump to latest")} title={t("Jump to latest")} onClick={scrollToBottom}><ArrowDown aria-hidden="true" /></button>;
  return <ChatMarkdownImages paneId={paneId} cwd={cwd} connected={connected} onOpen={openMarkdownImage}><FileNameLookupContext.Provider value={fileNames}><ChatPaneContext.Provider value={paneId}><ChatHistoryContext.Provider value={historyId ?? ""}><ImageViewerContext.Provider value={openViewer}><ToolPathRootContext.Provider value={toolPathRoot(cwd)}>
    {/* a reader away from the end has not seen the answer a finish lands there: presented only at the end */}
    <div className="chat-frame" data-pane-content={active && visible && !covered && connected && !ended && loaded && error === null && !away && !newMessages
      && endPresentation?.state === state && endPresentation.key === presentationKey
      && (agentStatus !== "done" || conversationFinishPresented({ source: state.conversationSource, turns: state.turns }))
      && readPresentation === presentationKey && (state.source === "conversation" ? ChatTimeline !== null : agent === null) ? presentationKey : undefined}>
    <div className="chat-frame-body">
    {state.source === "conversation" ? ChatTimeline === null
      ? <div className="chat-view chat-view-virtual" role="log" aria-live="polite" aria-label={logLabel}>
        <div className="chat-transcript chat-transcript-virtual">
          <div className="chat-virtual-header">{header}</div>
          <div className="chat-virtual-footer">{footer}</div>
        </div>
      </div>
      : <ChatTimeline
      rows={timelineRows}
      scope={timelineScope}
      source={state.conversationSource}
      scroller={scroller}
      listRef={timeline}
      following={stickToBottom}
      manualLayout={manualLayout}
      selecting={selecting}
      memories={rowMemories}
      header={header}
      footer={footer}
      label={logLabel}
      onScroll={onScroll}
      onFollowed={followed}
      onOpen={readOpened}
      renderRow={renderTurn}
    /> : <div className="chat-view" ref={scroller} onScroll={() => onScroll()} role="log" aria-live="polite" aria-label={logLabel}>
      <div className="chat-transcript" data-conversation-source={state.conversationSource}>
        <ChatFallback paneId={paneId} agent={agent} visible={visible} messages={state.messages} scrollback={state.scrollback} outcomes={outcomes} restored={restored} actions={outcomeActions} skills={skillMatcher}
          unavailable={state.hint !== undefined ? undefined : state.unavailable} onOpenTerminal={openTerminal} />
        {footer}
      </div>
    </div>}
    {state.source === "conversation" && <ChatMinimap turns={minimap} rowKeys={rowKeys} scroller={scroller} onJump={jumpToTurn} onWheel={minimapWheel} />}
    {jump}
    {/* only a pane this device may send to takes quotes and comments: they go with its next message */}
    {state.source === "conversation" && interactive && !ended && <ReplyCommentAction scroller={scroller} storageKey={replyCommentsKey(paneStorageId(machineId, paneId))} paneKey={quotable ? paneStorageId(machineId, paneId) : null} />}
    </div>
    </div>
  {/* The prompt card is not part of the transcript: it is drawn on the composer's column, over the
      input card, where PaneTerminal keeps its place. The prompt itself (its poll, the answer, the
      re-read) stays here. */}
  {prompt !== null && promptDock !== null && createPortal(
    <PromptCard key={promptOccurrence.current.count} paneId={paneId} prompt={prompt} context={promptContext} watching={watching} answered={answeredPrompt === prompt.id} stale={promptStale} screenWords={screenWordsToShow(prompt, state.source === "conversation" ? state.turns : [])} typedAnswer={pendingAnswer?.promptId === prompt.id ? pendingAnswer.answer : null} onTypedAnswerDone={() => onPendingAnswerDone?.(paneId, prompt.id)} onPromptChanged={() => setPromptPollKey((key) => key + 1)} initialText={heldCardText?.promptId === prompt.id && heldCardText.session === agentSession ? heldCardText.text : undefined} onTextChange={(text, cardGone) => trackCardText(prompt.id, cardLifetime, text, cardGone)} onAnswered={(toMessageBox) => {
      onPromptAnswered?.(toMessageBox);
      setAnsweredPrompt(prompt.id);
      lastPrompts.delete(paneStorageId(machineId, paneId));
      if (prompt.steps) setPromptPollKey((key) => key + 1);
      setPollKey((key) => key + 1);
      setPromptPollKey((key) => key + 1);
      onPendingAnswerDone?.(paneId, prompt.id);
    }} />, promptDock)}
  {viewer !== null && <ImageLightbox images={viewer.images} index={viewer.index} onClose={closeViewer} />}
  {searching && <ConversationSearch paneId={paneId} agent={agent} historyId={historyId} title={title} onClose={closeSearch} onPick={revealTurn} />}
  </ToolPathRootContext.Provider></ImageViewerContext.Provider></ChatHistoryContext.Provider></ChatPaneContext.Provider></FileNameLookupContext.Provider></ChatMarkdownImages>;
});
