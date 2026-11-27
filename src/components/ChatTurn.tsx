import { memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { BookOpen, Check, ChevronDown, Circle, CircleAlert, CircleCheck, CircleQuestionMark, CircleSlash, CircleX, Copy, Hourglass, Layers, SquareTerminal, Target, type LucideProps } from "lucide-react";

import { Markdown } from "./Markdown.tsx";
import { ChatDetails, ChatRowMemoryContext, useChatRowToggle } from "../lib/chatRowState.tsx";
import { turnSkills } from "../lib/skillActivity.ts";
import { copyText } from "../lib/clipboard.ts";
import { plainText } from "../lib/plainText.ts";
import { userGalleryImages } from "../lib/chatImages.ts";
import { answerItems, formatWorkDuration, runNames, splitTurn, turnSegments, type WorkSegment, visibleWorkParts, workBlockStartsOpen } from "../lib/workBlocks.ts";
import { formatGoalTime, goalWaitSources, goalWaitUntil, turnGoal, type GoalState, type GoalStatus } from "../lib/goals.ts";
import { teammateMessageParts, type TeammateMessage } from "../lib/teammateMessage.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { type SkillMatcher } from "../lib/skillMentions.ts";
import { formatTokens } from "../lib/compose.ts";
import { formatElapsed, taskResultMarkdown } from "../lib/omoTasks.ts";
import { shouldFoldUserMessage } from "../lib/userMessageFold.ts";
import { outcomeChip, outcomeCommand, outcomeLabel, outcomeNote, outcomeResultText, type OutcomeState } from "../lib/outcomeChip.ts";
import { typedTerminalCommand } from "../lib/compose.ts";
import type { CommandOutcome, ConversationPart, ConversationTurn, OmoTaskResult, SlashCommand } from "../../shared/protocol.ts";
import { TurnTime } from "./TurnTime.tsx";
import { currentLocale, useT } from "../lib/i18n.ts";
import { ImageGallery, turnWork, WorkBlockView } from "./ChatWork.tsx";

export const userText = (turn: ConversationTurn): string => turn.parts.filter((part): part is Extract<ConversationPart, { kind: "text" }> => part.kind === "text").map((part) => part.text).join("\n\n");

export function CopyButton({ text, getText, label, className = "icon-button chat-copy", children, onResult }: { text?: string; getText?: () => string; label: string; className?: string; children?: React.ReactNode; onResult: (ok: boolean) => void }) {
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

export interface OutcomeActions {
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

export function OutcomeChip({ outcome, actions, snapshot }: { outcome: CommandOutcome; actions: OutcomeActions | null; snapshot?: string }) {
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

export function OutcomeRow({ outcome, actions, skills = null }: { outcome: CommandOutcome; actions: OutcomeActions | null; skills?: SkillMatcher | null }) {
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