import { useContext, useEffect, useState } from "react";
import { Download, Info, X } from "lucide-react";
import { CHECKOUT_CHANGED_REASON, DESKTOP_APP_UPDATES, SUMMARY_GROUPS, type SummaryGroup, type UpdateNotes, type UpdateStatus } from "../../shared/update.ts";
import { useHerdrUpdate } from "../lib/herdrUpdate.ts";
import { runningAppVersion, runningHerdrVersion, staleClientVersion, versionLabel } from "../lib/runningVersion.ts";
import { useSettings } from "../lib/settings.ts";
import { announcesUpdate, readAnnounced, readOfferClosed, summaryFor, watchAnnounced, watchOfferClosed, writeAnnounced, writeOfferClosed } from "../lib/updateNotes.ts";
import { describeUpdate } from "../lib/updateProgress.ts";
import type { UpdatesModel } from "../lib/updates.ts";
import { useDesktopAppUpdate, type DesktopAppUpdate, type DesktopUpdateLine } from "../lib/desktopUpdate.ts";
import { usePreviewAppUpdate } from "../lib/previewAppUpdate.ts";
import { lazyChunkFailed, onLazyChunkFailure } from "../lib/lazyChunk.ts";
import { Markdown } from "./Markdown.tsx";
import { ProgressLine } from "./ProgressBar.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { SettingsBare, SettingsRow } from "./SettingsControls.tsx";
import "./Machines.css";
import "./UpdateControls.css";
import { useLocale, useT, type Translate } from "../lib/i18n.ts";
import { ExternalLink } from "../lib/externalLink.ts";

const BLOCKED_REASONS: ReadonlyArray<{ is: (reason: string) => boolean; words: (t: Translate) => string }> = [
  { is: (reason) => reason === "Start with bun run start or the herdr plugin to enable updates.", words: (t) => t("Start with bun run start or the herdr plugin to enable updates.") },
  { is: (reason) => reason === "Switch the source checkout to main to update.", words: (t) => t("Switch the source checkout to main to update.") },
  { is: (reason) => reason.startsWith("Ovis runs here as an installed release"), words: (t) => t("Ovis runs here as an installed release: update it by running the installer again (curl -fsSL https://ovis.sh/install.sh | sh, or irm https://ovis.sh/install.ps1 | iex on Windows), then restart Ovis.") },
  { is: (reason) => reason.startsWith("Ovis runs here as the herdr plugin's compiled server"), words: (t) => t("Ovis runs here as the herdr plugin's compiled server: update it with herdr (herdr plugin update devswha.ovis), then restart Ovis.") },
  { is: (reason) => reason === CHECKOUT_CHANGED_REASON, words: (t) => t("The source checkout changed. Restart the app before updating.") },
  { is: (reason) => reason === "The source checkout has local changes. Commit or move them before updating.", words: (t) => t("The source checkout has local changes. Commit or move them before updating.") },
  { is: (reason) => reason === "Updates require a Git checkout on the main branch.", words: (t) => t("Updates require a Git checkout on the main branch.") },
  { is: (reason) => reason.startsWith("This server runs from an installed update's folder"), words: (t) => t("This server runs from an installed update's folder, not from its source checkout. Restart Ovis from its source checkout (the herdr plugin's Stop, then Start, or bun run start there) to update.") },
  { is: (reason) => reason.startsWith("The running version is not part of the release history"), words: (t) => t("The running version is not part of the release history; automatic downgrade is disabled.") },
];

export function blockedReasonWords(reason: string, t: Translate): string {
  return BLOCKED_REASONS.find((entry) => entry.is(reason))?.words(t) ?? reason;
}

declare const __APP_VERSION__: string;

const CHANGELOG = "https://github.com/devswha/ovis/blob/main/CHANGELOG.md";
const RESTART_HELP = "https://github.com/devswha/ovis/blob/main/docs/guide.md#updates";

