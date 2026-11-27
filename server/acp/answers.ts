import type { AcpApproval } from "./messages.ts";

export type AnswerOutcome = "won" | "lost" | "gone";

interface Reservation {
  readonly optionId: string | null;
  by: string | null;
  finish(outcome: AnswerOutcome): void;
}

/** One local sender per open card, including the time spent waiting for replay. */
export class KeeperAnswers {
  private readonly resolved = new Set<string>();
  private readonly reservations = new Map<string, Reservation>();

  answer(
    request: { id: string; optionId: string; asked: AcpApproval | undefined },
    subscribe: (send: () => void) => () => void,
    send: (asked: AcpApproval, reservation: Reservation) => void,
  ): Promise<AnswerOutcome> {
    const { id, asked, optionId } = request;
    if (!asked?.options.some((option) => option.optionId === optionId)) return Promise.resolve(this.resolved.has(id) ? "lost" : "gone");
    return this.reserve({ id, optionId }, subscribe, reservation => send(asked, reservation));
  }

  reserve(
    { id, optionId }: { id: string; optionId: string | null },
    subscribe: (send: () => void) => () => void,
    send: (reservation: Reservation) => void,
  ): Promise<AnswerOutcome> {
    if (this.resolved.has(id) || this.reservations.has(id)) return Promise.resolve("lost");
    const { promise, resolve } = Promise.withResolvers<AnswerOutcome>();
    const dispatch = () => { if (reservation.by === null) send(reservation); };
    const off = subscribe(dispatch);
    const timer = setTimeout(() => this.settle(id, "gone"), 10_000);
    const reservation: Reservation = {
      by: null, optionId, finish(outcome) { off(); clearTimeout(timer); resolve(outcome); },
    };
    this.reservations.set(id, reservation);
    dispatch();
    return promise;
  }

  acknowledge(id: string, by: string | null, optionId: string | null): void {
    const waiting = this.reservations.get(id);
    this.resolved.add(id);
    this.settle(id, waiting && by !== null && waiting.by === by && waiting.optionId === optionId ? "won" : "lost");
  }

  /** `answering`: the keeper dropped it because another client's answer is on its way to the agent. */
  dropped(id: string, by: string | null, answering: boolean): void {
    if (by !== null && this.reservations.get(id)?.by === by) this.settle(id, this.resolved.has(id) || answering ? "lost" : "gone");
  }

  settle(id: string, outcome: AnswerOutcome): void {
    const waiting = this.reservations.get(id);
    if (!waiting) return;
    this.reservations.delete(id);
    waiting.finish(outcome);
  }

  close(): void {
    for (const id of this.reservations.keys()) this.settle(id, "gone");
  }
}
