import type { StoredDevice } from "../devices.ts";
import type { JournalEntry } from "./device-journal.ts";
import { JOIN_HOLD_MS, holdSecondsLeft, mayEndHold, type Sayer } from "./join-hold.ts";

/** The notice ID survives on the member row. Deadlines deliberately belong to this running process only. */
export class PromotedHolds {
  private readonly deadlines = new Map<string, number>();

  constructor(private readonly admits: (key: string) => boolean, private readonly release: (row: StoredDevice) => void) {}

  carry(notice: string, until: string | null): void {
    if (until !== null) this.deadlines.set(notice, Date.parse(until));
  }

  /** Called only at a whole read's commit, after its denials. Further reads leave running clocks alone. */
  resume(rows: readonly StoredDevice[], now: number): void {
    for (const row of rows) {
      if (row.held && !this.deadlines.has(row.held) && row.relay_public_key && this.admits(row.relay_public_key)) this.deadlines.set(row.held, now + JOIN_HOLD_MS);
    }
  }

  /** Compare standing against the original admission, not the newer promotion. */
  mayConfirm(row: StoredDevice, notice: JournalEntry, approval: { readonly sayer: Sayer; readonly accountNo: number | null; readonly now: number }): boolean {
    if (notice.how !== "list" || !notice.key || row.relay_public_key !== notice.key) return false;
    if (row.held ? row.held !== notice.id || !this.deadlines.has(row.held) : row.id !== notice.row || row.origin?.how !== "promoted") return false;
    return this.admits(notice.key) && mayEndHold(approval.sayer, { key: notice.key, no: approval.accountNo, admitNo: notice.no }, approval.now);
  }

  forget(notice: string): void { this.deadlines.delete(notice); }

  refusal(row: StoredDevice, now: number) {
    if ((row.held || row.carried_notice) && row.origin?.from === "pc" && ["code", "digits", "qr", "confirmed"].includes(row.origin.how)) {
      this.release(row);
      return null;
    }
    if (!row.held) return null;
    const until = this.deadlines.get(row.held) ?? null;
    const seconds = holdSecondsLeft(until, now);
    if (seconds !== 0) return { refused: { refused: "join_hold" as const, seconds }, holdUntil: until === null ? null : new Date(until).toISOString() };
    if (!row.relay_public_key || !this.admits(row.relay_public_key)) return { refused: { refused: "admission" as const }, holdUntil: null };
    this.release(row);
    return null;
  }
}
