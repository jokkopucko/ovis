import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_ORDER_FILE, AccountOrder } from "./account-order.ts";
import { legacyOrigin } from "./admission-order.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const dir = () => { const made = mkdtempSync(join(tmpdir(), "s2-24-order-")); dirs.push(made); return made; };
const read = (account: string, ...listed: [string, number][]) => ({ account, server_id: "pc", version: 1, devices: listed.map(([key, no]) => ({ key, no })), removed: [] });

describe("S2-24 the account's order as this PC's whole reads saw it (P21)", () => {
  test("P21: a key first seen with a number not above the highest seen is late; a new highest is not; the table survives a restart", () => {
    const at = dir();
    const order = AccountOrder.open(at);
    order.record(read("acct_1", ["k1", 1], ["k2", 2], ["k5", 5]), "binding");
    expect(["k1", "k2", "k5"].map((key) => order.late(key))).toEqual([false, false, false]);
    order.record(read("acct_1", ["k1", 1], ["k3", 3], ["k5", 5], ["k6", 6]), "binding");
    expect({ k3: order.late("k3"), k6: order.late("k6"), no: order.no("k3") }).toEqual({ k3: true, k6: false, no: 3 });
    const again = AccountOrder.open(at);
    expect({ k3: again.late("k3"), unknown: again.late("k9"), none: again.no("k9") }).toEqual({ k3: true, unknown: false, none: null });
  });

  test("P21: another account starts a new table", () => {
    const order = AccountOrder.open(dir());
    order.record(read("acct_1", ["k5", 5]), "binding");
    order.record(read("acct_2", ["k3", 3]), "binding");
    expect(order.late("k3")).toBe(false);
  });

  test("P21: a watermark below a persisted pin makes the table unusable", async () => {
    const at = dir();
    AccountOrder.open(at).record(read("acct_1", ["k5", 5]), "binding");
    const file = Bun.file(join(at, ACCOUNT_ORDER_FILE));
    await Bun.write(file, JSON.stringify({ ...await file.json(), max_no: 4 }));
    const reopened = AccountOrder.open(at);
    expect(reopened.late("k5")).toBe(true);
    expect(() => reopened.record(read("acct_1", ["k3", 3]), "binding")).toThrow();
  });

  test("P21: a legacy first admission stays joined at zero across re-admission and restart", async () => {
    const at = dir();
    const order = AccountOrder.open(at);
    order.recordJoins([{ relay_public_key: "k1", origin: legacyOrigin("2026-11-01T00:00:00.000Z") }]);
    order.record(read("acct_1", ["k1", 2]), "binding");
    order.recordJoins([{ relay_public_key: "k1", origin: { admit_no: 7 } }]);
    const reopened = AccountOrder.open(at);
    expect(reopened.problem).toBeNull();
    expect(reopened.no("k1")).toBe(2);
    expect((await Bun.file(join(at, ACCOUNT_ORDER_FILE)).json()).keys.k1.joined).toBe(0);
  });
});
