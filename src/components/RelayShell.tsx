import "./RelayShell.css";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { GLOBAL_RELAY } from "../../shared/relay-regions.ts";
import { newPcs, type MyPc } from "../lib/account/myPcs.ts";
import { parseMyMachinesHash, useLocationHash } from "../lib/account/myMachinesRoute.ts";
import type { AccountProvider } from "../lib/account/store.ts";
import { useT } from "../lib/i18n.ts";
import { serverIdOfPath } from "../lib/shellMode.ts";
import { dashboardPcs } from "../lib/relay/dashboard.ts";
import { isDashboardHash } from "../lib/relay/dashboardRoute.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import type { AccountView, RelayShellState } from "../lib/relay/shellState.ts";
import type { ObservedVersion } from "../lib/relay/updateFlow.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { SHEET_QUERY, useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { AddPcSheet, type AddPcSheetMode } from "./AddPcSheet.tsx";
import { codeFailureText, type TypedCodeFailure } from "./codeFailureText.ts";
import { KeyId } from "./KeyId.tsx";
import { MyMachinesPage } from "./MyMachinesPage.tsx";
import { RelayDashboard } from "./RelayDashboard.tsx";
import { EnrollmentStatus } from "./EnrollmentStatus.tsx";
import { ADD_PC_FROM_KEY } from "./MachineSidebar.tsx";
import { RelayAddPc } from "./RelayAddPc.tsx";
import { INSTALLER_COMMAND, PLUGIN_COMMANDS, RelayShellCardContent, ScanQrStep, TypedDigits } from "./RelayShellScreens.tsx";
import { RelayStepFrame, type RelayStepBack } from "./RelayStepFrame.tsx";
import { SheepMascot } from "./SheepMascot.tsx";

export { INSTALLER_COMMAND, PLUGIN_COMMANDS, TypedDigits };

export interface RelayShellProps {
  state: RelayShellState;
  pcStatus?: ReadonlyMap<string, PcStatus>;
  onCheckPcs?: () => void; onCheckPc?: (serverId: string) => void;
  onRefreshAccount?: () => void | Promise<void>;
  /** Admission succeeded; only this action hands the scoped page to the PC app. */
  onOpenPc?: () => void;
  /** Reloaded independently after a scope navigation, never copied into session storage. */
  continuedAccount?: AccountView | null;
  /** Versions from admitted sessions only; a liveness probe never supplies one. */
  observedVersions?: ReadonlyMap<string, ObservedVersion>;
  scoped: boolean; iosTab: boolean;
  onPair: () => void; onRetry: () => void; onCancel: () => void; onBack: () => void; onForget: () => void;
  onForgetPc?: (serverId: string) => Promise<void> | void;
  onUpdate: () => void;
  /** pairing without a code: the digits on this screen are the ones the PC shows (`typed`: typed from the PC's screen) */
  onMatch: (typed?: string) => void;
  onSignIn?: (provider: AccountProvider) => void;
  /** a PC of the account this device is not paired with: compare digits with it */
  onJoin?: (pc: MyPc, options?: { typed?: boolean; sheet?: "new" | "join" }) => void;
  sheetJoin?: { mode: "new" | "join"; server_id: string; returnHash?: string } | null;
  /** that sheet's typed comparison, for a PC that shows no number: the same request goes on as a join, with this device's digits */
  onJoinInstead?: () => void;
  onSignOut?: () => void; onLeave?: () => void; onDeleteAccount?: () => void;
  /** which sign-in the signed-in account view speaks of (AccountSession.sign_in_id): a question asked under one is dropped under the next */
  accountSignIn?: string;
  accountProviders?: readonly AccountProvider[];
  directoryRelays?: readonly { server_id: string; relay: string | null }[];
  defaultRelay?: string; meLabel?: string;
  onCodeStart: () => void; onCodeSubmit: (code: string) => void; onCodeMatch: () => void;
  /** the front page was opened on Add a PC (`/#add`: the app's More → Add a PC), whatever the account's state */
  addEntry?: boolean;
}

