/**
 * The ports of a whole account read (snapshot-read.ts) on this PC's real state (Step 2, S2-24). Every block of the
 * snapshot goes through DeviceStore.applyBlock, which checks its signature and its signer's age by this PC's admission
 * order before anything is written. A lift counts only after DeviceStore.liftAuthority, and is appended to the safety
 * log in the commit turn.
 */
import type { BlockRecord, DeviceLiftRecord } from "../../shared/account-records.ts";
import type { DeviceStore } from "../devices.ts";
import { OrderConflict, type AccountOrder, type LiftOrder } from "./account-order.ts";
import type { DeviceJournal } from "./device-journal.ts";
import type { PcAccountState } from "./pc-binding.ts";
import type { SafetyLog } from "./safety-log.ts";
import type { AccountSnapshot } from "../../shared/account-snapshot.ts";
import { SnapshotWriteRefused, type SnapshotPorts, type StagedRead } from "./snapshot-read.ts";

export interface SnapshotDeps {
  readonly devices: DeviceStore;
  readonly safetyLog: SafetyLog;
  readonly pc: PcAccountState;
  readonly journal: DeviceJournal;
  /** The account's order, written in each whole read's commit turn (P21). */
  readonly order: AccountOrder;
  /** This PC's relay identity now, or null without one. */
  serverId(): string | null;
  requestRead(): void;
  /** The account-joined rows' store, given the whole read's list in its commit turn (S2-25); absent without one. */
  commitList?(snapshot: AccountSnapshot): void;
  step2Off?(): void;
}


// A read gets fresh ports, but every read of this log must see the same fence.
// On reopen we conservatively fence any standing service lines again.
const fencedThrough = new WeakMap<SafetyLog, number>();

