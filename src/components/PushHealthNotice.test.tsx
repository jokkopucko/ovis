import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DEFAULT_ALERTS } from "../../shared/notify-policy.ts";
import { dismissPushNotice, refreshPushHealth, resetPushHealth, runPushAction } from "../lib/pushHealth.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { repairOutcome, useNotificationSwitch } from "../lib/useNotifications.ts";
import { PushHealthNotice } from "./PushHealthNotice.tsx";
import { PushTestControls } from "./PushTestControls.tsx";

describe("the alerts notice", () => {
  const saved = { PushManager: (globalThis as { PushManager?: unknown }).PushManager, Notification: (globalThis as { Notification?: unknown }).Notification };
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  const render = () => renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(PushHealthNotice, { onRepair: () => undefined, onOpen: () => undefined }) }));

  beforeEach(async () => {
    const pushManager = { getSubscription: async () => null };
    Object.defineProperty(globalThis.navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => ({ pushManager }) } });
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    Object.assign(globalThis, { PushManager: class {}, Notification: { permission: "granted" } });
    resetPushHealth();
    await refreshPushHealth(true);
  });

  afterEach(() => {
    delete (globalThis.navigator as { serviceWorker?: unknown; brave?: unknown }).serviceWorker;
    delete (globalThis.navigator as { brave?: unknown }).brave;
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
    Object.assign(globalThis, saved);
    resetPushHealth();
  });

  it("says why a repair failed instead of asking for it again, and can be closed", async () => {
    expect(render()).toContain("This device&#x27;s push subscription is missing. Turn alerts on again.");
    expect(render()).toContain("aria-label=\"Dismiss\"");
    await runPushAction("repair", async () => ({ result: "refused" }), () => true);
    expect(render()).toContain("This device would not make a push subscription.");
    // in Brave, the setting that turns its push service on
    Object.defineProperty(globalThis.navigator, "brave", { configurable: true, value: {} });
    expect(render()).toContain("Turn on Use Google services for push messaging in Brave&#x27;s privacy settings");
    await runPushAction("repair", async () => ({ result: "no-worker" }), () => true);
    expect(render()).toContain("Reload the page, then try again.");
    expect(render()).toContain("Turn alerts on again");
    dismissPushNotice();
    expect(render()).toBe("");
  });

  it.each([false, true])("keeps reload advice and the Settings repair button after a real worker-ready timeout (prior fault: %s)", async (priorFault) => {
    if (!priorFault) resetPushHealth();
    let enable: (() => Promise<import("../lib/pushHealth.ts").PushActionResult>) | undefined;
    function Harness() {
      enable = useNotificationSwitch({
        updateSettings: () => undefined, locked: false, notifications: "granted", setNotifications: () => undefined,
        alerts: DEFAULT_ALERTS, alertsRef: { current: DEFAULT_ALERTS }, alertsOn: true, setPushOn: () => undefined,
      }).enableNotifications;
      return null;
    }
    renderToStaticMarkup(createElement(Harness));
    const onEnable = enable!;
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
      ready: new Promise(() => undefined), getRegistration: async () => undefined,
    } });
    const timeout = globalThis.setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(Object.assign((callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => {
      if (milliseconds === 10_000) {
        queueMicrotask(() => callback(...args));
        return timeout(() => undefined, 0);
      }
      return timeout(callback, milliseconds, ...args);
    }, timeout));
    try {
      await runPushAction("repair", async () => repairOutcome(await onEnable()), () => true);
      const settings = renderToStaticMarkup(createElement(SettingsProvider, {
        children: createElement(PushTestControls, { onEnable }),
      }));
      expect(settings).toContain("Reload the page, then try again.");
      expect(settings).toContain("Turn alerts on again");
      if (priorFault) expect(render()).toContain("Reload the page, then try again.");
    } finally {
      timer.mockRestore();
    }
  });
});
