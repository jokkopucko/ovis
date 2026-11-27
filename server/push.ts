/**
 * Web Push: pane alerts that reach a device even when Ovis is closed there.
 *
 * The browser hands us a subscription (an endpoint on its vendor's push service plus
 * the keys to encrypt for it); we POST encrypted payloads there, signed with our VAPID
 * key. Both halves persist in the state dir (default ~/.config/ovis):
 * - vapid.json: every subscription is bound to this key pair. Regenerating it silently
 *   orphans every subscribed device, so a malformed file is an error, never a rotation.
 * - push-subscriptions.json: survives restarts, so a reboot does not unsubscribe phones.
 *   A 404/410 from a push service means the device dropped it; the record is deleted.
 * - push-retired.json: the endpoint is also remembered, as a hash with the owner it was retired for
 *   (`RETIRED_LIMIT`), so a restart does not forget it and a revocation finds it: a browser can keep handing over a subscription its push
 *   service retired, and registering it again would only fail the next push, so it is refused as
 *   `subscription_gone` and the device subscribes anew (#1038). A mark has no time limit: one that
 *   expired would let any device that knows the endpoint register it as its own (#2012). Only its
 *   owner's revocation removes it, or a thousand later retirements.
 * - push-keys.json (PUSH_EXTRA_KEYS): key pairs other than vapid.json's, each with the endpoints
 *   made for it. Only state-merge.ts writes it, for subscriptions taken over from the other state
 *   dir of an install that had two: each is signed with the key it was made for until its device
 *   subscribes again with this server's key (src/lib/push.ts does when it next opens).
 * - push-delivery.json: how the last push to each subscription went (`last_success_at`,
 *   `last_failure_at`, `last_failure`), by endpoint hash, with the owner and a hash of the keys it
 *   was recorded for. A device reads its own record through POST /api/push/status once it proves
 *   both, so a subscription its push service retired can still say why alerts stopped (#1039).
 *   Bounded like the retired list, and expired (`DELIVERY_TTL_MS`) on every read and write; an explicit unsubscribe or
 *   the device's revocation removes it together with the endpoint's retired mark.
 *
 * Requests are built by web-push's generateRequestDetails (RFC 8291 aes128gcm + RFC
 * 8292 VAPID) and sent with fetch; its sendNotification path goes through node:https
 * and https-proxy-agent, which Bun does not need.
 *
 * An alert waits before it goes out, and a change of the pane's status meanwhile calls it
 * off: a question answered at the desk, or a finish followed by the next prompt, never
 * reaches the phone. So does the pane going away: closed (`closed`), or no longer in a
 * snapshot (`gone`), as when its tab or workspace closed (#4217). A pane moved to another
 * workspace is not gone: its new ID takes its status and its waiting alert (`moved`). herdr says nothing of whether anyone is at the PC, so a change that
 * quick is taken for someone being there (as Claude Code waits ~6 s on a permission
 * prompt and ~60 s after a reply before it notifies). A question waits `short`; a finish
 * waits `long`, and only one after a turn that worked `longTurn` or more is worth it,
 * unless the device asked for every finish (which then waits `short`).
 *
 * No device gets an alert while a window of the app is in use somewhere (`inUse`: a
 * connected page that is visible and has focus, which says so over its WebSocket): the
 * person is at a screen that already shows the change (#751). It is asked when an alert
 * would go out, so a window brought forward while the alert waits still holds it back.
 *
 * A pane on the shared mute list (`muted`, shared/preferences.ts `muted_panes`) gets no alert
 * on any device: none is scheduled for it, one already waiting is called off when the list
 * changes (`mutesChanged`), and the list is asked again right before a waiting one goes out.
 * Its status is tracked all the same, so an unmute tells only what changes after it.
 *
 * Each device also says which kinds of alert it wants (shared/notify-policy.ts AlertPrefs: a
 * question, a permission, a finish, an error) and which PCs it hears nothing of (`pcs_off`, by the
 * PC's name, which every server that device subscribes to knows its own PC by). The choice is made
 * here, not on the device: a web push the device received has to be shown (iOS takes the
 * subscription away from a page that shows none), and the phone app's relay forwards what it gets.
 * Every alert names its `kind`.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import webpush from "web-push";

import { paneStorageId } from "../shared/machines.ts";
import type { AgentStatus, DevicePairedEvent, HerdrPane, InteractivePrompt, PushAction, PushDeliveryFailure, PushPayload, PushSubscriptionStatus } from "../shared/protocol.ts";
import {
  type AlertKind,
  type AlertPrefs,
  alertKindAllowed,
  alertPcAllowed,
  blockedAlertKind,
  DEFAULT_ALERTS,
  ENDED_NOTIFICATION_BODY,
  ERROR_NOTIFICATION_BODY,
  PERMISSION_NOTIFICATION_BODY,
  paneNotificationTag,
  pushPaneTitle,
  parseAlerts,
  shouldNotifyStatus,
  statusNotificationBody,
} from "../shared/notify-policy.ts";
import { cleanLine, isDivider, parsedByPublicPrompt } from "./dialogs/shared.ts";
import { badRequest, jsonResponse, setRequestRoute } from "./http.ts";
import { isLoopbackHost } from "./access.ts";
import type { AlertWebhook } from "./alert-webhook.ts";
import { privateStateRefusal, writePrivateState } from "./private-state.ts";

/** A blocked agent is still blocked when the phone gets signal back; a newer push for the pane replaces it anyway. */
const PUSH_TTL_SECONDS = 12 * 60 * 60;
const PUSH_TIMEOUT_MS = 10_000;
const PROMPT_LOOKUP_MS = 3_000;
/** The longest option label an alert's button carries: a longer one is cut by the platform, so its alert opens the pane. */
const ACTION_LABEL_MAX = 24;
/** The most of a prompt an alert with buttons shows whole: the lines of its body, and its length in all. A longer one gets no buttons. */
const PROMPT_SUMMARY_LINES = 4;
const PROMPT_SUMMARY_MAX = 300;
const DEFAULT_SUBJECT = "https://github.com/devswha/ovis";
/**
 * The largest encrypted body the phone app's push relay passes on (push-relay/worker.ts `push`): it
 * base64s the body into `{"aps":{"alert":{"body":FALLBACK_BODY},"mutable-content":1},"ovis":"…"}`,
 * 74 bytes besides the base64, and answers 413 when that is over MAX_APNS_BYTES, 4,096 (FCM's
 * limit too). floor((4096 - 74) / 4) * 3 = 3,015.
 */
export const RELAY_MAX_BODY_BYTES = 3015;
const RELAY_ENDPOINT_PATH = /^\/v1\/push\/[^/]+$/;
const RETIRED_LIMIT = 1000;
/** The key pairs, besides vapid.json's, that subscriptions taken over from another state dir were made for. */
export const PUSH_EXTRA_KEYS = "push-keys.json";

type VapidKeys = { publicKey: string; privateKey: string };
const DELIVERY_LIMIT = RETIRED_LIMIT;
const DELIVERY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AlertTiming {
  short: number;
  long: number;
  longTurn: number;
}
export const DEFAULT_ALERT_TIMING: AlertTiming = { short: 10_000, long: 60_000, longTurn: 60_000 };

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  alerts?: AlertPrefs;
  /** null: local/token sign-in; absent: legacy subscription awaiting ownership. */
  device_id?: string | null;
  /**
   * The stream keys of the browser that registered it (server/devices.ts `streamKeys`), so a
   * pairing that browser makes is not pushed back to it, whatever access it subscribed through.
   * Absent: registered without one (it then hears every pairing, like any other subscriber).
   */
  browser_keys?: string[];
}

export type PushDelivery = { ok: true } | { ok: false; status: number | null; gone: boolean };