/** The field a code is typed in, kept in the input itself (src/AGENTS.md: secret input stays in the DOM). */
export function CodeEntry({ failure, looking = false, onSubmit, back, titleTag: Title = "h1", titleId, formId, omitHeading = false }: { readonly failure: TypedCodeFailure | null; readonly looking?: boolean | undefined; readonly onSubmit: (code: string) => void; readonly back?: ReactNode; readonly titleTag?: "h1" | "h2" | undefined; readonly titleId?: string | undefined; readonly formId?: string | undefined; readonly omitHeading?: boolean | undefined }) {
  const t = useT(), id = useId(), label = t("Code from the PC");
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!looking) onSubmit((event.currentTarget.elements.namedItem("code") as HTMLInputElement).value);
  };
  return (
    <>
      {!omitHeading && <Title className="relay-shell-title" id={titleId}>{t("Pair with a code")}</Title>}
      <p className="relay-shell-copy">{t("On the PC, open Settings → Devices and PCs → Add a connection → Ovis relay and type the code it shows.")}</p>
      <form id={formId} className="relay-shell-code-form" onSubmit={submit}>
        <label className="relay-shell-field-label" htmlFor={`${id}-code`}>{label}</label>
        <input id={`${id}-code`} name="code" className="input relay-shell-code-input" aria-label={label} placeholder="XXXXX-XXXXX" disabled={looking} autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} maxLength={32} required autoFocus />
        {failure !== null && <p className="account-error" role="alert">{codeFailureText(t, failure)}</p>}
        {back !== undefined && <div className="relay-shell-actions"><button type="submit" className="btn btn-primary" aria-busy={looking ? "true" : undefined} disabled={looking}>{looking ? t("Looking for the PC…") : t("Pair")}</button>{back}</div>}
      </form>
    </>
  );
}

function PairQrDialog({ state, onCodeStart, onCodeSubmit, onCodeMatch, onCancel, onClose }: {
  readonly state: RelayShellState; readonly onCodeStart: () => void; readonly onCodeSubmit: (code: string) => void;
  readonly onCodeMatch: () => void; readonly onCancel: () => void; readonly onClose: () => void;
}) {
  const t = useT(), titleId = useId(), codeFormId = `${titleId}-code-form`, surface = useFocusTrap<HTMLDivElement>(true), phone = useMediaQuery(SHEET_QUERY);
  const inCode = state.kind === "code-entry" || state.kind === "code-looking" || state.kind === "code-compare", looking = state.kind === "code-looking";
  const close = (): void => { if (inCode) onCancel(); onClose(); };
  const latestClose = useRef(close);
  latestClose.current = close;
  useSheetSwipe(surface, close);
  usePhoneSheetBack(() => { latestClose.current(); });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation(); event.preventDefault(); latestClose.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const pc = state.kind === "code-compare" ? (state.offer.name ?? t("this PC")) : t("this PC");
  const mode = state.kind === "code-entry" || state.kind === "code-looking" ? "code" : state.kind === "code-compare" ? "compare" : "qr";
  const title = mode === "code" ? t("Pair with a code") : mode === "compare" ? t("Does {name}'s screen show this ID?", { name: pc }) : t("Scan the QR code on your PC");
  const secondary = mode === "qr" ? <button key="back" type="button" className="btn" onClick={close}>{t("Back")}</button> : <button key="cancel" type="button" className="btn" onClick={close}>{t("Cancel")}</button>;
  const primary = mode === "code"
    ? <button key="pair" type="submit" form={codeFormId} className="btn btn-primary" data-sheet-primary aria-busy={looking ? "true" : undefined} disabled={looking}>{looking ? t("Looking for the PC…") : t("Pair")}</button>
    : mode === "compare"
      ? <button key="match" type="button" className="btn btn-primary" data-sheet-primary onClick={onCodeMatch}>{t("It matches")}</button>
      : <button key="code" type="button" className="btn btn-primary" data-sheet-primary onClick={onCodeStart}>{t("Pair with a code")}</button>;
  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div ref={surface} className="modal add-pc-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-pair-dialog={mode}>
        <header className="modal-header add-pc-head"><h2 className="modal-title" id={titleId}>{title}</h2></header>
        <div className="modal-body add-pc-body">
          {mode === "code" ? (
            <CodeEntry omitHeading formId={codeFormId} failure={state.kind === "code-entry" ? state.failure : null} looking={looking} onSubmit={onCodeSubmit} />
          ) : mode === "compare" && state.kind === "code-compare" ? (
            <>
              <p className="relay-shell-copy">{t("The PC shows its ID at the top of Settings → Devices and PCs. Pair only if every group matches.")}</p>
              <p className="relay-shell-code-id"><KeyId id={state.offer.server_id} label={t("ID of the PC this code found")} /></p>
            </>
          ) : (
            <p className="relay-shell-copy">{t("On the PC, open Settings → Devices and PCs → Add a connection → Ovis relay and scan the QR code.")}</p>
          )}
        </div>
        <footer className="modal-footer add-pc-footer">{phone ? <>{primary}{secondary}</> : <>{secondary}{primary}</>}</footer>
      </div>
    </div>,
    document.body,
  );
}

