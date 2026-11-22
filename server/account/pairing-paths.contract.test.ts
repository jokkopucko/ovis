/**
 * Pairing through the relay and the first account link, at the wire: a code started on the PC and carried by a
 * relay offer, the join of a signed-in app through the relay tab's code, the first link of a paired device, and
 * this PC's own access (docs/account.md, "Who may admit a device").
 */
import { afterEach, expect, test } from "bun:test";
import type { RelayDevice, RelayDeviceStore } from "../../shared/relay-device.ts";
import { linkThisDevice, needsLink, pcAccountStatus } from "../../src/lib/account/join.ts";
import { handleRequest } from "../dispatch.ts";
import { ask, ended, linkRecord, memberRow, pair, pairingPc, phone, sendLink, SERVER_ID, setUpFor, signedInWith, vouchFor, type Link, type Pc } from "./pairing.test-helpers.ts";

const pcs: Pc[] = [];

test("Linux relay phone pairing switches with this PC's binding, without restart", async () => {
  const f = await pc({ server: { accountOpensAll: true, platform: "linux" } });
  const phoneKey = await phone();
  const code = f.devices.startPairing().code;
  const first = await pair(f, code, phoneKey);
  if ("error" in first) throw new Error(`Unbound phone pairing refused: ${first.error}`);
  expect(f.app.context.services.localConfirms).toBeUndefined();
  expect(f.devices.linkAccountKey(first.id, phoneKey.spki, phoneKey.spki, "acct_phone")).not.toBeNull();
  expect(f.devices.account()).toBe("acct_phone");
  expect(f.app.context.services.localConfirms).toBeDefined();
  expect(await pair(f, f.devices.startPairing().code, await phone())).toEqual({ error: "unsupported_version" });
  expect(f.devices.clearAccountBinding("unlisted", "account")).toBe(true);
  expect(f.app.context.services.localConfirms).toBeUndefined();
  expect(f.stored().find(row => row.id === first.id)).toMatchObject({ role: "drive", origin: { from: "remote", how: "code" } });
  expect(f.stored().find(row => row.id === first.id)).not.toHaveProperty("account");
  expect(await pair(f, f.devices.startPairing().code, await phone())).not.toHaveProperty("error");
});
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });

test("on an unbound PC a driving phone's fresh code may re-pair a locally revoked phone", async () => {
  const f = await pc();
  const keeper = await phone(), returning = await phone();
  const owner = await pair(f, await f.startedCode(), keeper);
  const old = await pair(f, await f.startedCode(), returning);
  if ("error" in owner || "error" in old) throw new Error("Could not pair fixture phones");
  expect((await f.local(`/api/devices/${old.id}`, { method: "DELETE", headers: { "x-herdr-machine": "1" }, body: {} })).status).toBe(204);
  expect(f.devices.isTombstoned(returning.spki)).toBe(true);
  const fresh = f.devices.startPairing(Date.now(), { remote: true, startedBy: owner.id, memberRequired: false, ownPc: false, by: owner.id });
  const admitted = await pair(f, fresh.code, returning);
  if ("error" in admitted) throw new Error(`Fresh pairing was refused: ${admitted.error}`);
  expect(admitted.id).not.toBe(old.id);
  expect(f.devices.originOf(admitted.id)?.from).toBe("remote");
  expect(f.devices.isTombstoned(returning.spki)).toBe(false);
});

async function pc(options: Parameters<typeof pairingPc>[0] = {}): Promise<Pc> {
  const made = await pairingPc(options);
  pcs.push(made);
  return made;
}

class SavedPairings implements RelayDeviceStore {
  private readonly saved = new Map<string, RelayDevice>();
  async get(serverId: string): Promise<RelayDevice | undefined> { return this.saved.get(serverId); }
  async update(serverId: string, change: (current: RelayDevice | undefined) => RelayDevice): Promise<RelayDevice> {
    const next = change(this.saved.get(serverId));
    this.saved.set(serverId, next);
    return next;
  }
  async list(): Promise<RelayDevice[]> { return [...this.saved.values()]; }
  async remove(serverId: string): Promise<void> { this.saved.delete(serverId); }
}

/** A client's requests to the PC over its relay session, as the app's transport hands them to its account steps. */
const pcFetch = (link: Link) => async (path: string, init?: RequestInit): Promise<Response> => {
  if ((init?.method ?? "GET") === "GET") return link.open(path).response;
  const request = link.open(path, { method: "POST", headers: [["content-type", "application/json"], ["x-herdr-machine", "1"]], body: "stream" });
  void request.stream.sendBody(new Response(init?.body ?? null).body ?? new ReadableStream()).catch(() => {});
  return request.response;
};

