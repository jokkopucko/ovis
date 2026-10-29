import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown, BookOpen, Check, ChevronDown, ChevronRight, Circle, CircleAlert, CircleCheck, CircleDot, CircleQuestionMark, CircleSlash, CircleX, Copy, Layers, SquareTerminal, Target, Undo2,
  type LucideProps,
} from "lucide-react";

import "./ChatView.css";
// the timeline's styles stay in the entry: its chunk loads apart (chatTimelineLoader.ts), but
// .chat-frame and the loading state are drawn before it arrives
import "./ChatTimeline.css";

import { AgentMark } from "./AgentMark.tsx";
import { AnimatedHeight } from "./AnimatedHeight.tsx";
import { Markdown, ReservedImage } from "./Markdown.tsx";
import { ImageLightbox } from "./ImageLightbox.tsx";
import { PromptCard } from "./PromptCard.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { loadChatTimeline, loadedChatTimeline, useChatTimeline } from "./chatTimelineLoader.ts";
import { ChatMinimap } from "./ChatMinimap.tsx";
import { minimapTurns } from "../lib/chatMinimap.ts";
import type { LegendListRef } from "@legendapp/list/react";
import { appendChatRowSlots, continuesHistory, createChatRowSlots, prependChatRowSlots } from "../lib/chatRows.ts";
import { ChatDetails, ChatRowMemoryContext, useChatRowToggle, useRowFocus, type ChatRowMemory } from "../lib/chatRowState.tsx";
import { turnRevision } from "../lib/turnRevision.ts";
import { conversationFinishEvidence, conversationFinishPresented } from "../lib/panePresentation.ts";
import { seenKey } from "../lib/seenFinishes.ts";
import { useWholeOutput as useScopedOutput } from "../lib/useWholeOutput.ts";
import { turnSkills } from "../lib/skillActivity.ts";
import { ApiError, pinPaneConversation, unpinPaneConversation } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { attachmentFileName, mentionFileName, type GalleryImage } from "../lib/imageViewer.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { toTranscriptMessages, type TranscriptMessage } from "../lib/transcript.ts";
import { isLiveWorkTurn, isWaitingWorkTurn, formatWorkDuration, runNames, splitTurn, turnSegments, type WorkSegment, todoGroups, visibleWorkParts, workFailed, workStartsOpen, workSummary, type TodoAttempt, type TodoGroup, type ToolPart as ToolPartType } from "../lib/workBlocks.ts";
import { phaseRows, planRows, taskRows, todoRows, type ChecklistRow } from "../lib/checklist.ts";
import { isTodoTool, parseTodoAnswer, todoCallSummary, type TodoItem, type TodoStatus } from "../lib/todos.ts";
import { formatGoalTime, turnGoal, type GoalState, type GoalStatus } from "../lib/goals.ts";
import { useSettings } from "../lib/settings.ts";
import { PAGE_OVERLAP_ROWS, pageScrollDistance } from "../lib/pageScroll.ts";
import { followGlides } from "../lib/followScroll.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { statusEdgeRead } from "../lib/status.ts";
import { askedQuestions } from "../../shared/askQuestions.ts";
import { ConversationRefresh } from "../lib/conversationRefresh.ts";
import { teammateMessageParts, type TeammateMessage } from "../lib/teammateMessage.ts";
import { usePageVisible } from "../lib/visibility.ts";
import { lettaScreenWork } from "../lib/lettaScreen.ts";
import { dismissKeyboardOn } from "../lib/keyboard.ts";
import { useFacesArrived } from "../lib/fontFaces.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { toolPathLabel, toolPathRoot } from "../lib/workspacePath.ts";
import { linkFilePaths } from "./FilePathLink.tsx";
import { patchText } from "../../shared/patch.ts";
import { workRowLabel } from "../lib/workRowLabel.ts";
import { machinePath, paneStorageId } from "../../shared/machines.ts";
import { chatRestoreIndex, chatTurnAnchor, readChatPosition, rememberChatPosition, type ChatPosition } from "../lib/chatScrollMemory.ts";
import { fileUrl } from "../lib/api.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { useSkillMatcher } from "../lib/useSkillMatcher.ts";
import type { SkillMatcher } from "../lib/skillMentions.ts";
import { lineDiff } from "../lib/diff.ts";
import { formatTokens, sameMessage } from "../lib/compose.ts";
import { formatElapsed, taskCallItems, taskResultMarkdown } from "../lib/omoTasks.ts";
import { sendUserFileCall } from "../lib/sendUserFile.ts";
import { LINE_IMAGES_SHOWN, LINE_IMAGES_SHOWN_TOUCH, lineImages, linePictures, previewPlace, workImages, type WorkImage } from "../lib/workImages.ts";
import { shouldFoldUserMessage } from "../lib/userMessageFold.ts";
import { rewindOffer } from "../lib/rewindAction.ts";
import { invalidatePaneCommands } from "../lib/paneCommandCache.ts";
import { noteCatalogChanges, outcomeChip, outcomeCommand, outcomeLabel, outcomeNote, outcomeResultText, outcomeRows, type OutcomeState } from "../lib/outcomeChip.ts";
import { typedTerminalCommand } from "../lib/compose.ts";
import { usePaneCommands } from "../lib/usePaneCommands.ts";
import { commandScreenClosed, sentOutcome, type TerminalPeek } from "../lib/terminalPeek.ts";

// How long after scroll input an upward move still counts as the reader's own.
const SCROLL_INPUT_MS = 500;
// How far the reader's own upward move may leave the end and still follow: only endpoint rounding.
const READER_ALLOWANCE_PX = 1;
// How far an upward move without the reader's input may leave the end and still follow: a composer
// growing a few lines shrinks the view before the correction to the end lands. A scroll that sends
// no input this page sees (a screen reader's, a Firefox scrollbar's) leaves the end only past it, and
// only over a transcript that did not shrink under it (onScroll, #2042).
const LAYOUT_ALLOWANCE_PX = 48;
/** The pane this chat shows, for what its rows fetch on request (a tool call's whole output). */
const ChatPaneContext = createContext<string | null>(null);
const ChatHistoryContext = createContext("");
/**
 * Opens the image viewer for a message's pictures. The viewer is held by ChatView, not by the row:
 * a virtualized row unmounts once it scrolls out of the render window (the transcript follows new
 * output while the viewer is open), and it must not take the open viewer with it.
 */
const ImageViewerContext = createContext<(images: GalleryImage[], index: number) => void>(() => {});
/** The pane's folder a tool card's file labels read from (toolPathRoot), or null: labels as written. */
const ToolPathRootContext = createContext<string | null>(null);
import type { TypedAnswer } from "../lib/promptAnswer.ts";
import { polledPrompt, screenWordsToShow } from "../lib/promptText.ts";
import type { AgentStatus, CommandOutcome, ConversationMetadata, ConversationPart, ConversationResponse, ConversationTurn, InteractivePrompt, OmoTaskResult, SlashCommand } from "../../shared/protocol.ts";
import { chatIsBlank, type ChatRead } from "../lib/greeting.ts";
import { TurnTime } from "./TurnTime.tsx";
import { useT } from "../lib/i18n.ts";
import { offersRetry, userFailure, type UserFailure } from "../lib/userError.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { replyCommentsKey } from "../lib/replyComments.ts";
import { ReplyCommentAction } from "./ReplyComments.tsx";

/** Slow reads in a row the chat waits through quietly before it alarms: about 50 s at the local 15 s deadline. */
const SLOW_READS_BEFORE_ALARM = 3;

/**
 * A read that failed, as one line (DESIGN.md, Messages say only what the person needs now): the
 * action and the known cause, or the action alone with Try again; the advice and the server's words
 * behind Details. A PC that stays slow is its own line, with Try again whatever else is known.
 */
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

// No row is this object, so the list finds nothing to scroll to.
const NO_ROW = Object.freeze({});
/**
 * The list's scrollToEnd does not scroll at once: it waits for the list's next commit, and then
 * for the layout to settle after a data change (up to 800 ms). A follow asked for while the reader
 * was at the end can so land after the reader paged or scrolled away, and pull them back. Any newer
 * scroll request supersedes a waiting one; a request for no row supersedes it without moving.
 */
function dropPendingListScroll(list: LegendListRef | null): void {
  void list?.scrollToItem({ item: NO_ROW, animated: false });
}

const TRANSCRIPT_LINES = 400;
const PROMPT_POLL_MS = 2000;
// failed prompt reads in a row before the card says it may be out of date: one is a hiccup
const PROMPT_STALE_READS = 2;
/** Scrolling this close to the top asks for the page before it. */
const LOAD_OLDER_PX = 400;

export interface ChatViewProps {
  /** A fresh successful read for this displayed finish may acknowledge it. */
  presentationKey?: string;
  finishEpoch?: string;
  finishId?: number;
  paneId: string;
  /** Only the active pane owns the chat-local Mod+F shortcut. */
  active?: boolean;
  /** false while the pane sits off-tab (a cached or retained pane): no reads, no conversation-watch */
  visible?: boolean;
  pageScroll?: { current: ((direction: -1 | 1) => void) | null };
  refreshKey: number;
  /** bumped by a conversation push; coalesced to at most one read a second */
  invalidationKey?: number;
  /** only a mounted, visible chat asks the bridge to watch its native conversation */
  onConversationWatch?: (paneId: string, enabled: boolean) => void;
  /** the bridge pushes this pane's transcript changes; without, the chat reads every 2s as before */
  conversationPushes?: boolean;
  /** while the chat shows herdr's scrollback, the pane's terminal output invalidates it */
  onTerminalOutput?: (listener: (() => void) | null) => void;
  /** bumped when a composer message goes out, before the transcript holds it */
  sentKey?: number;
  /** bumped once this browser's own message from the box was accepted at once, with the navigation
   * generation it went out at: the chat follows it to the end unless the reader navigated since */
  localSend?: { key: number; navigationGeneration: number };
  /** the reader's navigation generation, shared with the sender: scrolling or paging back, a jump, a
   * restored place, a replaced history and leaving the pane raise it */
  navigation?: { current: number };
  connected: boolean;
  ended: boolean;
  agent: string | null;
  agentStatus?: AgentStatus;
  onMetadata?: (paneId: string, metadata: ConversationMetadata | null) => void;
  /** what the last read says of the conversation, for the composer's greeting; null while nothing is known (loading, a failed read, the chat gone) */
  onRead?: (paneId: string, read: ChatRead | null) => void;
  /** the composer shows its greeting: the chat's own "nothing yet" line stays out */
  greeted?: boolean;
  /** the agent's waiting prompt, for the composer to answer too */
  onPrompt?: (paneId: string, prompt: InteractivePrompt | null) => void;
  /** with no prompt waiting, the next prompt the agent suggests (Claude's grey input text) */
  onSuggestion?: (paneId: string, suggestion: string | null) => void;
  /** a cancelled send the agent put back in its input box: the composer fills it again, and it is no sent turn here either */
  onRestored?: (paneId: string, restored: string | null) => void;
  /** bumped after the composer answered: read the prompt again now */
  promptRefreshKey?: number;
  /** a typed pick of an approval's option, waiting in the card for Confirm */
  pendingAnswer?: { promptId: string; answer: TypedAnswer } | null;
  /** the pick is done with (sent, cancelled): named by its pane and prompt, so another's pick is left alone; with no prompt, whichever pick the pane has */
  onPendingAnswerDone?: (paneId: string, promptId?: string) => void;
  /** where the prompt card is drawn: on the composer's column, over the input card (PaneTerminal
   * owns the place). The chat still owns the prompt, so the card is rendered from here into it */
  promptDock?: HTMLElement | null;
  /** a prompt was answered from its card; `toMessageBox`: the keyboard's focus was in the card and may go on to the message box */
  onPromptAnswered?: (toMessageBox: boolean) => void;
  /** the pane's own name, as App's header shows it: the log is named by it, never by the pane id */
  title?: string | null;
  /** shows the pane's terminal for a command sent from here (a peek over this chat), where a command the chat cannot follow runs; none: the pane has no terminal to show */
  onOpenTerminal?: (text: string) => void;
  /** a peek shows the pane's terminal over this chat: the chat stays mounted and reading, but presents nothing and pages nothing */
  covered?: boolean;
  /** the peek that comes back to the chat by itself, watched here: the transcript and the outcomes say when its screen closed */
  peek?: TerminalPeek | null;
  /** the agent recorded that the peek's command screen closed (lib/terminalPeek.ts commandScreenClosed) */
  onCommandScreenClosed?: (peek: TerminalPeek) => void;
  /** the outcome ids each prompt read lists: a send notes them, to know its own outcome among later ones */
  onOutcomes?: (paneId: string, ids: readonly string[]) => void;
  /** this connection may type into the pane (it is no watching device or observer): only then can a message be rewound to */
  interactive?: boolean;
  /** a message's "Rewind in terminal" (Claude Code, grok, agy): the pane opens its terminal with a hint to run the agent's own rewind; nothing is sent */
  onRewindInTerminal?: () => void;
  /** the pane's folder: a tool card's file reads from it (`app/src/a.ts`), while its title and what it opens stay the path as written */
  cwd?: string | null;
}



/** a user turn's words, as its bubble shows them */
const userText = (turn: ConversationTurn): string => turn.parts.filter((part): part is Extract<ConversationPart, { kind: "text" }> => part.kind === "text").map((part) => part.text).join("\n\n");

interface ChatState {
  activity?: ConversationResponse["activity"];
  source: "conversation" | "scrollback";
  conversationSource?: ConversationResponse["source"];
  turns: ConversationTurn[];
  messages: TranscriptMessage[];
  truncated: boolean;
}

