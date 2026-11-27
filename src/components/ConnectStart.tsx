import { Fragment, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Plus, QrCode } from "lucide-react";

import { useT, type Translate } from "../lib/i18n.ts";
import { pageListAdds, type ListAdds, type ListedPost } from "../lib/account/listPcs.ts";
import { indexedAccountService } from "../lib/account/service.ts";
import { pageAccountList } from "../lib/account/pageList.ts";
import { callNative, hasNativeMethod, hasNativePlugin } from "../lib/nativeApp.ts";
import { isLoopbackHost, tailnetHost } from "../lib/phone.ts";
import { endPairCodeComposition, typePairCode } from "../lib/pairCodeInput.ts";
import type { KnownPc } from "../lib/account/knownPcs.ts";
import type { MyPc } from "../lib/account/myPcs.ts";
import { serverIdOfPath, serverScopePath } from "../lib/shellMode.ts";
import { markRemovedPc, removedPcs, type RemovedPcMark } from "../lib/relay/shellState.ts";
import { StartScreenAccountMenu } from "./AccountHead.tsx";
import { AddPcByNumber } from "./AddPcByNumber.tsx";
import { followUnlessOffline, useOffline } from "../lib/useOffline.ts";
import { AddressForm, atDots, canScanQr, clearOutcome, offlineOpenText, OpenError, OpenStatus, OtherWayButton, scanQr, sshHandoff, TailscaleOff, tailscaleOn, useAddressOpen, Way, type AddressOpen, type SavedPc } from "./RelayAddPc.tsx";
import { codeFailureText, type TypedCodeFailure } from "./codeFailureText.ts";
import { InvitePc } from "./InvitePc.tsx";
import { SheepMascot } from "./SheepMascot.tsx";
import { StatusDot, type StatusDotState } from "./StatusDot.tsx";

export type ConnectWay = "relay" | "tailscale" | "ssh";
const CONNECT_WAYS: readonly ConnectWay[] = ["relay", "tailscale", "ssh"];

/** The phone app's shell plugin (app/android HerdrShellPlugin): the PCs this phone opened, and whether Tailscale is on. */
export const SHELL = "HerdrShell";

/**
 * A PC the phone app saved, by the way it connects: at a Tailscale address, added over SSH (a loopback address on the
 * phone), or at any other address; `serverId`, the relay ID its own page told the app (HerdrShell identify), where it did.
 */
export interface PhoneSavedPc { readonly origin: string; readonly host: string; readonly name: string; readonly way: "tailscale" | "ssh" | "address"; readonly serverId?: string }

const SERVER_ID = /^[0-9a-f]{32}$/;

/**
 * The PCs the phone app opened (app/web/shell.js `tabPcs`, the app's own lists), each by the way it connects, for My
 * PCs: a phone has no list of its tailnet's machines, only the ones opened here. A page of the app's origin
 * (`appOrigin`: the relay's, listed by the relay) and an unreadable entry are on neither. `saved`, `names` and `ids` as
 * HerdrShell's getState gives them; a MagicDNS name goes by its first label, an address by itself.
 */
export function phoneSavedPcs(saved: readonly string[], names: Readonly<Record<string, string>>, appOrigin: string, ids: Readonly<Record<string, string>> = {}): PhoneSavedPc[] {
  return saved.flatMap((origin) => {
    let url: URL;
    try { url = new URL(origin); } catch { return []; }
    if (url.origin === appOrigin) return [];
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const way = tailnetHost(host) ? "tailscale" : isLoopbackHost(host) ? "ssh" : "address";
    const short = host.toLowerCase().endsWith(".ts.net") ? host.split(".")[0]! : url.host;
    const serverId = Object.hasOwn(ids, origin) && SERVER_ID.test(ids[origin]!) ? ids[origin]! : undefined;
    return [{ origin, host: url.host, name: names[origin] || short, way, ...(serverId === undefined ? {} : { serverId }) }];
  });
}

/** One PC of My PCs: its relay row, and the ways the phone app saved it by whose own page said that PC's relay ID. */
export interface PcGroup { readonly relay?: RelayTabPc | undefined; readonly phones: readonly PhoneSavedPc[] }

/**
 * One row per PC: a way the phone app saved whose own page said its relay ID (PhoneSavedPc `serverId`) goes with the
 * relay row of that ID, else with the other saved ways of the same ID. A way with no ID is a row of its own, never put
 * with another by its name. The relay rows first, in their order, then the rest in the app's.
 */
export function onePcRows(relay: readonly RelayTabPc[], phones: readonly PhoneSavedPc[]): PcGroup[] {
  const groups: { relay?: RelayTabPc; phones: PhoneSavedPc[] }[] = relay.map((row) => ({ relay: row, phones: [] }));
  const byId = new Map(groups.map((group) => [group.relay!.server_id, group]));
  for (const pc of phones) {
    const same = pc.serverId === undefined ? undefined : byId.get(pc.serverId);
    if (same) { same.phones.push(pc); continue; }
    const own = { phones: [pc] };
    groups.push(own);
    if (pc.serverId !== undefined) byId.set(pc.serverId, own);
  }
  return groups;
}

/**
 * The way a row of several opens by. One with a relay row always opens by the relay, whose key is checked (and whose
 * connection stays on the relay unless its PC turned Direct connection on): the ways the app saved by an address only
 * put themselves on its row and its More ways, they never decide how its tap opens (null: the relay). One with none
 * opens by the saved way whose page loaded in the app last (`recent`, the app's saved list, newest first: it moves an
 * entry to the front each time its page loads), else the first.
 */
export function openWay(group: PcGroup, recent: readonly string[]): PhoneSavedPc | null {
  if (group.relay !== undefined) return null;
  const rank = (key: string): number => { const at = recent.indexOf(key); return at < 0 ? Infinity : at; };
  return [...group.phones].sort((a, b) => rank(a.origin) - rank(b.origin))[0] ?? null;
}

/** The saved way a row of several offers when opening it by `by` failed or was refused: the first of the others, or none. */
export function otherWay(group: PcGroup, by: PhoneSavedPc | null): PhoneSavedPc | null {
  return group.phones.find((pc) => pc !== by) ?? null;
}

/** A saved way's tag, as a row of My PCs and the button that opens a PC by another way (OtherWayButton) show it. */
export function savedWayTag(t: Translate, pc: Pick<PhoneSavedPc, "way">): string {
  return pc.way === "address" ? t("Address") : pc.way === "ssh" ? "SSH" : "Tailscale";
}

/** what this device's own check last found of a PC, where it settled it: it answered, or the relay found it off */
export type CheckedPc = "online" | "off";

