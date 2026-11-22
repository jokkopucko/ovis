import { describe, expect, spyOn, test } from "bun:test";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LIST_BODY_MAX, ListEntryError, entryFromText, entryHash, entryHolds, entryToText, firstState, isListHash, isListKeyEncoding, isListName,
  isListNumber, isListPoint, readBody, readFields, readFieldsUnder, signEntry, signatureInRange, verifySignature, writeBody, writeFields, writeFieldsUnder,
  type Entry, type EntryBody, type HeldEntry, type ListRefusalCode,
} from "./account-list-entry.ts";
import {
  ACCOUNT_RECORD_PREFIX, AccountRecordError, newRecordId, readAccountRecord, recordSigningBytes, signAccountRecord, type UnsignedAccountRecord,
} from "./account-records.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const FIELD = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;

async function newKey() {
  const pair = await crypto.subtle.generateKey(P256, true, ["sign", "verify"]);
  return { pair, key: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))) };
}
const owner = await newKey();
const other = await newKey();

const encoder = new TextEncoder();
type Pairs = [string, string | Uint8Array][];
function rawUnder(prefix: string, pairs: Pairs, tail: number[] = []): Uint8Array {
  const out: number[] = [...encoder.encode(prefix)];
  const length = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  for (const [name, value] of pairs) {
    const nameBytes = encoder.encode(name);
    const valueBytes = typeof value === "string" ? encoder.encode(value) : value;
    out.push(...length(nameBytes.length), ...nameBytes, ...length(valueBytes.length), ...valueBytes);
  }
  return Uint8Array.from([...out, ...tail]);
}
const raw = (pairs: Pairs, tail: number[] = []): Uint8Array => rawUnder("ovis-list/1", pairs, tail);
const sevenPairs = (): Pairs => [["issued_at", "1767225600"], ["kind", "genesis"], ["list", ""], ["prev", ""], ["seq", "0"], ["signer", owner.key], ["v", "1"]];
const set = (pairs: Pairs, name: string, value: string): Pairs => pairs.map(([n, v]) => [n, n === name ? value : v]);
const without = (pairs: Pairs, name: string): Pairs => pairs.filter(([n]) => n !== name);
const sorted = (pairs: Pairs): Pairs => [...pairs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

function refusal(run: () => unknown): ListRefusalCode | "none" {
  try {
    run();
  } catch (error) {
    if (error instanceof ListEntryError) return error.code;
    throw error;
  }
  return "none";
}
async function asyncRefusal(run: () => Promise<unknown>): Promise<ListRefusalCode | "none"> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ListEntryError) return error.code;
    throw error;
  }
  return "none";
}
const bodyRefusal = (body: Uint8Array) => refusal(() => readBody(body));

