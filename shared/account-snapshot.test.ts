import { describe, expect, test } from "bun:test";
import { accountDeviceId, exportAccountKey, newRecordId, signSafetyRecord } from "./account-records.ts";
import { ACCOUNT_ROWS_MAX, AccountSnapshotError, SNAPSHOT_PAGE_MAX, assembleSnapshot, parseAccountDevicesFile, parseAdmissionOrigin, parseSnapshotPage, type AccountSnapshotPage, parseUsedReport } from "./account-snapshot.ts";

async function key() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { pair, spki: await exportAccountKey(pair.publicKey) };
}

const [older, newer, gone] = [await key(), await key(), await key()];
const serverId = "0123456789abcdef0123456789abcdef";
const at = "2026-11-05T01:02:03.456Z";
const block = await signSafetyRecord({ v: 1, kind: "block", account: "acct_1", target: newer.spki, target_no: 2, signer: older.spki, signer_no: 1, signed_at: at, nonce: newRecordId() }, older.pair.privateKey);
const lift = await signSafetyRecord({ v: 1, kind: "lift", account: "acct_1", target: block.id, signer: older.spki, signer_no: 1, signed_at: at }, older.pair.privateKey);

function page(overrides: Partial<AccountSnapshotPage> = {}): AccountSnapshotPage {
  return {
    v: 1, snapshot: "a".repeat(32), account: "acct_1", server_id: serverId, version: 7, methods_version: 2, page: 0, last: true,
    devices: [{ key: older.spki, no: 1, eligible: true, label: "Phone" }, { key: newer.spki, no: 2, eligible: false, label: "Laptop" }],
    removed: [{ key: gone.spki, no: 3 }], blocks: [block], lifts: [lift], freezes: [{ block: block.id, target: newer.spki, after: 2 }],
    ...overrides,
  };
}

const expected = { account: "acct_1", server_id: serverId, lastApplied: 7 };

describe("account snapshot pages (device table P6, G1)", () => {
  test("a page survives JSON and one page is a whole read", () => {
    const read = parseSnapshotPage(JSON.parse(JSON.stringify({ ...page(), extra: 1 })));
    expect(read).toEqual({ ...page(), devices: page().devices.map((device) => ({ ...device, two_step: "unknown" })) });
    const whole = assembleSnapshot([read], expected);
    expect({ snapshot: whole.snapshot, version: whole.version, methods_version: whole.methods_version, devices: whole.devices.map((d) => d.no), removed: whole.removed.map((r) => r.no), blocks: whole.blocks.map((b) => b.id) })
      .toEqual({ snapshot: "a".repeat(32), version: 7, methods_version: 2, devices: [1, 2], removed: [3], blocks: [block.id] });
  });

  test.each([
    ["recognized values", { two_step: "set", provider: "google" }, { two_step: "set", provider: "google" }],
    ["missing values", {}, { two_step: "unknown" }],
    ["unrecognized values", { two_step: "garbage", provider: "garbage" }, { two_step: "unknown" }],
  ] as const)("a device entry normalizes %s without refusing the page", (_scenario, fields, normalized) => {
    const device = { key: older.spki, no: 1, eligible: true, label: "Phone" };
    expect(parseSnapshotPage({ ...page(), devices: [{ ...device, ...fields }] }).devices).toEqual([{ ...device, ...normalized }]);
  });

  test("pages of one snapshot join in order", () => {
    const first = page({ last: false, devices: page().devices.slice(0, 1) });
    const second = page({ page: 1, devices: page().devices.slice(1), removed: [], blocks: [], lifts: [], freezes: [] });
    expect(assembleSnapshot([first, second], expected).devices.map((d) => d.no)).toEqual([1, 2]);
  });

  test("a read that is not one snapshot, not ended, or older is refused", () => {
    const first = page({ last: false, devices: page().devices.slice(0, 1) });
    const second = page({ page: 1, devices: page().devices.slice(1), removed: [], blocks: [], lifts: [], freezes: [] });
    const refused: [AccountSnapshotPage[], typeof expected][] = [
      [[], expected],
      [[first, { ...second, snapshot: "b".repeat(32) }], expected],
      [[first, { ...second, version: 8 }], expected],
      [[first, { ...second, methods_version: 3 }], expected],
      [[first], expected],
      [[second, first], expected],
      [[{ ...first, last: true }, second], expected],
      [[page()], { ...expected, lastApplied: 8 }],
      [[page()], { ...expected, account: "acct_2" }],
      [[page()], { ...expected, server_id: "f".repeat(32) }],
      [[page({ removed: [{ key: older.spki, no: 3 }] })], expected],
      [[page({ removed: [{ key: gone.spki, no: 2 }] })], expected],
    ];
    for (const [pages, against] of refused) expect(() => assembleSnapshot(pages, against)).toThrow(AccountSnapshotError);
  });

  test("malformed pages are refused, and a missing part is not an empty one", () => {
    const { removed: _removed, ...noRemoved } = page();
    const bad: unknown[] = [
      null, noRemoved, { ...page(), v: 2 }, { ...page(), snapshot: "A".repeat(32) }, { ...page(), version: 0 }, { ...page(), methods_version: -1 }, { ...page(), methods_version: 1.5 },
      { ...page(), page: -1 }, { ...page(), devices: [{ key: older.spki, no: 0, eligible: true, label: "Phone" }] },
      { ...page(), devices: [{ key: "nope", no: 1, eligible: true, label: "Phone" }] }, { ...page(), blocks: [lift] }, { ...page(), lifts: [block] },
      { ...page(), freezes: [{ block: block.id, target: newer.spki, after: 0 }] }, { ...page(), blocks: [{ ...block, id: "c".repeat(64) }] },
    ];
    for (const value of bad) expect(() => parseSnapshotPage(value)).toThrow();
  });

  test("a page holds one account's records only, and a bad nested record is a bad page (P6)", async () => {
    const elsewhere = await signSafetyRecord({ v: 1, kind: "block", account: "acct_2", target: newer.spki, target_no: 2, signer: older.spki, signer_no: 1, signed_at: at, nonce: newRecordId() }, older.pair.privateKey);
    const liftElsewhere = await signSafetyRecord({ v: 1, kind: "lift", account: "acct_2", target: elsewhere.id, signer: older.spki, signer_no: 1, signed_at: at }, older.pair.privateKey);
    for (const value of [page({ blocks: [elsewhere] }), page({ lifts: [liftElsewhere] }), { ...page(), blocks: [null] }, { ...page(), lifts: [{ ...lift, id: "c".repeat(64) }] }]) {
      expect(() => parseSnapshotPage(value)).toThrow(AccountSnapshotError);
    }
  });

  test("every list of a page is bounded; the service pages longer ones", () => {
    const many = <T>(entry: T) => Array.from({ length: SNAPSHOT_PAGE_MAX + 1 }, () => entry);
    const full = page({ devices: Array.from({ length: SNAPSHOT_PAGE_MAX }, () => page().devices[0]!) });
    expect(parseSnapshotPage(full).devices.length).toBe(SNAPSHOT_PAGE_MAX);
    const over = [
      page({ devices: many(page().devices[0]!) }), page({ removed: many(page().removed[0]!) }), page({ blocks: many(block) }),
      page({ lifts: many(lift) }), page({ freezes: many(page().freezes[0]!) }),
    ];
    for (const value of over) expect(() => parseSnapshotPage(value)).toThrow(AccountSnapshotError);
  });
});

