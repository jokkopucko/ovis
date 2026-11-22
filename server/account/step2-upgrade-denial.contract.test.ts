import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountDeviceId, newRecordId, signSafetyRecord } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { parseSnapshotPage } from "../../shared/account-snapshot.ts";
import { createServer } from "../index.ts";
import { relayIdentityPath, rotateRelayIdentity } from "../relay/identity.ts";
import { readDeviceRegistry } from "../devices.ts";
import { bounded, relayConnection, TestClock } from "../relay/test-helpers.ts";
import { provingDevice } from "./key-proof.test-helpers.ts";
import { askRecovery } from "./recovery.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT, registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { ask, phone } from "./pairing.test-helpers.ts";
import { credentialStatus, hasReleaseFixtures, v057Fixture } from "./step2-upgrade-v057.test-helpers.ts";

const root = mkdtempSync(join(tmpdir(), "upgrade-denial-"));
const available = hasReleaseFixtures();
let release: Awaited<ReturnType<typeof v057Fixture>>;
beforeAll(async () => { if (available) release = await v057Fixture(join(root, "release")); }, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const day = 86_400_000;

async function fixture(history: "original" | "rollback", signer: "legacy" | "listed" = "legacy", siblingPhones: Awaited<ReturnType<typeof phone>>[] = []) {
  const stateDir = mkdtempSync(join(root, "pc-"));
  const sibling = siblingPhones.length ? mkdtempSync(join(root, "sibling-")) : undefined;
  const service = new FakeAccountService();
  service.opensAll = true;
  const serverId = await registerSnapshotPc(service, { stateDir }, rotateRelayIdentity(stateDir));
  const owner = await phone();
  const victim = await phone();
  const member = signer === "legacy" ? owner : await phone();
  service.registerDevice(ACCOUNT, owner.spki, "Older signer");
  service.registerDevice(ACCOUNT, victim.spki, "Legacy target");
  const now = Date.now();
  let online = false;
  let omitKey: string | undefined;
  let mailboxCopy: typeof record | undefined;
  let acknowledged = false;
  const start = (desktopOwner?: { input: ReadableStream<Uint8Array>; write(line: string): void }) => createServer({
    stateDir, ...(sibling ? { siblingStateDir: sibling } : {}), port: 0, hostname: "127.0.0.1", token: "matrix-owner", tailscaleOwner: null, sidecar: false,
    accountOpensAll: true, ...(desktopOwner ? { platform: "linux", desktopOwner } : {}), accountService: { url: "https://account.test", fetch: async request => {
      if (!online) return Promise.reject(new TypeError("fixture offline"));
      const pendingMail = mailboxCopy && new URL(request.url).pathname === "/v1/pc/mailbox" ? mailboxCopy : undefined;
      const ack: unknown = pendingMail ? (await request.clone().json()).ack : null;
      const response = await service.fetch(request);
      if (response.ok && pendingMail) {
        if (ack === 1) { mailboxCopy = undefined; acknowledged = true; }
        else return Response.json({ ...await response.json(), records: [{ seq: 1, record: pendingMail }], more: false });
      }
      if (omitKey && new URL(request.url).pathname === "/v1/pc/snapshot" && response.ok) {
        const page = parseSnapshotPage(await response.json());
        return Response.json({ ...page, devices: page.devices.filter(row => row.key !== omitKey) });
      }
      return response;
    } },
  });
  const initial = release(stateDir);
  let cookie: string;
  try {
    const { devices } = initial.context.services;
    const paired = devices.pairRelay(devices.startPairing(now - 3_000).code, "Local member", member.spki, now - 3_000);
    if (!paired || !devices.linkAccountKey(paired.device.id, member.spki, member.spki, ACCOUNT)) throw new Error("Release pairing failed");
    const browser = devices.pair(devices.startPairing(now - 1_000).code, "Unrelated browser", "drive", now - 1_000);
    if (!browser) throw new Error("Release browser pairing failed");
    cookie = browser.token;
    expect(await credentialStatus(initial.port, cookie)).toBe(200);
  } finally { await initial.stop(); }
  if (history === "rollback") await start().stop();
  const old = release(stateDir);
  let targetId: string;
  const closes: (() => void)[] = [];
  try {
    const { devices } = old.context.services;
    const ahead = now + 2 * day;
    const paired = devices.pairRelay(devices.startPairing(ahead).code, "Legacy target", victim.spki, ahead);
    if (!paired || !devices.linkAccountKey(paired.device.id, victim.spki, victim.spki, ACCOUNT)) throw new Error("Release target pairing failed");
    targetId = paired.device.id;
    const link = await relayConnection({ stateDir, app: old, closes, close: () => {} }, { serverId }, release.RelaySession);
    await link.auth({ id: targetId, keys: victim.keys, publicKey: victim.spki });
    expect((await ask(link, "/api/devices")).status).toBe(200);
    expect(await credentialStatus(old.port, cookie)).toBe(200);
  } finally {
    for (const close of closes) close();
    await old.stop();
  }
  const importedIds: string[] = [];
  if (sibling) {
    mkdirSync(join(sibling, "relay"), { recursive: true });
    copyFileSync(relayIdentityPath(stateDir), relayIdentityPath(sibling));
    const other = release(sibling);
    try {
      for (const key of siblingPhones) {
        const store = other.context.services.devices;
        const row = store.pairRelay(store.startPairing().code, "Sibling phone", key.spki);
        if (!row) throw new Error("Release sibling failed to pair");
        importedIds.push(row.device.id);
      }
    } finally { await other.stop(); }
    const merged = release(stateDir, { siblingStateDir: sibling });
    try {
      const registry = readDeviceRegistry(join(stateDir, "devices.json"));
      if (registry.kind !== "ok") throw new Error("No release-merged registry");
      expect(importedIds.map(id => registry.devices.find(row => row.id === id)?.imported)).toEqual(siblingPhones.map(() => true));
    } finally { await merged.stop(); }
  }
  const record = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, signer: owner.spki, signer_no: 1,
    target: victim.spki, target_no: 2, nonce: newRecordId(), signed_at: new Date(now).toISOString() }, owner.keys.privateKey);
  return { stateDir, service, serverId, owner, victim, targetId, importedIds, cookie, record, start,
    deliverDuplicate: () => { mailboxCopy = record; }, acknowledged: () => acknowledged,
    omit: (key: string) => { omitKey = key; },
    connect: () => { online = true; }, disconnect: () => { online = false; } };
}

