import type { DeviceStore } from "../devices.ts";
import { accountRowsFor, type AccountRowPorts } from "./account-devices.ts";
import type { DeviceJournal } from "./device-journal.ts";
import { listNotices } from "./list-notices.ts";
import type { PcAccountState } from "./pc-binding.ts";
import type { RemovalEvidence } from "./removal-evidence.ts";

/** The same durable row/journal ports serve startup replay and the running server. */
export function deviceStoreRows(
  stores: { stateDir: string; serverId: () => string | null; pc: PcAccountState; journal: DeviceJournal; removals: RemovalEvidence },
  devices: DeviceStore,
  live?: Pick<AccountRowPorts, "checkFreshness" | "releaseOf" | "admits" | "rowsWritten">,
) {
  const { stateDir, serverId, pc, journal, removals } = stores;
  return accountRowsFor(stateDir, serverId, {
    evidence: removals,
    ...listNotices(journal, removals, entry => devices.publish(entry)),
    settleNotices: rows => devices.settleListNotices(rows),
    closeSessions: id => devices.closeAccountSessions(id),
    heldByDevicesJson: key => devices.hasKey(key),
    serviceStep2Off: () => pc.serviceStep2Off() && !devices.listFollowed(),
    admits: () => false, // The replay-only store admits nobody and schedules no timers.
    now: () => Date.now(),
    ...(live ? { setTimeout: (run: () => void, ms: number) => devices.waitClock().setTimeout(run, ms), ...live } : {}),
    admitOrigin: at => pc.admit("remote", "list", null, Date.parse(devices.nextStamp(at))),
    firstDevice: {
      othersEver: () => pc.othersEver(),
      setOthersEver: () => { pc.setOthersEver(); },
      listKey: () => pc.first()?.list_key ?? null,
      otherRows: () => {
        const bound = pc.first()?.key;
        return devices.list(null).length > (bound !== undefined && devices.hasKey(bound) ? 1 : 0);
      },
    },
    admitListedRows: write => devices.admitListedRows(write),
    admitted: rows => devices.announceListAdmissions(rows),
  });
}
