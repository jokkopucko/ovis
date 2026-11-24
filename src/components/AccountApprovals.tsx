/**
 * An approval tells this PC first, which lets the device in here; then this device signs the `add`
 * for the account's other PCs and leaves the PCs it checked itself with this PC as the new device's
 * introduction (lib/account/join.ts). For an account whose signed list this device is in, it signs the
 * device into the list before that; where the list does not take it, the card says so and offers to try again.
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { accountLabel, type AccountAsker } from "../../shared/account-asker.ts";
import type { RemotePairingRequest } from "../../shared/protocol.ts";
import { AdmissionChangedError, approveForAccount, ListAllowError, NotConfirmedError, UnverifiedJoinError, vouchedAdmission } from "../lib/account/join.ts";
import { resendWaiting } from "../lib/account/listWrite.ts";
import type { AccountList, WaitingRequest } from "../lib/account/accountList.ts";
import { pageAccountList } from "../lib/account/pageList.ts";
import { useT } from "../lib/i18n.ts";
import { accountServiceOf, AccountService, type Admission } from "../lib/account/service.ts";
import { indexedAccountStore } from "../lib/account/store.ts";
import { decideRelayPairing } from "../lib/api.ts";
import { indexedDeviceStore } from "../lib/relay/device.ts";
import { serverIdOfPath } from "../lib/shellMode.ts";
import { getTransport } from "../lib/transport.ts";
import { AccountApprovalPrompt } from "./AccountApprovalPrompt.tsx";
import { keepStalled, ListAllowNotice, NotReadError, stalledReason, useWaitingChange, type Stalled } from "./ListChangeNotice.tsx";
import { VouchedPcApproval } from "./VouchedPcApproval.tsx";

/**
 * Whether a request rests on an admission, so its card says who is asking and its approval checks that admission
 * (approveJoin): an account join, or another PC of the account vouched for. Any other request is answered on the PC only.
 */
export const restsOnAdmission = (request: RemotePairingRequest | undefined): boolean => request?.intent === "account" || request?.vouched === true;

/**
 * The request that waits at this device's head for `account`, the one an approval began under: a sign-in that moved to
 * another account meanwhile leaves the page's list another account's, whose request is not this card's to send or let go.
 */
export async function waitingOf(list: AccountList | null, account: string): Promise<WaitingRequest | null> {
  const request = list === null ? null : await list.waiting().catch(() => null);
  return request !== null && request.account === account ? request : null;
}

/**
 * What the card says where an approval ended before the PC said that the new device confirmed (NotConfirmedError). A
 * join that brought its card waits for its person's press. One that brought none is a pairing of that PC's own: no
 * device is ever told that it confirmed, so it is approved on that PC's own screen.
 */
export function unconfirmedReason(t: (key: string, vars?: Record<string, string>) => string, request: RemotePairingRequest, device: string, pc: string): string {
  return request.list === true ? t("First press “The numbers match” on {device}", { device }) : t("Approve {device} on {pc}'s own screen", { device, pc });
}

export function AccountApprovals({ pairings }: { pairings: readonly RemotePairingRequest[] }) {
  // The devices this PC let in that the account's list did not take, each kept until it is let in or closed. They are
  // held here, above whichever card the next request draws, so a request for another PC (VouchedPcApproval) takes none
  // of them away; each is shown once no request is on screen.
  const [stalled, setStalled] = useState<readonly Stalled[]>([]);
  const keep = useCallback((key: string, next: Stalled | null): void => setStalled((kept) => keepStalled(kept, key, next)), []);
  // Another change was refused because a request signed for an earlier one still waits (listWrite.ts): where this page
  // holds no card of that earlier change (it was made before a reload), one is put up, to try it again or to cancel it.
  const earlier = useWaitingChange();
  const request = pairings[0];
  const through = serverIdOfPath(window.location.pathname);
  if (request?.vouched && through) return <VouchedPcApproval key={JSON.stringify([through, request.id, request.key, request.proven_server_id])} request={request} through={through} />;
  const waiting = stalled[0];
  if (request === undefined && waiting !== undefined) return createPortal(<ListAllowNotice key={waiting.key} stalled={waiting} onClose={() => keep(waiting.key, null)} />, document.body);
  if (request === undefined && earlier.stalled !== null) return createPortal(<ListAllowNotice key={earlier.stalled.key} stalled={earlier.stalled} onClose={earlier.close} />, document.body);
  return <DeviceApprovals pairings={pairings} onStalled={keep} />;
}

