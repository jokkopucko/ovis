import type { AlertPrefs } from "../../shared/notify-policy.ts";
import { ApiError, fetchPushKey, registerPushSubscription, sendTestPush, unregisterPushSubscription } from "./api.ts";
import { callNative, hasNativePlugin, PUSH_PLUGIN } from "./nativeApp.ts";
import { notificationState } from "./notifications.ts";

/**
 * This device's web push subscription: pane alerts that arrive with the app closed.
 *
 * A browser needs a service worker and PushManager, which exist only in secure contexts (https or
 * localhost) - and on iPhone only in the app added to the home screen. The phone app's web view
 * has neither: there the app's push plugin (lib/nativeApp.ts) makes the subscription. Its endpoint
 * is on the push relay (push-relay/) and only the app holds its keys; it has the shape a browser
 * hands over, so the server takes it as one more browser's. Everywhere else pushSupported() is
 * false and the bell keeps tab-only alerts (lib/notifications.ts).
 */

/** How long to wait for the service worker before giving up on push for this page load. */
const WORKER_READY_TIMEOUT_MS = 10_000;

/** A subscription the app made for this PC: a browser's PushSubscriptionJSON, its endpoint on the push relay. */
interface AppSubscription {
  endpoint: string;
  expirationTime: null;
  keys: { p256dh: string; auth: string };
}

const appPush = (): boolean => hasNativePlugin(PUSH_PLUGIN);

/** This PC's subscription in the app, without making one. */
async function appSubscription(): Promise<AppSubscription | null> {
  return (await callNative<{ subscription: AppSubscription | null }>(PUSH_PLUGIN, "getSubscription")).subscription;
}

/**
 * The desktop app (Electron, app/electron) offers a PushManager with no push service behind it: its
 * subscribe always fails. Its window stays loaded in the tray, so the page's own notifications carry
 * its alerts, as on a browser without push.
 */
const desktopApp = (): boolean => typeof navigator !== "undefined" && /\bElectron\//.test(navigator.userAgent);

export function pushSupported(): boolean {
  return appPush() || (typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof globalThis.PushManager !== "undefined" && !desktopApp());
}

/** Test the existing subscription without repairing it first, so stale registrations stay visible. */
export async function testDevicePush(tested?: (endpoint: string) => void): Promise<"sent" | "unsupported" | "permission" | "missing"> {
  if (!pushSupported()) return "unsupported";
  if (notificationState() !== "granted") return "permission";
  const subscription = appPush() ? await appSubscription() : await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
  if (!subscription) return "missing";
  // the subscription the test is about, whatever replaces it while the push is out (lib/pushHealth.ts)
  tested?.(subscription.endpoint);
  await sendTestPush(subscription.endpoint);
  return "sent";
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function sameKey(current: ArrayBuffer | null, expected: Uint8Array): boolean {
  if (!current || current.byteLength !== expected.length) return false;
  const bytes = new Uint8Array(current);
  return bytes.every((byte, index) => byte === expected[index]);
}

/** Whether a subscription made for `key` was made for the server's; null where that is not known. */
export function sameServerKey(key: ArrayBuffer | null, serverKey: string): boolean | null {
  return key ? sameKey(key, keyBytes(serverKey)) : null;
}

/**
 * This device's subscription as it stands, read without changing it (lib/pushHealth.ts), with the
 * key it was made for: null when it holds none, undefined while there is nothing to ask (no
 * service worker registered yet). The app makes its subscription for the key it is handed each
 * time and says no key back, so its key is null.
 */
export async function heldPushSubscription(): Promise<{ json: PushSubscriptionJSON; key: ArrayBuffer | null } | null | undefined> {
  if (appPush()) {
    const subscription = await appSubscription();
    return subscription && { json: subscription, key: null };
  }
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return undefined;
  const subscription = await registration.pushManager.getSubscription();
  return subscription && { json: subscription.toJSON(), key: subscription.options.applicationServerKey };
}

/** navigator.serviceWorker.ready never settles when registration failed; bound it. */
async function workerRegistration(): Promise<ServiceWorkerRegistration | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), WORKER_READY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The subscription being made right now, shared by every caller that arrives meanwhile. */
let pending: Promise<string | null> | null = null;
// Preserve click order across registration/removal, even when a prior operation fails.
let operations: Promise<unknown> = Promise.resolve();