function ReleaseNotes({ notes, label }: { notes: Pick<UpdateNotes, "releases" | "omitted">; label: string }) {
  const t = useT();
  const { resolvedLanguage } = useSettings();
  const groups: Record<SummaryGroup, string> = { new: t("New features"), improved: t("Improvements"), fixed: t("Bug fixes") };
  return <>
    <span className="settings-label">{label}</span>
    <div className="update-notes" role="region" aria-label={label}>
      {notes.releases.map((release) => {
        const summary = summaryFor(release, resolvedLanguage);
        const section = <div className="update-changelog" role="region" aria-label={t("Full changelog")} tabIndex={0}>
          <RenderBoundary resetKey={release.notes} fallback={() => <p className="settings-hint">{t("These notes could not be shown.")} <ExternalLink kind="link" href={CHANGELOG}>{t("Full changelog")}</ExternalLink></p>}>
            <Markdown>{release.notes}</Markdown>
          </RenderBoundary>
        </div>;
        return <section key={release.version}>
          <h4>v{release.version}{release.date && <time>{release.date}</time>}</h4>
          {summary === null ? section : <>
            <div className="update-summary">
              {SUMMARY_GROUPS.map((group) => summary[group] && <div key={group}>
                <h5>{groups[group]}</h5>
                <ul>{summary[group].map((line, index) => <li key={index}>{line}</li>)}</ul>
              </div>)}
            </div>
            <details className="update-details">
              <summary>{t("Show every change")}</summary>
              {section}
            </details>
          </>}
        </section>;
      })}
      {notes.omitted > 0 && <p className="settings-hint">{t("Earlier releases not shown here: {count}.", { count: notes.omitted })} <ExternalLink kind="link" href={CHANGELOG}>{t("Full changelog")}</ExternalLink></p>}
    </div>
  </>;
}

function UpdateProgress({ status, fallback }: { status: UpdateStatus | null; fallback: string }) {
  const t = useT();
  const view = describeUpdate(status);
  const label = view ? t(view.label) : fallback;
  return <ProgressLine className="update-progress" label={label} count={view?.step ?? null} percent={view?.percent ?? null} />;
}

/** The app's own version and check, in About's row (desktop app): the app downloads updates by itself, and this checks now */
function AppUpdateRow({ app }: { app: DesktopAppUpdate }) {
  const t = useT();
  const { state } = app;
  const update = state.update ?? "";
  const line = ((): string | null => {
    switch (state.phase) {
      case "off": return t("This build of the app does not update itself.");
      case "idle": case "failed": return null;
      case "checking": return t("Checking for updates…");
      case "latest": return t("Up to date.");
      case "downloading": return state.percent === null ? t("Downloading Ovis {version}…", { version: update }) : t("Downloading Ovis {version}… {percent}%", { version: update, percent: state.percent });
      case "ready": return t("Ovis {version} is ready.", { version: update });
    }
  })();
  // one line: the updater's errors run to several (an HTTP answer's headers), the first says what went wrong
  const error = state.phase === "failed" ? t("The update did not go through: {error}", { error: (state.error ?? "").split("\n")[0] ?? "" }) : null;
  const busy = state.phase === "checking" || state.phase === "downloading";
  return <>
    <span className="settings-fact">{t("Running {version}", { version: `v${state.version}` })}</span>
    {error !== null ? <span className="settings-hint update-app-error" role="alert" title={state.error ?? undefined}>{error}</span>
      : line !== null && <span className="settings-hint" role="status">{line}</span>}
    {state.phase === "ready" ? <button type="button" className="btn btn-primary" disabled={app.installing} onClick={app.install}>{t("Restart to Update")}</button>
      : state.phase !== "off" && <button type="button" className="btn" disabled={busy} onClick={app.check}>{t("Check for updates")}</button>}
  </>;
}

