/**
 * What a person is told of the move of an account that was in use onto its signed list (docs/account-list.md, "An
 * account that was in use"; Part F, F1 and F11), and nothing else: once, who made the list and every device and PC it
 * brought in, each PC with Not me; and on a device the list carried in that did not join it, why, naming the PCs that
 * said so and what to do. Nothing of the move asks the person to press anything else.
 */
import "./AccountApprovalPrompt.css";
import "./ListMoveNotice.css";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Monitor, Smartphone } from "lucide-react";
import { hexToBytes } from "@noble/hashes/utils.js";

import { deriveServerId } from "../../shared/relay-server-proof.ts";
import type { AccountList, AccountListView } from "../lib/account/accountList.ts";
import { knownPcs } from "../lib/account/knownPcs.ts";
import { removeListPc } from "../lib/account/listRemove.ts";
import { writeScope, type WriteScope } from "../lib/account/listWrite.ts";
import type { MoveNoticeView } from "../lib/account/listMigrate.ts";
import { pageAccountList } from "../lib/account/pageList.ts";
import { useT } from "../lib/i18n.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { NotMeButton } from "./BlockOutcomes.tsx";
import { useNotMe } from "./ListDevices.tsx";

/** The view of `list`, redrawn as it changes. */
function useView(list: AccountList | null): AccountListView | null {
  const [view, setView] = useState<AccountListView | null>(() => list?.view() ?? null);
  useEffect(() => {
    if (list === null) return;
    setView(list.view());
    return list.subscribe(setView);
  }, [list]);
  return view;
}

/** What a Not me is bound to from its press: the account, the list and the member key it was pressed for (X3). */
type NotMeScope = Required<WriteScope>;

/** Puts the PC at `endpoint` out of the list, for the account, list and member key of the press: true once the list took it. */
async function removeFromList(list: AccountList, endpoint: string, scope: NotMeScope): Promise<boolean> {
  const outcome = await removeListPc(list, endpoint, { expect: scope });
  return outcome.removed;
}

/**
 * The one-time notice, drawn where its host puts it. `removePc`: Not me's removal of a PC (the list's own by default).
 * `notMeDevice`: Not me's removal of a device, which asks Remove's question of the devices list with everything ticked
 * (`useNotMe(list).notMe` of ListDevices.tsx, whose `dialog` its host draws beside this); without it a device's row has
 * no Not me here, rather than a button that does nothing.
 */
