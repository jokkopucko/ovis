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
import { SshConnection } from "./ssh.ts";

// Every change to this PC's PCs goes through one rule: the owner, from any device he signed in or paired himself, from
// this app's own page.
const base: AccessInput = { loopback: true, forwarded: false, funnel: false, tailscaleLogin: null, forwardedFor: null, host: null, tokenMatched: false, device: null, owner: null, tagged: false,
  soleLogin: null, dnsName: null, tailnetIp: null, serveOnly: false, tokenConfigured: false, gated: false };
const drive = { id: "d1", label: "Phone", role: "drive" as const };
const watch = { ...drive, role: "watch" as const };
const KINDS: [string, Partial<AccessInput>, boolean][] = [
  ["a sign-in on this PC", {}, true],
  ["this PC's token", { loopback: false, tokenMatched: true, tokenConfigured: true }, true],
  ["this PC's Tailscale login", { tailscaleLogin: "me@x.com", owner: "me@x.com", forwardedFor: "100.64.0.9" }, true],
  ["a driving device paired here", { loopback: false, device: drive, gated: true }, true],
  ["a driving device paired over the relay", { relayPeer: drive as AccessInput["relayPeer"] }, true],
  ["an open-LAN visitor with nothing paired", { loopback: false }, false],
  ["a Portal visitor that drives", { portal: { proven: true, user: "guest", auth: "credential", role: "drive" } }, false],
  ["a watching device paired here", { loopback: false, device: watch, gated: true }, false],
  ["a watching device over the relay", { relayPeer: watch as AccessInput["relayPeer"] }, false],
];
const PC = "00000000-0000-4000-8000-000000000001";
const ROUTES: [string, string, unknown][] = [
  ["POST", "setup", { destination: "me@pc.invalid" }],
  ["POST", "setup/no-such-job", { action: "answer", challenge_id: "x", answer: "yes" }],
  ["DELETE", "setup/no-such-job", undefined],
  ["PATCH", "settings", { auto_update_bridges: false }],
  ["PATCH", PC, { name: "Lab" }],
  ["PATCH", PC, { enabled: true }],
  ["DELETE", PC, undefined],
  ["POST", `${PC}/update`, undefined],
  ["DELETE", `${PC}/update`, undefined],
  ["POST", "update-all", undefined],
  ["POST", `${PC}/update-bridge`, undefined],
  ["POST", "relay", { link: "x" }],
  ["POST", "relay/code", { code: "x" }],
  ["POST", "tailnet", { url: "x" }],
  ["POST", "install", { destination: "me@pc.invalid" }],
  ["DELETE", "install/no-such-job", undefined],
];

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function manager() {
  const dir = mkdtempSync(join(tmpdir(), "ovis-owner-guard-"));
  const reconnect = spyOn(MachineManager.prototype as unknown as { reconnect(): Promise<void> }, "reconnect").mockImplementation(async () => {});
  const ssh = spyOn(SshConnection.prototype, "start").mockImplementation(async () => { throw new Error("isolated: no SSH"); });
  const made = new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("isolated local offline"); });
  cleanups.push(() => { made.stop(); reconnect.mockRestore(); ssh.mockRestore(); rmSync(dir, { recursive: true, force: true }); });
  return made;
}

describe("every change to this PC's PCs", () => {
  for (const [who, input, allowed] of KINDS) it(`${allowed ? "is let through" : "is refused"} for ${who}`, async () => {
    const pcs = manager();
    const access = decideAccess({ ...base, ...input });
    const owner = ownerAccess(access);
    const readOnly = access.level === "full" && access.role === "watch";
    for (const [method, path, body] of ROUTES) for (const header of [true, false]) {
      const response = await handleMachineRequest(new Request(`http://localhost:7317/api/machines/${path}`, { method,
        headers: { origin: "http://localhost:7317", "x-herdr-machine": "1", "content-type": "application/json", ...(header ? { "x-herdr-update": "1" } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), pcs, undefined, undefined, readOnly, undefined, undefined, undefined, undefined, owner);
      const refused = response.status === 403;
      // the owner gets past the guard only from this app's own page (the update header); the PC or job need not exist
      expect({ who, method, path, header, refused }).toEqual({ who, method, path, header, refused: !(allowed && header) });
    }
  });
});

describe("this PC's own update routes", () => {
  it("take the same rule: an open-LAN visitor is refused, a sign-in on this PC is let through (install, check, herdr)", async () => {
    const state = mkdtempSync(join(tmpdir(), "ovis-owner-guard-server-"));
    const open = createServer({ port: 0, hostname: "127.0.0.1", stateDir: state, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false });
    cleanups.push(() => { open.stop(); rmSync(state, { recursive: true, force: true }); });
    // a check installs too where OVIS_AUTO_UPDATE=1, so it takes the same rule
    for (const [path, body] of [["/api/updates/install", { expected_revision: "a".repeat(40) }], ["/api/herdr/update", undefined], ["/api/updates/check", undefined]] as const) {
      const post = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${open.port}${path}`, { method: "POST", headers: { "x-herdr-update": "1", "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const visitor = await post({ "x-forwarded-for": "192.168.0.20" });
      expect([path, visitor.status]).toEqual([path, 403]);
      expect([path, (await post({})).status === 403]).toEqual([path, false]);
    }
  });
});