for (const [where, account] of [["in an account", "acct_1"], ["in no account", undefined]] as const) {
  test.each([false, true])(`on a Linux PC ${where}, a legacy client redeeming a local code follows the configured pairing mode (Step 2: %s)`, async accountOpensAll => {
    const f = await pc({ server: { accountOpensAll, platform: "linux" }, rows: account === undefined ? [] : [(await memberRow(account)).row] });
    const code = await f.startedCode();
    const key = await phone();
    const made = await pair(f, code, key);
    if (accountOpensAll && account !== undefined) {
      expect(made).toEqual({ error: "unsupported_version" });
      expect(f.stored().some(row => row.relay_public_key === key.spki)).toBe(false);
      return;
    }
    if ("error" in made) throw new Error(`The pairing was refused: ${made.error}`);
    expect(made.role).toBe("drive");
    // over the session that paired, with nothing more to do: a read only a device that drives gets
    const status = await ask(made.link, "/api/account/status");
    expect([status.status, status.body.account, status.body.unlinked]).toEqual([200, account ?? null, [made.id]]);
    expect(f.stored().find((device) => device.id === made.id)).toMatchObject({ role: "drive", relay_public_key: key.spki });
    expect((await f.listed()).map((device) => device.id)).toContain(made.id);
    // the code is spent
    expect(f.devices.activePairing()).toBeNull();
    expect(await pair(f, code, await phone())).toEqual({ error: "auth_failed" });
  });
}

test("a signed-in app joins a PC set up for its account through the relay tab's code: it pairs with its account key, signs in, reads its status and links, and is then a member that drives", async () => {
  const f = await pc({ server: { accountOpensAll: false } });
  await setUpFor(f, "acct_1");
  const reached: string[] = [];
  const dispatch: typeof handleRequest = (request, context) => {
    reached.push(`${request.method} ${new URL(request.url).pathname}`);
    return handleRequest(request, context);
  };
  const key = await phone();
  // the app's account vouched for its key before it paired
  await vouchFor(f, "acct_1", key);
  const row = await signedInWith(f, await f.tabCode(), key, { dispatch });
  const saved = new SavedPairings();
  const device = await saved.update(SERVER_ID, () => ({ server_id: SERVER_ID, server_public_key: "", relay: "wss://relay.test", device_id: row.id, private_key: key.keys.privateKey, public_spki: key.spki, label: "Phone" }));
  const fetch = pcFetch(row.session);
  expect(needsLink(await pcAccountStatus(fetch), device, "acct_1")).toBe(true);
  const linked = await linkThisDevice({ fetch, device, key: { private_key: key.keys.privateKey, public_spki: key.spki }, account: "acct_1", store: saved });
  expect(linked.account).toBe("acct_1");
  // the app's account steps are these two calls, and no other came before the link
  expect(reached).toEqual(["GET /api/account/status", "POST /api/account/link"]);
  expect(f.stored()).toEqual([expect.objectContaining({ id: row.id, role: "drive", account: "acct_1", relay_public_key: key.spki })]);
  expect(await f.status()).toMatchObject({ account: "acct_1", members: 1, unlinked: [] });
  // the session that only paired ends; the one that linked goes on, with a read only a device that drives gets
  expect(await ended(row.pairing)).toBe("auth_changed");
  expect(await pcAccountStatus(fetch)).toMatchObject({ account: "acct_1", unlinked: [] });
  // the code has done what it was for
  expect(f.devices.activePairing()).toBeNull();
});

test("a paired device's first link gives a PC in no account its first member; a link that names another account afterwards is refused, and its device drives on", async () => {
  const f = await pc({ server: { accountOpensAll: false } });
  const first = await signedInWith(f, await f.startedCode());
  expect((await sendLink(first.session, await linkRecord(first.id, "acct_7", first.key))).status).toBe(200);
  expect(await f.status()).toMatchObject({ account: "acct_7", members: 1 });
  const second = await signedInWith(f, await f.startedCode());
  const refused = await sendLink(second.session, await linkRecord(second.id, "acct_8", second.key));
  expect([refused.status, refused.body.error?.code]).toEqual([409, "account_mismatch"]);
  expect((await ask(second.session, "/api/account/status")).body).toMatchObject({ account: "acct_7", members: 1, unlinked: [second.id] });
});

test.each([false, true])("the PC itself lists devices, reads its account, manages a code and removes a device without a token (Step 2: %s)", async accountOpensAll => {
  const member = await memberRow("acct_1");
  const f = await pc({ rows: [member.row], server: { accountOpensAll } });
  expect((await f.listed()).map((device) => [device.id, device.role, device.account])).toEqual([[member.row.id, "drive", "acct_1"]]);
  expect(await f.status()).toMatchObject({ account: "acct_1", members: 1, unlinked: [] });
  const started = await f.local("/api/devices/pair/start", { method: "POST", headers: { "x-herdr-machine": "1" }, body: {} });
  expect([started.status, started.body.code]).toEqual([200, expect.stringMatching(/^\d{6}$/)]);
  const ended = await f.local("/api/devices/pair/cancel", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { code: started.body.code } });
  expect([ended.status, ended.body.cancelled]).toEqual([200, true]);
  expect((await f.local(`/api/devices/${member.row.id}`, { method: "DELETE", headers: { "x-herdr-machine": "1" } })).status).toBe(204);
  expect(await f.status()).toMatchObject({ account: accountOpensAll ? "acct_1" : null, members: 0 });
});
