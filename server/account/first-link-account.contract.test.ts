/**
 * The first account link of a PC that its signed-in owner set up for an account (POST /api/account/relay-account,
 * as `ovis add` sends it before it shows its code; docs/account.md, "PC API"): while the PC has no member, its
 * first member comes from that account, and a device that waits to link is taken into no other.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ask, ended, linkRecord, memberRow, pairingPc, sendLink, setUpFor, signedInWith, signIn, vouchFor, type Pc } from "./pairing.test-helpers.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });

async function pc(options: Parameters<typeof pairingPc>[0] = {}): Promise<Pc> {
  const made = await pairingPc({ ...options, server: { accountOpensAll: false, ...options.server } });
  pcs.push(made);
  return made;
}

test("on a PC set up for an account, a waiting device whose link names another account is refused and goes at once; the code stays, and a device of that account joins with it", async () => {
  const f = await pc();
  await setUpFor(f, "acct_owner");
  const code = await f.tabCode();
  const other = await signedInWith(f, code);
  // what it may read before its link tells it nothing of the account the PC is for
  expect(JSON.stringify((await ask(other.session, "/api/account/status")).body)).not.toContain("acct_owner");
  const refused = await sendLink(other.session, await linkRecord(other.id, "acct_other", other.key));
  expect([refused.status, refused.body.error?.code]).toEqual([409, "account_mismatch"]);
  expect(JSON.stringify(refused.body)).not.toContain("acct_owner");
  // with no time passing: its sessions end, and its key signs in no more
  expect([await ended(other.session), await ended(other.pairing)]).toEqual(["auth_revoked", "auth_revoked"]);
  expect(await signIn(f, other.id, other.key)).toEqual({ error: "auth_failed" });
  expect(await f.status()).toMatchObject({ account: null, members: 0, unlinked: [] });
  // nothing of it is on disk: no row, and no enrollment barrier of its link
  expect([f.stored(), existsSync(join(f.stateDir, "account-enrolling.json"))]).toEqual([[], false]);
  // the same code: the device of the account the PC is for pairs and links
  expect(f.devices.activePairing()?.code).toBe(code);
  const owner = await signedInWith(f, code);
  await vouchFor(f, "acct_owner", owner.key);
  expect((await sendLink(owner.session, await linkRecord(owner.id, "acct_owner", owner.key))).status).toBe(200);
  expect(await f.status()).toMatchObject({ account: "acct_owner", members: 1 });
  expect(f.stored().map((device) => [device.id, device.account])).toEqual([[owner.id, "acct_owner"]]);
});

test("on a PC set up for an account, a paired device whose first link names another account is refused and drives on; naming the PC's account, it joins", async () => {
  const f = await pc();
  await setUpFor(f, "acct_owner");
  const device = await signedInWith(f, await f.startedCode());
  const refused = await sendLink(device.session, await linkRecord(device.id, "acct_other", device.key));
  expect([refused.status, refused.body.error?.code]).toEqual([409, "account_mismatch"]);
  expect(await f.status()).toMatchObject({ account: null, members: 0, unlinked: [device.id] });
  // it keeps what its code gave it: a read only a device that drives gets, on the same session
  expect((await ask(device.session, "/api/account/status")).status).toBe(200);
  expect((await sendLink(device.session, await linkRecord(device.id, "acct_owner", device.key))).status).toBe(200);
  expect(await f.status()).toMatchObject({ account: "acct_owner", members: 1, unlinked: [] });
});

test("a PC set up for an account its owner no longer uses says what to run on it; once that has named the account in use, the device joins with the code shown then", async () => {
  const f = await pc();
  await setUpFor(f, "acct_before");
  const code = await f.tabCode();
  const first = await signedInWith(f, code);
  const refused = await sendLink(first.session, await linkRecord(first.id, "acct_now", first.key));
  expect([refused.status, refused.body.error?.code]).toEqual([409, "account_mismatch"]);
  // the way out is a command on the PC, and the answer names it
  expect(refused.body.error?.message).toContain("ovis add");
  // `ovis add`, run again by an owner signed in to the account in use, names it: the code made while the other was
  // named ends with that, and the device scans the one shown now
  await setUpFor(f, "acct_now");
  expect(f.devices.activePairing()).toBeNull();
  const fresh = await f.tabCode();
  expect(fresh).not.toBe(code);
  const again = await signedInWith(f, fresh, first.key);
  await vouchFor(f, "acct_now", first.key);
  expect((await sendLink(again.session, await linkRecord(again.id, "acct_now", first.key))).status).toBe(200);
  expect(await f.status()).toMatchObject({ account: "acct_now", members: 1 });
});

test("on a PC that no account was named for, a device that waits to link is taken into no account: its link is refused and it goes at once, and nothing of it is written", async () => {
  const f = await pc();
  // such a PC makes no code for the relay tab's QR code (server/relay/service.contract.test.ts), so no device waits
  // to link on it through its own offers: this code is made on the device list itself
  const code = f.devices.pairingForNoAccount().code;
  const waits = await signedInWith(f, code);
  expect(waits.role).toBe("watch");
  const refused = await sendLink(waits.session, await linkRecord(waits.id, "acct_1", waits.key));
  expect([refused.status, refused.body.error?.code]).toEqual([409, "account_mismatch"]);
  expect([await ended(waits.session), await ended(waits.pairing)]).toEqual(["auth_revoked", "auth_revoked"]);
  expect(await signIn(f, waits.id, waits.key)).toEqual({ error: "auth_failed" });
  expect(await f.status()).toMatchObject({ account: null, members: 0, unlinked: [] });
  expect([f.stored(), existsSync(join(f.stateDir, "account-enrolling.json"))]).toEqual([[], false]);
  // once the account is named, a device that pairs with the same code and names that account joins
  await setUpFor(f, "acct_1");
  const owner = await signedInWith(f, code);
  await vouchFor(f, "acct_1", owner.key);
  expect((await sendLink(owner.session, await linkRecord(owner.id, "acct_1", owner.key))).status).toBe(200);
  expect(await f.status()).toMatchObject({ account: "acct_1", members: 1 });
});

test("a PC that is in an account answers the relay tab's offer as in_account, with no account named for it too", async () => {
  const f = await pc({ rows: [(await memberRow("acct_1")).row] });
  const offer = await f.local("/api/relay/offer", { method: "POST", headers: { "x-herdr-update": "1", "x-ovis-no-account-only": "1" } });
  expect([offer.status, offer.body.error?.code]).toEqual([409, "in_account"]);
});

test("once a PC is in an account, that account decides its links, whatever account was named for it", async () => {
  const member = await memberRow("acct_1");
  const f = await pc({ rows: [member.row] });
  await setUpFor(f, "acct_named");
  const device = await signedInWith(f, await f.startedCode());
  expect((await sendLink(device.session, await linkRecord(device.id, "acct_1", device.key))).status).toBe(200);
  expect(await f.status()).toMatchObject({ account: "acct_1", members: 2, unlinked: [] });
  const second = await signedInWith(f, await f.startedCode());
  const refused = await sendLink(second.session, await linkRecord(second.id, "acct_named", second.key));
  expect([refused.status, refused.body.error?.code]).toEqual([409, "account_mismatch"]);
});
