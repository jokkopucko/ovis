import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { accountLabel } from "../../shared/account-asker.ts";
import type { PairedDevice } from "../../shared/protocol.ts";
import { removeFromAccount } from "../lib/account/leave.ts";
import { postedPcs } from "../lib/account/listAdd.ts";
import { classified, pageListReading, pagePcs, readPageList, type ListedPost } from "../lib/account/listPcs.ts";
import { holdsList } from "../lib/account/listWrite.ts";
import { pageAccountList } from "../lib/account/pageList.ts";
import { ACCOUNT_PCS_CHANGED_EVENT, OFFLINE_AFTER_MS } from "../lib/account/myPcs.ts";
import { AccountService, type DirectoryPc } from "../lib/account/service.ts";
import { indexedAccountStore } from "../lib/account/store.ts";
import { fetchDevices } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { loadRelayShell } from "../lib/relay.ts";
import { indexedDeviceStore } from "../lib/relay/device.ts";
import { serverIdOfPath } from "../lib/shellMode.ts";
import { getTransport } from "../lib/transport.ts";
import { DEVICES_CHANGED_EVENT, inRelayShell } from "../lib/useRelay.ts";
import { signInOfAccount } from "./AccountPcs.tsx";
import { AddPcByNumber } from "./AddPcByNumber.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { ListAlarmNotice } from "./ListAlarmNotice.tsx";
import type { Shown } from "../lib/account/listLeave.ts";
import { ListDevices, showsListDevices, useListView } from "./ListDevices.tsx";
import { StatusDot } from "./StatusDot.tsx";
import { heldRemoval, pcRemovalFailure, usePcRemoval, type HeldRemoval } from "./usePcRemoval.tsx";

/**
 * Whether `row` can be disconnected from every PC from here: another device of the account, and a
 * `remove` signed with this client's account key would be applied, as the PC takes one only from a
 * drive member of the account (server/account/records.ts). A browser signed in on the PC's own address,
 * paired by cookie, holds a key no row has, and every PC would refuse it (`signer_not_member`).
 */
export function offersAccountRemove(devices: readonly PairedDevice[], row: PairedDevice, account: string, key: string | null): boolean {
  return key !== null && !row.current && row.account === account && row.account_key !== undefined && row.account_key !== key
    && devices.some((d) => d.account === account && d.account_key === key && d.role === "drive");
}

/** A PC the account has not heard from for this long (three missed mailbox pulls) is off, and Manage account may remove it. */
export function offlinePc(pc: { readonly last_seen_at: string | null; readonly added_at: string | null }, now: number): boolean {
  const heard = Date.parse(pc.last_seen_at ?? pc.added_at ?? "");
  return Number.isFinite(heard) && now - heard > OFFLINE_AFTER_MS;
}

/**
 * Manage account's lists, for when a phone is lost or a PC is gone: the account's other devices on the PC this page
 * is on, each disconnected from every PC of the account, and the account's PCs, an offline one removed from it. One
 * line a row: a dot says how it is, a press asks once. `onLeave`: this device leaves the account (the hosted app); a
 * throw keeps its confirm up with the error. `pcHere` false: no PC is open on this page (the hosted app's start screen),
 * so no other device is read or offered, only this one's own row.
 */
export function AccountManageLists({ account, watching, pcHere = true, onLeave }: { readonly account: string; readonly watching: boolean; readonly pcHere?: boolean; readonly onLeave?: (shown: Shown) => Promise<void> }) {
  return (
    <>
      <ListAlarmNotice account={account} />
      <AccountDevices account={account} pcHere={pcHere} {...(onLeave ? { onLeave } : {})} />
      <AccountPcs account={account} watching={watching} />
    </>
  );
}

