import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { PreferenceStore } from "../../server/preferences.ts";
/** a document saved at least once, which names its state folder */
const named = <T extends object>(doc: T) => ({ ...doc, state_id: expect.stringMatching(/^[0-9a-f]{32}$/) });
import { type PreferencesChange, type SharedPreferences } from "../../shared/preferences.ts";
import { DEFAULT_SETTINGS, SettingsProvider, sanitizeSettings, useSettings, type Settings } from "./settings.ts";
import { currentSidebarPins, setSidebarPins } from "./sidebarPins.ts";
import { currentPaneMutes, setPaneMutes } from "./paneMutes.ts";
import { usePreferencesSync } from "./preferencesSync.ts";
import type { UserError } from "./userError.ts";

const deadlineTimer = globalThis.setTimeout;
const clearDeadline = globalThis.clearTimeout;

// Keep React, the provider, the hook and its API functions real. Only the network and DOM
// boundaries are stand-ins: PUTs go through a real on-disk store, not a canned answer.
describe("preferences sync real send path", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let dir: string;
  let store: PreferenceStore;
  let records: Map<string, string>;
  let oldServer: boolean;
  let releaseAnswer: (() => Promise<void>) | undefined;
  let renderers: ReactTestRenderer[];
  let clients: Client[];
  let revisions: number[];
  let answers: number;
  /** the next PUT's answer when the server refuses it, in its error envelope; stored nothing */
  let refuse: Response | null;
  /** every PUT's answer while set: a write error that persists, or a request that never reaches the PC */
  let refusing: (() => Response | Promise<Response>) | null;
  /** the waits the hook has set and not yet cleared or run, with their length */
  let waits: Map<unknown, number>;
  /** what the next render passes as `enabled` */
  let syncEnabled: boolean;
  let refusals: number;
  /** every PUT body in the order it was sent, refused or not */
  let bodies: PreferencesChange[];
  let answerListeners: Set<() => void>;
  /** the page's own events (pagehide, visibilitychange) */
  let pageEvents: EventTarget;
  /** whether each PUT asked to outlive the page */
  let keepalives: boolean[];
  /** the bodies the PUTs carried, in order */
  let sent: PreferencesChange[];
  /** an older server: no theme sides, no mute list and no state folder id in what it keeps or answers */
  const dropNewKeys = ({ muted_panes: _muted, state_id: _id, ...doc }: SharedPreferences): SharedPreferences => ({
    ...doc, settings: Object.fromEntries(Object.entries(doc.settings).filter(([key]) => key !== "darkTheme" && key !== "lightTheme")),
  });
  interface Client {
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
    /** render again, with `syncEnabled` as it is now */
    rerender: () => void;
  }

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT", "localStorage"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    records = new Map();
    waits = new Map();
    syncEnabled = true;
    pageEvents = new EventTarget();
    keepalives = [];
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    const localStorage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value), removeItem: (key: string) => records.delete(key) };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
    const tab = new Map<string, string>();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage,
      // this tab's session storage, which a reload keeps
      sessionStorage: { getItem: (key: string) => tab.get(key) ?? null, setItem: (key: string, value: string) => tab.set(key, value), removeItem: (key: string) => tab.delete(key) },
      setTimeout: (fn: () => void, ms: number) => {
        const id = globalThis.setTimeout(() => { waits.delete(id); fn(); }, ms);
        waits.set(id, ms);
        return id;
      },
      clearTimeout: (id: number) => { waits.delete(id); globalThis.clearTimeout(id); },
      addEventListener: pageEvents.addEventListener.bind(pageEvents),
      removeEventListener: pageEvents.removeEventListener.bind(pageEvents),
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
      visibilityState: "visible",
      addEventListener: pageEvents.addEventListener.bind(pageEvents),
      removeEventListener: pageEvents.removeEventListener.bind(pageEvents),
    } });
    // the stylesheet is loaded: its theme blocks own the page surface (applyToDocument)
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: (name: string) => (name === "--bg" ? "#12100e" : "") }) });
    dir = mkdtempSync(join(tmpdir(), "herdr-sync-hook-"));
    store = new PreferenceStore(dir);
    oldServer = false;
    releaseAnswer = undefined;
    renderers = [];
    clients = [];
    revisions = [];
    answers = 0;
    refuse = null;
    refusing = null;
    refusals = 0;
    bodies = [];
    sent = [];
    answerListeners = new Set();
    // the mute list is page state (lib/paneMutes.ts): each test opens as a page that has heard none
    setPaneMutes(null);
    // and the pins are this browser's own, with none it knew the server to hold
    setSidebarPins([]);
    store.subscribe((doc) => {
      revisions.push(doc.revision);
      for (const client of clients) client.receive(oldServer ? dropNewKeys(doc) : doc);
    });
    const fetchPreferences = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (init?.method !== "PUT") return Response.json(oldServer ? dropNewKeys(store.get()) : store.get());
      bodies.push(JSON.parse(String(init.body)));
      keepalives.push(init.keepalive === true);
      if (refuse !== null || refusing !== null) {
        const answer = refuse;
        refuse = null;
        refusals++;
        for (const listener of [...answerListeners]) listener();
        return answer ?? refusing!();
      }
      const body: PreferencesChange = JSON.parse(String(init.body));
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
    await act(async () => { for (const renderer of renderers) renderer.unmount(); });
    jest.useRealTimers();
    jest.restoreAllMocks();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
    rmSync(dir, { recursive: true, force: true });
  });

  /** a page of a browser opening; `again` keeps what an earlier page of the same browser stored */
  async function open(raw: object = DEFAULT_SETTINGS, again = false): Promise<Client> {
    if (!again) records.clear();
    records.set("ovis:settings", JSON.stringify(raw));
    const unmounted = () => { throw new Error("not mounted"); };
    const client: Client = { settings: sanitizeSettings(raw), rendered: { id: "amber", mode: "dark" }, update: unmounted, receive: unmounted, saveError: null, paused: false, retrying: false, retry: unmounted, resubscribed: unmounted, disconnected: unmounted, closed: unmounted, rerender: unmounted };
    function Probe() {
      const context = useSettings();
      client.settings = context.settings;
      client.rendered = context.resolvedEntry;
      client.update = context.update;
      const sync = usePreferencesSync(syncEnabled);
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
    const tree = () => createElement(SettingsProvider, null, createElement(Probe));
    let renderer: ReactTestRenderer | undefined;
    await act(async () => { renderer = create(tree()); });
    renderers.push(renderer!);
    client.rerender = () => renderer!.update(tree());
    clients.push(client);
    return client;
  }

  async function windows(count = 1): Promise<void> {
    for (let index = 0; index < count; index++) await act(async () => { jest.advanceTimersByTime(600); });
  }
  function nextAnswer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = deadlineTimer(() => { answerListeners.delete(done); reject(new Error("preferences answer did not arrive")); }, 2_000);
      const done = () => { clearDeadline(timer); answerListeners.delete(done); resolve(); };
      answerListeners.add(done);
    });
  }
  async function send(): Promise<void> {
    const answered = nextAnswer();
    await act(async () => { jest.advanceTimersByTime(600); await answered; });
  }
  const seed = { theme: "dark", palette: "tokyo-night", darkTheme: "tokyo-night", lightTheme: "tokyo-night-day" };

  it.each(["dark", "light"] as const)("takes a restarted legacy-only %s palette in a fresh client without corrective PUTs", async (theme) => {
    // Create valid old-format bytes without normalizing a new-format write, then restart.
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
    expect(JSON.parse(records.get("ovis:themes") ?? "{}").darkTheme).toBe(palette);
    expect(revisions).toEqual([1, 2]);
  });

  it.each(["pagehide", "visibilitychange"])("sends a change at once, to outlive the page, on %s", async (type) => {
    // Given a change made here, still inside the send delay.
    const client = await open();
    await act(async () => { client.update({ showUsage: !DEFAULT_SETTINGS.showUsage }); });

    // When the page closes, or is hidden (a phone may kill it then).
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => { pageEvents.dispatchEvent(new Event(type)); });

    // Then the change went out without waiting, in a request that survives the page.
    expect(keepalives).toEqual([true]);
    expect(store.get().settings.showUsage).toBe(!DEFAULT_SETTINGS.showUsage);
    await windows(3);
    expect(bodies).toHaveLength(1);
  });

  it("sends an edit made while a save is on its way when the page goes", async () => {
    // Given a save on its way, and a second edit made before its answer.
    const gate = Promise.withResolvers<void>();
    releaseAnswer = () => gate.promise;
    const client = await open();
    await act(async () => { client.update({ showUsage: !DEFAULT_SETTINGS.showUsage }); });
    await windows();
    await act(async () => { client.update({ showThinking: !DEFAULT_SETTINGS.showThinking }); });

    // When the page goes before that answer.
    await act(async () => { pageEvents.dispatchEvent(new Event("pagehide")); });

    // Then both edits go out at once in a request that outlives the page.
    expect(keepalives).toEqual([false, true]);
    expect(bodies[1]?.settings).toMatchObject({ showUsage: !DEFAULT_SETTINGS.showUsage, showThinking: !DEFAULT_SETTINGS.showThinking });
    await act(async () => { gate.resolve(); });
    releaseAnswer = undefined;
  });

  it("sends a change once when the page is hidden and then goes, and nothing when it shows again", async () => {
    // Given a change made here, still inside the send delay.
    const gate = Promise.withResolvers<void>();
    releaseAnswer = () => gate.promise;
    const client = await open();
    await act(async () => { client.update({ showUsage: !DEFAULT_SETTINGS.showUsage }); });

    // When the page is hidden, then goes, before the answer (a reload fires both).
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => { pageEvents.dispatchEvent(new Event("visibilitychange")); pageEvents.dispatchEvent(new Event("pagehide")); });

    // Then one request went out.
    expect(keepalives).toEqual([true]);
    const answered = nextAnswer();
    await act(async () => { gate.resolve(); await answered; });
    releaseAnswer = undefined;

    // And a page shown again sends nothing more.
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => { pageEvents.dispatchEvent(new Event("visibilitychange")); });
    await windows(3);
    expect(keepalives).toEqual([true]);
  });

  it.each([
    ["sends it again", false],
    ["takes a newer value saved elsewhere instead", true],
  ] as const)("when the request on the way out of a reload is lost, the reloaded page %s", async (_name, savedElsewhere) => {
    // Given a switch turned on and saved, then off again just before a reload whose request on the way out is lost.
    const on = !DEFAULT_SETTINGS.showUsage;
    const client = await open();
    await act(async () => { client.update({ showUsage: on }); });
    await send();
    await act(async () => { client.update({ showUsage: !on }); });
    refusing = () => Promise.reject(new TypeError("Failed to fetch"));
    await act(async () => { pageEvents.dispatchEvent(new Event("pagehide")); });
    await act(async () => { renderers.pop()!.unmount(); });
    clients.length = 0;
    refusing = null;
    expect(store.get().settings.showUsage).toBe(on);
    if (savedElsewhere) store.set({ settings: { showUsage: on } });

    // When the page comes back in the same tab.
    const reloaded = await open(JSON.parse(records.get("ovis:settings")!), true);
    await windows(3);

    // Then the value it went with is the server's and the page's, unless another browser saved the setting since.
    expect(store.get().settings.showUsage).toBe(savedElsewhere ? on : !on);
    expect(reloaded.settings.showUsage).toBe(savedElsewhere ? on : !on);
  });

  it("sends nothing on its way out when nothing changed", async () => {
    await open();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => { pageEvents.dispatchEvent(new Event("pagehide")); pageEvents.dispatchEvent(new Event("visibilitychange")); });
    await windows(3);
    expect(bodies).toEqual([]);
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

  it("says in plain words that the server cannot save, and clears it once the retried change lands", async () => {
    const client = await open();
    expect(client.saveError).toBeNull();
    // server/preferences.ts: its state folder refused the write
    refuse = Response.json({ error: { code: "preferences_unwritable", message: "EACCES: permission denied, open '/state/preferences.json.7.tmp'" } }, { status: 500 });
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await send();
    expect(refusals).toBe(1);
    expect(answers).toBe(0);
    expect(store.get().revision).toBe(0);
    expect(client.saveError).toEqual({ message: "The server cannot save settings: check that its state folder is writable.", detail: "EACCES: permission denied, open '/state/preferences.json.7.tmp'" });
    // the change goes out again after the wait (RETRY_MS) and lands
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
    // no list in the document: none here, and none made up for the server
    expect(currentPaneMutes()).toBeNull();
    expect(answers).toBe(0);
    // a change of something else goes out without a list
    await act(async () => { client.update({ showThinking: true }); });
    await send();
    // (the pins ride along with the first change, as they always have)
    expect(sent).toEqual([{ settings: { showThinking: true }, pins: [] }]);
    expect(currentPaneMutes()).toBeNull();
    // the server is upgraded: its next document carries the list, and the page offers mutes from then on
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
    // the server is replaced by one that keeps no list (a downgrade): its next, newer document has none
    oldServer = true;
    await act(async () => { store.set({ settings: { theme: "light" } }); });
    await windows(3);
    expect(revisions).toEqual([1, 2]);
    // the mutes stand down: no row offers a mute, and no channel holds an alert back for one
    expect(currentPaneMutes()).toBeNull();
    expect(answers).toBe(0);
    // a later change of something else carries no made-up list
    await act(async () => { client.update({ showThinking: true }); });
    await send();
    // (the pins ride along with the first change, as they always have)
    expect(sent).toEqual([{ settings: { showThinking: true }, pins: [] }]);
    expect(currentPaneMutes()).toBeNull();
  });

  it("a page opened again keeps a pin another client removed meanwhile removed, instead of sending its own back", async () => {
    // a server that already shares pins
    store.set({ settings: {}, pins: [] });
    await open();
    await windows();
    await act(async () => { setSidebarPins(["local:t1"]); });
    await send();
    expect(store.get().pins).toEqual(["local:t1"]);
    // the page goes; meanwhile the pin is removed elsewhere (another browser, or the Herdr app)
    await act(async () => { for (const renderer of renderers.splice(0)) renderer.unmount(); });
    clients.length = 0;
    store.set({ settings: {}, pins: [] });
    const before = sent.length;
    // the same browser opens again, its own copy still holding the old pin
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
    await act(async () => { for (const renderer of renderers.splice(0)) renderer.unmount(); });
    clients.length = 0;
    // the server starts over with a fresh state folder
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
    await act(async () => { for (const renderer of renderers.splice(0)) renderer.unmount(); });
    clients.length = 0;
    // the server starts over with a fresh state folder, and gets a pin from elsewhere first
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

  // the new server's saves from elsewhere reach the revision this browser kept (2), or pass it
  for (const saves of [2, 3]) it(`a page opened again on a server started over whose saves reached revision ${saves} keeps its own pins too`, async () => {
    store.set({ settings: {}, pins: [] });
    await open();
    await windows();
    await act(async () => { setSidebarPins(["local:t1"]); });
    await send();
    expect(store.get().revision).toBe(2);
    await act(async () => { for (const renderer of renderers.splice(0)) renderer.unmount(); });
    clients.length = 0;
    // the server starts over with a fresh state folder, and another device saves there meanwhile
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
    await act(async () => { for (const renderer of renderers.splice(0)) renderer.unmount(); });
    clients.length = 0;
    // the server starts over with a fresh state folder on a release that names none, and holds the pin at revision 3
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "herdr-sync-hook-"));
    store = new PreferenceStore(dir);
    for (let index = 0; index < 3; index += 1) store.set({ settings: {}, pins: ["local:t1"] });
    rmSync(join(dir, "preferences-id.json"));
    store = new PreferenceStore(dir);
    store.subscribe((doc) => { for (const client of clients) client.receive(doc); });
    oldServer = true;
    // the same browser opens there and takes its document as what the server holds
    await open(DEFAULT_SETTINGS, true);
    await windows();
    await act(async () => { for (const renderer of renderers.splice(0)) renderer.unmount(); });
    clients.length = 0;
    // the server is upgraded, and another device removes the pin: that save names the folder
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
    // the fresh store's empty list arrived with the GET: the first mute is a change of it
    expect(currentPaneMutes()).toEqual([]);
    await act(async () => { setPaneMutes(["w1:p1"]); });
    await send();
    expect(answers).toBe(1);
    expect(sent).toEqual([{ settings: {}, pins: [], muted_panes: ["w1:p1"] }]);
    expect(store.get().muted_panes).toEqual(["w1:p1"]);
    expect(a.saveError).toBeNull();
    await windows(3);
    expect(revisions).toEqual([1]);
    // the server restarts, and a browser that has heard nothing opens: it takes the list, and sends nothing
    store = new PreferenceStore(dir);
    expect(store.get().muted_panes).toEqual(["w1:p1"]);
    store.subscribe((doc) => { revisions.push(doc.revision); for (const client of clients) client.receive(doc); });
    setPaneMutes(null);
    await open();
    await windows(3);
    expect(currentPaneMutes()).toEqual(["w1:p1"]);
    expect(answers).toBe(1);
    expect(revisions).toEqual([1]);
    // an unmute there reaches the store, and every page hears the document
    await act(async () => { setPaneMutes([]); });
    await send();
    expect(sent.at(-1)).toEqual({ settings: {}, muted_panes: [] });
    expect(store.get().muted_panes).toEqual([]);
    expect(currentPaneMutes()).toEqual([]);
  });

  it.each([
    [403, "forbidden"],
    [404, "not_found"],
  ] as const)("clears a save error when the server stops accepting saves with %s", async (status, code) => {
    // Given a client with an unconfirmed save error.
    const client = await open();
    refuse = Response.json({ error: { code: "preferences_unwritable" } }, { status: 500 });
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await send();
    expect(client.saveError).not.toBeNull();

    // When its next save receives this terminal refusal.
    refuse = Response.json({ error: { code } }, { status });
    await act(async () => { jest.advanceTimersByTime(5_000); });
    await send();
    // Then the refusal was sent and the previous error clears.
    expect(refusals).toBe(2);
    expect(refuse).toBeNull();
    expect(client.saveError).toBeNull();
  });

  const unwritable = () => Response.json({ error: { code: "preferences_unwritable", message: "EACCES: permission denied" } }, { status: 500 });
  /** the first failed save, then the automatic ones after each RETRY_MS wait, until `count` have failed */
  async function failSaves(count: number): Promise<void> {
    await send();
    for (let index = 1; index < count; index++) {
      await act(async () => { jest.advanceTimersByTime(5_000); });
      await send();
    }
  }
  /** several RETRY_MS waits, each followed by a send window, with what each wakes settled between */
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

    // Retry starts one more round, which lands, and the count starts over
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
    expect(bodies[3]).toEqual({ settings: { darkTheme: "tokyo-night", lightTheme: "catppuccin", palette: "tokyo-night" }, pins: ["local:w1:p1"] });
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
    // a second press while the first is on its way starts no second chain
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
    // the answer confirms what was sent, not the edit made meanwhile: the status stays until that lands
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
    // an ordinary document from the event stream, at the revision already held, resumes nothing
    await act(async () => { client.receive(store.get()); });
    await longWait();
    expect(refusals).toBe(3);

    // the stream reopened: the server sends the same document as it opens, and one new round begins
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

  it("Retry never bypasses a watching device or an older server", async () => {
    const watching = await open();
    refuse = Response.json({ error: { code: "forbidden" } }, { status: 403 });
    await act(async () => { watching.update({ darkTheme: "tokyo-night" }); });
    await send();
    await act(async () => { watching.retry(); watching.resubscribed(); });
    await longWait();
    expect([bodies.length, watching.saveError, watching.retrying]).toEqual([1, null, false]);

    await act(async () => { for (const renderer of renderers.splice(0)) renderer.unmount(); });
    clients.length = 0;
    const older = await open();
    refuse = Response.json({ error: { code: "not_found" } }, { status: 404 });
    await act(async () => { older.update({ darkTheme: "gruvbox" }); });
    await send();
    await act(async () => { older.retry(); older.resubscribed(); });
    await longWait();
    expect([bodies.length, older.saveError, older.retrying]).toEqual([2, null, false]);
  });

  /** a refusal the server gives only once `gate` is resolved: the request is on its way until then */
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
    // back to what the server holds before the refusal arrives: nothing is unsent any more
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
    await act(async () => { for (const renderer of renderers.splice(0)) renderer.unmount(); });
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
    await act(async () => { client.rerender(); });
    await act(async () => { gate.resolve(); });
    await act(async () => {});
    // the answer is still read: the change stays unconfirmed here
    expect(client.saveError).not.toBeNull();
    expect(retryWaits()).toEqual([]);
    await longWait();
    expect(bodies.length).toBe(1);

    refusing = null;
    syncEnabled = true;
    await act(async () => { client.rerender(); });
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
    // an edit made while the stream is down stays here and is not sent either
    await act(async () => { client.update({ lightTheme: "catppuccin" }); });
    await longWait();
    expect([refusals, client.paused, client.saveError !== null]).toEqual([1, false, true]);
    expect(client.settings.lightTheme).toBe("catppuccin");

    // the user's Retry still goes once, and its refusal sets no wait while the stream is down
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
    // the automatic retry is on its way when the user presses Retry
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

    // that answer confirmed everything: the Retry is used up, so an edit made once the stream is lost stays here
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
    // the Retry still owes its own send: it goes in the next send window, not after a wait
    expect([refusals, client.retrying]).toEqual([2, true]);
    expect(retryWaits()).toEqual([]);
    await send();
    expect([refusals, client.retrying]).toEqual([3, false]);
    expect(retryWaits()).toEqual([]);
    // and then it is used up: a later edit stays here while the stream is lost
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
    // the answer is still read: the change stays unconfirmed here
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

  /** the paused saves' longer waits that are set and not yet cleared or run */
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
    // refused, it waits for App's new stream: until that opens, this page cannot hear another browser's save
    expect(retryWaits()).toEqual([]);
    refusing = null;
    await longWait();
    expect(bodies.length).toBe(1);
    // App's new stream opens with the server's document, then the change goes once and lands
    await act(async () => { client.resubscribed(); client.receive(store.get()); });
    await send();
    expect([bodies.length, answers, client.saveError]).toEqual([2, 1, null]);
    expect(store.get().settings.darkTheme).toBe("tokyo-night");
    await longWait();
    expect(bodies.length).toBe(2);

    // closed again: a refused change still goes at once on the user's Retry
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
    // an edit made while paused waits too, and joins the next send
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

  /** this client's change refused three times (the theme's sides and a pin), on a server that already shares pins */
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
    // another browser saves its own dark theme and pins; the event stream brings them at once
    await act(async () => { store.set({ settings: { darkTheme: "gruvbox" }, pins: ["pc:w2:p3", "pc:w2:p4"] }); });
    expect(client.settings.darkTheme).toBe("gruvbox");
    expect(client.saveError).not.toBeNull();
    refusing = null;
    // much later the stream reopens: what goes is only what nobody changed elsewhere
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await act(async () => { client.resubscribed(); client.receive(store.get()); });
    await send();
    expect(bodies.at(-1)).toEqual({ settings: { lightTheme: "catppuccin" } });
    expect(store.get()).toMatchObject({ settings: { darkTheme: "gruvbox", lightTheme: "catppuccin" }, pins: ["pc:w2:p3", "pc:w2:p4"] });
    expect([client.saveError, client.paused]).toEqual([null, false]);

    // once a save lands, a change made here goes over what arrives before it is sent, as always (even
    // one back to the value refused before)
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await act(async () => { store.set({ settings: { darkTheme: "kanagawa" } }); });
    expect(client.settings.darkTheme).toBe("tokyo-night");
    await send();
    expect(store.get().settings.darkTheme).toBe("tokyo-night");
  });

  it("a refused change resent when the event stream reopens never overwrites what another browser saved while it was lost", async () => {
    const client = await pausedWithPin();
    await act(async () => { client.disconnected(); });
    // the stream is down: another browser's save does not reach this one
    clients.splice(clients.indexOf(client), 1);
    store.set({ settings: { darkTheme: "gruvbox" }, pins: ["pc:w2:p3", "pc:w2:p4"] });
    expect(client.settings.darkTheme).toBe("tokyo-night");
    refusing = null;
    // it reopens: the server's document, sent as it opens, comes before the resent change
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
    // the server restarts behind a proxy: the stream is lost, then the reconnect's 502 closes it
    await act(async () => { client.disconnected(); client.closed(); });
    // it is back, and another browser saves before App's new stream opens here: this page does not hear it
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
    // later, before the stream reopens, the user picks again: that pick is the newest
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
    // the PC stores the change, but the network drops with its answer, and the event stream with it
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
    // the server stores it (its document is held here while the request is on its way), then the answer is lost
    refusing = () => { store.set(bodies.at(-1)!); refusing = null; return gate.promise.then(() => { throw new TypeError("Failed to fetch"); }); };
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await windows();
    expect([bodies.length, store.get().settings.darkTheme]).toEqual([1, "tokyo-night"]);
    await act(async () => { client.update({ darkTheme: "kanagawa" }); });
    await act(async () => { gate.resolve(); });
    await act(async () => {});
    expect([client.settings.darkTheme, client.saveError !== null]).toEqual(["kanagawa", true]);
    // the newer pick is what is unsent now: it goes once the settings rest
    await send();
    expect([bodies.length, store.get().settings.darkTheme, client.settings.darkTheme, client.saveError]).toEqual([2, "kanagawa", "kanagawa", null]);
  });
});
