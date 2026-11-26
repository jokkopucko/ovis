/**
 * The acts the recovery socket answers (docs/account.md, "Recovery at the PC"). Each request is parsed by the shared
 * contract; this PC's user, not the request, is named in the journal. Removing keys, lifting blocks and admitting keys
 * come with the device and log changes they need.
 */
import { AccountDevicesApiError, parseRecoveryAction, type RecoveryAction, type RecoveryStanding } from "../../shared/account-devices-api.ts";
import type { AccountAddRelay } from "../../shared/machines.ts";
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
  accountStatus(): { readonly account: string | null; readonly members: number };
  restamp?(confirm: string | undefined, user: string): unknown;
}

const UNREADABLE = { error: "This PC cannot read its safety log, so nothing is changed: log_unreadable" };

/**
 * Another PC of this user adds this one to its account over SSH (docs/account.md, "Adding a PC over SSH"): it reads this
 * PC's public relay fields, then names the account; this PC takes the admission on its own proof (one-press.ts). For an
 * account that keeps a signed list it names the list and the key whose entry adds this PC too (`named`): this PC answers
 * its card for that list (`state: "waiting"`) until the list holds that entry, then joins by the list.
 */
export interface AccountAddSeams {
  inspect(): { server_id: string; public_key: string; relay: string; label: string; account: string | null } | { refused: string; code: string };
  /** in `account`, with this PC's relay turned on and as it stood when it answered */
  take(account: string, serverId: string, named?: { readonly list: string; readonly adder: string }): Promise<{ account: string; relay: AccountAddRelay; list_joined?: true } | ListTakeWaiting | { refused: string; code: string }>;
}

/** A take that named a list, while the list holds no entry that adds this PC: its card for that list, which the adding PC signs into one. */
export interface ListTakeWaiting { readonly state: "waiting"; readonly standing: string; readonly key: string; readonly enc: string; readonly card: string }

export function recoveryActs(options: { releases: RecoveryReleases; logReadable(act: RecoveryAction["act"]): boolean; user: string; seams?: RecoverySeams; accountAdd?: AccountAddSeams }): (request: unknown) => Promise<unknown> {
  const { releases } = options;
  return async (request) => {
    let action;
    try { action = parseRecoveryAction(request); }
    catch (error) {
      if (error instanceof AccountDevicesApiError) return { error: error.message };
      throw error;
    }
    if (action.act === "restamp") return options.seams?.restamp?.(action.confirm, options.user) ?? { error: "Restamp is not available on this PC." };
    const pc = { logReadable: options.logReadable(action.act) };
    // Read the log for each request (S19), before any write can inspect or change its targets.
    if (action.act !== "list" && !pc.logReadable) {
      return action.act === "release" ? { error: `${action.rows[0]} cannot be released: log_unreadable` } : UNREADABLE;
    }
    switch (action.act) {
      case "account_status":
        return options.seams?.accountStatus() ?? { error: "Account status is not available on this PC" };
      case "account_add_inspect": case "account_add_take": {
        const add = options.accountAdd;
        if (add === undefined) return { error: "Adding this PC over SSH is not available on it", code: "unavailable" };
        const done = action.act === "account_add_inspect" ? add.inspect()
          : await add.take(action.account, action.server_id, action.list === undefined || action.adder === undefined ? undefined : { list: action.list, adder: action.adder });
        return "refused" in done ? { error: done.refused, code: done.code } : done;
      }
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
