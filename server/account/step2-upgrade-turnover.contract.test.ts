import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { leaveAccount } from "../../src/lib/account/leave.ts";
import { AccountService } from "../../src/lib/account/service.ts";
import { beginSignIn, finishOwnSignIn } from "../../src/lib/account/signin.ts";
import type { RelayDevice, ShellDeviceStore } from "../../src/lib/relay/device.ts";
import { memoryAccountStore } from "../../src/lib/account/store.ts";
import { createServer } from "../index.ts";
import { readDeviceRegistry } from "../devices.ts";
import { relayIdentityPath, rotateRelayIdentity, savedServerId, type RelayIdentity } from "../relay/identity.ts";
import { relayConnection } from "../relay/test-helpers.ts";
import { ACCOUNT, registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { ask } from "./pairing.test-helpers.ts";
import { PcAccountState } from "./pc-binding.ts";
import { credentialStatus, hasReleaseFixtures, v057Fixture } from "./step2-upgrade-v057.test-helpers.ts";

const root = mkdtempSync(join(tmpdir(), "upgrade-turnover-"));
const available = hasReleaseFixtures();
let release: Awaited<ReturnType<typeof v057Fixture>>;
beforeAll(async () => { if (available) release = await v057Fixture(join(root, "release")); }, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const SERVICE = "https://account.test";

async function listPc(service: FakeAccountService, account: string, identity: RelayIdentity) {
  const token = service.issueToken(account, { twoStep: true });
  const call = (path: string, method: string, body: unknown) => service.fetch(new Request(`${SERVICE}${path}`, {
    method, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  expect((await call(`/v1/pcs/${identity.server_id}`, "PUT", { label: "PC",
    public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" })).ok).toBe(true);
  return call;
}

async function releasedPc(browserOnlySibling = false) {
  const stateDir = mkdtempSync(join(root, "pc-"));
  const folders = { a: join(stateDir, "a"), b: join(stateDir, "b") };
  mkdirSync(folders.a);
  mkdirSync(join(folders.b, "relay"), { recursive: true });
  const identity = rotateRelayIdentity(folders.a);
  if (!browserOnlySibling) copyFileSync(relayIdentityPath(folders.a), relayIdentityPath(folders.b));
  const service = new FakeAccountService();
  service.opensAll = true;
  await registerSnapshotPc(service, { stateDir: folders.a }, identity);
  const accountStore = memoryAccountStore();
  const key = await accountStore.key();
  service.registerDevice(ACCOUNT, key.public_spki, "Account phone");
  const cookies: string[] = [];
  let deleted: { id: string; token: string } | undefined;
  let importedId = "";
  let memberId = "";
  for (const folder of ["a", "b"] as const) {
    const old = release(folders[folder]);
    try {
      const { devices } = old.context.services;
      if (folder === "a") {
        const paired = devices.pairRelay(devices.startPairing().code, "Account phone", key.public_spki);
        if (!paired || !devices.linkAccountKey(paired.device.id, key.public_spki, key.public_spki, ACCOUNT)) throw new Error("Release link failed");
        memberId = paired.device.id;
      }
      const browser = devices.pair(devices.startPairing().code, `Browser ${folder}`, "drive");
      if (!browser) throw new Error("Release browser pairing failed");
      expect(await credentialStatus(old.port, browser.token)).toBe(200);
      cookies.push(browser.token);
      if (folder === "b") {
        importedId = browser.device.id;
        if (browserOnlySibling) {
          const other = devices.pair(devices.startPairing().code, "Browser to revoke", "drive");
          if (!other) throw new Error("Release failed to pair second sibling browser");
          expect(await credentialStatus(old.port, other.token)).toBe(200);
          deleted = { id: other.device.id, token: other.token };
        }
      }
    } finally { await old.stop(); }
  }
  const merged = release(folders.a, { siblingStateDir: folders.b });
  try { for (const cookie of cookies) expect(await credentialStatus(merged.port, cookie)).toBe(200); }
  finally { await merged.stop(); }
  let online = true;
  const start = () => createServer({ stateDir: folders.a, siblingStateDir: folders.b, port: 0, hostname: "127.0.0.1",
    token: "matrix-owner", tailscaleOwner: null, sidecar: false, accountOpensAll: true,
    accountService: { url: SERVICE, fetch: request => online ? service.fetch(request) : Promise.reject(new TypeError("offline")) } });
  return { folders, identity, service, accountStore, key, cookies, memberId, importedId, deleted, start, offline: () => { online = false; } };
}

async function memberStatus(pc: Awaited<ReturnType<typeof releasedPc>>, app: ReturnType<typeof createServer>, serverId: string) {
  const closes: (() => void)[] = [];
  try {
    const link = await relayConnection({ stateDir: pc.folders.a, app, closes, close: () => {} }, { serverId });
    return await link.auth({ id: pc.memberId, keys: { privateKey: pc.key.private_key } as CryptoKeyPair, publicKey: pc.key.public_spki })
      .then(async () => (await ask(link, "/api/devices")).status, () => 401);
  } finally { for (const close of closes) close(); }
}

test.skipIf(!available).each(["sign-out", "leave"] as const)("released phone account %s keeps exactly what the user chose", async action => {
  const pc = await releasedPc();
  const app = pc.start();
  try {
    const { accountMailbox } = app.context.services;
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(await memberStatus(pc, app, pc.identity.server_id)).toBe(200);
    await pc.accountStore.set("session", { service: SERVICE, account: ACCOUNT, provider: "github",
      access_token: pc.service.issueToken(ACCOUNT), refresh_token: "r", expires_at: Date.now() + 3_600_000 });
    const account = new AccountService({ store: pc.accountStore, fetch: pc.service.fetch });
    const saved = new Map<string, RelayDevice>([[pc.identity.server_id, { server_id: pc.identity.server_id,
      server_public_key: pc.identity.public_key, relay: "wss://relay.ovis.sh", device_id: pc.memberId,
      private_key: pc.key.private_key, public_spki: pc.key.public_spki, label: "Account phone", account: ACCOUNT }]]);
    const phone: ShellDeviceStore = {
      get: async id => saved.get(id), list: async () => [...saved.values()], remove: async id => { saved.delete(id); },
      removeRow: async (id, deviceId) => saved.get(id)?.device_id === deviceId && saved.delete(id),
      update: async (id, change) => { const next = change(saved.get(id)); saved.set(id, next); return next; },
    };
    if (action === "sign-out") await account.signOut();
    else {
      const session = await account.session();
      if (!session) throw new Error("Missing account session");
      expect((await leaveAccount({ service: account, accountStore: pc.accountStore, relayStore: phone, session })).unconfirmed).toEqual([]);
    }
    await accountMailbox.pull();
    expect(await memberStatus(pc, app, pc.identity.server_id)).toBe(action === "leave" ? 401 : 200);
    for (const cookie of pc.cookies) expect(await credentialStatus(app.port, cookie)).toBe(200);
  } finally { await app.stop(); }
  pc.offline();
  const restarted = pc.start();
  try {
    expect(await memberStatus(pc, restarted, pc.identity.server_id)).toBe(action === "leave" ? 401 : 200);
    for (const cookie of pc.cookies) expect(await credentialStatus(restarted.port, cookie)).toBe(200);
  } finally {
    await restarted.stop();
    rmSync(pc.folders.a, { recursive: true, force: true });
  }
}, 20_000);

test.skipIf(!available).each([ACCOUNT, "acct_other"] as const)("PC browser signs out and back into %s without rebinding its PC", async next => {
  const pc = await releasedPc();
  const app = pc.start();
  const binding = PcAccountState.open(pc.folders.a).binding();
  const pcAccount = async (port: number) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/account/status`, { headers: { authorization: "Bearer matrix-owner" } });
    expect(response.status).toBe(200);
    return (await response.json() as { account: string | null }).account;
  };
  try {
    const browserStore = memoryAccountStore();
    const client = new AccountService({ store: browserStore, fetch: pc.service.fetch });
    const redirectUri = `http://127.0.0.1:${app.port}/callback`;
    const signIn = async (account: string) => {
      pc.service.signInAs("github", account);
      const started = await beginSignIn("github", { store: browserStore, service: SERVICE, redirectUri });
      const location = (await pc.service.fetch(started)).headers.get("location");
      if (!location) throw new Error("No return to the PC browser");
      const back = new URL(location);
      expect(back.origin + back.pathname).toBe(redirectUri);
      return finishOwnSignIn(started, back.search, { store: browserStore, fetch: pc.service.fetch });
    };
    const origin = new URL(redirectUri).origin;
    const post = (path: string, account: string) => fetch(origin + path, { method: "POST", headers: {
      origin, authorization: "Bearer matrix-owner", "content-type": "application/json", "x-herdr-machine": "1",
    }, body: JSON.stringify({ account }) });
    expect(binding?.account).toBe(ACCOUNT);
    expect((await signIn(ACCOUNT)).account).toBe(ACCOUNT);
    expect((await post("/api/account/relay-account", ACCOUNT)).status).toBe(204);
    expect(await pcAccount(app.port)).toBe(ACCOUNT);
    await client.signOut();
    expect(await client.session()).toBeUndefined();
    expect(await pcAccount(app.port)).toBe(ACCOUNT);
    expect((await signIn(next)).account).toBe(next);
    expect((await client.session())?.account).toBe(next);
    expect((await post("/api/account/relay-account", next)).status).toBe(204);
    const press = await post("/api/account/one-press", next);
    expect(press.status).toBe(409);
    expect(await press.json()).toMatchObject({ error: { code: "in_account" } });
    expect(await app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(await pcAccount(app.port)).toBe(ACCOUNT);
    // the same binding, now with the listing its account rows are let in under
    expect(PcAccountState.open(pc.folders.a).binding()).toMatchObject({ ...binding });
    for (const cookie of pc.cookies) expect(await credentialStatus(app.port, cookie)).toBe(200);
  } finally { await app.stop(); }
  pc.offline();
  const restarted = pc.start();
  try {
    expect(await pcAccount(restarted.port)).toBe(ACCOUNT);
    expect(PcAccountState.open(pc.folders.a).binding()).toMatchObject({ ...binding });
    expect(await memberStatus(pc, restarted, pc.identity.server_id)).toBe(200);
    for (const cookie of pc.cookies) expect(await credentialStatus(restarted.port, cookie)).toBe(200);
  } finally { await restarted.stop(); }
}, 20_000);

test.skipIf(!available).each([[ACCOUNT, "shared"], ["acct_other", "shared"], [ACCOUNT, "browser-only"]] as const)(
  "identity reset and a real one-press rebind to %s preserve imported cookies: %s sibling", async (next, sibling) => {
  const pc = await releasedPc(sibling === "browser-only");
  const app = pc.start();
  let identity: RelayIdentity | undefined;
  try {
    const { accountMailbox, devices, relay } = app.context.services;
    const registry = readDeviceRegistry(join(pc.folders.a, "devices.json"));
    if (registry.kind !== "ok") throw new Error("Missing merged registry");
    expect(registry.devices.find(row => row.id === pc.importedId)?.imported).toBe(true);
    expect(savedServerId(pc.folders.b)).toBe(sibling === "browser-only" ? undefined : pc.identity.server_id);
    if (pc.deleted) expect(await credentialStatus(app.port, pc.deleted.token)).toBe(200);
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    pc.service.opensAll = false;
    pc.service.reportsStep2Off = true;
    await accountMailbox.readSnapshot();
    expect(PcAccountState.open(pc.folders.a).serviceStep2Off()).toBe(true);
    const oldBinding = PcAccountState.open(pc.folders.a).binding()?.bind_id;
    await relay.resetIdentity();
    identity = relay.currentIdentity();
    if (!identity) throw new Error("Reset produced no identity");
    expect(devices.account()).toBeNull();
    expect(devices.sessionRow(pc.memberId)).toBeNull();
    for (const cookie of pc.cookies) expect(await credentialStatus(app.port, cookie)).toBe(200);
    pc.service.opensAll = true;
    pc.service.reportsStep2Off = false;
    const call = await listPc(pc.service, next, identity);
    const base = `http://127.0.0.1:${app.port}`;
    const post = (path: string, body: object) => fetch(base + path, { method: "POST",
      headers: { origin: base, authorization: "Bearer matrix-owner", "x-herdr-machine": "1" }, body: JSON.stringify(body) });
    expect((await post("/api/account/relay-account", { account: next })).status).toBe(204);
    expect((await call(`/v1/pcs/${identity.server_id}/admit`, "POST", {})).ok).toBe(true);
    const pressed = await post("/api/account/one-press", { account: next });
    expect([pressed.status, await pressed.json()]).toEqual([200, { account: next }]);
    const state = PcAccountState.open(pc.folders.a);
    expect(state.binding()?.bind_id).not.toBe(oldBinding);
    expect(state.serviceStep2Off()).toBe(false);
    expect(devices.account()).toBe(next);
    expect(await memberStatus(pc, app, identity.server_id)).toBe(401);
    for (const cookie of pc.cookies) expect(await credentialStatus(app.port, cookie)).toBe(200);
  } finally { await app.stop(); }
  if (pc.deleted) {
    const other = release(pc.folders.b);
    try {
      expect(other.context.services.devices.revoke(pc.deleted.id)).toBe(true);
      expect(await credentialStatus(other.port, pc.deleted.token)).toBe(401);
    } finally { await other.stop(); }
  }
  pc.offline();
  const restarted = pc.start();
  try {
    expect(restarted.context.services.devices.account()).toBe(next);
    expect(PcAccountState.open(pc.folders.b).serviceStep2Off()).toBe(false);
    if (pc.deleted) {
      expect(await credentialStatus(restarted.port, pc.deleted.token)).toBe(401);
      expect(restarted.context.services.devices.list(null).some(row => row.id === pc.deleted?.id)).toBe(false);
    }
    expect(await Promise.all(pc.cookies.map(cookie => credentialStatus(restarted.port, cookie)))).toEqual([200, 200]);
  } finally {
    await restarted.stop();
    rmSync(pc.folders.a, { recursive: true, force: true });
  }
}, 20_000);
