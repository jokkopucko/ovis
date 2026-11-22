/**
 * The code of the relay tab's QR code at this PC's own address (POST /api/devices/pair; docs/account.md, "Who may
 * admit a device"): it is redeemed through the relay only.
 */
import { afterEach, expect, test } from "bun:test";
import { linkRecord, pairingPc, sendLink, setUpFor, signedInWith, vouchFor, type Answer, type Pc } from "./pairing.test-helpers.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });

/** A code sent to this PC's own address, as the page of a browser that opened it there sends one. */
function redeem(f: Pc, code: string, headers: Record<string, string> = {}): Promise<Answer> {
  return f.local("/api/devices/pair", { method: "POST", headers: { "x-herdr-machine": "1", ...headers }, body: { code, label: "Browser" } });
}

test("the relay tab's code pairs nobody at this PC's own address and no try there is spent on it: it stays the code pending, and pairs through the relay", async () => {
  const f = await pairingPc();
  pcs.push(f);
  // a code started on the PC pairs a device at this address, as it always did
  const started = await f.local("/api/devices/pair/start", { method: "POST", headers: { "x-herdr-machine": "1" }, body: {} });
  const owner = await redeem(f, started.body.code ?? "", { accept: "application/json" });
  expect([owner.status, typeof owner.body.token, f.stored().map((device) => device.label)]).toEqual([200, "string", ["Browser"]]);

  await setUpFor(f, "acct_1");
  const code = await f.tabCode();
  const refused = await redeem(f, code);
  expect([refused.status, refused.body.error?.code, refused.headers.get("set-cookie")]).toEqual([401, "invalid_code", null]);
  // asked for as a script asks, it is given no credential either
  const scripted = await redeem(f, code, { accept: "application/json" });
  expect([scripted.status, scripted.body.token, scripted.headers.get("set-cookie")]).toEqual([401, undefined, null]);
  expect(f.stored().map((device) => device.label)).toEqual(["Browser"]);
  // ten wrong codes, more than any code takes: none is counted against it
  const wrong = code === "000000" ? "000001" : "000000";
  for (let tries = 0; tries < 10; tries += 1) expect((await redeem(f, wrong)).status).toBe(401);
  expect(f.devices.activePairing()?.code).toBe(code);
  // through the relay it pairs a device that waits to link, and whose link then makes it this PC's first member
  const device = await signedInWith(f, code);
  await vouchFor(f, "acct_1", device.key);
  expect(device.role).toBe("watch");
  expect((await sendLink(device.session, await linkRecord(device.id, "acct_1", device.key))).status).toBe(200);
  expect(await f.status()).toMatchObject({ account: "acct_1", members: 1, unlinked: [] });
});

test("the code of an offer asked for without the header pairs at this PC's own address as it did, also when it replaced the relay tab's code", async () => {
  const f = await pairingPc();
  pcs.push(f);
  await setUpFor(f, "acct_1");
  await f.tabCode();
  const paired = await redeem(f, await f.offerCode());
  expect([paired.status, f.stored().map((device) => device.label)]).toEqual([204, ["Browser"]]);
});
