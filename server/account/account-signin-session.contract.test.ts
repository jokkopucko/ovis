import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DeviceJournal, JOURNAL_FILE } from "./device-journal.ts";
import { privateStateFs } from "../private-state.ts";
import { ACCOUNT_DEVICES_FILE } from "./account-devices.ts";
import { keyOf } from "./account-devices.test-helpers.ts";
import { parseAccountDevicesFile } from "../../shared/account-snapshot.ts";
import { accountDeviceId, newRecordId, signAccountRecord, signSafetyRecord } from "../../shared/account-records.ts";
import { applyAccountRecords } from "./records.ts";
import { ACCOUNT, createListedPc, registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { ask, phone } from "./pairing.test-helpers.ts";
import { PcAccountState } from "./pc-binding.ts";
import { FrameType, type MuxFrame, ACCOUNT_OPENS_ALL_FEATURE } from "../../shared/relay-mux.ts";
import { bounded, relayConnection, relayDevice, relayFixture, TestClock } from "../relay/test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

const listedPc = () => createListedPc(close => closes.push(close));

async function refusal(pc: Pick<Awaited<ReturnType<typeof listedPc>>, "fixture" | "device" | "serverId">, features: readonly string[]) {
  const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
  let failed: Extract<MuxFrame, { type: typeof FrameType.SESSION_ERROR }>["payload"] | undefined;
  link.onFrame = (frame) => { if (frame.type === FrameType.SESSION_ERROR) failed = frame.payload; };
  void link.auth(pc.device, features).catch(() => undefined);
  await bounded(link.serverError);
  return failed;
}

describe("S2-25 an account-joined sign-in over the relay (S25)", () => {
  test("flag off: relay AUTH for a listed-only row bypasses account matching", async () => {
    const clock = new TestClock();
    const epoch = Date.now();
    const time = spyOn(Date, "now").mockImplementation(() => epoch + clock.now());
    closes.push(() => time.mockRestore());
    const { fixture, device, serverId } = await createListedPc(close => closes.push(close), clock);
    clock.advance(JOIN_HOLD_MS);
    const live = await relayConnection(fixture, { serverId });
    expect(await live.auth(device, [ACCOUNT_OPENS_ALL_FEATURE])).toMatchObject({ device_id: device.id });
    live.channel.close(1000);
    fixture.app.stop();

    const rolledBack = relayFixture(false, { stateDir: fixture.stateDir, accountOpensAll: false, accountService: { url: "off" } });
    const match = spyOn(rolledBack.app.context.services.devices, "matchAccountRelay");
    try {
      const link = await relayConnection(rolledBack, { serverId });
      expect(await bounded(Promise.race([link.auth(device, [ACCOUNT_OPENS_ALL_FEATURE]), link.serverError]))).toBe("auth_failed");
      expect(match).not.toHaveBeenCalled();
    } finally { match.mockRestore(); rolledBack.close(); }
  });

  test("T59/T67: a first link without a proved list key leaves the sole listed device in join_hold", async () => {
    const service = new FakeAccountService();
    service.opensAll = true;
    const fixture = relayFixture(false, { accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch } });
    closes.push(() => fixture.close());
    const serverId = await registerSnapshotPc(service, fixture);
    const paired = await relayDevice(fixture);
    const member = await phone();
    const link = await relayConnection(fixture, { serverId });
    await link.auth(paired);
    const record = await signAccountRecord({ v: 1, kind: "link", account: ACCOUNT, key: member.spki, server_id: serverId, device_id: paired.id,
      old_key: paired.publicKey, issued_at: new Date().toISOString(), id: newRecordId(), signer: member.spki }, member.keys.privateKey);
    expect((await ask(link, "/api/account/link", { method: "POST", body: { record } })).status).toBe(200);
    // binding the PC starts the wait after a start (S2-27, T59): the moved key signs in after the binding's first whole read
    expect(await fixture.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    const enrolled = await relayConnection(fixture, { serverId });
    await enrolled.auth({ id: paired.id, keys: member.keys, publicKey: member.spki });
    expect((await ask(enrolled, "/api/account/enroll", { method: "POST", body: { account: ACCOUNT, records: [], last: true } })).status).toBe(200);
    const binding = PcAccountState.open(fixture.stateDir);
    expect(binding.first()).toEqual({ key: member.spki, list_key: null });
    expect(binding.othersEver()).toBe(false);

    service.registerDevice(ACCOUNT, paired.publicKey, "First phone");
    expect(await fixture.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    const device = { ...paired, id: accountDeviceId(serverId, paired.publicKey) };
    expect(await refusal({ fixture, serverId, device }, [ACCOUNT_OPENS_ALL_FEATURE])).toMatchObject({ code: "held", hold: { reason: "join_hold" } });
  });
  test.each([
    ["revoke", JOURNAL_FILE], ["remove", JOURNAL_FILE], ["remove", ACCOUNT_DEVICES_FILE],
    ["block", JOURNAL_FILE], ["block", ACCOUNT_DEVICES_FILE], ["revoke_all", ACCOUNT_DEVICES_FILE],
  ] as const)("P8, T41: offline restart records %s once after replacement of %s failed", async (act, file) => {
    const { fixture, device, member, serverId } = await listedPc();
    const { devices } = fixture.app.context.services;
    const { stateDir } = fixture;
    const rename = privateStateFs.renameSync;
    const fault = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
      if (to === join(stateDir, file)) throw new Error("replacement failed");
      rename(from, to);
    });
    try {
      switch (act) {
        case "revoke": expect(() => devices.revoke(device.id)).toThrow("replacement failed"); break;
        case "revoke_all": expect(() => devices.revokeAll()).toThrow("replacement failed"); break;
        case "remove": {
          const record = await signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT, signer: device.publicKey,
            key: device.publicKey, id: newRecordId(), issued_at: new Date().toISOString() }, device.keys.privateKey);
          await expect(applyAccountRecords(devices, [record], serverId)).rejects.toThrow("replacement failed");
          break;
        }
        case "block": {
          const record = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: device.publicKey,
            signer: member.publicKey, target_no: 2, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, member.keys.privateKey);
          expect(await devices.applyBlock(record, "handed")).toMatchObject({ outcome: "applied" });
          break;
        }
      }
    } finally { fault.mockRestore(); }
    expect(devices.has(device.id)).toBe(false);
    const registry = () => parseAccountDevicesFile(JSON.parse(readFileSync(join(stateDir, ACCOUNT_DEVICES_FILE), "utf8"))).devices;
    if (act !== "revoke") expect(registry().map(row => row.id)).toEqual([device.id]);
    fixture.app.stop();
    const recovered = relayFixture(false, { stateDir, accountOpensAll: true, accountService: { url: "off" } });
    try {
      const restarted = recovered.app.context.services.devices;
      expect(restarted.isTombstoned(device.publicKey)).toBe(true);
      expect(restarted.has(member.id)).toBe(act !== "revoke_all");
      expect(restarted.has(device.id)).toBe(false);
      expect(registry()).toEqual([]);
      const history = DeviceJournal.open(stateDir).entries().filter(entry => entry.row === device.id);
      expect(history.map(({ kind, how }) => [kind, how])).toEqual([["admit", "list"], ["drop", act]]);
    } finally { recovered.app.stop(); }
  });

  test.each(["before", "after"] as const)("P8, T41: startup finishes an account revoke interrupted %s its journal write", async (cut) => {
    const { fixture, device, member } = await listedPc();
    const { devices } = fixture.app.context.services;
    const path = join(fixture.stateDir, ACCOUNT_DEVICES_FILE);
    const checkpoint = `${path}.at-interrupt`;
    const append = DeviceJournal.prototype.append;
    const failure = spyOn(DeviceJournal.prototype, "append").mockImplementation(function (this: DeviceJournal, entry) {
      if (entry.kind === "drop" && entry.how === "revoke") {
        copyFileSync(path, checkpoint);
        if (cut === "after") append.call(this, entry);
        throw new Error("journal unavailable");
      }
      return append.call(this, entry);
    });
    try { expect(() => devices.revoke(device.id)).toThrow("journal unavailable"); } finally { failure.mockRestore(); }
    const knownAfterFailure = devices.has(device.id);
    expect(devices.isTombstoned(device.publicKey)).toBe(true);
    fixture.app.stop();
    // A process stop at the checkpoint runs no final registry write.
    copyFileSync(checkpoint, path);
    const recovered = relayFixture(false, { stateDir: fixture.stateDir, accountOpensAll: true, accountService: { url: "off" } });
    try {
      const rows = parseAccountDevicesFile(JSON.parse(readFileSync(path, "utf8"))).devices;
      const restarted = recovered.app.context.services.devices;
      expect({ knownAfterFailure, persisted: rows.map(row => row.id), knownAfterRestart: restarted.has(device.id) })
        .toEqual({ knownAfterFailure: false, persisted: [], knownAfterRestart: false });
      expect(restarted.isTombstoned(device.publicKey)).toBe(true);
      expect(restarted.has(member.id)).toBe(true);
      const history = DeviceJournal.open(fixture.stateDir).entries().filter(entry => entry.row === device.id);
      expect(history.map(({ kind, how }) => [kind, how])).toEqual([["admit", "list"], ["drop", "revoke"]]);
    } finally { recovered.app.stop(); }
  });

  test("T20, P8: revoke-all intent and all session closes survive a failed account drop journal", async () => {
    const { fixture, device, member } = await listedPc();
    const { devices } = fixture.app.context.services;
    const intent = join(fixture.stateDir, "revoke-all.json");
    const closedWithDeny: string[] = [];
    for (const id of [member.id, device.id]) devices.onRevoke(id, () => { if (existsSync(intent)) closedWithDeny.push(id); });
    const append = DeviceJournal.prototype.append;
    const failure = spyOn(DeviceJournal.prototype, "append").mockImplementation(function (this: DeviceJournal, entry) {
      if (entry.kind === "drop" && entry.how === "revoke_all") throw new Error("journal unavailable");
      return append.call(this, entry);
    });
    try { expect(() => devices.revokeAll()).toThrow("journal unavailable"); } finally { failure.mockRestore(); }
    expect(closedWithDeny.sort()).toEqual([member.id, device.id].sort());
    expect(devices.has(member.id)).toBe(false);
    expect(existsSync(intent)).toBe(true);
    fixture.app.stop();
    const recovered = relayFixture(false, { stateDir: fixture.stateDir, accountOpensAll: true, accountService: { url: "off" } });
    try {
      expect(recovered.app.context.services.devices.account()).toBeNull();
      expect(recovered.app.context.services.devices.has(device.id)).toBe(false);
      expect(existsSync(intent)).toBe(false);
    } finally { recovered.app.stop(); }
  });

  for (const deny of ["local revoke", "account removal"] as const) {
    test(`T34, G6: a valid list cannot restore a key covered by its ${deny}`, async () => {
      const { fixture, device, serverId } = await listedPc();
      const { services } = fixture.app.context;
      if (deny === "local revoke") {
        expect(services.devices.revoke(device.id)).toBe(true);
      } else {
        const record = await signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT, signer: device.publicKey, key: device.publicKey,
          id: newRecordId(), issued_at: "2026-11-01T00:00:00.000Z" }, device.keys.privateKey);
        expect(await applyAccountRecords(services.devices, [record], serverId)).toMatchObject([{ outcome: "applied" }]);
      }
      expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      expect(services.devices.isTombstoned(device.publicKey)).toBe(true);
      expect(services.devices.has(device.id)).toBe(false);
    });
  }

  test.each(["enrollment", "held key", "waiting removal"] as const)("T34, G8/G9: a whole read commits without admitting a key blocked by %s", async (gate) => {
    const { fixture, service, serverId, member } = await listedPc();
    const { accountMailbox, accountHolds, devices } = fixture.app.context.services;
    const key = keyOf("k-waiting");
    service.registerDevice(ACCOUNT, key, "Waiting phone");
    switch (gate) {
      case "enrollment": accountHolds.startEnrolling(member.id); break;
      case "held key": accountHolds.hold([key]); break;
      case "waiting removal":
        expect(accountMailbox.wait(await signAccountRecord({ v: 1, kind: "remove", key, account: ACCOUNT,
          signer: member.publicKey, id: newRecordId(), issued_at: new Date().toISOString() }, member.keys.privateKey))).toBe(true);
        break;
    }
    // A barred candidate must not even need a writable admission journal for the read to commit.
    const append = DeviceJournal.prototype.append;
    const fence = spyOn(DeviceJournal.prototype, "append").mockImplementation(function (this: DeviceJournal, entry) {
      if (entry.kind === "admit" && entry.key === key) throw new Error("unexpected join notice for blocked key");
      return append.call(this, entry);
    });
    try {
      const outcome = await accountMailbox.readSnapshot();
      expect(accountMailbox.error).toBeNull();
      expect(outcome).toMatchObject({ committed: true });
      expect(devices.has(accountDeviceId(serverId, key))).toBe(false);
    } finally { fence.mockRestore(); }
  });

  test("T34, G15: a list stops at 64 unanswered notices and resumes when one is answered", async () => {
    // Exercise all 64 real replacements; the power-loss behavior of fsync is not part of G15.
    const flush = spyOn(privateStateFs, "fsyncSync").mockImplementation(() => {});
    closes.push(() => flush.mockRestore());
    const { fixture, device, service, serverId } = await listedPc();
    const { accountMailbox, devices } = fixture.app.context.services;
    const [original] = devices.openNotices();
    if (!original) throw new Error("missing initial join notice");
    const ids = Array.from({ length: 65 }, (_, index) => {
      const key = keyOf(`k-${index}`);
      service.registerDevice(ACCOUNT, key, `Phone ${index}`);
      return accountDeviceId(serverId, key);
    });
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(devices.openNotices()).toHaveLength(64);
    expect(devices.openNotices()).toContainEqual(original);
    expect(devices.has(device.id)).toBe(true);
    expect(ids.filter(id => devices.has(id))).toHaveLength(63);

    devices.decideNotice(original.id);
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(ids.filter(id => devices.has(id))).toHaveLength(64);
    expect(devices.openNotices()).toHaveLength(64);
  });

  test("S25: the whole read admits the listed device as an account row, held until its notice is out", async () => {
    const pc = await listedPc();
    expect(pc.fixture.app.context.services.devices.has(pc.device.id)).toBe(true);
  });

  test("S25: an app that offered the account feature is refused held, with its hold state", async () => {
    const pc = await listedPc();
    // its notice is out, so the hold names when its ten seconds end
    const held = await refusal(pc, [ACCOUNT_OPENS_ALL_FEATURE]);
    expect(held).toMatchObject({ code: "held", message: "This device waits for its join hold on this PC", hold: { reason: "join_hold" } });
    expect(Date.parse((held?.hold as { until: string }).until)).toBeGreaterThan(Date.now());
  });

  test("S25: an old-app hello gets today's code for the same refusal", async () => {
    const pc = await listedPc();
    expect(await refusal(pc, [])).toEqual({ code: "auth_failed", message: "auth_failed" });
  });
});
