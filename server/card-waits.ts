/**
 * On herdr-core an agent's status is what it reports (OSC 7501), and some ask without saying so: Codex keeps
 * `working` while its question waits, Claude Code reports nothing at its folder-trust prompt. While the server
 * reads such an asking on a terminal's screen (prompt.ts `waitingCard`), the terminal waits for its user: blocked,
 * with the card's kind where the agent's own report gives none. Read, never guessed: only a card a reader returns
 * for that terminal counts, and a terminal no agent runs in is never read. The agent's own `blocked` stands over
 * it, kind and words included. The wait is only what is shown and alerted: what the agent reported stays what the
 * turn is counted from (server/core/status.ts).
 *
 * A wait ends when reads find no card: at the first such read after an answer from a card (`answer`), else at the
 * second in a row, so a screen caught mid-repaint does not end it and raise a second alert. A read that says
 * nothing (it raced a change, or failed) changes nothing; ten of them in a row end the wait rather than keep a
 * terminal stuck in it. A terminal whose agent is gone (it exited at its card), or whose status a tracker of its own
 * tells from now on (`owned`), ends its wait at once, and a terminal forgotten while its screen is read, or waits to
 * be (closed, or its agent gone), drops that read. The same card redrawn is the same wait. Another card in its
 * place is the next wait: the first one ends and that one begins, alerted as any other. Nothing is kept across a
 * restart of the server: a card still shown then is waited on, and alerted, once more.
 *
 * A read and a wait are one agent's (`Asker`): the screen read for Codex says nothing of the Claude Code that runs in
 * the terminal once the read comes back. So each pane is asked for anew (`Roster`) right before its read starts and
 * when it returns, and a wait whose agent is no longer the terminal's ends. A terminal that changed hands and back
 * while its screen was read looks the same before and after, so the caller counts every change of its agent or
 * session it is told (`Roster.lifetime`): a read begun under an earlier count is dropped, and a wait ends.
 *
 * An answer is one wait's: it is given the wait it began under (`generation`), and ends that wait alone at its next
 * read without a card. A form answered field by field is one wait throughout, whatever its last field's card is; a
 * new asking in the same words is another.
 */
