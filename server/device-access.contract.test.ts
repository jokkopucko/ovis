import { expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLEAR_LEGACY_DEVICE_COOKIE, DEVICE_COOKIE, DEVICE_COOKIE_CLEARED } from "./auth.ts";
import { DeviceStore } from "./devices.ts";
import { handleRequest, type ServerContext } from "./dispatch.ts";
import { privateStateFs } from "./private-state.ts";
import { MachineRelay } from "./machine-relay.ts";
import { MachineManager } from "./machines.ts";
import { startFakePushService } from "./push.fake.ts";
import { createServer } from "./index.ts";
import { workspaceCreate, workspaceClose } from "./herdr/client.ts";
import type { DevicePairedEvent, DevicesRevokedAll, MachineEvent, ServerMessage } from "../shared/protocol.ts";

const guard = { "x-herdr-machine": "1", "content-type": "application/json" };

it("pairs a relay device, authenticates its key, and dispatches with the stored role", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-contract-"));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "configured", tailscaleOwner: null, machines: false, sidecar: false });
  try {
    const store = app.context.services.devices;
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
    const paired = store.pairRelay(store.startPairing().code, "Relay phone", publicKey);
    if (!paired) throw new Error("Expected relay enrollment");
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const signature = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey,
      Buffer.concat([Buffer.from("ovis-relay-auth/1"), nonce, Buffer.from("server-contract")]))).toString("base64url");
    for (const role of ["drive", "watch"] as const) {
      store.update(paired.device.id, { role });
      const device = await store.matchRelay(paired.device.id, nonce, signature, "server-contract");
      expect(device?.role).toBe(role);
      if (!device) throw new Error("Expected authenticated relay device");
      const ctx: ServerContext = { ...app.context, peer: { kind: "relay", device, sessionId: `session-${role}`, serverId: "0123456789abcdef0123456789abcdef", key: "" }, requestIP: () => null, timeout: () => {} };
      const health = await handleRequest(new Request("https://relay.ovis.invalid/api/health"), ctx);
      expect(health?.status).toBe(200);
      expect(await health?.json()).toMatchObject({ auth: { via: "relay", role }, security: { observed_ingress: "relay", pairing_gate: "closed" } });
      const listing = await handleRequest(new Request("https://relay.ovis.invalid/api/devices"), ctx);
      expect(await listing?.json()).toEqual({ devices: [expect.objectContaining({ id: device.id, role, current: true, via_relay: true })] });
      if (role === "watch") {
        const mutation = await handleRequest(new Request("https://relay.ovis.invalid/api/preferences", { method: "PUT", headers: guard, body: "{}" }), ctx);
        expect(mutation?.status).toBe(403);
        expect(await mutation?.json()).toMatchObject({ error: { code: "read_only" } });
      } else {
        const cookiePair = await handleRequest(new Request("https://relay.ovis.invalid/api/devices/pair", { method: "POST", headers: guard, body: "{}" }), ctx);
        expect(cookiePair?.status).toBe(403);
        expect(await cookiePair?.json()).toMatchObject({ error: { code: "device_key_required" } });
        expect(cookiePair?.headers.has("set-cookie")).toBe(false);
      }
    }
  } finally {
    app.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("never promotes forged relay headers or cookies on a real HTTP socket", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-forged-"));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "configured", tailscaleOwner: "owner@example.com", machines: false, sidecar: false });
  try {
    for (const headers of [
      new Headers({ "x-ovis-relay-peer": "1" }),
      new Headers({ "x-ovis-relay-peer": "1", "x-forwarded-for": "100.64.0.9", "tailscale-user-login": "another@example.com", cookie: "ovis_device=relay:0123456789abcdef" }),
    ]) {
      const health = await fetch(`http://127.0.0.1:${app.port}/api/health`, { headers });
      expect(await health.json()).toMatchObject({ auth: { authenticated: false, reason: "token_required" } });
      const access = await fetch(`http://127.0.0.1:${app.port}/api/access`, { headers });
      expect(access.status).toBe(401);
    }
  } finally {
    app.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("returns pairing_rate_limited on the eleventh HTTP code issue", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-issue-limit-"));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, machines: false, sidecar: false });
  try {
    for (let i = 0; i < 10; i++) {
      const response = await fetch(`http://127.0.0.1:${app.port}/api/devices/pair/start`, { method: "POST", headers: guard });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    const limited = await fetch(`http://127.0.0.1:${app.port}/api/devices/pair/start`, { method: "POST", headers: guard });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: "pairing_rate_limited" } });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  } finally {
    app.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

/** Fails every flush of a private state file, before its rename, until restored. */
function failFileSync() {
  return spyOn(privateStateFs, "fsyncSync").mockImplementation(() => { throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); });
}

async function connect(url: string, cookie: string) {
  // Bun supports handshake headers; lib.dom's browser constructor does not list them.
  const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: { cookie: string } }) => WebSocket;
  const socket = new RuntimeSocket(url, { headers: { cookie } });
  const messages: ServerMessage[] = [];
  socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return { socket, messages, closed };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for websocket output");
    await Bun.sleep(20);
  }
}

it("keeps the gate closed, and a device paired in the install's other state dir signed in, on a fresh state dir", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-access-"));
  // an update from a fresh 0.4.14 install starts on the old dir, while the phone was paired in the new one
  const [active, sibling] = [join(root, "herdr-web-ui"), join(root, "ovis")];
  for (const dir of [active, sibling]) mkdirSync(dir);
  const token = "7".repeat(64);
  const created = "2026-10-25T05:20:00.000Z";
  writeFileSync(join(sibling, "devices.json"), JSON.stringify({ gate_closed_at: created, devices: [{ id: "0123456789abcdef", label: "Phone", role: "drive", token_hash: createHash("sha256").update(token).digest("hex"), created_at: created, last_seen_at: null }] }));
  writeFileSync(join(sibling, "preferences.json"), JSON.stringify({ revision: 1, settings: { language: "en", sidebarRows: "two" } }));
  const server = createServer({ port: 0, stateDir: active, siblingStateDir: sibling, tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  // a request through a proxy on this PC stands for one from another device
  const remote = { "x-forwarded-for": "100.64.0.9" };
  try {
    expect((await fetch(`${base}/api/preferences`, { headers: remote })).status).toBe(401);
    const anonymous = await (await fetch(`${base}/api/health`, { headers: remote })).json() as { auth: unknown };
    expect(anonymous.auth).toMatchObject({ required: true, authenticated: false });
    const cookie = `${DEVICE_COOKIE}=${token}`;
    const paired = await (await fetch(`${base}/api/health`, { headers: { ...remote, cookie } })).json() as { auth: unknown };
    expect(paired.auth).toMatchObject({ authenticated: true, via: "device" });
    const preferences = await fetch(`${base}/api/preferences`, { headers: { ...remote, cookie } });
    expect(await preferences.json()).toMatchObject({ settings: { language: "en", sidebarRows: "two" } });
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

it("serves the state dir it merged into, even when the merge gave the old dir files of its own", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-access-"));
  // the old name holds only the bridge registry; the phone is paired in the new dir
  const [legacy, next] = [join(root, "herdr-web-ui"), join(root, "ovis")];
  mkdirSync(join(legacy, "bridges"), { recursive: true });
  writeFileSync(join(legacy, "bridges", "local.json"), "{}");
  mkdirSync(next);
  const token = "8".repeat(64);
  const created = "2026-10-25T05:20:00.000Z";
  writeFileSync(join(next, "devices.json"), JSON.stringify({ gate_closed_at: created, devices: [{ id: "0123456789abcdef", label: "Phone", role: "drive", token_hash: createHash("sha256").update(token).digest("hex"), created_at: created, last_seen_at: null }] }));
  const env = { XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"], OVIS_STATE_DIR: process.env["OVIS_STATE_DIR"] };
  process.env["XDG_CONFIG_HOME"] = root;
  delete process.env["OVIS_STATE_DIR"];
  // the copy of the registry for the old dir fails; its merge record does not, and gives it files of its own
  const rename = privateStateFs.renameSync;
  const failing = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
    if (to === join(legacy, "devices.json")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    rename(from, to);
  });
  let server: ReturnType<typeof createServer> | undefined;
  try {
    server = createServer({ port: 0, siblingStateDir: legacy, tailscaleOwner: null, machines: false });
    const base = `http://127.0.0.1:${server.port}`;
    const remote = { "x-forwarded-for": "100.64.0.9" };
    expect((await fetch(`${base}/api/preferences`, { headers: remote })).status).toBe(401);
    expect((await fetch(`${base}/api/preferences`, { headers: { ...remote, cookie: `${DEVICE_COOKIE}=${token}` } })).status).toBe(200);
  } finally {
    failing.mockRestore();
    server?.stop();
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
/** The next frame that satisfies `predicate`: subscribed before the frame is provoked, with a deadline instead of a poll. */
function nextMessage(socket: WebSocket, predicate: (message: ServerMessage) => boolean, label: string, ms = 5000): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener("message", onMessage); reject(new Error(`${label}: no such frame within ${ms} ms`)); }, ms);
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      resolve(message);
    };
    socket.addEventListener("message", onMessage);
  });
}

/**
 * An open machines event stream: its `events` are the JSON data lines as they arrive, `next`
 * resolves with the first event satisfying `predicate` (subscribed before it is provoked), and
 * `ended` resolves when the server closes the stream, or when the test aborts it.
 */
