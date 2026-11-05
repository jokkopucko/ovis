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
 * reaches the phone. herdr says nothing of whether anyone is at the PC, so a change that
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
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import webpush from "web-push";

import { paneStorageId } from "../shared/machines.ts";
import type { AgentStatus, DevicePairedEvent, HerdrPane, PushDeliveryFailure, PushPayload, PushSubscriptionStatus } from "../shared/protocol.ts";
import {
  type AlertPrefs,
  DEFAULT_ALERTS,
  ENDED_NOTIFICATION_BODY,
  paneNotificationTag,
  paneTitle,
  parseAlerts,
  shouldNotifyStatus,
  statusNotificationBody,
} from "../shared/notify-policy.ts";
import { badRequest, jsonResponse, setRequestRoute } from "./http.ts";
import { isLoopbackHost } from "./access.ts";
import { writePrivateState } from "./private-state.ts";

/** A blocked agent is still blocked when the phone gets signal back; a newer push for the pane replaces it anyway. */
const PUSH_TTL_SECONDS = 12 * 60 * 60;
const PUSH_TIMEOUT_MS = 10_000;
const DEFAULT_SUBJECT = "https://github.com/devswha/ovis";
/** How many retired endpoints are remembered; the oldest is forgotten first. */
const RETIRED_LIMIT = 1000;
/** The key pairs, besides vapid.json's, that subscriptions taken over from another state dir were made for. */
export const PUSH_EXTRA_KEYS = "push-keys.json";

type VapidKeys = { publicKey: string; privateKey: string };
/** The delivery records are bounded the same way, and kept for as long since their last write. */
const DELIVERY_LIMIT = RETIRED_LIMIT;
const DELIVERY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How long an alert waits for the pane to change first, and the turn a finish is worth telling. */
export interface AlertTiming {
  /** a question, and a finish on a device that wants every one */
  short: number;
  /** a finish after a long turn */
  long: number;
  /** the least a turn works for its finish to be worth an alert (`done: "long"`) */
  longTurn: number;
}
export const DEFAULT_ALERT_TIMING: AlertTiming = { short: 10_000, long: 60_000, longTurn: 60_000 };

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** what this device wants alerts for; absent in a record from before there was a choice */
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
  /** last written: the oldest records are forgotten first */
  at: number;
}

/** An endpoint a push service retired (push-retired.json), keyed by its hash. */
interface RetiredMark {
  at: number;
  /** the device it was registered for, null for a local/token/Tailscale sign-in; absent for a legacy owner or an older file */
  owner?: string | null;
}

/** What the push service's answer means for the subscription (shared/protocol.ts PushDeliveryFailure). */
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
  /** `parseSubscription` with this service's endpoint rule: what POST /api/push/subscribe accepts */
  parse(value: unknown): PushSubscriptionRecord | null;
  /** `alerts` absent keeps what the device chose before (a re-registration on load) */
  subscribe(subscription: PushSubscriptionRecord, alerts?: AlertPrefs, deviceId?: string | null, browserKeys?: readonly string[]): void;
  revokeDevice(id: string): void;
  unsubscribe(endpoint: string): void;
  /** whether a push service answered 404/410 for this endpoint, in any spelling normalizeEndpoint takes as one */
  retired(endpoint: string): boolean;
  /** One confirmation push to one device, so enabling alerts proves the whole path works. */
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
  /** The collector's view of every pane: status baselines and the titles notifications use. */
  seed(panes: readonly HerdrPane[], machineId?: string, machineName?: string): void;
  /**
   * After status events were lost, `panes` (every pane on the PC) are the baseline for all
   * but the `newer` ones, which had an event since this snapshot was asked for. A pane
   * missing from it is gone: its waiting alert is called off. Nothing is announced: a
   * change that happened unseen is not news, and an alert it overtook is called off.
   */
  resync(panes: readonly HerdrPane[], newer: ReadonlySet<string>, machineId?: string): void;
  /** Schedules the alert this change is worth, and calls off the one it overtakes. */
  onStatus(paneId: string, status: AgentStatus, machineId?: string): Promise<void>;
  onEnded(paneId: string, machineId?: string): Promise<void>;
  /** The shared mute list changed: an alert waiting for a pane now muted is called off. */
  mutesChanged(): void;
  /** Resolves once every alert scheduled so far went out or was called off (tests wait). */
  settled(): Promise<void>;
}

