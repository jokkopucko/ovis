import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_MUTED_PANES, MAX_PINS, MAX_TAB_LABEL_LENGTH, MAX_TAB_LABELS } from "../shared/preferences.ts";
import { handlePreferencesRequest, PreferenceStore } from "./preferences.ts";

const roots: string[] = [];
const root = (): string => { const dir = mkdtempSync(join(tmpdir(), "herdr-preferences-")); roots.push(dir); return dir; };
afterEach(() => {
  mock.restore();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const put = (store: PreferenceStore, body: string, headers: Record<string, string> = {}) => handlePreferencesRequest(new Request("http://x/api/preferences", { method: "PUT", body, headers }), store);
/** a document saved at least once, which names its state folder */
const named = <T extends object>(doc: T) => ({ ...doc, state_id: expect.stringMatching(/^[0-9a-f]{32}$/) });

const quietly = () => spyOn(console, "error").mockImplementation(() => undefined);

describe("shared preferences", () => {
  it("sends no id while its file is damaged, and leaves that file as it is", async () => {
    quietly();
    const dir = root();
    writeFileSync(join(dir, "preferences-id.json"), "{damaged");
    const store = new PreferenceStore(dir);
    const saved = await (await put(store, JSON.stringify({ settings: {}, pins: ["local:t1"] }))).json();
    expect(saved.revision).toBe(1);
    expect(saved.state_id).toBeUndefined();
    expect(readFileSync(join(dir, "preferences-id.json"), "utf8")).toBe("{damaged");
    expect(new PreferenceStore(dir).get().state_id).toBeUndefined();
  });

  it("refuses a first save whose id cannot be kept, and names the folder with the next", async () => {
    quietly();
    const dir = root();
    const store = new PreferenceStore(dir);
    const rename = fs.renameSync;
    const spy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith("preferences-id.json")) throw Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
      rename(from, to);
    });
    try { expect((await put(store, JSON.stringify({ settings: {}, pins: ["local:t1"] }))).status).toBe(500); } finally { spy.mockRestore(); }
    expect(store.get()).toEqual({ revision: 0, settings: {}, muted_panes: [] });
    expect(readdirSync(dir).filter((name) => !name.endsWith(".tmp"))).toEqual([]);
    expect(await (await put(store, JSON.stringify({ settings: {}, pins: ["local:t1"] }))).json()).toEqual(named({ revision: 1, settings: {}, pins: ["local:t1"], muted_panes: [] }));
  });

  it("takes the id another server on its folder wrote since it started, rather than writing over it", async () => {
    const dir = root();
    const first = new PreferenceStore(dir);
    const second = new PreferenceStore(dir);
    first.set({ settings: {}, pins: ["local:t1"] });
    const id = first.get().state_id;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(second.set({ settings: {}, pins: ["local:t2"] }).state_id).toBe(id);
    expect(new PreferenceStore(dir).get().state_id).toBe(id);
  });

  it("names its state folder from the first save on, across restarts, and a fresh folder anew", async () => {
    const dir = root();
    const store = new PreferenceStore(dir);
    // nothing shared yet: no id is sent that a restart could change
    expect(store.get().state_id).toBeUndefined();
    const first = await (await put(store, JSON.stringify({ settings: {}, pins: ["local:t1"] }))).json();
    expect(first.state_id).toMatch(/^[0-9a-f]{32}$/);
    // a browser cannot name it
    expect((await (await put(store, JSON.stringify({ settings: {}, state_id: "0".repeat(32) }))).json()).state_id).toBe(first.state_id);
    const again = new PreferenceStore(dir);
    expect(again.get().state_id).toBe(first.state_id);
    expect((await (await handlePreferencesRequest(new Request("http://x/api/preferences"), again)).json()).state_id).toBe(first.state_id);
    // a release that rewrites preferences.json whole keeps no id there, and the folder keeps its own
    writeFileSync(join(dir, "preferences.json"), JSON.stringify({ revision: 9, settings: {}, pins: [] }));
    expect(new PreferenceStore(dir).get().state_id).toBe(first.state_id);
    const fresh = new PreferenceStore(root());
    fresh.set({ settings: {}, pins: ["local:t2"] });
    expect(fresh.get().state_id).toMatch(/^[0-9a-f]{32}$/);
    expect(fresh.get().state_id).not.toBe(first.state_id);
  });

  const seed = { theme: "dark", palette: "tokyo-night", darkTheme: "tokyo-night", lightTheme: "tokyo-night-day" };
  it.each([
    ["h", [{ palette: "catppuccin" }], { darkTheme: "catppuccin", lightTheme: "tokyo-night-day", palette: "catppuccin" }],
    ["h2", [{ theme: "light" }, { palette: "charcoal" }], { darkTheme: "tokyo-night", lightTheme: "charcoal", palette: "charcoal" }],
    ["h4", [{ theme: "light" }], { darkTheme: "tokyo-night", lightTheme: "tokyo-night-day", palette: "tokyo-night-day" }],
    ["h4b", [{ theme: "light" }, { palette: "charcoal" }], { darkTheme: "tokyo-night", lightTheme: "charcoal", palette: "charcoal" }],
    ["h4c", [{ theme: "system" }, { palette: "charcoal" }], { darkTheme: "tokyo-night", lightTheme: "tokyo-night-day", palette: "tokyo-night" }],
    ["new format takes precedence", [{ darkTheme: "gruvbox", palette: "charcoal" }], { darkTheme: "gruvbox", lightTheme: "tokyo-night-day", palette: "gruvbox" }],
    ["unknown ids stay on the server", [{ darkTheme: "future-theme" }], { darkTheme: "future-theme", lightTheme: "tokyo-night-day", palette: "future-theme" }],
  ] as const)("%s normalizes only at the store writer", (_label, changes, expected) => {
    const dir = root();
    const store = new PreferenceStore(dir);
    store.set({ settings: seed });
    const revisions: number[] = [];
    store.subscribe((doc) => revisions.push(doc.revision));
    for (const settings of changes) store.set({ settings });
    expect(store.get().settings).toMatchObject(expected);
    expect(revisions).toEqual(changes.map((_, index) => index + 2));
    expect(new PreferenceStore(dir).get()).toEqual(store.get());
  });

  it("does not invent a side for a legacy System or mode-only document", () => {
    const store = new PreferenceStore(root());
    store.set({ settings: { theme: "system", palette: "amber" } });
    expect(store.get().settings).toEqual({ theme: "system", palette: "amber" });
    store.set({ settings: { theme: "light" } });
    expect(store.get().settings).toEqual({ theme: "light", palette: "amber" });
  });

  it.each([
    ["dark", { lightTheme: "one-light" }, { theme: "dark", palette: "charcoal", darkTheme: "charcoal", lightTheme: "one-light" }],
    ["light", { darkTheme: "gruvbox" }, { theme: "light", palette: "charcoal", darkTheme: "gruvbox", lightTheme: "charcoal" }],
    ["system", { lightTheme: "one-light" }, { theme: "system", palette: "charcoal", darkTheme: "charcoal", lightTheme: "one-light" }],
  ] as const)("keeps a legacy %s document's palette on its side when a new client picks the other side", (theme, change, expected) => {
    // a document an older server wrote: one palette and no sides
    const dir = root();
    writeFileSync(join(dir, "preferences.json"), JSON.stringify({ revision: 3, settings: { theme, palette: "charcoal" } }));
    const store = new PreferenceStore(dir);
    store.set({ settings: change });
    expect(store.get().settings).toEqual(expected);
  });

  it("starts empty, keeps only the shared names, counts each write, and survives a restart", async () => {
    const dir = root();
    const store = new PreferenceStore(dir);
    // no pins until a browser shares its own: an empty list would be taken for everyone's
    expect(await (await handlePreferencesRequest(new Request("http://x/api/preferences"), store)).json()).toEqual({ revision: 0, settings: {}, muted_panes: [] });
    const heard: number[] = [];
    store.subscribe((preferences) => heard.push(preferences.revision));
    const settingsOnly = await put(store, JSON.stringify({ settings: { showThinking: false } }));
    expect(await settingsOnly.json()).toEqual(named({ revision: 1, settings: { showThinking: false }, muted_panes: [] }));
    const first = await put(store, JSON.stringify({ settings: { theme: "light", terminalFontSize: 22, alertsOn: false, nonsense: 1 }, pins: ["local:w1:p1", "local:w1:p1", "pc:w2:p3"] }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(named({ revision: 2, settings: { showThinking: false, theme: "light" }, pins: ["local:w1:p1", "pc:w2:p3"], muted_panes: [] }));
    // a change lays its settings over what is held, and leaves the pins when it names none
    await put(store, JSON.stringify({ settings: { agentOrder: "activity" } }));
    expect(store.get()).toEqual(named({ revision: 3, settings: { showThinking: false, theme: "light", agentOrder: "activity" }, pins: ["local:w1:p1", "pc:w2:p3"], muted_panes: [] }));
    await put(store, JSON.stringify({ settings: { theme: "dark" }, pins: [] }));
    expect(heard).toEqual([1, 2, 3, 4]);
    expect(JSON.parse(readFileSync(join(dir, "preferences.json"), "utf8"))).toMatchObject({ revision: 4, settings: { showThinking: false, theme: "dark", agentOrder: "activity" }, pins: [] });
    expect(new PreferenceStore(dir).get()).toEqual(named({ revision: 4, settings: { showThinking: false, theme: "dark", agentOrder: "activity" }, pins: [], muted_panes: [] }));
  });

  it("refuses what is not a preferences document", async () => {
    const store = new PreferenceStore(root());
    expect((await put(store, "{")).status).toBe(400);
    expect((await put(store, JSON.stringify({ settings: [], pins: [] }))).status).toBe(400);
    expect((await put(store, JSON.stringify({ settings: {}, pins: [1] }))).status).toBe(400);
    expect((await put(store, JSON.stringify({ settings: {}, pins: Array.from({ length: MAX_PINS + 1 }, (_, i) => `pc:${i}`) }))).status).toBe(400);
    expect((await put(store, JSON.stringify({ settings: { quickReplies: ["x".repeat(70_000)] }, pins: [] }))).status).toBe(413);
    // a body that says it is too large is refused unread
    expect((await put(store, "{}", { "content-length": String(70_000) })).status).toBe(413);
    expect((await handlePreferencesRequest(new Request("http://x/api/preferences", { method: "POST", body: "{}" }), store)).status).toBe(405);
    expect(store.get().revision).toBe(0);
  });

  it("keeps the whole document under the limit, not only each change", async () => {
    const store = new PreferenceStore(root());
    expect((await put(store, JSON.stringify({ settings: { quickReplies: ["x".repeat(40_000)] } }))).status).toBe(200);
    const over = await put(store, JSON.stringify({ settings: { usageOrder: ["y".repeat(40_000)] } }));
    expect(over.status).toBe(413);
    expect(store.get()).toMatchObject({ revision: 1 });
    expect(store.get().settings["usageOrder"]).toBeUndefined();
  });

  it("holds and tells a change only once it is on disk", async () => {
    const dir = root();
    const file = join(dir, "state");
    writeFileSync(file, "a file where the state directory should be");
    const store = new PreferenceStore(file);
    const heard: number[] = [];
    store.subscribe((preferences) => heard.push(preferences.revision));
    const failed = await put(store, JSON.stringify({ settings: { theme: "light" } }));
    expect(failed.status).toBe(500);
    expect(await (await handlePreferencesRequest(new Request("http://x/api/preferences"), store)).json()).toEqual({ revision: 0, settings: {}, muted_panes: [] });
    expect(heard).toEqual([]);
  });

  it("fresh store advertises empty mutes and accepts first mute", async () => {
    const dir = root();
    const store = new PreferenceStore(dir);
    expect(await (await handlePreferencesRequest(new Request("http://x/api/preferences"), store)).json()).toEqual({ revision: 0, settings: {}, muted_panes: [] });
    const heard: number[] = [];
    store.subscribe((preferences) => heard.push(preferences.revision));
    // the very first mute is a change of the server's empty list: saved, told, and on disk
    const first = await put(store, JSON.stringify({ settings: {}, muted_panes: ["w1:p1", "w1:p1", "remote:pc-2:w1%3Ap1"] }));
    expect(await first.json()).toEqual(named({ revision: 1, settings: {}, muted_panes: ["w1:p1", "remote:pc-2:w1%3Ap1"] }));
    expect(heard).toEqual([1]);
    // the list is in its own document; preferences.json keeps the shape older releases read and write
    expect(JSON.parse(readFileSync(join(dir, "muted-panes.json"), "utf8"))).toEqual({ muted_panes: ["w1:p1", "remote:pc-2:w1%3Ap1"] });
    expect(JSON.parse(readFileSync(join(dir, "preferences.json"), "utf8"))).toEqual({ revision: 1, settings: {} });
    expect(new PreferenceStore(dir).get()).toEqual(named({ revision: 1, settings: {}, muted_panes: ["w1:p1", "remote:pc-2:w1%3Ap1"] }));
    // an empty list is the last one unmuted, not a missing field
    expect(await (await put(store, JSON.stringify({ settings: {}, muted_panes: [] }))).json()).toEqual(named({ revision: 2, settings: {}, muted_panes: [] }));
  });

  it("pre-feature stored document advertises empty mutes and accepts first mute", async () => {
    // a file an older server wrote: settings and pins, no list
    const dir = root();
    writeFileSync(join(dir, "preferences.json"), JSON.stringify({ revision: 7, settings: { theme: "light" }, pins: ["local:w1:p1"] }));
    const store = new PreferenceStore(dir);
    const heard: number[] = [];
    store.subscribe((preferences) => heard.push(preferences.revision));
    // read as none muted, without a write: the revision and the file are as they were
    expect(store.get()).toEqual({ revision: 7, settings: { theme: "light" }, pins: ["local:w1:p1"], muted_panes: [] });
    expect(JSON.parse(readFileSync(join(dir, "preferences.json"), "utf8"))).toEqual({ revision: 7, settings: { theme: "light" }, pins: ["local:w1:p1"] });
    expect(heard).toEqual([]);
    expect(await (await put(store, JSON.stringify({ settings: {}, muted_panes: ["w1:p1"] }))).json()).toEqual(named({ revision: 8, settings: { theme: "light" }, pins: ["local:w1:p1"], muted_panes: ["w1:p1"] }));
    expect(heard).toEqual([8]);
    expect(new PreferenceStore(dir).get().muted_panes).toEqual(["w1:p1"]);
  });

  it("an older release's save after a mute erases nothing, and the mutes are back after it", async () => {
    const dir = root();
    const store = new PreferenceStore(dir);
    await put(store, JSON.stringify({ settings: { theme: "light" }, pins: ["local:w1:p1"] }));
    await put(store, JSON.stringify({ settings: {}, muted_panes: ["w1:p1"] }));
    // a rollback or a downgrade serves a release from before the mutes: what it reads is the shape it knows
    const held = JSON.parse(readFileSync(join(dir, "preferences.json"), "utf8"));
    expect(held).toEqual({ revision: 2, settings: { theme: "light" }, pins: ["local:w1:p1"] });
    // its next save rewrites preferences.json whole, as origin/main's PreferenceStore.set does
    writeFileSync(join(dir, "preferences.json"), `${JSON.stringify({ revision: held.revision + 1, settings: { ...held.settings, theme: "dark" }, pins: [] }, null, 2)}\n`);
    // this release again: the older save and the mutes are both there, with no write of its own
    const back = new PreferenceStore(dir);
    expect(back.get()).toEqual(named({ revision: 3, settings: { theme: "dark" }, pins: [], muted_panes: ["w1:p1"] }));
    expect(readdirSync(dir).sort()).toEqual(["muted-panes.json", "preferences-id.json", "preferences.json"]);
    // and a change of something else leaves them
    expect(await (await put(back, JSON.stringify({ settings: { theme: "light" } }))).json()).toMatchObject({ revision: 4, muted_panes: ["w1:p1"] });
  });

  it("adds and drops tab labels key by key, in a document of its own, and sends none while none is kept", async () => {
    const dir = root();
    const store = new PreferenceStore(dir);
    const first = await put(store, JSON.stringify({ settings: {}, tab_labels: { "w1:p1|term_a": "Fix the login…" } }));
    expect(await first.json()).toEqual(named({ revision: 1, settings: {}, muted_panes: [], tab_labels: { "w1:p1|term_a": "Fix the login…" } }));
    // a key the server holds keeps its label; another pane's joins; a dropped key leaves
    const second = await put(store, JSON.stringify({ settings: {}, tab_labels: { "w1:p1|term_a": "Later", "remote:pc-2:w1%3Ap1|term_b": "Write the docs" } }));
    expect((await second.json()).tab_labels).toEqual({ "w1:p1|term_a": "Fix the login…", "remote:pc-2:w1%3Ap1|term_b": "Write the docs" });
    const third = await put(store, JSON.stringify({ settings: {}, tab_labels_removed: ["w1:p1|term_a"] }));
    expect((await third.json()).tab_labels).toEqual({ "remote:pc-2:w1%3Ap1|term_b": "Write the docs" });
    expect(JSON.parse(readFileSync(join(dir, "tab-labels.json"), "utf8"))).toEqual({ tab_labels: { "remote:pc-2:w1%3Ap1|term_b": "Write the docs" } });
    // preferences.json keeps the shape older releases read and write
    expect(JSON.parse(readFileSync(join(dir, "preferences.json"), "utf8"))).toEqual({ revision: 3, settings: {} });
    expect(new PreferenceStore(dir).get().tab_labels).toEqual({ "remote:pc-2:w1%3Ap1|term_b": "Write the docs" });
    // a change of something else leaves them, and writes no labels
    const before = readFileSync(join(dir, "tab-labels.json"), "utf8");
    expect((await (await put(store, JSON.stringify({ settings: { theme: "dark" } }))).json()).tab_labels).toEqual({ "remote:pc-2:w1%3Ap1|term_b": "Write the docs" });
    expect(readFileSync(join(dir, "tab-labels.json"), "utf8")).toBe(before);
    // the last one gone: the document carries none again
    expect((await (await put(store, JSON.stringify({ settings: {}, tab_labels_removed: ["remote:pc-2:w1%3Ap1|term_b"] }))).json()).tab_labels).toBeUndefined();
  });

  it("keeps both browsers' labels when they save at once, neither having heard the other", () => {
    const store = new PreferenceStore(root());
    store.set({ settings: {}, tab_labels: { "w1:p1|term_a": "From A" } });
    store.set({ settings: {}, tab_labels: { "w1:p2|term_b": "From B" } });
    expect(store.get().tab_labels).toEqual({ "w1:p1|term_a": "From A", "w1:p2|term_b": "From B" });
  });

  it("purges every stored tab label when the setting is turned off, and keeps none while it is", async () => {
    const dir = root();
    const store = new PreferenceStore(dir);
    store.set({ settings: {}, tab_labels: { "w1:p1|term_a": "Fix it", "w1:p2|term_b": "Ship it" } });
    // another browser turns it off without saying anything of the labels
    expect(store.set({ settings: { autoTabNames: false } }).tab_labels).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, "tab-labels.json"), "utf8"))).toEqual({ tab_labels: {} });
    // a browser that has not heard yet sends its labels: none is kept while the setting is off
    expect(store.set({ settings: {}, tab_labels: { "w1:p1|term_a": "Fix it" } }).tab_labels).toBeUndefined();
    expect(new PreferenceStore(dir).get().tab_labels).toBeUndefined();
    store.set({ settings: { autoTabNames: true }, tab_labels: { "w1:p3|term_c": "Again" } });
    expect(new PreferenceStore(dir).get().tab_labels).toEqual({ "w1:p3|term_c": "Again" });
  });

  it("keeps the newest MAX_TAB_LABELS labels and refuses a label or key that is not one", async () => {
    const store = new PreferenceStore(root());
    const many = Object.fromEntries(Array.from({ length: MAX_TAB_LABELS }, (_, n) => [`w1:p${n}|term_${n}`, `task ${n}`]));
    expect(Object.keys(store.set({ settings: {}, tab_labels: many }).tab_labels!)).toHaveLength(MAX_TAB_LABELS);
    for (const tab_labels of [
      { "w1:p1|term_a": "two\nlines" }, { "w1:p1|term_a": "two\rlines" }, { "w1:p1|term_a": "two\u2028lines" }, { "w1:p1|term_a": " " },
      { "w1:p1|term_a": "x".repeat(MAX_TAB_LABEL_LENGTH + 1) }, { "w1:p1|term_a": 3 }, ["w1:p1"],
      // a key is a pane and its terminal, never free text that could fill the document
      { "w1:p1": "no terminal" }, { [`${"x".repeat(250)}|term_a`]: "long" }, { "w1 p1|term_a": "space" },
      { ...many, "w1:pX|term_x": "one too many" },
    ]) {
      expect((await put(store, JSON.stringify({ settings: {}, tab_labels }))).status).toBe(400);
    }
    for (const tab_labels_removed of [["w1:p1"], ["w1:p1|term_a", 3], "w1:p1|term_a"]) {
      expect((await put(store, JSON.stringify({ settings: {}, tab_labels_removed }))).status).toBe(400);
    }
  });

  it("a labels file it cannot read drops only the labels from a change, never the settings, pins or mutes", () => {
    const dir = root();
    // a directory in its place: reading it fails, as it would for a file without read rights
    mkdirSync(join(dir, "tab-labels.json"));
    const store = new PreferenceStore(dir);
    expect(store.set({ settings: { theme: "dark" }, pins: ["local:w1:p1"] })).toMatchObject({ revision: 1, settings: { theme: "dark" }, pins: ["local:w1:p1"] });
    const saved = store.set({ settings: { theme: "light" }, muted_panes: ["w1:p1"], tab_labels: { "w1:p1|term_a": "Fix it" } });
    expect(saved).toEqual(named({ revision: 2, settings: { theme: "light" }, pins: ["local:w1:p1"], muted_panes: ["w1:p1"] }));
    expect(new PreferenceStore(dir).get()).toEqual(named({ revision: 2, settings: { theme: "light" }, pins: ["local:w1:p1"], muted_panes: ["w1:p1"] }));
    // turning the setting off cannot delete what it cannot read: the setting is saved all the same
    expect(store.set({ settings: { autoTabNames: false }, tab_labels: { "w1:p1|term_a": "Fix it" } }).settings).toMatchObject({ autoTabNames: false });
  });

  it("a labels file read at start that cannot be read later blocks no save, the setting turned off included", () => {
    const dir = root();
    writeFileSync(join(dir, "tab-labels.json"), JSON.stringify({ tab_labels: { "w1:p1|term_a": "Fix it" } }));
    const store = new PreferenceStore(dir);
    expect(store.get().tab_labels).toEqual({ "w1:p1|term_a": "Fix it" });
    rmSync(join(dir, "tab-labels.json"));
    mkdirSync(join(dir, "tab-labels.json"));
    expect(store.set({ settings: { autoTabNames: false, theme: "dark" }, tab_labels: { "w1:p2|term_b": "Next" } }).settings).toMatchObject({ autoTabNames: false, theme: "dark" });
    expect(JSON.parse(readFileSync(join(dir, "preferences.json"), "utf8")).settings).toMatchObject({ autoTabNames: false, theme: "dark" });
  });

  it("after the setting is turned off over an unreadable labels file, every later save of a setting, pin or mute goes through", () => {
    for (const start of ["loaded", "unreadable"] as const) {
      const dir = root();
      if (start === "loaded") writeFileSync(join(dir, "tab-labels.json"), JSON.stringify({ tab_labels: { "w1:p1|term_a": "Fix it" } }));
      else mkdirSync(join(dir, "tab-labels.json"));
      const store = new PreferenceStore(dir);
      if (start === "loaded") { rmSync(join(dir, "tab-labels.json")); mkdirSync(join(dir, "tab-labels.json")); }
      store.set({ settings: { autoTabNames: false } });
      expect(store.get().tab_labels).toBeUndefined();
      store.set({ settings: {}, pins: ["local:w1:p1"] });
      store.set({ settings: {}, muted_panes: ["w1:p1"] });
      store.set({ settings: { theme: "dark" } });
      expect(new PreferenceStore(dir).get()).toEqual(named({ revision: 4, settings: { autoTabNames: false, theme: "dark" }, pins: ["local:w1:p1"], muted_panes: ["w1:p1"] }));
    }
  });

  it("labels never make a save of the settings, pins or mutes too large: the labels that do not fit are left out", () => {
    const dir = root();
    const store = new PreferenceStore(dir);
    store.set({ settings: {}, tab_labels: { "w1:p1|term_a": "Fix it" } });
    // pins that fill the document all but the labels' room
    const pins = Array.from({ length: 220 }, (_, n) => `local:w1:p${n}:${"x".repeat(270)}`);
    const saved = store.set({ settings: {}, pins, tab_labels: Object.fromEntries(Array.from({ length: 60 }, (_, n) => [`w1:p${n + 10}|term_${n}`, "a".repeat(60)])) });
    expect(saved.pins).toHaveLength(220);
    expect(Object.keys(saved.tab_labels ?? {})).not.toContain("w1:p10|term_0");
    expect(new PreferenceStore(dir).get().pins).toHaveLength(220);
    // the labels held are left out of the document, never deleted from their file
    expect(JSON.parse(readFileSync(join(dir, "tab-labels.json"), "utf8"))).toEqual({ tab_labels: { "w1:p1|term_a": "Fix it" } });
    // the pins shrink: a label added next is laid over the held ones, read again from their file
    store.set({ settings: {}, pins: [] });
    expect(store.set({ settings: {}, tab_labels: { "w1:p2|term_b": "Next" } }).tab_labels).toEqual({ "w1:p1|term_a": "Fix it", "w1:p2|term_b": "Next" });
  });

  it("turning the setting off deletes labels left out of the document for their size", () => {
    const dir = root();
    const store = new PreferenceStore(dir);
    store.set({ settings: {}, tab_labels: { "w1:p1|term_a": "Fix it" } });
    const pins = Array.from({ length: 220 }, (_, n) => `local:w1:p${n}:${"x".repeat(270)}`);
    store.set({ settings: {}, pins, tab_labels: Object.fromEntries(Array.from({ length: 60 }, (_, n) => [`w1:p${n + 10}|term_${n}`, "a".repeat(60)])) });
    store.set({ settings: { autoTabNames: false } });
    expect(JSON.parse(readFileSync(join(dir, "tab-labels.json"), "utf8"))).toEqual({ tab_labels: {} });
  });

  it("labels a failed delete left while the setting was off are never loaded, and go with the next save", () => {
    const dir = root();
    const store = new PreferenceStore(dir);
    store.set({ settings: {}, tab_labels: { "w1:p1|term_a": "Private" } });
    const blocker = join(dir, `tab-labels.json.${process.pid}.tmp`);
    mkdirSync(blocker);
    expect(store.set({ settings: { autoTabNames: false } }).tab_labels).toBeUndefined();
    rmSync(blocker, { recursive: true });
    // the delete failed: the file still holds the label, a restart shows none
    expect(JSON.parse(readFileSync(join(dir, "tab-labels.json"), "utf8"))).toEqual({ tab_labels: { "w1:p1|term_a": "Private" } });
    const restarted = new PreferenceStore(dir);
    expect(restarted.get().tab_labels).toBeUndefined();
    // turned on again, it is deleted, never read back
    restarted.set({ settings: { autoTabNames: true } });
    expect(JSON.parse(readFileSync(join(dir, "tab-labels.json"), "utf8"))).toEqual({ tab_labels: {} });
    expect(restarted.set({ settings: {}, tab_labels: { "w1:p2|term_b": "New" } }).tab_labels).toEqual({ "w1:p2|term_b": "New" });
  });

  it("labels a save could not write leave memory even when its mutes then fail", () => {
    const dir = root();
    const store = new PreferenceStore(dir);
    store.set({ settings: {}, tab_labels: { "w1:p1|term_a": "Held" } });
    const labelBlocker = join(dir, `tab-labels.json.${process.pid}.tmp`);
    const muteBlocker = join(dir, `muted-panes.json.${process.pid}.tmp`);
    mkdirSync(labelBlocker);
    mkdirSync(muteBlocker);
    expect(() => store.set({ settings: {}, muted_panes: ["w1:p1"], tab_labels: { "w1:p2|term_b": "Next" } })).toThrow();
    expect(store.get().tab_labels).toBeUndefined();
  });

  it("turning the setting off deletes a labels file repaired after a damaged start, unread till then", () => {
    const dir = root();
    writeFileSync(join(dir, "tab-labels.json"), "{ not json");
    const store = new PreferenceStore(dir);
    writeFileSync(join(dir, "tab-labels.json"), JSON.stringify({ tab_labels: { "w1:p1|term_a": "Repaired" } }));
    store.set({ settings: { autoTabNames: false } });
    expect(JSON.parse(readFileSync(join(dir, "tab-labels.json"), "utf8"))).toEqual({ tab_labels: {} });
    expect(new PreferenceStore(dir).get().tab_labels).toBeUndefined();
  });

  it("a label save that failed is not held and fails nothing else, so its retry writes it", () => {
    const dir = root();
    const store = new PreferenceStore(dir);
    store.set({ settings: {}, tab_labels: { "w1:p1|term_a": "First" } });
    const blocker = join(dir, `tab-labels.json.${process.pid}.tmp`);
    mkdirSync(blocker);
    // the theme is saved; the labels leave memory until a change of them reads the file again
    expect(store.set({ settings: { theme: "dark" }, tab_labels: { "w1:p2|term_b": "Second" } })).toEqual(named({ revision: 2, settings: { theme: "dark" }, muted_panes: [] }));
    rmSync(blocker, { recursive: true });
    store.set({ settings: {}, tab_labels: { "w1:p2|term_b": "Second" } });
    expect(new PreferenceStore(dir).get().tab_labels).toEqual({ "w1:p1|term_a": "First", "w1:p2|term_b": "Second" });
  });

  it("an older release's save erases no tab label, and a damaged labels file is kept aside by the next label", async () => {
    const dir = root();
    const store = new PreferenceStore(dir);
    await put(store, JSON.stringify({ settings: { theme: "light" }, tab_labels: { "w1:p1|term_a": "Fix it" } }));
    const held = JSON.parse(readFileSync(join(dir, "preferences.json"), "utf8"));
    writeFileSync(join(dir, "preferences.json"), `${JSON.stringify({ revision: held.revision + 1, settings: { theme: "dark" } }, null, 2)}\n`);
    expect(new PreferenceStore(dir).get()).toEqual(named({ revision: 2, settings: { theme: "dark" }, muted_panes: [], tab_labels: { "w1:p1|term_a": "Fix it" } }));
    writeFileSync(join(dir, "tab-labels.json"), "{ not json");
    const damaged = new PreferenceStore(dir);
    expect(damaged.get().tab_labels).toBeUndefined();
    await put(damaged, JSON.stringify({ settings: {}, tab_labels: { "w1:p2|term_b": "Next" } }));
    expect(readFileSync(join(dir, "tab-labels.json.bad"), "utf8")).toBe("{ not json");
    expect(new PreferenceStore(dir).get().tab_labels).toEqual({ "w1:p2|term_b": "Next" });
  });

  it("starts from a labels file repaired after a damaged start, and keeps labels saved before a failed mute save", async () => {
    const dir = root();
    writeFileSync(join(dir, "tab-labels.json"), "{ not json");
    const store = new PreferenceStore(dir);
    writeFileSync(join(dir, "tab-labels.json"), JSON.stringify({ tab_labels: { "w1:p1|term_a": "Repaired" } }));
    // a change of something else reads no labels file, and writes none: the repaired one stays on disk
    expect(store.set({ settings: { theme: "dark" } }).tab_labels).toBeUndefined();
    expect(store.set({ settings: {}, tab_labels: { "w1:p2|term_b": "Next" } }).tab_labels).toEqual({ "w1:p1|term_a": "Repaired", "w1:p2|term_b": "Next" });
    // the mute list cannot be written: the labels went to disk first, and the store holds them for the next save
    const blocker = join(dir, `muted-panes.json.${process.pid}.tmp`);
    mkdirSync(blocker);
    expect(() => store.set({ settings: {}, muted_panes: ["w1:p1"], tab_labels: { "w1:p3|term_c": "Kept" } })).toThrow();
    rmSync(blocker, { recursive: true });
    expect(store.get().tab_labels).toEqual({ "w1:p1|term_a": "Repaired", "w1:p2|term_b": "Next", "w1:p3|term_c": "Kept" });
    store.set({ settings: { theme: "light" } });
    expect(new PreferenceStore(dir).get().tab_labels).toEqual({ "w1:p1|term_a": "Repaired", "w1:p2|term_b": "Next", "w1:p3|term_c": "Kept" });
  });

  it("a damaged mute list mutes nothing, leaves the settings, and is kept aside by the next mute", async () => {
    const dir = root();
    writeFileSync(join(dir, "preferences.json"), JSON.stringify({ revision: 2, settings: { theme: "light" } }));
    writeFileSync(join(dir, "muted-panes.json"), "{ not json");
    const store = new PreferenceStore(dir);
    expect(store.get()).toEqual({ revision: 2, settings: { theme: "light" }, muted_panes: [] });
    // a change of something else does not touch it
    await put(store, JSON.stringify({ settings: { theme: "dark" } }));
    expect(readFileSync(join(dir, "muted-panes.json"), "utf8")).toBe("{ not json");
    await put(store, JSON.stringify({ settings: {}, muted_panes: ["w1:p1"] }));
    expect(readFileSync(join(dir, "muted-panes.json.bad"), "utf8")).toBe("{ not json");
    expect(new PreferenceStore(dir).get()).toEqual(named({ revision: 4, settings: { theme: "dark" }, muted_panes: ["w1:p1"] }));
  });

  it("a mute whose save fails is not left on disk for a later revision to bring back", async () => {
    const dir = root();
    const store = new PreferenceStore(dir);
    await put(store, JSON.stringify({ settings: { theme: "light" } }));
    // preferences.json cannot be replaced: its temporary file's place is taken
    const blocker = join(dir, `preferences.json.${process.pid}.tmp`);
    mkdirSync(blocker);
    expect((await put(store, JSON.stringify({ settings: {}, muted_panes: ["w1:p1"] }))).status).toBe(500);
    expect(store.get()).toEqual(named({ revision: 1, settings: { theme: "light" }, muted_panes: [] }));
    rmSync(blocker, { recursive: true });
    // the next save, of something else, and a restart: the failed mute is nowhere
    expect(await (await put(store, JSON.stringify({ settings: { theme: "dark" } }))).json()).toEqual(named({ revision: 2, settings: { theme: "dark" }, muted_panes: [] }));
    expect(new PreferenceStore(dir).get()).toEqual(named({ revision: 2, settings: { theme: "dark" }, muted_panes: [] }));
  });

  it("a save that fails at the mute list keeps none of its settings or pins on disk", async () => {
    const dir = root();
    const store = new PreferenceStore(dir);
    await put(store, JSON.stringify({ settings: { theme: "light" }, muted_panes: ["w1:p0"] }));
    const bytes = (name: string) => readFileSync(join(dir, name));
    const before = { preferences: bytes("preferences.json"), mutes: bytes("muted-panes.json") };
    // the second document cannot be written: its temporary file's place is taken
    const blocker = join(dir, `muted-panes.json.${process.pid}.tmp`);
    mkdirSync(blocker);
    expect((await put(store, JSON.stringify({ settings: { theme: "dark" }, pins: ["local:w1:p1"], muted_panes: ["w1:p1"] }))).status).toBe(500);
    expect(store.get()).toEqual(named({ revision: 1, settings: { theme: "light" }, muted_panes: ["w1:p0"] }));
    // both documents on disk are byte for byte what they were before the refused save
    expect(bytes("preferences.json")).toEqual(before.preferences);
    expect(bytes("muted-panes.json")).toEqual(before.mutes);
    rmSync(blocker, { recursive: true });
    expect(new PreferenceStore(dir).get()).toEqual(named({ revision: 1, settings: { theme: "light" }, muted_panes: ["w1:p0"] }));
  });

  it("a failed save before the file was ever replaced keeps a manual repair for the next one", async () => {
    const dir = root();
    writeFileSync(join(dir, "preferences.json"), "{ not json");
    const store = new PreferenceStore(dir);
    // repaired by hand after the start
    writeFileSync(join(dir, "preferences.json"), JSON.stringify({ revision: 5, settings: { theme: "light" }, pins: ["local:w1:p1"] }));
    const blocker = join(dir, `muted-panes.json.${process.pid}.tmp`);
    mkdirSync(blocker);
    expect((await put(store, JSON.stringify({ settings: { showThinking: false }, muted_panes: ["w1:p1"] }))).status).toBe(500);
    rmSync(blocker, { recursive: true });
    // the next save is laid over the repair, not over what memory held before it
    expect(await (await put(store, JSON.stringify({ settings: { agentOrder: "activity" } }))).json()).toEqual(named({ revision: 6, settings: { theme: "light", agentOrder: "activity" }, pins: ["local:w1:p1"], muted_panes: [] }));
  });

  it("absent field does not clear mutes", async () => {
    const store = new PreferenceStore(root());
    await put(store, JSON.stringify({ settings: {}, muted_panes: ["w1:p1"] }));
    // a change that names no list (a theme from another browser, pins alone) leaves the mutes
    expect(await (await put(store, JSON.stringify({ settings: { theme: "dark" } }))).json()).toMatchObject({ revision: 2, muted_panes: ["w1:p1"] });
    expect(await (await put(store, JSON.stringify({ settings: {}, pins: ["local:w1:p1"] }))).json()).toMatchObject({ revision: 3, pins: ["local:w1:p1"], muted_panes: ["w1:p1"] });
  });

  it("refuses a mute list that is not one, and keeps the revision", async () => {
    const store = new PreferenceStore(root());
    for (const muted of [null, "w1:p1", [1], [""], ["x".repeat(301)], Array.from({ length: MAX_MUTED_PANES + 1 }, (_, i) => `p${i}`)]) {
      const refused = await put(store, JSON.stringify({ settings: {}, muted_panes: muted }));
      expect([JSON.stringify(muted).slice(0, 20), refused.status]).toEqual([JSON.stringify(muted).slice(0, 20), 400]);
    }
    expect(store.get()).toEqual({ revision: 0, settings: {}, muted_panes: [] });
    // the limits themselves are fine
    expect((await put(store, JSON.stringify({ settings: {}, muted_panes: ["x".repeat(300), ...Array.from({ length: MAX_MUTED_PANES - 1 }, (_, i) => `p${i}`)] }))).status).toBe(200);
    expect(store.get().muted_panes).toHaveLength(MAX_MUTED_PANES);
  });

});