async function openEvents(base: string, headers: Record<string, string>, signal: AbortSignal) {
  const response = await fetch(`${base}/api/machines/events`, { headers, signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const events: MachineEvent[] = [];
  const listeners = new Set<(event: MachineEvent) => void>();
  let buffered = "";
  const ended = (async () => {
    const decoder = new TextDecoder();
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try { chunk = await reader.read(); }
      catch (error) { if (signal.aborted) return; throw error; }
      const { done, value } = chunk;
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      for (;;) {
        const end = buffered.indexOf("\n\n");
        if (end === -1) break;
        const block = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice("data: ".length)).join("\n");
        if (!data) continue;
        const event = JSON.parse(data) as MachineEvent;
        events.push(event);
        for (const listener of listeners) listener(event);
      }
    }
  })();
  const next = (predicate: (event: MachineEvent) => boolean, label: string, ms = 5000): Promise<MachineEvent> => {
    const already = events.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(listener); reject(new Error(`${label}: no such event within ${ms} ms`)); }, ms);
      const listener = (event: MachineEvent) => { if (!predicate(event)) return; clearTimeout(timer); listeners.delete(listener); resolve(event); };
      listeners.add(listener);
    });
  };
  // the browser's stream key, when the server gave it one with this stream (shared/protocol.ts, "Browser stream keys")
  const setCookies = response.headers.getSetCookie();
  return { events, next, ended, setCookies, cookie: setCookies[0]?.split(";")[0] ?? null };
}