/** A relay PC of My PCs: this phone's own pairing (`saved`, by a QR or a code), or one of the account's. */
export interface RelayTabPc {
  readonly server_id: string; readonly name?: string | undefined; readonly status?: "online" | "off" | "update" | "removed" | undefined; readonly saved: boolean;
  /** the account has a list of its devices and PCs, and this device does not find the PC in it (myPcs `notInList`): the row says so */
  readonly outside?: true;
  /** the account's list holds the PC and the account service names no way to it: the row stays, off, and opens nothing */
  readonly noWay?: true;
}

/**
 * The relay PCs this phone is on: its own pairings, then, signed in, the account's PCs it can open (one its own page can
 * join) that are not among them, so a PC both paired here and in the account is listed once, as this phone's. What this
 * device knows itself comes before the account's word: a pairing's saved Ovis too old, or what its last check found
 * (`status`, RelayShell); an account PC's check that settled (`checked`). Then the account: too old needs an update, off
 * is off, and any other account PC is on, whether or not this phone is let into it yet (its own page asks for that), as
 * is a pairing of this phone's that the directory lists (one it does not list, it says nothing of). One
 * that turned this phone away as removed (`removed`, shellState removedPcs) says so, never on, until this phone opens it
 * again, and is left out once forgotten from the list. While the account cannot be read now (`unread`: no internet, or
 * the account service down), its word is no longer said: a PC is on or off only by this device's own check. `known`:
 * then, the account's PCs it listed last (knownPcs), with no state word, each that is not listed already.
 */
export function relayTabPcs(devices: readonly SavedPc[], account: readonly MyPc[] | null, removed: Readonly<Record<string, RemovedPcMark>> = {}, checked: ReadonlyMap<string, CheckedPc> = new Map(), { known = [], unread = false }: { readonly known?: readonly KnownPc[] | undefined; readonly unread?: boolean } = {}): RelayTabPc[] {
  const listed = new Map((account ?? []).map((pc) => [pc.server_id, pc]));
  const own = devices.map((device): RelayTabPc => {
    const row = listed.get(device.server_id);
    return { server_id: device.server_id, name: device.name, status: device.status ?? (row?.state === "needs-update" ? "update" : unread ? undefined : row?.state === "offline" ? "off" : row?.listed ? "online" : undefined), saved: true };
  });
  // a PC the account's list holds stays a row also where the account service names no way to it: it is the account's
  // by the list's word, and only that it cannot be reached now is the service's
  const more = (account ?? []).filter((pc) => !pc.paired && (pc.join !== undefined || pc.byList === true) && !own.some((row) => row.server_id === pc.server_id) && removed[pc.server_id] !== "hidden")
    .map((pc): RelayTabPc => pc.join === undefined ? { server_id: pc.server_id, name: pc.name, status: "off", saved: false, noWay: true }
      : { server_id: pc.server_id, name: pc.name, status: removed[pc.server_id] === "removed" ? "removed" : pc.state === "needs-update" ? "update" : checked.get(pc.server_id) ?? (unread ? undefined : pc.state === "offline" ? "off" : "online"), saved: false, ...(pc.notInList === true ? { outside: true as const } : {}) });
  const rows = [...own, ...more];
  const kept = known.filter((pc) => !rows.some((row) => row.server_id === pc.server_id) && removed[pc.server_id] !== "hidden")
    .map((pc): RelayTabPc => ({ server_id: pc.server_id, name: pc.name, status: removed[pc.server_id] === "removed" ? "removed" : undefined, saved: false }));
  return [...rows, ...kept];
}

/** What a row of My PCs says of its PC after its name: the account's word for it, or that this is the PC in use now. */
type PcWord = "online" | "off" | "update" | "removed" | "in-use";

const WORD_DOT: Partial<Record<PcWord, StatusDotState>> = { online: "ready", off: "offline", update: "needs-you" };

type PcWay = "relay" | "tailscale" | "ssh" | "address";

/** One row of My PCs: one row component fed by the relay's PCs and the phone app's. */
interface PhonePc {
  readonly key: string;
  readonly name: string;
  readonly way: PcWay;
  /** a PC saved by several ways: each, the first `way`, which Forget PCs lists one to a line, each with its own Forget */
  readonly ways?: readonly WayLine[];
  /** a PC saved by several ways: the saved ways its tap does not open, which its More ways lists */
  readonly others?: readonly OtherLine[];
  readonly word?: PcWord | undefined;
  readonly address?: string | undefined;
  /** a line under the name that says something of the PC a tap does not change: that it is not in the account's list */
  readonly note?: string | undefined;
  /** a relay PC's own page, or what opening it does */
  readonly href?: string;
  /** a tap on `href`, which may keep the page from going there */
  readonly onLink?: (event: { preventDefault(): void }) => void;
  readonly open?: () => void;
  readonly forget?: (() => void) | undefined;
  /** why a row has no Forget here, said in its place in Forget PCs: an account PC, or an SSH PC (which goes with its keys) */
  readonly kept?: "account" | "ssh" | undefined;
  readonly data?: Readonly<Record<string, string>>;
}

/**
 * One way a row of several is saved by, a line of its own in Forget PCs: its Forget (the relay's on the PC in use asks
 * once more first, `inUse`), or, where this screen forgets nothing of it, why (an account PC, an SSH PC).
 */
interface WayLine {
  readonly key: string;
  readonly way: PcWay;
  readonly address?: string | undefined;
  readonly forget?: (() => void) | undefined;
  readonly kept?: "account" | "ssh" | undefined;
  readonly inUse?: boolean;
}

/** A saved way a row's tap does not open, a line of its More ways: its tag, the host it opens and what opening it does. */
interface OtherLine {
  readonly key: string;
  readonly way: string;
  readonly host: string;
  readonly open: () => void;
}

/**
 * One row of My PCs: it opens its PC, the whole row; a row with `others` has More ways beside it, closed at first, which
 * lists them one to a line, each naming its way and its whole host and opening that way (OtherWayButton). `editing`, the
 * list's Forget PCs: it opens nothing and has no More ways, a row this phone can forget has Forget in its chevron's
 * place, one that it cannot the reason there instead, and a row of several ways lists them under it, one to a line, each
 * with its own Forget or reason. Forget on the PC in use asks once more, in the row, first (`asking`, the key of the row
 * or the line asked about).
 */
