import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey } from "../../shared/account-records.ts";
import { DeviceStore } from "../devices.ts";
import { privateStateFs } from "../private-state.ts";
import { loadRelayIdentity } from "../relay/identity.ts";
import { relayFixture } from "../relay/test-helpers.ts";
import { ADMISSION_FILE } from "./admission-order.ts";
import { PcAccountState } from "./pc-binding.ts";

const ACCOUNT = "acct_1";
const dirs: string[] = [];
const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-pc-binding-gate-"));
  dirs.push(dir);
  return dir;
}
const key = async () => exportAccountKey((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])).publicKey);
const store = (dir: string) => new DeviceStore(dir, null, null, { pc: PcAccountState.open(dir) });
const pcFile = (dir: string) => JSON.parse(readFileSync(join(dir, ADMISSION_FILE), "utf8")) as Record<string, unknown> & { binding: { account: string; bind_id: string } | null; clears: unknown[]; next_admit: number; others_ever: boolean };
function start(dir: string, accountOpensAll: boolean, sibling?: string) {
  const fixture = relayFixture(false, { stateDir: dir, accountOpensAll, ...(sibling ? { siblingStateDir: sibling } : {}) });
  fixtures.push(fixture);
  dirs.splice(dirs.indexOf(dir), 1);
  return fixture.app.context.services.devices;
}
async function linked(devices: DeviceStore, account = ACCOUNT): Promise<{ id: string; key: string }> {
  const k = await key();
  const id = devices.pairRelay(devices.startPairing().code, "Phone", k)!.device.id;
  if (devices.linkAccountKey(id, k, k, account) === null) throw new Error("link failed");
  return { id, key: k };
}

