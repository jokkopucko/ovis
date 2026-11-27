import { describe, expect, it } from "bun:test";

import { APP_ORIGIN, directPageAllowed, directSocketFactory, directTailnetSupport, EARLY_SEND_BYTES, EARLY_SEND_MESSAGES, isDirectSocketUrl, type DirectBridge, type DirectEvent, type DirectFrame } from "./directSocket.ts";

const CARRIER = "ws://192.168.0.10:7319/v1/ws?v=1";

function fakePlugin() {
  const calls: { method: string; id?: string; frame?: DirectFrame; code?: number; reason?: string; messages?: number; url?: string }[] = [];
  const opens: { url: string; answer: (id: string) => void; refuse: () => void; full: () => void }[] = [];
  let handler: ((event: DirectEvent) => void) | undefined;
  const bridge: DirectBridge = {
    open: (url) => new Promise((resolve, reject) => {
      calls.push({ method: "open", url });
      opens.push({ url, answer: resolve, refuse: () => reject(new Error("refused")), full: () => reject(Object.assign(new Error("Two direct sockets are open already"), { code: "too_many" })) });
    }),
    send: async (id, frame) => { calls.push({ method: "send", id, frame }); },
    close: async (id, code, reason) => { calls.push({ method: "close", id, ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) }); },
    ack: async (id, messages) => { calls.push({ method: "ack", id, messages }); },
    listen: (listener) => { handler = listener; },
  };
  return { bridge, calls, opens, emit: (event: DirectEvent) => handler!(event) };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("directPageAllowed", () => {
  const ios = { platform: "ios" as const, appVersion: "1.1.0", build: 12 };
  it("asks the plugin from the hosted shell's origin, as before", () => {
    expect(directPageAllowed(APP_ORIGIN, null)).toBe(true);
    expect(directPageAllowed("https://app-ap.ovis.sh", null)).toBe(false);
    expect(directPageAllowed("capacitor://app.ovis.sh", null)).toBe(false);
    expect(directPageAllowed("http://192.168.0.10:7317", null)).toBe(false);
  });

  it("asks it from the app's own copy whatever origin its platform gives it", () => {
    expect(directPageAllowed("capacitor://app.ovis.sh", ios)).toBe(true);
    expect(directPageAllowed(APP_ORIGIN, ios)).toBe(true);
  });
});

describe("isDirectSocketUrl", () => {
  it("takes only a private or Tailscale IPv4 carrier's /v1/ws?v=1", () => {
    expect(isDirectSocketUrl(CARRIER)).toBe(true);
    expect(isDirectSocketUrl("ws://10.0.0.2:7319/v1/ws?v=1")).toBe(true);
    expect(isDirectSocketUrl("ws://169.254.3.4:7319/v1/ws?v=1")).toBe(true);
    expect(isDirectSocketUrl("ws://100.64.0.2:7319/v1/ws?v=1")).toBe(true);
    expect(isDirectSocketUrl("ws://100.127.255.255:7319/v1/ws?v=1")).toBe(true);
    for (const url of [
      "ws://8.8.8.8:7319/v1/ws?v=1",
      "ws://100.63.255.255:7319/v1/ws?v=1",
      "ws://100.128.0.1:7319/v1/ws?v=1",
      "ws://172.32.0.1:7319/v1/ws?v=1",
      "ws://127.0.0.1:7319/v1/ws?v=1",
      "wss://192.168.0.10:7319/v1/ws?v=1",
      "ws://192.168.0.10/v1/ws?v=1",
      "ws://192.168.0.10:7319/v1/ws",
      "ws://192.168.0.10:7319/v1/ws?v=1&server_id=x",
      "ws://192.168.0.10:7319/other?v=1",
      "ws://pc.local:7319/v1/ws?v=1",
      "ws://user@192.168.0.10:7319/v1/ws?v=1",
    ]) expect(isDirectSocketUrl(url)).toBe(false);
  });
});