function PcRow({ pc, editing = false, asking, onAsk, onKeep }: { readonly pc: PhonePc; readonly editing?: boolean; readonly asking: string | null; readonly onAsk: (key: string) => void; readonly onKeep: () => void }) {
  const t = useT();
  const othersId = useId();
  const [more, setMore] = useState(false);
  const others = editing ? [] : pc.others ?? [];
  const tagOf = (way: PcWay): string => ({ relay: t("Relay"), tailscale: "Tailscale", ssh: "SSH", address: t("Address") }[way]);
  const tag = [...new Set((pc.ways ?? [{ way: pc.way }]).map((line) => line.way))].map(tagOf).join(" · ");
  const word = pc.word === undefined ? null : { online: t("On|pc state"), off: t("Off|pc state"), update: t("Update needed|pc state"), removed: t("Removed|pc state"), "in-use": t("In use now|pc state") }[pc.word];
  const dot = pc.word === undefined ? undefined : WORD_DOT[pc.word];
  const inside = (
    <>
      <span className="my-pc-text">
        <span className="relay-add-saved-name">{pc.name}</span>
        <span className="phone-pc-meta">
          <span className="phone-pc-tag">{tag}</span>
          {pc.address !== undefined && pc.address !== pc.name && <span className={pc.ways !== undefined ? "my-pc-address my-pc-address-more" : "my-pc-address"}>{atDots(pc.address)}</span>}
          {pc.note !== undefined && <span className="my-pc-note" data-pc-note="">{pc.note}</span>}
        </span>
      </span>
      {word !== null && <span className="relay-add-saved-note my-pc-state" data-pc-state={pc.word}>{dot && <StatusDot state={dot} size="inline" />}{word}</span>}
      {!editing && <ChevronRight className="relay-shell-pc-glyph" aria-hidden="true" />}
    </>
  );
  const keptText = (kept: "account" | "ssh"): string => kept === "account" ? t("Account PC") : t("SSH PC");
  // Forget, where it asks once more first on the PC in use, then that question under it
  const forgetting = (key: string, label: string, forget: () => void, inUse: boolean): ReactNode => (
    <>
      <button type="button" className="btn btn-ghost phone-pc-forget" data-action="forget-pc" aria-label={t("Forget {name}", { name: label })} aria-expanded={inUse ? asking === key : undefined} onClick={inUse ? () => onAsk(key) : forget}>{t("Forget|this phone's PC")}</button>
      {inUse && asking === key && (
        <div className="my-pc-ask" role="group" aria-label={label} data-forget-ask="">
          <p className="relay-shell-copy">{t("This is the PC in use now. Forget it?")}</p>
          <button type="button" className="btn btn-danger" onClick={forget}>{t("Forget|this phone's PC")}</button>
          <button type="button" className="btn" onClick={onKeep}>{t("Cancel")}</button>
        </div>
      )}
    </>
  );
  const lines = editing ? pc.ways : undefined;
  return (
    <li className="my-pc" data-pc-way={pc.way} {...pc.data}>
      {editing ? <div className="relay-add-saved-pc is-editing">{inside}</div>
        : pc.href !== undefined ? <a className="relay-add-saved-pc" href={pc.href} onClick={pc.onLink}>{inside}</a>
        : <button type="button" className="relay-add-saved-pc" disabled={pc.open === undefined} onClick={pc.open}>{inside}</button>}
      {others.length > 0 && (
        <button type="button" className="icon-button is-outlined my-pc-more" data-action="more-ways" aria-expanded={more} aria-controls={othersId}
          aria-label={t("More ways to open {name}", { name: pc.name })} title={t("More ways to open {name}", { name: pc.name })} onClick={() => setMore(!more)}>
          <ChevronDown aria-hidden="true" />
        </button>
      )}
      {others.length > 0 && (
        <div className="my-pc-others" id={othersId} role="group" aria-label={t("More ways to open {name}", { name: pc.name })} hidden={!more}>
          {more && others.map((line) => <OtherWayButton key={line.key} way={line.way} host={line.host} onClick={line.open} />)}
        </div>
      )}
      {editing && lines === undefined && (pc.forget ? forgetting(pc.key, pc.name, pc.forget, pc.word === "in-use") : pc.kept !== undefined && <span className="my-pc-kept" data-kept={pc.kept}>{keptText(pc.kept)}</span>)}
      {lines?.map((line) => (
        <Fragment key={line.key}>
          <span className="my-pc-way" data-way-line={line.way}>
            <span className="phone-pc-tag">{tagOf(line.way)}</span>
            {line.address !== undefined && <span className="my-pc-address">{atDots(line.address)}</span>}
          </span>
          {line.forget ? forgetting(line.key, `${pc.name} · ${tagOf(line.way)}`, line.forget, line.inUse === true)
            : line.kept !== undefined ? <span className="my-pc-kept" data-kept={line.kept}>{keptText(line.kept)}</span> : <span />}
        </Fragment>
      ))}
    </li>
  );
}

/** HerdrShell getState as the phone app answers it (app/android HerdrShellPlugin, app/ios HerdrShellPlugin.swift). */
interface ShellAnswer { readonly saved?: string[]; readonly names?: Record<string, string>; readonly ids?: Record<string, string>; readonly choosing?: boolean; readonly current?: string; readonly kind?: string; readonly failure?: string }

/**
 * The PC the phone app still has open while the person chooses another: a relay PC of this app by its id, any other by
 * its origin and, for a relay PC of another origin (a self-hosted relay), its scope there.
 */
export type CurrentPc = { readonly serverId: string } | { readonly origin: string; readonly scope: string | null };

/** how long a front page that waits on what the phone app saved holds its controls back for an answer */
const READ_WAIT_MS = 1_500;

/**
 * What the phone app says it has: the PCs it saved (phoneSavedPcs), and `recent`, its whole saved list in its order (the
 * way a PC opens by, openWay); `current`, the PC it keeps open while the person
 * chooses another (HerdrShell chooseAnother: `choosing` with `current`, app/web/connect.js showBackToPc), a relay PC by
 * its page on this app's origin and any other by its address; and `sshPort`, the address an SSH PC opens on that another
 * app on the phone took first, so the app did not open it (OvisSshPlugin.listen, getState `kind` "ssh-port").
 */
export function phoneShellState(state: ShellAnswer, appOrigin: string): { readonly pcs: PhoneSavedPc[]; readonly recent: readonly string[]; readonly current: CurrentPc | null; readonly sshPort: string | null } {
  let current: CurrentPc | null = null;
  if (state.choosing === true && state.current) {
    try {
      const url = new URL(state.current);
      const serverId = url.origin === appOrigin ? serverIdOfPath(url.pathname) : null;
      current = url.origin !== appOrigin ? { origin: url.origin, scope: serverIdOfPath(url.pathname) } : serverId === null ? null : { serverId };
    } catch { current = null; }
  }
  return { pcs: phoneSavedPcs(state.saved ?? [], state.names ?? {}, appOrigin, state.ids ?? {}), recent: state.saved ?? [], current, sshPort: state.kind === "ssh-port" && state.failure ? state.failure : null };
}

