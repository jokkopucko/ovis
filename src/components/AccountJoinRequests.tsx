import { Monitor } from "lucide-react";
import { useEffect, useState } from "react";
import { pageListAdds, type ListAdds, type ListedPost } from "../lib/account/listPcs.ts";
import { ACCOUNT_PCS_CHANGED_EVENT, myPcs, newPcs, type MyPc } from "../lib/account/myPcs.ts";
import { ACCOUNT_SIGN_OUT_EVENT, indexedAccountService, SignedOutError, type AccountService, type DirectoryPc } from "../lib/account/service.ts";
import type { AccountSession } from "../lib/account/store.ts";
import { useT } from "../lib/i18n.ts";
import { indexedDeviceStore, type RelayDevice } from "../lib/relay/device.ts";
import { serverScopePath } from "../lib/shellMode.ts";
import { AddPcByNumber } from "./AddPcByNumber.tsx";
import { usePcRemoval } from "./usePcRemoval.tsx";

import "./DevicePairedNotice.css";
import "./UpdateControls.css";

/**
 * `ids`: each shown row's own listing ID (account#57), as rendered, which its Decline names. `lists`: the account's
 * signed list, where it keeps one (listPcs.ts ListAdds).
 */
type Asking = { readonly session: AccountSession; readonly pcs: readonly MyPc[]; readonly listings: ReadonlyMap<string, string>; readonly ids: ReadonlyMap<string, string>; readonly lists: ListAdds };

/** One listing of a PC: a PC that asks again after a Decline is listed anew, so its new request is not the declined one. */
const listingOf = (pc: DirectoryPc): string => pc.listing_id ?? `${pc.server_id}@${pc.added_at}`;

/** The PCs still asking to join, each with the listing it asks by. */
function askingPcs(listed: readonly DirectoryPc[], here: readonly RelayDevice[], now: number): { pcs: MyPc[]; listings: Map<string, string>; ids: Map<string, string> } {
  return { pcs: newPcs(myPcs(listed, here, { now }), now), listings: new Map(listed.map((pc) => [pc.server_id, listingOf(pc)])),
    ids: new Map(listed.flatMap((pc) => typeof pc.listing_id === "string" ? [[pc.server_id, pc.listing_id] as const] : [])) };
}

/**
 * A PC that asks to join the account, as the PC's own Add this PC to my account leaves it when its one press is refused
 * ("On another device of your account, choose Add on {name}"): listed by an own sign-in, never in yet (it has not pulled
 * the account's mailbox), its request under ten minutes old, with a key its id is derived from (myPcs `join`, newPcs),
 * and no pairing of this device with it. A launch that goes straight into another PC never shows its join card, so this
 * device says so here: Allow opens that PC's own page, whose join takes the number the PC's screen shows and the PC's
 * approval (the guards of every join, AddPcSheet). Decline denies the request: it removes the listing with this sign-in
 * (DELETE /v1/pcs/:id), so no device shows it and the PC is not added; the waiting PC ends its wait (AccountSection
 * deniedElsewhere) and asks again only by a new press. Only an app's own sign-in is offered either. A Decline first reads
 * the directory again and removes the PC only while the listing it shows still asks: a card left open while another
 * device let the PC in (or the PC asked again) is refreshed instead, and a declined card hides that listing only, so the
 * PC's new press is shown. The removal names that listing (account#67), so one that changes between that read and the
 * removal is not removed either: the service refuses it and the card is refreshed the same way.
 *
 * On an account that keeps a signed list (docs/account-list.md, "Adding a PC") the card never ends in that join, which
 * is the directory's admission alone: it is shown only for a PC that posted its keys for the list, and its Allow asks
 * for the number both screens show (AddPcByNumber), confirmed at the PC, then Add. A PC that posted nothing gets no card.
 */
const pairedHere = (): Promise<readonly RelayDevice[]> => indexedDeviceStore.list();
const openPcPage = (serverId: string): void => window.location.assign(serverScopePath(serverId));