test.skipIf(!available).each([
  ["original", "none"], ["rollback", "none"], ["original", "present"], ["rollback", "present"],
] as const)(
  "service-produced target-only block: history=%s independent-freeze=%s", async (history, freeze) => {
    const independent = freeze === "present";
    const pc = await fixture(history);
    const app = pc.start();
    try {
      expect(await credentialStatus(app.port, pc.cookie)).toBe(200);
      if (independent) {
        const other = await phone();
        const no = pc.service.registerDevice(ACCOUNT, other.spki, "Independent blocked key");
        const record = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, signer: pc.owner.spki, signer_no: 1,
          target: other.spki, target_no: no, nonce: newRecordId(), signed_at: new Date().toISOString() }, pc.owner.keys.privateKey);
        expect((await pc.service.fetch(new Request("https://account.test/v1/safety-records", {
          method: "POST", headers: { authorization: `Bearer ${pc.service.issueToken(ACCOUNT)}` },
          body: JSON.stringify({ record }),
        }))).status).toBe(200);
      }
      const response = await pc.service.fetch(new Request("https://account.test/v1/safety-records", {
        method: "POST", headers: { authorization: `Bearer ${pc.service.issueToken(ACCOUNT)}` },
        body: JSON.stringify({ record: pc.record }),
      }));
      expect(response.status).toBe(200);
      pc.connect();
      expect(await app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      expect({
        targetDenied: app.context.services.devices.isTombstoned(pc.victim.spki),
        survivor: await credentialStatus(app.port, pc.cookie),
      }).toEqual({ targetDenied: true, survivor: independent ? 401 : 200 });
      expect(app.context.services.devices.sessionRow(pc.targetId)).toBeNull();
    } finally { await app.stop(); }
    pc.disconnect();
    const restarted = pc.start();
    try {
      expect(await credentialStatus(restarted.port, pc.cookie)).toBe(independent ? 401 : 200);
      expect(restarted.context.services.devices.isTombstoned(pc.victim.spki)).toBe(true);
      expect(restarted.context.services.devices.sessionRow(pc.targetId)).toBeNull();
    } finally { await restarted.stop(); }
  }, 15_000,
);

