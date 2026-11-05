import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type BridgeIdentity, type Machine, type SshTarget } from "../shared/machines.ts";
import type { BridgeDescriptor } from "./bridge.ts";
import type { CompletionTracker } from "./completion.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";
import { posixHost } from "./remote-host.ts";
import { SshConnection } from "./ssh.ts";

type Runtime = { machine: Machine; ssh?: SshConnection; generation: number; retry?: ReturnType<typeof setTimeout> };
type Verified = { endpoint: { url: string; token: string }; identity: BridgeIdentity };
type Internals = {
  runtime(machine: Machine): Runtime;
  machines: Map<string, Runtime>;
  autoChain: Promise<void>;
  prepare(runtime: Runtime): Promise<void>;
  verify(ssh: SshConnection, descriptor: BridgeDescriptor, socket: string): Promise<Verified>;
  reconnect(runtime: Runtime): Promise<void>;
  disconnect(runtime: Runtime): void;
  observe(runtime: Runtime): Promise<void>;
};
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ovis-independent-reconnect-"));
  const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("fixture local offline"); });
  const internals = manager as unknown as Internals;
  const target: SshTarget = { destination: "fixture-pc", session: "fixture-session" };
  const runtime = internals.runtime({ id: "fixture", kind: "ssh", name: "Fixture", target, enabled: true, state: "disconnected", snapshot: null, error: null });
  internals.machines.set(runtime.machine.id, runtime);
  const remote = {
    socket: "/home/fixture/.config/herdr/sessions/fixture-session/herdr.sock",
    present: true, alive: true, bundle: "", managed: false,
    version: REMOTE_BUNDLE_VERSION, protocol: BRIDGE_PROTOCOL, pid: 12345,
  };
  const commands: string[] = [];
  const descriptor = (): BridgeDescriptor => ({ pid: remote.pid, port: 17317, token: "a".repeat(64), socket_path: remote.socket, bridge_protocol: remote.protocol, bundle_version: remote.version, managed_remote: remote.managed });
  const inspection = () => `Linux\nx86_64\n/home/fixture\n/home/fixture/.config\n/usr/bin/herdr\n${remote.bundle}\n${remote.present ? JSON.stringify(descriptor()) : ""}\n`;
  const run = spyOn(SshConnection.prototype, "run").mockImplementation(async (script) => {
    commands.push(script);
    if (script.includes("uname")) return inspection();
    if (script.startsWith("socket=")) return remote.socket;
    if (script.includes("--version")) return "herdr 0.9.5";
    if (script.startsWith("kill -0")) return remote.alive ? "live" : "";
    throw new Error(`Unexpected remote mutation: ${script}`);
  });
  const start = spyOn(SshConnection.prototype, "start").mockImplementation(async () => {});
  const close = spyOn(SshConnection.prototype, "close").mockImplementation(() => {});
  const verify = spyOn(internals, "verify").mockImplementation(async () => ({
    endpoint: { url: "http://127.0.0.1:1", token: "fixture-token" },
    identity: { ...descriptor(), managed_remote: remote.managed, socket_id: "fixture-socket", herdr: { version: "0.9.5", protocol: 22 } },
  }));
  runtime.ssh = new SshConnection(target, dir);
  cleanups.push(() => { manager.stop(); verify.mockRestore(); close.mockRestore(); start.mockRestore(); run.mockRestore(); rmSync(dir, { recursive: true, force: true }); });
  return { manager, internals, runtime, remote, commands, verify, run, inspection, dir };
}

