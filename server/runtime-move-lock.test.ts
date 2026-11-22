import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSnapshot } from "../shared/herdr-api.generated.ts";
import type { HerdrRuntimeFacts } from "../shared/machines.ts";
import type { MovePlanResponse } from "../shared/runtime-move.ts";
import { handleRequest, type ServerContext } from "./dispatch.ts";
import { unitHerdrOnly } from "../scripts/test-herdr.ts";
import { createServer } from "./index.ts";
import { moveService, type MoveService } from "./runtime-move-service.ts";
import * as moveLock from "./runtime-move-lock.ts";
import { MoveLockUnsafe, moveLockPath, takeMoveLock } from "./runtime-move-lock.ts";
import { createServer as listenOn } from "node:net";

afterAll(unitHerdrOnly());
const facts: HerdrRuntimeFacts = { serving: "herdr", source: "detected", tui: { installed: true, running: true }, app_installed: false, switch_to: "herdr-core", locked: null };
const root = mkdtempSync(join(tmpdir(), "ovis-runtime-move-lock-"));
const lockPath = moveLockPath(join(root, "herdr.sock"));
const services: MoveService[] = [];
const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: join(root, "app"), token: "fictional-token", tailscaleOwner: null, machines: false, sidecar: false });
afterEach(() => { for (const service of services.splice(0)) { service.cancel(); service.stop(); } rmSync(lockPath, { force: true }); });
afterAll(() => { app.stop(); rmSync(root, { recursive: true, force: true }); });

function server(bootId: string, snapshotFirst?: Promise<void>): MoveService {
  const snapshot = { workspaces: [{ workspace_id: "w1", label: "demo" }], tabs: [{ tab_id: "t1", workspace_id: "w1", label: "1", number: 1 }], layouts: [], agents: [],
    panes: [{ pane_id: "p9", tab_id: "t1", workspace_id: "w1", cwd: root, agent: "codex", agent_status: "working" }] } as unknown as SessionSnapshot;
  const service = moveService({
    stateDir: join(root, bootId), port: 0, serving: () => "herdr", facts: () => facts, stores: {}, holdsPending: () => false,
    lane: (_pane, task) => Promise.resolve(task()), settleAfterTyping: async () => {}, inputEmpty: async () => null,
    switchRuntime: () => null, accepted: () => true, switching: () => false, lock: { path: lockPath },
    stopDeps: { snapshot: async () => { await snapshotFirst; return snapshot; }, processInfo: async () => undefined, sendKeys: async () => {}, signalGroup: () => {}, ownGroup: async () => null, terminalGroup: async () => null },
  });
  services.push(service);
  return service;
}
const start = async (service: MoveService) => service.start(((await service.read()) as Extract<MovePlanResponse, { available: true }>).plan.revision);

it("lets one server of a herdr session move it at a time, and the other once that move ends", async () => {
  const own = server("own-server");
  const bridge = server("bridge-server");
  expect(await start(own)).toBeNull();
  expect((await own.read()).status.state).toBe("waiting");
  expect(await start(bridge)).toBe("locked");
  expect((await bridge.read()).status.state).toBe("idle");
  const ctx: ServerContext = { ...app.context, services: { ...app.context.services, runtimeMove: bridge }, requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 1 }), timeout: () => {} };
  const revision = ((await bridge.read()) as Extract<MovePlanResponse, { available: true }>).plan.revision;
  const refused = await handleRequest(new Request("http://127.0.0.1/api/runtime/move", { method: "POST", body: JSON.stringify({ revision }),
    headers: { host: "127.0.0.1", authorization: "Bearer fictional-token", "content-type": "application/json", "x-herdr-update": "1" } }), ctx);
  expect([refused?.status, await refused?.json()]).toEqual([409, { error: { code: "already_moving", message: expect.stringContaining("Another Ovis on this PC is moving this herdr session already") } }]);
  own.cancel();
  expect(existsSync(lockPath)).toBe(false);
  expect(await start(bridge)).toBeNull();
  bridge.stop();
  expect(await start(own)).toBeNull();
});