describe("the PC's account binding holds through upgrades, siblings and failures (P12, T13, T59, T67)", () => {
  test("P21: S2-03's account-pc.json, as main writes it, is read with the flag on and off, and the upgrade binds the rows' account", async () => {
    for (const flag of [false, true]) {
      const dir = stateDir();
      writeFileSync(join(dir, ADMISSION_FILE), JSON.stringify({ v: 1, next_admit: 1 }), { mode: 0o600 });
      const devices = start(dir, flag);
      expect(() => devices.startPairing()).not.toThrow();
      expect(devices.failsClosed).toBe(false);
    }
  });

  test("P12, T59: a bind_id either folder lists among its clears never stands, and two standing accounts fail closed", () => {
    const [a, b] = [stateDir(), stateDir()];
    const one = PcAccountState.open(a);
    one.migrate(null, false);
    one.bind(ACCOUNT, "first").commit();
    writeFileSync(join(b, ADMISSION_FILE), readFileSync(join(a, ADMISSION_FILE)), { mode: 0o600 });
    one.clear("unlisted", "account");
    // the stale copy starts beside the folder that cleared its binding
    expect(start(b, true, a).account()).toBeNull();
    expect(pcFile(b).clears).toHaveLength(1);
    const [c, d] = [stateDir(), stateDir()];
    for (const [dir, account] of [[c, "acct_a"], [d, "acct_b"]] as const) {
      const state = PcAccountState.open(dir);
      state.migrate(null, false);
      state.bind(account, account).commit();
    }
    expect(start(c, true, d).failsClosed).toBe(true);
  });

  test("P12, T48: a clear in the active folder survives starting its sibling alone after merge", () => {
    const [a, b] = [stateDir(), stateDir()];
    const active = PcAccountState.open(a);
    active.migrate(null, false);
    active.bind(ACCOUNT, "first").commit();
    writeFileSync(join(b, ADMISSION_FILE), readFileSync(join(a, ADMISSION_FILE)), { mode: 0o600 });
    expect(active.clear("unlisted", "account")).toBe(true);

    const merged = start(a, true, b);

    expect(merged.failsClosed).toBe(false);
    expect(merged.account()).toBeNull();
    expect(start(b, true).account()).toBeNull();
  });

  test("T13: a failure after the member row is on disk takes nothing back: the binding and the count stand", async () => {
    const dir = stateDir();
    const devices = store(dir);
    const k = await key();
    // a code made for a PC in no account: its device waits, and its link makes it a member
    const id = devices.pairRelay(devices.startAccountPairing(ACCOUNT).code, "First", k)!.device.id;
    devices.onPaired(() => { throw new Error("notification failed"); });
    try { devices.linkAccountKey(id, k, k, ACCOUNT); } catch { /* the notification's failure */ }
    expect(pcFile(dir).binding?.account).toBe(ACCOUNT);
    expect(pcFile(dir).next_admit).toBe(2);
    expect(store(dir).failsClosed).toBe(false);
  });

  test("T13: a stop between the binding and the member row leaves the PC in no account at the next start", async () => {
    const dir = stateDir();
    const devices = store(dir);
    const k = await key();
    devices.pairRelay(devices.startPairing().code, "First", k);
    // the binding of a first link reached the disk, its row did not
    PcAccountState.open(dir).bind(ACCOUNT, k);
    expect(store(dir).account()).toBeNull();
  });

  test("T67, H2: a second account row sets others_ever, and a PC that had devices is never a first-device PC", async () => {
    const dir = stateDir();
    const devices = store(dir);
    await linked(devices);
    expect(pcFile(dir).others_ever).toBe(false);
    await linked(devices);
    expect(pcFile(dir).others_ever).toBe(true);
    expect(PcAccountState.open(dir).othersEver()).toBe(true);
    // a flag-off PC whose every device was revoked: its gate stays closed, so it has had devices
    const used = stateDir();
    const before = new DeviceStore(used);
    before.pair(before.startPairing().code, "Former", "drive");
    before.revokeAll();
    store(used);
    expect(pcFile(used).others_ever).toBe(true);
  });

  test("T59: Revoke all that cannot clear the binding does not report success", async () => {
    const dir = stateDir();
    const devices = store(dir);
    await linked(devices);
    const rename = privateStateFs.renameSync;
    privateStateFs.renameSync = (from, to) => {
      if (to === join(dir, ADMISSION_FILE)) throw new Error("simulated EIO");
      return rename(from, to);
    };
    try { expect(() => devices.revokeAll()).toThrow(); } finally { privateStateFs.renameSync = rename; }
    expect(devices.failsClosed).toBe(true);
  });

  test("S19: a binding whose account is not a string is damage, not a PC in no account", () => {
    const dir = stateDir();
    writeFileSync(join(dir, ADMISSION_FILE), JSON.stringify({ v: 1, next_admit: 1, binding: { bind_id: "a".repeat(32) }, clears: [], first: null, others_ever: false }), { mode: 0o600 });
    expect(PcAccountState.open(dir).strict).not.toBeNull();
  });

  test("P12, S19: after both folders migrated, a sibling's standing binding is this folder's too, and rows of an account the PC is not in fail closed", async () => {
    const [a, b] = [stateDir(), stateDir()];
    store(a);
    const there = store(b);
    await linked(there, "acct_x");
    expect(PcAccountState.open(a).account()).toBeNull();
    // the sibling's member rows come in with the merge; its binding comes with them
    const devices = start(a, true, b);
    expect(devices.account()).toBe("acct_x");
    expect(() => devices.startPairing()).not.toThrow();
    // whatever brought them, member rows of an account the PC is not in leave it strict
    const c = stateDir();
    store(c);
    const registry = JSON.parse(readFileSync(join(b, "devices.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(c, "devices.json"), JSON.stringify(registry), { mode: 0o600 });
    expect(store(c).failsClosed).toBe(true);
  });

  test("T67, H2: a member a signed add brings in sets others_ever", async () => {
    const dir = stateDir();
    const devices = store(dir);
    const member = await linked(devices);
    devices.addAccountDevice({ id: "b".repeat(16), key: await key(), label: "Added", role: "drive", account: ACCOUNT, addedBy: member.id });
    expect(pcFile(dir).others_ever).toBe(true);
  });

  test("S19: a PC already strict clears no binding it cannot write, and Revoke all and an identity reset still go through", async () => {
    const dir = stateDir();
    const devices = store(dir);
    await linked(devices);
    writeFileSync(join(dir, ADMISSION_FILE), JSON.stringify({ ...pcFile(dir), next_admit: 1 }), { mode: 0o600 });
    const strict = store(dir);
    expect(strict.failsClosed).toBe(true);
    expect(() => strict.revokeAll()).not.toThrow();
    expect(strict.clearAccountBinding("identity_reset", "pc")).toBe(false);
  });

  test("T13: a first link whose binding cannot be made to stand is no success, and a pending binding whose row is on disk stands at the next start", async () => {
    const dir = stateDir();
    const devices = store(dir);
    const k = await key();
    const id = devices.pairRelay(devices.startPairing().code, "First", k)!.device.id;
    const rename = privateStateFs.renameSync;
    let writes = 0;
    privateStateFs.renameSync = (from, to) => {
      // the pending binding is written, then the row; the write that makes the binding stand fails
      if (to === join(dir, ADMISSION_FILE) && ++writes === 2) throw new Error("simulated EIO");
      return rename(from, to);
    };
    try { expect(() => devices.linkAccountKey(id, k, k, ACCOUNT)).toThrow(); } finally { privateStateFs.renameSync = rename; }
    expect(devices.failsClosed).toBe(true);
    // the row is on disk with its pending binding: the next start makes it stand
    expect(store(dir).account()).toBe(ACCOUNT);
  });

  test("P12: a folder taking its sibling's standing binding takes the key that first bound it too", async () => {
    const [a, b] = [stateDir(), stateDir()];
    store(a);
    const there = store(b);
    const first = await linked(there, "acct_x");
    start(a, true, b);
    expect(PcAccountState.open(a).first()?.key).toBe(first.key);
  });

  test("P12: only a binding of this PC's own relay identity counts: another identity's folder is no sibling of it", () => {
    const [a, b] = [stateDir(), stateDir()];
    for (const [dir, account] of [[a, "acct_a"], [b, "acct_b"]] as const) {
      const state = PcAccountState.open(dir);
      state.migrate(null, false);
      state.bind(account, account).commit();
      loadRelayIdentity(dir);
    }
    const devices = start(a, true, b);
    expect(devices.failsClosed).toBe(false);
    expect(devices.account()).toBe("acct_a");
  });

  test("P12: Revoke all with the flag off clears the binding the flag-on PC left, so the next flag-on start is in no account", async () => {
    const dir = stateDir();
    await linked(store(dir));
    new DeviceStore(dir).revokeAll();
    expect(store(dir).account()).toBeNull();
  });

  test("P12: an identity reset with the flag off clears the binding the flag-on PC left", async () => {
    const dir = stateDir();
    await linked(store(dir));
    const f = relayFixture(false, { stateDir: dir, accountOpensAll: false });
    fixtures.push(f);
    dirs.splice(dirs.indexOf(dir), 1);
    await f.app.context.services.relay.resetIdentity();
    f.app.stop();
    fixtures.pop();
    dirs.push(dir);
    expect(store(dir).account()).toBeNull();
  });
});
