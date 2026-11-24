/**
 * Manage account's devices for an account whose signed list this device is in (docs/account-list.md, "Putting a
 * member out"): the devices the list holds, by the names this device opens, each saying what it may do, and a key
 * the list holds with no name. A device of power `full` removes any of them, and with it what came in through it
 * where the person ticks it; the removal is the list's, so the key never comes back.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { listView } from "../../shared/account-list.ts";
import type { AccountList, AccountListView, ListedDevice } from "../lib/account/accountList.ts";
import { inList, type Shown } from "../lib/account/listLeave.ts";
import { cameInThrough, carriedPcs, removeFromList, scopeOf, type Arrival, type RemoveOutcome } from "../lib/account/listRemoveDevice.ts";
import { LIST_WRITE_WAITING_EVENT } from "../lib/account/listWrite.ts";
import { pageAccountList } from "../lib/account/pageList.ts";
import { currentLocale, useT, type Translate } from "../lib/i18n.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** The page's list as it shows now, kept current. */
export function useListView(list: AccountList | null): AccountListView | null {
  const [view, setView] = useState<AccountListView | null>(() => list?.view() ?? null);
  useEffect(() => {
    if (list === null) { setView(null); return; }
    setView(list.view());
    // read again at each word that it changed: the list's own view is the one to draw
    return list.subscribe(() => setView(list.view()));
  }, [list]);
  return view;
}

/** Whether Manage account draws the account's devices from its list: this device follows it and is in it. */
export function showsListDevices(view: AccountListView | null, account: string): view is AccountListView {
  return view !== null && view.account === account && view.status.at === "following" && view.status.standing === "in";
}

/** A row of the list: a device, or a key the list holds that no kind made anything (`key` alone). */
type Row = { readonly kind: "device"; readonly device: ListedDevice } | { readonly kind: "signer"; readonly key: string };

const keyOf = (row: Row): string => (row.kind === "device" ? row.device.key : row.key);

/** What a row says besides its name: this device, a device that only watches, a browser that is let in for a while. */
export function roleOf(t: Translate, device: ListedDevice): string | null {
  if (device.self) return t("This device");
  if (device.role === "watch") return t("View only");
  if (device.until !== null) return t("Borrowed browser, until {time}", { time: new Date(device.until * 1000).toLocaleString(currentLocale(), { weekday: "short", hour: "2-digit", minute: "2-digit" }) });
  return null;
}

/** What the person is told when a removal did not go through: never that it did. */
function failureOf(t: Translate, outcome: Exclude<RemoveOutcome, { removed: true }>, name: string, total: number, asked: string): string {
  if (outcome.why === "stopped") return t("The account service cannot change the list right now. To remove a device, use Revoke on each PC.");
  if (outcome.placed > 0) return t("{done} of {total} were removed. Try again for the rest.", { done: String(outcome.placed), total: String(total) });
  // the request went out and no answer came, and the log could not be read: it may have been placed
  if (outcome.why === "unknown") return t("Whether {name} was removed is not known yet. Look at the list again in a moment.", { name });
  if (outcome.why === "clock") return t("This device's clock looks wrong. Check its date and time, then try again.");
  // a request this device signed for another change (an Allow, say) waits at this head: that change's card tries it again or cancels it
  if (outcome.why === "waiting") return t("An earlier change is still waiting: try it again or cancel it first.");
  // the copy this device holds cannot be written to (two histories, a stopped list, one it cannot read): a retry says the same
  if (outcome.why === "blocked") return t("This device cannot change your account's list right now.");
  if (outcome.why === "changed") return t("Your sign-in changed while this was asked. Nothing was removed.");
  // the question named a key the device has handed on: the person is asked again, for the key it holds now
  if (outcome.why === "handed") return outcome.heirs?.[asked] !== undefined
    ? t("{name} moved to a new key since you asked. Nothing was removed: press Remove again to remove it.", { name })
    : t("Something you ticked moved to a new key since you asked. Nothing was removed: press Remove again to remove it.");
  return t("{name} could not be removed. Try again.|device", { name });
}

/** The name a removal's question gives what came in through a key: by the view's names. */
export function arrivalNameOf(t: Translate, view: AccountListView, arrival: Arrival): string {
  if (arrival.kind === "pc") return view.pcs.find((pc) => pc.endpoint === arrival.endpoint)?.name?.label ?? t("Unnamed PC");
  if (arrival.kind === "signer") return t("Unknown key");
  return view.devices.find((device) => device.key === arrival.key)?.name?.label ?? t("Unnamed device");
}

