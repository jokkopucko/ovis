import { useId, useRef, useState } from "react";

import "./PortalPanel.css";

import { checkEntry, DEFAULT_INVITE_DAYS, PORTAL_AUTH_PROBLEMS, PORTAL_INVITE_DAYS } from "../../shared/portal.ts";
import type { PortalAuth } from "../../shared/protocol.ts";
import { issuePortalInvite } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import { Segmented, SettingsSelect } from "./SettingsControls.tsx";

/**
 * Settings → Phone & devices → Portal → Invite someone: a private link for a person, while Portal
 * runs with the private-link sign-in. The link is a bearer secret the server keeps nowhere: it is
 * shown here once, and gone when this is dismissed or Settings closes.
 */
export function PortalInvite({ auth }: { auth: PortalAuth }) {
  const t = useT();
  const id = useId();
  const linkRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [days, setDays] = useState<number>(DEFAULT_INVITE_DAYS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ name: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // with a list of link names, a link is for one of them: Portal turns any other away
  const listed = auth.allow.length > 0;
  const who = listed ? (auth.allow.includes(name) ? name : auth.allow[0]!) : name.trim();
  const checked = checkEntry("credential", who);
  const issue = async () => {
    if ("problem" in checked) return;
    setBusy(true); setError(null); setCopied(false);
    try {
      setIssued({ name: checked.entry, url: (await issuePortalInvite(checked.entry, days)).redeem_url });
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };
  return (
    <div className="settings-item portal-invite">
      <p className="settings-label">{t("Invite someone")}</p>
      {issued === null ? (
        <form className="portal-invite-form" onSubmit={(event) => { event.preventDefault(); void issue(); }}>
          <div className="portal-field">
            <label className="settings-label" htmlFor={`${id}-name`}>{t("Link name")}</label>
            {listed ? (
              <SettingsSelect id={`${id}-name`} value={who} disabled={busy} onChange={(event) => setName(event.currentTarget.value)}>
                {auth.allow.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
              </SettingsSelect>
            ) : (
              <input id={`${id}-name`} className="input" value={name} placeholder="alice" maxLength={256} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={busy}
                aria-invalid={name.trim() !== "" && "problem" in checked ? true : undefined} onChange={(event) => setName(event.currentTarget.value)} />
            )}
          </div>
          <div className="portal-field">
            <span className="settings-label">{t("Valid for")}</span>
            <Segmented label={t("Valid for")} value={String(days)} options={PORTAL_INVITE_DAYS.map((choice) => ({ value: String(choice), label: t(choice === 1 ? "1 day" : "{n} days", { n: choice }) }))} onChange={(value) => setDays(Number(value))} />
          </div>
          {!listed && name.trim() !== "" && "problem" in checked && <p className="settings-hint portal-warning" role="alert">{t(PORTAL_AUTH_PROBLEMS[checked.problem])}</p>}
          <div className="phone-actions"><button type="submit" className="btn btn-primary" disabled={busy || "problem" in checked}>{t("Create link")}</button></div>
        </form>
      ) : (
        <div className="portal-secret" role="status">
          <p className="portal-warning">{t("This link lets anyone who has it watch this PC's terminals until it expires, without typing or making changes. Send it only to {name}. It is shown once and this app keeps no copy.", { name: issued.name })}</p>
          <div className="phone-command">
            <input ref={linkRef} className="portal-link" readOnly value={issued.url} aria-label={t("Private link for {name}", { name: issued.name })} autoComplete="off" onFocus={(event) => event.currentTarget.select()} />
            <button type="button" className="btn" onClick={() => void copyText(issued.url, linkRef.current).then((ok) => { if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1600); } })}>{t(copied ? "Copied" : "Copy")}</button>
          </div>
          <div className="phone-actions"><button type="button" className="btn" onClick={() => { setIssued(null); setCopied(false); }}>{t("Done")}</button></div>
        </div>
      )}
      {error !== null && <p className="settings-hint portal-error" role="alert">{error}</p>}
    </div>
  );
}