describe("account-devices.json (device table S21, S25, P22)", () => {
  const row = {
    id: accountDeviceId(serverId, newer.spki), key: newer.spki, no: 2, label: "Laptop",
    origin: { from: "remote", how: "list", by: null, admit_no: 4, at }, confirmed_at: at, last_signin_day: "2026-11-05", state: "hold", hold_until: at,
  };
  const file = { v: 1, account: "acct_1", server_id: serverId, snapshot: "a".repeat(32), version: 7, devices: [row] };

  test("an origin from pc is a key confirm on this PC's screen: a code, digits or a QR, a confirmed row, or a confirmed replacement (P22, T68, T72)", () => {
    for (const how of ["code", "digits", "qr", "confirmed", "link"]) {
      const origin = { from: "pc", how, by: null, admit_no: 1, at };
      expect(parseAdmissionOrigin(origin)).toEqual(origin as never);
    }
    for (const how of ["list", "add", "member", "promoted", "legacy"]) expect(() => parseAdmissionOrigin({ from: "pc", how, by: null, admit_no: 1, at })).toThrow(AccountSnapshotError);
  });

  test("ovis recover --admit lets in a pending redemption: from recover only with a code, digits or a QR (P22, T70)", () => {
    for (const how of ["code", "digits", "qr"]) {
      const origin = { from: "recover", how, by: null, admit_no: 1, at };
      expect(parseAdmissionOrigin(origin)).toEqual(origin as never);
    }
    for (const how of ["list", "add", "member", "promoted", "confirmed", "link"]) expect(() => parseAdmissionOrigin({ from: "recover", how, by: null, admit_no: 1, at })).toThrow(AccountSnapshotError);
  });

  test("a row from before the upgrade is stamped admit_no 0, older than every admission; nothing else is (T50)", () => {
    const legacy = { from: "legacy", how: "legacy", by: null, admit_no: 0, at };
    expect(parseAdmissionOrigin(legacy)).toEqual(legacy as never);
    for (const origin of [{ ...legacy, admit_no: -1 }, { ...legacy, from: "remote", how: "list" }, { ...legacy, from: "pc", how: "code" }]) {
      expect(() => parseAdmissionOrigin(origin)).toThrow(AccountSnapshotError);
    }
  });

  test("an account-joined row has the id its key gives on this PC and came in from the list (S21)", () => {
    const bad = [
      { ...row, id: "0123456789abcdef" }, { ...row, id: accountDeviceId("f".repeat(32), newer.spki) },
      { ...row, origin: { ...row.origin, from: "pc", how: "code" } }, { ...row, origin: { ...row.origin, how: "add" } },
    ];
    for (const entry of bad) expect(() => parseAccountDevicesFile({ ...file, devices: [entry] })).toThrow(AccountSnapshotError);
  });

  test("a file survives JSON", () => {
    expect(parseAccountDevicesFile(JSON.parse(JSON.stringify(file)))).toEqual(file as never);
  });

  test("a held row has its deadline, or none while its notice is not yet durably published (T34, P17)", () => {
    for (const hold_until of [at, null]) {
      const held = { ...file, devices: [{ ...row, hold_until }] };
      expect(parseAccountDevicesFile(JSON.parse(JSON.stringify(held)))).toEqual(held as never);
    }
    for (const state of ["live", "expired"]) expect(() => parseAccountDevicesFile({ ...file, devices: [{ ...row, state, hold_until: at }] })).toThrow(AccountSnapshotError);
  });

  test("the cleared file has no account, no snapshot and no rows, and only together (T44)", () => {
    const cleared = { ...file, account: null, snapshot: null, devices: [] };
    expect(parseAccountDevicesFile(JSON.parse(JSON.stringify(cleared)))).toEqual(cleared as never);
    const bad = [
      { ...cleared, devices: [row] }, { ...cleared, account: "acct_1" }, { ...cleared, snapshot: "a".repeat(32) },
      { ...file, account: null }, { ...file, snapshot: null }, { ...file, account: null, devices: [] },
    ];
    for (const value of bad) expect(() => parseAccountDevicesFile(value)).toThrow(AccountSnapshotError);
  });

  test("a malformed file or row is refused", () => {
    const bad: unknown[] = [
      { ...file, v: 2 }, { ...file, devices: [row, row] }, { ...file, devices: [{ ...row, extra: 1 }] },
      { ...file, devices: [{ ...row, state: "live" }] }, { ...file, devices: [{ ...row, hold_until: "soon" }] },
      { ...file, devices: [{ ...row, origin: { ...row.origin, from: "list" } }] }, { ...file, devices: [{ ...row, origin: { ...row.origin, admit_no: 0 } }] },
      { ...file, devices: [{ ...row, origin: { ...row.origin, by: "someone" } }] }, { ...file, devices: [{ ...row, last_signin_day: "5 Nov" }] },
      { ...file, devices: [{ ...row, last_signin_day: "2026-02-31" }] },
      // P22: `pc` is only a key confirmed on this PC's screen, by a code, digits or a QR; `legacy` goes with `legacy`
      { ...file, devices: [{ ...row, origin: { ...row.origin, from: "pc", how: "list" } }] }, { ...file, devices: [{ ...row, origin: { ...row.origin, from: "pc", how: "link" } }] },
      { ...file, devices: [{ ...row, origin: { ...row.origin, from: "legacy", how: "list" } }] }, { ...file, devices: [{ ...row, origin: { ...row.origin, from: "remote", how: "legacy" } }] },
      { ...file, devices: Array.from({ length: ACCOUNT_ROWS_MAX + 1 }, (_, i) => ({ ...row, id: i.toString(16).padStart(16, "0") })) },
    ];
    for (const value of bad) expect(() => parseAccountDevicesFile(value)).toThrow(AccountSnapshotError);
  });
});

