import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountDeviceId, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { parseAccountDevicesFile } from "../../shared/account-snapshot.ts";
import { privateStateFs, writePrivateState } from "../private-state.ts";
import { bounded, relayConnection, relayFixture } from "../relay/test-helpers.ts";
import { ACCOUNT_DEVICES_FILE } from "./account-devices.ts";
import { keyOf } from "./account-devices.test-helpers.ts";
import { DeviceJournal, JOURNAL_FILE, JOURNAL_MAX } from "./device-journal.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";
import { applyAccountRecords } from "./records.ts";
import { askRecovery } from "./recovery.ts";
import { REMOVAL_FILE, RemovalEvidence } from "./removal-evidence.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
const listedPc = () => createListedPc(close => closes.push(close));
const rows = (dir: string) => parseAccountDevicesFile(JSON.parse(readFileSync(join(dir, ACCOUNT_DEVICES_FILE), "utf8"))).devices;
const drops = (dir: string) => DeviceJournal.open(dir).entries().filter(entry => entry.kind === "drop")
  .map(({ kind, how, key, row, account }) => ({ kind, how, key, row, account }));

function failReplacement(path: string, containing?: string) {
  const rename = privateStateFs.renameSync;
  return spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
    if (to === path && (containing === undefined || readFileSync(from, "utf8").includes(containing))) throw new Error("replacement failed");
    rename(from, to);
  });
}

async function leave({ fixture, device, serverId }: Awaited<ReturnType<typeof listedPc>>) {
  const record = await signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT, signer: device.publicKey,
    key: device.publicKey, id: newRecordId(), issued_at: new Date().toISOString() }, device.keys.privateKey);
  return applyAccountRecords(fixture.app.context.services.devices, [record], serverId);
}

const startOffline = (dir: string) => relayFixture(false, { stateDir: dir, accountOpensAll: true, accountService: { url: "off" } });
function restartOffline(dir: string) {
  const restarted = startOffline(dir);
  restarted.app.stop();
  return restarted.app.context.services.devices;
}

const RECOVERY_FILES = ["account-pc.json", REMOVAL_FILE, JOURNAL_FILE, "devices.json", "revoke-all.json", "account-tombstones.json"] as const;
const recoveryFiles = (dir: string) => Object.fromEntries(RECOVERY_FILES.map(name => {
  const path = join(dir, name);
  return [name, existsSync(path) ? readFileSync(path, "utf8") : null];
}));

test("P8: an invalid listed count cannot finish recovery with a missing registry", async () => {
  const { fixture } = await listedPc();
  const dir = fixture.stateDir;
  fixture.app.stop();
  rmSync(join(dir, ACCOUNT_DEVICES_FILE));
  const intent = join(dir, "revoke-all.json");
  writePrivateState(intent, { id: "fixture", by: "pc", at: new Date().toISOString(), rows: [], listed: "1" });
  const devices = restartOffline(dir);
  expect(existsSync(intent)).toBe(true);
  expect(devices.failsClosed).toBe(true);
});

/** A live listed row, a Revoke-all stopped before its receipt, then one start that cannot read the listed registry. */
async function revokeAllAcrossUnreadableRows() {
  const { fixture, device, serverId } = await listedPc();
  const dir = fixture.stateDir;
  const path = join(dir, ACCOUNT_DEVICES_FILE);
  fixture.app.stop();
  const file = parseAccountDevicesFile(JSON.parse(readFileSync(path, "utf8")));
  writePrivateState(path, { ...file, devices: file.devices.map(row => ({ ...row, state: "live" as const, hold_until: null })) });
  const live = startOffline(dir).app;
  const fault = failReplacement(join(dir, REMOVAL_FILE), device.id);
  try { expect(() => live.context.services.devices.revokeAll()).toThrow("replacement failed"); } finally { fault.mockRestore(); live.stop(); }
  const before = recoveryFiles(dir);
  chmodSync(path, 0o000);
  try {
    const unreadable = startOffline(dir).app;
    const strict = unreadable.context.services.devices.failsClosed;
    unreadable.stop();
    return { dir, device, serverId, unreadable: { strict, files: recoveryFiles(dir) }, before };
  } finally { chmodSync(path, 0o600); }
}