const genesisBody: EntryBody = { issued_at: 1767225600, kind: "genesis", list: "", prev: "", seq: 0, signer: owner.key, v: 1, own: [] };
const genesis = await signEntry(genesisBody, owner.pair.privateKey);
const held0 = await entryHolds(genesis, null);
const nextBody = (changes: Partial<EntryBody> = {}): EntryBody => ({
  issued_at: 1767225660, kind: "remove", list: held0.list, prev: held0.hash, seq: 1, signer: owner.key, v: 1, own: [], ...changes,
});
const signRaw = async (body: Uint8Array, pair: CryptoKeyPair = owner.pair): Promise<Entry> => ({
  body, signature: new Uint8Array(await crypto.subtle.sign(SIGN, pair.privateKey, new Uint8Array(body))),
});
const scalarBytes = (value: bigint) => hexToBytes(value.toString(16).padStart(64, "0"));
const keyOf = (x: bigint, y: bigint) => toBase64Url(Uint8Array.from([...fromBase64Url(owner.key).subarray(0, 27), ...scalarBytes(x), ...scalarBytes(y)]));
const pointOf = (key: string): [bigint, bigint] => {
  const bytes = fromBase64Url(key);
  return [BigInt(`0x${bytesToHex(bytes.subarray(27, 59))}`), BigInt(`0x${bytesToHex(bytes.subarray(59))}`)];
};
function onCurveElsewhere(x: bigint, y: bigint): boolean {
  try {
    p256.Point.fromAffine({ x, y }).assertValidity();
    return true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

describe("the vectors of envelope/", () => {
  const dir = join(import.meta.dir, "account-list-vectors", "envelope");
  const files = readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
  const FIRST = [
    "genesis-entry", "remove-entry", "device-entry", "body-at-limit", "body-8193", "field-missing", "names-out-of-order", "name-twice",
    "name-begins-next", "name-33-bytes", "name-form", "trailing-bytes", "length-past-end", "number-leading-zero", "number-16-digits",
    "v-zero", "hash-uppercase", "power-other", "adds-without-power", "power-without-adds", "ends-not-a-key", "key-second-spelling",
    "key-other-prefix", "signer-off-curve", "signature-other-key", "signature-high-s", "signature-r-zero", "byte-changed", "seq-wrong",
    "prev-wrong", "other-list", "entry-0-with-adds", "wire-second-dot", "wire-empty-part", "wire-outside-alphabet", "wire-padded",
    "wire-white-space", "wire-trailing-newline", "wire-signature-85",
  ];
  const MORE = ["signature-second-spelling", "wire-second-spelling", "wire-no-dot", "wire-signature-87", "name-empty", "list-mismatch", "v-zero-prev-wrong-signature-bad"];
  const SECOND = [
    "adds-not-a-key", "key-outside-alphabet", "key-short", "kind-form", "list-not-a-hash", "number-sign", "seq-leading-zero", "v-leading-zero", "prefix-other",
    "entry-0-prev-missing", "entry-0-with-prev", "list-wrong-prev-right", "signature-r-order", "signature-s-order", "signature-s-zero", "prev-wrong-signature-bad",
  ];
  const NAMES = [...FIRST, ...MORE, ...SECOND];

  interface VectorEntry { fields: [string, string][]; body: string; signature: string; text: string; hash: string }
  interface Vector {
    name: string;
    given_list?: string;
    keys: Record<string, { pkcs8: string; spki: string }>;
    entries: VectorEntry[];
    expect: { state: { list: string; head: { seq: number; hash: string }; first_signer: string } } | { stops: { seq: number; code: ListRefusalCode } };
  }
  const vectors = files.map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as Vector);
  const byName = new Map(vectors.map((vector) => [vector.name, vector]));

  test("there is one file for every vector named, and no other", () => {
    expect(files).toEqual(NAMES.map((name) => `${name}.json`).sort());
    for (const [index, vector] of vectors.entries()) expect(`${vector.name}.json`).toBe(files[index] ?? "");
  });

  for (const vector of vectors) {
    test(vector.name, async () => {
      const run: { before: HeldEntry | null; firstSigner: string | null; stopped: { seq: number; code: ListRefusalCode } | null } = { before: null, firstSigner: null, stopped: null };
      for (const [seq, item] of vector.entries.entries()) {
        expect(entryHash(fromBase64Url(item.body))).toBe(item.hash);
        const code = await asyncRefusal(async () => {
          const entry = entryFromText(item.text);
          expect(item.text).toBe(`${item.body}.${item.signature}`);
          if (run.before === null) {
            const { first, signer } = await firstState(entry, vector.given_list);
            run.before = first;
            run.firstSigner = signer;
          } else {
            run.before = await entryHolds(entry, run.before);
          }
          expect(entryToText(entry)).toBe(item.text);
        });
        if (code !== "none") {
          run.stopped = { seq, code };
          break;
        }
      }
      if ("stops" in vector.expect) {
        expect(run.stopped).toEqual(vector.expect.stops);
        expect(vector.entries.length).toBe(vector.expect.stops.seq + 1);
      } else {
        expect(run.stopped).toBeNull();
        const head = run.before;
        expect(head && { list: head.list, head: { seq: head.body.seq, hash: head.hash }, first_signer: run.firstSigner }).toEqual(vector.expect.state);
      }
    });
  }

  test("every vector body that reads is written again to the same bytes, and shows its fields", () => {
    let read = 0;
    for (const vector of vectors) {
      for (const item of vector.entries) {
        const body = fromBase64Url(item.body);
        if (refusal(() => readBody(body)) !== "none") continue;
        read++;
        expect(writeBody(readBody(body))).toEqual(body);
        expect(writeFields(readFields(body))).toEqual(body);
        expect(readFields(body).map(({ name, value }) => [name, new TextDecoder().decode(value)])).toEqual(item.fields);
      }
    }
    expect(read).toBeGreaterThanOrEqual(vectors.length);
  });

  test("signature-high-s: its s is above n/2, and with the low s it is the same entry", async () => {
    const item = byName.get("signature-high-s")?.entries[1];
    if (!item) throw new Error("signature-high-s has no entry 1");
    const entry = entryFromText(item.text);
    const s = BigInt(`0x${bytesToHex(entry.signature.subarray(32))}`);
    expect(s > ORDER / 2n).toBe(true);
    const low = entry.signature.slice();
    low.set(hexToBytes((ORDER - s).toString(16).padStart(64, "0")), 32);
    const signer = readBody(entry.body).signer;
    expect(await verifySignature(entry.body, low, signer)).toBe(true);
    expect(entryHash(entry.body)).toBe(item.hash);
  });

  test("signer-off-curve: its signer is a key in form whose point is not on the curve", () => {
    const signer = new Map(byName.get("signer-off-curve")?.entries[1]?.fields ?? []).get("signer") ?? "";
    expect([isListKeyEncoding(signer), isListPoint(signer)]).toEqual([true, false]);
  });

  test("the two vectors of an entry that fails more than one check fail every check they name, and stop with the first", async () => {
    for (const [name, code, v] of [["prev-wrong-signature-bad", "chain_broken", "1"], ["v-zero-prev-wrong-signature-bad", "entry_malformed", "0"]] as const) {
      const vector = byName.get(name);
      const [zero, one] = vector?.entries ?? [];
      if (!vector || !zero || !one) throw new Error(`${name} has no entry 1`);
      const fields = new Map(one.fields);
      expect([name, vector.expect]).toEqual([name, { stops: { seq: 1, code } }]);
      expect([name, fields.get("v"), fields.get("prev") === zero.hash, isListHash(fields.get("prev") ?? "")]).toEqual([name, v, false, true]);
      expect([name, await verifySignature(fromBase64Url(one.body), fromBase64Url(one.signature), fields.get("signer") ?? "")]).toEqual([name, false]);
      expect([name, isListPoint(fields.get("signer") ?? "")]).toEqual([name, true]);
    }
  });

  test("body-at-limit and body-8193 are the limit and one byte more", () => {
    expect(fromBase64Url(byName.get("body-at-limit")?.entries[1]?.body ?? "").length).toBe(LIST_BODY_MAX);
    expect(fromBase64Url(byName.get("body-8193")?.entries[1]?.body ?? "").length).toBe(LIST_BODY_MAX + 1);
  });

  test("each vector key is a TEST ONLY key pair whose private half signs for its public half", async () => {
    for (const vector of vectors) {
      for (const [name, { pkcs8, spki }] of Object.entries(vector.keys)) {
        expect(name).toContain("TEST-ONLY");
        expect(isListKeyEncoding(spki)).toBe(true);
        const privateKey = await crypto.subtle.importKey("pkcs8", new Uint8Array(fromBase64Url(pkcs8)), P256, false, ["sign"]);
        const message = encoder.encode(vector.name);
        const signature = new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, message));
        expect(await verifySignature(message, signature, spki)).toBe(true);
      }
    }
  });
});

