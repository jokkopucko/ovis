import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CLIProxyLogin } from "../shared/protocol.ts";
import { requiresAuth } from "./auth.ts";
import { CLIProxyService } from "./cliproxy.ts";
import { startFakeCLIProxy } from "./cliproxy.fake.ts";
import { CLIProxyRoutes } from "./cliproxy-routes.ts";
import { createServer } from "./index.ts";
import { UsageService, type UsageContext } from "./usage.ts";

const KEY = "test-management-secret-not-in-responses";
let dir: string;
let fake: ReturnType<typeof startFakeCLIProxy>;
let service: CLIProxyService;
let routes: CLIProxyRoutes;
const call = (path = "", init: RequestInit = {}) => routes.handle(new Request(`http://localhost/api/cliproxy${path}`, init));
const send = (path: string, body: unknown) => call(path, { method: path ? "POST" : "PUT", body: JSON.stringify(body) });
const configure = (key = KEY) => send("", { url: fake.server.url.origin, management_key: key });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cliproxy-test-"));
  fake = startFakeCLIProxy(KEY); service = new CLIProxyService(dir); routes = new CLIProxyRoutes(service);
});
afterEach(() => { fake.server.stop(true); rmSync(dir, { recursive: true, force: true }); });

describe("CLIProxyAPI v8", () => {
  it.each([
    ["invalid JSON", `garbage ${KEY}`],
    ["invalid fields", JSON.stringify({ url: 42, management_key: KEY })],
    ["invalid URL", JSON.stringify({ url: "not-a-url", management_key: KEY })],
    ["unreadable file", null],
  ])("treats the hub as unconfigured when configuration has %s", async (_name, content) => {
    // Given
    const path = join(dir, "cliproxy.json");
    if (content === null) mkdirSync(path);
    else writeFileSync(path, content);
    // When
    const restored = new CLIProxyService(dir);
    const response = await new CLIProxyRoutes(restored).handle(new Request("http://localhost/api/cliproxy"));
    const status = await response.json();
    // Then
    expect(response.status).toBe(200);
    expect(status).toMatchObject({ configured: false, ok: false, problem: expect.any(String) });
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(await restored.report()).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("starts the web UI and allows removal when hub configuration is corrupt", async () => {
    // Given
    writeFileSync(join(dir, "cliproxy.json"), "garbage");
    // When
    const app = createServer({
      port: 0, hostname: "127.0.0.1", token: "", stateDir: dir,
      machines: false, registerBridge: false, terminalAttach: false, sidecar: false,
    });
    // Then
    try {
      const origin = `http://127.0.0.1:${app.port}`;
      expect((await fetch(`${origin}/api/health?scope=bridge`)).status).toBe(200);
      const status = await fetch(`${origin}/api/cliproxy`);
      expect(await status.json()).toMatchObject({ configured: false, ok: false, problem: expect.any(String) });
      const removed = await fetch(`${origin}/api/cliproxy`, { method: "DELETE" });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toMatchObject({ configured: false, problem: null });
      expect(new CLIProxyService(dir).status()).toMatchObject({ configured: false, problem: null });
    } finally { app.stop(); }
  });

  it("checks saved and reloaded connections without fetching provider usage", async () => {
    await configure();
    expect(await (await call()).json()).toMatchObject({ configured: true, ok: true });
    const restored = new CLIProxyRoutes(new CLIProxyService(dir));
    const response = await restored.handle(new Request("http://localhost/api/cliproxy"));
    expect(await response.json()).toMatchObject({ configured: true, ok: true });
    expect(fake.calls.map((entry) => entry.path)).toEqual(["/credentials", "/credentials"]);
  });

  it("reports separate email accounts using existing windows when configured", async () => {
    // Given
    await configure();
    // When
    const report = await service.report();
    // Then
    expect(report.map((entry) => [entry.key, entry.account, entry.windows[0]?.used_percent])).toEqual([
      ["claude:cliproxy:claude-a.json", "claude-a@example.test", 25],
      ["codex:cliproxy:codex-b.json", "codex-b@example.test", 32],
    ]);
    expect(fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => entry.body)).toEqual([
      expect.objectContaining({ auth_index: "a", header: expect.objectContaining({ authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20" }) }),
      expect.objectContaining({ auth_index: "b", header: expect.objectContaining({ authorization: "Bearer $TOKEN$", "chatgpt-account-id": "workspace-b" }) }),
    ]);
  });

  it("persists the key privately without returning it when saved or reloaded", async () => {
    // Given
    const saved = await configure();
    // When
    const restored = new CLIProxyService(dir);
    // Then
    expect(await saved.text()).not.toContain(KEY);
    expect(restored.status().configured).toBe(true);
    expect(JSON.stringify(restored.status())).not.toContain(KEY);
    expect(statSync(join(dir, "cliproxy.json")).mode & 0o777).toBe(0o600);
  });

  it("stops retrying a wrong key when status and usage are requested again", async () => {
    // Given
    await configure("wrong-secret");
    // When
    const responses = await Promise.all([call(), call(), service.report(true)]);
    // Then
    expect(fake.calls).toHaveLength(1);
    expect(service.status().problem).toContain("rejected");
    for (const response of responses) expect(response instanceof Response ? await response.text() : JSON.stringify(response)).not.toMatch(/wrong-secret|test-management-secret-not-in-responses/);
  });

  it("stops queued upstream requests when a saved key has been revoked", async () => {
    // Given
    await configure();
    fake.setKey("replacement-management-key");
    const before = fake.calls.length;
    // When
    const responses = await Promise.allSettled(Array.from({ length: 8 }, () => service.call("/credentials")));
    // Then
    expect(responses.every((response) => response.status === "rejected")).toBe(true);
    expect(fake.calls.length - before).toBe(1);
  });

  it("redacts a key when a successful proxy response quotes it", async () => {
    // Given
    const file = fake.files[0];
    if (!file) throw new Error("fixture needs a credential");
    file.email = KEY;
    await configure();
    // When
    const report = await service.report();
    // Then
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(report[0]?.account).toBe("[redacted]");
  });

  it("keeps the saved key on its server when a URL change supplies an invalid replacement", async () => {
    // Given
    await configure();
    const other = startFakeCLIProxy(KEY);
    try {
      // When
      const responses = await Promise.all([true, "   ", 12].map((management_key) => send("", { url: other.server.url.origin, management_key })));
      // Then
      expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
      expect(other.calls).toEqual([]);
      expect(service.status().url).toBe(fake.server.url.origin);
    } finally { other.server.stop(true); }
  });

  it("keeps local usage when the proxy cannot be reached", async () => {
    // Given
    const ctx: UsageContext = { home: dir, env: {}, platform: "linux", fetch, now: Date.now, keychain: async () => ({ status: "missing" }), run: async () => null, has: () => true };
    await configure();
    fake.server.stop(true);
    await service.save({ url: fake.server.url.origin, management_key: KEY });
    const local = { id: "claude", signIns: async () => [{ source: "fixture", token: "local-token", expiresAt: null }], read: async () => ({ plan: "max", windows: [] }) } as const;
    // When
    const report = await new UsageService(ctx, [local], () => service.report()).report();
    // Then
    expect(report.providers).toHaveLength(1);
    expect(report.providers[0]?.plan).toBe("max");
    expect(service.status().problem).toContain("Could not reach");
  });

  it("adds an account when a pending login receives its redirect", async () => {
    // Given
    await configure();
    const login: CLIProxyLogin = await (await send("/login", { provider: "claude" })).json();
    expect(await (await call(`/login?state=${login.state}`)).json()).toEqual({ status: "wait" });
    // When
    const response = await send("/callback", { provider: "claude", state: login.state, redirect_url: `http://localhost/callback?code=test-code&state=${login.state}` });
    // Then
    expect(response.status).toBe(200);
    expect(await (await call(`/login?state=${login.state}`)).json()).toEqual({ status: "ok" });
    expect((await service.report()).map((entry) => entry.account)).toContain(`${login.state}@example.test`);
  });

  it("rejects mismatched callback state when a login belongs to another provider", async () => {
    // Given
    await configure();
    const login: CLIProxyLogin = await (await send("/login", { provider: "codex" })).json();
    // When
    const response = await send("/callback", { provider: "claude", state: login.state, redirect_url: `http://localhost/?state=${login.state}&code=x` });
    // Then
    expect(response.status).toBe(400);
    expect(fake.calls.some((entry) => entry.path === "/oauth/callback")).toBe(false);
  });

  it("cancels the upstream session when the user cancels", async () => {
    // Given
    await configure();
    const login: CLIProxyLogin = await (await send("/login", { provider: "claude" })).json();
    // When
    const response = await call(`/login?state=${login.state}`, { method: "DELETE" });
    // Then
    expect(response.status).toBe(200);
    expect(fake.sessions.has(login.state)).toBe(false);
  });

  it("removes saved configuration when requested and remains removed after restart", async () => {
    // Given
    await configure();
    // When
    await call("", { method: "DELETE" });
    // Then
    expect(new CLIProxyService(dir).status().configured).toBe(false);
    expect(await service.report()).toEqual([]);
  });

  it("requires app authentication for every proxy endpoint", () => {
    // Given / When / Then
    for (const path of ["", "/login", "/callback"]) expect(requiresAuth(`/api/cliproxy${path}`)).toBe(true);
  });
});
