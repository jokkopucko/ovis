/**
 * Adding this PC to an account in one press (docs/account.md, "One press"): POST /api/account/one-press binds a PC in
 * no account to the account its local owner is signed in to, on the account service's word for that account alone.
 * Conditions of security-triage: only the PC's owner here names the account, the PC's named account and the service's
 * answer must both be it, and nothing is bound otherwise.
 */
import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { accountDeviceId, exportAccountKey } from "../../shared/account-records.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { handleRequest, type ServerContext } from "../dispatch.ts";
import { createServer } from "../index.ts";
import { ask, linkRecord, memberRow, pairingPc, phone, provingDevice, sendLink, setUpFor, vouchFor, type Pc } from "./pairing.test-helpers.ts";
import { bounded, relayConnection } from "../relay/test-helpers.ts";
import { FrameType } from "../../shared/relay-mux.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });

async function pc(options: Parameters<typeof pairingPc>[0] = {}): Promise<Pc> {
  const made = await pairingPc({ ...options, server: { accountOpensAll: true, ...options.server } });
  made.account.opensAll = true;
  pcs.push(made);
  return made;
}

/** What the owner's signed-in browser does first: lists this PC in `account` and admits it in one press (S1). */
async function admitAt(f: Pc, account: string, twoStep: boolean | null = true): Promise<void> {
  const identity = f.app.context.services.relay.currentIdentity();
  if (!identity) throw new Error("The PC has no relay identity");
  const token = f.account.issueToken(account, { twoStep });
  const call = (path: string, method: string, body: unknown) =>
    f.account.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  const listed = await call(`/v1/pcs/${identity.server_id}`, "PUT", { label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" });
  if (!listed.ok) throw new Error(`The PC was not listed: ${listed.status} ${await listed.text()}`);
  const admitted = await call(`/v1/pcs/${identity.server_id}/admit`, "POST", {});
  if (!admitted.ok) throw new Error(`The PC was not admitted: ${admitted.status} ${await admitted.text()}`);
}

const press = (f: Pc, account: string) => f.local("/api/account/one-press", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { account } });

test("the owner's press binds a PC in no account to the account it is signed in to, and the account's devices are let in by its snapshot", async () => {
  const f = await pc();
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const laptop = await exportAccountKey(keys.publicKey);
  f.account.registerDevice("acct_1", laptop, "Laptop");
  const pressed = await press(f, "acct_1");
  expect([pressed.status, pressed.body]).toEqual([200, { account: "acct_1" }]);
  expect(f.devices.account()).toBe("acct_1");
  expect(f.devices.has(accountDeviceId(f.app.context.services.relay.currentIdentity()!.server_id, laptop))).toBe(true);
  expect(await f.status()).toMatchObject({ account: "acct_1" });
  // the admission is spent: a second press finds the PC in its account
  const again = await press(f, "acct_1");
  expect([again.status, again.body.error?.code]).toEqual([409, "in_account"]);
});

test("a press with no admission of that account binds nothing", async () => {
  const f = await pc();
  await setUpFor(f, "acct_1");
  const pressed = await press(f, "acct_1");
  expect([pressed.status, pressed.body.error?.code]).toEqual([404, "no_admission"]);
  expect(f.devices.account()).toBeNull();
});

test("the account pressed for must be the one named for this PC: a relay-account another drive caller set to B makes the owner's press for A refuse, and nothing is bound", async () => {
  const f = await pc();
  // any direct drive caller may name the relay-account (routes.ts): here it names B
  await setUpFor(f, "acct_b");
  await admitAt(f, "acct_a");
  await admitAt(f, "acct_b");
  const pressed = await press(f, "acct_a");
  expect([pressed.status, pressed.body.error?.code]).toEqual([409, "account_mismatch"]);
  expect(f.devices.account()).toBeNull();
});

test("an admission by another account is invisible to the PC: the press for its named account binds nothing", async () => {
  const f = await pc();
  await setUpFor(f, "acct_a");
  await admitAt(f, "acct_b");
  const pressed = await press(f, "acct_a");
  expect([pressed.status, pressed.body.error?.code]).toEqual([404, "no_admission"]);
  expect(f.devices.account()).toBeNull();
});

test("an answer of the account service that names another account is refused, and nothing is bound", async () => {
  const f = await pc({ accountFetch: async (request, service) => {
    if (new URL(request.url).pathname !== "/v1/pc/admission") return await service.fetch(request);
    const answer = await service.fetch(request);
    const body = await answer.json() as Record<string, unknown>;
    return Response.json({ ...body, account: "acct_other" }, { status: answer.status });
  } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  const pressed = await press(f, "acct_1");
  expect([pressed.status, pressed.body.error?.code]).toEqual([502, "account_mismatch"]);
  expect(f.devices.account()).toBeNull();
});

test("a device through the relay cannot press, and a watching one cannot either: nothing is bound", async () => {
  const f = await pc();
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  const serverId = f.app.context.services.relay.currentIdentity()!.server_id;
  const relayed = async (role: "drive" | "watch") => {
    const response = await handleRequest(new Request("https://relay.ovis.invalid/api/account/one-press", {
      method: "POST", headers: { origin: "https://relay.ovis.invalid", "x-herdr-machine": "1", "content-type": "application/json" }, body: JSON.stringify({ account: "acct_1" }),
    }), { ...f.app.context, peer: { kind: "relay", device: { id: "aaaaaaaaaaaaaaaa", label: "Relay", role }, sessionId: "s", serverId, key: "" }, timeout: () => {} });
    return [response?.status, ((await response!.json()) as { error: { code: string } }).error.code];
  };
  expect(await relayed("drive")).toEqual([403, "owner_only"]);
  expect(await relayed("watch")).toEqual([403, "read_only"]);
  expect(f.devices.account()).toBeNull();
});

test("an open LAN window cannot press", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-one-press-open-"));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, machines: false, sidecar: false, accountOpensAll: true });
  try {
    const base = `http://192.168.1.10:${app.port}`;
    const ctx: ServerContext = { ...app.context, requestIP: () => ({ address: "192.168.1.50" }), timeout: () => {}, upgrade: () => false };
    const response = await handleRequest(new Request(`${base}/api/account/one-press`, {
      method: "POST", headers: { host: `192.168.1.10:${app.port}`, origin: base, "x-herdr-machine": "1", "content-type": "application/json" },
      body: JSON.stringify({ account: "acct_1" }),
    }), ctx);
    expect(response?.status).toBe(403);
    expect(((await response!.json()) as { error: { code: string } }).error.code).toBe("owner_only");
    expect(app.context.services.devices.account()).toBeNull();
  } finally {
    app.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("with the step-2 switch off the PC has no such route", async () => {
  const f = await pc({ server: { accountOpensAll: false } });
  await setUpFor(f, "acct_1");
  const pressed = await press(f, "acct_1");
  expect([pressed.status, pressed.body.error?.code]).toEqual([404, "not_found"]);
  expect(f.devices.account()).toBeNull();
});

test("a PC bound in one press keeps its account when the snapshot route answers 404 (step 2 turned off for the account)", async () => {
  const f = await pc();
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  expect((await press(f, "acct_1")).status).toBe(200);
  f.account.opensAll = false;
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(f.devices.account()).toBe("acct_1");
});

test("service unlisting clears one-press status without a screen channel", async () => {
  const f = await pc({ server: { platform: "darwin" } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  expect((await press(f, "acct_1")).status).toBe(200);
  const serverId = f.app.context.services.relay.currentIdentity()!.server_id;
  expect((await f.account.fetch(new Request(`https://account.test/v1/pcs/${serverId}`, { method: "DELETE",
    headers: { authorization: `Bearer ${f.account.issueToken("acct_1")}` } }))).status).toBe(204);
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(await f.status()).toMatchObject({ account: null });
});

test.skipIf(process.platform !== "linux").each(["herdr-web-ui", "ovis"])("sibling unlisting: offline restart from %s keeps only this PC's pairings", async restartFolder => {
  const screen = new TransformStream<Uint8Array, Uint8Array>();
  const writer = screen.writable.getWriter();
  const legacy = await memberRow("acct_1");
  const { account: _, ...plain } = legacy.row;
  const f = await pc({ rows: [plain], server: { desktopOwner: { input: screen.readable, write() {} } } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  expect((await press(f, "acct_1")).status).toBe(200);
  const { devices, relay, accountMailbox, localConfirms } = f.app.context.services;
  const serverId = relay.currentIdentity()!.server_id;
  const listed = await phone();
  f.account.registerDevice("acct_1", listed.spki, "Listed only");
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const link = (id: string, key: string) => expect(devices.linkAccountKey(id, key, key, "acct_1")).not.toBeNull();
  link(plain.id, legacy.key.spki);
  const code = await phone(), localDigits = await phone(), memberDigits = await phone(), memberCode = await phone();
  const coded = devices.pairRelay(devices.startPairing().code, "Local code", code.spki)!;
  link(coded.device.id, code.spki);
  const memberCoded = devices.pairRelay(devices.startPairing().code, "Member code", memberCode.spki)!;
  link(memberCoded.device.id, memberCode.spki);
  expect(devices.originOf(memberCoded.device.id)).toMatchObject({ from: "remote", how: "code", by: null });
  const digits = devices.pairRelayApproved("Local digits", localDigits.spki, { path: "account" })!;
  link(digits.device.id, localDigits.spki);
  const member = devices.pairRelayApproved("Member digits", memberDigits.spki, { path: "account", addedBy: plain.id })!;
  const proof = await provingDevice(f, await f.offerCode());
  await proof.pending;
  const approval = localConfirms!.pending().find(e => e.action.kind === "approve_key")!;
  const admitted = Promise.withResolvers<string>();
  proof.link.onFrame = frame => { if (frame.type === FrameType.AUTH_OK) admitted.resolve(frame.payload.device_id); };
  await writer.write(new TextEncoder().encode(`${JSON.stringify({ approve: approval.id })}\n`));
  const screened = await bounded(admitted.promise);
  link(screened, proof.device.spki);
  expect(devices.originOf(digits.device.id)).toMatchObject({ from: "remote", how: "digits", by: null });
  expect(devices.originOf(member.device.id)).toMatchObject({ from: "remote", how: "member", by: legacy.key.spki });
  await f.app.stop();
  // a code a member device started names that member as `by`: it stood on the account's authority, not this PC's
  const rowsFile = join(f.stateDir, "devices.json");
  const rows = JSON.parse(readFileSync(rowsFile, "utf8")) as { devices: { id: string; origin?: object }[] };
  rows.devices = rows.devices.map(row => row.id === memberCoded.device.id ? { ...row, origin: { ...row.origin, by: legacy.key.spki } } : row);
  writeFileSync(rowsFile, JSON.stringify(rows), { mode: 0o600 });
  const root = mkdtempSync(join(tmpdir(), "unlisting-siblings-"));
  try {
    const active = join(root, "herdr-web-ui"), sibling = join(root, "ovis");
    for (const dest of [active, sibling]) cpSync(f.stateDir, dest, { recursive: true });
    const opts = { port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null, registerBridge: false, sidecar: false };
    const bound = createServer({ ...opts, stateDir: active, siblingStateDir: sibling, accountService: { url: "https://account.test", fetch: f.account.fetch } });
    try {
      expect(bound.context.services.devices.account()).toBe("acct_1");
      expect(bound.context.services.devices.serviceBinding()).not.toBeNull();
      expect((await f.account.fetch(new Request(`https://account.test/v1/pcs/${serverId}`, { method: "DELETE",
        headers: { authorization: `Bearer ${f.account.issueToken("acct_1")}` } }))).status).toBe(204);
      await bound.context.services.accountMailbox.readSnapshot();
      expect(bound.context.services.devices.account()).toBeNull();
    } finally { await bound.stop(); }
    const stateDir = join(root, restartFolder);
    const offline = createServer({ ...opts, stateDir, siblingStateDir: stateDir === active ? sibling : active, accountService: { url: "off" } });
    const closes: (() => void)[] = [];
    try {
      const statuses: number[] = [];
      for (const [id, key] of [[plain.id, legacy.key], [coded.device.id, code], [memberCoded.device.id, memberCode], [screened, proof.device],
        [digits.device.id, localDigits], [member.device.id, memberDigits], [accountDeviceId(serverId, listed.spki), listed]] as const) {
        const session = await relayConnection({ app: offline, stateDir, closes, close() {} });
        statuses.push(await session.auth({ id, keys: key.keys, publicKey: key.spki })
          .then(async () => (await ask(session, "/api/devices")).status, () => 401));
      }
      const own = await fetch(`http://127.0.0.1:${offline.port}/api/account/status`);
      expect({ own: own.status, account: (await own.json()).account, statuses }).toEqual({ own: 200, account: null, statuses: [200, 200, 401, 200, 200, 401, 401] });
    } finally { for (const close of closes) close(); await offline.stop(); }
  } finally { rmSync(root, { recursive: true, force: true }); writer.releaseLock(); }
});

test.skipIf(process.platform !== "linux").each([false, true])("service unlisting keeps a locally paired linked phone through offline restart (locked: %s)", async locked => {
  const screen = new TransformStream<Uint8Array, Uint8Array>();
  const writer = screen.writable.getWriter();
  const f = await pc({ server: { desktopOwner: { input: screen.readable, write() {} } } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  const laptop = await phone();
  f.account.registerDevice("acct_1", laptop.spki, "Laptop");
  expect((await press(f, "acct_1")).status).toBe(200);
  const serverId = f.app.context.services.relay.currentIdentity()!.server_id;
  const listedId = accountDeviceId(serverId, laptop.spki);
  expect(f.devices.has(listedId)).toBe(true);
  const pairing = await provingDevice(f, await f.offerCode());
  await pairing.pending;
  const confirm = f.app.context.services.localConfirms?.pending().find(e => e.action.kind === "approve_key");
  if (!confirm) throw new Error("Missing local pairing approval");
  const admitted = Promise.withResolvers<string>();
  pairing.link.onFrame = frame => { if (frame.type === FrameType.AUTH_OK) admitted.resolve(frame.payload.device_id); };
  await writer.write(new TextEncoder().encode(`${JSON.stringify({ approve: confirm.id })}\n`));
  const id = await bounded(admitted.promise);
  await vouchFor(f, "acct_1", pairing.device);
  expect((await sendLink(pairing.link, await linkRecord(id, "acct_1", pairing.device))).status).toBe(200);
  expect(f.stored().find(d => d.id === id)).toMatchObject({ account: "acct_1", origin: { from: "pc" } });
  const lock = locked ? f.app.context.services.safetyLog!.appendLock({ account: "acct_1" }).id : null;
  const removed = await f.account.fetch(new Request(`https://account.test/v1/pcs/${serverId}`, { method: "DELETE", headers: { authorization: `Bearer ${f.account.issueToken("acct_1")}` } }));
  expect(removed.status).toBe(204);
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(f.devices.account()).toBeNull();
  expect(f.devices.has(listedId)).toBe(false);
  const atClear = f.stored().find(d => d.id === id);
  await f.app.context.services.relay.stop();
  await f.app.stop();
  const offline = createServer({ stateDir: f.stateDir, port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null,
    registerBridge: false, sidecar: false, accountService: { url: "off" } });
  const closes: (() => void)[] = [];
  try {
    const base = `http://127.0.0.1:${offline.port}`;
    const local = await fetch(`${base}/api/devices`);
    const signed = await relayConnection({ stateDir: f.stateDir, app: offline, closes, close() {} });
    const pairedStatus = await signed.auth({ id, keys: pairing.device.keys, publicKey: pairing.device.spki })
      .then(async () => (await ask(signed, "/api/devices")).status, () => 401);
    expect({ pairedStatus, local: local.status, account: atClear?.account, linked: atClear?.linked_at,
      stored: atClear?.id }).toEqual({ pairedStatus: 200, local: locked ? 403 : 200, account: undefined, linked: undefined, stored: id });
    expect(offline.context.services.devices.accountError).toBeNull();
    const listed = await relayConnection({ stateDir: f.stateDir, app: offline, closes, close() {} });
    await expect(listed.auth({ id: listedId, keys: laptop.keys, publicKey: laptop.spki })).rejects.toThrow();
    if (lock !== null) {
      expect(await local.json()).toMatchObject({ error: { code: "locked" } });
      expect(await (await fetch(`${base}/api/account/lock`)).json()).toMatchObject({ locked: lock, bound: false });
      expect((await fetch(`${base}/api/account/unlock`, { method: "POST", headers: { origin: base, "x-herdr-machine": "1" },
        body: JSON.stringify({ lock }) })).status).toBe(202);
    }
  } finally { for (const close of closes) close(); await offline.stop(); writer.releaseLock(); }
});

test("first-PC exemption: an account never used, signed in with Google whose two-step is unknown, adds its first PC in one press", async () => {
  const f = await pc();
  await setUpFor(f, "acct_new");
  await admitAt(f, "acct_new", null);
  expect((await press(f, "acct_new")).status).toBe(200);
  expect(f.devices.account()).toBe("acct_new");
});

test("first-PC exemption: an account that ever had a device key (revoked included) needs two-step for one press", async () => {
  const f = await pc();
  await setUpFor(f, "acct_used");
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const key = await exportAccountKey(keys.publicKey);
  f.account.registerDevice("acct_used", key, "Old phone");
  f.account.removeDevice("acct_used", key);
  await expect(admitAt(f, "acct_used", null)).rejects.toThrow("two_step_required");
  expect([(await press(f, "acct_used")).status, f.devices.account()]).toEqual([404, null]);
});

test("a LAN window holding the access token, or any window that is not this PC's own, cannot press", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-one-press-token-"));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "secret-token", tailscaleOwner: null, machines: false, sidecar: false, accountOpensAll: true });
  try {
    const base = `http://192.168.1.10:${app.port}`;
    const ctx: ServerContext = { ...app.context, requestIP: () => ({ address: "192.168.1.50" }), timeout: () => {}, upgrade: () => false };
    const response = await handleRequest(new Request(`${base}/api/account/one-press`, {
      method: "POST", headers: { host: `192.168.1.10:${app.port}`, origin: base, authorization: "Bearer secret-token", "x-herdr-machine": "1", "content-type": "application/json" },
      body: JSON.stringify({ account: "acct_1" }),
    }), ctx);
    expect(response?.status).toBe(403);
    expect(((await response!.json()) as { error: { code: string } }).error.code).toBe("owner_only");
    expect(app.context.services.devices.account()).toBeNull();
  } finally {
    app.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a press whose PC is named for another account while the service answers binds nothing", async () => {
  let rename: (() => Promise<void>) | null = null;
  const f = await pc({ accountFetch: async (request, service) => {
    if (new URL(request.url).pathname === "/v1/pc/admission" && rename !== null) { const now = rename; rename = null; await now(); }
    return await service.fetch(request);
  } });
  await setUpFor(f, "acct_a");
  await admitAt(f, "acct_a");
  rename = () => setUpFor(f, "acct_b");
  const pressed = await press(f, "acct_a");
  expect([pressed.status, pressed.body.error?.code]).toEqual([409, "account_mismatch"]);
  expect(f.devices.account()).toBeNull();
});

test("a not_listed that answers a read begun under an earlier binding never clears a binding made since", async () => {
  let rebind = false;
  const f = await pc({ accountFetch: async (request, service) => {
    if (rebind && new URL(request.url).pathname === "/v1/pc/snapshot") {
      rebind = false;
      // the PC left and was added again in one press while this read was on its way
      f.devices.clearAccountBinding("unlisted", "test");
      f.devices.bindByService("acct_1");
      return Response.json({ error: { code: "not_listed", message: "gone" } }, { status: 403 });
    }
    return await service.fetch(request);
  } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  expect((await press(f, "acct_1")).status).toBe(200);
  const first = f.devices.serviceBinding();
  rebind = true;
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(f.devices.account()).toBe("acct_1");
  expect(f.devices.serviceBinding()).not.toBe(first);
});

test("first-PC exemption: a device key the admitting sign-in registered itself does not count as the account being used", async () => {
  const f = await pc();
  await setUpFor(f, "acct_own");
  const identity = f.app.context.services.relay.currentIdentity()!;
  const token = f.account.issueToken("acct_own", { twoStep: null });
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  f.account.registerSessionKey(token, await exportAccountKey(keys.publicKey), "This browser");
  const call = (path: string, method: string, body: unknown) => f.account.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  expect((await call(`/v1/pcs/${identity.server_id}`, "PUT", { label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" })).ok).toBe(true);
  expect((await call(`/v1/pcs/${identity.server_id}/admit`, "POST", {})).status).toBe(200);
  expect((await press(f, "acct_own")).status).toBe(200);
});

test("a press whose PC the account removes during its first read answers no success, and the PC is in no account", async () => {
  let remove = false;
  const f = await pc({ accountFetch: async (request, service) => {
    if (remove && new URL(request.url).pathname === "/v1/pc/snapshot") {
      remove = false;
      const serverId = f.app.context.services.relay.currentIdentity()!.server_id;
      await service.fetch(new Request(`https://account.test/v1/pcs/${serverId}`, { method: "DELETE", headers: { authorization: `Bearer ${service.issueToken("acct_1")}` } }));
    }
    return await service.fetch(request);
  } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  remove = true;
  const pressed = await press(f, "acct_1");
  expect([pressed.status, pressed.body.error?.code]).toEqual([409, "not_listed"]);
  expect(f.devices.account()).toBeNull();
});

test("a not_listed refusal of anything but the snapshot route never unbinds a PC bound in one press", async () => {
  let refuseChallenge = false;
  const f = await pc({ accountFetch: async (request, service) => {
    if (refuseChallenge && new URL(request.url).pathname === "/v1/pc/challenge") return Response.json({ error: { code: "not_listed", message: "x" } }, { status: 403 });
    return await service.fetch(request);
  } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  expect((await press(f, "acct_1")).status).toBe(200);
  refuseChallenge = true;
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(f.devices.account()).toBe("acct_1");
});

test("PADD-1: a Revoke all that finishes while the press waits on the account service binds nothing", async () => {
  let revoke: (() => void) | null = null;
  const f = await pc({ accountFetch: async (request, service) => {
    if (new URL(request.url).pathname === "/v1/pc/admission" && revoke !== null) { const now = revoke; revoke = null; now(); }
    return await service.fetch(request);
  } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  revoke = () => { f.devices.revokeAll(); };
  const pressed = await press(f, "acct_1");
  expect(pressed.status).toBe(409);
  expect(f.devices.account()).toBeNull();
});

test("first-PC exemption: the same sign-in may repeat its admit before the PC reads it, and gets the same admission", async () => {
  const f = await pc();
  await setUpFor(f, "acct_retry");
  const identity = f.app.context.services.relay.currentIdentity()!;
  const token = f.account.issueToken("acct_retry", { twoStep: null });
  const call = (path: string, method: string, body: unknown) => f.account.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  expect((await call(`/v1/pcs/${identity.server_id}`, "PUT", { label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" })).ok).toBe(true);
  const first = await (await call(`/v1/pcs/${identity.server_id}/admit`, "POST", {})).json() as { admitted_at: string };
  const again = await call(`/v1/pcs/${identity.server_id}/admit`, "POST", {});
  expect(again.status).toBe(200);
  expect(((await again.json()) as { admitted_at: string }).admitted_at).toBe(first.admitted_at);
  // another sign-in of the account gets no exemption of its own
  const other = f.account.issueToken("acct_retry", { twoStep: null });
  expect((await f.account.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}/admit`, { method: "POST", headers: { authorization: `Bearer ${other}` }, body: "{}" }))).status).toBe(403);
  expect((await press(f, "acct_retry")).status).toBe(200);
});

test("PADD-1: a relay identity reset that finishes while the press waits on the account service binds nothing", async () => {
  let reset: (() => Promise<void>) | null = null;
  const f = await pc({ accountFetch: async (request, service) => {
    if (new URL(request.url).pathname === "/v1/pc/admission" && reset !== null) { const now = reset; reset = null; const answer = await service.fetch(request); await now(); return answer; }
    return await service.fetch(request);
  } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  const before = f.app.context.services.relay.currentIdentity()!.server_id;
  reset = async () => { await f.app.context.services.relay.resetIdentity(); };
  const pressed = await press(f, "acct_1");
  expect(f.app.context.services.relay.currentIdentity()?.server_id).not.toBe(before);
  expect([pressed.status, pressed.body.error?.code]).toEqual([409, "identity_changed"]);
  expect(f.devices.account()).toBeNull();
});
