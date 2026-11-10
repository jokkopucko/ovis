import "./RelayOverview.css";

import { AlertCircle, ChevronRight, Monitor } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { MIN_SERVER_VERSION } from "../../shared/relay-mux.ts";
import type { MyPc } from "../lib/account/myPcs.ts";
import { DEVICE_PROVIDERS } from "../lib/account/service.ts";
import type { AccountProvider } from "../lib/account/store.ts";
import { copyText } from "../lib/clipboard.ts";
import { currentLocale, useT } from "../lib/i18n.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import { dashboardModel, relayHost, type DashboardFilter, type DashboardPc } from "../lib/relay/dashboard.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import type { ObservedVersion } from "../lib/relay/updateFlow.ts";
import { serverScopePath } from "../lib/shellMode.ts";
import { skeletonRows } from "../lib/skeleton.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { PROVIDER_NAMES } from "./AccountPcs.tsx";
import { INSTALLER_COMMAND } from "./RelayShellScreens.tsx";
import { Skeleton } from "./Skeleton.tsx";
import { StatusDot, type StatusDotState } from "./StatusDot.tsx";

export const ATTENTION_LIMIT = 3;
export const SKELETON_ROWS = 4;
export const LOADING_SPINNER_MS = 1_000;
/** The least Check again stays busy after a click, so a read that lands at once still shows it ran; it stays busy past this until the read it asked for has landed. */
export const CHECK_AGAIN_BUSY_MS = 1_000;

/** Ready and Needs you omit unchecked pairings. Needs you includes Offline as a note. */
type StripCell = { readonly key: string; readonly glyph: StatusDotState; readonly label: string; readonly count: number; readonly onClick: () => void; readonly pressed: boolean; readonly offline?: number };

export interface RelayOverviewProps {
  readonly pcs: readonly DashboardPc[] | null;
  readonly mode?: "account" | "local";
  readonly defaultRelay: string;
  readonly meLabel?: string;
  /** The sign-in of the account on show. With it, an account without a PC says how to add one. */
  readonly provider?: AccountProvider;
  readonly now?: number;
  readonly error?: string | null;
  readonly pcStatus?: ReadonlyMap<string, PcStatus>;
  readonly observedVersions?: ReadonlyMap<string, ObservedVersion>;
  readonly targetVersion?: string;
  readonly activeFilter?: DashboardFilter;
  readonly filter?: DashboardFilter;
  readonly onSelectFilter?: (filter: DashboardFilter) => void;
  readonly onFilter?: (filter: DashboardFilter) => void;
  readonly onOpenRelay?: (origin?: string) => void;
  readonly onRetryError?: () => void;
  /** Reads the account's PCs again. A promise it returns settles when that read has landed: Check again stays busy until then. */
  readonly onRefreshAccount?: () => void | Promise<void>;
  readonly onAddPc?: () => void;
  readonly onPairByQr?: () => void;
  readonly onOpenSheet?: (pc: MyPc, mode: "new" | "join") => void;
  readonly onSelectPc?: (serverId: string) => void;
  readonly onSelect?: (serverId: string) => void;
  readonly onOpenPc?: (pc: DashboardPc) => void;
  readonly children?: ReactNode;
}

/** Latest measured handshake RTT through a relay origin, or null when no check answered through it. */
export function relayLatencyMs(relay: { readonly origin: string; readonly pcs: readonly string[] }, pcStatus: ReadonlyMap<string, PcStatus> | undefined): number | null {
  if (!pcStatus) return null;
  let best: number | null = null;
  for (const id of relay.pcs) {
    const check = pcStatus.get(id);
    if (check?.kind !== "answered" || check.route !== "relay" || (check.relay !== undefined && check.relay !== relay.origin)) continue;
    if (best === null || check.rttMs < best) best = check.rttMs;
  }
  return best;
}

