/**
 * What each waiting agent of the inbox asks (components/InboxList.tsx): its prompt card read once per
 * wait and each time the list is shown, through the read-only GET /api/pane/prompt, a few at a time.
 * Nothing is answered from here.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { InteractivePrompt } from "../../shared/protocol.ts";
import { inboxKey, inboxStatus, questionWords } from "./agentInbox.ts";
import { agentGroup, type AgentRow } from "./agentRoster.ts";
import { fetchPanePromptState } from "./api.ts";
import { translate, type Language } from "./i18n.ts";
import { promptWords } from "./promptText.ts";
import { useSettings } from "./settings.ts";
import type { SidebarActivity } from "./sidebarActivity.tsx";

export const QUESTION_RETRY_MS = 1500;
export const QUESTION_READS_AT_ONCE = 2;

/**
 * A waiting row whose question is read: `seq` is its state counter, a new wait reads it again; `lifetime` is its PC's
 * herdr lifetime, as a replaced herdr can reuse a pane id and counter.
 */
export interface QuestionTarget { key: string; machineId: string; paneId: string; seq: number; lifetime: string }

export function questionTargets(rows: readonly AgentRow[], activity: SidebarActivity): QuestionTarget[] {
  return rows.flatMap((row) => {
    const pane = row.entry.pane;
    if (agentGroup(inboxStatus(row, activity)) !== "blocked" || pane.agent_kind || pane.agent_message?.trim()) return [];
    return [{
      key: inboxKey(row), machineId: row.machine.id, paneId: pane.pane_id, seq: activity.seqs(row.machine.id).get(pane.pane_id) ?? 0,
      lifetime: row.machine.snapshot?.herdr_lifetime ?? "",
    }];
  });
}

type Read = (paneId: string, machineId: string) => Promise<{ prompt: InteractivePrompt | null }>;
type Words = (prompt: InteractivePrompt, language: Language) => string;
type Wait = (run: () => void, ms: number) => () => void;

interface Ask extends QuestionTarget { language: Language }

const NO_TEXTS: ReadonlyMap<string, string> = new Map();
const waitOf = (target: QuestionTarget): string => `${target.lifetime}\n${target.seq}`;
interface ReadFor { lifetime: string; seq: number }
const sameWait = (read: ReadFor | undefined, target: QuestionTarget): boolean => read !== undefined && read.seq === target.seq
  && (read.lifetime === target.lifetime || read.lifetime === "" || target.lifetime === "");
const readOf = (ask: Ask): string => `${ask.key}\n${waitOf(ask)}\n${ask.language}`;

/**
 * Each target's question, read once per key, seq and language, at most QUESTION_READS_AT_ONCE at a time, and
 * once more each time the list is shown (`shownAgain`): a seq is no prompt's identity (a bridge without one
 * gives every wait 0, and two prompts can share a state), so the words kept from before are checked.
 */
export class QuestionReads {
  private readonly listeners = new Set<() => void>();
  private current: ReadonlyMap<string, string> = NO_TEXTS;
  private readonly readFor = new Map<string, ReadFor>();
  private targets = new Map<string, Ask>();
  private readonly started = new Set<string>();
  private readonly retried = new Set<string>();
  private readonly waits = new Map<string, () => void>();
  private readonly reading = new Set<string>();
  private readonly followUps = new Set<string>();
  private queue: Ask[] = [];
  private inFlight = 0;