for (const action of ["revoke", "role change"] as const) {
it(`keeps native WS and SSE open on rename until ${action}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-native-rename-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "", tailscaleOwner: null, sidecar: false });
  const base = `http://127.0.0.1:${server.port}`;
  const store = server.context.services.devices;
  const paired = store.pair(store.startPairing().code, "Phone", "drive");
  if (!paired) throw new Error("Expected pairing");
  store.match(paired.token);
  const cookie = `${DEVICE_COOKIE}=${paired.token}`;
  const abort = new AbortController();
  const client = await connect(`${base.replace("http:", "ws:")}/ws`, cookie);
  try {
    const events = await openEvents(base, { cookie }, abort.signal);
    await events.next((event) => event.type === "machines", "initial roster");
    const response = await fetch(`${base}/api/devices/${paired.device.id}`, {
      method: "PATCH", headers: guard, body: JSON.stringify({ label: "Renamed phone" }),
    });
    expect(response.status).toBe(200);
    await response.json();
    store.update(paired.device.id, { role: "drive" });
    const acknowledged = nextMessage(client.socket, (message) => message.type === "role-ack", "role after rename");
    client.socket.send(JSON.stringify({ type: "role", mode: "observe" }));
    expect(await acknowledged).toMatchObject({ mode: "observe" });
    const enrolled = events.next((event) => event.type === "device-paired", "enrollment after rename");
    store.pair(store.startPairing().code, "Other phone", "drive");
    await enrolled;
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    if (action === "revoke") store.revoke(paired.device.id);
    else store.update(paired.device.id, { role: "watch" });
    expect((await client.closed).code).toBe(1008);
    await events.ended;
  } finally {
    abort.abort();
    client.socket.close();
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
}

/** A browser's cookie jar: what each answer set, by cookie name, and the Cookie header its next request sends. */
function cookieJar() {
  const cookies = new Map<string, string>();
  return {
    take(setCookies: readonly string[]) {
      for (const line of setCookies) {
        const [pair] = line.split(";");
        const separator = pair!.indexOf("=");
        const name = pair!.slice(0, separator);
        if (/;\s*Max-Age=0\b/i.test(line)) cookies.delete(name);
        else cookies.set(name, pair!.slice(separator + 1));
      }
    },
    header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    names: () => [...cookies.keys()],
  };
}

it("revocation closes an active device's terminal and roster stream without disconnecting another device", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-access-"));
  const server = createServer({ port: 0, stateDir: root, token: "test-device-access", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  const admin = { ...guard, authorization: "Bearer test-device-access" };
  const sockets: WebSocket[] = [];
  const abort = new AbortController();
  let workspaceId: string | undefined;
  try {
    const pair = async (label: string) => {
      const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: admin })).json() as { code: string };
      const response = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: guard, body: JSON.stringify({ code, label }) });
      expect(response.status).toBe(204);
      const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      expect((await fetch(`${base}/api/session`, { headers: { cookie } })).status).toBe(200);
      return cookie;
    };
    const cookieA = await pair("A");
    const cookieB = await pair("B");
    const { devices } = await (await fetch(`${base}/api/devices`, { headers: admin })).json() as { devices: { id: string; label: string }[] };
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-device-revocation" });
    workspaceId = created.workspace.workspace_id;
    const paneId = created.root_pane.pane_id;
    const a = await connect(`${base.replace("http:", "ws:")}/ws`, cookieA); sockets.push(a.socket);
    const b = await connect(`${base.replace("http:", "ws:")}/ws`, cookieB); sockets.push(b.socket);
    for (const client of [a, b]) {
      client.socket.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 80, rows: 24 }));
      await until(() => client.messages.some((message) => message.type === "pty-data"));
    }
    const events = await fetch(`${base}/api/machines/events`, { headers: { cookie: cookieA }, signal: abort.signal });
    const reader = events.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const ended = (async () => { while (!(await reader.read()).done) {} })();
    expect((await fetch(`${base}/api/devices/${devices.find((device) => device.label === "A")!.id}`, { method: "DELETE", headers: admin })).status).toBe(204);
    expect((await a.closed).code).toBe(1008);
    await ended;
    expect((await fetch(`${base}/api/session`, { headers: { cookie: cookieA } })).status).toBe(401);
    b.socket.send(JSON.stringify({ type: "role", mode: "observe" }));
    await until(() => b.messages.some((message) => message.type === "role-ack" && message.mode === "observe"));
    expect(b.socket.readyState).toBe(WebSocket.OPEN);
    expect((await fetch(`${base}/api/session`, { headers: { cookie: cookieB } })).status).toBe(200);
  } finally {
    abort.abort();
    for (const socket of sockets) socket.close();
    server.stop();
    if (workspaceId) await workspaceClose(workspaceId);
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

it("revoking every device closes each paired client's streams at once, voids every credential, and leaves the token, this PC and the Tailscale login in, also after a restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-revoke-all-"));
  const OWNER = "owner@example.com";
  // a device that only watches: issued through the store itself, since the pairing route pairs drivers only
  const seed = new DeviceStore(root);
  const watch = seed.pair(seed.startPairing().code, "Watch", "watch")!;
  seed.match(watch.token);
  const options = { port: 0, stateDir: root, token: "test-revoke-all", tailscaleOwner: OWNER } as const;
  let server = createServer(options);
  let base = `http://127.0.0.1:${server.port}`;
  const admin = { ...guard, authorization: "Bearer test-revoke-all" };
  const stranger = { "x-forwarded-for": "100.64.0.9" };
  const tailscale = { ...stranger, "tailscale-user-login": OWNER };
  const sockets: WebSocket[] = [];
  const abort = new AbortController();
  let workspaceId: string | undefined;
  try {
    const pair = async (label: string) => {
      const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: admin })).json() as { code: string };
      const response = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: { ...guard, ...stranger }, body: JSON.stringify({ code, label }) });
      expect(response.status).toBe(204);
      const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      expect((await fetch(`${base}/api/session`, { headers: { ...stranger, cookie } })).status).toBe(200);
      return cookie;
    };
    const cookieA = await pair("A");
    const cookieB = await pair("B");
    const watchCookie = `${DEVICE_COOKIE}=${watch.token}`;
    // A's and the owner's streams are open before C is enrolled: both hear of it, once, as one event
    const streamA = await openEvents(base, { ...stranger, cookie: cookieA }, abort.signal);
    const owner = await openEvents(base, { authorization: "Bearer test-revoke-all" }, abort.signal);
    const isPairing = (label: string) => (event: MachineEvent): event is DevicePairedEvent => event.type === "device-paired" && event.label === label;
    const heardByA = streamA.next(isPairing("C"), "A hears of C");
    const heardByOwner = owner.next(isPairing("C"), "the owner hears of C");
    const cookieC = await pair("C");
    const [toldA, toldOwner] = await Promise.all([heardByA, heardByOwner]) as [DevicePairedEvent, DevicePairedEvent];
    expect(toldA).toEqual({ type: "device-paired", event_id: expect.stringMatching(/^[0-9a-f]{16}$/), device_id: expect.stringMatching(/^[0-9a-f]{16}$/), label: "C", enrolled_at: expect.any(String) });
    expect(toldOwner).toEqual(toldA);
    // C's own stream, opened after its enrollment, hears nothing of itself; a later enrollment (D) reaches A, the owner and C
    const streamC = await openEvents(base, { ...stranger, cookie: cookieC }, abort.signal);
    const heardD = [streamA, owner, streamC].map((stream) => stream.next(isPairing("D"), "hears of D"));
    const cookieD = await pair("D");
    const toldD = await Promise.all(heardD);
    expect(toldD.every((event) => event.type === "device-paired" && event.event_id === (toldD[0] as DevicePairedEvent).event_id)).toBe(true);
    expect(streamC.events.filter((event) => event.type === "device-paired").map((event) => (event as DevicePairedEvent).label)).toEqual(["D"]);
    expect(streamA.events.filter((event) => event.type === "device-paired").map((event) => (event as DevicePairedEvent).label)).toEqual(["C", "D"]);
    const { devices } = await (await fetch(`${base}/api/devices`, { headers: admin })).json() as { devices: { id: string; label: string }[] };
    expect(devices.map((device) => device.label).sort()).toEqual(["A", "B", "C", "D", "Watch"]);

    // live terminals for A (local) and B, and page media A's render was given
    const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-device-revoke-all" });
    workspaceId = created.workspace.workspace_id;
    const paneId = created.root_pane.pane_id;
    const a = await connect(`${base.replace("http:", "ws:")}/ws`, cookieA); sockets.push(a.socket);
    const b = await connect(`${base.replace("http:", "ws:")}/ws`, cookieB); sockets.push(b.socket);
    for (const client of [a, b]) {
      const output = nextMessage(client.socket, (message) => message.type === "pty-data", "terminal output");
      client.socket.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 80, rows: 24 }));
      await output;
    }

    // the refusals: no mutation guard, another origin, a watching device, a misspelled route
    const revokeAll = (headers: Record<string, string>, method = "POST") => fetch(`${base}/api/devices/revoke-all`, { method, headers });
    expect((await revokeAll({ authorization: "Bearer test-revoke-all" })).status).toBe(403);
    expect((await revokeAll({ ...admin, origin: "https://elsewhere.example" })).status).toBe(403);
    const watched = await revokeAll({ ...guard, ...stranger, cookie: watchCookie });
    expect([watched.status, ((await watched.json()) as { error: { code: string } }).error.code]).toEqual([403, "read_only"]);
    expect((await fetch(`${base}/api/devices/revoke-all/`, { method: "POST", headers: admin })).status).toBe(404);
    expect((await fetch(`${base}/api/devices//revoke-all`, { method: "POST", headers: admin })).status).toBe(404);
    expect((await revokeAll(admin, "GET")).status).toBe(400);
    // nothing above changed anything: every stream is still open and every credential still works
    expect(a.socket.readyState).toBe(WebSocket.OPEN);
    for (const cookie of [cookieA, cookieB, cookieC, cookieD, watchCookie]) expect((await fetch(`${base}/api/session`, { headers: { ...stranger, cookie } })).status).toBe(200);

    // the revocation, from a paired device that can drive: everything paired goes, its own pairing included
    const closures = Promise.all([a.closed, b.closed, streamA.ended, streamC.ended]);
    const revoked = await revokeAll({ ...guard, ...stranger, cookie: cookieD });
    expect(revoked.status).toBe(200);
    expect((await revoked.json()) as DevicesRevokedAll).toEqual({ revoked: 5 });
    expect(revoked.headers.getSetCookie()).toEqual([DEVICE_COOKIE_CLEARED, CLEAR_LEGACY_DEVICE_COOKIE]);
    const [closedA, closedB] = await closures;
    expect([closedA.code, closedB.code]).toEqual([1008, 1008]);
    for (const cookie of [cookieA, cookieB, cookieC, cookieD, watchCookie]) expect((await fetch(`${base}/api/session`, { headers: { ...stranger, cookie } })).status).toBe(401);
    expect((await (await fetch(`${base}/api/devices`, { headers: admin })).json() as { devices: unknown[] }).devices).toEqual([]);
    const registry = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { gate_closed_at: string | null; devices: unknown[] };
    expect(registry).toEqual({ gate_closed_at: expect.any(String), devices: [] });
    // the owner's stream and the token are untouched, and the policy for the rest is what it was: with a token
    // configured, this PC itself and the PC's Tailscale login are asked for it (token_required), a stranger too
    expect(owner.events.length).toBeGreaterThan(0);
    expect((await fetch(`${base}/api/session`, { headers: { authorization: "Bearer test-revoke-all" } })).status).toBe(200);
    const authOf = async (headers: Record<string, string>) => ((await (await fetch(`${base}/api/health?scope=bridge`, { headers })).json()) as { auth: { authenticated: boolean; reason?: string } }).auth;
    expect(await authOf({})).toMatchObject({ authenticated: false, reason: "token_required" });
    expect(await authOf(tailscale)).toMatchObject({ authenticated: false, reason: "token_required" });
    expect(await authOf(stranger)).toMatchObject({ authenticated: false, reason: "token_required" });
    expect(await authOf({ ...stranger, cookie: cookieA })).toMatchObject({ authenticated: false });
    // a late socket with a revoked cookie is refused at the upgrade, as the gate is closed to it
    expect((await fetch(`${base}/ws`, { headers: { ...stranger, cookie: cookieA } })).status).toBe(401);

    // after a restart the gate is still closed and every old credential still void; pairing anew works
    abort.abort();
    await owner.ended;
    server.stop();
    server = createServer(options);
    base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/api/session`, { headers: stranger })).status).toBe(401);
    for (const cookie of [cookieA, cookieD, watchCookie]) expect((await fetch(`${base}/api/session`, { headers: { ...stranger, cookie } })).status).toBe(401);
    expect((await fetch(`${base}/api/session`, { headers: { authorization: "Bearer test-revoke-all" } })).status).toBe(200);
    expect((await fetch(`${base}/api/session`, { headers: { ...tailscale, authorization: "Bearer test-revoke-all" } })).status).toBe(200);
    const cookieE = await pair("E");
    expect((await fetch(`${base}/api/session`, { headers: { ...stranger, cookie: cookieE } })).status).toBe(200);
  } finally {
    abort.abort();
    for (const socket of sockets) socket.close();
    server.stop();
    if (workspaceId) await workspaceClose(workspaceId);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

it("revoking every device closes relayed remote terminals through /ws?machine_id=, and one whose upgrade is still pending is never left open", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-revoke-all-relay-"));
  // the other PC: a fictional bridge that accepts the relay's bearer token, and can hold one upgrade until let go
  const opened: unknown[] = [];
  const upgrades: Request[] = [];
  const watchers = new Set<() => void>();
  let closedUpstreams = 0;
  let hold: { reached: () => void; released: Promise<void> } | null = null;
  const changed = () => { for (const watcher of watchers) watcher(); };
  const within = (check: () => boolean, label: string, ms = 5000): Promise<void> => check() ? Promise.resolve() : new Promise((resolve, reject) => {
    const timer = setTimeout(() => { watchers.delete(watcher); reject(new Error(`${label}: not within ${ms} ms`)); }, ms);
    const watcher = () => { if (!check()) return; clearTimeout(timer); watchers.delete(watcher); resolve(); };
    watchers.add(watcher);
  });
  const upstream = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(request, instance) {
      if (request.headers.get("authorization") !== "Bearer fictional-remote") return new Response(null, { status: 401 });
      upgrades.push(request);
      const held = hold;
      if (held) { held.reached(); await held.released; }
      if (instance.upgrade(request)) return;
      return new Response(null, { status: 426 });
    },
    websocket: { open(ws) { opened.push(ws); changed(); }, message() {}, close() { closedUpstreams += 1; changed(); } },
  });
  const endpoint = spyOn(MachineManager.prototype, "endpoint").mockImplementation((id) =>
    id === "fictional-remote" ? { url: `http://127.0.0.1:${upstream.port}`, token: "fictional-remote" } : undefined);
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "test-revoke-all-relay", tailscaleOwner: null, sidecar: false });
  const base = `http://127.0.0.1:${server.port}`;
  const admin = { ...guard, authorization: "Bearer test-revoke-all-relay" };
  const stranger = { "x-forwarded-for": "100.64.0.9" };
  const relayed = `${base.replace("http:", "ws:")}/ws?machine_id=fictional-remote`;
  const sockets: WebSocket[] = [];
  try {
    const pair = async (label: string) => {
      const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: admin })).json() as { code: string };
      const response = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: { ...guard, ...stranger }, body: JSON.stringify({ code, label }) });
      expect(response.status).toBe(204);
      const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      expect((await fetch(`${base}/api/session`, { headers: { ...stranger, cookie } })).status).toBe(200);
      return cookie;
    };
    const cookieA = await pair("A");
    const cookieB = await pair("B");
    // A's terminal on the other PC, relayed and open
    const a = await connect(relayed, cookieA); sockets.push(a.socket);
    await within(() => opened.length === 1, "A's relay reached the other PC");

    // B's upgrade is authenticated, and waits while the relay dials the other PC
    let reached!: () => void;
    let release!: () => void;
    const reachedRemote = new Promise<void>((resolve) => { reached = resolve; });
    hold = { reached, released: new Promise<void>((resolve) => { release = resolve; }) };
    const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: { cookie: string } }) => WebSocket;
    const b = new RuntimeSocket(relayed, { headers: { cookie: cookieB } }); sockets.push(b);
    const bMessages: string[] = [];
    b.addEventListener("message", (event) => bMessages.push(String(event.data)));
    const bClosed = new Promise<CloseEvent>((resolve) => b.addEventListener("close", resolve, { once: true }));
    await reachedRemote;
    hold = null;

    // every device goes while B's upgrade is still pending
    const revoked = await fetch(`${base}/api/devices/revoke-all`, { method: "POST", headers: admin });
    expect(revoked.status).toBe(200);
    expect((await revoked.json()) as DevicesRevokedAll).toEqual({ revoked: 2 });
    // the open relayed terminal ends at once, its connection to the other PC with it
    expect((await a.closed).code).toBe(1008);
    await within(() => closedUpstreams >= 1, "A's connection to the other PC closed");

    // the pending upgrade completes only now; its device is gone, so it is ended at admission, with its relay
    release();
    const closedB = await Promise.race([bClosed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("B's late relayed socket was left open")), 5000))]);
    expect(closedB.code).toBe(1008);
    await within(() => opened.length === 2 && closedUpstreams === 2, "B's connection to the other PC closed");
    expect(bMessages.filter((raw) => (JSON.parse(raw) as { type?: string }).type !== "error")).toEqual([]);

    // a later relayed upgrade with a revoked cookie is refused before the other PC is dialled
    const dialled = upgrades.length;
    for (const cookie of [cookieA, cookieB]) {
      expect((await fetch(`${base}/ws?machine_id=fictional-remote`, { headers: { ...stranger, cookie } })).status).toBe(401);
    }
    expect(upgrades.length).toBe(dialled);
  } finally {
    for (const socket of sockets) socket.close();
    server.stop();
    upstream.stop(true);
    endpoint.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

it("a revocation of every device that cannot be persisted changes nothing, and once it can, every credential issued before is void", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-revoke-all-write-"));
  const options = { port: 0, stateDir: root, token: "", tailscaleOwner: null } as const;
  let server = createServer(options);
  let base = `http://127.0.0.1:${server.port}`;
  const forwarded = { "x-forwarded-for": "198.51.100.24" };
  const abort = new AbortController();
  const start = async () => (await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: guard })).json() as { code: string }).code;
  const issue = async (code: string) => {
    const response = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: { ...guard, ...forwarded }, body: JSON.stringify({ code }) });
    expect(response.status).toBe(204);
    return response.headers.get("set-cookie")!.split(";")[0]!;
  };
  const session = (headers: Record<string, string>) => fetch(`${base}/api/session`, { headers });
  const revokeAll = () => fetch(`${base}/api/devices/revoke-all`, { method: "POST", headers: guard });
  let failing: ReturnType<typeof failFileSync> | undefined;
  try {
    const owner = await openEvents(base, {}, abort.signal);
    const pairings = () => owner.events.filter((event) => event.type === "device-paired") as DevicePairedEvent[];
    // nothing paired yet: a credential issued now is unconfirmed, a code is pending, and the gate is open
    const candidate = await issue(await start());
    const pendingCode = await start();
    expect((await session(forwarded)).status).toBe(200);
    failing = failFileSync();
    const failed = await revokeAll();
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: { code: "internal_error" } });
    // nothing changed: the gate is still open, no registry was written, and a confirmation that cannot be written is refused too
    expect((await session(forwarded)).status).toBe(200);
    expect(() => readFileSync(join(root, "devices.json"), "utf8")).toThrow();
    expect((await session({ ...forwarded, cookie: candidate })).status).toBe(500);
    failing.mockRestore();
    // once writes work: the pending code still pairs, the candidate still confirms, and that confirmation is the one enrollment heard
    const told = owner.next((event) => event.type === "device-paired", "the owner hears of the confirmed device");
    const sibling = await issue(pendingCode);
    expect((await session({ ...forwarded, cookie: candidate })).status).toBe(200);
    expect(((await told) as DevicePairedEvent).device_id).toMatch(/^[0-9a-f]{16}$/);
    expect(pairings()).toHaveLength(1);
    // a sibling candidate is stale once a first cookie closed the gate (the rule from before this route)
    expect((await session({ ...forwarded, cookie: sibling })).status).toBe(401);
    // gated now, with one device and a fresh pending code: the write succeeds, and everything issued before it is void
    const staleCode = await start();
    const revoked = await revokeAll();
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: 1 });
    expect((await session({ ...forwarded, cookie: candidate })).status).toBe(401);
    const stale = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: { ...guard, ...forwarded }, body: JSON.stringify({ code: staleCode }) });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toMatchObject({ error: { code: "invalid_code" } });
    expect((await session(forwarded)).status).toBe(401);
    // revoking announces nothing, and the owner's stream is still the owner's
    expect(pairings()).toHaveLength(1);
    expect((await session({})).status).toBe(200);
    // the registry on disk says gated with nothing in it, and a restart agrees
    abort.abort();
    await owner.ended;
    server.stop();
    server = createServer(options);
    base = `http://127.0.0.1:${server.port}`;
    expect(JSON.parse(readFileSync(join(root, "devices.json"), "utf8"))).toEqual({ gate_closed_at: expect.any(String), devices: [] });
    expect((await session(forwarded)).status).toBe(401);
    expect((await session({ ...forwarded, cookie: candidate })).status).toBe(401);
    expect((await session({})).status).toBe(200);
  } finally {
    abort.abort();
    failing?.mockRestore();
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

it("a corrupt device registry refuses strangers while keeping local recovery and the original file", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-recovery-"));
  const path = join(root, "devices.json");
  writeFileSync(path, "{broken registry");
  const server = createServer({ port: 0, stateDir: root, token: "", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    expect((await fetch(`${base}/api/session`, { headers: { "x-forwarded-for": "192.0.2.1" } })).status).toBe(401);
    expect((await fetch(`${base}/api/session`)).status).toBe(200);
    const response = await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: guard });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "device_store_unavailable" } });
    expect(readFileSync(path, "utf8")).toBe("{broken registry");
  } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
});

