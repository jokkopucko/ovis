import { afterEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine, PcUpdateAll, PcUpdateOffer } from "../shared/machines.ts";
import { unmanagedUpdateStatus, type UpdateStatus } from "../shared/update.ts";
import type { CompletionTracker } from "./completion.ts";
import { handleMachineRequest } from "./machine-api.ts";
import { MachineManager, OWN_UPDATES_AT_ONCE } from "./machines.ts";
import { offerFromStatus } from "./pc-update.ts";
import type { PushService } from "./push.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
type Runtime = { machine: Machine; endpoint?: { url: string; token: string }; ownOffer?: PcUpdateOffer | null; offerRevision?: string };
type Internals = { machines: Map<string, Runtime>; jobs: Map<string, { finished: Promise<void>; public: { machine_id: string; phase: string } }>; autoQueued: Set<string>; reconnect(runtime: Runtime): Promise<void> };

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ovis-update-all-"));
  writeFileSync(join(dir, "machines.json"), JSON.stringify([A, B].map((id, i) => ({ id, name: `PC ${i + 1}`, target: { destination: `me@pc${i + 1}.invalid` }, enabled: true }))));
  const reconnect = spyOn(MachineManager.prototype as unknown as Internals, "reconnect").mockImplementation(async () => {});
  const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("isolated local offline"); });
  const internals = manager as unknown as Internals;
  cleanups.push(() => { manager.stop(); reconnect.mockRestore(); rmSync(dir, { recursive: true, force: true }); });
  for (const id of [A, B]) Object.assign(internals.machines.get(id)!.machine, { state: "error", action_required: "update_bridge", error: "This PC runs a bridge from a different version." });
  const asked: string[] = [];
  const ends = new Map<string, () => void>();
  spyOn(manager, "updateBridge").mockImplementation((id: string) => {
    asked.push(id);
    const done = Promise.withResolvers<void>();
    const job = `job-${id}`;
    const state = { finished: done.promise, abort: new AbortController(), public: { machine_id: id, phase: "installing" } };
    internals.jobs.set(job, state);
    ends.set(id, () => { state.public.phase = "connected"; internals.machines.get(id)!.machine.action_required = null; internals.machines.get(id)!.machine.state = "connected"; done.resolve(); });
    return { id: job } as ReturnType<MachineManager["updateBridge"]>;
  });
  const pc = (id: string) => manager.list().find((machine) => machine.id === id)!;
  const until = async (done: () => boolean) => { const deadline = Date.now() + 2000; while (!done()) { if (Date.now() > deadline) throw new Error("condition timed out"); await Bun.sleep(5); } };
  const request = (path: string, method = "POST") => handleMachineRequest(new Request(`http://localhost:7317/api/machines/${path}`, { method, headers: { origin: "http://localhost:7317", "x-herdr-machine": "1", "x-herdr-update": "1" } }), manager,
    undefined, undefined, false, undefined, undefined, undefined, undefined, true);
  return { manager, internals, asked, ends, pc, until, request };
}

it("runs Update all's bridge updates one after another, each showing that it waits until its turn", async () => {
  const { asked, ends, pc, until, request } = fixture();
  const response = await request("update-all");
  expect(response.status).toBe(202);
  expect(await response.json() as PcUpdateAll).toEqual({ started: [], queued: [A, B], skipped: [] });
  await until(() => asked.length === 1);
  expect(asked).toEqual([A]);
  expect(pc(B).updating).toMatchObject({ queued: true, job_id: "" });
  ends.get(A)!();
  await until(() => asked.length === 2);
  expect(asked).toEqual([A, B]);
});

it("does not repeat an automatic bridge update already waiting for a PC, nor one done before its turn", async () => {
  const { internals, asked, ends, pc, until, request } = fixture();
  internals.autoQueued.add(A);
  expect(await (await request("update-all")).json() as PcUpdateAll).toEqual({ started: [], queued: [B], skipped: [{ machine_id: A, reason: "This PC is already updating." }] });
  await until(() => asked.length === 1);
  ends.get(B)!();
  internals.autoQueued.delete(A);
  Object.assign(pc(B), { state: "error", action_required: "update_bridge" });
  expect((await (await request("update-all")).json() as PcUpdateAll).queued).toEqual([A, B]);
  await until(() => asked.length === 2);
  Object.assign(pc(B), { state: "connected", action_required: null });
  ends.get(A)!();
  await until(() => !pc(B).updating);
  expect(asked).toEqual([B, A]);
});

