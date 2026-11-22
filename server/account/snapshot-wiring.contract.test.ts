import { AccountMailbox } from "./mailbox.ts";
import { HandedLifts } from "./handed-lift.ts";
import { SafetyLog } from "./safety-log.ts";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { applyAccountRecords } from "./records.ts";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { BlockReceipt } from "../../shared/account-devices-api.ts";
import { accountDeviceId, exportAccountKey, newRecordId, signAccountRecord, signSafetyRecord } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { ACCOUNT_OPENS_ALL_FEATURE, FrameType } from "../../shared/relay-mux.ts";
import { rotateRelayIdentity } from "../relay/identity.ts";
import { bounded, deferred, relayAccountFixture, relayConnection, relayDevice, relayFixture } from "../relay/test-helpers.ts";
import { ask, phone } from "./pairing.test-helpers.ts";

const ACCOUNT = "acct_1";
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

async function server(accountOpensAll: boolean) {
  const service = new FakeAccountService();
  service.opensAll = true;
  const { fixture, member } = await relayAccountFixture("drive", ACCOUNT, { accountOpensAll, accountService: { url: "https://account.test", fetch: service.fetch } });
  closes.push(() => fixture.close());
  const { services } = fixture.app.context;
  rotateRelayIdentity(fixture.stateDir);
  const identity = services.relay.currentIdentity();
  if (!identity) throw new Error("the fixture has no relay identity");
  const token = service.issueToken(ACCOUNT);
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  service.registerDevice(ACCOUNT, await exportAccountKey(pair.publicKey), "Laptop");
  return { service, services, member, identity, token, fixture };
}

