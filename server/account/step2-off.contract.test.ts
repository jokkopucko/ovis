import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_OPENS_ALL_FEATURE } from "../../shared/relay-mux.ts";
import { bounded, relayConnection } from "../relay/test-helpers.ts";
import { legacyOrigin } from "./admission-order.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT, createListedPc, registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { ask, memberRow, pairingPc } from "./pairing.test-helpers.ts";
import { PcAccountState } from "./pc-binding.ts";
import { askRecovery } from "./recovery.ts";
import { SafetyLog } from "./safety-log.ts";

const closes: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

async function legacyPc(options: { tombstone?: boolean; freeze?: "target" | "cutoff"; failure?: () => Response } = {}) {
  const good = await memberRow(ACCOUNT);
  const gone = options.tombstone ? await memberRow(ACCOUNT) : null;
  const freezeTarget = options.freeze === "cutoff" ? (await memberRow(ACCOUNT)).key.spki : good.key.spki;
  const pc = await pairingPc({
    rows: (gone ? [good.row, gone.row] : [good.row]).map(row => ({ ...row, origin: legacyOrigin(row.created_at) })),
    server: { accountOpensAll: true },
    prepare(dir) {
      PcAccountState.open(dir).migrate(ACCOUNT, true);
      if (options.freeze) expect(SafetyLog.open(dir).append({ got: "snapshot", record: {
        v: 1, kind: "freeze", id: `f:${"a".repeat(64)}`, account: ACCOUNT,
        target: freezeTarget,
        after: 1, signer: "service", signed_at: good.row.created_at, signature: "",
      } }).outcome).toBe("applied");
      if (gone) writeFileSync(join(dir, "account-tombstones.json"), JSON.stringify({
        v: 1, tombstones: [{ key: gone.key.spki, account: ACCOUNT, record_id: "local", removed_at: new Date(Date.now() + 1_000).toISOString() }],
      }), { mode: 0o600 });
    },
    async accountFetch(request, service) {
      if (options.failure && !service.reportsStep2Off && new URL(request.url).pathname === "/v1/pc/snapshot") return options.failure();
      return await service.fetch(request);
    },
  });
  closes.push(pc.close);
  const serverId = await registerSnapshotPc(pc.account, pc, pc.app.context.services.relay.currentIdentity());
  return { pc, serverId, legacy: { id: good.row.id, keys: good.key.keys, publicKey: good.key.spki },
    revoked: gone && { id: gone.row.id, keys: gone.key.keys, publicKey: gone.key.spki },
    mailbox: pc.app.context.services.accountMailbox };
}

test("a proved step2_off response leaves pre-Step-2 credential access intact", async () => {
  const { pc, legacy, mailbox, serverId } = await legacyPc();
  expect(pc.devices.catchingUp(legacy.id, false)).toBe(true);
  pc.account.reportsStep2Off = true;

  await mailbox.pull();

  const link = await relayConnection(pc, { serverId });
  expect(await link.auth(legacy, [ACCOUNT_OPENS_ALL_FEATURE])).toMatchObject({ device_id: legacy.id });
  expect((await ask(link, "/api/account/status")).status).toBe(200);
});

test("step2_off closes a previously admitted account-joined session and refuses its next sign-in", async () => {
  const { fixture, device, serverId, service } = await createListedPc(close => closes.push(close));
  const wall = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS + 1);
  closes.push(() => wall.mockRestore());
  const link = await relayConnection(fixture, { serverId });
  await link.auth(device, [ACCOUNT_OPENS_ALL_FEATURE]);
  service.opensAll = false;
  service.reportsStep2Off = true;

  await fixture.app.context.services.accountMailbox.readSnapshot();

  await expect(ask(link, "/api/account/status")).rejects.toThrow();
  const refused = await relayConnection(fixture, { serverId });
  void refused.auth(device, [ACCOUNT_OPENS_ALL_FEATURE]).catch(() => undefined);
  expect(await bounded(refused.serverError)).toBe("held");
});

test("step2_off releases a legacy phone but cannot resurrect a tombstoned key", async () => {
  const { pc, legacy, revoked, mailbox, serverId } = await legacyPc({ tombstone: true });
  if (!revoked) throw new Error("Missing revoked phone fixture");
  pc.account.reportsStep2Off = true;

  await mailbox.readSnapshot();

  const gone = await relayConnection(pc, { serverId });
  void gone.auth(revoked).catch(() => undefined);
  expect(await bounded(gone.serverError)).toBe("auth_failed");
  expect(pc.devices.isTombstoned(revoked.publicKey)).toBe(true);
  expect(pc.devices.sessionRow(legacy.id)).toMatchObject({ key: legacy.publicKey });
});

