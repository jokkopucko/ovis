import { describe, expect, test } from "bun:test";
import {
  AccountRecordError, accountDeviceId, exportAccountKey, newRecordId, parseAccountRecord, parseSafetyRecord, readAccountRecord, recordSigningBytes, registerSigningBytes,
  safetyRecordId, signAccountRecord, signSafetyRecord, verifyAccountRecord, verifySafetyRecord, type AccountRecord, type UnsignedAccountRecord,
} from "./account-records.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

async function accountKey() {
  const pair = await crypto.subtle.generateKey(P256, false, ["sign", "verify"]);
  return { pair, spki: await exportAccountKey(pair.publicKey) };
}

const signer = await accountKey();
const other = await accountKey();
const third = await accountKey();
const issued = "2026-11-05T01:02:03.456Z";

const unsigned: { [K in AccountRecord["kind"]]: Extract<UnsignedAccountRecord, { kind: K }> } = {
  add: { v: 1, kind: "add", account: "acct_1", key: other.spki, label: "Mac app", role: "drive", issued_at: issued, id: newRecordId(), signer: signer.spki },
  remove: { v: 1, kind: "remove", account: "acct_1", key: other.spki, issued_at: issued, id: newRecordId(), signer: signer.spki },
  link: { v: 1, kind: "link", account: "acct_1", key: signer.spki, server_id: "0123456789abcdef0123456789abcdef", device_id: "0123456789abcdef", old_key: other.spki, issued_at: issued, id: newRecordId(), signer: signer.spki },
};

const alternatives: Record<string, string> = {
  account: "acct_2", key: third.spki, label: "Windows app", role: "watch", server_id: "f".repeat(32),
  device_id: "f".repeat(16), old_key: third.spki, issued_at: "2026-11-05T01:02:03.457Z", id: newRecordId(), signer: third.spki,
};

