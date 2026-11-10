import "./RelayShell.css";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { GLOBAL_RELAY } from "../../shared/relay-regions.ts";
import { myPcs, type MyPc } from "../lib/account/myPcs.ts";
import type { AccountProvider } from "../lib/account/store.ts";
import { useT } from "../lib/i18n.ts";
import { dashboardPcs } from "../lib/relay/dashboard.ts";
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
import { RelayDashboard } from "./RelayDashboard.tsx";
import { EnrollmentStatus } from "./EnrollmentStatus.tsx";
import { INSTALLER_COMMAND, PLUGIN_COMMANDS, RelayShellCardContent, TypedDigits } from "./RelayShellScreens.tsx";

export { INSTALLER_COMMAND, PLUGIN_COMMANDS, TypedDigits };

export interface RelayShellProps {
  state: RelayShellState;
  /** how each saved PC answered the front page's latest check (pcStatus.ts), by server id */
  pcStatus?: ReadonlyMap<string, PcStatus>;
  /** Check now: probe the saved PCs again; Details' Check now: one PC, not the fleet sweep */
  onCheckPcs?: () => void; onCheckPc?: (serverId: string) => void;
  /** Explicit directory retry; independent of the liveness probe sweep. */
  onRefreshAccount?: () => void | Promise<void>;
  /** Admission succeeded; only this action hands the scoped page to the PC app. */
  onOpenPc?: () => void;
  /** Reloaded independently after a scope navigation, never copied into session storage. */
  continuedAccount?: AccountView | null;
  /** Versions from admitted sessions only; a liveness probe never supplies one. */
  observedVersions?: ReadonlyMap<string, ObservedVersion>;
  /** on a PC's own page (`/s/<id>/`), where Back leads to the front page; iosTab: an iPhone or iPad browser tab */
  scoped: boolean; iosTab: boolean;
  onPair: () => void; onRetry: () => void; onCancel: () => void; onBack: () => void; onForget: () => void;
  onForgetPc?: (serverId: string) => Promise<void> | void;
  /** a PC below the shell's minimum version with a managed install: install its latest release */
  onUpdate: () => void;
  /** pairing without a code: the digits on this screen are the ones the PC shows (`typed`: typed from the PC's screen) */
  onMatch: (typed?: string) => void;
  /** the front page's sign-in: off to the provider's pages */
  onSignIn?: (provider: AccountProvider) => void;
  /** a PC of the account this device is not paired with: compare digits with it */
  onJoin?: (pc: MyPc, options?: { typed?: boolean; sheet?: "new" | "join" }) => void;
  /** on a PC's own page: the join the dashboard's sheet started for this PC, which the sheet takes up again over the pairing screens */
  sheetJoin?: { mode: "new" | "join"; server_id: string; returnHash?: string } | null;
  onSignOut?: () => void; onLeave?: () => void;
  /** the sign-ins the account service offers (accountProvidersOf); GitHub alone by default */
  accountProviders?: readonly AccountProvider[];
  /** the relay each PC of the account's directory named (DirectoryPc.relay), for the dashboard's rows */
  directoryRelays?: readonly { server_id: string; relay: string | null }[];
  /** the shell's default relay origin, where the dashboard puts a PC with no known relay; meLabel: this device on the map */
  defaultRelay?: string; meLabel?: string;
  /** Pair with a code: the field to type it in; onCodeSubmit: the code as typed; onCodeMatch: the ID matches */
  onCodeStart: () => void; onCodeSubmit: (code: string) => void; onCodeMatch: () => void;
}