/**
 * What the phone app says it has (phoneShellState), read once, with a way to read it again (after a Forget); nothing
 * outside the app, nor from an app with no getState. `read`: the app answered, or `READ_WAIT_MS` went by (a call to a
 * method an app lacks never settles on iOS), so a screen chosen by whether any PC is saved neither flashes the other nor
 * stays blank; a late answer still lists its PCs.
 */
export function usePhoneSaved(native: boolean): ReturnType<typeof phoneShellState> & { readonly read: boolean; readonly reread: () => void } {
  const asks = native && hasNativeMethod(SHELL, "getState");
  const [shell, setShell] = useState<ReturnType<typeof phoneShellState>>({ pcs: [], recent: [], current: null, sshPort: null });
  const [read, setRead] = useState(!asks);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!asks) return;
    let live = true;
    // fixed wait: an app that does not answer holds the front page's controls back no longer than this
    const waited = setTimeout(() => { if (live) setRead(true); }, READ_WAIT_MS);
    callNative<ShellAnswer>(SHELL, "getState").then((state) => {
      if (!live) return;
      setShell(phoneShellState(state, window.location.origin));
      setRead(true);
    }, () => { if (live) setRead(true); }).finally(() => clearTimeout(waited));
    return () => { live = false; clearTimeout(waited); };
  }, [asks, round]);
  return { ...shell, read, reread: () => setRound((n) => n + 1) };
}

/** Which of a long My PCs are shown: every one, the ones on (the PC in use is on) or the ones off. */
export type PcShow = "all" | "on" | "off";

/** My PCs past this many PCs offers a search by name (and on a wide screen the On and Off chips) */
const SEARCH_PAST = 8;

/** The rows of My PCs whose name holds `query`, in any case, and that `show` keeps; a row with no state word only under All. */
export function pcsShown<T extends { readonly name: string; readonly word?: string | undefined }>(rows: readonly T[], query: string, show: PcShow): T[] {
  const wanted = query.trim().toLowerCase();
  const kept = (word: string | undefined): boolean => show === "all" || (show === "on" ? word === "online" || word === "in-use" : word === "off");
  return rows.filter((row) => (wanted === "" || row.name.toLowerCase().includes(wanted)) && kept(row.word));
}

/** The round Back of a connect screen, at its top start; `label` names where it goes when that is not the screen before. */
function BackButton({ onBack, label }: { readonly onBack: () => void; readonly label?: string | undefined }) {
  const t = useT();
  return <button type="button" className="relay-add-back" aria-label={label ?? t("Back")} onClick={onBack}><ChevronLeft aria-hidden="true" /></button>;
}

/**
 * A connect screen's sheep and title, Back at its start and the account's menu at its end where they apply; `side`: the
 * panel beside My PCs on a wide screen, under the page's own title, so no sheep and a heading one level down; `focus`:
 * counts the times the screen replaced the control that had the focus (Add PC opened it), each moving the focus to its
 * title so a keyboard keeps its place; a resize that only shows it again moves nothing.
 */
function ConnectHead({ title, onBack, backLabel, menu, side = false, focus = 0 }: { readonly title: string; readonly onBack?: (() => void) | undefined; readonly backLabel?: string | undefined; readonly menu?: ReactNode; readonly side?: boolean; readonly focus?: number }) {
  const Title = side ? "h2" : "h1";
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (focus > 0) heading.current?.focus(); }, [focus]);
  return (
    <>
      {!side && <SheepMascot screen="header" size={56} />}
      <div className="connect-start-head">
        {onBack && <BackButton onBack={onBack} label={backLabel} />}
        <Title className="relay-shell-title connect-start-title" ref={heading} tabIndex={-1}>{title}</Title>
        {menu}
      </div>
    </>
  );
}

/** Whether the app's saved entry is the PC it keeps open: the same origin, and the same relay scope there or none. */
function isCurrent(saved: string, current: CurrentPc | null): boolean {
  if (current === null || !("origin" in current)) return false;
  try {
    const url = new URL(saved);
    return url.origin === current.origin && serverIdOfPath(url.pathname) === current.scope;
  } catch { return false; }
}

/** The account signed in to here (the stored sign-in), or null: whose list My PCs reads for its account PCs. */
const signedInHere = (): Promise<string | null> => indexedAccountService.session().then((session) => session?.account ?? null);

/**
 * My PCs: every PC this phone can open in one list, the relay's (this phone's pairings, then the account's) and the ones
 * the phone app saved by a Tailscale address, over SSH or at another address, each with the way it connects and, for a
 * relay PC, the word the account or its last check has for it. The PC in use now is marked so instead: `inUse`, the PC
 * whose More opened this (`/#add`), else the one the phone app keeps open while the person chooses another, whose Back
 * goes back to it where the app can; its row does the same. A row opens its PC. Forget is no row's: the ⋮ menu's Forget
 * PCs, there whenever a row can be forgotten here (an SSH PC goes with its keys, from the app's own connect screen),
 * puts Forget on those rows until Done (PcRow). Past eight PCs a search by name, and on a `wide` screen the On and Off
 * chips. `top`: what the screen says above the list (notices, a PC not answering); `empty`: what it says with nothing
 * listed. Add PC (`onAdd`, none beside the panel on a wide screen) stays at the bottom while the list scrolls.
 */
