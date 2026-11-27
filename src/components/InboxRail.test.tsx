import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { SettingsProvider } from "../lib/settings.ts";
import { usageCounters } from "../lib/usageCounters.ts";
import { InboxRail, type InboxRailProps } from "./InboxRail.tsx";

describe("InboxRail", () => {
  let page: Page;
  let pressed: string[];
  let frames: FrameRequestCallback[];
  const runFrames = (): Promise<void> => act(async () => { for (const run of frames.splice(0)) run(0); });

  beforeEach(() => {
    pressed = [];
    frames = [];
    page = openPage();
    Object.defineProperty(page.window, "requestAnimationFrame", { configurable: true, value: (run: FrameRequestCallback) => frames.push(run) });
    Object.defineProperty(page.window, "cancelAnimationFrame", { configurable: true, value: () => {} });
  });

  afterEach(async () => { await page.close(); });

  const props = (change: Partial<InboxRailProps> = {}): InboxRailProps => ({
    onExit: () => pressed.push("exit"), onInbox: () => pressed.push("inbox"),
    waiting: null, alerts: { on: true, title: "Alerts on in the app. Tap to turn them off", toggle: () => pressed.push("alerts") },
    onSettings: () => pressed.push("settings"), connection: null, saidByThread: false,
    shortcutTitle: (label, id) => id === "settings" ? `${label} (Ctrl+,)` : label,
    ...change,
  });
  const view = (change: Partial<InboxRailProps>) => createElement(SettingsProvider, null, createElement(InboxRail, props(change)));
  const draw = async (change: Partial<InboxRailProps> = {}) => {
    await page.render(view(change));
    return page.container;
  };
  const redraw = (change: Partial<InboxRailProps>) => page.render(view(change));
  const buttons = (root: Element) => [...root.querySelectorAll("button")];
  const kind = (node: Element): string => [...node.classList].find((name) => name.startsWith("inbox-rail-") && name !== "inbox-rail-item") ?? "";
  const button = (root: Element, name: string) => {
    const found = buttons(root).find((node) => kind(node) === `inbox-rail-${name}`);
    if (!found) throw new Error(`Missing ${name} button`);
    return found;
  };
  const named = (node: HTMLButtonElement) => [node.getAttribute("aria-label"), node.title];
  const glyph = (node: Element): string => [...(node.querySelector("svg")?.classList ?? [])].find((name) => name.startsWith("lucide-")) ?? "";
  const press = (node: HTMLButtonElement) => act(async () => { node.click(); });

  it("is a navigation landmark named for the mode, apart from the list's own", async () => {
    await draw();
    const nav = page.one("nav");
    expect(nav.getAttribute("aria-label")).toBe("Inbox mode");
  });

  it("holds the place at its top, then alerts, the main view and Settings, the last, in its lower group, each a plain button, and no magnifier", async () => {
    const root = await draw();
    const groups = [...root.querySelectorAll("div.inbox-rail-group")];
    expect(root.querySelector("svg.lucide-search") !== null).toBe(false);
    expect(groups.map((group) => [[...group.classList].at(-1), buttons(group).map(kind)])).toEqual([
      ["is-top", ["inbox-rail-place"]],
      ["is-lower", ["inbox-rail-alerts", "inbox-rail-main", "inbox-rail-settings"]],
    ]);
    expect(kind(buttons(root).at(-1)!)).toBe("inbox-rail-settings");
    for (const node of buttons(root)) expect([node.getAttribute("type"), node.getAttribute("tabindex"), node.disabled]).toEqual(["button", null, false]);
  });

  it("takes the way back to the main view from the monitor right above Settings, named and titled for it, and opens no menu of PCs", async () => {
    const root = await draw();
    const main = button(root, "main");
    expect([...named(main), glyph(main), main.getAttribute("aria-haspopup"), main.getAttribute("aria-expanded")]).toEqual(["Back to main view", "Back to main view", "lucide-monitor", null, null]);
    expect(buttons(root).findIndex((node) => node === main)).toBe(buttons(root).length - 2);
    const menus = () => page.window.document.body.querySelectorAll(".row-sheet, .row-menu");
    expect(menus()).toHaveLength(0);
    await press(main);
    expect(menus()).toHaveLength(0);
    expect(pressed).toEqual(["exit"]);
  });

  it("marks the inbox as the current page, the one place the rail has, and a press asks the list for its top", async () => {
    const root = await draw();
    const place = button(root, "place");
    expect(named(place)).toEqual(["Agent inbox", "Agent inbox"]);
    expect(buttons(root).filter((node) => node.hasAttribute("aria-current")).map((node) => [kind(node), node.getAttribute("aria-current")])).toEqual([["inbox-rail-place", "page"]]);
    await press(place);
    expect(pressed).toEqual(["inbox"]);
  });

  it("still takes a press when its count fails", async () => {
    const counting = spyOn(usageCounters, "count").mockImplementation(() => { throw new Error("storage full"); });
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const root = await draw();
      await press(button(root, "place"));
      await press(button(root, "main"));
    } finally { counting.mockRestore(); logged.mockRestore(); }
    expect(pressed).toEqual(["inbox", "exit"]);
  });

  it("draws the waiting count only while an agent waits, first in the lower group, and a press opens the next one", async () => {
    const root = await draw();
    expect(buttons(root).map(kind)).not.toContain("inbox-rail-waiting");
    await redraw({ waiting: { count: 12, open: () => pressed.push("next") } });
    const lower = page.one("div.is-lower");
    expect(buttons(lower).map(kind)).toEqual(["inbox-rail-waiting", "inbox-rail-alerts", "inbox-rail-main", "inbox-rail-settings"]);
    const waiting = button(root, "waiting");
    expect(named(waiting)).toEqual(["12 waiting for you", "Open the next session waiting for you"]);
    const pill = page.one('.inbox-rail-waiting [data-count="12"]');
    expect([pill.className, pill.getAttribute("aria-hidden")]).toEqual(["header-more-dot is-waiting", "true"]);
    await press(waiting);
    expect(pressed).toEqual(["next"]);
    await redraw({ waiting: null });
    expect(buttons(root).map(kind)).not.toContain("inbox-rail-waiting");
  });

  it("switches this device's alerts: pressed and a bell while on, not pressed and a struck bell while off, the bell's own sentence as its tooltip", async () => {
    const root = await draw();
    const alerts = () => button(root, "alerts");
    expect([...named(alerts()), alerts().getAttribute("aria-pressed"), glyph(alerts())]).toEqual(["Alerts", "Alerts on in the app. Tap to turn them off", "true", "lucide-bell"]);
    await press(alerts());
    expect(pressed).toEqual(["alerts"]);
    await redraw({ alerts: { on: false, title: "Alerts off on this device. Tap to turn them on", toggle: () => pressed.push("alerts") } });
    expect([...named(alerts()), alerts().getAttribute("aria-pressed"), glyph(alerts())]).toEqual(["Alerts", "Alerts off on this device. Tap to turn them on", "false", "lucide-bell-off"]);
  });

  it("opens Settings, its shortcut in the tooltip where one is set", async () => {
    const root = await draw({ shortcutTitle: (label, id) => id === "settings" ? `${label} (Ctrl+Shift+,)` : label });
    const settings = button(root, "settings");
    expect(named(settings)).toEqual(["Settings", "Settings (Ctrl+Shift+,)"]);
    await press(settings);
    expect(pressed).toEqual(["settings"]);
  });

  describe("the connection", () => {
    const main = (root: Element) => button(root, "main");
    const dot = (root: Element): string | null => {
      const drawn = main(root).querySelector("span.inbox-rail-dot");
      return drawn ? [...drawn.classList].find((name) => name.startsWith("is-")) ?? "" : null;
    };
    const status = (root: Element) => [...root.querySelectorAll('[role="status"]')].map((node) => [node.className, node.textContent]);

    it("draws its dot on the main view's monitor only while the connection has something to say, says a lost one in its name, and draws none while the open thread's chip says the same word", async () => {
      const root = await draw();
      expect(dot(root)).toBeNull();
      await redraw({ connection: "reconnecting" });
      expect(dot(root)).toBe("is-reconnecting");
      expect(named(main(root))).toEqual(["Back to main view · Reconnecting…", "Back to main view · Reconnecting…"]);
      await redraw({ connection: "connected" });
      expect(dot(root)).toBe("is-connected");
      expect(named(main(root))).toEqual(["Back to main view", "Back to main view"]);
      expect(page.one('.inbox-rail-main [class="inbox-rail-dot is-connected"]').getAttribute("aria-hidden")).toBe("true");
      await redraw({ connection: "reconnecting", saidByThread: true });
      expect(dot(root)).toBeNull();
      expect(named(main(root))[0]).toBe("Back to main view · Reconnecting…");
      await redraw({ connection: null, saidByThread: false });
      expect(dot(root)).toBeNull();
    });

    it("announces the connection's word from a line that is in the document before it, and nothing the thread's chip says", async () => {
      const root = await draw();
      await runFrames();
      expect(status(root)).toEqual([["visually-hidden", ""]]);
      await redraw({ connection: "reconnecting" });
      expect(status(root)).toEqual([["visually-hidden", "Reconnecting…"]]);
      await redraw({ connection: "connected" });
      expect(status(root)).toEqual([["visually-hidden", "Connected"]]);
      await redraw({ connection: "reconnecting", saidByThread: true });
      expect(status(root)).toEqual([["visually-hidden", ""]]);
    });
  });
});