it("takes a PC out of the queue on cancel, or when it is disabled or removed, and never updates it", async () => {
  const { manager, asked, ends, pc, until, request } = fixture();
  await request("update-all");
  await until(() => asked.length === 1);
  const cancelled = await request(`${B}/update`, "DELETE");
  expect(await cancelled.json()).toEqual({ cancelled: true });
  expect(pc(B).updating ?? null).toBeNull();
  ends.get(A)!();
  await until(() => !pc(A).updating);
  expect(asked).toEqual([A]);
  Object.assign(pc(A), { state: "error", action_required: "update_bridge" });
  await request("update-all");
  manager.remove(B);
  await until(() => asked.length === 2);
  ends.get(A)!();
  await until(() => !pc(A).updating);
  expect(asked).toEqual([A, A]);
});

it("ends the wait of a running own update on cancel, and says it may still finish there when that PC cannot stop it", async () => {
  const { internals, pc, until, request } = fixture();
  const offered = "a".repeat(40);
  let installing = false;
  const status = (): UpdateStatus => ({ ...unmanagedUpdateStatus(), managed: true, blocked_reason: null, available: true, current_version: "0.5.0", latest_version: "0.5.1",
    latest_revision: offered, revision_bound_install: true, ...(installing ? { phase: "building" as const, step: "build" as const } : {}) });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    if (new URL(req.url).pathname === "/api/updates/install") { installing = true; return new Response(null, { status: 202 }); }
    return Response.json(status());
  } });
  cleanups.push(() => server.stop(true));
  const runtime = internals.machines.get(A)!;
  Object.assign(runtime.machine, { state: "connected", action_required: null, error: null });
  runtime.endpoint = { url: `http://127.0.0.1:${server.port}`, token: "t" };
  runtime.ownOffer = { how: "own", current_version: "0.5.0", latest_version: "0.5.1", updatable: true, reason: null };
  runtime.offerRevision = offered;
  expect((await request(`${A}/update`)).status).toBe(202);
  await until(() => installing && pc(A).updating?.step.includes("building") === true);
  expect(await (await request(`${A}/update`, "DELETE")).json()).toEqual({ cancelled: true });
  await until(() => !pc(A).updating);
  expect(pc(A).update_error).toContain("may still finish it there");
});

it("leaves a disabled PC out of Update all and its badge, so it is never connected again by it", async () => {
  const { manager, asked, pc, request } = fixture();
  manager.patch(B, { enabled: false });
  expect(pc(B).ovis_update ?? null).toBeNull();
  expect(await (await request("update-all")).json() as PcUpdateAll).toEqual({ started: [], queued: [A], skipped: [] });
  const refused = await request(`${B}/update`);
  expect(refused.status).toBe(409);
  expect(asked.includes(B)).toBe(false);
});

