/**
 * Settings → Alerts → Also send to (shared/alert-webhook.ts): the pane alerts web push sends
 * (server/push.ts, which decides what and when) also go to one destination outside the app, in its
 * preset's format: an ntfy topic, a Slack or Discord webhook, a Telegram bot, or plain JSON.
 *
 * alert-webhook.json in the state dir holds the destination, owner-only like the push keys: its URL
 * or token is what posts into someone's chat. It is never answered back, only masked.
 *
 * A message names the PC, the pane and what happened, with a link to open the pane; never what the
 * agent asked or answered, which would leave the PC for a third party.
 *
 * One post at a time, and at most one waiting: an alert that comes while another is being sent or
 * retried replaces the one waiting, so a destination that is down is never flooded. A post that fails
 * on the network, a 429 or a 5xx is tried again after `retryDelays`; any other answer (a wrong URL,
 * a revoked token) is not, and is kept as the last error.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ALERT_WEBHOOK_PRESETS, type AlertWebhookPreset, type AlertWebhookSave, type AlertWebhookView } from "../shared/alert-webhook.ts";
import { type AlertKind, type AlertPrefs, alertKindAllowed, DEFAULT_ALERTS, parseAlerts } from "../shared/notify-policy.ts";
import { isLoopbackHost } from "./access.ts";
import { badRequest, jsonResponse, setRequestRoute } from "./http.ts";
import { writePrivateState } from "./private-state.ts";
import { RELAY_ORIGIN } from "./relay/session.ts";

const FILE = "alert-webhook.json";
const TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAYS = [5_000, 30_000, 120_000];
const URL_MAX = 2048;
const TELEGRAM_TOKEN = /^\d{3,20}:[A-Za-z0-9_-]{20,100}$/;
const TELEGRAM_CHAT = /^(?:-?\d{1,20}|@[A-Za-z0-9_]{4,64})$/;

interface StoredWebhook {
  preset: AlertWebhookPreset;
  /** the URL, or for Telegram the bot token */
  secret: string;
  chat_id?: string;
  alerts: AlertPrefs;
  link_base?: string;
  /** who saved it, as a push subscription's `device_id`: a device, null for a local/token sign-in, absent for the open LAN */
  owner?: string | null;
}

export interface WebhookAlert {
  kind: AlertKind;
  title: string;
  body: string;
  pc?: string;
  pane_id: string;
  machine_id?: string;
  workspace_id?: string;
  current?: () => boolean;
  /** the destination's `generation()` when the alert arose: a destination set since is not told it */
  generation?: number;
}

export type WebhookResult = { ok: true } | { ok: false; error: string; retry: boolean };

export interface AlertWebhook {
  prefs(): AlertPrefs | null;
  wants(kind: AlertKind): boolean;
  generation(): number;
  send(alert: WebhookAlert): void;
  test(): Promise<WebhookResult | null>;
  view(): AlertWebhookView;
  save(input: AlertWebhookSave, linkBase: string | undefined, owner?: string | null): AlertWebhookView;
  remove(): void;
  settled(): Promise<void>;
}

export interface AlertWebhookOptions {
  stateDir: string;
  now?: () => number;
  retryDelays?: readonly number[];
  telegramApi?: string;
  /** accept a plain-http loopback URL for every preset: only for the tests' fake destination */
  loopbackHttp?: boolean;
  /** whether whoever saved it may still hear alerts (push.ts canDeliver): asked before each try */
  canDeliver?: (owner: string | null | undefined) => boolean;
}

export class WebhookInputError extends Error {}

function parseStored(value: unknown): StoredWebhook | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const preset = record["preset"];
  const secret = record["secret"];
  if (typeof preset !== "string" || !(ALERT_WEBHOOK_PRESETS as readonly string[]).includes(preset) || typeof secret !== "string" || secret.length === 0) return null;
  return {
    preset: preset as AlertWebhookPreset,
    secret,
    ...(typeof record["chat_id"] === "string" ? { chat_id: record["chat_id"] } : {}),
    alerts: parseAlerts(record["alerts"]),
    ...(typeof record["link_base"] === "string" ? { link_base: record["link_base"] } : {}),
    ...(typeof record["owner"] === "string" || record["owner"] === null ? { owner: record["owner"] as string | null } : {}),
  };
}