describe("a damaged preferences file", () => {
  const file = (dir: string) => join(dir, "preferences.json");
  const bad = (dir: string) => `${file(dir)}.bad`;
  const files = (dir: string) => readdirSync(dir).sort();
  const quiet = () => spyOn(console, "error").mockImplementation(() => undefined);
  const expectPrivate = (path: string) => { if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600); };
  const get = async (store: PreferenceStore) => (await handlePreferencesRequest(new Request("http://x/api/preferences"), store)).json();

  it("preserves malformed bytes only on first effective write", async () => {
    const logged = quiet();
    const dir = root();
    const first = Buffer.from('{"revision": 7, "settings": {"theme": "dark"');
    writeFileSync(file(dir), first);
    const store = new PreferenceStore(dir);
    // reading changes nothing on disk
    expect(await get(store)).toEqual({ revision: 0, settings: {}, muted_panes: [] });
    expect(readFileSync(file(dir))).toEqual(first);
    expect(files(dir)).toEqual(["preferences.json"]);
    expect(logged.mock.calls.flat().join("\n")).toContain("not JSON");
    expect(logged.mock.calls.flat().join("\n")).not.toContain('"theme"');
    // the file changed to other damaged bytes since the start: those are the ones kept
    const current = Buffer.from("{still not json");
    writeFileSync(file(dir), current);
    expect((await put(store, JSON.stringify({ settings: { theme: "light" } }))).status).toBe(200);
    expect(readFileSync(bad(dir))).toEqual(current);
    expectPrivate(bad(dir));
    expect(new PreferenceStore(dir).get()).toEqual(named({ revision: 1, settings: { theme: "light" }, muted_panes: [] }));
    store.set({ settings: { agentOrder: "activity" } });
    expect(readFileSync(bad(dir))).toEqual(current);
    expect(files(dir)).toEqual(["preferences-id.json", "preferences.json", "preferences.json.bad"]);
    // damaged again: one generation, the latest
    const again = Buffer.from("\u0000\u0001 not json either");
    writeFileSync(file(dir), again);
    new PreferenceStore(dir).set({ settings: { theme: "dark" } });
    expect(readFileSync(bad(dir))).toEqual(again);
    expect(files(dir)).toEqual(["preferences-id.json", "preferences.json", "preferences.json.bad"]);
  });

  it.each([
    ["settings as a list", '{"revision":2,"settings":[],"pins":[]}'],
    ["a pin that is not a string", '{"revision":2,"settings":{"theme":"dark"},"pins":[1]}'],
    ["a list", "[]"],
    ["a string", '"preferences"'],
  ])("preserves wrong-shaped documents privately: %s", (_label, text) => {
    const logged = quiet();
    const dir = root();
    const bytes = Buffer.from(text);
    writeFileSync(file(dir), bytes, { mode: 0o644 });
    const store = new PreferenceStore(dir);
    expect(store.get()).toEqual({ revision: 0, settings: {}, muted_panes: [] });
    expect(readFileSync(file(dir))).toEqual(bytes);
    expect(files(dir)).toEqual(["preferences.json"]);
    expect(logged.mock.calls.flat().join("\n")).toContain("not a preferences document");
    store.set({ settings: { theme: "light" } });
    expect(readFileSync(bad(dir))).toEqual(bytes);
    expectPrivate(bad(dir));
    expect(files(dir)).toEqual(["preferences-id.json", "preferences.json", "preferences.json.bad"]);
    expect(new PreferenceStore(dir).get()).toEqual(named({ revision: 1, settings: { theme: "light" }, muted_panes: [] }));
  });

  it("keeps a manual repair rather than quarantining it", () => {
    quiet();
    const dir = root();
    writeFileSync(file(dir), "not json");
    const store = new PreferenceStore(dir);
    const heard: unknown[] = [];
    store.subscribe((preferences) => heard.push(preferences));
    // repaired by hand while the server runs
    writeFileSync(file(dir), JSON.stringify({ revision: 5, settings: { theme: "dark", agentOrder: "activity" }, pins: ["pc:w1:p1"] }));
    const expected = named({ revision: 6, settings: { theme: "light", agentOrder: "activity" }, pins: ["pc:w1:p1"], muted_panes: [] });
    expect(store.set({ settings: { theme: "light" } })).toEqual(expected);
    expect(heard).toEqual([expected]);
    expect(files(dir)).toEqual(["preferences-id.json", "preferences.json"]);
    expect(new PreferenceStore(dir).get()).toEqual(expected);
  });

  it("refuses to write over a file it cannot read", async () => {
    quiet();
    const dir = root();
    // a directory where the file should be: reading it fails, and it is not an absent file
    mkdirSync(file(dir));
    writeFileSync(join(file(dir), "keep"), "kept");
    const store = new PreferenceStore(dir);
    const heard: number[] = [];
    store.subscribe((preferences) => heard.push(preferences.revision));
    const failed = await put(store, JSON.stringify({ settings: { theme: "light" } }));
    expect(failed.status).toBe(500);
    expect(((await failed.json()) as { error: { code: string } }).error.code).toBe("preferences_unwritable");
    expect(readFileSync(join(file(dir), "keep"), "utf8")).toBe("kept");
    expect(files(dir)).toEqual(["preferences.json"]);
    expect(heard).toEqual([]);
  });

  it("refuses overwrite when preservation fails", async () => {
    quiet();
    const dir = root();
    const bytes = Buffer.from('{"settings": [1, 2, 3]}');
    writeFileSync(file(dir), bytes);
    // the older generation cannot be replaced: a directory with something in it
    mkdirSync(bad(dir));
    writeFileSync(join(bad(dir), "older"), "older");
    const store = new PreferenceStore(dir);
    const heard: number[] = [];
    store.subscribe((preferences) => heard.push(preferences.revision));
    const failed = await put(store, JSON.stringify({ settings: { theme: "light" } }));
    expect(failed.status).toBe(500);
    const { error } = (await failed.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe("preferences_unwritable");
    expect(error.message).toContain("preferences.json.bad");
    expect(readFileSync(file(dir))).toEqual(bytes);
    expect(readFileSync(join(bad(dir), "older"), "utf8")).toBe("older");
    expect(files(dir)).toEqual(["preferences-id.json", "preferences.json", "preferences.json.bad"]);
    expect(store.get()).toEqual({ revision: 0, settings: {}, muted_panes: [] });
    expect(heard).toEqual([]);
    // once it can be kept, the same change goes through
    rmSync(bad(dir), { recursive: true });
    expect((await put(store, JSON.stringify({ settings: { theme: "light" } }))).status).toBe(200);
    expect(readFileSync(bad(dir))).toEqual(bytes);
    expect(heard).toEqual([1]);
  });

  it("retains one bad generation across replacement failure", async () => {
    quiet();
    const dir = root();
    const bytes = Buffer.from("{damaged");
    writeFileSync(file(dir), bytes);
    writeFileSync(bad(dir), "an older damaged generation");
    const store = new PreferenceStore(dir);
    const heard: number[] = [];
    store.subscribe((preferences) => heard.push(preferences.revision));
    const rename = fs.renameSync;
    // replacing preferences.json fails (the folder's id is written first, and is not what this is about)
    const spy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith("preferences.json")) throw Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
      rename(from, to);
    });
    expect((await put(store, JSON.stringify({ settings: { theme: "light" } }))).status).toBe(500);
    spy.mockRestore();
    expect(readFileSync(bad(dir))).toEqual(bytes);
    expect(files(dir).filter((name) => name.endsWith(".bad"))).toEqual(["preferences.json.bad"]);
    expect(store.get()).toEqual({ revision: 0, settings: {}, muted_panes: [] });
    expect(heard).toEqual([]);
    // the retry finds no file to keep aside and leaves the recovery bytes where they are
    expect((await put(store, JSON.stringify({ settings: { theme: "light" } }))).status).toBe(200);
    expect(readFileSync(bad(dir))).toEqual(bytes);
    expect(files(dir)).toEqual(["preferences-id.json", "preferences.json", "preferences.json.bad"]);
    expect(heard).toEqual([1]);
    expect(new PreferenceStore(dir).get()).toEqual(named({ revision: 1, settings: { theme: "light" }, muted_panes: [] }));
  });

  it("preserves a file damaged after a valid start on the first write", () => {
    quiet();
    const dir = root();
    writeFileSync(file(dir), JSON.stringify({ revision: 3, settings: { theme: "dark" } }));
    const store = new PreferenceStore(dir);
    expect(store.get()).toEqual({ revision: 3, settings: { theme: "dark" }, muted_panes: [] });
    const bytes = Buffer.from("{damaged after the start");
    writeFileSync(file(dir), bytes);
    store.set({ settings: { theme: "light" } });
    expect(readFileSync(bad(dir))).toEqual(bytes);
    expectPrivate(bad(dir));
    expect(files(dir)).toEqual(["preferences-id.json", "preferences.json", "preferences.json.bad"]);
    expect(new PreferenceStore(dir).get()).toEqual(named({ revision: 4, settings: { theme: "light" }, muted_panes: [] }));
  });
});
