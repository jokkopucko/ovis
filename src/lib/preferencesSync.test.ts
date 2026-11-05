import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS, sanitizeSettings, sharedSettings, type Settings } from "./settings.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { prunePaneMutes } from "./paneMutes.ts";
import { preferencesChange, takePreferences, type Baseline, type Local } from "./preferencesSync.ts";

const base = (settings: Settings, pins: readonly string[] | null, muted: readonly string[] | null = null): Baseline => ({ settings: sharedSettings(settings), pins, muted });
const local = (settings: Settings, pins: readonly string[], muted: readonly string[] | null = null): Local => ({ settings, pins, muted });
const light: Settings = { ...DEFAULT_SETTINGS, theme: "light" };

describe("preferences sync", () => {
  it("sends the tab labels learned and dropped here, key by key", () => {
    const known: Baseline = { ...base(DEFAULT_SETTINGS, [], []), tabLabels: { "w1:p1|t1": "Server" } };
    expect(preferencesChange(known, { ...local(DEFAULT_SETTINGS, [], []), tabLabels: { "w1:p1|t1": "Server", "w1:p2|t2": "Learned" } })).toEqual({ settings: {}, tab_labels: { "w1:p2|t2": "Learned" } });
    // a pane seen closed here: the drop is no one's action, so it waits for one, and goes with it
    expect(preferencesChange(known, { ...local(DEFAULT_SETTINGS, [], []), tabLabels: {} })).toBeNull();
    expect(preferencesChange(known, { ...local(light, [], []), tabLabels: {} })).toEqual({ settings: { theme: "light" }, tab_labels_removed: ["w1:p1|t1"] });
    expect(preferencesChange(known, { ...local(DEFAULT_SETTINGS, [], []), tabLabels: { "w1:p1|t1": "Server" } })).toBeNull();
    // a label an earlier version learned from an attachment's path is replaced by the one learned again (#2637)
    const stale: Baseline = { ...known, tabLabels: { "w1:p1|t1": "@/Users/example/Library/\u2026" } };
    expect(preferencesChange(stale, { ...local(DEFAULT_SETTINGS, [], []), tabLabels: { "w1:p1|t1": "Fix footer" } })).toEqual({ settings: {}, tab_labels: { "w1:p1|t1": "Fix footer" }, tab_labels_removed: ["w1:p1|t1"] });
    expect(preferencesChange(stale, { ...local(DEFAULT_SETTINGS, [], []), tabLabels: {} })).toBeNull();
  });

  it("lays the tab labels learned and dropped here over another browser's, label by label", () => {
    const known: Baseline = { ...base(DEFAULT_SETTINGS, [], []), tabLabels: { "w1:p1|t1": "One", "w1:p2|t2": "Two" } };
    // here: p1 closed, p3 learned; there: p4 learned
    const mine: Local = { ...local(DEFAULT_SETTINGS, [], []), tabLabels: { "w1:p2|t2": "Two", "w1:p3|t3": "Three" } };
    const taken = takePreferences(known, mine, { revision: 2, settings: {}, pins: [], muted_panes: [], tab_labels: { "w1:p1|t1": "One", "w1:p2|t2": "Two", "w1:p4|t4": "Four" } }, null);
    expect(taken.tabLabels).toEqual({ "w1:p2|t2": "Two", "w1:p4|t4": "Four", "w1:p3|t3": "Three" });
    // what is still unsent goes out next, key by key
    expect(preferencesChange(taken.base, { ...mine, tabLabels: taken.tabLabels! })).toEqual({ settings: {}, tab_labels: { "w1:p3|t3": "Three" }, tab_labels_removed: ["w1:p1|t1"] });
    // nothing changed here: the server's map stands, a document without one holding none (the setting turned off elsewhere)
    expect(takePreferences(known, { ...mine, tabLabels: known.tabLabels! }, { revision: 3, settings: {}, pins: [], muted_panes: [] }, null).tabLabels).toEqual({});
  });

  it("keeps a label learned again over an attachment's one another browser's save brings back (#2682)", () => {
    const stale = "See @/Users/example/Library/\u2026";
    const known: Baseline = { ...base(DEFAULT_SETTINGS, [], []), tabLabels: { "w1:p1|t1": stale } };
    const mine: Local = { ...local(DEFAULT_SETTINGS, [], []), tabLabels: { "w1:p1|t1": "Fix footer" } };
    const taken = takePreferences(known, mine, { revision: 2, settings: {}, pins: [], muted_panes: [], tab_labels: { "w1:p1|t1": stale, "w1:p2|t2": "Two" } }, null);
    expect(taken.tabLabels).toEqual({ "w1:p1|t1": "Fix footer", "w1:p2|t2": "Two" });
    expect(preferencesChange(taken.base, { ...mine, tabLabels: taken.tabLabels! })).toEqual({ settings: {}, tab_labels: { "w1:p1|t1": "Fix footer" }, tab_labels_removed: ["w1:p1|t1"] });
  });

  it("sends no learned label while the setting is off, and takes the server's empty map", () => {
    const known: Baseline = { ...base(DEFAULT_SETTINGS, [], []), tabLabels: {} };
    const off = { ...DEFAULT_SETTINGS, autoTabNames: false };
    expect(preferencesChange({ ...known, settings: sharedSettings(off) }, { ...local(off, [], []), tabLabels: { "w1:p1|t1": "Unsent" } })).toBeNull();
    const taken = takePreferences(known, { ...local(DEFAULT_SETTINGS, [], []), tabLabels: { "w1:p1|t1": "Unsent" } }, { revision: 2, settings: { autoTabNames: false }, pins: [], muted_panes: [] }, null);
    expect(taken.tabLabels).toEqual({});
  });

  it("sends an older server no tab labels once it showed it keeps none", () => {
    const old: Baseline = { ...base(DEFAULT_SETTINGS, [], []), tabLabels: null };
    const mine: Local = { ...local(DEFAULT_SETTINGS, [], []), tabLabels: { "w1:p1|t1": "Mine" } };
    expect(preferencesChange(old, mine)).toBeNull();
    const taken = takePreferences(old, mine, { revision: 4, settings: {}, pins: [], muted_panes: [] }, null);
    expect(taken.tabLabels).toBeNull();
    expect(taken.base.tabLabels).toBeNull();
  });

  it("sends only the shared settings that changed, and the pins only when they did", () => {
    const known = base(DEFAULT_SETTINGS, ["local:w1:p1"]);
    expect(preferencesChange(known, local({ ...DEFAULT_SETTINGS, terminalFontSize: 20, alertsOn: false, wrapCode: true, markdownWidth: "full" }, ["local:w1:p1"]))).toBeNull();
    expect(preferencesChange(known, local({ ...light, terminalFontSize: 20, wrapCode: true, markdownWidth: "full" }, ["local:w1:p1"]))).toEqual({ settings: { theme: "light" } });
    expect(preferencesChange(known, local(DEFAULT_SETTINGS, []))).toEqual({ settings: {}, pins: [] });
    expect(preferencesChange(known, local({ ...DEFAULT_SETTINGS, usageOrder: ["claude"] }, ["local:w1:p1"]))).toEqual({ settings: { usageOrder: ["claude"] } });
  });

  it("while the server has held no pins, this browser's ride along with its first change, and alone they wait", () => {
    const unknown = base(DEFAULT_SETTINGS, null);
    expect(preferencesChange(unknown, local(DEFAULT_SETTINGS, ["local:w1:p1"]))).toBeNull();
    expect(preferencesChange(unknown, local(light, ["local:w1:p1"]))).toEqual({ settings: { theme: "light" }, pins: ["local:w1:p1"] });
  });

  it("takes the shared settings the server holds and leaves the device's own", () => {
    const mine: Settings = { ...light, terminalFontSize: 20, alertsOn: false, wrapCode: true, markdownWidth: "full" };
    const taken = takePreferences(base(mine, null), local(mine, []), { revision: 3, settings: { theme: "dark", palette: "catppuccin" } }, null);
    expect(taken.patch).toEqual({ theme: "dark", palette: "catppuccin", darkTheme: "catppuccin" });
    expect(taken.pins).toBeNull();
    expect(taken.base).toEqual({ settings: { ...sharedSettings(mine), theme: "dark", palette: "catppuccin", darkTheme: "catppuccin" }, pins: null, muted: null });
    // nothing to send once taken
    expect(preferencesChange(taken.base, local({ ...mine, ...taken.patch }, []))).toBeNull();
  });

  it("keeps a change made here and not yet sent, which then goes out over the server's value", () => {
    // the page opened with dark, the user chose light before the document arrived
    const taken = takePreferences(base(DEFAULT_SETTINGS, null), local(light, []), { revision: 1, settings: { theme: "dark", showThinking: false } }, null);
    expect(taken.patch).toEqual({ showThinking: false });
    expect(taken.base.settings["theme"]).toBe("dark");
    expect(preferencesChange(taken.base, local({ ...light, showThinking: false }, []))).toEqual({ settings: { theme: "light" }, pins: [] });
  });

  it("lets a later write from elsewhere win over a value already sent, and keeps the rest of the document", () => {
    // light is on its way; meanwhile another browser set the palette, and then the theme back to dark
    const inFlight = { settings: { theme: "light" } };
    const concurrent = takePreferences(base(DEFAULT_SETTINGS, []), local(light, []), { revision: 2, settings: { theme: "light", palette: "catppuccin" }, pins: [] }, inFlight);
    expect(concurrent.patch).toEqual({ theme: "light", palette: "catppuccin", lightTheme: "catppuccin" });
    const overtaken = takePreferences(base(DEFAULT_SETTINGS, []), local(light, []), { revision: 3, settings: { theme: "dark" }, pins: [] }, inFlight);
    expect(overtaken.patch).toEqual({ theme: "dark" });
    expect(preferencesChange(overtaken.base, local({ ...light, theme: "dark" }, []))).toBeNull();
  });

  it("keeps a setting or the pins changed back while the change was on its way, and sends them next", () => {
    // the switch went on and its change is on its way; the user turns it off again before the server's answer, which carries on
    const on = !DEFAULT_SETTINGS.showUsage;
    const taken = takePreferences(base(DEFAULT_SETTINGS, []), local(DEFAULT_SETTINGS, []), { revision: 1, settings: { showUsage: on }, pins: [] }, { settings: { showUsage: on } });
    expect(taken.patch).toEqual({});
    expect(preferencesChange(taken.base, local(DEFAULT_SETTINGS, []))).toEqual({ settings: { showUsage: DEFAULT_SETTINGS.showUsage } });
    // a pin made and taken back the same way
    const unpinned = takePreferences(base(DEFAULT_SETTINGS, []), local(DEFAULT_SETTINGS, []), { revision: 1, settings: {}, pins: ["local:w1:p1"] }, { settings: {}, pins: ["local:w1:p1"] });
    expect(unpinned.pins).toBeNull();
    expect(preferencesChange(unpinned.base, local(DEFAULT_SETTINGS, []))).toEqual({ settings: {}, pins: [] });
  });

  it("a refused change gives way where another browser saved the same setting or the pins since, and stays elsewhere", () => {
    // refused here: dark tokyo-night, the light side and a pin; meanwhile another browser saved its own dark theme and pins
    const local: Settings = sanitizeSettings({ ...DEFAULT_SETTINGS, darkTheme: "tokyo-night", lightTheme: "catppuccin-latte" });
    const known = base(DEFAULT_SETTINGS, ["pc:w2:p3"]);
    const remote = { revision: 4, settings: { darkTheme: "gruvbox", palette: "gruvbox", lightTheme: DEFAULT_SETTINGS.lightTheme }, pins: ["pc:w2:p3", "pc:w2:p4"] };
    const body = preferencesChange(known, { settings: local, pins: ["local:w1:p1"], muted: null })!;
    const refused = takePreferences(known, { settings: local, pins: ["local:w1:p1"], muted: null }, remote, null, false, body);
    expect(refused.patch).toEqual({ darkTheme: "gruvbox", palette: "gruvbox" });
    expect(refused.pins).toEqual(["pc:w2:p3", "pc:w2:p4"]);
    // what is left unsent is only what nobody changed elsewhere: the light side
    expect(preferencesChange(refused.base, { settings: sanitizeSettings({ ...local, ...refused.patch }), pins: refused.pins!, muted: null })).toEqual({ settings: { lightTheme: "catppuccin-latte" } });
    // not refused (about to be sent): the change made here stays and goes out over them
    const pending = takePreferences(known, { settings: local, pins: ["local:w1:p1"], muted: null }, remote, null);
    expect(pending.patch).toEqual({});
    expect(pending.pins).toBeNull();
  });

  it("a refused mute gives way to a list another browser saved since, and an unrefused one is laid over it pane by pane", () => {
    const known = base(DEFAULT_SETTINGS, [], ["local:w1:p1"]);
    const mine = ["local:w1:p1", "local:w1:p2"];
    const remote = { revision: 4, settings: {}, pins: [], muted_panes: [] };
    const body = preferencesChange(known, local(DEFAULT_SETTINGS, [], mine))!;
    expect(body).toEqual({ settings: {}, muted_panes: mine });
    const refused = takePreferences(known, local(DEFAULT_SETTINGS, [], mine), remote, null, false, body);
    expect(refused.muted).toEqual([]);
    expect(preferencesChange(refused.base, local(DEFAULT_SETTINGS, [], refused.muted!))).toBeNull();
    const pending = takePreferences(known, local(DEFAULT_SETTINGS, [], mine), remote, null);
    // not refused: the unmute of w1:p1 made elsewhere stands, and the mute of w1:p2 made here goes out over it
    expect(pending.muted).toEqual(["local:w1:p2"]);
    expect(preferencesChange(pending.base, local(DEFAULT_SETTINGS, [], pending.muted!))).toEqual({ settings: {}, muted_panes: ["local:w1:p2"] });
  });

  it("keeps an unmute made while the mute was on its way, and sends it next", () => {
    // the mute of P is in flight; the user unmutes P before the server's answer, which carries [P]
    const taken = takePreferences(base(DEFAULT_SETTINGS, [], []), local(DEFAULT_SETTINGS, [], []), { revision: 1, settings: {}, pins: [], muted_panes: ["local:w1:p"] }, { settings: {}, muted_panes: ["local:w1:p"] });
    expect(taken.muted).toBeUndefined();
    expect(preferencesChange(taken.base, local(DEFAULT_SETTINGS, [], []))).toEqual({ settings: {}, muted_panes: [] });
    // a pane another browser muted meanwhile, outside the change on its way, keeps its new state
    const other = takePreferences(base(DEFAULT_SETTINGS, [], []), local(DEFAULT_SETTINGS, [], []), { revision: 2, settings: {}, pins: [], muted_panes: ["local:w1:p", "local:w1:q"] }, { settings: {}, muted_panes: ["local:w1:p"] });
    expect(other.muted).toEqual(["local:w1:q"]);
  });

  it("two browsers muting different panes at once both keep their mute", () => {
    // A muted P and B muted Q, each before hearing the other: B takes A's document with its own change unsent
    const taken = takePreferences(base(DEFAULT_SETTINGS, [], []), local(DEFAULT_SETTINGS, [], ["local:w1:q"]), { revision: 2, settings: {}, pins: [], muted_panes: ["local:w1:p"] }, null);
    expect(taken.muted).toEqual(["local:w1:p", "local:w1:q"]);
    expect(preferencesChange(taken.base, local(DEFAULT_SETTINGS, [], taken.muted!))).toEqual({ settings: {}, muted_panes: ["local:w1:p", "local:w1:q"] });
  });

  it("a value changed here after the refusal is a new change: it stays and goes out over a document that arrives later", () => {
    const known = base(DEFAULT_SETTINGS, ["pc:w2:p3"]);
    const sent: Settings = sanitizeSettings({ ...DEFAULT_SETTINGS, darkTheme: "tokyo-night" });
    const body = preferencesChange(known, { settings: sent, pins: ["pc:w2:p3", "local:w1:p1"], muted: null })!;
    // refused; then the user picked kanagawa and unpinned the pane again before any document arrived
    const now: Settings = sanitizeSettings({ ...sent, darkTheme: "kanagawa" });
    // the document that arrives (another browser's, or this browser's own refused value that landed after all)
    for (const darkTheme of ["gruvbox", "tokyo-night"]) {
      const remote = { revision: 4, settings: { darkTheme, palette: darkTheme }, pins: ["pc:w2:p3", "pc:w2:p4"] };
      const taken = takePreferences(known, { settings: now, pins: ["pc:w2:p3", "local:w1:p2"], muted: null }, remote, null, false, body);
      expect(taken.patch).toEqual({});
      expect(taken.pins).toBeNull();
      expect(preferencesChange(taken.base, { settings: now, pins: ["pc:w2:p3", "local:w1:p2"], muted: null })).toEqual({ settings: { darkTheme: "kanagawa", palette: "kanagawa" }, pins: ["pc:w2:p3", "local:w1:p2"] });
    }
  });

  it("leaves a value this browser cannot read, and does not send its own back", () => {
    const taken = takePreferences(base(DEFAULT_SETTINGS, null), local(DEFAULT_SETTINGS, []), { revision: 1, settings: { theme: "purple", agentMarks: "yes", palette: "catppuccin", darkTheme: "catppuccin", lightTheme: "future-theme" } }, null);
    expect(taken.patch).toEqual({ palette: "catppuccin", darkTheme: "catppuccin" });
    expect(preferencesChange(taken.base, local(sanitizeSettings({ ...DEFAULT_SETTINGS, ...taken.patch }), []))).toBeNull();
  });

  it("keeps an unsent side edit over a legacy-only fixed-mode document", () => {
    const edited = sanitizeSettings({ ...DEFAULT_SETTINGS, darkTheme: "tokyo-night" });
    const taken = takePreferences(base(DEFAULT_SETTINGS, []), local(edited, []), { revision: 2, settings: { theme: "dark", palette: "catppuccin" } }, null);
    expect(taken.patch).toEqual({ theme: "dark" });
    expect(taken.base.settings.darkTheme).toBe("catppuccin");
    expect(preferencesChange(taken.base, local(sanitizeSettings({ ...edited, ...taken.patch }), []))).toEqual({
      settings: { palette: "tokyo-night", darkTheme: "tokyo-night" },
    });
  });

  it("joins this browser's pins to the first the server holds, then follows the last write", () => {
    const first = takePreferences(base(DEFAULT_SETTINGS, null), local(DEFAULT_SETTINGS, ["local:w1:p1"]), { revision: 1, settings: {}, pins: ["pc:w2:p3", "local:w1:p1"] }, null);
    expect(first.pins).toEqual(["pc:w2:p3", "local:w1:p1"]);
    expect(first.base.pins).toEqual(["pc:w2:p3", "local:w1:p1"]);
    const joined = takePreferences(base(DEFAULT_SETTINGS, null), local(DEFAULT_SETTINGS, ["local:w1:p1"]), { revision: 1, settings: {}, pins: ["pc:w2:p3"] }, null);
    expect(joined.pins).toEqual(["pc:w2:p3", "local:w1:p1"]);
    // the join is this browser's change: it goes out
    expect(preferencesChange(joined.base, local(DEFAULT_SETTINGS, joined.pins!))).toEqual({ settings: {}, pins: ["pc:w2:p3", "local:w1:p1"] });
    const later = takePreferences(base(DEFAULT_SETTINGS, ["pc:w2:p3"]), local(DEFAULT_SETTINGS, ["pc:w2:p3"]), { revision: 2, settings: {}, pins: [] }, null);
    expect(later.pins).toEqual([]);
    // a pin made here and not yet sent stays
    const pinning = takePreferences(base(DEFAULT_SETTINGS, ["pc:w2:p3"]), local(DEFAULT_SETTINGS, ["pc:w2:p3", "local:w1:p1"]), { revision: 2, settings: {}, pins: [] }, null);
    expect(pinning.pins).toBeNull();
    expect(pinning.base.pins).toEqual([]);
  });

  it("a watching device takes everything", () => {
    const taken = takePreferences(base(DEFAULT_SETTINGS, ["a:b"]), local(light, ["a:b", "c:d"]), { revision: 5, settings: { theme: "dark" }, pins: [] }, null, true);
    expect(taken.patch).toEqual({ theme: "dark" });
    expect(taken.pins).toEqual([]);
  });
  it("older server without muted_panes stays unsupported", () => {
    // a document without the list: the server keeps none, so there is nothing to take and nothing to send
    const taken = takePreferences(base(DEFAULT_SETTINGS, []), local(DEFAULT_SETTINGS, []), { revision: 1, settings: {}, pins: [] }, null);
    expect(taken.muted).toBeNull();
    expect(taken.base.muted).toBeNull();
    expect(preferencesChange(taken.base, local(DEFAULT_SETTINGS, []))).toBeNull();
    // even a list this page somehow holds is not made into a change: the server has no field for it
    expect(preferencesChange(taken.base, local(DEFAULT_SETTINGS, [], ["w1:p1"]))).toBeNull();
    // a server that kept a list and now sends a document without one keeps none any more: the
    // list held here stands down, and nothing is left to resend
    const dropped = takePreferences(base(DEFAULT_SETTINGS, [], ["w1:p1"]), local(DEFAULT_SETTINGS, [], ["w1:p1"]), { revision: 2, settings: {}, pins: [] }, null);
    expect(dropped.muted).toBeNull();
    expect(dropped.base.muted).toBeNull();
    expect(preferencesChange(dropped.base, local(DEFAULT_SETTINGS, [], ["w1:p1"]))).toBeNull();
  });

  it("takes the server's mute list, sends a change of it, and keeps an unsent one over an older document", () => {
    const first = takePreferences(base(DEFAULT_SETTINGS, null), local(DEFAULT_SETTINGS, []), { revision: 1, settings: {}, pins: [], muted_panes: [] }, null);
    expect(first.muted).toEqual([]);
    expect(first.base.muted).toEqual([]);
    // the first mute goes out as the whole list, with nothing else
    expect(preferencesChange(first.base, local(DEFAULT_SETTINGS, [], ["w1:p1"]))).toEqual({ settings: {}, muted_panes: ["w1:p1"] });
    // another browser's list replaces this one's once nothing is pending here
    const theirs = takePreferences(base(DEFAULT_SETTINGS, [], ["w1:p1"]), local(DEFAULT_SETTINGS, [], ["w1:p1"]), { revision: 2, settings: {}, muted_panes: [paneStorageId("pc-2", "w1:p1")] }, null);
    expect(theirs.muted).toEqual([paneStorageId("pc-2", "w1:p1")]);
    // a mute made here and not yet sent stays over a document from before it, and goes out next
    const pending = takePreferences(base(DEFAULT_SETTINGS, [], []), local(DEFAULT_SETTINGS, [], ["w1:p1"]), { revision: 2, settings: { theme: "light" }, muted_panes: [] }, null);
    expect(pending.muted).toBeUndefined();
    expect(pending.base.muted).toEqual([]);
    expect(preferencesChange(pending.base, local({ ...DEFAULT_SETTINGS, theme: "light" }, [], ["w1:p1"]))).toEqual({ settings: {}, muted_panes: ["w1:p1"] });
    // the document that answers the change carries it: it is the server's list now, not an edit of this page's
    const answered = takePreferences(base(DEFAULT_SETTINGS, [], []), local(DEFAULT_SETTINGS, [], ["w1:p1"]), { revision: 3, settings: {}, muted_panes: ["w1:p1"] }, { settings: {}, muted_panes: ["w1:p1"] });
    expect(answered.muted).toEqual(["w1:p1"]);
    // a watching device takes the list as it takes everything
    const watching = takePreferences(base(DEFAULT_SETTINGS, [], []), local(DEFAULT_SETTINGS, [], ["w1:p1"]), { revision: 3, settings: {}, muted_panes: [] }, null, true);
    expect(watching.muted).toEqual([]);
  });

  it("offline PC survives pruning", () => {
    const pane = (paneId: string) => ({ pane_id: paneId });
    const connected = (id: string, panes: string[]) => ({ id, state: "connected" as const, snapshot: { panes: panes.map(pane) } as never });
    const machines = [
      connected("local", ["w1:p1"]),
      { id: "away", state: "disconnected" as const, snapshot: { panes: [] } as never },
      { id: "loading", state: "connected" as const, snapshot: null },
    ];
    const keys = ["w1:p1", "w1:gone", paneStorageId("away", "w1:p1"), paneStorageId("loading", "w1:p1"), paneStorageId("unlisted", "w1:p1")];
    // only this page's connected, loaded PC says which of its panes are gone; the others keep every mute
    expect(prunePaneMutes(keys, machines)).toEqual(["w1:p1", paneStorageId("away", "w1:p1"), paneStorageId("loading", "w1:p1"), paneStorageId("unlisted", "w1:p1")]);
    // no roster yet: nothing is pruned
    expect(prunePaneMutes(keys, [])).toEqual(keys);
  });

  it("only authoritative PC snapshot removes gone panes", () => {
    const connected = (id: string, panes: string[]) => ({ id, state: "connected" as const, snapshot: { panes: panes.map((pane_id) => ({ pane_id })) } as never });
    const [theirs, theirGone, third] = [paneStorageId("pc-2", "w1:p1"), paneStorageId("pc-2", "w1:gone"), paneStorageId("pc 3", "w1:p1")];
    const keys = ["w1:p1", "w1:gone", theirs, theirGone, third];
    expect(prunePaneMutes(keys, [connected("local", ["w1:p1"]), connected("pc-2", ["w1:p1"])])).toEqual(["w1:p1", theirs, third]);
    // a PC's gone pane is pruned only by that PC's own snapshot: another connected PC says nothing of it
    expect(prunePaneMutes(keys, [connected("pc-2", ["w1:p1"])])).toEqual(["w1:p1", "w1:gone", theirs, third]);
    // a remote PC whose id is a prefix of another's prunes only its own keys
    expect(prunePaneMutes([paneStorageId("pc", "w1:p1"), theirs], [connected("pc", [])])).toEqual([theirs]);
  });
});
