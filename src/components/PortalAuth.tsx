import { useId, useRef, useState } from "react";
import { X } from "lucide-react";

import "./PhonePanel.css";
import "./PortalPanel.css";

import { PORTAL_AUTH_PROBLEMS, PORTAL_OIDC_SECRET_VARIABLE } from "../../shared/portal.ts";
import type { PortalAuth, PortalSignIn, PortalStatus } from "../../shared/protocol.ts";
import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import { GOOGLE_ISSUER, methodName, redirectAddress, withEntry, type AuthDraft } from "../lib/portalAuth.ts";
import { Segmented } from "./SettingsControls.tsx";

/**
 * Who may open the address, chosen before Start: the app's own token or a paired device as always,
 * or Portal's own sign-in in front of everything. A choice is offered only when the `portal` on this
 * PC lists its flags, and says plainly when it does not.
 */
export function PortalAuthChoice({ status, draft, disabled, onChange }: { status: PortalStatus; draft: AuthDraft; disabled: boolean; onChange: (draft: AuthDraft) => void }) {
  const t = useT();
  const group = useId();
  const choices = [
    { value: "none", label: t("Token or paired device only"), description: t("Visitors need this app's access token or a paired device.") },
    { value: "credential", label: methodName("credential"), description: t("Only people you send a link to. A link names who it is for and expires.") },
    { value: "siwe", label: methodName("siwe"), description: t("Only the wallets you list, each proving itself with a signature.") },
    { value: "oidc", label: methodName("oidc"), description: t("Only the accounts you list, signed in at your identity provider.") },
  ] as const;
  const { method } = draft;
  return (
    <fieldset className="settings-item portal-auth" disabled={disabled} aria-labelledby={`${group}-label`}>
      <p id={`${group}-label`} className="settings-label">{t("Who can open the address")}</p>
      <div className="portal-options">
        {choices.map((choice) => {
          const unavailable = choice.value !== "none" && !status.auth_methods.includes(choice.value);
          return (
            <label key={choice.value} className="portal-option">
              <input type="radio" name={group} checked={method === choice.value} disabled={unavailable} onChange={() => onChange({ ...draft, method: choice.value })} />
              <span className="settings-row-text">
                <span className="settings-label">{choice.label}</span>
                <span className="settings-description">{choice.description}</span>
                {unavailable && <span className="settings-condition">{t("This Portal does not support it yet.")}</span>}
              </span>
            </label>
          );
        })}
      </div>
      {method !== "none" && <p className="settings-hint">{t("Visitors can watch your terminals, but cannot type or change anything. Your app token or paired device keeps its existing access.")}</p>}
      {method === "credential" && (
        <AllowList method="credential" entries={draft.allow.credential} label={t("Allowed link names")} placeholder="alice"
          hint={draft.allow.credential.length === 0 ? t("With no names, every unexpired link you issue opens it. Add names to accept only links issued to them.") : undefined}
          onChange={(list) => onChange({ ...draft, allow: { ...draft.allow, credential: list } })} />
      )}
      {method === "siwe" && (
        <AllowList method="siwe" entries={draft.allow.siwe} label={t("Allowed wallets")} placeholder="0x…"
          onChange={(list) => onChange({ ...draft, allow: { ...draft.allow, siwe: list } })} />
      )}
      {method === "oidc" && <OidcFields status={status} draft={draft} onChange={onChange} />}
    </fieldset>
  );
}

/**
 * What runs now, read-only: changing who may open an address means stopping it first. `url` is the
 * address Portal serves, which a Google or company login needs to be told to send people back to;
 * `shortUrl` is the short host Portal serves the same address on for its `--name`, whose callback a
 * provider that matches exactly (Google) needs registered as well.
 */
export function PortalAuthSummary({ auth, url, shortUrl = null }: { auth: PortalAuth; url: string | null; shortUrl?: string | null }) {
  const t = useT();
  return (
    <div className="settings-item portal-auth">
      <p className="settings-label">{t("Who can open the address")}</p>
      <p className="settings-description">{auth.method === "none" ? t("Token or paired device only") : methodName(auth.method)}</p>
      {auth.issuer !== null && <p className="settings-hint portal-chip-text">{auth.issuer}</p>}
      {auth.method === "credential" && auth.allow.length === 0 && <p className="settings-hint">{t("Every unexpired link you issue opens it.")}</p>}
      {auth.allow.length > 0 && <ul className="portal-chips" aria-label={t("Allowed")}>{auth.allow.map((entry) => <li key={entry} className="portal-chip"><span className="portal-chip-text">{entry}</span></li>)}</ul>}
      {auth.method === "oidc" && url !== null && [url, ...(shortUrl !== null && shortUrl !== url ? [shortUrl] : [])].map((host) => <RedirectAddress key={host} url={host} />)}
      <p className="settings-hint">{t("Stop Portal to change who can open it.")}</p>
    </div>
  );
}