describe("reading a body (the field form)", () => {
  const good = raw(sevenPairs());

  test("the seven fields in order read, and are written again to the same bytes", () => {
    expect(bodyRefusal(good)).toBe("none");
    expect(writeBody(readBody(good))).toEqual(good);
  });

  test("another prefix", () => {
    const body = good.slice();
    body[10] = "2".charCodeAt(0);
    expect(bodyRefusal(body)).toBe("entry_malformed");
    expect(bodyRefusal(new Uint8Array())).toBe("entry_malformed");
  });

  test("the size limit and one byte more", () => {
    const pad = (size: number) => raw([...sevenPairs(), ["zz", "x".repeat(size - good.length - 4 - 2 - 4)]]);
    expect(pad(LIST_BODY_MAX).length).toBe(LIST_BODY_MAX);
    expect(bodyRefusal(pad(LIST_BODY_MAX))).toBe("none");
    expect(pad(LIST_BODY_MAX + 1).length).toBe(LIST_BODY_MAX + 1);
    expect(bodyRefusal(pad(LIST_BODY_MAX + 1))).toBe("entry_malformed");
  });

  test("cut inside a length, a name or a value; bytes after the last field", () => {
    for (const cut of [good.length - 1, 11 + 2, 11 + 4 + 3, 11 + 4 + 9 + 2]) expect(bodyRefusal(good.slice(0, cut))).toBe("entry_malformed");
    const lastValueCut = raw([...sevenPairs(), ["zz", "abc"]]);
    expect(bodyRefusal(lastValueCut)).toBe("none");
    expect(bodyRefusal(lastValueCut.slice(0, -1))).toBe("entry_malformed");
    expect(bodyRefusal(raw(sevenPairs(), [0]))).toBe("entry_malformed");
    expect(bodyRefusal(raw(sevenPairs(), [0, 0, 0, 0]))).toBe("entry_malformed");
  });

  test("the longest name and one byte more", () => {
    expect(bodyRefusal(raw([...sevenPairs(), [`z${"_".repeat(31)}`, "x"]]))).toBe("none");
    expect(bodyRefusal(raw([...sevenPairs(), [`z${"_".repeat(32)}`, "x"]]))).toBe("entry_malformed");
  });

  test("a name out of form", () => {
    for (const name of ["", "Note", "_note", "9note", "no-te", "nöte"]) expect(bodyRefusal(raw([[name, "x"], ...sevenPairs()]))).toBe("entry_malformed");
  });

  test("names out of order, a name twice, and a name that is the start of another", () => {
    expect(bodyRefusal(raw(sorted([...sevenPairs(), ["note", "a"], ["note_x", "b"]])))).toBe("none");
    expect(bodyRefusal(raw([...without(sevenPairs(), "v"), ["zz", "x"], ["v", "1"]]))).toBe("entry_malformed");
    expect(bodyRefusal(raw([...sevenPairs(), ["note_x", "b"], ["note", "a"]]))).toBe("entry_malformed");
    expect(bodyRefusal(raw([...sevenPairs(), ["v", "1"]]))).toBe("entry_malformed");
  });

  test("an empty value is a value", () => {
    expect(readBody(raw([...sevenPairs(), ["zz", ""]])).own).toEqual([{ name: "zz", value: new Uint8Array() }]);
  });
});

describe("the field form under another prefix", () => {
  const APPROVE = "ovis-list-approve/1";
  const pairs: Pairs = [["after", ""], ["at", "1767225600"], ["key", owner.key], ["list", "ab".repeat(32)]];

  test("a body under another prefix reads, and writes back to the same bytes", () => {
    const bytes = rawUnder(APPROVE, pairs);
    const fields = readFieldsUnder(APPROVE, bytes);
    expect(fields.map((field) => field.name)).toEqual(["after", "at", "key", "list"]);
    expect(writeFieldsUnder(APPROVE, fields)).toEqual(bytes);
    expect(writeFieldsUnder(APPROVE, [...fields].reverse())).toEqual(bytes);
  });

  test("the right fields under the wrong prefix", () => {
    const bytes = rawUnder(APPROVE, pairs);
    expect(refusal(() => readFieldsUnder("ovis-list-read/1", bytes))).toBe("entry_malformed");
    expect(refusal(() => readFieldsUnder("ovis-list-approve/2", bytes))).toBe("entry_malformed");
    expect(refusal(() => readFields(bytes))).toBe("entry_malformed");
    expect(refusal(() => readFieldsUnder(APPROVE, raw(pairs)))).toBe("entry_malformed");
    expect(refusal(() => readFieldsUnder(APPROVE, raw(sevenPairs())))).toBe("entry_malformed");
  });

  test("the same strictness: names in form and ascending, the end exactly after the last field", () => {
    expect(refusal(() => readFieldsUnder(APPROVE, rawUnder(APPROVE, [...pairs].reverse())))).toBe("entry_malformed");
    expect(refusal(() => readFieldsUnder(APPROVE, rawUnder(APPROVE, [["Key", "x"]])))).toBe("entry_malformed");
    expect(refusal(() => readFieldsUnder(APPROVE, rawUnder(APPROVE, pairs, [0])))).toBe("entry_malformed");
    expect(refusal(() => readFieldsUnder(APPROVE, rawUnder(APPROVE, pairs).slice(0, -1)))).toBe("entry_malformed");
    expect(refusal(() => writeFieldsUnder(APPROVE, [{ name: "at", value: new Uint8Array() }, { name: "at", value: new Uint8Array() }]))).toBe("entry_malformed");
  });

  test("the limit of 8192 bytes on the whole, under a longer prefix", () => {
    const padded = (size: number) => rawUnder(APPROVE, [["zz", "x".repeat(size - APPROVE.length - 4 - 2 - 4)]]);
    expect(padded(LIST_BODY_MAX).length).toBe(LIST_BODY_MAX);
    expect(readFieldsUnder(APPROVE, padded(LIST_BODY_MAX))).toHaveLength(1);
    expect(padded(LIST_BODY_MAX + 1).length).toBe(LIST_BODY_MAX + 1);
    expect(refusal(() => readFieldsUnder(APPROVE, padded(LIST_BODY_MAX + 1)))).toBe("entry_malformed");
    expect(refusal(() => writeFieldsUnder(APPROVE, [{ name: "zz", value: new Uint8Array(LIST_BODY_MAX - APPROVE.length - 9) }]))).toBe("entry_malformed");
  });
});

describe("a v1 account record (docs/account.md, Records) and an entry", () => {
  const unsignedRecord: UnsignedAccountRecord = {
    v: 1, kind: "add", account: "acct_1", key: other.key, label: "Phone", role: "drive", issued_at: "2026-11-05T01:02:03.456Z", id: newRecordId(), signer: owner.key,
  };

  test("a v1 record offered as an entry is refused by its prefix", async () => {
    const record = await signAccountRecord(unsignedRecord, owner.pair.privateKey);
    const body = recordSigningBytes(unsignedRecord);
    expect(new TextDecoder().decode(body.subarray(0, ACCOUNT_RECORD_PREFIX.length))).toBe(ACCOUNT_RECORD_PREFIX);
    const offered: Entry = { body, signature: fromBase64Url(record.signature) };
    expect(await verifySignature(body, offered.signature, owner.key)).toBe(true);
    expect(refusal(() => readBody(body))).toBe("entry_malformed");
    expect(await asyncRefusal(() => entryHolds(entryFromText(entryToText(offered)), null))).toBe("entry_malformed");
  });

  test("an entry offered where a v1 record is read is refused there", async () => {
    const text = entryToText(genesis);
    await expect(readAccountRecord(text)).rejects.toBeInstanceOf(AccountRecordError);
    await expect(readAccountRecord({ body: toBase64Url(genesis.body), signature: toBase64Url(genesis.signature) })).rejects.toBeInstanceOf(AccountRecordError);
    // the entry's signature on a record of its signer: the record's bytes start with ovis-account/1, the entry's with ovis-list/1
    expect(await verifySignature(genesis.body, genesis.signature, owner.key)).toBe(true);
    expect(await readAccountRecord({ ...unsignedRecord, signature: toBase64Url(genesis.signature) })).toBeNull();
  });
});

