import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineManager } from "./machines.ts";
import type { Machine } from "../shared/machines.ts";
import type { HerdrMachineProfile } from "./herdr-profiles.ts";
import type { CompletionTracker } from "./completion.ts";
import type { PushService } from "./push.ts";
import { HerdrProfileState } from "./herdr-profile-state.ts";
import { SshConnection } from "./ssh.ts";

const profile: HerdrMachineProfile = { id: "source-a", label: "Build machine", enabled: true, target: { destination: "BuildBox", port: 2222, session: "agents" } };
type Runtime = { machine: Machine; generation: number; terminals: Set<() => void> };
type Internals = { profileState: HerdrProfileState; mayManageBridge(runtime: Runtime): boolean; reconnect(runtime: Runtime): Promise<void>; machines: Map<string, Runtime>; persist(): void; observe(runtime: unknown): Promise<void>; prepare(runtime: unknown): Promise<void> };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "herdr-profile-sync-"));
  const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("isolated local offline"); });
  const internals = manager as unknown as Internals;
  const reconnect = spyOn(internals, "reconnect").mockImplementation(async () => {});
  cleanups.push(() => { manager.stop(); reconnect.mockRestore(); rmSync(dir, { recursive: true, force: true }); });
  return { manager, internals, reconnect, dir };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() > deadline) throw new Error("condition timed out"); await Bun.sleep(5); }
}