it("tells the reason a lock could not be taken, not a stock one", async () => {
  const service = server("unsafe-server");
  const ctx: ServerContext = { ...app.context, services: { ...app.context.services, runtimeMove: service }, requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 1 }), timeout: () => {} };
  const revision = ((await service.read()) as Extract<MovePlanResponse, { available: true }>).plan.revision;
  const reason = "fictional: this PC's filesystem refused the lock";
  const take = spyOn(moveLock, "takeMoveLock").mockRejectedValueOnce(new MoveLockUnsafe(reason));
  try {
    const refused = await handleRequest(new Request("http://127.0.0.1/api/runtime/move", { method: "POST", body: JSON.stringify({ revision }),
      headers: { host: "127.0.0.1", authorization: "Bearer fictional-token", "content-type": "application/json", "x-herdr-update": "1" } }), ctx);
    expect([refused?.status, await refused?.json()]).toEqual([409, { error: { code: "move_lock_unsafe", message: reason } }]);
  } finally { take.mockRestore(); }
});

const realLockFile = () => join(realpathSync(root), "runtime-move.lock");
const lockDescriptors = (): string[] => readdirSync("/proc/self/fd").filter((fd) => { try { return readlinkSync(`/proc/self/fd/${fd}`) === realLockFile(); } catch { return false; } });

it.skipIf(process.platform !== "linux")("closes the lock file again when reading it back fails", async () => {
  const failing = spyOn(fs, "fstatSync").mockImplementationOnce(() => { throw Object.assign(new Error("fictional EIO"), { code: "EIO" }); });
  try {
    await expect(takeMoveLock(lockPath)).rejects.toThrow("fictional EIO");
  } finally { failing.mockRestore(); }
  expect(lockDescriptors()).toEqual([]);
});

it.skipIf(process.platform !== "linux")("never hands the held lock file to a program a server starts", async () => {
  const held = await takeMoveLock(lockPath);
  try {
    const fds = lockDescriptors();
    expect(fds).toHaveLength(1);
    const flags = Number.parseInt(readFileSync(`/proc/self/fdinfo/${fds[0]}`, "utf8").match(/^flags:\s*(\d+)/m)![1]!, 8);
    expect(flags & 0o2000000).toBe(0o2000000);
  } finally { held!.release(); }
});