describe("S2-24 the server wires the whole read only under the release flag (G1, P24)", () => {
  test("flag off: a null mailbox challenge reports the native property-read error", async () => {
    const { services, identity } = await server(false);
    const mailbox = new AccountMailbox({ devices: services.devices, identity: () => identity, service: "https://account.test",
      fetch: async () => Response.json(null) });
    const challenge = JSON.parse("null") as Record<string, unknown>;
    let expected: string;
    try { void challenge.challenge_id; throw new Error("expected a null challenge"); }
    catch (error) { if (!(error instanceof TypeError)) throw error; expected = error.message; }
    expect(await mailbox.pull()).toBe(0);
    expect(mailbox.error).toBe(expected);
  });

  test("H1/T38/T42: a recent member's signed add promotes without shedding the hold on restart", async () => {
    const { services, service, member, identity, fixture } = await server(true);
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    closes.push(() => clock.mockRestore());
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    const notice = services.devices.openNotices().find((entry) => entry.label === "Laptop");
    if (!notice?.key || !notice.row) throw new Error("Missing laptop admission");
    const record = await signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key: notice.key, signer: member.publicKey, label: "Laptop", role: "watch", issued_at: new Date(now).toISOString(), id: newRecordId() }, member.keys.privateKey);
    const [result] = await applyAccountRecords(services.devices, [record], identity.server_id, now);
    expect(result).toMatchObject({ outcome: "applied" });
    expect(services.devices.hasKey(notice.key)).toBe(true);
    expect(services.devices.sessionRow(notice.row)).toBeNull();
    fixture.app.stop();
    now += 20_000;
    const restarted = relayFixture(false, { stateDir: fixture.stateDir, accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch } });
    closes.unshift(() => restarted.app.stop());
    const after = restarted.app.context.services;
    expect(after.devices.sessionRow(notice.row)).toBeNull();
    expect(await after.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    now += 9_999;
    expect(after.devices.sessionRow(notice.row)).toBeNull();
    now += 1;
    expect(after.devices.sessionRow(notice.row)).toMatchObject({ role: "watch", key: notice.key });
  });
  test("P17/T34: older paired and list rows can replay the published admission", async () => {
    const { services, service, member } = await server(true);
    const devices = services.devices;
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    const laptop = devices.openNotices().find((entry) => entry.label === "Laptop");
    if (!laptop?.row) throw new Error("Laptop was not admitted");
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const key = await exportAccountKey(keys.publicKey);
    const published: string[] = [];
    devices.onNotice((entry) => { if (entry.key === key) published.push(entry.id); });
    service.registerDevice(ACCOUNT, key, "Tablet");
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    const tablet = devices.openNotices().find((entry) => entry.key === key);
    if (!tablet) throw new Error("Tablet was not admitted");
    expect({
      published,
      paired: devices.noticeReplay(member.id)?.notices.some((n) => n.id === tablet.id),
      listed: devices.noticeReplay(laptop.row)?.notices.some((n) => n.id === tablet.id),
    }).toEqual({ published: [tablet.id], paired: true, listed: true });
  });

  test("G1: with OVIS_ACCOUNT_OPENS_ALL on, the PC's mailbox reads and commits the account's snapshot", async () => {
    const { service, services } = await server(true);
    expect(services.devices.account()).toBe(ACCOUNT);
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(service.requests.some((request) => request.includes("/v1/pc/snapshot"))).toBe(true);
  });

  test("T15, P6: a mailed signed add waits across failed reads and settle until the whole read commits", async () => {
    const { services, service, identity, token, member } = await server(true);
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const key = await exportAccountKey(pair.publicKey);
    service.registerDevice(ACCOUNT, key, "Tablet");
    const record = await signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key, signer: member.publicKey, label: "Tablet", role: "drive", issued_at: "2026-11-01T00:00:00.000Z", id: newRecordId() }, member.keys.privateKey);
    expect((await service.fetch(new Request("https://account.test/v1/records", { method: "POST", headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ server_ids: [identity.server_id], record }) }))).ok).toBe(true);
    service.opensAll = false;
    await services.accountMailbox.pull();
    await services.accountMailbox.settle();
    expect(services.devices.hasKey(key)).toBe(false);
    service.opensAll = true;
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(services.devices.hasKey(key)).toBe(true);
  });

  for (const delivery of ["mailed while locked", "handed before a read", "enrollment before a read"] as const) {
    test(`T15, P6, P14, P23: ${delivery} add is decided only by the whole read`, async () => {
      const { services, service, identity, token, member, fixture } = await server(true);
      const { spki: key } = await phone();
      const record = await signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key, signer: member.publicKey,
        label: "Tablet", role: "drive", issued_at: "2026-11-01T00:00:00.000Z", id: newRecordId() }, member.keys.privateKey);
      if (delivery === "mailed while locked") {
        const log = services.safetyLog;
        if (!log) throw new Error("Expected a safety log");
        const lock = log.appendLock({ account: ACCOUNT });
        expect(lock.outcome).toBe("applied");
        expect((await service.fetch(new Request("https://account.test/v1/records", { method: "POST", headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ server_ids: [identity.server_id], record }) }))).ok).toBe(true);
        await services.accountMailbox.pull();
        expect(services.devices.hasKey(key)).toBe(false);
        expect(log.appendUnlock(lock.id, { account: ACCOUNT }).outcome).toBe("applied");
      } else {
        service.opensAll = false;
        const link = await relayConnection(fixture, { serverId: identity.server_id });
        await link.auth(member);
        const route = delivery === "enrollment before a read" ? "/api/account/enroll" : "/api/account/records";
        expect((await ask(link, route, { method: "POST", body: { account: ACCOUNT, records: [record] } })).status).toBe(200);
        await services.accountMailbox.settle();
        expect(await services.accountMailbox.readSnapshot()).not.toMatchObject({ committed: true });
        expect(services.devices.hasKey(key)).toBe(false);
        service.opensAll = true;
      }
      expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      expect(services.devices.hasKey(key)).toBe(delivery !== "mailed while locked");
    });
  }

  test("T60: the mailbox acknowledges a block only after the PC has its numbered receipt", async () => {
    const { services, service, identity, member, fixture } = await server(true);
    const target = await relayDevice(fixture);
    const record = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: target.publicKey, target_no: 2,
      signer: member.publicKey, signer_no: 1, signed_at: "2026-11-01T00:00:00.000Z", nonce: newRecordId() }, member.keys.privateKey);
    const acknowledged: unknown[] = [];
    const mailbox = new AccountMailbox({ devices: services.devices, identity: () => identity, service: "https://account.test",
      fetch: async (request) => {
        if (new URL(request.url).pathname !== "/v1/pc/mailbox") return service.fetch(request);
        const { ack } = await request.json();
        if (ack === 2) acknowledged.push(services.safetyLog?.receipt(record.id));
        return Response.json({ records: ack === null ? [{ seq: 1, record: { kind: "block" } }, { seq: 2, record }] : [] });
      },
    });
    await mailbox.pull();
    expect(acknowledged).toEqual([{ outcome: "applied", id: record.id, n: 1 }]);
    expect(services.devices.has(target.id)).toBe(false);
  });

  test("T52, P14: a handed lift requests a read but a snapshot without it keeps the freeze", async () => {
    const { services, service, identity, member, token, fixture } = await server(true);
    const target = await relayDevice(fixture);
    const signerNo = service.registerDevice(ACCOUNT, member.publicKey, "Signer");
    const targetNo = service.registerDevice(ACCOUNT, target.publicKey, "Target");
    const at = "2026-11-01T00:00:00.000Z";
    const block = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: target.publicKey, target_no: targetNo,
      signer: member.publicKey, signer_no: signerNo, signed_at: at, nonce: newRecordId() }, member.keys.privateKey);
    const lift = await signSafetyRecord({ v: 1, kind: "lift", account: ACCOUNT, target: block.id,
      signer: member.publicKey, signer_no: signerNo, signed_at: at }, member.keys.privateKey);
    expect((await services.devices.applyBlock(block, "handed")).outcome).toBe("applied");
    const link = await relayConnection(fixture, { serverId: identity.server_id });
    await link.auth(member);
    const requests = () => service.requests.filter((path) => path.includes("/v1/pc/snapshot")).length;
    const before = requests();
    service.opensAll = false;
    const answer = await ask(link, "/api/account/records", { method: "POST", body: { records: [lift] } });
    await services.accountMailbox.settle();
    expect(requests()).toBe(before + 1);
    expect(answer.body.results).toEqual([{ id: lift.id, outcome: "refused", code: "read_pending" }]);
    const waiting = () => new HandedLifts(fixture.stateDir).pending();
    expect(waiting()).toEqual([lift]);
    service.opensAll = true;
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(waiting()).toEqual([lift]);
    expect(services.safetyLog?.state().blocks.map(({ record }) => record.id)).toEqual([block.id]);
    for (const record of [block, lift]) {
      expect((await service.fetch("https://account.test/v1/safety-records", { method: "POST",
        headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ record }) })).ok).toBe(true);
    }
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true, liftsRefused: 0 });
    expect(waiting()).toEqual([]);
    expect(SafetyLog.open(fixture.stateDir).receipt(lift.id)).toMatchObject({ outcome: "applied" });
  });

  test.each([
    ["a proved signer's refusal carries its PC receipts", "proved"],
    ["a proved signer's refusal excludes blocks signed under an earlier account binding", "earlier"],
    ["an unproved signer's refusal carries no receipts", "unproved"],
    ["a refusal without negotiation carries no receipts", "legacy"],
    ["an unknown key's refusal carries no receipts", "unknown"],
    ["an ordered key's refusal carries no receipts when its log is empty", "empty"],
  ] as const)("T60: %s", async (_name, scenario) => {
    const { services, service, member, identity, fixture } = await server(true);
    if (scenario === "earlier") {
      const prior = await signSafetyRecord({ v: 1, kind: "block", account: "acct_previous", target: (await phone()).spki, target_no: 2,
        signer: member.publicKey, signer_no: 1, signed_at: "2026-10-01T00:00:00.000Z", nonce: newRecordId() }, member.keys.privateKey);
      expect(services.safetyLog?.append({ record: prior, got: "handed",
        asof: { signer_no: 1, target_no: 2, after: 0, joined: 0, signer_removed: false } }).outcome).toBe("applied");
      expect(services.safetyLog?.appendLift(prior.id, { account: prior.account }, { cause: "screen" }).outcome).toBe("applied");
    }
    service.registerDevice(ACCOUNT, member.publicKey, "Signer");
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    const stranger = await phone();
    const plain = { code: "auth_failed", message: "auth_failed" };
    let expected: typeof plain & { readonly receipts?: readonly BlockReceipt[] } = plain;
    if (scenario !== "empty") {
      const target = await relayDevice(fixture);
      const block = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: target.publicKey, target_no: 2,
        signer: member.publicKey, signer_no: 1, signed_at: "2026-11-01T00:00:00.000Z", nonce: newRecordId() }, member.keys.privateKey);
      const receipt = await services.devices.applyBlock(block, "handed");
      expect(receipt.outcome).toBe("applied");
      if (scenario === "proved" || scenario === "earlier") {
        expected = { ...plain, receipts: [receipt] };
      }
    }
    expect(services.devices.revoke(member.id)).toBe(true);
    const publicKey = scenario === "unknown" ? stranger.spki : member.publicKey;
    const keys = scenario === "unknown" || scenario === "unproved" ? stranger.keys : member.keys;
    const id = accountDeviceId(identity.server_id, publicKey);
    const link = await relayConnection(fixture, { serverId: identity.server_id });
    const reply = deferred<unknown>();
    link.onFrame = (frame) => { if (frame.type === FrameType.SESSION_ERROR) reply.resolve(frame.payload); };
    const before = service.requests.length;
    void link.auth({ publicKey, keys, id }, scenario === "legacy" ? [] : [ACCOUNT_OPENS_ALL_FEATURE]).catch(() => {});
    expect(await bounded(reply.promise)).toEqual(expected);
    expect(service.requests.slice(before).filter((request) => request === "POST /v1/pc/snapshot")).toEqual(["POST /v1/pc/snapshot"]);
  });

  test("P24: with the flag off the PC never asks for a snapshot", async () => {
    const { service, services } = await server(false);
    expect(await services.accountMailbox.readSnapshot()).toBeNull();
    await services.accountMailbox.pull();
    expect(service.requests.some((request) => request.includes("/v1/pc/snapshot"))).toBe(false);
  });
});