describe("the fields every entry carries", () => {
  test("each of the seven missing", () => {
    for (const [name] of sevenPairs()) expect(bodyRefusal(raw(without(sevenPairs(), name)))).toBe("entry_malformed");
  });

  test("numbers: 0, a leading zero, the longest and one digit more, a sign, empty", () => {
    expect(readBody(raw(set(sevenPairs(), "issued_at", "0"))).issued_at).toBe(0);
    expect(readBody(raw(set(sevenPairs(), "issued_at", "9".repeat(15)))).issued_at).toBe(999_999_999_999_999);
    for (const value of ["00", "01", "1".repeat(16), "-1", "+1", "1.0", "", " 1", "1e3"]) {
      expect(bodyRefusal(raw(set(sevenPairs(), "issued_at", value)))).toBe("entry_malformed");
      expect(bodyRefusal(raw(set(sevenPairs(), "seq", value)))).toBe("entry_malformed");
    }
    expect(bodyRefusal(raw(set(sevenPairs(), "v", "0")))).toBe("entry_malformed");
    expect(isListNumber("0") && isListNumber("10") && !isListNumber("010")).toBe(true);
  });

  test("kind: the longest and one byte more, empty, out of form", () => {
    expect(bodyRefusal(raw(set(sevenPairs(), "kind", "k".repeat(32))))).toBe("none");
    for (const value of ["k".repeat(33), "", "Genesis", "_genesis"]) expect(bodyRefusal(raw(set(sevenPairs(), "kind", value)))).toBe("entry_malformed");
    expect(isListName("a_") && !isListName("a".repeat(33))).toBe(true);
  });

  test("list and prev: a hash or empty; an uppercase hash, one digit short", () => {
    const hash = "ab".repeat(32);
    expect(bodyRefusal(raw(set(set(sevenPairs(), "list", hash), "prev", hash)))).toBe("none");
    for (const name of ["list", "prev"]) {
      for (const value of [hash.toUpperCase(), hash.slice(1), `${hash}0`, "g".repeat(64)]) expect(bodyRefusal(raw(set(sevenPairs(), name, value)))).toBe("entry_malformed");
    }
    expect(isListHash(hash) && !isListHash(hash.toUpperCase())).toBe(true);
  });

  test("a key: a second spelling, another prefix, padding, one character short", () => {
    const bytes = fromBase64Url(owner.key);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastIndex = alphabet.indexOf(owner.key.slice(-1));
    const second = owner.key.slice(0, -1) + alphabet[lastIndex ^ 1];
    expect(fromBase64Url(second)).toEqual(bytes);
    const otherPrefix = bytes.slice();
    otherPrefix[24] = 0x08;
    const otherPoint = bytes.slice();
    otherPoint[26] = 0x02;
    expect(isListKeyEncoding(owner.key)).toBe(true);
    for (const value of [second, toBase64Url(otherPrefix), toBase64Url(otherPoint), `${owner.key}==`, owner.key.slice(0, -1), `${owner.key.slice(0, 60)}+${owner.key.slice(61)}`]) {
      expect(isListKeyEncoding(value)).toBe(false);
      expect(bodyRefusal(raw(set(sevenPairs(), "signer", value)))).toBe("entry_malformed");
    }
  });

  test("adds and power together or not at all; power full or bound; ends a key", () => {
    const withAdds = (power: string): Pairs => sorted([...sevenPairs(), ["adds", other.key], ["power", power]]);
    expect(readBody(raw(withAdds("full"))).adds).toEqual({ key: other.key, power: "full" });
    expect(readBody(raw(withAdds("bound"))).adds).toEqual({ key: other.key, power: "bound" });
    expect(bodyRefusal(raw(withAdds("admin")))).toBe("entry_malformed");
    expect(bodyRefusal(raw(without(withAdds("full"), "power")))).toBe("entry_malformed");
    expect(bodyRefusal(raw(without(withAdds("full"), "adds")))).toBe("entry_malformed");
    expect(bodyRefusal(raw(sorted([...sevenPairs(), ["adds", "x"], ["power", "full"]])))).toBe("entry_malformed");
    expect(readBody(raw(sorted([...sevenPairs(), ["ends", other.key]]))).ends).toBe(other.key);
    expect(bodyRefusal(raw(sorted([...sevenPairs(), ["ends", ""]])))).toBe("entry_malformed");
  });

  test("a kind's own field is judged by its name, never its value", () => {
    const value = Uint8Array.from([0, 255, 0xc3, 0x28]);
    expect(readBody(raw([...sevenPairs(), ["zz", value]])).own).toEqual([{ name: "zz", value }]);
  });
});

describe("writing a body", () => {
  test("writes the one form, names ascending whatever the order given", () => {
    const body = writeBody({ ...genesisBody, own: [{ name: "zeta", value: encoder.encode("z") }, { name: "alpha", value: encoder.encode("a") }] });
    expect(readFields(body).map((field) => field.name)).toEqual(["alpha", "issued_at", "kind", "list", "prev", "seq", "signer", "v", "zeta"]);
    expect(writeBody(readBody(body))).toEqual(body);
  });

  test("refuses fields no entry can hold", () => {
    for (const changes of [{ seq: 1.5 }, { seq: -1 }, { issued_at: 1e16 }, { v: 0 }, { kind: "" }, { signer: "x" }, { list: "AB" }]) {
      expect(refusal(() => writeBody({ ...genesisBody, ...changes }))).toBe("entry_malformed");
    }
    expect(refusal(() => writeBody({ ...genesisBody, own: [{ name: "seq", value: encoder.encode("1") }] }))).toBe("entry_malformed");
    expect(refusal(() => writeBody({ ...genesisBody, own: [{ name: "zz", value: new Uint8Array(LIST_BODY_MAX) }] }))).toBe("entry_malformed");
  });

  test("refuses a field of the envelope passed through own", async () => {
    const field = (name: string, value: string) => ({ name, value: encoder.encode(value) });
    for (const own of [[field("adds", other.key), field("power", "full")], [field("ends", other.key)]]) {
      const names = own.map(({ name }) => name);
      expect([names, refusal(() => writeBody(nextBody({ own })))]).toEqual([names, "entry_malformed"]);
      expect([names, await asyncRefusal(() => signEntry(nextBody({ own }), owner.pair.privateKey))]).toEqual([names, "entry_malformed"]);
    }
    expect(refusal(() => writeBody(nextBody({ own: [field("note", "x")] })))).toBe("none");
  });

  test("a body above the limit is refused by its size, before anything of that size is allocated", () => {
    // A value that says it is longer than any buffer can be: a body allocated for it is a RangeError, and no refusal.
    const value = Object.defineProperty(new Uint8Array(1), "length", { value: Number.MAX_SAFE_INTEGER });
    expect(refusal(() => writeFields([{ name: "zz", value }]))).toBe("entry_malformed");
    expect(refusal(() => writeBody({ ...genesisBody, own: [{ name: "zz", value }] }))).toBe("entry_malformed");
  });
});

