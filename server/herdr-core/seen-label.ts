import type { HcConnection } from "./connection.ts";
import { SEEN_LABEL, seenTurnOf } from "./snapshot.ts";

type Hc = Pick<HcConnection, "call">;

/**
 * Tells every Herdr client that a person looked at a terminal's agent (herdr-app docs/labels.md):
 * `herdr.seen` becomes the terminal's turn, so a finish read in Ovis is read in the Herdr app too.
 * Written only to raise it, or where it is missing so a terminal started elsewhere joins, and once
 * per turn: a pane left on screen does not overrule a "mark unread" from another client. A turn
 * another client marked seen first counts as written. `again` (a person brought the pane into view)
 * writes a turn already written: coming back to it raises it again. One terminal's writes go in
 * order, so an earlier turn never lands after a later one.
 */
export class SeenMarker {
  /** the turn this server last wrote on each terminal */
  private readonly written = new Map<string, number>();
  private readonly turns = new Map<string, Promise<void>>();

  constructor(private readonly hc: Hc) {}

  /**
   * A terminal's turn and labels as the server learned them (adapter.ts events): a turn some client
   * marked seen counts as written, so a "mark unread" while the pane stays on screen here stands even
   * when Ovis was never told of a look at that turn (it was idle in front of the person).
   */
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
      // seen here and already marked elsewhere: an unread from another client later still stands
      this.observe(address, turn, record.labels ?? {});
      return;
    }
    await this.hc.call("terminal.label", { terminal: address, labels: { [SEEN_LABEL]: String(turn) } });
    this.written.set(address, turn);
  }
}
