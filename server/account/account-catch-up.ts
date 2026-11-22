import type { AccountSnapshot } from "../../shared/account-snapshot.ts";
import type { DeviceStore } from "../devices.ts";
import { STALE_READ_MS, type accountRowsFor } from "./account-devices.ts";
import { CatchUpGate } from "./catch-up-gate.ts";
import type { PcAccountState } from "./pc-binding.ts";
import type { Readmission } from "./readmission.ts";
import type { RecoveryReleases } from "./recovery.ts";
import { SnapshotWriteRefused } from "./snapshot-read.ts";

/** The server's whole-read lifecycle: release judged rows, then bound how long that read keeps them usable. */
export class AccountCatchUp {
  readonly gate: CatchUpGate | null;
  private cancelStaleness: (() => void) | undefined;
  private remaining: (() => number) | undefined;
  private onStale: (() => void) | undefined;
  private readonly stopLifts?: () => void;
  private readonly stopRecovery?: () => void;
  private readonly releases: RecoveryReleases | undefined;

  constructor(
    private readonly devices: DeviceStore,
    private readonly rows: ReturnType<typeof accountRowsFor> | null,
    private readonly options: { readonly pc: PcAccountState | null; readonly releases?: RecoveryReleases | undefined },
  ) {
    const { pc, releases } = options;
    this.releases = releases;
    this.gate = rows === null ? null : new CatchUpGate(() => pc?.binding()?.bind_id ?? null,
      id => releases?.releaseOf(id) != null);
    devices.attachCatchUp(this.gate, releases);
    if (rows && releases) this.stopRecovery = releases.registerRecoverySource(() =>
      (rows.store()?.waitingRows() ?? []).map(row => devices.listedRecoveryCandidate(row)));
    const gate = this.gate;
    if (gate && rows) this.stopLifts = devices.onLifted((target, cause) => {
      switch (cause) {
        case "snapshot":
        case "screen": gate.endFreeze(target); return;
        case "orphan":
        case "recover":
        case "record": {
          const members = devices.list(null).filter(row => devices.relayKeyOf(row.id) === target);
          const ids = gate.waitAfterLift(target, [...members, ...rows.rowsByKey(target)].map(row => row.id));
          for (const row of devices.list(null)) if (ids.has(row.id)) devices.closeAccountSessions(row.id);
          rows.store()?.waitForRead(ids);
          return;
        }
        default: return cause satisfies never;
      }
    });
  }

  /** An explicit opt-out is not a whole read: no renewal, no lift, and no account-list access. */
  step2Off(): void {
    if (this.options.pc?.setServiceStep2Off(true)) this.rows?.store()?.waitForService();
  }

  /** `readmission`: the proved returning device a sign-in's own pull may readmit (S2-28, T55). */
  commitList(snapshot: AccountSnapshot, readmission?: Readmission): void {
    const store = this.rows?.store();
    try {
      store?.commitList(snapshot, readmission);
      const accountError = this.devices.accountError;
      if (accountError !== null) throw new SnapshotWriteRefused(accountError);
      store?.expire();
      this.releases?.endAll();
      this.gate?.wholeRead(this.devices.list(null).filter(row =>
        !this.devices.admits(this.devices.relayKeyOf(row.id), undefined, { retainId: row.id })).map(row => row.id));
      this.options.pc?.setServiceStep2Off(false);
    } catch (error) {
      // A list write may already have changed some rows. They cannot serve on a partial read.
      store?.waitForRead();
      throw error;
    }
    // Only an applied whole read renews the deadline. Failed pulls never postpone it, and a hung service cannot
    // prevent the PC from closing idle sessions at the deadline.
    this.clearDeadline();
    if (!store) return;
    const clock = this.devices.waitClock();
    const deadline = clock.now() + STALE_READ_MS;
    this.remaining = () => deadline - clock.now();
    this.onStale = () => store.waitForRead();
    const fire = () => {
      const left = this.checkFreshness();
      if (left > 0) this.cancelStaleness = clock.setTimeout(fire, Math.ceil(left));
    };
    this.cancelStaleness = clock.setTimeout(fire, STALE_READ_MS);
  }

  /** Also checked synchronously at use; the timeout only guarantees closure of idle sessions. */
  checkFreshness(): number {
    const left = this.remaining?.() ?? 0;
    if (left <= 0 && this.onStale) {
      const expire = this.onStale;
      this.clearDeadline();
      expire();
    }
    return left;
  }

  private clearDeadline(): void {
    this.remaining = this.onStale = undefined;
    this.cancelStaleness?.();
    this.cancelStaleness = undefined;
  }

  stop(): void { this.stopRecovery?.(); this.releases?.endAll(); this.stopLifts?.(); this.clearDeadline(); }
}