/** The phone's preview app itself, above the PC's own updates: shown only in the Android preview build */
export function PreviewAppUpdate() {
  const t = useT();
  const preview = usePreviewAppUpdate();
  if (!preview) return null;
  return <section className="settings-section settings-updates" data-section="preview-app-update" aria-label="Ovis Preview">
    <div className="settings-card">
      <SettingsRow label="Ovis Preview" description={t("This phone's preview app. A check downloads a newer preview, and Restart to Update installs it.")} icon={Info}>
        <AppUpdateRow app={preview} />
      </SettingsRow>
    </div>
  </section>;
}

export function UpdateControls({ updates, bridgesFollow = false }: { updates: UpdatesModel; bridgesFollow?: boolean }) {
  const t = useT();
  const app = useDesktopAppUpdate();
  const { status, error, busy, needsReload, reload, notes, installed, request, failure, offered } = updates;
  const locale = useLocale();
  const installing = busy && (status?.phase === "building" || status?.phase === "restarting");
  const tabVersion = staleClientVersion(status, __APP_VERSION__);
  const restart = needsReload && reload === "restart";
  const reason = status?.blocked_reason === DESKTOP_APP_UPDATES ? t("This server is part of the Ovis app, which updates them together: updates come with the app, not from here.")
    : status?.blocked_reason ? blockedReasonWords(status.blocked_reason, t) : null;
  const blocked = restart && status?.blocked_reason === CHECKOUT_CHANGED_REASON ? null : reason;
  const bare = useContext(SettingsBare);
  // the desktop app's own server: the app's row, with its own check, in place of the sentence that updates come with the app
  const desktop = status?.blocked_reason === DESKTOP_APP_UPDATES ? app : null;
  if (bare && !installing && !needsReload && failure === null && !error && !status?.error && (!blocked || desktop) && !tabVersion) {
    const state = busy ? t("Checking for updates…") : status?.available ? t("Version {version} is available.", { version: versionLabel(status.latest_version, status.latest_revision) ?? "" }) : status?.checked_at ? t("Up to date.") : null;
    return <section className="settings-section settings-updates" data-section="updates" tabIndex={-1} aria-labelledby="settings-updates-title">
      <h3 id="settings-updates-title" className="visually-hidden">{t("Updates")}</h3>
      <div className="settings-card">
        {desktop ? <SettingsRow label="Ovis" description={t("The version of the Ovis app on this PC. The app downloads updates by itself, and Restart to Update installs one.")} icon={Info}>
          <AppUpdateRow app={desktop} />
        </SettingsRow> : <SettingsRow label="Ovis" description={t("The version of Ovis running on this PC. Update and restart installs the release shown and then restarts Ovis.")} icon={Info}>
          <span className="settings-fact">{t("Running {version}", { version: runningAppVersion(status, __APP_VERSION__) })}</span>
          {state && <span className="settings-hint" role="status">{state}</span>}
          {status?.managed && (status.available
            ? <button type="button" className="btn btn-primary" disabled={busy || offered === null} onClick={() => { if (offered) void request({ command: "install", expected_revision: offered }); }}>{t("Update and restart")}</button>
            : <button type="button" className="btn" disabled={busy} onClick={() => void request({ command: "check" })}>{t("Check for updates")}</button>)}
        </SettingsRow>}
        {notes && <div className="settings-item"><ReleaseNotes notes={notes} label={t("What's new")} /></div>}
        {installed && installed.releases.length > 0 && <div className="settings-item"><ReleaseNotes notes={installed} label={t("What the last update brought")} /></div>}
      </div>
    </section>;
  }
  return <section className="settings-section settings-updates" data-section="updates" tabIndex={-1} aria-labelledby="settings-updates-title">
    <h3 id="settings-updates-title" className={bare === true ? "visually-hidden" : undefined}>{t("Updates")}</h3>
    <div className="settings-card"><div className="settings-item">
    <p className="settings-hint">{t("Running {version}", { version: runningAppVersion(status, __APP_VERSION__) })}</p>
    {tabVersion && reload !== "restart" && <p className="settings-hint">{t("This tab still runs {version} until it is reloaded.", { version: tabVersion })}</p>}
    {installing && !error ? <div role="status"><UpdateProgress status={status} fallback={t(status?.phase === "building" ? "Installing dependencies and building…" : "Restarting the bridge…")} /></div> : <p className="settings-hint" role={error || status?.error || failure ? "alert" : "status"}>
      {(failure === "offer-changed" ? t("A newer release was published after you chose this update, so nothing was installed. Check again to review it.") : null) ?? error ?? status?.error ?? (restart ? <><span>{t("Ovis was updated on this PC. Restart it there to load the update.")}</span> <ExternalLink kind="link" className="settings-link" href={RESTART_HELP}>{t("How to restart")}</ExternalLink></> : null) ?? blocked ?? (busy ? t("Checking for updates…") :
        status?.available ? t("Version {version} is available.", { version: versionLabel(status.latest_version, status.latest_revision) ?? "" }) : status?.checked_at ? t("Up to date.") : t("Waiting for an update check…"))}
    </p>}
    {restart && !error && !status?.error && blocked && <p className="settings-hint">{blocked}</p>}
    {!installing && failure === "restart" && <p className="settings-hint">{t("Restart Ovis on this PC to update from here: the server running now cannot install exactly the release shown.")}</p>}
    {notes && <ReleaseNotes notes={notes} label={t("What's new")} />}
    {installed && installed.releases.length > 0 && <ReleaseNotes notes={installed} label={t("What the last update brought")} />}
    {status?.managed && <>
      <p className="settings-hint">{t("Checks for new releases every 5 minutes.")} {t(status.auto_update ? "Automatic installation is enabled." : "Install when you are ready; the bridge briefly reconnects and herdr sessions keep running.")}{bridgesFollow ? ` ${t("Remote PCs' bridges are updated afterwards when the new version needs it.")}` : ""}</p>
      <div className="update-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void request({ command: "check" })}>{t("Check for updates")}</button>
        <button type="button" className="btn btn-primary" disabled={busy || offered === null || failure !== null} onClick={() => { if (offered) void request({ command: "install", expected_revision: offered }); }}>{t("Update and restart")}</button>
        {!installing && failure === "restart" && <ExternalLink kind="link" className="btn" href={RESTART_HELP}>{t("How to restart")}</ExternalLink>}
      </div>
    </>}
    {status?.checked_at && <p className="settings-hint">{t("Last checked {when}", { when: new Date(status.checked_at).toLocaleString(locale) })}</p>}
    {needsReload && reload !== "restart" && <p className="settings-hint">{reload === "updated" ? t("The server was updated. Save any unsent drafts, then") : t("Part of the app could not load. Save unsent drafts, then reload.")} <button type="button" className="btn" onClick={() => window.location.reload()}>{t("Reload app")}</button></p>}
    </div></div>
  </section>;
}

