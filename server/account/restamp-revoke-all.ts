import { join } from "node:path";
import { DeviceStore, readDeviceRegistry } from "../devices.ts";
import { DeviceJournal } from "./device-journal.ts";
import { deviceStoreRows } from "./device-store-rows.ts";
import { PcAccountState } from "./pc-binding.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { checkRestampFile, RestampTrustError } from "./restamp-state.ts";
import { SafetyLog } from "./safety-log.ts";

/** Finish only the already durable intent, before taking the clock plan's snapshots. */
export function replayRestampRevokeAll(stateDir: string, relay: string | null, journal: DeviceJournal): void {
  checkRestampFile(join(stateDir, "revoke-all.json"));
  const pc = PcAccountState.open(stateDir);
  const registry = readDeviceRegistry(join(stateDir, "devices.json"), true, false);
  if (registry.kind === "bad") throw new RestampTrustError(`Cannot read devices.json in ${stateDir}`);
  if (registry.kind === "ok") pc.checkRows(registry.devices);
  const safety = SafetyLog.open(stateDir);
  const removals = RemovalEvidence.open(stateDir, safety);
  if (pc.evidenceWritten()) removals.missingAfterWritten();
  const refusal = pc.strict ?? safety.strict ?? removals.strict ?? journal.strict;
  if (refusal !== null) throw new RestampTrustError(refusal);
  const store = new DeviceStore(stateDir, null, null, {
    pc, safety, removals, journal, revokeAllOnly: true,
    joinedRows: devices => deviceStoreRows({ stateDir, serverId: () => relay, pc, removals, journal }, devices),
  });
  if (store.accountError !== null) throw new RestampTrustError(store.accountError);
}
