/**
 * Turning the lock on and off (device-row-states rows P11, S24, T46, T47, R10, and the hub's binding and platform
 * rulings): a window asks, the PC's screen confirms, and only then is the record written. Nothing from afar locks.
 */
import { expect, test } from "bun:test";
import type { Access } from "../access.ts";
import { bounded } from "../relay/test-helpers.ts";
import { desktopOwnerChannel, LocalConfirms } from "./local-confirm.ts";
import { lockRoutes, type LockStore } from "./lock-routes.ts";

const local: Access = { level: "full", via: "local", role: "drive" };
const relay: Access = { level: "full", via: "relay", role: "drive", device: { id: "0123456789abcdef", label: "Phone", role: "drive" } };

function store(initial: { bound?: boolean; locked?: string | null; strict?: boolean } = {}) {
  const writes: string[] = [];
  const removals = { pending: false };
  let wrote!: () => void;
  const written = new Promise<void>((resolve) => { wrote = resolve; });
  let locked = initial.locked ?? null;
  const lockStore: LockStore = {
    bound: () => initial.bound ?? true,
    state: () => ({ lock: locked, strict: initial.strict ?? false }),
    preview: () => ({ rows: [{ id: "0123456789abcdef", label: "Phone", origin: { from: "remote", how: "list" }, file: "account" }], grants: ["token"] }),
    lock: () => { writes.push("lock"); locked = "lock-1"; wrote(); },
    unlock: (id) => { writes.push(`unlock ${id}`); locked = null; wrote(); },
    removalsPending: () => removals.pending,
  };
  return { lockStore, writes, written, removals };
}

function routes(options: { platform?: NodeJS.Platform; store?: ReturnType<typeof store> } = {}) {
  const confirms = new LocalConfirms();
  const made = options.store ?? store();
  const handle = lockRoutes({ confirms, store: made.lockStore, platform: options.platform ?? "linux" });
  let push!: (line: string) => void;
  const input = new ReadableStream<Uint8Array>({ start(controller) { push = (line) => controller.enqueue(new TextEncoder().encode(line)); } });
  const channel = desktopOwnerChannel(confirms, { input, write: () => {} });
  const approve = (id: string) => push(`${JSON.stringify({ approve: id })}\n`);
  return { confirms, handle, approve, stop: () => channel.stop(), ...made };
}

