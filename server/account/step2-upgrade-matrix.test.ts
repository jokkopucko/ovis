import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountDeviceId, newRecordId, signAccountRecord, signSafetyRecord } from "../../shared/account-records.ts";
import { parseAccountDevicesFile } from "../../shared/account-snapshot.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { openRelayChannel } from "../../shared/relay-channel.ts";
import type { RelayDevice } from "../../shared/relay-device.ts";
import { ACCOUNT_OPENS_ALL_FEATURE } from "../../shared/relay-mux.ts";
import { createServer } from "../index.ts";
import { handleRequest } from "../dispatch.ts";
import { readDeviceRegistry } from "../devices.ts";
import { DirectCarrier } from "../relay/direct.ts";
import { relayIdentityPath, rotateRelayIdentity, savedServerId } from "../relay/identity.ts";
import { bounded, deferred, relayConnection, TestClock } from "../relay/test-helpers.ts";
import { ACCOUNT_DEVICES_FILE, STALE_READ_MS } from "./account-devices.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT, registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { ask, phone } from "./pairing.test-helpers.ts";
import { PcAccountState } from "./pc-binding.ts";
import { credentialStatus, hasReleaseFixtures, v057Fixture } from "./step2-upgrade-v057.test-helpers.ts";

const boots = ["online", "offline-first", "offline-second"] as const;
const folders = ["one", "two"] as const;
const clocks = ["normal", "ahead", "revoked-ahead-corrected", "corrected-between-upgrade-boots"] as const;
const histories = ["none", "saved-step2-off", "rollback-pair"] as const;
const denialRoutes = ["local-revoke", "token-revoke", "tailscale-revoke", "mailbox-not-me"] as const;
const denialCells = clocks.flatMap(clock => denialRoutes.map(route => [clock, route, "proof-present"] as const));
const proofCells = ["proof-later", "target-not-listed", "signer-not-older"] as const;
const clockOrderCells = ["behind", "equal", "plus-24h", "plus-24h-1ms", "ahead-signer", "ahead-unrelated"] as const;
const cells = boots.flatMap(boot => folders.flatMap(folder => clocks.flatMap(clock => histories.map(history =>
  [boot, folder, clock, history] as const))));
const day = 86_400_000;
const root = mkdtempSync(join(tmpdir(), "ovis-upgrade-matrix-"));
let startRelease: Awaited<ReturnType<typeof v057Fixture>>;
const available = hasReleaseFixtures();
beforeAll(async () => { if (available) startRelease = await v057Fixture(join(root, "release")); }, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function pairBrowser(app: ReturnType<typeof createServer>, label: string, now: number) {
  const { devices } = app.context.services;
  const paired = devices.pair(devices.startPairing(now).code, label, "drive", now);
  if (!paired) throw new Error(`v0.5.7 could not pair ${label}`);
  return paired;
}

const localPhone = (...args: Parameters<typeof pairBrowser>) => pairBrowser(...args).token;

test.skipIf(!available).each(["token", "tailscale", "device"] as const)("an unbound upgraded PC lets its %s owner reset its relay identity", async via => {
  const stateDir = mkdtempSync(join(root, "unbound-reset-"));
  const released = startRelease(stateDir);
  let token: string;
  try {
    token = localPhone(released, "Owner browser", Date.now());
    expect(await credentialStatus(released.port, token)).toBe(200);
  } finally { await released.stop(); }
  const old = rotateRelayIdentity(stateDir);
  const app = createServer({ stateDir, port: 0, hostname: "127.0.0.1", token: via === "token" ? "matrix-owner" : "",
    sidecar: false, tailscaleOwner: "owner@example.com", accountService: { url: "off" } });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = new Headers({ origin: base, "x-herdr-update": "1" });
    if (via === "token") headers.set("authorization", "Bearer matrix-owner");
    else {
      headers.set("x-forwarded-for", "100.64.0.9");
      if (via === "device") headers.set("authorization", `Device ${token}`);
      else headers.set("tailscale-user-login", "owner@example.com");
    }
    expect(await (await fetch(`${base}/api/health?scope=bridge`, { headers })).json()).toMatchObject({ auth: { via, role: "drive" } });
    expect((await fetch(`${base}/api/relay/reset-identity`, { method: "POST", headers })).status).toBe(200);
    expect(savedServerId(stateDir)).not.toBe(old.server_id);
  } finally { await app.stop(); }
});

test.skipIf(!available)("an unbound upgraded PC keeps its paired driving phone's revoke authority", async () => {
  const stateDir = mkdtempSync(join(root, "unbound-revoke-"));
  const released = startRelease(stateDir);
  const now = Date.now();
  const older = pairBrowser(released, "Older phone", now - 1000);
  expect(await credentialStatus(released.port, older.token)).toBe(200);
  const owner = pairBrowser(released, "Driving phone", now);
  try { expect(await credentialStatus(released.port, owner.token)).toBe(200); }
  finally { await released.stop(); }
  const app = createServer({ stateDir, port: 0, hostname: "127.0.0.1", token: "matrix-owner", sidecar: false, tailscaleOwner: null, accountService: { url: "off" } });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = { authorization: `Device ${owner.token}`, origin: base, "x-forwarded-for": "100.64.0.9", "x-herdr-machine": "1" };
    const list = await fetch(`${base}/api/devices`, { headers });
    expect(list.status).toBe(200);
    const body = await list.json() as { devices: { id: string; remote_revoke?: string }[]; revoke_all?: string };
    expect(body.revoke_all).toBeUndefined();
    expect(body.devices.find(row => row.id === older.device.id)).not.toHaveProperty("remote_revoke");
    expect((await fetch(`${base}/api/devices/${older.device.id}`, { method: "DELETE", headers })).status).toBe(204);
    expect(await credentialStatus(app.port, older.token)).toBe(401);
    expect((await fetch(`${base}/api/devices/revoke-all`, { method: "POST", headers })).status).toBe(200);
    expect(await credentialStatus(app.port, owner.token)).toBe(401);
  } finally { await app.stop(); }
});