/**
 * herdr itself. `herdr update` typed into a pane is refused by herdr, and every terminal here is
 * a pane: the server runs it instead and moves the running panes onto the new version.
 */
export function HerdrUpdateControls({ enabled, herdrVersion, showVersion = false }: { enabled: boolean; herdrVersion: string | null; showVersion?: boolean }) {
  const t = useT();
  const { status, error, busy, request } = useHerdrUpdate(enabled);
  const version = runningHerdrVersion(status, herdrVersion);
  const bare = useContext(SettingsBare);
  if (bare && !(status?.supported && ((status.stale && !!status.binary_version && !!status.server_version) || error || busy || status.output || status.phase === "error"))) {
    return status?.supported || (showVersion && version) ? <section className="settings-section settings-herdr-update">
      <div className="settings-card">
        <SettingsRow label="herdr" description={t("Installs the newest herdr on the PC this app runs on and moves its running panes onto it. Panes and agents keep running, and open terminals reconnect.")} icon={Download}>
          {showVersion && version && <span className="settings-fact">{version}</span>}
          {status?.supported && <button type="button" className="btn" onClick={() => void request()}>{t("Update herdr")}</button>}
        </SettingsRow>
      </div>
    </section> : null;
  }
  // Windows, an older server, a herdr that does not answer: nothing to offer, and the version
  // the health check reported is still read here, since the sidebar no longer carries it
  if (!status?.supported) {
    return version ? <section className="settings-section settings-herdr-update">
      <h3>herdr</h3>
      <div className="settings-card"><p className="settings-item settings-hint">{t("Running herdr {version}", { version })}</p></div>
    </section> : null;
  }
  const stale = status.stale && !!status.binary_version && !!status.server_version;
  return <section className="settings-section settings-herdr-update">
    <h3>herdr</h3>
    <div className="settings-card"><div className="settings-item">
    {version && <p className="settings-hint">{t("Running herdr {version}", { version })}</p>}
    {stale && <p className="settings-hint">{t("herdr {installed} is installed, but the running server is {running}. Updating moves your panes onto the installed version.", { installed: status.binary_version ?? "", running: status.server_version ?? "" })}</p>}
    <p className="settings-hint">{t("Installs the newest herdr on the PC this app runs on and moves its running panes onto it. Panes and agents keep running, and open terminals reconnect.")}</p>
    <div className="update-actions">
      <button type="button" className={stale ? "btn btn-primary" : "btn"} disabled={busy} onClick={() => void request()}>{t("Update herdr")}</button>
    </div>
    {(error || busy) && <p className="settings-hint" role={error ? "alert" : "status"}>{error ?? t("Updating herdr…")}</p>}
    {!busy && status.output && <pre className="update-output" role={status.phase === "error" ? "alert" : undefined} data-failed={status.phase === "error" || undefined}>{status.output}</pre>}
    {/* a failure herdr printed nothing for still says it failed */}
    {!busy && !status.output && status.phase === "error" && <p className="settings-hint" role="alert">{t("herdr could not be updated, and it printed nothing to say why.")}</p>}
    </div></div>
  </section>;
}

