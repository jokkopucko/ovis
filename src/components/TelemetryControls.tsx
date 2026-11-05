import { useEffect, useMemo, useRef, useState } from "react";

import { NOTICE_VERSION, type TelemetryStatus } from "../../shared/telemetry.ts";
import { ApiError, changeTelemetry, fetchTelemetry } from "../lib/api.ts";
import { telemetrySettingsSnapshot, useSettings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { SettingsGroup, SettingsRow, Toggle } from "./SettingsControls.tsx";

/**
 * The one-time line about anonymous usage counts: the install and update events and the daily
 * active message with the harness kinds (shared/telemetry.ts). Showing it is what lets the
 * server send, so it is recorded once it has been painted in a visible
 * tab, and the server still waits a while before the first event so the switch behind What is sent
 * stops it. It stays one line on any width; Settings says what is sent in full.
 * Closing it only hides it in this tab.
 */
export function TelemetryNotice({ enabled, onOpen }: { enabled: boolean; onOpen: () => void }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const [closed, setClosed] = useState(false);
  // The server keeps this browser's latest safe settings snapshot for its next count. The snapshot
  // contains no raw user-entered values or account identifiers.
  const { settings } = useSettings();
  const settingsSnapshot = useMemo(() => telemetrySettingsSnapshot(settings), [settings]);
  const settingsSignature = JSON.stringify(settingsSnapshot);
  const settingsSnapshotRef = useRef(settingsSnapshot);
  settingsSnapshotRef.current = settingsSnapshot;
  const submittedSettingsSignature = useRef<string | null>(null);
  // the server's word on the switch, the environment and the notice: the snapshot is told only where
  // an event may go out, so an install that is off, blocked or has not seen the notice keeps its
  // settings to itself. The first snapshot rides with the acknowledgement below.
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const allowed = status !== null && status.enabled && !status.blocked_by_env && status.notice_seen;
  useEffect(() => {
    if (!enabled || !allowed || submittedSettingsSignature.current === settingsSignature) return;
    submittedSettingsSignature.current = settingsSignature;
    changeTelemetry({ settings: settingsSnapshot }).then(setStatus, (error: unknown) => {
      if (!(error instanceof ApiError && error.status === 404)) console.error("telemetry settings", error);
    });
  }, [enabled, allowed, settingsSignature, settingsSnapshot]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetchTelemetry().then((current) => {
      if (!live || !current) return;
      setStatus(current);
      if (!current.notice_seen && current.enabled && !current.blocked_by_env) setShown(true);
    }, (error: unknown) => console.error("telemetry status", error));
    return () => { live = false; };
  }, [enabled]);
  useEffect(() => {
    if (!shown) return;
    let recorded = false;
    let frame = 0;
    // two frames after the commit the line has been painted; a hidden tab paints nothing
    const afterPaint = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(record); });
    };
    const record = () => {
      if (recorded || document.visibilityState !== "visible") return;
      recorded = true;
      const snapshot = settingsSnapshotRef.current;
      changeTelemetry({
        notice_seen: true,
        notice_version: NOTICE_VERSION,
        settings: snapshot,
      }).then((next) => { submittedSettingsSignature.current = JSON.stringify(snapshot); setStatus(next); },
        (error: unknown) => console.error("telemetry notice", error));
    };
    const onVisibility = () => { if (document.visibilityState === "visible") afterPaint(); };
    afterPaint();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { recorded = true; cancelAnimationFrame(frame); document.removeEventListener("visibilitychange", onVisibility); };
  }, [shown]);
  if (!shown || closed) return null;
  const text = t("Ovis sends anonymous usage counts.");
  return <div className="update-notice is-line" role="status">
    <span title={text}>{text}</span>
    <button type="button" className="btn btn-ghost" onClick={() => { setClosed(true); onOpen(); }}>{t("What is sent")}</button>
    <button type="button" className="btn btn-ghost" onClick={() => setClosed(true)}>{t("Dismiss")}</button>
  </div>;
}

