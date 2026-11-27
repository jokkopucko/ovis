import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function server() {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-own-window-"));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, machines: false, sidecar: false });
  cleanup.push(() => { app.stop(); rmSync(stateDir, { recursive: true, force: true }); });
  return { app, stateDir, base: `http://127.0.0.1:${app.port}` };
}

const health = async (base: string, headers: Record<string, string> = {}) => (await fetch(`${base}/api/health?scope=bridge`, { headers })).json() as Promise<{ own_window?: { port: number } }>;

it("tells this PC's own window the port it signs in back to, and no forwarded window", async () => {
  const { app, base } = server();
  expect((await health(base)).own_window).toEqual({ port: app.port });
  expect((await health(base, { "x-forwarded-for": "100.64.0.9", "x-forwarded-proto": "https" })).own_window).toBeUndefined();
});

it("serves the sign-in return as the app's page and never logs or keeps its code", async () => {
  const { base, stateDir } = server();
  const answer = await fetch(`${base}/callback?code=secret-code-123&state=secret-state-456`);
  expect(answer.status).toBe(200);
  expect(answer.headers.get("cache-control")).toBe("no-store");
  await answer.arrayBuffer();
  const log = readFileSync(join(stateDir, "http-requests.jsonl"), "utf8");
  expect(log).toContain('"route":"static"');
  expect(log).not.toContain("secret-code-123");
  expect(log).not.toContain("secret-state-456");
});

it("lists and decides account joins for this PC's own window only, and never without the digits", async () => {
  const { app, base } = server();
  const approvals = app.context.services.relay.approvals;
  const waiting = approvals.ask("Tablet", "654321", Date.now() + 90_000, { intent: "account", key: "k2", deviceId: "d2", membersOnly: true })!;
  const forwarded = { "x-forwarded-for": "100.64.0.9", "x-forwarded-proto": "https" };
  const other = await fetch(`${base}/api/relay/joins`, { headers: forwarded });
  expect(other.status).not.toBe(200);
  expect(await other.text()).not.toContain("Tablet");
  const own = await (await fetch(`${base}/api/relay/joins`)).json() as { joins: { id: string }[] };
  expect(own.joins).toHaveLength(1);
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/relay/join`, { method: "POST", headers: { origin: base, "x-herdr-update": "1", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  expect((await post({ id: own.joins[0]!.id, digits: "654321" }, forwarded)).status).not.toBe(200);
  expect((await post({ id: own.joins[0]!.id })).status).toBe(400);
  expect((await post({ id: own.joins[0]!.id, digits: "654321" })).status).toBe(200);
  // decided in this PC's own window: the approval says so
  expect(await waiting.decision).toEqual({ approved: true, own: true });
});
