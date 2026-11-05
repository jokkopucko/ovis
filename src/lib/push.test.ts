import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, useLayoutEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { DEFAULT_ALERTS } from "../../shared/notify-policy.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePushSubscription, pushSupported, registerPendingPush, removePushSubscription, testDevicePush } from "./push.ts";
import { ApiError } from "./api.ts";
import { notificationState, refreshNotificationState, requestNotificationPermission } from "./notifications.ts";
import { useNotificationSwitch } from "./useNotifications.ts";
import { fakeIndexedDB } from "./indexedDB.fake.ts";
import type { FakeIndexedDB } from "./indexedDB.fake.ts";
import { indexedDeviceStore, indexedPendingPush } from "./relay/device.ts";

/**
 * The device-side subscription flow against a stand-in browser whose PushManager, like
 * real Chrome (observed through FCM in .omo/evidence/push-qa/real-fcm.ts), issues a NEW
 * subscription on every subscribe() call and keeps only the latest one.
 */

const SERVER_KEY = Buffer.from(new Uint8Array(65).fill(4)).toString("base64url");
const OTHER_KEY = new Uint8Array(65).fill(7).buffer;

interface StandInSubscription {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer };
  unsubscribed: boolean;
  unsubscribe(): Promise<boolean>;
  toJSON(): { endpoint: string; keys: { p256dh: string; auth: string } };
}

let live: StandInSubscription | null;
let issued: number;
let registered: string[];
/** endpoints the server answers `subscription_gone` for: their push service retired them */
let retired: Set<string>;
const saved = {
  fetch: globalThis.fetch,
  PushManager: (globalThis as { PushManager?: unknown }).PushManager,
  Notification: (globalThis as { Notification?: unknown }).Notification,
};

function standIn(endpoint: string, key: ArrayBuffer): StandInSubscription {
  return {
    endpoint,
    options: { applicationServerKey: key },
    unsubscribed: false,
    async unsubscribe() {
      this.unsubscribed = true;
      if (live === this) live = null;
      return true;
    },
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
  };
}

beforeEach(() => {
  live = null;
  issued = 0;
  registered = [];
  retired = new Set();
  const pushManager = {
    getSubscription: async () => live,
    subscribe: async (options: { applicationServerKey: Uint8Array }) => {
      issued += 1;
      const key = options.applicationServerKey;
      live = standIn(`https://push.example/${issued}`, key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer);
      return live;
    },
  };
  Object.defineProperty(globalThis.navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager }), getRegistration: async () => ({ pushManager }) },
  });
  Object.assign(globalThis, { PushManager: class {}, Notification: { permission: "granted" } });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === "/api/push") return Response.json({ public_key: SERVER_KEY });
    if (url === "/api/push/subscribe" && init?.method === "POST") {
      const endpoint = (JSON.parse(String(init.body)) as { subscription: { endpoint: string } }).subscription.endpoint;
      if (retired.has(endpoint)) return Response.json({ error: { code: "subscription_gone", message: "retired" } }, { status: 410 });
      registered.push(endpoint);
      return new Response(null, { status: 204 });
    }
    if (url === "/api/push/subscribe" && init?.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  delete (globalThis.navigator as { serviceWorker?: unknown }).serviceWorker;
  Object.assign(globalThis, { PushManager: saved.PushManager, Notification: saved.Notification, fetch: saved.fetch });
});

