import { afterEach, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFrame, encodeFrame, FrameType, LIMITS_V1 } from "../../shared/relay-mux.ts";
import { MuxStreamError } from "../../shared/relay-mux-engine.ts";
import type { MachineEvent } from "../../shared/machines.ts";
import { handleRequest } from "../dispatch.ts";
import { PairingRateLimitedError, readDeviceRegistry } from "../devices.ts";
import { machineEventsClock, machineEventsQueuedBytes } from "../machine-api.ts";
import { PortalService } from "../portal.ts";
import { relayHeaders, RELAY_ORIGIN } from "./session.ts";
import { bounded, deferred, relayConnection, relayDevice, relayFixture, TestClock } from "./test-helpers.ts";

const fixtures: ReturnType<typeof relayFixture>[] = [];
function fixture(serveOnly = false) {
  const value = relayFixture(serveOnly);
  fixtures.push(value);
  return value;
}
afterEach(() => { for (const item of fixtures.splice(0)) item.close(); });
const guard = [["content-type", "application/json"], ["x-herdr-machine", "1"]] as const;
const fileTarget = (path: string) => `/api/fs/file?path=${encodeURIComponent(path)}`;

it("serves health through real protected channels and records the route template", async () => {
  const f = fixture();
  const device = await relayDevice(f);
  const link = await relayConnection(f);
  await link.auth(device);
  const response = await link.open("/api/health?secret=not-logged").response;
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ auth: { via: "relay", role: "drive" } });
  expect(link.channel.securityMode()).toBe("protected");
  expect(link.daemon.securityMode()).toBe("protected");
  const log = readFileSync(join(f.stateDir, "http-requests.jsonl"), "utf8");
  expect(log).toContain('"/api/health"');
  expect(log).not.toContain("not-logged");
});

