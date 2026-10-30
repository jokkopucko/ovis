import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { Socket } from "node:net";

export interface ShareConfig {
  id: string;
  cookieSecret: string;
  backendToken: string;
  socketPath: string;
  publicOrigin: string;
  expiresAt: string;
  hostname: string;
  port: number;
  tls?: { key: string; cert: string };
}
const COOKIE = "ovis_temporary_share";
const equal = (left: string, right: string) => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** One gateway serves one isolated instance. The UUID admits a browser; its cookie then
 * routes Ovis's root-relative assets, HTTP API and WebSockets to that same instance. */
export function createShareGateway(config: ShareConfig, options: { now?: () => number; onExpire?: () => void } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(config.id) || !/^[0-9a-f]{64}$/i.test(config.cookieSecret)
    || config.backendToken.length < 32) throw Error("Invalid share credentials");
  const origin = new URL(config.publicOrigin);
  const deadline = Date.parse(config.expiresAt);
  if (!Number.isFinite(deadline)) throw Error("Invalid expiry");
  if (!config.tls && !["127.0.0.1", "::1"].includes(config.hostname)) throw Error("A public listener requires TLS");
  if (origin.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)) throw Error("The public URL requires HTTPS");
  const now = options.now ?? Date.now;
  const sockets = new Set<Socket>();
  let expired = false;
  function expire() {
    if (expired) return;
    expired = true;
    for (const socket of sockets) socket.destroy();
    options.onExpire?.();
  }
  function validCookie(request: IncomingMessage) {
    return (request.headers.cookie ?? "").split(";").some(pair => {
      const at = pair.indexOf("=");
      return at >= 0 && pair.slice(0, at).trim() === COOKIE && equal(pair.slice(at + 1).trim(), config.cookieSecret);
    });
  }
  function authorize(request: IncomingMessage, upgrade = false): { status: number; entry?: boolean } {
    if (expired || now() >= deadline) return { status: 410 };
    if (request.headers.host !== origin.host) return { status: 404 };
    const path = new URL(request.url ?? "/", origin).pathname;
    const entry = path === "/" + config.id || path === "/" + config.id + "/";
    if (entry && !upgrade && ["GET", "HEAD"].includes(request.method ?? "")) return { status: 200, entry: true };
    if (!validCookie(request)) return { status: 404 };
    if ((upgrade || !["GET", "HEAD"].includes(request.method ?? "")) && request.headers.origin !== origin.origin) return { status: 403 };
    return { status: 200 };
  }
  function backendHeaders(request: IncomingMessage): http.OutgoingHttpHeaders {
    const headers = { ...request.headers };
    for (const key of Object.keys(headers)) {
      if (key.startsWith("x-forwarded-") || key.startsWith("tailscale-") || key === "forwarded") delete headers[key];
    }
    headers.authorization = "Bearer " + config.backendToken;
    headers.host = origin.host;
    headers["x-forwarded-proto"] = origin.protocol.slice(0, -1);
    return headers;
  }
  function handle(request: IncomingMessage, response: ServerResponse) {
    const decision = authorize(request);
    if (decision.status !== 200) {
      response.writeHead(decision.status, { "cache-control": "no-store", "referrer-policy": "no-referrer" });
      response.end(decision.status === 410 ? "This workspace share has expired." : "Not available.");
      return;
    }
    const upstream = http.request({ socketPath: config.socketPath, path: decision.entry ? "/" : request.url, method: request.method, headers: backendHeaders(request) }, received => {
      const headers = { ...received.headers, "referrer-policy": "no-referrer", "cache-control": "no-store" };
      if (decision.entry) {
        const cookie = `${COOKIE}=${config.cookieSecret}; HttpOnly; SameSite=Strict; Path=/; Expires=${new Date(deadline).toUTCString()}${origin.protocol === "https:" ? "; Secure" : ""}`;
        headers["set-cookie"] = [...(received.headers["set-cookie"] ?? []), cookie];
      }
      response.writeHead(received.statusCode ?? 502, headers);
      received.pipe(response);
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end("Workspace unavailable."); });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  }
  const server = config.tls
    ? https.createServer({ key: readFileSync(config.tls.key), cert: readFileSync(config.tls.cert) }, handle)
    : http.createServer(handle);
  server.requestTimeout = 0;
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("upgrade", (request, client, head) => {
    const decision = authorize(request, true);
    if (decision.status !== 200) { client.end(`HTTP/1.1 ${decision.status} Refused\r\nConnection: close\r\n\r\n`); return; }
    const upstream = http.request({ socketPath: config.socketPath, path: request.url, method: "GET", headers: backendHeaders(request) });
    upstream.on("upgrade", (received, remote, remoteHead) => {
      sockets.add(remote); remote.once("close", () => sockets.delete(remote));
      client.write("HTTP/1.1 101 Switching Protocols\r\n" + Object.entries(received.headers).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).filter(x => x !== undefined).map(x => `${key}: ${x}\r\n`)).join("") + "\r\n");
      if (head.length) remote.write(head);
      if (remoteHead.length) client.write(remoteHead);
      client.pipe(remote).pipe(client);
      client.once("error", () => remote.destroy()); remote.once("error", () => client.destroy());
      client.once("close", () => remote.destroy()); remote.once("close", () => client.destroy());
    });
    upstream.on("response", received => { client.end(`HTTP/1.1 ${received.statusCode ?? 502} Refused\r\nConnection: close\r\n\r\n`); received.resume(); });
    upstream.on("error", () => client.destroy());
    client.once("close", () => upstream.destroy());
    upstream.end();
  });
  const timer = setTimeout(expire, Math.max(0, deadline - now()));
  timer.unref();
  server.once("close", () => clearTimeout(timer));
  return { server, expire, close() { clearTimeout(timer); for (const socket of sockets) socket.destroy(); return new Promise<void>(resolve => server.close(() => resolve())); } };
}

if (import.meta.main) {
  const config: ShareConfig = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8"));
  const gateway = createShareGateway(config);
  gateway.server.listen(config.port, config.hostname, () => console.log(`Workspace gateway listening on ${config.hostname}:${config.port}; expires ${config.expiresAt}`));
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { void gateway.close().then(() => process.exit(0)); });
}