/** Where the provider sends a person back after they sign in, to register with it before anyone can. */
function RedirectAddress({ url }: { url: string }) {
  const t = useT();
  const addressRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const redirect = redirectAddress(url);
  return (
    <div className="portal-field">
      <span className="settings-label">{t("Redirect address to register with the provider")}</span>
      <span className="phone-command">
        <code ref={addressRef}>{redirect}</code>
        <button type="button" className="btn" onClick={() => void copyText(redirect, addressRef.current).then((ok) => { if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1600); } })}>{t(copied ? "Copied" : "Copy")}</button>
      </span>
    </div>
  );
}

function OidcFields({ status, draft, onChange }: { status: PortalStatus; draft: AuthDraft; onChange: (draft: AuthDraft) => void }) {
  const t = useT();
  const id = useId();
  const [custom, setCustom] = useState(draft.issuer !== GOOGLE_ISSUER);
  return (
    <div className="portal-oidc">
      <Segmented label={t("Identity provider")} value={custom ? "custom" : "google"} options={[{ value: "google", label: "Google" }, { value: "custom", label: t("Other") }]}
        onChange={(value) => { setCustom(value === "custom"); if (value === "google") onChange({ ...draft, issuer: GOOGLE_ISSUER }); }} />
      {custom && (
        <div className="portal-field">
          <label className="settings-label" htmlFor={`${id}-issuer`}>{t("Issuer address")}</label>
          <input id={`${id}-issuer`} className="input" type="url" inputMode="url" value={draft.issuer} placeholder="https://login.example.com"
            autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(event) => onChange({ ...draft, issuer: event.currentTarget.value })} />
        </div>
      )}
      <div className="portal-field">
        <label className="settings-label" htmlFor={`${id}-client`}>{t("Client ID")}</label>
        <input id={`${id}-client`} className="input" value={draft.clientId} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          onChange={(event) => onChange({ ...draft, clientId: event.currentTarget.value })} />
      </div>
      <AllowList method="oidc" entries={draft.allow.oidc} label={t("Allowed accounts")} placeholder="you@example.com" hint={t("A verified email, @example.com for a whole domain, or sub:<id> for one account.")}
        onChange={(list) => onChange({ ...draft, allow: { ...draft.allow, oidc: list } })} />
      <div className="portal-field">
        <span className="settings-label">{t("Redirect address to register with the provider")}</span>
        <span className="settings-hint">{t("It shows here once Portal has started.")}</span>
      </div>
      <p className="settings-hint">{t("The client secret is not typed here: the app reads it from the environment variable {name} on this PC.", { name: PORTAL_OIDC_SECRET_VARIABLE })}</p>
      {status.oidc_secret
        ? <p className="settings-hint">{t("The secret is set on this PC.")}</p>
        : <p className="settings-hint portal-warning" role="status">{t("The secret is not set on this PC. Google and most providers refuse sign-in without it. Set it and restart the app.")}</p>}
    </div>
  );
}

/** A list of entries as chips, each added through the check Portal itself applies to its kind. */
function AllowList({ method, entries, label, placeholder, hint, onChange }: { method: PortalSignIn; entries: readonly string[]; label: string; placeholder: string; hint?: string | undefined; onChange: (list: readonly string[]) => void }) {
  const t = useT();
  const id = useId();
  const [text, setText] = useState("");
  const typed = text.trim() === "" ? null : withEntry(entries, method, text);
  const problem = typed !== null && "problem" in typed ? typed.problem : null;
  const add = () => {
    if (typed !== null && "list" in typed) {
      onChange(typed.list);
      setText("");
    }
  };
  return (
    <div className="portal-field">
      <label className="settings-label" htmlFor={id}>{label}</label>
      {entries.length > 0 && (
        <ul className="portal-chips" aria-label={label}>
          {entries.map((entry) => (
            <li key={entry} className="portal-chip">
              <span className="portal-chip-text">{entry}</span>
              <button type="button" className="portal-chip-remove" aria-label={t("Remove {entry}", { entry })} onClick={() => onChange(entries.filter((other) => other !== entry))}><X aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      )}
      <form className="portal-entry" onSubmit={(event) => { event.preventDefault(); add(); }}>
        <input id={id} className="input" value={text} placeholder={placeholder} aria-invalid={problem !== null || undefined} aria-describedby={problem !== null ? `${id}-problem` : undefined}
          autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(event) => setText(event.currentTarget.value)} />
        <button type="submit" className="btn" disabled={typed === null || problem !== null}>{t("Add")}</button>
      </form>
      {problem !== null && <p id={`${id}-problem`} className="settings-hint portal-warning" role="alert">{t(PORTAL_AUTH_PROBLEMS[problem])}</p>}
      {hint !== undefined && <p className="settings-hint">{hint}</p>}
    </div>
  );
}