describe("the entry hash and the list id", () => {
  test("SHA-256 over ovis-list-entry/1 and the body, in lowercase hex", () => {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(encoder.encode("ovis-list-entry/1"));
    hasher.update(genesis.body);
    expect(entryHash(genesis.body)).toBe(hasher.digest("hex"));
    expect(isListHash(entryHash(genesis.body))).toBe(true);
  });

  test("the list id is entry 0's hash, whatever its signature", async () => {
    const again = await signEntry(genesisBody, owner.pair.privateKey);
    expect(again.signature).not.toEqual(genesis.signature);
    const { first, signer } = await firstState(again);
    expect(first.list).toBe(entryHash(genesis.body));
    expect(first.hash).toBe(first.list);
    expect(signer).toBe(owner.key);
  });
});

describe("the signature", () => {
  const sValue = (signature: Uint8Array) => BigInt(`0x${bytesToHex(signature.subarray(32))}`);
  const withS = (signature: Uint8Array, s: bigint) => {
    const out = signature.slice();
    out.set(hexToBytes(s.toString(16).padStart(64, "0")), 32);
    return out;
  };

  test("a high s counts", async () => {
    const s = sValue(genesis.signature);
    const flipped = withS(genesis.signature, ORDER - s);
    expect(await verifySignature(genesis.body, flipped, owner.key)).toBe(true);
    expect(sValue(s > ORDER / 2n ? genesis.signature : flipped) > ORDER / 2n).toBe(true);
    expect((await entryHolds({ body: genesis.body, signature: flipped }, null)).hash).toBe(held0.hash);
  });

  test("r or s of 0 or of n verify nothing", async () => {
    const zeroR = genesis.signature.slice();
    zeroR.fill(0, 0, 32);
    expect(await verifySignature(genesis.body, zeroR, owner.key)).toBe(false);
    expect(await verifySignature(genesis.body, withS(genesis.signature, 0n), owner.key)).toBe(false);
    expect(await verifySignature(genesis.body, withS(genesis.signature, ORDER), owner.key)).toBe(false);
  });

  test("r and s are judged from 1 to n-1 by the library itself", () => {
    const scalar = (value: bigint) => hexToBytes(value.toString(16).padStart(64, "0"));
    const one = scalar(1n);
    const values: [bigint, boolean][] = [[0n, false], [1n, true], [ORDER - 1n, true], [ORDER, false], [ORDER + 1n, false], [2n ** 256n - 1n, false]];
    for (const [value, inRange] of values) {
      expect([value, signatureInRange(Uint8Array.from([...scalar(value), ...one]))]).toEqual([value, inRange]);
      expect([value, signatureInRange(Uint8Array.from([...one, ...scalar(value)]))]).toEqual([value, inRange]);
    }
    expect(signatureInRange(new Uint8Array(63).fill(1))).toBe(false);
  });

  test("a runtime that accepts any r and s still verifies nothing outside 1 to n-1", async () => {
    const lenient = spyOn(crypto.subtle, "verify").mockResolvedValue(true);
    try {
      const outside = [0n, ORDER].map((value) => withS(genesis.signature, value));
      for (const signature of outside) expect(await verifySignature(genesis.body, signature, owner.key)).toBe(false);
      expect(await verifySignature(genesis.body, genesis.signature, owner.key)).toBe(true);
    } finally {
      lenient.mockRestore();
    }
  });

  test("a changed byte, a signature by another key", async () => {
    expect(await asyncRefusal(() => entryHolds(genesis, null))).toBe("none");
    const changed = genesis.signature.slice();
    changed[5] = (changed[5] ?? 0) ^ 1;
    expect(await asyncRefusal(() => entryHolds({ body: genesis.body, signature: changed }, null))).toBe("signature_invalid");
    const byOther = await signRaw(genesis.body, other.pair);
    expect(await asyncRefusal(() => entryHolds(byOther, null))).toBe("signature_invalid");
    const body = writeBody({ ...genesisBody, issued_at: 1767225601 });
    expect(await asyncRefusal(() => entryHolds({ body, signature: genesis.signature }, null))).toBe("signature_invalid");
  });

  test("whether a key's point is on the curve is judged by the library itself: X and Y below p, and Y² = X³ - 3X + b", () => {
    const atOne = 0x09e78d4ef60d05f750f6636209092bc43cbdd6b47e11a9de20a9feb2a50bb96cn;
    const atZero = 0x66485c780e2f83d72433bd5d84a06bb6541c2af31dae871728bf856a174f93f4n;
    const points: [bigint, bigint, boolean][] = [
      [atOne, 1n, true], [atOne, FIELD - 1n, true], [0n, atZero, true], [0n, FIELD - atZero, true],
      [atOne, FIELD + 1n, false], [FIELD, atZero, false],
      [atOne, 2n, false], [atOne + 1n, 1n, false], [0n, 0n, false], [0n, 1n, false], [1n, 1n, false], [FIELD - 1n, FIELD - 1n, false], [2n ** 256n - 1n, 2n ** 256n - 1n, false],
    ];
    for (const [x, y, on] of points) {
      const key = keyOf(x, y);
      expect([x, y, isListKeyEncoding(key), isListPoint(key)]).toEqual([x, y, true, on]);
      if (x < FIELD && y < FIELD) expect([x, y, onCurveElsewhere(x, y)]).toEqual([x, y, on]);
    }
    expect([isListPoint(owner.key), isListPoint(other.key)]).toEqual([true, true]);
    for (const text of ["", "not-a-key", owner.key.slice(0, 121), `${owner.key}A`, `${owner.key.slice(0, 121)}+`]) expect([text, isListPoint(text)]).toEqual([text, false]);
  });

  test("on fresh keys, and on each with one bit of its point changed, the library and another one agree about the curve", async () => {
    let on = 0;
    for (let round = 0; round < 12; round++) {
      const [x, y] = pointOf((await newKey()).key);
      const changed: [bigint, bigint][] = [[x, y], [x ^ 1n, y], [x, y ^ 1n], [x ^ (1n << 255n), y], [x, y ^ (1n << 200n)], [y, x]];
      for (const [cx, cy] of changed) {
        if (cx >= FIELD || cy >= FIELD) continue;
        const elsewhere = onCurveElsewhere(cx, cy);
        expect([cx, cy, isListPoint(keyOf(cx, cy))]).toEqual([cx, cy, elsewhere]);
        if (elsewhere) on++;
      }
    }
    expect(on).toBeGreaterThanOrEqual(12);
  });

  describe("on many points, the library, another library and the runtime agree about the curve", () => {
    const drawn = (label: string, index: number) => BigInt(`0x${bytesToHex(sha256(new TextEncoder().encode(`${label} ${index}`)))}`);
    async function runtimeTakes(key: string): Promise<boolean> {
      try {
        await crypto.subtle.importKey("spki", new Uint8Array(fromBase64Url(key)), P256, false, ["verify"]);
        return true;
      } catch (error) {
        if (!(error instanceof DOMException)) throw error;
        return false;
      }
    }
    async function agreed(x: bigint, y: bigint): Promise<boolean> {
      const key = keyOf(x, y);
      const here = isListPoint(key);
      if (x < FIELD && y < FIELD) expect([x, y, here]).toEqual([x, y, onCurveElsewhere(x, y)]);
      expect([x, y, here]).toEqual([x, y, await runtimeTakes(key)]);
      return here;
    }

    test("3000 points of the curve, from as many scalars: each is one, and so is its negation", async () => {
      let points = 0;
      for (let index = 0; index < 3000; index++) {
        const { x, y } = p256.Point.BASE.multiply(1n + (drawn("scalar", index) % (ORDER - 1n))).toAffine();
        if (await agreed(x, y)) points++;
        if (index < 300 && (await agreed(x, FIELD - y))) points++;
      }
      expect(points).toBe(3300);
    }, 60_000);

    test("each of 300 points with one thing changed, and 1000 pairs of numbers drawn at will: none is a point, but where the other library says so too", async () => {
      let points = 0, others = 0;
      for (let index = 0; index < 300; index++) {
        const { x, y } = p256.Point.BASE.multiply(1n + (drawn("scalar", index) % (ORDER - 1n))).toAffine();
        const changed: [bigint, bigint][] = [[x, (y + 1n) % FIELD], [(x + 1n) % FIELD, y], [x ^ (1n << BigInt(index % 256)), y], [x, y ^ (1n << BigInt(index % 256))], [y, x]];
        for (const [cx, cy] of changed) {
          if (await agreed(cx, cy)) points++;
          others++;
        }
      }
      for (let index = 0; index < 1000; index++) {
        if (await agreed(drawn("x", index), drawn("y", index))) points++;
        others++;
      }
      expect([points, others]).toEqual([0, 2500]);
    }, 60_000);

    test("the edges: the generator and its negation, the two points with X 0, coordinates at 0, at p - 1, at p and at the top of 32 bytes", async () => {
      const { x: gx, y: gy } = p256.Point.BASE.toAffine();
      const atZero = 0x66485c780e2f83d72433bd5d84a06bb6541c2af31dae871728bf856a174f93f4n;
      const top = 2n ** 256n - 1n;
      const edges: [bigint, bigint, boolean][] = [
        [gx, gy, true], [gx, FIELD - gy, true], [0n, atZero, true], [0n, FIELD - atZero, true],
        [gx, gy + 1n, false], [gx, gy - 1n, false], [gx + 1n, gy, false], [gy, gx, false], [gx, 0n, false], [0n, gy, false],
        [0n, 0n, false], [0n, 1n, false], [1n, 0n, false], [1n, 1n, false], [FIELD - 1n, 0n, false], [0n, FIELD - 1n, false], [FIELD - 1n, FIELD - 1n, false],
        [FIELD, atZero, false], [0n, FIELD, false], [FIELD, FIELD, false], [top, gy, false], [gx, top, false], [top, top, false],
      ];
      for (const [x, y, on] of edges) expect([x, y, await agreed(x, y)]).toEqual([x, y, on]);
    });

    test("1000 texts that are no key in its one spelling name no point", () => {
      const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const text = (index: number, length: number) => {
        let out = "";
        for (let block = 0; out.length < length; block++) {
          let bits = drawn("text", index * 1000 + block);
          for (let at = 0; at < 40 && out.length < length; at++, bits >>= 6n) out += letters[Number(bits % 64n)] ?? "A";
        }
        return out;
      };
      const real = owner.key;
      let texts = 0;
      for (let index = 0; index < 250; index++) {
        const at = index % 36;
        const other = letters[(letters.indexOf(real[at] ?? "A") + 1 + (index % 62)) % 64] ?? "A";
        for (const candidate of [text(index, 122), text(index, (index * 7) % 250), `${real.slice(0, at)}${other}${real.slice(at + 1)}`, `${real.slice(0, 40 + index % 80)}+${real.slice(41 + index % 80)}`]) {
          if (candidate === real) continue;
          expect([candidate, isListKeyEncoding(candidate), isListPoint(candidate)]).toEqual([candidate, false, false]);
          texts++;
        }
      }
      expect(texts).toBe(1000);
    });
  });

  test("a signer whose point is off the curve, or that is no key, verifies nothing, and the runtime is not asked", async () => {
    const offCurve = keyOf(0n, 1n);
    expect([isListKeyEncoding(offCurve), isListPoint(offCurve)]).toEqual([true, false]);
    const entry = await signRaw(raw(set(sevenPairs(), "signer", offCurve)));
    const asked = spyOn(crypto.subtle, "importKey");
    try {
      expect(await verifySignature(entry.body, entry.signature, offCurve)).toBe(false);
      expect(await asyncRefusal(() => entryHolds(entry, null))).toBe("signature_invalid");
      for (const signer of ["", "not-a-key", owner.key.slice(0, 121)]) expect([signer, await verifySignature(genesis.body, genesis.signature, signer)]).toEqual([signer, false]);
      expect(asked).not.toHaveBeenCalled();
      expect(await verifySignature(genesis.body, genesis.signature, owner.key)).toBe(true);
      expect(asked).toHaveBeenCalledTimes(1);
    } finally {
      asked.mockRestore();
    }
  });

  test("a runtime that takes any key and any signature still verifies nothing for a signer off the curve", async () => {
    const key = await crypto.subtle.importKey("spki", new Uint8Array(fromBase64Url(owner.key)), P256, false, ["verify"]);
    const takesAny = spyOn(crypto.subtle, "importKey").mockResolvedValue(key);
    const lenient = spyOn(crypto.subtle, "verify").mockResolvedValue(true);
    try {
      expect(await verifySignature(genesis.body, genesis.signature, keyOf(0n, 1n))).toBe(false);
      expect(await verifySignature(genesis.body, genesis.signature, owner.key)).toBe(true);
    } finally {
      lenient.mockRestore();
      takesAny.mockRestore();
    }
  });

  test("a runtime without WebCrypto is a fault, not a signature that does not verify", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    if (!original) throw new Error("this runtime has no crypto global");
    Object.defineProperty(globalThis, "crypto", { configurable: true, writable: true, value: { getRandomValues: crypto.getRandomValues.bind(crypto) } });
    try {
      await expect(verifySignature(genesis.body, genesis.signature, owner.key)).rejects.toBeInstanceOf(Error);
      await expect(entryHolds(genesis, null)).rejects.not.toBeInstanceOf(ListEntryError);
    } finally {
      Object.defineProperty(globalThis, "crypto", original);
    }
    expect(await verifySignature(genesis.body, genesis.signature, owner.key)).toBe(true);
  });

  test("whatever the runtime throws for a key is a fault, a DOMException too: no runtime's kind of error says that a signature does not verify", async () => {
    const faults = [new TypeError("crypto.subtle.importKey failed"), new DOMException("The key is not of the expected type", "DataError"), new DOMException("P-256 is not supported", "NotSupportedError")];
    for (const fault of faults) {
      const broken = spyOn(crypto.subtle, "importKey").mockRejectedValue(fault);
      try {
        await expect(verifySignature(genesis.body, genesis.signature, owner.key)).rejects.toBe(fault);
        await expect(entryHolds(genesis, null)).rejects.toBe(fault);
      } finally {
        broken.mockRestore();
      }
    }
    expect(await verifySignature(genesis.body, genesis.signature, owner.key)).toBe(true);
  });

  test("a signature of another length has not the form", async () => {
    expect(await asyncRefusal(() => entryHolds({ body: genesis.body, signature: genesis.signature.subarray(0, 63) }, null))).toBe("entry_malformed");
  });

  test("what is verified is the bytes as they were handed over, whatever the caller does to them while the key is imported", async () => {
    const unsigned = genesis.signature.slice();
    unsigned[5] = (unsigned[5] ?? 0) ^ 1;
    for (const [handed, after, verdict] of [[genesis.signature, new Uint8Array(64), true], [unsigned, genesis.signature, false]] as const) {
      const signature = handed.slice();
      const body = genesis.body.slice();
      const pending = verifySignature(body, signature, owner.key);
      signature.set(after);
      if (verdict) body.fill(0);
      expect([verdict, await pending]).toEqual([verdict, verdict]);
    }
  });
});