export function MyPcs({ devices, accountPcs = null, knownPcs, accountUnread = false, checked, phone, onForget, inUse = null, onBack, onAdd, focusAdd = 0, accountMenu = false, top, empty, wide = false, hidden = false, listOf = pageListAdds, signedIn = signedInHere }: {
  readonly devices: readonly SavedPc[];
  /** signed in, the account's PCs, which the list adds to this phone's own pairings (relayTabPcs) */
  readonly accountPcs?: readonly MyPc[] | null;
  /** the account unread now: the account's PCs it listed last (relayTabPcs) */
  readonly knownPcs?: readonly KnownPc[] | undefined;
  /** the account's last read failed: no row says on or off by its word (relayTabPcs) */
  readonly accountUnread?: boolean;
  /** what this device's own checks settled of the account's PCs (relayTabPcs) */
  readonly checked?: ReadonlyMap<string, CheckedPc>;
  /** counts the times Add a PC's Back, the control with the focus, came back here: each gives Add PC the focus again */
  readonly focusAdd?: number;
  readonly phone: ReturnType<typeof usePhoneSaved>;
  /** forgets one of this phone's pairings */
  readonly onForget?: ((serverId: string) => void) | undefined;
  readonly inUse?: string | null;
  readonly onBack?: (() => void) | undefined;
  readonly onAdd?: (() => void) | undefined;
  /** signed in: the ⋮ menu holds the account's items too (StartScreenAccountMenu) */
  readonly accountMenu?: boolean;
  readonly top?: ReactNode;
  readonly empty?: ReactNode;
  readonly wide?: boolean;
  /** kept mounted but not shown (Add a PC stands in its place on a phone): what it holds survives the switch back */
  readonly hidden?: boolean;
  /** what this device knows of the account's signed list (listPcs.ts ListAdds); a test's own */
  readonly listOf?: (account: string) => Promise<ListAdds>;
  /** the account signed in to here, or null (the stored sign-in); a test's own */
  readonly signedIn?: () => Promise<string | null>;
}) {
  const t = useT();
  const open = useAddressOpen("list");
  // what a tap said with no network on this device is over once it is back
  const offline = useOffline();
  const { setError } = open;
  const wasOffline = useRef(offline);
  useEffect(() => {
    if (wasOffline.current && !offline) { setError(null); clearOutcome(); }
    wasOffline.current = offline;
  }, [offline, setError]);
  const [query, setQuery] = useState("");
  const [show, setShow] = useState<PcShow>("all");
  // the PCs that turned this phone away as removed (relayTabPcs), read again once one is forgotten from the list
  const [removed, setRemoved] = useState(removedPcs);
  const current = inUse === null ? phone.current : null;
  // On an account that keeps a signed list, an account PC this device is not paired with that posted its keys for the
  // list is added by the number both screens show (AddPcByNumber), never by the join on its own page, which is the
  // directory's admission alone (docs/account-list.md, "Adding a PC"); one that posted nothing opens as before
  // "unread" until a read of the signed-in account's list settled (ListAdds, or null where the account keeps none): a read
  // that is out or failed is never "no list", so until then an account PC's row opens no page of its own, whose join is
  // the directory's admission alone; a tap on it reads the list first (settleThenOpen). A page that holds no list at all
  // (pageList.ts: it follows none) keeps no list for sure, from its first draw
  const [listAdds, setListAdds] = useState<ListAdds | "unread">(() => pageAccountList() === null ? null : "unread");
  const [adding, setAdding] = useState<{ readonly name: string; readonly post: ListedPost } | null>(null);
  const readLists = (): Promise<ListAdds> => signedIn().then((account) => account === null ? null : listOf(account));
  useEffect(() => {
    if (pageAccountList() === null) { setListAdds(null); return; }
    if (!(accountPcs ?? []).some((pc) => !pc.paired && pc.join !== undefined)) return;
    let live = true;
    readLists().then((next) => { if (live) setListAdds(next); }, (error: unknown) => {
      console.warn("Ovis: the account's list could not be read for its PCs", error instanceof Error ? error.name : error);
    });
    return () => { live = false; };
  }, [accountPcs, listOf, signedIn]); // eslint-disable-line react-hooks/exhaustive-deps
  /** the post of an account PC of this row that is added by the number, where it is one */
  // (keys the list holds for that PC by another device's entry are taken from that device alone: no Add of those here)
  const postIn = (lists: ListAdds, pc: RelayTabPc): ListedPost | undefined => pc.saved ? undefined : lists?.posts.find((post) => post.server_id === pc.server_id && post.for.kind !== "signer");
  const postOf = (pc: RelayTabPc): ListedPost | undefined => listAdds === "unread" ? undefined : postIn(listAdds, pc);
  const addByNumber = (pc: RelayTabPc, post: ListedPost) => (): void => { open.setError(null); setAdding({ name: pc.name ?? t("Unnamed PC"), post }); };
  /** An account PC's row while the list is unread: the list is read first, and only then does the row open what it opens. */
  const settleThenOpen = (pc: RelayTabPc) => (): void => {
    open.setError(null);
    readLists().then((next) => {
      setListAdds(next);
      const post = postIn(next, pc);
      if (post !== undefined) setAdding({ name: pc.name ?? t("Unnamed PC"), post });
      else window.location.assign(serverScopePath(pc.server_id));
    }, (error: unknown) => {
      console.warn("Ovis: the account's list could not be read for its PCs", error instanceof Error ? error.name : error);
      open.setError(t("The account service could not be reached. The PCs this device is paired with still work."));
    });
  };
  /** How an account PC's row opens that is not this phone's own pairing: by the number, its page, or the list read first. */
  const accountWay = (pc: RelayTabPc): Pick<PhonePc, "href" | "onLink" | "open"> => {
    const post = postOf(pc);
    if (post !== undefined) return { open: addByNumber(pc, post) };
    if (!pc.saved && listAdds === "unread") return { open: settleThenOpen(pc) };
    return { href: serverScopePath(pc.server_id), onLink: offlineLink(serverScopePath(pc.server_id)) };
  };
  // Forget PCs: the rows this phone can forget have Forget, and the PC in use's asks once more first (`asking`, its key)
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (focusAdd > 0) addButton.current?.focus(); }, [focusAdd]);
  // Done, or the last PC to forget gone, takes the Done button away: Add PC, in its place, takes the focus
  const wasEditing = useRef(false);
  useEffect(() => { if (wasEditing.current && !editing) addButton.current?.focus(); wasEditing.current = editing; }, [editing]);
  // the app keeps a PC open while the person chooses another: Back goes back to it, where the app can (an app built
  // before backToCurrent opens no page while choosing)
  const backToCurrent = onBack === undefined && current !== null && hasNativeMethod(SHELL, "backToCurrent")
    ? () => { open.setError(null); callNative(SHELL, "backToCurrent").catch(open.failed); } : undefined;
  // the PC in use is open already: its row goes back to it as Back does, rather than opening it again
  const goBack = onBack ?? backToCurrent;
  // a relay PC's row says so when the device has no network (followUnlessOffline), instead of going there
  const offlineLink = (href: string) => followUnlessOffline(href, () => open.setError(offlineOpenText(t)));
  const forgetSaved = (pc: PhoneSavedPc) => () => { open.setError(null); callNative(SHELL, "forget", { url: pc.origin }).then(phone.reread, open.failed); };
  // a saved Tailscale PC asks the app first whether Tailscale is on: off, Open Tailscale takes over (TailscaleOff)
  // `other`: a saved way the open offers by name when this one fails or is refused (a row of several)
  const openSaved = (pc: PhoneSavedPc, other: PhoneSavedPc | null = null): void => open.take(new URL(pc.origin), {
    askTailscale: pc.way === "tailscale",
    ...(other === null ? {} : { other: { way: savedWayTag(t, other), host: other.host, run: () => openSaved(other) } }),
  });
  // a saved way, as its own row opens it: the PC the app keeps open goes back to it, any other opens with its checks
  const openOf = (pc: PhoneSavedPc): (() => void) => isCurrent(pc.origin, current) && goBack ? goBack : () => openSaved(pc);
  const otherLine = (pc: PhoneSavedPc): OtherLine => ({ key: pc.origin, way: savedWayTag(t, pc), host: pc.host, open: openOf(pc) });
  const fromPhone = (pc: PhoneSavedPc): PhonePc => ({
    key: pc.origin, name: pc.name, way: pc.way, address: pc.host, ...(pc.way === "tailscale" ? { data: { "data-tailnet-pc": pc.origin } } : {}),
    ...(isCurrent(pc.origin, current) ? { word: "in-use" as const } : {}),
    open: openOf(pc),
    forget: pc.way === "ssh" ? undefined : forgetSaved(pc),
    ...(pc.way === "ssh" ? { kept: "ssh" as const } : {}),
  });
  const relayUsed = (pc: RelayTabPc): boolean => pc.server_id === inUse || (current !== null && "serverId" in current && current.serverId === pc.server_id);
  const forgetRelay = (pc: RelayTabPc): (() => void) | undefined => pc.status === "removed" ? () => { markRemovedPc(pc.server_id, "hidden"); setRemoved(removedPcs()); }
    : pc.saved && onForget ? () => onForget(pc.server_id) : undefined;
  // an account PC this device has no pairing for: nothing here forgets it
  const relayKept = (pc: RelayTabPc): "account" | undefined => pc.saved || pc.status === "removed" ? undefined : "account";
  const outsideNote = (pc: RelayTabPc): string | undefined => pc.outside === true ? t("Not in your account's list yet") : undefined;
  const fromRelay = (pc: RelayTabPc): PhonePc => {
    const used = relayUsed(pc);
    return {
      // a PC with no way to it (noWay) has nothing to open: its row stays, and says that it is off
      key: pc.server_id, name: pc.name ?? t("Unnamed PC"), way: "relay", ...(used && goBack ? { open: goBack } : pc.noWay === true ? {} : accountWay(pc)),
      word: used ? "in-use" : pc.status, forget: forgetRelay(pc), kept: relayKept(pc), note: outsideNote(pc),
    };
  };
  const phoneLine = (pc: PhoneSavedPc): WayLine => ({ key: pc.origin, way: pc.way, address: pc.host, forget: pc.way === "ssh" ? undefined : forgetSaved(pc), kept: pc.way === "ssh" ? "ssh" : undefined, inUse: isCurrent(pc.origin, current) });
  // one PC saved by several ways (onePcRows), on one row with every way's tag. With a relay row it is that row: its name,
  // its word, its tap opened by the relay; the ways saved by an address show themselves there, never name it or state
  // it, and open only from its More ways, a line each that shows the host it opens. With none, the saved way that loaded
  // last opens it, offering another when that fails, and gives its name and address; More ways lists the others. Forget
  // PCs lists the ways, one to a line, each forgotten on its own
  const together = (group: PcGroup): PhonePc => {
    const { relay, phones } = group;
    const by = openWay(group, phone.recent);
    const lines: WayLine[] = [
      ...(relay === undefined ? [] : [{ key: `${relay.server_id} relay`, way: "relay" as const, forget: forgetRelay(relay), kept: relayKept(relay), inUse: relayUsed(relay) }]),
      ...phones.map(phoneLine),
    ];
    const tailnet = phones.find((pc) => pc.way === "tailscale");
    const data = { "data-pc-ways": [...new Set(lines.map((line) => line.way))].join(" "), ...(tailnet ? { "data-tailnet-pc": tailnet.origin } : {}) };
    if (relay !== undefined) {
      const used = relayUsed(relay);
      return { key: relay.server_id, name: relay.name ?? t("Unnamed PC"), way: "relay", ways: lines, others: phones.map(otherLine), word: used ? "in-use" : relay.status, note: outsideNote(relay), ...(used && goBack ? { open: goBack } : accountWay(relay)), data };
    }
    // the way the app keeps open, where one is: the row's tap goes back to it, so the row shows it and More ways the rest
    const kept = phones.find((pc) => isCurrent(pc.origin, current));
    const shown = kept ?? by ?? phones[0]!;
    const used = kept !== undefined;
    return {
      key: shown.serverId ?? shown.origin, name: shown.name, way: shown.way, ways: lines, others: phones.filter((pc) => pc !== shown).map(otherLine), address: shown.host, ...(used ? { word: "in-use" as const } : {}),
      open: used && goBack ? goBack : () => openSaved(shown, otherWay(group, shown)), data,
    };
  };
  const tailscaleFirst = [...phone.pcs.filter((pc) => pc.way === "tailscale"), ...phone.pcs.filter((pc) => pc.way !== "tailscale")];
  const rows: PhonePc[] = onePcRows(relayTabPcs(devices, accountPcs, removed, checked, { known: knownPcs, unread: accountUnread }), tailscaleFirst).map((group) =>
    group.phones.length === 0 && group.relay ? fromRelay(group.relay) : group.relay === undefined && group.phones.length === 1 ? fromPhone(group.phones[0]!) : together(group));
  // what Forget PCs can forget here: a row's own Forget, or a line's of a row of several
  const forgets = rows.flatMap((row) => row.ways === undefined ? (row.forget ? [row.key] : []) : row.ways.flatMap((line) => line.forget ? [line.key] : []));
  const forgettable = forgets.length > 0;
  if (editing && !forgettable) setEditing(false);
  if (asking !== null && !forgets.includes(asking)) setAsking(null);
  const stopEditing = (): void => { setEditing(false); setAsking(null); };
  const currentName = rows.find((row) => row.word === "in-use")?.name ?? t("this PC");
  const searchable = rows.length > SEARCH_PAST;
  const shown = searchable ? pcsShown(rows, query, wide ? show : "all") : rows;
  const label: Record<PcShow, string> = { all: t("All"), on: t("On|pc state"), off: t("Off|pc state") };
  return (
    <div className="my-pcs" data-view="my-pcs" hidden={hidden || undefined}>
      <ConnectHead title={t("Your PCs")} onBack={onBack ?? backToCurrent} backLabel={backToCurrent ? t("Back to {name}", { name: currentName }) : undefined} menu={<StartScreenAccountMenu account={accountMenu} onForgetPcs={forgettable ? () => setEditing(true) : undefined} />} />
      {top}
      {!hidden && <OpenStatus view="list" anyView={!wide} />}
      <OpenError open={open} />
      {phone.sshPort !== null && <p className="account-error" role="alert">{t("Another app on this phone took the address the SSH PC opens on ({address}), so the app did not open it: that app would have answered in its place. Close or uninstall the app you do not know, or restart the phone, then open the PC again.", { address: phone.sshPort })}</p>}
      {searchable && (
        <div className="my-pcs-find">
          <input type="search" className="input my-pcs-search" aria-label={t("Search PC names")} placeholder={t("Search PC names")} value={query} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(event) => setQuery(event.currentTarget.value)} />
          {wide && (
            <div className="segmented my-pcs-chips" role="group" aria-label={t("Filter PCs")}>
              {(["all", "on", "off"] as const).map((each) => <button key={each} type="button" aria-pressed={show === each} data-show={each} onClick={() => setShow(each)}>{label[each]}</button>)}
            </div>
          )}
        </div>
      )}
      {shown.length > 0 ? <ul className="my-pcs-list">{shown.map((pc) => <PcRow key={pc.key} pc={pc} editing={editing} asking={asking} onAsk={setAsking} onKeep={() => setAsking(null)} />)}</ul>
        : rows.length > 0 ? <p className="relay-shell-copy my-pcs-none" role="status">{t("No PC matches.")}</p> : empty}
      {editing ? <div className="my-pcs-add"><button type="button" className="btn btn-primary" data-action="forget-done" onClick={stopEditing}>{t("Done")}</button></div>
        : onAdd && <div className="my-pcs-add"><button ref={addButton} type="button" className="btn btn-primary" data-action="add-pc" onClick={onAdd}><Plus aria-hidden="true" />{t("Add PC")}</button></div>}
      {adding !== null && listAdds !== null && listAdds !== "unread" && (
        <AddPcByNumber list={listAdds.list} account={listAdds.account} post={adding.post} name={adding.name} keys={adding.post.for.kind === "keys"} onClose={() => setAdding(null)} onAdded={() => setAdding(null)} />
      )}
    </div>
  );
}

