import { useEffect, useRef, useState, type FormEvent } from "react";
import { Send } from "lucide-react";
import { ALERT_WEBHOOK_PRESETS, type AlertWebhookPreset, type AlertWebhookSave, type AlertWebhookView } from "../../shared/alert-webhook.ts";
import type { AlertPrefs, DoneAlerts } from "../../shared/notify-policy.ts";
import { ApiError, fetchAlertWebhook, removeAlertWebhook, saveAlertWebhook, testAlertWebhook } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { Segmented, SettingsGroup, SettingsRow, SettingsSelect, Toggle } from "./SettingsControls.tsx";

const PRESET_NAMES: Readonly<Record<AlertWebhookPreset, string>> = { ntfy: "ntfy", slack: "Slack", discord: "Discord", telegram: "Telegram", json: "JSON" };
const URL_PLACEHOLDER: Readonly<Record<Exclude<AlertWebhookPreset, "telegram">, string>> = {
  ntfy: "https://ntfy.sh/your-topic",
  slack: "https://hooks.slack.com/services/…",
  discord: "https://discord.com/api/webhooks/…",
  json: "https://…",
};

/**
 * Settings → Alerts → Also send to (server/alert-webhook.ts): one destination this PC also posts its
 * alerts to, with its own choice of alerts. The URL or token is typed into an uncontrolled field and
 * sent once; the server only ever answers it masked.
 */