  constructor(private readonly read: Read, private readonly words: Words,
    private readonly wait: Wait = (run, ms) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer); }) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  texts = (): ReadonlyMap<string, string> => this.current;

  wordsFor(target: QuestionTarget): string | undefined {
    return sameWait(this.readFor.get(target.key), target) ? this.current.get(target.key) : undefined;
  }

  shownAgain(): void {
    for (const read of this.reading) this.followUps.add(read);
    const busy = new Set([...this.reading, ...this.waits.keys(), ...this.queue.map(readOf)]);
    for (const read of [...this.started]) if (!busy.has(read)) this.started.delete(read);
    for (const read of [...this.retried]) if (!busy.has(read)) this.retried.delete(read);
  }

  sync(targets: readonly QuestionTarget[], language: Language = "en"): void {
    const asks = targets.map((target): Ask => ({ ...target, language }));
    this.targets = new Map(asks.map((ask) => [ask.key, ask]));
    const live = new Set(asks.map(readOf));
    for (const read of new Set([...this.started, ...this.retried])) {
      if (live.has(read)) continue;
      this.started.delete(read);
      this.retried.delete(read);
      this.waits.get(read)?.();
      this.waits.delete(read);
    }
    this.queue = this.queue.filter((ask) => this.isCurrent(ask));
    const stale = [...this.current.keys()].filter((key) => { const now = this.targets.get(key); return now === undefined || !sameWait(this.readFor.get(key), now); });
    if (stale.length > 0) this.change((texts) => { for (const key of stale) { texts.delete(key); this.readFor.delete(key); } });
    for (const ask of asks) {
      const read = readOf(ask);
      if (this.started.has(read)) continue;
      this.started.add(read);
      this.queue.push(ask);
    }
    this.pump();
  }

  private isCurrent(ask: Ask): boolean {
    const now = this.targets.get(ask.key);
    return now?.seq === ask.seq && now.lifetime === ask.lifetime && now.language === ask.language;
  }

  private change(edit: (texts: Map<string, string>) => void): void {
    const next = new Map(this.current);
    edit(next);
    this.current = next;
    for (const listener of [...this.listeners]) listener();
  }

  private pump(): void {
    while (this.inFlight < QUESTION_READS_AT_ONCE && this.queue.length > 0) {
      const ask = this.queue.shift()!;
      if (this.isCurrent(ask)) this.start(ask);
    }
  }

  private start(ask: Ask): void {
    this.inFlight++;
    const read = readOf(ask);
    this.reading.add(read);
    this.read(ask.paneId, ask.machineId).then(({ prompt }) => {
      this.inFlight--;
      this.reading.delete(read);
      try { this.answered(ask, prompt); } catch { this.failed(ask); }
      this.followUp(ask);
      this.pump();
    }, () => {
      this.inFlight--;
      this.reading.delete(read);
      this.failed(ask);
      this.followUp(ask);
      this.pump();
    });
  }

  private followUp(ask: Ask): void {
    const read = readOf(ask);
    if (!this.followUps.delete(read) || !this.isCurrent(ask) || this.waits.has(read)) return;
    this.retried.delete(read);
    this.queue.push(ask);
  }

  private answered(ask: Ask, prompt: InteractivePrompt | null): void {
    if (!this.isCurrent(ask)) return;
    if (prompt !== null) {
      const words = this.words(prompt, ask.language);
      this.readFor.set(ask.key, { lifetime: ask.lifetime, seq: ask.seq });
      if (this.current.get(ask.key) !== words) this.change((texts) => { texts.set(ask.key, words); });
      return;
    }
    if (!this.retry(ask) && this.current.has(ask.key)) this.change((texts) => { texts.delete(ask.key); this.readFor.delete(ask.key); });
  }

  private failed(ask: Ask): void {
    if (this.isCurrent(ask)) this.retry(ask);
  }

  private retry(ask: Ask): boolean {
    const read = readOf(ask);
    if (this.retried.has(read)) return false;
    this.retried.add(read);
    this.waits.set(read, this.wait(() => {
      this.waits.delete(read);
      if (!this.isCurrent(ask)) return;
      this.queue.push(ask);
      this.pump();
    }, QUESTION_RETRY_MS));
    return true;
  }
}

export const newQuestionReads = (wait?: Wait): QuestionReads =>
  new QuestionReads(fetchPanePromptState, (prompt, language) => questionWords(promptWords(prompt, (key, vars) => translate(language, key, vars))), wait);

export function useInboxQuestions(reads: QuestionReads, targets: readonly QuestionTarget[]): ReadonlyMap<string, string> {
  const { resolvedLanguage } = useSettings();
  const targetsRef = useRef(targets); targetsRef.current = targets;
  const signature = targets.map((target) => `${target.key}:${target.seq}:${target.lifetime}`).join("\n");
  useEffect(() => { reads.shownAgain(); }, [reads]);
  useEffect(() => { reads.sync(targetsRef.current, resolvedLanguage); }, [reads, signature, resolvedLanguage]);
  const texts = useSyncExternalStore(reads.subscribe, reads.texts, reads.texts);
  return useMemo(() => new Map(targetsRef.current.flatMap((target) => {
    const words = reads.wordsFor(target);
    return words === undefined ? [] : [[target.key, words] as const];
  })), [reads, texts, signature]);
}