describe("a whole read names each record once and every freeze line's block (device table P6, P16, G12)", () => {
  test("G1: a block or a lift repeated across pages is refused", () => {
    const first = page({ last: false, devices: page().devices.slice(0, 1) });
    for (const repeat of [{ blocks: [block], lifts: [], freezes: [] }, { blocks: [], lifts: [lift], freezes: [] }]) {
      const second = page({ page: 1, devices: page().devices.slice(1), removed: [], ...repeat });
      expect(() => assembleSnapshot([first, second], expected)).toThrow(AccountSnapshotError);
    }
  });

  test("G12: a freeze line whose block is in neither the snapshot nor this PC's known blocks is refused", () => {
    const orphan = page({ blocks: [], lifts: [] });
    expect(() => assembleSnapshot([orphan], expected)).toThrow(AccountSnapshotError);
    expect(assembleSnapshot([orphan], { ...expected, knownBlocks: new Set([block.id]) }).freezes).toEqual(orphan.freezes);
  });
});

describe("the days a PC saw each key used (device table P9, section 5, T54)", () => {
  test("P9: a used report is a list of a key and a real UTC day, each key once, at most a page of them", () => {
    const report = [{ key: older.spki, day: "2026-11-20" }, { key: newer.spki, day: "2026-09-22" }];
    expect(parseUsedReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
    expect(parseUsedReport([])).toEqual([]);
    for (const bad of [
      null, {}, [{ key: older.spki }], [{ key: older.spki, day: "2026-02-30" }], [{ key: "not-a-key", day: "2026-11-20" }],
      [{ key: older.spki, day: "2026-11-20", at: 1 }], [{ key: older.spki, day: "2026-11-20" }, { key: older.spki, day: "2026-11-19" }],
      Array.from({ length: SNAPSHOT_PAGE_MAX + 1 }, () => ({ key: older.spki, day: "2026-11-20" })),
    ]) expect(() => parseUsedReport(bad)).toThrow(AccountSnapshotError);
  });
});
