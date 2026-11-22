import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideAccess, ownerAccess, type AccessInput } from "./access.ts";
import type { CompletionTracker } from "./completion.ts";
import { createServer } from "./index.ts";
import { handleMachineRequest } from "./machine-api.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";

// Changing what runs on this PC's PCs is the owner's, from any device he paired (relay included): never an open-LAN
// visitor's, a Portal visitor's or a watching device's.
const base: AccessInput = { loopback: true, forwarded: false, funnel: false, tailscaleLogin: null, forwardedFor: null, host: null, tokenMatched: false, device: null, owner: null, tagged: false,
  soleLogin: null, dnsName: null, tailnetIp: null, serveOnly: false, tokenConfigured: false, gated: false };
const drive = { id: "d1", label: "Phone", role: "drive" as const };

describe("who may update every PC", () => {
  const owner = (input: Partial<AccessInput>) => ownerAccess(decideAccess({ ...base, ...input }));
  it("is the owner from any device he paired: on this PC, its token, its Tailscale login, a device paired here or over the relay, that drives", () => {
    expect(owner({})).toBe(true);
    expect(owner({ loopback: false, tokenMatched: true, tokenConfigured: true })).toBe(true);
    expect(owner({ loopback: false, device: drive, gated: true })).toBe(true);
    expect(owner({ loopback: true, tailscaleLogin: "me@x.com", owner: "me@x.com", forwardedFor: "100.64.0.9" })).toBe(true);
    expect(owner({ relayPeer: { ...drive } as AccessInput["relayPeer"] })).toBe(true);
  });
  it("is never an open-LAN visitor (nothing paired), a Portal visitor, or a device that only watches", () => {
    expect(owner({ loopback: false })).toBe(false);
    expect(owner({ loopback: false, device: { ...drive, role: "watch" }, gated: true })).toBe(false);
    expect(owner({ portal: { proven: true, user: "guest", auth: "credential", role: "drive" } })).toBe(false);
    expect(owner({ relayPeer: { ...drive, role: "watch" } as AccessInput["relayPeer"] })).toBe(false);
  });
});

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

describe("the update routes", () => {
  const manager = () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-update-access-"));
    const reconnect = spyOn(MachineManager.prototype as unknown as { reconnect(): Promise<void> }, "reconnect").mockImplementation(async () => {});
    const made = new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("isolated local offline"); });
    cleanups.push(() => { made.stop(); reconnect.mockRestore(); rmSync(dir, { recursive: true, force: true }); });
    return made;
  };
  const ask = (pcs: MachineManager, path: string, owner: boolean, headers: Record<string, string> = { "x-herdr-update": "1" }, method = "POST") =>
    handleMachineRequest(new Request(`http://localhost:7317/api/machines/${path}`, { method, headers: { origin: "http://localhost:7317", "x-herdr-machine": "1", ...headers } }),
      pcs, undefined, undefined, false, undefined, undefined, undefined, undefined, owner);
  for (const path of ["update-all", "00000000-0000-4000-8000-000000000001/update"]) it(`refuses ${path} to anyone but the owner, and without its update header or with a query`, async () => {
    const pcs = manager();
    const refused = await ask(pcs, path, false);
    expect(refused.status).toBe(403);
    expect((await refused.json() as { error: { code: string } }).error.code).toBe("forbidden");
    expect((await ask(pcs, path, true, {})).status).toBe(403);
    expect((await ask(pcs, `${path}?x=1`, true)).status).toBe(403);
    expect((await ask(pcs, path, false, { "x-herdr-update": "1" }, "DELETE")).status).toBe(403);
    expect((await ask(pcs, path, true)).status).not.toBe(403);
  });

  it("refuses an open-LAN visitor through the server, and lets this PC's owner in", async () => {
    const state = mkdtempSync(join(tmpdir(), "ovis-update-open-"));
    // on loopback only: a visitor of an open install is told by the forwarded address it comes from (access.ts)
    const open = createServer({ port: 0, hostname: "127.0.0.1", stateDir: state, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false });
    cleanups.push(() => { open.stop(); rmSync(state, { recursive: true, force: true }); });
    const post = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${open.port}/api/machines/update-all`, { method: "POST", headers: { "x-herdr-machine": "1", "x-herdr-update": "1", ...headers } });
    expect((await post({ "x-forwarded-for": "192.168.0.20" })).status).toBe(403);
    expect((await post({})).status).toBe(202);
    const as = (path: string, method: string, body: unknown) => fetch(`http://127.0.0.1:${open.port}/api/machines/${path}`, { method, headers: { "x-herdr-machine": "1", "x-herdr-update": "1", "content-type": "application/json", "x-forwarded-for": "192.168.0.20" }, body: JSON.stringify(body) });
    expect((await as("00000000-0000-4000-8000-000000000001", "PATCH", { enabled: true })).status).toBe(403);
    expect((await as("setup/no-such-job", "POST", { action: "approve" })).status).toBe(403);
  });
});