import type { AgentStatus, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";

export type WaitingKind = "permission" | "question" | null;
/** what one read found: the agent's asking (its kind and the card's own id), none (null), or nothing to go by (undefined) */
export type CardRead = { kind: WaitingKind; id: string } | null | undefined;

/** reads in a row that find no card before a wait ends, unless an answer went to the pane */
const EMPTY_READS_END = 2;
/** reads in a row that say nothing before a wait ends */
const FAILED_READS_END = 10;
const READS_AT_ONCE = 4;

/** the agent a read or a wait is for: its name, and its session where the pane says one */
interface Asker { readonly agent: string; readonly session: string | undefined }
interface Wait { readonly kind: WaitingKind; readonly id: string; readonly generation: number; readonly lifetime: number; asker: Asker; empty: number; failed: number }
/** one pane picked for a read: whose it was, and under which count of its agents, as the tick began */
interface Picked { readonly pane: HerdrPane; readonly asker: Asker; readonly lifetime: number }
/**
 * The panes as their agents' reports and the newest snapshot make them now: all of them once a tick, and one again
 * around its own read. `lifetime`: how many times the pane's agent, or its session, was told to be another so far,
 * a change back to the one before counted too.
 */
export interface Roster { all(): HerdrPane[]; pane(paneId: string): HerdrPane | undefined; lifetime(paneId: string): number }

function askerOf(pane: Pick<HerdrPane, "agent" | "agent_session">): Asker | null {
  return pane.agent ? { agent: pane.agent, session: pane.agent_session?.agent === pane.agent ? pane.agent_session.value : undefined } : null;
}
/** another name is another agent, and so is another session of it; a session not known on one side tells nothing */
function sameAsker(one: Asker, other: Asker): boolean {
  return one.agent === other.agent && (one.session === undefined || other.session === undefined || one.session === other.session);
}

/** Whether the agent told for a pane now is not the one told before: another name, another session of it, or none any more. */
export function changedHands(before: Pick<HerdrPane, "agent" | "agent_session">, now: Pick<HerdrPane, "agent" | "agent_session">): boolean {
  const ran = askerOf(before);
  const runs = askerOf(now);
  return ran !== null && (runs === null || !sameAsker(ran, runs));
}

export class CardWaits {
  private readonly waits = new Map<string, Wait>();
  /** panes a card's answer went to since their last read that found no card */
  private readonly answered = new Set<string>();
  /** panes picked for a read under way or still queued, that still count: forgetting a pane drops its read (ticks never overlap: the caller runs one at a time) */
  private readonly reading = new Set<string>();
  private generations = 0;

  constructor(
    private readonly read: (pane: HerdrPane, panes: HerdrPane[]) => Promise<CardRead>,
    /** a wait began (true) or ended (false) */
    private readonly changed: (paneId: string, waiting: boolean) => void,
  ) {}

  waiting(paneId: string): boolean {
    return this.waits.has(paneId);
  }

  kindOf(paneId: string): WaitingKind | undefined {
    return this.waits.get(paneId)?.kind;
  }

  /** The wait the pane is in, for an answer that begins now to hand back once it was delivered (`answer`). */
  generation(paneId: string): number | undefined {
    return this.waits.get(paneId)?.generation;
  }

  /**
   * An answer begun under the wait `generation` was delivered: where that wait is still the pane's, its next read that
   * finds no card ends it. A wait begun since is another asking, whatever its card says, and is not answered by it.
   */
  answer(paneId: string, generation: number): void {
    if (this.waits.get(paneId)?.generation === generation) this.answered.add(paneId);
  }

  /** The pane is gone, or what is reported next tells its status: what it waited on goes, told to nobody. */
  forget(paneId: string): void {
    this.waits.delete(paneId);
    this.answered.delete(paneId);
    this.reading.delete(paneId);
  }

  /**
   * One read of each pane of `roster` that `reads` picks (`only`: of those panes alone), and of each pane that waits. A
   * pane no longer listed is forgotten, and a waiting pane ends its wait once no agent runs in it, another one does or
   * did since (`Roster.lifetime`), or a tracker of its own tells its status (`owned`). Such a pane is never read: not
   * when it became one while it waited its turn behind the panes read before it, and a read of it under way then
   * counts for nothing.
   */
  async tick(roster: Roster, reads: (pane: HerdrPane) => boolean, owned: (paneId: string) => boolean = () => false, only?: ReadonlySet<string>): Promise<void> {
    const panes = roster.all();
    const listed = new Set(panes.map((pane) => pane.pane_id));
    for (const paneId of [...this.waits.keys()]) if (!listed.has(paneId)) this.forget(paneId);
    for (const pane of panes) {
      const wait = this.waits.get(pane.pane_id);
      if (!wait) continue;
      const asker = askerOf(pane);
      if (asker === null || owned(pane.pane_id) || !sameAsker(wait.asker, asker) || wait.lifetime !== roster.lifetime(pane.pane_id)) this.end(pane.pane_id);
      else if (wait.asker.session === undefined) wait.asker = asker;
    }
    const candidates = panes.flatMap((pane): Picked[] => {
      const asker = askerOf(pane);
      return asker !== null && !owned(pane.pane_id) && (only === undefined || only.has(pane.pane_id)) && (this.waits.has(pane.pane_id) || reads(pane))
        ? [{ pane, asker, lifetime: roster.lifetime(pane.pane_id) }] : [];
    });
    for (const { pane } of candidates) this.reading.add(pane.pane_id);
    /** the pane is still this read's: not forgotten since it was picked, in the same lifetime, and the same agent's with no tracker of its own as it is now */
    const still = ({ pane, asker, lifetime }: Picked): boolean => {
      const current = roster.pane(pane.pane_id);
      const runs = current ? askerOf(current) : null;
      return this.reading.has(pane.pane_id) && roster.lifetime(pane.pane_id) === lifetime && runs !== null && sameAsker(asker, runs) && !owned(pane.pane_id);
    };
    for (let at = 0; at < candidates.length; at += READS_AT_ONCE) {
      const picked = candidates.slice(at, at + READS_AT_ONCE);
      const batch = picked.filter(still);
      const found = await Promise.all(batch.map(({ pane }) => this.read(pane, panes).catch((): CardRead => undefined)));
      batch.forEach((candidate, index) => { if (still(candidate)) this.settle(candidate, found[index]); });
      for (const { pane } of picked) this.reading.delete(pane.pane_id);
    }
  }

  private settle({ pane: { pane_id: paneId }, asker, lifetime }: Picked, read: CardRead): void {
    const wait = this.waits.get(paneId);
    if (read === undefined) {
      if (wait && ++wait.failed >= FAILED_READS_END) this.end(paneId);
      return;
    }
    if (read === null) {
      if (!wait) return;
      wait.failed = 0;
      if (this.answered.has(paneId) || ++wait.empty >= EMPTY_READS_END) this.end(paneId);
      return;
    }
    if (wait?.id === read.id) {
      wait.empty = 0;
      wait.failed = 0;
      return;
    }
    // another card where one was waited on (its answer brought the next asking before a read found the screen
    // without a card): that wait is over, an answer to it with it, and this card's begins
    if (wait) this.end(paneId);
    this.waits.set(paneId, { kind: read.kind, id: read.id, generation: ++this.generations, lifetime, asker, empty: 0, failed: 0 });
    this.changed(paneId, true);
  }

  private end(paneId: string): void {
    this.waits.delete(paneId);
    this.answered.delete(paneId);
    this.changed(paneId, false);
  }

  /** What a status shows as while its pane waits on a card: blocked, unless the agent said so itself. */
  status(paneId: string, reported: AgentStatus): AgentStatus {
    return this.waits.has(paneId) && reported !== "blocked" ? "blocked" : reported;
  }

  /** A snapshot with each waiting pane blocked, its card's kind where the agent's own report gives none. */
  apply(snapshot: SessionSnapshot): SessionSnapshot {
    if (this.waits.size === 0) return snapshot;
    const waiting = (pane: { pane_id: string; agent_status: AgentStatus }) => this.waits.has(pane.pane_id) && pane.agent_status !== "blocked";
    return {
      ...snapshot,
      panes: snapshot.panes.map((pane) => {
        if (!waiting(pane)) return pane;
        const kind = this.waits.get(pane.pane_id)!.kind;
        return { ...pane, agent_status: "blocked" as const, ...(kind ? { agent_kind: kind } : {}) };
      }),
      agents: snapshot.agents.map((agent) => waiting(agent) ? { ...agent, agent_status: "blocked" as const } : agent),
    };
  }
}