export function snapshotPorts(deps: SnapshotDeps): SnapshotPorts {
  const { devices, safetyLog, pc, journal } = deps;
  const bindId = pc.binding()?.bind_id;
  const serverId = deps.serverId();
  const orders = new WeakMap<StagedRead["snapshot"], LiftOrder>();
  const fenceFreezes = () => {
    const fenced = fencedThrough.get(safetyLog) ?? 0;
    const newest = safetyLog.inForce.freezes.reduce((n, entry) => entry.record.kind === "freeze" ? Math.max(n, entry.n) : n, fenced);
    if (newest === fenced) return;
    try { pc.raiseGen(); } catch (error) {
      pc.unwritten(error, "The service freeze generation could not be persisted");
      devices.recheckListedSessions();
      throw new SnapshotWriteRefused("Service freeze generation unavailable", { cause: error });
    }
    fencedThrough.set(safetyLog, newest);
  };
  return {
    scope() {
      const account = devices.account();
      const serverId = deps.serverId();
      if (account === null || serverId === null || deps.order.problem !== null || pc.strict !== null) return null;
      try { fenceFreezes(); } catch (error) {
        if (error instanceof SnapshotWriteRefused) return null;
        throw error;
      }
      const state = safetyLog.state();
      return { account, serverId, gen: devices.gen(), lock: state.locked ? state.locks.map((entry) => entry.record.id).join(",") : null };
    },
    lastVersion: () => deps.order.lastVersion(pc.binding()?.bind_id, deps.serverId()),
    knownBlocks: () => new Set(safetyLog.blockIds()),
    async deny(block: BlockRecord) {
      let raised = false;
      await devices.applyBlock(block, "snapshot", () => { raised = true; });
      return raised;
    },
    async liftAuthority(lift: DeviceLiftRecord, snapshot) {
      let order = orders.get(snapshot);
      if (!order) {
        try { order = deps.order.preview(snapshot, pc.binding()?.bind_id); } catch (error) {
          if (error instanceof OrderConflict) return false; // The commit journals the conflict and rejects the read.
          throw error;
        }
        orders.set(snapshot, order);
      }
      const entry = safetyLog.state().freezes.find(({ record }) => record.account === lift.account &&
        (record.kind === "block" ? record.id === lift.target : record.kind === "freeze" && record.id === `f:${lift.target}`));
      const target = entry?.record.target;
      const bound = pc.binding()?.bind_id;
      if (!target || bound === undefined || !order.listedOn(lift.signer, bound) || !order.listedOn(target, bound)
        || order.late(lift.signer) || !order.registered(lift.signer, lift.account)) return false;
      const signerNo = order.no(lift.signer);
      const targetNo = order.no(target);
      return signerNo !== null && targetNo !== null && signerNo < targetNo && devices.liftAuthority(lift, order);
    },
    commit(stage: StagedRead) {
      const binding = pc.binding();
      if (binding === null) throw new Error("Snapshot commit requires a current binding");
      let recordOrder: () => () => void;
      try { recordOrder = deps.order.prepare(stage.snapshot, binding.bind_id); } catch (error) {
        if (error instanceof OrderConflict) journal.append({ kind: "account", how: "order_conflict", key: error.key, no: null, row: null, label: error.message, by: null, account: binding.account });
        throw error;
      }
      const blocks = new Map(stage.snapshot.blocks.map((block) => [block.id, block]));
      let installedFreeze = false;
      fenceFreezes();
      for (const line of stage.snapshot.freezes) {
        const block = blocks.get(line.block);
        if (!block || devices.isTombstoned(block.signer)) continue;
        // An exact-key decision supplies no local cutoff for numbered rows; retain its service cutoff too.
        if (safetyLog.receipt(line.block) && !safetyLog.inForce.blocks.some(entry =>
          entry.record.id === line.block && entry.asof?.target_only === true)) continue;
        const id = `f:${line.block}`;
        if (safetyLog.receipt(id)) continue;
        const receipt = safetyLog.append({ got: "snapshot", record: { v: 1, kind: "freeze", id, account: block.account,
          target: line.target, after: line.after, signer: "service", signed_at: block.signed_at, signature: "" } });
        if (receipt.outcome !== "applied") throw new Error("Cannot record the snapshot freeze line");
        installedFreeze = true;
        devices.recheckListedSessions();
        fenceFreezes();
      }
      let restoreOrder: () => void;
      try { restoreOrder = recordOrder(); } catch (error) {
        if (error instanceof Error) throw new SnapshotWriteRefused(error.message, { cause: error });
        throw error;
      }
      // Signatures and order were checked against this snapshot; a line installed in this turn invalidates the
      // standing check, even though there was no intervening read or generation change from another writer.
      const lifts = installedFreeze ? stage.lifts.filter(lift => devices.liftStanding(lift, deps.order)) : stage.lifts;
      // P14: the generation is raised on disk before any lift counts, so no decision taken at the old generation stands
      // beside a lift; if it cannot be written, nothing is lifted and the previous watermark still applies
      if (lifts.length > 0) {
        try { pc.raiseGen(); } catch (error) {
          restoreOrder();
          if (error instanceof Error) throw new SnapshotWriteRefused(error.message, { cause: error });
          throw error;
        }
      }
      const { receipts } = safetyLog.commitLifts(lifts, "snapshot");
      const refused = receipts.find((receipt) => receipt.outcome === "refused");
      if (refused) {
        restoreOrder(); // commitLifts published nothing, so the previous watermark still applies.
        throw new SnapshotWriteRefused(refused.code);
      }
      journal.recordSnapshotLifts(safetyLog);
      devices.handedLifts.decide(stage.snapshot.lifts);
      // Take away access using the now-reconciled order before the mailbox or account list can grant new access.
      devices.applyWaitingBlocks(true);
      return lifts.length;
    },
    commitList(snapshot) {
      devices.resumePromotedHolds();
      deps.commitList?.(snapshot);
    },
    step2Off() {
      if (bindId !== undefined && pc.binding()?.bind_id === bindId && deps.serverId() === serverId) deps.step2Off?.();
    },
    methodsVersion: () => deps.order.methodsVersion(),
    journalMethod(version) {
      journal.append({ kind: "method", how: `methods_version:${version}`, key: null, no: null, row: null, label: "The account's sign-in methods changed", by: null, account: devices.account() });
      deps.order.recordMethod(version);
    },
    requestRead: deps.requestRead,
  };
}
