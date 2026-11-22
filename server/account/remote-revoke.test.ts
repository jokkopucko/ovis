import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { exportAccountKey, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { handleDeviceRequest, type DeviceStore } from "../devices.ts";
import { handleRequest } from "../dispatch.ts";
import { relayConnection, relayFixture, caughtUp } from "../relay/test-helpers.ts";
import { applyAccountRecords } from "./records.ts";
import { memberSnapshotPc } from "./listed-pc.test-helpers.ts";

const ACCOUNT = "acct_1";
const SERVER_ID = "0123456789abcdef0123456789abcdef";
const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

interface Key { keys: CryptoKeyPair; spki: string }
async function key(): Promise<Key> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

function pc(token = "") {
  const f = relayFixture(false, { accountOpensAll: true, token });
  fixtures.push(f);
  return { f, devices: f.app.context.services.devices };
}

function snapshotPc() {
  const { fixture: f, firstRead } = memberSnapshotPc();
  fixtures.push(f);
  return { f, devices: f.app.context.services.devices, firstRead };
}

/** A drive member of the account here, admitted now: each one joins this PC after the ones before it. */
async function member(devices: DeviceStore): Promise<Key & { id: string }> {
  const k = await key();
  const id = devices.pairRelay(devices.startPairing().code, "Phone", k.spki)!.device.id;
  devices.linkAccountKey(id, k.spki, k.spki, ACCOUNT);
  return { ...k, id };
}

/** A request from `caller` through the relay, signed in with its key. */
async function remote(f: ReturnType<typeof relayFixture>, caller: Key & { id: string }) {
  const link = await relayConnection(f);
  caughtUp(f);
  await link.auth({ keys: caller.keys, publicKey: caller.spki, id: caller.id });
  return async (method: "GET" | "POST" | "DELETE", target: string) => {
    const response = await link.open(target, { method, headers: [["content-type", "application/json"], ["x-herdr-machine", "1"]] }).response;
    const text = await response.text();
    return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as { error?: { code: string; message: string }; devices?: { id: string; remote_revoke?: string }[]; revoke_all?: string } };
  };
}

/** A request on this PC itself: loopback, no forwarding, the app's own origin. */
const local = (f: ReturnType<typeof relayFixture>) => async (method: string, target: string) => {
  const base = `http://127.0.0.1:${f.app.port}`;
  const response = await fetch(base + target, { method, headers: { origin: base, "x-herdr-machine": "1" } });
  return { status: response.status };
};