/** The last push to one subscription, kept for the device that owns it (push-delivery.json). */
interface DeliveryRecord {
  /** sha256 of the endpoint, base64url: the endpoint itself is not written */
  hash: string;
  /** the device it was recorded for, or null for a local/token/Tailscale sign-in; never a legacy owner */
  owner: string | null;
  /** sha256 of the subscription's keys: what a reader has to hold */
  keys: string;
  success_at: number | null;
  failure_at: number | null;
  failure: PushDeliveryFailure | null;
  at: number;
}

/** An endpoint a push service retired (push-retired.json), keyed by its hash. */
interface RetiredMark {
  at: number;
  /** the device it was registered for, null for a local/token/Tailscale sign-in; absent for a legacy owner or an older file */
  owner?: string | null;
}

export function classifyFailure(status: number | null): PushDeliveryFailure {
  if (status === null) return "network";
  if (status === 404 || status === 410) return "gone";
  if (status === 401 || status === 403) return "key-mismatch";
  if (status === 429) return "throttled";
  if (status >= 500) return "server";
  return "rejected";
}

export interface PushService {
  publicKey(): string;
  parse(value: unknown): PushSubscriptionRecord | null;
  subscribe(subscription: PushSubscriptionRecord, alerts?: AlertPrefs, deviceId?: string | null, browserKeys?: readonly string[]): void;
  revokeDevice(id: string): void;
  unsubscribe(endpoint: string): void;
  retired(endpoint: string): boolean;
  sendTest(endpoint: string): Promise<PushDelivery | null>;
  /**
   * What this server knows of one subscription, for its owner holding its keys: null for anyone
   * else, for an unknown subscription and for a legacy owner (undefined), all alike. A retired
   * subscription still answers, `registered: false`, with the failure that retired it.
   */
  status(subscription: PushSubscriptionRecord, owner: string | null | undefined): PushSubscriptionStatus | null;
  /**
   * A device was durably enrolled (server/devices.ts): every other eligible subscriber is told at
   * once, visibly, whether or not a window of the app is in use somewhere (that window could be
   * the new device's). The new device's own subscriptions hear nothing, and neither does any
   * subscription of the browser that paired (`origin`, its stream keys), whoever owns it: a
   * token, local or Tailscale sign-in pairing itself, or a device pairing again. Resolves once delivered.
   */
  devicePaired(event: DevicePairedEvent, origin?: readonly string[]): Promise<void>;
  seed(panes: readonly HerdrPane[], machineId?: string, machineName?: string, serverId?: string): void;
  resync(panes: readonly HerdrPane[], newer: ReadonlySet<string>, machineId?: string): void;
  /**
   * A status the pane already had, where nothing was heard of it yet: nothing is announced, and the change after it (a
   * card's wait, server/card-waits.ts) is news rather than a first sighting.
   */
  assume(paneId: string, status: AgentStatus, machineId?: string): void;
  /** this PC's panes the snapshot no longer lists, `newer` aside (an event since it was asked for), are gone: their alerts are called off, silently */
  gone(panes: readonly HerdrPane[], newer: ReadonlySet<string>, machineId?: string): void;
  /** a pane closed with no exit of its own: its alerts are called off, silently (an exit's alert is `onEnded`'s) */
  closed(paneId: string, machineId?: string): void;
  /** herdr gave a pane a new ID: carry its alert unless the move says it resumed work after a question */
  moved(from: string, to: string, status: AgentStatus, machineId?: string): void;
  /** A local roster shows the same terminal waiting under a new pane ID, not a lifecycle move for other alerts. */
  movedQuestion(from: string, to: string, destinationNewer: boolean): void;
  /**
   * A pane created while the server ran, first read at `status` by a snapshot, where nothing was heard of it yet: told
   * as a change from what it was `created` as, so a question or finish it reached before anyone listened alerts. Not
   * between two readings at rest (herdr reads a finish nobody saw as done or idle), and its turn is of unknown length.
   */
  firstStatus(paneId: string, created: AgentStatus, status: AgentStatus, machineId?: string): Promise<void>;
  onStatus(paneId: string, status: AgentStatus, machineId?: string): Promise<void>;
  onEnded(paneId: string, machineId?: string): Promise<void>;
  onFailed(paneId: string, machineId?: string, failedBeforeQueuedTurn?: true): Promise<void>;
  mutesChanged(): void;
  settled(): Promise<void>;
}

export interface PushServiceOptions {
  stateDir: string;
  subject?: string;
  lookupPane?: (paneId: string) => Promise<{ title: string; agent_kind?: string } | undefined>;
  lookupPrompt?: (paneId: string, signal: AbortSignal) => Promise<{ prompt: InteractivePrompt; screen?: string } | null>;
  /** whether a subscription's device may answer a prompt (not one paired to watch only): only it gets the buttons */
  canAnswer?: (deviceId: string | null | undefined) => boolean;
  localName?: string;
  serverId?: () => string | undefined;
  timing?: Partial<AlertTiming>;
  now?: () => number;
  canDeliver?: (deviceId: string | null | undefined) => boolean;
  inUse?: () => boolean;
  muted?: (machineId: string, paneId: string) => boolean;
  /** accept plain-http loopback endpoints: only for the tests' fake push service (push.fake.ts) */
  loopbackHttp?: boolean;
  onAlertDelivered?: () => void;
  webhook?: Pick<AlertWebhook, "prefs" | "wants" | "generation" | "send">;
}

export { defaultStateDir } from "./update-state.ts";

/** readJson for the key pair and the subscriptions: one another account could write is refused, and no key is made in its place */
function readPrivateJson(path: string): unknown {
  const refused = privateStateRefusal(path);
  if (refused !== null) throw new Error(`${path} is not trusted: ${refused}`);
  return readJson(path);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Owner-only, and written whole, but not flushed: only for push-retired.json, which is telemetry.
 * The key pair and the subscriptions go through writePrivateState (private-state.ts).
 */
function writeJsonPrivate(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function decodedLength(value: unknown): number {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+=*$/.test(value)) return -1;
  return Buffer.from(value, "base64url").length;
}

/**
 * The form an endpoint is retired in: the URL as WHATWG serializes it (host in lowercase, no default
 * port, no dot segments), without its fragment, which never reaches the push service. Those spellings
 * of a retired endpoint are then that same endpoint (#2012); a query string, percent-encoding and a
 * trailing slash are kept as they are, since a push service may tell them apart (WNS keeps its token in
 * the query). What does not parse is returned as it is. Only the retired check uses it: a subscription,
 * its key pair (push-keys.json), its history and state-merge.ts's records stay under the spelling the
 * browser handed over, so nothing stored before has to be found under another one.
 */
export function normalizeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.hash = "";
    return url.href;
  } catch {
    return endpoint;
  }
}

export function parseSubscription(value: unknown, options: { loopbackHttp?: boolean } = {}): PushSubscriptionRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const { endpoint, keys } = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof endpoint !== "string") return null;
  try {
    const url = new URL(endpoint);
    // https only. A browser never hands over an http: endpoint (push is https by
    // definition), so one is never a subscription: it is only the shape that turns this
    // server into a POST from inside the user's network at a host no browser page could
    // reach — a link-local metadata address, a router admin page, another VLAN.
    // Loopback is no exception: a watch device would make every agent alert a POST to a
    // local service. Only a push service made for the tests' fake (push.fake.ts, which runs
    // on loopback http) passes `loopbackHttp`, through createServer's `pushLoopbackHttp`.
    const loopbackHttp = options.loopbackHttp === true && url.protocol === "http:" && isLoopbackHost(url.hostname);
    if (url.protocol !== "https:" && !loopbackHttp) return null;
  } catch {
    return null;
  }
  // p256dh is an uncompressed P-256 point (65 bytes), auth a 16-byte secret
  if (decodedLength(keys?.p256dh) !== 65 || decodedLength(keys?.auth) !== 16) return null;
  return { endpoint, keys: { p256dh: keys!.p256dh as string, auth: keys!.auth as string } };
}

export function statusMessage(paneId: string, title: string, status: AgentStatus, kind: AlertKind = status === "blocked" ? "input" : "done"): PushPayload {
  return { pane_id: paneId, title, body: kind === "permission" ? PERMISSION_NOTIFICATION_BODY : statusNotificationBody(status), tag: paneNotificationTag(paneId), kind };
}