describe("when an entry holds", () => {
  test("entry 0 and entry 1 hold; the next is checked against the one before", async () => {
    const one = await entryHolds(await signEntry(nextBody(), owner.pair.privateKey), held0);
    expect(one.list).toBe(held0.hash);
    const two = await entryHolds(await signEntry(nextBody({ seq: 2, prev: one.hash }), owner.pair.privateKey), one);
    expect(two.list).toBe(held0.hash);
  });

  test("a wrong seq", async () => {
    expect(await asyncRefusal(async () => entryHolds(await signEntry({ ...genesisBody, seq: 1 }, owner.pair.privateKey), null))).toBe("chain_broken");
    for (const seq of [0, 2]) {
      expect(await asyncRefusal(async () => entryHolds(await signEntry(nextBody({ seq }), owner.pair.privateKey), held0))).toBe("chain_broken");
    }
  });

  test("a wrong prev, a wrong list", async () => {
    const elsewhere = entryHash(raw([["other", "list"]]));
    for (const changes of [{ prev: elsewhere }, { prev: "" }, { list: elsewhere }, { list: "" }]) {
      expect(await asyncRefusal(async () => entryHolds(await signEntry(nextBody(changes), owner.pair.privateKey), held0))).toBe("chain_broken");
    }
  });

  test("an entry of another list", async () => {
    const otherZero = await entryHolds(await signEntry({ ...genesisBody, signer: other.key }, other.pair.privateKey), null);
    const ofOther = await signEntry(nextBody({ list: otherZero.list, prev: otherZero.hash, signer: other.key }), other.pair.privateKey);
    expect(await asyncRefusal(() => entryHolds(ofOther, otherZero))).toBe("none");
    expect(await asyncRefusal(() => entryHolds(ofOther, held0))).toBe("chain_broken");
  });

  test("entry 0 with a list or a prev, or carrying adds or ends", async () => {
    const hash = "ab".repeat(32);
    for (const changes of [{ list: hash }, { prev: hash }, { adds: { key: other.key, power: "full" as const } }, { ends: other.key }]) {
      expect(await asyncRefusal(async () => entryHolds(await signEntry({ ...genesisBody, ...changes }, owner.pair.privateKey), null))).toBe("chain_broken");
    }
  });

  test("given a list id, only the entry with that hash is entry 0", async () => {
    expect((await firstState(genesis, held0.hash)).signer).toBe(owner.key);
    expect(await asyncRefusal(() => firstState(genesis, "ab".repeat(32)))).toBe("list_mismatch");
  });

  test("an entry that fails more than one check takes the name of the first; list_mismatch is only for an entry 0 that holds by all three", async () => {
    const elsewhere = entryHash(raw([["other", "list"]]));
    const given = "ab".repeat(32);
    const two = await signEntry(nextBody({ prev: elsewhere }), other.pair.privateKey);
    expect(await asyncRefusal(() => entryHolds(two, held0))).toBe("chain_broken");
    const onePairs = set(set(set(set(set(sevenPairs(), "kind", "remove"), "list", held0.list), "prev", elsewhere), "seq", "1"), "v", "0");
    expect(await asyncRefusal(async () => entryHolds(await signRaw(raw(onePairs), other.pair), held0))).toBe("entry_malformed");
    expect(await asyncRefusal(async () => entryHolds(await signRaw(raw(set(onePairs, "prev", held0.hash)), other.pair), held0))).toBe("entry_malformed");
    expect(await asyncRefusal(async () => firstState(await signRaw(raw(set(sevenPairs(), "v", "0"))), given))).toBe("entry_malformed");
    expect(await asyncRefusal(async () => firstState(await signEntry({ ...genesisBody, prev: elsewhere }, owner.pair.privateKey), given))).toBe("chain_broken");
    expect(await asyncRefusal(async () => firstState(await signRaw(genesis.body, other.pair), given))).toBe("signature_invalid");
    expect(await asyncRefusal(() => firstState(genesis, given))).toBe("list_mismatch");
  });

  test("a body out of form stops before the chain and the signature are looked at", async () => {
    const entry = await signRaw(raw(set(sevenPairs(), "seq", "01")));
    expect(await asyncRefusal(() => entryHolds(entry, null))).toBe("entry_malformed");
  });

  test("the held entry is of the bytes as they were shown, whatever the caller does to its buffers while the signature is checked", async () => {
    const note = encoder.encode("as shown");
    const signed = await signEntry({ ...genesisBody, own: [{ name: "note", value: note }] }, owner.pair.privateKey);
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    // The caller's buffers as a plain Uint8Array, and as Node's Buffer, whose slice() is a view of the same memory.
    for (const [kind, buffer] of [["Uint8Array", (bytes: Uint8Array) => bytes.slice()], ["Buffer", (bytes: Uint8Array) => Buffer.from(bytes)]] as const) {
      const shown: Entry = { body: buffer(signed.body), signature: buffer(signed.signature) };
      const changing = spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
        const verified = await verify(...args);
        shown.body.fill(0);
        shown.signature.fill(0);
        return verified;
      });
      try {
        const held = await entryHolds(shown, null);
        expect([kind, shown.body.some((byte) => byte !== 0), shown.signature.some((byte) => byte !== 0)]).toEqual([kind, false, false]);
        expect([kind, held.hash]).toEqual([kind, entryHash(signed.body)]);
        expect([kind, held.entry]).toEqual([kind, signed]);
        expect([kind, held.body.own]).toEqual([kind, [{ name: "note", value: note }]]);
      } finally {
        changing.mockRestore();
      }
    }
  });

  test("the state an entry is held against is read once: changed while the signature is checked, it changes nothing that comes back", async () => {
    const one = await signEntry(nextBody(), owner.pair.privateKey);
    const elsewhere = "f".repeat(64);
    const before = { ...held0 };
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    const changing = spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
      const verified = await verify(...args);
      before.list = elsewhere;
      before.hash = elsewhere;
      before.body = { ...before.body, seq: 7 };
      return verified;
    });
    let held: HeldEntry;
    try {
      held = await entryHolds(one, before);
    } finally {
      changing.mockRestore();
    }
    expect([before.list, held.list, held.body.list, held.hash, held.body.seq]).toEqual([elsewhere, held0.list, held0.list, entryHash(one.body), 1]);
    const two = (list: string) => signEntry(nextBody({ seq: 2, list, prev: held.hash }), owner.pair.privateKey);
    expect(await asyncRefusal(async () => entryHolds(await two(elsewhere), held))).toBe("chain_broken");
    expect(await asyncRefusal(async () => entryHolds(await two(held0.list), held))).toBe("none");
  });

  test("the entry it is shown is read once: one whose body or signature reads otherwise a second time is held as it first read", async () => {
    const second = { body: new Uint8Array(LIST_BODY_MAX + 1), signature: genesis.signature.subarray(0, 63) };
    const shownOnce = (part: "body" | "signature"): Entry => {
      let read = 0;
      return Object.defineProperty({ ...genesis }, part, { get: () => (read++ === 0 ? genesis[part] : second[part]) });
    };
    for (const part of ["body", "signature"] as const) {
      expect([part, await asyncRefusal(() => entryHolds(shownOnce(part), null))]).toEqual([part, "none"]);
      expect([part, await entryHolds(shownOnce(part), null)]).toEqual([part, held0]);
    }
  });

  test("a body that says it is above the limit is refused by that size, before a byte of it is read", async () => {
    // The bytes of an entry that holds, under a length of 64 MiB: only a check of the size, made first, refuses them.
    const body = Object.defineProperty(genesis.body.slice(), "length", { value: 64 * 1024 * 1024 });
    expect(await asyncRefusal(() => entryHolds({ body, signature: genesis.signature }, null))).toBe("entry_malformed");
  });
});

