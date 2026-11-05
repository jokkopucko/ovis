import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PINS } from "../../shared/preferences.ts";
import { PreferenceStore } from "../preferences.ts";
import { bridgePins } from "./pin-label.ts";

type Held = { address: string; state: string; labels: Record<string, string>; status?: { app: string; state: string } | null };

/** an agent's status, as the Agents list needs to draw a terminal */
const AGENT = { app: "claude-code", state: "idle" };

/**
 * hc's label and event calls over terminals held here: a label write comes back as hc tells it, a
 * `labels` event. `early` events reach the stream before its snapshot does, as hc may send them.
 */
function fakeCore(terminals: Held[]) {
  const written: { terminal: string; labels: Record<string, string> }[] = [];
  const state = { failing: false, early: [] as Record<string, unknown>[], held: null as Record<string, unknown>[] | null, answer: null as Promise<void> | null };
  /** resolves when the next label write reaches hc, before hc answers it */
  let writing = Promise.withResolvers<void>();
  let onData: ((chunk: Uint8Array) => void) | null = null;
  let onClose: (() => void) | null = null;
  let opened = Promise.withResolvers<void>();
  const tell = (event: Record<string, unknown>) => onData?.(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", method: "event", params: event })}\n`));
  const hc = {
    hello: async () => ({ version: "0.1.17", core: { id: "c1", name: "lab" } }),
    call: async (method: string, params: { terminal: string; labels: Record<string, string> }) => {
      if (method !== "terminal.label") throw new Error(`unexpected ${method}`);
      if (state.failing) throw new Error("hc is not answering");
      written.push(params);
      writing.resolve();
      writing = Promise.withResolvers<void>();
      const found = terminals.find((terminal) => terminal.address === params.terminal)!;
      for (const [key, value] of Object.entries(params.labels)) {
        if (value === "") delete found.labels[key];
        else found.labels[key] = value;
      }
      const event = { type: "labels", terminal: found.address, data: { labels: { ...found.labels } } };
      if (state.held) state.held.push(event);
      else tell(event);
      // hc's answer to the write waits, after its labels event was told
      if (state.answer) await state.answer;
      return found;
    },
    open: async (_method: string, _params: unknown, handlers: { onData: (chunk: Uint8Array) => void; onClose: () => void }) => {
      onData = handlers.onData;
      onClose = handlers.onClose;
      for (const event of state.early.splice(0)) tell(event);
      const snapshot = terminals.map((terminal) => ({ ...terminal, status: terminal.status === undefined ? AGENT : terminal.status, labels: { ...terminal.labels } }));
      queueMicrotask(() => opened.resolve());
      return { result: { channel: 1, seq: 1, terminals: snapshot }, channel: { close: async () => {} } };
    },
  };
  /** the stream ends, as when hc restarts; resolves once the bridge has read the next snapshot */
  const drop = () => { opened = Promise.withResolvers<void>(); onClose?.(); return opened.promise; };
  /** label events held back since `state.held` was set, told now */
  const release = () => { const held = state.held ?? []; state.held = null; for (const event of held) tell(event); };
  return { hc: hc as never, written, state, tell, drop, release, opened: () => opened.promise, writing: () => writing.promise };
}

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-pins-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function store(dir: string, pins?: string[]) {
  const preferences = new PreferenceStore(dir);
  if (pins) preferences.set({ settings: {}, pins });
  return preferences;
}

function bridge(core: ReturnType<typeof fakeCore>, preferences: PreferenceStore, dir: string) {
  const pins = bridgePins(core.hc, preferences, "local", dir, 0);
  cleanups.push(pins.stop);
  return pins;
}

describe("bridgePins", () => {
  it("keeps both sides' pins when they first meet, and only this PC's agent pins", async () => {
    const dir = stateDir();
    const preferences = store(dir, ["local:t2", "local:workspace:s1", "remote:t9"]);
    const core = fakeCore([
      { address: "t1", state: "live", labels: { "herdr.pinned": "1" } },
      { address: "t2", state: "live", labels: {} },
      { address: "t3", state: "live", labels: {} },
    ]);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    await pins.idle();
    expect(preferences.get().pins).toEqual(["local:t2", "local:workspace:s1", "remote:t9", "local:t1"]);
    expect(core.written).toEqual([{ terminal: "t2", labels: { "herdr.pinned": "1" } }]);
  });

  it("writes a pin or unpin made in a browser on its terminal, and takes one made in the Herdr app", async () => {
    const dir = stateDir();
    const preferences = store(dir, ["local:t1"]);
    const core = fakeCore([
      { address: "t1", state: "live", labels: { "herdr.pinned": "1" } },
      { address: "t2", state: "live", labels: {} },
    ]);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    preferences.set({ settings: {}, pins: ["local:t2"] });
    await pins.idle();
    expect(core.written).toEqual([
      { terminal: "t1", labels: { "herdr.pinned": "" } },
      { terminal: "t2", labels: { "herdr.pinned": "1" } },
    ]);
    // the Herdr app unpins t2, then a new terminal starts pinned there
    core.tell({ type: "labels", terminal: "t2", data: { labels: {} } });
    core.tell({ type: "created", terminal: "t4", data: { address: "t4", state: "live", status: AGENT, labels: { "herdr.pinned": "1" } } });
    expect(preferences.get().pins).toEqual(["local:t4"]);
    // a settings change from a browser writes nothing
    preferences.set({ settings: { theme: "dark" } });
    await pins.idle();
    expect(core.written).toHaveLength(2);
  });

  it("keeps an unpin made in the Herdr app while Ovis was stopped, and one made in Ovis while hc was away", async () => {
    const dir = stateDir();
    const terminals: Held[] = [
      { address: "t1", state: "live", labels: { "herdr.pinned": "1" } },
      { address: "t2", state: "live", labels: {} },
    ];
    const core = fakeCore(terminals);
    const first = bridge(core, store(dir, ["local:t1"]), dir);
    await core.opened();
    await first.idle();
    first.stop();
    // Ovis stopped; the Herdr app unpins t1, and a browser had pinned t2 meanwhile
    delete terminals[0]!.labels["herdr.pinned"];
    const preferences = new PreferenceStore(dir);
    preferences.set({ settings: {}, pins: ["local:t1", "local:t2"] });
    const again = fakeCore(terminals);
    const second = bridge(again, preferences, dir);
    await again.opened();
    await second.idle();
    expect(preferences.get().pins).toEqual(["local:t2"]);
    expect(again.written).toEqual([{ terminal: "t2", labels: { "herdr.pinned": "1" } }]);
  });

  it("writes a pin made while hc refused it once hc is back, instead of taking it for an unpin", async () => {
    const dir = stateDir();
    const preferences = store(dir, []);
    const core = fakeCore([{ address: "t1", state: "live", labels: {} }]);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    core.state.failing = true;
    preferences.set({ settings: {}, pins: ["local:t1"] });
    await pins.idle();
    core.state.failing = false;
    await core.drop();
    await pins.idle();
    expect(preferences.get().pins).toEqual(["local:t1"]);
    expect(core.written).toEqual([{ terminal: "t1", labels: { "herdr.pinned": "1" } }]);
  });

  it("applies an event that came before its stream's snapshot after it", async () => {
    const dir = stateDir();
    const preferences = store(dir, []);
    const core = fakeCore([{ address: "t1", state: "live", labels: {} }]);
    core.state.early.push({ type: "labels", terminal: "t1", data: { labels: { "herdr.pinned": "1" } } });
    bridge(core, preferences, dir);
    await core.opened();
    expect(preferences.get().pins).toEqual(["local:t1"]);
  });

  it("leaves a pin from the Herdr app out when the list is full, never past what the server reads back", async () => {
    const dir = stateDir();
    const full = Array.from({ length: MAX_PINS }, (_, index) => `local:workspace:w${index}`);
    const preferences = store(dir, full);
    const core = fakeCore([{ address: "t1", state: "live", labels: { "herdr.pinned": "1" } }]);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    await pins.idle();
    expect(preferences.get().pins).toHaveLength(MAX_PINS);
    expect(new PreferenceStore(dir).get().pins).toHaveLength(MAX_PINS);
    expect(core.written).toEqual([]);
    // a later change of anything else does not take it for an unpin
    preferences.set({ settings: { theme: "dark" } });
    await pins.idle();
    expect(core.written).toEqual([]);
    // once the list has room, the pin joins it
    preferences.set({ settings: {}, pins: full.slice(1) });
    await pins.idle();
    expect(preferences.get().pins).toEqual([...full.slice(1), "local:t1"]);
    expect(core.written).toEqual([]);
  });

  it("leaves a shell's pin to the Herdr app, so the Agents list pruning it unpins nothing, and syncs it once an agent runs there", async () => {
    const dir = stateDir();
    const preferences = store(dir, []);
    const core = fakeCore([{ address: "t1", state: "live", status: null, labels: { "herdr.pinned": "1" } }, { address: "t2", state: "live", labels: {} }]);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    await pins.idle();
    expect(preferences.get().pins).toEqual([]);
    // a browser pins t2; its roster prunes nothing that it never had
    preferences.set({ settings: {}, pins: ["local:t2"] });
    await pins.idle();
    expect(core.written).toEqual([{ terminal: "t2", labels: { "herdr.pinned": "1" } }]);
    core.tell({ type: "status", terminal: "t1", data: { status: AGENT } });
    expect(preferences.get().pins).toEqual(["local:t2", "local:t1"]);
  });

  it("leaves another hc machine's terminals alone: this PC shows none of them, so its list never unpins them (#2768)", async () => {
    const dir = stateDir();
    const preferences = store(dir, []);
    const core = fakeCore([{ address: "t1", state: "live", labels: {} }, { address: "vps/t2", state: "live", labels: { "herdr.pinned": "1" } }]);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    core.tell({ type: "created", terminal: "vps/t3", data: { address: "vps/t3", state: "live", status: AGENT, labels: { "herdr.pinned": "1" } } });
    await pins.idle();
    expect(preferences.get().pins).toEqual([]);
    preferences.set({ settings: {}, pins: ["local:t1"] });
    await pins.idle();
    expect(core.written).toEqual([{ terminal: "t1", labels: { "herdr.pinned": "1" } }]);
  });

  it("stops syncing a terminal told again without an agent, as a remote PC coming back tells it", async () => {
    const dir = stateDir();
    const preferences = store(dir, []);
    const core = fakeCore([{ address: "t1", state: "live", labels: { "herdr.pinned": "1" } }, { address: "t2", state: "live", labels: {} }]);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    await pins.idle();
    expect(preferences.get().pins).toEqual(["local:t1"]);
    // back from a remote PC, t1 is a shell now; the Agents list then drops its pin when t2 is pinned
    core.tell({ type: "created", terminal: "t1", data: { address: "t1", state: "live", status: null, labels: { "herdr.pinned": "1" } } });
    preferences.set({ settings: {}, pins: ["local:t2"] });
    await pins.idle();
    expect(core.written).toEqual([{ terminal: "t2", labels: { "herdr.pinned": "1" } }]);
  });

  it("keeps the Herdr app's pin of a terminal that quit its agent while Ovis was stopped, once an agent runs there again", async () => {
    const dir = stateDir();
    const terminals: Held[] = [
      { address: "t1", state: "live", labels: { "herdr.pinned": "1" } },
      { address: "t2", state: "live", labels: {} },
    ];
    const first = fakeCore(terminals);
    const earlier = bridge(first, store(dir, ["local:t1"]), dir);
    await first.opened();
    await earlier.idle();
    earlier.stop();
    // Ovis stopped; the agent in t1 quit, leaving its shell
    terminals[0]!.status = null;
    const preferences = new PreferenceStore(dir);
    const core = fakeCore(terminals);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    // a browser pins t2; the Agents list drops the shell's pin
    preferences.set({ settings: {}, pins: ["local:t2"] });
    await pins.idle();
    core.tell({ type: "status", terminal: "t1", data: { status: AGENT } });
    await pins.idle();
    expect(preferences.get().pins).toEqual(["local:t2", "local:t1"]);
    expect(core.written).toEqual([{ terminal: "t2", labels: { "herdr.pinned": "1" } }]);
  });

  for (const when of ["while Ovis was stopped", "after Ovis came back"] as const) {
    it(`keeps an unpin made in the Herdr app ${when}, of a terminal that came back a shell, once an agent runs there again`, async () => {
      const dir = stateDir();
      const terminals: Held[] = [{ address: "t1", state: "live", labels: { "herdr.pinned": "1" } }];
      const first = fakeCore(terminals);
      const earlier = bridge(first, store(dir, ["local:t1"]), dir);
      await first.opened();
      await earlier.idle();
      earlier.stop();
      terminals[0]!.status = null;
      if (when === "while Ovis was stopped") delete terminals[0]!.labels["herdr.pinned"];
      const preferences = new PreferenceStore(dir);
      const core = fakeCore(terminals);
      const pins = bridge(core, preferences, dir);
      await core.opened();
      if (when === "after Ovis came back") core.tell({ type: "labels", terminal: "t1", data: { labels: {} } });
      core.tell({ type: "status", terminal: "t1", data: { status: AGENT } });
      await pins.idle();
      expect(preferences.get().pins).toEqual([]);
      expect(core.written).toEqual([]);
    });
  }

  it("keeps the Herdr app's pin of a terminal whose agent quit before Ovis stopped and came back while it was stopped", async () => {
    const dir = stateDir();
    const terminals: Held[] = [{ address: "t1", state: "live", labels: { "herdr.pinned": "1" } }, { address: "t2", state: "live", labels: {} }];
    const first = fakeCore(terminals);
    const preferences = store(dir, ["local:t1"]);
    const earlier = bridge(first, preferences, dir);
    await first.opened();
    await earlier.idle();
    // t1's agent quits; the Agents list drops the shell's pin as t2 is pinned; Ovis stops
    first.tell({ type: "status", terminal: "t1", data: { status: null } });
    preferences.set({ settings: {}, pins: ["local:t2"] });
    await earlier.idle();
    earlier.stop();
    const core = fakeCore(terminals);
    const pins = bridge(core, new PreferenceStore(dir), dir);
    await core.opened();
    await pins.idle();
    expect(new PreferenceStore(dir).get().pins).toEqual(["local:t2", "local:t1"]);
    expect(core.written).toEqual([]);
  });

  it("keeps the Herdr app's pin of a terminal back from a shell that a full list left out, through later changes", async () => {
    const dir = stateDir();
    const full = Array.from({ length: MAX_PINS - 1 }, (_, index) => `local:workspace:w${index}`);
    const preferences = store(dir, ["local:t1"]);
    const core = fakeCore([{ address: "t1", state: "live", labels: { "herdr.pinned": "1" } }]);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    await pins.idle();
    core.tell({ type: "status", terminal: "t1", data: { status: null } });
    preferences.set({ settings: {}, pins: [...full, "local:workspace:last"] });
    core.tell({ type: "status", terminal: "t1", data: { status: AGENT } });
    preferences.set({ settings: { theme: "dark" } });
    await pins.idle();
    expect(core.written).toEqual([]);
    preferences.set({ settings: {}, pins: full });
    await pins.idle();
    expect(preferences.get().pins).toEqual([...full, "local:t1"]);
    expect(core.written).toEqual([]);
  });

  it("keeps the Herdr app's pin of a terminal whose agent quit while its events were cut off, once an agent runs there again", async () => {
    const dir = stateDir();
    const preferences = store(dir, []);
    const terminals: Held[] = [{ address: "t1", state: "live", labels: {} }, { address: "t2", state: "live", labels: {} }];
    const core = fakeCore(terminals);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    preferences.set({ settings: {}, pins: ["local:t1"] });
    await pins.idle();
    // the stream drops while t1's agent quits; then the Agents list drops the shell's pin as t2 is pinned
    terminals[0]!.status = null;
    await core.drop();
    preferences.set({ settings: {}, pins: ["local:t2"] });
    await pins.idle();
    core.tell({ type: "status", terminal: "t1", data: { status: AGENT } });
    await pins.idle();
    expect(preferences.get().pins).toEqual(["local:t2", "local:t1"]);
    expect(core.written).toEqual([{ terminal: "t1", labels: { "herdr.pinned": "1" } }, { terminal: "t2", labels: { "herdr.pinned": "1" } }]);
  });

  it("keeps an unpin made in Ovis whose label write failed, of a terminal that came back a shell, once an agent runs there again", async () => {
    const dir = stateDir();
    const preferences = store(dir, ["local:t1"]);
    const terminals: Held[] = [{ address: "t1", state: "live", labels: { "herdr.pinned": "1" } }];
    const core = fakeCore(terminals);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    await pins.idle();
    // hc is away: the unpin's label write fails, and t1's agent quits meanwhile
    core.state.failing = true;
    preferences.set({ settings: {}, pins: [] });
    await pins.idle();
    terminals[0]!.status = null;
    await core.drop();
    await pins.idle();
    core.state.failing = false;
    core.tell({ type: "status", terminal: "t1", data: { status: AGENT } });
    await pins.idle();
    expect(preferences.get().pins).toEqual([]);
    expect(terminals[0]!.labels).toEqual({});
    expect(core.written).toEqual([{ terminal: "t1", labels: { "herdr.pinned": "" } }]);
  });

  it("keeps a pin the Herdr app made again after an Ovis unpin whose label write failed, while the terminal was a shell", async () => {
    const dir = stateDir();
    const preferences = store(dir, ["local:t1"]);
    const terminals: Held[] = [{ address: "t1", state: "live", labels: { "herdr.pinned": "1" } }];
    const core = fakeCore(terminals);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    await pins.idle();
    core.state.failing = true;
    preferences.set({ settings: {}, pins: [] });
    await pins.idle();
    // t1's agent quits; the Herdr app unpins it, then pins it again
    core.tell({ type: "status", terminal: "t1", data: { status: null } });
    core.tell({ type: "labels", terminal: "t1", data: { labels: {} } });
    core.tell({ type: "labels", terminal: "t1", data: { labels: { "herdr.pinned": "1" } } });
    core.state.failing = false;
    core.tell({ type: "status", terminal: "t1", data: { status: AGENT } });
    await pins.idle();
    expect(preferences.get().pins).toEqual(["local:t1"]);
    expect(core.written).toEqual([]);
  });

  it("takes a pin whose write landed but whose answer failed for no pending change of Ovis's", async () => {
    const dir = stateDir();
    const preferences = store(dir, []);
    const core = fakeCore([{ address: "t1", state: "live", labels: {} }, { address: "t2", state: "live", labels: {} }]);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    await pins.idle();
    const answer = Promise.withResolvers<void>();
    core.state.answer = answer.promise;
    const reached = core.writing();
    preferences.set({ settings: {}, pins: ["local:t1"] });
    await reached;
    core.state.answer = null;
    answer.reject(new Error("reply lost"));
    await pins.idle();
    // t1's agent quits; the Agents list drops the shell's pin as t2 is pinned
    core.tell({ type: "status", terminal: "t1", data: { status: null } });
    preferences.set({ settings: {}, pins: ["local:t2"] });
    await pins.idle();
    core.tell({ type: "status", terminal: "t1", data: { status: AGENT } });
    await pins.idle();
    expect(preferences.get().pins).toEqual(["local:t2", "local:t1"]);
  });

  it("takes an Ovis unpin that failed after Ovis pinned again for no pending change", async () => {
    const dir = stateDir();
    const preferences = store(dir, ["local:t1"]);
    const core = fakeCore([{ address: "t1", state: "live", labels: { "herdr.pinned": "1" } }, { address: "t2", state: "live", labels: {} }]);
    const gate = Promise.withResolvers<void>();
    const hc = core.hc as unknown as { call: (method: string, params: unknown) => Promise<unknown> };
    const call = hc.call;
    const hanging = { on: false };
    const reached = Promise.withResolvers<void>();
    hc.call = async (method, params) => {
      if (!hanging.on) return call(method, params);
      reached.resolve();
      await gate.promise;
      throw new Error("hc is not answering");
    };
    const pins = bridge(core, preferences, dir);
    await core.opened();
    await pins.idle();
    // Ovis unpins t1 and its write hangs; Ovis pins it again, then t1's agent quits and the write fails
    hanging.on = true;
    preferences.set({ settings: {}, pins: [] });
    await reached.promise;
    preferences.set({ settings: {}, pins: ["local:t1"] });
    core.tell({ type: "status", terminal: "t1", data: { status: null } });
    gate.resolve();
    await pins.idle();
    hanging.on = false;
    // the Agents list drops the shell's pin as t2 is pinned
    preferences.set({ settings: {}, pins: ["local:t2"] });
    await pins.idle();
    core.tell({ type: "status", terminal: "t1", data: { status: AGENT } });
    await pins.idle();
    expect(preferences.get().pins).toEqual(["local:t2", "local:t1"]);
  });

  it("keeps a pin made again in Ovis while the retry of its failed unpin waited, once the retry fails too", async () => {
    const dir = stateDir();
    const preferences = store(dir, ["local:t1"]);
    const core = fakeCore([{ address: "t1", state: "live", labels: { "herdr.pinned": "1" } }, { address: "t2", state: "live", labels: {} }]);
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const hc = core.hc as unknown as { call: (method: string, params: unknown) => Promise<unknown> };
    const call = hc.call;
    const mode = { now: "pass" as "pass" | "fail" | "hang" };
    hc.call = async (method, params) => {
      if (mode.now === "pass") return call(method, params);
      if (mode.now === "hang") { reached.resolve(); await gate.promise; }
      else mode.now = "hang";
      throw new Error("hc is not answering");
    };
    const pins = bridge(core, preferences, dir);
    await core.opened();
    await pins.idle();
    // the unpin fails; its retry hangs while Ovis pins t1 again and t1's agent quits, then fails too
    mode.now = "fail";
    preferences.set({ settings: {}, pins: [] });
    await reached.promise;
    preferences.set({ settings: {}, pins: ["local:t1"] });
    core.tell({ type: "status", terminal: "t1", data: { status: null } });
    gate.resolve();
    await pins.idle();
    mode.now = "pass";
    // the Agents list drops the shell's pin as t2 is pinned
    preferences.set({ settings: {}, pins: ["local:t2"] });
    await pins.idle();
    core.tell({ type: "status", terminal: "t1", data: { status: AGENT } });
    await pins.idle();
    expect(preferences.get().pins).toEqual(["local:t2", "local:t1"]);
    expect(core.written).toEqual([{ terminal: "t2", labels: { "herdr.pinned": "1" } }]);
  });

  for (const first of ["hangs", "fails and its retry hangs"] as const) {
    it(`keeps a pin made again in Ovis when an unpin's write ${first}, and the shell's row is pruned before it fails`, async () => {
      const dir = stateDir();
      const preferences = store(dir, ["local:t1"]);
      const core = fakeCore([{ address: "t1", state: "live", labels: { "herdr.pinned": "1" } }, { address: "t2", state: "live", labels: {} }]);
      const gate = Promise.withResolvers<void>();
      const reached = Promise.withResolvers<void>();
      const hc = core.hc as unknown as { call: (method: string, params: unknown) => Promise<unknown> };
      const call = hc.call;
      const mode = { now: "pass" as "pass" | "fail" | "hang" };
      hc.call = async (method, params) => {
        if (mode.now === "pass") return call(method, params);
        if (mode.now === "hang") { reached.resolve(); await gate.promise; }
        else mode.now = "hang";
        throw new Error("hc is not answering");
      };
      const pins = bridge(core, preferences, dir);
      await core.opened();
      await pins.idle();
      mode.now = first === "hangs" ? "hang" : "fail";
      preferences.set({ settings: {}, pins: [] });
      await reached.promise;
      // Ovis pins t1 again; its agent quits and the Agents list drops the shell's pin as t2 is pinned
      preferences.set({ settings: {}, pins: ["local:t1"] });
      core.tell({ type: "status", terminal: "t1", data: { status: null } });
      mode.now = "pass";
      preferences.set({ settings: {}, pins: ["local:t2"] });
      mode.now = "hang";
      gate.resolve();
      await pins.idle();
      mode.now = "pass";
      await pins.idle();
      core.tell({ type: "status", terminal: "t1", data: { status: AGENT } });
      await pins.idle();
      expect(preferences.get().pins).toEqual(["local:t2", "local:t1"]);
      expect(core.written.filter((write) => write.terminal === "t1")).toEqual([]);
    });
  }

  it("saves the pending mark of a failed Ovis unpin on a later failed write when the first save failed", async () => {
    const dir = stateDir();
    const preferences = store(dir, ["local:t1"]);
    const core = fakeCore([{ address: "t1", state: "live", labels: { "herdr.pinned": "1" } }]);
    const hc = core.hc as unknown as { call: (method: string, params: unknown) => Promise<unknown> };
    const call = hc.call;
    let attempts = 0;
    const second = Promise.withResolvers<void>();
    hc.call = async (method, params) => {
      if (!core.state.failing) return call(method, params);
      attempts += 1;
      if (attempts === 2) second.resolve();
      throw new Error("hc is not answering");
    };
    const pins = bridge(core, preferences, dir);
    await core.opened();
    await pins.idle();
    // the first failed unpin cannot save its mark: the pins file's temporary path is taken
    const blocker = join(dir, `herdr-core-pins.json.${process.pid}.tmp`);
    mkdirSync(blocker);
    core.state.failing = true;
    preferences.set({ settings: {}, pins: [] });
    await pins.idle();
    rmSync(blocker, { recursive: true });
    await second.promise;
    await pins.idle();
    pins.stop();
    expect(JSON.parse(readFileSync(join(dir, "herdr-core-pins.json"), "utf8")).pending).toEqual(["c1/t1"]);
  });

  it("keeps the last of a quick pin and unpin, whatever order hc's answer and event come in", async () => {
    const dir = stateDir();
    const preferences = store(dir, []);
    const core = fakeCore([{ address: "t1", state: "live", labels: {} }]);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    await pins.idle();
    // the pin's write reaches hc; the unpin comes before the write's own labels event does
    core.state.held = [];
    const reached = core.writing();
    preferences.set({ settings: {}, pins: ["local:t1"] });
    await reached;
    preferences.set({ settings: {}, pins: [] });
    core.release();
    await pins.idle();
    expect(preferences.get().pins).toEqual([]);
    expect(core.written).toEqual([{ terminal: "t1", labels: { "herdr.pinned": "1" } }, { terminal: "t1", labels: { "herdr.pinned": "" } }]);
  });

  it("writes no label from an old agreement while no browser has shared its pins", async () => {
    const dir = stateDir();
    // agreed pinned by an earlier run, then preferences.json was lost: no list is shared now
    const first = fakeCore([{ address: "t1", state: "live", labels: { "herdr.pinned": "1" } }]);
    const earlier = bridge(first, store(dir, []), dir);
    await first.opened();
    await earlier.idle();
    earlier.stop();
    rmSync(join(dir, "preferences.json"), { force: true });
    const preferences = new PreferenceStore(dir);
    const core = fakeCore([{ address: "t1", state: "live", labels: { "herdr.pinned": "1" } }]);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    await pins.idle();
    expect(core.written).toEqual([]);
  });

  it("keeps two pins made in the Herdr app one right after the other", async () => {
    const dir = stateDir();
    const preferences = store(dir, []);
    const core = fakeCore([{ address: "t1", state: "live", labels: {} }, { address: "t2", state: "live", labels: {} }]);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    await pins.idle();
    core.tell({ type: "labels", terminal: "t1", data: { labels: { "herdr.pinned": "1" } } });
    core.tell({ type: "labels", terminal: "t2", data: { labels: { "herdr.pinned": "1" } } });
    await pins.idle();
    expect(preferences.get().pins).toEqual(["local:t1", "local:t2"]);
    expect(core.written).toEqual([]);
  });

  it("takes our own writes' labels events for ours even when they come after hc's answers", async () => {
    const dir = stateDir();
    const preferences = store(dir, []);
    const core = fakeCore([{ address: "t1", state: "live", labels: {} }]);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    await pins.idle();
    core.state.held = [];
    preferences.set({ settings: {}, pins: ["local:t1"] });
    await pins.idle();
    preferences.set({ settings: {}, pins: [] });
    await pins.idle();
    core.release();
    await pins.idle();
    expect(preferences.get().pins).toEqual([]);
    expect(core.written.map((write) => write.labels["herdr.pinned"])).toEqual(["1", ""]);
  });

  it("keeps an unpin made in the Herdr app while our own pin write waits for hc's answer", async () => {
    const dir = stateDir();
    const preferences = store(dir, []);
    const terminals: Held[] = [{ address: "t1", state: "live", labels: {} }];
    const core = fakeCore(terminals);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    await pins.idle();
    const answer = Promise.withResolvers<void>();
    core.state.answer = answer.promise;
    const reached = core.writing();
    preferences.set({ settings: {}, pins: ["local:t1"] });
    await reached;
    // our pin landed and its event came; the Herdr app unpins before hc's answer does
    terminals[0]!.labels = {};
    core.tell({ type: "labels", terminal: "t1", data: { labels: {} } });
    core.state.answer = null;
    answer.resolve();
    await pins.idle();
    expect(preferences.get().pins).toEqual([]);
    expect(terminals[0]!.labels).toEqual({});
    expect(core.written).toEqual([{ terminal: "t1", labels: { "herdr.pinned": "1" } }]);
  });

  it("keeps an unpin from the Herdr app that the list could not save, and takes it once it can", async () => {
    const dir = stateDir();
    const preferences = store(dir, ["local:t1"]);
    const failing = { on: false };
    const flaky = {
      get: () => preferences.get(),
      set: (change: Parameters<PreferenceStore["set"]>[0]) => {
        if (failing.on && change.pins) throw new Error("disk full");
        return preferences.set(change);
      },
      subscribe: (listener: Parameters<PreferenceStore["subscribe"]>[0]) => preferences.subscribe(listener),
    };
    const terminals: Held[] = [{ address: "t1", state: "live", labels: { "herdr.pinned": "1" } }];
    const core = fakeCore(terminals);
    const pins = bridgePins(core.hc, flaky, "local", dir, 0);
    cleanups.push(pins.stop);
    await core.opened();
    await pins.idle();
    failing.on = true;
    terminals[0]!.labels = {};
    core.tell({ type: "labels", terminal: "t1", data: { labels: {} } });
    expect(preferences.get().pins).toEqual(["local:t1"]);
    // the next change of anything else neither writes the pin back nor forgets the unpin
    failing.on = false;
    preferences.set({ settings: { theme: "dark" } });
    await pins.idle();
    expect(core.written).toEqual([]);
    expect(preferences.get().pins).toEqual([]);
  });

  it("keeps an agreed pin when preferences.json is lost and another pinned terminal starts the list", async () => {
    const dir = stateDir();
    // t2 agreed pinned by an earlier run, then preferences.json was lost
    const first = fakeCore([{ address: "t2", state: "live", labels: { "herdr.pinned": "1" } }]);
    const earlier = bridge(first, store(dir, []), dir);
    await first.opened();
    await earlier.idle();
    earlier.stop();
    rmSync(join(dir, "preferences.json"), { force: true });
    const preferences = new PreferenceStore(dir);
    const core = fakeCore([
      { address: "t1", state: "live", labels: { "herdr.pinned": "1" } },
      { address: "t2", state: "live", labels: { "herdr.pinned": "1" } },
    ]);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    await pins.idle();
    expect(core.written).toEqual([]);
    expect(preferences.get().pins).toEqual(["local:t1", "local:t2"]);
  });

  it("takes a late labels event of an answered write for no newer agreement", async () => {
    const dir = stateDir();
    const terminals: Held[] = [{ address: "t1", state: "live", labels: {} }];
    const core = fakeCore(terminals);
    const first = bridge(core, store(dir, []), dir);
    await core.opened();
    await first.idle();
    // a quick pin and unpin in Ovis, both answered; only the pin's event comes, late
    core.state.held = [];
    const preferences = new PreferenceStore(dir);
    first.stop();
    const again = fakeCore(terminals);
    const pins = bridge(again, preferences, dir);
    await again.opened();
    again.state.held = [];
    preferences.set({ settings: {}, pins: ["local:t1"] });
    await pins.idle();
    preferences.set({ settings: {}, pins: [] });
    await pins.idle();
    const held = again.state.held!;
    again.state.held = null;
    again.tell(held[0]!);
    pins.stop();
    // Ovis stopped; the Herdr app pins t1
    terminals[0]!.labels = { "herdr.pinned": "1" };
    const last = fakeCore(terminals);
    const third = bridge(last, new PreferenceStore(dir), dir);
    await last.opened();
    await third.idle();
    expect(last.written).toEqual([]);
    expect(new PreferenceStore(dir).get().pins).toEqual(["local:t1"]);
  });

  it("unpins no agreed pin a list started past its limit leaves out", async () => {
    const dir = stateDir();
    const last = `t${MAX_PINS}`;
    const first = fakeCore([{ address: last, state: "live", labels: { "herdr.pinned": "1" } }]);
    const earlier = bridge(first, store(dir, []), dir);
    await first.opened();
    await earlier.idle();
    earlier.stop();
    rmSync(join(dir, "preferences.json"), { force: true });
    const preferences = new PreferenceStore(dir);
    const core = fakeCore(Array.from({ length: MAX_PINS + 1 }, (_, index) => ({ address: `t${index}`, state: "live", labels: { "herdr.pinned": "1" } })));
    const pins = bridge(core, preferences, dir);
    await core.opened();
    await pins.idle();
    expect(core.written).toEqual([]);
    expect(preferences.get().pins).toHaveLength(MAX_PINS);
    preferences.set({ settings: { theme: "dark" } });
    await pins.idle();
    expect(core.written).toEqual([]);
  });

  it("takes a first pin from the Herdr app that the list could not save once it can", async () => {
    const dir = stateDir();
    const preferences = store(dir);
    const failing = { on: true };
    const flaky = {
      get: () => preferences.get(),
      set: (change: Parameters<PreferenceStore["set"]>[0]) => {
        if (failing.on && change.pins) throw new Error("disk full");
        return preferences.set(change);
      },
      subscribe: (listener: Parameters<PreferenceStore["subscribe"]>[0]) => preferences.subscribe(listener),
    };
    const core = fakeCore([{ address: "t1", state: "live", labels: { "herdr.pinned": "1" } }]);
    const pins = bridgePins(core.hc, flaky, "local", dir, 0);
    cleanups.push(pins.stop);
    await core.opened();
    expect(preferences.get().pins).toBeUndefined();
    failing.on = false;
    preferences.set({ settings: { theme: "dark" } });
    await pins.idle();
    expect(preferences.get().pins).toEqual(["local:t1"]);
    expect(core.written).toEqual([]);
  });

  it("unpins nothing while no browser has shared its pins", async () => {
    const dir = stateDir();
    const preferences = store(dir);
    const core = fakeCore([{ address: "t1", state: "live", labels: {} }]);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    preferences.set({ settings: { theme: "dark" } });
    await pins.idle();
    expect(core.written).toEqual([]);
    expect(preferences.get().pins).toBeUndefined();
  });
});