function DeviceApprovals({ pairings, onStalled }: { pairings: readonly RemotePairingRequest[]; onStalled: (key: string, stalled: Stalled | null) => void }) {
  const t = useT();
  const request = pairings[0];
  const serverId = serverIdOfPath(window.location.pathname);
  const [where, setWhere] = useState<{ pcName: string; pcCount: number }>({ pcName: "", pcCount: 1 });
  // who is asking, as the account service saw the device ring at this PC (never as the PC says);
  // until it is known an account join cannot be approved (AccountApprovalPrompt `asker` undefined)
  const [asker, setAsker] = useState<{ id: string; asker: AccountAsker; admission: Admission | null } | null>(null);
  // read again when the device asked anew with other details after the card was drawn
  const [reads, setReads] = useState(0);
  const checked = restsOnAdmission(request);
  const joiningId = checked ? request!.id : null;
  const joiningKey = request?.key;
  useEffect(() => {
    if (joiningId === null || joiningKey === undefined || serverId === null) return;
    let live = true;
    void (async () => {
      // nothing found, signed out or no answer: the card says the place is unknown rather than leave the line out
      let found: { asker: AccountAsker; admission: Admission | null } = { asker: { os: null, country: null, city: null }, admission: null };
      try {
        const service = new AccountService({ store: indexedAccountStore });
        if (accountServiceOf(document) !== null && await service.session() !== undefined) {
          const rang = vouchedAdmission(await service.recentAdmissions(), serverId, joiningKey, Date.now());
          if (rang !== undefined) found = { asker: { os: rang.os, country: rang.country, city: rang.city }, admission: rang };
        }
      } catch (error) { console.warn("Ovis: who is asking could not be read", error instanceof Error ? error.name : error); }
      if (live) setAsker({ id: joiningId, ...found });
    })();
    return () => { live = false; };
  }, [joiningId, joiningKey, serverId, reads]);

  const asking = request !== undefined;
  useEffect(() => {
    // only while a request is on screen: this card is mounted with none, too
    if (serverId === null || !asking) return;
    let live = true;
    void (async () => {
      // a store that does not read leaves the card with the PC's id for a name and one PC: nothing here throws into nothing
      const paired = await indexedDeviceStore.list().catch((error: unknown) => { console.warn("Ovis: this device's pairings could not be read for the approval", error instanceof Error ? error.name : error); return []; });
      const here = paired.find((device) => device.server_id === serverId);
      const service = accountServiceOf(document);
      let count = paired.filter((device) => device.device_id !== null).length;
      if (service !== null) {
        try { count = Math.max(count, (await new AccountService({ store: indexedAccountStore }).listPcs()).length); }
        catch (error) { console.warn("Ovis: the account's PCs could not be counted", error instanceof Error ? error.name : error); }
      }
      if (live) setWhere({ pcName: here?.name ?? serverId.slice(0, 8), pcCount: Math.max(count, 1) });
    })();
    return () => { live = false; };
  }, [serverId, asking]);

  if (request === undefined || serverId === null) return null;

  const known = asker?.id === request.id ? asker : null;
  // an account join shows the name the device gave the account service; a request for this PC only has no admission
  const deviceName = known?.admission?.label ?? (accountLabel(request.label) || t("Device"));

  const decide = async (decision: "approve" | "decline", digits?: string): Promise<void> => {
    if (decision === "decline" || digits === undefined) { await decideRelayPairing(request.id, "decline"); return; }
    const service = new AccountService({ store: indexedAccountStore });
    const session = await service.session();
    // signed out here, an account join is answered on this PC only, never added to the account. A PC vouched for is
    // never approved unchecked: approveJoin cannot read the admission without a sign-in, and approves nothing
    if (!checked || (session === undefined && request.intent === "account")) { await decideRelayPairing(request.id, "approve", digits); return; }
    const transport = getTransport();
    try {
      // what the card showed, or null when it showed no admission: approveJoin takes no other
      const shown = asker?.id === request.id ? asker.admission : null;
      await approveForAccount({
        request, digits, through: serverId, service, shown,
        decide: (answer, picked) => decideRelayPairing(request.id, answer, picked),
        // a PC that selected the list for this session lets devices in by it alone: the entry is signed right after the approval
        pc: { fetch: (path, init) => transport.fetch(path, init), followsList: transport.followsList === true },
        account: session!.account, key: indexedAccountStore.key(), list: pageAccountList(), store: indexedAccountStore,
        paired: () => indexedDeviceStore.list(), directory: async () => (await service.listPcs()).map((pc) => pc.server_id),
        // This PC let the device in already, and its request is gone from here: where the account's list did not take
        // it, that is said on a card of its own, which can try again.
        onStalled: async (stalled) => {
          if (stalled === null) { onStalled(request.key, null); return; }
          // A signed request may wait at this device's head: this approval's own, or an earlier change's that holds
          // it back (`waiting`). The card is the card of that very request: Cancel lets it go and no other, and where
          // it is the earlier change's, Try again sends that one first.
          const list = pageAccountList();
          const waits = stalled.why === "busy" || stalled.why === "unknown" || stalled.why === "stopped" || stalled.why === "waiting";
          const kept = waits ? await waitingOf(list, session!.account) : null;
          const retry = stalled.why === "waiting" && kept !== null && list !== null ? async (): Promise<void> => { await resendWaiting(list, kept); await stalled.retry(); } : stalled.retry;
          onStalled(request.key, { key: request.key, device: stalled.label, pc: where.pcName, pairedAtPc: stalled.pairedAtPc, placed: stalled.placed, why: stalled.why, retryAfterMs: stalled.retryAfterMs, retry,
            // Cancel reads the log first: a request that was placed after all is this approval going through, which
            // is then finished; one whose outcome cannot be read is not let go, and the card stays
            ...(kept !== null && list !== null ? { cancel: async () => {
              const said = await list.cancel(kept);
              if (said === "unread") throw new NotReadError();
              if (said === "placed" && kept.for === `allow:${request.key}`) await stalled.retry();
            } } : {}) });
        },
      });
    } catch (error) {
      if (error instanceof UnverifiedJoinError) throw new Error(t("Could not verify this device. It was declined: approve only a device you are signing in yourself."));
      // this PC lets devices in by the account's list alone, and this device cannot write that list: nothing was approved
      if (error instanceof ListAllowError) throw new Error(stalledReason(t, error.why, error.retryAfterMs));
      // nor where the new device's person has not said yet that the numbers match
      if (error instanceof NotConfirmedError) throw new Error(unconfirmedReason(t, request, deviceName, where.pcName));
      if (error instanceof AdmissionChangedError) {
        // Approve waits again until the new details are read (and the card's pick is cleared with them)
        setAsker(null);
        setReads((count) => count + 1);
        throw new Error(t("This device asked again with other details. Check them, then pick the number again."));
      }
      throw error;
    }
  };

  const shown = { ...request, label: deviceName };
  return <AccountApprovalPrompt key={request.id} request={shown} pcName={where.pcName} pcCount={where.pcCount} followsList={getTransport().followsList === true}
    asker={checked ? known?.asker : null} onDecide={decide} />;
}