/**
 * The buttons an alert for `prompt` carries: each option, when the prompt is one choice between at
 * most two short options (Allow / Deny, Yes / No) that nothing else goes with, and `screen` shows
 * all of what it is about (shownWhole). A plan, a menu, a form of several questions, a typed answer,
 * a queued question, or a prompt not read off a screen opens the pane instead.
 */
export function promptActions(prompt: InteractivePrompt | null, screen?: string): PushAction[] | null {
  if (!prompt || (prompt.kind !== "approval" && prompt.kind !== "question")) return null;
  // omp cut its own question short on the screen: what the alert would show is cut too
  if (screen === undefined || !shownWhole(prompt, screen) || parsedByPublicPrompt.get(prompt)?.ompQuestionCut) return null;
  if (prompt.multi_select || prompt.custom_option_index !== null || prompt.queued !== undefined || prompt.checks_with_text) return null;
  if (prompt.steps !== undefined || prompt.answers !== undefined || prompt.can_step_back || prompt.can_step_next) return null;
  if (prompt.options.length === 0 || prompt.options.length > 2) return null;
  // an option whose meaning is in its description is not answered by its label alone
  if (prompt.options.some((option) => option.label.trim() === "" || option.label.length > ACTION_LABEL_MAX || option.description)) return null;
  return prompt.options.map((option, index) => ({ option_index: index, label: option.label.trim() }));
}

/**
 * Whether the alert's text is the prompt as the screen shows it, verbatim: the body's lines are the
 * screen's lines right over the question, in order, with nothing between (a line a reader left out,
 * a key hint, a marker); over them is the prompt's title or a divider, so nothing of it is above the
 * screen or above a window the reader cut; under the question come the options, one line each. Any
 * line a reader dropped, filtered, joined or cut fails this, whichever agent's reader it is: a button
 * must approve only what the alert shows.
 */