async function holderProcess(path: string): Promise<{ kill(): Promise<void> }> {
  const child = Bun.spawn([process.execPath, "-e", `const { takeMoveLock } = await import(${JSON.stringify(join(import.meta.dir, "runtime-move-lock.ts"))}); const held = await takeMoveLock(${JSON.stringify(path)}); console.log(held ? "held" : "refused"); setInterval(() => {}, 1000);`], { stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  const said = new TextDecoder().decode((await reader.read()).value);
  expect(said.trim()).toBe("held");
  return { kill: async () => { child.kill("SIGKILL"); await child.exited; } };
}

it("lets one holder at a time, the kernel's own: a second taker is refused while the first listens, and takes it once that one lets go", async () => {
  const first = await takeMoveLock(lockPath);
  expect(first).not.toBeNull();
  expect(await takeMoveLock(lockPath)).toBeNull();
  expect(await first!.holds()).toBe(true);
  first!.release();
  const second = await takeMoveLock(lockPath);
  expect(second).not.toBeNull();
  second!.release();
});

it("frees the lock when its holder's process dies, with nothing but the kernel to tell (no pid, no start time)", async () => {
  const holder = await holderProcess(lockPath);
  expect(await takeMoveLock(lockPath)).toBeNull();
  // killed outright: nothing of it cleans up, and its socket file stays behind with nobody listening
  await holder.kill();
  expect(existsSync(lockPath)).toBe(true);
  const taken = await takeMoveLock(lockPath);
  expect(taken).not.toBeNull();
  taken!.release();
});

it("leaves alone a file at the lock's name that is not a socket, and takes nothing there", async () => {
  writeFileSync(lockPath, "not a socket");
  await expect(takeMoveLock(lockPath)).rejects.toThrow(MoveLockUnsafe);
  expect(readFileSync(lockPath, "utf8")).toBe("not a socket");
});

it("of two servers that both find a dead holder's socket, lets only one go on", async () => {
  const holder = await holderProcess(lockPath);
  await holder.kill();
  let other: Awaited<ReturnType<typeof takeMoveLock>> | undefined;
  const mine = await takeMoveLock(lockPath, async (step) => { if (step === "bound" && other === undefined) other = await takeMoveLock(lockPath); });
  const holders = [mine, other].filter((held) => held !== null && held !== undefined);
  expect(holders).toHaveLength(1);
  expect(await holders[0]!.holds()).toBe(true);
  for (const held of holders) held!.release();
});

it("lets only one of two takers hold after a dead holder, even one that pauses between finding it dead and removing it", async () => {
  const holder = await holderProcess(lockPath);
  await holder.kill();
  const paused = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const late = takeMoveLock(lockPath, async (step) => { if (step === "stale") { paused.resolve(); await resume.promise; } });
  await paused.promise;
  const first = await takeMoveLock(lockPath);
  resume.resolve();
  const second = await late;
  const holders = [first, second].filter((held) => held !== null);
  expect(holders).toHaveLength(1);
  for (const held of holders) held!.release();
});

it("holds the session with the kernel's own lock: refused while another process holds it, free once that one dies", async () => {
  const holder = await holderProcess(lockPath);
  expect(await takeMoveLock(lockPath)).toBeNull();
  await holder.kill();
  const taken = await takeMoveLock(lockPath);
  expect(taken).not.toBeNull();
  expect(await taken!.holds()).toBe(true);
  taken!.release();
});

it("refuses a link or a folder at runtime-move.lock as unsafe, never following it", async () => {
  const lockFile = join(root, "runtime-move.lock");
  try {
    for (const make of [() => symlinkSync(join(root, "elsewhere"), lockFile), () => mkdirSync(lockFile)]) {
      rmSync(lockFile, { recursive: true, force: true });
      make();
      await expect(takeMoveLock(lockPath)).rejects.toThrow(MoveLockUnsafe);
      expect(existsSync(join(root, "elsewhere"))).toBe(false);
    }
  } finally { rmSync(lockFile, { recursive: true, force: true }); }
});

it("is refused while a server of the previous version holds only the socket, and lets go of its kernel lock then", async () => {
  const old = listenOn((socket) => socket.end("previous-version-token"));
  await new Promise<void>((resolve) => old.listen(lockPath, () => resolve()));
  try {
    expect(await takeMoveLock(lockPath)).toBeNull();
  } finally { await new Promise<void>((resolve) => old.close(() => resolve())); }
  const taken = await takeMoveLock(lockPath);
  expect(taken).not.toBeNull();
  taken!.release();
});

it("takes the lock in the real folder behind a symlink of this user's own (a dotfiles ~/.config), and refuses a folder anybody may write in", async () => {
  const real = join(root, "real");
  mkdirSync(real, { recursive: true, mode: 0o700 });
  symlinkSync(real, join(root, "link"));
  const held = await takeMoveLock(join(root, "link", "runtime-move.sock"));
  expect(held).not.toBeNull();
  expect(await takeMoveLock(join(real, "runtime-move.sock"))).toBeNull();
  held!.release();
  const open = join(root, "open");
  mkdirSync(open, { recursive: true });
  chmodSync(open, 0o777);
  await expect(takeMoveLock(join(open, "runtime-move.sock"))).rejects.toThrow(MoveLockUnsafe);
});

it("leaves no lock behind when the server stops while a start is under way", async () => {
  const probe = server("probe");
  const revision = ((await probe.read()) as Extract<MovePlanResponse, { available: true }>).plan.revision;
  const snapshot = Promise.withResolvers<void>();
  const service = server("stopping", snapshot.promise);
  const starting = service.start(revision);
  service.stop();
  snapshot.resolve();
  await starting;
  expect(existsSync(lockPath)).toBe(false);
});
