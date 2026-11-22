import { afterEach, expect, spyOn, test } from "bun:test";
import { newRecordId, signSafetyRecord } from "../../shared/account-records.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";
import { phone } from "./pairing.test-helpers.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

test("T52: a service freeze withdraws a listed row's lift authority", async () => {
  const { fixture, service, device } = await createListedPc(close => closes.push(close));
  const { devices, safetyLog, accountMailbox } = fixture.app.context.services;
  if (!safetyLog) throw new Error("Expected a safety log");
  const signer = await phone();
  const peer = await phone();
  const signerNo = service.registerDevice(ACCOUNT, signer.spki, "Signer");
  const peerNo = service.registerDevice(ACCOUNT, peer.spki, "Peer");
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const time = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS + 1);
  closes.push(() => time.mockRestore());
  const target = "a".repeat(64);
  const at = new Date().toISOString();
  const line = { v: 1, kind: "freeze", id: `f:${target}`, account: ACCOUNT, target: peer.spki, after: peerNo,
    signer: "service", signed_at: at, signature: "" } as const;
  expect(safetyLog.append({ record: line, got: "snapshot" }).outcome).toBe("applied");
  const record = await signSafetyRecord({ v: 1, kind: "lift", target, account: ACCOUNT,
    signer: signer.spki, signer_no: signerNo, signed_at: at }, signer.keys.privateKey);
  expect(await devices.liftAuthority(record)).toBe(true);

  const restriction = { ...line, id: `f:${"b".repeat(64)}`, target: device.publicKey, after: signerNo - 1 };
  expect(safetyLog.append({ record: restriction, got: "snapshot" }).outcome).toBe("applied");
  expect(await devices.liftAuthority(record)).toBe(false);
  expect(safetyLog.state().freezes.map(entry => entry.record.id)).toContain(line.id);
});

test("T52/P14: a lift signed by a signer frozen in the same snapshot leaves the block standing", async () => {
  const { fixture, service } = await createListedPc(close => closes.push(close));
  const { safetyLog, accountMailbox } = fixture.app.context.services;
  if (!safetyLog) throw new Error("Expected a safety log");
  const [first, frozen, signer, target] = [await phone(), await phone(), await phone(), await phone()];
  const no = new Map([first, frozen, signer, target].map((key, i) => [key, service.registerDevice(ACCOUNT, key.spki, `Device ${i}`)]));
  const post = async (record: unknown) => (await service.fetch(new Request("https://account.test/v1/safety-records", { method: "POST",
    headers: { authorization: `Bearer ${service.issueToken(ACCOUNT)}`, "content-type": "application/json" }, body: JSON.stringify({ record }) }))).status;
  const blockOf = (on: typeof first, by: typeof first) => signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: on.spki,
    target_no: no.get(on)!, signer: by.spki, signer_no: no.get(by)!, signed_at: new Date().toISOString(), nonce: newRecordId() }, by.keys.privateKey);
  const denial = await blockOf(target, signer);
  expect(await post(denial)).toBeLessThan(300);
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(safetyLog.state().freezes.map(entry => entry.record.id)).toContain(`f:${denial.id}`);
  const time = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS + 1);
  closes.push(() => time.mockRestore());

  // The service took the lift while its signer stood, then a block on an older key froze the signer: one read carries both.
  const release = await signSafetyRecord({ v: 1, kind: "lift", account: ACCOUNT, target: denial.id, signer: signer.spki,
    signer_no: no.get(signer)!, signed_at: new Date().toISOString() }, signer.keys.privateKey);
  expect(await post(release)).toBeLessThan(300);
  expect(await post(await blockOf(frozen, first))).toBeLessThan(300);
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true, liftsRefused: 1 });
  expect(safetyLog.receipt(release.id)).toBeNull();
  expect(safetyLog.state().freezes.map(entry => entry.record.id)).toContain(`f:${denial.id}`);
});
