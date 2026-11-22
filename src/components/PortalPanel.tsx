import { useState } from "react";

import "./PortalPanel.css";
import "./UpdateControls.css";

import { PORTAL_AUTH_PROBLEMS } from "../../shared/portal.ts";
import { useT } from "../lib/i18n.ts";
import { usePortal } from "../lib/portal.ts";
import { authOf, authProblem, draftOf, type AuthDraft } from "../lib/portalAuth.ts";
import { PortalAuthChoice, PortalAuthSummary } from "./PortalAuth.tsx";
import { PortalInvite } from "./PortalInvite.tsx";
import { Address } from "./PhonePanel.tsx";
import { SettingsGroup, SettingsRow } from "./SettingsControls.tsx";


/**
 * Settings → Phone & devices → Portal: a public HTTPS address for this PC through a relay the
 * user picks, run by the `portal` installed there, and who may open it. Any device that can type
 * starts and stops it; the server refuses without a token. Hidden where the server offers none.
 * `readOnly`: this browser reads it and changes nothing: a device that only watches, or a visitor
 * Portal's own sign-in let in, which the server refuses every action here.
 */
export function PortalPanel({ readOnly = false }: { readOnly?: boolean }) {
  const t = useT();
  const { status, error, pending, busy, request } = usePortal();
  const [typed, setTyped] = useState<string | null>(null);
  const [edited, setEdited] = useState<AuthDraft | null>(null);
  if (!status?.supported) return null;
  const relay = typed ?? status.relay ?? "";
  const draft = edited ?? draftOf(status.auth);
  const problem = draft.method === "none" ? null : authProblem(draft);
  const offered = draft.method === "none" || status.auth_methods.includes(draft.method);
  const on = status.phase !== "idle";
  const progress = status.phase === "starting" ? t("Starting…") : status.phase === "recovering" ? t("Recovering…") : status.phase === "stopping" ? t("Stopping…") : null;
  let control;
  if (on) {
    control = (
      <>
        <PortalAuthSummary auth={status.auth} url={status.url} shortUrl={status.short_url ?? null} />
        {status.phase === "running" && status.auth.method === "credential" && !readOnly && <PortalInvite auth={status.auth} />}
        <SettingsRow label={t("Relay")} description={status.relay ?? undefined}>
          <button type="button" className="btn" disabled={readOnly || pending || status.phase === "stopping"} onClick={() => void request("stop")}>{t("Stop")}</button>
        </SettingsRow>
      </>
    );
  } else {
    control = (
      <>
        <PortalAuthChoice status={status} draft={draft} disabled={readOnly || busy} onChange={setEdited} />
        <SettingsRow label={t("Relay")} htmlFor="portal-relay" description={t("A relay you trust, from portal list: it holds the address's certificate, so one set up to intercept could read the traffic.")} wide>
          <form className="portal-start" onSubmit={(event) => { event.preventDefault(); void request("start", relay, authOf(draft)); }}>
            <input id="portal-relay" className="input" inputMode="url" value={relay} placeholder="https://relay.example.com" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={readOnly || busy} onChange={(event) => setTyped(event.currentTarget.value)} />
            <button type="submit" className="btn btn-primary" disabled={readOnly || busy || relay.trim() === "" || problem !== null || !offered}>{t("Start")}</button>
          </form>
        </SettingsRow>
        {problem !== null && <p className="settings-item settings-hint">{t(PORTAL_AUTH_PROBLEMS[problem])}</p>}
      </>
    );
  }
  return (
    <SettingsGroup title="Portal" note={t("A public HTTPS address for this PC through a Portal relay. Anyone on the internet can open it, so it needs an access token.")}>
      {status.url !== null && (
        <div className="settings-item phone-panel">
          <Address url={status.url} title={t("Portal serves this PC")} />
          <p className="settings-description">{status.auth.method === "none" ? t("Open it on your phone and sign in with the access token, or pair the phone with a pairing code.") : t("Open it on your phone and sign in the way you chose here. The access token is not asked after it.")}</p>
        </div>
      )}
      {control}
      {progress !== null && <p className="settings-item settings-hint portal-progress" role="status">{progress}</p>}
      {error !== null && <p className="settings-item settings-hint portal-error" role="alert">{error}</p>}
      {status.phase === "error" && status.error !== null && (
        <div className="settings-item">
          <p className="settings-hint portal-error" role="alert">{status.error}</p>
          {status.output !== null && (
            <details>
              <summary>{t("Portal's output")}</summary>
              <pre className="update-output" data-failed>{status.output}</pre>
            </details>
          )}
        </div>
      )}
    </SettingsGroup>
  );
}