export interface PushServiceOptions {
  stateDir: string;
  subject?: string;
  /** Current title of a pane, looked up when an alert fires; falls back to the last seeded one. */
  lookupTitle?: (paneId: string) => Promise<string | undefined>;
  timing?: Partial<AlertTiming>;
  now?: () => number;
  canDeliver?: (deviceId: string | null | undefined) => boolean;
  /** whether a window of the app is in use right now: then no alert goes to any device (the test push still does) */
  inUse?: () => boolean;
  /** whether the pane's alerts are off for everyone (shared/notify-policy.ts paneAlertsMuted on the shared preferences) */
  muted?: (machineId: string, paneId: string) => boolean;
  /** accept plain-http loopback endpoints: only for the tests' fake push service (push.fake.ts) */
  loopbackHttp?: boolean;
  /** a pane's alert reached one device (the push service took it); not the test push or a pairing notice */
  onAlertDelivered?: () => void;
}

export { defaultStateDir } from "./update-state.ts";

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

/** The PushSubscription JSON a browser produces, checked before anything is stored. */
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

export function statusMessage(paneId: string, title: string, status: AgentStatus): PushPayload {
  return { pane_id: paneId, title, body: statusNotificationBody(status), tag: paneNotificationTag(paneId) };
}

export function endedMessage(paneId: string, title: string): PushPayload {
  return { pane_id: paneId, title, body: ENDED_NOTIFICATION_BODY, tag: paneNotificationTag(paneId) };
}

/** An alert scheduled for a pane, from its scheduling until it went out or was called off. */
interface Scheduled {
  key: string;
  machineId: string;
  paneId: string;
  /** a mute called it off: set for good, so an unmute while its title is looked up sends nothing */
  silenced: boolean;
  /** stops the timers that have not fired yet */
  cancel: () => void;
}