/** Settings → About: the switch and the messages as they would be sent. Hidden on a server that sends none. */
export function TelemetryControls() {
  const t = useT();
  const { settings } = useSettings();
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const settingsSnapshot = useMemo(() => telemetrySettingsSnapshot(settings), [settings]);
  const settingsSignature = JSON.stringify(settingsSnapshot);
  const settingsSnapshotRef = useRef(settingsSnapshot);
  settingsSnapshotRef.current = settingsSnapshot;
  const statusRequest = useRef(0);
  useEffect(() => {
    let live = true;
    const request = ++statusRequest.current;
    const snapshot = settingsSnapshotRef.current;
    setError(null);
    // Show what the server accepted, not a local snapshot pasted over an older response.
    // The GET keeps controls hidden on bridges and the demo, where telemetry is absent.
    fetchTelemetry().then((current) => {
      if (!live || request !== statusRequest.current) return;
      if (!current) {
        setStatus(null);
        return;
      }
      // off, blocked or before the notice: the switch and the preview show the server's state, and the
      // snapshot stays in the browser
      if (!current.enabled || current.blocked_by_env || !current.notice_seen) {
        setStatus(current);
        return;
      }
      return changeTelemetry({ settings: snapshot }).then((next) => {
        if (!live || request !== statusRequest.current) return;
        setStatus(next);
      });
    }).catch((failure: unknown) => {
      if (!live || request !== statusRequest.current) return;
      if (failure instanceof ApiError && failure.status === 404) {
        setStatus(null);
        setError(null);
      } else {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    });
    return () => { live = false; };
  }, [settingsSignature]);
  if (!status) return error ? <p className="settings-item settings-hint" role="alert">{error}</p> : null;
  const toggle = (enabled: boolean) => {
    // one change at a time: two answers out of order would leave the switch showing what the server does not hold
    if (saving) return;
    const request = ++statusRequest.current;
    setSaving(true);
    setError(null);
    // turned on, the switch brings the snapshot the browser kept to itself while it was off
    changeTelemetry(enabled ? { enabled, settings: settingsSnapshotRef.current } : { enabled }).then(
      (next) => { if (request === statusRequest.current) setStatus(next); },
      (failure: unknown) => { if (request === statusRequest.current) setError(failure instanceof Error ? failure.message : String(failure)); },
    ).finally(() => setSaving(false));
  };
  return (
    <SettingsGroup title={t("Anonymous usage counts")} className="settings-telemetry" section="telemetry">
      {status.blocked_by_env
        ? <p className="settings-item settings-hint">{t("Turned off on this PC by OVIS_TELEMETRY=0, DO_NOT_TRACK or a CI environment.")}</p>
        : <SettingsRow label={t("Send anonymous usage counts")} description={t("Once on install and once per update, with the last browser's app settings, and once a day you open the app, with the kinds of coding agents running in herdr (such as claude or codex), the kinds of screen the app was opened on, how they reached this PC, and how many prompt answers were sent and alerts delivered and tapped. Custom fonts, shortcuts and replies are reported only as customization flags or counts, never their text. Account identifiers, terminal content and files are excluded. The receiver stores the country, not the IP address.")}>
          <Toggle label={t("Send anonymous usage counts")} checked={status.enabled} onChange={toggle} disabled={saving} />
        </SettingsRow>}
      {error && <p className="settings-item settings-hint" role="alert">{error}</p>}
      <details className="settings-item">
        <summary>{t("What is sent")}</summary>
        {status.next
          ? <pre className="update-output">{JSON.stringify(status.next, null, 2)}</pre>
          : <p className="settings-hint">{t("This version has already been counted. The next event is sent after an update.")}</p>}
        <p className="settings-hint">{t("Once a day you open the app:")}</p>
        <pre className="update-output">{JSON.stringify(status.active, null, 2)}</pre>
        <p className="settings-hint">{t("The receiver adds the country this message comes from (two letters, such as KR). It does not store the address.")}</p>
      </details>
    </SettingsGroup>
  );
}