it("keeps a renamed relay device admitted and still revokes its session", async () => {
  const f = fixture();
  const device = await relayDevice(f);
  const link = await relayConnection(f);
  await link.auth(device);
  const response = await fetch(`http://127.0.0.1:${f.app.port}/api/devices/${device.id}`, {
    method: "PATCH", headers: { "content-type": "application/json", "x-herdr-machine": "1" },
    body: JSON.stringify({ label: "Renamed phone" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ label: "Renamed phone", role: "drive" });
  await link.flush();
  expect(link.session.mux.active).toBe(true);
  expect(link.channel.isOpen()).toBe(true);
  const health = await link.open("/api/health").response;
  expect(await health.json()).toMatchObject({ auth: { via: "relay", role: "drive" } });
  f.app.context.services.devices.revoke(device.id);
  expect(await bounded(link.serverError)).toBe("auth_revoked");
});

for (const role of ["drive", "watch"] as const) {
  it(`keeps the preferences PUT contract and ${role} authority`, async () => {
    const f = fixture();
    const link = await relayConnection(f);
    await link.auth(await relayDevice(f, role));
    const request = link.open("/api/preferences", { method: "PUT", headers: guard, body: "stream" });
    const upload = request.stream.sendBody(new Response('{"settings":{}}').body ?? new ReadableStream());
    const response = await request.response;
    // A refused upload is stopped, so a body write still queued behind the channel is cancelled.
    const uploaded = await upload.then(() => "sent", (error: unknown) => error instanceof MuxStreamError ? error.code : String(error));
    expect(role === "drive" ? ["sent"] : ["sent", "cancelled"]).toContain(uploaded);
    expect(response.status).toBe(role === "drive" ? 200 : 403);
    expect(await response.json()).toMatchObject(role === "drive" ? { settings: {} } : { error: { code: "read_only" } });
    const post = await link.open("/api/preferences", { method: "POST" }).response;
    expect(post.status).toBe(role === "drive" ? 405 : 403);
    await post.text();
  });
}

it("delivers exact Range bytes and a digest-equal 40 MiB download within the counted budget", async () => {
  const f = fixture();
  const path = join(f.stateDir, "download.bin");
  const bytes = Buffer.alloc(40 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  writeFileSync(path, bytes);
  const link = await relayConnection(f);
  await link.auth(await relayDevice(f));
  const ranged = await link.open(fileTarget(path), { headers: [["range", "bytes=0-99"]] }).response;
  expect(ranged.status).toBe(206);
  expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(new Uint8Array(bytes.subarray(0, 100)));
  const response = await link.open(fileTarget(path)).response;
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing download");
  const hash = createHash("sha256");
  let received = 0;
  for (;;) {
    const chunk = await bounded(reader.read());
    if (chunk.done) break;
    received += chunk.value.length;
    hash.update(chunk.value);
    expect(link.peakBuffered).toBeLessThanOrEqual(9.5 * 1024 * 1024);
  }
  reader.releaseLock();
  const digest = hash.digest("hex");
  expect(received).toBe(bytes.length);
  expect(digest).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(link.frames.filter((frame) => frame.type === FrameType.HTTP_DATA).every((frame) => frame.bytes <= 16384)).toBe(true);
  console.log(`DOWNLOAD bytes=${received} sha256=${digest} peak_counted_buffered=${link.peakBuffered} limit=${9.5 * 1024 * 1024}`);
}, 30_000);

for (const extension of ["html", "svg"]) {
  it(`preserves sandbox and nosniff for ${extension} files`, async () => {
    const f = fixture();
    const path = join(f.stateDir, `document.${extension}`);
    writeFileSync(path, extension === "html" ? "<h1>Document</h1>" : '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const link = await relayConnection(f);
    await link.auth(await relayDevice(f));
    const response = await link.open(fileTarget(path)).response;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")?.startsWith("sandbox")).toBe(true);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.has("set-cookie")).toBe(false);
    console.log(`HEADERS ${extension} content-security-policy=${response.headers.get("content-security-policy")} x-content-type-options=${response.headers.get("x-content-type-options")} referrer-policy=${response.headers.get("referrer-policy")}`);
    await response.text();
  });
}

it("delivers the roster and heartbeat and cancels the real SSE subscription on abort", async () => {
  const f = fixture();
  const manager = f.app.context.services.core.machines;
  if (!manager) throw new Error("Missing machine manager");
  const subscribe = manager.subscribe.bind(manager);
  const unsubscribed = deferred<void>();
  const stopped = spyOn(manager, "subscribe").mockImplementation((listener) => {
    const stop = subscribe(listener);
    return () => { stop(); unsubscribed.resolve(); };
  });
  let heartbeat: (() => void) | undefined;
  const realHeartbeat = machineEventsClock.heartbeat;
  const timer = spyOn(machineEventsClock, "heartbeat").mockImplementation((send) => {
    heartbeat = send;
    return realHeartbeat(send);
  });
  try {
    const link = await relayConnection(f);
    await link.auth(await relayDevice(f));
    const request = link.open("/api/machines/events");
    const response = await request.response;
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.has("set-cookie")).toBe(false);
    const reader = response.body?.getReader();
    if (!reader || !heartbeat) throw new Error("SSE not started");
    let text = "";
    while (!text.includes('"type":"machines"')) {
      const chunk = await bounded(reader.read());
      expect(chunk.done).toBe(false);
      text += new TextDecoder().decode(chunk.value);
    }
    heartbeat();
    while (!text.includes(": heartbeat\n\n")) {
      const chunk = await bounded(reader.read());
      expect(chunk.done).toBe(false);
      text += new TextDecoder().decode(chunk.value);
    }
    await reader.cancel();
    await bounded(unsubscribed.promise);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(machineEventsQueuedBytes()).toBe(0);
    expect((await link.open("/api/health").response).status).toBe(200);
  } finally { stopped.mockRestore(); timer.mockRestore(); }
});

it("charges oversized SSE frames to the relay stream instead of the native exception", async () => {
  const f = fixture();
  const manager = f.app.context.services.core.machines;
  if (!manager) throw new Error("Missing machine manager");
  const subscribe = manager.subscribe.bind(manager);
  let emit: ((event: MachineEvent) => void) | undefined;
  const unsubscribed = deferred<void>();
  const watched = spyOn(manager, "subscribe").mockImplementation((listener) => {
    emit = listener;
    const stop = subscribe(listener);
    return () => { stop(); unsubscribed.resolve(); };
  });
  try {
    const link = await relayConnection(f);
    await link.auth(await relayDevice(f));
    const request = link.open("/api/machines/events");
    const response = await request.response;
    const reset = deferred<string>();
    link.onFrame = (frame) => { if (frame.type === FrameType.RESET) reset.resolve(frame.payload.code); };
    if (!emit) throw new Error("Missing SSE listener");
    emit({ type: "machine-message", machine_id: "local",
      message: { type: "pane-status", pane_id: "x".repeat(5 * 1024 * 1024), agent_status: "idle", finish_epoch: "e", finish_id: 0 } });
    expect(await bounded(reset.promise)).toBe("resource_exhausted");
    await bounded(unsubscribed.promise);
    await expect(response.text()).rejects.toThrow();
    expect(machineEventsQueuedBytes()).toBe(0);
    expect(link.session.bufferedBytes).toBeLessThan(1024 * 1024);
    expect((await link.open("/api/health").response).status).toBe(200);
  } finally { watched.mockRestore(); }
});

it("aborts an in-flight request and closes with auth_revoked when the device is revoked", async () => {
  const f = fixture();
  const device = await relayDevice(f);
  const entered = deferred<Request>();
  const aborted = deferred<void>();
  const link = await relayConnection(f, {
    dispatch: async (request, context) => {
      if (new URL(request.url).pathname !== "/api/held") return handleRequest(request, context);
      entered.resolve(request);
      return new Promise<Response>((resolve) => {
        request.signal.addEventListener("abort", () => { aborted.resolve(); resolve(new Response("aborted")); }, { once: true });
      });
    },
  });
  await link.auth(device);
  const request = link.open("/api/held");
  const outcome = request.response.catch((error: unknown) => error);
  await bounded(entered.promise);
  f.app.context.services.devices.revoke(device.id);
  await bounded(aborted.promise);
  expect(await bounded(link.serverError)).toBe("auth_revoked");
  await bounded(link.closed);
  expect(await outcome).toBeInstanceOf(Error);
});

it("rejects OPEN before AUTH_OK without invoking the dispatcher", async () => {
  const f = fixture();
  let calls = 0;
  const link = await relayConnection(f, { dispatch: async (request, context) => { calls++; return handleRequest(request, context); } });
  // The server closes the channel while answering, so this send may reject with that close.
  await link.channel.send(encodeFrame({
    type: FrameType.HTTP_OPEN, flags: 0, stream_id: 1,
    payload: { device_id: "0123456789abcdef", method: "GET", target: "/api/health", headers: [], body: "none" },
  }).slice().buffer).catch((error: unknown) => {
    if (!(error instanceof Error) || error.message !== "Secure channel closed") throw error;
  });
  expect(await bounded(link.serverError)).toBe("protocol_error");
  expect(calls).toBe(0);
  console.log(`PREAUTH SESSION_ERROR=protocol_error handler_calls=${calls}`);
});

it("drops all forged identity headers at the Request boundary", async () => {
  const forged = [
    ["cookie", "ovis_device=forged"], ["authorization", "Bearer forged"], ["host", "evil.example"],
    ["origin", "https://evil.example"], ["x-forwarded-host", "evil.example"], ["x-forwarded-for", "127.0.0.1"],
    ["tailscale-user-login", "owner@example.com"], ["accept", "application/json"],
  ] as const;
  const seen = new Request(RELAY_ORIGIN + "/api/health", { headers: relayHeaders(forged) });
  expect(seen.headers.get("origin")).toBe(RELAY_ORIGIN);
  expect(seen.headers.get("sec-fetch-site")).toBe("same-origin");
  expect(seen.headers.get("accept-encoding")).toBe("identity");
  expect(seen.headers.get("accept")).toBe("application/json");
  for (const [name] of forged) {
    if (name !== "origin" && name !== "accept") expect(seen.headers.has(name)).toBe(false);
  }
});

it("drops forged headers on the encrypted wire and dispatches with synthetic origin", async () => {
  const f = fixture();
  const portal = new PortalService({ stateDir: f.stateDir });
  f.app.context.services.options.portal = portal;
  const proof = spyOn(portal, "vouches").mockReturnValue(true);
  const portalRole = spyOn(portal, "roleFor").mockReturnValue("drive");
  const device = await relayDevice(f, "watch");
  const handled = deferred<Request>();
  const link = await relayConnection(f, { dispatch: async (request, context) => {
    expect(context.peer).toMatchObject({ kind: "relay", device: { id: device.id, role: "watch" } });
    handled.resolve(request);
    return handleRequest(request, context);
  } });
  try {
    expect(await link.auth(device)).toMatchObject({ device_id: device.id, role: "watch" });
    // Inject after mux serialization but before encryption, bypassing the client's header filter.
    link.transformClientFrame = (bytes) => {
      const decoded = decodeFrame(bytes);
      if (decoded.type !== FrameType.HTTP_OPEN) return bytes;
      const metadata = new TextEncoder().encode(JSON.stringify({
        ...decoded.payload,
        headers: [["cookie", "forged"], ["origin", "https://evil.example"], ["authorization", "Bearer forged"],
          ["host", "evil.example"], ["x-forwarded-for", "127.0.0.1"], ["tailscale-user-login", "owner@example.com"],
          ["x-portal-proof", "valid-portal-proof"], ["x-portal-user", "owner"], ["x-portal-auth", "credential"]],
      }));
      const frame = new Uint8Array(8 + metadata.length);
      frame.set(bytes.subarray(0, 8));
      frame.set(metadata, 8);
      return frame;
    };
    const response = await link.open("/api/health").response;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      auth: { authenticated: true, via: "relay", role: "watch" },
      security: { observed_ingress: "relay" },
    });
    const request = await bounded(handled.promise);
    expect(request.headers.get("origin")).toBe(RELAY_ORIGIN);
    expect(request.headers.get("sec-fetch-site")).toBe("same-origin");
    for (const name of ["cookie", "authorization", "host", "x-forwarded-for", "tailscale-user-login",
      "x-portal-proof", "x-portal-user", "x-portal-auth"]) {
      expect(request.headers.has(name)).toBe(false);
    }
    const write = await link.open("/api/preferences", { method: "PUT" }).response;
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ error: { code: "read_only" } });
    expect(link.channel.securityMode()).toBe("protected");
    expect(link.daemon.securityMode()).toBe("protected");
    expect(proof).not.toHaveBeenCalled();
    expect(portalRole).not.toHaveBeenCalled();
  } finally {
    proof.mockRestore();
    portalRole.mockRestore();
    await portal.shutdown();
  }
});