async function rebind(pc: Awaited<ReturnType<typeof fixture>>, app: ReturnType<typeof createServer>, omitted: string) {
  expect(app.context.services.devices.clearAccountBinding("unlisted", "account")).toBe(true);
  pc.omit(omitted);
  const base = `http://127.0.0.1:${app.port}`;
  const post = (path: string, body: object) => fetch(base + path, { method: "POST",
    headers: { origin: base, authorization: "Bearer matrix-owner", "x-herdr-machine": "1" }, body: JSON.stringify(body) });
  expect((await post("/api/account/relay-account", { account: ACCOUNT })).status).toBe(204);
  expect((await pc.service.fetch(new Request(`https://account.test/v1/pcs/${pc.serverId}/admit`, {
    method: "POST", headers: { authorization: `Bearer ${pc.service.issueToken(ACCOUNT, { twoStep: true })}` }, body: "{}",
  }))).status).toBe(200);
  expect((await post("/api/account/one-press", { account: ACCOUNT })).status).toBe(200);
}

test.skipIf(!available).each([
  ["session", "mailbox-copy"], ["session", "single"], ["handed", "single"], ["pc", "single"],
] as const)("a reconciled denial takes its exact target regardless of first delivery: %s / %s", async (first, delivery) => {
  const pc = await fixture("original");
  pc.omit(pc.victim.spki);
  const app = pc.start();
  try {
    pc.connect();
    const { devices, accountMailbox, safetyLog } = app.context.services;
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(await devices.applyBlock(pc.record, first)).toMatchObject({ outcome: "refused", reason: "unknown_target" });
    if (delivery === "mailbox-copy") {
      pc.deliverDuplicate();
      await accountMailbox.pull();
      expect(pc.acknowledged()).toBe(true);
    }
    expect(safetyLog?.waitingBlocks().map(entry => entry.record.id)).toEqual([pc.record.id]);
    pc.omit("");
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    const closes: (() => void)[] = [];
    try {
      const link = await relayConnection({ stateDir: pc.stateDir, app, closes, close() {} }, { serverId: pc.serverId });
      const request = await bounded(link.auth({ id: pc.targetId, keys: pc.victim.keys, publicKey: pc.victim.spki })
        .then(() => ask(link, "/api/devices").then(answer => answer.status), () => 401));
      expect({ pending: safetyLog?.waitingBlocks().map(entry => entry.record.id), receipt: safetyLog?.receipt(pc.record.id)?.outcome,
        target: request, unrelated: await credentialStatus(app.port, pc.cookie) }).toEqual({ pending: [], receipt: "applied", target: 401, unrelated: 200 });
    } finally { for (const close of closes) close(); }
  } finally { await app.stop(); }
}, 15_000);