/** Scan a QR code, where the phone app can scan: what it read opens as a typed address would (`open`). */
function ScanWay({ open, failed, disabled = false }: { readonly open: AddressOpen; readonly failed: (cause: unknown) => void; readonly disabled?: boolean }) {
  const t = useT();
  return <Way icon={QrCode} title={t("Scan a QR code")} sub={t("The QR on the PC's screen")} action="scan-qr" disabled={disabled} onClick={() => { open.setError(null); scanQr(t, open.scanned, open.ifLive(failed)); }} />;
}

/**
 * The code a PC shows: one small line that opens its field in place. Its Pair looks the code up right here (`code.submit`):
 * while it looks the field is read-only, and after a failure the person can correct it, the same field keeping what was
 * typed, with Cancel; a code that found its PC goes on to the comparison, and that, Cancel or folding the field away ends
 * the lookup and closes the field, so dropping the code. The code stays in its input alone (src/AGENTS.md).
 */
function CodeLine({ code, disabled }: { readonly code: CodeWays; readonly disabled: boolean }) {
  const t = useT(), id = useId();
  const [shown, setShown] = useState(false);
  // the lookup this field started ended (a PC found, or Cancel): the field closes
  const [wasActive, setWasActive] = useState(false);
  if (code.state.active !== wasActive) {
    setWasActive(code.state.active);
    if (!code.state.active) setShown(false);
  }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!code.state.looking) code.submit((event.currentTarget.elements.namedItem("code") as HTMLInputElement).value);
  };
  return (
    <>
      <button type="button" className="connect-address-link" data-action="add-code" disabled={disabled} aria-expanded={shown} onClick={() => { if (shown && code.state.active) code.cancel(); setShown(!shown); }}>{t("Pair with a code")}</button>
      {shown && (
        <form className="relay-shell-code-form" data-code-form="" onSubmit={submit}>
          <label className="relay-shell-field-label" htmlFor={`${id}-code`}>{t("Code from the PC")}</label>
          <input id={`${id}-code`} name="code" className="input relay-shell-code-input" placeholder="XXXXX-XXXXX" disabled={disabled} readOnly={code.state.looking} autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} maxLength={32} required autoFocus onInput={typePairCode} onCompositionEnd={endPairCodeComposition} />
          {code.state.failure !== null && <p className="account-error" role="alert">{codeFailureText(t, code.state.failure)}</p>}
          <div className="relay-shell-actions">
            <button type="submit" className="btn btn-primary" disabled={disabled || code.state.looking} aria-busy={code.state.looking || undefined}>{code.state.looking ? t("Looking for the PC…") : t("Pair")}</button>
            {code.state.active && <button type="button" className="btn" onClick={code.cancel}>{t("Cancel")}</button>}
          </div>
        </form>
      )}
    </>
  );
}

