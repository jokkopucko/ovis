import { expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVICE_COOKIE } from "./auth.ts";
import { DeviceStore } from "./devices.ts";
import { createServer } from "./index.ts";

it("gates bounded client diagnostics by auth and same origin, permits watch reports but never watch input", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-client-trace-contract-"));
  const devices = new DeviceStore(stateDir);
  const code = devices.startPairing().code;
  const paired = devices.pair(code, "Fictional viewer", "watch")!;
  devices.match(paired.token);
  const lines: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation((line) => { lines.push(String(line)); });
  const app = createServer({ port: 0, hostname: "127.0.0.1", token: "fixture-owner-token", stateDir, machines: false, registerBridge: false, herdrProfiles: async () => [], tailscaleOwner: null });
  const base = `http://127.0.0.1:${app.port}`;
  const trace = { client_id: "00000000-0000-4000-8000-000000000001", target: "local", events: [{ seq: 1, at: Date.now(), connection: 1, kind: "close", socket_state: 3, visibility: "visible", online: true, code: 1005 }] };
  const owner = { authorization: "Bearer fixture-owner-token" };
  const viewer = { cookie: `${DEVICE_COOKIE}=${paired.token}` };
  const post = (headers: Record<string, string>, origin = base, body: unknown = trace) => fetch(base + "/api/connection-diagnostics", { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    expect((await post({})).status).toBe(401);
    expect((await post(owner, "https://cross-site.invalid")).status).toBe(403);
    expect((await post(owner)).status).toBe(204);
    expect((await post(viewer)).status).toBe(204);
    const input = await fetch(base + "/api/pane/input", { method: "POST", headers: { ...viewer, origin: base, "content-type": "application/json" }, body: JSON.stringify({ pane_id: "not-a-real-pane", text: "never delivered" }) });
    expect(input.status).toBe(403);
    expect((await fetch(base + "/api/connection-diagnostics", { headers: owner })).status).toBe(405);
    expect((await post(owner, base, { ...trace, padding: "x".repeat(8192) })).status).toBe(413);
    expect((await post(owner)).status).toBe(204);
    expect((await post(owner)).status).toBe(429);
    const reports = lines.filter((line) => line.includes('"event":"client.connection_trace"'));
    expect(reports).toHaveLength(3);
    expect(reports.join("\n")).not.toContain("fixture-owner-token");
    expect(reports.join("\n")).not.toContain(paired.token);
    expect(reports.join("\n")).not.toContain("never delivered");
  } finally {
    app.stop(); warn.mockRestore(); rmSync(stateDir, { recursive: true, force: true });
  }
});