/** A destination URL: http(s), no credentials in it; Slack and Discord only ever give https. */
function checkUrl(preset: AlertWebhookPreset, value: unknown, loopbackHttp = false): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > URL_MAX) throw new WebhookInputError("a URL is required");
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new WebhookInputError("the URL does not parse"); }
  const https = url.protocol === "https:";
  const http = url.protocol === "http:" && (preset === "ntfy" || preset === "json" || loopbackHttp && isLoopbackHost(url.hostname));
  if (!https && !http) throw new WebhookInputError(preset === "slack" || preset === "discord" ? "the URL must start with https://" : "the URL must start with http:// or https://");
  if (url.username || url.password) throw new WebhookInputError("the URL must not carry a user name or password");
  url.hash = "";
  return url.href;
}

/** Which service it is, and nothing of the path or token, which is the secret (an ntfy topic is all of it). */
export function maskSecret(preset: AlertWebhookPreset, secret: string): string {
  if (preset === "telegram") return "…";
  try { return `${new URL(secret).host}/…`; } catch { return "…"; }
}

function reachable(base: string | undefined): boolean {
  if (base === undefined) return false;
  // URL writes an IPv4-mapped loopback in hex ([::ffff:7f00:1]), which isLoopbackHost does not read; an unspecified
  // address (0.0.0.0, [::]) names no PC either
  try { const host = new URL(base).host; return !isLoopbackHost(host) && !/^(?:\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]|0\.0\.0\.0|\[::\])(?::\d+)?$/i.test(host); } catch { return false; }
}

export function paneLink(base: string | undefined, alert: Pick<WebhookAlert, "pane_id" | "machine_id">): string | null {
  if (!base) return null;
  const url = new URL("/", base);
  if (alert.machine_id) url.searchParams.set("machine", alert.machine_id);
  url.searchParams.set("pane", alert.pane_id);
  url.searchParams.set("view", "chat");
  return url.href;
}

export function alertText(alert: Pick<WebhookAlert, "title" | "body" | "pc">): string {
  return `${alert.pc ? `${alert.pc} · ` : ""}${alert.title}: ${alert.body}`;
}

interface Post { url: string; init: RequestInit }

export function buildPost(stored: StoredWebhook, alert: WebhookAlert | null, telegramApi = "https://api.telegram.org"): Post {
  const text = alert ? alertText(alert) : "Ovis: alerts reach this destination";
  const link = alert ? paneLink(stored.link_base, alert) : null;
  const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  switch (stored.preset) {
    case "ntfy":
      return { url: stored.secret, init: { method: "POST", headers: {
        title: "Ovis",
        ...(link ? { click: link } : {}),
        ...(alert?.kind === "input" || alert?.kind === "permission" ? { priority: "high" } : {}),
      }, body: text } };
    case "slack":
      return { url: stored.secret, init: json({ text: link ? `${text}\n<${link}|Open in Ovis>` : text }) };
    case "discord":
      return { url: stored.secret, init: json({ content: link ? `${text}\n${link}` : text, allowed_mentions: { parse: [] } }) };
    case "telegram":
      return { url: `${telegramApi}/bot${stored.secret}/sendMessage`, init: json({ chat_id: stored.chat_id, text: link ? `${text}\n${link}` : text, disable_web_page_preview: true }) };
    case "json":
      return { url: stored.secret, init: json(alert
        ? { type: "alert", kind: alert.kind, text, title: alert.title, body: alert.body, ...(alert.pc ? { pc: alert.pc } : {}), pane_id: alert.pane_id,
          ...(alert.machine_id ? { machine_id: alert.machine_id } : {}), ...(alert.workspace_id ? { workspace_id: alert.workspace_id } : {}), ...(link ? { url: link } : {}) }
        : { type: "test", text }) };
  }
}