export function shownWhole(prompt: InteractivePrompt, screen: string): boolean {
  const lines = screen.split("\n").map(cleanLine).filter((line) => line !== "");
  const body = (prompt.body ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const question = prompt.question.trim();
  const at = lines.lastIndexOf(question);
  if (at < 0) return false;
  if (!prompt.options.every((option, index) => lines[at + 1 + index]?.includes(option.label.trim()))) return false;
  const start = at - body.length;
  // the screen's first line has nothing over it to say it is where the prompt begins
  if (start < 1 || !body.every((line, index) => lines[start + index] === line)) return false;
  const over = lines[start - 1]!;
  return over === prompt.title.trim() || isDivider(over);
}

/**
 * What an alert with buttons says: the prompt's title, its question and what it shows (the command, the file).
 * Null when that does not fit an alert whole: a button must not approve what the alert cut off.
 */
export function promptSummary(prompt: InteractivePrompt): string | null {
  const body = (prompt.body ?? "").split("\n");
  if (body.length > PROMPT_SUMMARY_LINES) return null;
  // every line of what is approved stays, a repeated one too: only a title that repeats the question goes
  const head = prompt.title.trim() === prompt.question.trim() ? [prompt.question] : [prompt.title, prompt.question];
  const text = [...head, ...body].map((line) => line.trim()).filter((line) => line !== "").join("\n");
  return text.length > PROMPT_SUMMARY_MAX ? null : text;
}

export function endedMessage(paneId: string, title: string): PushPayload {
  return { pane_id: paneId, title, body: ENDED_NOTIFICATION_BODY, tag: paneNotificationTag(paneId), kind: "ended" };
}

export function failedMessage(paneId: string, title: string): PushPayload {
  return { pane_id: paneId, title, body: ERROR_NOTIFICATION_BODY, tag: paneNotificationTag(paneId), kind: "error" };
}

interface Scheduled {
  key: string;
  machineId: string;
  paneId: string;
  questionAt?: symbol;
  silenced: boolean;
  cancel: () => void;
}

export function createPushService(options: PushServiceOptions): PushService {
  const vapidPath = join(options.stateDir, "vapid.json");
  const subscriptionsPath = join(options.stateDir, "push-subscriptions.json");
  const subject = options.subject ?? process.env["OVIS_PUSH_SUBJECT"] ?? DEFAULT_SUBJECT;

  let vapid: { publicKey: string; privateKey: string } | null = null;
  let subscriptions: Map<string, PushSubscriptionRecord> | null = null;
  let stale = false;
  const lastStatus = new Map<string, AgentStatus>();
  const titles = new Map<string, string>();
  // the workspace a pane was last seen in: an alert names it, so the tap of an ended pane can open
  // its workspace (src/lib/deepLink.ts resolveLink) once herdr has dropped the pane
  const workspaces = new Map<string, string>();
  // what a blocked pane last said it waits for (herdr-core's agent_kind), for a PC whose pane is not looked up
  const kinds = new Map<string, string>();
  const pcNames = new Map<string, string>();
  const pcIds = new Map<string, string>();
  const pcKeys = (machineId: string): [string, string | undefined] => machineId === "local"
    ? [options.localName ?? hostname(), options.serverId?.()]
    : [pcNames.get(machineId) ?? machineId, pcIds.get(machineId)];
  const retiredPath = join(options.stateDir, "push-retired.json");
  /**
   * sha256 of each endpoint a push service retired -> when, and the owner it was registered for (absent for a
   * legacy one), oldest first; loaded on first need. The owner is kept here, not only in the delivery record,
   * because that record can be evicted first and a revocation still has to find the mark.
   */
  let retiredEndpoints: Map<string, RetiredMark> | null = null;
  const endpointHash = (endpoint: string): string => createHash("sha256").update(endpoint).digest("base64url");
  /** what a retired mark is keyed by: one key for every spelling of the endpoint (#2012) */
  const retiredKey = (endpoint: string): string => endpointHash(normalizeEndpoint(endpoint));
  /** a mark from before #2012 is keyed by the spelling as it was handed over */
  const isRetired = (endpoint: string): boolean => retiredStore().has(retiredKey(endpoint)) || retiredStore().has(endpointHash(endpoint));
  /** endpoint -> the key pair it was made for, when that is not vapid.json's; loaded on first need */
  let extraKeys: Map<string, VapidKeys> | null = null;

  /** The key pair `endpoint` was made for: one of push-keys.json's, else this server's own. */
  function keysFor(endpoint: string): VapidKeys {
    if (extraKeys === null) {
      extraKeys = new Map();
      const path = join(options.stateDir, PUSH_EXTRA_KEYS);
      try {
        const stored = readJson(path) as { keys?: unknown } | undefined;
        for (const entry of Array.isArray(stored?.keys) ? stored.keys as unknown[] : []) {
          const { publicKey, privateKey, endpoints } = (entry ?? {}) as { publicKey?: unknown; privateKey?: unknown; endpoints?: unknown };
          if (typeof publicKey !== "string" || typeof privateKey !== "string" || !Array.isArray(endpoints)) continue;
          for (const at of endpoints) if (typeof at === "string") extraKeys.set(at, { publicKey, privateKey });
        }
      } catch (error) {
        // those subscriptions are then signed with vapid.json's key, which their push service refuses
        console.error(`Cannot read ${path} (${(error as NodeJS.ErrnoException).code ?? "not JSON"}); subscriptions taken over from another state dir get no alerts until their devices subscribe again`);
      }
    }
    return extraKeys.get(endpoint) ?? keys();
  }
  const keyFingerprint = (keys: PushSubscriptionRecord["keys"]): string => createHash("sha256").update(`${keys.p256dh}.${keys.auth}`).digest("base64url");
  const deliveryPath = join(options.stateDir, "push-delivery.json");
  let deliveries: Map<string, DeliveryRecord> | null = null;

  /** Created on first need: a server nobody subscribes to never writes a key. */
  function keys(): { publicKey: string; privateKey: string } {
    if (vapid) return vapid;
    const stored = readPrivateJson(vapidPath) as { publicKey?: unknown; privateKey?: unknown } | undefined;
    if (stored === undefined) {
      // cached only once on disk: a key no restart would find must never sign a subscription
      const created = webpush.generateVAPIDKeys();
      writePrivateState(vapidPath, created);
      vapid = created;
    } else if (typeof stored.publicKey === "string" && typeof stored.privateKey === "string") {
      vapid = { publicKey: stored.publicKey, privateKey: stored.privateKey };
    } else {
      throw new Error(`${vapidPath} is malformed; restore it or delete it (every device then re-subscribes)`);
    }
    return vapid;
  }

  function store(): Map<string, PushSubscriptionRecord> {
    if (subscriptions) return subscriptions;
    const stored = readPrivateJson(subscriptionsPath);
    subscriptions = new Map();
    if (Array.isArray(stored)) {
      for (const entry of stored) {
        const parsed = parseSubscription(entry, options);
        if (parsed && isRetired(parsed.endpoint)) {
          stale = true;
          continue;
        }
        const alerts = (entry as { alerts?: unknown } | null)?.alerts;
        if (parsed) {
          const owner = (entry as PushSubscriptionRecord).device_id;
          const browser = (entry as { browser_keys?: unknown }).browser_keys;
          const browserKeys = Array.isArray(browser) ? browser.filter((key): key is string => typeof key === "string" && /^[0-9a-f]{32}$/.test(key)).slice(0, 8) : [];
          subscriptions.set(parsed.endpoint, { ...parsed, ...(alerts === undefined ? {} : { alerts: parseAlerts(alerts) }),
            ...(owner === null || typeof owner === "string" ? { device_id: owner } : {}),
            ...(browserKeys.length > 0 ? { browser_keys: browserKeys } : {}) });
        }
      }
    }
    return subscriptions;
  }

  function expire<T>(entries: Map<string, T>, at: (entry: T) => number, ttl: number): boolean {
    const cutoff = (options.now ?? Date.now)() - ttl;
    let changed = false;
    for (const [key, entry] of entries) {
      if (at(entry) > cutoff) continue;
      entries.delete(key);
      changed = true;
    }
    return changed;
  }

  /**
   * Writes the list back. Never throws: neither a read of the list (a subscribe's retired check) nor a
   * retirement may fail on it, as the list is telemetry (#2013). The list stays as it is in memory, and
   * the next write that succeeds puts it on disk.
   */
  function rewriteRetired(): void {
    try {
      persistRetired();
    } catch (error) {
      retiredUnwritten = true;
      console.error(`Cannot write ${retiredPath} (${(error as NodeJS.ErrnoException).code ?? "unknown error"}); retired endpoints are kept in memory until a write succeeds`);
    }
  }
  /**
   * The list on disk is not the one in memory (a write failed): a subscribe writes it first, so a mark
   * a revocation removed in memory only cannot come back at a restart and drop the new subscription.
   */
  let retiredUnwritten = false;

  function persistRetired(): void {
    writeJsonPrivate(retiredPath, [...retiredStore()].map(([hash, { at, owner }]) => ({ hash, at, ...(owner === undefined ? {} : { owner }) })));
    retiredUnwritten = false;
  }

  function retiredStore(): Map<string, RetiredMark> {
    if (retiredEndpoints) return retiredEndpoints;
    retiredEndpoints = new Map();
    let stored: unknown;
    try {
      stored = readJson(retiredPath);
    } catch {
      return retiredEndpoints; // an unreadable file only means a retired endpoint registers again once
    }
    if (!Array.isArray(stored)) return retiredEndpoints;
    for (const entry of stored.slice(-RETIRED_LIMIT)) {
      const { hash, at, owner } = (entry ?? {}) as { hash?: unknown; at?: unknown; owner?: unknown };
      if (typeof hash !== "string" || typeof at !== "number") continue;
      retiredEndpoints.set(hash, { at, ...(owner === null || typeof owner === "string" ? { owner } : {}) });
    }
    // what was dropped (over the bound, malformed) leaves the file too: a revocation later finds
    // nothing of it to remove, and the device's marks must not stay on disk
    if (retiredEndpoints.size !== stored.length) {
      rewriteRetired();
    }
    return retiredEndpoints;
  }

  function persist(next: Map<string, PushSubscriptionRecord>): void {
    writePrivateState(subscriptionsPath, [...next.values()]);
    subscriptions = next;
    stale = false;
  }

  function without(remove: (endpoint: string, subscription: PushSubscriptionRecord) => boolean): Map<string, PushSubscriptionRecord> | null {
    const next = new Map([...store()].filter(([endpoint, subscription]) => !remove(endpoint, subscription)));
    return next.size === store().size ? null : next;
  }

  const FAILURES: readonly PushDeliveryFailure[] = ["gone", "key-mismatch", "rejected", "throttled", "server", "network"];

  function deliveryStore(): Map<string, DeliveryRecord> {
    if (deliveries) {
      if (expire(deliveries, (record) => record.at, DELIVERY_TTL_MS)) persistDeliveries();
      return deliveries;
    }
    deliveries = new Map();
    let stored: unknown;
    try {
      stored = readJson(deliveryPath);
    } catch {
      return deliveries;
    }
    if (!Array.isArray(stored)) return deliveries;
    const cutoff = (options.now ?? Date.now)() - DELIVERY_TTL_MS;
    for (const entry of stored.slice(-DELIVERY_LIMIT)) {
      const { hash, owner, keys, success_at, failure_at, failure, at } = (entry ?? {}) as Partial<Record<keyof DeliveryRecord, unknown>>;
      // a number a Date cannot hold (1e100, NaN) would throw when the status is told: such a record is dropped
      const date = (value: unknown): value is number => typeof value === "number" && Number.isFinite(new Date(value).getTime());
      const time = (value: unknown): value is number | null => value === null || date(value);
      if (typeof hash !== "string" || !(owner === null || typeof owner === "string") || typeof keys !== "string" || !date(at) || at <= cutoff) continue;
      if (!time(success_at) || !time(failure_at) || !(failure === null || FAILURES.includes(failure as PushDeliveryFailure))) continue;
      deliveries.set(hash, { hash, owner, keys, success_at, failure_at, failure: failure as PushDeliveryFailure | null, at });
    }
    // what was dropped leaves the file too: an unsubscribe or a revocation later finds nothing of it to
    // remove, and a device's history must not stay on disk without another push
    if (deliveries.size !== stored.length) persistDeliveries();
    return deliveries;
  }

  /**
   * Never throws: the records are telemetry, and a write that fails (a full disk) must not keep a
   * push's own outcome from counting, a retirement included. They stay in memory until a write succeeds.
   */
  function persistDeliveries(): void {
    try {
      writeJsonPrivate(deliveryPath, [...deliveryStore().values()]);
    } catch (error) {
      console.error(`Cannot write ${deliveryPath} (${(error as NodeJS.ErrnoException).code ?? "unknown error"}); push health is kept in memory until a write succeeds`);
    }
  }

  function identityOf(subscription: PushSubscriptionRecord): { hash: string; owner: string | null | undefined; keys: string } {
    return { hash: endpointHash(subscription.endpoint), owner: subscription.device_id, keys: keyFingerprint(subscription.keys) };
  }

  /** The stored subscription is still the one the push went to: same owner, same keys. */
  function stillOwns(identity: ReturnType<typeof identityOf>, endpoint: string): boolean {
    const current = store().get(endpoint);
    return current !== undefined && current.device_id === identity.owner && keyFingerprint(current.keys) === identity.keys;
  }

  /** A push went out and was answered: its outcome is this subscription's latest, for its owner. */
  function recordDelivery(identity: ReturnType<typeof identityOf>, failure: PushDeliveryFailure | null): void {
    // a legacy subscription (from before owners, or the open LAN) is nobody's to read
    if (identity.owner === undefined) return;
    const records = deliveryStore();
    const previous = records.get(identity.hash);
    const kept = previous && previous.owner === identity.owner && previous.keys === identity.keys ? previous : null;
    const now = (options.now ?? Date.now)();
    records.delete(identity.hash);
    records.set(identity.hash, {
      hash: identity.hash, owner: identity.owner, keys: identity.keys,
      success_at: failure === null ? now : kept?.success_at ?? null,
      failure_at: failure === null ? kept?.failure_at ?? null : now,
      failure: failure === null ? kept?.failure ?? null : failure,
      at: now,
    });
    while (records.size > DELIVERY_LIMIT) records.delete(records.keys().next().value!);
    persistDeliveries();
  }

  function forgetDeliveries(keep: (record: DeliveryRecord) => boolean): void {
    const records = deliveryStore();
    let changed = false;
    for (const [hash, record] of records) {
      if (keep(record)) continue;
      records.delete(hash);
      changed = true;
    }
    if (changed) persistDeliveries();
  }

  const iso = (at: number | null): string | null => at === null ? null : new Date(at).toISOString();

  async function deliver(subscription: PushSubscriptionRecord, message: PushPayload, urgency: "normal" | "high"): Promise<PushDelivery> {
    // denied here, nothing went out: not a delivery, so nothing is recorded
    if (options.canDeliver && !options.canDeliver(subscription.device_id)) return { ok: false, status: null, gone: false };
    // what the push goes to, taken now: by the time the answer comes the endpoint may be
    // registered again by another owner or with other keys, and that subscription is not told
    const identity = identityOf(subscription);
    const { publicKey, privateKey } = keysFor(subscription.endpoint);
    const request = (payload: PushPayload) => webpush.generateRequestDetails(subscription, JSON.stringify(payload), {
      vapidDetails: { subject, publicKey, privateKey },
      TTL: PUSH_TTL_SECONDS,
      urgency,
      contentEncoding: "aes128gcm",
    });
    // which PC sent it, for the phone app's tap (shared/push.ts endpoint): a pane alert to the push
    // relay only, as a browser's worker knows its PC by its own scope
    const toRelay = message.pane_id !== null && RELAY_ENDPOINT_PATH.test(new URL(subscription.endpoint).pathname);
    const serverId = toRelay ? options.serverId?.() : undefined;
    const named: PushPayload | null = toRelay ? { ...message, endpoint: subscription.endpoint, ...(serverId ? { server_id: serverId } : {}) } : null;
    let details = request(named ?? message);
    if (named && details.body.length > RELAY_MAX_BODY_BYTES) details = request(message);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(details.headers)) headers[name] = String(value);
    let status: number | null = null;
    try {
      const response = await fetch(details.endpoint, {
        method: details.method,
        headers,
        body: new Uint8Array(details.body),
        // a push service answers, it never redirects: following one would send the alert to
        // wherever the endpoint points, past the https-only check (a local service, over http)
        redirect: "error",
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      if (response.ok) {
        if (stillOwns(identity, subscription.endpoint)) recordDelivery(identity, null);
        return { ok: true };
      }
      status = response.status;
    } catch {
    }
    // 404/410: the device unsubscribed or the browser dropped the subscription
    const gone = status === 404 || status === 410;
    // a replacement subscription at this endpoint is not retired, and not written to, for a push
    // that went to the one before it
    if (!stillOwns(identity, subscription.endpoint)) return { ok: false, status, gone };
    recordDelivery(identity, classifyFailure(status));
    if (gone) {
      const retired = retiredStore();
      const mark = retiredKey(subscription.endpoint);
      // two spellings of one endpoint held by different owners share the mark: it then belongs to neither,
      // so one owner's revocation cannot take a mark the other's subscription was retired under too
      const previous = retired.get(mark);
      const shared = (previous !== undefined && previous.owner === undefined)
        || [...store().values()].some((held) => held.endpoint !== subscription.endpoint && retiredKey(held.endpoint) === mark && held.device_id !== identity.owner);
      const owner = shared ? undefined : identity.owner;
      retired.delete(mark);
      retired.set(mark, { at: (options.now ?? Date.now)(), ...(owner === undefined ? {} : { owner }) });
      if (retired.size > RETIRED_LIMIT) retired.delete(retired.keys().next().value!);
      rewriteRetired();
      const next = without((endpoint) => endpoint === subscription.endpoint);
      if (next) {
        try {
          persist(next);
        } catch (error) {
          subscriptions = next;
          stale = true;
          console.error(`Cannot write ${subscriptionsPath} (${(error as NodeJS.ErrnoException).code ?? "unknown error"}); the retired subscription is dropped in memory until a write succeeds`);
        }
      }
    } else {
      console.error(`web push to ${new URL(subscription.endpoint).host} failed: ${status ?? "no response"}`);
    }
    return { ok: false, status, gone };
  }

  async function broadcast(message: PushPayload, urgency: "normal" | "high", to: readonly PushSubscriptionRecord[] = [...store().values()], alert = false): Promise<void> {
    await Promise.all(
      to.map((subscription) =>
        deliver(subscription, message, urgency).then((delivery) => {
          if (alert && delivery.ok) options.onAlertDelivered?.();
        }, (error: unknown) => {
          console.error(`web push failed: ${error instanceof Error ? error.message : String(error)}`);
        }),
      ),
    );
  }

  function where(key: string, machineId: string): Pick<PushPayload, "machine_id" | "workspace_id"> {
    const workspace = workspaces.get(key);
    return { ...(machineId === "local" ? {} : { machine_id: machineId }), ...(workspace ? { workspace_id: workspace } : {}) };
  }

  async function lookUp(key: string, machineId: string, paneId: string): Promise<{ title: string; agentKind: string | undefined }> {
    if (machineId === "local") {
      try {
        const fresh = await options.lookupPane?.(paneId);
        if (fresh?.title) return { title: fresh.title, agentKind: fresh.agent_kind };
      } catch {
      }
    }
    return { title: titles.get(key) ?? paneId, agentKind: kinds.get(key) };
  }

  async function readActions(paneId: string): Promise<{ promptId: string; body: string; actions: PushAction[] } | null> {
    if (!options.lookupPrompt) return null;
    const signal = AbortSignal.timeout(PROMPT_LOOKUP_MS);
    try {
      const read = await Promise.race([
        options.lookupPrompt(paneId, signal),
        new Promise<null>((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true })),
      ]);
      const prompt = read?.prompt ?? null;
      const actions = promptActions(prompt, read?.screen);
      const body = prompt && actions ? promptSummary(prompt) : null;
      return prompt && actions && body !== null ? { promptId: prompt.id, body, actions } : null;
    } catch {
      return null;
    }
  }

  const timing = { ...DEFAULT_ALERT_TIMING, ...options.timing };
  const now = options.now ?? Date.now;
  const turnStart = new Map<string, number>();
  const waiting = new Map<string, Scheduled>();
  const unsent = new Set<Scheduled>();
  const inFlight = new Set<Promise<void>>();

  const changes = new Map<string, symbol>();

  function tellWebhook(key: string, machineId: string, paneId: string, message: PushPayload, generation?: number): void {
    const workspace = workspaces.get(key);
    const at = epochs.get(key) ?? 0;
    hooked.set(key, { machineId, paneId });
    options.webhook?.send({
      kind: message.kind ?? "input", title: message.title, body: message.body, pane_id: paneId,
      // a terminal that ended stays ended: what changes the pane after it (closed, gone from a snapshot) does not call it off
      current: () => (message.kind === "ended" || (epochs.get(key) ?? 0) === at) && !muted(machineId, paneId) && options.inUse?.() !== true,
      ...(machineId === "local" ? { pc: pcKeys(machineId)[0] } : { machine_id: machineId }),
      ...(workspace ? { workspace_id: workspace } : {}),
      ...(generation === undefined ? {} : { generation }),
    });
  }

  const epochs = new Map<string, number>();
  const hooked = new Map<string, { machineId: string; paneId: string }>();
  const bump = (key: string): void => { epochs.set(key, (epochs.get(key) ?? 0) + 1); };

  function callOff(key: string): void {
    changes.set(key, Symbol());
    bump(key);
    waiting.get(key)?.cancel();
    waiting.delete(key);
  }

  /** an alert under way for it, its timer already fired, is silenced too; and with no status left a late one is not told */
  function forget(key: string): void {
    for (const entry of unsent) if (entry.key === key) entry.silenced = true;
    callOff(key);
    changes.delete(key);
    turnStart.delete(key);
    lastStatus.delete(key);
  }

  function currentQuestion(key: string): Scheduled | undefined {
    if (lastStatus.get(key) !== "blocked") return;
    const at = changes.get(key);
    if (at === undefined) return;
    for (const entry of unsent) {
      if (entry.key === key && !entry.silenced && entry.questionAt === at) return entry;
    }
  }

  function rekeyAlert(entry: Scheduled, after: string, paneId: string): void {
    if (waiting.get(entry.key) === entry) {
      waiting.delete(entry.key);
      waiting.set(after, entry);
    }
    entry.key = after;
    entry.paneId = paneId;
  }

  function carryQuestion(question: Scheduled, after: string, paneId: string): void {
    const before = question.key;
    const at = changes.get(before);
    if (at === undefined) return;
    rekeyAlert(question, after, paneId);
    changes.set(after, at);
    lastStatus.set(after, "blocked");
    const began = turnStart.get(before);
    if (began !== undefined && !turnStart.has(after)) turnStart.set(after, began);
  }

  function gone(panes: readonly HerdrPane[], newer: ReadonlySet<string>, machineId: string): void {
    const present = new Set(panes.map((pane) => paneStorageId(machineId, pane.pane_id)));
    const newerKeys = new Set([...newer].map((paneId) => paneStorageId(machineId, paneId)));
    const remotePrefix = `remote:${encodeURIComponent(machineId)}:`;
    const onThisPc = (key: string): boolean => machineId === "local" ? !key.startsWith("remote:") : key.startsWith(remotePrefix);
    for (const key of [...lastStatus.keys()]) {
      if (onThisPc(key) && !present.has(key) && !newerKeys.has(key)) forget(key);
    }
  }

  const muted = (machineId: string, paneId: string): boolean => options.muted?.(machineId, paneId) === true;
  // A web push the device received has to be shown (iOS takes the subscription away from a page
  // that shows none), so a device's alert choices are applied here, not on the device.
  const wants = (subscription: PushSubscriptionRecord, kind: AlertKind, machineId: string): boolean => {
    const prefs = subscription.alerts ?? DEFAULT_ALERTS;
    return alertKindAllowed(prefs, kind) && alertPcAllowed(prefs, ...pcKeys(machineId));
  };

  function delayFor(prefs: AlertPrefs, status: AgentStatus, worked: number | null): number | null {
    if (status === "blocked") return alertKindAllowed(prefs, "input") || alertKindAllowed(prefs, "permission") ? timing.short : null;
    if (status !== "done" || prefs.done === "off") return null;
    if (prefs.done === "always") return timing.short;
    return worked === null || worked >= timing.longTurn ? timing.long : null;
  }

  function schedule(key: string, machineId: string, paneId: string, groups: Map<number, PushSubscriptionRecord[]>, send: (to: PushSubscriptionRecord[], silenced: () => boolean, delay: number, pane: Scheduled) => Promise<void>, questionAt?: symbol): void {
    const cancels: Array<() => void> = [];
    let remaining = groups.size;
    let open = groups.size;
    for (const [delay, to] of groups) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let fired = false;
      const done = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          fired = true;
          remaining -= 1;
          if (remaining === 0 && waiting.get(entry.key) === entry) waiting.delete(entry.key);
          send(to, () => entry.silenced, delay, entry).catch((error: unknown) => {
            console.error(`web push failed: ${error instanceof Error ? error.message : String(error)}`);
          }).finally(resolve);
        }, delay);
        cancels.push(() => { if (fired) return; clearTimeout(timer); resolve(); });
      });
      inFlight.add(done);
      void done.finally(() => {
        inFlight.delete(done);
        open -= 1;
        if (open === 0) unsent.delete(entry);
      });
    }
    const entry: Scheduled = { key, machineId, paneId, ...(questionAt === undefined ? {} : { questionAt }), silenced: false, cancel: () => { for (const cancel of cancels) cancel(); } };
    waiting.set(key, entry);
    unsent.add(entry);
  }

  /** `timed`: a turn this change begins is timed from now; a first reading came after its turn began */
  async function statusChanged(paneId: string, status: AgentStatus, machineId: string, timed: boolean): Promise<void> {
    const key = paneStorageId(machineId, paneId);
    const previous = lastStatus.get(key);
    lastStatus.set(key, status);
    if (previous === status) return;
    callOff(key);
    const busy = (value: AgentStatus | undefined): boolean => value === "working" || value === "blocked";
    if (timed && busy(status) && previous !== undefined && !busy(previous)) turnStart.set(key, now());
    let worked: number | null = null;
    if (!busy(status)) {
      const start = turnStart.get(key);
      worked = start === undefined ? null : now() - start;
      turnStart.delete(key);
    }
    if (!shouldNotifyStatus(previous, status)) return;
    if (muted(machineId, paneId)) return;
    const groups = new Map<number, PushSubscriptionRecord[]>();
    for (const subscription of store().values()) {
      const prefs = subscription.alerts ?? DEFAULT_ALERTS;
      if (!alertPcAllowed(prefs, ...pcKeys(machineId))) continue;
      const delay = delayFor(prefs, status, worked);
      if (delay !== null) groups.set(delay, [...(groups.get(delay) ?? []), subscription]);
    }
    const hookPrefs = options.webhook?.prefs() ?? null;
    const hookDelay = hookPrefs === null ? null : delayFor(hookPrefs, status, worked);
    if (hookDelay !== null && !groups.has(hookDelay)) groups.set(hookDelay, []);
    if (groups.size === 0) return;
    // the destination the alert arose for: one set before the timer fires was not there to be told
    const hookAt = options.webhook?.generation();
    schedule(key, machineId, paneId, groups, async (to, silenced, delay, pane) => {
      if (options.inUse?.() || muted(machineId, pane.paneId)) return;
      // only this PC's prompts are read here, and only a question's alert carries buttons
      const reading = status === "blocked" && machineId === "local" ? readActions(pane.paneId) : Promise.resolve(null);
      const [{ title, agentKind }, answer] = await Promise.all([lookUp(pane.key, machineId, pane.paneId), reading]);
      if (options.inUse?.() || silenced() || muted(machineId, pane.paneId)) return;
      // a question whose pane changed while its prompt was read: the next asking's alert, under the same tag, holds what
      // the pane asks now, and this one's buttons must not replace it. A finish already under way still goes out
      if (status === "blocked" && changes.get(pane.key) !== pane.questionAt) return;
      const kind: AlertKind = status === "blocked" ? blockedAlertKind(agentKind) : "done";
      // a device that dropped out meanwhile is not written to, nor one that does not want this kind
      const live = to.flatMap((subscription) => {
        const current = store().get(subscription.endpoint);
        return current && current.device_id === subscription.device_id && wants(current, kind, machineId) ? [current] : [];
      });
      const hook = delay === hookDelay && options.webhook?.wants(kind) === true;
      if (live.length === 0 && !hook) return;
      const message = statusMessage(pane.paneId, title, status, kind);
      if (hook) tellWebhook(pane.key, machineId, pane.paneId, message, hookAt);
      if (live.length === 0) return;
      const alert: PushPayload = { ...message, ...where(pane.key, machineId), tag: paneNotificationTag(pane.paneId, machineId) };
      const urgency = status === "blocked" ? "high" : "normal";
      const answering = answer === null ? [] : live.filter((subscription) => options.canAnswer?.(subscription.device_id) ?? true);
      await Promise.all([
        // the buttons go with what they answer: a bare "Yes" under "waiting for your input" says nothing of what it allows
        broadcast({ ...alert, ...(answer === null ? {} : { body: answer.body, prompt_id: answer.promptId, actions: answer.actions }) }, urgency, answering, true),
        broadcast(alert, urgency, live.filter((subscription) => !answering.includes(subscription)), true),
      ]);
    }, status === "blocked" ? changes.get(key) : undefined);
  }

  return {
    publicKey: () => keys().publicKey,
    parse: (value) => parseSubscription(value, options),

    subscribe(subscription, alerts, deviceId, browserKeys = []) {
      const previous = store().get(subscription.endpoint);
      const kept = alerts ?? previous?.alerts;
      // one endpoint is one browser: a re-registration adds the keys it carries (a browser that lost its
      // key cookie is issued a new one) to those it was registered with, the newest kept within the limit
      const merged = [...new Set([...(previous?.browser_keys ?? []), ...browserKeys])].slice(-8);
      const browser = merged.length > 0 ? merged : undefined;
      const next = new Map(store());
      next.set(subscription.endpoint, { ...subscription, ...(kept === undefined ? {} : { alerts: kept }),
        ...(deviceId === undefined ? {} : { device_id: deviceId }),
        ...(browser === undefined ? {} : { browser_keys: browser }) });
      if (retiredUnwritten) persistRetired();
      persist(next);
      // the record of the subscription this replaces (another owner, other keys) is not the new one's
      const identity = identityOf({ ...subscription, device_id: deviceId });
      forgetDeliveries((record) => record.hash !== identity.hash || (identity.owner !== undefined && record.owner === identity.owner && record.keys === identity.keys));
    },

    revokeDevice(id) {
      persist(without((_, subscription) => subscription.device_id === id || subscription.device_id === undefined) ?? new Map(store()));
      // the device's tombstones go with its history: the retired marks of the endpoints it owned
      const retired = retiredStore();
      let unmarked = false;
      for (const [hash, mark] of retired) {
        if (mark.owner !== id) continue;
        retired.delete(hash);
        unmarked = true;
      }
      // a write that fails must not keep the device's history: the next write that succeeds drops its marks from disk
      if (unmarked) rewriteRetired();
      forgetDeliveries((record) => record.owner !== id);
    },

    unsubscribe(endpoint) {
      const next = without((key) => key === endpoint);
      if (next) persist(next);
      else if (stale) persist(new Map(store()));
      const hash = endpointHash(endpoint);
      // an explicit goodbye takes the endpoint's history with it, but never its retired mark: this route proves
      // neither owner nor keys, and a mark it cleared would let anyone register a retired endpoint again with
      // keys of their own (#1038). The mark goes only with its owner's revocation
      forgetDeliveries((record) => record.hash !== hash);
    },

    status(subscription, owner) {
      // the open LAN and a subscription from before owners prove nothing
      if (owner === undefined) return null;
      const hash = endpointHash(subscription.endpoint);
      const proof = keyFingerprint(subscription.keys);
      const current = store().get(subscription.endpoint);
      const record = deliveryStore().get(hash);
      const mine = record !== undefined && record.owner === owner && record.keys === proof ? record : null;
      if (current) {
        if (current.device_id !== owner || keyFingerprint(current.keys) !== proof) return null;
        return { registered: true, last_success_at: iso(mine?.success_at ?? null), last_failure_at: iso(mine?.failure_at ?? null), last_failure: mine?.failure ?? null };
      }
      if (!mine) return null;
      return { registered: false, last_success_at: iso(mine.success_at), last_failure_at: iso(mine.failure_at), last_failure: mine.failure };
    },

    retired: isRetired,

    async sendTest(endpoint) {
      const subscription = store().get(endpoint);
      if (!subscription) return null;
      return deliver(subscription, { pane_id: null, title: "Ovis", body: "Alerts are on for this device", tag: "herdr-test" }, "normal");
    },

    async devicePaired(event, origin = []) {
      // its own tag per enrollment: a second delivery of the same event replaces the first instead of adding to it
      const others = [...store().values()].filter((subscription) => subscription.device_id !== event.device_id
        && !(subscription.browser_keys ?? []).some((key) => origin.includes(key)));
      await broadcast({ pane_id: null, title: "Ovis", body: `New device paired: ${event.label}`, tag: `herdr-device-paired-${event.event_id}` }, "high", others);
    },

    seed(panes, machineId = "local", machineName, serverId) {
      if (machineName) pcNames.set(machineId, machineName);
      if (serverId) pcIds.set(machineId, serverId);
      for (const pane of panes) {
        const key = paneStorageId(machineId, pane.pane_id);
        titles.set(key, `${machineName ? machineName + " · " : ""}${pushPaneTitle(pane)}`);
        workspaces.set(key, pane.workspace_id);
        if (pane.agent_kind) kinds.set(key, pane.agent_kind); else kinds.delete(key);
        if (!lastStatus.has(key)) lastStatus.set(key, pane.agent_status);
      }
    },

    assume(paneId, status, machineId = "local") {
      const key = paneStorageId(machineId, paneId);
      if (!lastStatus.has(key)) lastStatus.set(key, status);
    },

    resync(panes, newer, machineId = "local") {
      const busy = (value: AgentStatus | undefined): boolean => value === "working" || value === "blocked";
      gone(panes, newer, machineId);
      for (const pane of panes) {
        if (newer.has(pane.pane_id)) continue;
        const key = paneStorageId(machineId, pane.pane_id);
        const previous = lastStatus.get(key);
        const status = pane.agent_status;
        if (previous === status) continue;
        // done and idle are both at rest: herdr reports a finish nobody has seen as idle. No
        // alert is called off for it, but it is what the next event is measured against
        if (previous !== undefined && !busy(previous) && !busy(status)) { lastStatus.set(key, status); continue; }
        lastStatus.set(key, status);
        if (previous === undefined) continue;
        callOff(key);
        if (busy(status) !== busy(previous)) turnStart.delete(key);
      }
    },

    gone(panes, newer, machineId = "local") {
      gone(panes, newer, machineId);
    },

    closed(paneId, machineId = "local") {
      forget(paneStorageId(machineId, paneId));
    },

    movedQuestion(from, to, destinationNewer) {
      const before = paneStorageId("local", from);
      const after = paneStorageId("local", to);
      const question = currentQuestion(before);
      if (before === after || !question) return;
      const heard = changes.has(after);
      if (destinationNewer && !heard) return;
      // A first blocked reading is not a second alert. A destination that actually queued its
      // own question keeps it; an already resolved destination must not inherit the old one.
      if ((!heard || lastStatus.get(after) === "blocked") && !currentQuestion(after)) {
        carryQuestion(question, after, to);
      }
      forget(before);
    },

    moved(from, to, status, machineId = "local") {
      const before = paneStorageId(machineId, from);
      const after = paneStorageId(machineId, to);
      if (before === after || !lastStatus.has(before)) return;
      const destination = lastStatus.get(after);
      if (changes.has(after) && (lastStatus.get(before) === "blocked" || destination === "blocked")) {
        // A question already reported at the new ID takes precedence over the move payload.
        const question = currentQuestion(before);
        if (question && destination === "blocked" && !currentQuestion(after)) carryQuestion(question, after, to);
        for (const entry of unsent) {
          if (entry.key !== before || entry.questionAt !== undefined) continue;
          // An already-started finish still goes out. A timer must not replace the destination's question.
          if (waiting.get(before) === entry && waiting.has(after)) {
            entry.cancel();
            waiting.delete(before);
          }
          rekeyAlert(entry, after, to);
        }
        forget(before);
        return;
      }
      forget(after);
      for (const state of [lastStatus, turnStart, changes, titles, workspaces, kinds] as Map<string, unknown>[]) {
        if (!state.has(before)) continue;
        state.set(after, state.get(before));
        state.delete(before);
      }
      // its alert reads the pane it is for when it goes out: under way already, it goes out under the new ID too
      for (const entry of unsent) {
        if (entry.key === before) rekeyAlert(entry, after, to);
      }
      // The collector has already taken the move's working status as its baseline.
      if (status === "working" && lastStatus.get(after) === "blocked") {
        lastStatus.set(after, status);
        bump(before); // A queued webhook still checks the old ID.
        callOff(after);
      }
    },

    firstStatus(paneId, created, status, machineId = "local") {
      const key = paneStorageId(machineId, paneId);
      const atRest = (value: AgentStatus): boolean => value === "idle" || value === "done";
      if (lastStatus.has(key) || (atRest(created) && atRest(status))) return Promise.resolve();
      lastStatus.set(key, created);
      return statusChanged(paneId, status, machineId, false);
    },

    onStatus(paneId, status, machineId = "local") {
      return statusChanged(paneId, status, machineId, true);
    },

    async onFailed(paneId, machineId = "local", failedBeforeQueuedTurn) {
      const key = paneStorageId(machineId, paneId);
      const at = lastStatus.get(key);
      if ((at === "working" && !failedBeforeQueuedTurn) || at === "blocked" || muted(machineId, paneId)) return;
      const to = [...store().values()].filter((subscription) => {
        const prefs = subscription.alerts ?? DEFAULT_ALERTS;
        return alertKindAllowed(prefs, "error") && alertPcAllowed(prefs, ...pcKeys(machineId));
      });
      const hooked = options.webhook?.wants("error") === true;
      if (to.length === 0 && !hooked) return;
      const hookAt = options.webhook?.generation();
      schedule(key, machineId, paneId, new Map([[timing.short, to]]), async (group, silenced, _delay, pane) => {
        if (options.inUse?.() || muted(machineId, pane.paneId)) return;
        const { title } = await lookUp(pane.key, machineId, pane.paneId);
        if (options.inUse?.() || silenced() || muted(machineId, pane.paneId)) return;
        const live = group.flatMap((subscription) => {
          const current = store().get(subscription.endpoint);
          return current && current.device_id === subscription.device_id && wants(current, "error", machineId) ? [current] : [];
        });
        const hook = options.webhook?.wants("error") === true;
        if (live.length === 0 && !hook) return;
        const message = failedMessage(pane.paneId, title);
        if (hook) tellWebhook(pane.key, machineId, pane.paneId, message, hookAt);
        if (live.length === 0) return;
        await broadcast({ ...message, ...where(pane.key, machineId), tag: paneNotificationTag(pane.paneId, machineId) }, "normal", live, true);
      });
      // told while a queued turn already runs: that turn's next status must not call this failure's alert off (a pane
      // that is forgotten still silences it)
      if (failedBeforeQueuedTurn) waiting.delete(key);
    },

    async onEnded(paneId, machineId = "local") {
      const key = paneStorageId(machineId, paneId);
      callOff(key);
      changes.delete(key);
      turnStart.delete(key);
      if (muted(machineId, paneId)) return;
      const to = [...store().values()].filter((subscription) => {
        const prefs = subscription.alerts ?? DEFAULT_ALERTS;
        return alertKindAllowed(prefs, "ended") && alertPcAllowed(prefs, ...pcKeys(machineId));
      });
      const hook = options.webhook?.wants("ended") === true;
      if ((to.length === 0 && !hook) || options.inUse?.()) return;
      // the pane may already be gone from herdr: the seeded title is what is left
      const message = endedMessage(paneId, titles.get(key) ?? paneId);
      if (hook) tellWebhook(key, machineId, paneId, message);
      if (to.length === 0) return;
      await broadcast({ ...message, ...where(key, machineId), tag: paneNotificationTag(paneId, machineId) }, "normal", to);
    },

    mutesChanged() {
      for (const [key, pane] of hooked) {
        if (!muted(pane.machineId, pane.paneId)) continue;
        bump(key);
        hooked.delete(key);
      }
      for (const entry of [...unsent]) {
        if (!muted(entry.machineId, entry.paneId)) continue;
        entry.silenced = true;
        entry.cancel();
        unsent.delete(entry);
        if (waiting.get(entry.key) === entry) waiting.delete(entry.key);
      }
    },

    async settled() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}