/** The account's devices: from its signed list where this device is in one (ListDevices.tsx), otherwise as the PC here pairs them. */
function AccountDevices({ account, pcHere, onLeave }: { readonly account: string; readonly pcHere: boolean; readonly onLeave?: (shown: Shown) => Promise<void> }) {
  const list = pageAccountList();
  const view = useListView(list);
  if (list !== null && showsListDevices(view, account)) return <ListDevices list={list} view={view} {...(onLeave ? { onLeave } : {})} />;
  return <PairedAccountDevices account={account} pcHere={pcHere} {...(onLeave ? { onLeave } : {})} />;
}

function PairedAccountDevices({ account, pcHere, onLeave }: { readonly account: string; readonly pcHere: boolean; readonly onLeave?: (shown: Shown) => Promise<void> }) {
  const t = useT();
  // "failed": the PC did not answer, which says nothing of the account's devices
  const [devices, setDevices] = useState<PairedDevice[] | "failed" | null>(pcHere ? null : []);
  const [key, setKey] = useState<string | null>(null);
  const [asked, setAsked] = useState<PairedDevice | "self" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const read = useCallback(() => fetchDevices().then(setDevices, () => setDevices("failed")), []);
  useEffect(() => {
    if (!pcHere) return;
    void read();
    let live = true;
    indexedAccountStore.key().then((own) => { if (live) setKey(own.public_spki); }, () => undefined);
    return () => { live = false; };
  }, [read, pcHere]);
  const others = devices === null || devices === "failed" ? devices : devices.filter((device) => offersAccountRemove(devices, device, account, key));

  /** A device of the account, gone from every PC of it: at once on this PC, from the mailbox on the others. */
  const disconnect = async (device: PairedDevice): Promise<void> => {
    const transport = getTransport();
    const service = new AccountService({ store: indexedAccountStore });
    const hereId = serverIdOfPath(window.location.pathname);
    const { unconfirmed, queued = [] } = await removeFromAccount({ service, accountStore: indexedAccountStore, relayStore: indexedDeviceStore, key: device.account_key!, account,
      here: (path, init) => transport.fetch(path, init), ...(hereId !== null ? { hereId } : {}) });
    window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT));
    await read();
    if (unconfirmed.length === 0 && queued.length === 0) { setNote(null); return; }
    // only this PC answered: the others are named, rather than claimed (one may have revoked this device and refuse it)
    const names = new Map((await service.listPcs().catch(() => [])).map((pc) => [pc.server_id, pc.label]));
    const named = (ids: readonly string[]) => ids.map((id) => names.get(id) ?? id.slice(0, 8)).join(", ");
    setNote([
      unconfirmed.length > 0 ? t("Not removed yet on: {pcs}. Disconnect it from a device that is in the account there.", { pcs: named(unconfirmed) }) : "",
      queued.length > 0 ? t("Sent to {pcs}: each removes it when it next comes online. If it still shows there, disconnect it from another device in the account.", { pcs: named(queued) }) : "",
    ].filter(Boolean).join(" "));
  };

  return (
    <section className="account-manage-part" aria-label={t("Devices")}>
      <h3 className="account-manage-h">{t("Devices")}</h3>
      <ul className="account-manage-list" data-testid="account-devices">
        {onLeave && (
          <li className="account-manage-row">
            <StatusDot state="ready" />
            <span className="account-manage-name">{t("This device")}</span>
            <button type="button" className="btn account-head-btn" data-action="leave-account" onClick={() => setAsked("self")}>{t("Disconnect")}</button>
          </li>
        )}
        {others === null ? <li className="account-manage-row account-manage-dim" role="status">{t("Loading…")}</li>
          : others === "failed" ? <li className="account-manage-row account-manage-dim" role="alert">{t("Devices could not be loaded.")}</li>
          : others.map((device) => (
            <li key={device.id} className="account-manage-row" data-device-id={device.id}>
              <StatusDot state={device.connection ? "ready" : "offline"} />
              <span className="visually-hidden">{device.connection ? t("Online") : t("Offline")}</span>
              <span className="account-manage-name">{device.label}</span>
              <button type="button" className="btn account-head-btn" data-action="disconnect-device" onClick={() => setAsked(device)}>{t("Disconnect")}</button>
            </li>
          ))}
      </ul>
      {note !== null && <p className="settings-condition" role="alert">{note}</p>}
      {asked === "self" && onLeave && (
        <ConfirmDialog title={t("Remove this device?")} body={t("Every PC of the account removes this device. QR pairings outside the account stay.")}
          confirmLabel={t("Disconnect")} onClose={() => setAsked(null)} onConfirm={async () => { await onLeave({ account, scope: null }); setAsked(null); }} />
      )}
      {asked !== null && asked !== "self" && (
        <ConfirmDialog title={t("Disconnect {name}?", { name: asked.label })} body={t("{name} loses access to every PC of your account. Pairings it made outside the account stay.", { name: asked.label })}
          confirmLabel={t("Disconnect")} onClose={() => setAsked(null)}
          onConfirm={async () => {
            try { await disconnect(asked); } catch (error) {
              console.warn("Ovis: the device was not disconnected", error instanceof Error ? error.name : error);
              throw new Error(t("{name} could not be disconnected. Try again.", { name: asked.label }));
            }
            setAsked(null);
          }} />
      )}
    </section>
  );
}