it("pairs with a valid code and stores the relay public key before AUTH_OK", async () => {
  const f = fixture();
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
  const link = await relayConnection(f);
  const admitted = await link.pair(f.app.context.services.devices.startPairing().code, publicKey);
  expect(admitted.role).toBe("drive");
  const registry = readDeviceRegistry(join(f.stateDir, "devices.json"));
  expect(registry.kind).toBe("ok");
  if (registry.kind !== "ok") throw new Error("Missing registry");
  expect(registry.devices.find((device) => device.id === admitted.device_id)?.relay_public_key).toBe(publicKey);
  expect((await link.open("/api/health").response).status).toBe(200);
});

it("reports pairing rate limits during PAIR instead of an internal error", async () => {
  const f = fixture();
  const store = f.app.context.services.devices;
  const device = await relayDevice(f);
  for (let attempt = 0; attempt < 20; attempt++) expect(store.pairRelay("000000", "Phone", device.publicKey)).toBeNull();
  let limited: PairingRateLimitedError | undefined;
  try { store.pairRelay("000000", "Phone", device.publicKey); }
  catch (error) {
    if (!(error instanceof PairingRateLimitedError)) throw error;
    limited = error;
  }
  if (!limited) throw new Error("Expected pairing limit");
  const link = await relayConnection(f);
  const failure = deferred<{ code: string; message: string }>();
  link.onFrame = (frame) => {
    if (frame.type === FrameType.SESSION_ERROR) failure.resolve(frame.payload);
  };
  const admission = link.pair("000000", device.publicKey).catch((error: unknown) => error);
  expect(await bounded(failure.promise)).toEqual({ code: "auth_failed", message: limited.message });
  expect(await admission).toBeInstanceOf(Error);
  expect(link.frames.some((frame) => frame.type === FrameType.AUTH_OK)).toBe(false);
});