describe("ensurePushSubscription", () => {
  it("gives overlapping callers one subscription, not two where only the later survives", async () => {
    // the bell's first tap: its own call plus the load-time registration the grant starts
    const [fromClick, fromEffect] = await Promise.all([ensurePushSubscription(), ensurePushSubscription()]);
    expect(issued).toBe(1);
    expect(fromClick).toBe(fromEffect);
    expect(fromClick).toBe(live!.endpoint);
    expect(registered).toEqual([live!.endpoint]);
  });

  it("reuses the live subscription on a later load and registers it again", async () => {
    const first = await ensurePushSubscription();
    const again = await ensurePushSubscription();
    expect(issued).toBe(1);
    expect(again).toBe(first);
    expect(registered).toEqual([first!, first!]);
  });

  it("replaces a subscription made for another server key", async () => {
    const stale = standIn("https://push.example/stale", OTHER_KEY);
    live = stale;
    const endpoint = await ensurePushSubscription();
    expect(stale.unsubscribed).toBe(true);
    expect(endpoint).toBe("https://push.example/1");
    expect(registered).toEqual(["https://push.example/1"]);
  });

  // regression (fails on main): "Turn alerts on again" must not hand the server the retired endpoint again (#1038)
  it("drops a subscription the server says its push service retired and registers a fresh one", async () => {
    const first = await ensurePushSubscription();
    const old = live!;
    retired.add(first!);
    const repaired = await ensurePushSubscription();
    expect(old.unsubscribed).toBe(true);
    expect(issued).toBe(2);
    expect(repaired).toBe("https://push.example/2");
    expect(registered).toEqual([first!, "https://push.example/2"]);
  });

  // control: a browser that keeps returning the retired endpoint is not registered again
  it("gives up when the browser still holds the retired endpoint after unsubscribing", async () => {
    await ensurePushSubscription();
    const stuck = live!;
    stuck.unsubscribe = async () => true; // the browser says yes and keeps it
    retired.add(stuck.endpoint);
    await expect(ensurePushSubscription()).rejects.toMatchObject({ code: "subscription_gone" });
    expect(issued).toBe(1);
  });

  it("does nothing until notifications are allowed", async () => {
    Object.assign(globalThis, { Notification: { permission: "default" } });
    expect(await ensurePushSubscription()).toBeNull();
    expect(issued).toBe(0);
    expect(registered).toEqual([]);
  });
});

describe("testDevicePush", () => {
  it("tests only this browser's current endpoint without registering it again", async () => {
    live = standIn("https://push.example/existing", OTHER_KEY);
    const calls: Array<[string, RequestInit | undefined]> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const tested: string[] = [];
    expect(await testDevicePush((endpoint) => { tested.push(endpoint); })).toBe("sent");
    // the endpoint the test went to is named, for the line it leaves in Settings (lib/pushHealth.ts)
    expect(tested).toEqual(["https://push.example/existing"]);
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toBe("/api/push/test");
    expect(calls[0]![1]?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]![1]?.body))).toEqual({ endpoint: live.endpoint });
    expect(issued).toBe(0);
    expect(registered).toEqual([]);
  });

  it("reports a missing browser subscription without creating a replacement", async () => {
    expect(await testDevicePush()).toBe("missing");
    expect(issued).toBe(0);
    expect(registered).toEqual([]);
  });

  it.each([[404, "subscription_not_found"], [502, "push_failed"]] as const)("preserves the server's %s %s result", async (status, code) => {
    live = standIn("https://push.example/stale", OTHER_KEY);
    globalThis.fetch = (async (_url: string) => Response.json({ error: { code, message: code } }, { status })) as typeof fetch;
    try {
      await testDevicePush();
      throw new Error("expected the test to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe(code);
    }
    expect(issued).toBe(0);
  });

  it("does not ask for permission or send a push after permission is revoked", async () => {
    Object.assign(globalThis, { Notification: { permission: "denied" } });
    expect(await testDevicePush()).toBe("permission");
    expect(issued).toBe(0);
  });

  it("handles a browser without push support", async () => {
    delete (globalThis.navigator as { serviceWorker?: unknown }).serviceWorker;
    expect(await testDevicePush()).toBe("unsupported");
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

it("removes a registration still in flight when the bell is turned off", async () => {
  const entered = deferred(), release = deferred();
  const fetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    if (args[0] === "/api/push") { entered.resolve(); await release.promise; }
    return fetch(...args);
  }) as typeof fetch;
  const enable = ensurePushSubscription();
  await entered.promise;
  const disable = removePushSubscription();
  release.resolve();
  await Promise.all([enable, disable]);
  expect(registered).toEqual(["https://push.example/1"]);
  expect(live).toBeNull();
});

it("still cleans up the browser subscription when registration fails", async () => {
  const entered = deferred(), release = deferred();
  const fetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    if (args[0] === "/api/push/subscribe" && args[1]?.method === "POST") {
      entered.resolve(); await release.promise; return new Response(null, { status: 503 });
    }
    return fetch(...args);
  }) as typeof fetch;
  const enable = ensurePushSubscription().catch(() => null);
  await entered.promise;
  const subscription = live!;
  const disable = removePushSubscription();
  release.resolve();
  await Promise.all([enable, disable]);
  expect(subscription.unsubscribed).toBe(true);
  expect(live).toBeNull();
});