it("runs at most a few PCs' own updates at once with Update all, starting the next as one ends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-update-fanout-"));
  const ids = Array.from({ length: OWN_UPDATES_AT_ONCE + 2 }, (_, i) => `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`);
  writeFileSync(join(dir, "machines.json"), JSON.stringify(ids.map((id, i) => ({ id, name: `PC ${i}`, target: { destination: `me@pc${i}.invalid` }, enabled: true }))));
  const reconnect = spyOn(MachineManager.prototype as unknown as Internals, "reconnect").mockImplementation(async () => {});
  const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("isolated local offline"); }, { ownUpdate: { pollMs: 5 } });
  cleanups.push(() => { manager.stop(); reconnect.mockRestore(); rmSync(dir, { recursive: true, force: true }); });
  const offered = "a".repeat(40);
  const finished = new Set<string>();
  const asked: string[] = [];
  const servers = ids.map((id) => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    if (new URL(req.url).pathname === "/api/updates/install") { asked.push(id); return new Response(null, { status: 202 }); }
    const base = { ...unmanagedUpdateStatus(), managed: true, blocked_reason: null, available: true, latest_revision: offered, latest_version: "0.5.1", revision_bound_install: true };
    if (finished.has(id)) return Response.json({ ...base, available: false, current_revision: offered });
    return Response.json(asked.includes(id) ? { ...base, phase: "building", step: "build" } : base);
  } }));
  cleanups.push(() => { for (const server of servers) server.stop(true); });
  const internals = manager as unknown as Internals;
  ids.forEach((id, i) => {
    const runtime = internals.machines.get(id)!;
    Object.assign(runtime.machine, { state: "connected", action_required: null, error: null });
    runtime.endpoint = { url: `http://127.0.0.1:${servers[i]!.port}`, token: "t" };
    runtime.ownOffer = { how: "own", current_version: "0.5.0", latest_version: "0.5.1", updatable: true, reason: null };
    runtime.offerRevision = offered;
  });
  const until = async (done: () => boolean) => { const deadline = Date.now() + 3000; while (!done()) { if (Date.now() > deadline) throw new Error("condition timed out"); await Bun.sleep(5); } };
  const all = manager.updateAll();
  expect(all.started).toHaveLength(OWN_UPDATES_AT_ONCE);
  expect(all.queued).toEqual(ids.slice(OWN_UPDATES_AT_ONCE));
  await until(() => asked.length === OWN_UPDATES_AT_ONCE);
  expect(manager.list().find((machine) => machine.id === ids.at(-1))?.updating).toMatchObject({ queued: true });
  finished.add(ids[0]!);
  await until(() => asked.length === OWN_UPDATES_AT_ONCE + 1);
  expect(asked.at(-1)).toBe(ids[OWN_UPDATES_AT_ONCE]);
});

it("cancels an automatic bridge update still waiting its turn, so it never starts", async () => {
  const { manager, internals, request } = fixture();
  internals.autoQueued.add(A);
  expect(await (await request(`${A}/update`, "DELETE")).json()).toEqual({ cancelled: true });
  expect((internals.machines.get(A) as unknown as { updateCancelled?: boolean }).updateCancelled).toBe(true);
  expect(manager.list().length).toBeGreaterThan(0);
});

it("counts an SSH PC's own update through its setup against the same limit, and installs only the release it was queued for", async () => {
  const { manager, internals, asked, ends, pc, until } = fixture();
  for (const [id, revision] of [[A, "a".repeat(40)], [B, "b".repeat(40)]] as const) {
    const runtime = internals.machines.get(id)! as Runtime & { remoteRevision?: string };
    runtime.machine.remote_ovis = { version: "0.4.9", latest_version: "0.5.1", updatable: true, reason: null, address: "pc.invalid:7317", url: null };
    runtime.remoteRevision = revision;
  }
  const spare = 2;
  (manager as unknown as { ownViaSetup: Set<string> }).ownViaSetup = new Set(Array.from({ length: spare }, (_, i) => `other-${i}`));
  const all = manager.updateAll();
  expect(all.started.map((entry) => entry.machine_id)).toEqual([A]);
  expect(all.queued).toEqual([B]);
  expect(asked).toEqual([A]);
  expect(pc(B).updating).toMatchObject({ queued: true });
  (internals.machines.get(B)! as Runtime & { remoteRevision?: string }).remoteRevision = "c".repeat(40);
  ends.get(A)!();
  await until(() => typeof pc(B).update_error === "string");
  expect(pc(B).update_error).toContain("another release now than the one shown");
  expect(asked).toEqual([A]);
});