it("keeps the native pairing rate-limit status and retry header over relay HTTP", async () => {
  const f = fixture();
  const device = await relayDevice(f);
  const store = f.app.context.services.devices;
  // Enrollment already spent the first of ten code issues.
  for (let issue = 1; issue < 10; issue++) store.startPairing();
  const link = await relayConnection(f);
  await link.auth(device);
  const response = await link.open("/api/devices/pair/start", { method: "POST", headers: guard }).response;
  expect(response.status).toBe(429);
  expect(await response.json()).toMatchObject({ error: { code: "pairing_rate_limited" } });
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(link.channel.isOpen()).toBe(true);
});

it("refuses WS_OPEN without an adapter hook and keeps HTTP available", async () => {
  const f = fixture();
  const link = await relayConnection(f);
  await link.auth(await relayDevice(f));
  const reset = deferred<string>();
  link.onFrame = (frame) => { if (frame.type === FrameType.RESET) reset.resolve(frame.payload.code); };
  link.mux.openWs({ target: "/ws", headers: [], protocols: [] });
  expect(await bounded(reset.promise)).toBe("refused");
  expect((await link.open("/api/health").response).status).toBe(200);
});

it("captures the real dispatcher upgrade for an injected WebSocket adapter", async () => {
  const f = fixture();
  const captured = deferred<void>();
  const link = await relayConnection(f, {
    onWs: (stream, exchange) => {
      void handleRequest(exchange.request, exchange.context).then((response) => {
        expect(response).toBeUndefined();
        expect(exchange.upgrade?.data.deviceId).toBe(stream.request.device_id);
        expect(exchange.context.requestIP(exchange.request)).toBeNull();
        captured.resolve();
        stream.reset("refused");
      }, captured.reject);
    },
  });
  await link.auth(await relayDevice(f));
  link.mux.openWs({ target: "/ws", headers: [], protocols: [] });
  await bounded(captured.promise);
});