/**
 * /api/push routes. All sit behind the token gate (they are /api/ and not health/auth):
 * a subscription receives pane titles until it is removed.
 *   GET    /api/push                        -> { public_key }
 *   POST   /api/push/subscribe { subscription, alerts? } -> 204 (alerts: this device's AlertPrefs)
 *          | 410 subscription_gone (its push service retired the endpoint: subscribe anew)
 *   DELETE /api/push/subscribe { endpoint } -> 204
 *   POST   /api/push/test      { endpoint } -> 204 | 404 subscription_not_found | 410 subscription_gone | 502 push_failed
 *   POST   /api/push/status    { subscription } -> PushSubscriptionStatus | 404 subscription_not_found (unknown, another
 *          owner's, other keys, a legacy owner: one answer, so nothing is enumerated)
 */
function subscriptionGone(): Response {
  return jsonResponse({ error: { code: "subscription_gone", message: "the push service retired this subscription; subscribe again" } }, 410);
}

function subscriptionNotFound(): Response {
  return jsonResponse({ error: { code: "subscription_not_found", message: "this device is not subscribed" } }, 404);
}

const PUSH_ROUTES = ["POST /api/push/subscribe", "DELETE /api/push/subscribe", "POST /api/push/test", "POST /api/push/status"];

export async function handlePushRequest(request: Request, pathname: string, push: PushService, deviceId: string | null | undefined, browserKeys: readonly string[] = []): Promise<Response | null> {
  if (pathname === "/api/push" || pathname === "/api/push/subscribe" || pathname === "/api/push/test" || pathname === "/api/push/status") setRequestRoute(pathname);
  const route = `${request.method} ${pathname}`;
  if (route === "GET /api/push") return jsonResponse({ public_key: push.publicKey() });
  if (!PUSH_ROUTES.includes(route)) {
    const known = pathname === "/api/push" || PUSH_ROUTES.some((candidate) => candidate.endsWith(` ${pathname}`));
    return known ? badRequest("method_not_allowed", `${request.method} is not supported on ${pathname}`) : null;
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest("invalid_json", "request body must be JSON");
  }
  const body = (typeof payload === "object" && payload !== null ? payload : {}) as { subscription?: unknown; endpoint?: unknown; alerts?: unknown };

  if (route === "POST /api/push/subscribe") {
    const subscription = push.parse(body.subscription);
    if (!subscription) return badRequest("invalid_subscription", "subscription needs an https endpoint and p256dh/auth keys");
    if (push.retired(subscription.endpoint)) return subscriptionGone();
    push.subscribe(subscription, body.alerts === undefined ? undefined : parseAlerts(body.alerts), deviceId, browserKeys);
    return new Response(null, { status: 204 });
  }
  if (route === "POST /api/push/status") {
    // the open LAN signs in as nobody: no record can be its own, so it is told that before any is looked
    // at, and its device stays quiet rather than reading "not subscribed" for a subscription that works
    if (deviceId === undefined) return jsonResponse({ error: { code: "status_unavailable", message: "this sign-in has no device to answer for" } }, 403);
    const subscription = push.parse(body.subscription);
    if (!subscription) return badRequest("invalid_subscription", "subscription needs an https endpoint and p256dh/auth keys");
    const status = push.status(subscription, deviceId);
    return status ? jsonResponse(status, 200, { "cache-control": "no-store" }) : subscriptionNotFound();
  }
  if (typeof body.endpoint !== "string") return badRequest("missing_endpoint", "endpoint is required");
  if (route === "DELETE /api/push/subscribe") {
    push.unsubscribe(body.endpoint);
    return new Response(null, { status: 204 });
  }
  const delivery = await push.sendTest(body.endpoint);
  if (!delivery) return push.retired(body.endpoint) ? subscriptionGone() : subscriptionNotFound();
  if (delivery.ok) return new Response(null, { status: 204 });
  if (delivery.gone) return subscriptionGone();
  return jsonResponse({ error: { code: "push_failed", message: `push service answered ${delivery.status ?? "nothing"}` } }, 502);
}
