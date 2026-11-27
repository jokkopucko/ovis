import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { openPage, type Page } from "./page.fixture.ts";
import { handlePreferencesRequest, PreferenceStore } from "../../server/preferences.ts";
const named = <T extends object>(doc: T) => ({ ...doc, state_id: expect.stringMatching(/^[0-9a-f]{32}$/) });
import type { PreferencesPut, SharedPreferences } from "../../shared/preferences.ts";
import { DEFAULT_SETTINGS, SettingsProvider, sanitizeSettings, useSettings, type Settings } from "./settings.ts";
import { currentSidebarPins, setSidebarPins } from "./sidebarPins.ts";
import { currentPaneMutes, setPaneMutes } from "./paneMutes.ts";
import { usePreferencesSync } from "./preferencesSync.ts";
import type { UserError } from "./userError.ts";

describe("preferences sync real send path", () => {
  let savedStorage: PropertyDescriptor | undefined;
  let dir: string;
  let store: PreferenceStore;

  let oldServer: boolean;
  let releaseAnswer: (() => Promise<void>) | undefined;
  let releaseGet: (() => Promise<void>) | undefined;
  let page: Page;
  let mounted: Map<number, ReactElement>;
  let nextMount: number;
  let clients: Client[];
  let revisions: number[];
  let answers: number;
  let refuse: Response | null;
  let refusing: (() => Response | Promise<Response>) | null;
  let waits: Map<unknown, number>;
  let syncEnabled: boolean;
  let refusals: number;
  let bodies: PreferencesPut[];
  let answerListeners: Set<() => void>;
  let beforeConditionalPut: (() => void) | null;

  let keepalives: boolean[];
  let sent: PreferencesPut[];
  const dropNewKeys = ({ muted_panes: _muted, state_id: _id, ...doc }: SharedPreferences): SharedPreferences => ({
    ...doc, settings: Object.fromEntries(Object.entries(doc.settings).filter(([key]) => key !== "darkTheme" && key !== "lightTheme")),
  });
  interface Client {
    known: boolean;
    settings: Settings;
    rendered: { id: string; mode: string };
    update: (patch: Partial<Settings>) => void;
    receive: (doc: SharedPreferences) => void;
    saveError: UserError | null;
    paused: boolean;
    retrying: boolean;
    retry: () => void;
    resubscribed: () => void;
    disconnected: () => void;
    closed: () => void;
    rerender: () => Promise<void>;
  }

  beforeEach(() => {
    page = openPage();
    waits = new Map();
    syncEnabled = true;
    keepalives = [];
    savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: page.window.localStorage });
    Object.defineProperty(page.window.navigator, "languages", { configurable: true, value: ["en-US"] });
    Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "visible" });
    page.window.document.documentElement.style.setProperty("--bg", "#12100e");
    Object.defineProperties(page.window, {
      setTimeout: { configurable: true, value: (fn: () => void, ms: number) => {
        const id = globalThis.setTimeout(() => { waits.delete(id); fn(); }, ms);
        waits.set(id, ms);
        return id;
      } },
      clearTimeout: { configurable: true, value: (id: number) => { waits.delete(id); globalThis.clearTimeout(id); } },
    });
    dir = mkdtempSync(join(tmpdir(), "herdr-sync-hook-"));
    store = new PreferenceStore(dir);
    oldServer = false;
    releaseAnswer = undefined;
    releaseGet = undefined;
    mounted = new Map();
    nextMount = 0;
    clients = [];
    revisions = [];
    answers = 0;
    refuse = null;
    refusing = null;
    refusals = 0;
    bodies = [];
    sent = [];
    answerListeners = new Set();
    beforeConditionalPut = null;
    setPaneMutes(null);
    setSidebarPins([]);
    store.subscribe((doc) => {
      revisions.push(doc.revision);
      for (const client of clients) client.receive(oldServer ? dropNewKeys(doc) : doc);
    });
    const fetchPreferences = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (init?.method !== "PUT") {
        if (releaseGet) await releaseGet();
        return Response.json(oldServer ? dropNewKeys(store.get()) : store.get());
      }
      bodies.push(JSON.parse(String(init.body)));
      keepalives.push(init.keepalive === true);
      if (beforeConditionalPut !== null) {
        beforeConditionalPut();
        return handlePreferencesRequest(new Request("http://x/api/preferences", init), store);
      }
      if (refuse !== null || refusing !== null) {
        const answer = refuse;
        refuse = null;
        refusals++;
        for (const listener of [...answerListeners]) listener();
        return answer ?? refusing!();
      }
      const body: PreferencesPut = JSON.parse(String(init.body));
      sent.push(body);
      const settings = oldServer ? dropNewKeys({ revision: 0, settings: body.settings }).settings : body.settings;
      const { muted_panes: _dropped, ...older } = body;
      const saved = store.set(oldServer ? { ...older, settings } : { ...body, settings });
      const answer = oldServer ? dropNewKeys(saved) : saved;
      if (releaseAnswer) await releaseAnswer();
      answers++;
      for (const listener of [...answerListeners]) listener();
      return Response.json(answer);
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetchPreferences, { preconnect: globalThis.fetch.preconnect }));
    jest.useFakeTimers();
  });

  afterEach(async () => {
    jest.useRealTimers();
    await page.close();
    jest.restoreAllMocks();
    if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    rmSync(dir, { recursive: true, force: true });
  });

  const draw = () => page.render([...mounted.values()]);
  const unmountLast = () => {
    const id = [...mounted.keys()].at(-1);
    if (id === undefined) throw new Error("No client mounted");
    mounted.delete(id);
    return draw();
  };
  const unmountClients = () => {
    mounted.clear();
    return page.render(null);
  };
  const leavePage = (type: string): void => {
    const target = type === "visibilitychange" ? page.window.document : page.window;
    target.dispatchEvent(new page.window.Event(type));
  };

  async function open(raw: object = DEFAULT_SETTINGS, again = false): Promise<Client> {
    if (!again) page.window.localStorage.clear();
    page.window.localStorage.setItem("ovis:settings", JSON.stringify(raw));
    const unmounted = () => { throw new Error("not mounted"); };
    const client: Client = { known: false, settings: sanitizeSettings(raw), rendered: { id: "amber", mode: "dark" }, update: unmounted, receive: unmounted, saveError: null, paused: false, retrying: false, retry: unmounted, resubscribed: unmounted, disconnected: unmounted, closed: unmounted, rerender: unmounted };
    function Probe() {
      const context = useSettings();
      client.settings = context.settings;
      client.rendered = context.resolvedEntry;
      client.update = context.update;
      const sync = usePreferencesSync(syncEnabled);
      client.known = sync.known;
      client.receive = sync.receive;
      client.saveError = sync.saveError;
      client.paused = sync.paused;
      client.retrying = sync.retrying;
      client.retry = sync.retry;
      client.resubscribed = sync.resubscribed;
      client.disconnected = sync.disconnected;
      client.closed = sync.closed;
      return null;
    }
    const key = nextMount++;
    client.rerender = () => {
      mounted.set(key, createElement(SettingsProvider, { key, children: createElement(Probe) }));
      return draw();
    };
    await client.rerender();
    clients.push(client);
    return client;
  }

  async function windows(count = 1): Promise<void> {
    for (let index = 0; index < count; index++) await act(async () => { jest.advanceTimersByTime(600); });
  }
  // bun's fake timers stop every timer and clock, a setTimeout kept from before them too, so a wait is bounded in
  // turns of the event loop: what is waited for here follows from promises alone, before the loop turns once
  function bounded(message: string, listen: (arrived: () => void) => () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      let turns = 0;
      let waiting = true;
      const stop = listen(() => { waiting = false; stop(); resolve(); });
      const turn = (): void => {
        if (!waiting) return;
        if (++turns > 100) { stop(); reject(new Error(message)); } else setImmediate(turn);
      };
      setImmediate(turn);
    });
  }
  function nextAnswer(): Promise<void> {
    return bounded("preferences answer did not arrive", (arrived) => {
      answerListeners.add(arrived);
      return () => answerListeners.delete(arrived);
    });
  }
  function nextAbsorbed(): Promise<void> {
    // the answer is taken in once its pins are stored; React draws nothing before this act ends
    const storage = page.window.localStorage;
    return bounded("the answer's pins were not stored", (arrived) => {
      const { setItem, removeItem } = storage;
      const told = (key: string): void => { if (key === "ovis:sidebar-pins-shared") arrived(); };
      Object.defineProperties(storage, {
        setItem: { configurable: true, value: (key: string, value: string) => { setItem(key, value); told(key); } },
        removeItem: { configurable: true, value: (key: string) => { removeItem(key); told(key); } },
      });
      return () => {
        Object.defineProperties(storage, {
          setItem: { configurable: true, value: setItem },
          removeItem: { configurable: true, value: removeItem },
        });
      };
    });
  }
  async function send(): Promise<void> {
    const answered = nextAnswer();
    await act(async () => { jest.advanceTimersByTime(600); await answered; });
  }
  const seed = { theme: "dark", palette: "tokyo-night", darkTheme: "tokyo-night", lightTheme: "tokyo-night-day" };

  it.each(["before the PUT", "in the 409 response"] as const)("reapplies only local list edits and scalar choices when another writer is seen %s (#3261)", async (delivery) => {
    const original = ["local:w1:p1", "local:w1:p2"] satisfies [string, string];
    const local = [original[0], "local:w1:p3"];
    const remote = [original[1], "local:w1:p4"];
    store.set({ settings: { lockedAgents: original, language: "en" }, pins: original, muted_panes: original });
    const client = await open();
    const writer = () => store.set({ settings: { lockedAgents: remote, language: "ja", showThinking: false }, pins: remote, muted_panes: remote });
    beforeConditionalPut = () => undefined;
    await act(async () => {
      setSidebarPins(local);
      setPaneMutes(local);
      client.update({ lockedAgents: local, language: "ko" });
    });
    if (delivery === "before the PUT") await act(async () => { writer(); });
    else {
      clients.length = 0; // No event delivery: the conflict response itself must supply the newer lists.
      beforeConditionalPut = () => {
        beforeConditionalPut = () => undefined;
        writer();
      };
    }

    await windows(3);

    const merged = ["local:w1:p4", "local:w1:p3"];
    expect(bodies.map((body) => body.expected_revision)).toEqual(delivery === "before the PUT" ? [2] : [1, 2]);
    expect(store.get()).toMatchObject({ revision: 3, settings: { lockedAgents: merged, language: "ko", showThinking: false }, pins: merged, muted_panes: merged });
    expect(currentSidebarPins()).toEqual(merged);
    expect(currentPaneMutes()).toEqual(merged);
    expect(client.settings.lockedAgents).toEqual(merged);
    expect(client.saveError).toBeNull();
  });

  it.each(["manual", "automatic"] as const)("keeps the edit after repeated revision conflicts for %s retry", async (retry) => {
    store.set({ settings: {}, pins: ["local:w1:p1"] });
    const client = await open();
    beforeConditionalPut = () => { store.set({ settings: { showThinking: false } }); };
    await act(async () => { setSidebarPins(["local:w1:p1", "local:w1:p2"]); });

    await windows(8);

    expect(client.paused).toBe(true);
    expect(bodies).toHaveLength(4);
    expect(store.get().pins).toEqual(["local:w1:p1"]);
    expect(currentSidebarPins()).toEqual(["local:w1:p1", "local:w1:p2"]);
    beforeConditionalPut = () => undefined;
    if (retry === "manual") await act(async () => { client.retry(); });
    else await act(async () => { jest.advanceTimersByTime(60_000); });
    await windows();
    expect(store.get().pins).toEqual(["local:w1:p1", "local:w1:p2"]);
    expect(client.paused).toBe(false);
  });

  it("sends an expected revision only for whole-list writes, including keepalive", async () => {
    store.set({ settings: {}, pins: [] });
    const client = await open();
    await act(async () => { client.update({ language: "ko" }); });
    await send();
    await act(async () => { client.update({ language: "en" }); });
    await act(async () => { leavePage("pagehide"); });
    await act(async () => { client.update({ lockedAgents: ["local:w1:p1"] }); });
    await send();
    await act(async () => { setSidebarPins(["local:w1:p1"]); });
    await act(async () => { leavePage("pagehide"); });

    expect(keepalives).toEqual([false, true, false, true]);
    expect(bodies.map((body) => body.expected_revision)).toEqual([undefined, undefined, 3, 4]);
  });

  it("finishes manual Retry through a revision conflict while the event stream is disconnected", async () => {
    store.set({ settings: {}, pins: [] });
    const client = await open();
    refuse = unwritable();
    await act(async () => { setSidebarPins(["local:w1:p1"]); });
    await send();
    expect(client.saveError).not.toBeNull();

    await act(async () => { client.disconnected(); });
    clients.length = 0;
    store.set({ settings: {}, pins: ["local:w1:p2"] });
    beforeConditionalPut = () => undefined;
    await act(async () => { client.retry(); });
    await windows(3);

    expect(bodies.map((body) => body.expected_revision)).toEqual([1, 1, 2]);
    expect(store.get().pins).toEqual(["local:w1:p2", "local:w1:p1"]);
    expect([client.retrying, client.saveError]).toEqual([false, null]);
  });

  it.each(["dark", "light"] as const)("takes a restarted legacy-only %s palette in a fresh client without corrective PUTs", async (theme) => {
    store.set({ settings: { palette: "catppuccin" } });
    store.set({ settings: { theme } });
    store = new PreferenceStore(dir);
    expect(store.get()).toEqual(named({ revision: 2, settings: { palette: "catppuccin", theme }, muted_panes: [] }));
    revisions.length = 0;
    store.subscribe((doc) => {
      revisions.push(doc.revision);
      for (const client of clients) client.receive(doc);
    });
    const client = await open({});
    expect(client.settings.palette).toBe("catppuccin");
    expect(client.settings[theme === "dark" ? "darkTheme" : "lightTheme"]).toBe("catppuccin");
    expect(client.rendered).toMatchObject({ id: "catppuccin", mode: theme });
    expect(document.documentElement.dataset["palette"]).toBe("catppuccin");
    await windows(3);
    expect(store.get().revision).toBe(2);
    expect(revisions).toEqual([]);
    expect(answers).toBe(0);
  });

  it("says the server's settings are known only once they were read, so a stale copy here is not taken for them", async () => {
    store.set({ settings: { showUsage: false } });
    const gate = Promise.withResolvers<void>();
    releaseGet = () => gate.promise;
    const client = await open({ ...DEFAULT_SETTINGS, showUsage: true });
    expect(client.known).toBe(false);
    expect(client.settings.showUsage).toBe(true);
    const absorbed = nextAbsorbed();
    await act(async () => { gate.resolve(); await absorbed; });
    releaseGet = undefined;
    expect(client.known).toBe(true);
    expect(client.settings.showUsage).toBe(false);
  });

  it("keeps a migrated device-local System pair on upgrade without a correcting PUT (h3)", async () => {
    store.set({ settings: { theme: "system", palette: "amber" } });
    const client = await open({ theme: "system", palette: "amber", paletteDark: "charcoal", paletteLight: "catppuccin" });
    await windows(3);
    expect(client.settings.darkTheme).toBe("charcoal");
    expect(client.settings.lightTheme).toBe("catppuccin");
    expect(revisions).toEqual([1]);
  });

  it("keeps a raw catppuccin-latte id stable across two new clients (h5)", async () => {
    store.set({ settings: { theme: "light", darkTheme: "tokyo-night", lightTheme: "catppuccin-latte" } });
    const a = await open();
    const b = await open();
    await windows(3);
    expect([a.settings.palette, b.settings.palette]).toEqual(["catppuccin-latte", "catppuccin-latte"]);
    expect(revisions).toEqual([1]);
    expect(answers).toBe(0);
  });

  it("takes one old palette write in three new clients without extra PUTs (h, h6)", async () => {
    store.set({ settings: seed });
    const group = [await open(), await open(), await open()];
    await act(async () => { store.set({ settings: { palette: "catppuccin" } }); });
    await windows(3);
    expect(group.map((client) => client.settings.darkTheme)).toEqual(["catppuccin", "catppuccin", "catppuccin"]);
    expect(group.map((client) => client.settings.palette)).toEqual(["catppuccin", "catppuccin", "catppuccin"]);
    expect(revisions).toEqual([1, 2]);
    expect(answers).toBe(0);
  });

  it.each(["charcoal", "amber"] as const)("persists an explicit old-tab %s choice arriving through a new server (f2, f3)", async (palette) => {
    store.set({ settings: seed });
    const client = await open(seed);
    await act(async () => { store.set({ settings: { palette } }); });
    await windows(3);
    expect(client.settings.darkTheme).toBe(palette);
    expect(JSON.parse(page.window.localStorage.getItem("ovis:themes") ?? "{}").darkTheme).toBe(palette);
    expect(revisions).toEqual([1, 2]);
  });

  it.each(["pagehide", "visibilitychange"])("sends a change at once, to outlive the page, on %s", async (type) => {
    const client = await open();
    await act(async () => { client.update({ showUsage: !DEFAULT_SETTINGS.showUsage }); });

    // When the page closes, or is hidden (a phone may kill it then).
    Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => { leavePage(type); });

    expect(keepalives).toEqual([true]);
    expect(store.get().settings.showUsage).toBe(!DEFAULT_SETTINGS.showUsage);
    await windows(3);
    expect(bodies).toHaveLength(1);
  });

  it("saves a list edit when the page goes while another save's answer is pending", async () => {
    store.set({ settings: {}, pins: [] });
    const gate = Promise.withResolvers<void>();
    releaseAnswer = () => gate.promise;
    const client = await open();
    await act(async () => { client.update({ showUsage: !DEFAULT_SETTINGS.showUsage }); });
    await windows();
    expect(store.get().revision).toBe(2);
    beforeConditionalPut = () => undefined;
    await act(async () => { client.update({ showThinking: !DEFAULT_SETTINGS.showThinking }); });
    await act(async () => { setSidebarPins(["local:w1:p1"]); });

    await act(async () => { leavePage("pagehide"); });

    expect(keepalives).toEqual([false, true]);
    expect(bodies[1]).not.toHaveProperty("expected_revision");
    expect(bodies[1]?.settings).toMatchObject({ showUsage: !DEFAULT_SETTINGS.showUsage, showThinking: !DEFAULT_SETTINGS.showThinking });
    expect(store.get().pins).toEqual(["local:w1:p1"]);
    await act(async () => { gate.resolve(); });
    releaseAnswer = undefined;
  });

  it("sends a change once when the page is hidden and then goes, and nothing when it shows again", async () => {
    const gate = Promise.withResolvers<void>();
    releaseAnswer = () => gate.promise;
    const client = await open();
    await act(async () => { client.update({ showUsage: !DEFAULT_SETTINGS.showUsage }); });

    // When the page is hidden, then goes, before the answer (a reload fires both).
    Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => { leavePage("visibilitychange"); leavePage("pagehide"); });

    expect(keepalives).toEqual([true]);
    const answered = nextAnswer();
    await act(async () => { gate.resolve(); await answered; });
    releaseAnswer = undefined;

    Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => { leavePage("visibilitychange"); });
    await windows(3);
    expect(keepalives).toEqual([true]);
  });

  it.each([
    ["sends it again", false],
    ["takes a newer value saved elsewhere instead", true],
  ] as const)("when the request on the way out of a reload is lost, the reloaded page %s", async (_name, savedElsewhere) => {
    const on = !DEFAULT_SETTINGS.showUsage;
    const client = await open();
    await act(async () => { client.update({ showUsage: on }); });
    await send();
    await act(async () => { client.update({ showUsage: !on }); });
    refusing = () => Promise.reject(new TypeError("Failed to fetch"));
    await act(async () => { leavePage("pagehide"); });
    await unmountLast();
    clients.length = 0;
    refusing = null;
    expect(store.get().settings.showUsage).toBe(on);
    if (savedElsewhere) store.set({ settings: { showUsage: on } });

    const reloaded = await open(JSON.parse(page.window.localStorage.getItem("ovis:settings")!), true);
    await windows(3);

    expect(store.get().settings.showUsage).toBe(savedElsewhere ? on : !on);
    expect(reloaded.settings.showUsage).toBe(savedElsewhere ? on : !on);
  });

  it("sends nothing on its way out when nothing changed", async () => {
    await open();
    Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => { leavePage("pagehide"); leavePage("visibilitychange"); });
    await windows(3);
    expect(bodies).toEqual([]);
  });

  it.each([["drawn", true], ["not drawn yet", false]] as const)("sends and carries an edit made just before the page goes, %s", async (_name, drawn) => {
    const on = !DEFAULT_SETTINGS.showUsage;
    const client = await open();
    await act(async () => { client.update({ darkTheme: "gruvbox" }); });
    if (drawn) await act(async () => { client.update({ showUsage: on }); });

    await act(async () => {
      if (!drawn) client.update({ showUsage: on });
      leavePage("pagehide");
    });

    expect(bodies.map((body) => [body.settings.darkTheme, body.settings.showUsage])).toEqual([["gruvbox", on]]);
    expect(JSON.parse(window.sessionStorage.getItem("ovis:preferences-unsent")!).settings).toMatchObject({ darkTheme: "gruvbox", showUsage: on });
  });

  it.each([["drawn", true], ["not drawn yet", false]] as const)("a pick taken back as its send wait ends, %s, is not sent", async (_name, drawn) => {
    store.set({ settings: { darkTheme: "tokyo-night" } });
    const client = await open();
    await act(async () => { client.update({ darkTheme: "gruvbox" }); });
    if (drawn) await act(async () => { client.update({ darkTheme: "tokyo-night" }); });

    await act(async () => {
      if (!drawn) client.update({ darkTheme: "tokyo-night" });
      jest.advanceTimersByTime(600);
    });

    await windows(3);
    expect(bodies).toEqual([]);
    expect(store.get().revision).toBe(1);
  });

  it("sends a new dark choice once and another client takes it (i)", async () => {
    const a = await open();
    const b = await open();
    await act(async () => { a.update({ darkTheme: "tokyo-night" }); });
    await send();
    expect(answers).toBe(1);
    expect(b.settings.darkTheme).toBe("tokyo-night");
    await windows(3);
    expect(revisions).toEqual([1]);
  });

  it("acknowledges keys an old server dropped and resumes after upgrade without loops (j)", async () => {
    oldServer = true;
    const client = await open();
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await send();
    expect(answers).toBe(1);
    expect(client.settings.darkTheme).toBe("tokyo-night");
    expect(store.get().settings.palette).toBe("tokyo-night");
    await windows(3);
    expect(revisions).toEqual([1]);
    oldServer = false;
    await act(async () => { client.update({ darkTheme: "gruvbox" }); });
    await send();
    expect(store.get().settings.darkTheme).toBe("gruvbox");
    await windows(3);
    expect(revisions).toEqual([1, 2]);
  });

  it("acknowledges the sent dropped value without swallowing a later in-flight edit", async () => {
    oldServer = true;
    const gate = Promise.withResolvers<void>();
    releaseAnswer = () => gate.promise;
    const client = await open();
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await windows();
    expect(revisions).toEqual([1]);
    await act(async () => { client.update({ darkTheme: "gruvbox" }); });
    const answered = nextAnswer();
    await act(async () => { gate.resolve(); await answered; });
    releaseAnswer = undefined;
    await send();
    expect(client.settings.darkTheme).toBe("gruvbox");
    expect(store.get().settings.palette).toBe("gruvbox");
    await windows(3);
    expect(revisions).toEqual([1, 2]);
  });

  it("keeps an edit whose page has not drawn it yet when the answer to the save on its way lands", async () => {
    const gate = Promise.withResolvers<void>();
    releaseAnswer = () => gate.promise;
    const client = await open();
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await windows();
    const absorbed = nextAbsorbed();
    await act(async () => {
      client.update({ darkTheme: "gruvbox" });
      gate.resolve();
      await absorbed;
    });
    releaseAnswer = undefined;
    expect(client.settings.darkTheme).toBe("gruvbox");
    await send();
    expect(store.get().settings.darkTheme).toBe("gruvbox");
  });

  it.each([["drawn", true], ["not drawn yet", false]] as const)("a pick %s that the save's answer already holds gives way to a newer save held behind it", async (_name, drawn) => {
    const gate = Promise.withResolvers<void>();
    releaseAnswer = () => gate.promise;
    const client = await open();
    // this tab first hears about gruvbox in the answer to its unrelated PUT
    clients.pop();
    store.set({ settings: { darkTheme: "gruvbox" } });
    clients.push(client);
    await act(async () => { client.update({ showThinking: true }); });
    await windows();
    await act(async () => { store.set({ settings: { darkTheme: "tokyo-night" } }); });

    if (drawn) await act(async () => { client.update({ darkTheme: "gruvbox" }); });
    const absorbed = nextAbsorbed();
    await act(async () => {
      if (!drawn) client.update({ darkTheme: "gruvbox" });
      gate.resolve();
      await absorbed;
    });
    releaseAnswer = undefined;
    expect(client.settings.darkTheme).toBe("tokyo-night");
    await windows(3);
    expect(sent.map((body) => body.settings.darkTheme)).toEqual([undefined]);
    expect(store.get().settings.darkTheme).toBe("tokyo-night");
  });

  it("a tab takes a save's value from the server while the tab that sent it has already stored a newer pick", async () => {
    const gate = Promise.withResolvers<void>();
    releaseAnswer = () => gate.promise;
    const a = await open();
    const b = await open();
    // a's event stream brings the save after b's next pick, as a real one does
    clients.splice(clients.indexOf(a), 1);
    await act(async () => { b.update({ darkTheme: "catppuccin" }); });
    await windows();
    await act(async () => { b.update({ darkTheme: "gruvbox" }); });
    const answered = nextAnswer();
    await act(async () => { gate.resolve(); await answered; });
    releaseAnswer = undefined;
    clients.push(a);

    await act(async () => { a.receive(store.get()); });
    expect([a.settings.darkTheme, b.settings.darkTheme]).toEqual(["catppuccin", "gruvbox"]);
    await windows(3);

    expect(store.get().settings.darkTheme).toBe("gruvbox");
    expect(sent.map((body) => body.settings.darkTheme)).toEqual(["catppuccin", "gruvbox"]);
    expect([a.settings.darkTheme, b.settings.darkTheme]).toEqual(["gruvbox", "gruvbox"]);
  });

  it("a tab that missed a Chat Markdown pick does not send it back over a newer one when it hears from the server again", async () => {
    const a = await open();
    const b = await open();
    // b's event stream is down: it hears of a's pick only through the browser's storage
    clients.splice(clients.indexOf(b), 1);
    await act(async () => { a.update({ markdownStyle: "tinted" }); });
    await send();
    await act(async () => { page.window.dispatchEvent(new page.window.StorageEvent("storage", { key: "ovis:markdown-style", storageArea: page.window.localStorage })); });
    clients.splice(clients.indexOf(a), 1);
    store.set({ settings: { markdownStyle: "colorful" } });
    clients.push(b);
    await act(async () => { b.receive(store.get()); });
    await windows(3);

    expect(b.settings.markdownStyle).toBe("colorful");
    expect(store.get().settings.markdownStyle).toBe("colorful");
    expect(sent.map((body) => body.settings.markdownStyle)).toEqual(["tinted"]);
  });

  it("a save answered after its page's settings tree is gone leaves what another tab stored since", async () => {
    const gate = Promise.withResolvers<void>();
    releaseAnswer = () => gate.promise;
    const client = await open();
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await windows();
    await act(async () => { store.set({ settings: { darkTheme: "catppuccin" } }); });
    await unmountLast();
    clients.length = 0;

    let pick: (patch: Partial<Settings>) => void = () => { throw new Error("not mounted"); };
    function OtherTab() {
      pick = useSettings().update;
      return null;
    }
    const key = nextMount++;
    mounted.set(key, createElement(SettingsProvider, { key, children: createElement(OtherTab) }));
    await draw();
    await act(async () => { pick({ darkTheme: "gruvbox" }); });
    const storedTheme = (): unknown => JSON.parse(page.window.localStorage.getItem("ovis:settings")!).darkTheme;
    expect(storedTheme()).toBe("gruvbox");

    const absorbed = nextAbsorbed();
    await act(async () => { gate.resolve(); await absorbed; });
    releaseAnswer = undefined;
    expect(storedTheme()).toBe("gruvbox");
  });

  it("a return to the value on its way, not drawn yet, gives way to a newer save held behind the answer, as it does once drawn", async () => {
    const gate = Promise.withResolvers<void>();
    releaseAnswer = () => gate.promise;
    const client = await open();
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await windows();
    await act(async () => { client.update({ darkTheme: "gruvbox" }); });
    await act(async () => { store.set({ settings: { darkTheme: "catppuccin" } }); });

    const absorbed = nextAbsorbed();
    await act(async () => {
      client.update({ darkTheme: "tokyo-night" });
      gate.resolve();
      await absorbed;
    });
    releaseAnswer = undefined;

    expect(client.settings.darkTheme).toBe("catppuccin");
    await windows(3);
    expect(sent.map((body) => body.settings.darkTheme)).toEqual(["tokyo-night"]);
    expect(store.get().settings.darkTheme).toBe("catppuccin");
  });

  it("a reloaded page keeps an edit it has not drawn yet when the answer to the change it sent again lands", async () => {
    const client = await open();
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    refusing = () => Promise.reject(new TypeError("Failed to fetch"));
    await act(async () => { leavePage("pagehide"); });
    await unmountLast();
    clients.length = 0;
    refusing = null;
    const gate = Promise.withResolvers<void>();
    releaseAnswer = () => gate.promise;
    const reloaded = await open(JSON.parse(page.window.localStorage.getItem("ovis:settings")!), true);
    await windows();
    expect(keepalives).toEqual([true, false]);
    expect(bodies[1]?.settings).toMatchObject({ darkTheme: "tokyo-night" });

    const absorbed = nextAbsorbed();
    await act(async () => {
      reloaded.update({ darkTheme: "gruvbox" });
      gate.resolve();
      await absorbed;
    });
    releaseAnswer = undefined;
    expect(reloaded.settings.darkTheme).toBe("gruvbox");
    await send();
    expect(store.get().settings.darkTheme).toBe("gruvbox");
  });

  it.each([
    ["holds that setting", "drawn", true, true],
    ["holds that setting", "not drawn yet", true, false],
    ["lacks that setting", "drawn", false, true],
    ["lacks that setting", "not drawn yet", false, false],
  ] as const)("a reloaded page whose first document %s sends its carried change again after a return to it, %s", async (_doc, _name, held, drawn) => {
    store.set({ settings: held ? { darkTheme: "catppuccin" } : { showThinking: true } });
    const client = await open();
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    refusing = () => Promise.reject(new TypeError("Failed to fetch"));
    await act(async () => { leavePage("pagehide"); });
    await unmountLast();
    clients.length = 0;
    refusing = null;
    const gate = Promise.withResolvers<void>();
    releaseGet = () => gate.promise;
    const reloaded = await open(JSON.parse(page.window.localStorage.getItem("ovis:settings")!), true);
    await act(async () => { reloaded.update({ darkTheme: "gruvbox" }); });
    if (drawn) await act(async () => { reloaded.update({ darkTheme: "tokyo-night" }); });

    const absorbed = nextAbsorbed();
    await act(async () => {
      if (!drawn) reloaded.update({ darkTheme: "tokyo-night" });
      gate.resolve();
      await absorbed;
    });
    releaseGet = undefined;

    expect(reloaded.settings.darkTheme).toBe("tokyo-night");
    await windows(3);
    expect(sent.map((body) => body.settings.darkTheme)).toEqual(["tokyo-night"]);
    expect(store.get().settings.darkTheme).toBe("tokyo-night");
  });

  it.each([["drawn", true], ["not drawn yet", false]] as const)("a first page that returns to its own value before the first document, %s, takes the server's value and sends nothing", async (_name, drawn) => {
    store.set({ settings: { darkTheme: "catppuccin" } });
    const gate = Promise.withResolvers<void>();
    releaseGet = () => gate.promise;
    const client = await open({ ...DEFAULT_SETTINGS, darkTheme: "tokyo-night" });
    await act(async () => { client.update({ darkTheme: "gruvbox" }); });
    if (drawn) await act(async () => { client.update({ darkTheme: "tokyo-night" }); });

    const absorbed = nextAbsorbed();
    await act(async () => {
      if (!drawn) client.update({ darkTheme: "tokyo-night" });
      gate.resolve();
      await absorbed;
    });
    releaseGet = undefined;

    expect(client.settings.darkTheme).toBe("catppuccin");
    await windows(3);
    expect(sent).toEqual([]);
  });

  /** A page that goes with `edit` unsent, its request on the way out lost, and comes back in the same tab: the reloaded page's first document waits for `first`. */
  async function reloadCarrying(edit: Partial<Settings>, boot: object = DEFAULT_SETTINGS): Promise<{ reloaded: Client; first: () => Promise<void> }> {
    const client = await open(boot);
    await act(async () => { client.update(edit); });
    refusing = () => Promise.reject(new TypeError("Failed to fetch"));
    await act(async () => { leavePage("pagehide"); });
    await unmountLast();
    clients.length = 0;
    refusing = null;
    const gate = Promise.withResolvers<void>();
    releaseGet = () => gate.promise;
    const reloaded = await open(JSON.parse(page.window.localStorage.getItem("ovis:settings")!), true);
    const first = async (): Promise<void> => {
      const absorbed = nextAbsorbed();
      gate.resolve();
      await absorbed;
      releaseGet = undefined;
    };
    return { reloaded, first };
  }
  /** each step drawn before the next, or all of them before React draws once: the two must end the same */
  async function inOrder(drawn: boolean, steps: (() => void | Promise<void>)[]): Promise<void> {
    if (drawn) for (const step of steps) await act(async () => { await step(); });
    else await act(async () => { for (const step of steps) await step(); });
  }
  const orders = [["each drawn before the next", true], ["all before one render", false]] as const;

  it.each(orders)("a reloaded page keeps a return to its carried change when another browser's save follows a first document that lacks the setting, %s", async (_name, drawn) => {
    store.set({ settings: { showThinking: true } });
    const { reloaded, first } = await reloadCarrying({ darkTheme: "tokyo-night" });
    await act(async () => { reloaded.update({ darkTheme: "gruvbox" }); });

    await inOrder(drawn, [
      () => reloaded.update({ darkTheme: "tokyo-night" }),
      first,
      () => { store.set({ settings: { darkTheme: "catppuccin" } }); },
    ]);

    expect(reloaded.settings.darkTheme).toBe("tokyo-night");
    await windows(3);
    expect(sent.map((body) => body.settings.darkTheme)).toEqual(["tokyo-night"]);
    expect(store.get().settings.darkTheme).toBe("tokyo-night");
  });

  it.each(orders)("a reloaded page that returns to its carried change only after its first document gives way to another browser's save, %s", async (_name, drawn) => {
    store.set({ settings: { showThinking: true } });
    const { reloaded, first } = await reloadCarrying({ darkTheme: "tokyo-night" });

    await inOrder(drawn, [
      () => reloaded.update({ darkTheme: "gruvbox" }),
      first,
      () => reloaded.update({ darkTheme: "tokyo-night" }),
      () => { store.set({ settings: { darkTheme: "catppuccin" } }); },
    ]);

    expect(reloaded.settings.darkTheme).toBe("catppuccin");
    await windows(3);
    expect(sent).toEqual([]);
    expect(store.get().settings.darkTheme).toBe("catppuccin");
  });

  it.each(orders)("a reloaded page whose carried change another browser saved as it was sends nothing, and takes the save after that, %s", async (_name, drawn) => {
    store.set({ settings: { showThinking: true } });
    const { reloaded, first } = await reloadCarrying({ darkTheme: "tokyo-night" });
    await act(async () => { reloaded.update({ darkTheme: "gruvbox" }); });

    await inOrder(drawn, [
      () => reloaded.update({ darkTheme: "tokyo-night" }),
      first,
      () => { store.set({ settings: { darkTheme: "tokyo-night" } }); },
    ]);
    await act(async () => { store.set({ settings: { darkTheme: "catppuccin" } }); });

    expect(reloaded.settings.darkTheme).toBe("catppuccin");
    await windows(3);
    expect(sent).toEqual([]);
    expect(store.get().settings.darkTheme).toBe("catppuccin");
  });

  it.each(orders)("a reloaded page keeps a return to its carried change through three documents and an edit between them, %s", async (_name, drawn) => {
    const on = !DEFAULT_SETTINGS.showUsage;
    store.set({ settings: { showThinking: true } });
    const { reloaded, first } = await reloadCarrying({ darkTheme: "tokyo-night" });
    await act(async () => { reloaded.update({ darkTheme: "gruvbox" }); });

    await inOrder(drawn, [
      () => reloaded.update({ darkTheme: "tokyo-night" }),
      first,
      () => reloaded.update({ showUsage: on }),
      () => { store.set({ settings: { showThinking: false } }); },
      () => { store.set({ settings: { darkTheme: "catppuccin" } }); },
    ]);

    expect([reloaded.settings.darkTheme, reloaded.settings.showThinking, reloaded.settings.showUsage]).toEqual(["tokyo-night", false, on]);
    await windows(3);
    expect(sent.map((body) => [body.settings.darkTheme, body.settings.showUsage])).toEqual([["tokyo-night", on]]);
    expect(store.get().settings).toMatchObject({ darkTheme: "tokyo-night", showUsage: on, showThinking: false });
  });

  it.each(orders)("a reloaded page whose first document holds no settings sends its carried change again after a return to it, %s", async (_name, drawn) => {
    const { reloaded, first } = await reloadCarrying({ darkTheme: "tokyo-night" });
    await act(async () => { reloaded.update({ darkTheme: "gruvbox" }); });

    await inOrder(drawn, [() => reloaded.update({ darkTheme: "tokyo-night" }), first]);

    expect(reloaded.settings.darkTheme).toBe("tokyo-night");
    await windows(3);
    expect(sent.map((body) => body.settings.darkTheme)).toEqual(["tokyo-night"]);
    expect(store.get().settings.darkTheme).toBe("tokyo-night");
  });

  it.each(orders)("a reloaded page that left its carried theme mode sends the mode alone when its first document holds only an old palette, %s", async (_name, drawn) => {
    store.set({ settings: { palette: "catppuccin" } });
    const { reloaded, first } = await reloadCarrying({ theme: "light" }, { ...DEFAULT_SETTINGS, theme: "system", darkTheme: "catppuccin", lightTheme: "tokyo-night" });

    await inOrder(drawn, [() => reloaded.update({ theme: "system" }), first]);

    await windows(3);
    expect(sent.map((body) => body.settings)).toEqual([{ theme: "system" }]);
    expect(store.get().settings).toEqual({ theme: "system", palette: "catppuccin" });
  });

  it("keeps pins and a mute this tab has not drawn yet when another browser's document lands, and sends them", async () => {
    store.set({ settings: {}, pins: ["local:w1:p1"] });
    const client = await open();
    expect([currentSidebarPins(), currentPaneMutes()]).toEqual([["local:w1:p1"], []]);

    await act(async () => {
      setSidebarPins(["local:w1:p1", "local:w1:p2"]);
      setPaneMutes(["w1:p1"]);
      store.set({ settings: { showThinking: true } });
    });

    expect(client.settings.showThinking).toBe(true);
    expect([currentSidebarPins(), currentPaneMutes()]).toEqual([["local:w1:p1", "local:w1:p2"], ["w1:p1"]]);
    await send();
    expect(store.get()).toMatchObject({ pins: ["local:w1:p1", "local:w1:p2"], muted_panes: ["w1:p1"], settings: { showThinking: true } });
  });

  it("says in plain words that the server cannot save, and clears it once the retried change lands", async () => {
    const client = await open();
    expect(client.saveError).toBeNull();
    refuse = Response.json({ error: { code: "preferences_unwritable", message: "EACCES: permission denied, open '/state/preferences.json.7.tmp'" } }, { status: 500 });
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await send();
    expect(refusals).toBe(1);
    expect(answers).toBe(0);
    expect(store.get().revision).toBe(0);
    expect(client.saveError).toEqual({ message: "The server cannot save settings: check that its state folder is writable.", detail: "EACCES: permission denied, open '/state/preferences.json.7.tmp'" });
    await act(async () => { jest.advanceTimersByTime(5_000); });
    await send();
    expect(answers).toBe(1);
    expect(client.saveError).toBeNull();
    expect(store.get().settings.darkTheme).toBe("tokyo-night");
    await windows(3);
    expect(revisions).toEqual([1]);
  });

  it("older server without muted_panes stays unsupported", async () => {
    oldServer = true;
    const client = await open();
    await windows(3);
    expect(currentPaneMutes()).toBeNull();
    expect(answers).toBe(0);
    await act(async () => { client.update({ showThinking: true }); });
    await send();
    expect(sent).toEqual([{ expected_revision: 0, settings: { showThinking: true }, pins: [] }]);
    expect(currentPaneMutes()).toBeNull();
    oldServer = false;
    await act(async () => { store.set({ settings: { theme: "light" } }); });
    await windows(3);
    expect(currentPaneMutes()).toEqual([]);
    expect(answers).toBe(1);
    expect(revisions).toEqual([1, 2]);
  });

  it("a server that stops keeping muted_panes leaves no mute in force", async () => {
    store.set({ settings: {}, muted_panes: ["w1:p1"] });
    const client = await open();
    await windows(3);
    expect(currentPaneMutes()).toEqual(["w1:p1"]);
    oldServer = true;
    await act(async () => { store.set({ settings: { theme: "light" } }); });
    await windows(3);
    expect(revisions).toEqual([1, 2]);
    expect(currentPaneMutes()).toBeNull();
    expect(answers).toBe(0);
    await act(async () => { client.update({ showThinking: true }); });
    await send();
    expect(sent).toEqual([{ expected_revision: 2, settings: { showThinking: true }, pins: [] }]);
    expect(currentPaneMutes()).toBeNull();
  });

  it("a page opened again keeps a pin another client removed meanwhile removed, instead of sending its own back", async () => {
    store.set({ settings: {}, pins: [] });
    await open();
    await windows();
    await act(async () => { setSidebarPins(["local:t1"]); });
    await send();
    expect(store.get().pins).toEqual(["local:t1"]);
    await unmountClients();
    clients.length = 0;
    store.set({ settings: {}, pins: [] });
    const before = sent.length;
    await open(DEFAULT_SETTINGS, true);
    await windows(3);
    expect(store.get().pins).toEqual([]);
    expect(currentSidebarPins()).toEqual([]);
    expect(sent.slice(before)).toEqual([]);
  });

  it("a page opened again on a server that holds no pins any more shares its own with its next change", async () => {
    store.set({ settings: {}, pins: [] });
    await open();
    await windows();
    await act(async () => { setSidebarPins(["local:t1"]); });
    await send();
    await unmountClients();
    clients.length = 0;
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "herdr-sync-hook-"));
    store = new PreferenceStore(dir);
    store.subscribe((doc) => { for (const client of clients) client.receive(doc); });
    const client = await open(DEFAULT_SETTINGS, true);
    await windows();
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await send();
    expect(store.get().pins).toEqual(["local:t1"]);
  });

  it("a page opened again on a server started over that already holds other pins keeps its own too", async () => {
    store.set({ settings: {}, pins: [] });
    await open();
    await windows();
    await act(async () => { setSidebarPins(["local:t1"]); });
    await send();
    await unmountClients();
    clients.length = 0;
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "herdr-sync-hook-"));
    store = new PreferenceStore(dir);
    store.set({ settings: {}, pins: ["local:t2"] });
    store.subscribe((doc) => { for (const client of clients) client.receive(doc); });
    const client = await open(DEFAULT_SETTINGS, true);
    await windows();
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await send();
    expect(store.get().pins).toEqual(["local:t2", "local:t1"]);
  });

  for (const saves of [2, 3]) it(`a page opened again on a server started over whose saves reached revision ${saves} keeps its own pins too`, async () => {
    store.set({ settings: {}, pins: [] });
    await open();
    await windows();
    await act(async () => { setSidebarPins(["local:t1"]); });
    await send();
    expect(store.get().revision).toBe(2);
    await unmountClients();
    clients.length = 0;
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "herdr-sync-hook-"));
    store = new PreferenceStore(dir);
    for (let index = 0; index < saves; index += 1) store.set({ settings: {}, pins: ["local:t2"] });
    expect(store.get().revision).toBe(saves);
    store.subscribe((doc) => { for (const client of clients) client.receive(doc); });
    const client = await open(DEFAULT_SETTINGS, true);
    await windows();
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await send();
    expect(store.get().pins).toEqual(["local:t2", "local:t1"]);
  });

  it("a page that took a baseline from a release naming no folder does not bring back a pin removed after the upgrade", async () => {
    store.set({ settings: {}, pins: [] });
    await open();
    await windows();
    await act(async () => { setSidebarPins(["local:t1"]); });
    await send();
    await unmountClients();
    clients.length = 0;
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "herdr-sync-hook-"));
    store = new PreferenceStore(dir);
    for (let index = 0; index < 3; index += 1) store.set({ settings: {}, pins: ["local:t1"] });
    rmSync(join(dir, "preferences-id.json"));
    store = new PreferenceStore(dir);
    store.subscribe((doc) => { for (const client of clients) client.receive(doc); });
    oldServer = true;
    await open(DEFAULT_SETTINGS, true);
    await windows();
    await unmountClients();
    clients.length = 0;
    oldServer = false;
    store.set({ settings: {}, pins: [] });
    const client = await open(DEFAULT_SETTINGS, true);
    await windows();
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await send();
    expect(store.get().pins).toEqual([]);
  });

  it("mute survives restart and another browser", async () => {
    const a = await open();
    await windows();
    expect(currentPaneMutes()).toEqual([]);
    await act(async () => { setPaneMutes(["w1:p1"]); });
    await send();
    expect(answers).toBe(1);
    expect(sent).toEqual([{ expected_revision: 0, settings: {}, pins: [], muted_panes: ["w1:p1"] }]);
    expect(store.get().muted_panes).toEqual(["w1:p1"]);
    expect(a.saveError).toBeNull();
    await windows(3);
    expect(revisions).toEqual([1]);
    store = new PreferenceStore(dir);
    expect(store.get().muted_panes).toEqual(["w1:p1"]);
    store.subscribe((doc) => { revisions.push(doc.revision); for (const client of clients) client.receive(doc); });
    setPaneMutes(null);
    await open();
    await windows(3);
    expect(currentPaneMutes()).toEqual(["w1:p1"]);
    expect(answers).toBe(1);
    expect(revisions).toEqual([1]);
    await act(async () => { setPaneMutes([]); });
    await send();
    expect(sent.at(-1)).toEqual({ expected_revision: 1, settings: {}, muted_panes: [] });
    expect(store.get().muted_panes).toEqual([]);
    expect(currentPaneMutes()).toEqual([]);
  });

  it.each([
    [403, "forbidden"],
    [404, "not_found"],
  ] as const)("clears a save error when the server stops accepting saves with %s", async (status, code) => {
    const client = await open();
    refuse = Response.json({ error: { code: "preferences_unwritable" } }, { status: 500 });
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await send();
    expect(client.saveError).not.toBeNull();

    refuse = Response.json({ error: { code } }, { status });
    await act(async () => { jest.advanceTimersByTime(5_000); });
    await send();
    expect(refusals).toBe(2);
    expect(refuse).toBeNull();
    expect(client.saveError).toBeNull();
  });

  const unwritable = () => Response.json({ error: { code: "preferences_unwritable", message: "EACCES: permission denied" } }, { status: 500 });
  async function failSaves(count: number): Promise<void> {
    await send();
    for (let index = 1; index < count; index++) {
      await act(async () => { jest.advanceTimersByTime(5_000); });
      await send();
    }
  }
  async function longWait(): Promise<void> {
    for (let index = 0; index < 4; index++) {
      await act(async () => { jest.advanceTimersByTime(5_000); });
      await windows();
    }
  }

  it("pauses after three consecutive failed saves", async () => {
    const client = await open();
    refusing = unwritable;
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await failSaves(2);
    expect(refusals).toBe(2);
    expect(client.paused).toBe(false);
    await act(async () => { jest.advanceTimersByTime(5_000); });
    await send();
    expect(refusals).toBe(3);
    expect(client.paused).toBe(true);
    await longWait();
    expect(refusals).toBe(3);
    expect(answers).toBe(0);
    expect(client.saveError?.message).toBe("The server cannot save settings: check that its state folder is writable.");
    expect(client.settings.darkTheme).toBe("tokyo-night");

    refusing = null;
    await act(async () => { client.retry(); });
    expect(client.retrying).toBe(true);
    await send();
    expect(answers).toBe(1);
    expect([client.saveError, client.paused, client.retrying]).toEqual([null, false, false]);
    expect(store.get().settings.darkTheme).toBe("tokyo-night");
    refusing = unwritable;
    await act(async () => { client.update({ darkTheme: "gruvbox" }); });
    await failSaves(2);
    expect(client.paused).toBe(false);
  });

  it("an unreachable PC pauses the same way", async () => {
    const client = await open();
    refusing = () => { throw new TypeError("Failed to fetch"); };
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await failSaves(3);
    await longWait();
    expect([refusals, client.paused, client.saveError !== null]).toEqual([3, true, true]);
  });

  it("edits while paused do not restart retries", async () => {
    const client = await open();
    refusing = unwritable;
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await failSaves(3);
    expect(client.paused).toBe(true);
    await act(async () => { client.update({ lightTheme: "catppuccin" }); });
    await act(async () => { setSidebarPins(["local:w1:p1"]); });
    await longWait();
    expect(refusals).toBe(3);
    expect(client.paused).toBe(true);

    refusing = null;
    await act(async () => { client.retry(); });
    await send();
    expect(bodies.length).toBe(4);
    expect(bodies[3]).toEqual({ expected_revision: 0, settings: { darkTheme: "tokyo-night", lightTheme: "catppuccin", palette: "tokyo-night" }, pins: ["local:w1:p1"] });
    expect(store.get()).toMatchObject({ settings: { darkTheme: "tokyo-night", lightTheme: "catppuccin" }, pins: ["local:w1:p1"] });
    expect(client.saveError).toBeNull();
  });

  it("retry sends latest pending intent without losing in-flight edits", async () => {
    const client = await open();
    refusing = unwritable;
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await failSaves(3);
    await act(async () => { client.update({ darkTheme: "gruvbox" }); });
    refusing = null;
    const gate = Promise.withResolvers<void>();
    releaseAnswer = () => gate.promise;
    await act(async () => { client.retry(); });
    await windows();
    expect(client.retrying).toBe(true);
    await act(async () => { client.retry(); });
    await act(async () => { client.update({ lightTheme: "catppuccin" }); });
    await windows(3);
    expect(bodies.length).toBe(4);
    expect(bodies[3]?.settings).toMatchObject({ darkTheme: "gruvbox" });
    expect(bodies[3]?.settings).not.toHaveProperty("lightTheme");

    const answered = nextAnswer();
    await act(async () => { gate.resolve(); await answered; });
    releaseAnswer = undefined;
    expect(client.settings.lightTheme).toBe("catppuccin");
    expect(client.saveError).not.toBeNull();
    await send();
    expect(bodies.length).toBe(5);
    expect(bodies[4]?.settings).toMatchObject({ lightTheme: "catppuccin" });
    expect(client.saveError).toBeNull();
    expect(store.get().settings).toMatchObject({ darkTheme: "gruvbox", lightTheme: "catppuccin" });
    expect(bodies.slice(3).some((body) => body.settings.darkTheme === "tokyo-night")).toBe(false);
  });

  it("unchanged opening document can resume after reconnect", async () => {
    const client = await open();
    refusing = unwritable;
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await failSaves(3);
    expect(client.paused).toBe(true);
    await act(async () => { client.receive(store.get()); });
    await longWait();
    expect(refusals).toBe(3);

    await act(async () => { client.resubscribed(); client.receive(store.get()); });
    expect(client.paused).toBe(false);
    await failSaves(3);
    expect(refusals).toBe(6);
    expect(client.paused).toBe(true);
    await longWait();
    expect(refusals).toBe(6);

    refusing = null;
    await act(async () => { client.resubscribed(); client.receive(store.get()); });
    await send();
    expect(answers).toBe(1);
    expect(client.saveError).toBeNull();
    expect(store.get().settings.darkTheme).toBe("tokyo-night");
  });

  it("takes the server's value on a read-only device even when a local pick has not rendered", async () => {
    const client = await open();
    refuse = Response.json({ error: { code: "forbidden" } }, { status: 403 });
    await act(async () => { client.update({ showThinking: true }); });
    await send();
    expect(refusals).toBe(1);

    await act(async () => {
      client.update({ darkTheme: "gruvbox" });
      store.set({ settings: { darkTheme: "tokyo-night" } });
    });

    expect(client.settings.darkTheme).toBe("tokyo-night");
    await windows();
    expect(bodies).toHaveLength(1);
  });

  it("a device's first refusal as read-only takes a document held behind it over a pick not drawn yet", async () => {
    const gate = Promise.withResolvers<void>();
    refusing = () => gate.promise.then(() => Response.json({ error: { code: "forbidden" } }, { status: 403 }));
    const client = await open();
    await act(async () => { client.update({ showThinking: true }); });
    await windows();
    await act(async () => { store.set({ settings: { darkTheme: "tokyo-night" } }); });

    const absorbed = nextAbsorbed();
    await act(async () => {
      client.update({ darkTheme: "gruvbox" });
      gate.resolve();
      await absorbed;
    });
    refusing = null;

    expect(client.settings.darkTheme).toBe("tokyo-night");
    await windows(3);
    expect(bodies).toHaveLength(1);
  });

  it("a pick refused while another browser's newer value was held behind it gives way to that value, and is not sent again", async () => {
    const gate = Promise.withResolvers<void>();
    refusing = () => gate.promise.then(() => Response.json({ error: { code: "preferences_unwritable" } }, { status: 500 }));
    const client = await open();
    await act(async () => { client.update({ darkTheme: "gruvbox" }); });
    await windows();
    await act(async () => { store.set({ settings: { darkTheme: "catppuccin" } }); });

    const absorbed = nextAbsorbed();
    await act(async () => { gate.resolve(); await absorbed; });
    refusing = null;

    expect(client.settings.darkTheme).toBe("catppuccin");
    await act(async () => { jest.advanceTimersByTime(5_000); });
    await windows(3);
    expect(bodies).toHaveLength(1);
    expect(store.get().settings.darkTheme).toBe("catppuccin");
    expect(client.saveError).toBeNull();
  });

  it.each([["drawn", true], ["not drawn yet", false]] as const)("a refused pick about to go again gives way to a newer save, %s, that lands as its wait ends", async (_name, drawn) => {
    store.set({ settings: { darkTheme: "tokyo-night" } });
    const client = await open();
    refuse = unwritable();
    await act(async () => { client.update({ darkTheme: "gruvbox" }); });
    await send();
    await act(async () => { jest.advanceTimersByTime(5_000); });
    if (drawn) await act(async () => { store.set({ settings: { darkTheme: "catppuccin" } }); });

    await act(async () => {
      if (!drawn) store.set({ settings: { darkTheme: "catppuccin" } });
      jest.advanceTimersByTime(600);
    });

    await longWait();
    expect([client.settings.darkTheme, store.get().settings.darkTheme, bodies.length]).toEqual(["catppuccin", "catppuccin", 1]);
  });

  it.each([["held behind the refused save", true], ["after the refusal", false]] as const)("a refused mute gives way to the list another browser saved since, %s", async (_name, heldBehind) => {
    store.set({ settings: {}, muted_panes: [] });
    const client = await open();
    const elsewhere = (): void => { store.set({ settings: {}, muted_panes: ["w1:p2"] }); };
    if (heldBehind) {
      const gate = heldRefusal();
      await act(async () => { setPaneMutes(["w1:p1"]); });
      await windows();
      await act(async () => { elsewhere(); });
      const absorbed = nextAbsorbed();
      await act(async () => { gate.resolve(); await absorbed; });
      refusing = null;
    } else {
      refuse = unwritable();
      await act(async () => { setPaneMutes(["w1:p1"]); });
      await send();
      await act(async () => { elsewhere(); });
    }

    expect([currentPaneMutes(), client.saveError]).toEqual([["w1:p2"], null]);
    await longWait();
    expect([bodies.map((body) => body.muted_panes), store.get().muted_panes]).toEqual([[["w1:p1"]], ["w1:p2"]]);
  });

  it.each([["drawn", true], ["not drawn yet", false]] as const)("a return to a refused pick, %s when the refusal lands, still gives way to a newer save and is not sent again", async (_name, drawn) => {
    store.set({ settings: { darkTheme: "tokyo-night" }, pins: [] });
    const client = await open();
    const gate = heldRefusal();
    await act(async () => { client.update({ darkTheme: "gruvbox" }); });
    await windows();
    expect(bodies).toHaveLength(1);
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    // held behind the save: it changes no setting
    await act(async () => { store.set({ settings: {}, pins: ["local:w1:p1"] }); });

    if (drawn) await act(async () => { client.update({ darkTheme: "gruvbox" }); });
    const absorbed = nextAbsorbed();
    await act(async () => {
      if (!drawn) client.update({ darkTheme: "gruvbox" });
      gate.resolve();
      await absorbed;
    });
    refusing = null;
    expect([client.settings.darkTheme, client.saveError !== null]).toEqual(["gruvbox", true]);

    await act(async () => { store.set({ settings: { darkTheme: "catppuccin" } }); });
    await longWait();
    expect([client.settings.darkTheme, store.get().settings.darkTheme, bodies.length]).toEqual(["catppuccin", "catppuccin", 1]);
  });

  it.each([["drawn", true], ["not drawn yet", false]] as const)("a refused pick taken back, %s, and then picked again is a new edit: it shows no save error and goes over a save another browser makes next", async (_name, drawn) => {
    store.set({ settings: { darkTheme: "tokyo-night" } });
    const client = await open();
    refuse = unwritable();
    await act(async () => { client.update({ darkTheme: "gruvbox" }); });
    await send();
    expect(client.saveError).not.toBeNull();

    if (drawn) await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await act(async () => {
      if (!drawn) client.update({ darkTheme: "tokyo-night" });
      client.update({ darkTheme: "gruvbox" });
    });
    expect(client.saveError).toBeNull();

    await act(async () => { store.set({ settings: { darkTheme: "catppuccin" } }); });
    await longWait();
    expect([client.settings.darkTheme, store.get().settings.darkTheme]).toEqual(["gruvbox", "gruvbox"]);
  });

  it.each([
    ["drawn", true, false],
    ["not drawn yet, the mute last", false, false],
    ["not drawn yet, the pin last", false, true],
  ] as const)("a refused pin and mute taken back, %s, and then made again are new edits: they show no save error and go over a list another browser saves next", async (_name, drawn, pinLast) => {
    store.set({ settings: {}, pins: ["local:w1:p1"] });
    const client = await open();
    refuse = unwritable();
    await act(async () => { setSidebarPins(["local:w1:p1", "local:w1:p2"]); setPaneMutes(["w1:p1"]); });
    await send();
    expect(client.saveError).not.toBeNull();

    // the last of the two to go back is the one that leaves nothing unsent
    const takeBack = (): void => {
      if (pinLast) setPaneMutes([]);
      setSidebarPins(["local:w1:p1"]);
      if (!pinLast) setPaneMutes([]);
    };
    if (drawn) await act(async () => { takeBack(); });
    await act(async () => {
      if (!drawn) takeBack();
      setSidebarPins(["local:w1:p1", "local:w1:p2"]);
      setPaneMutes(["w1:p1"]);
    });
    expect(client.saveError).toBeNull();

    await act(async () => { store.set({ settings: {}, pins: ["local:w1:p9"], muted_panes: ["w1:p9"] }); });
    await longWait();
    expect(store.get().pins).toEqual(["local:w1:p9", "local:w1:p2"]);
    expect([...store.get().muted_panes!].sort()).toEqual(["w1:p1", "w1:p9"]);
    expect([currentSidebarPins(), [...currentPaneMutes()!].sort()]).toEqual([["local:w1:p9", "local:w1:p2"], ["w1:p1", "w1:p9"]]);
  });

  it.each([["drawn", true], ["not drawn yet", false]] as const)("a refused pick that gives way to a newer save, %s, leaves no save error over the edit made next", async (_name, drawn) => {
    store.set({ settings: { darkTheme: "tokyo-night" } });
    const client = await open();
    refuse = unwritable();
    await act(async () => { client.update({ darkTheme: "gruvbox" }); });
    await send();
    expect(client.saveError).not.toBeNull();

    if (drawn) await act(async () => { store.set({ settings: { darkTheme: "catppuccin" } }); });
    await act(async () => {
      if (!drawn) store.set({ settings: { darkTheme: "catppuccin" } });
      client.update({ darkTheme: "kanagawa" });
    });
    expect(client.saveError).toBeNull();

    await longWait();
    expect([client.settings.darkTheme, store.get().settings.darkTheme, bodies.length]).toEqual(["kanagawa", "kanagawa", 2]);
  });

  it.each([["drawn", true], ["not drawn yet", false]] as const)("a pick made again after its refused save gave way to a newer save held behind it, that refusal %s, is sent", async (_name, drawn) => {
    store.set({ settings: { darkTheme: "tokyo-night" } });
    const client = await open();
    const gate = heldRefusal();
    await act(async () => { client.update({ darkTheme: "gruvbox" }); });
    await windows();
    await act(async () => { store.set({ settings: { darkTheme: "catppuccin" } }); });

    const absorbed = nextAbsorbed();
    if (drawn) await act(async () => { gate.resolve(); await absorbed; });
    await act(async () => {
      if (!drawn) { gate.resolve(); await absorbed; }
      client.update({ darkTheme: "gruvbox" });
    });
    refusing = null;

    await longWait();
    expect([client.settings.darkTheme, store.get().settings.darkTheme, bodies.length]).toEqual(["gruvbox", "gruvbox", 2]);
  });

  it.each([["drawn", true], ["not drawn yet", false]] as const)("a refused pick taken back leaves no save error when a newer save was held behind it and another change, %s, lands with the refusal", async (_name, drawn) => {
    store.set({ settings: { darkTheme: "tokyo-night" }, pins: [] });
    const client = await open();
    const gate = heldRefusal();
    await act(async () => { client.update({ darkTheme: "gruvbox" }); });
    await windows();
    expect(bodies).toHaveLength(1);
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await act(async () => { store.set({ settings: { darkTheme: "catppuccin" } }); });

    if (drawn) await act(async () => { client.update({ density: "compact" }); });
    const absorbed = nextAbsorbed();
    await act(async () => {
      if (!drawn) client.update({ density: "compact" });
      gate.resolve();
      await absorbed;
    });
    refusing = null;

    await longWait();
    expect([client.settings.darkTheme, client.settings.density, store.get().settings.darkTheme, bodies.length]).toEqual(["catppuccin", "compact", "catppuccin", 1]);
    expect(client.saveError).toBeNull();
  });

  it("Retry never bypasses a watching device or an older server", async () => {
    const watching = await open();
    refuse = Response.json({ error: { code: "forbidden" } }, { status: 403 });
    await act(async () => { watching.update({ darkTheme: "tokyo-night" }); });
    await send();
    await act(async () => { watching.retry(); watching.resubscribed(); });
    await longWait();
    expect([bodies.length, watching.saveError, watching.retrying]).toEqual([1, null, false]);

    await unmountClients();
    clients.length = 0;
    const older = await open();
    refuse = Response.json({ error: { code: "not_found" } }, { status: 404 });
    await act(async () => { older.update({ darkTheme: "gruvbox" }); });
    await send();
    await act(async () => { older.retry(); older.resubscribed(); });
    await longWait();
    expect([bodies.length, older.saveError, older.retrying]).toEqual([2, null, false]);
  });

  function heldRefusal(): ReturnType<typeof Promise.withResolvers<void>> {
    const gate = Promise.withResolvers<void>();
    refusing = () => gate.promise.then(unwritable);
    return gate;
  }
  const retryWaits = () => [...waits.values()].filter((ms) => ms === 5_000);

  it("a change undone while its refused save is on the way leaves nothing for Retry to wait on", async () => {
    const client = await open();
    const gate = heldRefusal();
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await windows();
    expect(bodies.length).toBe(1);
    await act(async () => { client.update({ darkTheme: DEFAULT_SETTINGS.darkTheme }); });
    await act(async () => { gate.resolve(); });
    await act(async () => {});
    expect([client.saveError, client.retrying, client.paused]).toEqual([null, false, false]);
    await act(async () => { client.retry(); });
    expect(client.retrying).toBe(false);
    await longWait();
    expect([bodies.length, client.saveError, client.retrying, client.paused]).toEqual([1, null, false, false]);
    expect(store.get().revision).toBe(0);
  });

  it("a refusal that arrives after unmounting sets no new wait", async () => {
    await open();
    const gate = heldRefusal();
    await act(async () => { clients[0]!.update({ darkTheme: "tokyo-night" }); });
    await windows();
    expect(bodies.length).toBe(1);
    await unmountClients();
    await act(async () => { gate.resolve(); });
    await act(async () => {});
    expect(refusals).toBe(1);
    expect(retryWaits()).toEqual([]);
  });

  it("a refusal that arrives once sync is off sets no new wait, and the change goes when it is on again", async () => {
    const client = await open();
    const gate = heldRefusal();
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await windows();
    expect(bodies.length).toBe(1);
    syncEnabled = false;
    await client.rerender();
    await act(async () => { gate.resolve(); });
    await act(async () => {});
    expect(client.saveError).not.toBeNull();
    expect(retryWaits()).toEqual([]);
    await longWait();
    expect(bodies.length).toBe(1);

    refusing = null;
    syncEnabled = true;
    await client.rerender();
    await send();
    expect([bodies.length, answers, client.saveError]).toEqual([2, 1, null]);
    expect(store.get().settings.darkTheme).toBe("tokyo-night");
  });

  it("a lost event stream cancels the wait, and its reopening resumes one chain", async () => {
    const client = await open();
    refusing = unwritable;
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await failSaves(1);
    expect(retryWaits()).toEqual([5_000]);
    await act(async () => { client.disconnected(); });
    expect(retryWaits()).toEqual([]);
    await act(async () => { client.update({ lightTheme: "catppuccin" }); });
    await longWait();
    expect([refusals, client.paused, client.saveError !== null]).toEqual([1, false, true]);
    expect(client.settings.lightTheme).toBe("catppuccin");

    await act(async () => { client.retry(); });
    await send();
    expect([refusals, client.retrying]).toEqual([2, false]);
    expect(retryWaits()).toEqual([]);
    await longWait();
    expect(refusals).toBe(2);

    refusing = null;
    await act(async () => { client.resubscribed(); client.receive(store.get()); });
    await send();
    await longWait();
    expect([bodies.length, answers, client.saveError, client.paused]).toEqual([3, 1, null, false]);
    expect(bodies[2]?.settings).toMatchObject({ darkTheme: "tokyo-night", lightTheme: "catppuccin" });
    expect(store.get().settings).toMatchObject({ darkTheme: "tokyo-night", lightTheme: "catppuccin" });
  });

  it("a Retry pressed while a save is on its way lets nothing go on its own once that save confirms everything", async () => {
    const client = await open();
    refuse = unwritable();
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await send();
    expect(client.saveError).not.toBeNull();
    const gate = Promise.withResolvers<void>();
    releaseAnswer = () => gate.promise;
    await act(async () => { jest.advanceTimersByTime(5_000); });
    await windows();
    expect(bodies.length).toBe(2);
    await act(async () => { client.retry(); });
    expect(client.retrying).toBe(true);
    const answered = nextAnswer();
    await act(async () => { gate.resolve(); await answered; });
    releaseAnswer = undefined;
    expect([client.saveError, client.retrying]).toEqual([null, false]);

    await act(async () => { client.disconnected(); });
    await act(async () => { client.update({ darkTheme: "gruvbox" }); });
    await longWait();
    expect(bodies.length).toBe(2);
    expect(client.settings.darkTheme).toBe("gruvbox");
    await act(async () => { client.resubscribed(); client.receive(store.get()); });
    await send();
    expect([bodies.length, store.get().settings.darkTheme]).toEqual([3, "gruvbox"]);
  });

  it("a Retry pressed while a save is on its way that is then refused sends once, at once, even with the stream lost", async () => {
    const client = await open();
    refuse = unwritable();
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await send();
    const gate = heldRefusal();
    await act(async () => { jest.advanceTimersByTime(5_000); });
    await windows();
    expect(bodies.length).toBe(2);
    await act(async () => { client.disconnected(); client.retry(); });
    await act(async () => { gate.resolve(); });
    await act(async () => {});
    expect([refusals, client.retrying]).toEqual([2, true]);
    expect(retryWaits()).toEqual([]);
    await send();
    expect([refusals, client.retrying]).toEqual([3, false]);
    expect(retryWaits()).toEqual([]);
    await act(async () => { client.update({ lightTheme: "catppuccin" }); });
    await longWait();
    expect([bodies.length, client.paused]).toEqual([3, false]);
  });

  it("a refusal that arrives while the event stream is down sets no wait, and goes when it reopens", async () => {
    const client = await open();
    const gate = heldRefusal();
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await windows();
    expect(bodies.length).toBe(1);
    await act(async () => { client.disconnected(); });
    await act(async () => { gate.resolve(); });
    await act(async () => {});
    expect(client.saveError).not.toBeNull();
    expect(retryWaits()).toEqual([]);
    await longWait();
    expect(bodies.length).toBe(1);

    refusing = null;
    await act(async () => { client.resubscribed(); client.receive(store.get()); });
    await send();
    expect([bodies.length, answers, client.saveError]).toEqual([2, 1, null]);
    expect(store.get().settings.darkTheme).toBe("tokyo-night");
  });

  const pauseWaits = () => [...waits.values()].filter((ms) => ms >= 60_000);

  it("a stream the browser gave up on holds back only a refused change: what is unsent goes, its refusal shows with Retry, and it goes again once the new stream opens", async () => {
    const client = await open();
    await act(async () => { client.disconnected(); });
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await longWait();
    expect(bodies.length).toBe(0);
    // the reconnect got a proxy's 502: the browser never reconnects this stream, so nothing waits for it
    refusing = unwritable;
    await act(async () => { client.closed(); });
    await send();
    expect(refusals).toBe(1);
    expect([client.saveError?.message, client.paused]).toEqual(["The server cannot save settings: check that its state folder is writable.", false]);
    expect(retryWaits()).toEqual([]);
    refusing = null;
    await longWait();
    expect(bodies.length).toBe(1);
    await act(async () => { client.resubscribed(); client.receive(store.get()); });
    await send();
    expect([bodies.length, answers, client.saveError]).toEqual([2, 1, null]);
    expect(store.get().settings.darkTheme).toBe("tokyo-night");
    await longWait();
    expect(bodies.length).toBe(2);

    refusing = unwritable;
    await act(async () => { client.closed(); });
    await act(async () => { client.update({ lightTheme: "catppuccin" }); });
    await send();
    expect([bodies.length, client.saveError !== null]).toEqual([3, true]);
    await longWait();
    expect(bodies.length).toBe(3);
    refusing = null;
    await act(async () => { client.retry(); });
    await send();
    expect([bodies.length, answers, client.saveError, client.retrying]).toEqual([4, 2, null, false]);
    expect(store.get().settings.lightTheme).toBe("catppuccin");
  });

  it("a paused save goes once more on its own after a longer wait, doubling up to five minutes, and lands once the server can write", async () => {
    const client = await open();
    refusing = unwritable;
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await failSaves(3);
    expect([client.paused, pauseWaits()]).toEqual([true, [60_000]]);
    await act(async () => { client.update({ lightTheme: "catppuccin" }); });
    await act(async () => { jest.advanceTimersByTime(58_000); });
    await windows();
    expect(refusals).toBe(3);
    for (const [index, wait] of [60_000, 120_000, 240_000, 300_000, 300_000].entries()) {
      expect([client.paused, pauseWaits()]).toEqual([true, [wait]]);
      if (index > 0) {
        await act(async () => { jest.advanceTimersByTime(wait - 1_000); });
        await windows();
        expect(refusals).toBe(3 + index);
      }
      await act(async () => { jest.advanceTimersByTime(index > 0 ? 1_000 : 1_400); });
      await send();
      expect([refusals, client.paused]).toEqual([4 + index, true]);
    }
    expect(bodies.at(-1)?.settings).toMatchObject({ darkTheme: "tokyo-night", lightTheme: "catppuccin" });

    refusing = null;
    await act(async () => { jest.advanceTimersByTime(300_000); });
    await send();
    expect([answers, client.saveError, client.paused, pauseWaits()]).toEqual([1, null, false, []]);
    expect(store.get().settings).toMatchObject({ darkTheme: "tokyo-night", lightTheme: "catppuccin" });
  });

  async function pausedWithPin(): Promise<Client> {
    await act(async () => { setSidebarPins(["pc:w2:p3"]); });
    store.set({ settings: {}, pins: ["pc:w2:p3"] });
    const client = await open();
    refusing = unwritable;
    await act(async () => { client.update({ darkTheme: "tokyo-night", lightTheme: "catppuccin" }); setSidebarPins(["pc:w2:p3", "local:w1:p1"]); });
    await failSaves(3);
    expect(client.paused).toBe(true);
    return client;
  }

  it("a newer value another browser saves while a refused change is paused wins here, and the change sent later leaves it", async () => {
    const client = await pausedWithPin();
    await act(async () => { store.set({ settings: { darkTheme: "gruvbox" }, pins: ["pc:w2:p3", "pc:w2:p4"] }); });
    expect(client.settings.darkTheme).toBe("gruvbox");
    expect(client.saveError).not.toBeNull();
    refusing = null;
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await act(async () => { client.resubscribed(); client.receive(store.get()); });
    await send();
    expect(bodies.at(-1)).toEqual({ settings: { lightTheme: "catppuccin" } });
    expect(store.get()).toMatchObject({ settings: { darkTheme: "gruvbox", lightTheme: "catppuccin" }, pins: ["pc:w2:p3", "pc:w2:p4"] });
    expect([client.saveError, client.paused]).toEqual([null, false]);

    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await act(async () => { store.set({ settings: { darkTheme: "kanagawa" } }); });
    expect(client.settings.darkTheme).toBe("tokyo-night");
    await send();
    expect(store.get().settings.darkTheme).toBe("tokyo-night");
  });

  it("a refused change resent when the event stream reopens never overwrites what another browser saved while it was lost", async () => {
    const client = await pausedWithPin();
    await act(async () => { client.disconnected(); });
    clients.splice(clients.indexOf(client), 1);
    store.set({ settings: { darkTheme: "gruvbox" }, pins: ["pc:w2:p3", "pc:w2:p4"] });
    expect(client.settings.darkTheme).toBe("tokyo-night");
    refusing = null;
    clients.push(client);
    await act(async () => { client.resubscribed(); client.receive(store.get()); });
    await send();
    expect(bodies.at(-1)).toEqual({ settings: { lightTheme: "catppuccin" } });
    expect(store.get()).toMatchObject({ settings: { darkTheme: "gruvbox", lightTheme: "catppuccin" }, pins: ["pc:w2:p3", "pc:w2:p4"] });
    expect(client.settings.darkTheme).toBe("gruvbox");
    expect([client.saveError, client.paused]).toEqual([null, false]);
  });

  it("a paused change whose longer wait ends while the stream is closed waits for the new stream's opening document, and gives way to what another browser saved meanwhile", async () => {
    const client = await pausedWithPin();
    await act(async () => { client.disconnected(); client.closed(); });
    clients.splice(clients.indexOf(client), 1);
    refusing = null;
    store.set({ settings: { darkTheme: "gruvbox" }, pins: ["pc:w2:p3", "pc:w2:p4"] });
    await act(async () => { jest.advanceTimersByTime(60_000); });
    await longWait();
    expect(bodies.length).toBe(3);
    expect(store.get()).toMatchObject({ settings: { darkTheme: "gruvbox" }, pins: ["pc:w2:p3", "pc:w2:p4"] });
    clients.push(client);
    await act(async () => { client.resubscribed(); client.receive(store.get()); });
    await send();
    expect(bodies.at(-1)).toEqual({ settings: { lightTheme: "catppuccin" } });
    expect(store.get()).toMatchObject({ settings: { darkTheme: "gruvbox", lightTheme: "catppuccin" }, pins: ["pc:w2:p3", "pc:w2:p4"] });
    expect([client.saveError, client.paused]).toEqual([null, false]);
  });

  it("a pick made here after a refusal goes over what another browser saved while the stream was lost", async () => {
    const client = await open();
    refusing = unwritable;
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await send();
    expect(client.saveError).not.toBeNull();
    await act(async () => { client.disconnected(); });
    clients.splice(clients.indexOf(client), 1);
    refusing = null;
    store.set({ settings: { darkTheme: "gruvbox" } });
    await act(async () => { jest.advanceTimersByTime(20_000); });
    await act(async () => { client.update({ darkTheme: "kanagawa" }); });
    clients.push(client);
    await act(async () => { client.resubscribed(); client.receive(store.get()); });
    expect(client.settings.darkTheme).toBe("kanagawa");
    await send();
    expect([store.get().settings.darkTheme, client.settings.darkTheme, client.saveError]).toEqual(["kanagawa", "kanagawa", null]);
  });

  it("a pick made here after a save whose answer was lost stays when the reopened stream brings that save's own value", async () => {
    const client = await open();
    clients.splice(clients.indexOf(client), 1);
    refusing = () => { store.set(bodies.at(-1)!); refusing = null; throw new TypeError("Failed to fetch"); };
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await send();
    await act(async () => { client.disconnected(); });
    expect([store.get().settings.darkTheme, client.saveError !== null]).toEqual(["tokyo-night", true]);
    await act(async () => { client.update({ darkTheme: "kanagawa" }); });
    await longWait();
    expect(bodies.length).toBe(1);
    clients.push(client);
    await act(async () => { client.resubscribed(); client.receive(store.get()); });
    expect(client.settings.darkTheme).toBe("kanagawa");
    await send();
    expect([bodies.length, store.get().settings.darkTheme, client.settings.darkTheme, client.saveError]).toEqual([2, "kanagawa", "kanagawa", null]);
  });

  it("an edit made while a save is on its way stays when the server stored that save but its answer was lost", async () => {
    const client = await open();
    const gate = Promise.withResolvers<void>();
    refusing = () => { store.set(bodies.at(-1)!); refusing = null; return gate.promise.then(() => { throw new TypeError("Failed to fetch"); }); };
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await windows();
    expect([bodies.length, store.get().settings.darkTheme]).toEqual([1, "tokyo-night"]);
    await act(async () => { client.update({ darkTheme: "kanagawa" }); });
    await act(async () => { gate.resolve(); });
    await act(async () => {});
    expect([client.settings.darkTheme, client.saveError !== null]).toEqual(["kanagawa", true]);
    await send();
    expect([bodies.length, store.get().settings.darkTheme, client.settings.darkTheme, client.saveError]).toEqual([2, "kanagawa", "kanagawa", null]);
  });
});
