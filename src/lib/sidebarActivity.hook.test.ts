import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane } from "../../shared/protocol.ts";
import machinesFixture from "../../site/demo/fixtures/machines.json";
import { type PanePresence, useSidebarActivityState, type SidebarActivity } from "./sidebarActivity.tsx";
import { loadSeen, receiveSeen, saveSeen, seenKey, SEEN_LIMIT } from "./seenFinishes.ts";
import type { SeenFinish, SeenPresentation } from "../../shared/seen.ts";
import { conversationFinishEvidence } from "./panePresentation.ts";
import { shareSeen } from "./api.ts";

const fixture: Machine[] = JSON.parse(JSON.stringify(machinesFixture.machines));
function roster(finishes: Record<string, number>, statuses: Record<string, AgentStatus> = {}, epoch: string | undefined = "server-a"): Machine[] {
  const machine = structuredClone(fixture[0]);
  if (!machine?.snapshot) throw new Error("fixture has no snapshot");
  const pane = machine.snapshot.panes[0], agent = machine.snapshot.agents[0];
  if (!pane || !agent) throw new Error("fixture has no agent pane");
  machine.snapshot.finish_epoch = epoch;
  machine.snapshot.panes = Object.entries(finishes).map(([id, finish_id]) => ({ ...pane, pane_id: id, agent_status: statuses[id] ?? "done", finish_id }));
  // Deliberately unchanged: native overrides finish without any herdr counter change.
  machine.snapshot.agents = Object.keys(finishes).map((id) => ({ ...agent, pane_id: id, agent_status: statuses[id] ?? "done", state_change_seq: 5 }));
  return [machine];
}