export function AccountJoinRequests({ service = indexedAccountService, devices = pairedHere, now = Date.now, open = openPcPage, listOf = pageListAdds }: {
  readonly service?: AccountService;
  readonly devices?: () => Promise<readonly RelayDevice[]>;
  readonly now?: () => number;
  readonly open?: (serverId: string) => void;
  /** what this device knows of `account`'s signed list (ListAdds); a test's own */
  readonly listOf?: (account: string) => Promise<ListAdds>;
}) {
  const t = useT();
  const [asking, setAsking] = useState<Asking | null>(null);
  // the PC whose number is asked for, on an account that keeps a list, and the account it was asked for under: the
  // dialog shows only while that account is the one signed in to here, and that account's list is the one read
  const [adding, setAdding] = useState<{ readonly account: string; readonly pc: MyPc; readonly post: ListedPost } | null>(null);
  // the declined listings, so a new request from the same PC is shown
  const [denied, setDenied] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // a Decline is a removal (PCR-1): one the service wants a fresh own sign-in for says so, with Sign in again, in its card
  const removal = usePcRemoval(service, (serverId) => {
    const listing = asking?.listings.get(serverId);
    if (listing !== undefined) setDenied((prior) => new Set([...prior, listing]));
    window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT));
  });
  useEffect(() => {
    let version = 0;
    const read = async (): Promise<void> => {
      const mine = ++version;
      try {
        const session = await service.session();
        if (mine !== version) return;
        if (session === undefined) { setAsking(null); return; }
        const directory = service.forSignIn(session);
        const [own, listed, here, lists] = await Promise.all([directory.ownSignIn(), directory.listPcs(), devices(), listOf(session.account)]);
        if (mine !== version) return;
        // a device code's sign-in is no one's to let a PC in or turn it away with
        setAsking(own ? { session, ...askingPcs(listed, here, now()), lists } : null);
      } catch (error) {
        if (mine !== version) return;
        if (error instanceof SignedOutError) setAsking(null);
        else if (error instanceof Error) console.warn("Ovis: the PCs asking to join could not be read", error.name);
        else throw error;
      }
    };
    const visibleRead = (): void => { if (document.visibilityState === "visible") void read(); };
    void read();
    document.addEventListener("visibilitychange", visibleRead);
    window.addEventListener("focus", visibleRead);
    window.addEventListener(ACCOUNT_SIGN_OUT_EVENT, visibleRead);
    window.addEventListener(ACCOUNT_PCS_CHANGED_EVENT, visibleRead);
    return () => {
      version++;
      document.removeEventListener("visibilitychange", visibleRead);
      window.removeEventListener("focus", visibleRead);
      window.removeEventListener(ACCOUNT_SIGN_OUT_EVENT, visibleRead);
      window.removeEventListener(ACCOUNT_PCS_CHANGED_EVENT, visibleRead);
    };
  }, [service, devices, now, listOf]);

  if (asking === null) return null;
  const deny = async (pc: MyPc): Promise<void> => {
    if (busy !== null) return;
    setBusy(pc.server_id);
    setFailed(null);
    try {
      // only the request this card shows: one another device let in, or the PC renewed by a new press, is not declined
      const [listed, here] = await Promise.all([service.forSignIn(asking.session).listPcs(), devices()]);
      const current = askingPcs(listed, here, now());
      const shown = asking.listings.get(pc.server_id);
      if (shown === undefined || current.listings.get(pc.server_id) !== shown || !current.pcs.some((still) => still.server_id === pc.server_id)) {
        window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT));
        return;
      }
      // the re-read above is only the guard: the removal names the listing this card was rendered with
      await removal.remove(asking.session, pc.server_id, asking.ids.get(pc.server_id));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setFailed(pc.server_id);
    } finally { setBusy(null); }
  };
  const { lists } = asking;
  // on an account that keeps a list, only a PC that posted for it is asked about, and only by its number (as My PCs and
  // Manage account read it: listPcs.ts postedFor; keys another device's entry holds are that device's to finish)
  const postOf = (pc: MyPc): ListedPost | undefined => lists?.posts.find((post) => post.server_id === pc.server_id && post.for.kind !== "signer");
  const allow = (pc: MyPc): void => {
    if (lists === null) { open(pc.server_id); return; }
    const post = postOf(pc);
    if (post !== undefined) setAdding({ account: asking.session.account, pc, post });
  };
  const shown = asking.pcs.filter((pc) => !denied.has(asking.listings.get(pc.server_id) ?? "") && (lists === null || postOf(pc) !== undefined));
  return <>
    {shown.map((pc) => (
    <div key={pc.server_id} className="update-notice is-paired device-notice" role="status" data-join-request={pc.server_id}>
      <Monitor aria-hidden="true" />
      <span className="device-notice-text">
        <span>{t("\"{name}\" asks to join your account", { name: pc.name })}</span>
        {failed === pc.server_id && <span className="account-error" role="alert">{t("The request could not be declined. Try again.")}</span>}
        {removal.promptFor === pc.server_id && removal.prompt}
      </span>
      <div className="device-paired-actions">
        <button type="button" className="btn" disabled={busy !== null} onClick={() => allow(pc)}>{t("Allow")}</button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void deny(pc)}>{t("Decline")}</button>
      </div>
    </div>
    ))}
    {adding !== null && lists !== null && adding.account === asking.session.account && lists.account === adding.account && (
      <AddPcByNumber list={lists.list} account={asking.session.account} post={adding.post} name={adding.pc.name} keys={adding.post.for.kind === "keys"}
        onClose={() => setAdding(null)} onAdded={() => { setAdding(null); window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT)); }} />
    )}
  </>;
}