const ask = (handle: ReturnType<typeof routes>["handle"], method: string, path: string, access: Access, body?: unknown) =>
  handle(new Request(`http://localhost${path}`, { method, headers: { origin: "http://localhost", host: "localhost", "x-herdr-machine": "1", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), path, access, access.level === "full" && access.via === "local");

test("T46: the PC tells whether it can lock, what a lock would end, and that it confirms on its screen", async () => {
  const { handle } = routes();
  const answer = await (await ask(handle, "GET", "/api/account/lock", local)).json();
  expect(answer).toEqual({ bound: true, locked: null, strict: false, confirm: "available",
    preview: { rows: [{ id: "0123456789abcdef", label: "Phone", origin: { from: "remote", how: "list" }, file: "account" }], grants: ["token"] } });
});

test("T46: asking to lock only puts the act on the screen; the screen's approval writes the lock", async () => {
  const { handle, confirms, writes, written, approve } = routes();
  const asked = await ask(handle, "POST", "/api/account/lock", local, {});
  expect(asked.status).toBe(202);
  const { confirm } = await asked.json() as { confirm: string };
  expect(writes).toEqual([]);
  expect(confirms.pending().map((open) => open.action)).toEqual([{ kind: "lock" }]);
  approve(confirm);
  await bounded(written);
  expect(writes).toEqual(["lock"]);
});

test("T47: an unlock names the lock it ends and is written only after the screen approves it", async () => {
  const { handle, confirms, writes, written, approve } = routes({ store: store({ locked: "lock-1" }) });
  const asked = await ask(handle, "POST", "/api/account/unlock", local, { lock: "lock-1" });
  expect(asked.status).toBe(202);
  const { confirm } = await asked.json() as { confirm: string };
  expect(confirms.pending().map((open) => open.action)).toEqual([{ kind: "unlock", lock: "lock-1" }]);
  approve(confirm);
  await bounded(written);
  expect(writes).toEqual(["unlock lock-1"]);
});

test("T46: approving two outstanding lock prompts writes only one lock", async () => {
  const { handle, confirms, writes, approve, stop } = routes();
  try {
    const first = await ask(handle, "POST", "/api/account/lock", local, {});
    const second = await ask(handle, "POST", "/api/account/lock", local, {});
    expect([first.status, second.status]).toEqual([202, 202]);
    for (const response of [first, second]) {
      const { confirm } = await response.json() as { confirm: string };
      const answered = confirms.answer(confirm);
      approve(confirm);
      expect(await bounded(answered)).toBe("approved");
    }
    expect(writes).toEqual(["lock"]);
  } finally { stop(); }
});

test("R10: nothing from afar locks or unlocks, even a device that drives this PC", async () => {
  const { handle, confirms } = routes({ store: store({ locked: "lock-1" }) });
  for (const path of ["/api/account/lock", "/api/account/unlock"]) {
    const tried = await ask(handle, "POST", path, relay, { lock: "lock-1" });
    expect([tried.status, (await tried.json() as { error: { code: string } }).error.code]).toEqual([403, "local_required"]);
  }
  expect(confirms.pending()).toEqual([]);
});

test("R10, S36-1: only this PC's own window asks: a Tailscale login, a token from elsewhere and the open network get local_required, and nothing reaches the screen", async () => {
  const { handle, confirms } = routes({ store: store({ locked: "lock-1" }) });
  for (const via of ["tailscale", "token", "open"] as const) {
    const caller: Access = { level: "full", via, role: "drive" };
    for (const path of ["/api/account/lock", "/api/account/unlock"]) {
      const tried = await handle(new Request(`http://localhost${path}`, { method: "POST", headers: { origin: "http://localhost", host: "localhost", "x-herdr-machine": "1", "content-type": "application/json" }, body: JSON.stringify({ lock: "lock-1" }) }), path, caller, false);
      expect({ via, path, status: tried.status, code: (await tried.json() as { error: { code: string } }).error.code }).toEqual({ via, path, status: 403, code: "local_required" });
    }
  }
  expect(confirms.pending()).toEqual([]);
  const asked = await ask(handle, "POST", "/api/account/unlock", local, { lock: "lock-1" });
  expect(asked.status).toBe(202);
});

test("t13r S36-1 (3): the screen says what the act does, that a browser on this PC asked, and until when", async () => {
  for (const [path, locked, title] of [["/api/account/lock", null, "Turn strict mode ON"], ["/api/account/unlock", "lock-1", "Turn strict mode OFF"]] as const) {
    const { handle, confirms } = routes({ store: store({ locked }) });
    expect((await ask(handle, "POST", path, local, locked === null ? {} : { lock: locked })).status).toBe(202);
    const [open] = confirms.pending();
    expect(open?.shown.title).toBe(title);
    expect(open?.shown.lines.join("\n")).toContain("A browser on this PC asked for this.");
    expect(open?.shown.lines.join("\n")).toMatch(/Approve by \d{1,2}:\d{2}/);
  }
});

test("T46: a PC in no account, an already locked PC, or one without screen proof offers no lock", async () => {
  const unbound = routes({ store: store({ bound: false }) });
  expect((await (await ask(unbound.handle, "POST", "/api/account/lock", local, {})).json() as { error: { code: string } }).error.code).toBe("not_bound");
  const lockedAlready = routes({ store: store({ locked: "lock-1" }) });
  expect((await (await ask(lockedAlready.handle, "POST", "/api/account/lock", local, {})).json() as { error: { code: string } }).error.code).toBe("already_locked");
  const mac = routes({ platform: "darwin" });
  expect((await (await ask(mac.handle, "GET", "/api/account/lock", local)).json() as { confirm: string }).confirm).toBe("unsupported");
  expect((await (await ask(mac.handle, "POST", "/api/account/lock", local, {})).json() as { error: { code: string } }).error.code).toBe("no_screen_proof");
});

test("T47: an unlock of a lock that is not the one in force is refused", async () => {
  const { handle } = routes({ store: store({ locked: "lock-1" }) });
  expect((await (await ask(handle, "POST", "/api/account/unlock", local, { lock: "lock-2" })).json() as { error: { code: string } }).error.code).toBe("not_locked");
});

test("T46/T47: while this run holds a lock's removals it could not write, an unlock is refused before the screen is asked", async () => {
  const made = store({ locked: "lock-1" });
  made.removals.pending = true;
  const { handle, confirms } = routes({ store: made });
  const asked = await ask(handle, "POST", "/api/account/unlock", local, { lock: "lock-1" });
  expect([asked.status, ((await asked.json()) as { error: { code: string } }).error.code]).toEqual([409, "lock_removals_pending"]);
  expect(confirms.pending()).toEqual([]);
});

test("T46/T47: an unlock prompt shown earlier and approved while the lock's removals are unwritten writes nothing", async () => {
  const made = store({ locked: "lock-1" });
  const { handle, confirms, writes, approve } = routes({ store: made });
  const asked = await ask(handle, "POST", "/api/account/unlock", local, { lock: "lock-1" });
  const { confirm } = await asked.json() as { confirm: string };
  made.removals.pending = true;
  // the route's own continuation was registered on the answer first, so it has run by the time this await returns
  const answered = confirms.answer(confirm);
  approve(confirm);
  expect(await bounded(answered)).toBe("approved");
  expect(writes).toEqual([]);
});
