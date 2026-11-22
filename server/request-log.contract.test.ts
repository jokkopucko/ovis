import { expect, it, spyOn } from "bun:test";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { DeviceStore } from "./devices.ts";
import { MachineManager } from "./machines.ts";
import { PortalService } from "./portal.ts";
import { fileInfo, fileResponse } from "./file-view.ts";
import { serveStatic } from "./static.ts";
import { compressResponse } from "./compress.ts";
import * as conversation from "./conversation.ts";

function records(root: string): Record<string, unknown>[] {
  const text = readFileSync(join(root, "http-requests.jsonl"), "utf8").trim();
  return text === "" ? [] : text.split("\n").map((line) => JSON.parse(line));
}

it("attributes reserved setup job lookups to the dispatch branch rather than a machine proxy", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-request-route-dispatch-"));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "", tailscaleOwner: null, sidecar: false });
  try {
    for (const jobId of ["session", "agents", "settings", "events"]) {
      const response = await fetch(`http://127.0.0.1:${app.port}/api/machines/setup/${jobId}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "job_not_found" } });
      const rows = records(root).filter((row) => row.request_id === response.headers.get("x-request-id"));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ route: "/api/machines/setup/:job_id", status: 404 });
    }
    // Adjacent dispatch branches keep their own templates and never copy private segments.
    for (const [path, route, status] of [
      ["/api/machines/private-pc/pane/conversation", "/api/machines/:machine_id/pane/conversation", 503],
      ["/api/machines/private-pc/pane/summary", "/api/machines/:machine_id/pane/summary", 503],
      ["/api/devices/private-label", "/api/devices/:device_id", 400],
      ["/api/fs/page-media/private-token", "/api/fs/page-media/:media_id", 404],
      ["/api/pane/private-pane", "unmatched", 404],
      ["/api/machines/private-pc/private-path", "unmatched", 404],
      ["/api/private-path", "unmatched", 404],
      ["/home/private-path", "static", 200],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${app.port}${path}`, { headers: { "x-herdr-machine": "1" } });
      expect(response.status).toBe(status);
      await response.arrayBuffer();
      const rows = records(root).filter((row) => row.request_id === response.headers.get("x-request-id"));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ route, status });
    }
    expect(readFileSync(join(root, "http-requests.jsonl"), "utf8")).not.toContain("private-");
  } finally {
    app.stop();
    rmSync(root, { recursive: true, force: true });
    console.log(`CLEANUP pid=${process.pid} ports=${app.port} removed=${root} sockets=closed readers=closed`);
  }
});

