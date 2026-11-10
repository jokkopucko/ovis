import { describe, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { UpdateStatus } from "../../shared/update.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { UpdatesModel } from "../lib/updates.ts";
import * as herdrUpdate from "../lib/herdrUpdate.ts";
import { SettingsBare } from "./SettingsControls.tsx";
import { DesktopUpdateNotice, HerdrUpdateControls, UpdateControls, UpdateNotice } from "./UpdateControls.tsx";

Object.assign(globalThis, { __APP_VERSION__: "0.4.22" });

const blocked: UpdateStatus = {
  managed: true, auto_update: false, phase: "idle", current_revision: "c4418bca", latest_revision: "c4418bca",
  current_version: "0.4.22", latest_version: "0.4.22", available: false, checked_at: null,
  blocked_reason: "Switch the source checkout to main to update.", error: null,
};

const updates = (status: UpdateStatus): UpdatesModel => ({
  status, error: null, busy: false, needsReload: false, reload: null, notes: null, installed: null,
  request: async () => undefined, failure: null, offered: null,
} as unknown as UpdatesModel);

function render(bare: boolean, model = updates(blocked)): string {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, null,
      createElement(SettingsBare.Provider, { value: bare }, createElement(UpdateControls, { updates: model }))));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

const heading = (html: string): string => /<h3 id="settings-updates-title"[^>]*>/.exec(html)?.[0] ?? "";

// About joins its sections into one card (herdr-app's About list): a caption between two of its
// rows splits that card in two. The full section (a blocked check, an install, a failure) keeps its
// name for a link and a screen reader there, out of sight like the compact line's.
describe("the Updates section's heading", () => {
  it("is out of sight inside About's joined card", () => {
    expect(heading(render(true))).toContain('class="visually-hidden"');
  });

  it("stays a visible caption on a page with captions", () => {
    const shown = heading(render(false));
    expect(shown).not.toBe("");
    expect(shown).not.toContain("visually-hidden");
  });
});

// the offer line closes for its release on this device (G-102), as the done line does, and offers the next one again
describe("the update offer line", () => {
  const offer = (revision: string, closed: string | null, model?: Partial<UpdatesModel>): string => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: (key: string) => key === "ovis:update-offer-closed" ? closed : null } } });
    try {
      const status = { ...blocked, blocked_reason: null, available: true, latest_version: "0.4.23", latest_revision: revision };
      return renderToStaticMarkup(createElement(SettingsProvider, null,
        createElement(UpdateNotice, { updates: { ...updates(status), ...model }, onOpen: () => undefined })));
    } finally {
      if (saved) Object.defineProperty(globalThis, "window", saved);
      else Reflect.deleteProperty(globalThis, "window");
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  };

  it("can be closed, and stays closed for that release only", () => {
    expect(offer("aaaa111", null)).toContain('aria-label="Dismiss"');
    expect(offer("aaaa111", "aaaa111")).toBe("");
    expect(offer("bbbb222", "aaaa111")).toContain("Ovis v0.4.23 is available.");
  });

  it("keeps a failed install on the line, with no Close", () => {
    const html = offer("aaaa111", "aaaa111", { error: "The release server could not be reached." });
    expect(html).toContain("The update could not be installed.");
    expect(html).not.toContain('aria-label="Dismiss"');
  });
});

describe("update failure announcements", () => {
  it.each(["request", "server", "offer"] as const)("announces a %s failure beside its recovery controls", (source) => {
    const model = updates({ ...blocked, blocked_reason: null });
    if (source === "request") model.error = "The release server could not be reached.";
    if (source === "server") model.status = { ...blocked, error: "The downloaded release could not be verified." };
    if (source === "offer") model.failure = "offer-changed";
    const html = render(true, model);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Check for updates");
  });

  it("keeps an ordinary update check polite", () => {
    const html = render(true, { ...updates({ ...blocked, blocked_reason: null }), busy: true });
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('role="status"');
  });

  it.each(["request", "output"] as const)("announces a runtime update %s failure", (source) => {
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    const hook = spyOn(herdrUpdate, "useHerdrUpdate").mockReturnValue({
      status: { supported: true, phase: source === "output" ? "error" : "idle", server_version: "1.0", binary_version: "1.0", stale: false, output: source === "output" ? "Download failed" : null, finished_at: null },
      error: source === "request" ? "The update request was refused" : null,
      busy: false, request: async () => undefined,
    });
    try {
      const html = renderToStaticMarkup(createElement(SettingsProvider, null,
        createElement(HerdrUpdateControls, { enabled: true, herdrVersion: "1.0" })));
      expect(html).toContain('role="alert"');
      expect(html).toContain(source === "request" ? "The update request was refused" : "Download failed");
    } finally {
      hook.mockRestore();
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  });

  it.each([true, false])("announces a runtime update that failed without output (bare %p)", (bare) => {
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    const hook = spyOn(herdrUpdate, "useHerdrUpdate").mockReturnValue({
      status: { supported: true, phase: "error", server_version: "1.0", binary_version: "1.0", stale: false, output: null, finished_at: null },
      error: null, busy: false, request: async () => undefined,
    });
    try {
      const html = renderToStaticMarkup(createElement(SettingsProvider, null,
        createElement(SettingsBare.Provider, { value: bare }, createElement(HerdrUpdateControls, { enabled: true, herdrVersion: "1.0" }))));
      expect(html).toContain('role="alert"');
      expect(html).toContain("Update herdr");
    } finally {
      hook.mockRestore();
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  });
});

// the desktop app's downloaded update (lib/desktopUpdate.ts): the tray's Restart to Update, on the release line's row
describe("the desktop app's update line", () => {
  const line = (update: Parameters<typeof DesktopUpdateNotice>[0]["update"], language = "en"): string => {
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: [language] });
    try {
      return renderToStaticMarkup(createElement(SettingsProvider, null, createElement(DesktopUpdateNotice, { update })));
    } finally {
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  };
  const ready = { version: "0.5.3", installing: false, install: () => undefined, close: () => undefined };

  it("names the version, with Restart to Update and a Close", () => {
    const html = line(ready);
    expect(html).toContain('class="update-notice is-line"');
    expect(html).toContain("Ovis 0.5.3 is ready.");
    expect(html).toMatch(/<button type="button" class="btn btn-primary">Restart to Update<\/button>/);
    expect(html).toContain('aria-label="Dismiss"');
  });

  it("holds its button while the app installs", () => {
    expect(line({ ...ready, installing: true })).toMatch(/<button type="button" class="btn btn-primary" disabled="">Restart to Update<\/button>/);
  });

  it("is not drawn with no update, a closed line or in a browser", () => {
    expect(line(null)).toBe("");
  });

  // the line's button is the tray's item: the words the app's own menu uses (app/electron/src/text.ts)
  it("names Restart to Update as the app's tray does, in every language", async () => {
    const { desktopText } = await import("../../app/electron/src/text.ts");
    for (const language of ["ko", "ja", "zh"] as const) {
      const html = line(ready, language);
      expect(html).toContain(`>${desktopText(language)("Restart to Update")}</button>`);
      expect(html).toContain(`${desktopText(language)("Ovis {version} is ready", { version: "0.5.3" })}`);
    }
  });
});