function AccountPcs({ account, watching }: { readonly account: string; readonly watching: boolean }) {
  const t = useT();
  const service = useMemo(() => new AccountService({ store: indexedAccountStore }), []);
  const [pcs, setPcs] = useState<readonly DirectoryPc[] | "failed" | null>(null);
  // the PC the question is asked for, with the row of this device's list it was pressed on (null: no list holds it)
  const [asked, setAsked] = useState<(DirectoryPc & { readonly held: HeldRemoval | null }) | null>(null);
  // PCL-1: the PCs a sign-in code listed that no one added, for an app's own sign-in (a device code's removes none):
  // their card may be closed on this device, and this row still removes one
  const [unconfirmed, setUnconfirmed] = useState<readonly DirectoryPc[]>([]);
  // the PCs whose Remove was confirmed on such a row, kept from the press (a Sign in again finishes it later, after
  // reads that may no longer list the PC as waiting)
  const listingRemovals = useRef(new Set<string>());
  const removal = usePcRemoval(service, async (serverId, how) => {
    // a PC that was never added leaves the account only: a pairing made with it itself stays
    if (listingRemovals.current.delete(serverId)) { window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT)); return; }
    // On an account with no list, this device's own pairing with the gone PC goes too, so no list here offers it
    // again. A device that goes by its account's signed list forgets no pairing here, whichever way the PC left: a
    // pairing made with the PC itself still opens it, as the question says, and only Forget takes that key away
    const view = pageAccountList()?.view();
    const byList = view !== undefined && view.account === account && holdsList(view);
    if (how === "directory" && !byList && inRelayShell()) await (await loadRelayShell()).forgetSavedPc(serverId).catch(() => undefined);
    window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT));
  });
  // The PCs that posted their keys for the list, where this device may add one to it, each with what its Add does
  // (listPcs.ts postedFor): a row the list does not hold yet offers Add for such a PC, and says to update one that posted
  // nothing; a row the move carried in with no key of its own offers Add for its keys. null: not read, so neither is said
  const [posts, setPosts] = useState<readonly ListedPost[] | null>(null);
  const [adding, setAdding] = useState<{ readonly pc: DirectoryPc; readonly post: ListedPost } | null>(null);
  // for a device that is in the account's signed list, the PCs that list holds (listPcs.ts)
  // (a page that has not read its copy of the list yet reads it first: until a read ends, every row is marked)
  // Reads overlap (the list moves while the directory is read): only the newest one draws, so an older answer, or an
  // older failure, never takes the place of a newer one
  const reads = useRef(0);
  const read = useCallback(async () => {
    const mine = ++reads.current;
    let shown: readonly DirectoryPc[];
    let waiting: readonly DirectoryPc[];
    try {
      const [listed, asking] = await Promise.all([service.listPcs(), service.ownSignIn().then((own) => own ? service.listUnconfirmedPcs() : []).catch((error: unknown) => {
        console.warn("Ovis: the account's unconfirmed PCs could not be read", error instanceof Error ? error.name : error);
        return [];
      })]);
      await readPageList(account);
      shown = pagePcs(account, listed);
      waiting = asking;
    } catch { if (mine === reads.current) setPcs("failed"); return; }
    if (mine !== reads.current) return;
    setPcs(shown);
    setUnconfirmed(waiting);
    const list = pageAccountList();
    // only a device that may write the list adds a PC to it
    if (list === null || pageListReading(account) !== "in" || list.writer() === null || !shown.some((pc) => pc.not_in_list === true || pc.by_list === true)) { setPosts(null); return; }
    const posted = await postedPcs(list).catch((error: unknown) => {
      console.warn("Ovis: the PCs that ask to be added could not be read", error instanceof Error ? error.name : error);
      return null;
    });
    // classified by the list as it stands once they are read (listPcs.ts classified)
    if (mine === reads.current) setPosts(posted === null ? null : classified(list, posted));
  }, [service, account]);
  useEffect(() => {
    void read();
    const changed = () => { void read(); };
    window.addEventListener(ACCOUNT_PCS_CHANGED_EVENT, changed);
    // the account's list moved (another device added a PC, or put one out): the rows are drawn again from it
    const unfollow = pageAccountList()?.subscribe(changed);
    return () => { window.removeEventListener(ACCOUNT_PCS_CHANGED_EVENT, changed); unfollow?.(); };
  }, [read]);
  const now = Date.now();
  return (
    <section className="account-manage-part" aria-label={t("PCs")}>
      <h3 className="account-manage-h">{t("PCs")}</h3>
      <ul className="account-manage-list" data-testid="account-pcs">
        {pcs === null ? <li className="account-manage-row account-manage-dim" role="status">{t("Loading…")}</li>
          : pcs === "failed" ? <li className="account-manage-row account-manage-dim" role="alert">{t("PCs could not be loaded.")}</li>
          : pcs.map((pc) => {
            // a PC the list holds that the account service gives no way to: off, as far as this device can tell, and removable
            const off = offlinePc(pc, now) || (pc.by_list === true && pc.relay === null);
            const listed = watching ? undefined : posts?.find((each) => each.server_id === pc.server_id);
            // Add here: a PC the list does not hold yet, or one the move carried in, for its keys. Keys the list holds
            // by another device's entry are taken by the PC from that device alone: its row names it, and offers no Add
            const post = listed !== undefined && (listed.for.kind === "keys" || (listed.for.kind === "add" && pc.not_in_list === true)) ? listed : undefined;
            const signer = listed?.for.kind === "signer" ? listed.for.signer : null;
            const signerName = signer === null ? null : pageAccountList()?.view().devices.find((device) => device.key === signer)?.name?.label ?? t("another device of your account");
            return (
              <li key={pc.server_id} className="account-manage-row" data-pc-id={pc.server_id}>
                <StatusDot state={off ? "offline" : "ready"} />
                <span className="visually-hidden">{off ? t("Offline") : t("Online")}</span>
                {/* no keys posted: not added from that PC yet, or its Ovis is from before lists; both are said */}
                <span className="account-manage-name">{pc.label}{pc.not_in_list === true && <span className="settings-hint" data-pc-note=""> · {t("Not in your account's list yet")}{posts !== null && post === undefined && !watching ? ` · ${t("Add it from that PC (ovis add, or Add this PC to my account there); update an Ovis older than 0.5.10 first")}` : ""}</span>}
                  {pc.needs_keys === true && <span className="settings-hint" data-pc-note=""> · {t("No key of its own in your account's list yet")}{posts !== null && post === undefined && signerName === null && !watching ? ` · ${t("Run ovis add on that PC to give it one, and compare the number with this device")}` : ""}</span>}
                  {signerName !== null && <span className="settings-hint" data-pc-note=""> · {t("Only {device} can finish giving it its keys: compare the number on {device}", { device: signerName })}</span>}</span>
                {post !== undefined && <button type="button" className="btn account-head-btn" data-action="add-pc" onClick={() => setAdding({ pc, post })}>{t("Add|account pc")}</button>}
                {/* On an account with no list, a PC in use lists itself again on its next pull: only an offline one is
                    offered, whatever its age. A PC the account's list holds comes back only as a new PC: on or off */}
                {(off || pc.by_list === true) && !watching && <button type="button" className="btn account-head-btn" data-action="remove-pc" onClick={() => setAsked({ ...pc, held: heldRemoval(account, pc.server_id) })}>{t("Remove")}</button>}
              </li>
            );
          })}
        {Array.isArray(pcs) && unconfirmed.map((pc) => (
          <li key={pc.server_id} className="account-manage-row" data-pc-id={pc.server_id} data-unconfirmed-pc-row="">
            <StatusDot state="needs-you" />
            <span className="account-manage-name">{accountLabel(pc.label)}<span className="settings-hint" data-pc-note=""> · {t("Not added: listed with a sign-in code")}</span></span>
            {/* removed by its listing's ID only, so a listing replaced or added meanwhile is never the one removed */}
            {!watching && typeof pc.listing_id === "string" && <button type="button" className="btn account-head-btn" data-action="remove-pc" onClick={() => setAsked({ ...pc, held: null })}>{t("Remove")}</button>}
          </li>
        ))}
      </ul>
      {removal.prompt !== null && <p className="settings-condition">{removal.prompt}</p>}
      {adding !== null && pageAccountList() !== null && (
        <AddPcByNumber list={pageAccountList()!} account={account} post={adding.post} name={adding.pc.label} keys={adding.post.for.kind === "keys"} onClose={() => setAdding(null)} onAdded={() => setAdding(null)} />
      )}
      {asked !== null && (
        <ConfirmDialog title={t("Remove {name} from your account?", { name: asked.label })}
          body={asked.unconfirmed === true
            ? t("{name} was listed in your account with a sign-in code and never added. It leaves your account; to add it later, start again on {name}.", { name: accountLabel(asked.label) })
            : asked.by_list === true
            ? t("{name} leaves your account's list on every device, and your account's devices no longer open it; a device paired with {name} itself still does. It comes back to your account only as a new PC, added again on {name}.", { name: asked.label })
            : t("{name} leaves your account's PCs on every device. Once {name} is online again it leaves your account too: your account's devices no longer open it, and a device paired with {name} itself still does. To use it with your account again, add it on {name}.", { name: asked.label })}
          confirmLabel={t("Remove")} onClose={() => setAsked(null)}
          onConfirm={async () => {
            // a removal that wants a fresh sign-in first closes the question: its Sign in again, below the list, removes it
            // a listing that was never added is removed by its ID (account#67), as its card's No removes it
            const listing = asked.unconfirmed === true && typeof asked.listing_id === "string" ? asked.listing_id : undefined;
            if (listing !== undefined) listingRemovals.current.add(asked.server_id);
            try { await removal.remove(await signInOfAccount(service, account), asked.server_id, listing, asked.unconfirmed === true ? undefined : asked.held, asked.by_list === true); } catch (error) {
              console.warn("Ovis: the PC was not removed from the account", error instanceof Error ? error.name : error);
              throw new Error(pcRemovalFailure(error, t, t("{name} could not be removed. Try again.", { name: asked.label })));
            }
            setAsked(null);
          }} />
      )}
    </section>
  );
}