test.skipIf(!available).each(cells)("boot=%s folders=%s clock=%s history=%s", async (boot, folder, clock, history) => {
  const stateDir = mkdtempSync(join(root, "cell-"));
  const active = join(stateDir, "active");
  const other = join(stateDir, "sibling");
  mkdirSync(active);
  if (folder === "two") mkdirSync(other);
  const service = new FakeAccountService();
  const identity = rotateRelayIdentity(active);
  const serverId = await registerSnapshotPc(service, { stateDir: active }, identity);
  const trusted = await phone();
  const revoked = await phone();
  const newcomer = await phone();
  service.registerDevice(ACCOUNT, trusted.spki, "Existing relay phone");
  const now = Date.now();
  const ahead = now + 2 * day;
  const cookies: Record<string, string> = {};
  let relayId: string;
  let revokedId: string | undefined;
  const old = startRelease(active);
  try {
    const { devices } = old.context.services;
    const paired = devices.pairRelay(devices.startPairing(now).code, "Existing relay phone", trusted.spki, now);
    if (!paired || !devices.linkAccountKey(paired.device.id, trusted.spki, trusted.spki, ACCOUNT)) throw new Error("v0.5.7 account link failed");
    relayId = paired.device.id;
    expect(devices.sessionRow(relayId)?.key).toBe(trusted.spki);
    cookies.original = localPhone(old, "Existing browser phone", clock === "ahead" ? ahead : now);
    if (clock === "revoked-ahead-corrected" || clock === "corrected-between-upgrade-boots") {
      const gone = devices.pairRelay(devices.startPairing(now).code, "Owner revoked", revoked.spki, now);
      if (!gone) throw new Error("v0.5.7 could not pair the second relay phone");
      revokedId = gone.device.id;
      expect(devices.sessionRow(revokedId)?.key).toBe(revoked.spki);
      const wall = spyOn(Date, "now").mockReturnValue(ahead);
      try {
        const base = `http://127.0.0.1:${old.port}`;
        const response = await fetch(`${base}/api/devices/${revokedId}`, { method: "DELETE", headers: {
          origin: base, "x-herdr-machine": "1", authorization: "Bearer matrix-owner",
        } });
        expect(response.status).toBe(204);
      } finally { wall.mockRestore(); }
      expect(devices.isTombstoned(revoked.spki)).toBe(true);
    }
    expect(await credentialStatus(old.port, cookies.original)).toBe(200);
  } finally { await old.stop(); }

  const start = (online: boolean) => createServer({
    port: 0, hostname: "127.0.0.1", stateDir: active, token: "matrix-owner", sidecar: false,
    tailscaleOwner: null, accountOpensAll: true, ...(folder === "two" ? { siblingStateDir: other } : {}),
    accountService: { url: "https://account.test", fetch: async request => {
      if (!online) throw new TypeError("matrix PC offline");
      return await service.fetch(request);
    } },
  });

  if (clock === "corrected-between-upgrade-boots") {
    const wall = spyOn(Date, "now").mockReturnValue(ahead);
    try {
      const first = start(false);
      try {
        expect(await credentialStatus(first.port, cookies.original!)).toBe(200);
        expect(first.context.services.devices.sessionRow(relayId)?.key).toBe(trusted.spki);
        expect(first.context.services.devices.isTombstoned(revoked.spki)).toBe(true);
      } finally { await first.stop(); }
    } finally { wall.mockRestore(); }
  }

  if (history === "saved-step2-off") {
    service.opensAll = true;
    const optedOut = start(true);
    try {
      if (clock === "normal") expect(await optedOut.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      service.opensAll = false;
      service.reportsStep2Off = true;
      await optedOut.context.services.accountMailbox.readSnapshot();
    } finally { await optedOut.stop(); }
    expect(PcAccountState.open(active).serviceStep2Off()).toBe(true);
  } else if (history === "rollback-pair") {
    const activating = start(false);
    await activating.stop();
    const rollback = startRelease(active);
    try {
      cookies.rollback = localPhone(rollback, "Phone paired during rollback", now + 1);
      for (const token of Object.values(cookies)) expect(await credentialStatus(rollback.port, token)).toBe(200);
    } finally { await rollback.stop(); }
  }

  if (boot === "offline-second") {
    const first = start(false);
    await first.stop();
  }
  service.registerDevice(ACCOUNT, newcomer.spki, "Eligible newcomer");
  service.opensAll = history !== "saved-step2-off";
  const upgraded = start(boot === "online");
  const closes: (() => void)[] = [];
  try {
    const { accountMailbox, devices } = upgraded.context.services;
    const shouldAdmit = boot === "online" && history !== "saved-step2-off";
    const reconciled = boot === "online" ? await accountMailbox.readSnapshot() : null;
    const credentials = Object.fromEntries(await Promise.all(Object.entries(cookies).map(async ([label, token]) =>
      [label, await credentialStatus(upgraded.port, token)])));
    let relayStatus: number | null = null;
    if (devices.sessionRow(relayId)?.key === trusted.spki) {
      const link = await relayConnection({ stateDir: active, app: upgraded, closes, close: () => {} }, { serverId });
      await link.auth({ id: relayId, keys: trusted.keys, publicKey: trusted.spki });
      relayStatus = (await ask(link, "/api/devices")).status;
    }
    const newcomerId = accountDeviceId(serverId, newcomer.spki);
    const accountFile = join(active, ACCOUNT_DEVICES_FILE);
    const savedNewcomer = () => existsSync(accountFile)
      ? parseAccountDevicesFile(JSON.parse(readFileSync(accountFile, "utf8"))).devices.find(row => row.id === newcomerId)
      : undefined;
    const beforeHold = savedNewcomer();
    const joinedBeforeExpiry = devices.sessionRow(newcomerId);
    const wall = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS + 1);
    let joinedAfterExpiry;
    try { joinedAfterExpiry = devices.sessionRow(newcomerId); } finally { wall.mockRestore(); }
    // Absence and a temporary hold are different. An eligible key is admitted only by a successful read.
    expect({
      credentials, relayStatus,
      unknownCookie: await credentialStatus(upgraded.port, "never-paired"),
      reconciliation: reconciled?.committed ?? false,
      newcomerBeforeExpiry: beforeHold?.state ?? null,
      hadHoldDeadline: beforeHold?.hold_until != null,
      joinedBeforeExpiry: joinedBeforeExpiry?.key ?? null,
      joinedAfterExpiry: joinedAfterExpiry?.key ?? null,
      newcomerAfterExpiry: savedNewcomer()?.state ?? null,
      revokedSession: revokedId === undefined ? null : devices.sessionRow(revokedId),
      tombstone: revokedId === undefined || devices.isTombstoned(revoked.spki),
    }, devices.accountError ?? undefined).toEqual({
      credentials: Object.fromEntries(Object.keys(cookies).map(label => [label, 200])),
      relayStatus: 200, unknownCookie: 401, reconciliation: shouldAdmit,
      newcomerBeforeExpiry: shouldAdmit ? "hold" : null, hadHoldDeadline: shouldAdmit,
      joinedBeforeExpiry: null, joinedAfterExpiry: shouldAdmit ? newcomer.spki : null,
      newcomerAfterExpiry: shouldAdmit ? "live" : null,
      revokedSession: null, tombstone: true,
    });
  } finally {
    for (const close of closes) close();
    await upgraded.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}, 20_000);

const siblingCells = (["A", "B"] as const).flatMap(first =>
  (["keep-both", "delete-since-merge"] as const).map(history => [first, history] as const));

test.skipIf(!available).each(siblingCells)("populated siblings first=%s history=%s", async (first, history) => {
  const stateDir = mkdtempSync(join(root, "siblings-"));
  const folders = { A: join(stateDir, "a"), B: join(stateDir, "b") };
  mkdirSync(folders.A);
  mkdirSync(folders.B);
  const identity = rotateRelayIdentity(folders.A);
  mkdirSync(join(folders.B, "relay"));
  copyFileSync(relayIdentityPath(folders.A), relayIdentityPath(folders.B));
  expect(savedServerId(folders.B)).toBe(identity.server_id);
  const owner = await phone();
  const now = Date.now();
  const pair = async (folder: "A" | "B") => {
    const app = startRelease(folders[folder]);
    try {
      if (folder === "A") {
        const { devices } = app.context.services;
        const signer = devices.pairRelay(devices.startPairing(now).code, "Account member", owner.spki, now);
        if (!signer || !devices.linkAccountKey(signer.device.id, owner.spki, owner.spki, ACCOUNT)) {
          throw new Error("v0.5.7 could not bind folder A");
        }
      }
      const credential = pairBrowser(app, `${folder}'s browser phone`, now);
      expect(await credentialStatus(app.port, credential.token)).toBe(200);
      return credential;
    } finally { await app.stop(); }
  };
  const credentials = { A: await pair("A"), B: await pair("B") };
  const second = first === "A" ? "B" : "A";
  const query = async (app: ReturnType<typeof createServer>) =>
    Promise.all([credentialStatus(app.port, credentials.A.token), credentialStatus(app.port, credentials.B.token)]);
  const startOld = (folder: "A" | "B") =>
    startRelease(folders[folder], { siblingStateDir: folders[folder === "A" ? "B" : "A"] });
  const initialize = startOld(first);
  try {
    expect(await query(initialize)).toEqual([200, 200]);
  } finally { await initialize.stop(); }
  for (const folder of [first, second] as const) {
    const baseline = startOld(folder);
    try { expect(await query(baseline)).toEqual([200, 200]); } finally { await baseline.stop(); }
  }
  if (history === "delete-since-merge") {
    const deleting = startRelease(folders[first]);
    const victim = credentials[second];
    try {
      expect(await credentialStatus(deleting.port, victim.token)).toBe(200);
      expect(deleting.context.services.devices.revoke(victim.device.id)).toBe(true);
      expect(await credentialStatus(deleting.port, victim.token)).toBe(401);
    } finally { await deleting.stop(); }
    // The last ordinary merge still lists the row; do not run a released merge again
    // before upgrading, since it would propagate the deletion and remove the stale twin.
    const stale = readDeviceRegistry(join(folders[second], "devices.json"));
    expect(stale.kind === "ok" && stale.devices.some(row => row.id === victim.device.id)).toBe(true);
  }
  const outcomes: number[][] = [];
  for (const folder of [first, second] as const) {
    const app = createServer({
      stateDir: folders[folder], siblingStateDir: folders[folder === "A" ? "B" : "A"],
      port: 0, hostname: "127.0.0.1", token: "matrix-owner", tailscaleOwner: null, sidecar: false,
      accountOpensAll: true, accountService: { url: "off" },
    });
    try { outcomes.push(await query(app)); } finally { await app.stop(); }
  }
  const expected = [
    history === "delete-since-merge" && second === "A" ? 401 : 200,
    history === "delete-since-merge" && second === "B" ? 401 : 200,
  ];
  expect(outcomes).toEqual([expected, expected]);
}, 20_000);

test.skipIf(!available).each(["several-boots", "fresh-then-stale", "configured-off"] as const)("outage history=%s", async history => {
  const stateDir = mkdtempSync(join(root, "outage-"));
  const service = new FakeAccountService();
  service.opensAll = true;
  const serverId = await registerSnapshotPc(service, { stateDir }, rotateRelayIdentity(stateDir));
  const member = await phone();
  const newcomer = await phone();
  service.registerDevice(ACCOUNT, member.spki, "Account member");
  service.registerDevice(ACCOUNT, newcomer.spki, "Eligible account-only phone");
  const newcomerId = accountDeviceId(serverId, newcomer.spki);
  const old = startRelease(stateDir);
  let cookie: string;
  try {
    const { devices } = old.context.services;
    const at = Date.now();
    const paired = devices.pairRelay(devices.startPairing(at).code, "Account member", member.spki, at);
    if (!paired || !devices.linkAccountKey(paired.device.id, member.spki, member.spki, ACCOUNT)) throw new Error("v0.5.7 did not bind");
    cookie = localPhone(old, "Existing browser phone", at);
    expect(await credentialStatus(old.port, cookie)).toBe(200);
  } finally { await old.stop(); }
  let available = history === "fresh-then-stale";
  const start = () => createServer({
    stateDir, port: 0, hostname: "127.0.0.1", token: "matrix-owner", tailscaleOwner: null, sidecar: false,
    accountOpensAll: true, accountService: history === "configured-off" ? { url: "off" } : {
      url: "https://account.test", fetch: request => available ? service.fetch(request) : Promise.reject(new TypeError("matrix PC offline")),
    },
  });
  if (history === "several-boots") {
    for (let boot = 0; boot < 2; boot++) {
      const app = start();
      try {
        expect(await credentialStatus(app.port, cookie)).toBe(200);
        expect(app.context.services.devices.sessionRow(newcomerId)).toBeNull();
        expect(existsSync(join(stateDir, ACCOUNT_DEVICES_FILE))).toBe(false);
      } finally { await app.stop(); }
    }
  }
  const app = start();
  const clock = new TestClock();
  const epoch = Date.now();
  const wall = spyOn(Date, "now").mockImplementation(() => epoch + clock.now());
  try {
    const { devices, accountMailbox } = app.context.services;
    devices.useClock(clock);
    expect(await credentialStatus(app.port, cookie)).toBe(200);
    if (history !== "fresh-then-stale") {
      expect(devices.sessionRow(newcomerId)).toBeNull();
      expect(existsSync(join(stateDir, ACCOUNT_DEVICES_FILE))).toBe(false);
    }
    if (history === "configured-off") return;
    available = true;
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    clock.advance(JOIN_HOLD_MS + 1);
    expect(devices.sessionRow(newcomerId)?.key).toBe(newcomer.spki);
    if (history === "fresh-then-stale") {
      available = false;
      expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: false });
      clock.advance(STALE_READ_MS);
      expect(devices.sessionRow(newcomerId)).toBeNull();
      expect(await credentialStatus(app.port, cookie)).toBe(200);
      available = true;
      expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      expect(devices.sessionRow(newcomerId)?.key).toBe(newcomer.spki);
    }
    expect(await credentialStatus(app.port, cookie)).toBe(200);
  } finally {
    wall.mockRestore();
    await app.stop();
  }
});