test("T41/S19/P8/P10: an unreadable listed registry during Revoke-all recovery: the revoked row cannot sign in afterwards", async () => {
  const { dir, device, serverId } = await revokeAllAcrossUnreadableRows();
  const restarted = startOffline(dir);
  closes.push(() => restarted.close());
  const link = await relayConnection(restarted, { serverId });
  const outcome = await link.auth(device).then(() => "auth_ok", async () => await bounded(link.serverError));
  expect(outcome).toBe("auth_failed");
});

test("T41/S19/P8/P10: an unreadable listed registry during Revoke-all recovery: the Revoke and drop are recorded and the intent kept until durable", async () => {
  const { dir, device, unreadable, before } = await revokeAllAcrossUnreadableRows();
  expect(unreadable).toEqual({ strict: true, files: before });
  restartOffline(dir);
  expect(drops(dir).filter(entry => entry.row === device.id)).toEqual([
    { kind: "drop", how: "revoke_all", key: device.publicKey, row: device.id, account: ACCOUNT },
  ]);
  expect(RemovalEvidence.open(dir, null).standingRevokes(device.publicKey)).toHaveLength(1);
  expect(rows(dir)).toEqual([]);
  expect(existsSync(join(dir, "revoke-all.json"))).toBe(false);
});

test("T41/S19/P8/P10: a missing listed registry during Revoke-all recovery: the revoked row cannot sign in once the file is restored", async () => {
  const { fixture, device, serverId } = await listedPc();
  const dir = fixture.stateDir;
  const path = join(dir, ACCOUNT_DEVICES_FILE);
  fixture.app.stop();
  const file = parseAccountDevicesFile(JSON.parse(readFileSync(path, "utf8")));
  writePrivateState(path, { ...file, devices: file.devices.map(row => ({ ...row, state: "live" as const, hold_until: null })) });
  const live = startOffline(dir).app;
  const fault = failReplacement(join(dir, REMOVAL_FILE), device.id);
  try { expect(() => live.context.services.devices.revokeAll()).toThrow("replacement failed"); } finally { fault.mockRestore(); live.stop(); }
  const saved = readFileSync(path, "utf8");
  rmSync(path);
  restartOffline(dir);
  writeFileSync(path, saved, { mode: 0o600 });
  const restarted = startOffline(dir);
  closes.push(() => restarted.close());
  const link = await relayConnection(restarted, { serverId });
  const outcome = await link.auth(device).then(() => "auth_ok", async () => await bounded(link.serverError));
  expect(outcome).toBe("auth_failed");
});

test("T41/S19/P8/P10: a new Revoke-all while the listed registry will not parse ends known rows, keeps its intent, and the listed row cannot sign in once the file is restored", async () => {
  const { fixture, device, member, serverId } = await listedPc();
  const dir = fixture.stateDir;
  const path = join(dir, ACCOUNT_DEVICES_FILE);
  const intent = join(dir, "revoke-all.json");
  fixture.app.stop();
  const file = parseAccountDevicesFile(JSON.parse(readFileSync(path, "utf8")));
  writePrivateState(path, { ...file, devices: file.devices.map(row => ({ ...row, state: "live" as const, hold_until: null })) });
  const original = readFileSync(path, "utf8");
  expect(existsSync(intent)).toBe(false);
  writeFileSync(path, "{");
  const broken = startOffline(dir).app;
  try {
    expect(broken.context.services.devices.failsClosed).toBe(true);
    if (process.platform === "win32") expect(broken.context.services.devices.revokeAll()).toEqual([member.id]);
    else expect(await askRecovery(dir, { act: "revoke_all" })).toEqual({ revoked: 1 });
    expect(broken.context.services.devices.list(null)).toEqual([]);
    expect(existsSync(intent)).toBe(true);
  } finally { broken.stop(); }
  writeFileSync(path, original, { mode: 0o600 });
  const restarted = startOffline(dir);
  closes.push(() => restarted.close());
  expect(RemovalEvidence.open(dir, null).standingRevokes(device.publicKey)).toHaveLength(1);
  const link = await relayConnection(restarted, { serverId });
  const outcome = await link.auth(device).then(() => "auth_ok", async () => await bounded(link.serverError));
  expect(outcome).toBe("auth_failed");
});