/**
 * How the relay tab's code goes on: `start` opens the code screen (a scanner that could not run); `submit` looks up a
 * code typed in the tab's own field, whose lookup (`state`: under way, `looking` now, the `failure` it ended on) shows
 * there until it finds its PC; `cancel` ends it (the connect screen owns it, and ends it too when the person leaves).
 */
export interface CodeWays {
  readonly start: () => void;
  readonly submit: (code: string) => void;
  readonly cancel: () => void;
  readonly state: { readonly active: boolean; readonly looking: boolean; readonly failure: TypedCodeFailure | null };
}

/**
 * The relay tab's way in to a PC: its QR code where the phone app can scan, and its code everywhere (the PC offers both),
 * folded to one line; a scanner that cannot run (the camera refused) leads to the code screen. Both are held while a
 * sign-in is under way (`disabled`).
 */
function QrOrCode({ code, disabled = false }: { readonly code: CodeWays; readonly disabled?: boolean }) {
  const open = useAddressOpen("add");
  return (
    <>
      {canScanQr() && <ScanWay open={open} failed={code.start} disabled={disabled} />}
      <CodeLine code={code} disabled={disabled} />
      <OpenError open={open} />
    </>
  );
}

/**
 * The relay tab signed out: what an account gives, the sign-in (`signIn`, AccountSignIn), then the PC's QR code or its
 * code, for a PC in no account, and that the other tabs need no sign-in.
 */
export function SignedOutRelayPanel({ signIn, signingIn, decidingAccount, code }: { readonly signIn: ReactNode; readonly signingIn: boolean; readonly decidingAccount: boolean; readonly code: CodeWays }) {
  const t = useT();
  return (
    <>
      <p className="relay-shell-copy">{t("Reach your PCs from anywhere with your Ovis account")}</p>
      {signIn}
      {!decidingAccount && <p className="relay-shell-first-time">{t("First time? Your account is made right away.")}</p>}
      <QrOrCode code={code} disabled={signingIn} />
      <p className="relay-shell-detail">{t("Tailscale and SSH need no sign-in.")}</p>
    </>
  );
}

/**
 * The relay tab signed in: a PC joins the account from its own Ovis, signed in with the same account, so this says so; a
 * PC in no account pairs by its QR code where the phone app can scan, or by its code in a browser. Every device that
 * may write its account's signed list also makes invites here, the way a PC is set up through an agent.
 */