describe("in the phone app", () => {
  /**
   * The app's OvisPush plugin as app/ios and app/android answer: one relay endpoint per PC, kept
   * until unsubscribe, with the phone's keys. The page has no service worker and no Notification.
   */
  const KEYS = { p256dh: Buffer.from(new Uint8Array(65).fill(9)).toString("base64url"), auth: Buffer.from(new Uint8Array(16).fill(3)).toString("base64url") };
  /** `checkGate`: holds a check's answer, which keeps the permission it read when it was asked */
  let app: { permission: string; answer: string; saved: string | null; made: number; calls: string[]; checkGate: Promise<void> | null };
  let sent: Array<{ url: string; method: string | undefined; body: unknown }>;
  const subscription = (endpoint: string) => ({ endpoint, expirationTime: null, keys: KEYS });

  function standInApp(plugins: string[]) {
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      PluginHeaders: plugins.map((name) => ({ name })),
      nativePromise: async (plugin: string, method: string, options: Record<string, unknown>) => {
        app.calls.push(`${plugin}.${method}`);
        if (method === "checkPermissions") {
          const reading = app.permission;
          if (app.checkGate) await app.checkGate;
          return { notifications: reading };
        }
        if (method === "requestPermissions") {
          if (app.permission.startsWith("prompt")) app.permission = app.answer;
          return { notifications: app.permission };
        }
        if (method === "subscribe") {
          expect(options).toEqual({ applicationServerKey: SERVER_KEY });
          app.saved ??= `https://push.ovis.sh/v1/push/${++app.made}`;
          return { subscription: subscription(app.saved) };
        }
        if (method === "getSubscription") return { subscription: app.saved === null ? null : subscription(app.saved) };
        if (method === "unsubscribe") app.saved = null;
        return undefined;
      },
    };
  }

  beforeEach(async () => {
    delete (globalThis.navigator as { serviceWorker?: unknown }).serviceWorker;
    Object.assign(globalThis, { PushManager: undefined, Notification: undefined });
    app = { permission: "granted", answer: "granted", saved: null, made: 0, calls: [], checkGate: null };
    sent = [];
    const server = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url !== "/api/push") sent.push({ url, method: init?.method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return url === "/api/push/test" ? new Response(null, { status: 204 }) : server(url, init);
    }) as typeof fetch;
    standInApp(["HerdrShell", "OvisPush"]);
    await refreshNotificationState();
  });

  afterEach(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
  });

  it("asks the app whether it may notify, as the page has no Notification", async () => {
    for (const [answer, state] of [["granted", "granted"], ["denied", "denied"], ["prompt", "default"], ["prompt-with-rationale", "default"]] as const) {
      app.permission = answer;
      expect(await refreshNotificationState()).toBe(state);
      expect(notificationState()).toBe(state);
    }
    expect(await requestNotificationPermission()).toBe("granted");
    expect(notificationState()).toBe("granted");
    expect(app.calls.filter((call) => call === "OvisPush.requestPermissions")).toHaveLength(1);
  });

  // the page came back into view as the user tapped Alerts: its check read the permission before
  // the user answered the prompt, and its answer arrives after the tap's
  it("keeps the permission the user just gave when an older check answers after it, and subscribes", async () => {
    app.permission = "prompt";
    await refreshNotificationState();
    const held = deferred();
    app.checkGate = held.promise;
    const late = refreshNotificationState();
    app.checkGate = null;
    expect(await requestNotificationPermission()).toBe("granted");
    held.resolve();
    expect(await late).toBe("granted");
    expect(notificationState()).toBe("granted");
    expect(await ensurePushSubscription()).toBe("https://push.ovis.sh/v1/push/1");
    expect(app.calls).toContain("OvisPush.subscribe");
    expect(registered).toEqual(["https://push.ovis.sh/v1/push/1"]);
    // a check asked after the answer still counts: notifications turned off in the phone's Settings
    app.permission = "denied";
    expect(await refreshNotificationState()).toBe("denied");
  });

  it("subscribes through the app with the PC's key and hands the PC the app's subscription", async () => {
    expect(pushSupported()).toBe(true);
    const endpoint = await ensurePushSubscription({ input: true, done: "long" });
    expect(endpoint).toBe("https://push.ovis.sh/v1/push/1");
    expect(sent).toEqual([{ url: "/api/push/subscribe", method: "POST", body: { subscription: subscription(endpoint!), alerts: { input: true, done: "long" } } }]);
    // a later load hands over the endpoint the app kept: the relay registers nothing new
    expect(await ensurePushSubscription()).toBe(endpoint);
    expect(app.made).toBe(1);
    expect(registered).toEqual([endpoint!, endpoint!]);
  });

  it("does not subscribe until the app may notify", async () => {
    app.permission = "denied";
    await refreshNotificationState();
    expect(await ensurePushSubscription()).toBeNull();
    expect(app.calls).not.toContain("OvisPush.subscribe");
    expect(sent).toEqual([]);
  });

  it("has the app make a new relay endpoint when the PC says the kept one is retired", async () => {
    const first = await ensurePushSubscription();
    retired.add(first!);
    app.calls = [];
    const repaired = await ensurePushSubscription();
    expect(repaired).toBe("https://push.ovis.sh/v1/push/2");
    expect(app.calls).toEqual(["OvisPush.subscribe", "OvisPush.unsubscribe", "OvisPush.subscribe"]);
    expect(registered).toEqual([first!, repaired!]);
  });

  it("has the PC forget the subscription first, then the app, when alerts are turned off", async () => {
    const endpoint = await ensurePushSubscription();
    sent = [];
    await removePushSubscription();
    expect(sent).toEqual([{ url: "/api/push/subscribe", method: "DELETE", body: { endpoint } }]);
    expect(app.saved).toBeNull();
    // nothing left to remove: neither the PC nor the app is asked again
    app.calls = [];
    await removePushSubscription();
    expect(app.calls).toEqual(["OvisPush.getSubscription"]);
  });

  /**
   * The PC refuses to forget a subscription until `answer` lets it (the PC is unreachable meanwhile).
   * `nextRefusal`, asked before what triggers it, settles when the next removal is refused.
   */
  function pcRefusesRemoval() {
    const server = globalThis.fetch;
    let refusal = deferred();
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url !== "/api/push/subscribe" || init?.method !== "DELETE") return server(url, init);
      refusal.resolve();
      return new Response(null, { status: 503 });
    }) as typeof fetch;
    return {
      nextRefusal: () => { refusal = deferred(); return refusal.promise; },
      answer: () => { globalThis.fetch = server; },
    };
  }

  // the relay keeps an endpoint the app forgot live: the phone would get this PC's alerts with alerts
  // off, and nothing left in the app to remove them by
  it("keeps the app's endpoint when the PC could not forget it, so the next removal still reaches the PC", async () => {
    const endpoint = await ensurePushSubscription();
    sent = [];
    const pc = pcRefusesRemoval();
    await expect(removePushSubscription()).rejects.toBeInstanceOf(ApiError);
    expect(app.saved).toBe(endpoint);
    expect(app.calls).not.toContain("OvisPush.unsubscribe");
    pc.answer();
    await removePushSubscription();
    expect(sent).toEqual([{ url: "/api/push/subscribe", method: "DELETE", body: { endpoint } }]);
    expect(app.saved).toBeNull();
  });

  it("tries a removal the PC did not take again at load and when the app comes back into view", async () => {
    const endpoint = await ensurePushSubscription();
    const pc = pcRefusesRemoval();
    await expect(removePushSubscription()).rejects.toBeInstanceOf(ApiError);
    sent = [];
    function Page({ alertsOn }: { alertsOn: boolean }) {
      useNotificationSwitch({ updateSettings: () => {}, locked: false, notifications: "granted", setNotifications: () => {}, alerts: DEFAULT_ALERTS,
        alertsRef: { current: DEFAULT_ALERTS }, alertsOn, setPushOn: () => {} });
      return null;
    }
    // the app forgets the endpoint last, once the PC has: that is a retry's removal done
    const forgotten = deferred();
    const capacitor = (globalThis as unknown as { Capacitor: { nativePromise: (plugin: string, method: string, options?: Record<string, unknown>) => Promise<unknown> } }).Capacitor;
    const native = capacitor.nativePromise;
    capacitor.nativePromise = async (plugin, method, options) => {
      const answer = await native(plugin, method, options);
      if (method === "unsubscribe") forgotten.resolve();
      return answer;
    };
    const view = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const saved = (name: string) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const;
    const restore = [saved("document"), saved("IS_REACT_ACT_ENVIRONMENT")];
    Object.defineProperty(globalThis, "document", { configurable: true, value: view });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    let page: ReactTestRenderer | null = null;
    try {
      // the PC is still out of reach as the app loads: that try is refused too, and the endpoint stays
      const refusedAtLoad = pc.nextRefusal();
      await act(async () => { page = create(createElement(Page, { alertsOn: false })); });
      await refusedAtLoad;
      expect(app.saved).toBe(endpoint);
      // the PC answers again, and the app comes back into view (one of the alerts opened it)
      pc.answer();
      view.dispatchEvent(new Event("visibilitychange"));
      await forgotten.promise;
      expect(sent).toEqual([{ url: "/api/push/subscribe", method: "DELETE", body: { endpoint } }]);
      expect(app.saved).toBeNull();
    } finally {
      await act(async () => { page?.unmount(); });
      for (const [name, descriptor] of restore) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      }
    }
  });

  it("preserves push when visibility changes during the alerts reenable commit", async () => {
    // Given: an off device whose removal could not reach the PC.
    const endpoint = await ensurePushSubscription();
    const pc = pcRefusesRemoval();
    await expect(removePushSubscription()).rejects.toBeInstanceOf(ApiError);
    const view = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const restore = ["document", "IS_REACT_ACT_ENVIRONMENT"].map((name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    Object.defineProperty(globalThis, "document", { configurable: true, value: view });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    const registeredAgain = deferred();
    function Page({ alertsOn }: { readonly alertsOn: boolean }) {
      useNotificationSwitch({ updateSettings: () => {}, locked: false, notifications: "granted",
        setNotifications: () => {}, alerts: DEFAULT_ALERTS, alertsRef: { current: DEFAULT_ALERTS },
        alertsOn, setPushOn: () => {} });
      useLayoutEffect(() => {
        if (alertsOn) view.dispatchEvent(new Event("visibilitychange"));
      }, [alertsOn]);
      return null;
    }
    let page: ReactTestRenderer | null = null;
    try {
      const refusedAtLoad = pc.nextRefusal();
      await act(async () => { page = create(createElement(Page, { alertsOn: false })); });
      await refusedAtLoad;
      pc.answer();
      const server = globalThis.fetch;
      globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
        const response = await server(...args);
        if (args[0] === "/api/push/subscribe" && args[1]?.method === "POST") registeredAgain.resolve();
        return response;
      }, { preconnect: server.preconnect });
      sent = [];
      // When: visibility changes after reenable renders but before the old effect cleans up.
      await act(async () => { page?.update(createElement(Page, { alertsOn: true })); });
      await registeredAgain.promise;
      // Then: re-registration reuses the endpoint without removing it first.
      expect(sent.filter(({ method }) => method === "DELETE")).toEqual([]);
      expect(app.saved).toBe(endpoint);
    } finally {
      await act(async () => { page?.unmount(); });
      for (const [name, descriptor] of restore) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  it("tests the app's kept subscription without making one", async () => {
    expect(await testDevicePush()).toBe("missing");
    expect(app.calls).not.toContain("OvisPush.subscribe");
    const endpoint = await ensurePushSubscription();
    sent = [];
    expect(await testDevicePush()).toBe("sent");
    expect(sent).toEqual([{ url: "/api/push/test", method: "POST", body: { endpoint } }]);
  });

  // an app from before its push plugin: on iOS a call to a missing plugin would never settle
  it("never calls an app that has no push plugin", async () => {
    standInApp(["HerdrShell"]);
    app.calls = [];
    expect(pushSupported()).toBe(false);
    expect(notificationState()).toBe("unsupported");
    expect(await ensurePushSubscription()).toBeNull();
    expect(await testDevicePush()).toBe("unsupported");
    await removePushSubscription();
    expect(app.calls).toEqual([]);
  });
});

it("preserves a rapid on-off-on sequence instead of reusing a subscription being removed", async () => {
  const enable = ensurePushSubscription();
  const disable = removePushSubscription();
  const reenable = ensurePushSubscription();
  await Promise.all([enable, disable, reenable]);
  expect(issued).toBe(2);
  expect(await reenable).toBe(live!.endpoint);
  expect(live!.unsubscribed).toBe(false);
});

describe("a subscription the hosted shell's worker kept while no window could tell the PC", () => {
  const SERVER = "0123456789abcdef0123456789abcdef";
  const OTHER = "fedcba9876543210fedcba9876543210";
  let db: FakeIndexedDB;
  /** what reached the PC, in order; `online` false: the relay is out of reach */
  let calls: { method: string; endpoint: string }[];
  let online: boolean;
  let refusal: number | null;
  const savedIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");

  const subscription = (endpoint: string, key: ArrayBuffer | null = null) => ({
    endpoint, options: { applicationServerKey: key },
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: "p", auth: "a" } }),
  });

  /** public/sw.js as the worker of `scope`, with `windows` open: fires its pushsubscriptionchange. */
  async function rotate(scope: string, change: { oldSubscription?: unknown; newSubscription?: unknown }, windows: { url: string; postMessage: (data: unknown) => void }[] = []) {
    const listeners = new Map<string, (event: unknown) => void>();
    const workerFetches: string[] = [];
    const self = {
      registration: { scope, pushManager: { subscribe: async () => subscription("https://push.example/resubscribed") } },
      clients: { matchAll: async () => windows },
      addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    };
    new Function("self", "indexedDB", "fetch", readFileSync(join(import.meta.dir, "..", "..", "public", "sw.js"), "utf8"))(
      self, db.factory, async (url: string) => { workerFetches.push(url); return new Response(null, { status: 404 }); });
    let done: Promise<unknown> = Promise.resolve();
    listeners.get("pushsubscriptionchange")!({ ...change, waitUntil: (work: Promise<unknown>) => { done = work; } });
    await done;
    return workerFetches;
  }

  beforeEach(() => {
    db = fakeIndexedDB();
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: db.factory });
    calls = [];
    online = true;
    refusal = null;
    const server = globalThis.fetch;
    globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
      const [url, init] = args;
      if (url === "/api/push/subscribe") {
        if (!online) throw new TypeError("Failed to fetch");
        const body = JSON.parse(String(init?.body)) as { subscription?: { endpoint: string }; endpoint?: string };
        calls.push({ method: init?.method ?? "GET", endpoint: body.subscription?.endpoint ?? body.endpoint ?? "" });
        if (refusal !== null) return Response.json({ error: { code: "invalid_subscription", message: "no" } }, { status: refusal });
      }
      return server(...args);
    }, { preconnect: server.preconnect });
  });

  afterEach(() => {
    if (savedIndexedDB) Object.defineProperty(globalThis, "indexedDB", savedIndexedDB);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  });

  it("is stored by the PC's worker, then registered with that PC on the next start exactly once", async () => {
    const fetched = await rotate(`https://app.test/s/${SERVER}/`, {
      oldSubscription: subscription("https://push.example/old"), newSubscription: subscription("https://push.example/new"),
    });
    // the worker has no way to its PC: nothing is sent from it, the subscription waits in IndexedDB
    expect(fetched).toEqual([]);
    expect([...db.rows("pending-push").values()]).toEqual([{ server_id: SERVER,
      subscription: { endpoint: "https://push.example/new", expirationTime: null, keys: { p256dh: "p", auth: "a" } }, old_endpoint: "https://push.example/old" }]);
    expect(db.version()).toBe(2);

    // another PC's start registers nothing of it
    expect(await registerPendingPush(OTHER, indexedPendingPush)).toBe(false);
    expect(calls).toEqual([]);

    expect(await registerPendingPush(SERVER, indexedPendingPush)).toBe(true);
    expect(calls).toEqual([{ method: "POST", endpoint: "https://push.example/new" }, { method: "DELETE", endpoint: "https://push.example/old" }]);
    expect(db.rows("pending-push").size).toBe(0);
    // the start after that has nothing left to register
    expect(await registerPendingPush(SERVER, indexedPendingPush)).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("is registered once on a start with alerts allowed, where the app's own load-time registration runs too", async () => {
    await rotate(`https://app.test/s/${SERVER}/`, {
      oldSubscription: subscription("https://push.example/old"), newSubscription: subscription("https://push.example/new"),
    });
    // the browser now holds the rotated subscription, made for this PC's key
    live = standIn("https://push.example/new", new Uint8Array(65).fill(4).buffer);
    // a start: the shell's recovery, then the app's effect while the recovery is still on its way
    const recovery = registerPendingPush(SERVER, indexedPendingPush, DEFAULT_ALERTS);
    const load = ensurePushSubscription(DEFAULT_ALERTS);
    expect(await recovery).toBe(true);
    expect(await load).toBe("https://push.example/new");
    expect(calls.filter(({ method }) => method === "POST")).toEqual([{ method: "POST", endpoint: "https://push.example/new" }]);
    expect(issued).toBe(0);
    // the skip is spent: the next start's load-time registration goes to the PC as always
    await ensurePushSubscription(DEFAULT_ALERTS);
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(2);
  });

  it("still hands the PC alerts chosen otherwise than the recovery sent", async () => {
    await rotate(`https://app.test/s/${SERVER}/`, { newSubscription: subscription("https://push.example/new") });
    live = standIn("https://push.example/new", new Uint8Array(65).fill(4).buffer);
    const recovery = registerPendingPush(SERVER, indexedPendingPush, DEFAULT_ALERTS);
    const load = ensurePushSubscription({ ...DEFAULT_ALERTS, input: !DEFAULT_ALERTS.input });
    await Promise.all([recovery, load]);
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(2);
  });

  it("tells only the PC's own open windows, and still keeps it for a window that is not connected", async () => {
    const own: unknown[] = [];
    const other: unknown[] = [];
    await rotate(`https://app.test/s/${SERVER}/`, { newSubscription: subscription("https://push.example/new") }, [
      { url: `https://app.test/s/${OTHER}/`, postMessage: (data) => other.push(data) },
      { url: `https://app.test/s/${SERVER}/?pane=w1%3Ap1`, postMessage: (data) => own.push(data) },
    ]);
    expect(own).toEqual([{ type: "push-subscription-change" }]);
    expect(other).toEqual([]);
    expect(db.rows("pending-push").get(SERVER)).toMatchObject({ old_endpoint: null });
  });

  it("waits through a start that cannot reach the PC, and a second rotation keeps the endpoint the PC knows", async () => {
    const scope = `https://app.test/s/${SERVER}/`;
    await rotate(scope, { oldSubscription: subscription("https://push.example/a"), newSubscription: subscription("https://push.example/b") });
    online = false;
    await expect(registerPendingPush(SERVER, indexedPendingPush)).rejects.toBeInstanceOf(TypeError);
    expect(db.rows("pending-push").size).toBe(1);
    // rotated again while offline: the PC never heard of b, so a is the one to drop
    await rotate(scope, { oldSubscription: subscription("https://push.example/b"), newSubscription: subscription("https://push.example/c") });
    online = true;
    expect(await registerPendingPush(SERVER, indexedPendingPush)).toBe(true);
    expect(calls).toEqual([{ method: "POST", endpoint: "https://push.example/c" }, { method: "DELETE", endpoint: "https://push.example/a" }]);
    expect(db.rows("pending-push").size).toBe(0);
  });

  it("is dropped once the PC refused it, so no start asks again", async () => {
    await rotate(`https://app.test/s/${SERVER}/`, { newSubscription: subscription("https://push.example/new") });
    refusal = 400;
    await expect(registerPendingPush(SERVER, indexedPendingPush)).rejects.toBeInstanceOf(ApiError);
    expect(db.rows("pending-push").size).toBe(0);
  });

  it("goes with the PC when the phone forgets it (a revoked PC's subscription is never registered)", async () => {
    await rotate(`https://app.test/s/${SERVER}/`, { newSubscription: subscription("https://push.example/new") });
    await indexedDeviceStore.remove(SERVER);
    expect(db.rows("pending-push").size).toBe(0);
    expect(await registerPendingPush(SERVER, indexedPendingPush)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("subscribes again with the old key when the browser gave no new subscription", async () => {
    await rotate(`https://app.test/s/${SERVER}/`, { oldSubscription: subscription("https://push.example/old", new Uint8Array(65).fill(4).buffer) });
    expect(db.rows("pending-push").get(SERVER)).toMatchObject({ subscription: { endpoint: "https://push.example/resubscribed" }, old_endpoint: "https://push.example/old" });
  });
});