test.skipIf(!available)("a companion freeze still covers a newer account row before and after clock correction", async () => {
  const pc = await fixture("original");
  const newer = await phone();
  const no = pc.service.registerDevice(ACCOUNT, newer.spki, "Newer account phone");
  expect(no).toBeGreaterThan(pc.record.target_no);
  const app = pc.start();
  const now = Date.now();
  const wall = spyOn(Date, "now").mockReturnValue(now);
  try {
    pc.connect();
    const { accountMailbox, devices, safetyLog } = app.context.services;
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    wall.mockReturnValue(now + JOIN_HOLD_MS + 1);
    const id = accountDeviceId(pc.serverId, newer.spki);
    expect(devices.sessionRow(id)?.key).toBe(newer.spki);
    expect(safetyLog?.append({ got: "snapshot", record: pc.record, asof: {
      signer_no: pc.record.signer_no, target_no: pc.record.target_no, after: null, joined: null, signer_removed: false, target_only: true,
    } }).outcome).toBe("applied");
    expect(safetyLog?.append({ got: "snapshot", record: {
      v: 1, kind: "freeze", account: ACCOUNT, id: `f:${pc.record.id}`, target: pc.record.target,
      after: pc.record.target_no, signer: "service", signed_at: pc.record.signed_at, signature: "",
    } }).outcome).toBe("applied");
    const results = [];
    for (const at of [now + 3 * day, now + JOIN_HOLD_MS + 1]) {
      wall.mockReturnValue(at);
      results.push({ cookie: await credentialStatus(app.port, pc.cookie), numbered: devices.admitsFromList(newer.spki, ACCOUNT),
        listed: devices.sessionRow(id) !== null });
    }
    expect(results).toEqual(Array(2).fill({ cookie: 200, numbered: false, listed: false }));
  } finally {
    wall.mockRestore();
    await app.stop();
  }
}, 15_000);

test.skipIf(!available || process.platform !== "linux")("a service companion freeze preserves the owner's exact key decisions", async () => {
  const [approvedCopy, otherCopy] = await Promise.all([phone(), phone()]);
  const pc = await fixture("original", "legacy", [approvedCopy, otherCopy]);
  const [approvedId, otherId] = pc.importedIds;
  if (!approvedId || !otherId) throw new Error("Missing release import");
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const app = pc.start({ input: stream.readable, write() {} });
  const closes: (() => void)[] = [];
  const local = { stateDir: pc.stateDir, app, closes, close() {} };
  try {
    const { accountMailbox, devices, localConfirms, safetyLog } = app.context.services;
    const [relay, screen, newScreen, recovered, priorRecovery] = await Promise.all([phone(), phone(), phone(), phone(), phone()]);
    const confirm = async (key: typeof screen, via: "screen" | "recover") => {
      const pending = await provingDevice(local, devices.startPairing().code, { serverId: pc.serverId }, key);
      await pending.pending;
      const request = localConfirms?.pending().find(entry => entry.action.kind === "approve_key" && entry.action.fingerprint === pending.fingerprint);
      if (!request || request.action.kind !== "approve_key") throw new Error("No matching PC screen confirmation");
      if (via === "recover") {
        const answer = await askRecovery(pc.stateDir, { act: "admit", pending: request.action.pending, fingerprint: pending.fingerprint });
        expect(answer).toHaveProperty("admitted");
      } else {
        const answer = localConfirms?.answer(request.id);
        await writer.write(new TextEncoder().encode(`${JSON.stringify({ approve: request.id })}\n`));
        expect(await answer).toBe("approved");
      }
      const row = devices.list(null).find(row => devices.relayKeyOf(row.id) === key.spki);
      if (!row) throw new Error("Owner decision did not write a device row");
      expect(devices.originOf(row.id)?.from).toBe(via === "screen" ? "pc" : "recover");
      return row.id;
    };
    const signedStatus = async (key: typeof screen, id: string) => {
      const link = await relayConnection(local, { serverId: pc.serverId });
      const admitted = await bounded(link.auth({ id, keys: key.keys, publicKey: key.spki }).then(() => true, () => false));
      return admitted ? (await ask(link, "/api/devices")).status : 401;
    };
    const relayRow = devices.pairRelay(devices.startPairing().code, "Ordinary phone", relay.spki);
    if (!relayRow) throw new Error("Ordinary pairing failed");
    const screenId = await confirm(screen, "screen");
    const priorId = await confirm(priorRecovery, "recover");
    for (const key of [relay, screen, newScreen, recovered, priorRecovery, approvedCopy, otherCopy]) expect(pc.service.registerDevice(ACCOUNT, key.spki, "Numbered phone")).toBeGreaterThan(pc.record.target_no);
    pc.connect();
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(await signedStatus(relay, relayRow.device.id)).toBe(200);
    expect(await signedStatus(screen, screenId)).toBe(200);
    expect(await signedStatus(priorRecovery, priorId)).toBe(200);
    expect(await signedStatus(approvedCopy, approvedId)).toBe(200);
    expect(await signedStatus(otherCopy, otherId)).toBe(200);
    expect((await pc.service.fetch(new Request("https://account.test/v1/safety-records", {
      method: "POST", headers: { authorization: `Bearer ${pc.service.issueToken(ACCOUNT)}` }, body: JSON.stringify({ record: pc.record }),
    }))).status).toBe(200);
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(safetyLog?.inForce.freezes.find(entry => entry.record.id === `f:${pc.record.id}`)?.targetOnlyCompanion).toBe(true);
    expect(await signedStatus(approvedCopy, approvedId)).toBe(401);
    expect(await signedStatus(otherCopy, otherId)).toBe(401);
    expect(await confirm(approvedCopy, "screen")).toBe(approvedId);
    const newId = await confirm(newScreen, "screen");
    const recoverId = await confirm(recovered, "recover");
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect({ existingScreen: await signedStatus(screen, screenId), newScreen: await signedStatus(newScreen, newId),
      recovered: await signedStatus(recovered, recoverId), relay: await signedStatus(relay, relayRow.device.id),
      priorRecovery: await signedStatus(priorRecovery, priorId), cookie: await credentialStatus(app.port, pc.cookie),
      approvedCopy: await signedStatus(approvedCopy, approvedId), otherCopy: await signedStatus(otherCopy, otherId) })
      .toEqual({ existingScreen: 200, newScreen: 200, recovered: 200, relay: 401, priorRecovery: 401, cookie: 200, approvedCopy: 200, otherCopy: 401 });
  } finally {
    for (const close of closes) close();
    await app.stop();
    writer.releaseLock();
  }
  pc.disconnect();
  const restarted = pc.start();
  const reopened: (() => void)[] = [];
  try {
    for (const [key, id, status] of [[approvedCopy, approvedId, 200], [otherCopy, otherId, 401]] as const) {
      const link = await relayConnection({ stateDir: pc.stateDir, app: restarted, closes: reopened, close() {} }, { serverId: pc.serverId });
      const signed = await bounded(link.auth({ id, keys: key.keys, publicKey: key.spki }).then(() => true, () => false));
      expect(signed ? (await ask(link, "/api/devices")).status : 401).toBe(status);
    }
  } finally { for (const close of reopened) close(); await restarted.stop(); }
}, 20_000);