describe("automatic herdr machine inheritance", () => {
  it("discovers profiles, keeps stable identities and named sessions, and waits for consent before connecting", () => {
    const { manager, reconnect } = fixture();
    manager.syncHerdrProfiles([profile]);
    const first = manager.list()[1]!;
    expect(first).toMatchObject({ herdr_profile_id: "source-a", name: "Build machine", target: profile.target, enabled: true });
    expect(reconnect).toHaveBeenCalledTimes(0);
    manager.syncHerdrProfiles([profile]);
    manager.syncHerdrProfiles([{ ...profile, label: "Renamed" }]);
    expect(reconnect).toHaveBeenCalledTimes(0);
    expect(manager.list()[1]).toMatchObject({ id: first.id, name: "Renamed" });
    manager.syncHerdrProfiles([{ ...profile, target: { destination: "BuildBox", session: "other" } }]);
    expect(reconnect).toHaveBeenCalledTimes(0);
    const next = fixture(); next.manager.syncHerdrProfiles([profile]);
    expect(next.manager.list()[1]?.id).toBe(first.id);
  });
  it("follows disable, enable and removal, releasing browser attachments", () => {
    const { manager, internals, reconnect } = fixture();
    internals.profileState.allowConnection(profile.id, profile.target!);
    manager.syncHerdrProfiles([profile]);
    let closed = 0;
    const runtime = internals.machines.get(manager.list()[1]!.id)!;
    runtime.terminals.add(() => closed++);
    manager.syncHerdrProfiles([{ ...profile, enabled: false }]);
    expect(closed).toBe(1);
    expect(runtime.machine).toMatchObject({ enabled: false, state: "disconnected", action_required: null });
    expect(reconnect).toHaveBeenCalledTimes(1);
    manager.syncHerdrProfiles([profile]);
    expect(reconnect).toHaveBeenCalledTimes(2);
    const generation = runtime.generation;
    manager.syncHerdrProfiles([]);
    expect(manager.list().map((m) => m.id)).toEqual(["local"]);
    expect(runtime.generation).toBeGreaterThan(generation);
    expect(runtime.machine.enabled).toBe(false);
  });
  it("never connects unsupported or disabled profiles; clears the old snapshot when a target changes", () => {
    const { manager, reconnect } = fixture();
    manager.syncHerdrProfiles([{ ...profile, enabled: false }, { ...profile, id: "invalid", target: null }]);
    expect(manager.list()).toHaveLength(3);
    expect(reconnect).not.toHaveBeenCalled();
    expect(manager.list()[2]?.error).toContain("unsupported");
    manager.syncHerdrProfiles([profile]);
    manager.list()[1]!.snapshot = { panes: [] } as any;
    manager.syncHerdrProfiles([{ ...profile, target: { destination: "new-host", session: "other" } }]);
    expect(manager.list()[1]?.snapshot).toBeNull();
  });
  it("keeps manual registrations and suppresses exact duplicates, but distinguishes sessions", () => {
    const { manager, internals } = fixture();
    internals.machines.set("manual", { machine: { id: "manual", name: "Manual", kind: "ssh", target: profile.target!, enabled: false, state: "disconnected", error: null, snapshot: null }, generation: 0, terminals: new Set() });
    manager.syncHerdrProfiles([profile, { ...profile, id: "other-session", target: { ...profile.target!, session: "different" } }]);
    expect(manager.list()).toHaveLength(3);
    expect(manager.list()[1]).toMatchObject({ id: "manual", name: "Manual", enabled: false });
    manager.syncHerdrProfiles([]);
    expect(manager.list().map((m) => m.id)).toEqual(["local", "manual"]);
  });
  it("derives rows rather than persisting a second catalog and refuses conflicting web mutations", () => {
    const { manager, internals, dir } = fixture();
    manager.syncHerdrProfiles([profile]);
    const machine = manager.list()[1]!;
    internals.persist();
    expect(JSON.parse(readFileSync(join(dir, "machines.json"), "utf8"))).toEqual([]);
    expect(() => manager.patch(machine.id, { name: "Other" })).toThrow("in herdr");
    expect(() => manager.patch(machine.id, { enabled: false })).toThrow("in herdr");
    expect(() => manager.remove(machine.id)).toThrow("in herdr");
    expect(() => manager.setup({ machine_id: machine.id, destination: "changed" })).toThrow("managed by herdr");
    manager.syncHerdrProfiles([{ ...profile, enabled: false }]);
    expect(() => manager.setup({ machine_id: machine.id, ...profile.target! })).toThrow("managed by herdr");
  });
  it("polls serially, preserves the last good roster on failure and ignores a late read after stop", async () => {
    const { manager } = fixture();
    const log = spyOn(console, "error").mockImplementation(() => {}); cleanups.push(() => log.mockRestore());
    let calls = 0, active = 0, maxActive = 0;
    let release!: (rows: HerdrMachineProfile[]) => void;
    manager.watchHerdrProfiles(async () => {
      calls++; active++; maxActive = Math.max(maxActive, active);
      try {
        if (calls === 1) return [profile];
        if (calls === 2) throw new Error("broken catalog");
        return await new Promise<HerdrMachineProfile[]>((resolve) => { release = resolve; });
      } finally { active--; }
    }, 5);
    await until(() => calls === 3);
    expect(manager.list()[1]?.herdr_profile_id).toBe(profile.id);
    expect(maxActive).toBe(1);
    manager.stop(); release([{ ...profile, label: "late" }]);
    await until(() => active === 0);
    expect(manager.list()[1]?.name).toBe("Build machine");
    expect(calls).toBe(3);
  });
  it("connects a saved machine whose catalog label is longer than a PC name may be, and keeps that label", () => {
    const { manager } = fixture();
    const label = "L".repeat(101);
    manager.syncHerdrProfiles([{ ...profile, label }]);
    const id = manager.list()[1]!.id;
    expect(manager.list()[1]?.name).toBe(label);
    const job = manager.setup({ ...profile.target!, machine_id: id, name: label });
    expect(job.phase).toBe("connecting");
    expect(manager.list()[1]?.name).toBe(label);
    manager.action(job.id, { action: "cancel" });
  });

  it("cancels a real pending authentication job when its source changes, disables or disappears", async () => {
    const start = spyOn(SshConnection.prototype, "start").mockImplementation(async function (challenge) {
      if (!challenge) throw new Error("test requires interactive setup");
      await challenge("Fixture passphrase", false);
    });
    cleanups.push(() => start.mockRestore());
    for (const next of [[], [{ ...profile, enabled: false }], [{ ...profile, target: { destination: "new-host", session: "other" } }]]) {
      const { manager } = fixture();
      manager.syncHerdrProfiles([profile]);
      const id = manager.list()[1]!.id;
      const job = manager.setup({ ...profile.target!, machine_id: id });
      await until(() => manager.job(job.id)?.phase === "authentication");
      manager.syncHerdrProfiles(next);
      expect(manager.job(job.id)?.phase).toBe("cancelled");
      expect(manager.job(job.id)?.challenge).toBeNull();
      expect(() => manager.action(job.id, { action: "approve" })).toThrow("already changed");
      await Bun.sleep(0);
      if (!next.length) expect(manager.list().map((m) => m.id)).toEqual(["local"]);
      else expect(manager.list()[1]?.target).toEqual(next[0]!.target!);
    }
  });
  it("retains web approval and snapshots across a manager restart, but revokes them and keys on retarget/removal", () => {
    const { manager, internals, dir } = fixture();
    manager.syncHerdrProfiles([profile]);
    const machine = manager.list()[1]!;
    const runtime = internals.machines.get(machine.id)!;
    expect(internals.mayManageBridge(runtime)).toBe(false);
    internals.profileState.approve(profile.id, profile.target!);
    machine.snapshot = { panes: [{ pane_id: "cached" }] } as any;
    internals.persist(); manager.stop();
    const restored = new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("offline"); });
    const restoredInternals = restored as unknown as Internals;
    const reconnect = spyOn(restoredInternals, "reconnect").mockImplementation(async () => {});
    cleanups.push(() => { restored.stop(); reconnect.mockRestore(); });
    restored.syncHerdrProfiles([profile]);
    expect(restored.list()[1]?.snapshot?.panes[0]?.pane_id).toBe("cached");
    expect(restoredInternals.mayManageBridge(restoredInternals.machines.get(machine.id)!)).toBe(true);
    const key = join(dir, "ssh", machine.id);
    mkdirSync(join(dir, "ssh"), { recursive: true }); writeFileSync(key, "fixture key");
    restored.syncHerdrProfiles([{ ...profile, target: { destination: "replacement" } }]);
    expect(restoredInternals.mayManageBridge(restoredInternals.machines.get(machine.id)!)).toBe(false);
    expect(restored.list()[1]?.snapshot).toBeNull();
    expect(existsSync(key)).toBe(false);
    writeFileSync(key, "fixture key"); writeFileSync(key + ".pub", "fixture public key");
    restored.syncHerdrProfiles([]);
    expect(existsSync(key)).toBe(false); expect(existsSync(key + ".pub")).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "herdr-profile-state.json"), "utf8"))).toEqual([]);
  });
  for (const change of ["retarget", "remove"] as const) {
    it(`retries failed key cleanup on ${change}, including after restart, before reconnecting`, async () => {
      const start = spyOn(SshConnection.prototype, "start").mockImplementation(async function (challenge) { await challenge!("Fixture passphrase", false); });
      cleanups.push(() => start.mockRestore());
      const { manager, internals, reconnect, dir } = fixture();
      manager.syncHerdrProfiles([profile]);
      const id = manager.list()[1]!.id;
      const runtime = internals.machines.get(id)!;
      internals.profileState.approve(profile.id, profile.target!);
      internals.persist();
      const job = manager.setup({ ...profile.target!, machine_id: id });
      await until(() => job.phase === "authentication");
      let closed = 0;
      runtime.terminals.add(() => closed++);
      const key = join(dir, "ssh", id);
      mkdirSync(join(dir, "ssh"), { recursive: true });
      writeFileSync(key, "fixture key");
      // Deleting the private key succeeds, but unlink cannot delete this public-key directory.
      mkdirSync(key + ".pub");
      const next = change === "retarget" ? [{ ...profile, target: { destination: "replacement" } }] : [];
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(() => manager.syncHerdrProfiles(next)).toThrow();
        expect(manager.list().map((m) => m.id)).toEqual(["local"]);
        expect(reconnect).not.toHaveBeenCalled();
        expect(job.phase).toBe("cancelled");
        expect(runtime.machine.enabled).toBe(false);
        expect(existsSync(key)).toBe(false);
        expect(existsSync(key + ".pub")).toBe(true);
      }
      expect(closed).toBe(1);
      manager.stop();
      const restored = new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("offline"); });
      const restoredInternals = restored as unknown as Internals;
      const restoredReconnect = spyOn(restoredInternals, "reconnect").mockImplementation(async () => {});
      cleanups.push(() => { restored.stop(); restoredReconnect.mockRestore(); });
      expect(() => restored.syncHerdrProfiles(next)).toThrow();
      expect(restoredReconnect).not.toHaveBeenCalled();
      rmSync(key + ".pub", { recursive: true });
      writeFileSync(key + ".pub", "fixture public key");
      restored.syncHerdrProfiles(next);
      expect(existsSync(key + ".pub")).toBe(false);
      expect(restoredInternals.profileState.approved(profile.id, profile.target!)).toBe(false);
      if (change === "retarget") {
        expect(restoredReconnect).not.toHaveBeenCalled();
        expect(restored.list()[1]).toMatchObject({ target: next[0]!.target, snapshot: null });
        expect(restoredInternals.mayManageBridge(restoredInternals.machines.get(id)!)).toBe(false);
      } else {
        expect(restoredReconnect).not.toHaveBeenCalled();
        expect(JSON.parse(readFileSync(join(dir, "herdr-profile-state.json"), "utf8"))).toEqual([]);
      }
    });
  }
  it("a successful explicit connection persists consent without granting installation permission", async () => {
    const { manager, internals, dir, reconnect } = fixture();
    const start = spyOn(SshConnection.prototype, "start").mockResolvedValue();
    const prepare = spyOn(internals, "prepare").mockResolvedValue();
    const observe = spyOn(internals, "observe").mockResolvedValue();
    cleanups.push(() => { start.mockRestore(); prepare.mockRestore(); observe.mockRestore(); });
    manager.syncHerdrProfiles([profile]);
    expect(start).not.toHaveBeenCalled();
    const machine = manager.list()[1]!;
    expect(machine.action_required).toBe("connect");
    const job = manager.setup({ ...profile.target!, machine_id: machine.id });
    await until(() => job.phase === "connected");
    expect(start).toHaveBeenCalledTimes(1);
    const saved = new HerdrProfileState(dir);
    expect(saved.connectionApproved(profile.id, profile.target!)).toBe(true);
    expect(saved.approved(profile.id, profile.target!)).toBe(false);
    manager.stop();
    const restored = new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("offline"); });
    const resumed = spyOn(restored as unknown as Internals, "reconnect").mockResolvedValue();
    cleanups.push(() => { restored.stop(); resumed.mockRestore(); });
    restored.syncHerdrProfiles([profile]);
    expect(resumed).toHaveBeenCalledTimes(1);
    restored.syncHerdrProfiles([{ ...profile, target: { ...profile.target!, port: 2223 } }]);
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(restored.list()[1]?.action_required).toBe("connect");
    expect(reconnect).not.toHaveBeenCalled();
  });
  for (const change of ["disable", "retarget", "remove"] as const) {
    it(`a failed cleanup for A does not block ${change} of B, even across restart`, () => {
      const { manager, internals, dir } = fixture();
      const other = { ...profile, id: "source-b", target: { destination: "other" } };
      manager.syncHerdrProfiles([profile, other]);
      for (const p of [profile, other]) internals.profileState.approve(p.id, p.target!);
      internals.persist();
      const [a, b] = manager.list().slice(1);
      let closed = 0;
      internals.machines.get(b!.id)!.terminals.add(() => closed++);
      mkdirSync(join(dir, "ssh", a!.id), { recursive: true });
      if (change === "remove") mkdirSync(join(dir, "ssh", b!.id), { recursive: true });
      const next = [{ ...profile, target: { destination: "replacement-a" } }, ...(change === "remove" ? [] : [{ ...other, ...(change === "disable" ? { enabled: false } : { target: { destination: "replacement-b" } }) }])];
      expect(() => manager.syncHerdrProfiles(next)).toThrow("cleanup will retry");
      expect(closed).toBe(1);
      expect(manager.endpoint(b!.id)).toBeUndefined();
      const saved = new HerdrProfileState(dir);
      expect(saved.approved(profile.id, profile.target!)).toBe(false);
      expect(saved.connectionApproved(profile.id, profile.target!)).toBe(false);
      if (change !== "disable") expect(saved.approved(other.id, other.target)).toBe(false);
      manager.stop();
      expect(new HerdrProfileState(dir).approved(profile.id, profile.target!)).toBe(false);
    });
  }
  for (const change of ["retarget", "remove"] as const) {
    it(`does not publish a key generated after ${change}`, async () => {
      const { manager, internals, dir } = fixture();
      const start = spyOn(SshConnection.prototype, "start").mockImplementation(async function (this: SshConnection) { this.usedSecret = true; });
      const run = spyOn(SshConnection.prototype, "run").mockImplementation(async (script) => {
        if (script.includes("uname")) return "Linux\nx86_64\n/home/fixture\n/home/fixture/.config\n/usr/bin/herdr\nbundle-ready\n";
        if (script.startsWith("socket=")) return "/home/fixture/.config/herdr/sessions/agents/herdr.sock";
        if (script.includes("--version")) return "herdr 0.9.3";
        throw new Error("Unexpected remote mutation: " + script);
      });
      let finish!: (code: number) => void;
      let output: string | undefined;
      const spawn = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
        expect(args[0]).toBe("ssh-keygen");
        output = args.at(-1)!;
        return { exited: new Promise<number>((resolve) => { finish = resolve; }) };
      }) as typeof Bun.spawn);
      cleanups.push(() => { start.mockRestore(); run.mockRestore(); spawn.mockRestore(); });
      manager.syncHerdrProfiles([profile]);
      const id = manager.list()[1]!.id;
      const job = manager.setup({ ...profile.target!, machine_id: id });
      await until(() => job.phase === "approval");
      manager.action(job.id, { action: "approve" });
      await until(() => !!output);
      manager.syncHerdrProfiles(change === "remove" ? [] : [{ ...profile, target: { destination: "replacement" } }]);
      writeFileSync(output!, "late private key"); writeFileSync(output! + ".pub", "late public key");
      finish(0);
      await until(() => !existsSync(output!));
      expect(existsSync(join(dir, "ssh", id))).toBe(false);
      expect(existsSync(join(dir, "ssh", id + ".pub"))).toBe(false);
      expect(readdirSync(join(dir, "ssh")).filter((name) => name.startsWith("keygen-"))).toEqual([]);
      expect(job.phase).toBe("cancelled");
      expect(internals.profileState.approved(profile.id, profile.target!)).toBe(false);
    });
  }
  it("rejects key overrides and keeps an unchanged profile's interactive setup alive across polls", async () => {
    const start = spyOn(SshConnection.prototype, "start").mockImplementation(async function (challenge) { await challenge!("Fixture passphrase", false); });
    cleanups.push(() => start.mockRestore());
    const { manager } = fixture(); manager.syncHerdrProfiles([profile]);
    const machine_id = manager.list()[1]!.id;
    expect(() => manager.setup({ ...profile.target!, machine_id, identity_file: "/tmp/other-key" })).toThrow("managed by herdr");
    const job = manager.setup({ machine_id, session: "agents", destination: "BuildBox", port: 2222 });
    await until(() => job.phase === "authentication");
    manager.syncHerdrProfiles([profile]); manager.syncHerdrProfiles([{ ...profile, label: "Renamed" }]);
    expect(job.phase).toBe("authentication");
    manager.action(job.id, { action: "cancel" });
  });
  it.each(["catalog sync", "update offer", "bridge update"])("keeps approval during an in-flight setup for %s", async (check) => {
    const authentication = Promise.withResolvers<void>();
    const start = spyOn(SshConnection.prototype, "start").mockImplementation(async function (challenge) {
      if (!challenge) throw new Error("Expected an interactive setup");
      const answer = challenge("Fixture passphrase", false);
      authentication.resolve();
      await answer;
    });
    cleanups.push(() => start.mockRestore());
    const { manager, internals } = fixture();
    if (!profile.target) throw new Error("Expected SSH profile");
    internals.profileState.allowConnection(profile.id, profile.target);
    internals.profileState.approve(profile.id, profile.target);
    manager.syncHerdrProfiles([profile]);
    const machine = manager.list()[1];
    if (!machine) throw new Error("Expected catalog machine");
    const job = manager.setup({ ...profile.target, machine_id: machine.id });
    try {
      await authentication.promise;
      if (check === "catalog sync") {
        manager.syncHerdrProfiles([profile]);
        expect(manager.list()[1]?.action_required).not.toBe("connect");
      } else if (check === "update offer") {
        machine.state = "error"; machine.action_required = "update_bridge"; machine.remote_ovis = null;
        expect(manager.list()[1]?.ovis_update).toMatchObject({ how: "bridge", updatable: true, reason: null });
      } else {
        expect(() => manager.updateBridge(machine.id)).toThrow("A connection job for this PC is already running");
      }
    } finally { manager.action(job.id, { action: "cancel" }); }
  });
  it("keeps polling other machines promptly when one key cleanup keeps failing", async () => {
    const { manager, internals, dir } = fixture();
    const other = { ...profile, id: "source-b", target: { destination: "other" } };
    manager.syncHerdrProfiles([profile, other]);
    const [a, b] = manager.list().slice(1);
    let closed = false;
    internals.machines.get(b!.id)!.terminals.add(() => { closed = true; });
    mkdirSync(join(dir, "ssh", a!.id), { recursive: true });
    const log = spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(() => log.mockRestore());
    let reads = 0;
    const timers = spyOn(globalThis, "setTimeout");
    cleanups.push(() => timers.mockRestore());
    manager.watchHerdrProfiles(async () => {
      reads++;
      return [{ ...profile, target: { destination: "replacement" } }, { ...other, enabled: reads < 6 }];
    }, 10);
    await until(() => closed);
    manager.stop();
    expect(reads).toBeGreaterThanOrEqual(6);
    const delays = timers.mock.calls.filter(([callback]) => typeof callback === "function" && callback.name === "poll").map(([, delay]) => delay);
    expect(delays.length).toBeGreaterThanOrEqual(6);
    expect(new Set(delays)).toEqual(new Set([10]));
    expect(log).toHaveBeenCalledTimes(1);
  });
  it("requires Connect before a direct bridge update and preserves failed connection details across polls", () => {
    const { manager, internals } = fixture();
    manager.syncHerdrProfiles([profile]);
    const machine = manager.list()[1]!;
    expect(() => manager.updateBridge(machine.id)).toThrow("Connect this machine first");
    const row = internals.machines.get(machine.id)!.machine;
    row.state = "error"; row.action_required = "bridge_conflict"; row.error = "Another bridge owns this session";
    manager.syncHerdrProfiles([profile]);
    expect(manager.list()[1]).toMatchObject({ state: "error", action_required: "bridge_conflict", error: "Another bridge owns this session" });
  });
  it("sends a connected PC's bridge update without bridge approval to its dialog instead of updating it", () => {
    const { manager, internals } = fixture();
    internals.profileState.allowConnection(profile.id, profile.target!);
    manager.syncHerdrProfiles([profile]);
    const machine = manager.list()[1]!;
    let refused: unknown;
    try { manager.updateBridge(machine.id); } catch (error) { refused = error; }
    expect(refused).toMatchObject({ action: "update_bridge" });
    expect(internals.profileState.approved(profile.id, profile.target!)).toBe(false);
  });
  it("backs off repeated discovery errors and logs again only after recovery", async () => {
    const { manager } = fixture();
    const log = spyOn(console, "error").mockImplementation(() => {}); cleanups.push(() => log.mockRestore());
    const times: number[] = [];
    manager.watchHerdrProfiles(async () => { times.push(Date.now()); if (times.length !== 4) throw new Error("unavailable"); return [profile]; }, 10);
    await until(() => times.length >= 5);
    manager.stop();
    expect(log).toHaveBeenCalledTimes(2);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(30);
    expect(times[3]! - times[2]!).toBeGreaterThanOrEqual(60);
    expect(manager.list()[1]?.herdr_profile_id).toBe(profile.id);
  });
  it("a discovered PC with a preinstalled runtime still requires approval before starting a missing bridge", async () => {
    const { internals } = fixture();
    const ssh = { run: async (script: string) => {
      if (script.includes("uname")) return "Linux\nx86_64\n/home/fixture\n/home/fixture/.config\n/usr/bin/herdr\nbundle-ready\n";
      if (script.startsWith("socket=")) return "/home/fixture/.config/herdr/sessions/agents/herdr.sock";
      if (script.includes("--version")) return "herdr 0.9.3";
      throw new Error("Unexpected remote mutation: " + script);
    } } as unknown as SshConnection;
    await expect(internals.prepare({ machine: { herdr_profile_id: profile.id, target: profile.target }, ssh, generation: 0 })).rejects.toMatchObject({ action: "setup" });
  });
});