export function ListMoveNotice({ list = pageAccountList(), removePc, notMeDevice, scrim = false }: {
  readonly list?: AccountList | null;
  /** drawn over a scrim of its own, in the page's body, as a modal is */
  readonly scrim?: boolean;
  readonly removePc?: (endpoint: string, scope: NotMeScope) => Promise<boolean>;
  readonly notMeDevice?: (key: string, name: string) => void;
}) {
  const t = useT();
  const view = useView(list);
  const [notice, setNotice] = useState<MoveNoticeView | null>(null);
  const [asked, setAsked] = useState<{ readonly endpoint: string; readonly name: string; readonly scope: NotMeScope } | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const account = view?.account ?? null;
  const seen = async (): Promise<void> => {
    if (list === null || account === null || notice === null) return;
    await list.noticeSeen?.(account, notice.list).catch((error: unknown) => console.warn("Ovis: the notice of the move stays until it is kept as seen", error instanceof Error ? error.name : error));
    setNotice(null);
  };
  const following = view?.status.at === "following" && view.status.standing === "in";
  useEffect(() => {
    let live = true;
    if (list === null || account === null || !following || list.notice === undefined) { setNotice(null); return; }
    void list.notice(account).then((read) => { if (live) setNotice(read); }, (error: unknown) => {
      console.warn("Ovis: the notice of the move onto the account's list could not be read", error instanceof Error ? error.name : error);
    });
    return () => { live = false; };
  }, [list, account, following, view]);
  /** Whether the device still follows the list of the account, and signs with the member key, a Not me was pressed for. */
  const inScope = (scope: NotMeScope): boolean => {
    const now = list === null ? null : writeScope(list);
    return view !== null && view.account === scope.account && view.status.at === "following" && view.status.list === scope.list
      && now !== null && now.account === scope.account && now.list === scope.list && now.key === scope.key;
  };
  // a question asked for another account, list or member key than the device's now is put away: it acts on nothing
  useEffect(() => {
    if (asked !== null && !busy && !inScope(asked.scope)) setAsked(null);
  });
  // Back answers the question that is asked first, then is the notice's OK; never while a removal is under way
  usePhoneSheetBack(() => {
    if (busy) return false;
    if (asked !== null) { setAsked(null); return false; }
    void seen();
  }, list !== null && account !== null && notice !== null);
  if (list === null || account === null || notice === null) return null;
  const deviceName = (name: MoveNoticeView["devices"][number]["name"]): string => name?.label ?? t("A device of yours");
  const pcName = (name: MoveNoticeView["pcs"][number]["name"]): string => name?.label ?? t("Unnamed PC");

  const remove = async (): Promise<void> => {
    if (asked === null) return;
    if (!inScope(asked.scope)) { setAsked(null); return; }
    setBusy(true);
    try {
      const gone = await (removePc ?? ((endpoint: string, scope: NotMeScope) => removeFromList(list, endpoint, scope)))(asked.endpoint, asked.scope);
      setSaid(gone ? t("{pc} was removed from your account.", { pc: asked.name }) : t("{pc} could not be removed. Try again.", { pc: asked.name }));
      if (gone) setNotice((now) => now === null ? now : { ...now, pcs: now.pcs.filter((pc) => pc.endpoint !== asked.endpoint) });
    } catch (error) {
      console.warn("Ovis: the PC was not removed from the account's list", error instanceof Error ? error.name : error);
      setSaid(t("{pc} could not be removed. Try again.", { pc: asked.name }));
    } finally {
      setBusy(false);
      setAsked(null);
    }
  };
  const title = t("Your account now keeps its own list");
  // the device that made the list, when it is another
  const maker = notice.first.self ? null : notice.first.key;
  const card = (
    <div className="modal account-approval list-move-notice" role="dialog" aria-modal="true" aria-label={title} data-testid="list-move-notice">
      <h2 className="account-approval-title">{title}</h2>
      {maker === null || notMeDevice === undefined
        ? <p className="account-approval-lead">{notice.first.self ? t("This device made your account's list.") : t("{device} made your account's list.", { device: deviceName(notice.first.name) })}</p>
        : (
          // in a birth someone else made, they are its first signer: Not me answers them as it does a device they brought in (R-G)
          <div className="list-move-first">
            <p className="account-approval-lead">{t("{device} made your account's list.", { device: deviceName(notice.first.name) })}</p>
            <NotMeButton sending={false} onPress={() => notMeDevice(maker, deviceName(notice.first.name))} />
          </div>
        )}
      {notice.devices.length + notice.pcs.length > 0 && <>
        <p className="account-approval-hint">{t("It brought these in. Press Not me on one you do not know.")}</p>
        <ul className="list-move-rows">
          {notice.devices.map((row) => (
            <li key={row.key} className="list-move-row">
              <Smartphone aria-hidden="true" />
              <span className="list-move-name">{deviceName(row.name)}</span>
              {notMeDevice !== undefined && <NotMeButton sending={false} onPress={() => notMeDevice(row.key, deviceName(row.name))} />}
            </li>
          ))}
          {notice.pcs.map((row) => (
            <li key={row.endpoint} className="list-move-row">
              <Monitor aria-hidden="true" />
              <span className="list-move-name">{pcName(row.name)}</span>
              <NotMeButton sending={busy && asked?.endpoint === row.endpoint} onPress={() => {
                const scope = writeScope(list);
                setSaid(null);
                if (scope !== null && scope.list === notice.list) setAsked({ endpoint: row.endpoint, name: pcName(row.name), scope });
              }} />
            </li>
          ))}
        </ul>
      </>}
      {notice.removed.map((row) => (
        <p key={row.key} className="account-approval-hint" data-testid="list-move-removed">{t("{device} was removed from your account, as you asked with Not me.", { device: deviceName(row.name) })}</p>
      ))}
      {asked !== null && (
        <div className="list-move-ask" role="alertdialog" aria-label={t("Remove {pc} from your account?", { pc: asked.name })}>
          <p className="account-approval-ask">{t("Remove {pc} from your account?", { pc: asked.name })}</p>
          <div className="account-approval-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => setAsked(null)}>{t("Cancel")}</button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>{t("Remove")}</button>
          </div>
        </div>
      )}
      {said !== null && <p className="account-approval-note" role="status">{said}</p>}
      <div className="account-approval-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void seen()}>{t("OK")}</button>
      </div>
    </div>
  );
  return scrim ? createPortal(<div className="modal-scrim">{card}</div>, document.body) : card;
}

