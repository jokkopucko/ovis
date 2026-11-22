import { afterAll, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest, type ServerContext } from "./dispatch.ts";
import { unitHerdrOnly } from "../scripts/test-herdr.ts";
import { createServer } from "./index.ts";
import type { MachineManager } from "./machines.ts";
import { PortalService } from "./portal.ts";

// Adding another PC's Ovis by its address leaves this PC holding a device token that drives that PC, so it is the
// owner's, from a window direct to this PC that drives it. Never an open LAN window, a Portal visitor, a device on the
// relay or one that only watches; and the code goes only over HTTPS or to localhost.
afterAll(unitHerdrOnly());
const root = mkdtempSync(join(tmpdir(), "ovis-address-pc-owner-"));
const TOKEN = "fictional-owner-token";
const open = createServer({ port: 0, hostname: "0.0.0.0", stateDir: join(root, "open"), token: "", tailscaleOwner: "owner@example.com", machines: false, sidecar: false });
const portal = new PortalService({ stateDir: join(root, "secured") });
const secured = createServer({ port: 0, hostname: "0.0.0.0", stateDir: join(root, "secured"), portal, token: TOKEN, tailscaleOwner: null, machines: false, sidecar: false });
afterAll(() => { open.stop(); secured.stop(); rmSync(root, { recursive: true, force: true }); });
let reached = 0;
const manager = { list: () => [], addAddress: async () => { reached++; return { id: "added" }; } } as unknown as MachineManager;
const vouches = spyOn(portal, "vouches").mockImplementation((proof) => proof === "valid-proof");
const roleFor = spyOn(portal, "roleFor").mockReturnValue("drive");
afterAll(() => { vouches.mockRestore(); roleFor.mockRestore(); });
const store = secured.context.services.devices;
const pairDevice = (label: string, role: "drive" | "watch"): string => {
  const token = store.pair(store.startPairing().code, label, role)!.token;
  store.match(token);
  return token;
};
const driveDevice = pairDevice("Owner's laptop", "drive");
const watchDevice = pairDevice("Wall screen", "watch");

const OWNERS = ["this PC", "the token", "a Tailscale login", "a paired device that drives"] as const;
const OTHERS = ["an open LAN visitor", "a Portal visitor that drives", "a paired device that watches", "a relay device that drives"] as const;
type Kind = typeof OWNERS[number] | typeof OTHERS[number];
const lan = { address: "192.168.0.20", family: "IPv4", port: 1 };
const loopback = { address: "127.0.0.1", family: "IPv4", port: 1 };

function contextFor(kind: Kind): ServerContext {
  const app = kind === "this PC" || kind === "a Tailscale login" || kind === "an open LAN visitor" ? open : secured;
  const base = { ...app.context, services: { ...app.context.services, core: { ...app.context.services.core, machines: manager } }, timeout: () => {} };
  if (kind === "a relay device that drives") {
    return { ...base, peer: { kind: "relay", device: { id: "0123456789abcdef", label: "Phone", role: "drive" }, sessionId: "s", serverId: "0123456789abcdef0123456789abcdef", key: "" }, requestIP: () => null };
  }
  return { ...base, requestIP: () => kind === "this PC" || kind === "a Tailscale login" ? loopback : lan };
}
function headersFor(kind: Kind): Record<string, string> {
  const origin = { origin: "http://127.0.0.1", host: "127.0.0.1", "x-herdr-machine": "1", "x-herdr-update": "1", "content-type": "application/json" };
  switch (kind) {
    case "the token": return { ...origin, authorization: `Bearer ${TOKEN}` };
    case "a Tailscale login": return { ...origin, "tailscale-user-login": "owner@example.com", "x-forwarded-for": "100.64.0.1" };
    case "a paired device that drives": return { ...origin, cookie: `ovis_device=${driveDevice}` };
    case "a paired device that watches": return { ...origin, cookie: `ovis_device=${watchDevice}` };
    case "a Portal visitor that drives": return { ...origin, "x-portal-proof": "valid-proof", "x-portal-user": "visitor", "x-portal-auth": "credential" };
    default: return origin;
  }
}
const ask = async (kind: Kind, url = "http://127.0.0.1/api/machines/address") => {
  const response = await handleRequest(new Request(url, { method: "POST", headers: headersFor(kind), body: JSON.stringify({ address: "https://desk.example.ts.net", code: "123456" }) }), contextFor(kind));
  if (!response) throw new Error("no answer");
  return { status: response.status, code: response.status === 201 ? null : (await response.json() as { error: { code: string } }).error.code };
};

it("lets the owner's direct windows add a PC by its address", async () => {
  for (const kind of OWNERS) {
    reached = 0;
    expect([kind, await ask(kind), reached]).toEqual([kind, { status: 201, code: null }, 1]);
  }
});

it("never lets an open LAN window, a Portal visitor, a relay device or a watching device reach it", async () => {
  const refusal = { "an open LAN visitor": "owner_only", "a Portal visitor that drives": "owner_only", "a relay device that drives": "owner_only", "a paired device that watches": "read_only" } as const;
  for (const kind of OTHERS) {
    reached = 0;
    expect([kind, await ask(kind), reached]).toEqual([kind, { status: 403, code: refusal[kind] }, 0]);
  }
});

it("takes the code only over HTTPS or from localhost", async () => {
  reached = 0;
  const response = await handleRequest(new Request("http://desk.lan/api/machines/address", { method: "POST", headers: { ...headersFor("a paired device that drives"), origin: "http://desk.lan", host: "desk.lan" }, body: "{}" }), contextFor("a paired device that drives"));
  expect([response?.status, (await response!.json() as { error: { code: string } }).error.code]).toEqual([403, "https_required"]);
  expect(reached).toBe(0);
});
