import { afterEach, expect, it, spyOn, setSystemTime } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine, PcInstallJob, RemoteOvis, SshTarget } from "../shared/machines.ts";
import type { CompletionTracker } from "./completion.ts";
import { appBuild } from "./app-revision.ts";
import { handleMachineRequest } from "./machine-api.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";
import { SshConnection } from "./ssh.ts";
const APP_VERSION = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version;
import {forgetSshAddresses, literalAddress, resolveWithSsh, samePc, sshAddresses, warmSshAddresses } from "./ssh-address.ts";


const SAVED = "00000000-0000-4000-8000-0000000000aa";
type Runtime = { machine: Machine; installFix?: { mode: "replace" | "restart"; pid: number; target: SshTarget } };
type Internals = { machines: Map<string, Runtime>; reconnect(runtime: Runtime): Promise<void> };

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ovis-install-routes-"));
  writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id: SAVED, name: "Lab", target: { destination: "me@lab.invalid" }, enabled: true }]));
  const reconnect = spyOn(MachineManager.prototype as unknown as Internals, "reconnect").mockImplementation(async () => {});
  const real = { start: SshConnection.prototype.start, close: SshConnection.prototype.close };
  const waiting = new Map<string, { refuse(words: string): void }>();
  const tried = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const reached = (destination: string) => { if (!tried.has(destination)) tried.set(destination, Promise.withResolvers<void>()); return tried.get(destination)!.promise; };
  SshConnection.prototype.start = function (this: SshConnection) {
    return new Promise<void>((_, reject) => {
      waiting.set(this.target.destination, { refuse: (words) => reject(new Error(words)) });
      void reached(this.target.destination); tried.get(this.target.destination)!.resolve();
      (this as unknown as { refuse?: () => void }).refuse = () => reject(new Error("SSH connection closed"));
    });
  };
  SshConnection.prototype.close = function (this: SshConnection) { (this as unknown as { refuse?: () => void }).refuse?.(); };
  const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("isolated local offline"); });
  const resolve = spyOn(sshAddresses, "resolve").mockImplementation(async (target) => literalAddress(target));
  forgetSshAddresses();
  cleanups.push(() => { resolve.mockRestore(); forgetSshAddresses(); });
  cleanups.push(() => { manager.stop(); Object.assign(SshConnection.prototype, real); reconnect.mockRestore(); rmSync(dir, { recursive: true, force: true }); });
  const call = (path: string, method = "POST", body?: unknown, readOnly = false, owner = !readOnly, headers: Record<string, string> = { "x-herdr-update": "1" }) => handleMachineRequest(new Request(`http://localhost:7317/api/machines/${path}`,
    { method, headers: { origin: "http://localhost:7317", "x-herdr-machine": "1", "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), manager, undefined, undefined, readOnly, undefined, undefined, undefined, undefined, owner);
  const ended = async (id: string) => { await (manager as unknown as { installer: { finished(id: string): Promise<void> } }).installer.finished(id); return manager.installJob(id)!; };
  return { manager, internals: manager as unknown as Internals, waiting, reached, call, ended };
}

it("starts an install on a PC not added here, tells its job, refuses a watching device and an address already added", async () => {
  const { manager, waiting, reached, call, ended } = fixture();
  expect((await call("install", "POST", { destination: "me@new.invalid" }, true)).status).toBe(403);
  // running the installer on another PC is the owner's only (access.ts ownerAccess), from this app's own page
  for (const refused of [await call("install", "POST", { destination: "me@new.invalid" }, false, false), await call("install", "POST", { destination: "me@new.invalid" }, false, true, {}), await call("install/any-job", "GET", undefined, false, false)]) {
    expect(refused.status).toBe(403);
    expect((await refused.json() as { error: { code: string } }).error.code).toBe("forbidden");
  }
  const added = await call("install", "POST", { destination: "me@lab.invalid" });
  expect(added.status).toBe(409);
  expect((await added.json() as { error: { code: string } }).error.code).toBe("install_unavailable");
  const started = await call("install", "POST", { destination: "me@new.invalid", name: "New" });
  expect(started.status).toBe(202);
  const job = await started.json() as PcInstallJob;
  expect(job).toMatchObject({ machine_id: null, mode: "install", phase: "connecting", target: { destination: "me@new.invalid" } });
  expect((await call("install", "POST", { destination: "me@new.invalid" })).status).toBe(409);
  expect(() => manager.setup({ destination: "me@new.invalid" })).toThrow("Ovis is being installed on this PC");
  await reached("me@new.invalid");
  waiting.get("me@new.invalid")!.refuse("me@new.invalid: Permission denied (publickey).");
  expect((await ended(job.id)).phase).toBe("failed");
  expect(await (await call(`install/${job.id}`, "GET")).json()).toMatchObject({ phase: "failed", error_code: "ssh_refused" });
  expect((await call("install/no-such-job", "GET")).status).toBe(404);
});

it("cancels a running install with DELETE, and with the PC's own update cancel or its removal", async () => {
  const { manager, internals, reached, call, ended } = fixture();
  const own: RemoteOvis = { version: "0.4.9", latest_version: null, updatable: false, reason: "That PC's Ovis does not update itself: it was not started by its updater.", address: "lab.invalid:7317", url: null };
  const offerInstall = () => {
    const runtime = internals.machines.get(SAVED)!;
    Object.assign(runtime.machine, { state: "error", action_required: "setup", remote_ovis: own });
    runtime.installFix = { mode: "replace", pid: 4242, target: { destination: "me@lab.invalid" } };
  };
  offerInstall();
  expect(manager.list().find((machine) => machine.id === SAVED)?.ovis_update).toMatchObject({ how: "install", updatable: true });
  expect(await (await call("update-all")).json()).toEqual({ started: [], queued: [], skipped: [{ machine_id: SAVED, reason: expect.stringContaining("start it for this PC alone") }] });
  expect(manager.installJob("none")).toBeUndefined();
  const byRoute = await (await call("install", "POST", { machine_id: SAVED })).json() as PcInstallJob;
  expect(byRoute).toMatchObject({ machine_id: SAVED, mode: "replace" });
  expect((await (await call(`install/${byRoute.id}`, "DELETE")).json() as PcInstallJob).phase).toBe("cancelled");
  const { job_id } = await (await call(`${SAVED}/update`)).json() as { job_id: string };
  await reached("me@lab.invalid");
  expect(await (await call(`${SAVED}/update`, "DELETE")).json()).toEqual({ cancelled: true });
  expect((await ended(job_id)).phase).toBe("cancelled");
  const third = await (await call(`${SAVED}/update`)).json() as { job_id: string };
  manager.remove(SAVED);
  expect((await ended(third.job_id)).phase).toBe("cancelled");
});

function connects(manager: MachineManager) {
  type Job = { id: string; phase: string; error: string | null; step: string; action_required?: string | null; remote_ovis?: { latest_version: string | null } | null };
  const asked: { update: boolean; revision: string | undefined }[] = [];
  const outcomes: (Partial<Job> & { offeredRevision?: string })[] = [];
  const jobs = (manager as unknown as { jobs: Map<string, { finished: Promise<void>; public: Job; offeredRevision?: string }> }).jobs;
  spyOn(manager, "setup").mockImplementation((request, options) => {
    asked.push({ update: request.update_remote === true, revision: options?.expectedRevision });
    const { offeredRevision, ...outcome } = outcomes.shift() ?? {};
    const job: Job = { id: `job-${asked.length}`, phase: "connecting", error: null, step: "", ...outcome };
    jobs.set(job.id, { finished: Promise.resolve(), public: job, ...(offeredRevision ? { offeredRevision } : {}) });
    return job as unknown as ReturnType<MachineManager["setup"]>;
  });
  const connect = (manager as unknown as { installConnect(request: { target: SshTarget; machine_id?: string; update: boolean; revision?: string }): { finished: Promise<string | null> } }).installConnect;
  return { asked, outcomes, connect };
}
const OLDER = { phase: "failed", action_required: "update_bridge", error: "older" } as const;

it("connects after an install without updating, and asks for the update only when that PC is still older than this app", async () => {
  const { manager } = fixture();
  const { asked, outcomes, connect } = connects(manager);
  outcomes.push({ phase: "connected" });
  expect(await connect({ target: { destination: "me@lab.invalid" }, machine_id: SAVED, update: true }).finished).toBeNull();
  expect(asked).toEqual([{ update: false, revision: undefined }]);
  asked.length = 0;
  outcomes.push({ ...OLDER, remote_ovis: { latest_version: "0.5.0" }, offeredRevision: "b".repeat(40) }, { phase: "connected" });
  expect(await connect({ target: { destination: "me@lab.invalid" }, machine_id: SAVED, update: true, revision: "c".repeat(40) }).finished).toBeNull();
  expect(asked).toEqual([{ update: false, revision: undefined }, { update: true, revision: "c".repeat(40) }]);
});

it("installs on a PC added here only as its card offers: never one not approved for this app, or past this app's release", async () => {
  const { manager, internals, call } = fixture();
  const runtime = internals.machines.get(SAVED)!;
  const offer = (latest: string | null) => {
    Object.assign(runtime.machine, { state: "error", action_required: "setup", remote_ovis: { version: "0.4.9", latest_version: latest, updatable: false, reason: "too old", address: "lab.invalid:7317", url: null } });
    runtime.installFix = { mode: "restart", pid: 4242, target: { destination: "me@lab.invalid" } };
  };
  offer("999.0.0");
  expect(manager.list().find((machine) => machine.id === SAVED)?.ovis_update).toMatchObject({ how: "install", updatable: false, reason: expect.stringContaining("newer than this app") });
  const refused = await call("install", "POST", { machine_id: SAVED });
  expect(refused.status).toBe(409);
  // a PC this app was not approved to manage: refused through the direct route too, as on its card
  offer("0.5.0");
  spyOn(manager as unknown as { mayManageBridge(runtime: unknown): boolean }, "mayManageBridge").mockReturnValue(false);
  const unapproved = await call("install", "POST", { machine_id: SAVED });
  expect(unapproved.status).toBe(409);
  expect((await unapproved.json() as { error: { message: string } }).error.message).toContain("Review the bridge update");
});

it("updates an older Ovis a fresh install finds already installed there, only to the release checked here", async () => {
  const { manager } = fixture();
  const { asked, outcomes, connect } = connects(manager);
  const build = spyOn(appBuild, "revision").mockReturnValue("b".repeat(40));
  cleanups.push(() => build.mockRestore());
  outcomes.push({ ...OLDER, remote_ovis: { latest_version: APP_VERSION }, offeredRevision: "b".repeat(40) }, { phase: "connected" });
  expect(await connect({ target: { destination: "me@fresh.invalid" }, update: true }).finished).toBeNull();
  expect(asked).toEqual([{ update: false, revision: undefined }, { update: true, revision: "b".repeat(40) }]);
  for (const [outcome, words] of [
    [{ ...OLDER, remote_ovis: { latest_version: "999.0.0-beta.1" }, offeredRevision: "b".repeat(40) }, "newer than this app"],
    [{ ...OLDER, remote_ovis: { latest_version: null }, offeredRevision: "b".repeat(40) }, "does not tell its version"],
    [{ ...OLDER, remote_ovis: { latest_version: APP_VERSION } }, "did not tell which release"],
    [{ ...OLDER, remote_ovis: { latest_version: "0.5.0" }, offeredRevision: "b".repeat(40) }, `another release now (v0.5.0) than the one shown (v${APP_VERSION})`],
    [{ ...OLDER, remote_ovis: { latest_version: APP_VERSION }, offeredRevision: "c".repeat(40) }, `another build of v${APP_VERSION}`],
  ] as const) {
    asked.length = 0;
    outcomes.push(outcome);
    expect(await connect({ target: { destination: "me@fresh.invalid" }, update: true }).finished).toContain(words);
    expect(asked).toEqual([{ update: false, revision: undefined }]);
  }
});

it("restarts a PC's Ovis from its card with the release that card showed, for the update after it", async () => {
  const { manager, internals } = fixture();
  const runtime = internals.machines.get(SAVED)! as typeof internals extends { machines: Map<string, infer R> } ? R & { remoteRevision?: string } : never;
  Object.assign(runtime.machine, { state: "error", action_required: "setup", remote_ovis: { version: "0.4.9", latest_version: "0.5.0", updatable: false, reason: "too old", address: "lab.invalid:7317", url: null } });
  runtime.installFix = { mode: "restart", pid: 4242, target: { destination: "me@lab.invalid" } };
  runtime.remoteRevision = "d".repeat(40);
  expect(manager.list().find((machine) => machine.id === SAVED)?.ovis_update).toMatchObject({ how: "install", updatable: true, revision: "d".repeat(40) });
  const installer = (manager as unknown as { installer: { start(request: { revision?: string }): { id: string } } }).installer;
  const start = spyOn(installer, "start").mockReturnValue({ id: "install-1" });
  runtime.remoteRevision = undefined;
  expect(() => manager.update(SAVED)).toThrow("did not tell which release");
  runtime.remoteRevision = "d".repeat(40);
  expect(() => manager.update(SAVED, "e".repeat(40))).toThrow("another release");
  expect(manager.update(SAVED, "d".repeat(40))).toEqual({ job_id: "install-1" });
  expect(start.mock.calls[0]![0]).toMatchObject({ revision: "d".repeat(40), plan: { mode: "restart", pid: 4242 } });
});

it("keeps one install or setup at a time per SSH address: across herdr sessions, and for two PCs saved at one address", async () => {
  const { manager, internals, reached } = fixture();
  const job = manager.install({ destination: "me@new.invalid" });
  await reached("me@new.invalid");
  expect(() => manager.setup({ destination: "me@new.invalid", session: "work" })).toThrow("Ovis is being installed on this PC");
  manager.cancelInstall(job.id);
  const runtime = internals.machines.get(SAVED)!;
  Object.assign(runtime.machine, { state: "error", action_required: "setup", remote_ovis: { version: "0.4.9", latest_version: null, updatable: false, reason: "not started by its updater", address: "lab.invalid:7317", url: null } });
  runtime.installFix = { mode: "replace", pid: 4242, target: { destination: "me@lab.invalid" } };
  const installer = (manager as unknown as { installer: { runningAt(target: SshTarget): unknown } }).installer;
  spyOn(installer, "runningAt").mockImplementation((target) => target.destination === "me@lab.invalid" ? { id: "other" } : undefined);
  expect(() => manager.install({ machine_id: SAVED })).toThrow("being installed or connected already");
});

it("cancels an automatic bridge update that is already running, not only one waiting its turn", () => {
  const { manager, internals } = fixture();
  const runtime = internals.machines.get(SAVED)!;
  const jobs = (manager as unknown as { jobs: Map<string, unknown> }).jobs;
  jobs.set("auto-1", { runtime, update: true, public: { id: "auto-1", phase: "uploading" } });
  (manager as unknown as { autoQueued: Set<string> }).autoQueued.add(SAVED);
  const cancel = spyOn(manager as unknown as { cancelJob(id: string): void }, "cancelJob").mockImplementation(() => {});
  expect(manager.cancelUpdate(SAVED)).toBe(true);
  expect(cancel).toHaveBeenCalledWith("auto-1", false, true);
});

it("starts no bridge update while the PC's own Ovis updates itself", () => {
  const { manager, internals } = fixture();
  const runtime = internals.machines.get(SAVED)! as Runtime & { ownJob?: { id: string; abort: AbortController } };
  runtime.ownJob = { id: "own-1", abort: new AbortController() };
  const setup = spyOn(manager, "setup");
  expect(() => manager.updateBridge(SAVED)).toThrow("already updating");
  expect(setup).not.toHaveBeenCalled();
});

it("offers no install for a PC added with a named herdr session, saying why", () => {
  const { manager, internals } = fixture();
  const runtime = internals.machines.get(SAVED)!;
  Object.assign(runtime.machine, { target: { destination: "me@lab.invalid", session: "work" }, state: "error", action_required: "setup", remote_ovis: { version: "0.4.9", latest_version: null, updatable: false, reason: "not started by its updater", address: "lab.invalid:7317", url: null } });
  runtime.installFix = { mode: "replace", pid: 4242, target: { destination: "me@lab.invalid", session: "work" } };
  expect(manager.list().find((machine) => machine.id === SAVED)?.ovis_update).toMatchObject({ how: "install", updatable: false, reason: expect.stringContaining("default session only") });
  expect(() => manager.install({ machine_id: SAVED })).toThrow("default session only");
});

it("has a restarted PC install the release its card showed even when it connects with no update asked", async () => {
  const { manager, internals } = fixture();
  const { asked, outcomes, connect } = connects(manager);
  const runtime = internals.machines.get(SAVED)!;
  const own = spyOn(manager as unknown as { updateOwn(runtime: unknown, shown?: string): string }, "updateOwn").mockReturnValue("own-1");
  outcomes.push({ phase: "connected" });
  runtime.machine.state = "connected";
  expect(await connect({ target: { destination: "me@lab.invalid" }, machine_id: SAVED, update: true, revision: "c".repeat(40) }).finished).toBeNull();
  expect(asked).toEqual([{ update: false, revision: undefined }]);
  expect(own).toHaveBeenCalledTimes(1);
  expect(own.mock.calls[0]![1]).toBe("c".repeat(40));
  own.mockClear(); asked.length = 0;
  outcomes.push({ ...OLDER, remote_ovis: { latest_version: "0.5.0" }, offeredRevision: "b".repeat(40) }, { phase: "connected" });
  expect(await connect({ target: { destination: "me@lab.invalid" }, machine_id: SAVED, update: true, revision: "c".repeat(40) }).finished).toBeNull();
  expect(own).not.toHaveBeenCalled();
});

it("ends a restart's install with the PC's own update it started: its error, or connected once it installed", async () => {
  const { manager, internals } = fixture();
  const { outcomes, connect } = connects(manager);
  const runtime = internals.machines.get(SAVED)! as Runtime & { ownJob?: { id: string; abort: AbortController; finished?: Promise<void> } };
  const asked = Promise.withResolvers<void>(), done = Promise.withResolvers<void>();
  spyOn(manager as unknown as { updateOwn(runtime: unknown, shown?: string): string }, "updateOwn").mockImplementation(() => {
    runtime.ownJob = { id: "own-1", abort: new AbortController(), finished: done.promise };
    asked.resolve();
    return "own-1";
  });
  outcomes.push({ phase: "connected" });
  runtime.machine.state = "connected";
  let settled = false;
  const install = connect({ target: { destination: "me@lab.invalid" }, machine_id: SAVED, update: true, revision: "c".repeat(40) }).finished.then((words) => { settled = true; return words; });
  await asked.promise;
  expect(settled).toBe(false);
  runtime.machine.update_error = "That PC offers another release now than the one shown.";
  done.resolve();
  expect(await install).toBe("That PC offers another release now than the one shown.");
});

function sshConfig(): (targets: SshTarget[]) => Promise<void> {
  const aliases: Record<string, string> = { "new-alias": "new.invalid", "lab-alias": "lab.invalid", "new.home": "new.invalid" };
  spyOn(sshAddresses, "resolve").mockImplementation(async (target) => {
    const at = target.destination.lastIndexOf("@");
    const host = target.destination.slice(at + 1);
    return `${at >= 0 ? target.destination.slice(0, at) : "me"}@${aliases[host] ?? host}:${target.port ?? 22}`;
  });
  forgetSshAddresses();
  return (targets: SshTarget[]) => warmSshAddresses(targets);
}

it("keeps one install or setup per PC as ssh resolves it: an alias, or the default port given, is the same PC", async () => {
  const { manager, reached } = fixture();
  const warm = sshConfig();
  await warm([{ destination: "me@new.invalid" }, { destination: "new-alias" }, { destination: "me@new.invalid", port: 22 }, { destination: "lab-alias" }, { destination: "me@lab.invalid" }, { destination: "me@lab.invalid", port: 22 }]);
  const job = manager.install({ destination: "me@new.invalid" });
  await reached("me@new.invalid");
  expect(() => manager.setup({ destination: "new-alias" })).toThrow("Ovis is being installed on this PC");
  expect(() => manager.setup({ destination: "me@new.invalid", port: 22 })).toThrow("Ovis is being installed on this PC");
  expect(() => manager.install({ destination: "new-alias" })).toThrow("being installed or connected already");
  manager.cancelInstall(job.id);
  for (const same of [{ destination: "lab-alias" }, { destination: "me@lab.invalid", port: 22 }]) expect(() => manager.install(same)).toThrow("already added here");
});

it("keeps one setup at a time per PC as ssh resolves it, whatever herdr session each names", async () => {
  const { manager, reached } = fixture();
  const warm = sshConfig();
  await warm([{ destination: "new-alias" }, { destination: "me@new.invalid" }, { destination: "me@new.invalid", port: 22 }, { destination: "me@other.invalid" }]);
  const first = manager.setup({ destination: "new-alias" });
  await reached("new-alias");
  for (const second of [{ destination: "me@new.invalid" }, { destination: "me@new.invalid", port: 22, session: "work" }, { destination: "new-alias", session: "work" }]) {
    expect(() => manager.setup(second)).toThrow("already connecting to this PC");
  }
  expect(() => manager.setup({ destination: "me@other.invalid" })).not.toThrow();
  manager.action(first.id, { action: "cancel" });
});

it("counts a PC that ssh cannot resolve as possibly busy, so an alias never starts a second job beside one", async () => {
  const { manager, reached } = fixture();
  const job = manager.install({ destination: "me@new.invalid" });
  await reached("me@new.invalid");
  (sshAddresses.resolve as unknown as { mockImplementation(fn: (target: SshTarget) => Promise<string | null>): void }).mockImplementation(async (target) => target.destination === "unresolved-alias" ? null : literalAddress(target));
  forgetSshAddresses();
  await warmSshAddresses([{ destination: "unresolved-alias" }]);
  expect(() => manager.setup({ destination: "unresolved-alias" })).toThrow("Ovis is being installed on this PC");
  manager.cancelInstall(job.id);
});

it("starts a first job for another PC at once, while its address is still being looked up", async () => {
  const { manager, reached } = fixture();
  const job = manager.install({ destination: "me@new.invalid" });
  await reached("me@new.invalid");
  forgetSshAddresses();
  expect(() => manager.setup({ destination: "me@other.invalid" })).not.toThrow();
  manager.cancelInstall(job.id);
});

it("refuses an alias typed for the first time while its host has a job, before ssh has resolved it", async () => {
  const { manager, reached } = fixture();
  const job = manager.install({ destination: "me@new.invalid" });
  await reached("me@new.invalid");
  forgetSshAddresses();
  expect(() => manager.setup({ destination: "new-alias" })).toThrow();
  manager.cancelInstall(job.id);
});

it("resolves a dotted alias typed for the first time before checking it, through the HTTP route", async () => {
  const { manager, reached, call } = fixture();
  sshConfig();
  const job = manager.install({ destination: "me@new.invalid" });
  await reached("me@new.invalid");
  forgetSshAddresses();
  const answer = await call("install", "POST", { destination: "new.home" });
  expect(answer.status).toBe(409);
  manager.cancelInstall(job.id);
});

it("keeps a saved PC's resolved address past its minute while it is looked up again, so a bare alias is never taken for another PC", async () => {
  fixture();
  const desktop = { destination: "desktop" }, other = { destination: "me@other.invalid" };
  await warmSshAddresses([desktop, other]);
  expect(samePc(desktop, other)).toBe(false);
  setSystemTime(new Date(Date.now() + 61_000));
  try {
    await warmSshAddresses([{ destination: "me@third.invalid" }]);
    expect(samePc(desktop, other)).toBe(false);
  } finally { setSystemTime(); }
});

it("ends a lookup at its limit even when something ssh started holds its output open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-ssh-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  // an "ssh" whose child outlives it, holding stdout, as a hung Match exec can
  const ssh = join(dir, "ssh");
  writeFileSync(ssh, "#!/bin/sh\nsleep 30 &\nsleep 30\n", { mode: 0o755 });
  const before = process.env["OVIS_SSH"];
  process.env["OVIS_SSH"] = ssh;
  cleanups.push(() => { if (before === undefined) delete process.env["OVIS_SSH"]; else process.env["OVIS_SSH"] = before; });
  const started = Date.now();
  expect(await resolveWithSsh({ destination: "held.invalid" })).toBeNull();
  expect(Date.now() - started).toBeLessThan(6000);
}, 10_000);

it("runs no ssh -G under bun test: the resolver is the test stand-in, never ssh itself", () => {
  expect(sshAddresses.resolve).not.toBe(resolveWithSsh);
});

it("cancels an install's follow-up connect as the person's cancel, so its update there is asked to stop too", async () => {
  const { manager } = fixture();
  const { outcomes, connect } = connects(manager);
  outcomes.push({ phase: "connected" });
  const cancel = spyOn(manager as unknown as { cancelJob(id: string, timedOut?: boolean, asked?: boolean): void }, "cancelJob").mockImplementation(() => {});
  const handle = connect({ target: { destination: "me@fresh.invalid" }, update: true }) as unknown as { job_id: string; cancel(): void; finished: Promise<string | null> };
  handle.cancel();
  expect(cancel).toHaveBeenCalledWith(handle.job_id, false, true);
  cancel.mockRestore();
  await handle.finished;
});

it("binds an install's follow-up update to this build's own revision without OVIS_REVISION, as the desktop app runs", async () => {
  const { manager } = fixture();
  const { asked, outcomes, connect } = connects(manager);
  const before = process.env["OVIS_REVISION"];
  delete process.env["OVIS_REVISION"];
  const build = spyOn(appBuild, "revision").mockReturnValue("b".repeat(40));
  cleanups.push(() => { build.mockRestore(); if (before !== undefined) process.env["OVIS_REVISION"] = before; });
  outcomes.push({ ...OLDER, remote_ovis: { latest_version: APP_VERSION }, offeredRevision: "b".repeat(40) }, { phase: "connected" });
  expect(await connect({ target: { destination: "me@desktop.invalid" }, update: true }).finished).toBeNull();
  expect(asked).toEqual([{ update: false, revision: undefined }, { update: true, revision: "b".repeat(40) }]);
});