const EMPTY_STATE: ChatState = { source: "conversation", turns: [], messages: [], truncated: false };

/** One row of the timeline: a loaded turn in its browser slot, or a provisional sent row keyed by its outcome. */
type ChatRow = { key: string; beforeUser: boolean } & (
  | { turn: ConversationTurn; index: number; outcome: CommandOutcome | null }
  | { turn: null; outcome: CommandOutcome }
);

/** The view of a structured (not scrollback) answer. */
function conversationState(conversation: ConversationResponse): ChatState {
  return { source: "conversation", conversationSource: conversation.source, turns: conversation.turns, messages: [], truncated: false, activity: conversation.activity };
}


function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]+\)/gi, "$1")
    .replace(/(?:\*\*|__|~~|`)(.*?)(?:\*\*|__|~~|`)/g, "$1")
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/^>\s?/gm, "");
}

/** A quiet text button that copies and says "Copied" for a moment. */
function CopyButton({ text, label, className = "icon-button chat-copy", children, onResult }: { text: string; label: string; className?: string; children?: React.ReactNode; onResult: (ok: boolean) => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    const ok = await copyText(text);
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

/** A todo list by phase: one row per item, its state as an icon (and in words, for screen readers). */
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

/** A file a tool call names: it opens in the viewer where one can, and reads as text elsewhere. */
function ToolFile({ path, suffix }: { path: string; suffix?: string }) {
  const t = useT();
  const open = useContext(OpenFileContext);
  // shorter to read only: the title, the viewer and every copy keep the path as written (a copy
  // of the whole label takes data-raw-path: lib/markdownClipboard.ts)
  const shown = toolPathLabel(path, useContext(ToolPathRootContext));
  if (open === null) return <p className="chat-tool-file" title={path}><span data-raw-path={path}>{shown}</span>{suffix}</p>;
  return <p className="chat-tool-file"><button type="button" className="chat-tool-file-link" title={t("Open {path}", { path })} data-raw-path={path} onClick={() => open(path)}>{shown}</button>{suffix}</p>;
}

/** An edit's old and new text as one diff: the unchanged lines once, the changes in place. */
function EditDiff({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after);
  return <pre className="chat-diff">{lines.map((line, index) =>
    <span key={index} className={line.kind === "add" ? "chat-diff-add" : line.kind === "del" ? "chat-diff-del" : undefined}>{line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}{line.text}{"\n"}</span>)}</pre>;
}

/** A Codex patch as a diff: each file it touches a header that opens it, then its lines coloured. */
function PatchView({ patch }: { patch: string }) {
  const sections: Array<{ file: string | null; action: string; lines: string[] }> = [];
  for (const line of patch.split("\n")) {
    const file = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (file !== null) { sections.push({ file: file[2]!.trim(), action: file[1]!, lines: [] }); continue; }
    if (/^\*\*\* (Begin|End) Patch/.test(line)) continue;
    if (sections.length === 0) sections.push({ file: null, action: "", lines: [] });
    sections.at(-1)!.lines.push(line);
  }
  // the blank line a patch ends on is not part of any file
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
  if (part.arguments_omitted) return <pre className="chat-tool-io">{t("Arguments omitted (too large)")}</pre>;
  // a todo call shows the list as it stood after it, when the agent answered with it
  const after = isTodoTool(part.name) ? parseTodoAnswer(part.output) : null;
  if (after !== null && after.length > 0) return <TodoList items={after} />;
  const patch = patchText(part.input);
  if (patch !== null) return <PatchView patch={patch} />;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(part.input) as Record<string, unknown>; }
  catch { return <pre className="chat-tool-io">{part.input}</pre>; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return <pre className="chat-tool-io">{part.input}</pre>;
  // a question the agent asked: what it asked and offered, not its JSON (the answer is the output)
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
  // an OmO or omp `task` call: the tasks it starts, not its JSON or a checklist nobody ticks
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
  // several edits to one file: each its own diff, in order
  if (Array.isArray(parsed["edits"]) && parsed["edits"].every((item) => item !== null && typeof item === "object")) {
    const edits = parsed["edits"] as Array<Record<string, unknown>>;
    return <div className="chat-tool-io">{str("file_path") !== undefined && <ToolFile path={str("file_path")!} />}{edits.map((item, index) =>
      <EditDiff key={index} before={typeof item["old_string"] === "string" ? item["old_string"] : ""} after={typeof item["new_string"] === "string" ? item["new_string"] : ""} />)}</div>;
  }
  // SendUserFile: the files it names, openable where the viewer already opens any other path
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

/** A call's input as the agent sent it, indented when it is JSON. */
function RawToolInput({ part }: { part: ToolPartType }) {
  const t = useT();
  return <section className="chat-tool-output"><h4>{t("Input")}</h4>
    <pre className="chat-tool-io">{part.arguments_omitted ? t("Arguments omitted (too large)") : indentedJson(part.input)}</pre>
  </section>;
}

function indentedJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

/** A cut output's rest, fetched when asked for: the page carries the first few thousand characters. */
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

/** A chat thumbnail: a tap opens the message's pictures over the page (ImageLightbox), this one first. */
function ImageThumb({ image, onOpen }: { image: GalleryImage; onOpen: () => void }) {
  const t = useT();
  // the focus is placed on the thumbnail before the viewer opens, so the viewer's focus trap
  // records it as the opener and gives the focus back here on close (Safari does not focus a
  // clicked button on its own)
  return <button type="button" className="chat-user-image" title={t("Open image")} onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); onOpen(); }}>
    <ReservedImage src={image.src} alt={image.name} slot />
  </button>;
}

/** The thumbnails of a message's pictures; a press opens ChatView's viewer on them. */
function ImageGallery({ images, className }: { images: GalleryImage[]; className: string }) {
  const openViewer = useContext(ImageViewerContext);
  return <div className={className}>
    {images.map((image, index) => <ImageThumb key={image.src} image={image} onOpen={() => openViewer(images, index)} />)}
  </div>;
}

/** A tool's picture as the viewer shows it, fetched from the pane's conversation by its ref. */
function toolGalleryImage(machineId: string, paneId: string, image: WorkImage, t: ReturnType<typeof useT>): GalleryImage {
  return {
    src: machinePath(machineId, `pane/conversation/image?${new URLSearchParams({ pane_id: paneId, ref: image.ref }).toString()}`),
    // a tool's picture carries no file name: it is named by its place and the tool that read it
    name: t("Image {n} from {tool}", { n: image.ordinal + 1, tool: image.part.name }),
    file: attachmentFileName(image.mediaType, image.ordinal),
  };
}

/** Images a tool returned (pi reads a picture into the result), at full thumbnail size in the opened row. */
function ToolImages({ paneId, part }: { paneId: string; part: ToolPartType }) {
  const t = useT();
  const machineId = useMachineId();
  const images = workImages([part]);
  if (images.length === 0) return null;
  return <ImageGallery images={images.map((image) => toolGalleryImage(machineId, paneId, image, t))} className="chat-tool-images" />;
}

/**
 * The larger look a line thumbnail gives on hover or keyboard focus, over the page: the picture, the
 * tool that returned it and its place among the line's (lib/workImages.ts previewPlace). It never
 * takes a pointer, so moving onto it reads as leaving the thumbnail.
 */
function LinePreview({ image, tool, place, anchor }: { image: GalleryImage; tool: string; place: string; anchor: HTMLElement }) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  // placed before the first paint, its box being sized by CSS before the picture decodes, and again
  // whenever the page under it moves (the chat following a streaming answer scrolls it): it stays with
  // its thumbnail, and is hidden while that is out of view or gone
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

/** One small thumbnail on a work line. */
function LineThumb({ image, onOpen, onHover, onFocused, onFailed }: {
  image: GalleryImage; onOpen: (target: HTMLElement) => void; onHover: (anchor: HTMLElement | null) => void; onFocused: (target: HTMLElement) => void; onFailed: () => void;
}) {
  return <button type="button" className="work-image" aria-label={image.name}
    onClick={(event) => onOpen(event.currentTarget)}
    // a touch has no hover: a tap opens the viewer at once
    onPointerEnter={(event) => { if (event.pointerType !== "touch") onHover(event.currentTarget); }}
    onPointerLeave={() => onHover(null)}
    // reached by the keyboard, not by a click
    onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) onFocused(event.currentTarget); }}
    onBlur={() => onHover(null)}>
    <img src={image.src} alt="" loading="lazy" onError={onFailed} />
  </button>;
}

/**
 * The pictures a work line's tools returned, small at the line's end, as the Claude app's folded
 * "Read 2 files" line shows them: hovering one shows it larger, a click opens the viewer on all of
 * them at that one. The latest few show; the ones before them are one "+N" tile, so the line never wraps.
 */