it("keeps a forwarded first-pair gate open until a returned cookie is durably confirmed", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-first-pair-proxy-"));
  const options = { port: 0, stateDir: root, token: "", tailscaleOwner: null, machines: false } as const;
  let server = createServer(options);
  let base = `http://127.0.0.1:${server.port}`;
  const forwarded = { "x-forwarded-for": "198.51.100.24" };
  const start = async () => {
    const response = await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: { origin: base, "x-herdr-machine": "1", ...forwarded } });
    expect(response.status).toBe(200);
    return (await response.json() as { code: string }).code;
  };
  const issue = async (code: string) => {
    const response = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: { origin: base, "x-herdr-machine": "1", "content-type": "application/json", ...forwarded }, body: JSON.stringify({ code }) });
    expect(response.status).toBe(204);
    return response.headers.get("set-cookie")!.split(";")[0]!;
  };
  const stranger = () => fetch(`${base}/api/devices`, { headers: forwarded });
  try {
    const droppedCookie = await issue(await start());
    expect((await stranger()).status).toBe(200);
    expect((await (await fetch(`${base}/api/devices`, { headers: forwarded })).json()).devices).toEqual([]);
    expect(() => readFileSync(join(root, "devices.json"), "utf8")).toThrow();

    // A lost cookie can be retried through the proxy; issuing another cookie still does
    // not close the gate until one of them returns in a later request.
    const retryCookie = await issue(await start());
    expect((await stranger()).status).toBe(200);
    expect(retryCookie).not.toBe(droppedCookie);
    server.stop();

    // No first-pair candidate or gate survives a restart before confirmation.
    server = createServer(options);
    base = `http://127.0.0.1:${server.port}`;
    expect((await stranger()).status).toBe(200);
    const confirmedCookie = await issue(await start());
    expect((await stranger()).status).toBe(200);
    const fsync = failFileSync();
    try {
      const failed = await fetch(`${base}/api/devices`, { headers: { ...forwarded, cookie: confirmedCookie } });
      expect(failed.status).toBe(500);
      expect(failed.headers.get("content-type")).toContain("application/json");
      expect(await failed.json()).toMatchObject({ error: { code: "internal_error" } });
      expect((await stranger()).status).toBe(200);
      expect(() => readFileSync(join(root, "devices.json"), "utf8")).toThrow();
    } finally { fsync.mockRestore(); }
    expect((await fetch(`${base}/api/devices`, { headers: { ...forwarded, cookie: confirmedCookie } })).status).toBe(200);
    expect((await stranger()).status).toBe(401);
    const registry = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { gate_closed_at: string | null; devices: unknown[] };
    expect(registry.gate_closed_at).not.toBeNull();
    expect(registry.devices).toHaveLength(1);
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

it("never tells a browser of the device it paired itself, on any stream or push subscription it had before, even from tabs that opened at once", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-self-pair-"));
  const server = createServer({ port: 0, stateDir: root, token: "test-self-pair", tailscaleOwner: null, pushLoopbackHttp: true });
  const base = `http://127.0.0.1:${server.port}`;
  const bearer = { authorization: "Bearer test-self-pair" };
  const abort = new AbortController();
  const selfPush = await startFakePushService();
  const otherPush = await startFakePushService();
  const isPairing = (label: string) => (event: MachineEvent): event is DevicePairedEvent => event.type === "device-paired" && event.label === label;
  const pairedLabels = (stream: { events: MachineEvent[] }) => stream.events.filter((event) => event.type === "device-paired").map((event) => (event as DevicePairedEvent).label);
  const pushed = (label: string) => (push: { payload: { body: string } }) => push.payload.body === `New device paired: ${label}`;
  const issued = /^ovis_stream_([0-9a-f]{32})=1; Path=\/; HttpOnly; SameSite=Strict; Max-Age=31536000$/;
  // "Pair this device" from a signed-in browser: a code, then the pairing from that same browser
  const selfPair = async (jar: ReturnType<typeof cookieJar>, label: string) => {
    const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: { ...guard, ...bearer, cookie: jar.header() } })).json() as { code: string };
    const response = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: { ...guard, ...bearer, cookie: jar.header() }, body: JSON.stringify({ code, label }) });
    expect(response.status).toBe(204);
    jar.take(response.headers.getSetCookie());
  };
  // a device paired by someone else, from a browser of its own that holds no key
  const otherPair = async (label: string) => {
    const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: { ...guard, ...bearer } })).json() as { code: string };
    expect((await fetch(`${base}/api/devices/pair`, { method: "POST", headers: guard, body: JSON.stringify({ code, label }) })).status).toBe(204);
  };
  const subscribe = (subscription: unknown, cookie: string) => fetch(`${base}/api/push/subscribe`, { method: "POST", headers: { ...guard, ...bearer, cookie }, body: JSON.stringify({ subscription }) });
  try {
    // two tabs of one browser open at once, before it holds any key: each answer issues a key in a cookie of its own name
    const browser = cookieJar();
    const [tab, otherTab] = await Promise.all([openEvents(base, bearer, abort.signal), openEvents(base, bearer, abort.signal)]);
    for (const stream of [tab, otherTab]) {
      expect(stream.setCookies).toHaveLength(1);
      expect(stream.setCookies[0]).toMatch(issued);
    }
    expect(tab.setCookies[0]!.match(issued)![1]).not.toBe(otherTab.setCookies[0]!.match(issued)![1]);
    // the browser keeps both, since neither overwrites the other, and sends both from now on
    browser.take([...tab.setCookies, ...otherTab.setCookies]);
    expect(browser.names()).toHaveLength(2);
    // a third tab carries the keys: nothing new is issued, and it is the same browser
    const thirdTab = await openEvents(base, { ...bearer, cookie: browser.header() }, abort.signal);
    expect(thirdTab.setCookies).toEqual([]);
    // this browser's alerts were on before it paired anything (a token sign-in: no owner); the answer issues nothing new
    const ownSubscription = await subscribe(selfPush.subscription, browser.header());
    expect(ownSubscription.status).toBe(204);
    expect(ownSubscription.headers.getSetCookie()).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, "push-subscriptions.json"), "utf8"))[0]).toMatchObject({ device_id: null, browser_keys: expect.arrayContaining(browser.names().map((name) => name.slice("ovis_stream_".length))) });

    // another browser signed in with the same token: its push subscription comes first, and that answer gives it its key
    const other = cookieJar();
    const otherSubscription = await subscribe(otherPush.subscription, "");
    expect(otherSubscription.status).toBe(204);
    expect(otherSubscription.headers.getSetCookie()[0]).toMatch(issued);
    other.take(otherSubscription.headers.getSetCookie());
    const owner = await openEvents(base, { ...bearer, cookie: other.header() }, abort.signal);
    expect(owner.setCookies).toEqual([]);
    // a key cookie that is malformed is no key: the stream is served, not refused, and given a real one (a browser of its own)
    const malformed = await openEvents(base, { ...bearer, cookie: `ovis_stream_${"A".repeat(32)}=1; ovis_stream_${"a".repeat(32)}=0; ovis_stream=${"a".repeat(32)}` }, abort.signal);
    expect(malformed.setCookies).toHaveLength(1);
    expect(malformed.setCookies[0]).toMatch(issued);

    // the store is not gated yet: the pairing issues a first-pair cookie, and its first return enrolls it
    const heardSelf = [owner, malformed].map((stream) => stream.next(isPairing("Self"), "another browser hears of Self"));
    const pushedSelf = otherPush.waitFor(pushed("Self"), "the other browser is pushed Self", 5000);
    await selfPair(browser, "Self");
    expect((await fetch(`${base}/api/devices`, { headers: { cookie: browser.header() } })).status).toBe(200);
    const self = (await Promise.all(heardSelf))[0] as DevicePairedEvent;
    await pushedSelf;
    // a key grants nothing: from another address, the browser's keys alone are refused like no cookie at all
    const keysOnly = browser.header().split("; ").filter((pair) => pair.startsWith("ovis_stream_")).join("; ");
    expect(keysOnly.split("; ")).toHaveLength(2);
    expect((await fetch(`${base}/api/machines/events`, { headers: { cookie: keysOnly, "x-forwarded-for": "192.0.2.1" } })).status).toBe(401);
    // a later enrollment by someone else reaches every tab and both subscriptions; a stream is ordered,
    // so had Self reached a tab it came first, and Self's push went out before this one was asked for
    const tabs = [tab, otherTab, thirdTab];
    const heardBarrier = [...tabs, owner, malformed].map((stream) => stream.next(isPairing("Barrier"), "hears of Barrier"));
    const pushedBarrier = [selfPush, otherPush].map((fake) => fake.waitFor(pushed("Barrier"), "pushed Barrier", 5000));
    await otherPair("Barrier");
    await Promise.all([...heardBarrier, ...pushedBarrier]);
    for (const stream of tabs) expect(pairedLabels(stream)).toEqual(["Barrier"]);
    expect(pairedLabels(owner)).toEqual(["Self", "Barrier"]);
    expect(pairedLabels(malformed)).toEqual(["Self", "Barrier"]);
    expect(selfPush.received.map((push) => push.payload.body)).toEqual(["New device paired: Barrier"]);
    // the event the other browser heard was this browser's own enrollment
    const { devices } = await (await fetch(`${base}/api/devices`, { headers: bearer })).json() as { devices: { id: string; label: string }[] };
    expect(devices.find((entry) => entry.label === "Self")?.id).toBe(self.device_id);

    // the gate is closed now: the same browser, holding its device cookie, pairs again and is enrolled at once;
    // none of its tabs or its subscription hears of it, the other browser does
    const heardAgain = owner.next(isPairing("Again"), "the other browser hears of Again");
    const pushedAgain = otherPush.waitFor(pushed("Again"), "the other browser is pushed Again", 5000);
    await selfPair(browser, "Again");
    await Promise.all([heardAgain, pushedAgain]);
    const heardLast = [...tabs, owner].map((stream) => stream.next(isPairing("Last"), "hears of Last"));
    const pushedLast = selfPush.waitFor(pushed("Last"), "pushed Last", 5000);
    await otherPair("Last");
    await Promise.all([...heardLast, pushedLast]);
    for (const stream of tabs) expect(pairedLabels(stream)).toEqual(["Barrier", "Last"]);
    expect(selfPush.received.map((push) => push.payload.body)).toEqual(["New device paired: Barrier", "New device paired: Last"]);
  } finally {
    abort.abort();
    selfPush.stop();
    otherPush.stop();
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

it("watch credentials cannot mutate HTTP state, read credential files, or elevate local and relayed terminals", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-watch-access-"));
  const store = new DeviceStore(root);
  const watch = store.pair(store.startPairing().code, "Watch", "watch")!;
  store.match(watch.token);
  const server = createServer({ port: 0, stateDir: root, token: "test-watch", tailscaleOwner: null, machines: false });
  const base = `http://127.0.0.1:${server.port}`;
  const cookie = `ovis_device=${watch.token}`;
  const headers = { ...guard, cookie };
  const sockets: WebSocket[] = [];
  const relays: MachineRelay[] = [];
  const manager = { endpoint: () => ({ url: base, token: "test-watch" }), trackTerminal: () => () => {} } as unknown as MachineManager;
  const proxy = Bun.serve<{ relay: MachineRelay }>({ port: 0, hostname: "127.0.0.1", async fetch(request, instance) {
    const relay = new MachineRelay(manager, "remote", true, (snapshot) => snapshot); relays.push(relay);
    await relay.ready;
    if (instance.upgrade(request, { data: { relay } })) return;
    relay.close(); return new Response(null, { status: 426 });
  }, websocket: { open(ws) { ws.data.relay.bind(ws); }, message(ws, raw) { ws.data.relay.message(raw); }, close(ws) { ws.data.relay.close(); } } });
  try {
    expect((await fetch(`${base}/api/session`, { headers })).status).toBe(200);
    for (const path of ["pane/input", "workspace/create", "tab/create", "tab/rename", "tab/close", "machines/setup", "updates/install", "herdr/update", "portal/start", "portal/stop", "portal/invite"]) {
      expect((await fetch(`${base}/api/${path}`, { method: "POST", headers, body: "{}" })).status).toBe(403);
    }
    // the shared settings: a watching device reads them, and cannot change them for every browser
    expect((await fetch(`${base}/api/preferences`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/api/preferences`, { method: "PUT", headers, body: JSON.stringify({ settings: { theme: "light" }, pins: [] }) })).status).toBe(403);
    // herdr's copy_on_select: a watching device selects text too, so it reads it (#1559)
    expect((await fetch(`${base}/api/herdr-ui`, { headers })).status).toBe(200);
    // what was read in the other browsers: a watching device sees it, and its own views stay its own
    expect((await fetch(`${base}/api/seen`, { headers })).status).toBe(200);
    const told = await fetch(`${base}/api/seen`, { method: "POST", headers, body: JSON.stringify({ pc: "local", epoch: "e", pane: "p", id: 1 }) });
    expect(told.status).toBe(403);
    expect(await told.json()).toMatchObject({ error: { code: "read_only" } });
    expect((await fetch(`${base}/api/fs/file?path=${encodeURIComponent(join(root, "devices.json"))}`, { headers })).status).toBe(403);
    // a PC's file is read without the origin check (#448, Android's Open button): the watch refusal still comes first, for GET and HEAD alike
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(`${base}/api/machines/pc1/fs/file?path=%2Fetc%2Fhostname`, { method, headers: { ...headers, "sec-fetch-site": "cross-site" } });
      expect(response.status).toBe(403);
      if (method === "GET") expect(await response.json()).toMatchObject({ error: { code: "read_only" } });
    }
    // a repository's changes are file contents: refused like a file read, on this PC and through a PC's route
    for (const path of ["workspace/diff/files", "workspace/diff/file", "workspace/diff/refs", "machines/pc1/workspace/diff/files", "machines/pc1/workspace/diff/file", "machines/pc1/workspace/diff/refs", "machines/local/workspace/diff/file"]) {
      const response = await fetch(`${base}/api/${path}?directory=${encodeURIComponent(root)}&path=devices.json`, { headers });
      expect([path, response.status]).toEqual([path, 403]);
      expect(await response.json()).toMatchObject({ error: { code: "read_only" } });
    }
    for (const path of ["api//workspace/diff/file", "api/workspace//diff/file", "api/machines/pc1//workspace/diff/file"]) {
      expect((await fetch(`${base}/${path}?directory=${encodeURIComponent(root)}&path=devices.json`, { headers })).status).toBe(404);
    }
    // an empty segment must not turn a file read into "some other route" (the PC proxy drops it)
    for (const path of ["api//fs/file", "api/machines/pc1//fs/file", "api/machines/pc1/fs//file"]) {
      expect((await fetch(`${base}/${path}?path=${encodeURIComponent(join(root, "devices.json"))}`, { headers })).status).toBe(404);
    }
    for (const origin of [base, `http://127.0.0.1:${proxy.port}`]) {
      const client = await connect(`${origin.replace("http:", "ws:")}/ws`, cookie); sockets.push(client.socket);
      client.socket.send(JSON.stringify({ type: "role", mode: "interact" }));
      await until(() => client.messages.some((m) => m.type === "role-ack" && m.mode === "observe"));
      for (const frame of [{ type: "input", text: "must not type" }, { type: "keys", keys: ["Enter"] }, { type: "resize", cols: 40, rows: 10 }]) {
        const before = client.messages.filter((m) => m.type === "error").length;
        client.socket.send(JSON.stringify({ ...frame, pane_id: "absent" }));
        await until(() => client.messages.filter((m) => m.type === "error").length > before);
        expect(client.messages.filter((m) => m.type === "error").at(-1)).toMatchObject({ code: "read_only" });
      }
      client.socket.send(JSON.stringify({ type: "submit", id: 1, pane_id: "absent", text: "no", payload: "no" }));
      await until(() => client.messages.some((m) => m.type === "submit-result"));
      expect(client.messages.find((m) => m.type === "submit-result")).toMatchObject({ ok: false, code: "read_only" });
    }
  } finally {
    for (const socket of sockets) socket.close();
    for (const relay of relays) relay.close();
    proxy.stop(true); server.stop(); rmSync(root, { recursive: true, force: true });
  }
});

it("a route spelled with a trailing, doubled or encoded slash is no route, for a watching and a driving device alike", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-route-spelling-"));
  const store = new DeviceStore(root);
  const watch = store.pair(store.startPairing().code, "Watch", "watch")!;
  store.match(watch.token);
  const drive = store.pair(store.startPairing().code, "Drive", "drive")!;
  store.match(drive.token);
  const server = createServer({ port: 0, stateDir: root, token: "test-route-spelling", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  const query = "?workspace_id=w1&agent=pi";
  try {
    // the PC proxy drops empty segments before it forwards with the PC's own credential, so each
    // of these would reach the PC's history past the watch refusal if it were taken for a route
    const spellings = [
      "api/sessions/history/", "api/sessions//history", "api/sessions%2Fhistory", "api/sessions%2fhistory", "api/machines/local/sessions/history/",
      "api/machines/pc1/sessions/history/", "api/machines/pc1/sessions//history", "api/machines/pc1//sessions/history", "api/machines/pc1/sessions%2Fhistory",
      "api/machines/pc1/workspace/directories/", "api/machines/pc1/pane/commands/",
    ];
    for (const [label, token] of [["watch", watch.token], ["drive", drive.token]] as const) {
      const headers = { cookie: `ovis_device=${token}` };
      for (const path of spellings) {
        const response = await fetch(`${base}/${path}${query}`, { headers });
        expect([label, path, response.status]).toEqual([label, path, 404]);
      }
    }
    // the canonical spellings: refused to a watching device on this PC, its alias and another PC's route
    for (const path of ["api/sessions/history", "api/machines/local/sessions/history", "api/machines/pc1/sessions/history"]) {
      const response = await fetch(`${base}/${path}${query}`, { headers: { cookie: `ovis_device=${watch.token}` } });
      expect([path, response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([path, 403, "read_only"]);
    }
    // and answered for a driving one (no such workspace here; no such PC connected)
    const driving = { cookie: `ovis_device=${drive.token}` };
    const absent = await fetch(`${base}/api/sessions/history?workspace_id=ovis-test-absent&agent=pi`, { headers: driving });
    expect([absent.status, ((await absent.json()) as { error: { code: string } }).error.code]).toEqual([404, "workspace_not_found"]);
    expect((await fetch(`${base}/api/machines/pc1/sessions/history${query}`, { headers: driving })).status).toBe(503);
  } finally {
    server.stop(); rmSync(root, { recursive: true, force: true });
  }
});

it("a pane's command rows are refused to a watching device on this PC, its alias and another PC's route, as a folder's are, and answered for a driving one (#2132)", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-pane-commands-"));
  const store = new DeviceStore(root);
  const watch = store.pair(store.startPairing().code, "Watch", "watch")!;
  store.match(watch.token);
  const drive = store.pair(store.startPairing().code, "Drive", "drive")!;
  store.match(drive.token);
  const server = createServer({ port: 0, stateDir: root, token: "test-pane-commands", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  const query = "?pane_id=ovis-test-absent:p1";
  try {
    // a custom command's row carries its file's first line and its path: what a folder's command files hold
    for (const path of ["api/pane/commands", "api/machines/local/pane/commands", "api/machines/pc1/pane/commands"]) {
      const response = await fetch(`${base}/${path}${query}`, { headers: { cookie: `ovis_device=${watch.token}` } });
      expect([path, response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([path, 403, "read_only"]);
    }
    // a driving device reaches the route: this PC asks herdr for the pane, its alias too, and no such PC is connected
    const driving = { cookie: `ovis_device=${drive.token}` };
    for (const path of ["api/pane/commands", "api/machines/local/pane/commands"]) {
      const response = await fetch(`${base}/${path}${query}`, { headers: driving });
      expect([path, response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([path, 404, "pane_not_found"]);
    }
    expect((await fetch(`${base}/api/machines/pc1/pane/commands${query}`, { headers: driving })).status).toBe(503);
  } finally {
    server.stop(); rmSync(root, { recursive: true, force: true });
  }
});

it("the paths under a pane's folder and a plugin run's output are refused to a watching device on this PC, its alias and another PC's route, and answered for a driving one (#2244)", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-pane-files-"));
  const store = new DeviceStore(root);
  const watch = store.pair(store.startPairing().code, "Watch", "watch")!;
  store.match(watch.token);
  const drive = store.pair(store.startPairing().code, "Drive", "drive")!;
  store.match(drive.token);
  const server = createServer({ port: 0, stateDir: root, token: "test-pane-files", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  // the @-mention picker's paths, and where a plugin action's run stands (what its command printed when it failed)
  const routes = ["pane/files?pane_id=ovis-test-absent:p1&q=commands", "plugin/action?plugin_id=ovis-test-absent&log_id=plugin-log-1", "pane/docs?pane_id=ovis-test-absent:p1"];
  try {
    for (const route of routes) {
      for (const prefix of ["api", "api/machines/local", "api/machines/pc1"]) {
        const path = `${prefix}/${route}`;
        const response = await fetch(`${base}/${path}`, { headers: { cookie: `ovis_device=${watch.token}` } });
        expect([path, response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([path, 403, "read_only"]);
      }
    }
    // a driving device reaches the routes: this PC asks herdr, its alias too, and no such PC is connected
    const driving = { cookie: `ovis_device=${drive.token}` };
    for (const prefix of ["api", "api/machines/local"]) {
      for (const [route, code] of [[routes[0], "pane_not_found"], [routes[1], "plugin_log_not_found"], [routes[2], "pane_not_found"]] as const) {
        const response = await fetch(`${base}/${prefix}/${route}`, { headers: driving });
        expect([prefix, route, response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([prefix, route, 404, code]);
      }
    }
    for (const route of routes) expect((await fetch(`${base}/api/machines/pc1/${route}`, { headers: driving })).status).toBe(503);
  } finally {
    server.stop(); rmSync(root, { recursive: true, force: true });
  }
});

it("a repository's checkouts are refused to a watching device on this PC, its alias and another PC's route, and answered for a driving one (#2250)", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-worktree-list-"));
  const store = new DeviceStore(root);
  const watch = store.pair(store.startPairing().code, "Watch", "watch")!;
  store.match(watch.token);
  const drive = store.pair(store.startPairing().code, "Drive", "drive")!;
  store.match(drive.token);
  const server = createServer({ port: 0, stateDir: root, token: "test-worktree-list", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  // every checkout of the workspace's repository: paths and branches, those not open in herdr too;
  // the inventory answers the same for several workspaces at once (#2661)
  try {
    for (const route of ["worktree/list?workspace_id=ovis-test-absent", "worktree/inventory?workspace_id=ovis-test-absent"]) for (const prefix of ["api", "api/machines/local", "api/machines/pc1"]) {
      const path = `${prefix}/${route}`;
      const response = await fetch(`${base}/${path}`, { headers: { cookie: `ovis_device=${watch.token}` } });
      expect([path, response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([path, 403, "read_only"]);
    }
    // a driving device reaches the route: this PC asks herdr, its alias too, and no such PC is connected
    const driving = { cookie: `ovis_device=${drive.token}` };
    const route = "worktree/list?workspace_id=ovis-test-absent";
    for (const prefix of ["api", "api/machines/local"]) {
      const response = await fetch(`${base}/${prefix}/${route}`, { headers: driving });
      expect([prefix, response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([prefix, 404, "workspace_not_found"]);
      const inventory = await fetch(`${base}/${prefix}/worktree/inventory?workspace_id=ovis-test-absent`, { headers: driving });
      expect([prefix, inventory.status, ((await inventory.json()) as { entries: { error?: { code: string } }[] }).entries.map((entry) => entry.error?.code)]).toEqual([prefix, 200, ["workspace_not_found"]]);
    }
    for (const path of [route, "worktree/inventory?workspace_id=ovis-test-absent"]) expect((await fetch(`${base}/api/machines/pc1/${path}`, { headers: driving })).status).toBe(503);
  } finally {
    server.stop(); rmSync(root, { recursive: true, force: true });
  }
});

it("revoking a paired device removes its persistent push subscription", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-push-"));
  const server = createServer({ port: 0, stateDir: root, token: "test-push-owner", tailscaleOwner: null, machines: false, pushLoopbackHttp: true });
  const fake = await startFakePushService();
  const base = `http://127.0.0.1:${server.port}`;
  const admin = { ...guard, authorization: "Bearer test-push-owner" };
  try {
    const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: admin })).json() as { code: string };
    const paired = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: guard, body: JSON.stringify({ code }) });
    const cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
    const registered = await fetch(`${base}/api/push/subscribe`, { method: "POST", headers: { ...guard, cookie }, body: JSON.stringify({ subscription: fake.subscription }) });
    expect(registered.status).toBe(204);
    const { devices } = await (await fetch(`${base}/api/devices`, { headers: admin })).json() as { devices: { id: string }[] };
    const id = devices[0]!.id;
    expect(JSON.parse(readFileSync(join(root, "push-subscriptions.json"), "utf8"))[0].device_id).toBe(id);
    expect((await fetch(`${base}/api/devices/${id}`, { method: "DELETE", headers: admin })).status).toBe(204);
    expect((await fetch(`${base}/api/session`, { headers: { cookie } })).status).toBe(401);
    expect(JSON.parse(readFileSync(join(root, "push-subscriptions.json"), "utf8"))).toEqual([]);
    expect((await fetch(`${base}/api/push/test`, { method: "POST", headers: admin, body: JSON.stringify({ endpoint: fake.subscription.endpoint }) })).status).toBe(404);
  } finally { fake.stop(); server.stop(); rmSync(root, { recursive: true, force: true }); }
});

it("returns an error when revocation cannot be persisted, then allows a successful retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-write-"));
  const store = new DeviceStore(root);
  const paired = store.pair(store.startPairing().code, "Phone", "drive")!;
  store.match(paired.token);
  const server = createServer({ port: 0, stateDir: root, token: "test-write", tailscaleOwner: null, machines: false });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const revoke = () => fetch(`${base}/api/devices/${paired.device.id}`, { method: "DELETE", headers: { ...guard, authorization: "Bearer test-write" } });
    const fsync = failFileSync();
    try {
      const failed = await revoke();
      expect(failed.status).toBe(500);
      expect(await failed.json()).toMatchObject({ error: { code: "internal_error" } });
      expect(new DeviceStore(root).match(paired.token)).not.toBeNull();
    } finally { fsync.mockRestore(); }
    expect((await revoke()).status).toBe(204);
    expect(new DeviceStore(root).match(paired.token)).toBeNull();
  } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
});

it("never announces a pairing to a stream that came in through the open LAN: it ends with the gate, before any news", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-open-stream-"));
  const server = createServer({ port: 0, stateDir: root, token: "", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  const abort = new AbortController();
  // a request through a proxy on this PC stands for one from another device; with nothing paired it gets in through the open LAN
  const lan = { "x-forwarded-for": "100.64.0.9" };
  const isPairing = (label: string) => (event: MachineEvent): event is DevicePairedEvent => event.type === "device-paired" && event.label === label;
  const pairedLabels = (stream: { events: MachineEvent[] }) => stream.events.filter((event) => event.type === "device-paired").map((event) => (event as DevicePairedEvent).label);
  const pair = async (label: string) => {
    const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: guard })).json() as { code: string };
    const response = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: { ...guard, ...lan }, body: JSON.stringify({ code, label }) });
    expect(response.status).toBe(204);
    const cookie = response.headers.getSetCookie().find((line) => line.startsWith(`${DEVICE_COOKIE}=`))!.split(";")[0]!;
    // its first return confirms a first-pair credential (and closes the gate); a gated pairing is in already
    expect((await fetch(`${base}/api/session`, { headers: { ...lan, cookie } })).status).toBe(200);
  };
  try {
    const open = await openEvents(base, lan, abort.signal);
    const local = await openEvents(base, {}, abort.signal);
    const heardFirst = local.next(isPairing("First"), "this PC hears of First");
    await pair("First");
    await heardFirst;
    // the gate is closed: the LAN client is refused on any new request, and the stream it opened before has ended
    // without a word of the pairing that closed it
    expect((await fetch(`${base}/api/session`, { headers: lan })).status).toBe(401);
    await Promise.race([open.ended, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the open stream outlived the gate")), 5000))]);
    expect(pairedLabels(open)).toEqual([]);
    const revoked = await fetch(`${base}/api/devices/revoke-all`, { method: "POST", headers: guard });
    expect(await revoked.json()).toEqual({ revoked: 1 } satisfies DevicesRevokedAll);
    const heardSecond = local.next(isPairing("Second"), "this PC hears of Second");
    await pair("Second");
    await heardSecond;
    // a stream is ordered: a change made after both pairings reaches this PC's stream after them, and the ended one hears none of it
    const barrier = local.next((event) => event.type === "preferences" && event.preferences.settings["theme"] === "light", "this PC hears the barrier");
    expect((await fetch(`${base}/api/preferences`, { method: "PUT", headers: guard, body: JSON.stringify({ settings: { theme: "light" } }) })).status).toBe(200);
    await barrier;
    expect(open.events.filter((event) => event.type === "device-paired" || event.type === "preferences" && event.preferences.settings["theme"] === "light")).toEqual([]);
    expect(pairedLabels(local)).toEqual(["First", "Second"]);
  } finally {
    abort.abort();
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

it("a script pairs for its token in JSON and authenticates with Authorization: Device under the cookie's role, last-seen and revocation (#2744)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-device-header-"));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "configured", tailscaleOwner: null, machines: false, sidecar: false });
  const base = `http://127.0.0.1:${app.port}`;
  const admin = { ...guard, authorization: "Bearer configured" };
  const code = async () => ((await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: admin })).json()) as { code: string }).code;
  try {
    // a browser's pairing keeps its answer: no body, the HttpOnly cookie only
    const browser = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: guard, body: JSON.stringify({ code: await code(), label: "Browser" }) });
    expect(browser.status).toBe(204);
    expect(await browser.text()).toBe("");
    const browserCookie = browser.headers.get("set-cookie")!.split(";")[0]!;
    expect(browserCookie).toStartWith("ovis_device=");
    // its cookie coming back confirms the first pairing, so the script pairs through the closed gate
    expect((await fetch(`${base}/api/session`, { headers: { cookie: browserCookie } })).status).toBe(200);

    const paired = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: { ...guard, accept: "application/json" }, body: JSON.stringify({ code: await code(), label: "Script" }) });
    expect(paired.status).toBe(200);
    expect(paired.headers.get("cache-control")).toBe("no-store");
    const { token } = await paired.json() as { token: string };
    expect(token).toMatch(/^\S{16,}$/);
    expect(paired.headers.get("set-cookie")).toContain(`ovis_device=${encodeURIComponent(token)}`);

    const session = (authorization: string) => fetch(`${base}/api/session`, { headers: { authorization } });
    const listed = async () => ((await (await fetch(`${base}/api/devices`, { headers: admin })).json()) as { devices: { id: string; label: string; last_seen_at: string | null }[] }).devices.find((d) => d.label === "Script")!;
    expect((await listed()).last_seen_at).toBeNull();
    expect((await session(`Device ${token}`)).status).toBe(200);
    expect((await session(`device ${token}`)).status).toBe(200);
    expect((await listed()).last_seen_at).not.toBeNull();
    expect((await session(`Device ${token}x`)).status).toBe(401);
    // the device's token is not the shared token
    expect((await session(`Bearer ${token}`)).status).toBe(401);
    const { devices } = await (await fetch(`${base}/api/devices`, { headers: { authorization: `Device ${token}` } })).json() as { devices: { label: string; current: boolean }[] };
    expect(devices.find((d) => d.current)?.label).toBe("Script");

    const id = (await listed()).id;
    const startAs = (authorization: string) => fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: { ...guard, authorization } });
    expect((await startAs(`Device ${token}`)).status).toBe(200);
    app.context.services.devices.update(id, { role: "watch" });
    const refused = await startAs(`Device ${token}`);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "read_only" } });

    expect((await fetch(`${base}/api/devices/${id}`, { method: "DELETE", headers: admin })).status).toBe(204);
    expect((await session(`Device ${token}`)).status).toBe(401);
  } finally {
    app.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("a device downgraded to watch while its relayed /ws?machine_id= upgrade is pending is ended at admission, not left driving", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-device-downgrade-relay-"));
  let reached!: () => void, release!: () => void;
  const reachedRemote = new Promise<void>((resolve) => { reached = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  let upstreamClosed!: () => void;
  const closedUpstream = new Promise<void>((resolve) => { upstreamClosed = resolve; });
  const forwarded: string[] = [];
  const upstream = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(request, instance) {
      reached(); await released;
      return instance.upgrade(request) ? undefined : new Response(null, { status: 426 });
    },
    websocket: { open() {}, message(_ws, raw) { forwarded.push(String(raw)); }, close() { upstreamClosed(); } },
  });
  const endpoint = spyOn(MachineManager.prototype, "endpoint").mockImplementation((id) =>
    id === "fictional-remote" ? { url: `http://127.0.0.1:${upstream.port}`, token: "fictional-remote" } : undefined);
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "test-downgrade-relay", tailscaleOwner: null, sidecar: false });
  const base = `http://127.0.0.1:${app.port}`;
  const admin = { ...guard, authorization: "Bearer test-downgrade-relay" };
  const stranger = { "x-forwarded-for": "100.64.0.9" };
  let socket: WebSocket | undefined;
  try {
    const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: admin })).json() as { code: string };
    const paired = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: { ...guard, ...stranger }, body: JSON.stringify({ code, label: "Phone" }) });
    expect(paired.status).toBe(204);
    const cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
    // its cookie coming back confirms the pairing
    expect((await fetch(`${base}/api/session`, { headers: { ...stranger, cookie } })).status).toBe(200);
    const { devices } = await (await fetch(`${base}/api/devices`, { headers: { ...stranger, cookie } })).json() as { devices: { id: string; current: boolean }[] };
    const id = devices.find((device) => device.current)!.id;

    const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: { cookie: string } }) => WebSocket;
    socket = new RuntimeSocket(`${base.replace("http:", "ws:")}/ws?machine_id=fictional-remote`, { headers: { cookie } });
    const closed = new Promise<CloseEvent>((resolve) => socket!.addEventListener("close", resolve, { once: true }));
    await reachedRemote;
    // the role changes while the relay still dials the other PC: the socket was authorized to drive
    app.context.services.devices.update(id, { role: "watch" });
    release();
    socket.addEventListener("open", () => socket!.send(JSON.stringify({ type: "attach", pane_id: "remote-pane", cols: 80, rows: 24, receipt_resume_id: crypto.randomUUID() })), { once: true });
    const ended = await Promise.race([closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the downgraded socket was left open")), 5000))]);
    expect(ended.code).toBe(1008);
    await closedUpstream;
    expect(forwarded).toEqual([]);
  } finally {
    socket?.close();
    app.stop();
    upstream.stop(true);
    endpoint.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

it("a script's first pairing on a fresh install is kept at once, so its token still works after a restart (#2744)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-device-header-first-"));
  const options = { port: 0, hostname: "127.0.0.1", stateDir, token: "configured", tailscaleOwner: null, machines: false, sidecar: false } as const;
  let app = createServer(options);
  try {
    let base = `http://127.0.0.1:${app.port}`;
    const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: { ...guard, authorization: "Bearer configured" } })).json() as { code: string };
    const paired = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: { ...guard, accept: "application/json" }, body: JSON.stringify({ code, label: "Script" }) });
    expect(paired.status).toBe(200);
    const { token } = await paired.json() as { token: string };
    const registry = JSON.parse(readFileSync(join(stateDir, "devices.json"), "utf8")) as { gate_closed_at: string | null; devices: { label: string }[] };
    expect(registry.devices.map((d) => d.label)).toEqual(["Script"]);
    expect(registry.gate_closed_at).not.toBeNull();
    app.stop();
    app = createServer(options);
    base = `http://127.0.0.1:${app.port}`;
    expect((await fetch(`${base}/api/session`, { headers: { authorization: `Device ${token}` } })).status).toBe(200);
  } finally {
    app.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("a PC in no account lets a revoked key pair again with a code started through the relay, which clears its tombstone", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-repair-"));
  try {
    const store = new DeviceStore(stateDir);
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
    const first = store.pairRelay(store.startPairing().code, "Relay phone", publicKey);
    if (!first) throw new Error("Expected relay enrollment");
    store.revoke(first.device.id);
    expect(store.isTombstoned(publicKey)).toBe(true);
    const again = store.pairRelay(store.startPairing(Date.now(), { remote: true, startedBy: null, memberRequired: false }).code, "Relay phone", publicKey);
    expect(again?.device.label).toBe("Relay phone");
    expect(new DeviceStore(stateDir).isTombstoned(publicKey)).toBe(false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("a PC in no account still refuses, with a code started through the relay, a key its account removed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-account-removed-"));
  try {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
    writeFileSync(join(stateDir, "account-tombstones.json"), JSON.stringify({ v: 1, tombstones: [{ key: publicKey, account: "acct_1", record_id: "r1", removed_at: "2026-11-01T00:00:00.000Z" }] }), { mode: 0o600 });
    const store = new DeviceStore(stateDir);
    expect(store.pairRelay(store.startPairing(Date.now(), { remote: true, startedBy: null, memberRequired: false }).code, "Phone", publicKey)).toBeNull();
    expect(store.isTombstoned(publicKey)).toBe(true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("a PC in no account whose tombstone file will not parse refuses a code started through the relay", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-tombstones-broken-"));
  try {
    writeFileSync(join(stateDir, "account-tombstones.json"), "{broken", { mode: 0o600 });
    const store = new DeviceStore(stateDir);
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
    expect(store.pairRelay(store.startPairing(Date.now(), { remote: true, startedBy: null, memberRequired: false }).code, "Phone", publicKey)).toBeNull();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("a key re-paired on a PC in no account with a code another device started stays when its tombstone comes back", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-repair-starter-"));
  try {
    const store = new DeviceStore(stateDir);
    const fresh = async () => {
      const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      return Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
    };
    const [starterKey, publicKey] = [await fresh(), await fresh()];
    const starter = store.pairRelay(store.startPairing().code, "Laptop", starterKey);
    const first = store.pairRelay(store.startPairing().code, "Phone", publicKey);
    if (!starter || !first) throw new Error("Expected relay enrollment");
    store.revoke(first.device.id);
    const tombstones = readFileSync(join(stateDir, "account-tombstones.json"));
    // a second later, as a person pairing again would be
    const later = Date.now() + 1_000;
    expect(store.pairRelay(store.startPairing(later, { remote: true, startedBy: starter.device.id, memberRequired: false }).code, "Phone", publicKey, later)).not.toBeNull();
    // the revoke's tombstone back, as a stop before it was cleared or a sibling dir's merge leaves it
    writeFileSync(join(stateDir, "account-tombstones.json"), tombstones, { mode: 0o600 });
    expect(new DeviceStore(stateDir).hasKey(publicKey)).toBe(true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("POST /api/devices/pair/cancel takes back the pending code, so it pairs nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-cancel-"));
  const server = createServer({ port: 0, stateDir: root, token: "test-device-cancel", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  const admin = { ...guard, authorization: "Bearer test-device-cancel" };
  try {
    const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: admin })).json() as { code: string };
    expect((await fetch(`${base}/api/devices/pair/cancel`, { method: "POST", headers: { authorization: admin.authorization } })).status).toBe(403);
    expect((await fetch(`${base}/api/devices/pair/cancel`, { method: "POST", headers: admin })).status).toBe(200);
    const late = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: guard, body: JSON.stringify({ code, label: "Too late" }) });
    expect(late.status).not.toBe(204);
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

it("POST /api/devices/pair/cancel with a code ends only that pairing, not one started after it", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-cancel-own-"));
  const server = createServer({ port: 0, stateDir: root, token: "test-device-cancel-own", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  const admin = { ...guard, authorization: "Bearer test-device-cancel-own" };
  try {
    const start = async () => (await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: admin })).json() as { code: string }).code;
    const shown = await start();
    // Settings, or another device, starts a pairing of its own while `link --code` still runs
    const newer = await start();
    const stale = await fetch(`${base}/api/devices/pair/cancel`, { method: "POST", headers: admin, body: JSON.stringify({ code: shown }) });
    expect(stale.status).toBe(200);
    expect(await stale.json()).toEqual({ ok: true, cancelled: false });
    const paired = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: guard, body: JSON.stringify({ code: newer, label: "Newer" }) });
    expect(paired.ok).toBe(true);
    const third = await start();
    const own = await fetch(`${base}/api/devices/pair/cancel`, { method: "POST", headers: admin, body: JSON.stringify({ code: third }) });
    expect(await own.json()).toEqual({ ok: true, cancelled: true });
    const late = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: guard, body: JSON.stringify({ code: third, label: "Too late" }) });
    expect(late.ok).toBe(false);
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

it("ends an events stream the open LAN let in once the gate closes, and refuses its next one", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-open-stream-"));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false });
  const base = `http://127.0.0.1:${app.port}`;
  const stranger = { "x-forwarded-for": "192.168.0.20" };
  const abort = new AbortController();
  try {
    const events = await openEvents(base, stranger, abort.signal);
    await events.next((event) => event.type === "machines", "initial roster");
    // the relay turned on: the gate closes with no device paired, and the stream that read this PC's roster ends
    app.context.services.devices.closeGate();
    await Promise.race([events.ended, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the open stream outlived the gate")), 5000))]);
    expect((await fetch(`${base}/api/machines/events`, { headers: stranger })).status).toBe(401);
  } finally {
    abort.abort();
    app.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}, 15_000);

it("ends a socket the open LAN let in once the first device is paired, and refuses its next one", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-open-socket-"));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, machines: false, sidecar: false });
  const base = `http://127.0.0.1:${app.port}`;
  // another machine on the LAN, as a proxy in front of this server names it
  const stranger = { "x-forwarded-for": "192.168.0.20" };
  const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const open = (): { socket: WebSocket; opened: Promise<boolean>; closed: Promise<CloseEvent> } => {
    const socket = new RuntimeSocket(`${base.replace("http:", "ws:")}/ws`, { headers: stranger });
    const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }));
    const opened = new Promise<boolean>((resolve) => {
      socket.addEventListener("open", () => resolve(true), { once: true });
      socket.addEventListener("error", () => resolve(false), { once: true });
    });
    return { socket, opened, closed };
  };
  const sockets: WebSocket[] = [];
  try {
    const health = async () => (await (await fetch(`${base}/api/health`, { headers: stranger })).json() as { auth: { authenticated: boolean; via?: string } }).auth;
    expect(await health()).toMatchObject({ authenticated: true, via: "open" });
    const first = open();
    sockets.push(first.socket);
    expect(await first.opened).toBe(true);
    const store = app.context.services.devices;
    // a first pairing whose cookie has not come back closes nothing: the socket stays
    const phone = store.pair(store.startPairing().code, "Phone", "drive")!;
    expect([store.gated, first.socket.readyState]).toEqual([false, WebSocket.OPEN]);
    // the cookie comes back: the gate closes, and with it the connection nothing but the open LAN stood behind
    store.match(phone.token);
    const ended = await Promise.race([first.closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the open socket outlived the gate")), 5000))]);
    expect([ended.code, ended.reason]).toEqual([1008, "Pairing required"]);
    expect(await health()).toMatchObject({ authenticated: false });
    const second = open();
    sockets.push(second.socket);
    expect(await second.opened).toBe(false);
  } finally {
    for (const socket of sockets) socket.close();
    app.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}, 15_000);

it("a pairing code the open LAN started does not pair once the first device closed the gate", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-open-code-"));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, machines: false, sidecar: false });
  const base = `http://127.0.0.1:${app.port}`;
  const stranger = { ...guard, "x-forwarded-for": "192.168.0.20" };
  try {
    const store = app.context.services.devices;
    // the owner's phone redeemed its code; until its cookie comes back the gate is open
    const phone = store.pair(store.startPairing().code, "Phone", "drive")!;
    const started = await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: stranger });
    expect(started.status).toBe(200);
    const { code } = await started.json() as { code: string };
    store.match(phone.token);
    expect(store.gated).toBe(true);
    const redeemed = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: stranger, body: JSON.stringify({ code, label: "Stranger" }) });
    expect([redeemed.ok, redeemed.headers.get("set-cookie")]).toEqual([false, null]);
    expect(store.list(null).map((device) => device.label)).toEqual(["Phone"]);
  } finally {
    app.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
