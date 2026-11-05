import { expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest, type ServerContext } from "./dispatch.ts";
import * as herdr from "./herdr/client.ts";
import { createServer } from "./index.ts";
import { PortalService } from "./portal.ts";

for (const [path, status, expectedTimeouts] of [["/api/health", 200, [60]], ["/api/nope", 404, [60]]] as const) {
  it(`dispatches GET ${path} with a fake socket context`, async () => {
    // Given: isolated server services and a transport that never uses a Bun request socket.
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-dispatch-"));
    const ping = spyOn(herdr, "ping").mockResolvedValue({ version: "fixture", protocol: 22, terminal_attach: false, terminal_mirror: true });
    let app: ReturnType<typeof createServer> | undefined;
    try {
      app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, machines: false, sidecar: false });
      const request = new Request(`http://127.0.0.1:${app.port}${path}`, { headers: { host: `127.0.0.1:${app.port}` } });
      const timeouts: Array<{ request: Request; seconds: number }> = [];
      const ctx: ServerContext = {
        ...app.context,
        requestIP: () => ({ address: "127.0.0.1" }),
        timeout: (request, seconds) => { timeouts.push({ request, seconds }); },
        upgrade: () => { throw new Error("Unexpected WebSocket upgrade"); },
      };
      // When
      const response = await handleRequest(request, ctx);
      // Then
      expect(response?.status).toBe(status);
      expect(timeouts).toEqual(expectedTimeouts.map((seconds) => ({ request, seconds })));
      expect(response?.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      app?.stop();
      ping.mockRestore();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

it("uses only the relay principal, even with valid driving cookies, bridge tokens and Portal proof", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-dispatch-relay-"));
  const portal = new PortalService({ stateDir });
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, portal, token: "shared-token", bridgeToken: "bridge-token", tailscaleOwner: null, machines: false, sidecar: false });
  const store = app.context.services.devices;
  const cookie = store.pair(store.startPairing().code, "Driving cookie", "drive");
  if (!cookie) throw new Error("Expected cookie pairing");
  const cookieMatch = spyOn(store, "match").mockImplementation(() => { throw new Error("Relay must not inspect cookies"); });
  const identity = spyOn(app.context.services, "identityOf").mockImplementation(() => { throw new Error("Relay must not inspect Tailscale"); });
  const proof = spyOn(portal, "vouches").mockReturnValue(true);
  const principal = { id: "0123456789abcdef", label: "Relay watcher", role: "watch" as const };
  const ctx: ServerContext = {
    ...app.context, peer: { kind: "relay", device: principal, sessionId: "session-a" },
    requestIP: () => { throw new Error("Relay must not inspect the socket"); },
    timeout: () => {},
    upgrade: (_request, options) => {
      expect(options.data.readOnly).toBe(true);
      expect(options.data.bridge).toBe(false);
      expect(options.data.deviceId).toBe(principal.id);
      return true;
    },
  };
  const headers = {
    cookie: `ovis_device=${cookie.token}; ovis_token=shared-token`, authorization: "Bearer shared-token",
    "tailscale-user-login": "owner@example.com", "x-forwarded-for": "100.64.0.1",
    "x-portal-proof": "valid-portal-proof", "x-portal-user": "owner", "x-portal-auth": "credential",
    origin: "https://relay.ovis.invalid", "x-herdr-machine": "1",
  };
  const request = (path: string, method = "GET") => new Request(`https://relay.ovis.invalid${path}`, { method, headers });
  try {
    const health = await handleRequest(request("/api/health?scope=bridge"), ctx);
    expect(await health?.json()).toMatchObject({
      auth: { via: "relay", role: "watch", authenticated: true },
      security: { observed_ingress: "relay" },
    });
    const mutation = await handleRequest(request("/api/preferences", "PUT"), ctx);
    expect(mutation?.status).toBe(403);
    expect(await mutation?.json()).toMatchObject({ error: { code: "read_only" } });
    const auth = await handleRequest(request("/api/auth", "POST"), ctx);
    expect(auth?.status).toBe(403);
    expect(auth?.headers.has("set-cookie")).toBe(false);
    expect(await handleRequest(new Request("https://relay.ovis.invalid/ws", { headers: { ...headers, authorization: "Bearer bridge-token" } }), ctx)).toBeUndefined();
    expect(store.gated).toBe(false);
    expect(cookieMatch).not.toHaveBeenCalled();
    expect(identity).not.toHaveBeenCalled();
    expect(proof).not.toHaveBeenCalled();
  } finally {
    cookieMatch.mockRestore();
    identity.mockRestore();
    proof.mockRestore();
    await portal.shutdown();
    app.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("keys relay request budgets by device rather than session or forged source address", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-dispatch-relay-client-"));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, machines: false, sidecar: false });
  const send = (id: string, sessionId: string, forwarded: string) => handleRequest(new Request("https://relay.ovis.invalid/api/connection-diagnostics", {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": forwarded }, body: "{}",
  }), {
    ...app.context, peer: { kind: "relay", device: { id, label: "Relay", role: "drive" }, sessionId }, timeout: () => {},
  });
  const log = spyOn(app.context.services.clientConnectionLog, "handle");
  try {
    for (let i = 0; i < 4; i++) expect((await send("aaaaaaaaaaaaaaaa", `session-${i}`, `100.64.0.${i}`))?.status).toBe(400);
    expect((await send("aaaaaaaaaaaaaaaa", "new-session", "203.0.113.1"))?.status).toBe(429);
    expect((await send("bbbbbbbbbbbbbbbb", "new-session", "203.0.113.1"))?.status).toBe(400);
    expect(log.mock.calls.map((call) => call[1])).toEqual([...Array<string>(5).fill("relay:aaaaaaaaaaaaaaaa"), "relay:bbbbbbbbbbbbbbbb"]);
  } finally {
    log.mockRestore();
    app.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