/** A completed pairing owns its transport until Open PC or Cancel, including in continued scope. */
export function ReadyCheckpoint({ open, cancel, state, retry }: { readonly open: () => void; readonly cancel: () => void; readonly state?: Extract<RelayShellState, { kind: "ready" }>; readonly retry?: () => void }) {
  const t = useT(), title = useId(), surface = useFocusTrap<HTMLDivElement>(true);
  const latestCancel = useRef(cancel); latestCancel.current = cancel;
  usePhoneSheetBack(() => { latestCancel.current(); });
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === "Escape") { event.preventDefault(); cancel(); } };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [cancel]);
  return (
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) cancel(); }}>
      <div ref={surface} className="modal add-pc-sheet" role="dialog" aria-modal="true" aria-labelledby={title} tabIndex={-1} data-add-pc-phase="ready">
        <header className="modal-header"><h2 id={title} className="modal-title" role="status">{t("Ready")}</h2></header>
        {state && <div className="modal-body"><p className="relay-shell-copy">{t("{name} is ready to open on this device.", { name: state.name ?? t("this PC") })}</p><EnrollmentStatus state={state.enrollment} {...(retry ? { retry } : {})} /></div>}
        <footer className="modal-footer"><button type="button" className="btn" onClick={cancel}>{t("Cancel")}</button><button type="button" className="btn btn-primary" onClick={open}>{t("Open PC")}</button></footer>
      </div>
    </div>
  );
}

