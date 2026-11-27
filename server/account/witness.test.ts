import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateStateFs } from "../private-state.ts";
import { ACCOUNT_WITNESS_FILE, AccountWitness, WITNESS_INTERVAL_MS, type WitnessedRow, type WitnessRecord } from "./witness.ts";

const ACCOUNT = "acct_1a2b3c4d5e6f";
const SERVER = "a".repeat(32);
const PHONE = "phone-key";
const TABLET = "tablet-key";
const T0 = 1_795_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A PC's record with clocks a test moves: `wall` is the clock a person can set, `mono` the time the process itself ran. */
function recording(stateDir = mkdtempSync(join(tmpdir(), "witness-"))) {
  if (!dirs.includes(stateDir)) dirs.push(stateDir);
  const world = {
    wall: T0, mono: 5_000,
    scope: { account: ACCOUNT as string | null, serverId: SERVER } as { account: string | null; serverId: string } | null,
    rows: [] as WitnessedRow[] | null,
  };
  const witness = new AccountWitness({ stateDir, scope: () => world.scope, rows: () => world.rows, wall: () => world.wall, mono: () => world.mono });
  const path = join(stateDir, ACCOUNT_WITNESS_FILE);
  return {
    stateDir, world, witness, path,
    /** Both clocks move together, as they do while nobody sets the wall clock. */
    pass(ms: number) { world.wall += ms; world.mono += ms; witness.step(); },
    file: () => JSON.parse(readFileSync(path, "utf8")) as WitnessRecord,
  };
}
const lets = (key: string, seen: number | null = null): WitnessedRow => ({ key, lets: true, seen });
const waits = (key: string): WitnessedRow => ({ key, lets: false, seen: null });