test.skipIf(!available).each(["signer", "target"] as const)(
  "a previous binding's %s pin cannot authorize a target-only block", async missing => {
    const pc = await fixture("original");
    const app = pc.start();
    try {
      pc.connect();
      const { devices, accountMailbox } = app.context.services;
      expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      await rebind(pc, app, missing === "signer" ? pc.owner.spki : pc.victim.spki);
      // A new binding needs a fresh member link. Only the order pin is intentionally missing here.
      const signer = devices.list(null).find(row => devices.relayKeyOf(row.id) === pc.owner.spki);
      if (!signer) throw new Error("Missing original signer credential");
      expect(devices.linkAccountKey(signer.id, pc.owner.spki, pc.owner.spki, ACCOUNT)).not.toBeNull();
      expect(await devices.applyBlock(pc.record, "mailbox")).toMatchObject({ outcome: "refused", reason: "unknown_target" });
      expect(devices.isTombstoned(pc.victim.spki)).toBe(false);
      expect(app.context.services.safetyLog?.waitingBlocks().map(entry => entry.record.id)).toContain(pc.record.id);
    } finally { await app.stop(); }
  }, 15_000,
);

test.skipIf(!available).each(["proof-present", "proof-later"] as const)(
  "rollback target gets an exact-key denial without acquiring authority: %s", async proof => {
    const pc = await fixture("rollback");
    const app = pc.start();
    try {
      const { devices, accountMailbox, safetyLog } = app.context.services;
      expect(devices.sessionRow(pc.targetId)?.key).toBe(pc.victim.spki);
      expect(devices.isAccountApproverSession(pc.targetId, pc.victim.spki)).toBe(false);
      if (proof === "proof-present") {
        pc.connect();
        expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      }
      const receipt = await devices.applyBlock(pc.record, "mailbox");
      if (proof === "proof-later") {
        expect(receipt).toMatchObject({ outcome: "refused", reason: "unknown_target" });
        expect(safetyLog?.waitingBlocks().map(entry => entry.record.id)).toContain(pc.record.id);
        const shown = await fetch(`http://127.0.0.1:${app.port}/api/devices`, { headers: { authorization: "Bearer matrix-owner" } });
        const { devices: rows } = await shown.json() as { devices: { id: string; not_me_waiting?: true }[] };
        expect(rows.filter(row => row.not_me_waiting).map(row => row.id)).toEqual([pc.targetId]);
        pc.connect();
        expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      }
      expect(safetyLog?.receipt(pc.record.id)?.outcome).toBe("applied");
      expect(devices.isTombstoned(pc.victim.spki)).toBe(true);
      expect(devices.sessionRow(pc.targetId)).toBeNull();
      expect(await credentialStatus(app.port, pc.cookie)).toBe(200);
    } finally { await app.stop(); }
  }, 15_000,
);

