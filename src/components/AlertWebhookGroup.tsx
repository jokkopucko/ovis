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
  const [preset, setPreset] = useState<AlertWebhookPreset | "off">("off");
  const [alerts, setAlerts] = useState<AlertPrefs>({ input: true, done: "long" });
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<{ text: string; error: boolean } | null>(null);
  const secret = useRef<HTMLInputElement>(null);
  const chatId = useRef<HTMLInputElement>(null);

  const show = (next: AlertWebhookView) => {
    setView(next);
    setPreset(next.preset ?? "off");
    setAlerts(next.alerts);
  };
  useEffect(() => { fetchAlertWebhook().then(show, () => setView(null)); }, []);

  const failed = (error: unknown) => setLine({ text: error instanceof ApiError ? error.detail : String(error), error: true });
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); } catch (error) { failed(error); } finally { setBusy(false); }
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
  // a saved destination takes a new choice at once; a new one keeps it until Save
  const choose = (patch: Partial<AlertPrefs>) => {
    // one save at a time: a quicker second one could land first and the older choice win
    if (busy) return;
    const next = { ...alerts, ...patch };
    setAlerts(next);
    if (saved) void save(next);
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

  if (view === null) return null;
  const lastError = saved && view.last_error !== null && line === null ? t("Last post failed: {error}", { error: view.last_error }) : null;
  return (
    <SettingsGroup title={t("Also send to")} section="alert-webhook" keepNote note={t("This PC also posts its alerts to a chat app or any URL. A message names the PC, the pane and what happened, with a link to the pane. The pane goes by its terminal title, which an agent may take from your task.")}>
      {/* the group's caption is its row's name: a bare page shows no captions */}
      <SettingsRow label={t("Also send to")} icon={Send} htmlFor="settings-alert-webhook" wide>
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
          {saved && <p className="settings-hint">{t("Saved on this PC. Leave the field empty to keep it.")}</p>}
          {saved && !view.reachable_link && <p className="settings-hint">{t("Messages have no link a phone can open yet. Save once from this PC's network address, not localhost or the relay.")}</p>}
          <p className={line?.error || lastError ? "settings-hint alert-webhook-error" : "settings-hint"} role="status">{line?.text ?? lastError}</p>
        </div>
        <SettingsRow label={t("Needs input")}>
          <Toggle disabled={busy} label={t("Needs input")} checked={alerts.input} onChange={(input) => choose({ input })} />
        </SettingsRow>
        <SettingsRow label={t("Needs permission")}>
          <Toggle disabled={busy} label={t("Needs permission")} checked={alerts.permission ?? alerts.input} onChange={(permission) => choose({ permission })} />
        </SettingsRow>
        <SettingsRow label={t("Finished")} wide>
          <Segmented disabled={busy} label={t("Finished")} value={alerts.done} onChange={(done: DoneAlerts) => choose({ done })} options={[{ value: "off", label: t("Off") }, { value: "long", label: t("Long turns") }, { value: "always", label: t("Every turn") }]} />
        </SettingsRow>
        <SettingsRow label={t("Stopped on an error")}>
          <Toggle disabled={busy} label={t("Stopped on an error")} checked={alerts.error === true} onChange={(error) => choose({ error })} />
        </SettingsRow>
      </>}
      {preset === "off" && line !== null && <p className={line.error ? "settings-item settings-hint alert-webhook-error" : "settings-item settings-hint"} role="status">{line.text}</p>}
    </SettingsGroup>
  );
}
