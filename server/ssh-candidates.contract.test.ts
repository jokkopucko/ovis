import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CompletionTracker } from "./completion.ts";
import { createServer } from "./index.ts";
import { handleMachineRequest } from "./machine-api.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";

// GET /api/machines/ssh-candidates on a live server: the owner's window gets the list, an open LAN window and a
// watching device do not (server/dispatch.ts, server/machine-api.ts)
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function sshDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-ssh-candidates-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const status = (peers: string[]): string => JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "self.tail.ts.net.", UserID: 1 },
  Peer: Object.fromEntries(peers.map((name, index) => [`k${index}`, { DNSName: `${name}.tail.ts.net.`, UserID: 1, Online: true, OS: "linux" }])),
});

it("answers the owner's window with the list, and refuses an open LAN window and a watching device", async () => {
  const dir = sshDir({ config: "Host nuc12\n  HostName 100.127.218.1\n  User rise\nHost *\n" });
  const state = sshDir({});
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: state, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false,
    sshCandidates: { sshDir: dir, readStatus: async () => status(["winvm"]) } });
  cleanup.push(() => { void server.stop(); });
  const base = `http://127.0.0.1:${server.port}`;
  const owner = await fetch(`${base}/api/machines/ssh-candidates`, { headers: { origin: base } });
  expect(owner.status).toBe(200);
  expect((await owner.json() as { pcs: { destination: string }[] }).pcs.map((pc) => pc.destination)).toEqual(["nuc12", "winvm.tail.ts.net"]);
  const fromLan = await fetch(`${base}/api/machines/ssh-candidates`, { headers: { origin: base, "x-forwarded-for": "192.168.1.5" } });
  expect(fromLan.status).toBe(403);
  expect((await fromLan.json() as { error: { code: string } }).error.code).toBe("owner_only");

  let read = 0;
  const manager = new MachineManager(state, {} as PushService, {} as CompletionTracker, async () => { throw new Error("local offline"); },
    { sshCandidates: { sshDir: dir, readStatus: async () => { read++; return null; } } });
  const watching = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/ssh-candidates"), manager, undefined, undefined, true);
  expect(watching.status).toBe(403);
  expect(read).toBe(0);
  manager.stop();
});
