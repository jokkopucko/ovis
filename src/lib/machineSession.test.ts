import { describe, expect, it, spyOn } from "bun:test";
import type { PendingMessage, ServerMessage } from "../../shared/protocol.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { greetingMemory } from "./greeting.ts";
import { MachineSession, MachineSessionRegistry } from "./machineSession.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { PendingMessageStore, pendingMessages } from "./pendingMessages.ts";
import { currentWaitingSends, forgetWaitingSends, waitingKey } from "./sentWaiting.ts";
import type { HerdrSocket } from "./ws.ts";

type FeaturesFrame = Extract<ServerMessage, { type: "features" }>;

class FakeSocket {
  connected = false;
  connects = 0;
  closes = 0;
  private readonly handlers = new Set<(message: ServerMessage) => void>();
  private readonly disconnects = new Set<() => void>();
  on(handler: (message: ServerMessage) => void): () => void {
    this.handlers.add(handler); return () => { this.handlers.delete(handler); };
  }
  onDisconnect(handler: () => void): () => void {
    this.disconnects.add(handler); return () => { this.disconnects.delete(handler); };
  }
  connect(): void { this.connects++; this.connected = true; }
  close(): void { this.closes++; this.connected = false; this.handlers.clear(); this.disconnects.clear(); }
  private trusted: (frame: FeaturesFrame) => boolean = () => false;
  trustFeatures(check: (frame: FeaturesFrame) => boolean): void { this.trusted = check; }
  trusts(frame: FeaturesFrame): boolean { return this.trusted(frame); }
  receive(message: ServerMessage): void { for (const handler of this.handlers) handler(message); }
  disconnect(): void { this.connected = false; for (const handler of this.disconnects) handler(); }
}