describe("sidebar finish acknowledgement through React effects", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderers: ReactTestRenderer[];
  let visibility: DocumentVisibilityState;
  let events: EventTarget;
  let storageEvents: EventTarget;
  let data: Map<string, string>;
  let storageAdds: number;
  let storageRemoves: number;

  beforeEach(() => {
    for (const key of ["document", "window", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    renderers = []; visibility = "visible"; events = new EventTarget(); storageEvents = new EventTarget(); data = new Map();
    storageAdds = 0; storageRemoves = 0;
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      get visibilityState() { return visibility; },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === "storage") storageAdds++;
        storageEvents.addEventListener(type, listener);
      },
      removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === "storage") storageRemoves++;
        storageEvents.removeEventListener(type, listener);
      },
    } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
    } });
  });
  afterEach(async () => {
    await act(async () => { for (const renderer of renderers) renderer.unmount(); });
    jest.useRealTimers();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  async function storage(key: string | null, newValue: string | null, storageArea?: Storage): Promise<void> {
    await act(async () => {
      const event = new Event("storage");
      Object.defineProperties(event, { key: { value: key }, newValue: { value: newValue }, storageArea: { value: storageArea } });
      storageEvents.dispatchEvent(event);
    });
  }

  async function open(machines: Machine[], selected: string | null = null, covered = false, share?: (finish: SeenFinish, presented?: SeenPresentation) => Promise<void>) {
    let activity: SidebarActivity | undefined;
    let current = machines;
    let renders = 0;
    function Probe({ machines, selected, covered }: { machines: Machine[]; selected: string | null; covered: boolean }) {
      // Keep callback identity stable between the hook's own renders.
      renders++;
      activity = useSidebarActivityState(machines, "local", selected, covered ? coveredView : loading.current ? loadingView : frontView, share);
      return null;
    }
    let renderer: ReactTestRenderer | undefined;
    await act(async () => { renderer = create(createElement(Probe, { machines, selected, covered })); });
    if (!renderer) throw new Error("probe did not mount");
    const mounted = renderer; renderers.push(mounted);
    return {
      status(id: string, override?: Partial<HerdrPane>): AgentStatus | undefined {
        const pane = current[0]?.snapshot?.panes.find((pane) => pane.pane_id === id);
        if (!activity || !pane) throw new Error("probe has no pane");
        return activity.status("local", { ...pane, ...override });
      },
      statusAt(machineId: string, id: string, override?: Partial<HerdrPane>): AgentStatus | undefined {
        const pane = current.find((machine) => machine.id === machineId)?.snapshot?.panes.find((pane) => pane.pane_id === id);
        if (!activity || !pane) throw new Error("probe has no pane");
        return activity.status(machineId, { ...pane, ...override });
      },
      async update(next: Machine[], selected: string | null = null, covered = false): Promise<void> {
        current = next;
        await act(async () => { mounted.update(createElement(Probe, { machines: next, selected, covered })); });
      },
      async unmount(): Promise<void> {
        const index = renderers.indexOf(mounted);
        if (index < 0) return;
        await act(async () => { mounted.unmount(); });
        renderers.splice(index, 1);
      },
      get renders() { return renders; },
    };
  }
  // stable identities, as App's memoized callback; content still loading: in view, not yet drawn
  const frontView = (): PanePresence => "front", coveredView = (): PanePresence => "covered", loadingView = (): PanePresence => "loading";
  const loading = { current: false };

  for (const state of ["connecting", "reconnecting", "disconnected"] as const) {
    it(`keeps cached read finishes ready while ${state}, without marking an unseen selected pane`, async () => {
      const client = await open(roster({ a: 1, b: 1 }), "a");
      const offline = roster({ a: 1, b: 1 });
      offline[0]!.state = state;
      await client.update(offline, "b");
      expect(client.status("a")).toBe("idle");
      expect(client.status("b")).toBe("done");
      expect(loadSeen("local", "server-a")).toEqual({ a: 1 });
      const reopened = await open(offline, "b");
      expect(reopened.status("a")).toBe("idle");
      expect(reopened.status("b")).toBe("done");
    });
  }

  it("uses the warm snapshot for multiple PCs and presentation-only updates", async () => {
    const local = roster({ a: 1, b: 1 })[0]!;
    const remoteA: Machine = { ...structuredClone(local), id: "remote-a" };
    const remoteB: Machine = { ...structuredClone(local), id: "remote-b" };
    for (const machine of [local, remoteA, remoteB]) {
      data.set(seenKey(machine.id, "server-a", "a"), JSON.stringify({ id: 1, at: 1 }));
      data.set(seenKey(machine.id, "server-a", "b"), JSON.stringify({ id: 1, at: 2 }));
    }
    const client = await open([local, remoteA, remoteB], "a");
    let keyCalls = 0, readCalls = 0;
    const storage = localStorage;
    const key = storage.key.bind(storage), getItem = storage.getItem.bind(storage);
    storage.key = (index) => { keyCalls++; return key(index); };
    storage.getItem = (name) => { readCalls++; return getItem(name); };

    const changed = roster({ a: 1, b: 1 }, { a: "working" })[0]!;
    await client.update([changed, remoteA, remoteB], "b");
    await client.update([roster({ a: 1, b: 1 })[0]!, remoteA, remoteB], "a");

    expect([keyCalls, readCalls]).toEqual([0, 0]);
    expect(client.status("a")).toBe("idle");
    expect(client.status("b")).toBe("idle");
  });

  it("keeps the seen map identity when a repeated acknowledgement changes no value", async () => {
    data.set(seenKey("local", "server-a", "a"), JSON.stringify({ id: 1, at: 1 }));
    const client = await open(roster({ a: 1 }), "a");
    const before = client.renders;
    await client.update(roster({ a: 1 }), "a");
    expect(client.renders - before).toBe(1);
    expect(client.status("a")).toBe("idle");
  });

  it("publishes same-page saves to mounted consumers and owns one storage listener lifetime", async () => {
    const first = await open(roster({ a: 1 }));
    const second = await open(roster({ a: 1 }));
    expect([storageAdds, storageRemoves]).toEqual([1, 0]);
    expect(second.status("a")).toBe("done");
    await act(async () => { saveSeen("local", "server-a", "a", 1); });
    expect(second.status("a")).toBe("idle");

    await first.unmount();
    expect(storageRemoves).toBe(0);
    await second.unmount();
    expect([storageAdds, storageRemoves]).toEqual([1, 1]);
  });

  it("keeps the global record cap without restoring evicted history on roster updates", async () => {
    for (let index = 0; index < 1900; index++) {
      data.set(seenKey("local", "server-a", `p${index}`), JSON.stringify({ id: 1, at: index }));
    }
    const client = await open(roster({ p0: 1 }));
    await act(async () => {
      for (let index = 1900; index < 2200; index++) saveSeen("remote", "server-b", `p${index}`, 1);
    });

    expect(data.size).toBe(SEEN_LIMIT);
    expect(data.has(seenKey("local", "server-a", "p0"))).toBe(false);
    expect(loadSeen("local", "server-a").p0).toBeUndefined();
    await client.update(roster({ p0: 1 }, { p0: "working" }));
    expect(data.size).toBe(SEEN_LIMIT);
    expect(data.has(seenKey("local", "server-a", "p0"))).toBe(false);
    expect(loadSeen("local", "server-a").p0).toBeUndefined();
  });

  it("publishes records after a later PC acknowledgement evicts an earlier PC", async () => {
    for (let index = 0; index < SEEN_LIMIT; index++) {
      data.set(seenKey("remote", "server-a", `p${index}`), JSON.stringify({ id: 1, at: index }));
    }
    const remote = { ...roster({ p0: 1 })[0]!, id: "remote" };
    const local = roster({ newest: 1 })[0]!;
    const client = await open([remote, local]);
    expect(client.statusAt("remote", "p0")).toBe("idle");

    await client.update([remote, local], "newest");
    expect(client.statusAt("remote", "p0")).toBe("done");
    expect(data.has(seenKey("remote", "server-a", "p0"))).toBe(false);
  });

  it("updates the mounted epoch when one same-page batch contains mixed epochs for a PC", async () => {
    const client = await open(roster({ a: 1 }));
    await act(async () => {
      receiveSeen([
        { pc: "local", epoch: "server-b", pane: "other", id: 1 },
        { pc: "local", epoch: "server-a", pane: "a", id: 1 },
      ]);
    });
    expect(client.status("a")).toBe("idle");
  });

  it("forgets deleted and cleared marks until their content is presented again", async () => {
    const client = await open(roster({ a: 1 }), "a");
    const key = seenKey("local", "server-a", "a");
    data.delete(key);
    await storage(key, null);
    expect(client.status("a")).toBe("done");
    expect(loadSeen("local", "server-a")).toEqual({});

    data.clear();
    await storage(null, null);
    expect(client.status("a")).toBe("done");
    expect(loadSeen("local", "server-a")).toEqual({});
    await client.unmount();
    const reopened = await open(roster({ a: 1 }));
    expect(reopened.status("a")).toBe("done");
    expect(loadSeen("local", "server-a")).toEqual({});
    await reopened.update(roster({ a: 1 }), "a");
    expect(reopened.status("a")).toBe("idle");
    expect(loadSeen("local", "server-a")).toEqual({ a: 1 });
  });

  it("keeps bounded session acknowledgements through storage access loss and rehydrates when restored", async () => {
    const client = await open(roster({ a: 1 }), "a");
    const available = localStorage;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("blocked"); } });
    try {
      await client.update(roster({ a: 2 }), "a");
      expect(client.status("a")).toBe("idle");
      expect(loadSeen("local", "server-a")).toEqual({ a: 2 });
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: available });
    }
    expect(loadSeen("local", "server-a")).toEqual({ a: 2 });
    expect(JSON.parse(data.get(seenKey("local", "server-a", "a"))!)).toMatchObject({ id: 2 });
  });

  it("keeps a newer persisted finish when an older clear event arrives", async () => {
    const client = await open(roster({ a: 1, b: 2 }), "a");
    data.clear();
    await act(async () => { saveSeen("local", "server-a", "b", 2); });
    await storage(null, null, localStorage);
    expect(client.status("a")).toBe("done");
    expect(client.status("b")).toBe("idle");
    expect(loadSeen("local", "server-a")).toEqual({ b: 2 });
  });

  it("ignores events from a different storage area", async () => {
    const client = await open(roster({ a: 1 }), "a");
    await storage(null, null, {} as Storage);
    expect(client.status("a")).toBe("idle");
    expect(loadSeen("local", "server-a")).toEqual({ a: 1 });
  });

  it("persists a session-only finish when the same storage methods recover", async () => {
    const storage = localStorage;
    const getItem = storage.getItem, setItem = storage.setItem;
    storage.getItem = () => { throw new Error("blocked"); };
    storage.setItem = () => { throw new Error("blocked"); };
    const client = await open(roster({ a: 1 }), "a");
    expect(client.status("a")).toBe("idle");
    expect(data.has(seenKey("local", "server-a", "a"))).toBe(false);

    storage.getItem = getItem;
    storage.setItem = setItem;
    await client.update(roster({ a: 1 }), "a");
    expect(data.get(seenKey("local", "server-a", "a"))).toMatch(/"id":1/);
  });

  it("tells the other browsers of a presented finish once, and again after a failed attempt", async () => {
    jest.useFakeTimers();
    const told: SeenFinish[] = [];
    let reachable = false;
    const share = async (finish: SeenFinish) => { told.push(finish); if (!reachable) throw new Error("offline"); };
    const warn = console.warn;
    const warned: unknown[] = [];
    console.warn = (...args: unknown[]) => { warned.push(args[0]); };
    try {
      const client = await open(roster({ a: 1 }), "a", false, share);
      await act(async () => { await Promise.resolve(); });
      expect(warned).toEqual(["Could not tell the other browsers about a read finish"]);
      reachable = true;
      await client.update(roster({ a: 1 }), "a");
      await client.update(roster({ a: 1 }), "a");
      expect(told).toHaveLength(1);
      await act(async () => { jest.advanceTimersByTime(1_000); });
      await client.update(roster({ a: 1, b: 1 }), "b");
      const a = { pc: "local", epoch: "server-a", pane: "a", id: 1 };
      expect(told).toEqual([a, a, { ...a, pane: "b" }]);
    } finally {
      console.warn = warn;
    }
  });

  for (const failure of [502, 503, "network"] as const) {
    it(`delivers once after backoff despite 20 roster updates when sharing fails with ${failure}`, async () => {
      // Given a transient failure followed by a successful delivery.
      jest.useFakeTimers();
      const delivered: unknown[] = [];
      let attempts = 0;
      const post = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
        attempts++;
        if (attempts === 1) {
          if (failure === "network") throw new TypeError("offline");
          return new Response("restart", { status: failure });
        }
        delivered.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 200 });
      }, { preconnect: fetch.preconnect }));
      try {
        const client = await open(roster({ a: 1 }), "a", false, shareSeen);

        // When roster updates arrive before the retry deadline.
        for (let index = 0; index < 20; index++) await client.update(roster({ a: 1 }), "a");
        await act(async () => { jest.advanceTimersByTime(999); });
        expect(attempts).toBe(1);
        await act(async () => { jest.advanceTimersByTime(1); });

        // Then exactly one retry delivers, without another request after success.
        await client.update(roster({ a: 1 }), "a");
        await act(async () => { jest.advanceTimersByTime(60_000); });
        expect(post.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
          ["/api/seen", "POST"], ["/api/seen", "POST"],
        ]);
        // a retry tells an earlier look: it cannot overrule an unread told since
        expect(delivered).toEqual([{ pc: "local", epoch: "server-a", pane: "a", id: 1, presented: "held" }]);
      } finally { post.mockRestore(); }
    });
  }

  it("does not retry a bad request even after backoff and roster updates", async () => {
    // Given a finish refused as invalid.
    jest.useFakeTimers();
    const told: SeenFinish[] = [];
    const client = await open(roster({ a: 1 }), "a", false, async (finish) => {
      told.push(finish);
      throw Object.assign(new Error("invalid_finish"), { status: 400 });
    });

    // When time passes and the roster changes.
    for (let index = 0; index < 20; index++) await client.update(roster({ a: 1 }), "a");
    await act(async () => { jest.advanceTimersByTime(60_000); });

    // Then the refused finish remains local without another send.
    expect(told).toHaveLength(1);
    expect(client.status("a")).toBe("idle");
  });

  it("doubles retry delays up to 30 seconds without roster-driven sends", async () => {
    // Given a server that remains unavailable.
    jest.useFakeTimers();
    let attempts = 0;
    const client = await open(roster({ a: 1 }), "a", false, async () => {
      attempts++;
      throw Object.assign(new Error("restart"), { status: 503 });
    });

    // When each retry deadline is approached and then reached.
    let expected = 1;
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      await client.update(roster({ a: 1 }), "a");
      await act(async () => { jest.advanceTimersByTime(delay - 1); });
      expect(attempts).toBe(expected);
      await act(async () => { jest.advanceTimersByTime(1); });
      expected++;
      // Then only that chain's scheduled request has been sent.
      expect(attempts).toBe(expected);
    }
  });

  for (const retirement of ["unmount", "epoch", "new finish"] as const) {
    it(`cancels a pending retry on ${retirement}`, async () => {
      // Given a finish waiting to retry.
      jest.useFakeTimers();
      const told: SeenFinish[] = [];
      const client = await open(roster({ a: 1 }), "a", false, async (finish) => {
        told.push(finish);
        throw Object.assign(new Error("restart"), { status: 502 });
      });

      // When the owner or finish is retired before the timer fires.
      await {
        unmount: () => client.unmount(),
        epoch: () => client.update(roster({ a: 1 }, {}, "server-b")),
        "new finish": () => client.update(roster({ a: 2 }), "a"),
      }[retirement]();
      await act(async () => { jest.advanceTimersByTime(1_000); });

      // Then the retired finish is never sent again.
      expect(told.filter(({ id }) => id === 1)).toHaveLength(1);
    });
  }

  it("resumes a 401 only after authentication succeeds without reloading", async () => {
    // Given an unauthorized share and a browser still signed out.
    jest.useFakeTimers();
    let authenticated = false;
    const health = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () =>
      Response.json({ auth: { authenticated } }), { preconnect: fetch.preconnect }));
    const told: SeenFinish[] = [];
    try {
      const client = await open(roster({ a: 1 }), "a", false, async (finish) => {
        told.push(finish);
        if (!authenticated) throw Object.assign(new Error("unauthorized"), { status: 401 });
      });
      await act(async () => { jest.advanceTimersByTime(1_000); });
      await client.update(roster({ a: 1 }), "a");
      expect(told).toHaveLength(1);

      // When a later health response confirms sign-in.
      authenticated = true;
      await act(async () => { jest.advanceTimersByTime(2_000); });

      // Then the existing finish is shared once and its chain stops.
      await act(async () => { jest.advanceTimersByTime(60_000); });
      expect(told).toHaveLength(2);
      expect(health.mock.calls.map(([url]) => url)).toEqual([
        "/api/health?scope=bridge", "/api/health?scope=bridge",
      ]);
    } finally { health.mockRestore(); }
  });

  it("does not send again a finish the server answered with an error", async () => {
    const told: SeenFinish[] = [];
    const share = async (finish: SeenFinish) => { told.push(finish); throw Object.assign(new Error("seen_unwritable"), { status: 500 }); };
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const client = await open(roster({ a: 1 }), "a", false, share);
      await act(async () => { await Promise.resolve(); });
      await client.update(roster({ a: 1 }), "a");
      await client.update(roster({ a: 1 }), "a");
      expect(told).toHaveLength(1);
    } finally {
      console.warn = warn;
    }
  });

  it("uses one health request per backoff window for 100 unauthorized finishes", async () => {
    // Given 100 finishes read while signed out.
    jest.useFakeTimers();
    const health = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () =>
      Response.json({ auth: { authenticated: false } }), { preconnect: fetch.preconnect }));
    const share = async () => { throw Object.assign(new Error("unauthorized"), { status: 401 }); };
    try {
      const client = await open(roster({ p0: 1 }), "p0", false, share);
      for (let index = 1; index < 100; index++) await client.update(roster({ [`p${index}`]: 1 }), `p${index}`);

      // When each shared backoff window expires, including at the delay cap.
      let windows = 0;
      for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
        await act(async () => { jest.advanceTimersByTime(delay); });
        windows++;

        // Then pending finish count does not multiply authentication probes.
        expect(health.mock.calls.map(([url]) => url)).toEqual(
          Array.from({ length: windows }, () => "/api/health?scope=bridge"),
        );
      }
    } finally { health.mockRestore(); }
  });

  it("sends each of 100 paused finishes once after one successful auth observation", async () => {
    // Given 100 pending finishes behind the same authentication gate.
    jest.useFakeTimers();
    let authenticated = false;
    const delivered: SeenFinish[] = [];
    const health = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () =>
      Response.json({ auth: { authenticated } }), { preconnect: fetch.preconnect }));
    const share = async (finish: SeenFinish) => {
      if (!authenticated) throw Object.assign(new Error("unauthorized"), { status: 401 });
      delivered.push(finish);
    };
    try {
      const client = await open(roster({ p0: 1 }), "p0", false, share);
      for (let index = 1; index < 100; index++) await client.update(roster({ [`p${index}`]: 1 }), `p${index}`);
      await act(async () => { jest.advanceTimersByTime(1_000); });

      // When one later health response confirms sign-in.
      authenticated = true;
      await act(async () => { jest.advanceTimersByTime(2_000); });
      // roster updates on the pane still in front (going back to the others would be a look again)
      for (let index = 0; index < 100; index++) await client.update(roster({ p99: 1 }), "p99");
      await act(async () => { jest.advanceTimersByTime(60_000); });

      // Then every finish is delivered exactly once, and health polling stops.
      expect(delivered).toHaveLength(100);
      expect(delivered.map(({ pane }) => pane).sort()).toEqual(
        Array.from({ length: 100 }, (_, index) => `p${index}`).sort(),
      );
      expect(health).toHaveBeenCalledTimes(2);
    } finally { health.mockRestore(); }
  });

  for (const failure of [503, "network"] as const) {
    it(`bounds ${failure} outage retries independently of 100 pending finishes and drains on recovery`, async () => {
      // Given 100 finishes presented during a transient outage.
      jest.useFakeTimers();
      let available = false;
      let attempts = 0;
      const delivered: SeenFinish[] = [];
      const share = async (finish: SeenFinish) => {
        attempts++;
        if (!available) throw failure === "network" ? new TypeError("offline")
          : Object.assign(new Error("restart"), { status: failure });
        delivered.push(finish);
      };
      const client = await open(roster({ p0: 1 }), "p0", false, share);
      for (let index = 1; index < 100; index++) await client.update(roster({ [`p${index}`]: 1 }), `p${index}`);
      const initial = attempts;
      expect(initial).toBe(1);

      // When the outage continues across retry deadlines and roster traffic.
      let windows = 0;
      for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
        for (let index = 0; index < 20; index++) await client.update(roster({ p99: 1 }), "p99");
        await act(async () => { jest.advanceTimersByTime(delay); });
        windows++;
        expect(attempts - initial).toBe(windows);
      }
      available = true;
      await act(async () => { jest.advanceTimersByTime(30_000); });
      await act(async () => { jest.advanceTimersByTime(60_000); });

      // Then the aggregate outage sends were bounded, but no pending finish was lost.
      expect(delivered).toHaveLength(100);
      expect(new Set(delivered.map(({ pane }) => pane)).size).toBe(100);
      expect(attempts).toBe(initial + windows + 100);
    });
  }

  it("does not duplicate an in-flight auth probe or resume shares after unmount", async () => {
    // Given 100 paused finishes and one unanswered authentication probe.
    jest.useFakeTimers();
    const reply = Promise.withResolvers<Response>();
    const health = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
      () => reply.promise, { preconnect: fetch.preconnect },
    ));
    let attempts = 0;
    try {
      const client = await open(roster({ p0: 1 }), "p0", false, async () => {
        attempts++;
        throw Object.assign(new Error("unauthorized"), { status: 401 });
      });
      for (let index = 1; index < 100; index++) await client.update(roster({ [`p${index}`]: 1 }), `p${index}`);
      await act(async () => { jest.advanceTimersByTime(1_000); });

      // When time and roster updates pass, then the owner unmounts before the reply.
      await act(async () => { jest.advanceTimersByTime(60_000); });
      await client.update(roster({ p99: 1 }), "p99");
      await client.unmount();
      await act(async () => { reply.resolve(Response.json({ auth: { authenticated: true } })); });
      await act(async () => { jest.advanceTimersByTime(60_000); });

      // Then no overlapping health poll or stale resumed share was sent.
      expect(health).toHaveBeenCalledTimes(1);
      expect(attempts).toBe(1);
    } finally { health.mockRestore(); }
  });

  it("says whether a shared finish's pane just came into view, and tells a held finish again when the pane is shown again", async () => {
    const told: [number, string | undefined][] = [];
    const share = async (finish: SeenFinish, presented?: SeenPresentation) => { told.push([finish.id, presented]); };
    const client = await open(roster({ a: 1, b: 1 }, { b: "working" }), "a", false, share);
    // a finish that arrives while the pane is in front (another client marked it unread)
    await client.update(roster({ a: 2, b: 1 }, { b: "working" }), "a");
    // away and back: the same finish, now shown again
    await client.update(roster({ a: 2, b: 1 }, { b: "working" }), "b");
    await client.update(roster({ a: 2, b: 1 }, { b: "working" }), "a");
    // once told as a look, coming back to it tells nothing more
    await client.update(roster({ a: 2, b: 1 }, { b: "working" }), "b");
    await client.update(roster({ a: 2, b: 1 }, { b: "working" }), "a");
    // content still loading and a reconnect are no look: the pane stayed in view
    loading.current = true;
    await client.update(roster({ a: 3, b: 1 }, { b: "working" }), "a");
    loading.current = false;
    await client.update(roster({ a: 3, b: 1 }, { b: "working" }), "a");
    const away = roster({ a: 4, b: 1 }, { b: "working" });
    away[0]!.state = "reconnecting";
    await client.update(away, "a");
    await client.update(roster({ a: 4, b: 1 }, { b: "working" }), "a");
    // a pane selected while covered is new once it is first presented
    await client.update(roster({ a: 4, b: 5 }), "b", true);
    await client.update(roster({ a: 4, b: 5 }), "b");
    // closing an overlay over it brings it into view again
    await client.update(roster({ a: 4, b: 6 }), "b", true);
    await client.update(roster({ a: 4, b: 6 }), "b");
    expect(told).toEqual([[1, "new"], [2, "held"], [2, "new"], [3, "held"], [4, "held"], [5, "new"], [6, "new"]]);
  });

  it("tells a return made while a held share is in flight as a look right away, once", async () => {
    // Given finish 2 of pane a shared as held, its request still unanswered.
    const told: [number, string | undefined][] = [];
    const pending = Promise.withResolvers<void>();
    const share = (finish: SeenFinish, presented?: SeenPresentation) => {
      told.push([finish.id, presented]);
      return finish.id === 2 ? pending.promise : Promise.resolve();
    };
    const client = await open(roster({ a: 1, b: 1 }, { b: "working" }), "a", false, share);
    await client.update(roster({ a: 2, b: 1 }, { b: "working" }), "a");

    // When the person goes away and comes back before it answers.
    await client.update(roster({ a: 2, b: 1 }, { b: "working" }), "b");
    await client.update(roster({ a: 2, b: 1 }, { b: "working" }), "a");

    // Then the return is told as a look then, not when the held share answers, and not again.
    expect(told).toEqual([[1, "new"], [2, "held"], [2, "new"]]);
    await act(async () => { pending.resolve(); await pending.promise; });
    expect(told).toEqual([[1, "new"], [2, "held"], [2, "new"]]);
    await client.update(roster({ a: 2, b: 1 }, { b: "working" }), "b");
    await client.update(roster({ a: 2, b: 1 }, { b: "working" }), "a");
    expect(told).toEqual([[1, "new"], [2, "held"], [2, "new"]]);
  });

  it("keeps a finish told as a look when its answer upgrade is shared as held", async () => {
    // Given finish 1 of a shared as new without an answer.
    const told: [number, string | undefined, boolean][] = [];
    const share = async (finish: SeenFinish, presented?: SeenPresentation) => { told.push([finish.id, presented, finish.answer !== undefined]); };
    const pane = "proof-upgrade-told";
    const client = await open(roster({ [pane]: 1, b: 1 }, { b: "working" }), pane, false, share);

    // When its answer arrives while it stays in front, and the person goes away and back.
    expect(conversationFinishEvidence.accept(seenKey("local", "server-a", pane), 1, {
      source: "pi-transcript", history_id: "session",
      turns: [{ role: "assistant", ts: "2026-10-19T00:00:00Z", end_ts: "2026-10-19T00:00:01Z",
        parts: [{ kind: "text", text: "Finished", phase: "final_answer" }] }],
    })).toBe(true);
    await client.update(roster({ [pane]: 1, b: 1 }, { b: "working" }), pane);
    await client.update(roster({ [pane]: 1, b: 1 }, { b: "working" }), "b");
    await client.update(roster({ [pane]: 1, b: 1 }, { b: "working" }), pane);

    // Then the return tells nothing more: the finish was already told as a look.
    expect(told).toEqual([[1, "new", false], [1, "held", true]]);
  });

  it("keeps a look that answers after its answer upgrade answered first", async () => {
    // Given finish 1 of a shared as new, its request still unanswered.
    const told: [number, string | undefined, boolean][] = [];
    const pending = Promise.withResolvers<void>();
    const share = (finish: SeenFinish, presented?: SeenPresentation) => {
      told.push([finish.id, presented, finish.answer !== undefined]);
      return finish.answer === undefined ? pending.promise : Promise.resolve();
    };
    const pane = "proof-upgrade-in-flight";
    const client = await open(roster({ [pane]: 1, b: 1 }, { b: "working" }), pane, false, share);

    // When its answer upgrade is shared and answers, then the look answers, and the person goes away and back.
    expect(conversationFinishEvidence.accept(seenKey("local", "server-a", pane), 1, {
      source: "pi-transcript", history_id: "session",
      turns: [{ role: "assistant", ts: "2026-10-19T00:00:00Z", end_ts: "2026-10-19T00:00:01Z",
        parts: [{ kind: "text", text: "Finished", phase: "final_answer" }] }],
    })).toBe(true);
    await client.update(roster({ [pane]: 1, b: 1 }, { b: "working" }), pane);
    await act(async () => { pending.resolve(); await pending.promise; });
    await client.update(roster({ [pane]: 1, b: 1 }, { b: "working" }), "b");
    await client.update(roster({ [pane]: 1, b: 1 }, { b: "working" }), pane);

    // Then the look is not told a second time.
    expect(told).toEqual([[1, "new", false], [1, "held", true]]);
  });

  it("tells a return as a look while the look in flight at its answer upgrade then fails", async () => {
    // Given finish 1 of a shared as new, its request still unanswered, and its answer upgrade shared.
    const told: [number, string | undefined, boolean][] = [];
    const pending = Promise.withResolvers<void>();
    const share = (finish: SeenFinish, presented?: SeenPresentation) => {
      told.push([finish.id, presented, finish.answer !== undefined]);
      return finish.answer === undefined ? pending.promise : Promise.resolve();
    };
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const pane = "proof-upgrade-lost-look";
      const client = await open(roster({ [pane]: 1, b: 1 }, { b: "working" }), pane, false, share);
      expect(conversationFinishEvidence.accept(seenKey("local", "server-a", pane), 1, {
        source: "pi-transcript", history_id: "session",
        turns: [{ role: "assistant", ts: "2026-10-19T00:00:00Z", end_ts: "2026-10-19T00:00:01Z",
          parts: [{ kind: "text", text: "Finished", phase: "final_answer" }] }],
      })).toBe(true);
      await client.update(roster({ [pane]: 1, b: 1 }, { b: "working" }), pane);

      // When the person goes away and back while the look is in flight, and the look then fails.
      await client.update(roster({ [pane]: 1, b: 1 }, { b: "working" }), "b");
      await client.update(roster({ [pane]: 1, b: 1 }, { b: "working" }), pane);
      await act(async () => { pending.reject(new TypeError("offline")); await pending.promise.catch(() => undefined); });
      await client.update(roster({ [pane]: 1, b: 1 }, { b: "working" }), pane);

      // Then the return was told as a look.
      expect(told).toEqual([[1, "new", false], [1, "held", true], [1, "new", true]]);
    } finally {
      console.warn = warn;
    }
  });

  it("upgrades a shared finish when its same-ID answer fingerprint becomes available", async () => {
    const told: SeenFinish[] = [];
    const share = async (finish: SeenFinish) => { told.push(finish); };
    const pane = "proof-upgrade";
    const client = await open(roster({ [pane]: 1 }), pane, false, share);
    expect(told).toEqual([{ pc: "local", epoch: "server-a", pane, id: 1 }]);

    const conversation = {
      source: "pi-transcript" as const,
      history_id: "session",
      turns: [{ role: "assistant" as const, ts: "2026-10-19T00:00:00Z", end_ts: "2026-10-19T00:00:01Z",
        parts: [{ kind: "text" as const, text: "Finished", phase: "final_answer" as const }] }],
    };
    expect(conversationFinishEvidence.accept(seenKey("local", "server-a", pane), 1, conversation)).toBe(true);
    await client.update(roster({ [pane]: 1 }), pane);
    expect(told).toHaveLength(2);
    expect(told[1]).toMatchObject({ pane, id: 1, answer: expect.any(String) });
  });

  it("retries a failed share once, with the answer fingerprint that arrived before the retry", async () => {
    // Given a share of a finish whose answer was not read yet, failed with a transient error.
    jest.useFakeTimers();
    const pane = "proof-late-answer";
    const told: SeenFinish[] = [];
    const client = await open(roster({ [pane]: 1 }), pane, false, async (finish) => {
      told.push(finish);
      if (told.length === 1) throw Object.assign(new Error("restart"), { status: 503 });
    });
    expect(told).toEqual([{ pc: "local", epoch: "server-a", pane, id: 1 }]);

    // When the answer is read before the retry is due.
    expect(conversationFinishEvidence.accept(seenKey("local", "server-a", pane), 1, {
      source: "pi-transcript", history_id: "session",
      turns: [{ role: "assistant", ts: "2026-10-19T00:00:00Z", end_ts: "2026-10-19T00:00:01Z",
        parts: [{ kind: "text", text: "Finished", phase: "final_answer" }] }],
    })).toBe(true);
    await client.update(roster({ [pane]: 1 }), pane);
    expect(told).toHaveLength(1);
    await act(async () => { jest.advanceTimersByTime(1_000); });
    await act(async () => { jest.advanceTimersByTime(60_000); });

    // Then the retry shares it once, carrying the answer.
    expect(told).toHaveLength(2);
    expect(told[1]).toMatchObject({ pane, id: 1, answer: expect.any(String) });
  });

  it("does not let a late network rejection erase a newer share, and bounds share retention", async () => {
    const told: SeenFinish[] = [];
    let rejectFirst!: (error: Error) => void;
    let resolveLatest!: () => void;
    const share = (finish: SeenFinish) => {
      told.push(finish);
      return new Promise<void>((resolve, reject) => {
        if (finish.id === 1) rejectFirst = reject;
        else resolveLatest = resolve;
      });
    };
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const client = await open(roster({ a: 1 }), "a", false, share);
      await client.update(roster({ a: 2 }), "a");
      rejectFirst(new Error("offline"));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await client.update(roster({ a: 2 }), "a");
      expect(told.map(({ id }) => id)).toEqual([1, 2]);
      resolveLatest();
      await act(async () => { await Promise.resolve(); });
    } finally {
      console.warn = warn;
    }

    const bounded: SeenFinish[] = [];
    const client = await open(roster({ p0: 1 }), "p0", false, async (finish) => { bounded.push(finish); });
    for (let index = 1; index <= SEEN_LIMIT; index++) {
      const pane = `p${index}`;
      await client.update(roster({ [pane]: 1 }), pane);
    }
    await client.update(roster({ p0: 1 }), "p0");
    expect(bounded).toHaveLength(SEEN_LIMIT + 2);
    expect(bounded.at(-1)?.pane).toBe("p0");
  });

  it("keeps one latest share per pane through more turns than the history limit", async () => {
    const told: SeenFinish[] = [];
    const client = await open(roster({ kept: 1 }), "kept", false, async (finish) => { told.push(finish); });
    for (let id = 1; id <= SEEN_LIMIT + 1; id++) await client.update(roster({ active: id }), "active");
    await client.update(roster({ kept: 1 }), "kept");
    await client.update(roster({ active: 1 }), "active");
    expect(told.filter(({ pane }) => pane === "kept")).toHaveLength(1);
    expect(told.filter(({ pane }) => pane === "active")).toHaveLength(SEEN_LIMIT + 1);
    expect(loadSeen("local", "server-a").active).toBe(SEEN_LIMIT + 1);
  });

  it("draws a finish another browser of the server presented as ready, and never steps it back", async () => {
    const client = await open(roster({ a: 2, b: 1 }));
    expect([client.status("a"), client.status("b")]).toEqual(["done", "done"]);
    await act(async () => { receiveSeen([{ pc: "local", epoch: "server-a", pane: "a", id: 2, answer: "proof" }]); });
    expect([client.status("a"), client.status("b")]).toEqual(["idle", "done"]);
    await act(async () => { receiveSeen([{ pc: "local", epoch: "server-a", pane: "a", id: 1 }, { pc: "local", epoch: "server-b", pane: "b", id: 1 }]); });
    expect([client.status("a"), client.status("b")]).toEqual(["idle", "done"]);
    expect(JSON.parse(data.get(seenKey("local", "server-a", "a"))!)).toMatchObject({ id: 2, answer: "proof" });
  });

  it("does not scan unrelated storage on repeated or new acknowledgement", async () => {
    const client = await open(roster({ a: 1 }), "a");
    let unrelatedReads = 0;
    const read = localStorage.getItem;
    const key = seenKey("remote", "server-b", "other");
    data.set(key, JSON.stringify({ id: 4, at: 1 }));
    localStorage.getItem = (name) => { if (name === key) unrelatedReads++; return read(name); };
    await client.update(roster({ a: 1 }), "a");
    expect(unrelatedReads).toBe(0);
    await client.update(roster({ a: 2 }), "a");
    expect(unrelatedReads).toBe(0);
  });

  it("does not mark WORKING; a later native DONE with unchanged herdr seq keeps its dot", async () => {
    const client = await open(roster({ a: 1 }, { a: "working" }), "a");
    expect(loadSeen("local", "server-a")).toEqual({});
    await client.update(roster({ a: 2 }));
    expect(client.status("a")).toBe("done");
  });

  it("keeps a later unseen finish after opening an earlier finish", async () => {
    const client = await open(roster({ a: 1 }), "a");
    expect(client.status("a")).toBe("idle");
    await client.update(roster({ a: 1 }, { a: "working" }));
    await client.update(roster({ a: 2 }));
    expect(client.status("a")).toBe("done");
  });

  it("does not mark a finish under an overlay, but marks when uncovered", async () => {
    const client = await open(roster({ a: 0 }, { a: "working" }), "a", true);
    await client.update(roster({ a: 1 }), "a", true);
    expect(client.status("a")).toBe("done");
    expect(loadSeen("local", "server-a")).toEqual({});
    await client.update(roster({ a: 1 }), "a");
    expect(client.status("a")).toBe("idle");
  });

  it("does not acknowledge background work while the underlying status is DONE", async () => {
    const machines = roster({ a: 1 });
    machines[0]!.snapshot!.panes[0]!.background_wait = true;
    const client = await open(machines, "a");
    expect(client.status("a")).toBe("waiting");
    expect(loadSeen("local", "server-a")).toEqual({});
    await client.update(roster({ a: 1 }));
    expect(client.status("a")).toBe("done");
  });

  it("does not cache a retired epoch's scope again while it retires", async () => {
    const client = await open(roster({ a: 1 }, {}, "retire-1"), "a");
    const set = Map.prototype.set;
    let cached: unknown[] = [];
    const spy = spyOn(Map.prototype, "set").mockImplementation(function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      // A scope's cached record maps panes to IDs; a change notice carries its epoch.
      if (value && typeof value === "object" && !Object.hasOwn(value, "epoch")) cached.push(key);
      return set.call(this, key, value);
    });
    try {
      for (let epoch = 2; epoch <= 4; epoch++) {
        cached = [];
        await client.update(roster({ a: 1 }, {}, `retire-${epoch}`), "a");
        expect(cached).not.toContain(JSON.stringify(["local", `retire-${epoch - 1}`]));
        expect(client.status("a")).toBe("idle");
      }
    } finally { spy.mockRestore(); }
  });

  it("drops the prior epoch even if pane IDs and finish counters are identical", async () => {
    const client = await open(roster({ a: 1 }), "a");
    await client.update(roster({ a: 1 }, {}, "server-b"));
    expect(client.status("a")).toBe("done");
    expect(loadSeen("local", "server-a")).toEqual({});
  });

  it("never restores an old tab's mark into a new epoch", async () => {
    const stale = await open(roster({ a: 1, b: 1 }), "a");
    const fresh = await open(roster({ a: 1, b: 1 }));
    await fresh.update(roster({ a: 1, b: 1 }, {}, "server-b"), "b");
    await stale.update(roster({ a: 1, b: 1 }), "b");
    const reload = await open(roster({ a: 1, b: 1 }, {}, "server-b"));
    expect([reload.status("a"), reload.status("b")]).toEqual(["done", "idle"]);
  });

  it("keeps another tab's new-pane marks when this tab has an older roster", async () => {
    const stale = await open(roster({ a: 1 }));
    await open(roster({ a: 1, c: 3 }), "c");
    await stale.update(roster({ a: 1 }), "a");
    expect(loadSeen("local", "server-a")).toEqual({ a: 1, c: 3 });
  });

  it("does not mistake an older initial roster or lower herdr seq for a restart", async () => {
    saveSeen("local", "server-a", "a", 4);
    const stale = await open(roster({ a: 1 }));
    expect(loadSeen("local", "server-a")).toEqual({ a: 4 });
    await stale.update(roster({ a: 4 }));
    expect(stale.status("a")).toBe("idle");
  });

  it("does not let an older initial epoch delete a newer tab's marks", async () => {
    saveSeen("local", "server-b", "b", 2);
    await open(roster({ a: 1 }, {}, "server-a"), "a");
    expect(loadSeen("local", "server-b")).toEqual({ b: 2 });
  });

  it("persists independent pane writes even with both reads before either write", () => {
    // This is the read/read/write/write schedule that lost a mark in the old whole-record store.
    const first = loadSeen("local", "server-a"), second = loadSeen("local", "server-a");
    expect([first, second]).toEqual([{}, {}]);
    saveSeen("local", "server-a", "a", 1);
    saveSeen("local", "server-a", "b", 2);
    expect(loadSeen("local", "server-a")).toEqual({ a: 1, b: 2 });
  });

  it("updates another mounted tab on storage events and repairs a lower same-pane race", async () => {
    const client = await open(roster({ a: 4 }));
    const key = seenKey("local", "server-a", "a");
    // Both contexts already prepared values; the older write lands last.
    data.set(key, JSON.stringify({ id: 4, at: 1 }));
    data.set(key, JSON.stringify({ id: 2, at: 2 }));
    await storage(key, JSON.stringify({ id: 4, at: 1 }));
    expect(loadSeen("local", "server-a")).toEqual({ a: 4 });
    expect(client.status("a")).toBe("idle");
  });

  it("marks only a visible page and a connected, actually rendered pane", async () => {
    visibility = "hidden";
    const client = await open(roster({ a: 1 }), "a");
    expect(client.status("a")).toBe("done");
    await act(async () => { visibility = "visible"; events.dispatchEvent(new Event("visibilitychange")); });
    expect(client.status("a")).toBe("idle");
    const absent = await open(roster({ b: 1 }), "not-rendered");
    expect(absent.status("b")).toBe("done");
    await absent.update(roster({ b: 1 }).map((m) => ({ ...m, state: "disconnected" })), "b");
    expect(absent.status("b")).toBe("done");
  });

  it("does not resurrect a deleted key when a previously queued write event arrives", async () => {
    const client = await open(roster({ a: 1 }), "a");
    await client.update(roster({ a: 1 }));
    const key = seenKey("local", "server-a", "a");
    data.delete(key);
    await storage(key, JSON.stringify({ id: 1, at: 1 }));
    expect(data.has(key)).toBe(false);
    expect(client.status("a")).toBe("done");
    expect(loadSeen("local", "server-a")).toEqual({});
  });

  it("leaves older bridges without an epoch or finish ID always unread", async () => {
    const machines = roster({ a: 1 });
    delete machines[0]!.snapshot!.finish_epoch;
    const noEpoch = await open(machines, "a");
    expect(noEpoch.status("a")).toBe("done");
    const noId = roster({ a: 1 });
    delete noId[0]!.snapshot!.panes[0]!.finish_id;
    const client = await open(noId, "a");
    expect(client.status("a")).toBe("done");
  });

  it("removes old-format records and caps keys oldest first, never by a roster", () => {
    data.set("ovis:seen:local", '{"a":5}');
    data.set("ovis:settings", "{}");
    for (let i = 0; i <= SEEN_LIMIT; i++) data.set(seenKey("local", "server-a", `p${i}`), JSON.stringify({ id: 1, at: i }));
    loadSeen("local", "server-a");
    expect(data.has("ovis:seen:local")).toBe(false);
    expect(data.has(seenKey("local", "server-a", "p0"))).toBe(false);
    expect(data.has(seenKey("local", "server-a", `p${SEEN_LIMIT}`))).toBe(true);
    expect(data.get("ovis:settings")).toBe("{}");
  });
});