/** The field a code is typed in, kept in the input itself (src/AGENTS.md: secret input stays in the DOM). */
export function CodeEntry({ failure, looking = false, onSubmit, back, titleTag: Title = "h1", titleId, formId, omitHeading = false }: { readonly failure: TypedCodeFailure | null; readonly looking?: boolean | undefined; readonly onSubmit: (code: string) => void; readonly back?: ReactNode; readonly titleTag?: "h1" | "h2" | undefined; /** the id a dialog around this screen is labelled by */ readonly titleId?: string | undefined; /** when inside a modal sheet whose footer owns the submit button */ readonly formId?: string | undefined; readonly omitHeading?: boolean | undefined }) {
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

/**
 * The hosted shell's screens before the app: the sign-in column, the dashboard, the continued
 * sheet over the dashboard frame across a scoped join, and the pairing/recovery screens.
 */
export function RelayShell(props: RelayShellProps) {
  const { state, pcStatus, onCheckPcs, onCheckPc, onRefreshAccount, observedVersions, scoped, onPair, onRetry, onCancel, onBack, onForgetPc, onMatch, onCodeStart, onCodeSubmit, onCodeMatch, onOpenPc, continuedAccount, onSignIn, onJoin, sheetJoin = null, onSignOut, onLeave, directoryRelays = [], defaultRelay = GLOBAL_RELAY, meLabel } = props;
  const t = useT();
  const [cachedAccount, setCachedAccount] = useState<AccountView | null>(null);
  const rawAccount: AccountView | null = (state.kind === "list" || state.kind === "empty") && onSignIn ? state.account ?? null : null;
  if (rawAccount !== null && rawAccount !== cachedAccount) setCachedAccount(rawAccount);
  const account: AccountView | null = rawAccount ?? (addingPcOpen(state) && onSignIn ? cachedAccount : null);
  const [signedOutView, setSignedOutView] = useState<"sign-in" | "pair" | "saved">("sign-in");
  const [sheet, setSheet] = useState<{ pc: MyPc | null; mode: AddPcSheetMode } | null>(null);
  const [addingPc, setAddingPc] = useState(false);
  const saved = state.kind === "list" ? state.devices.length : 0;
  const signedOutOrSigningIn = account?.kind === "signed-out" || account?.kind === "signing-in";
  const view = !signedOutOrSigningIn ? null : signedOutView === "saved" && saved === 0 ? "sign-in" : signedOutView;
  const signInFirst = view === "sign-in";
  // a sign-out found while the QR dialog is open closes it: the sign-in stays the only screen, and a later sign-in opens no stale dialog
  if (addingPc && signInFirst) setAddingPc(false);
  const name = state.kind === "confirm" || state.kind === "code-compare" ? state.offer.name ?? null
    : state.kind === "list" || state.kind === "empty" || state.kind === "code-entry" || state.kind === "code-looking" ? null : state.name;
  const pc = name ?? t("this PC");
  const stateName = state.kind === "failed" ? state.failure : state.kind === "outdated" ? "pc-outdated" : state.kind === "forged" ? "identity-changed" : state.kind;
  const devices = state.kind === "list" ? state.devices : [];
  const local = view === "saved" && state.kind === "list";

  if (account && (account.kind === "signed-in" || local)) {
    const signedIn = account.kind === "signed-in" ? account : null;
    const outdatedIds = new Set([...(observedVersions ?? [])].filter(([, value]) => value.outdated).map(([id]) => id));
    const modalOpen = sheet !== null || addingPc;
    const dash = (
      <RelayDashboard
        pcs={signedIn ? (signedIn.pcs === null ? null : dashboardPcs(signedIn.pcs, devices, directoryRelays)) : dashboardPcs(myPcs([], devices, { now: Date.now(), outdated: outdatedIds }), devices)}
        account={signedIn ? { provider: signedIn.provider } : null}
        defaultRelay={defaultRelay}
        meLabel={meLabel ?? t("This device")}
        error={signedIn?.error ?? null}
        {...(pcStatus ? { pcStatus } : {})}
        {...(observedVersions ? { observedVersions } : {})}
        {...(onCheckPcs ? { onCheckPcs } : {})}
        {...(onCheckPc ? { onCheckPc } : {})}
        {...(onRefreshAccount ? { onRefreshAccount } : {})}
        onAddPc={() => setSheet({ pc: null, mode: "add" })}
        onPairByQr={() => { setSheet(null); setAddingPc(true); }}
        onOpenSheet={(target, mode) => setSheet({ pc: target, mode })}
        {...(onForgetPc ? { onForgetPc } : {})}
        {...(signedIn ? {} : { onSignIn: () => setSignedOutView("sign-in") })}
        {...(signedIn && onSignOut ? { onSignOut } : {})}
        {...(signedIn && onLeave ? { onLeave } : {})}
      />
    );
    return (
      <main className="relay-dash-screen" data-relay-state={stateName} data-account-state={account.kind}>
        {/* one wrapper whether a sheet is open or not: swapping it in would remount the dashboard, losing the control that opened the sheet before its focus trap records it */}
        <div inert={modalOpen || undefined}>{dash}</div>
        {sheet && (
          <AddPcSheet mode={sheet.mode} pc={sheet.pc} state={state} onJoin={(target, options) => onJoin?.(target, { ...options, sheet: sheet.mode === "new" ? "new" : "join" })} onPair={onPair} onMatch={onMatch} onCancel={onCancel} onClose={() => setSheet(null)} onPairByQr={() => { setSheet(null); setAddingPc(true); }} />
        )}
        {addingPc && (
          <PairQrDialog state={state} onCodeStart={onCodeStart} onCodeSubmit={onCodeSubmit} onCodeMatch={onCodeMatch} onCancel={onCancel} onClose={() => {
            setAddingPc(false);
            queueMicrotask(() => { if (document.activeElement === null || document.activeElement === document.body) [...document.querySelectorAll<HTMLElement>('[data-action="add-pc"]')].find((el) => el.getClientRects().length > 0)?.focus({ preventScroll: true }); });
          }} />
        )}
      </main>
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
        <AddPcSheet mode={sheetJoin.mode} pc={joining} state={state} onJoin={() => {}} onPair={onPair} onMatch={onMatch} onRetry={onRetry} {...(onOpenPc ? { onOpenPc } : {})} onCancel={onCancel} onClose={onBack} onPairByQr={onCodeStart} />
      </main>
    );
  }

  return (
    <main className="relay-shell-screen" data-relay-state={stateName} {...(account ? { "data-account-state": account.kind } : {})}>
      <div className={signInFirst || state.kind === "compare" ? "relay-shell account-centered" : "relay-shell"}>
        <img src="/icons/icon-192.png?v=sheep1" alt="" width="44" height="44" className="relay-shell-mark" />
        <RelayShellCardContent props={props} view={view} signInFirst={signInFirst} saved={saved} addingPc={addingPc} setSignedOutView={setSignedOutView} setAddingPc={setAddingPc} />
      </div>
    </main>
  );
}

function addingPcOpen(state: RelayShellState): boolean {
  return state.kind === "code-entry" || state.kind === "code-looking" || state.kind === "code-compare";
}
