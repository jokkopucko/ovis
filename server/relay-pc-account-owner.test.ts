import { afterAll, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest, type ServerContext } from "./dispatch.ts";
import { unitHerdrOnly } from "../scripts/test-herdr.ts";
import { createServer } from "./index.ts";
import type { MachineManager } from "./machines.ts";
import { PortalService } from "./portal.ts";

// Pairing this PC's server with another PC of the account (docs/account.md, "Adding a PC of your account") is the
// owner's, from a window direct to this PC that drives it: this PC itself, the token, the owner's Tailscale login, a
// device paired with it directly that drives. Never an open LAN window, a Portal visitor, a device on the relay or
// one that only watches: none of them may have this PC pair itself with a PC they name.
afterAll(unitHerdrOnly());
const root = mkdtempSync(join(tmpdir(), "ovis-account-pc-owner-"));
const TOKEN = "fictional-owner-token";
const open = createServer({ port: 0, hostname: "0.0.0.0", stateDir: join(root, "open"), token: "", tailscaleOwner: "owner@example.com", machines: false, sidecar: false });
const portal = new PortalService({ stateDir: join(root, "secured") });
const secured = createServer({ port: 0, hostname: "0.0.0.0", stateDir: join(root, "secured"), portal, token: TOKEN, tailscaleOwner: null, machines: false, sidecar: false });
afterAll(() => { open.stop(); secured.stop(); rmSync(root, { recursive: true, force: true }); });
const reached: string[] = [];
const manager = {
  list: () => [],
  checkAccountPcs: async () => { reached.push("check"); return []; },
  startAccountPc: async () => { reached.push("start"); return { ticket: "t", key: "k", label: "l" }; },
  pairAccountPc: async () => { reached.push("pair"); throw new Error("not under test"); },
} as unknown as MachineManager;
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
const OTHERS = ["an open LAN visitor", "a Portal visitor that drives", "a paired device that watches", "a relay device that drives", "a relay device that watches"] as const;
type Kind = typeof OWNERS[number] | typeof OTHERS[number];
const lan = { address: "192.168.0.20", family: "IPv4", port: 1 };
const loopback = { address: "127.0.0.1", family: "IPv4", port: 1 };

function contextFor(kind: Kind): ServerContext {
  const onOpen = kind === "this PC" || kind === "a Tailscale login" || kind === "an open LAN visitor";
  const app = onOpen ? open : secured;
  const base = { ...app.context, services: { ...app.context.services, core: { ...app.context.services.core, machines: manager } }, timeout: () => {} };
  if (kind === "a relay device that drives" || kind === "a relay device that watches") {
    const role = kind === "a relay device that drives" ? "drive" as const : "watch" as const;
    return { ...base, peer: { kind: "relay", device: { id: "0123456789abcdef", label: "Phone", role }, sessionId: "s", serverId: "0123456789abcdef0123456789abcdef", key: "" }, requestIP: () => null };
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
const BODIES = { check: { pcs: [] }, start: { pc: {} }, pair: { ticket: "t" } } as const;
const ROUTES = ["check", "start", "pair"] as const;
const ask = async (kind: Kind, route: keyof typeof BODIES) => {
  const response = await handleRequest(new Request(`http://127.0.0.1/api/machines/relay/account/${route}`, { method: "POST", headers: headersFor(kind), body: JSON.stringify(BODIES[route]) }), contextFor(kind));
  if (!response) throw new Error("no answer");
  return response.status;
};

it("lets the owner's direct windows ask whether PCs of the account would pair, start a pairing and compare its digits", async () => {
  for (const kind of OWNERS) for (const route of ROUTES) {
    reached.length = 0;
    expect([kind, route, await ask(kind, route), reached]).toEqual([kind, route, 200, [route]]);
  }
});

it("never lets an open LAN window, a Portal visitor, a relay device or a watching device reach it", async () => {
  for (const kind of OTHERS) for (const route of ROUTES) {
    reached.length = 0;
    expect([kind, route, await ask(kind, route), reached]).toEqual([kind, route, 403, []]);
  }
});