describe("independent bridge successor ownership", () => {
  for (const successor of ["independent", "unverified"] as const) it(`does not install from an incompatible managed hint when the retained owner's successor is ${successor}`, async () => {
    const { internals, runtime, remote, verify } = fixture();
    await internals.prepare(runtime);
    remote.managed = true; remote.version = "older";
    const install = spyOn(posixHost, "installBundle").mockImplementation(async () => {});
    cleanups.push(() => install.mockRestore());
    verify.mockImplementation(async () => {
      if (successor === "unverified") throw new Error("temporary identity failure");
      return { endpoint: { url: "http://127.0.0.1:1", token: "fixture" }, identity: {
        pid: remote.pid, managed_remote: false, bridge_protocol: BRIDGE_PROTOCOL,
        bundle_version: remote.version, socket_path: remote.socket, socket_id: "fixture-socket",
        herdr: { version: "0.9.5", protocol: 22 },
      } };
    });
    await internals.reconnect(runtime);
    await internals.autoChain;
    expect(install).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledTimes(2);
    expect(runtime.machine.action_required).toBe(successor === "independent" ? "setup" : null);
    expect(runtime.machine.state).toBe(successor === "independent" ? "error" : "reconnecting");
  });

  it("verifies a managed incompatible successor before offering an update", async () => {
    const { internals, runtime, remote, verify } = fixture();
    await internals.prepare(runtime);
    remote.managed = true; remote.version = "older";
    await expect(internals.prepare(runtime)).rejects.toMatchObject({ action: "update_bridge" });
    expect(verify).toHaveBeenCalledTimes(2);
  });

  for (const mismatch of ["pid", "newer", "cancelled"] as const) it(`refuses an incompatible successor after ${mismatch} ownership verification`, async () => {
    const { internals, runtime, remote, verify } = fixture();
    await internals.prepare(runtime);
    remote.managed = true; remote.version = "older";
    verify.mockImplementationOnce(async () => {
      if (mismatch === "cancelled") runtime.generation++;
      return { endpoint: { url: "http://127.0.0.1:1", token: "fixture" }, identity: {
        pid: remote.pid + (mismatch === "pid" ? 1 : 0), managed_remote: true,
        bridge_protocol: BRIDGE_PROTOCOL,
        bundle_version: mismatch === "newer" ? String(Number(REMOTE_BUNDLE_VERSION) + 1) : remote.version,
        socket_path: remote.socket, socket_id: "fixture-socket", herdr: { version: "0.9.5", protocol: 22 },
      } };
    });
    if (mismatch === "newer") await expect(internals.prepare(runtime)).rejects.toMatchObject({ action: "bridge_conflict" });
    else await expect(internals.prepare(runtime)).rejects.toThrow(mismatch === "pid" ? "Bridge process verification failed" : "Setup cancelled");
    remote.present = false; remote.bundle = "bundle-ready";
    await expect(internals.prepare(runtime)).rejects.toThrow("This PC's own Ovis is not running");
  });

  it("retains the independent owner when a compatible successor reports a different PID", async () => {
    const { internals, runtime, remote, verify, commands } = fixture();
    await internals.prepare(runtime);
    remote.managed = true;
    verify.mockImplementationOnce(async () => ({
      endpoint: { url: "http://127.0.0.1:1", token: "fixture" },
      identity: {
        pid: remote.pid + 1, managed_remote: true, bridge_protocol: BRIDGE_PROTOCOL,
        bundle_version: REMOTE_BUNDLE_VERSION, socket_path: remote.socket,
        socket_id: "fixture-socket", herdr: { version: "0.9.5", protocol: 22 },
      },
    }));
    await expect(internals.prepare(runtime)).rejects.toThrow("Bridge process verification failed");
    remote.present = false; remote.bundle = "bundle-ready";
    await expect(internals.prepare(runtime)).rejects.toThrow("This PC's own Ovis is not running");
    expect(commands.some(script => script.includes("nohup") || script.includes("mkdir"))).toBe(false);
  });

  it("clears the observation after verifying a managed successor", async () => {
    const { internals, runtime, remote } = fixture();
    await internals.prepare(runtime);
    remote.managed = true;
    await internals.prepare(runtime);
    remote.present = false;
    await expect(internals.prepare(runtime)).rejects.toMatchObject({ action: "setup" });
  });

  for (const bundle of ["", "bundle-ready"]) it(`retains the independent owner after transient successor verification failure (${bundle || "no bundle"})`, async () => {
    const { internals, runtime, remote, verify, commands } = fixture();
    await internals.prepare(runtime);
    remote.pid++;
    verify.mockRejectedValueOnce(new Error("temporary SSH forward failure"));
    await expect(internals.prepare(runtime)).rejects.toThrow("temporary SSH forward failure");
    remote.present = false; remote.bundle = bundle;
    await expect(internals.prepare(runtime)).rejects.toThrow("This PC's own Ovis is not running");
    expect(commands.some(script => script.includes("nohup") || script.includes("mkdir"))).toBe(false);
  });

});