describe("remote Revokes reach the caller itself and the rows that joined after it (rule B)", () => {
  test("T19: remote self or all-newer targets pass, but older or incomparable duplicates refuse the whole Revoke", async () => {
    const { f, devices } = pc();
    const [older, caller, newer, self] = [await member(devices), await member(devices), await member(devices), await member(devices)];
    const ask = await remote(f, caller);
    // the device list says, for this caller, what it may Revoke from afar
    const listed = (await ask("GET", "/api/devices")).body;
    expect(Object.fromEntries(listed.devices!.map((row) => [row.id, row.remote_revoke]))).toMatchObject({ [older.id]: "older", [caller.id]: "allowed", [newer.id]: "allowed" });
    expect(listed.revoke_all).toBe("local_only");
    // an older row is refused, with the words that say where it is done
    const refused = await ask("DELETE", `/api/devices/${older.id}`);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toEqual({ code: "older_device", message: "removing an older device is done from that PC or from an older device" });
    expect(devices.has(older.id)).toBe(true);
    // a newer row, and itself, pass
    expect((await ask("DELETE", `/api/devices/${newer.id}`)).status).toBe(204);
    expect(devices.has(newer.id)).toBe(false);
    // its own row: the Revoke ends the very session that asked, so the answer may not arrive; the row is gone
    const own = await remote(f, self);
    await own("DELETE", `/api/devices/${self.id}`).catch(() => undefined);
    expect(devices.has(self.id)).toBe(false);

    // a key with one row newer and one row older than the caller: the whole Revoke is refused
    const shared = await key();
    const first = devices.pairRelay(devices.startPairing().code, "Old", shared.spki)!.device.id;
    const middle = await member(devices);
    const second = devices.pairRelayApproved("New", shared.spki, { path: "account", addedBy: middle.id })!.device.id;
    const fromMiddle = await remote(f, middle);
    expect((await fromMiddle("DELETE", `/api/devices/${second}`)).status).toBe(403);
    expect(devices.has(first) && devices.has(second)).toBe(true);
  });

  test("T20: relay Revoke all is refused, but PC-local loopback Revoke all is allowed", async () => {
    const { f, devices } = pc();
    const [oldest] = [await member(devices), await member(devices)];
    const refused = await (await remote(f, oldest))("POST", "/api/devices/revoke-all");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toEqual({ code: "local_required", message: "Revoke all is done at that PC" });
    expect(devices.list(null)).toHaveLength(2);
    expect((await local(f)("POST", "/api/devices/revoke-all")).status).toBe(200);
    expect(devices.list(null)).toHaveLength(0);
  });

  test.each([
    ["Tailscale owner", "Revoke", "", "DELETE", 204],
    ["Tailscale owner", "Revoke all", "", "POST", 200],
    ["access-token owner", "Revoke", "test-revoke-token", "DELETE", 204],
    ["access-token owner", "Revoke all", "test-revoke-token", "POST", 200],
  ] as const)("S11-2, T20: %s can use PC-level %s only while unlocked", async (_login, action, token, method, status) => {
    const owner = "owner@example.com";
    const { f, devices } = pc(token);
    const screen = await key();
    const redemption = devices.redeemCode(devices.startPairing().code, "code", screen.spki);
    if (!("codeId" in redemption)) throw new Error("Could not redeem a pairing");
    const target = devices.admitConfirmed({ codeId: redemption.codeId, key: screen.spki, label: "Screen", source: "screen" });
    const log = f.app.context.services.safetyLog;
    if (!target || !log) throw new Error("Could not set up a screen-confirmed row and lock");
    const other = await member(devices);
    const path = action === "Revoke all" ? "/api/devices/revoke-all" : `/api/devices/${target.id}`;
    const request = (credentials: Record<string, string> = {}, verb: string = method, route = path) =>
      new Request(`http://127.0.0.1${route}`, {
        method: verb, headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "x-herdr-machine": "1", ...credentials },
      });
    const context = {
      ...f.app.context,
      requestIP: () => ({ address: "127.0.0.1" }),
      timeout: () => {},
      services: {
        ...f.app.context.services,
        identityOf: async () => ({ owner, soleLogin: null, dnsName: null, tailnetIp: null, tagged: false }),
      },
    };
    const tailscale = { "tailscale-user-login": owner, "x-forwarded-for": "100.64.0.1" };
    const credentials: Record<string, string> = token === "" ? tailscale : { authorization: `Bearer ${token}` };
    const ask = () => handleRequest(request(credentials), context);

    for (const via of ["open", "portal"] as const) {
      const refused = await handleDeviceRequest(request(), path, devices, { level: "full", via, role: "drive" }, null);
      expect(refused.status).toBe(403);
    }
    if (token === "") {
      const otherUser = await handleRequest(request({ ...tailscale, "tailscale-user-login": "visitor@example.com" }), context);
      expect(otherUser?.status).toBe(403);
    }
    const lock = log.appendLock({ account: ACCOUNT });
    if (lock.outcome !== "applied") throw new Error("Could not lock the PC");
    expect((await ask())?.status).toBe(403);
    expect(devices.has(target.id)).toBe(true);
    expect(log.appendUnlock(lock.id, { account: ACCOUNT }).outcome).toBe("applied");

    const listed = await handleRequest(request(credentials, "GET", "/api/devices"), context);
    expect((await ask())?.status).toBe(status);
    expect(devices.has(target.id)).toBe(false);
    expect(devices.has(other.id)).toBe(action === "Revoke");
    const body = await listed?.json();
    expect(body).not.toHaveProperty("revoke_all");
    expect(body?.devices).toContainEqual(expect.objectContaining({ id: target.id }));
    expect(body?.devices.find((row: { id: string }) => row.id === target.id)).not.toHaveProperty("remote_revoke");
  });

  test("R1/T19: self-Revoke does not extend to an older twin", async () => {
    const { devices, firstRead } = snapshotPc();
    const older = await member(devices);
    await firstRead();
    const later = devices.pairRelayApproved("Later", older.spki, { path: "account", addedBy: older.id });
    if (later === null) throw new Error("Could not set up duplicate rows");

    expect(devices.remoteRevoke(later.device.id, later.device.id)).toBe("unorderable");
  });

  test("R1/T19: self-Revoke does not silently remove a newer twin either", async () => {
    const { devices, firstRead } = snapshotPc();
    const older = await member(devices);
    await firstRead();
    const later = devices.pairRelayApproved("Later", older.spki, { path: "account", addedBy: older.id });
    if (later === null) throw new Error("Could not set up duplicate rows");

    expect(devices.remoteRevoke(older.id, older.id)).toBe("unorderable");
  });

  test("S11-3, R1: a caller cannot revoke a newer twin of its own key", async () => {
    const { devices, firstRead } = snapshotPc();
    const caller = await member(devices);
    const other = await member(devices);
    await firstRead();
    expect(devices.remoteRevoke(caller.id, caller.id)).toBe("allowed");
    expect(devices.remoteRevoke(caller.id, other.id)).toBe("allowed");
    const twin = devices.pairRelayApproved("Twin", caller.spki, { path: "account", addedBy: caller.id });
    if (twin === null) throw new Error("Could not set up duplicate rows");

    expect(devices.remoteRevoke(caller.id, twin.device.id)).toBe("unorderable");
  });

  test("T19: a watch caller sees read_only for every row it cannot Revoke", async () => {
    const { f, devices } = pc();
    const [watch, newer] = [await member(devices), await member(devices)];
    devices.update(watch.id, { role: "watch" });
    const ask = await remote(f, watch);

    const list = await ask("GET", "/api/devices");
    const refused = await ask("DELETE", `/api/devices/${newer.id}`);
    expect(list.status).toBe(200);
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "read_only" } } });
    expect(list.body.devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: watch.id, remote_revoke: "read_only" }),
      expect.objectContaining({ id: newer.id, remote_revoke: "read_only" }),
    ]));
  });

  test("P21/T36: a member cannot sign a remove when the target has no known admission age", async () => {
    const { devices } = pc();
    const signer = await member(devices);
    const target = await key();

    expect(devices.removeAuthority(signer.spki, target.spki, ACCOUNT)).toBe(false);
  });

  test.each(["a newer key", "its own key"])("T36: a mailbox-held member cannot sign a remove for %s", async (targetKind) => {
    const { f, devices, firstRead } = snapshotPc();
    const signer = await member(devices);
    const target = targetKind === "its own key" ? signer : await member(devices);
    await firstRead();
    f.app.context.services.accountHolds.hold([signer.spki]);
    const gates = f.app.context.services.accountMailbox.gates();
    expect(gates.held(signer.spki)).toBe(true);
    const record = await signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT, key: target.spki, issued_at: new Date().toISOString(), id: newRecordId(), signer: signer.spki }, signer.keys.privateKey);
    const write = spyOn(devices, "removeAccountKey").mockReturnValue(false);
    try {
      expect(await applyAccountRecords(devices, [record], SERVER_ID, Date.now(), gates)).toEqual([
        { id: record.id, outcome: "refused", code: "removal_pending" },
      ]);
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  test("T36: signed leave or an older member's authorized remove can commit, with all duplicates checked", async () => {
    const { fixture, firstRead } = memberSnapshotPc();
    fixtures.push(fixture);
    const { devices } = fixture.app.context.services;
    const [older, target, leaving] = [await member(devices), await member(devices), await member(devices)];
    await firstRead();
    const remove = (of: string, by: Key) => signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT, key: of, issued_at: new Date().toISOString(), id: newRecordId(), signer: by.spki }, by.keys.privateKey);
    // a newer member signs the remove of an older one: refused, nothing changes
    expect((await applyAccountRecords(devices, [await remove(older.spki, leaving)], SERVER_ID))[0]).toMatchObject({ outcome: "refused", code: "older_device" });
    expect(devices.has(older.id)).toBe(true);
    // an older member's remove of a newer one commits
    expect((await applyAccountRecords(devices, [await remove(target.spki, older)], SERVER_ID))[0]!.outcome).toBe("applied");
    expect(devices.has(target.id)).toBe(false);
    // a signed leave always commits
    expect((await applyAccountRecords(devices, [await remove(leaving.spki, leaving)], SERVER_ID))[0]!.outcome).toBe("applied");
    expect(devices.has(leaving.id)).toBe(false);
    // a key that also has a row older than the signer: the whole remove is refused
    const shared = await key();
    const early = devices.pairRelay(devices.startPairing().code, "Early", shared.spki)!.device.id;
    devices.linkAccountKey(early, shared.spki, shared.spki, ACCOUNT);
    const signer = await member(devices);
    devices.pairRelayApproved("Late", shared.spki, { path: "account", addedBy: signer.id });
    expect((await applyAccountRecords(devices, [await remove(shared.spki, signer)], SERVER_ID))[0]).toMatchObject({ outcome: "refused", code: "older_device" });
    expect(devices.has(early)).toBe(true);
  });

  test("T37: account-joined row Revoke of a newer row grants no signed remove authority", async () => {
    const { fixture: f, firstRead } = memberSnapshotPc();
    fixtures.push(f);
    const { devices } = f.app.context.services;
    const [first, caller] = [await member(devices), await member(devices)];
    await firstRead();
    const added = devices.pairRelayApproved("Added", (await key()).spki, { path: "account", addedBy: first.id })!.device.id;
    // the caller may Revoke the row that joined after it, from afar
    expect((await (await remote(f, caller))("DELETE", `/api/devices/${added}`)).status).toBe(204);
    // and that gives it no right to sign the remove of a key that joined before it
    const remove = await signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT, key: first.spki, issued_at: new Date().toISOString(), id: newRecordId(), signer: caller.spki }, caller.keys.privateKey);
    expect((await applyAccountRecords(devices, [remove], SERVER_ID))[0]).toMatchObject({ outcome: "refused", code: "older_device" });
    expect(devices.has(first.id)).toBe(true);
  });

  test("T20: a valid non-local reset request reaches the reset authorization check", async () => {
    const token = "test-reset-drive-token";
    const { f, devices } = pc(token);
    await member(devices);
    const origin = `http://127.0.0.1:${f.app.port}`;
    const refused = await fetch(`${origin}/api/relay/reset-identity`, {
      method: "POST", headers: { origin, "x-herdr-update": "1", authorization: `Bearer ${token}` },
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: { code: "local_required", message: "Resetting the relay identity is done at that PC" } });
    expect(devices.list(null)).toHaveLength(1);
  });
});