const snapshot: ServerMessage = { type: "snapshot", features: ["submit", "pending-input"], snapshot: { version: "test", protocol: 22, workspaces: [], tabs: [], panes: [], agents: [], layouts: [] } };
const message = (id: string, state: PendingMessage["state"] = "queued"): PendingMessage => ({ id, request_id: 1, text: "review this next", state, created_at: "2026-10-11T00:00:00Z" });
function setup(machineId = "local", sharedStore?: PendingMessageStore) {
  const data = new Map<string, string>();
  const store = sharedStore ?? new PendingMessageStore(() => ({ getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } }));
  const socket = new FakeSocket();
  const session = new MachineSession(machineId, { socket: socket as unknown as HerdrSocket, pendingStore: store });
  return { session, socket, store };
}
function start(session: MachineSession, socket: FakeSocket): void { session.connect(); socket.receive(snapshot); }
const named = (herdr_lifetime: string): ServerMessage => ({ type: "snapshot", features: ["submit", "pending-input"], snapshot: { version: "test", protocol: 22, workspaces: [], tabs: [], panes: [], agents: [], layouts: [], herdr_lifetime } });
/** a page's localStorage, where the herdr fence finds what each pane kept */
function withStorage(run: () => void): void {
  const data = new Map<string, string>();
  const storage = {
    get length() { return data.size; },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => { data.clear(); },
  };
  const window = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
  try { run(); } finally {
    if (window) Object.defineProperty(globalThis, "window", window);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

describe("PC connection ownership", () => {
  it.each(["sent", "discarded"] as const)("settles a reloaded copy after the snapshot proves an early resumed %s receipt's lifetime", (outcome) => {
    const { session, socket, store } = setup(`reload-receipt-${outcome}`);
    const owner = paneStorageId(session.machineId, "w1:p1");
    store.accept(owner, message("saved"), null);
    session.connect();
    socket.receive({ type: "features", features: ["pending-input"], connection: "reload", herdr_lifetime: "reload-herdr" });
    expect(session.scope).toBeNull();
    // Open's attach replay can finish while the server still awaits clientSnapshot().
    socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [], removed: [{ id: "saved", outcome, resumed: true }] });
    expect(store.read(owner)).toHaveLength(1);
    socket.receive(named("reload-herdr"));
    expect(store.read(owner)).toEqual([]);
    session.close();
  });
  it("settles durable reload state only after the lifetime fence exposes that herdr's storage", () => {
    withStorage(() => {
      const { session, socket } = setup("durable-reload", pendingMessages);
      const owner = paneStorageId(session.machineId, "w1:p1");
      window.localStorage.setItem(`ovis:pane-lifetime:${session.machineId}`, "durable-herdr");
      window.localStorage.setItem(`ovis:pending:${owner}`, JSON.stringify({ version: 1, messages: [message("saved")] }));
      session.connect();
      socket.receive({ type: "features", features: ["pending-input"], connection: "reload", herdr_lifetime: "durable-herdr" });
      socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [], removed: [{ id: "saved", outcome: "sent", resumed: true }] });
      expect(window.localStorage.getItem(`ovis:pending:${owner}`)).not.toBeNull();
      socket.receive(named("durable-herdr"));
      expect(pendingMessages.read(owner)).toEqual([]);
      expect(window.localStorage.getItem(`ovis:pending:${owner}`)).toBeNull();
      session.close();
    });
  });
  it.each(["different lifetime", "no lifetime", "disconnected", "ordinary receipt"] as const)("does not settle an early receipt with %s", (scenario) => {
    const { session, socket, store } = setup(`reload-reject-${scenario}`);
    const owner = paneStorageId(session.machineId, "w1:p1");
    store.accept(owner, message("saved"), null);
    session.connect();
    socket.receive({ type: "features", features: ["pending-input"], connection: "reload", herdr_lifetime: "early-herdr" });
    socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [], removed: [{
      id: "saved", outcome: "sent", ...(scenario === "ordinary receipt" ? {} : { resumed: true }),
    }] });
    if (scenario === "disconnected") { socket.disconnect(); session.connect(); }
    socket.receive(scenario === "no lifetime" ? snapshot : named(scenario === "different lifetime" ? "other-herdr" : "early-herdr"));
    expect(store.read(owner)).toMatchObject([{ id: "saved", serverOwned: false }]);
    // A later matching snapshot cannot resurrect a rejected receipt.
    socket.receive(named("early-herdr"));
    expect(store.read(owner)).toHaveLength(1);
    session.close();
  });
  it("bounds early resumed receipts and keeps only resumed removals from a mixed frame", () => {
    const { session, socket, store } = setup("reload-bounded");
    const owner = paneStorageId(session.machineId, "w1:p1");
    store.accept(owner, message("oldest"), null);
    store.accept(owner, message("latest"), null);
    store.accept(owner, message("ordinary"), null);
    session.connect();
    socket.receive({ type: "features", features: ["pending-input"], connection: "reload", herdr_lifetime: "bounded-herdr" });
    for (let i = 0; i < 129; i++) socket.receive({
      type: "pending-messages", pane_id: "w1:p1", messages: [message("live")],
      removed: [{ id: i === 0 ? "oldest" : "latest", outcome: "sent", resumed: true }, { id: "ordinary", outcome: "sent" }],
    });
    socket.receive(named("bounded-herdr"));
    expect(store.read(owner).map(({ id }) => id)).toEqual(["oldest", "ordinary"]);
    session.close();
  });
  it("knows the PC's id for the open connection from its snapshot, and none once it drops", () => {
    const { session, socket } = setup();
    expect(session.connection).toBeNull();
    session.connect();
    socket.receive({ ...snapshot, connection: "c1" } as ServerMessage);
    expect(session.connection).toBe("c1");
    socket.disconnect();
    expect(session.connection).toBeNull();
    // an older bridge names none
    session.connect();
    socket.receive(snapshot);
    expect(session.connection).toBeNull();
  });
  it("owns a queued send's receipt from a features frame naming the herdr it knows, and keeps it live through the snapshot (#2257)", () => {
    withStorage(() => {
      const { session, socket } = setup("known-herdr-pc", pendingMessages);
      const owner = paneStorageId("known-herdr-pc", "w1:p1");
      session.connect();
      socket.receive(named("known-herdr-a"));
      socket.disconnect();
      session.connect();
      const features: FeaturesFrame = { type: "features", features: ["submit", "pending-input"], connection: "c1", herdr_lifetime: "known-herdr-a" };
      expect(socket.trusts(features)).toBe(true);
      socket.receive(features);
      expect(session.connection).toBe("c1");
      // the send left once the features were known; its receipt and the live list come before the snapshot
      session.acceptPending("w1:p1", message("p1"), session.epoch);
      socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [message("p1")] });
      expect(pendingMessages.read(owner).map(({ state, serverOwned }) => [state, serverOwned])).toEqual([["queued", true]]);
      const scope = session.scope;
      socket.receive(named("known-herdr-a"));
      expect(session.scope).toBe(scope);
      expect(pendingMessages.isOwned(owner, "p1", session.scope)).toBe(true);
      // the same herdr: nothing live is offered again as unsent text
      expect(paneLifetimes.unsent().filter((item) => item.machine_id === "known-herdr-pc")).toEqual([]);
      session.close();
    });
  });
  it("waits for the snapshot when a features frame names another herdr, or none: its pane IDs may be given out again (#2257)", () => {
    withStorage(() => {
      const { session, socket } = setup("replaced-herdr-pc", pendingMessages);
      session.connect();
      socket.receive(named("replaced-herdr-a"));
      socket.disconnect();
      session.connect();
      const frames: FeaturesFrame[] = [
        { type: "features", features: ["submit", "pending-input"], connection: "c1", herdr_lifetime: "replaced-herdr-b" },
        { type: "features", features: ["submit", "pending-input"], connection: "c1" },
      ];
      for (const features of frames) {
        expect(socket.trusts(features)).toBe(false);
        socket.receive(features);
        expect(session.scope).toBeNull();
        expect(session.connection).toBeNull();
      }
      // the snapshot runs the herdr fence first, then opens the connection's scope
      socket.receive({ ...named("replaced-herdr-b"), connection: "c1" } as ServerMessage);
      expect(paneLifetimes.generation("replaced-herdr-pc")).toBe("replaced-herdr-b");
      expect(session.scope).not.toBeNull();
      expect(session.connection).toBe("c1");
      session.close();
    });
  });
  it("lends its sessions to a peek without making one", () => {
    const made: string[] = [];
    const registry = new MachineSessionRegistry((machineId) => { made.push(machineId); return setup(machineId).session; });
    expect(registry.peek("local")).toBeUndefined();
    const session = registry.get("local");
    expect(registry.peek("local")).toBe(session);
    expect(made).toEqual(["local"]);
  });
  it("creates no network connection until explicitly connected and replays only the current role", () => {
    const { session, socket } = setup();
    expect(socket.connects).toBe(0);
    start(session, socket);
    socket.receive({ type: "role-ack", mode: "observe" });
    socket.receive({ type: "pty-data", pane_id: "w1:p1", data: "private output" });
    const events: ServerMessage[] = [];
    const off = session.on((frame) => events.push(frame));
    expect(events).toEqual([{ type: "role-ack", mode: "observe" }]);
    off();
    socket.disconnect();
    session.on((frame) => events.push(frame));
    expect(events).toHaveLength(1);
    session.close();
  });

  it("keeps the same scope while views unsubscribe and accepts a held receipt with no mounted pane", () => {
    const { session, socket, store } = setup();
    start(session, socket);
    const scope = session.scope;
    const owner = paneStorageId("local", "w1:p1");
    const off = session.on(() => {});
    socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [message("p1")] });
    off();
    // Detach's reply can arrive after the component and its xterm have gone away.
    socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [message("p1", "held")] });
    expect(session.scope).toBe(scope);
    expect(socket.closes).toBe(0);
    expect(store.read(owner)).toMatchObject([{ id: "p1", state: "held", serverOwned: true }]);
    expect(store.isOwned(owner, "p1", session.scope)).toBe(true);
    session.close();
  });

  it("keeps newer stream state when a queued submit promise is handled later", async () => {
    for (const state of ["held", "sending", "uncertain"] as const) {
      const { session, socket, store } = setup();
      start(session, socket);
      const owner = paneStorageId("local", "w1:p1"), epoch = session.epoch;
      const accepted = message("p1");
      socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [accepted] });
      const settled = Promise.resolve().then(() => session.acceptPending("w1:p1", accepted, epoch));
      const current = { ...message("p1", state), error: { code: "newer_state", message: "Review the current pane state" } };
      socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [current] });
      await settled;
      expect(store.read(owner)).toEqual([{ ...current, serverOwned: true }]);
      expect(store.isOwned(owner, "p1", session.scope)).toBe(true);
      session.close();
    }
  });

  it("publishes a matching removal and remembers sent chat before notifying a view", () => {
    const { session, socket, store } = setup("receipt-test-pc");
    start(session, socket);
    const owner = paneStorageId("receipt-test-pc", "w1:p1");
    socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [message("p1")] });
    let sentCount = 0;
    session.on((frame, sent) => {
      if (frame.type !== "pending-messages" || !sent) return;
      sentCount++;
      expect(store.read(owner)).toEqual([]);
      expect(greetingMemory(owner).sent).toBe(true);
    });
    const removal: ServerMessage = { type: "pending-messages", pane_id: "w1:p1", messages: [], removed: [{ id: "p1", outcome: "sent" }] };
    socket.receive(removal);
    socket.receive(removal);
    expect(sentCount).toBe(1);
    // A delayed acceptance receipt cannot recreate an already delivered item.
    session.acceptPending("w1:p1", message("p1"), session.epoch);
    expect(store.read(owner)).toEqual([]);
    session.close();
  });

  // a queued row typed by the turn end's drain or Send now leaves the row list before the transcript
  // holds its turn: the chat shows it as the user's waiting message meanwhile, as a composer send
  it("keeps a typed row in the chat as a waiting message, timed from when it went out", () => {
    const { session, socket } = setup("drain-pc");
    const key = waitingKey("drain-pc", "w1:p1");
    const clock = spyOn(Date, "now").mockReturnValue(1000);
    try {
      start(session, socket);
      socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [message("p1")] });
      socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [message("p1", "sending")] });
      clock.mockReturnValue(3000);
      const removal: ServerMessage = { type: "pending-messages", pane_id: "w1:p1", messages: [], removed: [{ id: "p1", outcome: "sent" }] };
      socket.receive(removal);
      socket.receive(removal);
      expect(currentWaitingSends(key)).toMatchObject([{ text: "review this next", at: 1000 }]);
      // a discarded row was never typed
      socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [message("p2")] });
      socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [], removed: [{ id: "p2", outcome: "discarded" }] });
      expect(currentWaitingSends(key)).toHaveLength(1);
    } finally { clock.mockRestore(); forgetWaitingSends(key); session.close(); }
  });

  it("times a row sent again from its own try, not from an earlier one that left it held", () => {
    const { session, socket } = setup("retry-pc");
    const key = waitingKey("retry-pc", "w1:p1");
    const clock = spyOn(Date, "now").mockReturnValue(1000);
    try {
      start(session, socket);
      socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [message("p1", "sending")] });
      // not typed (a draft in the box): held, and sent with Send now long after
      socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [message("p1", "held")] });
      clock.mockReturnValue(90_000);
      socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [message("p1", "sending")] });
      clock.mockReturnValue(91_000);
      socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [], removed: [{ id: "p1", outcome: "sent" }] });
      expect(currentWaitingSends(key)).toMatchObject([{ text: "review this next", at: 90_000 }]);
    } finally { clock.mockRestore(); forgetWaitingSends(key); session.close(); }
  });

  // sent through another connection: this one never saw it go out, and its turn may be read already
  it("keeps no waiting message for a row removed as sent that this connection never saw sending", () => {
    const { session, socket } = setup("elsewhere-pc");
    const key = waitingKey("elsewhere-pc", "w1:p1");
    try {
      start(session, socket);
      socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [message("p1", "held")] });
      socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [], removed: [{ id: "p1", outcome: "sent" }] });
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); session.close(); }
  });

  it("accepts an unmounted pane's submit receipt on its captured live connection", () => {
    const { session, socket, store } = setup();
    start(session, socket);
    const epoch = session.epoch;
    const off = session.on(() => {});
    off();
    session.acceptPending("w1:p1", message("p1"), epoch);
    const owner = paneStorageId("local", "w1:p1");
    expect(store.isOwned(owner, "p1", session.scope)).toBe(true);
    expect(store.read(owner)[0]?.state).toBe("queued");
    session.close();
  });

  it("suspends ownership on a real disconnect before view callbacks and never revives it on reconnect", () => {
    const { session, socket, store } = setup();
    start(session, socket);
    const epoch = session.epoch, oldScope = session.scope;
    const owner = paneStorageId("local", "w1:p1");
    session.acceptPending("w1:p1", message("queued"), epoch);
    session.acceptPending("w1:p1", message("held", "held"), epoch);
    session.onDisconnect(() => {
      expect(session.scope).toBeNull();
      expect(session.epoch).toBe(epoch + 1);
      expect(store.read(owner).map(({ state, serverOwned }) => [state, serverOwned])).toEqual([["uncertain", false], ["held", false]]);
    });
    socket.disconnect();
    start(session, socket);
    expect(session.scope).not.toBe(oldScope);
    socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [] });
    session.acceptPending("w1:p1", message("queued"), epoch);
    expect(store.read(owner).map(({ state, serverOwned }) => [state, serverOwned])).toEqual([["uncertain", false], ["held", false]]);
    session.close();
  });

  it("isolates identical pane and pending IDs across PCs and closes only the selected registry entry", () => {
    const sessions = new Map<string, ReturnType<typeof setup>>();
    const sharedStore = setup("store-only").store;
    const registry = new MachineSessionRegistry((machineId) => {
      const item = setup(machineId, sharedStore); sessions.set(machineId, item); return item.session;
    });
    const local = registry.get("local"), remote = registry.get("remote");
    expect(registry.get("local")).toBe(local);
    start(local, sessions.get("local")!.socket);
    start(remote, sessions.get("remote")!.socket);
    local.acceptPending("w1:p1", message("same"), local.epoch);
    remote.acceptPending("w1:p1", message("same"), remote.epoch);
    expect(local.scope).not.toBe(remote.scope);
    expect(sharedStore.isOwned(paneStorageId("local", "w1:p1"), "same", local.scope)).toBe(true);
    expect(sharedStore.isOwned(paneStorageId("remote", "w1:p1"), "same", remote.scope)).toBe(true);
    registry.retainMachines(new Set(["remote"]));
    expect(sessions.get("local")!.socket.closes).toBe(1);
    expect(sessions.get("remote")!.socket.closes).toBe(0);
    expect(sessions.get("remote")!.store.isOwned(paneStorageId("remote", "w1:p1"), "same", remote.scope)).toBe(true);
    registry.closeAll();
  });

  it("closeAll clears ownership and is reusable after an effect restart", () => {
    const made: ReturnType<typeof setup>[] = [];
    const registry = new MachineSessionRegistry((machineId) => {
      const item = setup(machineId); made.push(item); return item.session;
    });
    const old = registry.get("local");
    start(old, made[0]!.socket);
    old.acceptPending("w1:p1", message("p1"), old.epoch);
    registry.closeAll();
    registry.closeAll();
    expect(made[0]!.socket.closes).toBe(1);
    expect(made[0]!.store.read("w1:p1")).toMatchObject([{ state: "uncertain", serverOwned: false }]);
    const next = registry.get("local");
    expect(next).not.toBe(old);
    expect(made[1]!.socket.connects).toBe(0);
    start(next, made[1]!.socket);
    expect(next.scope).not.toBeNull();
    registry.closeAll();
  });
  it("gives the page the herdr a reconnected PC names before any pane hears of its snapshot (#1608)", () => {
    const { session, socket } = setup("fence-pc");
    const named = (herdr_lifetime: string): ServerMessage => ({ type: "snapshot", snapshot: { version: "test", protocol: 22, workspaces: [], tabs: [], panes: [], agents: [], layouts: [], herdr_lifetime } });
    paneLifetimes.observe([{ id: "fence-pc", snapshot: { version: "test", protocol: 22, workspaces: [], tabs: [], panes: [], agents: [], layouts: [], herdr_lifetime: "fence-herdr-a" } }], (pane) => pane.pane_id);
    const drawnUnder: (string | null | undefined)[] = [];
    session.on((message) => { if (message.type === "snapshot") drawnUnder.push(paneLifetimes.generation("fence-pc")); });
    session.connect();
    socket.receive(named("fence-herdr-b"));
    expect(drawnUnder).toEqual(["fence-herdr-b"]);
    session.close();
  });
  it("draws a reconnected PC's panes under no herdr when its snapshot proves none, before any pane hears of it (#1608)", () => {
    const { session, socket } = setup("unproven-pc");
    const owner = paneStorageId("unproven-pc", "w1:p1");
    const bare = { version: "test", protocol: 22, workspaces: [], tabs: [], panes: [], agents: [], layouts: [] };
    const seen: { lifetime: string | null | undefined; text: string | null }[] = [];
    session.on((message) => {
      if (message.type === "snapshot") seen.push({ lifetime: paneLifetimes.generation("unproven-pc"), text: paneLifetimes.paneStorage.getItem(`ovis:composer-draft:${owner}`) });
    });
    session.connect();
    socket.receive({ type: "snapshot", snapshot: { ...bare, herdr_lifetime: "unproven-herdr-a" } });
    paneLifetimes.paneStorage.setItem(`ovis:composer-draft:${owner}`, "old socket pane text");
    socket.disconnect();
    session.connect();
    socket.receive({ type: "snapshot", snapshot: bare });
    expect(seen).toEqual([{ lifetime: "unproven-herdr-a", text: null }, { lifetime: null, text: null }]);
    session.close();
  });
  it("brings a PC's own drafts back once its connection names its herdr again, and leaves what was typed with no proof to recovery (#1608)", () => {
    const data = new Map<string, string>();
    const storage = {
      get length() { return data.size; },
      key: (index: number) => [...data.keys()][index] ?? null,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
      clear: () => { data.clear(); },
    };
    const window = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
    try {
      const { session, socket } = setup("ingress-pc");
      const draft = (pane: string): string => `ovis:composer-draft:${paneStorageId("ingress-pc", pane)}`;
      const bare = { version: "test", protocol: 22, workspaces: [], tabs: [], panes: [], agents: [], layouts: [] };
      session.connect();
      socket.receive({ type: "snapshot", snapshot: { ...bare, herdr_lifetime: "ingress-herdr-a" } });
      paneLifetimes.paneStorage.setItem(draft("w1:p1"), "A's own draft");
      // the connection comes back with a snapshot that proves no herdr
      socket.disconnect();
      session.connect();
      socket.receive({ type: "snapshot", snapshot: bare });
      expect(paneLifetimes.paneStorage.getItem(draft("w1:p1"))).toBeNull();
      // typed meanwhile, in a pane that had no draft
      paneLifetimes.paneStorage.setItem(draft("w1:p2"), "unidentified new draft");
      socket.disconnect();
      session.connect();
      socket.receive({ type: "snapshot", snapshot: { ...bare, herdr_lifetime: "ingress-herdr-a" } });
      expect(paneLifetimes.paneStorage.getItem(draft("w1:p1"))).toBe("A's own draft");
      expect(paneLifetimes.paneStorage.getItem(draft("w1:p2"))).toBeNull();
      expect(paneLifetimes.unsent().filter((item) => item.machine_id === "ingress-pc").map((item) => `${item.pane_id}=${item.text}`)).toEqual(["w1:p2=unidentified new draft"]);
      session.close();
    } finally {
      if (window) Object.defineProperty(globalThis, "window", window);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
