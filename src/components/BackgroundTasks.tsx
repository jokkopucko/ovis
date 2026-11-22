import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { ChevronDown, ChevronRight, Circle, CircleAlert, CircleCheck, CircleDot, CircleSlash, CircleX, Layers, ListChecks, Workflow, type LucideProps } from "lucide-react";

import "./BackgroundTasks.css";

import { BackgroundAgentDetail } from "./BackgroundAgentDetail.tsx";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { clockOffsetMs, endedSummary, formatElapsed, runGoing, spanMs, taskElapsedMs } from "../lib/omoTasks.ts";
import { formatTokens } from "../lib/compose.ts";
import { planWaves } from "../lib/plan.ts";
import { useT } from "../lib/i18n.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import type { OmoRun, OmoRunNode, OmoTask, PlanStep, PlanSummary } from "../../shared/protocol.ts";

const POLL_MS = 3000;

const ICONS: Record<OmoTask["status"], ComponentType<LucideProps>> = {
  running: CircleDot, completed: CircleCheck, failed: CircleX, cancelled: CircleSlash, lost: CircleAlert,
};
const STEP_ICONS: Record<PlanStep["status"], ComponentType<LucideProps>> = { pending: Circle, in_progress: CircleDot, completed: CircleCheck };
const NODE_ICONS: Record<OmoRunNode["state"], ComponentType<LucideProps>> = {
  pending: Circle, scheduled: Circle, running: CircleDot, blocked: CircleAlert, completed: CircleCheck, failed: CircleX, skipped: CircleSlash, cancelled: CircleSlash,
};

/**
 * The status line's one chip for what the agent works through besides its answer: the plan it
 * keeps (Claude Code's task list, Codex's checklist: `plan`, read again while open) and its
 * background tasks. A Claude Code or OpenCode pane's tasks are its subagents (`subagents`).
 */