test.skipIf(!available).each(["hold", "expired", "service-off", "live"] as const)(
  "target-only denial checks the list signer's owning store: %s", async standing => {
    const pc = await fixture("original", "listed");
    const app = pc.start();
    const clock = new TestClock();
    const epoch = Date.now();
    const wall = spyOn(Date, "now").mockImplementation(() => epoch + clock.now());
    try {
      const { devices, accountMailbox } = app.context.services;
      devices.useClock(clock);
      pc.connect();
      expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      if (standing !== "hold") clock.advance(JOIN_HOLD_MS + 1);
      if (standing === "expired") {
        clock.advance(61 * day);
        expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      }
      if (standing === "service-off") {
        pc.service.opensAll = false;
        pc.service.reportsStep2Off = true;
        await accountMailbox.readSnapshot();
      }
      // Do not call sessionRow on the signer first: access must inspect expiry itself.
      const receipt = await devices.applyBlock(pc.record, "mailbox");
      expect(receipt.outcome).toBe(standing === "live" ? "applied" : "refused");
      expect(devices.isTombstoned(pc.victim.spki)).toBe(standing === "live");
      expect(devices.sessionRow(accountDeviceId(pc.serverId, pc.owner.spki))?.key ?? null)
        .toBe(standing === "live" ? pc.owner.spki : null);
      expect(await credentialStatus(app.port, pc.cookie)).toBe(200);
    } finally {
      wall.mockRestore();
      await app.stop();
    }
  }, 15_000,
);

test.skipIf(!available).each(["hold", "expired", "frozen", "live"] as const)(
  "an owner sees a pending Not me only from a live member: %s", async standing => {
    const pc = await fixture("original", "listed");
    pc.omit(pc.victim.spki);
    const app = pc.start();
    const now = Date.now();
    const wall = spyOn(Date, "now").mockReturnValue(now);
    try {
      pc.connect();
      const { devices, accountMailbox } = app.context.services;
      expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      if (standing !== "hold") wall.mockReturnValue(now + JOIN_HOLD_MS + 1);
      if (standing === "expired") {
        wall.mockReturnValue(now + 61 * day);
        expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      }
      if (standing === "frozen") {
        expect(app.context.services.safetyLog?.append({ got: "snapshot", record: {
          v: 1, kind: "freeze", id: `f:${"c".repeat(64)}`, account: ACCOUNT, target: pc.owner.spki,
          after: 1, signer: "service", signed_at: new Date(now).toISOString(), signature: "",
        } }).outcome).toBe("applied");
      }
      expect((await devices.applyBlock(pc.record, "mailbox")).outcome).toBe("refused");
      expect([...devices.pendingNotMeRows()]).toEqual(standing === "live" ? [pc.targetId] : []);
    } finally {
      wall.mockRestore();
      await app.stop();
    }
  }, 15_000,
);