export function AccountRelayPanel({ code }: { readonly code: CodeWays }) {
  const t = useT();
  // the page's list, in the phone apps and the hosted app in a browser alike (InvitePc draws nothing for a device that
  // may not write it); a PC's own page has none, and says where invites are made instead (ConnectPhoneDialog)
  const list = pageAccountList();
  return (
    <>
      <p className="relay-shell-copy">{t("Turn on Ovis on the PC and sign in with the same account.")}</p>
      <QrOrCode code={code} />
      {list !== null && <InvitePc list={list} />}
    </>
  );
}

/** The relay tab of a relay with no accounts: where the PC shows its QR code, then that QR code or its code. */
export function AccountlessRelayPanel({ code }: { readonly code: CodeWays }) {
  const t = useT();
  return (
    <>
      <p className="relay-shell-copy">{t("On the PC, open Settings → Devices and PCs → Add a connection → Ovis relay and scan the QR code.")}</p>
      <QrOrCode code={code} />
    </>
  );
}

/**
 * My PCs with no network on this device (useOffline): one line that says so, naming the phone in the phone app, and Try
 * again, which reads what the screen shows once more (as the network coming back does by itself).
 */
export function OfflineLine({ onRetry }: { readonly onRetry: () => void }) {
  const t = useT();
  return (
    <p className="account-error my-pcs-offline" role="alert" data-offline="">
      {hasNativePlugin(SHELL) ? t("This phone is not connected to the internet.") : t("This device is not connected to the internet.")}
      {" "}<button type="button" className="account-link" onClick={onRetry}>{t("Try again")}</button>
    </p>
  );
}

/**
 * The Tailscale tab: a PC's Tailscale address in one field, and in the phone app its QR scan; with Tailscale off on the
 * phone a tailnet address opens nothing, so one line and Open Tailscale come first (TailscaleOff), the field still under
 * it for an address on the home network. It asks the app while it is on screen (`shown`): as it comes into view and when
 * the app comes back (from Tailscale). An app that cannot tell draws it as on. `status`: the connect screen's open, at
 * the panel's end.
 */
function TailscalePanel({ shown, status }: { readonly shown: boolean; readonly status: ReactNode }) {
  const t = useT();
  const open = useAddressOpen("add");
  const native = hasNativePlugin(SHELL);
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!native || !shown) return;
    let live = true;
    const check = (): void => { void tailscaleOn().then((now) => { if (live) setOn(now); }); };
    check();
    const visible = (): void => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", visible);
    return () => { live = false; document.removeEventListener("visibilitychange", visible); };
  }, [native, shown]);
  return (
    <div className="connect-start-panel" data-tab-panel="tailscale">
      {!on && <TailscaleOff />}
      <AddressForm open={open} labelShown label={t("Tailscale address")} placeholder="my-pc.tailnet.ts.net" submit={t("Connect")} />
      {on && <p className="relay-shell-detail">{t("The phone needs the Tailscale app turned on too.")}</p>}
      {canScanQr() && <ScanWay open={open} failed={open.failed} />}
      {status}
      <OpenError open={open} />
    </div>
  );
}

/**
 * The SSH tab: in the phone app SSH's user@host first, which opens the app's own SSH screen with it filled in
 * (sshHandoff); then Add by address, a text link that opens a field for a PC's https address. `status`: the connect
 * screen's open, at the panel's end.
 */
function SshPanel({ status }: { readonly status: ReactNode }) {
  const t = useT();
  const open = useAddressOpen("add");
  const ssh = sshHandoff();
  const [byAddress, setByAddress] = useState(false);
  return (
    <div className="connect-start-panel" data-tab-panel="ssh">
      {ssh && <AddressForm open={open} labelShown ssh label="SSH" placeholder="user@host" submit={t("Connect")} />}
      <button type="button" className="connect-address-link" aria-expanded={byAddress} onClick={() => { open.setError(null); setByAddress((shown) => !shown); }}>{t("Add by address")}</button>
      {byAddress && <AddressForm open={open} labelShown label={t("PC address")} placeholder="https://my-pc.example.com" submit={t("Connect")} autoFocus />}
      {status}
      <OpenError open={open} />
    </div>
  );
}

/**
 * Add a PC: the desktop's Add a connection tabs in its order, the Ovis relay chosen, holding only the ways to add or
 * open a PC, no list; on a wide screen always open beside My PCs. `relay`: that tab's way in (signed out its sign-in, signed in what to do on the PC); `title`:
 * Connect a PC where this is the front page, Add PC behind My PCs (`onBack`). A browser cannot see the tailnet or reach
 * SSH, so Tailscale and SSH each take a PC's address (RelayAddPc's AddressForm, which opens that PC's own Ovis); the
 * phone app adds what it knows.
 */
export function AddPcTabs({ title, relay, way, onWay, away, onBack, layout = "page", focus = 0, hidden = false }: {
  readonly title: string; readonly relay: ReactNode; readonly onBack?: (() => void) | undefined;
  /** the chosen tab, which the connect screen keeps (leaving the relay tab ends a code it looks up) */
  readonly way: ConnectWay; readonly onWay: (way: ConnectWay) => void;
  /** what the relay tab says that stays in view on the other tabs: a sign-in that ended */
  readonly away?: ReactNode;
  /** `front`: the front page itself (a centred card on a wide screen); `side`: the panel beside My PCs on a wide screen */
  readonly layout?: "page" | "front" | "side";
  /** counts the times My PCs' Add PC opened this: each moves the focus to its title (ConnectHead) */
  readonly focus?: number;
  /** kept mounted but not shown (My PCs stands in its place on a phone): its tab and what is typed survive the switch */
  readonly hidden?: boolean;
}) {
  const t = useT();
  const label: Record<ConnectWay, string> = { relay: t("Ovis relay"), tailscale: "Tailscale", ssh: "SSH" };
  // in the pane on screen only; beside My PCs, why an open started there did not go is said there, on its own here
  const status = hidden ? null : <OpenStatus view="add" anyView={layout !== "side"} />;
  return (
    <div className={layout === "page" ? "connect-add" : `connect-add connect-add-${layout}`} data-view="add-pc" hidden={hidden || undefined}>
      <ConnectHead title={title} onBack={onBack} side={layout === "side"} focus={focus} />
      <div className="segmented connect-start-tabs" role="group" aria-label={t("How to connect")}>
        {CONNECT_WAYS.map((each) => <button key={each} type="button" aria-pressed={way === each} data-tab={each} onClick={() => onWay(each)}>{label[each]}</button>)}
      </div>
      {way !== "relay" && away}
      {way === "relay" && <div className="connect-start-panel" data-tab-panel="relay">{relay}{status}</div>}
      {way === "tailscale" && <TailscalePanel shown={!hidden} status={status} />}
      {way === "ssh" && <SshPanel status={status} />}
    </div>
  );
}