test("T41/S19/P8/P10: a new Revoke-all on a bound PC whose listed registry is missing keeps its intent, and the listed row cannot sign in once the file is restored", async () => {
  const { fixture, device, member, serverId } = await listedPc();
  const dir = fixture.stateDir;
  const path = join(dir, ACCOUNT_DEVICES_FILE);
  const intent = join(dir, "revoke-all.json");
  fixture.app.stop();
  const file = parseAccountDevicesFile(JSON.parse(readFileSync(path, "utf8")));
  writePrivateState(path, { ...file, devices: file.devices.map(row => ({ ...row, state: "live" as const, hold_until: null })) });
  const saved = readFileSync(path, "utf8");
  rmSync(path);
  const missing = startOffline(dir).app;
  try {
    expect(missing.context.services.devices.revokeAll()).toEqual([member.id]);
    expect(missing.context.services.devices.list(null)).toEqual([]);
    expect(missing.context.services.devices.failsClosed).toBe(true);
    expect(existsSync(intent)).toBe(true);
    // The file reappears before restart. This store has not read it, so retrying cannot finish its listed denial.
    writeFileSync(path, saved, { mode: 0o600 });
    expect(missing.context.services.devices.revokeAll()).toEqual([]);
    expect(existsSync(intent)).toBe(true);
  } finally { missing.stop(); }
  const restarted = startOffline(dir);
  closes.push(() => restarted.close());
  const link = await relayConnection(restarted, { serverId });
  const outcome = await link.auth(device).then(() => "auth_ok", async () => await bounded(link.serverError));
  expect(outcome).toBe("auth_failed");
});

test("T70: replaying the deferred listed denial does not revoke a later whole-read admission", async () => {
  const { fixture, service, device, serverId } = await listedPc();
  const dir = fixture.stateDir;
  const path = join(dir, ACCOUNT_DEVICES_FILE);
  const intent = join(dir, "revoke-all.json");
  fixture.app.stop();
  const old = readFileSync(path, "utf8");
  rmSync(path);
  const missing = startOffline(dir).app;
  let deferred: string;
  try {
    missing.context.services.devices.revokeAll();
    deferred = readFileSync(intent, "utf8");
  } finally { missing.stop(); }

  writeFileSync(path, old);
  const online = relayFixture(false, { stateDir: dir, accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch } });
  const newer = keyOf("later-listed");
  const id = accountDeviceId(serverId, newer);
  try {
    const { devices, accountMailbox } = online.app.context.services;
    const owner = keyOf("later-owner");
    const paired = devices.pairRelay(devices.startPairing().code, "Owner", owner);
    if (!paired) throw new Error("Owner did not pair");
    devices.linkAccountKey(paired.device.id, owner, owner, ACCOUNT);
    service.registerDevice(ACCOUNT, newer, "New tablet");
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(rows(dir).map(row => row.id)).toEqual([id]);
  } finally { online.app.stop(); }

  // Replay the retained intent against the registry a later whole read actually produced.
  writeFileSync(intent, deferred);
  const recovered = restartOffline(dir);
  expect(recovered.account()).toBe(ACCOUNT);
  expect(rows(dir).map(row => row.id)).toEqual([id]);
  const evidence = RemovalEvidence.open(dir, null);
  expect(evidence.standingRevokes(newer)).toEqual([]);
  expect(evidence.standingRevokes(device.publicKey)).toHaveLength(1);
});

test.each(["unallocated sequence", "transfer points to admission"] as const)("T41/S19/P8/P10: a contradictory drop receipt preserves the registry (%s)", async damage => {
  const { fixture, device } = await listedPc();
  const dir = fixture.stateDir;
  const journalPath = join(dir, JOURNAL_FILE);
  const evidencePath = join(dir, REMOVAL_FILE);
  const fault = damage === "unallocated sequence" ? failReplacement(journalPath) : failReplacement(evidencePath, '"journalled"');
  try { expect(() => fixture.app.context.services.devices.revoke(device.id)).toThrow("replacement failed"); } finally { fault.mockRestore(); }
  fixture.app.stop();
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  if (damage === "unallocated sequence") {
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    expect(evidence.row_drops).toMatchObject([{ row: device.id, how: "revoke" }]);
    evidence.row_drops[0].journalled = journal.next_seq;
    writeFileSync(evidencePath, JSON.stringify(evidence));
  } else {
    expect(journal.last_row_drop).toMatchObject({ row: device.id, how: "revoke" });
    const admit = DeviceJournal.open(dir).entries().find(event => event.kind === "admit" && event.row === device.id);
    if (!admit) throw new Error("missing listed admission");
    journal.last_row_drop.journalled = admit.seq;
    writeFileSync(journalPath, JSON.stringify(journal));
  }
  const before = readFileSync(evidencePath, "utf8");
  expect(restartOffline(dir).failsClosed).toBe(true);
  expect(rows(dir).map(row => row.id)).toEqual([device.id]);
  expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toEqual(JSON.parse(before));
});

