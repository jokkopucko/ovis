import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "./page.fixture.ts";
import { resetPushHealth, usePushHealth, type PushActionResult } from "./pushHealth.ts";
import { pushSupported, registeredPushEndpoint } from "./push.ts";
import { confirmation } from "./pushConfirm.ts";
import { alertsHere, type AlertsHere } from "./setupGuideFlow.ts";
import { useNotificationState, useNotificationSwitch } from "./useNotifications.ts";
import type { AlertPrefs } from "../../shared/notify-policy.ts";

describe("what Turn on alerts leaves this device", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const key = Buffer.from(new Uint8Array(65).fill(4)).toString("base64url");
  let page: Page;
  let testPushStatus = 204;
  let lastSuccess: string | null = null;
  let lastFailure: string | null = null;
  let statusRoute: "record" | "error" | "no-device" = "record";
  let rendered: (() => void)[] = [];
  let permission: NotificationPermission = "granted";
  let permissionEvents: EventTarget;
  let hook: { notifications: string; pushOn: boolean; enable: () => Promise<PushActionResult>; alerts: AlertsHere };

  beforeEach(() => {
    testPushStatus = 204;
    permission = "granted";
    lastSuccess = null;
    lastFailure = null;
    statusRoute = "record";
    rendered = [];
    for (const name of ["PushManager", "Notification"]) descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    page = openPage("https://pc.example/");
    Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "visible" });
    let live: unknown = null;
    const pushManager = {
      getSubscription: async () => live,
      subscribe: async () => {
        live = { endpoint: "https://push.example/1", options: { applicationServerKey: new Uint8Array(65).fill(4).buffer }, toJSON: () => ({ endpoint: "https://push.example/1", keys: { p256dh: "x", auth: "y" } }), unsubscribe: async () => { live = null; return true; } };
        return live;
      },
    };
    const registration = { pushManager };
    permissionEvents = new EventTarget();
    const permissions = { query: async () => permissionEvents };
    Object.defineProperties(page.window.navigator, {
      userAgent: { configurable: true, value: "Mozilla/5.0 Chrome/130" },
      languages: { configurable: true, value: ["en"] },
      permissions: { configurable: true, value: permissions },
      serviceWorker: { configurable: true, value: { ready: Promise.resolve(registration), getRegistration: async () => registration } },
    });
    Object.defineProperty(globalThis, "PushManager", { configurable: true, value: class {} });
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: { get permission() { return permission; }, requestPermission: async () => permission } });
    const fetch = async (input: string | URL | Request) => {
      const path = new URL(String(input instanceof Request ? input.url : input), "https://pc.example").pathname;
      if (path === "/api/push") return Response.json({ public_key: key });
      if (path === "/api/push/subscribe") return new Response(null, { status: 204 });
      if (path === "/api/push/test") {
        if (testPushStatus === 204) { lastSuccess = "2026-11-15T00:00:01Z"; return new Response(null, { status: 204 }); }
        lastFailure = "server";
        return Response.json({ error: { code: "push_failed", message: "push service 502" } }, { status: testPushStatus });
      }
      if (path === "/api/push/status") {
        if (statusRoute === "error") return Response.json({ error: { code: "internal_error", message: "boom" } }, { status: 500 });
        if (statusRoute === "no-device") return Response.json({ error: { code: "status_unavailable", message: "no device" } }, { status: 403 });
        return Response.json({ registered: true, last_success_at: lastSuccess, last_failure: lastFailure, last_failure_at: lastFailure === null ? null : "2026-11-15T00:00:02Z" });
      }
      return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
  });

  afterEach(async () => {
    await page.close();
    mock.restore();
    resetPushHealth();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    descriptors.clear();
  });

  async function mount(): Promise<void> {
    const alerts = { input: true, permission: true, done: "long" } as unknown as AlertPrefs;
    function Probe() {
      const state = useNotificationState();
      const health = usePushHealth();
      const { enableNotifications } = useNotificationSwitch({ updateSettings: () => {}, locked: true, notifications: state.notifications, setNotifications: state.setNotifications, alerts, alertsRef: { current: alerts }, alertsOn: true, setPushOn: state.setPushOn });
      const answer = alertsHere({ alertsOn: true, notifications: state.notifications, desktop: false, pushSupported: pushSupported(), pushOn: state.pushOn, push: { checked: health.checked, problem: health.health.problem, delivered: health.delivered }, confirmed: confirmation(registeredPushEndpoint()) });
      hook = { notifications: state.notifications, pushOn: state.pushOn, enable: enableNotifications, alerts: answer };
      for (const listener of rendered.splice(0)) listener();
      return null;
    }
    await page.render(createElement(Probe));
  }

  async function settled(): Promise<AlertsHere> {
    await act(async () => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`alerts still ${hook.alerts}`)), 2000);
        const look = (): void => { if (hook.alerts !== "checking") { clearTimeout(timer); resolve(); } else rendered.push(look); };
        look();
      });
    });
    return hook.alerts;
  }

  async function enable(): Promise<PushActionResult> {
    let result: PushActionResult | undefined;
    await act(async () => { result = await hook.enable(); });
    return result!;
  }

  it("counts a push on once its confirmation push went out", async () => {
    await mount();
    expect(await enable()).toBe("sent");
    expect(hook.pushOn).toBe(true);
  });

  it("keeps the push subscription when the confirmation push failed, so the tab does not notify beside it", async () => {
    testPushStatus = 502;
    await mount();
    expect(await enable()).toBe("failed");
    expect(hook.pushOn).toBe(true);
  });

  it("leaves a permission granted in the site's settings to the next tap, in view or on return to the page", async () => {
    permission = "default";
    await mount();
    permission = "granted";
    await act(async () => { permissionEvents.dispatchEvent(new Event("change")); });
    expect(hook.notifications).toBe("default");
    await act(async () => { page.window.document.dispatchEvent(new page.window.Event("visibilitychange")); });
    expect(hook.notifications).toBe("default");
  });

  it("reads a permission given back after a refusal as not asked yet, so the next tap turns alerts on", async () => {
    permission = "denied";
    await mount();
    expect(hook.notifications).toBe("denied");
    permission = "granted";
    await act(async () => { permissionEvents.dispatchEvent(new Event("change")); });
    expect(hook.notifications).toBe("default");
    expect(await enable()).toBe("sent");
    expect(hook.notifications).toBe("granted");
  });

  it("reads a permission taken back while the page stays in view", async () => {
    await mount();
    await enable();
    permission = "denied";
    await act(async () => { permissionEvents.dispatchEvent(new Event("change")); });
    expect(hook.notifications).toBe("denied");
  });

  it("reads a permission taken back in the site's settings when the page comes back", async () => {
    await mount();
    await enable();
    permission = "denied";
    await act(async () => { page.window.document.dispatchEvent(new page.window.Event("visibilitychange")); });
    expect(hook.notifications).toBe("denied");
  });

  it("reads on once the PC recorded the confirmation push, without a reload", async () => {
    await mount();
    expect(await enable()).toBe("sent");
    expect(await settled()).toBe("on");
  });

  it("reads off when the confirmation push failed for a while and nothing was ever delivered", async () => {
    testPushStatus = 502;
    await mount();
    expect(await enable()).toBe("failed");
    expect(await settled()).toBe("off");
  });

  it("says nothing while the PC's record cannot be read", async () => {
    await mount();
    await enable();
    resetPushHealth();
    statusRoute = "error";
    await act(async () => { page.window.document.dispatchEvent(new page.window.Event("visibilitychange")); });
    expect(hook.alerts).toBe("checking");
  });

  it("where the PC cannot say (the open LAN), reads off after this browser saw its confirmation push fail", async () => {
    statusRoute = "no-device";
    testPushStatus = 502;
    await mount();
    expect(await enable()).toBe("failed");
    expect(await settled()).toBe("off");
  });
});
