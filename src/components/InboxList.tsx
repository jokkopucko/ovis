import { tally, usageCounters } from "../lib/usageCounters.ts";
import { useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from "react";
import { Ellipsis, ListFilter, Monitor, Plus, Search, Terminal, TriangleAlert, X } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import { heldOrder, INBOX_FILTERS, inboxEmpty, inboxFiltered, inboxKey, inboxOrder, inboxSearched, inboxSinceAt, inboxStatus, inboxWords, plainWords, type InboxFilter } from "../lib/agentInbox.ts";
import { agentGroup, type AgentRow } from "../lib/agentRoster.ts";
import { stateSince } from "../lib/agentStateSince.ts";
import type { HeaderConnection } from "../lib/headerConnection.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { inboxAsks, inboxRowLine, inboxStateWord } from "../lib/inboxRow.ts";
import { PanePressContext } from "../lib/paneSubmitContext.ts";
import { agentName } from "../lib/runtimeMove.ts";
import { useSettings } from "../lib/settings.ts";
import { knownStatus } from "../lib/status.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { SHEET_QUERY } from "../lib/sheets.ts";
import type { SidebarActivity } from "../lib/sidebarActivity.tsx";
import { agentContext, agentTabName, paneMark } from "../lib/sidebarAgents.ts";
import { useAgentStateStamps } from "../lib/useAgentStateSince.ts";
import type { InboxListHandle } from "../lib/useInbox.ts";
import { questionTargets, useInboxQuestions, type QuestionReads } from "../lib/useInboxQuestions.ts";
import { summaryTargets, useInboxSummaries, type RowSummary, type SummaryReads } from "../lib/useInboxSummaries.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { AgentMark } from "./AgentMark.tsx";
import { agentRowTitle, blockedNote, stateAge } from "./AgentSidebar.tsx";
import { RowMenu } from "./RowMenu.tsx";
import { compactWorktreeName, StatusBadge } from "./Sidebar.tsx";
import "./InboxList.css";

export interface InboxMore {
  label: string;
  expanded: boolean;
  popup: "menu" | "dialog";
  onPress(anchor: HTMLElement): void;
}

export interface InboxListProps {
  ref?: Ref<InboxListHandle>;
  machines: Machine[];
  activity: SidebarActivity;
  /** this device only watches: it is offered no New workspace */
  watching: boolean;
  wide: boolean;
  filter: InboxFilter;
  onFilter(filter: InboxFilter): void;
  query: string;
  onQuery(query: string): void;
  scroll: RefObject<number>;
  focus: { opening: number; taken: RefObject<number>; row?: string | null };
  current?: string | null;
  onOpen(machineId: string, paneId: string): void;
  onNew(machineId: string): void;
  questionReads: QuestionReads;
  summaryReads: SummaryReads;
  more?: InboxMore;
  note?: ReactNode;
  connection?: HeaderConnection;
  failure?: { error: string; retry(): Promise<void> | void } | null;
}

const TILE_MARKS = new Set(["claude", "omp", "omo"]);
const PRESS_HOLD_MS = 1000;
const CLOCK_MS = 30_000;

function lastWords(summary: RowSummary | undefined, t: Translate): string | null {
  if (summary === undefined) return null;
  const text = plainWords(summary.text);
  if (text === null) return null;
  return summary.role === "user" ? t("You: {text}", { text }) : text;
}

export function InboxAvatar({ mark }: { mark: string | null }) {
  const tile = mark !== null && TILE_MARKS.has(mark);
  return (
    <span className={`inbox-avatar${tile ? " is-tile" : ""}`} aria-hidden="true">
      <span className="inbox-avatar-face">{mark === null ? <Terminal /> : <AgentMark agent={mark} size={32} />}</span>
    </span>
  );
}

export function InboxList({ ref, machines, activity, watching, wide, filter, onFilter, query, onQuery, scroll, focus, current = null, onOpen, onNew, questionReads, summaryReads, more, note, connection = null, failure = null }: InboxListProps) {
  const t = useT();
  const pressPane = useContext(PanePressContext);
  const root = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const searchToggle = useRef<HTMLButtonElement>(null);
  const { settings, resolvedLanguage } = useSettings();
  const popup = useMediaQuery(SHEET_QUERY) ? "dialog" : "menu";
  const { agentGroupSort: sort, sidebarRows, statusIndicators } = settings;
  const all = useMemo(() => inboxOrder(machines, activity, { sort, name: (row) => agentRowTitle(row, sidebarRows === "one").drawn }), [machines, activity, sort, sidebarRows]);
  const questions = useInboxQuestions(questionReads, questionTargets(all, activity));
  const summaries = useInboxSummaries(summaryReads, summaryTargets(all, activity));
  const stamps = useAgentStateStamps();
  const [tick, setTick] = useState(0);
  const wordsOf = (row: AgentRow): string | null => {
    const online = row.machine.state === "connected";
    const key = inboxKey(row);
    return inboxWords({
      group: agentGroup(inboxStatus(row, activity)), blocked: online ? blockedNote(row.entry.pane, t) : null,
      question: questions.get(key) ?? null, plan: online ? row.entry.pane.plan : undefined, last: lastWords(summaries.get(key), t),
    });
  };
  const found = inboxSearched(inboxFiltered(all, filter, activity), query, machines, t, wordsOf);

  // a state change never moves a row under a finger or the keyboard's focus (AgentSidebar.tsx): while either is in
  // the list, rows keep the order last drawn; the reader's own doing (a filter, a query) draws them as they are at
  // once. Only a focus drawn with its ring holds them: the one this list gives a row after a thread's Back is no
  // one's place on a touch screen, and held there it would keep a new question from rising to the top
  const [focusIn, setFocusIn] = useState(false);
  const [pressHeld, setPressHeld] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdAfterPress = (): void => {
    if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    setPressHeld(true);
    pressTimer.current = setTimeout(() => { pressTimer.current = null; setPressHeld(false); }, PRESS_HOLD_MS);
  };
  useEffect(() => () => { if (pressTimer.current !== null) clearTimeout(pressTimer.current); }, []);
  const readerKey = `${filter}\n${query}`;
  const kept = useRef<{ readerKey: string; order: readonly string[] } | null>(null);
  const holding = (focusIn || pressHeld) && kept.current?.readerKey === readerKey;
  const shown = holding ? heldOrder(found, inboxKey, kept.current?.order ?? []) : found;
  useEffect(() => {
    if (!holding) kept.current = { readerKey, order: shown.map(inboxKey) };
  });

  const restoring = useRef<number | null>(scroll.current);
  const stopRestoring = (): void => { restoring.current = null; };
  useImperativeHandle(ref, () => ({
    toTop() {
      restoring.current = null;
      if (scroller.current !== null) scroller.current.scrollTop = 0;
      scroll.current = 0;
      root.current?.focus({ preventScroll: true });
    },
  }), [scroll]);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node === null || restoring.current === null) return;
    node.scrollTop = restoring.current;
    if (node.scrollTop === restoring.current) restoring.current = null;
  }, [questions, summaries]);
  const { opening, taken, row: returnTo = null } = focus;
  const rowNodes = useRef(new Map<string, HTMLButtonElement>());
  useLayoutEffect(() => {
    if (taken.current === opening) return;
    taken.current = opening;
    ((returnTo === null ? undefined : rowNodes.current.get(returnTo)) ?? root.current)?.focus({ preventScroll: true });
  }, [opening, taken]);

  const [pcMenu, setPcMenu] = useState<HTMLElement | null>(null);
  const [filterMenu, setFilterMenu] = useState<HTMLElement | null>(null);
  const [searchAsked, setSearchAsked] = useState(false);
  const searchOpen = !wide || searchAsked || query !== "";
  useLayoutEffect(() => { if (wide && searchAsked) search.current?.focus(); }, [wide, searchAsked]);

  const severalPcs = machines.length > 1;
  const rows = shown.map((row) => {
    const { machine, entry } = row;
    const { pane, workspace, tab } = entry;
    const online = machine.state === "connected";
    const status = inboxStatus(row, activity);
    const group = agentGroup(status);
    const title = agentRowTitle(row, false).title;
    const tabs = machine.snapshot?.tabs.filter((candidate) => candidate.workspace_id === workspace.workspace_id) ?? [];
    const place = agentContext({
      agentLabel: null, title, markAgent: null, machineName: null,
      workspaceLabel: workspace.worktree?.is_linked_worktree ? compactWorktreeName(workspace.label) : workspace.label,
      tabName: agentTabName(tab, tabs, t),
    }).filter((part) => part !== title).join(" · ");
    const kind = entry.canonicalAgent;
    const key = inboxKey(row);
    const summary = summaries.get(key);
    const failed = online && group === "done" && summary?.failed === true;
    const state = !online ? t("Offline") : failed ? t("Turn failed") : inboxStateWord(group, t);
    const line = inboxRowLine({ online, group, words: wordsOf(row), place, machine: severalPcs ? machine.name : null, failed }, t);
    return {
      key, machine, pane, online, status, group, title, line, failed, mark: paneMark(entry) ?? "", kind, state,
      asks: online && inboxAsks(group), since: online ? inboxSinceAt(group, summary, group === "blocked" ? stateSince(stamps, machine.id, pane.pane_id, pane.terminal_id, "blocked") : null) : null,
    };
  });
  const timed = rows.some((row) => row.since !== null);
  const timedRows = rows.flatMap((row) => row.since === null ? [] : [row.key]).join("\n");
  const now = useMemo(() => Date.now(), [tick, summaries, stamps, timedRows]);
  useEffect(() => {
    if (!timed) return;
    const timer = setInterval(() => setTick((count) => count + 1), CLOCK_MS);
    return () => clearInterval(timer);
  }, [timed]);
  const connected = machines.filter((machine) => machine.state === "connected");
  const offerNew = !watching && connected.length > 0;
  useEffect(() => { if (connected.length < 2) setPcMenu(null); }, [connected.length]);
  const emptyWhy = inboxEmpty(machines, all.length, rows.length);
  const failed = failure !== null && all.length === 0 ? failure : null;
  const [retrying, setRetrying] = useState(false);
  const retry = (): void => {
    if (retrying || failed === null) return;
    setRetrying(true);
    void Promise.resolve(failed.retry()).finally(() => setRetrying(false));
  };
  const failing = failed !== null;
  const wasFailing = useRef(failing);
  useLayoutEffect(() => {
    const was = wasFailing.current;
    wasFailing.current = failing;
    if (!was || failing) return;
    const at = document.activeElement;
    if (at === null || at === undefined || at === document.body) root.current?.focus({ preventScroll: true });
  }, [failing]);
  const empty = emptyWhy === "loading" ? [t("Loading…")]
    : emptyWhy === "none" ? (offerNew ? [t("Nothing is running yet"), t("Use + to start a workspace")] : [t("Nothing is running yet")])
    : emptyWhy === "no-match" ? [t("No results")] : null;

  const drawsMark = (status: AgentStatus | undefined): boolean => statusIndicators !== "classic" || agentGroup(status) !== "idle";
  const stateMark = (status: AgentStatus | undefined, failed: boolean, word: string) => failed ? (
    <span className="inbox-state is-drawn"><span className="badge badge-blocked sidebar-status" data-status="failed" role="status" aria-label={t("Turn failed")} title={t("Turn failed")}><TriangleAlert aria-hidden="true" /></span></span>
  ) : (
    <span className={`inbox-state${drawsMark(status) ? " is-drawn" : ""}`}><StatusBadge compact status={status} label={knownStatus(status) === "waiting" ? t("Working, waiting on background work") : word} /></span>
  );

  const closeSearch = (event: KeyboardEvent<HTMLInputElement>): void => {
    // an Escape that ends an IME's composition is the composition's
    if (event.key !== "Escape" || !wide || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    const folds = searchToggle.current !== null && searchToggle.current.getClientRects().length > 0;
    if (query !== "") { onQuery(""); if (folds) setSearchAsked(true); }
    else if (folds) { setSearchAsked(false); searchToggle.current?.focus(); }
  };
  const searchLabel = wide ? t("Search agents") : t("Search");
  const searchField = (searchOpen || wide) && (
    <div className="inbox-search" role="search">
      {!wide && <Search className="inbox-search-glass" aria-hidden="true" />}
      <input ref={search} className="input inbox-search-input" type="search" value={query} placeholder={searchLabel} aria-label={searchLabel}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} enterKeyHint="search" onChange={(event) => {
          const value = event.currentTarget.value;
          if (query === "" && value !== "") tally(() => usageCounters.count("inbox_search"));
          onQuery(value);
        }} onKeyDown={closeSearch} />
      {query !== "" && <button type="button" className="inbox-search-clear" aria-label={t("Clear search")} onClick={() => { onQuery(""); search.current?.focus(); }}><X aria-hidden="true" /></button>}
    </div>
  );
  const newButton = offerNew && (
    <button type="button" className="icon-button inbox-round inbox-add" aria-label={t("New workspace")} title={t("New workspace")}
      aria-haspopup={connected.length > 1 ? popup : undefined} aria-expanded={connected.length > 1 ? pcMenu !== null : undefined}
      onClick={(event) => {
        if (connected.length === 1) { tally(() => usageCounters.count("new_workspace_by_button")); onNew(connected[0]!.id); }
        else setPcMenu(pcMenu === null ? event.currentTarget : null);
      }}>
      <Plus aria-hidden="true" />
    </button>
  );
  const filterWord = (value: InboxFilter): string => value === "all" ? t("All") : inboxStateWord(value, t);
  const filterLabel = filter === "all" ? t("Filter by state") : t("Filter by state: {state}", { state: filterWord(filter) });
  const filterButton = (
    <button type="button" className={`icon-button inbox-round inbox-filter-toggle${filter === "all" ? "" : " is-on"}`} aria-label={filterLabel} title={filterLabel}
      aria-haspopup={popup} aria-expanded={filterMenu !== null} onClick={(event) => { if (filterMenu === null) tally(() => usageCounters.count("inbox_filter")); setFilterMenu(filterMenu === null ? event.currentTarget : null); }}>
      <ListFilter aria-hidden="true" />
    </button>
  );
  const connectionWord = useAnnouncedText(connection === null ? null : t(connection === "connected" ? "Connected" : "Reconnecting…"));
  const connectionLine = <p className={connectionWord === null ? "visually-hidden" : "inbox-connection"} role="status">{connectionWord}</p>;
  const moreButton = more && (
    <button type="button" className="icon-button inbox-round inbox-more" aria-label={more.label} title={more.label}
      aria-haspopup={more.popup} aria-expanded={more.expanded} onClick={(event) => more.onPress(event.currentTarget)}>
      <Ellipsis aria-hidden="true" />
    </button>
  );

  return (
    <section className={`mode-inbox${wide ? " is-wide" : ""}`} aria-label={t("Agent inbox")} tabIndex={-1} ref={root}
      onWheel={stopRestoring} onTouchStart={stopRestoring} onPointerDown={stopRestoring} onKeyDown={stopRestoring}>
      <div className={`inbox-top${wide && searchOpen ? " is-search-open" : ""}`}>
        {wide ? <>
          {searchField}
          <button type="button" ref={searchToggle} className="icon-button inbox-round inbox-search-toggle" aria-label={searchLabel} title={searchLabel} aria-expanded={searchOpen}
            onClick={() => { if (!searchOpen) setSearchAsked(true); else if (query === "") setSearchAsked(false); else search.current?.focus(); }}>
            <Search aria-hidden="true" />
          </button>
          {filterButton}
          {newButton}
        </> : <>
          {moreButton}
          {note}
          {connectionLine}
          {newButton}
        </>}
      </div>
      <div className="inbox-scroll" ref={scroller} onScroll={(event) => { if (restoring.current === null) scroll.current = event.currentTarget.scrollTop; }}>
        {failed !== null ? (
          <div className="inbox-failed">
            {retrying ? (
              <div key="loading" className="inbox-failed-words is-loading" role="status">
                <p className="inbox-failed-line">{t("Loading…")}</p>
                {failed.error !== "" && <p className="inbox-failed-cause" dir="auto" aria-hidden="true">{failed.error}</p>}
              </div>
            ) : (
              <div key="failed" className="inbox-failed-words" role="alert">
                <p className="inbox-failed-line">{t("Couldn't load the list.")}</p>
                {failed.error !== "" && <p className="inbox-failed-cause" dir="auto">{failed.error}</p>}
              </div>
            )}
            {/* aria-disabled, not disabled: a press keeps the focus it had */}
            <button type="button" className="btn inbox-retry" aria-disabled={retrying || undefined} aria-busy={retrying || undefined} onClick={retry}>
              <span className="inbox-retry-words">
                <span aria-hidden={retrying || undefined}>{t("Retry")}</span>
                <span aria-hidden={!retrying || undefined}>{t("Retrying…")}</span>
              </span>
            </button>
          </div>
        ) : empty !== null ? <p className="inbox-empty" role="status">{empty.flatMap((line, at) => [...(at > 0 ? [" "] : []), <span key={line}>{line}</span>])}</p> : (
          <ul className="inbox-rows" onPointerDown={holdAfterPress} onTouchEnd={holdAfterPress}
            onFocus={(event) => setFocusIn(event.target.matches(":focus-visible"))} onBlur={(event) => { if (!(typeof Node === "function" && event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setFocusIn(false); }}>
            {rows.map((row) => {
              const open = wide && row.key === current;
              const words = <span className="inbox-words" dir="auto">{row.line}</span>;
              const age = row.since === null ? null : stateAge(now - row.since);
              const at = row.since === null ? null : new Date(row.since);
              const spoken = [row.kind ? agentName(row.kind) : null, row.title, row.state, row.line === row.state ? null : row.line, age].filter((part) => part !== null).join(", ");
              return (
                <li key={row.key} className={`inbox-item${row.online ? "" : " is-offline"}${row.asks ? " is-asking" : ""}${open ? " is-current" : ""}`} data-machine={row.machine.id} data-pane={row.pane.pane_id} data-state={row.group}>
                  <button type="button" className="inbox-row" disabled={!row.online} aria-label={spoken} aria-current={open ? "true" : undefined}
                    ref={(node) => { if (node) rowNodes.current.set(row.key, node); else rowNodes.current.delete(row.key); }}
                    title={wide ? [row.title, row.line, at === null ? null : `${age} · ${at.toLocaleString(resolvedLanguage)}`].filter((part) => part !== null).join("\n") : undefined}
                    onPointerDown={(event) => { if (event.button === 0 && row.online) pressPane?.(row.machine.id, row.pane.pane_id); }}
                    onClick={() => { tally(() => usageCounters.paneUse("inbox_open", row.machine.id)); onOpen(row.machine.id, row.pane.pane_id); }}>
                    <InboxAvatar mark={row.mark} />
                    <span className="inbox-body">
                      <span className="inbox-line">
                        <span className="inbox-name">{row.title}</span>
                        {!wide && at !== null && <time className="inbox-time" dateTime={at.toISOString()} title={at.toLocaleString(resolvedLanguage)}>{age}</time>}
                      </span>
                      {wide ? words : <span className="inbox-sub">{words}{stateMark(row.status, row.failed, row.state)}</span>}
                    </span>
                    {wide && stateMark(row.status, row.failed, row.state)}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {!wide && <div className="inbox-foot">
        {filterButton}
        {searchField}
      </div>}
      {pcMenu !== null && !watching && connected.length > 1 && <RowMenu anchor={pcMenu} title={t("New workspace")} onClose={() => setPcMenu(null)}
        items={connected.map((machine) => ({ id: machine.id, label: machine.name, icon: Monitor, run: () => { tally(() => usageCounters.count("new_workspace_by_button")); onNew(machine.id); } }))} />}
      {filterMenu !== null && <RowMenu anchor={filterMenu} title={t("Filter by state")} choice onClose={() => setFilterMenu(null)}
        items={INBOX_FILTERS.map((value) => ({
          id: value, label: filterWord(value), icon: ListFilter, checked: filter === value, run: () => onFilter(value),
          ...(value === "all" ? {} : { glyph: <span className="inbox-filter-mark" aria-hidden="true"><StatusBadge compact status={value} label={filterWord(value)} /></span> }),
        }))} />}
    </section>
  );
}