export function RelayShell(props: RelayShellProps) {
  const { state, pcStatus, onCheckPcs, onCheckPc, onRefreshAccount, observedVersions, scoped, onPair, onRetry, onCancel, onBack, onForgetPc, onMatch, onCodeStart, onCodeSubmit, onCodeMatch, onOpenPc, continuedAccount, onSignIn, onJoin, sheetJoin = null, onJoinInstead, onSignOut, onLeave, onDeleteAccount, accountSignIn, directoryRelays = [], defaultRelay = GLOBAL_RELAY, meLabel } = props;
  const t = useT();
  const [cachedAccount, setCachedAccount] = useState<AccountView | null>(null);
  const rawAccount: AccountView | null = (state.kind === "list" || state.kind === "empty") && onSignIn ? state.account ?? null : null;
  if (rawAccount !== null && rawAccount !== cachedAccount) setCachedAccount(rawAccount);
  const account: AccountView | null = rawAccount ?? (addingPcOpen(state) && onSignIn ? cachedAccount : null);
  const [signedOutView, setSignedOutView] = useState<"sign-in" | "pair">("sign-in");
  const [sheet, setSheet] = useState<{ pc: MyPc | null; mode: AddPcSheetMode } | null>(null);
  const [addingPc, setAddingPc] = useState(false);
  const [addOpen, setAddOpen] = useState(props.addEntry === true);
  // the PC page whose More opened Add a PC, read once as it opens: a mark left by an earlier one never sends Back elsewhere
  const [addFrom] = useState(() => props.addEntry === true ? takeAddFrom() : null);
  const hash = useLocationHash(), machinesRoute = parseMyMachinesHash(hash);
  // the dashboard of the account's PCs is a page people open on purpose, by its address (Settings → Devices and PCs →
  // Relayed connections): no launch, sign-in, pairing or Back ever lands on it, and the front page is Add a PC instead
  const manage = machinesRoute !== null || isDashboardHash(hash);
  // a sheet opened on one of the screens goes with it, whether by a link or the browser's Back (to Add a PC too)
  const onMachines = machinesRoute !== null;
  useEffect(() => { setSheet(null); }, [onMachines, manage]);
  const signedOutOrSigningIn = account?.kind === "signed-out" || account?.kind === "signing-in";
  const view = signedOutOrSigningIn ? signedOutView : null;
  const signInFirst = view === "sign-in";
  // a sign-out found while the QR dialog is open closes it: the sign-in stays the only screen, and a later sign-in opens no stale dialog
  if (addingPc && signInFirst) setAddingPc(false);
  // a sign-in puts Start without signing in behind it: a later sign-out opens on the sign-in again
  if (account?.kind === "signed-in" && signedOutView !== "sign-in") setSignedOutView("sign-in");
  const name = state.kind === "confirm" || state.kind === "code-compare" ? state.offer.name ?? null
    : state.kind === "list" || state.kind === "empty" || state.kind === "code-entry" || state.kind === "code-looking" ? null : state.name;
  const pc = name ?? t("this PC");
  const stateName = state.kind === "failed" ? state.failure : state.kind === "outdated" ? "pc-outdated" : state.kind === "forged" ? "identity-changed" : state.kind;
  const devices = state.kind === "list" ? state.devices : [];
  // a pairing's sign-in reads on the plain page, with nothing around it; its other steps are on the step frame
  const plain = state.kind === "failed" && state.failure === "sign-in-first" && onSignIn !== undefined;

  // the PCs Add a PC lists: this device's pairings, then the account's PCs not on it yet (their own page joins them),
  // each with what is known of it
  const offOf = (serverId: string): boolean => { const now = pcStatus?.get(serverId); const shown = now?.kind === "checking" ? now.previous : now; return shown?.kind === "offline" && shown.reason === "pc"; };
  const addPcs = [
    ...devices.map((device) => ({ server_id: device.server_id, name: device.name, ...(offOf(device.server_id) ? { note: t("Off|pc state") } : {}) })),
    // only a row its own page can join: one with no way to join would open on nothing
    ...(account?.kind === "signed-in" ? account.pcs ?? [] : []).filter((row) => !row.paired && row.join !== undefined && !devices.some((device) => device.server_id === row.server_id))
      .map((row) => ({ server_id: row.server_id, name: row.name, ...(row.state === "offline" ? { note: t("Off|pc state") } : row.state === "needs-approval" ? { note: t("Needs approval") } : {}) })),
  ];
  const addPc = (onAddBack?: () => void) => (
    <div className="relay-shell account-centered relay-shell-signin">
      <RelayAddPc onBack={onAddBack} devices={addPcs}
        qr={(qrBack) => <ScanQrStep onCodeStart={() => {
          // signed in, the code is typed in the front page's own pairing dialog; signed out, on the way past the sign-in,
          // as from Start without signing in: either takes the screens that follow
          if (account?.kind === "signed-in") setAddingPc(true); else setSignedOutView("pair");
          onCodeStart();
        }} back={<button type="button" className="btn btn-ghost" onClick={qrBack}>{t("Back")}</button>} />} />
      {account?.kind === "signed-in" && account.error !== null && (
        <p className="account-error relay-add-directory-error" role="alert">{account.error}{onRefreshAccount && <> <button type="button" className="account-link" onClick={() => { void onRefreshAccount(); }}>{t("Try again")}</button></>}</p>
      )}
      {/* signed in, the account's own page (its PCs, this device, sign-out) is one deliberate press away */}
      {account?.kind === "signed-in" && <a className="account-link relay-add-manage" href="#overview">{t("Relayed connections")}</a>}
    </div>
  );

  // Add a PC asked for by its address stands alone over the front page; its Back goes back to where it was asked from
  // Add a PC hands over to a screen of its own (a code to type): coming back from there lands on the front page
  // so does a dashboard's address taken since: that page is asked for on purpose
  if (addOpen && (manage || (state.kind !== "list" && state.kind !== "empty"))) setAddOpen(false);
  if (addOpen && (state.kind === "list" || state.kind === "empty")) {
    return (
      <main className="relay-shell-screen relay-add-screen" data-relay-state={stateName} {...(account ? { "data-account-state": account.kind } : {})}>
        {addPc(() => { setAddOpen(false); leaveAddEntry(addFrom); })}
      </main>
    );
  }

  if (account?.kind === "signed-in") {
    const signedIn = account;
    const modalOpen = sheet !== null || addingPc;
    // My machines has its own signed-in address and main landmark; while the directory cannot be read, the dashboard says so and offers its retry
    const machines = signedIn.error === null && machinesRoute !== null;
    const Frame = machines ? "div" : "main";
    const dash = !manage ? addPc() : machines ? (
      <MyMachinesPage route={machinesRoute} pcs={signedIn.pcs} pcStatus={pcStatus ?? new Map()} onCheckPc={(serverId) => onCheckPc?.(serverId)}
        onJoin={(target) => setSheet({ pc: target, mode: newPcs([target], Date.now()).length > 0 ? "new" : "join" })} />
    ) : (
      <RelayDashboard
        pcs={signedIn.pcs === null ? null : dashboardPcs(signedIn.pcs, devices, directoryRelays)}
        account={{ provider: signedIn.provider }}
        defaultRelay={defaultRelay}
        meLabel={meLabel ?? t("This device")}
        error={signedIn.error}
        {...(signedIn.deleteError !== undefined ? { deleteError: signedIn.deleteError } : {})}
        {...(pcStatus ? { pcStatus } : {})}
        {...(observedVersions ? { observedVersions } : {})}
        {...(onCheckPcs ? { onCheckPcs } : {})}
        {...(onCheckPc ? { onCheckPc } : {})}
        {...(onRefreshAccount ? { onRefreshAccount } : {})}
        onAddPc={() => setSheet({ pc: null, mode: "add" })}
        onPairByQr={() => { setSheet(null); setAddingPc(true); }}
        onOpenSheet={(target, mode) => setSheet({ pc: target, mode })}
        {...(onForgetPc ? { onForgetPc } : {})}
        {...(onSignOut ? { onSignOut } : {})}
        {...(onLeave ? { onLeave } : {})}
        {...(onDeleteAccount ? { onDeleteAccount } : {})}
        {...(accountSignIn !== undefined ? { signedInAs: accountSignIn } : {})}
      />
    );
    return (
      <Frame className={Frame === "main" ? (manage ? "relay-dash-screen" : "relay-shell-screen relay-add-screen") : undefined} data-relay-state={stateName} data-account-state={account.kind}>
        {/* one wrapper whether a sheet is open or not: swapping it in would remount the dashboard, losing the control that opened the sheet before its focus trap records it */}
        <div inert={modalOpen || undefined}>{dash}</div>
        {sheet && (
          <AddPcSheet mode={sheet.mode} pc={sheet.pc} state={state} onJoin={(target, options) => onJoin?.(target, { ...options, sheet: sheet.mode === "new" ? "new" : "join" })} onPair={onPair} onMatch={onMatch} onCancel={onCancel} onClose={() => setSheet(null)} onPairByQr={() => { setSheet(null); setAddingPc(true); }} {...(sheet.mode === "new" && sheet.pc !== null ? { onAskToJoin: () => setSheet({ pc: sheet.pc, mode: "join" }) } : {})} {...(sheet.mode === "join" && sheet.pc !== null ? { onTypeNumber: () => setSheet({ pc: sheet.pc, mode: "new" }) } : {})} />
        )}
        {addingPc && (
          <PairQrDialog state={state} onCodeStart={onCodeStart} onCodeSubmit={onCodeSubmit} onCodeMatch={onCodeMatch} onCancel={onCancel} onClose={() => {
            setAddingPc(false);
            queueMicrotask(() => { if (document.activeElement === null || document.activeElement === document.body) [...document.querySelectorAll<HTMLElement>('[data-action="add-pc"], [data-action="add-code"], [data-action="add-qr"]')].find((el) => el.getClientRects().length > 0)?.focus({ preventScroll: true }); });
          }} />
        )}
      </Frame>
    );
  }

  const continued = scoped && sheetJoin !== null && (state.kind === "confirm" ? state.offer.server_id === sheetJoin.server_id
    : state.kind === "failed" ? state.server_id === sheetJoin.server_id && state.failure !== "identity-changed"
    : state.kind === "connecting" || state.kind === "compare" || state.kind === "ready");
  if (continued) {
    const joining: MyPc = (continuedAccount?.kind === "signed-in" ? continuedAccount.pcs?.find((row) => row.server_id === sheetJoin.server_id) : undefined)
      ?? { server_id: sheetJoin.server_id, name: pc, state: "needs-approval", last_seen_at: null, added_at: null, listed: true, paired: false, linked: false };
    return (
      <main className="relay-dash-screen" data-relay-state={stateName}>
        {continuedAccount !== undefined && <div inert>
          <RelayDashboard pcs={continuedAccount?.kind === "signed-in" && continuedAccount.pcs !== null ? dashboardPcs(continuedAccount.pcs, [], directoryRelays) : null} account={continuedAccount?.kind === "signed-in" ? { provider: continuedAccount.provider } : null} defaultRelay={defaultRelay} meLabel={meLabel ?? t("This device")} error={continuedAccount?.kind === "signed-in" ? continuedAccount.error : null} onAddPc={onBack} onOpenSheet={onBack} />
        </div>}
        <AddPcSheet mode={sheetJoin.mode} pc={joining} state={state} onJoin={() => {}} onPair={onPair} onMatch={onMatch} onRetry={onRetry} {...(onOpenPc ? { onOpenPc } : {})} onCancel={onCancel} onClose={onBack} onPairByQr={onCodeStart} {...(sheetJoin.mode === "new" && onJoinInstead ? { onAskToJoin: onJoinInstead } : {})} />
      </main>
    );
  }

  const content = <RelayShellCardContent props={props} view={view} signInFirst={signInFirst} addingPc={addingPc} setSignedOutView={setSignedOutView} setAddingPc={setAddingPc} />;
  const step = plain ? undefined : pairingStep(state);
  if (step !== undefined) {
    // before this phone's press the comparison can still go back; after it, the pairing waits on the PC and only its own small Cancel ends it
    const back: RelayStepBack | null = state.kind === "confirm" || (state.kind === "compare" && !state.confirmed) ? { label: t("Back"), onClick: onCancel }
      : state.kind === "connecting" ? { label: t("Cancel"), onClick: onCancel } : null;
    const note = state.kind === "connecting" ? t("Connecting…") : state.kind === "compare" && state.confirmed ? t("Waiting for approval…") : null;
    return (
      <main className="relay-step-screen" data-relay-state={stateName} {...(account ? { "data-account-state": account.kind } : {})}>
        <RelayStepFrame step={step} back={back} note={note}>{content}</RelayStepFrame>
      </main>
    );
  }

  // Add a PC stands on the page as the sign-in does, from the top, with its own sheep and Back
  const adding = !addingPc && (account === null ? state.kind === "empty" : view === "pair");
  return (
    <main className={plain ? "relay-shell-screen relay-shell-plain" : adding ? "relay-shell-screen relay-add-screen" : "relay-shell-screen"} data-relay-state={stateName} {...(account ? { "data-account-state": account.kind } : {})}>
      <div className={signInFirst || adding ? "relay-shell account-centered relay-shell-signin" : plain ? "relay-shell relay-shell-signin" : "relay-shell"}>
        {signInFirst || plain
          ? <SheepMascot screen="header" size={80} />
          : !adding && <img src="/icons/icon-192.png?v=sheep1" alt="" width="44" height="44" className="relay-shell-mark" />}
        {content}
      </div>
    </main>
  );
}