export function BackgroundTasks({ paneId, count, omo, subagents = false, plan = null }: { paneId: string; count: number; omo: boolean; subagents?: boolean; plan?: PlanSummary | null }) {
  const t = useT();
  const { fetchPaneOmoActivity, fetchPanePlan } = useMachineApi();
  const machineId = useMachineId();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<OmoTask | null>(null);
  const detailUp = useRef(false);
  detailUp.current = detail !== null;
  const closeDetail = useCallback(() => setDetail(null), []);
  usePhoneSheetBack(() => setOpen(false), open && detail === null);
  useEffect(() => { if (!open) setDetail(null); }, [open]);
  useEffect(() => { setDetail(null); }, [paneId, machineId]);
  const [seen, setSeen] = useState(count > 0);
  useEffect(() => { if (count > 0) setSeen(true); }, [count]);
  useEffect(() => {
    if (!subagents || count > 0) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The server answers within a second with what it knows, so a pane whose session it is still
    // looking for reads as having none: an empty answer is asked again a few times. Agents that
    // ended before that are told by nothing else, as the count changes only for running ones.
    const ask = (left: number): void => {
      const again = (): void => { if (alive && left > 0) timer = setTimeout(() => ask(left - 1), POLL_MS); };
      fetchPaneOmoActivity(paneId).then((found) => { if (!alive) return; if (found.tasks.length > 0) setSeen(true); else again(); }, again);
    };
    ask(3);
    return () => { alive = false; clearTimeout(timer); };
  }, [subagents, paneId, count]);
  const [tasks, setTasks] = useState<OmoTask[] | null>(null);
  const [runs, setRuns] = useState<OmoRun[]>([]);
  const [moreRunning, setMoreRunning] = useState(0);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [offset, setOffset] = useState(0);
  const [showEnded, setShowEnded] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const endedId = useId();
  useEffect(() => { if (!open) setShowEnded(false); }, [open]);

  const tasksShown = count > 0 || seen || omo;
  useEffect(() => {
    if (!open || !tasksShown) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      try {
        const next = await fetchPaneOmoActivity(paneId);
        if (!alive) return;
        const received = Date.now();
        setTasks(next.tasks); setRuns(next.runs); setMoreRunning(next.moreRunning); setFailed(false); setOffset(clockOffsetMs(next.serverTime, received)); setNow(received);
      } catch {
        if (alive) setFailed(true);
      }
      if (!alive) return;
      timer = setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [open, tasksShown, paneId, fetchPaneOmoActivity]);

  const [steps, setSteps] = useState<PlanStep[] | null | undefined>(undefined);
  const [planFailed, setPlanFailed] = useState(false);
  const planShown = plan !== null;
  useEffect(() => {
    if (!open || !planShown) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSteps(undefined);
    const load = async (): Promise<void> => {
      try {
        const next = await fetchPanePlan(paneId);
        if (!alive) return;
        const received = Date.now();
        setSteps(next.steps); setPlanFailed(false); setOffset(clockOffsetMs(next.serverTime, received)); setNow(received);
      } catch {
        if (alive) setPlanFailed(true);
      }
      if (alive) timer = setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [open, planShown, paneId, fetchPanePlan]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => { if (!detailUp.current && !root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || detailUp.current) return;
      if (root.current?.contains(document.activeElement)) toggle.current?.focus();
      setOpen(false);
    };
    // no relatedTarget: a press on a row, or a browser that does not focus a pressed button (Safari,
    // Firefox on macOS)
    const left = (event: FocusEvent): void => { if (!detailUp.current && event.relatedTarget instanceof Node && !node?.contains(event.relatedTarget)) setOpen(false); };
    const node = root.current;
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    node?.addEventListener("focusout", left);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); node?.removeEventListener("focusout", left); };
  }, [open]);

  useLayoutEffect(() => {
    const list = menu.current;
    const anchor = list?.offsetParent;
    const composer = anchor?.closest(".composer") ?? null;
    const frame = (composer ?? anchor)?.parentElement;
    if (!open || !list || !anchor || !frame) return;
    const measure = (): void => list.style.setProperty("--bg-tasks-room", `${anchor.getBoundingClientRect().top - frame.getBoundingClientRect().top}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    observer.observe(frame);
    if (composer) observer.observe(composer);
    return () => observer.disconnect();
  }, [open]);

  const running = tasks?.filter((task) => task.status === "running") ?? [];
  const ended = tasks?.filter((task) => task.status !== "running") ?? [];
  const words: Record<OmoTask["status"], string> = {
    running: t("running"), completed: t("done"), failed: t("failed"), cancelled: t("cancelled"), lost: t("lost"),
  };

  const row = (task: OmoTask) => {
    const Icon = ICONS[task.status];
    const elapsed = taskElapsedMs(task, now + offset);
    const meta = [
      task.category, task.model, elapsed === null ? null : formatElapsed(elapsed),
      task.turns === null ? null : t(task.turns === 1 ? "{n} turn" : "{n} turns", { n: task.turns }),
      task.tool_calls === null ? null : t(task.tool_calls === 1 ? "{n} tool call" : "{n} tool calls", { n: task.tool_calls }),
      task.tokens === null ? null : t("{n} tokens", { n: formatTokens(task.tokens) }),
    ].filter((item) => item !== null).join(" · ");
    const main = <span className="bg-task-main">
      <span className="bg-task-title">{task.title}<span className="sr-only"> ({words[task.status]})</span></span>
      {(meta.length > 0 || (task.status !== "running" && task.status !== "completed")) && <span className="bg-task-meta">{[task.status !== "running" && task.status !== "completed" ? words[task.status] : null, meta || null].filter((item) => item !== null).join(" · ")}</span>}
    </span>;
    if (task.status === "running") {
      return <li key={task.id} className={`bg-task is-${task.status} is-openable`}>
        <button type="button" className="bg-task-open" aria-haspopup="dialog" aria-expanded={detail?.id === task.id} onClick={(event) => { event.currentTarget.focus(); setDetail(task); }}>
          <Icon className="bg-task-icon" aria-hidden="true" />
          {main}
          <ChevronRight className="bg-task-caret" aria-hidden="true" />
        </button>
      </li>;
    }
    return <li key={task.id} className={`bg-task is-${task.status}`}>
      <Icon className="bg-task-icon" aria-hidden="true" />
      {main}
    </li>;
  };

  const nodeWords: Record<OmoRunNode["state"], string> = {
    pending: t("waiting"), scheduled: t("waiting"), running: t("running"), blocked: t("blocked"), completed: t("done"), failed: t("failed"), skipped: t("skipped"), cancelled: t("cancelled"),
  };

  const runView = (run: OmoRun) => {
    const nodes = run.waves.flat();
    const done = nodes.filter((node) => node.state === "completed").length;
    const runningNow = nodes.filter((node) => node.state === "running").length;
    const failedNodes = nodes.filter((node) => node.state === "failed");
    const elapsed = spanMs(run.started_at, run.ended_at, runGoing(run), now + offset);
    const meta = [
      t("{done} of {total} done", { done, total: nodes.length }),
      runningNow > 0 ? t("{n} running", { n: runningNow }) : null,
      failedNodes.length > 0 ? t("{n} failed", { n: failedNodes.length }) : null,
      run.status === "cancelled" ? t("cancelled") : run.status === "paused" ? t("paused") : run.status === "pending" ? t("waiting") : null,
      elapsed === null ? null : formatElapsed(elapsed),
    ].filter((item) => item !== null).join(" · ");
    return <li key={run.id} className={`bg-run is-${run.status}`}>
      <div className="bg-run-head"><Workflow className="bg-task-icon" aria-hidden="true" /><span className="bg-task-main"><span className="bg-task-title">{run.name}</span><span className="bg-task-meta">{meta}</span></span></div>
      <ol className="bg-run-waves">{run.waves.map((wave, index) => <li key={index} className="bg-run-wave">
        {wave.map((node) => {
          const Icon = NODE_ICONS[node.state];
          return <span key={node.id} className={`bg-node is-${node.state}`} title={node.error ?? undefined}><Icon aria-hidden="true" />{node.label}<span className="sr-only"> ({nodeWords[node.state]})</span></span>;
        })}
      </li>)}</ol>
      {failedNodes.filter((node) => node.error !== null).map((node) => <p key={node.id} className="bg-run-error">{node.label}: {node.error}</p>)}
    </li>;
  };

  const goingRuns = runs.filter(runGoing);
  const endedRuns = runs.filter((run) => !runGoing(run));
  const summary = endedSummary(tasks ?? [], runs);

  useEffect(() => { if (open && !planShown && !tasksShown) setOpen(false); }, [open, planShown, tasksShown]);
  if (!planShown && !tasksShown) return null;
  const tasksLabel = count === 0 ? t("Background tasks") : t(count === 1 ? "{n} background task" : "{n} background tasks", { n: count });
  const planLabel = plan ? t("Plan: {done} of {total} done", { done: plan.done, total: plan.total }) : null;
  const current = plan?.current ? plan.current : null;
  const name = [planLabel, current, tasksShown ? tasksLabel : null].filter((part) => part !== null).join(" · ");
  const busy = count > 0 || (plan !== null && plan.done < plan.total);
  const stepWords: Record<PlanStep["status"], string> = { pending: t("waiting"), in_progress: t("running"), completed: t("done") };
  const stepRow = (step: PlanStep) => {
    const Icon = STEP_ICONS[step.status];
    const elapsed = spanMs(step.started_at, step.ended_at, step.status === "in_progress", now + offset);
    const meta = [stepWords[step.status], elapsed === null ? null : formatElapsed(elapsed), step.owner].filter((part) => part !== null).join(" · ");
    return <li key={step.id} className={`bg-task bg-step is-${step.status}`}>
      <Icon className="bg-task-icon" aria-hidden="true" />
      <span className="bg-task-main">
        <span className="bg-task-title">{step.label}</span>
        {step.status === "in_progress" && step.active && step.active !== step.label && <span className="bg-step-active">{step.active}</span>}
        <span className="bg-task-meta">{meta}</span>
      </span>
    </li>;
  };
  return <span className="bg-tasks" ref={root}>
    <button type="button" ref={toggle} className={`bg-tasks-toggle${busy ? "" : " is-idle"}`} aria-label={name} title={name} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      {plan && <><ListChecks aria-hidden="true" /><span className="bg-tasks-label">{t("Plan")}</span><span className="bg-tasks-plan" aria-hidden="true">{plan.done}/{plan.total}</span>{current && <span className="bg-tasks-current" aria-hidden="true">{current}</span>}</>}
      {plan && tasksShown && count > 0 && <span className="bg-tasks-sep" aria-hidden="true" />}
      {(!plan || count > 0) && tasksShown && <><Layers aria-hidden="true" /><span className={`bg-tasks-label${plan ? " is-secondary" : ""}`}>{tasksLabel}</span>{count > 0 && <span className="bg-tasks-count" aria-hidden="true">{count}</span>}</>}
    </button>
    {open && <div id={id} ref={menu} className="menu bg-tasks-menu" role="dialog" aria-live="off" aria-label={planShown && tasksShown ? t("Plan and background tasks") : planShown ? t("Plan") : t("Background tasks")}>
      {planShown && <>
        <div className="menu-heading">{t("Plan")}{plan && <span className="bg-plan-progress">{t("{done} of {total} done", { done: plan.done, total: plan.total })}</span>}</div>
        {steps === undefined && !planFailed && <p className="bg-tasks-note">{t("Reading the plan…")}</p>}
        {steps === null && <p className="bg-tasks-note">{t("This session keeps no plan right now")}</p>}
        {planFailed && <p className="bg-tasks-note" role="status">{t("Couldn't read the plan. Trying again…")}</p>}
        {steps && steps.length > 0 && <ol className="bg-task-list">{planWaves(steps).flat().map(stepRow)}</ol>}
      </>}
      {planShown && tasksShown && <div className="menu-heading bg-tasks-heading">{t("Background tasks")}</div>}
      {tasksShown && <>
      {tasks === null && !failed && <p className="bg-tasks-note">{t("Loading…")}</p>}
      {failed && tasks === null && <p className="bg-tasks-note">{t("Couldn't load the background tasks")}</p>}
      {failed && tasks !== null && <p className="bg-tasks-note" role="status">{t("Couldn't refresh: this is the list as it last read")}</p>}
      {tasks !== null && tasks.length === 0 && runs.length === 0 && <p className="bg-tasks-note">{t("No background tasks to show yet")}</p>}
      {tasks !== null && !failed && count === 0 && running.length === 0 && goingRuns.length === 0 && summary.ended > 0 && <p className="bg-tasks-note">{t("Nothing running right now")}</p>}
      {goingRuns.length > 0 && <><div className="menu-heading">{t("Workflows")}</div><ul className="bg-task-list">{goingRuns.map(runView)}</ul></>}
      {running.length > 0 && <><div className="menu-heading">{t("Running")}</div><ul className="bg-task-list">{running.map(row)}</ul></>}
      {running.length > 0 && moreRunning > 0 && <p className="bg-tasks-note">{t("{n} more running", { n: moreRunning })}</p>}
      {summary.ended > 0 && <>
        <button type="button" className="bg-ended-toggle" aria-expanded={showEnded} aria-controls={endedId} onClick={() => setShowEnded(!showEnded)}>
          {showEnded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          <span>{t("{n} recently ended", { n: summary.ended })}</span>
          {summary.failed > 0 && <span className="bg-ended-failed">{t("{n} failed", { n: summary.failed })}</span>}
        </button>
        <ul id={endedId} className="bg-task-list" hidden={!showEnded}>{endedRuns.map(runView)}{ended.map(row)}</ul>
      </>}
      </>}
    </div>}
    {detail !== null && <BackgroundAgentDetail key={`${machineId}\0${paneId}\0${detail.id}`} paneId={paneId} task={detail} onClose={closeDetail} />}
  </span>;
}