function LineImages({ paneId, images }: { paneId: string; images: readonly WorkImage[] }) {
  const t = useT();
  const machineId = useMachineId();
  const openViewer = useContext(ImageViewerContext);
  const touch = useMediaQuery("(pointer: coarse)");
  // by address, not place: a picture that moves onto the "+N" tile or leaves the line takes its preview along
  const [preview, setPreview] = useState<{ src: string; anchor: HTMLElement } | null>(null);
  // a picture that failed to load leaves the line and the viewer, never a broken icon, while the line is drawn
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const entries = useMemo(() => images.map((image) => ({ image: toolGalleryImage(machineId, paneId, image, t), tool: image.part.name })), [images, machineId, paneId, t]);
  const usable = entries.filter((entry) => !failed.has(entry.image.src));
  if (usable.length === 0) return null;
  const gallery = usable.map((entry) => entry.image);
  const { hidden, shown } = lineImages(usable, touch ? LINE_IMAGES_SHOWN_TOUCH : LINE_IMAGES_SHOWN);
  // the focus is placed on the thumbnail first, so the viewer gives it back there on close (ImageThumb)
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

/**
 * One row of a work block: `▸ Ran bun test`, expanding to the call's input and output. A tool the
 * verb table knows reads as verb + object, and its id moves to the title and the opened detail;
 * any other keeps its id in front, as the agent names it.
 */
function WorkRow({ paneId, part, stateKey, state }: { paneId: string; part: ToolPartType; stateKey: string; state?: TodoAttempt["state"] }) {
  const t = useT();
  // the files an output names open from it ("saved /tmp/shot/t0.png")
  const openFile = useContext(OpenFileContext);
  const [chosen, setOpen] = useChatRowToggle(stateKey, false);
  const open = chosen === true;
  const focus = useRowFocus<HTMLButtonElement>(stateKey);
  // an update inside a todo run: the run already shows the list it left, so the update shows what it sent and got back
  const attempt = state !== undefined;
  const whole = useWholeOutput(part.output_ref);
  const summary = part.arguments_omitted ? t("Arguments omitted (too large)") : todoCallSummary(part) ?? part.summary;
  // reads the call's input: once per call, not on every poll of the transcript
  const { verb, narration } = useMemo(() => workRowLabel({ name: part.name, input: part.input }, summary), [part.name, part.input, summary]);
  // the list is the answer of a todo call: its raw text would say it twice
  const output = !attempt && isTodoTool(part.name) && parseTodoAnswer(part.output) !== null ? "" : whole.text ?? part.output;
  // an attempt inside a todo run says how it went, in the transcript's words; a failure already says "failed"
  const stateWord = state === undefined || part.error ? null
    : state === "ok" ? t("succeeded") : state === "pending" ? t("pending") : state === "error" ? t("failed") : t("outcome not recorded");
  const images = useMemo(() => linePictures([part]), [part]);
  return <div className={`work-row${part.error ? " is-error" : ""}`}>
    <div className="work-row-line">
      <button type="button" className="work-row-head" aria-expanded={open} title={narration || verb !== null ? `${part.name} · ${summary}` : undefined} onClick={() => setOpen(!open)} {...focus}>
        <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
        {!narration && (verb !== null ? <span className="work-row-name is-verb">{t(verb)}</span> : <span className="work-row-name">{part.name}</span>)}
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
    {open && <div className="work-row-detail">{verb !== null && <p className="work-row-tool">{part.name}</p>}{attempt ? <RawToolInput part={part} /> : <ToolInputView part={part} />}<ToolImages paneId={paneId} part={part} />{output.length > 0 && <section className="chat-tool-output"><h4>{t(part.error ? "Error" : "Output")}</h4><pre className={`chat-tool-io${whole.text !== null ? " is-whole" : ""}`}>{linkFilePaths(output, openFile)}</pre>
      {part.output_ref !== undefined && whole.text === null && <button type="button" className="btn btn-ghost chat-tool-more" disabled={whole.state === "loading"} onClick={whole.load}>
        {t(whole.state === "loading" ? "Loading the whole output…" : whole.state === "failed" ? "Couldn't load the whole output — retry" : "Show the whole output ({size} characters)", { size: formatTokens(part.output_size ?? 0) })}
      </button>}</section>}</div>}
  </div>;
}

/**
 * Todo updates the agent made one after another, as one row: the list they leave and how many there
 * were, opening to every attempt in order. The list is the latest one that completed; a later call
 * still waiting or one that failed is counted beside it, never taken for the list.
 */
function TodoGroupRow({ paneId, group, stateKeyOf }: { paneId: string; group: TodoGroup; stateKeyOf: (part: ToolPartType) => string }) {
  const t = useT();
  const memory = useContext(ChatRowMemoryContext);
  // an update the reader opened before the next one joined it opens the group: what they were
  // reading stays open, inside it, while the turn streams on (#1388). The group keeps that as its own
  // state, so closing the update inside later does not fold the group when the list remounts it.
  const groupKey = `todo-group:${group.id}`;
  const [chosen, setOpen] = useChatRowToggle(groupKey, group.attempts.some((attempt) => memory?.toggles.get(stateKeyOf(attempt.part)) === true));
  // the update the reader was on takes the focus back inside the run when it is open (WorkRow); folded, the run's head takes it
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
  // its failures are counted in words on its head; each failed attempt marks itself inside
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

function ThinkingRow({ text, stateKey }: { text: string; stateKey: string }) {
  const t = useT();
  const [chosen, setOpen] = useChatRowToggle(stateKey, false);
  const open = chosen === true;
  return <div className="work-row work-row-thinking">
    <button type="button" className="work-row-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
      <span className="work-row-name">{t("thinking")}</span>
    </button>
    {open && <div className="work-row-detail work-thinking-text">{text}</div>}
  </div>;
}

/**
 * Everything the agent did on the way — tool calls, reasoning and the narration
 * between them — under one header ("Worked for 7s · 1 edit"). Rows stay one line
 * each until opened; the narration between them is answer prose while the turn runs, dim after.
 */
/**
 * A live work block's head with no rows yet, where the block will be: a turn that has written
 * nothing the block draws (Claude Code's spinner, hidden thinking, or only words so far). The block
 * the first row draws takes its place without a change of look; nothing to open yet, so its caret
 * holds only the room.
 */
function PendingWorkHead({ title, className = "" }: { title: string; className?: string }) {
  return <div className={`work-block is-live is-pending ${className}`} role="status">
    <div className="work-block-head"><span className="work-row-caret" aria-hidden="true" /><span className="work-block-title">{title}</span></div>
  </div>;
}

/** What every work block of one turn reads, found once per turn rather than once per block. */
interface TurnWork {
  /** each part's index in the turn: rows are keyed and remembered by it, whichever block holds them */
  at: ReadonlyMap<ConversationPart, number>;
  /** runs of todo updates, found in the turn's own order before anything is hidden */
  groups: ReadonlyMap<ToolPartType, TodoGroup>;
  /** the updates a group row stands for, after its first */
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

function WorkBlockView({ paneId, parts, work, memoryKey, duration, live, waiting, defaultOpen, showThinking, pendingHead }: { paneId: string; parts: ConversationPart[]; work: TurnWork; memoryKey: string; duration: string | null; live: boolean; waiting: boolean; defaultOpen: boolean; showThinking: boolean; pendingHead: boolean }) {
  const t = useT();
  const [chosenOpen, setOpen] = useChatRowToggle(memoryKey, null);
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
  // a blocked agent is not working: the open block takes the sidebar's words for it
  const title = waiting ? t("Needs you") : live ? t("Working…") : duration !== null ? t("Worked for {duration}", { duration }) : t("Worked");
  return <section className={`work-block${live ? " is-live" : ""}${waiting ? " is-waiting" : ""}${open ? "" : " is-folded"}`}>
    <div className="work-block-line">
      <button type="button" className="work-block-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
        <span className="work-block-title">{title}</span>
        {summary.length > 0 && <span className="work-block-summary">· {summary}</span>}
        {/* its own span: the counts before it are cut on a narrow screen, a failure never is */}
        {failed > 0 && <span className="work-block-failed">· {t("{n} failed", { n: failed })}</span>}
      </button>
      {/* folded, the block's line carries its tools' pictures the browser keeps (linePictures); opened, each row carries its own */}
      {!open && <LineImages paneId={paneId} images={images} />}
    </div>
    {/* the rows open and fold at the block's measured height; folded and settled, they are not drawn */}
    <AnimatedHeight open={open} animateContent={false}>
      <div className="work-block-rows" onFocus={keepOpen} onClick={keepOpen}>{visible.map((part) =>
        part.kind === "thinking" ? <ThinkingRow key={`thinking:${at.get(part)}`} stateKey={`thinking:${at.get(part)}`} text={part.text} />
          : part.kind === "text" ? <div key={`text:${at.get(part)}`} className="work-narration"><Markdown>{part.text}</Markdown></div>
            : part.kind === "tool" ? groups.has(part) ? <TodoGroupRow key={groups.get(part)!.id} paneId={paneId} group={groups.get(part)!} stateKeyOf={toolKey} />
              : grouped.has(part) ? null : <WorkRow key={toolKey(part)} stateKey={toolKey(part)} paneId={paneId} part={part} /> : null)}
      </div>
    </AnimatedHeight>
  </section>;
}

/** Skill evidence stays visible even when the surrounding work block is folded. */
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

/** The goal as this turn left it: like a skill, visible while the work block is folded. */
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

/** Image files a message mentions as `@path`, the way this app attaches them: shown as thumbnails. */
const IMAGE_MENTION = /(?:^|\s)@(\S+\.(?:png|jpe?g|gif|webp))(?=\s|$)/gi;

function UserImages({ paneId, parts, text }: { paneId: string; parts: ConversationPart[]; text: string }) {
  const t = useT();
  const machineId = useMachineId();
  const pasted = parts.filter((part): part is Extract<ConversationPart, { kind: "image" }> => part.kind === "image");
  const mentioned = [...new Set([...text.matchAll(IMAGE_MENTION)].map((match) => match[1]!))];
  if (pasted.length === 0 && mentioned.length === 0) return null;
  // one gallery for the message: its pasted pictures first, then the files it mentioned
  const images: GalleryImage[] = [
    ...pasted.map((part, index): GalleryImage => ({
      src: machinePath(machineId, `pane/conversation/image?${new URLSearchParams({ pane_id: paneId, ref: part.ref }).toString()}`),
      name: t("Attached image"),
      file: attachmentFileName(part.media_type, index),
    })),
    ...mentioned.map((path): GalleryImage => ({ src: fileUrl(path, paneId, machineId), name: path, file: mentionFileName(path) })),
  ];
  return <ImageGallery images={images} className="chat-user-images" />;
}

/**
 * The user's words as a raised card. A long message (lib/userMessageFold.ts) is capped at the
 * lines `--chat-fold-lines` names; where the cap cuts it (measured on that message alone, never on
 * every row) the last line fades into the card and "Show full message" opens it. Opened, it stays
 * open while its row leaves and re-enters the list (useChatRowToggle).
 */
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
  // "Show less" sits at the bottom of a long message: after folding, bring the card's top back
  // into view rather than leave the reader far below it (as a code block's fold does)
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

/** Where a chip's action goes: the waiting card, or the pane's terminal for the command sent. Null: nothing to go to (no card up, no terminal). */
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

/**
 * What became of a command sent from here (lib/outcomeChip.ts), under its bubble: the state in
 * words with the card or the terminal to go to, and a changed screen folded under it as an
 * unconfirmed preview. The words are a live region: a chip that moves on is announced.
 */
function OutcomeChip({ outcome, actions }: { outcome: CommandOutcome; actions: OutcomeActions | null }) {
  const t = useT();
  const chip = outcomeChip(outcome);
  const Icon = OUTCOME_ICONS[chip.state];
  const terminal = actions?.terminal ?? null;
  const action = chip.action === "answer" ? actions?.answer ?? null : chip.action === "terminal" && terminal !== null ? () => terminal(outcome.text) : null;
  // a recognized result shows what the agent printed; the unconfirmed preview of the same screen goes
  const preview = outcome.result_text ? "" : outcome.preview ?? "";
  const [dismissed, setDismissed] = useChatRowToggle(`outcome-result:${outcome.id}`, false);
  const result = outcomeResultText(outcome, dismissed === true);
  const note = outcomeNote(t, outcome);
  return <div className="chat-outcome" data-outcome-state={chip.state}>
    <div className="chat-outcome-row">
      <span className="chat-outcome-state" role="status"><Icon aria-hidden="true" />{outcomeLabel(t, chip)}</span>
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

/**
 * A command sent from here that the transcript has no turn for: its bubble as a sent turn would
 * be, placed by send time, with its chip. A turn that records the command takes the chip over and
 * this row goes (lib/outcomeChip.ts), so a command never shows twice.
 */
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
  /** the turn's stable row in the timeline (ChatRow.key): what its folded todo runs are named by */
  rowKey: string;
  /** the last turn while the agent runs: its work block reads "Working…" */
  live: boolean;
  /** ...and "Needs you" while the agent is blocked */
  waiting: boolean;
  showThinking: boolean;
  /** the pane's skill names: an answer's text chips them */
  skills?: SkillMatcher | null;
  /** omo only: the user's own `$skill:x` and the `[skill: x]` omo leaves where one stood are chipped too */
  userSkills?: SkillMatcher | null;
  /** a user turn that records a command sent from here: what became of it is drawn under the bubble */
  outcome?: CommandOutcome | null;
  outcomeActions?: OutcomeActions | null;
  /** Claude Code, grok, agy: the message offers to open the terminal, where the agent's own rewind is run (lib/rewindAction.ts) */
  onRewindInTerminal?: (() => void) | null;
}

const TASK_RESULT_ICONS: Record<OmoTaskResult["status"], ComponentType<LucideProps>> = { completed: CircleCheck, failed: CircleX, cancelled: CircleSlash };

/** One OmO background task that ended: what it was and how it went, and what it found on request. */
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
  // the answer is drawn once the row is opened: a wake can carry many tasks, each with a long answer
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

/** what a runtime notice was: a background result by name, anything else by its own first line */
function noticeLabel(t: ReturnType<typeof useT>, notice: Extract<ConversationPart, { kind: "notice" }>): string {
  if (notice.source === undefined || notice.source === "async-result") return t("Background result delivered");
  if (notice.source.startsWith("peer:")) {
    const name = notice.source.slice(5);
    return name ? t("Message from another session: {name}", { name }) : t("Message from another session");
  }
  const first = notice.text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? notice.source;
  return first.length > 96 ? `${first.slice(0, 95)}…` : first;
}

// a turn that did not change keeps its object across polls: skip re-rendering it
export const Turn = memo(function Turn({ paneId, turn, rowKey, live, waiting, showThinking, skills = null, userSkills = null, outcome = null, outcomeActions = null, onRewindInTerminal = null }: TurnProps) {
  const t = useT();
  const memory = useContext(ChatRowMemoryContext);
  // what the drawn runs, and the runs that drew no block, were named, by part index; the row's
  // memory takes it once the turn is drawn
  const named = useRef<{ runs: Map<number, string>; dormant: Map<number, string> } | null>(null);
  named.current = null;
  useLayoutEffect(() => {
    if (memory === null || named.current === null) return;
    for (const key of ["runs", "dormant"] as const) {
      memory[key].clear();
      for (const [index, name] of named.current[key]) memory[key].set(index, name);
    }
  });
  // under the turn, not in its meta row: that row fades out once the pointer and focus leave
  const [copyFailed, setCopyFailed] = useChatRowToggle("copy-failed", false);
  const copyError = copyFailed && <p className="chat-copy-error" role="alert">{t("Couldn't copy. Select the text and copy it manually.")}</p>;
  const copied = (ok: boolean): void => setCopyFailed(!ok);
  const time = turn.ts === null ? null : <TurnTime ts={turn.ts} />;
  const compact = turn.parts.find((part): part is Extract<ConversationPart, { kind: "compact" }> => part.kind === "compact");
  if (compact !== undefined) {
    return <ChatDetails memoryKey="compact" className="chat-compact">
      <summary>{t("Conversation compacted")}{time !== null && <> · {time}</>}</summary>
      <div className="chat-compact-text"><Markdown>{compact.text}</Markdown></div>
    </ChatDetails>;
  }
  // OmO's background tasks reported back: a card of what ended, each result on request
  const ended = turn.parts.find((part): part is Extract<ConversationPart, { kind: "task_result" }> => part.kind === "task_result");
  if (ended !== undefined) {
    const heading = ended.tasks.length === 1 ? t("Background task ended") : t("{n} background tasks ended", { n: ended.tasks.length });
    return <section className="chat-task-results" aria-label={heading}>
      <p className="chat-task-results-head"><Layers aria-hidden="true" /><span>{heading}</span>{time !== null && <> · {time}</>}</p>
      {ended.tasks.map((task) => <TaskResultRow key={task.id} task={task} />)}
    </section>;
  }
  // the runtime spoke, not the user: a quiet divider like a compaction, the text on request
  const notice = turn.parts.find((part): part is Extract<ConversationPart, { kind: "notice" }> => part.kind === "notice");
  if (notice !== undefined) {
    return <ChatDetails memoryKey="notice" className="chat-compact chat-notice">
      <summary><span className="chat-notice-label">{noticeLabel(t, notice)}</span>{time !== null && <> · {time}</>}</summary>
      <pre className="chat-compact-text chat-notice-text">{notice.text}</pre>
    </ChatDetails>;
  }
  // a command the user ran in the agent's shell, without the model (bash mode): what went in, then what came out
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
        <div className="chat-turn-meta">{time}{text.length > 0 && <CopyButton text={text} label={t("Copy message")} onResult={copied} />}
          {text.length > 0 && onRewindInTerminal !== null && (
            <button type="button" className="icon-button chat-copy chat-rewind" aria-label={t("Rewind in terminal")} title={t("Rewind in terminal")} onClick={onRewindInTerminal}><Undo2 aria-hidden="true" /></button>
          )}
        </div>
      </div>
      {copyError}
      {outcome !== null && <OutcomeChip outcome={outcome} actions={outcomeActions} />}
      {/* the skill this message invoked (omp, omo, pi): the runtime recorded its instructions with it */}
      <SkillActivityList parts={turn.parts} />
    </article>;
  }
  const { answer } = splitTurn(turn.parts);
  const answerText = answer.map((part) => part.text).join("\n\n");
  const goal = turnGoal(turn.parts);
  // in the agent's own order, as the terminal shows it: words written before a tool stay above it
  const segments = turnSegments(turn.parts);
  const runs = segments.filter((segment): segment is WorkSegment => segment.kind === "work");
  // the turn's head is its last run that draws a row: it reads Working… while the turn runs and
  // carries the turn's duration once it settles, even below the answer when tools came after it.
  // The runs before it have the agent's words after them: they are done, read Worked and fold.
  const head = runs.filter((run) => visibleWorkParts(run.parts, showThinking).length > 0).at(-1) ?? runs.at(-1);
  const work = turnWork(turn.parts, rowKey);
  // a run keeps its block and fold while its parts change (runNames); the stand-in is named by the
  // part that will start the turn's first run, and is drawn only while the turn has none
  const drawn = (run: WorkSegment): boolean => visibleWorkParts(run.parts, showThinking).length > 0;
  const names = runNames(runs, work.at, memory?.runs ?? new Map(), drawn, memory?.dormant ?? new Map());
  // a run of hidden reasoning alone leaves its name apart: it has no fold, and a drawn block's name
  // comes first once the two merge (#2111)
  const partNames = (shown: boolean) => new Map(runs.flatMap((run, index) => drawn(run) === shown ? run.parts.map((part) => [work.at.get(part)!, names[index]!] as const) : []));
  named.current = { runs: partNames(true), dormant: partNames(false) };
  // `null`: the head standing in while the running turn has no work yet
  const block = (run: WorkSegment | null) => {
    const isHead = run === null || run === head;
    const key = run === null ? `work:${turn.parts.length}` : names[runs.indexOf(run)]!;
    return <WorkBlockView key={key} paneId={paneId} parts={run?.parts ?? []} work={work} memoryKey={key}
      duration={isHead ? formatWorkDuration(turn.ts, turn.end_ts ?? null) : null} live={live && isHead} waiting={waiting && isHead}
      // a settled turn folds its work, unless words the agent said last are in its final run
      defaultOpen={(live && isHead) || (run !== null && run === segments.at(-1) && workStartsOpen(false, turn.parts))}
      showThinking={showThinking} pendingHead={isHead && answer.length === 0} />;
  };
  return <article className="chat-turn chat-turn-agent">
    <SkillActivityList parts={turn.parts} />
    {goal !== null && <GoalActivity goal={goal} />}
    {/* the pending head stands only above no answer: one above words would leave a gap when the turn ends */}
    {head === undefined && live && answer.length === 0 && block(null)}
    {segments.map((segment) => segment.kind === "work" ? block(segment)
      : segment.parts.map((part) => <Markdown key={`answer:${work.at.get(part)}`} skills={skills}>{part.text}</Markdown>))}
    {answerText.length > 0 && <div className="chat-turn-meta chat-agent-meta">
      {/* a mouse reads one copy glyph and the words "Plain text"; touch reads the two formats */}
      <CopyButton className="chat-meta-btn" text={answerText} label={t("Copy as markdown")} onResult={copied}><span className="chat-meta-fmt">MD</span></CopyButton>
      <CopyButton className="chat-meta-btn chat-meta-plain" text={plainText(answerText)} label={t("Copy as plain text")} onResult={copied}><span className="chat-meta-fmt">TXT</span><span className="chat-meta-word">{t("Plain text")}</span></CopyButton>
      {time}
    </div>}
    {copyError}
  </article>;
});

function fallbackTurn(message: TranscriptMessage): ConversationTurn {
  return { role: message.role === "user" ? "user" : "assistant", ts: null, parts: [{ kind: "text", text: message.text }] };
}

/**
 * The transcript shown without a native conversation: herdr's scrollback as turns (a pane with no
 * agent), or the terminal output on request (an agent whose conversation could not be read). The
 * commands sent from here keep their outcomes as in the native timeline: a chip on the scrollback
 * turn that records one, a provisional sent row for one no turn records.
 */
export function ChatFallback({ paneId, agent, visible, messages, outcomes, restored, actions, skills }: {
  paneId: string; agent: string | null; visible: boolean; messages: readonly TranscriptMessage[]; outcomes: readonly CommandOutcome[];
  restored: string | null; actions: OutcomeActions | null; skills: SkillMatcher | null;
}) {
  const turns = useMemo(() => messages.filter((message) => message.role !== "status").map(fallbackTurn), [messages]);
  const rows = useMemo(() => outcomeRows(turns, outcomes, { restored }), [turns, outcomes, restored]);
  return <>
    {agent !== null && <TerminalFallback key={paneId} paneId={paneId} visible={visible} />}
    {rows.map((row) => row.kind === "sent"
      ? <OutcomeRow key={`outcome:${row.outcome.id}`} outcome={row.outcome} actions={actions} skills={skills} />
      : <Turn key={row.index} paneId={paneId} turn={turns[row.index]!} rowKey={`fallback:${row.index}`} live={false} waiting={false} showThinking={false} outcome={row.outcome} outcomeActions={actions} />)}
  </>;
}

/**
 * Stores that write a turn only when it ends: Letta Code appends the whole turn to its transcript
 * at `end_turn` (server/letta.ts), so while the agent works or waits on the user, only its terminal
 * shows the turn.
 */
const TURN_END_SOURCES: ReadonlySet<ConversationResponse["source"]> = new Set(["letta-transcript"]);
/** The pane's newest lines stand for the running turn: about a screen of the agent's own TUI. */
const LIVE_TURN_LINES = 60;
/** The running turn's terminal is read every second, as fast as pushed transcript reads go. */
const LIVE_TURN_POLL_MS = 1000;

/** Whether the turn the agent is on is not in its transcript yet, so the terminal shows it under the chat. */
export function turnOnlyInTerminal(source: ConversationResponse["source"] | undefined, status: AgentStatus | undefined): boolean {
  return source !== undefined && TURN_END_SOURCES.has(source) && (status === "working" || status === "blocked");
}

/**
 * The live box of one running turn: `after` counts the pane's newest-page reads started before the
 * turn ran; `key` is the transcript (its newest turn as a key) the first read started after it
 * returned. That read cannot hold the running turn: such a store appends a turn only when it ends.
 * `ended`: the reads started when the pane's status said the turn was over.
 */
export type LiveTurnArm = { pane: string; after: number; key: string | null; ended: number | null };
/** The pane's last newest-page read to end: laid out (or confirmed unchanged by a 304), or failed. */
export type SettledRead = { pane: string; read: number; ok: boolean };

/**
 * The arm for this render. `watching`: the chat is up and online on such a transcript; a chat
 * hidden or offline can miss a turn's end and the next one's start, so it arms afresh when back. A
 * transcript shown before the turn ran (a cached answer, a page that was hidden) is no baseline:
 * turns written meanwhile would read as this one's end. Letta writes the turn before herdr's status
 * says it ended, but the chat reads it after: past that edge the box stays until a read started
 * after it ends, and it goes in the render that lays the turn out, or when that read fails (each is
 * bounded by the chat's read deadline). A turn cancelled is never written: that read ends it too.
 */
export function nextLiveTurnArm(arm: LiveTurnArm | null, pane: string, watching: boolean, running: boolean, readsStarted: number, settled: SettledRead | null, written: string): LiveTurnArm | null {
  if (!watching) return null;
  const held = arm !== null && arm.pane === pane ? arm : null;
  const read = settled !== null && settled.pane === pane ? settled : null;
  if (running) {
    if (held === null || held.ended !== null) return { pane, after: readsStarted, key: null, ended: null };
    if (held.key === null && read !== null && read.ok && read.read > held.after) return { ...held, key: written };
    return held;
  }
  if (held === null) return null;
  if (held.ended === null) return { ...held, ended: readsStarted };
  return read !== null && read.read > held.ended ? null : held;
}

/** The box shows until the transcript moves past its baseline: then it holds the turn, and the box goes in that render. */
export function liveTurnShown(arm: LiveTurnArm | null, written: string): boolean {
  return arm !== null && (arm.key === null || arm.key === written);
}

/**
 * Optional terminal output must never hold initial display or transcript polling. `live`: the turn
 * a TURN_END_SOURCES agent is on, open from the start under the turns its transcript holds.
 */
export function TerminalFallback({ paneId, visible, live = false }: { paneId: string; visible: boolean; live?: boolean }) {
  const { fetchPaneTranscript } = useMachineApi();
  const t = useT();
  const [open, setOpen] = useState(live);
  const tail = useRef<HTMLPreElement>(null);
  /** the reader has not scrolled up inside the box: it follows the terminal's newest line */
  const following = useRef(true);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<UserFailure | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  useEffect(() => {
    if (!open || !visible) return;
    let cancelled = false;
    let timer: number | undefined;
    const read = async (): Promise<void> => {
      try {
        const result = await fetchPaneTranscript(paneId, live ? LIVE_TURN_LINES : TRANSCRIPT_LINES);
        if (cancelled) return;
        // a live box is Letta's (TURN_END_SOURCES): its input box and status line are not the work
        setText(toTranscriptMessages(live ? lettaScreenWork(result.text) : result.text).filter((message) => message.role !== "status").map((message) => message.text).join("\n\n"));
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(userFailure(cause));
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void read(), live ? LIVE_TURN_POLL_MS : PROMPT_POLL_MS);
      }
    };
    void read();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [paneId, open, visible, live, fetchPaneTranscript, retryKey]);
  // a live turn's box is a few rows high and follows the terminal's newest line
  useLayoutEffect(() => { if (live && following.current && tail.current) tail.current.scrollTop = tail.current.scrollHeight; }, [live, text]);
  return <details className={`chat-terminal-fallback${live ? " is-live" : ""}`} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{live ? t("Live terminal") : t("Conversation unavailable — show terminal output")}</summary>
    {live
      // its full height from the start, so the chat never moves as text arrives; terminal noise is not announced
      ? <pre ref={tail} tabIndex={0} aria-live="off" aria-label={t("Live terminal")}
        onScroll={(event) => { const box = event.currentTarget; following.current = box.scrollTop + box.clientHeight >= box.scrollHeight - 4; }}>{text ?? ""}</pre>
      : text !== null && <pre>{text}</pre>}
    {!live && text === null && error === null && <p className="chat-inline-state" role="status">{t("Loading…")}</p>}
    {error !== null && <FailureLine action={t("Couldn't load the terminal output")} failure={error} onRetry={() => setRetryKey((key) => key + 1)} />}
  </details>;
}

// the app re-renders on every pane-status and poll; an unchanged transcript sits those out
export const ChatView = memo(function ChatView({ paneId, presentationKey, finishEpoch, finishId, active = true, visible: paneVisible = true, pageScroll, refreshKey, invalidationKey = 0, onConversationWatch, conversationPushes = false, onTerminalOutput, sentKey = 0, localSend, navigation, connected, ended, agent, agentStatus, onMetadata, onRead, greeted = false, onPrompt, onSuggestion, onRestored, promptRefreshKey = 0, pendingAnswer = null, onPendingAnswerDone, promptDock = null, onPromptAnswered, title = null, onOpenTerminal, covered = false, peek = null, onCommandScreenClosed, onOutcomes, interactive = false, onRewindInTerminal, cwd = null }: ChatViewProps) {
  const t = useT();
  const { fetchPaneConversation, peekPaneConversation, fetchPanePromptState, fetchPaneTranscript } = useMachineApi();
  const { settings } = useSettings();
  // older turns load a page at a time; the setting decides how many prompts a page holds
  const pagePrompts = settings.historyPrompts;
  const machineId = useMachineId();
  // the pane the chat has open keeps its page: its answer is the last one evicted
  useEffect(() => {
    pinPaneConversation(paneId, machineId);
    return () => unpinPaneConversation(paneId, machineId);
  }, [paneId, machineId]);
  const skillMatcher = useSkillMatcher(paneId, agent);
  const commands = usePaneCommands(paneId, agent);
  // polls pause while the page or the pane is hidden and pick up at once when it is back
  const pageVisible = usePageVisible();
  const visible = paneVisible && pageVisible;
  /** the answer last laid out: an unchanged poll (a 304) hands back this very object */
  const lastAnswer = useRef<ConversationResponse | null>(null);
  const [conversationRefresh] = useState(() => new ConversationRefresh());
  const onMetadataRef = useRef(onMetadata);
  onMetadataRef.current = onMetadata;
  const [state, setState] = useState<ChatState>(EMPTY_STATE);
  /** the answer shown states settings read off the agent's own screen (ConversationResponse.screen) */
  const [screenRead, setScreenRead] = useState(false);
  // Native Grok/Agy events can arrive while Herdr still reports ready/done. This is display
  // feedback only: sending, queuing and stopping retain the server's input authority.
  const activity = state.activity ?? (agentStatus === "working" ? "working" : "idle");
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const smoothFollow = followGlides({ working: activity !== "idle" && agentStatus !== "blocked", reducedMotion });
  const workStatus = state.activity !== undefined && agentStatus !== "blocked" ? activity === "idle" ? "idle" : "working" : agentStatus;
  const newestTurn = state.turns.at(-1);
  const writtenKey = `${state.turns.length}\0${newestTurn?.ts ?? ""}\0${newestTurn?.end_ts ?? ""}`;
  const turnEndView = state.source === "conversation" && state.conversationSource !== undefined && TURN_END_SOURCES.has(state.conversationSource);
  /** newest-page reads started, and the last one to end: the live box's baseline and its end */
  const newestReads = useRef(0);
  const [settledRead, setSettledRead] = useState<SettledRead | null>(null);
  const [liveArm, setLiveArm] = useState<LiveTurnArm | null>(null);
  const nextLiveArm = nextLiveTurnArm(liveArm, paneId, turnEndView && connected && visible, turnOnlyInTerminal(state.conversationSource, agentStatus), newestReads.current, settledRead, writtenKey);
  if (nextLiveArm !== liveArm) setLiveArm(nextLiveArm);
  const liveTurnOpen = liveTurnShown(nextLiveArm, writtenKey);
  const [error, setError] = useState<UserFailure | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  /** reads failed in a row: a slow PC is waited for this many times before the chat alarms */
  const [failures, setFailures] = useState(0);
  const [newMessages, setNewMessages] = useState(false);
  /** scrolled up from the end: the way back is offered even when nothing new came */
  const [away, setAway] = useState(false);
  const [viewer, setViewer] = useState<{ images: GalleryImage[]; index: number } | null>(null);
  const openViewer = useCallback((images: GalleryImage[], index: number) => setViewer({ images, index }), []);
  const closeViewer = useCallback(() => setViewer(null), []);
  /** an answer for this pane arrived (or failed): until then, and while a replaced history is read again, an empty chat is only loading */
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
  // Each prompt that appears is an occurrence of its own, and gets a card of its own. The prompt's
  // id is a hash of what it says, so the same question asked twice shares it. Navigation metadata
  // can change within an occurrence; only another id or a disappearance starts a new card.
  const promptOccurrence = useRef<{ of: InteractivePrompt | null; count: number }>({ of: null, count: 0 });
  if (prompt === null) promptOccurrence.current.of = null;
  else if (promptOccurrence.current.of?.id !== prompt.id) promptOccurrence.current = { of: prompt, count: promptOccurrence.current.count + 1 };
  // turns the transcript holds on a path /tree walked away from: no page can reach them, so the
  // only way to say they exist is to be told, and to say it where the reader would look for them
  const [abandoned, setAbandoned] = useState<{ count: number; branches: number; summary: string | null } | null>(null);
  // the suggestion is handed up from each read, with the pane that read it: never kept here,
  // where a pane switch or a send upstream could leave it stale
  const onSuggestionRef = useRef(onSuggestion);
  onSuggestionRef.current = onSuggestion;
  // restored is handed up the same way, and also kept here: while it holds, the send it names
  // is filtered out of the rendered turns (the terminal shows no sent turn for it either)
  const onRestoredRef = useRef(onRestored);
  onRestoredRef.current = onRestored;
  const [restored, setRestored] = useState<string | null>(null);
  // the pane's tracked command sends, read with the prompt (lib/outcomeChip.ts draws them)
  const [outcomes, setOutcomes] = useState<CommandOutcome[]>([]);
  const onOutcomesRef = useRef(onOutcomes);
  onOutcomesRef.current = onOutcomes;
  /** the outcomes whose catalog change this chat has already answered with a fresh command read */
  const catalogNoted = useRef(new Set<string>());
  // a read begun before the latest send answers for the turn before it: its suggestion is dropped
  const sentKeyRef = useRef(sentKey);
  sentKeyRef.current = sentKey;
  const [promptPollKey, setPromptPollKey] = useState(0);
  const ownNavigation = useRef(0);
  const navigationRef = navigation ?? ownNavigation;
  /** the reader chose a place: a local send already on its way no longer takes them to the end */
  const navigated = (): void => { navigationRef.current += 1; };
  // a local send accepted before this chat mounted (another pane, another lens) is not followed here
  const seenLocalSend = useRef(localSend?.key ?? 0);
  const scroller = useRef<HTMLDivElement>(null);
  const timeline = useRef<LegendListRef>(null);
  const ChatTimeline = useChatTimeline();
  const stickToBottom = useRef(true);
  // the timeline's hold on a following reader's own click layout (ChatTimeline manualLayout)
  const manualLayout = useRef(false);
  // Explicit paging stays away even inside the ordinary near-bottom tolerance.
  const pagingAway = useRef(false);
  // The paging away is the reader opening something (readOpened): it holds in a chat still too short to scroll.
  const openedAway = useRef(false);
  const lastScrollTop = useRef(0);
  // The last row and where it started in the transcript, and the transcript's height, at the
  // previous scroll event (#2042).
  const lastRowOffset = useRef<{ key: string; offset: number } | null>(null);
  const lastScrollHeight = useRef(0);
  // When the reader last used upward scroll input.
  const scrollInputAt = useRef(-Infinity);
  const pointerDragAt = useRef(-Infinity);
  // A primary press on the transcript's scrollbar, while held: where it went down, and whether the
  // transcript moved up since. No pointermove comes while its thumb is dragged.
  const scrollbarPress = useRef<{ y: number; movedUp: boolean } | null>(null);
  const onScrollRef = useRef<() => void>(() => undefined);
  const signature = useRef("");
  // Older pages sit above the newest one. Once any shows, the newest page is
  // polled from its start at that moment, so the two always meet.
  const [older, setOlder] = useState<ConversationTurn[]>([]);
  const olderCount = useRef(0);
  const incarnation = useRef(0);
  const slots = useRef(createChatRowSlots({ machineId, paneId, historyId: null, incarnation: 0 }, 0));
  /** the history the row slots stand for: its own, or the one a rewrite continued (continuesHistory) */
  const slotsHistory = useRef<string | null>(null);
  /** the page before everything shown; null at the conversation's beginning, undefined when unknown */
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [olderState, setOlderState] = useState<"idle" | "loading" | "failed">("idle");
  const heldFrom = useRef<string | null>(null);
  const loadingOlder = useRef(false);
  /** bumped whenever the older pages are dropped: a load still in flight for them is ignored */
  const olderGeneration = useRef(0);
  const history = useRef<string | undefined>(undefined);
  const [historyId, setHistoryId] = useState<string | undefined>(undefined);
  const shownPane = useRef(paneId);
  const prependAnchor = useRef<{ key: string; offset: number } | null>(null);
  /** where the reader left this pane before (lib/chatScrollMemory.ts), until the first answer puts it back */
  const restoring = useRef<ChatPosition | null>(null);
  const stopRestore = useRef<(() => void) | null>(null);
  const [pollKey, setPollKey] = useState(0);
  /**
   * The assistant turn that was last when a message went out, with the turns it was read from.
   * It holds only while those turns are unchanged: once the transcript moves at all, the status
   * applies again (a slash command Claude logs as no user turn continues the very same turn).
   */
  const [sentOver, setSentOver] = useState<{ turn: ConversationTurn; page: ConversationTurn[] } | null>(null);
  /** the newest page as rendered: an earlier page loaded above it does not move the transcript */
  const heldPage = useRef<ConversationTurn[]>([]);
  const seenSent = useRef(sentKey);
  const seenStatus = useRef<{ pane: string; status: AgentStatus | undefined }>({ pane: paneId, status: agentStatus });
  const seenConnected = useRef(connected);
  /** the socket has been connected since this pane showed: only then is a connected edge a reconnect */
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

  /** What an answer says beside its turns: where older pages start, its metadata, abandoned turns. */
  const showAnswerDetails = (conversation: ConversationResponse): void => {
    if (heldFrom.current === null) setOlderCursor(conversation.source === "scrollback" ? undefined : conversation.cursor);
    // a scrollback stand-in carries metadata only as the agent's own status line states it
    onMetadataRef.current?.(paneId, conversation.metadata ?? null);
    setScreenRead(conversation.screen === true);
    setAbandoned(conversation.abandoned ?? null);
  };

  /** Lays out the state built from an answer and marks that answer as the one shown. */
  const showAnswer = (conversation: ConversationResponse, next: ChatState): void => {
    if (next.source === "conversation") {
      const count = olderCount.current + next.turns.length;
      if (slotsHistory.current !== (history.current ?? null) || lastAnswer.current?.source === "scrollback") {
        slots.current = createChatRowSlots({ machineId, paneId, historyId: history.current ?? null, incarnation: ++incarnation.current }, count);
        slotsHistory.current = history.current ?? null;
      } else if (count > slots.current.rows.length) {
        slots.current = appendChatRowSlots(slots.current, count - slots.current.rows.length);
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
    // only an answer laid out in full is skipped when it comes back unchanged: a read
    // cancelled mid-way (a pane switch, the page hidden during a gap fill) is redone
    lastAnswer.current = conversation;
  };

  useLayoutEffect(() => {
    shownPane.current = paneId;
    stopRestore.current?.();
    restoring.current = readChatPosition(paneStorageId(machineId, paneId)) ?? null;
    history.current = undefined; setHistoryId(undefined);
    pagingAway.current = false; stickToBottom.current = true; lastRowOffset.current = null; lastScrollHeight.current = 0; signature.current = ""; setState(EMPTY_STATE); setNewMessages(false); setAway(false); setLoaded(false); setError(null); setErrorStatus(null); setFailures(0); setPrompt(null); setAbandoned(null); setRestored(null); setOutcomes([]); setScreenRead(false);
    dropOlder();
    lastAnswer.current = null;
    setSentOver(null);
    wasConnected.current = connected;
    // Stale while revalidating: the last answer read for this pane draws before paint, and the
    // mount read still asks the server; an unchanged answer (a 304) is this object and is skipped.
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
    // sent into a run (a queued message sent now): that turn is the one running, not one to finish
    const page = heldPage.current;
    const last = page[page.length - 1];
    setSentOver(last?.role === "assistant" && agentStatus !== "working" && agentStatus !== "blocked" ? { turn: last, page } : null);
  }, [sentKey, agentStatus]);

  // Status edges still read immediately, including on a bridge without conversation pushes.
  // They share the same serialized reader as pushes, sends and the periodic backstop.
  useEffect(() => {
    const seen = seenStatus.current;
    seenStatus.current = { pane: paneId, status: agentStatus };
    if (seen.pane === paneId && statusEdgeRead(seen.status, agentStatus)) setPollKey((key) => key + 1);
  }, [paneId, agentStatus]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    /** The turns between the held start and where the newest page now starts, a page at a time; null when they cannot be joined. */
    const turnsBetween = async (held: string | null, start: string): Promise<ConversationTurn[] | null> => {
      const pages: ConversationTurn[][] = [];
      let before = start;
      try {
        for (let step = 0; step < 32 && before !== held; step++) {
          if (cancelled) return null;
          const page = await fetchPaneConversation(paneId, { before, ...(held === null ? {} : { since: held }), prompts: pagePrompts });
          if (page.cursor === held) {
            pages.unshift(page.turns);
            return pages.flat();
          }
          if (typeof page.cursor !== "string") return null;
          pages.unshift(page.turns);
          before = page.cursor;
        }
      } catch (cause) {
        // Failed gap reads keep the same timeline, just as a failed newest-page
        // read does. Only a rejected cursor means these pages cannot be joined.
        if (!(cause instanceof ApiError) || cause.status !== 409) throw cause;
        return null;
      }
      return before === held ? pages.flat() : null;
    };
    const read = async (): Promise<void> => {
      const started = ++newestReads.current;
      const readKey = presentationRef.current;
      const finish = finishRef.current;
      const previousAnswer = lastAnswer.current ?? undefined;
      const page = { ...(heldFrom.current === null ? {} : { from: heldFrom.current }), history_id: previousAnswer?.history_id, prompts: pagePrompts, fresh: readKey !== validatedPresentation.current };
       let generation = olderGeneration.current;
      try {
        let conversation;
        try {
          conversation = await fetchPaneConversation(paneId, page);
        } catch (cause) {
          // a new session or a Codex backtrack replaced the transcript the older pages came from
          if (!(cause instanceof ApiError) || cause.status !== 409) throw cause;
          if (cancelled || generation !== olderGeneration.current) return;
          dropOlder(); setState(EMPTY_STATE); setLoaded(false); signature.current = ""; lastAnswer.current = null;
          generation = olderGeneration.current;
          conversation = await fetchPaneConversation(paneId, { prompts: pagePrompts });
        }
        if (cancelled || generation !== olderGeneration.current) return;
        if (conversation !== previousAnswer) validatedPresentation.current = readKey;
        const proved = finish.status !== "done" || (readKey === presentationRef.current && finishRef.current.status === "done"
          && finish.epoch !== undefined && finish.id !== undefined
          && conversationFinishEvidence.accept(seenKey(machineId, finish.epoch, paneId), finish.id, conversation, previousAnswer));
        // the timeline's chunk is in hand before any turn is: the list mounts once, with the refs bound
        if (conversation.source !== "scrollback" && loadedChatTimeline() === null) {
          await loadChatTimeline();
          if (cancelled || generation !== olderGeneration.current) return;
        }
        if (history.current !== conversation.history_id) {
          // the same turns under a new ID (gjc rewrote its file): the rows, what the reader opened and
          // where they read stay, so it is no navigation. Older pages were read from the old file: with
          // any held, it starts over, and a replaced history is navigation.
          const continued = olderCount.current === 0 && history.current !== undefined && conversation.history_id !== undefined
            && continuesHistory(lastAnswer.current, conversation);
          if (continued) {
            slotsHistory.current = conversation.history_id ?? null;
            // an older page still being read names the old file: it is dropped, not taken for a replacement
            olderGeneration.current += 1; loadingOlder.current = false; setOlderState("idle");
            // the place kept for this pane is in the new history too
            const storageId = paneStorageId(machineId, paneId);
            const kept = readChatPosition(storageId);
            if (kept !== undefined && kept.historyId === (history.current ?? null)) rememberChatPosition(storageId, { ...kept, historyId: conversation.history_id ?? null });
          }
          else { if (history.current !== undefined) navigated(); dropOlder(); }
          generation = olderGeneration.current;
          history.current = conversation.history_id; setHistoryId(conversation.history_id);
          if (!continued) { pagingAway.current = false; stickToBottom.current = true; lastRowOffset.current = null; lastScrollHeight.current = 0; setNewMessages(false); setAway(false); }
        }
        // a 304 hands back the answer already shown: nothing to compare or lay out again
        if (conversation === lastAnswer.current) { setError(null); setErrorStatus(null); setFailures(0); setReadPresentation(proved ? readKey : undefined); setSettledRead({ pane: paneId, read: started, ok: true }); return; }
        // The newest page moved past the held start: the turns in between join the older
        // pages and the newest page is held from its new start, so no poll reads more than a page.
        const previous = lastAnswer.current;
        const held = heldFrom.current ?? (previous?.source !== "scrollback" && previous?.history_id === conversation.history_id ? previous?.cursor : undefined);
        let moved: ConversationTurn[] = [];
        if (held !== undefined && conversation.source !== "scrollback" && typeof conversation.cursor === "string" && conversation.cursor !== held) {
          const between = await turnsBetween(held, conversation.cursor);
          if (cancelled || generation !== olderGeneration.current) return;
          if (between === null) {
            dropOlder(); setState(EMPTY_STATE); setLoaded(false); signature.current = ""; lastAnswer.current = null;
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
        else if (agent !== null) next = { source: "scrollback", turns: [], messages: [], truncated: false };
        else {
          // The reader has rejected this history. Hide it before the separate terminal
          // request, which may wait or fail; a transport error must not revive those turns.
          if (lastAnswer.current?.source !== "scrollback") {
            setState((previous) => previous.source === "conversation"
              ? { source: "scrollback", turns: [], messages: [], truncated: false } : previous);
            signature.current = ""; lastAnswer.current = null;
          }
          const result = await fetchPaneTranscript(paneId, TRANSCRIPT_LINES);
          if (cancelled || generation !== olderGeneration.current) return;
          next = { source: "scrollback", turns: [], messages: toTranscriptMessages(result.text).filter((message) => message.role !== "status"), truncated: result.truncated === true };
        }
        showAnswer(conversation, next);
        setReadPresentation(proved ? readKey : undefined);
        setSettledRead({ pane: paneId, read: started, ok: true });
      } catch (cause) {
        if (cancelled || generation !== olderGeneration.current) return;
        setSettledRead({ pane: paneId, read: started, ok: false });
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
      onConversationWatch?.(paneId, false);
      conversationRefresh.stop();
    };
  }, [paneId, pagePrompts, fetchPaneConversation, fetchPaneTranscript, conversationRefresh, visible, onConversationWatch, agent]);

  // Sends, status/history repairs and visibility return read immediately without cancelling
  // the answer in flight. The reader is installed before this effect requests its first read.
  useEffect(() => {
    if (visible) conversationRefresh.refresh();
  }, [paneId, pagePrompts, presentationKey, refreshKey, pollKey, visible, fetchPaneConversation, fetchPaneTranscript, conversationRefresh, onConversationWatch, agent]);

  // Mount/visibility return already read immediately; only a changed push key invalidates.
  useEffect(() => {
    const seen = seenInvalidation.current;
    seenInvalidation.current = { pane: paneId, key: invalidationKey };
    if (seen.pane === paneId && seen.key !== invalidationKey && visible) conversationRefresh.invalidate();
  }, [paneId, invalidationKey, visible, conversationRefresh]);

  useEffect(() => {
    conversationRefresh.setPushes(conversationPushes && (agent !== "copilot" || state.source !== "scrollback"));
  }, [conversationPushes, state.source, conversationRefresh, agent]);

  // A scrollback stand-in has no native file for the server to watch, and neither have settings
  // read off the agent's screen (a conversation not begun). Their source is the pane's own
  // screen, so terminal output is the invalidation, under the same 1s bound: a model switched in
  // the terminal shows once the agent draws it.
  useEffect(() => {
    if ((state.source !== "scrollback" && !screenRead) || !visible || onTerminalOutput === undefined) return;
    onTerminalOutput(() => conversationRefresh.invalidate());
    return () => onTerminalOutput(null);
  }, [state.source, screenRead, visible, onTerminalOutput, conversationRefresh]);

  // Catch writes made offline as soon as the existing socket is connected again. The first
  // connection after the pane shows (a fresh attach) is no reconnect: while the mount read is
  // still in flight, that read already answers for it, and a second full read would only repeat it.
  useEffect(() => {
    const before = seenConnected.current;
    seenConnected.current = connected;
    const reconnect = wasConnected.current;
    if (connected) wasConnected.current = true;
    if (!connected || before || !visible) return;
    if (!reconnect && conversationRefresh.reading) return;
    conversationRefresh.refresh();
  }, [connected, visible, conversationRefresh]);

  const loadOlder = useCallback(async (): Promise<void> => {
    const node = scroller.current;
    if (node === null || loadingOlder.current || typeof olderCursor !== "string") return;
    const before = olderCursor;
    const generation = olderGeneration.current;
    loadingOlder.current = true;
    setOlderState("loading");
    await conversationRefresh.page(async () => {
      try {
        if (shownPane.current !== paneId || olderGeneration.current !== generation) return;
        const page = await fetchPaneConversation(paneId, { before, prompts: pagePrompts });
        if (shownPane.current !== paneId || olderGeneration.current !== generation) return;
        if (page.history_id !== history.current) {
          dropOlder(); setState(EMPTY_STATE); setLoaded(false); signature.current = ""; lastAnswer.current = null;
          setPollKey((key) => key + 1); return;
        }
        // a bridge without pages answers with its newest turns: nothing older to add
        if (page.source === "scrollback" || page.cursor === undefined) { setOlderCursor(undefined); setOlderState("idle"); return; }
        const first = heldFrom.current === null;
        heldFrom.current ??= before;
        const top = node.getBoundingClientRect().top;
        const anchor = [...node.querySelectorAll<HTMLElement>("[data-chat-row]")]
          .filter((row) => row.getBoundingClientRect().bottom > top)
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
        if (anchor?.dataset.chatRow) prependAnchor.current = { key: anchor.dataset.chatRow, offset: anchor.getBoundingClientRect().top - top };
        slots.current = prependChatRowSlots(slots.current, page.turns.length);
        olderCount.current += page.turns.length;
        setOlder((turns) => [...page.turns, ...turns]);
        setOlderCursor(page.cursor);
        setOlderState("idle");
        // the newest page may have slid since it was read: poll it from the held start now
        if (first) setPollKey((key) => key + 1);
      } catch (cause) {
        if (shownPane.current !== paneId || olderGeneration.current !== generation) return;
        if (cause instanceof ApiError && cause.status === 409) {
          dropOlder(); setState(EMPTY_STATE); setLoaded(false); signature.current = ""; lastAnswer.current = null;
          setPollKey((key) => key + 1);
        }
        else setOlderState("failed");
      } finally {
        if (olderGeneration.current === generation) loadingOlder.current = false;
      }
    });
  }, [fetchPaneConversation, olderCursor, paneId, pagePrompts, conversationRefresh]);

  // Reconcile the estimated prepend with the actual reader row, through the list's
  // own scroll command. No scrollHeight delta or second virtualizer owns the position.
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
  const pollPrompt = connected && !ended && agent !== null;
  useEffect(() => {
    if (!pollPrompt) { setPrompt(null); setPromptStale(false); failedPromptReads.current = 0; setRestored(null); onSuggestionRef.current?.(paneId, null); onRestoredRef.current?.(paneId, null); return; }
    if (!visible) return;
    let cancelled = false;
    let timer = 0;
    // a restart (the page shown again, a refused answer) keeps the notice and the count of failed reads: only a read that answers clears them
    const readPrompt = async (): Promise<void> => {
      // Keep unchanged prompts stable, but refresh navigation without replacing the card's edits.
      const sent = sentKeyRef.current;
      try {
        const next = await fetchPanePromptState(paneId);
        if (!cancelled) {
          failedPromptReads.current = 0;
          setPromptStale(false);
          setPrompt((current) => polledPrompt(current, next.prompt));
          // unchanged outcomes keep their objects: the turns carrying them are not re-rendered
          setOutcomes((current) => JSON.stringify(current) === JSON.stringify(next.outcomes) ? current : next.outcomes);
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
      // a read the restart cancelled counts for neither side: the new poll's count is its own
      catch { if (!cancelled) { failedPromptReads.current += 1; if (failedPromptReads.current >= PROMPT_STALE_READS) setPromptStale(true); } }
      finally { if (!cancelled) timer = window.setTimeout(() => void readPrompt(), PROMPT_POLL_MS); }
    };
    void readPrompt();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [pollPrompt, paneId, machineId, promptPollKey, promptRefreshKey, fetchPanePromptState, visible]);

  useEffect(() => {
    onPrompt?.(paneId, prompt);
    return () => onPrompt?.(paneId, null);
  }, [onPrompt, paneId, prompt]);

  // a pane left behind keeps no suggestion and no restored send
  useEffect(() => () => { onSuggestionRef.current?.(paneId, null); onRestoredRef.current?.(paneId, null); }, [paneId]);

  // away from the page, the prompt is not read: it can be answered in the terminal and asked
  // again unseen, so a typed pick waiting for Confirm does not outlive the page being hidden
  useEffect(() => {
    if (!visible) onPendingAnswerDone?.(paneId);
  }, [visible, onPendingAnswerDone, paneId]);

  // Following is intent; only measured content at the endpoint proves presentation. In
  // particular scrollToEnd may still be pending, or superseded by another navigation.
  const measureEnd = (): void => {
    const node = scroller.current;
    if (!node) return;
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
      // back at the end, by hand as by Jump: what grows next is followed, no earlier hold kept
      if (!stickToBottom.current) manualLayout.current = false;
      pagingAway.current = false; stickToBottom.current = true;
      scrollInputAt.current = -Infinity; pointerDragAt.current = -Infinity;
      setAway(false); setNewMessages(false);
    }
  };
  const measureEndRef = useRef(measureEnd);
  measureEndRef.current = measureEnd;

  // Before paint and without animation: an opened conversation starts at its end
  // instead of scrolling there from the top.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node !== null && stickToBottom.current) {
      if (state.source === "conversation") timeline.current?.scrollToEnd({ animated: false });
      else node.scrollTop = node.scrollHeight;
    }
  }, [state, prompt, agentStatus, connected, ended]);

  // A resized composer, a raised keyboard or a narrower window shrinks the view
  // without a scroll event; a reader at the end stays at the end, at once. So does a
  // conversation that rewraps inside an unchanged view: its width or its type changed
  // (Settings → Chat width, Chat font size, Chat font). One that only grew taller did so under
  // the reader's hand (a folded block opened, a whole output asked for): following the end there
  // would jump past what was just opened. New messages follow in the layout effect above.
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
      if (follow && stickToBottom.current) {
        // The list's scrollToEnd lands a frame later (see dropPendingListScroll), so the frame
        // painted now would show the conversation's last lines under a composer that grew a line.
        // This callback runs before that paint: put the view at the end here, then let the list
        // settle its own scroll state.
        node.scrollTop = node.scrollHeight;
        if (timeline.current) timeline.current.scrollToEnd({ animated: false });
      }
      measureEndRef.current();
    });
    observer.observe(node);
    if (node.firstElementChild !== null) observer.observe(node.firstElementChild);
    // The list can mount/position its rows after the parent's layout without resizing a
    // short scroll container. Those commits, including retry recovery, also prove geometry.
    const content = new MutationObserver(() => measureEndRef.current());
    content.observe(node, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["style"] });
    return () => { observer.disconnect(); content.disconnect(); };
  }, [state.source, ChatTimeline]);
  // One of the app's faces arrived (font-display: swap; a unicode-range chunk on the first Korean
  // answer): the conversation rewraps with no width, size or family string changed, so the
  // observer above takes it for one that only grew taller. A reader at the end stays at the end.
  const faces = useFacesArrived();
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node !== null && stickToBottom.current) {
      if (timeline.current) timeline.current.scrollToEnd({ animated: false });
      else node.scrollTo({ top: node.scrollHeight, behavior: "instant" });
    }
  }, [faces]);
  // a tap or a drag down the transcript puts a phone's keyboard away to read (lib/keyboard.ts)
  useEffect(() => {
    const node = scroller.current;
    return node === null ? undefined : dismissKeyboardOn(node);
  }, [state.source, ChatTimeline]);

  useEffect(() => {
    if (!visible) return;
    let pointer: { x: number; y: number } | null = null;
    let touchY: number | undefined;
    const mark = (event: Event): void => {
      const node = scroller.current;
      if (event instanceof KeyboardEvent) {
        if (!active || event.isComposing || event.keyCode === 229) return;
        if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")) return;
        if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home" || (event.key === " " && event.shiftKey)) scrollInputAt.current = performance.now();
        return;
      }
      if (event instanceof PointerEvent && (event.type === "pointerup" || event.type === "pointercancel")) {
        // A thumb let go away from where it was pressed was dragged: the reader moved it, however
        // long it rested first. One let go where it went down only rested while the layout moved the
        // transcript. A scroll still on its way counts from now; one already shown stops following now.
        const press = scrollbarPress.current;
        const dragged = press !== null && event.type === "pointerup" && event.clientY !== press.y;
        if (node !== null && node.scrollTop < lastScrollTop.current) {
          scrollInputAt.current = Math.max(scrollInputAt.current, dragged ? performance.now() : pointerDragAt.current);
          // the reader dragged the thumb away: a local send already on its way no longer takes them to the end
          if (dragged) navigated();
        } else if (node !== null && dragged && press.movedUp && node.scrollHeight - node.clientHeight - node.scrollTop > READER_ALLOWANCE_PX) {
          // however far the drag went, and whether or not the layout allowance already stopped following
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
      if (event instanceof PointerEvent && (event.type === "pointerdown" || event.buttons === 0)) scrollbarPress.current = null;
      if (node === null || !(event.target instanceof Node) || !node.contains(event.target)) return;
      if (event instanceof WheelEvent && event.deltaY < 0) scrollInputAt.current = performance.now();
      if (event instanceof PointerEvent) {
        if (event.type === "pointerdown") {
          pointer = { x: event.clientX, y: event.clientY };
          pointerDragAt.current = -Infinity;
          // A scrollbar press may scroll before the browser delivers any pointermove.
          if (event.target === node && event.clientX >= node.getBoundingClientRect().left + node.clientWidth) {
            pointerDragAt.current = performance.now();
            scrollbarPress.current = event.button === 0 ? { y: event.clientY, movedUp: false } : null;
          }
        }
        else if (pointer !== null && event.buttons !== 0 && (event.clientX !== pointer.x || event.clientY !== pointer.y)) pointerDragAt.current = performance.now();
      }
      if ((event.type === "touchstart" || event.type === "touchmove") && event instanceof TouchEvent) {
        const y = event.touches[0]?.clientY;
        if (event.type === "touchmove" && y !== undefined && touchY !== undefined && y > touchY) scrollInputAt.current = performance.now();
        touchY = y;
      }
    };
    const options = { capture: true, passive: true } as const;
    const types = ["wheel", "touchstart", "touchmove", "pointerdown", "pointermove", "pointerup", "pointercancel", "keydown"] as const;
    for (const type of types) document.addEventListener(type, mark, options);
    // a press whose release this page may not see: the window lost focus, the page was hidden, or the
    // chat was hidden or left
    const letGo = (): void => { scrollbarPress.current = null; };
    const hidden = (): void => { if (document.visibilityState === "hidden") letGo(); };
    window.addEventListener("blur", letGo);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      for (const type of types) document.removeEventListener(type, mark, options);
      window.removeEventListener("blur", letGo);
      document.removeEventListener("visibilitychange", hidden);
      letGo();
    };
  }, [active, visible]);
  const onScroll = (): void => {
    const node = scroller.current;
    if (node === null) return;
    const distanceFromBottom = node.scrollHeight - node.clientHeight - node.scrollTop;
    const scrollingDown = node.scrollTop > lastScrollTop.current;
    const scrollingUp = node.scrollTop < lastScrollTop.current;
    lastScrollTop.current = node.scrollTop;
    // A pointer press alone is not intent: a drag must also move the transcript up. A held scrollbar
    // thumb's move is decided when it is let go (the pointerup above): while it rests, the layout
    // may move the transcript too.
    if (scrollingUp) {
      if (scrollbarPress.current !== null) scrollbarPress.current.movedUp = true;
      scrollInputAt.current = Math.max(scrollInputAt.current, pointerDragAt.current);
    }
    // An upward move right after upward input is reading intent beyond endpoint rounding; one without
    // it (a growing composer shrinking the viewport before the bottom correction) keeps following
    // within the layout allowance. The end presentation stays exact in measureEnd.
    const byReader = performance.now() - scrollInputAt.current < SCROLL_INPUT_MS;
    const allowance = byReader ? READER_ALLOWANCE_PX : LAYOUT_ALLOWANCE_PX;
    if (scrollingUp && byReader) navigated();
    // A row above the view shrank and the list held the rows on screen where they were
    // (maintainVisibleContentPosition), or the transcript's end shrank under a view at it: the move
    // up is the layout's, however far it lands from an end a glide was still on its way to (#2042).
    // A move up the reader made, even one that sends no input this page sees, moves the view up a
    // transcript that did not shrink.
    const lastKey = timelineRows.at(-1)?.key;
    const lastRow = lastKey === undefined ? null : node.querySelector<HTMLElement>(`[data-chat-row="${CSS.escape(lastKey)}"]`);
    // where the last row starts in the transcript: it moves up as rows above it shrink
    const row = lastKey === undefined || lastRow === null ? null
      : { key: lastKey, offset: lastRow.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop };
    const rowBefore = lastRowOffset.current;
    lastRowOffset.current = row;
    const shrunkAbove = row !== null && rowBefore?.key === row.key ? Math.max(0, rowBefore.offset - row.offset) : 0;
    // the transcript got shorter: at its end the browser moves the view up with it
    const shrunk = Math.max(0, lastScrollHeight.current - node.scrollHeight);
    lastScrollHeight.current = node.scrollHeight;
    // Without input, a move up while the transcript got shorter is the layout's, however far: the
    // list holding the rows and the browser keeping the view inside the transcript can both move it
    // for one shrink. Over a transcript that did not shrink it is the reader's once the view is past
    // the layout allowance from the end, however many small moves took it there. Growth never
    // excuses a move up.
    const shrankUnderView = shrunkAbove > READER_ALLOWANCE_PX || shrunk > READER_ALLOWANCE_PX;
    const heldInPlace = scrollingUp && !byReader && (shrankUnderView || distanceFromBottom <= LAYOUT_ALLOWANCE_PX);
    const leftEnd = scrollingUp && !heldInPlace;
    // Reaching the rounded endpoint clears reading intent unless still paging upward.
    if ((!pagingAway.current || scrollingDown) && distanceFromBottom <= 1) pagingAway.current = false;
    if (leftEnd && distanceFromBottom > allowance && stickToBottom.current) {
      pagingAway.current = true;
      dropPendingListScroll(timeline.current);
    }
    // the layout's move left a reader still following short of the end: they go on there, unless
    // what they just clicked is laid out where they are (ChatTimeline manualLayout)
    if (heldInPlace && stickToBottom.current && !pagingAway.current && !manualLayout.current && distanceFromBottom > LAYOUT_ALLOWANCE_PX) {
      if (timeline.current) timeline.current.scrollToEnd({ animated: false });
      else node.scrollTo({ top: node.scrollHeight, behavior: "instant" });
    }
    // A downward automatic scroll may arrive before the next measured layout.
    // Only upward movement can turn an existing follow intent into reading intent.
    if (!stickToBottom.current || leftEnd || pagingAway.current) {
      const following = !pagingAway.current && distanceFromBottom <= allowance;
      if (following && !stickToBottom.current) manualLayout.current = false;
      stickToBottom.current = following;
    }
    setAway(!stickToBottom.current);
    measureEnd();
    if (loaded && restoring.current === null && state.source === "conversation") rememberPlace(node);
    if (node.scrollTop < LOAD_OLDER_PX && olderState === "idle") void loadOlder();
  };
  onScrollRef.current = onScroll;
  // the turn at the top of the view and its offset there, or the end while the reader follows it
  const rememberPlace = (node: HTMLDivElement): void => {
    if (stickToBottom.current) {
      // End restoration ignores row anchors; only readers away from it need geometry.
      rememberChatPosition(paneStorageId(machineId, paneId), {
        historyId: history.current ?? null, turn: "", offset: 0, atEnd: true,
      });
      return;
    }
    const top = node.getBoundingClientRect().top;
    let first: { key: string; top: number } | null = null;
    for (const row of node.querySelectorAll<HTMLElement>("[data-chat-row]")) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > top && (first === null || rect.top < first.top)) first = { key: row.dataset.chatRow ?? "", top: rect.top };
    }
    const row = first === null ? undefined : timelineRows.find((candidate) => candidate.key === first.key);
    rememberChatPosition(paneStorageId(machineId, paneId), {
      historyId: history.current ?? null,
      turn: row === undefined ? "" : row.turn === null ? `outcome|${row.outcome.id}` : chatTurnAnchor(row.turn),
      offset: first === null ? 0 : first.top - top,
      atEnd: row === undefined,
    });
  };
  // Opening a tool, a folded block or a whole output is reading there, as scrolling up is: the end
  // moves on without the reader until they go back to it (#1388), and a local send already on its way
  // no longer takes them to the end. A glide still under way stops where it is.
  const readOpened = useCallback((): void => {
    navigationRef.current += 1;
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
    // Away/new-message state clears in measureEnd once the end is really on screen (#1342).
    pagingAway.current = false; stickToBottom.current = true;
    // back at the end, what grows next is followed: no hold an earlier click set is kept (#1388)
    manualLayout.current = false;
    // A lens change can unmount us before the deferred list scroll emits its first event.
    rememberPlace(node);
    if (timeline.current) timeline.current.scrollToEnd({ animated: false });
    else node.scrollTo({ top: node.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    measureEnd();
  };
  // This browser's own message, taken by the bridge at once: the reader goes back to the end and
  // follows the turn there as it is written, unless they navigated after it went out. Each key is
  // taken once; an upward scroll before the turn shows ends the follow as it always does.
  useLayoutEffect(() => {
    if (localSend === undefined || seenLocalSend.current === localSend.key) return;
    seenLocalSend.current = localSend.key;
    if (localSend.navigationGeneration === navigationRef.current) scrollToBottom();
  }, [localSend]);
  // leaving the pane (a retained pane stays mounted off-tab) or the chat lens is navigation: a
  // receipt still on its way follows nothing
  useEffect(() => { if (!paneVisible) navigationRef.current += 1; }, [paneVisible, navigationRef]);
  useEffect(() => () => { navigationRef.current += 1; }, [navigationRef]);
  useLayoutEffect(() => {
    // under a peek the page keys and the shortcuts page the terminal (TerminalViewportTools)
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
      // paging back is navigation; paging toward the end keeps a follow on its way, as a wheel down does
      if (direction < 0 && node.scrollTop !== before) navigated();
      // A physical end may still report a positive subpixel gap, even with no movement.
      if (direction > 0 && node.scrollHeight - node.clientHeight - node.scrollTop <= 1) {
        pagingAway.current = false;
        onScroll();
        return;
      }
      // At the loaded top, PageUp still asks for the earlier page the scroll position cannot reach.
      if (node.scrollTop === before) { if (direction < 0) onScroll(); return; }
      lastScrollTop.current = before;
      if (direction < 0) {
        pagingAway.current = true;
        // A minimap tick and a restored place scroll through the list, which drops a follow
        // still waiting there; this native page scroll does not, so drop it here, or it lands after.
        dropPendingListScroll(timeline.current);
      }
      // Apply the intent before output or a deferred scroll event can restore following.
      onScroll();
    };
    pageScroll.current = scroll;
    return () => { if (pageScroll.current === scroll) pageScroll.current = null; };
  });
  const turns = useMemo(() => older.length > 0 ? [...older, ...state.turns] : state.turns, [older, state.turns]);
  // A cancelled send back in the agent's input box is no sent turn: the transcript still holds it
  // (empty, blank, held and onRead keep the turns as read), but the rendered list drops it while
  // the last turn is that very send — matching the terminal, which shows it only as typed text.
  const shownTurns = useMemo(() => {
    const last = turns[turns.length - 1];
    if (restored === null || last?.role !== "user") return turns;
    const sent = last.parts.filter((part): part is Extract<ConversationPart, { kind: "text" }> => part.kind === "text").map((part) => part.text).join("\n");
    return sameMessage(sent, restored) ? turns.slice(0, -1) : turns;
  }, [turns, restored]);
  heldPage.current = state.turns;
  const finishedBeforeSend = sentOver !== null && sentOver.page === state.turns ? sentOver.turn : null;
  const lastShownTurn = state.source === "conversation" ? shownTurns.at(-1) : undefined;
  const lastSplit = lastShownTurn !== undefined && isLiveWorkTurn(lastShownTurn, true, workStatus, finishedBeforeSend) ? splitTurn(lastShownTurn.parts) : null;
  // the last turn runs and already says the agent works: its work block, or the head standing in
  // for one while it has no answer yet
  const workBlockLive = lastSplit !== null && (visibleWorkParts(lastSplit.work, settings.showThinking).length > 0 || lastSplit.answer.length === 0);
  // a running turn with words and no work rows: the activity is a line under its words, as before
  const answerOnlyLive = lastSplit !== null && !workBlockLive;
  const empty = state.source === "conversation" ? turns.length === 0 : agent === null && state.messages.length === 0;
  const blank = !ended && chatIsBlank({ loaded, failed: error !== null, transcript: state.source === "conversation", turns: turns.length, older: typeof olderCursor === "string", abandoned: abandoned?.count ?? 0, prompt: prompt !== null, agent });
  // the scrollback standing in says nothing of the conversation: it has no history to compare
  const known = loaded && error === null && !ended && state.source === "conversation";
  const held = turns.length + (abandoned?.count ?? 0);
  // before paint: the greeting replaces the line below in the same frame, not one after it
  useLayoutEffect(() => {
    onRead?.(paneId, known ? { blank, turns: held, history: historyId } : null);
  }, [onRead, paneId, known, blank, held, historyId]);
  // the chat left the screen (another lens): nothing is known of it until it is read again
  useLayoutEffect(() => () => onRead?.(paneId, null), [onRead, paneId]);

  const rowSlots = slots.current.rows;
  const timelineScope = JSON.stringify(slots.current.scope);
  // another pane or PC: its pictures are not this one's
  useEffect(() => setViewer(null), [timelineScope]);
  const rowMemories = useMemo(() => new Map<string, ChatRowMemory>(), [timelineScope]);
  // the turns with the commands sent from here: a chip on the turn that records one, a provisional
  // sent row for one no turn records (yet), placed by send time (lib/outcomeChip.ts)
  const withOutcomes = useMemo(() => outcomeRows(shownTurns, outcomes, { restored, beginningLoaded: olderCursor === null }), [shownTurns, outcomes, restored, olderCursor]);
  const timelineRows = useMemo((): ChatRow[] => {
    const rows = withOutcomes.map((row): ChatRow => {
      if (row.kind === "sent") return { key: `outcome:${row.outcome.id}`, turn: null, outcome: row.outcome, beforeUser: false };
      const slot = rowSlots[row.index];
      if (!slot) throw new Error("A loaded chat turn has no row identity");
      return { key: slot.key, turn: shownTurns[row.index]!, index: row.index, outcome: row.outcome, beforeUser: false };
    });
    // a sent row opens an exchange as a user turn does
    return rows.map((row, index) => {
      const next = rows[index + 1];
      return { ...row, beforeUser: row.turn?.role === "assistant" && next !== undefined && (next.turn === null || next.turn.role === "user") };
    });
  }, [withOutcomes, shownTurns, rowSlots]);
  // Back in a pane the reader left away from the end: the first answer read puts the turn they
  // were on back where it sat, before paint. The list's index scroll starts from estimated heights,
  // so the row is brought to its offset once measured, for a few frames at most; any scroll of the
  // reader's own, or an earlier page loaded above (the prepend anchor), takes over at once.
  useLayoutEffect(() => {
    const saved = restoring.current;
    if (saved === null || !loaded || error !== null || state.source !== "conversation") return;
    restoring.current = null;
    const index = chatRestoreIndex(saved, history.current ?? null, timelineRows.map((row) => row.turn === null ? `outcome|${row.outcome.id}` : chatTurnAnchor(row.turn)));
    const list = timeline.current, node = scroller.current;
    if (index === null || list === null || node === null) return;
    const key = timelineRows[index]!.key;
    pagingAway.current = true; stickToBottom.current = false; setAway(true);
    navigated();
    void list.scrollToIndex({ index, viewPosition: 0, viewOffset: saved.offset, animated: false });
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
        const delta = row.getBoundingClientRect().top - node.getBoundingClientRect().top - saved.offset;
        if (Math.abs(delta) > 1) { stable = 0; void list.scrollToOffset({ offset: node.scrollTop + delta, animated: false }); }
        else if (++stable >= 2) { stop(); return; }
      }
      frame = requestAnimationFrame(settle);
    };
    for (const type of ["wheel", "touchmove", "pointerdown"]) node.addEventListener(type, stop, { passive: true });
    document.addEventListener("keydown", stop, true);
    stopRestore.current = stop;
    frame = requestAnimationFrame(settle);
  }, [loaded, error, state.source, timelineRows]);
  // Covers first layout, restored short chats and a fresh read that changes no scroll offset.
  useLayoutEffect(() => { measureEnd(); });
  useEffect(() => () => stopRestore.current?.(), []);
  // the minimap's ticks name list rows: a sent row before a turn moves the turn's row down
  const minimap = useMemo(() => {
    const rowOfTurn = new Map(timelineRows.flatMap((row, index) => row.turn === null ? [] : [[row.index, index] as const]));
    return minimapTurns(shownTurns).map((tick) => ({ ...tick, row: rowOfTurn.get(tick.row) ?? tick.row }));
  }, [shownTurns, timelineRows]);
  const rowKeys = useMemo(() => timelineRows.map((row) => row.key), [timelineRows]);
  // a tick takes the reader to its turn: reading there, follow left off
  const jumpToTurn = useCallback((index: number) => {
    pagingAway.current = true; stickToBottom.current = false; setAway(true);
    navigationRef.current += 1;
    void timeline.current?.scrollToIndex({ index, animated: false, viewPosition: 0 });
  }, [navigationRef]);
  // the rail scrolls the chat from outside it, where the input listeners do not see the wheel
  const minimapWheel = useCallback((deltaY: number) => { if (deltaY < 0) scrollInputAt.current = performance.now(); }, []);
  // a chip's action: the card's first control (the card is drawn into the dock, outside the
  // transcript), or the terminal lens where the command's screen is
  const focusPrompt = useCallback(() => {
    const card = promptDock?.querySelector<HTMLElement>(".prompt-card");
    if (!card) return;
    const control = card.querySelector<HTMLElement>(".prompt-card-options button:not([disabled]), .prompt-card-options input:not([disabled])") ?? card.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled])");
    control?.focus();
  }, [promptDock]);
  const promptUp = prompt !== null;
  // A peek that comes back by itself (lib/terminalPeek.ts): once a prompt read lists the send's own
  // outcome its time is kept (the bridge lists an outcome for a while only), and a local-command
  // notice the agent wrote after it says the command's screen closed (read in every loaded turn: a
  // burst of later turns can move it out of the newest page)
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
  const outcomeActions = useMemo((): OutcomeActions => ({ answer: promptUp ? focusPrompt : null, terminal: onOpenTerminal ?? null, commands }), [promptUp, focusPrompt, onOpenTerminal, commands]);
  // Nothing is typed: drafts and the agent's own rewind remain in the terminal.
  const offered = rewindOffer({ agent, interactive, connected, ended, conversation: state.source === "conversation" });
  const rewindInTerminal = offered === "terminal" ? onRewindInTerminal ?? null : null;
  const renderTurn = useCallback((row: ChatRow) => {
    if (row.turn === null) return <OutcomeRow outcome={row.outcome} actions={outcomeActions} skills={skillMatcher} />;
    const { turn } = row;
    const live = isLiveWorkTurn(turn, row.index === shownTurns.length - 1, workStatus, finishedBeforeSend);
    return <RenderBoundary resetKey={turnRevision(turn, true)} fallback={() => <p className="chat-inline-state chat-inline-error" data-pane-content-error>{t("This message can't be shown here. The terminal has it.")}</p>}>
      <Turn paneId={paneId} turn={turn} rowKey={row.key} live={live} waiting={isWaitingWorkTurn(live, agentStatus)} showThinking={settings.showThinking} skills={skillMatcher} userSkills={skillMatcher} outcome={row.outcome} outcomeActions={outcomeActions}
        onRewindInTerminal={turn.role === "user" ? rewindInTerminal : null} />
    </RenderBoundary>;
  }, [shownTurns.length, workStatus, finishedBeforeSend, t, paneId, agentStatus, settings.showThinking, skillMatcher, outcomeActions, rewindInTerminal]);
  // displayPaneTitle falls back to the pane id for a pane with nothing else to call it
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
        <button type="button" className="btn btn-ghost chat-older" disabled={olderState === "loading"} onClick={() => void loadOlder()}>
          {t(olderState === "loading" ? "Loading earlier messages…" : olderState === "failed" ? "Couldn't load earlier messages — retry" : "Earlier messages")}
        </button>
      )}
      {state.source === "conversation" && olderCursor === null && older.length > 0 && <p className="chat-endcap">{t("beginning of conversation")}</p>}
  </>;
  // the chat's one wait is a live region in the footer from the view's first render, clipped while
  // empty (never display: none); its words land a frame after it (lib/useAnnouncedText.ts). The
  // connection's word is the header chip's alone; a slow PC is waited for quietly before it alarms
  const waiting = error !== null && error.kind === "slow" && failures < SLOW_READS_BEFORE_ALARM;
  const waitWords = useAnnouncedText(!loaded && error === null ? t("Loading conversation…") : waiting ? t("Waiting for the PC…") : null);
  const retryRead = useCallback(() => { setFailures(0); conversationRefresh.refresh(); }, [conversationRefresh]);
  const footer = <>
      <p className={waitWords === null ? "visually-hidden" : "chat-inline-state"} role="status">{waitWords}</p>
      {error !== null && !waiting && (errorStatus === 401
        ? <p className="chat-inline-state chat-inline-error" role="alert">{t("locked — the token gate is asking again")}</p>
        : <FailureLine action={t("Couldn't load the conversation")} failure={error} onRetry={retryRead} />)}
      {loaded && error === null && agent === "grok" && state.source !== "conversation" && <p className="chat-inline-state" role="status">{t("Grok chat is unavailable. Open Terminal to see activity and tool calls.")}</p>}
      {loaded && error === null && agent === "agy" && state.source !== "conversation" && <p className="chat-inline-state" role="status">{t("Antigravity chat is unavailable. Open Terminal to see activity and tool calls.")}</p>}
      {loaded && error === null && connected && !ended && liveTurnOpen
        && <TerminalFallback paneId={paneId} visible={visible} live />}
      {/* The agent's activity, where no open work block says it: before the turn has an assistant or
          tool row (Claude Code's spinner writes nothing to the transcript), and while a native turn
          thinks (a work block's head says Working). Without native activity the pane status stands
          in. One Working at a time. */}
      {connected && !ended && activity !== "idle" && agentStatus !== "blocked" && prompt === null && (activity === "thinking" || !workBlockLive) && (workBlockLive
        // under the running turn's own head, a second head would read as a second block
        ? <p className="chat-activity chat-activity-line" role="status"><CircleDot aria-hidden="true" />{t("Thinking…")}</p>
        // under a running turn's words: removing a line below them moves nothing when it ends
        : answerOnlyLive
          ? <p className="chat-activity chat-activity-line" role="status"><CircleDot aria-hidden="true" />{activity === "thinking" ? t("Thinking…") : t("Working…")}</p>
          // before the turn has a row at all, where its work block will be drawn
          : <PendingWorkHead className="chat-activity" title={activity === "thinking" ? t("Thinking…") : t("Working…")} />)}
      {loaded && empty && error === null && prompt === null && activity === "idle" && !(greeted && blank) && <div className="chat-empty"><AgentMark agent={agent ?? "agent"} size={32} /><p>{t("No conversation yet — say something below")}</p></div>}
      {ended && <p className="chat-endcap">{t("terminal ended")}</p>}
  </>;
  const jump = newMessages ? <button type="button" className="btn chat-new-messages chat-virtual-jump" onClick={scrollToBottom}>{t("New messages")} <ArrowDown aria-hidden="true" /></button>
    : away && <button type="button" className="btn chat-new-messages chat-virtual-jump is-icon" aria-label={t("Jump to latest")} title={t("Jump to latest")} onClick={scrollToBottom}><ArrowDown aria-hidden="true" /></button>;
  return <ChatPaneContext.Provider value={paneId}><ChatHistoryContext.Provider value={historyId ?? ""}><ImageViewerContext.Provider value={openViewer}><ToolPathRootContext.Provider value={toolPathRoot(cwd)}>
    {/* a reader away from the end has not seen the answer a finish lands there: presented only at the end */}
    <div className="chat-frame" data-pane-content={active && visible && !covered && connected && !ended && loaded && error === null && !away && !newMessages
      && endPresentation?.state === state && endPresentation.key === presentationKey
      && (agentStatus !== "done" || conversationFinishPresented({ source: state.conversationSource, turns: state.turns }))
      && readPresentation === presentationKey && (state.source === "conversation" ? ChatTimeline !== null : agent === null) ? presentationKey : undefined}>
    <div className="chat-frame-body">
    {state.source === "conversation" ? ChatTimeline === null
      // its chunk is still loading: no turn is read until it arrives, so this is the loading state
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
      smoothFollow={smoothFollow}
      memories={rowMemories}
      header={header}
      footer={footer}
      label={logLabel}
      onScroll={onScroll}
      onOpen={readOpened}
      renderRow={renderTurn}
    /> : <div className="chat-view" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-label={logLabel}>
      <div className="chat-transcript" data-conversation-source={state.conversationSource}>
        <ChatFallback paneId={paneId} agent={agent} visible={visible} messages={state.messages} outcomes={outcomes} restored={restored} actions={outcomeActions} skills={skillMatcher} />
        {footer}
      </div>
    </div>}
    {state.source === "conversation" && <ChatMinimap turns={minimap} rowKeys={rowKeys} scroller={scroller} onJump={jumpToTurn} onWheel={minimapWheel} />}
    {jump}
    {/* only a pane this device may send to takes comments: they go with its next message */}
    {state.source === "conversation" && interactive && !ended && <ReplyCommentAction scroller={scroller} storageKey={replyCommentsKey(paneStorageId(machineId, paneId))} />}
    </div>
    </div>
  {/* The prompt card is not part of the transcript: it is drawn on the composer's column, over the
      input card, where PaneTerminal keeps its place. The prompt itself (its poll, the answer, the
      re-read) stays here. */}
  {prompt !== null && promptDock !== null && createPortal(
    <PromptCard key={promptOccurrence.current.count} paneId={paneId} prompt={prompt} stale={promptStale} screenWords={screenWordsToShow(prompt, state.source === "conversation" ? state.turns : [])} typedAnswer={pendingAnswer?.promptId === prompt.id ? pendingAnswer.answer : null} onTypedAnswerDone={() => onPendingAnswerDone?.(paneId, prompt.id)} onPromptChanged={() => setPromptPollKey((key) => key + 1)} onAnswered={(toMessageBox) => {
      // the card reports only while it is the one shown; still, only its own prompt is cleared
      onPromptAnswered?.(toMessageBox);
      setPrompt((current) => current === prompt ? null : current);
      // a form of several questions goes on to its next one: read it now, not at the next poll
      if (prompt.steps) setPromptPollKey((key) => key + 1);
      // Refresh conversation and input state after an answer.
      setPollKey((key) => key + 1);
      setPromptPollKey((key) => key + 1);
      onPendingAnswerDone?.(paneId, prompt.id);
    }} />, promptDock)}
  {viewer !== null && <ImageLightbox images={viewer.images} index={viewer.index} onClose={closeViewer} />}
  </ToolPathRootContext.Provider></ImageViewerContext.Provider></ChatHistoryContext.Provider></ChatPaneContext.Provider>;
});