/** Moves on with every registration or removal begun: a look at the subscription started before one reads a subscription it may replace (lib/pushHealth.ts). */
let epoch = 0;

export function pushSubscriptionEpoch(): number {
  return epoch;
}

/** The endpoint this page's latest registration ended with, null after a failed one or a removal: what a repair proved (lib/pushHealth.ts). */
let registered: string | null = null;

export function registeredPushEndpoint(): string | null {
  return registered;
}

/** Settles with the registration or removal under way, if any: a look at the subscription waits for it (lib/pushHealth.ts). */
export function currentPushOperation(): Promise<void> {
  return operations.then(() => undefined, () => undefined);
}

/**
 * Subscribes this device (reusing a live subscription) and registers it with the server.
 * Idempotent, so it also runs on every load: a server that lost its state gets the device
 * back without a click. Resolves the endpoint, or null when push is not available here.
 *
 * Single-flight: the bell's first tap grants permission, which also starts App's
 * load-time registration. Two overlapping `subscribe()` calls make Chrome issue TWO
 * subscriptions and keep only the later one, so the confirmation push could go to a
 * dead endpoint. Concurrent callers therefore share one attempt.
 */
export function ensurePushSubscription(alerts?: AlertPrefs): Promise<string | null> {
  if (pending) return pending;
  epoch += 1;
  const request = operations.catch(() => undefined).then(() => {
    // read once this registration's turn comes: the recovery queued before it has finished by then
    const handedOver = recovered;
    recovered = null;
    return subscribeDevice(alerts, handedOver);
  }).then((endpoint) => {
    registered = endpoint;
    return endpoint;
  }, (error: unknown) => {
    registered = null;
    throw error;
  }).finally(() => {
    if (pending === request) pending = null;
  });
  pending = request;
  operations = request;
  return request;
}

async function subscribeDevice(alerts?: AlertPrefs, handedOver: Recovered | null = null): Promise<string | null> {
  if (!pushSupported() || notificationState() !== "granted") return null;
  if (appPush()) return subscribeApp(alerts);
  const registration = await workerRegistration();
  if (!registration) return null;
  const key = keyBytes(await fetchPushKey());
  let subscription = await registration.pushManager.getSubscription();
  // made for another server key (the server's state dir was reset): it can never receive our pushes
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  // the start's recovery (registerPendingPush) handed the PC this very endpoint with these alerts just before
  if (handedOver !== null && handedOver.endpoint === subscription.endpoint && handedOver.alerts === alertsKey(alerts)) return subscription.endpoint;
  try {
    await registerPushSubscription(subscription.toJSON(), alerts);
  } catch (error) {
    // its push service retired this endpoint (#1038); an older server never says so and keeps today's path
    if (!(error instanceof ApiError && error.code === "subscription_gone")) throw error;
    const retired = subscription.endpoint;
    await subscription.unsubscribe();
    // a browser still handing over the retired endpoint cannot be repaired from here
    if ((await registration.pushManager.getSubscription())?.endpoint === retired) throw error;
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await registerPushSubscription(subscription.toJSON(), alerts);
  }
  return subscription.endpoint;
}

/**
 * The app's subscription for this PC. The app keeps the relay endpoint it made for this PC's key
 * and hands it over again, so registering on every load costs the relay nothing.
 */
async function subscribeApp(alerts?: AlertPrefs): Promise<string> {
  const applicationServerKey = await fetchPushKey();
  const subscribe = async () => (await callNative<{ subscription: AppSubscription }>(PUSH_PLUGIN, "subscribe", { applicationServerKey })).subscription;
  let subscription = await subscribe();
  try {
    await registerPushSubscription(subscription, alerts);
  } catch (error) {
    // the relay dropped the endpoint the app kept (unused for 60 days, or the phone's token is
    // gone) and the PC remembers it as retired: the app forgets it and registers a new one
    if (!(error instanceof ApiError && error.code === "subscription_gone")) throw error;
    await callNative(PUSH_PLUGIN, "unsubscribe");
    subscription = await subscribe();
    await registerPushSubscription(subscription, alerts);
  }
  return subscription.endpoint;
}