it("closes a device revoked during listener registration before publishing AUTH_OK", async () => {
  const f = fixture();
  const device = await relayDevice(f);
  const store = f.app.context.services.devices;
  const register = store.onRevoke.bind(store);
  const raced = spyOn(store, "onRevoke").mockImplementation((id, close) => {
    store.revoke(id);
    return register(id, close);
  });
  try {
    const link = await relayConnection(f);
    const admission = link.auth(device).catch((error: unknown) => error);
    expect(await bounded(link.serverError)).toBe("auth_revoked");
    expect(link.frames.some((frame) => frame.type === FrameType.AUTH_OK)).toBe(false);
    link.stop();
    expect(await admission).toBeInstanceOf(Error);
  } finally { raced.mockRestore(); }
});

it("enforces the ten second setup deadline without a wall-clock sleep", async () => {
  const f = fixture();
  const clock = new TestClock();
  const link = await relayConnection(f, { clock });
  await link.hello();
  clock.advance(9999);
  expect(link.session.mux.active).toBe(true);
  clock.advance(1);
  expect(await bounded(link.serverError)).toBe("timeout");
});

it("applies dispatcher timeout overrides and aborts the request at that budget", async () => {
  const f = fixture();
  const clock = new TestClock();
  const entered = deferred<void>();
  const aborted = deferred<void>();
  const link = await relayConnection(f, {
    clock, dispatch: async (request, context) => {
      context.timeout(request, 180);
      entered.resolve();
      await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => { aborted.resolve(); resolve(); }, { once: true }));
      return new Response();
    },
  });
  await link.auth(await relayDevice(f));
  const request = link.open("/api/machines/test/worktree/create");
  const outcome = request.response.catch((error: unknown) => error);
  await bounded(entered.promise);
  const deadline = [...clock.tasks.values()].find((task) => task.at === 180_000);
  expect(deadline).toBeDefined();
  expect([...clock.tasks.values()].some((task) => task.at === 60_000)).toBe(false);
  if (!deadline) throw new Error("Route deadline missing");
  deadline.callback();
  await bounded(aborted.promise);
  expect(await outcome).toBeInstanceOf(Error);
  expect(link.session.mux.active).toBe(true);
});