/**
 * A pairing's steps, drawn on the step frame: the confirm (1), the comparison and the connection before
 * the PC's approval (2), the connection after it (3), and a pairing that failed (no step). `undefined`:
 * the screen is not a pairing step (the ready checkpoint too: a saved PC's enrollment retry reaches it).
 */
function pairingStep(state: RelayShellState): 1 | 2 | 3 | null | undefined {
  switch (state.kind) {
    case "confirm": return 1;
    case "compare": return 2;
    // a saved PC opening again connects, and fails, on the card: only a new pairing has steps
    case "connecting": return state.pairing ? (state.approved ? 3 : 2) : undefined;
    case "failed": return state.pairing ? null : undefined;
    default: return undefined;
  }
}

/** The PC page that opened Add a PC by its address (MachineSidebar.openAddPc), taken off so it serves that one opening alone. */
function takeAddFrom(): string | null {
  try {
    const from = sessionStorage.getItem(ADD_PC_FROM_KEY);
    sessionStorage.removeItem(ADD_PC_FROM_KEY);
    return from !== null && serverIdOfPath(from) !== null ? from : null;
  } catch { return null; }
}

/**
 * Back from Add a PC opened by its address (`/#add`): to the PC page whose More opened it (`from`), or, for a link or a
 * bookmark from elsewhere, the front page itself, the `#add` dropped so a reload does not open it again.
 */
export function leaveAddEntry(from: string | null, history: Pick<History, "back" | "replaceState"> = window.history): void {
  if (from !== null) history.back();
  else history.replaceState(null, "", "/");
}

function addingPcOpen(state: RelayShellState): boolean {
  return state.kind === "code-entry" || state.kind === "code-looking" || state.kind === "code-compare";
}