export function AlertWebhookGroup() {
  const t = useT();
  const [view, setView] = useState<AlertWebhookView | null>(null);
  const [unreadable, setUnreadable] = useState<string | null>(null);
  const [preset, setPreset] = useState<AlertWebhookPreset | "off">("off");
  const [alerts, setAlerts] = useState<AlertPrefs>({ input: true, done: "long" });
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<{ text: string; error: boolean } | null>(null);
  const secret = useRef<HTMLInputElement>(null);
  const chatId = useRef<HTMLInputElement>(null);

  const show = (next: AlertWebhookView) => {
    setView(next);
    setUnreadable(null);
    setPreset(next.preset ?? "off");
    setAlerts(next.alerts);
  };
  useEffect(() => {
    fetchAlertWebhook().then(show, (error: unknown) => {
      setView(null);
      setUnreadable(error instanceof ApiError && error.status === 404 ? null : error instanceof ApiError ? error.detail : String(error));
    });
  }, []);

  const failed = (error: unknown) => setLine({ text: error instanceof ApiError ? error.detail : String(error), error: true });
  const run = async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    try { await action(); return true; } catch (error) { failed(error); return false; } finally { setBusy(false); }
  };

  const saved = view?.configured === true && view.preset === preset;
  const save = (prefs: AlertPrefs) => run(async () => {
    if (preset === "off") return;
    const typed = secret.current?.value.trim() ?? "";
    const request: AlertWebhookSave = { preset, alerts: prefs, ...(typed ? preset === "telegram" ? { token: typed } : { url: typed } : {}),
      ...(preset === "telegram" ? { chat_id: chatId.current?.value.trim() ?? "" } : {}) };
    show(await saveAlertWebhook(request));
    if (secret.current) secret.current.value = "";
    setLine({ text: t("Saved"), error: false });
  });
  const choose = (patch: Partial<AlertPrefs>) => {
    // one save at a time: a quicker second one could land first and the older choice win
    if (busy) return;
    const next = { ...alerts, ...patch };
    setAlerts(next);
    if (!saved) return;
    const held = view.alerts;
    void save(next).then((landed) => { if (!landed) setAlerts(held); });
  };
  const pick = (value: AlertWebhookPreset | "off") => {
    setLine(null);
    if (value === "off" && view?.configured) {
      void run(async () => { await removeAlertWebhook(); show(await fetchAlertWebhook()); setLine({ text: t("Removed"), error: false }); });
      return;
    }
    setPreset(value);
  };
  const test = () => run(async () => {
    setLine(null);
    try { await testAlertWebhook(); setLine({ text: t("Test sent. Check the destination."), error: false }); }
    finally { show(await fetchAlertWebhook()); }
  });
  const submit = (event: FormEvent) => { event.preventDefault(); void save(alerts); };

  const note = t("Sends alerts to another app too, with the PC and pane names and a link to open the pane.");
  if (view === null) {
    if (unreadable === null) return null;
    return (
      <SettingsGroup title={t("Also send to")} section="alert-webhook" keepNote note={note}>
        <SettingsRow label={t("Also send to")} description={t("Posts each alert to one more place: ntfy, Slack, Discord, Telegram, or any address that takes JSON. The address is saved on this PC, never shown in full again, and used whichever device set it.")} icon={Send} wide condition={<span className="settings-condition" role="status">{t("Could not read this PC's alert destination ({error}). Close Settings and open it again.", { error: unreadable })}</span>}>
          {null}
        </SettingsRow>
      </SettingsGroup>
    );
  }
  const lastError = saved && view.last_error !== null && line === null ? t("Last post failed: {error}", { error: view.last_error }) : null;
  const fieldNames = preset === "off" ? undefined : <span className="settings-condition">{preset === "telegram" ? `${t("Bot token")} · ${t("Chat id")}` : t("Webhook URL")}</span>;
  return (
    <SettingsGroup title={t("Also send to")} section="alert-webhook" keepNote note={note}>
      <SettingsRow label={t("Also send to")} description={t("Posts each alert to one more place: ntfy, Slack, Discord, Telegram, or any address that takes JSON. The address is saved on this PC, never shown in full again, and used whichever device set it.")} icon={Send} htmlFor="settings-alert-webhook" wide condition={fieldNames} keywords={[t("Webhook URL"), t("Bot token"), t("Chat id"), "webhook", "ntfy", "slack", "discord", "telegram", "json"].join(" ")}>
        <SettingsSelect id="settings-alert-webhook" value={preset} disabled={busy} onChange={(event) => pick(event.target.value as AlertWebhookPreset | "off")}>
          <option value="off">{t("Off")}</option>
          {ALERT_WEBHOOK_PRESETS.map((value) => <option key={value} value={value}>{value === "json" ? t("JSON to any URL") : PRESET_NAMES[value]}</option>)}
        </SettingsSelect>
      </SettingsRow>
      {preset !== "off" && <>
        <div className="settings-item">
          <form className="alert-webhook-form" onSubmit={submit}>
            <input
              key={preset}
              ref={secret}
              className="input alert-webhook-input"
              type="password"
              placeholder={saved ? view.target ?? "" : preset === "telegram" ? "123456:ABC…" : URL_PLACEHOLDER[preset]}
              aria-label={preset === "telegram" ? t("Bot token") : t("Webhook URL")}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            {preset === "telegram" && <input
              key={`${preset}-chat`}
              ref={chatId}
              className="input alert-webhook-chat"
              defaultValue={saved ? view.chat_id ?? "" : ""}
              placeholder={t("Chat id")}
              aria-label={t("Chat id")}
              autoComplete="off"
              spellCheck={false}
            />}
            <button type="submit" className="btn" disabled={busy}>{t("Save")}</button>
            <button type="button" className="btn" disabled={busy || !saved} onClick={() => void test()}>{t("Send a test")}</button>
          </form>
          {saved && !line?.error && <p className="settings-hint">{t("Saved on this PC. Leave the field empty to keep it.")}</p>}
          {saved && !view.reachable_link && <p className="settings-hint">{t("Messages have no link a phone can open yet. Save once from this PC's network address, not localhost or the relay.")}</p>}
          <p className={line?.error || lastError ? "settings-hint alert-webhook-error" : "settings-hint"} role={line?.error ? "alert" : "status"}>{line?.text ?? lastError}</p>
        </div>
        <SettingsRow label={t("Needs input")} description={t("Also sends there when an agent asks you something. Chosen apart from this device's own alerts.")}>
          <Toggle disabled={busy} label={t("Needs input")} checked={alerts.input} onChange={(input) => choose({ input })} />
        </SettingsRow>
        <SettingsRow label={t("Needs permission")} description={t("Also sends there when an agent asks before it runs a command or changes a file.")}>
          <Toggle disabled={busy} label={t("Needs permission")} checked={alerts.permission ?? alerts.input} onChange={(permission) => choose({ permission })} />
        </SettingsRow>
        <SettingsRow label={t("Finished")} description={t("Whether a finished turn is sent there: never, only work that took a minute or more, or every turn.")} wide condition={<span className="settings-condition">{t("Long turns: only work that took a minute or more")}</span>}>
          <Segmented disabled={busy} label={t("Finished")} value={alerts.done} onChange={(done: DoneAlerts) => choose({ done })} options={[{ value: "off", label: t("Off") }, { value: "long", label: t("Long turns") }, { value: "always", label: t("Every turn") }]} />
        </SettingsRow>
        <SettingsRow label={t("Stopped on an error")} description={t("Also sends there when a turn ends on an error, for the agents that report one (OmO and GJC).")}>
          <Toggle disabled={busy} label={t("Stopped on an error")} checked={alerts.error === true} onChange={(error) => choose({ error })} />
        </SettingsRow>
      </>}
      {preset === "off" && line !== null && <p className={line.error ? "settings-item settings-hint alert-webhook-error" : "settings-item settings-hint"} role="status">{line.text}</p>}
    </SettingsGroup>
  );
}