export function createPushService(options: PushServiceOptions): PushService {
  const vapidPath = join(options.stateDir, "vapid.json");
  const subscriptionsPath = join(options.stateDir, "push-subscriptions.json");
  const subject = options.subject ?? process.env["OVIS_PUSH_SUBJECT"] ?? DEFAULT_SUBJECT;

  let vapid: { publicKey: string; privateKey: string } | null = null;
  let subscriptions: Map<string, PushSubscriptionRecord> | null = null;
  /** the file still lists a subscription dropped in memory only (a retirement whose write failed): the next goodbye writes it */
  let stale = false;
  const lastStatus = new Map<string, AgentStatus>();
  const titles = new Map<string, string>();
  // the workspace a pane was last seen in: an alert names it, so the tap of an ended pane can open
  // its workspace (src/lib/deepLink.ts resolveLink) once herdr has dropped the pane
  const workspaces = new Map<string, string>();
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
  /** by endpoint hash, least recently written first; loaded on first need */
  let deliveries: Map<string, DeliveryRecord> | null = null;

  /** Created on first need: a server nobody subscribes to never writes a key. */
  function keys(): { publicKey: string; privateKey: string } {
    if (vapid) return vapid;
    const stored = readJson(vapidPath) as { publicKey?: unknown; privateKey?: unknown } | undefined;
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
    const stored = readJson(subscriptionsPath);
    subscriptions = new Map();
    if (Array.isArray(stored)) {
      for (const entry of stored) {
        const parsed = parseSubscription(entry, options);
        // retired, but its removal could not be written (#2013): it stays gone, and the next goodbye writes the file without it
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

  /** Drops what has outlived its time to live: on every read and write, not only when the file is loaded. */
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

  /** Writes `next` and only then makes it the subscriptions in use, so a failed write changes nothing. */
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
      return deliveries; // an unreadable file only means a device is told nothing until the next push
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

  /** The identity a delivery is recorded for, taken before the push goes out. */
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
    const details = webpush.generateRequestDetails(subscription, JSON.stringify(message), {
      vapidDetails: { subject, publicKey, privateKey },
      TTL: PUSH_TTL_SECONDS,
      urgency,
      contentEncoding: "aes128gcm",
    });
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
      /* network failure or timeout: status stays null */
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
      // the list is telemetry: a write that fails keeps the mark in memory, and never keeps the dead subscription (#2013)
      rewriteRetired();
      const next = without((endpoint) => endpoint === subscription.endpoint);
      if (next) {
        try {
          persist(next);
        } catch (error) {
          // the push service said it is gone: nothing is sent to it again, and the next write that succeeds leaves it off disk
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

  /** Where an alert's pane is: its PC (absent for this one) and the workspace it was last seen in. */
  function where(key: string, machineId: string): Pick<PushPayload, "machine_id" | "workspace_id"> {
    const workspace = workspaces.get(key);
    return { ...(machineId === "local" ? {} : { machine_id: machineId }), ...(workspace ? { workspace_id: workspace } : {}) };
  }

  async function titleOf(paneId: string): Promise<string> {
    try {
      const fresh = await options.lookupTitle?.(paneId);
      if (fresh) return fresh;
    } catch {
      /* herdr busy: the seeded title is at most one reconcile old */
    }
    return titles.get(paneId) ?? paneId;
  }

  const timing = { ...DEFAULT_ALERT_TIMING, ...options.timing };
  const now = options.now ?? Date.now;
  /** when each pane's current turn began: from `working`/`blocked` entered, until idle or done */
  const turnStart = new Map<string, number>();
  /** the alert each pane is waiting to send, called off by the pane's next change (or its mute) */
  const waiting = new Map<string, Scheduled>();
  /**
   * every alert from its scheduling until it went out or was called off, with the pane it is for:
   * a mute calls one off even while its title is looked up, and an unmute after that brings it back nowhere
   */
  const unsent = new Set<Scheduled>();
  /** every alert not yet sent or called off, for `settled()` */
  const inFlight = new Set<Promise<void>>();

  function callOff(key: string): void {
    waiting.get(key)?.cancel();
    waiting.delete(key);
  }

  const muted = (machineId: string, paneId: string): boolean => options.muted?.(machineId, paneId) === true;

  /** How long a device waits before this alert reaches it, or null: it does not want it. */
  function delayFor(prefs: AlertPrefs, status: AgentStatus, worked: number | null): number | null {
    if (status === "blocked") return prefs.input ? timing.short : null;
    if (status !== "done" || prefs.done === "off") return null;
    if (prefs.done === "always") return timing.short;
    // a turn that began before this server knew the pane is of unknown length: tell it
    return worked === null || worked >= timing.longTurn ? timing.long : null;
  }

  /** One timer per delay, each for the devices that wait that long; all called off together. */
  function schedule(key: string, machineId: string, paneId: string, groups: Map<number, PushSubscriptionRecord[]>, send: (to: PushSubscriptionRecord[], silenced: () => boolean) => Promise<void>): void {
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
          if (remaining === 0 && waiting.get(key) === entry) waiting.delete(key);
          send(to, () => entry.silenced).catch((error: unknown) => {
            console.error(`web push failed: ${error instanceof Error ? error.message : String(error)}`);
          }).finally(resolve);
        }, delay);
        // a group already sending is past calling off: it settles when its delivery does
        cancels.push(() => { if (fired) return; clearTimeout(timer); resolve(); });
      });
      inFlight.add(done);
      void done.finally(() => {
        inFlight.delete(done);
        open -= 1;
        if (open === 0) unsent.delete(entry);
      });
    }
    const entry: Scheduled = { key, machineId, paneId, silenced: false, cancel: () => { for (const cancel of cancels) cancel(); } };
    waiting.set(key, entry);
    unsent.add(entry);
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

    seed(panes, machineId = "local", machineName) {
      for (const pane of panes) {
        // only fill gaps: an event already seen is newer than any snapshot
        const key = paneStorageId(machineId, pane.pane_id);
        titles.set(key, `${machineName ? machineName + " · " : ""}${paneTitle(pane)}`);
        workspaces.set(key, pane.workspace_id);
        if (!lastStatus.has(key)) lastStatus.set(key, pane.agent_status);
      }
    },

    resync(panes, newer, machineId = "local") {
      const busy = (value: AgentStatus | undefined): boolean => value === "working" || value === "blocked";
      const present = new Set(panes.map((pane) => paneStorageId(machineId, pane.pane_id)));
      const newerKeys = new Set([...newer].map((paneId) => paneStorageId(machineId, paneId)));
      const remotePrefix = `remote:${encodeURIComponent(machineId)}:`;
      const onThisPc = (key: string): boolean => machineId === "local" ? !key.startsWith("remote:") : key.startsWith(remotePrefix);
      for (const key of [...lastStatus.keys()]) {
        if (!onThisPc(key) || present.has(key) || newerKeys.has(key)) continue;
        // closed while events were lost: no alert may still speak for it
        callOff(key);
        turnStart.delete(key);
        lastStatus.delete(key);
      }
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
        // a turn that began unseen has no known start, like a first sighting mid-turn
        if (busy(status) !== busy(previous)) turnStart.delete(key);
      }
    },

    async onStatus(paneId, status, machineId = "local") {
      const key = paneStorageId(machineId, paneId);
      const previous = lastStatus.get(key);
      lastStatus.set(key, status);
      if (previous === status) return;
      // answered, working again, or seen: whatever was waiting is no longer news
      callOff(key);
      const busy = (value: AgentStatus | undefined): boolean => value === "working" || value === "blocked";
      // a first sighting mid-turn has no start: its length stays unknown
      if (busy(status) && previous !== undefined && !busy(previous)) turnStart.set(key, now());
      let worked: number | null = null;
      if (!busy(status)) {
        const start = turnStart.get(key);
        worked = start === undefined ? null : now() - start;
        turnStart.delete(key);
      }
      if (!shouldNotifyStatus(previous, status)) return;
      // muted for everyone: tracked above, told to nobody
      if (muted(machineId, paneId)) return;
      const groups = new Map<number, PushSubscriptionRecord[]>();
      for (const subscription of store().values()) {
        const delay = delayFor(subscription.alerts ?? DEFAULT_ALERTS, status, worked);
        if (delay !== null) groups.set(delay, [...(groups.get(delay) ?? []), subscription]);
      }
      if (groups.size === 0) return;
      schedule(key, machineId, paneId, groups, async (to, silenced) => {
        if (options.inUse?.() || muted(machineId, paneId)) return;
        const title = machineId === "local" ? await titleOf(paneId) : titles.get(key) ?? paneId;
        // the title can wait for herdr: a window that came into use, or a mute made (even one undone since), meanwhile still holds the alert
        if (options.inUse?.() || silenced() || muted(machineId, paneId)) return;
        // a device that dropped out meanwhile is not written to
        const live = to.flatMap((subscription) => {
          const current = store().get(subscription.endpoint);
          return current && current.device_id === subscription.device_id ? [current] : [];
        });
        await broadcast({ ...statusMessage(paneId, title, status), ...where(key, machineId), tag: paneNotificationTag(paneId, machineId) }, status === "blocked" ? "high" : "normal", live, true);
      });
    },

    async onEnded(paneId, machineId = "local") {
      const key = paneStorageId(machineId, paneId);
      callOff(key);
      turnStart.delete(key);
      if (muted(machineId, paneId)) return;
      // an ended terminal is a finish of its own: a device that wants none hears none
      const to = [...store().values()].filter((subscription) => (subscription.alerts ?? DEFAULT_ALERTS).done !== "off");
      if (to.length === 0 || options.inUse?.()) return;
      // the pane may already be gone from herdr: the seeded title is what is left
      await broadcast({ ...endedMessage(paneId, titles.get(key) ?? paneId), ...where(key, machineId), tag: paneNotificationTag(paneId, machineId) }, "normal", to);
    },

    mutesChanged() {
      // an unmute resurrects nothing: what was called off while muted stays called off, including
      // an alert whose timer has fired and whose title is still being looked up
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