export function UpdateNotice({ updates, onOpen }: { updates: UpdatesModel; onOpen: () => void }) {
  const t = useT();
  const { status, error, busy, needsReload, reload, notes, installed, request, failure, offered } = updates;
  const [announced, setAnnounced] = useState(readAnnounced);
  useEffect(() => { const stop = watchAnnounced(setAnnounced); setAnnounced(readAnnounced()); return stop; }, []);
  const [closedOffer, setClosedOffer] = useState(readOfferClosed);
  useEffect(() => { const stop = watchOfferClosed(setClosedOffer); setClosedOffer(readOfferClosed()); return stop; }, []);
  const [started, setStarted] = useState(false);
  useEffect(() => { if (!busy) setStarted(false); }, [busy]);
  const failed = error !== null || (status?.phase === "error" && !!status.error);
  const [attempted, setAttempted] = useState(false);
  useEffect(() => { if (!busy && !failed) setAttempted(false); }, [busy, failed]);
  const installing = status?.phase === "building" || status?.phase === "restarting";
  const looking = attempted && busy;
  if (!needsReload && !status?.available && !installing && !started && !looking && !(attempted && failed)) {
    if (!installed?.version || !announcesUpdate(status, installed, announced, Date.now())) return null;
    const version = installed.version;
    const close = () => { writeAnnounced(version); setAnnounced(version); };
    const text = t("Ovis was updated to v{version}.", { version });
    return <div className="update-notice is-line" role="status">
      <span title={text}>{text}</span>
      {installed.releases.length > 0 && <button type="button" className="btn btn-ghost" onClick={() => { close(); onOpen(); }}>{t("What's new")}</button>}
      <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={close}><X /></button>
    </div>;
  }
  if (installing || started || looking) {
    return <div className="update-notice is-line is-progress" role="status">
      <UpdateProgress status={status} fallback={t(installing ? status?.phase === "building" ? "Installing dependencies and building…" : "Restarting the bridge…" : started ? "Starting the update…" : "Checking for updates…")} />
    </div>;
  }
  if (needsReload) {
    if (reload === "restart") return <div className="update-notice is-line is-warning" role="status">
      <span>{t("Ovis was updated on this PC. Restart it there to load the update.")}</span>
      <ExternalLink kind="link" className="btn" href={RESTART_HELP}>{t("How to restart")}</ExternalLink>
    </div>;
    const text = reload === "updated" ? t("App updated. Save unsent drafts before reloading.") : t("Part of the app could not load. Save unsent drafts, then reload.");
    return <div className="update-notice is-line is-warning" role="status">
      <span>{text}</span>
      <button type="button" className="btn" onClick={() => window.location.reload()}>{t("Reload app")}</button>
    </div>;
  }
  // a server that cannot install by revision is sent no install: the line says to restart it
  if (failure === "restart") return <div className="update-notice is-line is-warning" role="status">
    <span>{t("Restart Ovis on this PC to update from here: the server running now cannot install exactly the release shown.")}</span>
    <ExternalLink kind="link" className="btn" href={RESTART_HELP}>{t("How to restart")}</ExternalLink>
  </div>;
  // A release that replaced the one asked for is looked at again too, never installed from here unseen.
  const install = failure === null ? offered : null;
  const changed = failure === "offer-changed";
  const offer = !failed && !changed && !attempted ? status?.latest_revision ?? null : null;
  if (offer !== null && offer === closedOffer) return null;
  const text = changed ? t("A newer release was published after you chose this update, so nothing was installed. Check again to review it.") : failed ? t("The update could not be installed.") : status?.latest_version ? t("Ovis v{version} is available.", { version: status.latest_version }) : t("An Ovis update is available.");
  return <div className={changed ? "update-notice is-line is-warning" : "update-notice is-line"} role="status">
    <span title={text}>{text}</span>
    {failed ? <button type="button" className="btn btn-ghost" onClick={onOpen}>{t("Details")}</button>
      : notes && <button type="button" className="btn btn-ghost" onClick={onOpen}>{t("What's new")}</button>}
    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => {
      setAttempted(true); setStarted(install !== null);
      void request(install !== null ? { command: "install", expected_revision: install } : { command: "check" });
    }}>{t(failed ? "Try again" : "Update")}</button>
    {offer !== null && <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={(event) => {
      const focused = event.currentTarget === document.activeElement;
      writeOfferClosed(offer); setClosedOffer(offer);
      if (focused) document.querySelector<HTMLElement>(".header-more-button")?.focus();
    }}><X /></button>}
  </div>;
}

export function DesktopUpdateNotice({ update }: { update: DesktopUpdateLine | null }) {
  const t = useT();
  if (update === null) return null;
  const text = t("Ovis {version} is ready.", { version: update.version });
  return <div className="update-notice is-line" role="status">
    <span title={text}>{text}</span>
    <button type="button" className="btn btn-primary" disabled={update.installing} onClick={update.install}>{t("Restart to Update")}</button>
    <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={(event) => {
      const focused = event.currentTarget === document.activeElement;
      update.close();
      if (focused) document.querySelector<HTMLElement>(".header-more-button")?.focus();
    }}><X /></button>
  </div>;
}

export function ChunkFailureNotice() {
  const t = useT();
  const [failed, setFailed] = useState(lazyChunkFailed);
  useEffect(() => { const stop = onLazyChunkFailure(() => setFailed(true)); setFailed(lazyChunkFailed()); return stop; }, []);
  if (!failed) return null;
  return <div className="update-notice is-line is-warning" role="status">
    <span>{t("Part of the app could not load. Save unsent drafts, then reload.")}</span>
    <button type="button" className="btn" onClick={() => window.location.reload()}>{t("Reload app")}</button>
  </div>;
}