test.skipIf(!available).each(["release-default", "release-opt-in", "head-off-on", "rollback-after-read"] as const)(
  "install flag history=%s", async history => {
    const stateDir = mkdtempSync(join(root, "flags-"));
    const previous = process.env["OVIS_ACCOUNT_OPENS_ALL"];
    const setFlag = (value?: "0" | "1") => {
      if (value === undefined) delete process.env["OVIS_ACCOUNT_OPENS_ALL"];
      else process.env["OVIS_ACCOUNT_OPENS_ALL"] = value;
    };
    const service = new FakeAccountService();
    service.opensAll = true;
    const identity = rotateRelayIdentity(stateDir);
    await registerSnapshotPc(service, { stateDir }, identity);
    const owner = await phone();
    service.registerDevice(ACCOUNT, owner.spki, "Account member");
    const start = () => createServer({
      stateDir, port: 0, hostname: "127.0.0.1", token: "matrix-owner", tailscaleOwner: null, sidecar: false,
      accountService: { url: "https://account.test", fetch: service.fetch },
    });
    try {
      setFlag(history === "release-opt-in" ? "1" : undefined);
      const released = startRelease(stateDir, {
        accountOpensAll: undefined,
        ...(history === "release-opt-in" ? { accountService: { url: "https://account.test", fetch: service.fetch } } : {}),
      });
      let surviving: string;
      let other: ReturnType<typeof pairBrowser>;
      try {
        const { devices } = released.context.services;
        expect(devices.opensAll()).toBe(history === "release-opt-in");
        const at = Date.now();
        const member = devices.pairRelay(devices.startPairing(at).code, "Account member", owner.spki, at);
        if (!member || !devices.linkAccountKey(member.device.id, owner.spki, owner.spki, ACCOUNT)) throw new Error("v0.5.7 did not bind");
        surviving = localPhone(released, "Existing browser phone", at);
        other = pairBrowser(released, "Another browser phone", at);
        if (history === "release-opt-in") {
          expect(await released.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
        }
        expect(await credentialStatus(released.port, surviving)).toBe(200);
        expect(await credentialStatus(released.port, other.token)).toBe(200);
      } finally { await released.stop(); }
      setFlag();
      let offOrRollback: string | undefined;
      if (history === "head-off-on" || history === "rollback-after-read") {
        const online = start();
        try {
          expect(online.context.services.devices.opensAll()).toBe(true);
          expect(await online.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
          expect(await credentialStatus(online.port, surviving)).toBe(200);
        } finally { await online.stop(); }
        if (history === "head-off-on") setFlag("0");
        const off = history === "head-off-on" ? start() : startRelease(stateDir, { accountOpensAll: undefined });
        try {
          expect(off.context.services.devices.opensAll()).toBe(false);
          expect(await credentialStatus(off.port, surviving)).toBe(200);
          offOrRollback = localPhone(off, "Paired while Step 2 is off", Date.now());
          expect(await credentialStatus(off.port, offOrRollback)).toBe(200);
          expect(off.context.services.devices.revoke(other.device.id)).toBe(true);
          expect(await credentialStatus(off.port, other.token)).toBe(401);
        } finally { await off.stop(); }
      }
      setFlag();
      const final = start();
      try {
        expect(final.context.services.devices.opensAll()).toBe(true);
        expect(await final.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
        expect(await credentialStatus(final.port, surviving)).toBe(200);
        expect(await credentialStatus(final.port, other.token)).toBe(offOrRollback === undefined ? 200 : 401);
        if (offOrRollback !== undefined) expect(await credentialStatus(final.port, offOrRollback)).toBe(200);
      } finally { await final.stop(); }
    } finally {
      if (previous === undefined) setFlag();
      else process.env["OVIS_ACCOUNT_OPENS_ALL"] = previous;
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 15_000,
);

const provenanceCells = [
  ["unlinked", "relay", false], ["unlinked", "direct", true],
  ["same-key", "relay", true], ["same-key", "direct", false],
  ["moved-key", "relay", false], ["moved-key", "direct", true],
  ["signed-add", "relay", true], ["signed-add", "direct", false],
  ["watch", "relay", false], ["watch", "direct", true],
] as const;

const bindingCells = (["never-bound", "named-empty", "last-member-revoked", "member-bound", "service-bound"] as const)
  .flatMap(binding => (["ordinary-403", "not-listed-403"] as const).map(refusal => [binding, refusal] as const));

test.skipIf(!available).each(bindingCells)("PC binding history=%s snapshot=%s", async (binding, refusal) => {
  const stateDir = mkdtempSync(join(root, "binding-"));
  const service = new FakeAccountService();
  service.opensAll = true;
  const serverId = await registerSnapshotPc(service, { stateDir }, rotateRelayIdentity(stateDir));
  const newer = await phone();
  service.registerDevice(ACCOUNT, newer.spki, "Eligible newcomer");
  const needsMember = binding === "last-member-revoked" || binding === "member-bound";
  const old = startRelease(stateDir);
  let credential: string;
  try {
    credential = localPhone(old, "Existing browser phone", Date.now());
    expect(await credentialStatus(old.port, credential)).toBe(200);
    if (needsMember) {
      const { devices } = old.context.services;
      const key = await phone();
      const paired = devices.pairRelay(devices.startPairing().code, "Member", key.spki);
      if (!paired || !devices.linkAccountKey(paired.device.id, key.spki, key.spki, ACCOUNT)) throw new Error("v0.5.7 did not bind");
      if (binding === "last-member-revoked") expect(devices.revoke(paired.device.id)).toBe(true);
    }
  } finally { await old.stop(); }
  let online = true;
  let reads = 0;
  const start = () => createServer({
    stateDir, port: 0, hostname: "127.0.0.1", token: "matrix-owner", sidecar: false, tailscaleOwner: null,
    accountOpensAll: true, accountService: { url: "https://account.test", fetch: async request => {
      if (!online) throw new TypeError("matrix PC offline");
      if (new URL(request.url).pathname === "/v1/pc/snapshot") {
        reads++;
        return Response.json({ error: { code: refusal === "not-listed-403" ? "not_listed" : "forbidden", message: refusal } }, { status: 403 });
      }
      return service.fetch(request);
    } },
  });
  if (binding === "service-bound") {
    const pc = PcAccountState.open(stateDir);
    pc.migrate(null, true);
    pc.bindByService(ACCOUNT);
  }
  const newcomerId = accountDeviceId(serverId, newer.spki);
  const previous = binding === "member-bound" || binding === "service-bound" ? ACCOUNT : null;
  const expected = binding === "service-bound" && refusal === "not-listed-403" ? null : previous;
  const app = start();
  try {
    const { devices, accountMailbox } = app.context.services;
    if (binding === "named-empty") devices.startPairing(Date.now(), { remote: false, startedBy: null, memberRequired: false, account: ACCOUNT });
    expect(devices.account()).toBe(previous);
    expect((await accountMailbox.readSnapshot())?.committed ?? false).toBe(false);
    expect(reads > 0).toBe(previous !== null);
    expect(devices.account()).toBe(expected);
    expect(await credentialStatus(app.port, credential)).toBe(200);
  } finally { await app.stop(); }
  online = false;
  const restarted = start();
  try {
    const { devices } = restarted.context.services;
    expect(devices.account()).toBe(expected);
    expect(await credentialStatus(restarted.port, credential)).toBe(200);
    expect(devices.sessionRow(newcomerId)).toBeNull();
    expect(existsSync(join(stateDir, ACCOUNT_DEVICES_FILE))).toBe(false);
  } finally {
    await restarted.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test.skipIf(!available).each(provenanceCells)("credential provenance=%s carrier=%s negotiation=%s", async (provenance, carrier, negotiating) => {
  const stateDir = mkdtempSync(join(root, "provenance-"));
  const identity = rotateRelayIdentity(stateDir);
  const owner = await phone();
  const original = await phone();
  const current = provenance === "moved-key" ? await phone() : original;
  const role = provenance === "watch" ? "watch" : "drive";
  const member = provenance === "same-key" || provenance === "moved-key" || provenance === "signed-add";
  const credentials = (id: string) => ({ id, keys: current.keys, publicKey: current.spki });
  const check = async (app: ReturnType<typeof createServer>, id: string, released: boolean) => {
    if (carrier === "relay") {
      const closes: (() => void)[] = [];
      try {
        const link = await relayConnection({ stateDir, app, closes, close: () => {} }, {
          serverId: identity.server_id,
        }, released ? startRelease.RelaySession : undefined);
        expect((await link.auth(credentials(id), negotiating ? [ACCOUNT_OPENS_ALL_FEATURE] : [])).role).toBe(role);
        expect((await ask(link, "/api/devices")).status).toBe(200);
        if (role === "watch") expect((await ask(link, "/api/preferences", { method: "PUT", body: { settings: {} } })).status).toBe(403);
      } finally { for (const close of closes) close(); }
      return;
    }
    const Carrier = released ? startRelease.DirectCarrier : DirectCarrier;
    const direct = new Carrier({ identity, services: app.context.services, port: app.port,
      addresses: () => ["127.0.0.1"], preferredPort: 0, peerAllowed: () => true });
    await direct.start();
    try {
      const offer = { v: 1 as const, server_id: identity.server_id, server_public_key: identity.public_key, relay: "wss://relay.example.test" };
      let saved: RelayDevice | undefined = { ...offer, device_id: id, private_key: current.keys.privateKey,
        public_spki: current.spki, label: "Test phone" };
      const channel = await bounded(openRelayChannel(offer, {
        // The old release does not negotiate Step 2 unless the account has opted in.
        accountOpensAll: negotiating && !released,
        store: { get: async () => saved, update: async (_id, change) => (saved = change(saved)),
          list: async () => saved ? [saved] : [], remove: async () => { saved = undefined; } },
        socket: () => new WebSocket(`ws://127.0.0.1:${direct.port}/v1/ws?v=1`),
      }));
      try {
        expect(channel.role).toBe(role);
        const request = (target: string, method: "GET" | "PUT") => {
          const response = deferred<number>();
          const stream = channel.mux.openHttp({ target, method, headers: [], body: "none" });
          stream.onHeaders = ({ status }) => { if (status >= 200) response.resolve(status); };
          stream.onDispose = error => { if (error) response.reject(error); };
          return bounded(response.promise);
        };
        expect(await request("/api/devices", "GET")).toBe(200);
        if (role === "watch") expect(await request("/api/preferences", "PUT")).toBe(403);
      } finally { channel.close(); }
    } finally { await direct.stop(); }
  };
  try {
    const release = startRelease(stateDir);
    let id: string;
    try {
      const { devices } = release.context.services;
      const at = Date.now();
      const bound = devices.pairRelay(devices.startPairing(at).code, "Account member", owner.spki, at);
      if (!bound || !devices.linkAccountKey(bound.device.id, owner.spki, owner.spki, ACCOUNT)) throw new Error("v0.5.7 did not bind");
      if (provenance === "signed-add") {
        const addition = await signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key: current.spki, signer: owner.spki,
          role, label: "Signed add", issued_at: new Date(at).toISOString(), id: newRecordId() }, owner.keys.privateKey);
        expect(await startRelease.applyAccountRecords(devices, [addition], identity.server_id)).toMatchObject([{ outcome: "applied" }]);
        id = accountDeviceId(identity.server_id, current.spki);
      } else {
        const row = devices.pairRelay(devices.startPairing(at).code, "Test phone", original.spki, at);
        if (!row) throw new Error("v0.5.7 did not pair the test phone");
        id = row.device.id;
        if (member && !devices.linkAccountKey(id, original.spki, current.spki, ACCOUNT)) throw new Error("v0.5.7 did not link the test phone");
        if (role === "watch") devices.update(id, { role });
      }
      await check(release, id, true);
      expect(devices.isMemberOf(id, ACCOUNT)).toBe(member);
    } finally { await release.stop(); }
    const upgraded = createServer({ stateDir, port: 0, hostname: "127.0.0.1", token: "matrix-owner",
      accountOpensAll: true, tailscaleOwner: null, sidecar: false, accountService: { url: "off" } });
    try {
      await check(upgraded, id, false);
      const { devices } = upgraded.context.services;
      expect(devices.isMemberOf(id, ACCOUNT)).toBe(member);
      expect(devices.isAccountApproverSession(id, current.spki)).toBe(false);
    } finally { await upgraded.stop(); }
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
}, 15_000);

test.skipIf(!available).each([
  ...denialCells,
  ...proofCells.map(proof => ["ahead", "mailbox-not-me", proof] as const),
  ...clockOrderCells.map(clock => [clock, "mailbox-not-me", "proof-present"] as const),
])(
  "denial clock=%s route=%s service-order=%s", async (clock, route, proof) => {
    const stateDir = mkdtempSync(join(root, "deny-"));
    const service = new FakeAccountService();
    service.opensAll = true;
    const serverId = await registerSnapshotPc(service, { stateDir }, rotateRelayIdentity(stateDir));
    const owner = await phone();
    const victim = await phone();
    const now = Date.now();
    const ahead = now + 2 * day;
    const signerAt = clock === "ahead-signer" ? ahead : now - 3_000;
    const affectedAt = clock === "ahead" ? ahead
      : clock === "behind" ? now - day
        : clock === "equal" ? signerAt
          : clock === "plus-24h" ? now + day
            : clock === "plus-24h-1ms" ? now + day + 1 : now - 2_000;
    const noDeny = proof === "signer-not-older" || proof === "target-not-listed"
      || clock === "ahead-signer" || clock === "equal" || clock === "behind";
    const mailbox = route === "mailbox-not-me";
    const release = startRelease(stateDir);
    const oldDevices = release.context.services.devices;
    const pairMember = (label: string, key: string, at: number) => {
      const paired = oldDevices.pairRelay(oldDevices.startPairing(at).code, label, key, at);
      if (!paired || !oldDevices.linkAccountKey(paired.device.id, key, key, ACCOUNT)) throw new Error(`Could not link ${label} in v0.5.7`);
      return paired.device.id;
    };
    let signerId: string;
    let targetId: string;
    let targetCookie: string | undefined;
    let unrelated: string;
    let newerUnrelated: string | undefined;
    try {
      signerId = pairMember("Drive signer", owner.spki, signerAt);
      if (mailbox) {
        targetId = pairMember("Not me target", victim.spki, affectedAt);
        expect(oldDevices.sessionRow(targetId)?.key).toBe(victim.spki);
      } else {
        const paired = pairBrowser(release, "Revoke target", affectedAt);
        targetId = paired.device.id;
        targetCookie = paired.token;
        expect(await credentialStatus(release.port, targetCookie)).toBe(200);
      }
      unrelated = localPhone(release, "Untouched legacy phone", clock === "ahead-unrelated" ? ahead : now - 4_000);
      expect(await credentialStatus(release.port, unrelated)).toBe(200);
      if (mailbox && (clock === "ahead" || clock === "plus-24h-1ms")) {
        newerUnrelated = localPhone(release, "Untouched newer legacy phone", now - 1_000);
        expect(await credentialStatus(release.port, newerUnrelated)).toBe(200);
      }
      if (clock === "revoked-ahead-corrected" || clock === "corrected-between-upgrade-boots") {
        const gone = await phone();
        const id = pairMember("Previously revoked phone", gone.spki, now - 500);
        const wall = spyOn(Date, "now").mockReturnValue(ahead);
        try { expect(oldDevices.revoke(id)).toBe(true); } finally { wall.mockRestore(); }
        expect(oldDevices.isTombstoned(gone.spki)).toBe(true);
      }
    } finally { await release.stop(); }

    const olderNo = proof === "signer-not-older" ? 2 : 1;
    const targetNo = proof === "signer-not-older" ? 1 : 2;
    if (olderNo === 2) service.registerDevice(ACCOUNT, victim.spki, "Not me target");
    expect(service.registerDevice(ACCOUNT, owner.spki, "Older drive signer")).toBe(olderNo);
    if (mailbox && olderNo === 1 && proof !== "target-not-listed") {
      expect(service.registerDevice(ACCOUNT, victim.spki, "Not me target")).toBe(targetNo);
    }
    const record = mailbox ? await signSafetyRecord({
      v: 1, kind: "block", account: ACCOUNT, signer: owner.spki, signer_no: olderNo,
      target: victim.spki, target_no: targetNo, nonce: newRecordId(), signed_at: new Date(now).toISOString(),
    }, owner.keys.privateKey) : null;
    const stagedAdd = proof === "proof-later" ? await signAccountRecord({
      v: 1, kind: "add", account: ACCOUNT, key: victim.spki, signer: owner.spki, label: "Same target add",
      role: "drive", issued_at: new Date(now).toISOString(), id: newRecordId(),
    }, owner.keys.privateKey) : null;
    let reachable = false;
    let offered = false;
    let acknowledged = false;
    let snapshotAvailable = proof !== "proof-later";
    const start = () => createServer({
      stateDir, port: 0, hostname: "127.0.0.1", token: route === "tailscale-revoke" ? "" : "matrix-owner",
      tailscaleOwner: null, sidecar: false, accountOpensAll: true,
      accountService: { url: "https://account.test", fetch: async request => {
        if (!reachable) throw new TypeError("matrix PC offline");
        const pathname = new URL(request.url).pathname;
        if (pathname === "/v1/pc/snapshot" && !snapshotAvailable) return new Response(null, { status: 503 });
        if (pathname !== "/v1/pc/mailbox" || !offered) return service.fetch(request);
        const requestBody = await request.clone().json() as { ack?: number | null };
        const response = await service.fetch(request);
        if (!response.ok) return response;
        if ((requestBody.ack ?? 0) >= 1) acknowledged = true;
        const payload: object = await response.json();
        return Response.json({ ...payload, records: acknowledged ? [] : [
          { seq: 1, record }, ...(stagedAdd ? [{ seq: 2, record: stagedAdd }] : []),
        ] });
      } },
    });
    if (clock === "corrected-between-upgrade-boots") {
      const wall = spyOn(Date, "now").mockReturnValue(ahead);
      try { await start().stop(); } finally { wall.mockRestore(); }
    }
    const boundary = clock === "plus-24h" || clock === "plus-24h-1ms"
      ? spyOn(Date, "now").mockReturnValue(now)
      : null;
    let app;
    try { app = start(); } finally { boundary?.mockRestore(); }
    const closes: (() => void)[] = [];
    const link = () => relayConnection({ stateDir, app, closes, close: () => {} }, { serverId });
    const target = { id: targetId, publicKey: victim.spki, keys: victim.keys };
    try {
      expect(await credentialStatus(app.port, unrelated)).toBe(200);
      if (newerUnrelated) expect(await credentialStatus(app.port, newerUnrelated)).toBe(200);
      const { devices, accountMailbox, safetyLog } = app.context.services;
      await accountMailbox.pull();
      reachable = true;
      if (proof !== "proof-later") expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      const signerLink = await link();
      await signerLink.auth({ id: signerId, publicKey: owner.spki, keys: owner.keys });
      expect((await ask(signerLink, "/api/devices")).status).toBe(200);
      if (mailbox && record) {
        const live = await link();
        await live.auth(target);
        expect((await ask(live, "/api/devices")).status).toBe(200);
        offered = true;
        await accountMailbox.pull();
        const pending = () => safetyLog?.waitingBlocks().map(item => item.record) ?? [];
        if (proof === "proof-later") {
          expect(pending()).toContainEqual(record);
          expect(devices.isTombstoned(victim.spki)).toBe(false);
          expect((await ask(live, "/api/devices")).status).toBe(200);
          expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: false });
          snapshotAvailable = true;
          expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
          expect(devices.sessionRow(accountDeviceId(serverId, victim.spki))).toBeNull();
        }
        if (noDeny) {
          expect(devices.isTombstoned(victim.spki)).toBe(false);
          expect((await ask(live, "/api/devices")).status).toBe(200);
          if (proof === "target-not-listed") {
            expect(pending()).toContainEqual(record);
            const status = await fetch(`http://127.0.0.1:${app.port}/api/devices`, {
              headers: { authorization: "Bearer matrix-owner" },
            });
            expect(status.status).toBe(200);
            const { devices: shown } = await status.json() as { devices: { id: string; not_me_waiting?: true }[] };
            expect(shown.filter(row => row.not_me_waiting).map(row => row.id)).toEqual([targetId]);
          }
          expect(await credentialStatus(app.port, unrelated)).toBe(200);
          if (newerUnrelated) expect(await credentialStatus(app.port, newerUnrelated)).toBe(200);
          return;
        }
        expect(safetyLog?.receipt(record.id)?.outcome).toBe("applied");
        expect(devices.isTombstoned(victim.spki)).toBe(true);
        expect(pending()).not.toContainEqual(record);
        expect(acknowledged).toBe(true);
        await live.closed;
        const fresh = await link();
        await expect(fresh.auth(target)).rejects.toThrow();
      } else {
        if (!targetCookie) throw new Error("Expected the release's browser credential");
        expect(await credentialStatus(app.port, targetCookie)).toBe(200);
        const base = `http://127.0.0.1:${app.port}`;
        const headers: Record<string, string> = { origin: base, "x-herdr-machine": "1" };
        if (route === "tailscale-revoke") headers["tailscale-user-login"] = "owner@example.test";
        else headers["authorization"] = "Bearer matrix-owner";
        if (route !== "local-revoke") headers["x-forwarded-for"] = "100.64.0.9";
        const request = new Request(`${base}/api/devices/${targetId}`, { method: "DELETE", headers });
        const result = await handleRequest(request, {
          ...app.context, requestIP: () => ({ address: "127.0.0.1" }), timeout: () => {},
          services: { ...app.context.services,
            identityOf: async () => ({ owner: "owner@example.test", soleLogin: null, dnsName: null, tailnetIp: null, tagged: false }),
          },
        });
        expect(result?.status).toBe(204);
        expect(await credentialStatus(app.port, targetCookie)).toBe(401);
      }
      expect((await ask(signerLink, "/api/devices")).status).toBe(200);
      // A normal ordered Not me still freezes unordered keys; this control is distinct
      // from the target-only exception tested with a quarantined target.
      expect(await credentialStatus(app.port, unrelated)).toBe(clock === "ahead-unrelated" ? 401 : 200);
      if (newerUnrelated) expect(await credentialStatus(app.port, newerUnrelated)).toBe(200);
    } finally {
      for (const close of closes) close();
      await app.stop();
    }
    reachable = false;
    const reopened = start();
    try {
      expect(await credentialStatus(reopened.port, unrelated)).toBe(clock === "ahead-unrelated" ? 401 : 200);
      if (newerUnrelated) expect(await credentialStatus(reopened.port, newerUnrelated)).toBe(200);
      if (targetCookie) expect(await credentialStatus(reopened.port, targetCookie)).toBe(401);
      else {
        expect(reopened.context.services.devices.isTombstoned(victim.spki)).toBe(true);
        expect(reopened.context.services.devices.sessionRow(targetId)).toBeNull();
      }
      expect(reopened.context.services.devices.sessionRow(signerId)?.key).toBe(owner.spki);
    } finally {
      await reopened.stop();
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 12_000,
);
