/**
 * The acts the recovery socket answers (docs/account.md, "Recovery at the PC"). Each request is parsed by the shared
 * contract; this PC's user, not the request, is named in the journal. Removing keys, lifting blocks and admitting keys
 * come with the device and log changes they need.
 */
import { AccountDevicesApiError, parseRecoveryAction, type RecoveryAction, type RecoveryStanding } from "../../shared/account-devices-api.ts";
import type { DeviceMatch } from "../devices.ts";
import { AlreadyReleasedError, ReleaseJournalError, releaseRefusal, type RecoveryReleases } from "./recovery.ts";

/** What this PC does for the acts beyond release and undo (Track A's devices.ts and safety-log.ts). */
export interface RecoverySeams {
  pendingList(): { id: string; label: string; fingerprint: string }[];
  standing(): readonly RecoveryStanding[];
  /**
   * Admits the waiting redemption `id` when `fingerprint` is its key's, through its own pairing (so its session is let
   * in too), with origin recover. A standing block or freeze targeting the key leaves the redemption waiting.
   */
  admitPending(id: string, fingerprint: string): DeviceMatch | null | "unknown" | "mismatch" | { readonly refused: string };
  /** `user`: this PC's OS user, for the journal (P24) */
  removeKey(input: { target: string; by: "local"; user: string }): { removed: string[] } | { refused: string };
  appendLift(id: string, forget: boolean, user: string): { readonly outcome: string; readonly journalWarning?: string };
  revokeAll(user: string): string[];
}

const UNREADABLE = { error: "This PC cannot read its safety log, so nothing is changed: log_unreadable" };

export function recoveryActs(options: { releases: RecoveryReleases; logReadable(act: RecoveryAction["act"]): boolean; user: string; seams?: RecoverySeams }): (request: unknown) => Promise<unknown> {
  const { releases } = options;
  return async (request) => {
    let action;
    try { action = parseRecoveryAction(request); }
    catch (error) {
      if (error instanceof AccountDevicesApiError) return { error: error.message };
      throw error;
    }
    const pc = { logReadable: options.logReadable(action.act) };
    // Read the log for each request (S19), before any write can inspect or change its targets.
    if (action.act !== "list" && !pc.logReadable) {
      return action.act === "release" ? { error: `${action.rows[0]} cannot be released: log_unreadable` } : UNREADABLE;
    }
    switch (action.act) {
      case "list":
        return {
          rows: releases.candidates().filter((row) => row.waiting !== null).map((row) => ({
            id: row.id, label: row.label, origin: row.origin, waiting: row.waiting, last_seen_at: row.lastSeenAt, refusal: releaseRefusal(row, pc),
          })),
          ...(options.seams ? { pending: options.seams.pendingList(), standing: pc.logReadable ? options.seams.standing() : [] } : {}),
        };
      case "release": {
        const candidates = releases.candidates();
        const chosen = [];
        for (const id of action.rows) {
          const row = candidates.find((candidate) => candidate.id === id);
          if (row === undefined || row.waiting === null) return { error: `${id} does not wait here` };
          const refusal = releaseRefusal(row, pc);
          if (refusal !== null) return { error: `${id} cannot be released: ${refusal}` };
          chosen.push(row);
        }
        try { releases.release(chosen, options.user); }
        catch (error) {
          if (error instanceof ReleaseJournalError || error instanceof AlreadyReleasedError) return { error: error.message };
          throw error;
        }
        return { released: chosen.map((row) => row.id) };
      }
      case "undo": {
        const undone = releases.undo(action.rows ?? undefined, options.user);
        return { releases: undone.releases, ...(undone.journalError === null ? {} : { warning: `The undo was not journalled: ${undone.journalError.message}` }) };
      }
      case "admit": case "remove": case "lift": case "revoke_all": {
        const acts = options.seams;
        if (acts === undefined) return { error: `${action.act} is not available on this PC yet` };
        if (action.act === "revoke_all") return { revoked: acts.revokeAll(options.user).length };
        if (action.act === "remove") {
          const removed: string[] = [];
          for (const target of action.targets) {
            const done = acts.removeKey({ target, by: "local", user: options.user });
            if ("refused" in done) return { error: `${target} was not removed: ${done.refused}`, removed };
            removed.push(...done.removed);
          }
          return { removed };
        }
        if (action.act === "lift") {
          const lifted: string[] = [];
          for (const id of action.blocks) {
            const done = acts.appendLift(id, false, options.user);
            if (done.outcome !== "applied" && done.outcome !== "already_applied") return { lifted, error: `${id} was not lifted: ${done.outcome}` };
            lifted.push(id);
            if (done.journalWarning !== undefined) return { lifted, error: `${id} was lifted, but could not be journalled: ${done.journalWarning}` };
          }
          return { lifted };
        }
        const admitted = acts.admitPending(action.pending, action.fingerprint);
        if (admitted === "unknown") return { error: "No such device waits here" };
        if (admitted === "mismatch") return { error: "The fingerprint does not match the waiting device" };
        if (admitted === null) return { error: "This PC refused to admit the key (locked, frozen, or its log cannot be read)" };
        return "refused" in admitted ? { error: admitted.refused } : { admitted: admitted.id };
      }
    }
  };
}