/** One cause/onset sentence for an attention row: fresh Add countdown, closed window, available update, or offline duration. */
export function attentionReasonText(
  pc: DashboardPc,
  expiresAt: number | null,
  t: ReturnType<typeof useT>,
  options: { readonly now: number; readonly targetVersion: string },
): string {
  switch (pc.state) {
    case "needs-approval":
      if (expiresAt !== null) return t("new · {n} min left", { n: Math.max(1, Math.ceil((expiresAt - options.now) / 60_000)) });
      return pc.added_at !== null ? t("Add window closed · an account member must approve") : t("Needs approval");
    case "needs-update":
      return t("update to {version}", { version: options.targetVersion });
    case "offline": {
      if (pc.last_seen_at === null) return t("Offline");
      const minutes = Math.max(1, Math.round((options.now - Date.parse(pc.last_seen_at)) / 60_000));
      if (minutes < 60) return t("offline since {n} min", { n: minutes });
      if (minutes < 60 * 48) return t("offline since {n} h", { n: Math.round(minutes / 60) });
      return t("offline since {when}", { when: new Date(pc.last_seen_at).toLocaleDateString(currentLocale()) });
    }
    case "paired":
      return t("Ready");
  }
}

function rowAction(pc: DashboardPc, fresh: boolean, t: ReturnType<typeof useT>, props: Pick<RelayOverviewProps, "onOpenSheet" | "onSelectPc" | "onSelect" | "onOpenPc">): ReactNode {
  const openPc = (): void => { if (props.onOpenPc) props.onOpenPc(pc); else window.location.assign(serverScopePath(pc.server_id)); };
  const selectPc = (): void => { (props.onSelectPc ?? props.onSelect)?.(pc.server_id); };
  switch (pc.state) {
    case "needs-approval":
      if (!pc.join) return null;
      return fresh
        ? <button type="button" className="btn" data-attention-action="add" onClick={() => props.onOpenSheet?.(pc, "new")}>{t("Add")}</button>
        : <button type="button" className="btn" data-attention-action="join" onClick={() => props.onOpenSheet?.(pc, "join")}>{t("Join")}</button>;
    case "needs-update":
      return pc.paired ? <button type="button" className="btn" data-attention-action="update" onClick={openPc}>{t("Update")}</button> : null;
    case "offline":
      if (pc.paired) return <button type="button" className="btn" data-attention-action="details" onClick={selectPc}>{t("Details")}</button>;
      return pc.join ? <button type="button" className="btn" data-attention-action="join" onClick={() => props.onOpenSheet?.(pc, "join")}>{t("Join")}</button> : null;
    case "paired":
      return <button type="button" className="btn" data-attention-action="open" onClick={openPc}>{t("Open")}</button>;
  }
}

/** The installer for a PC on Windows, as README.md gives it: the `sh` line of `INSTALLER_COMMAND` does not run there. */
export const WINDOWS_INSTALLER_COMMAND = "irm https://ovis.sh/install.ps1 | iex";
/** How long Copy reads Copied after a copy that worked. */
export const COPIED_MS = 1_600;

/** One installer line under the system it is for, with its Copy button: the first step of an account that has no PC yet. */
function InstallCommand({ os, command, action }: { readonly os: string; readonly command: string; readonly action: string }) {
  const t = useT();
  const osId = useId();
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  useEffect(() => () => { if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current); }, []);
  const copy = (): void => {
    void copyText(command, preRef.current).then((ok) => {
      if (!ok) return;
      setCopied(true);
      // one timer at a time: an earlier copy's must not turn the label back early
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => { copiedTimer.current = null; setCopied(false); }, COPIED_MS);
    });
  };
  return (
    <>
      <span id={osId} className="relay-overview-empty-os">{os}</span>
      <div className="relay-overview-empty-command-row">
        <pre ref={preRef} className="relay-overview-empty-command"><code>{command}</code></pre>
        {/* two Copy buttons on one screen: each is described by the system its line is for */}
        <button type="button" className="btn" data-action={action} aria-describedby={osId} onClick={copy}>{t(copied ? "Copied" : "Copy")}</button>
      </div>
    </>
  );
}

