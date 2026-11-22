import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accountDeviceId, newRecordId, signSafetyRecord } from "../../shared/account-records.ts";
import { parseAccountDevicesFile } from "../../shared/account-snapshot.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { ACCOUNT_OPENS_ALL_FEATURE, FrameType } from "../../shared/relay-mux.ts";
import { bounded, relayAccountFixture, relayConnection, TestClock } from "../relay/test-helpers.ts";
import { ACCOUNT_DEVICES_FILE, STALE_READ_MS } from "./account-devices.ts";
import { DeviceJournal } from "./device-journal.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT, registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { ask, phone } from "./pairing.test-helpers.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

test("T42/S23: a frozen account row is dropped at catch-up and returns after a lift only with a new age, notice and hold", async () => {
  const clock = new TestClock();
  const epoch = Date.now();
  const time = spyOn(Date, "now").mockImplementation(() => epoch + clock.now());
  closes.push(() => time.mockRestore());
  const service = new FakeAccountService();
  const { fixture, member } = await relayAccountFixture("drive", ACCOUNT, {
    accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch },
  });
  closes.push(() => fixture.close());
  const serverId = await registerSnapshotPc(service, fixture);
  const { devices, accountMailbox } = fixture.app.context.services;
  devices.useClock(clock);
  await accountMailbox.pull();
  const target = await phone();
  const newer = await phone();
  const elder = await phone();
  const signerNo = service.registerDevice(ACCOUNT, member.publicKey, "Owner");
  service.registerDevice(ACCOUNT, elder.spki, "Older listed row");
  const targetNo = service.registerDevice(ACCOUNT, target.spki, "Target");
  service.registerDevice(ACCOUNT, newer.spki, "Newer");
  service.opensAll = true;
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const id = accountDeviceId(serverId, newer.spki);
  const row = (rowId = id) => parseAccountDevicesFile(JSON.parse(readFileSync(join(fixture.stateDir, ACCOUNT_DEVICES_FILE), "utf8")))
    .devices.find(candidate => candidate.id === rowId);
  const elderId = accountDeviceId(serverId, elder.spki);
  const before = row(elderId);
  if (!before) throw new Error("Missing older listed row");
  const original = row();
  if (!original) throw new Error("Missing initial admission");
  clock.advance(JOIN_HOLD_MS);
  expect(devices.sessionRow(elderId)).toMatchObject({ role: "drive", key: elder.spki });
  const owner = await relayConnection(fixture, { serverId, websocket: fixture.app.context.services.core.socketHandlers });
  await owner.auth(member, [ACCOUNT_OPENS_ALL_FEATURE]);
  const originalSession = await relayConnection(fixture, { serverId });
  await originalSession.auth({ id, keys: newer.keys, publicKey: newer.spki }, [ACCOUNT_OPENS_ALL_FEATURE]);
  expect((await ask(originalSession, "/api/account/status")).status).toBe(200);
  const notices = owner.openSocket();
  await notices.opened;

  const block = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: target.spki, target_no: targetNo,
    signer: member.publicKey, signer_no: signerNo, signed_at: new Date(epoch + clock.now()).toISOString(), nonce: newRecordId() }, member.keys.privateKey);
  expect((await ask(owner, "/api/account/records", { method: "POST", body: { records: [block] } })).body.receipts)
    .toMatchObject([{ outcome: "applied", id: block.id }]);
  await bounded(originalSession.closed);
  clock.advance(STALE_READ_MS);
  // The service has not received this block: its list still names the newer key as eligible.
  expect((await ask(owner, "/api/account/status?fresh=1")).status).toBe(200);
  expect(row(elderId)?.origin).toEqual(before.origin);
  expect(devices.sessionRow(elderId)).toMatchObject({ role: "drive", key: elder.spki });
  expect(DeviceJournal.open(fixture.stateDir).entries().filter(entry => entry.row === elderId).map(entry => entry.kind)).toEqual(["admit"]);
  expect(row()).toBeUndefined();
  expect(DeviceJournal.open(fixture.stateDir).entries().filter(entry => entry.row === id).map(entry => entry.kind))
    .toEqual(["admit", "drop"]);

  const lift = await signSafetyRecord({ v: 1, kind: "lift", account: ACCOUNT, target: block.id,
    signer: member.publicKey, signer_no: signerNo, signed_at: new Date(epoch + clock.now()).toISOString() }, member.keys.privateKey);
  const token = service.issueToken(ACCOUNT);
  for (const record of [block, lift]) {
    expect((await service.fetch(new Request("https://account.test/v1/safety-records", {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ record }),
    }))).status).toBe(200);
  }
  expect((await ask(owner, "/api/account/status?fresh=1")).status).toBe(200);
  const returned = row();
  if (!returned) throw new Error("Missing new admission after lift");
  expect(returned.origin.admit_no).toBeGreaterThan(original.origin.admit_no);
  expect(returned.origin.at).toBe(new Date(epoch + clock.now()).toISOString());
  const history = DeviceJournal.open(fixture.stateDir).entries().filter(entry => entry.row === id);
  expect(history.map(entry => entry.kind)).toEqual(["admit", "drop", "admit"]);
  const announced = await notices.until(message => message.type === "device-notice"
    && message.notice.kind === "admit" && message.notice.row === id && message.notice.no === returned.origin.admit_no);
  expect(announced).toMatchObject({ type: "device-notice", notice: { id: history.at(-1)?.id, open: true } });
  const held = await relayConnection(fixture, { serverId });
  let hold: unknown;
  held.onFrame = frame => { if (frame.type === FrameType.SESSION_ERROR) hold = frame.payload.hold; };
  void held.auth({ id, keys: newer.keys, publicKey: newer.spki }, [ACCOUNT_OPENS_ALL_FEATURE]).catch(() => undefined);
  expect(await bounded(held.serverError)).toBe("held");
  expect(hold).toEqual({ reason: "join_hold", until: new Date(epoch + clock.now() + JOIN_HOLD_MS).toISOString() });
  clock.advance(JOIN_HOLD_MS);
  const admitted = await relayConnection(fixture, { serverId });
  await admitted.auth({ id, keys: newer.keys, publicKey: newer.spki }, [ACCOUNT_OPENS_ALL_FEATURE]);
  expect((await ask(admitted, "/api/account/status")).status).toBe(200);
});