it("keeps going past a PC whose update cannot start, and tells it under skipped", async () => {
  const { manager, internals, asked } = fixture();
  const runtime = internals.machines.get(A)! as Runtime & { remoteRevision?: string };
  runtime.machine.remote_ovis = { version: "0.4.9", latest_version: "0.5.1", updatable: true, reason: null, address: "pc.invalid:7317", url: null };
  runtime.remoteRevision = "a".repeat(40);
  (manager.updateBridge as unknown as { mockImplementationOnce(fn: () => never): void }).mockImplementationOnce(() => { throw new Error("Finish or cancel the current connection jobs first"); });
  const all = manager.updateAll();
  expect(all.skipped).toEqual([{ machine_id: A, reason: "Finish or cancel the current connection jobs first" }]);
  expect(all.queued).toEqual([B]);
  expect(internals.machines.get(B)!.machine.updating).toBeTruthy();
  expect((manager as unknown as { ownViaSetup: Set<string> }).ownViaSetup.has(A)).toBe(false);
  expect(asked).toEqual([]);
});

it("offers an SSH PC's own update only where this app may connect and manage it, as it does a bridge update", async () => {
  const { manager, internals, pc } = fixture();
  const runtime = internals.machines.get(A)! as Runtime & { remoteRevision?: string };
  runtime.machine.remote_ovis = { version: "0.4.9", latest_version: "0.5.1", updatable: true, reason: null, address: "pc.invalid:7317", url: null };
  runtime.remoteRevision = "a".repeat(40);
  const internalsOf = manager as unknown as { mayManageBridge(runtime: unknown): boolean };
  spyOn(internalsOf, "mayManageBridge").mockImplementation((r) => (r as Runtime).machine.id !== A);
  expect(pc(A).ovis_update).toMatchObject({ how: "own", updatable: false, reason: expect.stringContaining("Review") });
  expect(manager.updateAll().skipped.map((entry) => entry.machine_id)).toContain(A);
});

it("lets a PC cancelled and queued again run on its new entry, not on the stale one", async () => {
  const { manager, internals, asked, pc } = fixture();
  for (const id of [A, B]) {
    const runtime = internals.machines.get(id)! as Runtime & { remoteRevision?: string };
    runtime.machine.remote_ovis = { version: "0.4.9", latest_version: "0.5.1", updatable: true, reason: null, address: "pc.invalid:7317", url: null };
    runtime.remoteRevision = "a".repeat(40);
  }
  const slots = (manager as unknown as { ownViaSetup: Set<string> }).ownViaSetup;
  for (let i = 0; i < OWN_UPDATES_AT_ONCE; i++) slots.add(`other-${i}`);
  expect(manager.updateAll().queued).toEqual([A, B]);
  manager.cancelUpdate(B);
  (internals.machines.get(B)! as Runtime & { remoteRevision?: string }).remoteRevision = "b".repeat(40);
  expect(manager.updateAll().queued).toEqual([B]);
  slots.clear();
  (manager as unknown as { nextOwn(): void }).nextOwn();
  expect(asked).toEqual([A, B]);
  expect(pc(B).update_error ?? null).toBeNull();
});

it("binds an SSH PC's own update asked through update-bridge to the release its card shows", async () => {
  const { manager, internals } = fixture();
  const runtime = internals.machines.get(A)! as Runtime & { remoteRevision?: string };
  runtime.machine.remote_ovis = { version: "0.4.9", latest_version: "0.5.1", updatable: true, reason: null, address: "pc.invalid:7317", url: null };
  runtime.remoteRevision = "a".repeat(40);
  const bridge = manager.updateBridge as unknown as { mockRestore(): void };
  bridge.mockRestore();
  const setup = spyOn(manager, "setup").mockImplementation(() => ({ id: "job" }) as ReturnType<MachineManager["setup"]>);
  manager.updateBridge(A);
  expect(setup.mock.calls[0]![1]).toMatchObject({ expectedRevision: "a".repeat(40) });
});

it("never offers an SSH PC's own update to a release newer than this app, which would leave the PC unreachable from here", async () => {
  const { manager, internals, pc } = fixture();
  const ahead = (major: number) => `${major}.0.0`;
  const runtime = internals.machines.get(A)! as Runtime & { remoteRevision?: string };
  runtime.machine.remote_ovis = { version: "0.4.9", latest_version: ahead(999), updatable: true, reason: null, address: "pc.invalid:7317", url: null };
  runtime.remoteRevision = "a".repeat(40);
  expect(pc(A).ovis_update).toMatchObject({ how: "own", updatable: false, reason: expect.stringContaining("newer than this app") });
  const connected = internals.machines.get(B)!;
  Object.assign(connected.machine, { state: "connected", action_required: null, error: null });
  connected.ownOffer = { how: "own", current_version: "0.5.0", latest_version: ahead(999), updatable: true, reason: null };
  expect(pc(B).ovis_update).toMatchObject({ how: "own", updatable: false, reason: expect.stringContaining("newer than this app") });
  expect(manager.updateAll().started).toEqual([]);
});

