import { userInfo } from "node:os";
import type { RecoveryStanding } from "../../shared/account-devices-api.ts";
import type { DeviceStore } from "../devices.ts";
import { forgetPageMedia } from "../file-view.ts";
import type { DeviceJournal } from "./device-journal.ts";
import type { KeyProofPairings } from "./key-proof.ts";
import type { PcAccountState } from "./pc-binding.ts";
import type { PendingRedemptions } from "./pending.ts";
import { RelayIdentityError } from "../relay/identity.ts";
import type { RelayService } from "../relay/service.ts";
import type { AccountMailbox } from "./mailbox.ts";
import type { ListFollow } from "./list-follow.ts";
import { takeByList, takeForAccount } from "./one-press.ts";
import { recoveryActs, type AccountAddSeams, type RecoverySeams } from "./recovery-acts.ts";
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
  readonly relay: RelayService;
  readonly accountMailbox: AccountMailbox;
  /** the account's signed list as this PC follows it: a take that names a list joins by it */
  readonly accountList?: ListFollow | null;
  /** how long a take over SSH waits for this PC's relay to come online (one-press.ts ADDED_RELAY_ONLINE_MS) */
  readonly addedRelayOnlineMs?: number | undefined;
}) {
  const { stateDir, devices, pcAccount, journal, safetyLog, releases, pending, pairings, relay, accountMailbox } = options;
  // The log's freeze set already includes each standing block once.
  const standing = (): RecoveryStanding[] => safetyLog.state().freezes.flatMap(({ record }) => {
    const { kind, id, target, account, signer } = record;
    return kind === "block" || kind === "freeze" ? [{ kind, id, target, account, signer }] : [];
  });
  // a row the CLI ends loses the page media its renders were given, as one HTTP revoke ends (dispatch.ts)
  const forgetMedia = (ids: string[]): string[] => {
    for (const id of ids) forgetPageMedia({ device: id });
    return ids;
  };
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
    removeKey: (input) => {
      const done = devices.removeKey(input);
      if ("removed" in done) forgetMedia(done.removed);
      return done;
    },
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
    revokeAll: (user) => forgetMedia(devices.revokeAll(user)),
  };
  // a bridge this app started on another PC's behalf is never that PC's own Ovis: it is not added to an account
  const managed = () => process.env["OVIS_REMOTE"] === "1";
  const accountAdd: AccountAddSeams = {
    inspect: () => {
      if (managed()) return { refused: "This is a bridge another PC started, not this PC's own Ovis", code: "managed" };
      // an SSH install skips the first browser visit: the add itself makes the missing identity, never a damaged one's
      try { relay.ensureIdentity(); }
      catch (error) {
        if (error instanceof RelayIdentityError) return { refused: "This PC's relay identity cannot be read", code: "identity_unreadable" };
        throw error;
      }
      const fields = relay.publicFields();
      if (fields === null) return { refused: "This PC has no relay identity yet", code: "no_identity" };
      const { name, ...shown } = fields;
      return { ...shown, label: (name ?? fields.server_id.slice(0, 8)).slice(0, 48), account: devices.account() };
    },
    take: async (account, serverId, named) => {
      if (managed()) return { refused: "This is a bridge another PC started, not this PC's own Ovis", code: "managed" };
      const taken = named === undefined ? await takeForAccount({ devices, relay, accountMailbox }, account, serverId, options.addedRelayOnlineMs)
        : await takeByList({ devices, relay, accountMailbox, accountList: options.accountList ?? null }, account, serverId, named, options.addedRelayOnlineMs);
      return "refused" in taken ? { refused: taken.refused.message, code: taken.refused.code } : taken;
    },
  };
  const handle = recoveryActs({ releases, logReadable: act => {
    if (!SafetyLog.open(stateDir).readable) return false;
    switch (act) {
      case "revoke_all": return devices.revokeAllError === null;
      case "release": case "admit": case "lift": case "account_add_inspect": case "account_add_take": return devices.accountError === null;
      case "list": case "undo": case "remove": return !devices.failsClosed;
    }
  }, user: userInfo().username, seams, accountAdd });
  const opened = openRecoverySocket({ stateDir, handle });
  if ("refused" in opened) {
    if (opened.refused !== "windows") console.error(`ovis recover is not available: ${opened.refused}`);
    return null;
  }
  return opened;
}