test("T41/S19/P8/P10: an unwritable drop receipt starts strict and retries the original sequence", async () => {
  const { fixture, device, member } = await listedPc();
  const dir = fixture.stateDir;
  const journalPath = join(dir, JOURNAL_FILE);
  const fault = failReplacement(join(dir, REMOVAL_FILE), '"journalled"');
  try {
    expect(() => fixture.app.context.services.devices.revoke(device.id)).toThrow("replacement failed");
    fixture.app.stop();
    const written = DeviceJournal.open(dir).entries().at(-1);
    expect(written).toMatchObject({ kind: "drop", how: "revoke", row: device.id });
    const before = readFileSync(journalPath, "utf8");
    const { app } = startOffline(dir);
    try {
      expect(app.context.services.devices.list(null).map(row => row.id)).toContain(member.id);
      expect(app.context.services.devices.sessionRow(member.id)).toBeNull();
      expect(app.context.services.devices.accountError).not.toBeNull();
    } finally { app.stop(); }
    expect(rows(dir).map(row => row.id)).toEqual([device.id]);
    fault.mockRestore();
    const { app: repairedApp } = startOffline(dir);
    try {
      const repaired = repairedApp.context.services.devices;
      expect(repaired.accountError).toBeNull();
      // The repaired PC keeps the old credential; its Step 2 authority still waits for a whole read.
      expect(repaired.sessionRow(member.id)?.key).toBe(member.publicKey);
      expect(repaired.catchingUp(member.id, false)).toBe(true);
      repairedApp.context.services.catchUp?.wholeRead();
      expect(repaired.catchingUp(member.id, false)).toBe(false);
      expect(repaired.sessionRow(member.id)?.key).toBe(member.publicKey);
    } finally { repairedApp.stop(); }
    expect(rows(dir)).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, REMOVAL_FILE), "utf8")).row_drops).toMatchObject([{ row: device.id, journalled: written?.seq }]);
    expect(readFileSync(journalPath, "utf8")).toBe(before);
  } finally { fault.mockRestore(); }
});

test.each(["identity reset", "local Revoke"] as const)("P8/T41/P10: pending Revoke-all owns the listed row before %s", async action => {
  const { fixture, device } = await listedPc();
  const dir = fixture.stateDir;
  const { devices, relay } = fixture.app.context.services;
  const fault = failReplacement(join(dir, REMOVAL_FILE), device.id);
  try { expect(() => devices.revokeAll()).toThrow("replacement failed"); } finally { fault.mockRestore(); }
  expect(existsSync(join(dir, "revoke-all.json"))).toBe(true);
  expect(rows(dir).map(row => row.id)).toEqual([device.id]);
  expect(RemovalEvidence.open(dir, null).standingRevokes(device.publicKey)).toEqual([]);
  if (action === "identity reset") await relay.resetIdentity();
  else devices.revoke(device.id);
  fixture.app.stop();
  restartOffline(dir);
  restartOffline(dir);
  expect(drops(dir).filter(entry => entry.row === device.id)).toEqual([
    { kind: "drop", how: "revoke_all", key: device.publicKey, row: device.id, account: ACCOUNT },
  ]);
  expect(RemovalEvidence.open(dir, null).standingRevokes(device.publicKey)).toHaveLength(1);
  expect(rows(dir)).toEqual([]);
  expect(existsSync(join(dir, "revoke-all.json"))).toBe(false);
});

test("P8/T41/P10/T44: identity reset preserves a signed leave's pending drop", async () => {
  const pc = await listedPc();
  const { fixture, device } = pc;
  const dir = fixture.stateDir;
  const fault = failReplacement(join(dir, JOURNAL_FILE));
  try { await expect(leave(pc)).rejects.toThrow("replacement failed"); } finally { fault.mockRestore(); }
  expect(rows(dir).map(row => row.id)).toEqual([device.id]);
  expect(drops(dir)).toEqual([]);
  await fixture.app.context.services.relay.resetIdentity();
  fixture.app.stop();
  restartOffline(dir);
  restartOffline(dir);
  expect(drops(dir).filter(entry => entry.row === device.id)).toEqual([
    { kind: "drop", how: "remove", key: device.publicKey, row: device.id, account: ACCOUNT },
  ]);
  expect(rows(dir)).toEqual([]);
});

