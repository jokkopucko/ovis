import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accountDeviceId, exportAccountKey, newRecordId, signAccountRecord, signSafetyRecord } from "../../shared/account-records.ts";
import { parseAccountDevicesFile, type AccountDevicesFile } from "../../shared/account-snapshot.ts";
import { writePrivateState } from "../private-state.ts";
import { rotateRelayIdentity } from "../relay/identity.ts";
import { bounded, relayAccountFixture, relayConnection, relayFixture, caughtUp } from "../relay/test-helpers.ts";
import { recoveryActs } from "./recovery-acts.ts";
import { ACCOUNT_DEVICES_FILE } from "./account-devices.ts";
import { applyAccountRecords } from "./records.ts";

const account = "acct_1";
const at = "2026-01-01T00:00:00.000Z";
const options = { accountOpensAll: true, accountService: { url: "https://offline.test", fetch: async () => new Response(null, { status: 503 }) } };

type Removal = (pc: Awaited<ReturnType<typeof relayAccountFixture>>, target: string, serverId: string) => Promise<void>;

/** Begin with a durable live row this PC saw used today: the hold (S2-29) and idle expiry (S2-28) are other transitions. */
async function expectRemoval(remove: Removal) {
  const pc = await relayAccountFixture("drive", account, options);
  let fixture = pc.fixture;
  try {
    const { stateDir } = fixture;
    const serverId = rotateRelayIdentity(stateDir).server_id;
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const publicKey = await exportAccountKey(keys.publicKey);
    const id = accountDeviceId(serverId, publicKey);
    const path = join(stateDir, ACCOUNT_DEVICES_FILE);
    writePrivateState(path, {
      v: 1, account, server_id: serverId, version: 1, snapshot: "1".padStart(32, "0"),
      devices: [{ id, key: publicKey, no: 2, label: "Laptop", confirmed_at: at, last_signin_day: new Date().toISOString().slice(0, 10),
        origin: { from: "remote", how: "list", by: null, admit_no: 1, at }, state: "live", hold_until: null }],
    } satisfies AccountDevicesFile);
    const persisted = () => parseAccountDevicesFile(JSON.parse(readFileSync(path, "utf8"))).devices.map((row) => row.id);
    // the PC starts with this file, as it would after a restart: its rows are read at start, never behind its back
    fixture.app.stop();
    fixture = relayFixture(false, { ...options, stateDir });
    // past the wait after a start (S2-27): the PC's user released this row by name (T70), as no read comes offline
    caughtUp(fixture);
    const releases = fixture.app.context.services.recoveryReleases;
    if (!releases) throw new Error("Expected PC-local releases");
    const recover = recoveryActs({ releases, logReadable: () => true, user: "owner" });
    expect(await recover({ act: "release", rows: [id] })).toEqual({ released: [id] });
    const link = await relayConnection(fixture, { serverId });
    expect(await link.auth({ id, publicKey, keys })).toMatchObject({ device_id: id });
    const disksAtClose: string[][] = [];
    const { devices } = fixture.app.context.services;
    devices.onRevoke(id, () => disksAtClose.push(persisted()));

    await remove({ ...pc, fixture }, publicKey, serverId);

    expect(disksAtClose).toEqual([[id]]);
    expect(await bounded(link.serverError)).toBe("auth_revoked");
    await bounded(link.closed);
    expect(devices.has(id)).toBe(false);
    expect(persisted()).toEqual([]);
    fixture.app.stop();
    fixture = relayFixture(false, { ...options, stateDir });
    expect(fixture.app.context.services.devices.has(id)).toBe(false);
  } finally {
    fixture.close();
  }
}

test("T19, T37, P8: revoking the account row by ID closes its session and survives restart", async () => {
  await expectRemoval(async ({ fixture }, key, serverId) => {
    const { devices } = fixture.app.context.services;
    expect(devices.revoke(accountDeviceId(serverId, key))).toBe(true);
    expect(devices.isTombstoned(key)).toBe(true);
  });
});

test("T36, P8: signed removal closes the account session before persistence and survives restart", async () => {
  await expectRemoval(async ({ fixture, member }, key, serverId) => {
    const record = await signAccountRecord({ v: 1, kind: "remove", account, key, signer: member.publicKey,
      id: newRecordId(), issued_at: at }, member.keys.privateKey);
    expect(await applyAccountRecords(fixture.app.context.services.devices, [record], serverId)).toMatchObject([{ outcome: "applied" }]);
  });
});

test("T51, T64, P8: a block revokes the target session before persistence and survives restart", async () => {
  await expectRemoval(async ({ fixture, member }, target) => {
    const record = await signSafetyRecord({ v: 1, kind: "block", account, target, target_no: 2,
      signer: member.publicKey, signer_no: 1, signed_at: at, nonce: newRecordId() }, member.keys.privateKey);
    expect(await fixture.app.context.services.devices.applyBlock(record, "handed")).toMatchObject({ outcome: "applied" });
  });
});
