import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountDeviceId, newRecordId, signSafetyRecord } from "../../shared/account-records.ts";
import { createServer } from "../index.ts";
import { isJsonObject } from "../http.ts";
import { privateStateFs } from "../private-state.ts";
import { loadRelayIdentity, rotateRelayIdentity } from "../relay/identity.ts";
import { DeviceJournal } from "./device-journal.ts";
import { askRecovery } from "./recovery.ts";
import { parseEvidence, RemovalEvidence } from "./removal-evidence.ts";
import { SafetyLog } from "./safety-log.ts";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const stamp = (offset: number) => new Date(NOW + offset).toISOString();
const FUTURE = stamp(2 * DAY);
const REVOKED = stamp(2 * DAY + 1);
const id = "a".repeat(16);
const other = "b".repeat(16);
const account = "acct_1";
const key = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const row = (created_at = FUTURE, k = key(), rowId = id) => ({ id: rowId, label: "Phone", role: "drive", token_hash: "c".repeat(64), relay_public_key: k, created_at, last_seen_at: null, origin: { from: "pc", how: "link", by: null, admit_no: Number.parseInt(rowId[0] ?? "0", 16) + 1, at: stamp(-DAY) } });
const tomb = (key: string, removed_at: string, record_id = "local") => ({ key, account, removed_at, record_id });
const revoke = (key: string, at: string) => ({ id: createHash("sha256").update(`${key}\n${account}\n${at}`).digest("hex").slice(0, 32), key, account, at });
const dirs: string[] = [];
const apps = new Set<ReturnType<typeof createServer>>();
const posix = test.skipIf(process.platform === "win32");
let herdrSocket: string | undefined;

