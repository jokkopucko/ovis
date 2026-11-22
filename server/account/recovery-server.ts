import { userInfo } from "node:os";
import type { RecoveryStanding } from "../../shared/account-devices-api.ts";
import type { DeviceStore } from "../devices.ts";
import type { DeviceJournal } from "./device-journal.ts";
import type { KeyProofPairings } from "./key-proof.ts";
import type { PcAccountState } from "./pc-binding.ts";
import type { PendingRedemptions } from "./pending.ts";
import { recoveryActs, type RecoverySeams } from "./recovery-acts.ts";
import { openRecoverySocket, type RecoveryReleases } from "./recovery.ts";
import { pcRecordId, SafetyLog } from "./safety-log.ts";

/** Wire the PC's stores into its local recovery socket. */
export function openPcRecovery(options: {
  readonly stateDir: string;
  readonly devices: DeviceStore;
  readonly pcAccount: PcAccountState | null;
  readonly journal: DeviceJournal;
  readonly safetyLog: SafetyLog;
  readonly releases: RecoveryReleases;
  readonly pending: PendingRedemptions | undefined;
  readonly pairings: KeyProofPairings | undefined;
}) {
  const { stateDir, devices, pcAccount, journal, safetyLog, releases, pending, pairings } = options;
  // The log's freeze set already includes each standing block once.
  const standing = (): RecoveryStanding[] => safetyLog.state().freezes.flatMap(({ record }) => {
    const { kind, id, target, account, signer } = record;
    return kind === "block" || kind === "freeze" ? [{ kind, id, target, account, signer }] : [];
  });
  const seams: RecoverySeams = {
    pendingList: () => (pending?.list() ?? []).map(({ id, label, fingerprint }) => ({ id, label, fingerprint })),
    standing,
    admitPending: (id, fingerprint) => {
      const waiting = pending?.list().find((entry) => entry.id === id);
      if (waiting === undefined || pairings === undefined) return "unknown";
      if (waiting.fingerprint !== fingerprint) return "mismatch";
      // Check before approve consumes the pending redemption.
      const restriction = standing().find(({ target }) => target === waiting.key);
      if (restriction !== undefined) {
        return { refused: `${waiting.label} cannot be admitted while ${restriction.kind} ${restriction.id} stands: lift it first with ovis recover --lift ${restriction.id}` };
      }
      return pairings.approve(id, fingerprint, "recover");
    },
    removeKey: (input) => devices.removeKey(input),
    appendLift: (id, forget, user) => {
      const freezeId = id.startsWith("f:");
      const restriction = standing().find((entry) => entry.id === id);
      if (freezeId && restriction === undefined) return { outcome: "refused" };
      const blockId = freezeId ? id.slice(2) : id;
      const binding = restriction === undefined ? pcAccount?.binding() ?? null : { account: restriction.account };
      // A snapshot can leave this PC with a freeze but no signed block. The log still ends it by its block ID.
      const done = restriction?.kind === "freeze" && !safetyLog.blockIds().includes(blockId)
        ? safetyLog.append({
          record: { v: 1, id: pcRecordId(), kind: "lift", account: restriction.account, target: blockId, signer: "pc", signed_at: new Date().toISOString(), forget, signature: "" },
          got: "pc", cause: "recover",
        })
        : safetyLog.appendLift(blockId, binding, { cause: "recover", forget });
      if (done.outcome === "applied") {
        try {
          journal.append({ kind: "lift", how: "recover", key: null, no: null, row: null, label: id, by: user, account: binding?.account ?? null });
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          return { ...done, journalWarning: error.message };
        }
      }
      return done;
    },
    revokeAll: (user) => devices.revokeAll(user),
  };
  const handle = recoveryActs({ releases, logReadable: act => {
    if (!SafetyLog.open(stateDir).readable) return false;
    switch (act) {
      case "revoke_all": return devices.revokeAllError === null;
      case "release": case "admit": case "lift": return devices.accountError === null;
      case "list": case "undo": case "remove": return !devices.failsClosed;
    }
  }, user: userInfo().username, seams });
  const opened = openRecoverySocket({ stateDir, handle });
  if ("refused" in opened) {
    if (opened.refused !== "windows") console.error(`ovis recover is not available: ${opened.refused}`);
    return null;
  }
  return opened;
}