/** A PC's name as this device last read the account's PCs, by its relay key; null where it has none. */
function knownName(account: string, endpoint: string): string | null {
  try {
    const serverId = deriveServerId(hexToBytes(endpoint));
    return knownPcs(account).find((pc) => pc.server_id === serverId)?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * On a device the list carried in, which did not join it (F5): why, naming the PCs that said so, and what to do. It
 * asks to be let in as a new device does meanwhile. And on one that followed it and whose PCs turn out not to know it
 * (V4-6): why, and the reset of this device's copy, after which it asks to be let in the same way. A device that only
 * waits on its PCs is told nothing.
 */
export function ListJoinRefusal({ list = pageAccountList(), pcName, scrim = false }: { readonly list?: AccountList | null; readonly pcName?: (endpoint: string) => string | null; readonly scrim?: boolean }) {
  const t = useT();
  const view = useView(list);
  const [closed, setClosed] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const status = view?.status;
  // what is said: a refusal of the list that carried this device in, or a doubt of the list it follows
  const said = status?.at === "not_in" ? status.refused : status?.at === "following" ? status.doubt : undefined;
  const followed = status?.at === "following";
  const shownFor = status !== undefined && said !== undefined && (status.at === "not_in" || status.at === "following") ? `${status.at}:${status.list}:${said.why}:${said.pcs.join(",")}` : null;
  // Back is Close
  usePhoneSheetBack(() => { if (resetting) return false; setClosed(shownFor); }, shownFor !== null && closed !== shownFor && view?.account != null);
  if (list === null || view === null || view.account === null || said === undefined || shownFor === null || closed === shownFor) return null;
  const account = view.account;
  const names = said.pcs.map((endpoint) => (pcName ?? ((one: string) => knownName(account, one)))(endpoint)).filter((name): name is string => name !== null);
  const pcs = names.length === 0 ? t("One of your PCs") : names.join(", ");
  const line = followed ? (() => {
    switch (said.why) {
      case "other_list": return t("{pc} follows another list of your account.", { pc: pcs });
      case "first_signer_removed": return t("A PC of yours removed the device that made the list this device follows.");
      default: return t("Your PCs do not know the device that made the list this device follows.");
    }
  })() : (() => {
    switch (said.why) {
      case "other_list": return t("{pc} follows another list of your account, so this device did not join yours. Remove {pc} from your account, or reset it there; this device then joins by itself.", { pc: pcs });
      case "first_signer_removed": return t("A PC of yours removed the device that made your account's list, so this device did not join it.");
      case "first_signer_unknown": return t("Your PCs do not know the device that made your account's list, so this device did not join it.");
      default: return t("This device did not join your account's list.");
    }
  })();
  const title = followed ? t("Your PCs do not know the list this device follows") : t("This device is not in your account's list");
  // the reset forgets what this device keeps of the account's list, and nothing else: its keys and its sign-in stay
  const reset = async (): Promise<void> => {
    setResetting(true);
    try { await list.forget(account); }
    catch (error) { console.warn("Ovis: this device's copy of the account's list was not reset", error instanceof Error ? error.name : error); }
    finally { setResetting(false); }
  };
  const card = (
    <div className="modal account-approval" role="alertdialog" aria-modal="true" aria-label={title} data-testid="list-join-refusal" data-why={said.why}>
      <h2 className="account-approval-title">{title}</h2>
      <p className="account-approval-error" role="alert">{line}</p>
      <p className="account-approval-note">{followed ? t("Reset this device's copy of the list, then allow this device from a device that is in the list.") : t("Allow this device from a device that is in the list.")}</p>
      <div className="account-approval-actions">
        <button type="button" className="btn" disabled={resetting} onClick={() => setClosed(shownFor)}>{t("Close")}</button>
        {followed && <button type="button" className="btn btn-danger" disabled={resetting} onClick={() => reset()}>{t("Reset this device's list")}</button>}
      </div>
    </div>
  );
  return scrim ? createPortal(<div className="modal-scrim">{card}</div>, document.body) : card;
}

/**
 * Both, where nothing else draws them: over the start screen and over an opened PC, each over a scrim of its own in the
 * page's body while it is drawn. A carried device's Not me, and that of the device that made the list, is the devices
 * list's Remove, asked with everything ticked.
 */
export function ListMoveNotices({ list = pageAccountList() }: { readonly list?: AccountList | null }) {
  const { notMe, dialog } = useNotMe(list);
  return <><ListMoveNotice list={list} scrim notMeDevice={notMe} />{dialog}<ListJoinRefusal list={list} scrim /></>;
}
