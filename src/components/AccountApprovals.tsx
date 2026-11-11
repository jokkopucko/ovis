/**
 * Devices asking to join the account through the PC this window is in (`remote-pairings`): the
 * first waits in AccountApprovalPrompt. An approval tells this PC first, which lets the device in
 * here; then this device signs the `add` for the account's other PCs and leaves the PCs it checked
 * itself with this PC as the new device's introduction (lib/account/join.ts).
 */
import { useEffect, useState } from "react";

import { accountLabel, type AccountAsker } from "../../shared/account-asker.ts";
import type { RemotePairingRequest } from "../../shared/protocol.ts";
import { AdmissionChangedError, admitToAccount, approveJoin, UnverifiedJoinError, vouchedAdmission } from "../lib/account/join.ts";
import { useT } from "../lib/i18n.ts";
import { accountServiceOf, AccountService, type Admission } from "../lib/account/service.ts";
import { indexedAccountStore } from "../lib/account/store.ts";
import { decideRelayPairing } from "../lib/api.ts";
import { indexedDeviceStore } from "../lib/relay/device.ts";
import { serverIdOfPath } from "../lib/shellMode.ts";
import { getTransport } from "../lib/transport.ts";
import { AccountApprovalPrompt } from "./AccountApprovalPrompt.tsx";

/**
 * Whether a request rests on an admission, so its card says who is asking and its approval checks that admission
 * (approveJoin): an account join, or another PC of the account vouched for. Any other request is answered on the PC only.
 */
export const restsOnAdmission = (request: RemotePairingRequest | undefined): boolean => request?.intent === "account" || request?.vouched === true;

export function AccountApprovals({ pairings }: { pairings: readonly RemotePairingRequest[] }) {
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

  useEffect(() => {
    if (serverId === null) return;
    let live = true;
    void (async () => {
      const paired = await indexedDeviceStore.list();
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
  }, [serverId]);

  if (request === undefined || serverId === null) return null;

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
      await approveJoin({
        request, digits, through: serverId, service, shown,
        decide: (answer, picked) => decideRelayPairing(request.id, answer, picked),
        admit: async (admission) => admitToAccount({
          fetch: (path, init) => transport.fetch(path, init), service, key: await indexedAccountStore.key(), account: session!.account,
          joining: { key: request.key, label: admission.label }, through: serverId, paired: await indexedDeviceStore.list(),
          directory: (await service.listPcs()).map((pc) => pc.server_id), store: indexedAccountStore,
        }),
      });
    } catch (error) {
      if (error instanceof UnverifiedJoinError) throw new Error(t("Could not verify this device. It was declined: approve only a device you are signing in yourself."));
      if (error instanceof AdmissionChangedError) {
        // Approve waits again until the new details are read (and the card's pick is cleared with them)
        setAsker(null);
        setReads((count) => count + 1);
        throw new Error(t("This device asked again with other details. Check them, then pick the number again."));
      }
      throw error;
    }
  };

  const known = asker?.id === request.id ? asker : null;
  // an account join shows the name the device gave the account service; a request for this PC only has no admission
  const shown = { ...request, label: known?.admission?.label ?? (accountLabel(request.label) || t("Device")) };
  return <AccountApprovalPrompt key={request.id} request={shown} pcName={where.pcName} pcCount={where.pcCount}
    asker={checked ? known?.asker : null} onDecide={decide} />;
}