describe("an entry's text", () => {
  const text = entryToText(genesis);
  const [bodyPart = "", signaturePart = ""] = text.split(".");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const secondSpelling = (part: string) => part.slice(0, -1) + alphabet[alphabet.indexOf(part.slice(-1)) ^ 1];

  test("an entry and its text, both ways", () => {
    expect(signaturePart.length).toBe(86);
    expect(entryFromText(text)).toEqual({ body: genesis.body, signature: genesis.signature });
    expect(JSON.parse(JSON.stringify({ entry: text })).entry).toBe(text);
  });

  test("refusals", () => {
    expect(genesis.body.length % 3).not.toBe(0);
    const cases = [
      bodyPart + signaturePart,
      `${bodyPart}.${signaturePart}.`,
      `${bodyPart}..${signaturePart}`,
      `.${signaturePart}`,
      `${bodyPart}.`,
      `${bodyPart}+.${signaturePart}`,
      `${bodyPart.slice(0, -1)}/.${signaturePart}`,
      `${bodyPart}.${signaturePart.slice(0, -1)}*`,
      `${bodyPart}=.${signaturePart}`,
      `${bodyPart}.${signaturePart}==`,
      `${bodyPart} .${signaturePart}`,
      ` ${text}`,
      `${text}\n`,
      `${text} `,
      `${bodyPart}.${signaturePart.slice(0, 85)}`,
      `${bodyPart}.${signaturePart}A`,
      `${secondSpelling(bodyPart)}.${signaturePart}`,
      `${bodyPart}.${secondSpelling(signaturePart)}`,
    ];
    for (const value of cases) expect([value, refusal(() => entryFromText(value))]).toEqual([value, "entry_malformed"]);
  });

  test("the body part is judged by the field form, the size limit included", async () => {
    const signature = toBase64Url(genesis.signature);
    const big = (size: number) => raw([...sevenPairs(), ["zz", "x".repeat(size - raw(sevenPairs()).length - 4 - 2 - 4)]]);
    expect(await asyncRefusal(() => entryHolds(entryFromText(`${toBase64Url(big(LIST_BODY_MAX))}.${signature}`), null))).toBe("signature_invalid");
    expect(await asyncRefusal(async () => entryHolds(entryFromText(`${toBase64Url(big(LIST_BODY_MAX + 1))}.${signature}`), null))).toBe("entry_malformed");
    expect(await asyncRefusal(async () => entryHolds(entryFromText(`${toBase64Url(raw(sevenPairs(), [0]))}.${signature}`), null))).toBe("entry_malformed");
  });
});