it("answers a pane's summary through the dispatch: 401 without a session, 200 for a watching device", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-summary-dispatch-"));
  const store = new DeviceStore(root);
  const watch = store.pair(store.startPairing().code, "fictional-watch-label", "watch");
  if (watch === null) throw new Error("Watch fixture did not pair");
  store.match(watch.token);
  const read = spyOn(conversation, "paneConversation").mockImplementation(async () => ({
    source: "claude-transcript", cursor: null, history_id: "h", version: "v", metadata: { model: null, reasoning_effort: null },
    turns: [{ role: "assistant", ts: "2026-11-12T10:00:00Z", parts: [{ kind: "text", text: "Done." }] }],
  }));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "fictional-owner", tailscaleOwner: null, sidecar: false });
  const url = `http://127.0.0.1:${app.port}/api/pane/summary?pane_id=w1%3Ap1`;
  try {
    const refused = await fetch(url);
    expect(refused.status).toBe(401);
    await refused.arrayBuffer();
    const watched = await fetch(url, { headers: { cookie: `ovis_device=${watch.token}` } });
    expect(watched.status).toBe(200);
    expect((await watched.json() as { summaries: unknown }).summaries).toEqual({ "w1:p1": { role: "assistant", text: "Done.", at: "2026-11-12T10:00:00Z", asked_at: null } });
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    app.stop(); read.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

/** Raw HTTP exposes the 101 headers that a browser's WebSocket API deliberately hides. */
function handshake(port: number, path: string, extra = ""): Promise<{ status: number; headers: Headers }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let received = "";
    const timer = setTimeout(() => socket.destroy(new Error("Handshake deadline exceeded")), 5000);
    socket.on("error", reject);
    socket.on("connect", () => socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer fictional-owner\r\n${extra}\r\n`,
    ));
    socket.on("data", (data) => {
      received += data.toString();
      const end = received.indexOf("\r\n\r\n");
      if (end === -1) return;
      const [statusLine = "", ...lines] = received.slice(0, end).split("\r\n");
      const headers = new Headers();
      for (const line of lines) {
        const colon = line.indexOf(":");
        if (colon > 0) headers.set(line.slice(0, colon), line.slice(colon + 1).trim());
      }
      socket.removeAllListeners("data");
      socket.once("close", () => resolve({ status: Number(statusLine.split(" ")[1]), headers }));
      socket.destroy();
    });
    socket.once("close", () => clearTimeout(timer));
  });
}

it("records exactly one completion for HTTP responses, early refusals, streams and both 101 paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-request-contract-"));
  const store = new DeviceStore(root);
  const watch = store.pair(store.startPairing().code, "fictional-watch-label", "watch");
  if (watch === null) throw new Error("Watch fixture did not pair");
  store.match(watch.token);
  const upstream = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(request, server) {
      if (request.headers.get("authorization") !== "Bearer fictional-remote") return new Response(null, { status: 401 });
      if (server.upgrade(request)) return;
      return new Response(null, { status: 426 });
    },
    websocket: { message() {} },
  });
  const endpoint = spyOn(MachineManager.prototype, "endpoint").mockImplementation((id) =>
    id === "fictional-remote" ? { url: `http://127.0.0.1:${upstream.port}`, token: "fictional-remote" } : undefined);
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "fictional-owner", tailscaleOwner: null, sidecar: false });
  const base = `http://127.0.0.1:${app.port}`;
  const auth = { authorization: "Bearer fictional-owner" };
  const upstreamPort = upstream.port;
  const abort = new AbortController();
  const seenIds: string[] = [];
  const check = (response: { status: number; headers: Headers }, expected: number) => {
    expect(response.status).toBe(expected);
    const id = response.headers.get("x-request-id");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    if (id === null) throw new Error("Missing response id");
    seenIds.push(id);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const matched = records(root).filter((record) => record.request_id === id);
    expect(matched).toHaveLength(1);
    expect(matched[0]?.status).toBe(expected);
  };
  try {
    check(await fetch(`${base}/api/preferences`, { headers: auth }), 200);
    check(await fetch(`${base}/api/auth`, { method: "DELETE", headers: auth }), 204);
    check(await fetch(`${base}/api/devices/pair`, { method: "POST", body: "{}" }), 400);
    check(await fetch(`${base}/api/session`), 401);
    check(await fetch(`${base}/api/preferences`, { method: "PUT", headers: { ...auth, origin: "https://other.example" }, body: "{}" }), 403);
    check(await fetch(`${base}/api/fs/file?path=/fictional-secret`, { headers: { cookie: `ovis_device=${watch.token}` } }), 403);
    check(await fetch(`${base}/api/fictional-secret?token=fictional-secret`, { headers: auth }), 404);
    const shell = await fetch(`${base}/`, { headers: { ...auth, "accept-encoding": "identity" } });
    check(shell, 200);
    const routeShell = await compressResponse(new Request(base, { headers: { "accept-encoding": "identity" } }), await serveStatic("/", "identity", base));
    for (const name of ["cache-control", "content-security-policy", "content-type", "x-frame-options", "content-encoding", "vary"]) {
      expect(shell.headers.get(name)).toBe(routeShell?.headers.get(name) ?? null);
    }
    expect(shell.headers.get("cache-control")).toBe("no-cache");
    for (const path of ["/sw.js", "/manifest.webmanifest"]) {
      const response = await fetch(`${base}${path}`, { headers: { "accept-encoding": "identity" } });
      check(response, 200);
      expect(response.headers.get("cache-control")).toBe("no-cache");
    }
    const media = join(root, "fictional-report.html");
    writeFileSync(media, "<h1>Fictional report</h1>");
    const info = fileInfo(media);
    if (info === null) throw new Error("Missing media fixture");
    const routeMedia = await fileResponse(info, false, true);
    const responseMedia = await fetch(`${base}/api/fs/file?path=${encodeURIComponent(media)}&render=1`, { headers: { ...auth, "accept-encoding": "identity" } });
    check(responseMedia, 200);
    for (const name of ["cache-control", "content-type", "x-frame-options", "referrer-policy"]) {
      expect(responseMedia.headers.get(name)).toBe(routeMedia.headers.get(name) ?? (name === "referrer-policy" ? "no-referrer" : null));
    }
    // The HTTP route supplies a media source; compare the otherwise byte-identical CSP.
    expect(responseMedia.headers.get("content-security-policy")).toBe(
      routeMedia.headers.get("content-security-policy")?.replace("media-src data: blob:", `media-src data: blob: ${base}/api/fs/page-media/`) ?? null,
    );
    const sse = await fetch(`${base}/api/machines/events`, { headers: auth, signal: abort.signal });
    check(sse, 200);
    expect(sse.headers.get("content-type")).toBe("text/event-stream");
    const reader = sse.body?.getReader();
    expect((await reader?.read())?.done).toBe(false);
    await reader?.cancel();
    abort.abort();
    check(await handshake(app.port, "/ws"), 101);
    check(await handshake(app.port, "/ws?machine_id=fictional-remote"), 101);

    for (const value of ["repeated", "repeated", "a".repeat(64), "a".repeat(65), "é"]) {
      const response = await fetch(`${base}/api/preferences?token=fictional-secret`, { headers: { ...auth, "x-request-id": value } });
      check(response, 200);
      const row = records(root).find((record) => record.request_id === response.headers.get("x-request-id"));
      expect(row?.client_request_id).toBe(/^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : undefined);
    }
    // A wire CRLF ends the header; injected fields never become log metadata.
    check(await handshake(app.port, "/ws", "X-Request-Id: safe\r\nX-Injected: fictional-secret\r\n"), 101);
    expect(new Set(seenIds).size).toBe(seenIds.length);
    const all = records(root);
    expect(all).toHaveLength(seenIds.length);
    for (const row of all) {
      expect(Object.keys(row).sort()).toEqual(row.client_request_id === undefined
        ? ["latency_ms", "method", "request_id", "route", "status"]
        : ["client_request_id", "latency_ms", "method", "request_id", "route", "status"]);
    }
    const raw = readFileSync(join(root, "http-requests.jsonl"), "utf8");
    for (const secret of [root, "fictional-secret", "fictional-watch-label", "fictional-owner", "fictional-remote", watch.token]) expect(raw).not.toContain(secret);
  } finally {
    abort.abort();
    app.stop(); upstream.stop(true); endpoint.mockRestore();
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
    console.log(`CLEANUP pid=${process.pid} ports=${app.port},${upstreamPort} removed=${root} sockets=closed readers=closed`);
  }
});

for (const writable of [true, false]) it(`correlates portal startup failure with writable log ${writable}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-request-startup-"));
  if (!writable) mkdirSync(join(root, "http-requests.jsonl"));
  const portal = new PortalService({ stateDir: root });
  const resume = spyOn(portal, "resume").mockRejectedValue(new Error("fictional-private-startup"));
  const log = spyOn(console, "error").mockImplementation(() => {});
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "", tailscaleOwner: null, machines: false, sidecar: false, portal });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/preferences`);
    expect(response.status).toBe(500);
    const id = response.headers.get("x-request-id");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await response.json()).toMatchObject({ error: { message: `internal error (${id})` } });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    if (writable) {
      expect(records(root)).toHaveLength(1);
      expect(records(root)[0]).toMatchObject({ request_id: id, status: 500, route: "startup" });
    }
  } finally {
    app.stop(); resume.mockRestore(); log.mockRestore();
    rmSync(root, { recursive: true, force: true });
    console.log(`CLEANUP pid=${process.pid} ports=${app.port} removed=${root} sockets=closed readers=closed`);
  }
});
