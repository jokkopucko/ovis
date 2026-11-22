import { describe, expect, test } from "bun:test";
import { accountRouteAction, accountRowMay, type AccountCaller, type RowAction } from "./account-row-rights.ts";

const self: AccountCaller = { rowId: "row-self", key: "k-self", state: "live", mayRevoke: id => id === "row-self" || id === "row-newer" };
const held: AccountCaller = { ...self, state: "hold" };

const verdicts = (caller: AccountCaller, actions: readonly RowAction[]) => actions.map((action) => ({ action: action.action, verdict: accountRowMay(caller, action) }));

describe("S2-26 what an account-joined row may do (T36, T37, T40, R3 to R10)", () => {
  test("T36: an account-joined row can sign only its own remove, without a hold blocking leave", () => {
    expect(accountRowMay(self, { action: "remove", key: "k-self" })).toEqual({ ok: true });
    expect(accountRowMay(held, { action: "remove", key: "k-self" })).toEqual({ ok: true });
    expect(accountRowMay(self, { action: "remove", key: "k-newer" })).toEqual({ refused: "not_yours" });
    expect(accountRowMay(self, { action: "add" })).toEqual({ refused: "not_yours" });
  });

  test("T37: ordered row Revoke works and Revoke all remains local for both row types", () => {
    expect(accountRowMay(self, { action: "revoke", rowId: "row-self" })).toEqual({ ok: true });
    expect(accountRowMay(held, { action: "revoke", rowId: "row-self" })).toEqual({ ok: true });
    expect(accountRowMay(self, { action: "revoke", rowId: "row-newer" })).toEqual({ ok: true });
    expect(accountRowMay(self, { action: "revoke", rowId: "row-other" })).toEqual({ refused: "older_device" });
    expect(accountRowMay(self, { action: "revoke_all" })).toEqual({ refused: "local_required" });
  });

  test("T40: the route policy refuses an account-joined link", () => {
    expect(accountRowMay(self, { action: "link" })).toEqual({ refused: "link_not_owner" });
  });

  test("R3: account-joined label is writable only on self", () => {
    expect(verdicts(self, [{ action: "label", rowId: "row-self" }, { action: "label", rowId: "row-other" }])).toEqual([
      { action: "label", verdict: { ok: true } },
      { action: "label", verdict: { refused: "not_yours" } },
    ]);
  });

  test("R4: account-joined cannot start or cancel pairing", () => {
    for (const action of ["pair_start", "pair_cancel"] as const) expect(accountRowMay(self, { action })).toEqual({ refused: "member_required" });
  });

  test("R5: account-joined cannot enroll, approve or change relay account", () => {
    for (const action of ["enroll", "approve", "relay_account"] as const) expect(accountRowMay(self, { action })).toEqual({ refused: "member_required" });
  });

  test("R6: records: its own leave, and a block or lift only of a key newer than its own", () => {
    expect(accountRowMay(self, { action: "block", targetNewer: true })).toEqual({ ok: true });
    expect(accountRowMay(self, { action: "block", targetNewer: false })).toEqual({ refused: "older_device" });
    expect(accountRowMay(self, { action: "lift", targetNewer: true })).toEqual({ ok: true });
    expect(accountRowMay(self, { action: "lift", targetNewer: false })).toEqual({ refused: "older_device" });
    // a row in its join hold signs nothing but its own leave
    expect(accountRowMay(held, { action: "block", targetNewer: true })).toEqual({ refused: "join_hold" });
  });

  test("R7: account-joined local machine stays usable without cross-PC routing", () => {
    expect(accountRowMay(self, { action: "route", machine: "local" })).toEqual({ ok: true });
    expect(accountRowMay(self, { action: "route", machine: "other-pc" })).toEqual({ refused: "local_only" });
  });

  test("R8 and R10: lock, unlock and the other screen acts are local only", () => {
    for (const action of ["lock", "unlock", "leave_account", "forget", "confirm"] as const) expect(accountRowMay(self, { action })).toEqual({ refused: "local_required" });
  });

  test("R9: push ends with the row and webhook is refused", () => {
    expect(accountRowMay(self, { action: "push_subscribe" })).toEqual({ ok: true });
    expect(accountRowMay(self, { action: "webhook" })).toEqual({ refused: "member_required" });
  });
});

describe("S2-26 representative account route mappings (R1 to R10)", () => {
  test("R1 to R10: the routes map to their actions; unregistered routes have no action", () => {
    const cases: [string, string, RowAction | null][] = [
      ["PATCH", "/api/devices/aaaaaaaaaaaaaaaa", { action: "label", rowId: "aaaaaaaaaaaaaaaa" }],
      ["DELETE", "/api/devices/aaaaaaaaaaaaaaaa", { action: "revoke", rowId: "aaaaaaaaaaaaaaaa" }],
      ["POST", "/api/devices/revoke-all", { action: "revoke_all" }],
      ["POST", "/api/devices/pair/start", { action: "pair_start" }],
      ["POST", "/api/devices/pair/cancel", { action: "pair_cancel" }],
      ["POST", "/api/account/link", { action: "link" }],
      ["POST", "/api/account/enroll", { action: "enroll" }],
      ["POST", "/api/account/relay-account", { action: "relay_account" }],
      ["POST", "/api/alerts/webhook", { action: "webhook" }],
      ["GET", "/api/machines/other-pc/api/sessions", { action: "route", machine: "other-pc" }],
      ["GET", "/api/machines/local/api/sessions", { action: "route", machine: "local" }],
      ["POST", "/api/push/subscribe", { action: "push_subscribe" }],
      ["GET", "/api/sessions", null],
    ];
    for (const [method, path, action] of cases) expect({ method, path, action: accountRouteAction(method, path) }).toEqual({ method, path, action });
  });
});