it("refuses an oversized request before dispatch and does not grant body credit", async () => {
  const f = fixture();
  let calls = 0;
  const link = await relayConnection(f, { dispatch: async () => { calls++; return new Response(); } });
  await link.auth(await relayDevice(f));
  const request = link.open("/api/preferences", {
    method: "PUT", body: "stream", headers: [["content-length", String(LIMITS_V1.max_request_body_bytes + 1)]],
  });
  expect((await request.response).status).toBe(413);
  expect(calls).toBe(0);
  expect(link.frames.some((frame) => frame.type === FrameType.HTTP_ACCEPT)).toBe(false);
});

it("keeps the engine's 413 when an unknown-length upload crosses the request ceiling", async () => {
  const f = fixture();
  const aborted = deferred<void>();
  const link = await relayConnection(f, {
    dispatch: async (request) => {
      request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      const reader = request.body?.getReader();
      if (!reader) throw new Error("Missing upload");
      try {
        while (!(await reader.read()).done) { /* Consume without retaining the upload. */ }
        return new Response("accepted");
      } catch {
        return new Response("body stopped", { status: 400 });
      } finally { reader.releaseLock(); }
    },
  });
  await link.auth(await relayDevice(f));
  const request = link.open("/api/upload", { method: "POST", body: "stream" });
  let left = LIMITS_V1.max_request_body_bytes + 1;
  const upload = request.stream.sendBody(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!left) { controller.close(); return; }
      const size = Math.min(left, 16376);
      left -= size;
      controller.enqueue(new Uint8Array(size));
    },
  }, { highWaterMark: 0 }));
  const response = await request.response;
  expect(response.status).toBe(413);
  expect(await response.text()).toBe("");
  await upload;
  await bounded(aborted.promise);
  expect(link.session.mux.active).toBe(true);
}, 30_000);

it("rejects malformed binary frames without dispatch", async () => {
  const f = fixture();
  let calls = 0;
  const link = await relayConnection(f, { dispatch: async () => { calls++; return new Response(); } });
  await link.auth(await relayDevice(f));
  await link.channel.send(new Uint8Array([1, FrameType.HTTP_OPEN]).buffer).catch((error: unknown) => {
    if (!(error instanceof Error) || error.message !== "Secure channel closed") throw error;
  });
  expect(await bounded(link.serverError)).toBe("protocol_error");
  expect(calls).toBe(0);
});

it("cancels the response producer when the client aborts mid-body", async () => {
  const f = fixture();
  const cancelled = deferred<void>();
  const link = await relayConnection(f, {
    dispatch: async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(16376)); },
      cancel() { cancelled.resolve(); },
    }, { highWaterMark: 0 })),
  });
  await link.auth(await relayDevice(f));
  const response = await link.open("/api/download").response;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing response");
  expect((await bounded(reader.read())).value?.length).toBe(16376);
  await reader.cancel();
  await bounded(cancelled.promise);
});

it("rejects a principal whose role changed between key verification and listener registration", async () => {
  const f = fixture();
  const device = await relayDevice(f);
  const store = f.app.context.services.devices;
  const match = store.matchRelay.bind(store);
  const raced = spyOn(store, "matchRelay").mockImplementation(async (...args) => {
    const principal = await match(...args);
    store.update(device.id, { role: "watch" });
    return principal;
  });
  try {
    const link = await relayConnection(f);
    const admission = link.auth(device).catch((error: unknown) => error);
    expect(await bounded(link.serverError)).toBe("auth_changed");
    expect(await admission).toBeInstanceOf(Error);
    expect(link.frames.some((frame) => frame.type === FrameType.AUTH_OK)).toBe(false);
  } finally { raced.mockRestore(); }
});