beforeEach(() => {
  setSystemTime(NOW);
  herdrSocket = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = join(dir(), "unused.sock");
});
afterEach(() => {
  setSystemTime();
  for (const app of apps) app.stop();
  apps.clear();
  if (herdrSocket === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = herdrSocket;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dir() {
  const path = mkdtempSync(join(tmpdir(), "ovis-restamp-"));
  dirs.push(path);
  return path;
}
const put = (dir: string, file: string, value: unknown) => writeFileSync(join(dir, file), JSON.stringify(value), { mode: 0o600 });
const bytes = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
// Clock repair is for numbered Step 2 pairings. An old Step 1 time is quarantined instead.
function registry(dir: string, ...devices: ReturnType<typeof row>[]) {
  if (!existsSync(join(dir, "account-pc.json"))) put(dir, "account-pc.json", { v: 1, next_admit: 32 });
  put(dir, "devices.json", { gate_closed_at: stamp(-DAY), devices });
}
const registered = (dir: string) => (JSON.parse(bytes(dir, "devices.json")) as { devices: ReturnType<typeof row>[] }).devices;
const tombstones = (dir: string, ...tombstones: ReturnType<typeof tomb>[]) => put(dir, "account-tombstones.json", { v: 1, tombstones });
const evidence = (dir: string) => parseEvidence(JSON.parse(bytes(dir, "account-removed.json")));
const pending = (dir: string) => existsSync(join(dir, "restamp.json"));

function start(stateDir: string, siblingStateDir?: string) {
  const app = createServer({ stateDir, ...(siblingStateDir === undefined ? {} : { siblingStateDir }), accountOpensAll: true, port: 0, hostname: "127.0.0.1", tailscaleOwner: null, sidecar: false, machines: false });
  apps.add(app);
  return { devices: app.context.services.devices, stop() { app.stop(); apps.delete(app); } };
}

async function queue(dir: string) {
  const preview = await askRecovery(dir, { act: "restamp" }) as { confirm?: string; error?: string };
  expect(preview).not.toHaveProperty("error");
  expect(preview.confirm).toBeString();
  expect(await askRecovery(dir, { act: "restamp", confirm: preview.confirm })).toMatchObject({ queued: true });
}

posix("restamp 1/12: a Revoke still denies, with one derived ID shared by both tombstone copies", async () => {
  const [active, sibling] = [dir(), dir()];
  const paired = row();
  const k = paired.relay_public_key;
  registry(active, paired);
  tombstones(active, tomb(k, REVOKED));
  tombstones(sibling, tomb(k, REVOKED));
  const ended = key();
  const endedRevoke = revoke(ended, stamp(2 * DAY + 2));
  const unrevoke = { id: "e".repeat(32), revoke: endedRevoke.id, at: stamp(2 * DAY + 3), by: "pc" };
  for (const folder of [active, sibling]) put(folder, "account-removed.json", {
    v: 1, markers: [], revokes: [revoke(k, REVOKED), endedRevoke], unrevokes: [unrevoke],
  });
  const closed = start(active, sibling);
  expect(closed.devices.failsClosed).toBe(true);
  const unchanged = ["devices.json", "account-tombstones.json", "account-removed.json", "account-pc.json", "account-log.json"];
  const before = unchanged.map((file) => bytes(active, file));
  await queue(active);
  expect(unchanged.map((file) => bytes(active, file))).toEqual(before);
  closed.stop();
  const restarted = start(active, sibling);
  expect(restarted.devices.failsClosed).toBe(false);
  expect(restarted.devices.hasKey(k)).toBe(false);
  const endedAfter = revoke(ended, stamp(3));
  for (const folder of [active, sibling]) {
    expect(evidence(folder)?.revokes).toEqual([revoke(k, stamp(2)), endedAfter]);
    expect(evidence(folder)?.unrevokes).toEqual([{ ...unrevoke, at: stamp(4), revoke: endedAfter.id }]);
  }
  expect(bytes(active, "account-tombstones.json")).toContain(stamp(2));
  expect(bytes(sibling, "account-tombstones.json")).toContain(stamp(2));
});

posix("restamp 1: refuse a new Revoke ID already occupied in the ledger", async () => {
  const active = dir();
  const k = key();
  registry(active, row());
  tombstones(active, tomb(k, REVOKED));
  put(active, "account-removed.json", {
    v: 1, markers: [], unrevokes: [],
    revokes: [revoke(k, REVOKED), { ...revoke(key(), stamp(-DAY)), id: revoke(k, stamp(2)).id }],
  });
  expect(start(active).devices.failsClosed).toBe(true);
  expect(await askRecovery(active, { act: "restamp" })).toMatchObject({ error: expect.stringMatching(/collide/) });
  expect(pending(active)).toBe(false);
});

posix("restamp 2/3/10: keep own values below the floor, including a past pairing denied by a later removal", async () => {
  const active = dir();
  const past = row(stamp(-HOUR));
  const soon = row(stamp(300_000), key(), other);
  const ahead = row(FUTURE, key(), "d".repeat(16));
  registry(active, past, soon, ahead);
  tombstones(active, tomb(past.relay_public_key, stamp(HOUR), "r"));
  const closed = start(active);
  await queue(active);
  expect(JSON.parse(bytes(active, "restamp.json"))).toMatchObject({
    base: stamp(HOUR), mapping: [{ old: FUTURE, new: stamp(HOUR + 1) }],
  });
  closed.stop();
  const restarted = start(active);
  expect(restarted.devices.failsClosed).toBe(false);
  expect(restarted.devices.hasKey(past.relay_public_key)).toBe(false);
  expect(restarted.devices.list(null).find(({ id }) => id === other)?.created_at).toBe(stamp(300_000));
  expect(restarted.devices.list(null).find(({ id }) => id === ahead.id)?.created_at).toBe(stamp(HOUR + 1));
});

posix.each([
  ["a malformed own timestamp", "not ISO", null, /malformed|ISO/i],
  ["an unreadable safety log", FUTURE, "account-log.json", /log/i],
  ["a non-own time more than a day ahead", FUTURE, "account-tombstones.json", /elsewhere|non-own/i],
] as const)("restamp 4/11: refuse %s", async (_name, at, file, message) => {
  const active = dir();
  registry(active, row(at));
  if (file === "account-log.json") put(active, file, false);
  if (file === "account-tombstones.json") tombstones(active, tomb(key(), stamp(DAY + 1), "r"));
  expect(start(active).devices.failsClosed).toBe(true);
  expect(await askRecovery(active, { act: "restamp" })).toMatchObject({ error: expect.stringMatching(message) });
  expect(pending(active)).toBe(false);
});

posix("restamp 5: resume a partial rewrite without changing the approved timestamps", async () => {
  for (const partial of [false, true]) {
    const active = dir();
    const k = key();
    registry(active, row());
    tombstones(active, tomb(k, REVOKED));
    const closed = start(active);
    await queue(active);
    closed.stop();
    if (partial) {
      const { devices } = JSON.parse(bytes(active, "devices.json")) as { devices: ReturnType<typeof row>[] };
      registry(active, ...devices.map((device) => ({ ...device, created_at: stamp(1) })));
    }
    setSystemTime(NOW + 600_000);
    const restarted = start(active);
    expect(restarted.devices.failsClosed).toBe(false);
    expect(restarted.devices.list(null)[0]?.created_at).toBe(stamp(1));
    expect(evidence(active)?.revokes).toEqual([{ ...revoke(k, stamp(2)), legacy_time: true }]);
    setSystemTime(NOW);
  }
});

posix("restamp 6: a later non-own time invalidates a plan without rewriting any timestamp", async () => {
  const active = dir();
  registry(active, row());
  const closed = start(active);
  await queue(active);
  closed.stop();
  const before = bytes(active, "devices.json");
  tombstones(active, tomb(key(), stamp(HOUR), "late"));
  const restarted = start(active);
  expect(restarted.devices.failsClosed).toBe(true);
  expect(restarted.devices.accountError).toContain("ovis recover --restamp again");
  expect(bytes(active, "devices.json")).toBe(before);
  expect(pending(active)).toBe(false);
  expect(existsSync(join(active, "restamp-refused.json"))).toBe(true);
  expect(bytes(active, "device-journal.json")).toContain("restamp refused");
  await queue(active);
  restarted.stop();
  const repaired = start(active);
  expect(repaired.devices.failsClosed).toBe(false);
  expect(repaired.devices.list(null)[0]?.created_at).toBe(stamp(HOUR + 1));
});

posix.each(["newer", "non-own", "bad shape", "unsafe"] as const)("restamp 7: fail closed over a %s plan", async (damage) => {
  const active = dir();
  registry(active, row());
  const closed = start(active);
  await queue(active);
  closed.stop();
  const file = "restamp.json";
  const plan = JSON.parse(bytes(active, file));
  if (damage === "unsafe") {
    rmSync(join(active, file));
    mkdirSync(join(active, file));
  } else {
    if (damage === "newer") plan.mapping[0].new = stamp(3 * DAY);
    if (damage === "non-own") plan.mapping[0].field = "last_seen_at";
    if (damage === "bad shape") plan.extra = true;
    put(active, file, plan);
  }
  const before = bytes(active, "devices.json");
  const restarted = start(active);
  expect(restarted.devices.failsClosed).toBe(true);
  expect(restarted.devices.accountError).toContain("restamp.json");
  expect(bytes(active, "devices.json")).toBe(before);
  expect(pending(active)).toBe(true);
});

posix("restamp 8: the asked audit reaches disk before publishing the plan, and applied is recorded at startup", async () => {
  const active = dir();
  registry(active, row());
  const closed = start(active);
  const rename = privateStateFs.renameSync;
  let journalAtPublish = "";
  privateStateFs.renameSync = (from, to) => {
    if (to === join(active, "restamp.json")) journalAtPublish = bytes(active, "device-journal.json");
    rename(from, to);
  };
  try { await queue(active); } finally { privateStateFs.renameSync = rename; }
  expect(journalAtPublish).toContain("restamp asked");
  expect(journalAtPublish).not.toContain("restamp applied");
  closed.stop();
  start(active);
  expect(pending(active)).toBe(false);
  expect(existsSync(join(active, "restamp-done.json"))).toBe(true);
  expect(bytes(active, "device-journal.json")).toContain("restamp applied");
});

posix("r1 HIGH 1: startup refuses a writable log without changing its mode or bytes", async () => {
  const active = dir();
  registry(active, row());
  const closed = start(active);
  await queue(active);
  closed.stop();
  const file = "account-log.json";
  const before = bytes(active, file);
  chmodSync(join(active, file), 0o664);
  const restarted = start(active);
  expect({
    closed: restarted.devices.failsClosed, mode: statSync(join(active, file)).mode & 0o777, log: bytes(active, file), pending: pending(active),
  }).toEqual({ closed: true, mode: 0o664, log: before, pending: true });
});

posix("r1 HIGH 2: clock-blocked sibling merge does not coalesce away a separate local denial", async () => {
  const [active, sibling] = [dir(), dir()];
  const paired = row();
  registry(active, paired);
  tombstones(active, tomb(paired.relay_public_key, REVOKED));
  tombstones(sibling, tomb(paired.relay_public_key, stamp(HOUR), "service-removal"));
  const closed = start(active, sibling);
  expect(closed.devices.failsClosed).toBe(true);
  await queue(active);
  closed.stop();
  const repaired = start(active, sibling);
  expect(repaired.devices.failsClosed).toBe(false);
  expect(repaired.devices.hasKey(paired.relay_public_key)).toBe(false);
  expect(evidence(active)?.revokes).toContainEqual({ ...revoke(paired.relay_public_key, stamp(HOUR + 2)), legacy_time: true, untrusted_time: true });
  expect(evidence(active)?.markers[0]?.removals.map(({ id }) => id)).toContain("service-removal");
});

function failRename(path: string, run: () => void) {
  const rename = privateStateFs.renameSync;
  let hit = false;
  privateStateFs.renameSync = (from, to) => {
    if (to === path && !hit) {
      hit = true;
      throw new Error("interrupted private-state replacement");
    }
    rename(from, to);
  };
  try { run(); } finally { privateStateFs.renameSync = rename; }
  return hit;
}

posix.each([false, true])("r1 HIGH 3: stale two-folder plan rolls back; interrupt rollback=%p", async (interrupt) => {
  const [active, sibling] = [dir(), dir()];
  const first = row();
  const k = key();
  for (const folder of [active, sibling]) {
    registry(folder, first);
    tombstones(folder, tomb(k, REVOKED));
  }
  const closed = start(active, sibling);
  await queue(active);
  closed.stop();
  expect(failRename(join(sibling, "devices.json"), () => start(active, sibling).stop())).toBe(true);
  expect(registered(active)[0]?.created_at).toBe(stamp(1));
  expect(bytes(active, "account-tombstones.json")).toContain(stamp(2));
  expect(registered(sibling)[0]?.created_at).toBe(FUTURE);
  tombstones(sibling, tomb(k, REVOKED), tomb(key(), stamp(HOUR), "late-removal"));
  if (interrupt) {
    expect(failRename(join(active, "account-tombstones.json"), () => {
      const stopped = start(active, sibling);
      expect(stopped.devices.failsClosed).toBe(true);
      stopped.stop();
    })).toBe(true);
    expect(pending(active) || existsSync(join(active, "restamp-rollback.json"))).toBe(true);
    expect(registered(active)[0]?.created_at).toBe(FUTURE);
    expect(bytes(active, "account-tombstones.json")).toContain(stamp(2));
  }
  const refused = start(active, sibling);
  expect(refused.devices.failsClosed).toBe(true);
  expect(refused.devices.accountError).toContain("A time from elsewhere changed");
  expect(registered(active)[0]?.created_at).toBe(FUTURE);
  expect(bytes(active, "account-tombstones.json")).toContain(REVOKED);
  expect(registered(sibling)[0]?.created_at).toBe(FUTURE);
  expect(bytes(sibling, "account-tombstones.json")).toContain(stamp(HOUR));
  expect(existsSync(join(active, "restamp-refused.json"))).toBe(true);
  await queue(active);
  refused.stop();
  expect(start(active, sibling).devices.failsClosed).toBe(false);
});

posix("r1 HIGH 3: starting the sibling completes the other folder's plan", async () => {
  const [active, sibling] = [dir(), dir()];
  const first = row();
  registry(active, first);
  registry(sibling, first);
  const closed = start(active, sibling);
  await queue(active);
  closed.stop();
  expect(start(sibling, active).devices.failsClosed).toBe(false);
  expect(existsSync(join(active, "restamp-done.json"))).toBe(true);
  expect(registered(sibling)[0]?.created_at).toBe(stamp(1));
});

posix("r1 HIGH 4: an otherwise unoccupied ID named by a sibling Unrevoke is reserved", async () => {
  const [active, sibling] = [dir(), dir()];
  const k = key();
  registry(active, row());
  tombstones(active, tomb(k, REVOKED));
  put(sibling, "account-removed.json", {
    v: 1, markers: [], revokes: [], unrevokes: [{ id: "e".repeat(32), revoke: revoke(k, stamp(2)).id, at: stamp(-DAY), by: "pc" }],
  });
  expect(start(active, sibling).devices.failsClosed).toBe(true);
  expect(await askRecovery(active, { act: "restamp" })).toMatchObject({ error: expect.stringMatching(/collide|reserved/) });
  expect(pending(active)).toBe(false);
});

posix("r1 MEDIUM: a waiting signed block contributes to the comparison floor", async () => {
  const active = dir();
  registry(active, row());
  const closed = start(active);
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const signer = Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64url");
  const block = await signSafetyRecord({ v: 1, kind: "block", account, target: key(), signer, target_no: 2, signer_no: 1, signed_at: stamp(HOUR), nonce: newRecordId() }, pair.privateKey);
  if (block.kind !== "block") throw new Error("Expected a signed block fixture");
  expect(SafetyLog.open(active).wait({ record: block, got: "mailbox", signer_removed: false })).toBe(true);
  await queue(active);
  expect(JSON.parse(bytes(active, "restamp.json"))).toMatchObject({ base: stamp(HOUR) });
  closed.stop();
});

posix("r1 MEDIUM: confirmation refuses a newly conflicting sibling binding", async () => {
  const [active, sibling] = [dir(), dir()];
  const binding = (account: string, bind_id: string) => ({ v: 1, next_admit: 32, binding: { account, bind_id }, clears: [], first: null, others_ever: true, gen: 0 });
  registry(active, row());
  put(active, "account-pc.json", binding(account, "a".repeat(32)));
  start(active, sibling);
  const preview = await askRecovery(active, { act: "restamp" }) as { confirm?: string };
  expect(preview.confirm).toBeString();
  put(sibling, "account-pc.json", binding("other_account", "b".repeat(32)));
  expect(await askRecovery(active, { act: "restamp", confirm: preview.confirm })).toMatchObject({ error: expect.stringMatching(/bind.*two accounts/i) });
  expect(pending(active)).toBe(false);
});

posix.each([false, true])("r1 MEDIUM: audit is already on disk when archiving a plan; refuse=%p", async (invalidated) => {
  const active = dir();
  registry(active, row());
  const closed = start(active);
  await queue(active);
  closed.stop();
  if (invalidated) tombstones(active, tomb(key(), stamp(HOUR), "late-removal"));
  const label = invalidated ? "restamp refused" : "restamp applied";
  const archive = join(active, invalidated ? "restamp-refused.json" : "restamp-done.json");
  const rename = privateStateFs.renameSync;
  let recorded = false;
  privateStateFs.renameSync = (from, to) => {
    if (to === archive) recorded = bytes(active, "device-journal.json").includes(label);
    rename(from, to);
  };
  try { start(active); } finally { privateStateFs.renameSync = rename; }
  expect(recorded).toBe(true);
  expect(existsSync(archive)).toBe(true);
});

posix("r1 MEDIUM: Windows startup does not consume or alter a queued plan", async () => {
  const active = dir();
  registry(active, row());
  const closed = start(active);
  await queue(active);
  closed.stop();
  const before = bytes(active, "restamp.json");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  if (!platform) throw new Error("No test platform descriptor");
  Object.defineProperty(process, "platform", { value: "win32" });
  try { expect(start(active).devices.failsClosed).toBe(true); }
  finally { Object.defineProperty(process, "platform", platform); }
  expect(bytes(active, "restamp.json")).toBe(before);
  expect(bytes(active, "devices.json")).toContain(FUTURE);
});

posix("r1 LOW: a new own timestamp invalidates the plan without losing the new value", async () => {
  const active = dir();
  const first = row();
  registry(active, first);
  const closed = start(active);
  await queue(active);
  closed.stop();
  const later = row(stamp(2 * DAY + 5), key(), other);
  registry(active, first, later);
  const before = bytes(active, "devices.json");
  const refused = start(active);
  expect(refused.devices.failsClosed).toBe(true);
  expect(bytes(active, "devices.json")).toBe(before);
  expect(existsSync(join(active, "restamp-refused.json"))).toBe(true);
  await queue(active);
});

posix("r1 HIGH 3b: rollback does not overwrite a value that the plan never wrote", async () => {
  const active = dir();
  const first = row();
  const second = row(REVOKED, key(), other);
  registry(active, first, second);
  const closed = start(active);
  await queue(active);
  closed.stop();
  const independent = stamp(2 * DAY + 8);
  registry(active, { ...first, created_at: stamp(1) }, { ...second, created_at: independent });
  const refused = start(active);
  expect(refused.devices.failsClosed).toBe(true);
  const { devices } = JSON.parse(bytes(active, "devices.json")) as { devices: ReturnType<typeof row>[] };
  expect(devices.map(({ created_at }) => created_at)).toEqual([FUTURE, independent]);
});

posix("r1 MEDIUM: the startup plan is read before the sibling identity and relay state", async () => {
  const [active, sibling] = [dir(), dir()];
  registry(active, row());
  const closed = start(active, sibling);
  await queue(active);
  closed.stop();
  const watch = spyOn(fs, "readFileSync");
  let reads: unknown[];
  try {
    start(active, sibling);
    reads = watch.mock.calls.map(([path]) => path);
  } finally { watch.mockRestore(); }
  const plan = reads.indexOf(join(active, "restamp.json"));
  const identity = reads.indexOf(join(sibling, "relay", "identity.json"));
  const relay = reads.indexOf(join(active, "relay", "pairing-window.json"));
  expect({ planSeen: plan >= 0, identityAfter: identity > plan, relayAfter: relay > plan }).toEqual({
    planSeen: true, identityAfter: true, relayAfter: true,
  });
});

posix("r1 LOW: confirmation cannot overwrite a newer on-disk journal", async () => {
  const active = dir();
  registry(active, row());
  start(active);
  const preview = await askRecovery(active, { act: "restamp" }) as { confirm?: string };
  expect(preview.confirm).toBeString();
  DeviceJournal.open(active).append({ kind: "account", how: "independent audit", key: null, no: null, row: null, by: "pc", account: null, label: "independent audit" });
  const before = bytes(active, "device-journal.json");
  expect(await askRecovery(active, { act: "restamp", confirm: preview.confirm })).toMatchObject({ error: expect.stringMatching(/journal/i) });
  expect(bytes(active, "device-journal.json")).toBe(before);
  expect(pending(active)).toBe(false);
});

posix("r2 H2a: a future own time in the sibling ledger closes admission but permits recovery", async () => {
  const [active, sibling] = [dir(), dir()];
  registry(active, row(stamp(-HOUR)));
  put(sibling, "account-removed.json", { v: 1, markers: [], revokes: [revoke(key(), REVOKED)], unrevokes: [] });
  const closed = start(active, sibling);
  expect({ closed: closed.devices.failsClosed, reason: closed.devices.accountError }).toEqual({
    closed: true, reason: expect.stringMatching(/time.*future/i),
  });
  await queue(active);
});

posix("r2 H2b: both ledgers hold both standing denials before tombstone publication", async () => {
  const [active, sibling] = [dir(), dir()];
  const paired = row();
  const k = paired.relay_public_key;
  registry(active, paired);
  tombstones(active, tomb(k, REVOKED));
  tombstones(sibling, tomb(k, stamp(HOUR), "service-removal"));
  const closed = start(active, sibling);
  await queue(active);
  closed.stop();
  const rename = privateStateFs.renameSync;
  const publications = new Set<string>();
  const projections = [active, sibling].map(folder => join(folder, "account-tombstones.json"));
  privateStateFs.renameSync = (from, to) => {
    if (typeof to === "string" && projections.includes(to) && readFileSync(from, "utf8").includes("service-removal")) {
      for (const folder of [active, sibling]) {
        const ledger = RemovalEvidence.open(folder, SafetyLog.open(folder));
        expect(ledger.standingRevokes(k)).toContainEqual({ ...revoke(k, stamp(HOUR + 2)), legacy_time: true, untrusted_time: true });
        expect(ledger.standingMarkers(k).flatMap(({ standing }) => standing.map(({ id }) => id))).toContain("service-removal");
      }
      publications.add(to);
    }
    rename(from, to);
  };
  try { start(active, sibling); } finally { privateStateFs.renameSync = rename; }
  expect(publications).toEqual(new Set(projections));
});

posix.each(["origin", "sibling"] as const)("r2 H3a: a missing %s cannot terminate a partial two-folder rewrite", async missing => {
  const [active, sibling, holding] = [dir(), dir(), dir()];
  const first = row();
  const k = key();
  for (const folder of [active, sibling]) {
    registry(folder, first);
    tombstones(folder, tomb(k, REVOKED));
  }
  const closed = start(active, sibling);
  await queue(active);
  closed.stop();
  expect(failRename(join(sibling, "account-tombstones.json"), () => start(active, sibling).stop())).toBe(true);
  expect(registered(sibling)[0]?.created_at).toBe(stamp(1));
  const moved = join(holding, "missing");
  const unavailableDir = missing === "origin" ? active : sibling;
  const availableDir = missing === "origin" ? sibling : active;
  renameSync(unavailableDir, moved);
  try {
    const unavailable = start(availableDir);
    expect(unavailable.devices.failsClosed).toBe(true);
    unavailable.stop();
    const origin = missing === "origin" ? moved : active;
    expect(existsSync(join(origin, "restamp-refused.json"))).toBe(false);
    expect(pending(origin) || existsSync(join(origin, "restamp-rollback.json"))).toBe(true);
  } finally { renameSync(moved, unavailableDir); }
  const rollback = start(active, sibling);
  expect(rollback.devices.failsClosed).toBe(true);
  for (const folder of [active, sibling]) {
    expect(registered(folder)[0]?.created_at).toBe(FUTURE);
    expect(bytes(folder, "account-tombstones.json")).toContain(REVOKED);
  }
});

posix("r2 H3b: an independent non-future value keeps both startup directions closed until confirmed", async () => {
  const [active, sibling] = [dir(), dir()];
  const first = row();
  for (const folder of [active, sibling]) registry(folder, first);
  const closed = start(active, sibling);
  await queue(active);
  closed.stop();
  for (const folder of [active, sibling]) registry(folder, { ...first, created_at: stamp(-HOUR) });
  const initial = start(active, sibling);
  expect(initial.devices.failsClosed).toBe(true);
  initial.stop();
  const before = [active, sibling].map(folder => bytes(folder, "devices.json"));
  const next = start(sibling, active);
  expect(next.devices.failsClosed).toBe(true);
  expect([active, sibling].map(folder => bytes(folder, "devices.json"))).toEqual(before);
  await queue(sibling);
  next.stop();
  expect(start(active, sibling).devices.failsClosed).toBe(false);
});

posix("r2 H3c: a local-only approved repair does not involve a foreign sibling", async () => {
  const [active, foreign] = [dir(), dir()];
  loadRelayIdentity(active);
  loadRelayIdentity(foreign);
  registry(active, row());
  registry(foreign, row(REVOKED));
  const before = bytes(foreign, "devices.json");
  const closed = start(active, foreign);
  await queue(active);
  closed.stop();
  const repaired = start(active, foreign);
  expect(repaired.devices.accountError).toBeNull();
  expect(repaired.devices.failsClosed).toBe(false);
  expect(bytes(foreign, "devices.json")).toBe(before);
});

posix("r2 H3d: ordinary journal trimming does not evict a pending approval", async () => {
  const active = dir();
  registry(active, row());
  const closed = start(active);
  await queue(active);
  for (let i = 0; i < 1_000; i++) closed.devices.journalEvent({ kind: "account", how: "owner action", key: null, no: null, row: null, by: "pc", account: null, label: `action ${i}` });
  expect(DeviceJournal.open(active).entries().some(entry => entry.how === "restamp asked")).toBe(false);
  closed.stop();
  expect(start(active).devices.accountError).toBeNull();
  expect(existsSync(join(active, "restamp-done.json"))).toBe(true);
});

posix.each([false, true])("r2 M2: a row disagreeing with its binding refuses the repair; after queue=%p", async queued => {
  const active = dir();
  const first = { ...row(), account };
  registry(active, first);
  put(active, "account-pc.json", { v: 1, next_admit: 32, binding: { account, bind_id: "a".repeat(32) }, clears: [], first: null, others_ever: true, gen: 0 });
  const running = start(active);
  const preview = await askRecovery(active, { act: "restamp" }) as { confirm?: string };
  expect(preview.confirm).toBeString();
  if (queued) {
    expect(await askRecovery(active, { act: "restamp", confirm: preview.confirm })).toMatchObject({ queued: true });
    running.stop();
  }
  const inconsistent = { ...first, account: "other_account" };
  registry(active, inconsistent);
  if (queued) {
    expect(start(active).devices.failsClosed).toBe(true);
    expect(registered(active)[0]?.created_at).toBe(FUTURE);
    expect(existsSync(join(active, "restamp-done.json"))).toBe(false);
  } else {
    expect(await askRecovery(active, { act: "restamp", confirm: preview.confirm })).toMatchObject({ error: expect.stringMatching(/bind|member/i) });
    expect(pending(active)).toBe(false);
  }
});

posix("r2 M3: a trusted retryable clock refusal is audited once before returning", async () => {
  const active = dir();
  registry(active, row());
  const closed = start(active);
  await queue(active);
  closed.stop();
  setSystemTime(NOW - 2 * DAY);
  for (let attempt = 0; attempt < 2; attempt++) {
    const refused = start(active);
    expect(refused.devices.accountError).toContain("too far behind");
    refused.stop();
    expect(pending(active)).toBe(true);
  }
  const refusals = DeviceJournal.open(active).entries().filter(entry => entry.how === "restamp refused");
  expect(refusals.map(entry => entry.label)).toEqual([expect.stringContaining("too far behind")]);
});

posix("r3 H2b: a journal-ended pairing cannot end the sibling's local Revoke", () => {
  const [active, sibling] = [dir(), dir()];
  const paired = row(stamp(-HOUR));
  const k = paired.relay_public_key;
  put(active, "account-pc.json", { v: 1, next_admit: 32 });
  const running = start(active);
  running.devices.journalEvent({ kind: "remove", how: "pc", key: k, no: null, row: paired.id, label: paired.label, by: "pc", account: null });
  running.stop();
  registry(active, paired); // The stop happened after the journal write and before the row replacement.
  tombstones(sibling, tomb(k, stamp(-DAY)));
  const restarted = start(active, sibling);
  const denied = revoke(k, stamp(-DAY));
  expect({
    keyOut: !restarted.devices.hasKey(k),
    standing: RemovalEvidence.open(active, null).standingRevokes(k),
    ended: evidence(active)?.unrevokes.some(u => u.revoke === denied.id),
  }).toEqual({ keyOut: true, standing: [{ ...denied, legacy_time: true }], ended: false });
});

posix("r3 H2a: without a plan the previous identity's listed time is ignored like ordinary startup", () => {
  const foreignIdentity = loadRelayIdentity(dir()).server_id;
  const k = key();
  const startWithList = (withSibling: boolean) => {
    const active = dir();
    loadRelayIdentity(active);
    put(active, "account-devices.json", {
      v: 1, account, server_id: foreignIdentity, version: 1, snapshot: "1".repeat(32),
      devices: [{ id: accountDeviceId(foreignIdentity, k), key: k, no: 2, label: "Previous phone", confirmed_at: FUTURE,
        last_signin_day: null, origin: { from: "remote", how: "list", by: null, admit_no: 1, at: FUTURE }, state: "live", hold_until: null }],
    });
    const { devices } = start(active, withSibling ? dir() : undefined);
    return { closed: devices.failsClosed, reason: devices.accountError, rows: JSON.parse(bytes(active, "account-devices.json")).devices };
  };
  const normal = startWithList(false);
  expect(normal).toEqual({ closed: false, reason: null, rows: [] });
  expect(startWithList(true)).toEqual(normal);
});

posix("r3 H3c: a malformed plan for a provably foreign PC does not close this PC", () => {
  const [active, foreign] = [dir(), dir()];
  loadRelayIdentity(active);
  loadRelayIdentity(foreign);
  writeFileSync(join(foreign, "restamp.json"), "{broken", { mode: 0o600 });
  const normal = start(active);
  expect(normal.devices.accountError).toBeNull();
  normal.stop();
  const restarted = start(active, foreign);
  expect({ closed: restarted.devices.failsClosed, reason: restarted.devices.accountError }).toEqual({ closed: false, reason: null });
  expect(bytes(foreign, "restamp.json")).toBe("{broken");
});

posix.each([false, true])("r3 M2: a pending link gets the ordinary sibling binding verdict; after queue=%p", async queued => {
  const [active, sibling, control, controlSibling] = [dir(), dir(), dir(), dir()];
  const first = { ...row(), account };
  const bound = { v: 1, next_admit: 32, binding: { account, bind_id: "a".repeat(32) }, clears: [], first: { key: first.relay_public_key, list_key: null }, others_ever: true, gen: 0 };
  const unbound = { ...bound, binding: null, first: null };
  const pendingBinding = { ...bound, binding: { ...bound.binding, pending: true } };
  registry(control, { ...first, created_at: stamp(-HOUR) });
  put(control, "account-pc.json", pendingBinding);
  put(controlSibling, "account-pc.json", unbound);
  const ordinary = start(control, controlSibling);
  expect(ordinary.devices.accountError).toContain("binds it to no account");
  ordinary.stop();

  registry(active, first);
  put(active, "account-pc.json", bound);
  put(sibling, "account-pc.json", unbound);
  const running = start(active, sibling);
  const preview = await askRecovery(active, { act: "restamp" }) as { confirm?: string };
  expect(preview.confirm).toBeString();
  if (queued) {
    expect(await askRecovery(active, { act: "restamp", confirm: preview.confirm })).toMatchObject({ queued: true });
    running.stop();
  }
  put(active, "account-pc.json", pendingBinding);
  put(sibling, "account-pc.json", unbound);
  if (queued) {
    const before = bytes(active, "devices.json");
    expect(start(active, sibling).devices.accountError).toContain("binds it to no account");
    expect(bytes(active, "devices.json")).toBe(before);
    expect(pending(active)).toBe(true);
  } else {
    expect(await askRecovery(active, { act: "restamp", confirm: preview.confirm })).toMatchObject({ error: expect.stringContaining("binds it to no account") });
    expect(pending(active)).toBe(false);
  }
});

posix("r3 L9b: changing a folder's filesystem device number does not invalidate its approved repair", async () => {
  const [active, sibling] = [dir(), dir()];
  const first = row();
  for (const folder of [active, sibling]) registry(folder, first);
  const closed = start(active, sibling);
  await queue(active);
  closed.stop();
  const ids = [active, sibling].map(folder => {
    expect(statSync(join(folder, "restamp-folder-id.json")).mode & 0o777).toBe(0o600);
    return bytes(folder, "restamp-folder-id.json");
  });
  expect(ids.every(value => /^[0-9a-f]{32}$/.test(JSON.parse(value)))).toBe(true);
  expect(new Set(ids).size).toBe(2);
  const stat = fs.statSync;
  const fakeStat = ((...args: Parameters<typeof stat>) => {
    const result = stat(...args);
    if (result && (args[0] === active || args[0] === sibling)) {
      result.dev = typeof result.dev === "bigint" ? result.dev + 1n : result.dev + 1;
    }
    return result;
  }) as typeof stat;
  const hook = spyOn(fs, "statSync").mockImplementation(fakeStat);
  try {
    expect(start(active, sibling).devices.accountError).toBeNull();
    for (const folder of [active, sibling]) expect(registered(folder)[0]?.created_at).toBe(stamp(1));
    expect(existsSync(join(active, "restamp-done.json"))).toBe(true);
    expect([active, sibling].map(folder => bytes(folder, "restamp-folder-id.json"))).toEqual(ids);
  } finally { hook.mockRestore(); }
});

posix("r3 L9b: a changed relay identity does not inherit the folder's approved repair", async () => {
  const active = dir();
  loadRelayIdentity(active);
  registry(active, row());
  const closed = start(active);
  await queue(active);
  closed.stop();
  const before = bytes(active, "devices.json");
  rotateRelayIdentity(active);
  const restarted = start(active);
  expect(restarted.devices.accountError).toContain("relay identity changed");
  expect(bytes(active, "devices.json")).toBe(before);
  expect(pending(active)).toBe(true);
});

posix("without a plan, an unreadable sibling gates the registry, not the whole account, also on standalone restart", () => {
  const [active, sibling] = [dir(), dir()];
  writeFileSync(join(sibling, "devices.json"), "{broken", { mode: 0o600 });
  for (const candidate of [sibling, undefined]) {
    const running = start(active, candidate);
    expect({ registryGated: running.devices.gated, accountClosed: running.devices.failsClosed }).toEqual({ registryGated: true, accountClosed: false });
    running.stop();
  }
  expect(JSON.parse(bytes(active, "devices.json"))).toMatchObject({ placeholder: true, devices: [] });
});

posix("an approved restamp refuses an unreadable sibling registry without publishing a repair", async () => {
  const [active, sibling] = [dir(), dir()];
  registry(active, row());
  const running = start(active, sibling);
  await queue(active);
  running.stop();
  writeFileSync(join(sibling, "devices.json"), "{broken", { mode: 0o600 });
  const files = ["devices.json", "account-pc.json", "account-devices.json", "account-log.json", "account-removed.json",
    "account-tombstones.json", "account-tombstones.pending.json", "restamp.json", "restamp-participant.json",
    "restamp-rollback.json", "restamp-done.json", "restamp-refused.json"];
  const repairState = () => [active, sibling].flatMap(folder => files.map(file =>
    existsSync(join(folder, file)) ? bytes(folder, file) : null));
  const before = repairState();
  const refused = start(active, sibling);
  expect(refused.devices.failsClosed).toBe(true);
  expect(refused.devices.accountError).toContain(join(sibling, "devices.json"));
  expect(repairState()).toEqual(before);
  const refusals = DeviceJournal.open(active).entries().filter(entry => entry.how === "restamp refused");
  expect(refusals.map(entry => entry.label)).toEqual([expect.stringContaining(join(sibling, "devices.json"))]);
});

posix.each(["preview", "confirmation", "replay"] as const)(
  "restamp %s refuses two accounts that only disagree after the registries merge", async phase => {
    const [active, sibling] = [dir(), dir()];
    const future = row();
    registry(active, future);
    const running = start(active, sibling);
    const request = { act: "restamp" } as const;
    const introduceDifferentAccounts = () => {
      for (const folder of [active, sibling]) put(folder, "account-pc.json", { v: 1, next_admit: 32 });
      const a = { ...row(stamp(-HOUR), key(), other), account };
      const b = { ...row(stamp(-HOUR), key(), "d".repeat(16)), account: "other_account" };
      registry(active, future, a);
      registry(sibling, future, b);
    };
    const disagreement = expect.stringMatching(/devices name.*account/i);

    if (phase === "preview") {
      introduceDifferentAccounts();
      expect(await askRecovery(active, request)).toMatchObject({ error: disagreement });
      return;
    }
    const preview = await askRecovery(active, request);
    if (!isJsonObject(preview) || typeof preview.confirm !== "string") throw new Error("Expected a restamp preview");
    const confirm = { ...request, confirm: preview.confirm };
    if (phase === "confirmation") {
      introduceDifferentAccounts();
      expect(await askRecovery(active, confirm)).toMatchObject({ error: disagreement });
      expect(pending(active)).toBe(false);
      return;
    }
    expect(await askRecovery(active, confirm)).toMatchObject({ queued: true });
    running.stop();
    introduceDifferentAccounts();

    const restarted = start(active, sibling);
    expect(restarted.devices.accountError).toEqual(disagreement);
    expect(registered(active)[0]?.created_at).toBe(FUTURE);
    expect(existsSync(join(active, "restamp-done.json"))).toBe(false);
  },
);

posix.each([false, true])("restamp keeps the working phone when ordinary merge drops conflicting twins; imported copy became native=%p", async becameNative => {
  const [active, sibling] = [dir(), dir()];
  const phone = { ...row(), account };
  registry(active, phone);
  const closed = start(active, sibling);
  await queue(active);
  closed.stop();
  const twin = { ...row(stamp(-HOUR), key(), other), account: "other_account" };
  registry(active, phone, twin);
  // Only the conflict changes in the ordinary case. Replacing the imported copy
  // with the native phone also adds an own timestamp outside the approved plan.
  registry(sibling, ...(becameNative ? [phone] : registered(sibling)), { ...twin, relay_public_key: key() });

  const restarted = start(active, sibling);
  if (becameNative) {
    expect(restarted.devices.failsClosed).toBe(true);
    expect(existsSync(join(active, "restamp-refused.json"))).toBe(true);
    expect(registered(sibling).find(device => device.id === phone.id)?.created_at).toBe(FUTURE);
    return;
  }
  expect(restarted.devices.accountError).toBeNull();
  expect(restarted.devices.hasKey(phone.relay_public_key)).toBe(true);
  expect(registered(active).map(device => device.id)).toEqual([phone.id]);
});

posix("a promoted list row cannot close the clock gate on its working paired phone", () => {
  const [active, sibling] = [dir(), dir()];
  const { server_id } = loadRelayIdentity(active);
  const phone = { ...row(stamp(-HOUR)), account };
  registry(sibling, phone);
  put(active, "account-devices.json", {
    v: 1, account, server_id, version: 1, snapshot: "1".repeat(32),
    devices: [{ id: accountDeviceId(server_id, phone.relay_public_key), key: phone.relay_public_key, no: 2, label: "Phone",
      confirmed_at: FUTURE, last_signin_day: null, origin: { from: "remote", how: "list", by: null, admit_no: 1, at: FUTURE },
      state: "live", hold_until: null }],
  });

  const { devices } = start(active, sibling);
  expect(devices.accountError).toBeNull();
  expect(devices.hasKey(phone.relay_public_key)).toBe(true);
  expect(JSON.parse(bytes(active, "account-devices.json")).devices).toEqual([]);
});

posix("confirmation refuses a pending binding to a different account without writing the journal", async () => {
  const [active, sibling] = [dir(), dir()];
  const phone = { ...row(), account };
  registry(active, phone);
  start(active, sibling);
  const preview = await askRecovery(active, { act: "restamp" });
  if (!isJsonObject(preview) || typeof preview.confirm !== "string") throw new Error("Expected a restamp preview");
  put(sibling, "account-pc.json", { v: 1, next_admit: 32,
    binding: { account: "other_account", bind_id: "f".repeat(32), pending: true },
    first: { key: key(), list_key: null }, clears: [], others_ever: true, gen: 0 });
  const journal = join(active, "device-journal.json");
  const before = existsSync(journal) ? readFileSync(journal, "utf8") : null;

  expect(await askRecovery(active, { act: "restamp", confirm: preview.confirm })).toMatchObject({ error: expect.stringMatching(/pending.*bind/i) });
  expect(existsSync(journal) ? readFileSync(journal, "utf8") : null).toBe(before);
  expect(pending(active)).toBe(false);
});