it("leaves a setup slot free: SSH own updates through setup run fewer at once than the setup jobs allowed", async () => {
  const { manager, internals } = fixture();
  for (const id of [A, B]) {
    const runtime = internals.machines.get(id)! as Runtime & { remoteRevision?: string };
    runtime.machine.remote_ovis = { version: "0.4.9", latest_version: "0.5.1", updatable: true, reason: null, address: "pc.invalid:7317", url: null };
    runtime.remoteRevision = "a".repeat(40);
  }
  const slots = (manager as unknown as { ownViaSetup: Set<string> }).ownViaSetup;
  slots.add("other-1"); slots.add("other-2");
  const all = manager.updateAll();
  expect(all.started.map((entry) => entry.machine_id)).toEqual([A]);
  expect(all.queued).toEqual([B]);
});

it("refuses an update-bridge of an SSH PC's own Ovis to a release newer than this app, as its card does", async () => {
  const { manager, internals } = fixture();
  const runtime = internals.machines.get(A)! as Runtime & { remoteRevision?: string };
  runtime.machine.remote_ovis = { version: "0.4.9", latest_version: "999.0.0", updatable: true, reason: null, address: "pc.invalid:7317", url: null };
  runtime.remoteRevision = "a".repeat(40);
  (manager.updateBridge as unknown as { mockRestore(): void }).mockRestore();
  const setup = spyOn(manager, "setup");
  expect(() => manager.updateBridge(A)).toThrow("newer than this app");
  expect(setup).not.toHaveBeenCalled();
});

it("reads a beta release as its updater offers it, and refuses one newer than this app, or one it cannot tell", async () => {
  const { manager, internals, pc } = fixture();
  const told = (latest_version: string | null) => offerFromStatus({ ...unmanagedUpdateStatus(), managed: true, blocked_reason: null, available: true, latest_revision: "a".repeat(40), latest_version, revision_bound_install: true });
  expect(told("999.0.0-beta.2")).toMatchObject({ latest_version: "999.0.0-beta.2", updatable: true });
  const connected = internals.machines.get(B)!;
  Object.assign(connected.machine, { state: "connected", action_required: null, error: null });
  connected.ownOffer = told("999.0.0-beta.2")!;
  expect(pc(B).ovis_update).toMatchObject({ updatable: false, reason: expect.stringContaining("newer than this app") });
  connected.ownOffer = told("0.5.1-beta.3")!;
  expect(pc(B).ovis_update).toMatchObject({ updatable: true });
  connected.ownOffer = told("next")!;
  expect(pc(B).ovis_update).toMatchObject({ updatable: false, reason: expect.stringContaining("does not tell its version") });
  const runtime = internals.machines.get(A)! as Runtime & { remoteRevision?: string };
  runtime.machine.remote_ovis = { version: "0.4.9", latest_version: "999.0.0-beta.2", updatable: true, reason: null, address: "pc.invalid:7317", url: null };
  runtime.remoteRevision = "a".repeat(40);
  expect(pc(A).ovis_update).toMatchObject({ updatable: false, reason: expect.stringContaining("newer than this app") });
  (manager.updateBridge as unknown as { mockRestore(): void }).mockRestore();
  const setup = spyOn(manager, "setup");
  expect(() => manager.updateBridge(A)).toThrow("newer than this app");
  runtime.machine.remote_ovis = { ...runtime.machine.remote_ovis, latest_version: null };
  expect(() => manager.updateBridge(A)).toThrow("does not tell its version");
  expect(setup).not.toHaveBeenCalled();
  expect(manager.updateAll().started).toEqual([]);
});