export function ListDevices({ list, view, onLeave }: { readonly list: AccountList; readonly view: AccountListView; readonly onLeave?: (shown: Shown) => Promise<void> }) {
  const t = useT();
  const [asked, setAsked] = useState<Row | "self" | null>(null);
  // what Disconnect's question was drawn for: the account, the list and this device's key in it, as shown when it opened
  const [leaving, setLeaving] = useState<Shown | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // what this device may sign on, as its copy stands with this view: only a device of power `full` removes anybody
  const writer = list.writer();
  const nameless = writer === null ? [] : listView(writer.state).signers.map((row) => row.key);
  const rows: Row[] = [...view.devices.map((device): Row => ({ kind: "device", device })), ...nameless.map((key): Row => ({ kind: "signer", key }))];
  const nameOf = (row: Row): string => (row.kind === "signer" ? t("Unknown key") : row.device.name?.label ?? t("Unnamed device"));

  return (
    <section className="account-manage-part" aria-label={t("Devices")}>
      <h3 className="account-manage-h">{t("Devices")}</h3>
      <ul className="account-manage-list" data-testid="account-devices" data-source="list">
        {rows.map((row) => {
          const self = row.kind === "device" && row.device.self;
          const role = row.kind === "device" ? roleOf(t, row.device) : null;
          // the same device, in by a key it handed its place on to: said quietly, with the day
          const moved = row.kind === "device" && row.device.moved !== undefined
            ? t("Moved to a new key on {day}", { day: new Date(row.device.moved * 1000).toLocaleDateString(currentLocale(), { month: "short", day: "numeric" }) }) : null;
          return (
            <li key={keyOf(row)} className="account-manage-row" data-list-device={row.kind}>
              <span className="account-manage-name account-manage-named">
                <span className="account-manage-line">{nameOf(row)}</span>
                {role !== null && <span className="account-manage-dim account-manage-tag">{role}</span>}
                {moved !== null && <span className="account-manage-dim account-manage-tag" data-testid="list-device-moved">{moved}</span>}
              </span>
              {self && onLeave && view.account !== null && <button type="button" className="btn account-head-btn" data-action="leave-account" onClick={() => { setLeaving({ account: view.account!, scope: scopeOf(view) }); setAsked("self"); }}>{t("Disconnect")}</button>}
              {!self && writer !== null && <button type="button" className="btn account-head-btn" data-action="remove-device" onClick={() => { setNote(null); setAsked(row); }}>{t("Remove")}</button>}
            </li>
          );
        })}
      </ul>
      {note !== null && <p className="settings-condition" role="status" data-testid="list-device-note">{note}</p>}
      {asked === "self" && onLeave && leaving !== null && (
        <ConfirmDialog title={t("Remove this device?")} body={t("Every PC of the account removes this device. To use it again, sign in on it and allow it from another device.")}
          confirmLabel={t("Disconnect")} onClose={() => setAsked(null)} onConfirm={async () => { await onLeave(leaving); setAsked(null); }} />
      )}
      {asked !== null && asked !== "self" && (
        <RemoveDialog list={list} view={view} removing={keyOf(asked)} name={nameOf(asked)} ticked={false}
          onClose={() => setAsked(null)} onRemoved={(name) => { setAsked(null); setNote(t("{name} was removed from your account.", { name })); }} />
      )}
    </section>
  );
}

/**
 * Remove's question. The key goes for good; what came in through it is listed by name below, each to tick: a lost
 * phone may have let in the person's own PCs, a stolen one the thief's devices. `ticked`: whether every item is
 * ticked at first, as for Not me on a device the person does not know, whose additions are suspect; each can be
 * left out either way. Invites it placed go void by themselves and are not named.
 */
