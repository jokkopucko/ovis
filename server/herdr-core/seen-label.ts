import type { HcConnection } from "./connection.ts";
import { SEEN_LABEL, seenTurnOf } from "./snapshot.ts";

type Hc = Pick<HcConnection, "call">;

/**
 * Tells every Herdr client that a person looked at a terminal's agent (herdr-app docs/labels.md):
 * `herdr.seen` becomes the terminal's turn, so a finish read in Ovis is read in the Herdr app too.
 */
export class SeenMarker {
  private readonly written = new Map<string, number>();
  private readonly turns = new Map<string, Promise<void>>();

  constructor(private readonly hc: Hc) {}

  observe(address: string, turn: number, labels: Record<string, string>): void {
    const seen = seenTurnOf(labels);
    if (seen !== null && seen >= turn && turn > (this.written.get(address) ?? -1)) this.written.set(address, turn);
  }

  mark(address: string, again = false): Promise<void> {
    const run = (this.turns.get(address) ?? Promise.resolve()).then(() => this.write(address, again));
    const settled = run.catch(() => {});
    this.turns.set(address, settled);
    void settled.then(() => { if (this.turns.get(address) === settled) this.turns.delete(address); });
    return run;
  }

  private async write(address: string, again: boolean): Promise<void> {
    const record = await this.hc.call("terminal.get", { terminal: address });
    if (record.state !== "live") return;
    const turn = record.turn ?? 0;
    if (!again && turn <= (this.written.get(address) ?? -1)) return;
    const seen = seenTurnOf(record.labels);
    if (seen !== null && seen >= turn) {
      this.observe(address, turn, record.labels ?? {});
      return;
    }
    await this.hc.call("terminal.label", { terminal: address, labels: { [SEEN_LABEL]: String(turn) } });
    this.written.set(address, turn);
  }
}
