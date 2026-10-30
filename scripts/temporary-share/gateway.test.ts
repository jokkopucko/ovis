import { afterEach, expect, it } from "bun:test";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShareGateway, type ShareConfig } from "./gateway.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(ttl = 60_000) {
  const directory = mkdtempSync(join(tmpdir(), "ovis-share-gateway-"));
  const socket = join(directory, "backend.sock");
  const backend = http.createServer((request, response) => {
    if (request.url === "/events") { response.writeHead(200, { "content-type": "text/event-stream" }); response.write("data: ready\n\n"); return; }
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ path: request.url, body: Buffer.concat(chunks).toString(), authorization: request.headers.authorization, forwarded: request.headers["x-forwarded-host"] })); });
  });
  backend.on("upgrade", (_request, client) => {
    client.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    client.on("data", data => client.write(data));
  });
  await new Promise<void>(resolve => backend.listen(socket, resolve));
  const config: ShareConfig = { id: "d83ab961-d9b4-4f6e-8c18-804719202947", cookieSecret: "a".repeat(64), backendToken: "backend-control-secret".repeat(3), socketPath: socket, publicOrigin: "https://share.test:7300", expiresAt: new Date(Date.now() + ttl).toISOString(), hostname: "127.0.0.1", port: 0 };
  const gateway = createShareGateway(config);
  await new Promise<void>(resolve => gateway.server.listen(0, "127.0.0.1", resolve));
  const port = (gateway.server.address() as { port: number }).port;
  cleanups.push(async () => { backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); });
  cleanups.push(() => gateway.close());
  function request(path: string, headers: Record<string, string> = {}, method = "GET", body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, method, headers: { host: "share.test:7300", ...headers } }, response => {
        const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on("error", reject); req.end(body);
    });
  }
  return { config, gateway, port, request, cookie: "ovis_temporary_share=" + config.cookieSecret };
}

it("admits only the UUID and keeps API requests behind the share cookie", async () => {
  const f = await fixture();
  expect((await f.request("/api/session")).status).toBe(404);
  expect((await f.request("/wrong-uuid")).status).toBe(404);
  const entry = await f.request("/" + f.config.id);
  expect(entry.status).toBe(200);
  expect(JSON.parse(entry.body).path).toBe("/");
  const cookie = entry.headers["set-cookie"]![0]!;
  expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("Secure"); expect(cookie).toContain("SameSite=Strict");
  const allowed = await f.request("/api/session", { cookie: f.cookie, authorization: "Bearer attacker", "x-forwarded-host": "attacker.test" });
  expect(allowed.status).toBe(200);
  expect(JSON.parse(allowed.body)).toEqual({ path: "/api/session", body: "", authorization: "Bearer " + f.config.backendToken });
  expect((await f.request("/api/session", { cookie: "ovis_temporary_share=wrong" })).status).toBe(404);
});

it("allows controls only from this share's browser origin", async () => {
  const f = await fixture();
  expect((await f.request("/api/pane/send", { cookie: f.cookie, origin: "https://attacker.test" }, "POST", "no")).status).toBe(403);
  expect((await f.request("/api/pane/send", { cookie: f.cookie }, "POST", "no")).status).toBe(403);
  const sent = await f.request("/api/pane/send", { cookie: f.cookie, origin: f.config.publicOrigin }, "POST", "control input");
  expect(sent.status).toBe(200); expect(JSON.parse(sent.body).body).toBe("control input");
  expect((await f.request("/api/session", { host: "attacker.test", cookie: f.cookie })).status).toBe(404);
});

it("rejects expired links and existing cookies", async () => {
  const f = await fixture(); f.gateway.expire();
  expect((await f.request("/" + f.config.id)).status).toBe(410);
  expect((await f.request("/api/session", { cookie: f.cookie })).status).toBe(410);
});

it("closes an active streamed response at the deadline", async () => {
  const f = await fixture(400);
  const closed = new Promise<void>((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: f.port, path: "/events", headers: { host: "share.test:7300", cookie: f.cookie } }, response => {
      response.once("data", () => response.once("close", resolve));
      response.on("error", () => {});
    }); req.on("error", reject);
  });
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(Error("expiry did not close the stream")), 2000))]);
  expect((await f.request("/api/session", { cookie: f.cookie })).status).toBe(410);
});

it("proxies WebSocket upgrades and closes them on revocation", async () => {
  const f = await fixture();
  const client = await new Promise<import("node:net").Socket>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: f.port, path: "/ws", headers: { host: "share.test:7300", cookie: f.cookie, origin: f.config.publicOrigin, upgrade: "websocket", connection: "Upgrade" } });
    req.on("upgrade", (_response, socket) => resolve(socket)); req.on("error", reject); req.end();
  });
  const echo = new Promise<string>(resolve => client.once("data", data => resolve(data.toString())));
  client.write("terminal input"); expect(await echo).toBe("terminal input");
  const closed = new Promise<void>(resolve => client.once("close", () => resolve()));
  f.gateway.expire(); await closed;
});

it("refuses a public listener without TLS", () => {
  expect(() => createShareGateway({ id: "d83ab961-d9b4-4f6e-8c18-804719202947", cookieSecret: "a".repeat(64), backendToken: "b".repeat(64), socketPath: "/tmp/no.sock", publicOrigin: "https://share.test:7300", expiresAt: new Date(Date.now() + 1000).toISOString(), hostname: "0.0.0.0", port: 7300 })).toThrow("TLS");
});
