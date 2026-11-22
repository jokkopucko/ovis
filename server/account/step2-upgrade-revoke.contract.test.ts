import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountDeviceId, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { createServer } from "../index.ts";
import { relayIdentityPath, rotateRelayIdentity } from "../relay/identity.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT, registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { phone } from "./pairing.test-helpers.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { credentialStatus, hasReleaseFixtures, v057Fixture } from "./step2-upgrade-v057.test-helpers.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-upgrade-revoke-"));
let release: Awaited<ReturnType<typeof v057Fixture>>;
const available = hasReleaseFixtures();
beforeAll(async () => { if (available) release = await v057Fixture(join(root, "release")); }, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

test.skipIf(!available).each(["all", "re-pair", "re-pair-standing-removal"] as const)("upgrade revoke history=%s", async action => {
  const dir = mkdtempSync(join(root, "pc-"));
  const a = join(dir, "a");
  const b = join(dir, "b");
  mkdirSync(a);
  mkdirSync(join(b, "relay"), { recursive: true });
  const identity = rotateRelayIdentity(a);
  copyFileSync(relayIdentityPath(a), relayIdentityPath(b));
  const service = new FakeAccountService();
  service.opensAll = true;
  const serverId = await registerSnapshotPc(service, { stateDir: a }, identity);
  const member = await phone();
  const listed = await phone();
  service.registerDevice(ACCOUNT, member.spki, "Released relay phone");
  service.registerDevice(ACCOUNT, listed.spki, "Listed phone");
  const idForList = accountDeviceId(serverId, listed.spki);
  const old = release(a);
  let relayId: string;
  let cookie: string;
  try {
    const { devices } = old.context.services;
    const paired = devices.pairRelay(devices.startPairing().code, "Released relay phone", member.spki);
    if (!paired || !devices.linkAccountKey(paired.device.id, member.spki, member.spki, ACCOUNT)) throw new Error("Cannot link released phone");
    relayId = paired.device.id;
    expect(devices.sessionRow(relayId)?.key).toBe(member.spki);
    const browser = devices.pair(devices.startPairing().code, "Released browser phone", "drive");
    if (!browser) throw new Error("Cannot pair released browser");
    cookie = browser.token;
    expect(await credentialStatus(old.port, cookie)).toBe(200);
  } finally { await old.stop(); }
  await release(a, { siblingStateDir: b }).stop();

  const start = (stateDir: string, online: boolean) => createServer({
    stateDir, siblingStateDir: stateDir === a ? b : a, port: 0, hostname: "127.0.0.1", token: "matrix-owner",
    tailscaleOwner: null, sidecar: false, accountOpensAll: true,
    accountService: { url: "https://account.test", fetch: request => online ? service.fetch(request) : Promise.reject(new TypeError("offline")) },
  });
  const app = start(a, true);
  let replacement: string | undefined;
  try {
    const { devices, accountMailbox } = app.context.services;
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    const wall = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS + 1);
    try { expect(devices.sessionRow(idForList)?.key).toBe(listed.spki); } finally { wall.mockRestore(); }
    expect(devices.sessionRow(relayId)?.key).toBe(member.spki);
    expect(await credentialStatus(app.port, cookie)).toBe(200);
    const base = `http://127.0.0.1:${app.port}`;
    const revoke = await fetch(`${base}/api/devices/${action === "all" ? "revoke-all" : relayId}`, {
      method: action === "all" ? "POST" : "DELETE",
      headers: { origin: base, authorization: "Bearer matrix-owner", "x-herdr-machine": "1" },
    });
    expect(revoke.status).toBe(action === "all" ? 200 : 204);
    await revoke.arrayBuffer();
    expect(devices.sessionRow(relayId)).toBeNull();
    expect(await credentialStatus(app.port, cookie)).toBe(action === "all" ? 401 : 200);
    if (action === "all") expect(devices.sessionRow(idForList)).toBeNull();
    else {
      if (action === "re-pair-standing-removal") {
        const remove = { id: newRecordId(), issuedAt: new Date().toISOString() };
        const signed = await signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT,
          key: member.spki, signer: member.spki, id: remove.id, issued_at: remove.issuedAt }, member.keys.privateKey);
        if (signed.kind !== "remove") throw new Error("Wrong signed record");
        expect(devices.removeAccountKey(member.spki, ACCOUNT, { ...remove, signed })).toBe(true);
      }
      const revokes = RemovalEvidence.open(a, null).standingRevokes(member.spki);
      expect(revokes).toHaveLength(1);
      const redeemed = devices.redeemCode(devices.startPairing().code, "code", member.spki);
      if (!("codeId" in redeemed)) throw new Error("Could not redeem owner-issued code");
      replacement = devices.admitConfirmed({
        codeId: redeemed.codeId, key: member.spki, label: "Repaired phone", source: "screen", unrevokes: revokes.map(revoke => revoke.id),
      })?.id;
      expect(replacement !== undefined).toBe(action === "re-pair");
      expect(devices.isTombstoned(member.spki)).toBe(action === "re-pair-standing-removal");
    }
  } finally { await app.stop(); }
  for (const stateDir of [b, a]) {
    for (const mode of ["upgraded", "released"] as const) {
      const reopened = mode === "upgraded" ? () => start(stateDir, false)
        : () => release(stateDir, { siblingStateDir: stateDir === a ? b : a });
      const next = reopened();
      try {
        const { devices } = next.context.services;
        expect(devices.sessionRow(relayId)).toBeNull();
        expect(await credentialStatus(next.port, cookie)).toBe(action === "all" ? 401 : 200);
        expect(await credentialStatus(next.port, "never-paired")).toBe(401);
        if (action === "all") expect(devices.sessionRow(idForList)).toBeNull();
        if (replacement !== undefined) {
          // An explicit re-pair restores the credential, not the other folder's Step 2 admission order.
          if (mode === "upgraded" && stateDir === b) {
            expect(devices.has(replacement)).toBe(true);
            expect(devices.sessionRow(replacement)).toBeNull();
          } else expect(devices.sessionRow(replacement)?.key, `${stateDir} in ${mode}`).toBe(member.spki);
        }
        else expect(devices.isTombstoned(member.spki)).toBe(true);
      } finally { await next.stop(); }
    }
  }
  const registry: { gate_closed_at: string | null } = JSON.parse(readFileSync(join(a, "devices.json"), "utf8"));
  expect(registry.gate_closed_at).not.toBeNull();
}, 20_000);
