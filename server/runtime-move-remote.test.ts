import { afterAll, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrRuntimeFacts } from "../shared/machines.ts";
import type { ServerContext } from "./dispatch.ts";
import { handleRequest } from "./dispatch.ts";
import type { RuntimeService } from "./herdr-core/runtime-choice.ts";
import { unitHerdrOnly } from "../scripts/test-herdr.ts";
import { createServer } from "./index.ts";
import { PortalService } from "./portal.ts";

// The PC being moved from another one: its connection server reaches it with the bridge token
// (an SSH PC) or as a paired relay device. The Herdr app is installed here, so no move is offered
// and nothing reaches herdr; what is checked is who gets past each route's gate.
afterAll(unitHerdrOnly());
const SECRET = "fictional-browser-token";
const BRIDGE = "fictional-bridge-token";
const stateDir = mkdtempSync(join(tmpdir(), "ovis-runtime-move-remote-"));
const facts_: HerdrRuntimeFacts = { serving: "herdr", source: "detected", tui: { installed: true, running: true }, app_installed: true, switch_to: "herdr-core", locked: null };
const runtimeService: RuntimeService = { facts: () => facts_, request: () => ({ ok: false, status: 409, code: "runtime_locked", message: "test" }) };
const portal = new PortalService({ stateDir });
const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, portal, token: SECRET, bridgeToken: BRIDGE, tailscaleOwner: null, machines: false, sidecar: false, runtimeService });
afterAll(() => { app.stop(); rmSync(stateDir, { recursive: true, force: true }); });

const base = `http://127.0.0.1:${app.port}`;
const bridge = { authorization: `Bearer ${BRIDGE}` };
const send = async (path: string, method: string, headers: Record<string, string>, body?: unknown) => {
  const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const answer = await response.json() as { error?: { code: string } };
  return [response.status, answer.error?.code ?? null];
};

it("lets the connection server holding the bridge token read and run this PC's move, behind the same header and no-query gate", async () => {
  const plan = await fetch(`${base}/api/runtime/move`, { headers: bridge });
  expect([plan.status, await plan.json()]).toEqual([200, { available: false, reason: "herdr_app", status: { state: "idle" } }]);
  const update = { ...bridge, "x-herdr-update": "1" };
  // each passes the gate and gets the move's own answer
  expect(await send("/api/runtime/move", "POST", update, { revision: "shown" })).toEqual([409, "unavailable"]);
  expect(await send("/api/runtime/move", "DELETE", update)).toEqual([200, null]);
  expect(await send("/api/runtime/move/stop-all", "POST", update, {})).toEqual([409, "not_waiting"]);
  expect(await send("/api/runtime/move/stop", "POST", update, { pane_id: "w1:p1" })).toEqual([409, "not_waiting"]);
  expect(await send("/api/runtime/move/install", "POST", update)).toEqual([409, "unavailable"]);
  // without the app's header, or with a query, as for any other driver
  expect(await send("/api/runtime/move", "POST", bridge, { revision: "shown" })).toEqual([403, "forbidden"]);
  expect(await send("/api/runtime/move?x=1", "POST", update, { revision: "shown" })).toEqual([403, "forbidden"]);
  // another token opens nothing, and the bridge token opens no runtime switch
  expect((await fetch(`${base}/api/runtime/move`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  expect((await send("/api/runtime", "POST", update, { runtime: "herdr-core" }))[0]).toBe(401);
});

it("holds an install's request open for the whole install, past the usual minute", async () => {
  const seconds: number[] = [];
  const ctx: ServerContext = { ...app.context, requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 1 }), timeout: (_request, value) => { seconds.push(value); } };
  const response = await handleRequest(new Request(`${base}/api/runtime/move/install`, { method: "POST", headers: { ...bridge, "x-herdr-update": "1" } }), ctx);
  expect(response?.status).toBe(409);
  // the last word on this request's timeout is the install's: its download alone may take 120 s
  expect(seconds.at(-1)).toBe(180);
});

it("tells the runtime facts to the bridge token in the bridge's own health answer", async () => {
  const health = await (await fetch(`${base}/api/health?scope=bridge`, { headers: bridge })).json() as { herdr_runtime?: HerdrRuntimeFacts };
  expect(health.herdr_runtime).toEqual(facts_);
});

it("lets a relay device that drives this PC read its move, and refuses one that watches", async () => {
  for (const role of ["drive", "watch"] as const) {
    const ctx: ServerContext = { ...app.context, peer: { kind: "relay", device: { id: "0123456789abcdef", label: "Ovis on another PC", role }, sessionId: `s-${role}`, serverId: "0123456789abcdef0123456789abcdef", key: "" }, requestIP: () => null, timeout: () => {} };
    const response = await handleRequest(new Request("https://relay.ovis.invalid/api/runtime/move"), ctx);
    expect([role, response?.status]).toEqual([role, role === "drive" ? 200 : 403]);
  }
});

it("refuses a Portal visitor that drives this PC: moving its runtime is the owner's", async () => {
  const vouches = spyOn(portal, "vouches").mockReturnValue(true);
  const roleFor = spyOn(portal, "roleFor").mockReturnValue("drive");
  try {
    const visitor = { "x-portal-proof": "proof", "x-portal-user": "visitor", "x-portal-auth": "credential", "x-herdr-update": "1" };
    expect(await send("/api/runtime/move", "GET", visitor)).toEqual([403, "forbidden"]);
    for (const path of ["/api/runtime/move", "/api/runtime/move/stop", "/api/runtime/move/stop-all", "/api/runtime/move/install"]) {
      expect([path, ...await send(path, "POST", visitor, {})]).toEqual([path, 403, "forbidden"]);
    }
  } finally { vouches.mockRestore(); roleFor.mockRestore(); }
});

it("refuses a Portal visitor that drives this PC a runtime switch, before the switch is asked", async () => {
  const vouches = spyOn(portal, "vouches").mockReturnValue(true);
  const roleFor = spyOn(portal, "roleFor").mockReturnValue("drive");
  const switches = spyOn(runtimeService, "request").mockReturnValue({ ok: true });
  try {
    const visitor = { "x-portal-proof": "proof", "x-portal-user": "visitor", "x-portal-auth": "credential", "x-herdr-update": "1" };
    expect(await send("/api/runtime", "POST", visitor, { runtime: "herdr-core" })).toEqual([403, "forbidden"]);
    expect(switches).not.toHaveBeenCalled();
    // the owner on this app's page still switches
    expect(await send("/api/runtime", "POST", { authorization: `Bearer ${SECRET}`, "x-herdr-update": "1" }, { runtime: "herdr-core" })).toEqual([202, null]);
    expect(switches).toHaveBeenCalledTimes(1);
    // nor is it told the runtime facts a switch is offered from
    const facts = async (headers: Record<string, string>) => (await (await fetch(`${base}/api/health?scope=bridge`, { headers })).json() as { herdr_runtime?: unknown }).herdr_runtime;
    expect(await facts(visitor)).toBeUndefined();
    expect(await facts({ authorization: `Bearer ${SECRET}` })).toEqual(facts_);
  } finally { vouches.mockRestore(); roleFor.mockRestore(); switches.mockRestore(); }
});