/**
 * A subscription the browser rotated while no window of this PC's app could tell the PC: the hosted
 * shell's worker (public/sw.js pushsubscriptionchange) keeps it in IndexedDB `ovis-relay/pending-push`,
 * one per PC, and the shell registers it once it is connected again (lib/relay/shell.tsx).
 */
export interface PendingPush {
  readonly server_id: string;
  readonly subscription: PushSubscriptionJSON;
  /** the endpoint the PC last knew, to drop; null when the browser did not say */
  readonly old_endpoint: string | null;
}

export interface PendingPushStore {
  get(serverId: string): Promise<PendingPush | undefined>;
  /** Drops the PC's pending subscription only while it is still `endpoint`: one the worker kept meanwhile waits for the next run. */
  clear(serverId: string, endpoint: string): Promise<void>;
}

/** A registration the start's recovery made, which the load-time registration queued after it does not repeat. */
interface Recovered {
  endpoint: string;
  alerts: string;
}

let recovered: Recovered | null = null;

const alertsKey = (alerts: AlertPrefs | undefined): string => JSON.stringify(alerts ?? null);

/**
 * Hands the PC the subscription its worker kept while no window could, over whatever transport is set
 * (the relay in the hosted shell), with this device's `alerts`, then forgets it: registered once. The
 * shell runs it before the app's own load-time registration (ensurePushSubscription), which then skips
 * that endpoint once when its alerts are the same, so one start registers it once. A PC that could not
 * be reached keeps it for the next start; a PC that answered with a refusal has had its say, and the
 * load-time registration takes it from there. Resolves whether one was registered.
 */
export function registerPendingPush(serverId: string, store: PendingPushStore, alerts?: AlertPrefs): Promise<boolean> {
  epoch += 1;
  const request = operations.catch(() => undefined).then(async () => {
    const held = await store.get(serverId);
    const endpoint = held?.subscription.endpoint;
    if (held === undefined || endpoint === undefined) return false;
    try {
      await registerPushSubscription(held.subscription, alerts);
      if (held.old_endpoint !== null && held.old_endpoint !== endpoint) await unregisterPushSubscription(held.old_endpoint);
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) await store.clear(serverId, endpoint);
      throw error;
    }
    await store.clear(serverId, endpoint);
    recovered = { endpoint, alerts: alertsKey(alerts) };
    return true;
  });
  operations = request;
  return request;
}

/** Stops pushes to this device: the server forgets it first, then the browser (or the app) drops it. */
export function removePushSubscription(): Promise<void> {
  // A later enable must enqueue a new registration after this removal, not join the old one.
  pending = null;
  epoch += 1;
  registered = null;
  recovered = null;
  const request = operations.catch(() => undefined).then(unsubscribeDevice);
  operations = request;
  return request;
}

async function unsubscribeDevice(): Promise<void> {
  if (appPush()) {
    // Removal needs the kept endpoint even when the phone's decryption keys are damaged.
    const { subscription } = await callNative<{ readonly subscription: Pick<AppSubscription, "endpoint"> | null }>(
      PUSH_PLUGIN, "getSubscription", { endpointOnly: true },
    );
    if (!subscription) return;
    // the app forgets its endpoint only once the PC has: unlike a browser's, an endpoint the app
    // drops stays live at the relay, so the phone would go on getting this PC's alerts with nothing
    // left here to remove them by. A removal the PC did not take is tried again (lib/useNotifications.ts).
    await unregisterPushSubscription(subscription.endpoint);
    await callNative(PUSH_PLUGIN, "unsubscribe");
    return;
  }
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  try {
    await unregisterPushSubscription(subscription.endpoint);
  } finally {
    await subscription.unsubscribe();
  }
}