export function RelayOverview(props: RelayOverviewProps) {
  const { pcs, mode = "account", defaultRelay, meLabel, provider, error = null, pcStatus, targetVersion = MIN_SERVER_VERSION, onOpenRelay, onAddPc, onPairByQr, children } = props;
  const currentFilter = props.activeFilter ?? props.filter;
  const selectFilter = props.onSelectFilter ?? props.onFilter;
  const refreshAccount = props.onRefreshAccount;
  const retryError = props.onRetryError ?? (refreshAccount ? (): void => { void refreshAccount(); } : undefined);
  const t = useT();
  const now = props.now ?? Date.now();
  const loading = pcs === null;
  const [showSpinner, setShowSpinner] = useState(false);
  const [checking, setChecking] = useState(false);
  const checkTimer = useRef<number | null>(null);
  // what a Check again still waits for: its least busy time, and the read it asked for
  const checkWaits = useRef<{ timer: boolean; read: boolean }>({ timer: false, read: false });
  const mounted = useRef(false);
  const announcedWait = useAnnouncedText(loading ? t("Loading your PCs…") : null);

  useEffect(() => {
    if (!loading) { setShowSpinner(false); return; }
    const timer = window.setTimeout(() => setShowSpinner(true), LOADING_SPINNER_MS);
    return () => window.clearTimeout(timer);
  }, [loading]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (checkTimer.current !== null) window.clearTimeout(checkTimer.current); };
  }, []);

  const checkAgain = (): void => {
    if (checking || !refreshAccount) return;
    const waits = { timer: true, read: true };
    checkWaits.current = waits;
    // a later Check again has its own waits: an earlier one's late answer ends nothing of it
    const landed = (part: "timer" | "read"): void => {
      waits[part] = false;
      if (checkWaits.current === waits && !waits.timer && !waits.read && mounted.current) setChecking(false);
    };
    setChecking(true);
    checkTimer.current = window.setTimeout(() => { checkTimer.current = null; landed("timer"); }, CHECK_AGAIN_BUSY_MS);
    let read: void | Promise<void>;
    try { read = refreshAccount(); } catch { read = undefined; }
    void Promise.resolve(read).then(() => landed("read"), () => landed("read"));
  };
  // only a signed-in dashboard says how to add a PC: without an account there is no list a PC could join. A list that
  // could not be read is not known to be empty: under that banner nobody is told to install Ovis and add a PC again
  const providerName = mode === "account" && provider !== undefined && error === null ? PROVIDER_NAMES[provider] : null;
  // a PC's own page signs in through a device flow, which Apple has none of: such an account is not told to sign in there with Apple
  const pcCanSignIn = provider !== undefined && (DEVICE_PROVIDERS as readonly string[]).includes(provider);

  const model = pcs === null ? null : dashboardModel(pcs, { label: meLabel ?? t("This device"), now, ...(pcStatus ? { status: pcStatus } : {}) }, defaultRelay);
  const byId = new Map((model?.rows ?? []).map((row) => [row.server_id, row]));
  const stripCells: readonly StripCell[] = model === null ? [] : mode === "local"
    ? [
      { key: "paired", glyph: "offline", label: t("Paired with this device"), count: model.counts.paired, onClick: () => selectFilter?.("all"), pressed: currentFilter === "all" },
      { key: "relays", glyph: "ready", label: t("Relays"), count: model.relays.length, onClick: () => onOpenRelay?.(), pressed: false },
    ]
    : [
      { key: "ready", glyph: "ready", label: t("Ready"), count: model.counts.ready, onClick: () => selectFilter?.("ready"), pressed: currentFilter === "ready" },
      { key: "needs", glyph: "needs-you", label: t("Needs you"), count: model.counts.needsYou, onClick: () => selectFilter?.("needs"), pressed: currentFilter === "needs", offline: model.counts.offline },
      { key: "relays", glyph: "ready", label: t("Relays in use"), count: model.relays.length, onClick: () => onOpenRelay?.(), pressed: false },
    ];
  // the attention rows on show, with the reason each one carries; a reason they all share is said once, above them
  const attentionRows = (model?.attention ?? []).slice(0, ATTENTION_LIMIT).flatMap(({ server_id, reason, expiresAt }) => { const pc = byId.get(server_id); return pc === undefined ? [] : [{ pc, reason, expiresAt, why: attentionReasonText(pc, expiresAt, t, { now, targetVersion }) }]; });
  // how many PCs this device reaches right now and by which way; a check still running or never run counts nowhere
  const reachable = { direct: 0, relay: 0, none: 0 };
  for (const { check } of model?.rows ?? []) if (check !== null && check.kind !== "checking") reachable[check.kind === "offline" ? "none" : check.route === "relay" ? "relay" : "direct"] += 1;
  const firstAttention = attentionRows[0];
  const sharedReason = firstAttention !== undefined && attentionRows.length > 1 && attentionRows.every((row) => row.why === firstAttention.why) ? firstAttention.why : null;

  return (
    <div className="relay-overview" data-overview-mode={mode}>
      <div className="visually-hidden" role="status" aria-live="polite">{announcedWait}</div>
      {error !== null && (
        <div className="relay-overview-banner" role="alert" data-directory-error="">
          <AlertCircle className="relay-overview-banner-icon" aria-hidden="true" />
          <p className="relay-overview-banner-text">{error}</p>
          {retryError && <button type="button" className="btn" data-action="retry-directory" onClick={retryError}>{t("Try again")}</button>}
        </div>
      )}
      {loading || model === null ? (
        <div className="relay-overview-loading" data-dashboard-loading="">
          <section className="relay-overview-strip" aria-label={t("Summary")}>
            {([["ready", "ready", t("Ready")], ["needs", "needs-you", t("Needs you")], ["relays", "ready", t("Relays in use")]] as const).map(([key, glyph, label]) => (
              <div key={key} className="relay-overview-strip-btn is-skeleton" data-strip-cell={key}>
                <span className="relay-overview-strip-label"><StatusDot state={glyph} /><span>{label}</span></span>
                <span className="relay-overview-strip-value" data-loading-slot="strip-numeral"><Skeleton className="relay-overview-skeleton-numeral" /></span>
              </div>
            ))}
          </section>
          <div className="relay-overview-skeleton-table" aria-hidden="true">
            {skeletonRows(SKELETON_ROWS).map((width, index) => (
              <div key={index} className="relay-overview-skeleton-row" data-loading-slot="table-row">
                <Skeleton className="relay-overview-skeleton-dot" /><Skeleton width={width} /><Skeleton className="relay-overview-skeleton-meta" /><Skeleton className="relay-overview-skeleton-action" />
              </div>
            ))}
          </div>
          {showSpinner && <div className="relay-overview-spinner" aria-hidden="true"><div className="boot-spinner" aria-hidden="true" /></div>}
        </div>
      ) : pcs.length === 0 ? (
        <section className="relay-overview-empty" data-dashboard-empty="">
          <Monitor className="relay-overview-empty-icon" aria-hidden="true" />
          <h2 className="relay-overview-empty-title">{t("No PCs yet")}</h2>
          {providerName === null ? (
            // the banner above already says the list could not be read: the heading stands alone under it
            error === null && <p className="relay-overview-empty-copy">{t("Sign in on a PC, or scan the QR code it shows, to see it here.")}</p>
          ) : (
            <>
              <ol className="relay-overview-empty-steps" data-empty-steps="">
                <li>
                  <span>{t("Install Ovis on the PC.")}</span>
                  <InstallCommand os={t("On macOS or Linux:")} command={INSTALLER_COMMAND} action="copy-install" />
                  <InstallCommand os={t("On Windows, in PowerShell:")} command={WINDOWS_INSTALLER_COMMAND} action="copy-install-windows" />
                </li>
                <li>{pcCanSignIn
                  ? t("On that PC, open Settings → Devices and PCs → Account and sign in with the same {provider} account as on this device.", { provider: providerName })
                  : t("On that PC, open Settings → Devices and PCs → Account and sign in with a GitHub or Google sign-in that is linked to this account.")}</li>
                <li>{t("Choose Add this PC to my account there. It then shows here with Add.")}</li>
              </ol>
              <p className="relay-overview-empty-copy" data-empty-provider="">{pcCanSignIn
                ? t("Signed in with {provider}. GitHub and Google are separate Ovis accounts until you link them, so a PC signed in the other way is not listed here.", { provider: providerName })
                : t("Signed in with {provider}. A PC signs in with GitHub or Google only, and each is a separate Ovis account until you link it to this one. Without a linked sign-in, pair with a QR or code instead.", { provider: providerName })}</p>
            </>
          )}
          <div className="relay-overview-empty-actions">
            {/* aria-disabled, not disabled: a press keeps the focus it had instead of dropping it to the page */}
            {providerName !== null && refreshAccount && <button type="button" className="btn relay-overview-check-again" data-action="check-again" aria-disabled={checking || undefined} aria-busy={checking || undefined} onClick={checkAgain}>{t(checking ? "Checking…" : "Check again")}</button>}
            {onAddPc && <button type="button" className="btn btn-primary" data-action="add-pc" onClick={onAddPc}>{t("Add a PC")}</button>}
            {onPairByQr && <button type="button" className="btn btn-ghost" data-action="pair-qr" onClick={onPairByQr}>{t("Pair with a QR or code")}</button>}
          </div>
        </section>
      ) : (
        <>
          <section className="relay-overview-strip" data-local={mode === "local" ? "" : undefined} aria-label={t("Summary")}>
            {stripCells.map((cell) => (
              <button key={cell.key} type="button" className="relay-overview-strip-btn" data-strip-cell={cell.key} data-strip-count={cell.count} data-strip-offline={cell.offline}
                aria-pressed={cell.pressed ? true : undefined} onClick={cell.onClick}>
                <span className="relay-overview-strip-label"><StatusDot state={cell.glyph} /><span>{cell.label}</span></span>
                <strong className="relay-overview-strip-value">{cell.count}</strong>
                {cell.offline !== undefined && cell.offline > 0 && <small className="relay-overview-strip-note">{t("incl. {count} offline", { count: cell.offline })}</small>}
              </button>
            ))}
          </section>
          <div className="relay-overview-connectivity">
            <ul className="relay-overview-relays" aria-label={t("Relays")}>
              {model.relays.map((relay) => {
                const rtt = relayLatencyMs(relay, pcStatus);
                return (
                  <li key={relay.origin} className="relay-overview-relay-item">
                    <button type="button" className="pill relay-overview-relay-chip" onClick={() => onOpenRelay?.(relay.origin)}>{relayHost(relay.origin)}</button>
                    <span className="relay-overview-relay-count">{relay.pcs.length === 1 ? t("1 PC") : t("{count} PCs", { count: relay.pcs.length })}</span>
                    <span className="relay-overview-relay-scope">{relay.regional ? t("regional") : t("global")}</span>
                    {rtt !== null && <span className="relay-overview-relay-rtt">{t("{n} ms", { n: rtt })}</span>}
                  </li>
                );
              })}
            </ul>
            {reachable.direct + reachable.relay + reachable.none > 0 && (
              <p className="relay-overview-reach" data-reachable-direct={reachable.direct} data-reachable-relay={reachable.relay} data-reachable-none={reachable.none}>{t("Reachable now: {direct} direct · {relay} via relay · {none} no answer", reachable)}</p>
            )}
          </div>
          {mode === "account" && attentionRows.length > 0 && (
            <section className="relay-overview-attention-section" aria-label={t("Needs you")}>
              {(sharedReason !== null || model.attention.length > ATTENTION_LIMIT) && (
                <div className="relay-overview-attention-head">
                  {sharedReason !== null && <p className="relay-overview-attention-caption">{sharedReason}</p>}
                  {model.attention.length > ATTENTION_LIMIT && (
                    <button type="button" className="btn btn-ghost relay-overview-view-all" data-action="view-all-attention" data-attention-total={model.counts.needsYou} onClick={() => selectFilter?.("needs")}>
                      {t("View all {count}", { count: model.counts.needsYou })}
                    </button>
                  )}
                </div>
              )}
              <ol className="relay-overview-attention">
                {attentionRows.map(({ pc, reason, expiresAt, why }) => (
                  <li key={pc.server_id} className="relay-overview-attention-row" data-pc-state={pc.state}>
                    <StatusDot state={reason === "offline" ? "offline" : "needs-you"} />
                    <span className="relay-overview-attention-name" title={pc.name}>{pc.name}</span>
                    <span className="relay-overview-attention-why">{sharedReason === null ? why : pc.relay !== null ? relayHost(pc.relay) : pc.last_seen_at !== null ? lastSeen(pc.last_seen_at, now) : "—"}</span>
                    <div className="relay-overview-attention-act">{rowAction(pc, expiresAt !== null, t, props)}</div>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {children}
          <button type="button" className="relay-overview-map-disclosure" data-action="open-connection-map" onClick={() => onOpenRelay?.()}>
            <span className="relay-overview-map-title">{t("Connection map")}</span>
            <span className="relay-overview-map-summary">
              {model.relays.length === 1 ? t("1 relay") : t("{count} relays", { count: model.relays.length })} · {pcs.length === 1 ? t("1 PC") : t("{count} PCs", { count: pcs.length })}
            </span>
            <ChevronRight className="relay-overview-map-chevron" aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );
}