export function RemoveDialog({ list, view, removing, name, ticked, onClose, onRemoved }: {
  readonly list: AccountList;
  readonly view: AccountListView;
  readonly removing: string;
  readonly name: string;
  readonly ticked: boolean;
  readonly onClose: () => void;
  readonly onRemoved: (name: string) => void;
}) {
  const t = useT();
  // read when the question opens: what came in through the key, by the list this device holds now
  const [arrivals] = useState<readonly Arrival[]>(() => {
    const writer = list.writer();
    return writer === null ? [] : cameInThrough(writer.state, removing, writer.keys.key, carriedPcs(list));
  });
  // the keys asked for that were handed on to a new key since, by the key they were handed to: asked again for that one
  const [heirs, setHeirs] = useState<Readonly<Record<string, string>>>({});
  // a key may have been handed on more than once since the question was drawn: to the key that stands now
  const now = (key: string): string => {
    let at = key;
    for (let steps = 0; heirs[at] !== undefined && steps < 64; steps += 1) at = heirs[at]!;
    return at;
  };
  // what the question was asked for: a sign-in or a list that took its place since signs nothing for it
  const [scope] = useState(() => scopeOf(view));
  const [chosen, setChosen] = useState<ReadonlySet<number>>(() => new Set(ticked ? arrivals.map((_, index) => index) : []));
  const picked = arrivals.filter((_, index) => chosen.has(index));
  const remove = async (): Promise<void> => {
    const outcome = await removeFromList(list, {
      keys: [removing, ...picked.flatMap((arrival) => (arrival.kind === "pc" ? [] : [arrival.key]))].map(now),
      pcs: picked.flatMap((arrival) => (arrival.kind === "pc" ? [arrival.endpoint] : [])),
    }, { scope, operation: `${ticked ? "not-me" : "remove"}:${removing}` }).catch((error: unknown): RemoveOutcome => {
      console.warn("Ovis: the device was not removed from the account's list", error instanceof Error ? error.name : error);
      return { removed: false, why: "unreached", retryAfterMs: null, placed: 0 };
    });
    if (!outcome.removed && outcome.why === "handed") setHeirs((before) => ({ ...before, ...outcome.heirs }));
    // the change that waits is shown with its own Try again and Cancel, wherever the page draws its card
    if (!outcome.removed && outcome.why === "waiting") window.dispatchEvent(new Event(LIST_WRITE_WAITING_EVENT));
    if (!outcome.removed) throw new Error(failureOf(t, outcome, name, 1 + picked.length, now(removing)));
    onRemoved(name);
  };
  return (
    <ConfirmDialog title={t("Remove {name} from your account?|device", { name })}
      body={t("{name} loses access to every PC of your account for good. To use it again, sign in on it and allow it from another device.", { name })}
      confirmLabel={t("Remove")} onClose={onClose} onConfirm={remove}>
      {arrivals.length > 0 && (
        <fieldset className="account-manage-through" data-testid="came-in-through">
          <legend className="settings-description">{t("Came in through {name}:", { name })}</legend>
          {arrivals.map((arrival, index) => (
            <label key={arrival.kind === "pc" ? arrival.endpoint : arrival.key} className="account-manage-through-row">
              <input type="checkbox" checked={chosen.has(index)}
                onChange={() => setChosen((now) => { const next = new Set(now); if (!next.delete(index)) next.add(index); return next; })} />
              <span className="settings-label">{arrivalNameOf(t, view, arrival)}</span>
            </label>
          ))}
          <p className="settings-hint">{t("If {name} was stolen, tick what you did not add yourself.", { name })}</p>
          {picked.some((arrival) => arrival.kind === "pc") && <p className="settings-hint" data-testid="pcs-added-again">{t("These PCs will need to be added again.")}</p>}
        </fieldset>
      )}
    </ConfirmDialog>
  );
}

/**
 * Not me on a device from anywhere a page draws one (the move's notice, ListMoveNotice's `notMeDevice`): `notMe(key,
 * name)` asks Remove's question for that key with every item ticked, as the new-device notice's Not me does; `dialog`
 * is drawn where the caller draws it. Nothing is asked on a device that may remove nobody.
 */
export function useNotMe(list: AccountList | null = pageAccountList()): { readonly notMe: (key: string, name: string) => void; readonly dialog: ReactNode } {
  const view = useListView(list);
  const [asked, setAsked] = useState<{ readonly key: string; readonly name: string } | null>(null);
  const notMe = useCallback((key: string, name: string): void => setAsked({ key, name }), []);
  const close = (): void => setAsked(null);
  const dialog = asked !== null && list !== null && view !== null && list.writer() !== null
    ? <RemoveDialog list={list} view={view} removing={asked.key} name={asked.name} ticked onClose={close} onRemoved={close} />
    : null;
  return { notMe, dialog };
}

/**
 * Sign out every device's question, for an account whose list this device is in: every other device leaves the
 * list first, by name, since a device that is only signed out keeps a key that opens the account's PCs. `named`: the
 * devices the question was drawn with, which the press passes on, and no others. `children`: what the question says
 * for any other account.
 */
export function SignOutEverywhereSays({ account, named, children }: { readonly account: string; readonly named: readonly string[]; readonly children: ReactNode }) {
  const t = useT();
  const view = useListView(pageAccountList());
  if (view === null || !inList(view, account)) return <>{children}</>;
  const others = named.map((key) => view.devices.find((device) => device.key === key)?.name?.label ?? t("Unnamed device"));
  return (
    <p className="settings-description" role="status" data-testid="sign-out-everywhere-says">
      {others.length === 0 ? t("Every browser and app is signed out of the account.")
        : t("These devices leave your account for good, then every browser and app is signed out: {names}", { names: others.join(", ") })}
    </p>
  );
}