describe("account records", () => {
  for (const kind of ["add", "remove", "link"] as const) {
    test(`a signed ${kind} survives JSON and verifies`, async () => {
      const record = await signAccountRecord(unsigned[kind], signer.pair.privateKey);
      const read = await readAccountRecord(JSON.parse(JSON.stringify(record)));
      expect(read).toEqual(record);
    });

    test(`a ${kind}'s signature covers every field`, async () => {
      const record = await signAccountRecord(unsigned[kind], signer.pair.privateKey);
      const fields = Object.keys(record).filter((name) => name !== "signature" && name !== "v" && name !== "kind");
      for (const name of fields) {
        const changed = { ...record, [name]: alternatives[name] } as AccountRecord;
        // a link's signer is its key; moving one without the other is refused before the signature
        if (kind === "link" && (name === "key" || name === "signer")) {
          expect(() => parseAccountRecord(changed)).toThrow(AccountRecordError);
          continue;
        }
        expect({ name, verified: await verifyAccountRecord(parseAccountRecord(changed)) }).toEqual({ name, verified: false });
      }
      const otherKind = kind === "remove"
        ? { ...record, kind: "add", label: "Mac app", role: "drive" }
        : { v: 1, kind: "remove", account: record.account, key: record.kind === "link" ? other.spki : record.key, issued_at: record.issued_at, id: record.id, signer: record.signer, signature: record.signature };
      expect(await verifyAccountRecord(parseAccountRecord(otherKind))).toBe(false);
    });
  }

  test("malformed records are refused before any signature check", async () => {
    const add = await signAccountRecord(unsigned.add, signer.pair.privateKey);
    const link = await signAccountRecord(unsigned.link, signer.pair.privateKey);
    const { label: _label, ...missingLabel } = add;
    const flipped = fromBase64Url(add.key);
    flipped[0] = 0x31;
    const bad: unknown[] = [
      null, [], "add", { ...add, v: 2 }, { ...add, kind: "rename" }, { ...add, extra: 1 }, missingLabel,
      { ...add, key: add.key.slice(0, -1) }, { ...add, key: toBase64Url(flipped) }, { ...add, key: `${add.key}=` },
      { ...add, label: "" }, { ...add, label: " Mac" }, { ...add, label: "Mac  app" }, { ...add, label: "Mac\u0007" }, { ...add, label: "Mac\ud800" }, { ...add, label: "x".repeat(49) },
      { ...add, role: "owner" }, { ...add, account: "acct 1" }, { ...add, account: "a".repeat(65) },
      { ...add, issued_at: "2026-11-05T01:02:03Z" }, { ...add, issued_at: "2026-02-30T01:02:03.000Z" },
      { ...add, id: "A".repeat(32) }, { ...add, signature: "A".repeat(85) }, { ...add, signer: add.key },
      { ...link, signer: other.spki }, { ...link, server_id: "F".repeat(32) }, { ...link, device_id: "0".repeat(15) },
    ];
    for (const value of bad) expect(() => parseAccountRecord(value)).toThrow(AccountRecordError);
  });

  test("a key off the curve verifies as false instead of throwing", async () => {
    const record = await signAccountRecord(unsigned.remove, signer.pair.privateKey);
    const offCurve = toBase64Url(Uint8Array.from([...fromBase64Url(record.signer).subarray(0, 27), ...new Uint8Array(64).fill(1)]));
    expect(await verifyAccountRecord({ ...record, signer: offCurve })).toBe(false);
  });

  test("record and AUTH signatures cannot stand in for each other", async () => {
    const serverId = "0123456789abcdef0123456789abcdef";
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    // AUTH as server/devices.ts matchRelay verifies it: `ovis-relay-auth/1 || nonce || server_id`
    const auth = new Uint8Array([...new TextEncoder().encode("ovis-relay-auth/1"), ...nonce, ...new TextEncoder().encode(serverId)]);
    const authSignature = new Uint8Array(await crypto.subtle.sign(SIGN, signer.pair.privateKey, auth));
    for (const kind of ["add", "remove", "link"] as const) {
      const record = await signAccountRecord(unsigned[kind], signer.pair.privateKey);
      expect(await verifyAccountRecord({ ...record, signature: toBase64Url(authSignature) })).toBe(false);
      expect(await crypto.subtle.verify(SIGN, signer.pair.publicKey, fromBase64Url(record.signature) as Uint8Array<ArrayBuffer>, auth)).toBe(false);
      const bytes = recordSigningBytes(unsigned[kind]);
      const firstDifference = bytes.findIndex((byte, index) => byte !== auth[index]);
      expect(firstDifference).toBeLessThan(new TextEncoder().encode("ovis-account/1").length);
    }
  });

  test("fields are length-delimited, so moving bytes across a boundary changes the signed bytes", () => {
    const a = recordSigningBytes({ ...unsigned.remove, account: "ab", key: "c" });
    const b = recordSigningBytes({ ...unsigned.remove, account: "a", key: "bc" });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

test("an added device's id is the first 16 hex of SHA-256 over the domain, the PC and the key, so both ends agree", async () => {
  const serverId = "0123456789abcdef0123456789abcdef";
  const expected = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ovis-account-device/1${serverId}${other.spki}`))).toString("hex").slice(0, 16);
  expect(accountDeviceId(serverId, other.spki)).toBe(expected);
  expect(accountDeviceId(serverId, other.spki)).toMatch(/^[0-9a-f]{16}$/);
  expect(accountDeviceId("f".repeat(32), other.spki)).not.toBe(expected);
});

test("the three older kinds keep their exact signing bytes", () => {
  // SHA-256 of recordSigningBytes on main before the safety records were added
  const k1 = `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${"A".repeat(86)}`;
  const k2 = `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${"B".repeat(86)}`;
  const at = "2026-11-05T01:02:03.456Z";
  const fixed: UnsignedAccountRecord[] = [
    { v: 1, kind: "add", account: "acct_1", key: k2, label: "Mac app", role: "drive", issued_at: at, id: "0".repeat(32), signer: k1 },
    { v: 1, kind: "remove", account: "acct_1", key: k2, issued_at: at, id: "1".repeat(32), signer: k1 },
    { v: 1, kind: "link", account: "acct_1", key: k1, server_id: "0123456789abcdef0123456789abcdef", device_id: "0123456789abcdef", old_key: k2, issued_at: at, id: "2".repeat(32), signer: k1 },
  ];
  const hashes = fixed.map((record) => new Bun.CryptoHasher("sha256").update(recordSigningBytes(record)).digest("hex"));
  expect(hashes).toEqual([
    "38bdaf4f9fe7030794b26966b039529a6a812ecd11ad104376ae17c28c804119",
    "6ac6e50675767014e26041082986b6cc7d6094bc11bcaffc9b504fd4020a61f4",
    "28cc21dcc85bc3d7b6a10daceddb215040d76c5a7ad87dbb51ca45096da8a63f",
  ]);
});

describe("safety records (device table P24, P16)", () => {
  const block = () => signSafetyRecord({ v: 1, kind: "block", account: "acct_1", target: other.spki, target_no: 5, signer: signer.spki, signer_no: 2, signed_at: issued, nonce: newRecordId() }, signer.pair.privateKey);

  test("a signed block and a device lift survive JSON, verify, and carry the hash of their bytes as id", async () => {
    const signed = await block();
    const lift = await signSafetyRecord({ v: 1, kind: "lift", account: "acct_1", target: signed.id, signer: signer.spki, signer_no: 2, signed_at: issued }, signer.pair.privateKey);
    for (const record of [signed, lift]) {
      const read = parseSafetyRecord(JSON.parse(JSON.stringify(record)));
      expect(read).toEqual(record);
      expect(await verifySafetyRecord(record)).toBe(true);
      const { id, signature: _signature, ...unsigned } = record;
      expect(id).toBe(safetyRecordId(unsigned));
      expect(id).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("a block's signature covers every signed field", async () => {
    const signed = await block();
    const changes: Record<string, unknown> = { account: "acct_2", target: third.spki, target_no: 6, signer_no: 1, signed_at: "2026-11-05T01:02:03.457Z", nonce: newRecordId() };
    for (const [name, value] of Object.entries(changes)) {
      const changed = { ...signed, [name]: value };
      const { id: _id, signature: _signature, ...unsigned } = changed;
      const rehashed = { ...changed, id: safetyRecordId(unsigned as never) };
      expect({ name, verified: await verifySafetyRecord(parseSafetyRecord(rehashed) as never) }).toEqual({ name, verified: false });
    }
  });

  test("a block's numbers are claims the PC judges, so a signer later in the account's order still parses (P21 b)", async () => {
    const later = await signSafetyRecord({ v: 1, kind: "block", account: "acct_1", target: other.spki, target_no: 2, signer: signer.spki, signer_no: 5, signed_at: issued, nonce: newRecordId() }, signer.pair.privateKey);
    expect(parseSafetyRecord(JSON.parse(JSON.stringify(later)))).toEqual(later);
    await expect(signSafetyRecord({ v: 1, kind: "block", account: "acct_1", target: signer.spki, target_no: 5, signer: signer.spki, signer_no: 2, signed_at: issued, nonce: newRecordId() }, signer.pair.privateKey))
      .rejects.toThrow(AccountRecordError);
  });

  test("records the PC writes parse with a random id and no signature", () => {
    const blockId = "a".repeat(64);
    const written = [
      { v: 1, kind: "lift", id: newRecordId(), account: "acct_1", target: blockId, signer: "pc", signed_at: issued, forget: true, signature: "" },
      { v: 1, kind: "freeze", id: `f:${blockId}`, account: "acct_1", target: other.spki, after: 5, signer: "service", signed_at: issued, signature: "" },
      { v: 1, kind: "lock", id: newRecordId(), account: "acct_1", target: null, signer: "pc", signed_at: issued, signature: "" },
      { v: 1, kind: "unlock", id: newRecordId(), account: "acct_1", target: newRecordId(), signer: "pc", signed_at: issued, signature: "" },
      { v: 1, kind: "forget", id: newRecordId(), account: "acct_1", target: other.spki, signer: "pc", signed_at: issued, signature: "" },
    ];
    for (const record of written) expect(parseSafetyRecord(JSON.parse(JSON.stringify(record)))).toEqual(record as never);
  });

  test("malformed safety records are refused", async () => {
    const signed = await block();
    const lock = { v: 1, kind: "lock", id: newRecordId(), account: "acct_1", target: null, signer: "pc", signed_at: issued, signature: "" };
    const bad: unknown[] = [
      null, { ...signed, kind: "forget" }, { ...signed, v: 2 }, { ...signed, extra: 1 }, { ...signed, id: "b".repeat(64) },
      { ...signed, target_no: 0 }, { ...signed, target_no: 1.5 }, { ...signed, signer_no: 5 }, { ...signed, target: signed.signer },
      { ...signed, signer: "pc" }, { ...signed, signature: "" }, { ...signed, nonce: "x" },
      { ...lock, signature: "A".repeat(86) }, { ...lock, signer: signer.spki }, { ...lock, target: newRecordId() }, { ...lock, id: "f:" + "a".repeat(64) },
      { ...lock, kind: "unlock" }, { ...lock, kind: "freeze", target: other.spki, after: 1, id: newRecordId() },
      { ...lock, kind: "freeze", target: other.spki, after: 1, id: `f:${"a".repeat(64)}` },
      { ...lock, kind: "lift", target: "a".repeat(64) },
    ];
    // Device table P13, T61: a forget names an account key, never a record id (no forget names a Revoke or a block)
    const forget = { v: 1, kind: "forget", id: newRecordId(), account: "acct_1", target: other.spki, signer: "pc", signed_at: issued, signature: "" };
    bad.push(
      { ...forget, target: "a".repeat(64) }, { ...forget, target: newRecordId() }, { ...forget, target: null },
      { ...forget, account: null }, { ...forget, signer: signer.spki }, { ...forget, signature: "A".repeat(86) },
      { ...forget, id: "a".repeat(64) }, { ...forget, forget: true }, { ...forget, v: 2 },
    );
    for (const value of bad) expect(() => parseSafetyRecord(value)).toThrow(AccountRecordError);
  });

  test("the older parser refuses every safety kind, and the safety parser every older kind", async () => {
    const signed = await block();
    expect(() => parseAccountRecord(signed)).toThrow(AccountRecordError);
    const remove = await signAccountRecord(unsigned.remove, signer.pair.privateKey);
    expect(() => parseSafetyRecord(remove)).toThrow(AccountRecordError);
  });
});

test("registration signing bytes match the account service's byte for byte", () => {
  // produced by registerSigningBytes in the account service (src/devices.ts) for these inputs
  const key = `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${"A".repeat(86)}`;
  const bytes = registerSigningBytes("acct_reg_device", key, "0123456789abcdef0123456789abcdef", "Zm9vYmFyLWNoYWxsZW5nZS10b2tlbi0xMjM0NTY3ODkw");
  expect({ length: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") })
    .toEqual({ length: 251, sha256: "3ad603c0126f58fcfaa1aa2ca01b5880cb560c204776ed3ea377deb5aca675dc" });
  expect(Buffer.from(bytes).toString("hex")).toBe("6f7669732d6465766963652d72656769737465722f310000000f616363745f7265675f6465766963650000007a4d466b77457759484b6f5a497a6a3043415159494b6f5a497a6a3044415163445167414541414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141410000002030313233343536373839616263646566303132333435363738396162636465660000002c5a6d3976596d46794c574e6f595778735a57356e5a5331306232746c626930784d6a4d304e5459334f446b77");
});
