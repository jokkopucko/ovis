import type { AlertPrefs } from "../../shared/notify-policy.ts";
import { ApiError, fetchPushKey, registerPushSubscription, sendTestPush, unregisterPushSubscription } from "./api.ts";
import { callNative, hasNativePlugin, PUSH_PLUGIN } from "./nativeApp.ts";
import { notificationState } from "./notifications.ts";
import { recordConfirmation, recordTestFailure } from "./pushConfirm.ts";

/**
 * A browser needs a service worker and PushManager, which exist only in secure contexts (https or
 * localhost) - and on iPhone only in the app added to the home screen. The phone app's web view
 * has neither: there the app's push plugin (lib/nativeApp.ts) makes the subscription. Its endpoint
 * is on the push relay (push-relay/) and only the app holds its keys; it has the shape a browser
 * hands over, so the server takes it as one more browser's.
 */

const WORKER_READY_TIMEOUT_MS = 10_000;

interface AppSubscription {
  endpoint: string;
  expirationTime: null;
  keys: { p256dh: string; auth: string };
}

const appPush = (): boolean => hasNativePlugin(PUSH_PLUGIN);

async function appSubscription(): Promise<AppSubscription | null> {
  return (await callNative<{ subscription: AppSubscription | null }>(PUSH_PLUGIN, "getSubscription")).subscription;
}

/**
 * The desktop app (Electron, app/electron) offers a PushManager with no push service behind it: its
 * subscribe always fails.
 */
const desktopApp = (): boolean => typeof navigator !== "undefined" && /\bElectron\//.test(navigator.userAgent);

export function pushSupported(): boolean {
  return appPush() || (typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof globalThis.PushManager !== "undefined" && !desktopApp());
}

export async function testDevicePush(tested?: (endpoint: string) => void): Promise<"sent" | "unsupported" | "permission" | "missing"> {
  if (!pushSupported()) return "unsupported";
  if (notificationState() !== "granted") return "permission";
  const subscription = appPush() ? await appSubscription() : await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
  if (!subscription) return "missing";
  tested?.(subscription.endpoint);
  try {
    await sendTestPush(subscription.endpoint);
  } catch (error) {
    recordTestFailure(subscription.endpoint, error);
    throw error;
  }
  recordConfirmation(subscription.endpoint, true);
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

export function sameServerKey(key: ArrayBuffer | null, serverKey: string): boolean | null {
  return key ? sameKey(key, keyBytes(serverKey)) : null;
}

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

let pending: Promise<string | null> | null = null;
let operations: Promise<unknown> = Promise.resolve();

let epoch = 0;

export function pushSubscriptionEpoch(): number {
  return epoch;
}

let registered: string | null = null;

export function registeredPushEndpoint(): string | null {
  return registered;
}

export function currentPushOperation(): Promise<void> {
  return operations.then(() => undefined, () => undefined);
}

/**
 * Two overlapping `subscribe()` calls make Chrome issue TWO subscriptions and keep only the later one, so the
 * confirmation push could go to a dead endpoint.
 */
export function ensurePushSubscription(alerts?: AlertPrefs): Promise<string | null> {
  if (pending) return pending;
  epoch += 1;
  const request = operations.catch(() => undefined).then(() => {
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
  if (handedOver !== null && handedOver.endpoint === subscription.endpoint && handedOver.alerts === alertsKey(alerts)) return subscription.endpoint;
  try {
    await registerPushSubscription(subscription.toJSON(), alerts);
  } catch (error) {
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

export interface PendingPush {
  readonly server_id: string;
  readonly subscription: PushSubscriptionJSON;
  readonly old_endpoint: string | null;
}

export interface PendingPushStore {
  get(serverId: string): Promise<PendingPush | undefined>;
  clear(serverId: string, endpoint: string): Promise<void>;
}

interface Recovered {
  endpoint: string;
  alerts: string;
}

let recovered: Recovered | null = null;

const alertsKey = (alerts: AlertPrefs | undefined): string => JSON.stringify(alerts ?? null);

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

export function removePushSubscription(): Promise<void> {
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