test.each([
  ["a hidden 404", () => new Response(null, { status: 404 })],
  ["a 5xx carrying the code", () => Response.json({ error: { code: "step2_off" } }, { status: 503 })],
  ["a 403 carrying the code", () => Response.json({ error: { code: "step2_off" } }, { status: 403 })],
  ["a malformed 404", () => new Response('{"error":{"code":"step2_off"', { status: 404 })],
] as const)("%s is not a service opt-out and does not affect the existing credential", async (_name, failure) => {
  const { pc, legacy, mailbox } = await legacyPc({ failure });

  await mailbox.readSnapshot();
  const duringFailure = pc.devices.sessionRow(legacy.id);
  expect(PcAccountState.open(pc.stateDir).serviceStep2Off()).toBe(false);
  pc.account.reportsStep2Off = true;
  await mailbox.readSnapshot();

  expect([duringFailure?.key, pc.devices.sessionRow(legacy.id)?.key]).toEqual([legacy.publicKey, legacy.publicKey]);
  expect(PcAccountState.open(pc.stateDir).serviceStep2Off()).toBe(true);
});

test("a whole snapshot after step2_off restores an account-joined phone's access", async () => {
  const { fixture, device, service } = await createListedPc(close => closes.push(close));
  const { devices, accountMailbox } = fixture.app.context.services;
  const wall = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS + 1);
  closes.push(() => wall.mockRestore());
  // Establish a live row, not one whose pending join hold a whole read must restart.
  expect(devices.sessionRow(device.id)?.key).toBe(device.publicKey);
  service.opensAll = false;
  service.reportsStep2Off = true;
  await accountMailbox.readSnapshot();
  const duringOff = devices.sessionRow(device.id);

  service.opensAll = true;
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });

  expect([duringOff?.key ?? null, devices.sessionRow(device.id)?.key]).toEqual([null, device.publicKey]);
});

test.each(["target", "cutoff"] as const)("step2_off cannot bypass a persisted standalone freeze %s", async freeze => {
  const { pc, legacy, mailbox } = await legacyPc({ freeze });
  pc.account.reportsStep2Off = true;

  await mailbox.readSnapshot();

  expect(pc.devices.sessionRow(legacy.id)).toBeNull();
});

test.skipIf(process.platform === "win32")("a named recovery release cannot satisfy a joined row under step2_off", async () => {
  const { fixture, device, serverId, service } = await createListedPc(close => closes.push(close));
  const { accountMailbox, devices, recoveryReleases } = fixture.app.context.services;
  const notice = devices.openNotices().find(entry => entry.row === device.id);
  if (!notice) throw new Error("Missing list admission notice");
  devices.decideNotice(notice.id);
  const wall = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS + 1);
  closes.push(() => wall.mockRestore());
  await (await relayConnection(fixture, { serverId })).auth(device, [ACCOUNT_OPENS_ALL_FEATURE]);
  service.opensAll = false;
  service.reportsStep2Off = true;
  await accountMailbox.readSnapshot();

  const reply = await askRecovery(fixture.stateDir, { act: "release", rows: [device.id] });

  expect(reply).not.toHaveProperty("released");
  // Even a release already recorded for this row must not satisfy the service wait.
  if (!recoveryReleases) throw new Error("Missing Step 2 recovery store");
  recoveryReleases.release([{ id: device.id, key: device.publicKey }], "test");
  expect(devices.sessionRow(device.id)).toBeNull();
  service.opensAll = true;
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(devices.sessionRow(device.id)?.key).toBe(device.publicKey);
});

test("a reconciled snapshot clears service opt-out in both folders of the same binding", async () => {
  const { pc, mailbox } = await legacyPc();
  const sibling = mkdtempSync(join(tmpdir(), "ovis-step2-off-sibling-"));
  closes.push(() => rmSync(sibling, { recursive: true, force: true }));
  pc.account.opensAll = false;
  pc.account.reportsStep2Off = true;
  await mailbox.readSnapshot();
  const other = PcAccountState.open(sibling);
  other.takeSibling(pc.stateDir);
  other.migrate(ACCOUNT, true);
  expect(other.serviceStep2Off()).toBe(true);

  pc.account.opensAll = true;
  expect(await mailbox.readSnapshot()).toMatchObject({ committed: true });
  PcAccountState.open(pc.stateDir).takeSibling(sibling);
  expect([PcAccountState.open(pc.stateDir).serviceStep2Off(), PcAccountState.open(sibling).serviceStep2Off()]).toEqual([false, false]);
});
