import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { installedState, installHelp, isAppWindow, type InstalledStateInput } from "./install.ts";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";

function detect(modes: string[], rest: Partial<Omit<InstalledStateInput, "matches">> = {}): boolean {
  return installedState({
    matches: (query) => modes.some((mode) => query === `(display-mode: ${mode})`),
    iosStandalone: false,
    installedByEvent: false,
    relatedInstalled: false,
    previous: false,
    ...rest,
  });
}

describe("installedState", () => {
  it("standalone -> installed", () => {
    expect(detect(["standalone"])).toBe(true);
  });

  it("minimal-ui -> installed", () => {
    expect(detect(["minimal-ui"])).toBe(true);
  });

  it("window-controls-overlay -> installed", () => {
    expect(detect(["window-controls-overlay"])).toBe(true);
  });

  it("tabbed -> installed", () => {
    expect(detect(["tabbed"])).toBe(true);
  });

  it("unframed -> installed", () => {
    expect(detect(["unframed"])).toBe(true);
  });

  it("app window in fullscreen keeps the previous verdict", () => {
    expect(detect(["fullscreen"], { previous: true })).toBe(true);
  });

  it("tab in F11 fullscreen is not installed", () => {
    expect(detect(["fullscreen"], { previous: false })).toBe(false);
  });

  it("browser -> not installed", () => {
    expect(detect(["browser"])).toBe(false);
  });

  it("no matching display mode -> not installed", () => {
    expect(detect([])).toBe(false);
  });

  it("iosStandalone -> installed, also while fullscreen", () => {
    expect(detect([], { iosStandalone: true })).toBe(true);
    expect(detect(["fullscreen"], { iosStandalone: true })).toBe(true);
  });

  it("relatedInstalled or installedByEvent -> installed in a browser tab and in fullscreen", () => {
    expect(detect(["browser"], { relatedInstalled: true })).toBe(true);
    expect(detect(["fullscreen"], { relatedInstalled: true })).toBe(true);
    expect(detect(["browser"], { installedByEvent: true })).toBe(true);
  });
});

describe("related app refresh", () => {
  for (const trigger of ["focus", "visibilitychange"]) {
    for (const byEvent of [false, true]) {
      it(`detects uninstall on ${trigger} with appinstalled=${byEvent}`, async () => {
        const originals = Object.getOwnPropertyDescriptors(globalThis);
        const page = new EventTarget();
        const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
        let apps = [{ platform: "webapp" }];
        let query = Promise.resolve(apps);
        Object.assign(page, {
          top: page,
          matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
        });
        Object.defineProperties(globalThis, {
          window: { configurable: true, value: page },
          document: { configurable: true, value: document },
          navigator: {
            configurable: true,
            value: { userAgent: CHROME, getInstalledRelatedApps: () => (query = Promise.resolve(apps)) },
          },
        });
        try {
          const modulePath = `./install.ts?refresh=${trigger}-${byEvent}`;
          const { useInstallPrompt } = await import(modulePath);
          await query;
          const State = () => String(useInstallPrompt().installed);
          expect(renderToStaticMarkup(createElement(State))).toBe("true");
          if (byEvent) page.dispatchEvent(new Event("appinstalled"));
          apps = [];

          (trigger === "focus" ? page : document).dispatchEvent(new Event(trigger));
          await query;

          expect(renderToStaticMarkup(createElement(State))).toBe("false");
        } finally {
          for (const key of ["window", "document", "navigator"]) {
            const original = originals[key];
            if (original) Object.defineProperty(globalThis, key, original);
            else Reflect.deleteProperty(globalThis, key);
          }
        }
      });
    }
  }
});

describe("Ovis for Mac", () => {
  const MAC_APP = `${IPAD} OvisMac/1.0.0`;

  it("counts its window as the app installed, and Safari on the same Mac as a tab", async () => {
    const originals = Object.getOwnPropertyDescriptors(globalThis);
    const page = Object.assign(new EventTarget(), { matchMedia: () => Object.assign(new EventTarget(), { matches: false }) });
    try {
      for (const [userAgent, installed] of [[MAC_APP, "true"], [IPAD, "false"]] as const) {
        Object.defineProperties(globalThis, {
          window: { configurable: true, value: page },
          navigator: { configurable: true, value: { userAgent, maxTouchPoints: 0 } },
        });
        const { useInstallPrompt } = await import(`./install.ts?mac=${installed}`);
        const State = () => String(useInstallPrompt().installed);
        expect(renderToStaticMarkup(createElement(State))).toBe(installed);
      }
    } finally {
      for (const key of ["window", "navigator"]) {
        const original = originals[key];
        if (original) Object.defineProperty(globalThis, key, original);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
});

describe("installHelp", () => {
  it("points iPhones and iPads (which report a Mac) at Add to Home Screen", () => {
    expect(installHelp({ userAgent: IPHONE, secure: false, maxTouchPoints: 5 })).toContain("Add to Home Screen");
    expect(installHelp({ userAgent: IPAD, secure: true, maxTouchPoints: 5 })).toContain("Add to Home Screen");
  });

  it("names the platform's own route elsewhere", () => {
    expect(installHelp({ userAgent: IPAD, secure: true, maxTouchPoints: 0 })).toContain("Add to Dock");
    expect(installHelp({ userAgent: ANDROID, secure: true, maxTouchPoints: 5 })).toContain("Add to Home screen");
    expect(installHelp({ userAgent: CHROME, secure: true, maxTouchPoints: 0 })).toContain("address bar");
    expect(installHelp({ userAgent: FIREFOX, secure: true, maxTouchPoints: 0 })).toContain("Chrome or Edge");
  });

  it("asks for HTTPS before anything else a browser needs to install", () => {
    expect(installHelp({ userAgent: CHROME, secure: false, maxTouchPoints: 0 })).toContain("HTTPS");
    expect(installHelp({ userAgent: ANDROID, secure: false, maxTouchPoints: 5 })).toContain("HTTPS");
  });
});

describe("isAppWindow", () => {
  const inWindow = (modes: string[], standalone = false): boolean => {
    const saved = { window: globalThis.window, navigator: globalThis.navigator };
    Object.assign(globalThis, {
      window: { matchMedia: (query: string) => ({ matches: modes.some((mode) => query === `(display-mode: ${mode})`) }) },
      navigator: { standalone },
    });
    try { return isAppWindow(); } finally { Object.assign(globalThis, saved); }
  };

  it("is the app's own window in standalone, minimal-ui or iOS standalone", () => {
    expect(inWindow(["standalone"])).toBe(true);
    expect(inWindow(["minimal-ui"])).toBe(true);
    expect(inWindow([], true)).toBe(true);
  });

  it("is a plain browser tab even after an app window was seen", () => {
    expect(inWindow(["standalone"])).toBe(true);
    expect(inWindow(["browser"])).toBe(false);
  });
});
