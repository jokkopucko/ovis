import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AccountRecordError, isDeviceSafetyRecord, parseSafetyRecord, verifySafetyRecord, type DeviceLiftRecord } from "../../shared/account-records.ts";
import type { DeviceStore } from "../devices.ts";
import { writePrivateState } from "../private-state.ts";
import type { RecordOutcome } from "./records.ts";
import { WAITING_MAX, type SafetyLog } from "./safety-log.ts";

/** A hand-delivered lift is a hint to read, never authority to thaw. */
export class HandedLifts {
  private readonly path: string;
  constructor(stateDir: string) { this.path = join(stateDir, "account-handed-lifts.json"); }

  /** Missing means empty; an unreadable or malformed queue is never overwritten. */
  pending(): readonly DeviceLiftRecord[] | null {
    try {
      const values: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!Array.isArray(values) || values.length > WAITING_MAX) return null;
      const lifts = new Map<string, DeviceLiftRecord>();
      for (const value of values) {
        const record = parseSafetyRecord(value);
        if (!isDeviceSafetyRecord(record) || record.kind !== "lift" || lifts.has(record.id)) return null;
        lifts.set(record.id, record);
      }
      return [...lifts.values()];
    } catch (error) {
      if (error instanceof Error && "code" in error) return error.code === "ENOENT" ? [] : null;
      if (error instanceof SyntaxError || error instanceof AccountRecordError) return null;
      throw error;
    }
  }

  async receive(value: unknown, store: DeviceStore, log: SafetyLog): Promise<RecordOutcome> {
    let lift;
    try { lift = parseSafetyRecord(value); } catch (error) {
      if (error instanceof AccountRecordError) return { id: null, outcome: "refused", code: "record_invalid" };
      throw error;
    }
    const { id } = lift;
    if (!isDeviceSafetyRecord(lift) || lift.kind !== "lift") return { id, outcome: "refused", code: "record_invalid" };
    if (lift.account !== store.account()) return { id, outcome: "refused", code: "account_mismatch" };
    if (!await verifySafetyRecord(lift)) return { id, outcome: "refused", code: "signature_invalid" };
    if (lift.account !== store.account()) return { id, outcome: "refused", code: "account_mismatch" };
    if (log.receipt(id)) return { id, outcome: "unchanged" };
    const pending = this.pending();
    if (log.strict !== null || pending === null) return { id, outcome: "refused", code: "account_unavailable" };
    const held = pending.find((record) => record.id === id);
    if (held) return { id, outcome: "refused", code: held.signature === lift.signature ? "read_pending" : "account_unavailable" };
    if (pending.length >= WAITING_MAX) return { id, outcome: "refused", code: "account_unavailable" };
    try { writePrivateState(this.path, [...pending, lift]); } catch (error) {
      if (error instanceof Error) return { id, outcome: "refused", code: "account_unavailable" };
      throw error;
    }
    return { id, outcome: "refused", code: "read_pending" };
  }

  /** Only retire exact records listed in the committed snapshot, whether accepted or denied. */
  decide(listed: readonly DeviceLiftRecord[]): void {
    if (listed.length === 0) return;
    const pending = this.pending();
    if (pending === null) return;
    const decisions = new Map(listed.map(({ id, signature }) => [id, signature]));
    const remaining = pending.filter(({ id, signature }) => decisions.get(id) !== signature);
    if (remaining.length !== pending.length) writePrivateState(this.path, remaining);
  }
}
