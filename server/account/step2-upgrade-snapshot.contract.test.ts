import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountDeviceId, newRecordId, signSafetyRecord } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { parseAccountDevicesFile } from "../../shared/account-snapshot.ts";
import { createServer } from "../index.ts";
import { rotateRelayIdentity } from "../relay/identity.ts";
import { bounded, deferred } from "../relay/test-helpers.ts";
import { ACCOUNT_DEVICES_FILE } from "./account-devices.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT, registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { phone } from "./pairing.test-helpers.ts";
import { credentialStatus, hasReleaseFixtures, v057Fixture } from "./step2-upgrade-v057.test-helpers.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-upgrade-snapshot-"));
let release: Awaited<ReturnType<typeof v057Fixture>>;
const available = hasReleaseFixtures();
beforeAll(async () => { if (available) release = await v057Fixture(join(root, "release")); }, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

test.skipIf(!available).each(["first-page-denial", "owner-revoke-during-read"] as const)("upgraded snapshot interruption=%s", async interruption => {
  const stateDir = mkdtempSync(join(root, "pc-"));
  const service = new FakeAccountService();
  service.opensAll = true;
  const serverId = await registerSnapshotPc(service, { stateDir }, rotateRelayIdentity(stateDir));
  const owner = await phone();
  const victim = await phone();
  const candidate = await phone();
  for (const [key, label] of [[owner.spki, "Owner"], [victim.spki, "Victim"]] as const) {
    service.registerDevice(ACCOUNT, key, label);
  }
  const old = release(stateDir);
  let survivor: string;
  let victimId: string | undefined;
  try {
    const { devices } = old.context.services;
    const now = Date.now();
    for (const [key, label, at] of [[owner.spki, "Owner", now - 2_000], [victim.spki, "Victim", now - 1_000]] as const) {
      const paired = devices.pairRelay(devices.startPairing(at).code, label, key, at);
      if (!paired || !devices.linkAccountKey(paired.device.id, key, key, ACCOUNT)) throw new Error(`v0.5.7 did not link ${label}`);
      if (key === victim.spki) victimId = paired.device.id;
      expect(devices.sessionRow(paired.device.id)?.key).toBe(key);
    }
    const earlier = now - 3_000;
    const paired = devices.pair(devices.startPairing(earlier).code, "Unrelated browser phone", "drive", earlier);
    if (!paired) throw new Error("v0.5.7 did not pair a browser");
    survivor = paired.token;
    expect(await credentialStatus(old.port, survivor)).toBe(200);
  } finally { await old.stop(); }
  if (!victimId) throw new Error("Missing release victim");

  const pageReady = deferred<void>();
  const resume = deferred<void>();
  let serving = false;
  let interrupt = false;
  let pageOneBlock: Awaited<ReturnType<typeof signSafetyRecord>> | null = null;
  const candidateId = accountDeviceId(serverId, candidate.spki);
  const path = join(stateDir, ACCOUNT_DEVICES_FILE);
  const candidateOnDisk = () => existsSync(path) && parseAccountDevicesFile(JSON.parse(readFileSync(path, "utf8")))
    .devices.some(row => row.id === candidateId);
  const start = () => createServer({
    stateDir, port: 0, hostname: "127.0.0.1", token: "matrix-owner", tailscaleOwner: null, sidecar: false,
    accountOpensAll: true, accountService: { url: "https://account.test", fetch: async request => {
      if (!serving) throw new TypeError("PC offline");
      if (new URL(request.url).pathname !== "/v1/pc/snapshot" || !interrupt) return service.fetch(request);
      const body = await request.clone().json() as { page?: number };
      if ((body.page ?? 0) > 0) return new Response(null, { status: 503 });
      const page = await service.fetch(request);
      if (!page.ok) return page;
      pageReady.resolve();
      if (interruption === "owner-revoke-during-read") {
        await resume.promise;
        return page;
      }
      return Response.json({ ...await page.json(), last: false, blocks: pageOneBlock ? [pageOneBlock] : [] });
    } },
  });
  const app = start();
  try {
    const { devices, accountMailbox } = app.context.services;
    expect(devices.sessionRow(victimId)?.key).toBe(victim.spki);
    await accountMailbox.pull();
    serving = true;
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(candidateOnDisk()).toBe(false);
    service.registerDevice(ACCOUNT, candidate.spki, "Eligible newcomer");
    interrupt = true;
    if (interruption === "first-page-denial") {
      pageOneBlock = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: victim.spki,
        target_no: 2, signer: owner.spki, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, owner.keys.privateKey);
      service.removeDevice(ACCOUNT, victim.spki);
    }
    const read = accountMailbox.readSnapshot();
    await bounded(pageReady.promise);
    if (interruption === "owner-revoke-during-read") {
      const base = `http://127.0.0.1:${app.port}`;
      expect((await fetch(`${base}/api/devices/${victimId}`, { method: "DELETE",
        headers: { origin: base, authorization: "Bearer matrix-owner", "x-herdr-machine": "1" } })).status).toBe(204);
      resume.resolve();
    }
    expect(await read).toMatchObject({ committed: false });
    expect(devices.sessionRow(victimId)).toBeNull();
    expect(devices.isTombstoned(victim.spki)).toBe(true);
    expect(devices.sessionRow(candidateId)).toBeNull();
    expect(candidateOnDisk()).toBe(false);
    expect(await credentialStatus(app.port, survivor)).toBe(200);
  } finally {
    resume.resolve();
    await app.stop();
  }

  interrupt = false;
  serving = false;
  const restored = start();
  try {
    const { devices, accountMailbox } = restored.context.services;
    expect(devices.sessionRow(victimId)).toBeNull();
    expect(candidateOnDisk()).toBe(false);
    serving = true;
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    // A page-one ordered block can intentionally put later account numbers behind a freeze.
    expect(candidateOnDisk()).toBe(interruption !== "first-page-denial");
    const wall = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS + 1);
    try {
      expect(devices.sessionRow(candidateId)?.key ?? null).toBe(interruption === "first-page-denial" ? null : candidate.spki);
    } finally { wall.mockRestore(); }
    expect(devices.sessionRow(victimId)).toBeNull();
    expect(await credentialStatus(restored.port, survivor)).toBe(200);
  } finally { await restored.stop(); }
}, 20_000);
