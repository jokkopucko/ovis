import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_LIST_VOUCHES_FILE, ListVouches, VOUCH_LISTS_MAX, VOUCHES_PER_LIST_MAX } from "./list-vouches.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const folder = () => { const dir = mkdtempSync(join(tmpdir(), "ovis-vouches-")); dirs.push(dir); return dir; };

const SCOPE = { serverId: "0123456789abcdef0123456789abcdef", bindId: "ab".repeat(16) };
const list = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const vouch = (n: number) => ({ key: `member-${n}`, device: `signin-${n}` });

describe("the vouches a PC keeps for the lists devices named to it", () => {
  test("kept per list, on disk (0600), for this binding alone; another server's on the same folder are kept beside them", () => {
    const dir = folder();
    const one = new ListVouches(dir);
    expect(one.keep(SCOPE, list(1), [vouch(1)])).toBe("kept");
    const other = new ListVouches(dir);
    expect(other.keep(SCOPE, list(1), [vouch(2)])).toBe("kept");
    // the first server's next write reads the file first: nothing the other kept is lost
    expect(one.keep(SCOPE, list(1), [vouch(1), vouch(3)])).toBe("kept");
    expect(new ListVouches(dir).of(SCOPE, list(1))).toEqual([vouch(1), vouch(2), vouch(3)]);
    if (process.platform !== "win32") expect(statSync(join(dir, ACCOUNT_LIST_VOUCHES_FILE)).mode & 0o777).toBe(0o600);
    // another binding's vouches are none of this one's, and the next write replaces them
    const later = { ...SCOPE, bindId: "cd".repeat(16) };
    expect(new ListVouches(dir).of(later, list(1))).toEqual([]);
    expect(new ListVouches(dir).keep(later, list(2), [vouch(4)])).toBe("kept");
    expect(new ListVouches(dir).of(SCOPE, list(1))).toEqual([]);
  });

  test("at most four lists and 64 vouches a list: a fifth list is refused, and nothing kept is pushed out by a caller", () => {
    const dir = folder();
    const vouches = new ListVouches(dir);
    for (let n = 1; n <= VOUCH_LISTS_MAX; n++) expect(vouches.keep(SCOPE, list(n), [])).toBe("kept");
    expect(vouches.keep(SCOPE, list(9), [vouch(1)])).toBe("full");
    expect(vouches.of(SCOPE, list(9))).toEqual([]);
    expect(vouches.keep(SCOPE, list(1), Array.from({ length: VOUCHES_PER_LIST_MAX + 10 }, (_, n) => vouch(n)))).toBe("full");
    expect(vouches.of(SCOPE, list(1))).toHaveLength(VOUCHES_PER_LIST_MAX);
    expect(vouches.keep(SCOPE, list(1), [vouch(500)])).toBe("full");
    expect(vouches.of(SCOPE, list(1)).some((one) => one.key === "member-500")).toBe(false);
    // once the PC follows one of them, the others go
    vouches.keepOnly(SCOPE, list(1));
    expect([vouches.of(SCOPE, list(2)), vouches.keep(SCOPE, list(9), [])]).toEqual([[], "kept"]);
  });

  test("a link whose sign-in key this PC holds a removal against is kept past the cap; any other past it is refused, never dropped unsaid", () => {
    const dir = folder();
    const vouches = new ListVouches(dir);
    const removed = (device: string) => device.startsWith("removed-");
    expect(vouches.keep(SCOPE, list(1), Array.from({ length: VOUCHES_PER_LIST_MAX }, (_, n) => vouch(n)), removed)).toBe("kept");
    // full: a link that holds a device out still goes in, and says it was kept
    expect(vouches.keep(SCOPE, list(1), [{ key: "member-x", device: "removed-x" }], removed)).toBe("kept");
    expect(vouches.of(SCOPE, list(1)).some((one) => one.device === "removed-x")).toBe(true);
    // one that only says a device is known here does not, and the caller is told
    expect(vouches.keep(SCOPE, list(1), [vouch(500)], removed)).toBe("full");
    expect(vouches.of(SCOPE, list(1)).some((one) => one.key === "member-500")).toBe(false);
    // what is kept already is no news, and is no refusal
    expect(vouches.keep(SCOPE, list(1), [vouch(1)], removed)).toBe("kept");
  });

  test("a file that does not read is no vouches and is replaced; the file goes when the binding goes", () => {
    const dir = folder();
    writeFileSync(join(dir, ACCOUNT_LIST_VOUCHES_FILE), "{not json");
    const vouches = new ListVouches(dir);
    expect(vouches.of(SCOPE, list(1))).toEqual([]);
    expect(vouches.keep(SCOPE, list(1), [vouch(1)])).toBe("kept");
    expect(JSON.parse(readFileSync(join(dir, ACCOUNT_LIST_VOUCHES_FILE), "utf8"))).toMatchObject({ v: 1, server_id: SCOPE.serverId, bind_id: SCOPE.bindId });
    vouches.forget();
    expect(existsSync(join(dir, ACCOUNT_LIST_VOUCHES_FILE))).toBe(false);
  });
});
