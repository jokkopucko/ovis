import { afterAll, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine } from "../shared/machines.ts";
import { handleRequest, type ServerContext } from "./dispatch.ts";
import { unitHerdrOnly } from "../scripts/test-herdr.ts";
import { createServer } from "./index.ts";
import type { MachineManager } from "./machines.ts";
import { PortalService } from "./portal.ts";

// Another PC's move is the owner's, from any device the owner signed in or paired: this PC itself, the
// token, the owner's Tailscale login, a paired device that drives, or a relay device that drives (the
// owner's phone, another of the owner's PCs). Never an open LAN visitor, a Portal visitor, or a device
// that only watches.
afterAll(unitHerdrOnly());
const root = mkdtempSync(join(tmpdir(), "ovis-move-owner-"));
const TOKEN = "fictional-owner-token";
const open = createServer({ port: 0, hostname: "0.0.0.0", stateDir: join(root, "open"), token: "", tailscaleOwner: "owner@example.com", machines: false, sidecar: false });
// with a token and paired devices, which close the open LAN
const portal = new PortalService({ stateDir: join(root, "secured") });
const secured = createServer({ port: 0, hostname: "0.0.0.0", stateDir: join(root, "secured"), portal, token: TOKEN, tailscaleOwner: null, machines: false, sidecar: false });
afterAll(() => { open.stop(); secured.stop(); rmSync(root, { recursive: true, force: true }); });
const pcs: Pick<Machine, "id" | "kind">[] = [{ id: "pc", kind: "ssh" }];
const manager = { list: () => pcs, endpoint: () => undefined, retryNow: () => {}, moveOfferSoon: () => {} } as unknown as MachineManager;
const vouches = spyOn(portal, "vouches").mockImplementation((proof) => proof === "valid-proof");
const roleFor = spyOn(portal, "roleFor").mockReturnValue("drive");
afterAll(() => { vouches.mockRestore(); roleFor.mockRestore(); });
const store = secured.context.services.devices;
// a first pairing counts once its device has come back with its cookie (server/devices.ts), before the next one
const pairDevice = (label: string, role: "drive" | "watch"): string => {
  const token = store.pair(store.startPairing().code, label, role)!.token;
  store.match(token);
  return token;
};
const driveDevice = pairDevice("Owner's laptop", "drive");
const watchDevice = pairDevice("Wall screen", "watch");

const OWNERS = ["this PC", "the token", "a Tailscale login", "a paired device that drives", "a relay device that drives"] as const;
const OTHERS = ["an open LAN visitor", "a Portal visitor that drives", "a paired device that watches", "a relay device that watches"] as const;
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
function headersFor(kind: Kind, extra: Record<string, string>): Record<string, string> {
  // a request with no Host came through a proxy (access.ts cameThroughProxy): this PC's own browser names it
  const origin = { origin: "http://127.0.0.1", host: "127.0.0.1", "x-herdr-machine": "1", "content-type": "application/json", ...extra };
  switch (kind) {
    case "the token": return { ...origin, authorization: `Bearer ${TOKEN}` };
    case "a Tailscale login": return { ...origin, "tailscale-user-login": "owner@example.com", "x-forwarded-for": "100.64.0.1" };
    case "a paired device that drives": return { ...origin, cookie: `ovis_device=${driveDevice}` };
    case "a paired device that watches": return { ...origin, cookie: `ovis_device=${watchDevice}` };
    case "a Portal visitor that drives": return { ...origin, "x-portal-proof": "valid-proof", "x-portal-user": "visitor", "x-portal-auth": "credential" };
    default: return origin;
  }
}
const ask = async (kind: Kind, path: string, method = "GET", extra: Record<string, string> = {}, body?: unknown) => {
  const response = await handleRequest(new Request(`http://127.0.0.1/api/machines/${path}`, { method, headers: headersFor(kind, extra), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), contextFor(kind));
  if (!response) throw new Error("no answer");
  const answer = await response.json() as { error?: { code: string } };
  return [response.status, answer.error?.code ?? null];
};

const update = { "x-herdr-update": "1" };
const plans = { plans: [{ machine_id: "pc", revision: "shown" }] };
const ROUTES = [["pc/runtime/move", "GET"], ["pc/runtime/move", "POST"], ["pc/runtime/move/stop", "POST"], ["pc/runtime/move/stop-all", "POST"], ["pc/runtime/move/install", "POST"], ["runtime/move-all", "POST"]] as const;
const bodyFor = (path: string, method: string) => method === "GET" ? undefined : path === "runtime/move-all" ? plans : {};

it("each kind of access is the one it names", async () => {
  const auth = async (kind: Kind) => {
    const response = await handleRequest(new Request("http://127.0.0.1/api/health?scope=bridge", { headers: headersFor(kind, {}) }), contextFor(kind));
    const { via, role } = (await response!.json() as { auth: { via: string; role: string } }).auth;
    return `${via}/${role}`;
  };
  expect(await Promise.all([...OWNERS, ...OTHERS].map(auth))).toEqual(["local/drive", "token/drive", "tailscale/drive", "device/drive", "relay/drive", "open/drive", "portal/drive", "device/watch", "relay/watch"]);
});

it("lets the owner from this PC, the token, a Tailscale login, a paired or a relay device that drives move another PC or every PC; never an open LAN visitor, a Portal visitor or a device that watches", async () => {
  for (const kind of OWNERS) {
    for (const [path, method] of ROUTES) {
      const expected = path === "runtime/move-all" ? [202, null] : [503, "machine_offline"];
      expect([kind, path, method, ...await ask(kind, path, method, update, bodyFor(path, method))]).toEqual([kind, path, method, ...expected]);
    }
  }
  for (const kind of OTHERS) {
    for (const [path, method] of ROUTES) {
      const [status] = await ask(kind, path, method, update, bodyFor(path, method));
      expect([kind, path, method, status]).toEqual([kind, path, method, 403]);
    }
  }
});

it("takes the owner's change to another PC's move only from this app's own page, with no query", async () => {
  for (const kind of ["this PC", "a relay device that drives"] as const) {
    expect(await ask(kind, "pc/runtime/move", "POST", {}, { revision: "shown" })).toEqual([403, "forbidden"]);
    expect(await ask(kind, "runtime/move-all", "POST", {}, plans)).toEqual([403, "forbidden"]);
    // refused by the one guard over every change to this PC's PCs (machine-api.ts), as an update with a query is
    expect((await ask(kind, "pc/runtime/move?x=1", "POST", update, { revision: "shown" }))[0]).toBe(403);
    expect((await ask(kind, "runtime/move-all?x=1", "POST", update, plans))[0]).toBe(403);
  }
});