export function createAlertWebhook(options: AlertWebhookOptions): AlertWebhook {
  const path = join(options.stateDir, FILE);
  const now = options.now ?? Date.now;
  const retryDelays = options.retryDelays ?? DEFAULT_RETRY_DELAYS;
  let stored: StoredWebhook | null | undefined;
  let lastSuccess: number | null = null;
  let lastFailure: number | null = null;
  let lastError: string | null = null;
  let next: WebhookAlert | null = null;
  let running: Promise<void> | null = null;
  let testing: { at: number; result: Promise<WebhookResult | null> } | null = null;
  let wake: (() => void) | null = null;
  /** bumped by a save or removal: a post for the destination before it is not retried or recorded */
  let generation = 0;

  function current(): StoredWebhook | null {
    if (stored !== undefined) return stored;
    try {
      stored = parseStored(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Cannot read ${path}; no alert webhook is used`);
      stored = null;
    }
    return stored;
  }

  async function post(target: StoredWebhook, alert: WebhookAlert | null): Promise<WebhookResult> {
    const { url, init } = buildPost(target, alert, options.telegramApi);
    try {
      // a webhook answers, it never redirects: following one would post the alert somewhere else
      const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
      await response.body?.cancel().catch(() => {});
      if (response.ok) return { ok: true };
      return { ok: false, error: `HTTP ${response.status}`, retry: response.status === 429 || response.status >= 500 };
    } catch {
      return { ok: false, error: "no response", retry: true };
    }
  }

  function record(result: WebhookResult): void {
    if (result.ok) { lastSuccess = now(); lastError = null; return; }
    lastFailure = now();
    lastError = result.error;
  }

  const wait = (ms: number): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });

  async function drain(): Promise<void> {
    while (next !== null) {
      const alert = next;
      next = null;
      const at = generation;
      for (let attempt = 0; ; attempt += 1) {
        const target = current();
        if (target === null || at !== generation || options.canDeliver?.(target.owner) === false || alert.current?.() === false || !alertKindAllowed(target.alerts, alert.kind)) break;
        const result = await post(target, alert);
        if (at !== generation) break;
        record(result);
        if (result.ok || !result.retry || attempt >= retryDelays.length) {
          if (!result.ok) console.error(`alert webhook (${target.preset}) failed: ${result.error}`);
          break;
        }
        // fixed wait: the backoff before the destination is tried again
        await wait(retryDelays[attempt]!);
        if (next !== null) break;
      }
    }
  }

  function view(): AlertWebhookView {
    const target = current();
    const iso = (at: number | null): string | null => at === null ? null : new Date(at).toISOString();
    return {
      configured: target !== null,
      preset: target?.preset ?? null,
      target: target ? maskSecret(target.preset, target.secret) : null,
      chat_id: target?.chat_id ?? null,
      alerts: target?.alerts ?? DEFAULT_ALERTS,
      reachable_link: reachable(target?.link_base),
      last_success_at: iso(lastSuccess),
      last_failure_at: iso(lastFailure),
      last_error: lastError,
    };
  }

  function forgetOutcome(): void {
    generation += 1;
    wake?.();
    next = null;
    lastSuccess = null;
    lastFailure = null;
    lastError = null;
  }

  return {
    prefs: () => current()?.alerts ?? null,
    wants(kind) {
      const prefs = current()?.alerts;
      return prefs !== undefined && alertKindAllowed(prefs, kind);
    },
    generation: () => generation,
    send(alert) {
      if (current() === null || alert.generation !== undefined && alert.generation !== generation) return;
      next = alert;
      running ??= drain().finally(() => { running = null; });
    },
    test() {
      if (testing !== null && testing.at === generation) return testing.result;
      const at = generation;
      const run = (async () => {
        const target = current();
        if (target === null) return null;
        const result = await post(target, null);
        if (at === generation) record(result);
        return result;
      })().finally(() => { if (testing?.at === at) testing = null; });
      testing = { at, result: run };
      return run;
    },
    view,
    save(input, linkBase, owner) {
      if (!(ALERT_WEBHOOK_PRESETS as readonly string[]).includes(input.preset)) throw new WebhookInputError("unknown destination");
      const before = current();
      const same = before?.preset === input.preset ? before : null;
      let secret: string;
      let chatId: string | undefined;
      if (input.preset === "telegram") {
        const token = input.token?.trim();
        if (token !== undefined && token !== "" && !TELEGRAM_TOKEN.test(token)) throw new WebhookInputError("the bot token looks like 123456:ABC…");
        secret = token || same?.secret || "";
        if (!secret) throw new WebhookInputError("a bot token is required");
        chatId = input.chat_id?.trim() || same?.chat_id;
        if (!chatId || !TELEGRAM_CHAT.test(chatId)) throw new WebhookInputError("a chat id is a number or an @channel name");
      } else {
        const typed = input.url !== undefined && input.url.trim() !== "";
        secret = typed || !same ? checkUrl(input.preset, input.url, options.loopbackHttp) : same.secret;
      }
      let base = same?.link_base ?? before?.link_base;
      // a relay request names no address the app opens at (relay/session.ts RELAY_ORIGIN), and this PC's own loopback
      // address opens nothing on a phone: a saved base another device can reach stays
      if (linkBase && linkBase !== RELAY_ORIGIN) {
        try {
          const origin = new URL(linkBase).origin;
          if (reachable(origin) || !reachable(base)) base = origin;
        } catch {}
      }
      const saved: StoredWebhook = {
        preset: input.preset, secret, ...(chatId ? { chat_id: chatId } : {}),
        alerts: input.alerts === undefined ? same?.alerts ?? DEFAULT_ALERTS : parseAlerts(input.alerts),
        ...(base ? { link_base: base } : {}),
        ...(owner === undefined ? {} : { owner }),
      };
      writePrivateState(path, saved);
      const changed = before === null || before.preset !== saved.preset || before.secret !== saved.secret || before.chat_id !== saved.chat_id;
      stored = saved;
      if (changed) forgetOutcome();
      return view();
    },
    remove() {
      rmSync(path, { force: true });
      stored = null;
      forgetOutcome();
    },
    async settled() {
      while (running !== null) await running;
    },
  };
}

/** /api/alerts/webhook routes (shared/alert-webhook.ts). A watching device is refused every change before it gets here (dispatch.ts). */
export async function handleAlertWebhookRequest(request: Request, pathname: string, webhook: AlertWebhook, owner?: string | null): Promise<Response | null> {
  if (pathname !== "/api/alerts/webhook" && pathname !== "/api/alerts/webhook/test") return null;
  setRequestRoute(pathname);
  const route = `${request.method} ${pathname}`;
  const noStore = { "cache-control": "no-store" };
  if (route === "GET /api/alerts/webhook") return jsonResponse(webhook.view(), 200, noStore);
  if (route === "DELETE /api/alerts/webhook") { webhook.remove(); return new Response(null, { status: 204 }); }
  if (route === "POST /api/alerts/webhook/test") {
    const result = await webhook.test();
    if (result === null) return jsonResponse({ error: { code: "webhook_not_configured", message: "no destination is set" } }, 404);
    if (result.ok) return new Response(null, { status: 204 });
    return jsonResponse({ error: { code: "webhook_failed", message: `the destination answered: ${result.error}` } }, 502);
  }
  if (route !== "PUT /api/alerts/webhook") return badRequest("method_not_allowed", `${request.method} is not supported on ${pathname}`);
  let payload: unknown;
  try { payload = await request.json(); } catch { return badRequest("invalid_json", "request body must be JSON"); }
  const body = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  const text = (key: string): string | undefined => typeof body[key] === "string" ? body[key] as string : undefined;
  try {
    const saved = webhook.save({
      preset: text("preset") as AlertWebhookPreset,
      ...(text("url") === undefined ? {} : { url: text("url")! }),
      ...(text("token") === undefined ? {} : { token: text("token")! }),
      ...(text("chat_id") === undefined ? {} : { chat_id: text("chat_id")! }),
      ...(body["alerts"] === undefined ? {} : { alerts: parseAlerts(body["alerts"]) }),
    }, request.headers.get("origin") ?? new URL(request.url).origin, owner);
    return jsonResponse(saved, 200, noStore);
  } catch (error) {
    if (error instanceof WebhookInputError) return badRequest("invalid_webhook", error.message);
    throw error;
  }
}
