import type { SessionSnapshot } from "../shared/protocol.ts";

const MAX_ENDED = 64;

export class FinishEpochLedger {
  private held = new Map<string, string | undefined>();
  private endedRuns = new Map<string, boolean>();

  constructor(snapshot?: SessionSnapshot | null) {
    this.hold(snapshot?.finish_epoch);
  }

  hold(epoch: string | undefined, server?: string): void {
    if (!epoch) return;
    this.held.set(epoch, server ?? this.held.get(epoch));
    if (this.endedRuns.get(epoch) === false) this.endedRuns.delete(epoch);
  }

  settle(snapshot: SessionSnapshot): void {
    const epoch = snapshot.finish_epoch;
    if (!epoch) return;
    const server = snapshot.order_epoch;
    for (const [held, from] of this.held) if (held !== epoch) this.end(held, server !== undefined && from === server);
    this.held = new Map([[epoch, server]]);
    this.endedRuns.delete(epoch);
  }

  stale(epoch: string | undefined): boolean {
    return epoch !== undefined && this.endedRuns.get(epoch) === true;
  }

  ended(epoch: string): boolean {
    return this.endedRuns.has(epoch);
  }

  copy(): FinishEpochLedger {
    const copy = new FinishEpochLedger();
    copy.held = new Map(this.held);
    copy.endedRuns = new Map(this.endedRuns);
    return copy;
  }

  private end(epoch: string, own: boolean): void {
    const before = this.endedRuns.get(epoch) === true;
    this.endedRuns.delete(epoch);
    this.endedRuns.set(epoch, own || before);
    for (const old of this.endedRuns.keys()) {
      if (this.endedRuns.size <= MAX_ENDED) break;
      this.endedRuns.delete(old);
    }
  }
}