it("cannot dispatch the first request after its authenticated device is revoked", async () => {
  const f = fixture();
  const device = await relayDevice(f);
  let calls = 0;
  const link = await relayConnection(f, { dispatch: async () => { calls++; return new Response(); } });
  await link.auth(device);
  const request = link.open("/api/health");
  const outcome = request.response.catch((error: unknown) => error);
  f.app.context.services.devices.revoke(device.id);
  expect(await bounded(link.serverError)).toBe("auth_revoked");
  expect(await outcome).toBeInstanceOf(Error);
  expect(calls).toBe(0);
});

it("refuses relay admission on a serve-only installation", async () => {
  const f = fixture(true);
  const device = await relayDevice(f);
  const link = await relayConnection(f);
  const admission = link.auth(device).catch((error: unknown) => error);
  expect(await bounded(link.serverError)).toBe("auth_failed");
  expect(await admission).toBeInstanceOf(Error);
  expect(link.frames.some((frame) => frame.type === FrameType.AUTH_OK)).toBe(false);
});

it("preserves every whitelisted security header and drops cookies and unrelated response headers", async () => {
  const f = fixture();
  const headers = {
    "content-security-policy": "sandbox; default-src 'none'",
    "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer", "set-cookie": "secret=value", "x-private": "private",
  };
  const link = await relayConnection(f, { dispatch: async () => new Response("body", { headers }) });
  await link.auth(await relayDevice(f));
  const response = await link.open("/api/document").response;
  for (const name of ["content-security-policy", "x-content-type-options", "cross-origin-resource-policy", "referrer-policy"]) {
    expect(response.headers.get(name)).toBe(new Headers(headers).get(name));
  }
  expect(response.headers.has("set-cookie")).toBe(false);
  expect(response.headers.has("x-private")).toBe(false);
  expect(await response.text()).toBe("body");
});

it("renders pages without an absolute page-media origin over the relay", async () => {
  const f = fixture();
  const path = join(f.stateDir, "page.html");
  const video = join(f.stateDir, "clip.mp4");
  writeFileSync(video, "");
  truncateSync(video, 9 * 1024 * 1024);
  writeFileSync(path, '<video src="clip.mp4" controls></video>');
  const link = await relayConnection(f);
  await link.auth(await relayDevice(f));
  const response = await link.open(fileTarget(path) + "&render=1").response;
  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toContain("media-src data: blob:");
  expect(response.headers.get("content-security-policy")).not.toContain(RELAY_ORIGIN);
  expect(await response.text()).not.toContain(RELAY_ORIGIN);
});

for (const invalid of [
  '{"device_id":"ID","method":"GET","target":"/api/health","target":"/api/preferences","headers":[],"body":"none"}',
  '{"device_id":"ID","method":"GET","target":"/api/health","headers":[["cookie","a\\r\\nb"]],"body":"none"}',
  '{"device_id":"ID","method":"GET","target":"/api/health","headers":[["cookie","LONG"]],"body":"none"}',
]) {
  it(`keeps syntax and size checks before filtering headers (${invalid.includes("LONG") ? "oversize" : invalid.includes("cookie") ? "CRLF" : "duplicate key"})`, async () => {
    const f = fixture();
    let calls = 0;
    const link = await relayConnection(f, { dispatch: async () => { calls++; return new Response(); } });
    const device = await relayDevice(f);
    await link.auth(device);
    const payload = new TextEncoder().encode(invalid.replace("ID", device.id).replace("LONG", "a".repeat(12289)));
    const bytes = new Uint8Array(8 + payload.length);
    bytes.set([1, FrameType.HTTP_OPEN, 0, 0, 0, 0, 0, 1]);
    bytes.set(payload, 8);
    await link.channel.send(bytes.buffer).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== "Secure channel closed") throw error;
    });
    expect(await bounded(link.serverError)).toBe("protocol_error");
    expect(calls).toBe(0);
  });
}