describe("directTailnetSupport", () => {
  it("says yes only once the plugin answered tailnet, and never waits for an answer", async () => {
    const answer = Promise.withResolvers<unknown>();
    const yes = directTailnetSupport(() => answer.promise);
    const no = directTailnetSupport(async () => ({}));
    const missing = directTailnetSupport(async () => { throw new Error("not implemented"); });
    const silent = directTailnetSupport(() => new Promise<never>(() => {}));
    expect(yes()).toBe(false);
    answer.resolve({ tailnet: true });
    await settle();
    expect([yes(), no(), missing(), silent()]).toEqual([true, false, false, false]);
  });
});

describe("directSocketFactory", () => {
  it("refuses an address that is not a direct carrier's before the plugin hears of it", () => {
    const plugin = fakePlugin();
    const open = directSocketFactory(plugin.bridge);
    expect(() => open("ws://8.8.8.8:7319/v1/ws?v=1")).toThrow(TypeError);
    expect(() => open("wss://relay.ovis.sh/v1/ws?v=1")).toThrow(TypeError);
    expect(plugin.calls).toEqual([]);
  });

  it("carries text and binary frames in their envelope both ways, in order, and acknowledges what it took", async () => {
    const plugin = fakePlugin();
    const socket = directSocketFactory(plugin.bridge)(CARRIER);
    const received: unknown[] = [];
    socket.onmessage = (event) => received.push(event.data);
    expect(socket.readyState).toBe(0);
    socket.send("hello");
    plugin.opens[0]!.answer("s1");
    await settle();
    expect(socket.readyState).toBe(1);
    socket.send(new Uint8Array([0, 1, 254, 255]).buffer);

    plugin.emit({ type: "message", id: "s1", kind: "text", data: "{\"type\":\"assigned\"}" });
    plugin.emit({ type: "message", id: "s1", kind: "binary", data: "AAH+/w==" });
    await settle();

    expect(plugin.calls.filter((call) => call.method === "send").map((call) => call.frame)).toEqual([
      { kind: "text", data: "hello" },
      { kind: "binary", data: "AAH+/w==" },
    ]);
    expect(received[0]).toBe("{\"type\":\"assigned\"}");
    expect(received[1]).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(received[1] as ArrayBuffer)]).toEqual([0, 1, 254, 255]);
    expect(plugin.calls.filter((call) => call.method === "ack")).toEqual([{ method: "ack", id: "s1", messages: 2 }]);
  });

  it("hands over events the plugin sent before its open answered, in order", async () => {
    const plugin = fakePlugin();
    const socket = directSocketFactory(plugin.bridge)(CARRIER);
    const seen: string[] = [];
    socket.onmessage = (event) => seen.push(`message:${String(event.data)}`);
    socket.onclose = (event) => seen.push(`close:${event.code}`);
    plugin.emit({ type: "message", id: "s1", kind: "text", data: "first" });
    plugin.emit({ type: "close", id: "s1", code: 1000, reason: "" });
    plugin.opens[0]!.answer("s1");
    await settle();
    expect(seen).toEqual(["message:first", "close:1000"]);
    expect(socket.readyState).toBe(3);
  });

  it("maps the plugin's error and close to the socket's, and a refused open to a socket that never connected", async () => {
    const plugin = fakePlugin();
    const open = directSocketFactory(plugin.bridge);
    const live = open(CARRIER);
    const events: string[] = [];
    live.onerror = () => events.push("error");
    live.onclose = (event) => events.push(`close:${event.code}:${event.reason}:${event.wasClean}`);
    plugin.opens[0]!.answer("s1");
    await settle();
    plugin.emit({ type: "error", id: "s1" });
    plugin.emit({ type: "close", id: "s1", code: 1001, reason: "going away" });
    expect(events).toEqual(["error", "close:1001:going away:true"]);
    expect(live.readyState).toBe(3);

    // two already open, or not the app's page: the plugin refuses, and the socket fails as WebSocket does
    const refused = open(CARRIER);
    const failed: string[] = [];
    refused.onerror = () => failed.push("error");
    refused.onclose = (event) => failed.push(`close:${event.code}:${event.wasClean}`);
    plugin.opens[1]!.refuse();
    await settle();
    expect(failed).toEqual(["error", "close:1006:false"]);
    expect(refused.readyState).toBe(3);
  });

  it("asks again for a socket the plugin refused as full once it reports a close, unless the asker would not wait (#3243)", async () => {
    // Given two sockets open, one of them closing (the plugin keeps its place until it reports the close)
    const plugin = fakePlugin();
    const open = directSocketFactory(plugin.bridge);
    const closing = open(CARRIER);
    open(CARRIER);
    plugin.opens[0]!.answer("s1");
    plugin.opens[1]!.answer("s2");
    await settle();
    closing.close();
    // When a later race asks for one, another asker gives up while refused, and a sweep that would not wait asks too
    const events: string[] = [];
    const next = open(CARRIER);
    next.onclose = (event) => events.push(`next:close:${event.code}`);
    const givenUp = open(CARRIER);
    givenUp.onclose = (event) => events.push(`given-up:close:${event.code}`);
    const sweep = open(CARRIER, false);
    sweep.onclose = (event) => events.push(`sweep:close:${event.code}`);
    for (const refused of plugin.opens.slice(2)) refused.full();
    await settle();
    givenUp.close();
    await settle();
    // Then the race's socket still connects, the others end as sockets that never connected
    expect(next.readyState).toBe(0);
    expect(events).toEqual(["sweep:close:1006", "given-up:close:1006"]);
    // and once the plugin reports the close, only the race's is asked for again
    plugin.emit({ type: "close", id: "s1", code: 1000, reason: "" });
    expect(plugin.opens.slice(5).length).toBe(1);
    plugin.opens[5]!.answer("s3");
    await settle();
    expect(next.readyState).toBe(1);
    // a close reported while a refused ask was on its way gets it asked again at once
    const late = open(CARRIER);
    plugin.emit({ type: "close", id: "s2", code: 1000, reason: "" });
    plugin.opens[6]!.full();
    await settle();
    expect(plugin.opens.length).toBe(8);
    expect(late.readyState).toBe(0);
  });

  it("closes through the plugin, once it named the socket", async () => {
    const plugin = fakePlugin();
    const socket = directSocketFactory(plugin.bridge)(CARRIER);
    socket.close(4000, "probe done");
    expect(socket.readyState).toBe(2);
    socket.send("late");
    plugin.opens[0]!.answer("s1");
    await settle();
    expect(plugin.calls.filter((call) => call.method !== "open")).toEqual([{ method: "close", id: "s1", code: 4000, reason: "probe done" }]);
  });

  it.each([
    ["bytes", () => [new ArrayBuffer(EARLY_SEND_BYTES), new ArrayBuffer(1)]],
    ["messages", () => Array.from({ length: EARLY_SEND_MESSAGES + 1 }, () => "")],
  ] as const)("closes with 1009 when more %s wait for the plugin to name the socket than it holds", async (_kind, sends) => {
    const plugin = fakePlugin();
    const socket = directSocketFactory(plugin.bridge)(CARRIER);
    const closed: number[] = [];
    socket.onclose = (event) => closed.push(event.code);
    for (const data of sends()) socket.send(data);
    await settle();
    expect(closed).toEqual([1009]);
    expect(socket.readyState).toBe(3);
    plugin.opens[0]!.answer("s1");
    await settle();
    expect(plugin.calls.filter((call) => call.method !== "open")).toEqual([{ method: "close", id: "s1", code: 1009, reason: "send queue full" }]);
  });

  it("ends a socket whose queue in the plugin overflowed, and takes nothing more from it", async () => {
    const plugin = fakePlugin();
    const socket = directSocketFactory(plugin.bridge)(CARRIER);
    const seen: string[] = [];
    socket.onmessage = (event) => seen.push(String(event.data));
    socket.onclose = (event) => seen.push(`close:${event.code}`);
    plugin.opens[0]!.answer("s1");
    await settle();
    // the plugin gives up on a page that does not keep up: past 4 MiB or 16,384 unacknowledged messages
    plugin.emit({ type: "close", id: "s1", code: 1009, reason: "receive queue full" });
    plugin.emit({ type: "message", id: "s1", kind: "text", data: "after" });
    await settle();
    expect(seen).toEqual(["close:1009"]);
    expect(plugin.calls.some((call) => call.method === "ack")).toBe(false);
  });
});