describe("the record of how long this PC has let each key in through its account", () => {
  test("a key enters at nothing when its row first lets it in, and both counters grow with the time it stays in", () => {
    const made = recording();
    made.witness.step();
    expect(made.file()).toEqual({ v: 1, account: ACCOUNT, server_id: SERVER, saved: T0 / 1000, keys: {} });
    made.world.rows = [lets(PHONE, 1_794_990_000)];
    made.pass(MINUTE);
    expect(made.file().keys).toEqual({ [PHONE]: { wall: 0, ran: 0, seen: 1_794_990_000 } });
    made.pass(4 * MINUTE);
    made.pass(4 * MINUTE);
    expect(made.file()).toMatchObject({ saved: (T0 + 9 * MINUTE) / 1000, keys: { [PHONE]: { wall: 480, ran: 480, seen: 1_794_990_000 } } });
    // a key that comes later starts at nothing, beside the first
    made.world.rows = [lets(PHONE, 1_794_990_000), lets(TABLET)];
    made.pass(MINUTE);
    made.pass(MINUTE);
    expect(made.file().keys).toEqual({ [PHONE]: { wall: 600, ran: 600, seen: 1_794_990_000 }, [TABLET]: { wall: 60, ran: 60, seen: null } });
  });

  test("the file is the owner's alone to read, and the record answers what it holds", () => {
    const made = recording();
    made.world.rows = [lets(PHONE)];
    made.witness.step();
    made.pass(MINUTE);
    if (process.platform !== "win32") expect(statSync(made.path).mode & 0o777).toBe(0o600);
    expect(made.witness.record()).toEqual(made.file());
  });

  test("the wall clock set forward gives a key the time the PC ran and a minute, never the jump; set back, it takes nothing away", () => {
    const made = recording();
    made.world.rows = [lets(PHONE)];
    made.witness.step();
    // a PC with no clock chip gets its time a minute after it started: the clock jumps two days
    made.world.wall += 48 * HOUR;
    made.world.mono += MINUTE;
    made.witness.step();
    expect(made.file().keys[PHONE]).toMatchObject({ wall: 120, ran: 60 });
    made.world.wall -= 12 * HOUR;
    made.world.mono += MINUTE;
    made.witness.step();
    expect(made.file().keys[PHONE]).toMatchObject({ wall: 120, ran: 120 });
  });

  test("across a restart the time the PC was off counts by the wall clock, a day at most, and not as time it ran", () => {
    const made = recording();
    made.world.rows = [lets(PHONE)];
    made.witness.step();
    made.pass(HOUR);
    made.witness.stop();
    expect(made.file().keys[PHONE]).toMatchObject({ wall: 3600, ran: 3600 });
    // off for three hours
    const again = recording(made.stateDir);
    again.world.wall = T0 + 4 * HOUR;
    again.world.rows = [lets(PHONE)];
    again.witness.step();
    expect(again.file()).toMatchObject({ saved: (T0 + 4 * HOUR) / 1000, keys: { [PHONE]: { wall: 4 * 3600, ran: 3600 } } });
    again.witness.stop();
    // off for a month: one day counts
    const late = recording(made.stateDir);
    late.world.wall = T0 + 4 * HOUR + 30 * 24 * HOUR;
    late.world.rows = [lets(PHONE)];
    late.witness.step();
    expect(late.file().keys[PHONE]).toMatchObject({ wall: 4 * 3600 + 86_400, ran: 3600 });
    late.witness.stop();
    // a clock that stands before the last write at the next start gives nothing
    const back = recording(made.stateDir);
    back.world.wall = T0;
    back.world.rows = [lets(PHONE)];
    back.witness.step();
    expect(back.file().keys[PHONE]).toMatchObject({ wall: 4 * 3600 + 86_400, ran: 3600 });
  });

  test("a row that only waits is no break and counts no time; one that stops standing leaves, and starts at nothing when it is let in again", () => {
    const made = recording();
    made.world.rows = [lets(PHONE), lets(TABLET)];
    made.witness.step();
    made.pass(HOUR);
    // the phone's row waits for a whole read (after a start, or while the account service is away)
    made.world.rows = [waits(PHONE), lets(TABLET)];
    made.pass(HOUR);
    made.pass(HOUR);
    expect(made.file().keys).toMatchObject({ [PHONE]: { wall: 3600, ran: 3600 }, [TABLET]: { wall: 3 * 3600, ran: 3 * 3600 } });
    made.world.rows = [lets(PHONE), lets(TABLET)];
    made.pass(HOUR);
    made.pass(HOUR);
    expect(made.file().keys[PHONE]).toMatchObject({ wall: 2 * 3600, ran: 2 * 3600 });
    // the account stops naming the tablet: no record of it stays
    made.world.rows = [lets(PHONE)];
    made.witness.step();
    expect(Object.keys(made.file().keys)).toEqual([PHONE]);
    made.world.rows = [lets(PHONE), lets(TABLET)];
    made.pass(HOUR);
    expect(made.file().keys[TABLET]).toEqual({ wall: 0, ran: 0, seen: null });
  });

  test("rows that cannot be read change nothing and count no time", () => {
    const made = recording();
    made.world.rows = [lets(PHONE)];
    made.witness.step();
    made.pass(HOUR);
    made.world.rows = null;
    made.pass(HOUR);
    expect(made.file().keys[PHONE]).toMatchObject({ wall: 3600, ran: 3600 });
    made.world.rows = [lets(PHONE)];
    made.pass(HOUR);
    made.pass(HOUR);
    expect(made.file().keys[PHONE]).toMatchObject({ wall: 2 * 3600, ran: 2 * 3600 });
  });

  test("the record goes with the account and the relay identity: another of either starts it anew, and a PC in no account keeps none", () => {
    const made = recording();
    made.world.rows = [lets(PHONE)];
    made.witness.step();
    made.pass(HOUR);
    // a relay identity that is not known yet (the start) is no word that it changed
    made.world.scope = null;
    made.pass(MINUTE);
    expect(made.file().keys[PHONE]).toMatchObject({ wall: 3600, ran: 3600 });
    made.world.scope = { account: ACCOUNT, serverId: "b".repeat(32) };
    made.pass(MINUTE);
    expect(made.file()).toMatchObject({ server_id: "b".repeat(32), keys: { [PHONE]: { wall: 0, ran: 0 } } });
    made.pass(HOUR);
    made.world.scope = { account: "acct_other0000001", serverId: "b".repeat(32) };
    made.pass(MINUTE);
    expect(made.file()).toMatchObject({ account: "acct_other0000001", keys: { [PHONE]: { wall: 0, ran: 0 } } });
    // out of every account: the file goes with the binding
    made.world.scope = { account: null, serverId: "b".repeat(32) };
    made.world.rows = [];
    made.pass(MINUTE);
    expect(existsSync(made.path)).toBe(false);
    expect(made.witness.record()).toBeNull();
    // and a restart under another identity does not take the old file's keys over
    const other = recording();
    other.world.rows = [lets(PHONE)];
    other.witness.step();
    other.pass(HOUR);
    other.witness.stop();
    const reset = recording(other.stateDir);
    reset.world.scope = { account: ACCOUNT, serverId: "c".repeat(32) };
    reset.world.wall = T0 + 2 * HOUR;
    reset.world.rows = [lets(PHONE)];
    reset.witness.step();
    expect(reset.file()).toMatchObject({ server_id: "c".repeat(32), keys: { [PHONE]: { wall: 0, ran: 0 } } });
  });

  test("a file that does not read as the record starts it anew: that only delays", () => {
    for (const text of ["{", JSON.stringify({ v: 2, account: ACCOUNT, server_id: SERVER, saved: T0 / 1000, keys: {} }),
      JSON.stringify({ v: 1, account: ACCOUNT, server_id: SERVER, saved: T0 / 1000, keys: { [PHONE]: { wall: -1, ran: 0, seen: null } } }),
      JSON.stringify({ v: 1, account: ACCOUNT, server_id: SERVER, saved: T0 / 1000, keys: { [PHONE]: { wall: 90_000, ran: "90000", seen: null } } })]) {
      const made = recording();
      writeFileSync(made.path, text);
      made.world.rows = [lets(PHONE)];
      made.witness.step();
      expect(made.file().keys).toEqual({ [PHONE]: { wall: 0, ran: 0, seen: null } });
    }
  });

  test("a write that fails loses nothing the PC still runs with: the next one holds the whole time", () => {
    const made = recording();
    made.world.rows = [lets(PHONE)];
    made.witness.step();
    const failing = spyOn(privateStateFs, "renameSync").mockImplementation(() => { throw new Error("disk full"); });
    const said = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      made.pass(HOUR);
      made.pass(HOUR);
      expect(made.file().keys[PHONE]).toMatchObject({ wall: 0, ran: 0 });
      // said once, not at every interval
      expect(said).toHaveBeenCalledTimes(1);
    } finally { failing.mockRestore(); said.mockRestore(); }
    made.pass(HOUR);
    expect(made.file().keys[PHONE]).toMatchObject({ wall: 3 * 3600, ran: 3 * 3600 });
  });

  test("rows that throw when they are read break nothing: the record says so once and goes on", () => {
    const made = recording();
    made.world.rows = [lets(PHONE)];
    made.witness.step();
    const rows = made.world.rows;
    const said = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      Object.defineProperty(made.world, "rows", { configurable: true, get() { throw new Error("no rows"); } });
      made.pass(HOUR);
      made.pass(HOUR);
      expect(said).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(made.world, "rows", { configurable: true, writable: true, value: rows });
      said.mockRestore();
    }
    made.pass(HOUR);
    made.pass(HOUR);
    expect(made.file().keys[PHONE]).toMatchObject({ wall: 3600, ran: 3600 });
  });

  test("time in which the rows could not be read is not given back as time the PC was off at the next start", () => {
    const made = recording();
    made.world.rows = [lets(PHONE)];
    made.witness.step();
    made.pass(HOUR);
    // the rows stop reading for five hours, and the PC is then restarted within a minute
    made.world.rows = null;
    for (let hour = 0; hour < 5; hour++) made.pass(HOUR);
    made.witness.stop();
    expect(made.file()).toMatchObject({ saved: (T0 + 6 * HOUR) / 1000, keys: { [PHONE]: { wall: 3600, ran: 3600 } } });
    const again = recording(made.stateDir);
    again.world.wall = T0 + 6 * HOUR + MINUTE;
    again.world.rows = [lets(PHONE)];
    again.witness.step();
    expect(again.file().keys[PHONE]).toMatchObject({ wall: 3600 + 60, ran: 3600 });
  });

  test("a record that could not be deleted when the PC left its account is deleted at a later step", () => {
    const made = recording();
    made.world.rows = [lets(PHONE)];
    made.witness.step();
    made.world.scope = { account: null, serverId: SERVER };
    made.world.rows = [];
    const failing = spyOn(privateStateFs, "unlinkSync").mockImplementation(() => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); });
    const said = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      made.pass(MINUTE);
      made.pass(MINUTE);
      expect(existsSync(made.path)).toBe(true);
      expect(said).toHaveBeenCalledTimes(1);
    } finally { failing.mockRestore(); said.mockRestore(); }
    made.pass(MINUTE);
    expect(existsSync(made.path)).toBe(false);
    // and a file that is already gone is no failure
    made.pass(MINUTE);
    expect(made.witness.record()).toBeNull();
  });

  test("it takes the time at least every five minutes while it runs, and once more when it stops", () => {
    expect(WITNESS_INTERVAL_MS).toBeLessThanOrEqual(5 * MINUTE);
    const made = recording();
    made.world.rows = [lets(PHONE)];
    made.witness.step();
    made.world.wall += 2 * MINUTE;
    made.world.mono += 2 * MINUTE;
    made.witness.stop();
    expect(made.file()).toMatchObject({ saved: (T0 + 2 * MINUTE) / 1000, keys: { [PHONE]: { wall: 120, ran: 120 } } });
  });
});

describe("what the record tells a device of its account (admits)", () => {
  test("rows that cannot be read are no answer, not an answer that nobody is let in", () => {
    const made = recording();
    made.world.rows = [lets(PHONE)];
    made.witness.step();
    expect(made.witness.admits()?.admits.map((row) => row.key)).toEqual([PHONE]);
    made.world.rows = null;
    expect(made.witness.admits()).toBeNull();
  });

  test("how long ago a key was last used is read now, from the newest use the rows know", () => {
    const made = recording();
    const used = T0 / 1000 - 100;
    made.world.rows = [lets(PHONE, used)];
    made.witness.step();
    expect(made.witness.admits()?.admits[0]?.idle).toBe(100);
    // two minutes on, with no step between: 220 seconds, and a newer use of the row counts at once
    made.world.wall += 2 * MINUTE;
    made.world.mono += 2 * MINUTE;
    expect(made.witness.admits()?.admits[0]?.idle).toBe(220);
    made.world.rows = [lets(PHONE, T0 / 1000 + 100)];
    expect(made.witness.admits()?.admits[0]?.idle).toBe(20);
  });
});