test.each(["last listed row", "still-listed sibling"] as const)("P8/T41/P10: leave then Revoke-all during one outage (%s)", async scenario => {
  const pc = await listedPc();
  const { fixture, device, serverId, service } = pc;
  const { accountMailbox, devices } = fixture.app.context.services;
  const dir = fixture.stateDir;
  const siblingKey = keyOf("sibling");
  const sibling = accountDeviceId(serverId, siblingKey);
  const expected = [{ kind: "drop" as const, how: "remove", key: device.publicKey, row: device.id, account: ACCOUNT }];
  if (scenario === "still-listed sibling") {
    service.registerDevice(ACCOUNT, siblingKey, "Sibling");
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expected.push({ kind: "drop", how: "revoke_all", key: siblingKey, row: sibling, account: ACCOUNT });
  }
  const fault = failReplacement(join(dir, JOURNAL_FILE));
  try {
    await expect(leave(pc)).rejects.toThrow("replacement failed");
    try { devices.revokeAll(); } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("replacement failed")) throw error;
    }
    expect(rows(dir).map(row => row.id)).toEqual(expected.map(entry => entry.row));
    expect(drops(dir)).toEqual([]);
  } finally { fault.mockRestore(); }
  fixture.app.stop();
  restartOffline(dir);
  restartOffline(dir);
  expect(drops(dir).filter(entry => entry.row === device.id || entry.row === sibling)).toEqual(expected);
  expect(rows(dir)).toEqual([]);
});

test("P8/T41/P10: a journalled Revoke-all after a pending leave keeps the leave's own reason", async () => {
  const pc = await listedPc();
  const { fixture, device } = pc;
  const { devices } = fixture.app.context.services;
  const dir = fixture.stateDir;
  const fault = failReplacement(join(dir, JOURNAL_FILE));
  try { await expect(leave(pc)).rejects.toThrow("replacement failed"); } finally { fault.mockRestore(); }
  expect(drops(dir)).toEqual([]);
  devices.revokeAll();
  fixture.app.stop();
  restartOffline(dir);
  expect(drops(dir).filter(entry => entry.row === device.id)).toEqual([
    { kind: "drop", how: "remove", key: device.publicKey, row: device.id, account: ACCOUNT },
  ]);
  expect(rows(dir)).toEqual([]);
});

test("P8/T41/P10: offline Revoke recovery allocates no new drop after the original is trimmed", async () => {
  const { fixture, device, member } = await listedPc();
  const dir = fixture.stateDir;
  const { devices } = fixture.app.context.services;
  const fault = failReplacement(join(dir, ACCOUNT_DEVICES_FILE));
  try { expect(() => devices.revoke(device.id)).toThrow("replacement failed"); } finally { fault.mockRestore(); }
  expect(rows(dir).map(row => row.id)).toEqual([device.id]);
  const original = DeviceJournal.open(dir).entries().at(-1);
  expect(original).toMatchObject({ kind: "drop", how: "revoke", row: device.id });
  fixture.app.stop();
  // Replay closes consume capacity too. Fill the rest in one write, then rotate past the drop and its close.
  const path = join(dir, JOURNAL_FILE);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const link = { kind: "account", how: "link", key: member.publicKey, row: member.id, account: ACCOUNT, no: null, label: "", by: null } as const;
  const fill = Array.from({ length: JOURNAL_MAX - doc.entries.length - (doc.closed?.length ?? 0) }, (_, i) => ({
    ...link, seq: doc.next_seq + i, id: i.toString(16).padStart(32, "0"), at: new Date().toISOString(),
  }));
  writeFileSync(path, JSON.stringify({ ...doc, next_seq: doc.next_seq + fill.length, entries: [...doc.entries, ...fill] }));
  const journal = DeviceJournal.open(dir);
  for (let index = fill.length; index < JOURNAL_MAX; index++) journal.append(link);
  const retained = DeviceJournal.open(dir).entries();
  expect(retained[0]?.seq).toBe(doc.next_seq);
  expect(retained.some(entry => entry.id === original?.id)).toBe(false);
  restartOffline(dir);
  expect(rows(dir)).toEqual([]);
  expect(drops(dir).filter(entry => entry.row === device.id)).toEqual([]);
  expect(DeviceJournal.open(dir).entries().at(-1)?.seq).toBe(retained.at(-1)?.seq);
});
