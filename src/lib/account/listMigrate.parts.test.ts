import { describe, expect, test } from "bun:test";
import { MIGRATION_KNOWN_SECONDS } from "../../../shared/account-list-migrate.ts";
import {
  birthText, handOverRecord, knownPcs, MIGRATION_QA_SCALE_MAX, migrationScale, noticeRecord, notCarriedAt, pageScale, pcAnswerOf, pcAnswers, pcHowOf, QA_TWIN_APP, readAppId, readBirth, readHandOver,
  readNotice, readRetired, retiredText, scaled, ownRemovals, type KeptBirth,
} from "./listMigrate.ts";
import { memoryAccountStore } from "./store.ts";

const KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5lhuexKpDRsxAK4WTOjTQTjBurzk0iGngvCpNGetUiwtppuB-SgVWvMwkHCQe6FNPoAzLJZntcFyjzv0sk82Bg";
const E = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const LIST = "1e02680cc5e01ec2c5c7ebaf0a37a1007dd79352492b040879f664cfc142d54c";

describe("the waits of a move are turned down only in the QA twin", () => {
  test("the store app, a browser and the owner's preview app wait the full time, whatever is set", () => {
    expect(migrationScale(null, "3600")).toBe(1);
    expect(migrationScale("sh.ovis.app", "3600")).toBe(1);
    expect(migrationScale("sh.ovis.app.preview", "3600")).toBe(1);
  });

  test("the QA twin takes a whole factor from 1 to a day, and nothing else", () => {
    expect(migrationScale(QA_TWIN_APP, null)).toBe(1);
    expect(migrationScale(QA_TWIN_APP, "3600")).toBe(3600);
    expect(migrationScale(QA_TWIN_APP, "86400")).toBe(MIGRATION_QA_SCALE_MAX);
    expect(migrationScale(QA_TWIN_APP, "999999")).toBe(MIGRATION_QA_SCALE_MAX);
    for (const junk of ["0", "-5", "1.5", "1e3", " 60", "abc", ""]) expect(migrationScale(QA_TWIN_APP, junk)).toBe(1);
  });

  test("a duration is scaled, and a clock that ran back counts nothing", () => {
    expect(scaled(100, 160, 1)).toBe(60);
    expect(scaled(100, 160, 60)).toBe(3600);
    expect(scaled(160, 100, 60)).toBe(0);
  });
});

describe("a PC's answer, as a device reads it", () => {
  test("its form: an account, the list it follows or null, durations and removals", () => {
    expect(pcAnswerOf({ account: "acct", pinned: null, admits: [{ key: KEY, wall: 90000, ran: 30000, idle: 5 }], removed: [KEY] }))
      .toEqual({ account: "acct", pinned: null, admits: [{ key: KEY, wall: 90000, ran: 30000, idle: 5 }], removed: [KEY] });
    expect(pcAnswerOf({ account: "acct", pinned: LIST, admits: [], removed: [] })?.pinned).toBe(LIST);
  });

  test("a row that is no duration is dropped; an answer out of form is none", () => {
    expect(pcAnswerOf({ account: "acct", pinned: null, admits: [{ key: KEY, wall: -1, ran: 3 }, { key: "x", wall: 1, ran: 1 }, { key: KEY, wall: 1.5, ran: 1 }], removed: [] })?.admits).toEqual([]);
    for (const junk of [null, [], { account: 1, pinned: null, admits: [], removed: [] }, { account: "a", pinned: "nope", admits: [], removed: [] }, { account: "a", pinned: null, admits: {}, removed: [] }]) {
      expect(pcAnswerOf(junk)).toBeNull();
    }
  });
});

describe("the PCs a device knows, as a move hands them over", () => {
  const record = { v: 1 as const, account: "acct", pcs: {
    [E(1)]: { since: 1000, last: 2000, how: "paired" as const },
    [E(2)]: { since: 1000, last: 2000, how: "invited" as const },
    [E(3)]: { how: "none" as const },
    [E(4)]: { since: 1000, last: 2000, how: "later_build_value" },
  } };

  test("what it did itself, how long it has held sessions there (scaled), and this run's answer", () => {
    const answers = pcAnswers();
    answers.set("acct", E(1), { account: "acct", pinned: null, admits: [], removed: [] });
    const pcs = knownPcs({ account: "acct", record, letIn: null, answers, names: () => null, now: 1000 + MIGRATION_KNOWN_SECONDS, scale: 1 });
    expect(pcs.map((pc) => [pc.endpoint, pc.how, pc.known, pc.says === null])).toEqual([
      [E(1), "paired", MIGRATION_KNOWN_SECONDS, false], [E(2), "added", MIGRATION_KNOWN_SECONDS, true], [E(3), "none", null, true], [E(4), "none", MIGRATION_KNOWN_SECONDS, true],
    ]);
    expect(knownPcs({ account: "acct", record, letIn: null, answers, names: () => null, now: 1010, scale: 60 }).find((pc) => pc.endpoint === E(1))?.known).toBe(600);
  });

  test("a PC the directory does not list as let in, and one a refusal named, are left out; an answer of another account is none of this one's", () => {
    const answers = pcAnswers();
    answers.set("other", E(1), { account: "other", pinned: null, admits: [], removed: [] });
    const pcs = knownPcs({ account: "acct", record, letIn: new Set([E(1), E(2)]), answers, names: () => null, now: 5000, scale: 1, skip: new Set([E(2)]) });
    expect(pcs.map((pc) => pc.endpoint)).toEqual([E(1)]);
    expect(pcs[0]!.says).toBeNull();
  });

  test("an invite the line's own key proved, and the person's tap, counts as an Add", () => {
    expect(pcHowOf({ how: "invited" })).toBe("added");
    expect(pcHowOf({ how: "window" })).toBe("window");
    expect(pcHowOf(undefined)).toBe("none");
  });
});

describe("what a refusal of a birth names", () => {
  const birth = { signIn: "S", carried: { devices: ["A", "B"], pcs: [E(1), E(2)] } };
  test("entry 0 is the device's own key; the run is the devices, then the PCs", () => {
    expect(notCarriedAt(birth, 0)).toEqual({ key: "S" });
    expect(notCarriedAt(birth, 1)).toEqual({ key: "A" });
    expect(notCarriedAt(birth, 2)).toEqual({ key: "B" });
    expect(notCarriedAt(birth, 3)).toEqual({ endpoint: E(1) });
    expect(notCarriedAt(birth, 4)).toEqual({ endpoint: E(2) });
    expect(notCarriedAt(birth, 5)).toBeNull();
    expect(notCarriedAt(birth, null)).toBeNull();
  });
});

describe("what a move keeps, read back strictly", () => {
  const wrap = "A".repeat(151);
  const birth: KeptBirth = {
    list: LIST, signIn: KEY, member: KEY, entry: "e0", entries: ["e1", "e2"], wraps: [{ epoch: 1, member: KEY, wrap }],
    link: { member: "m", device: "d" }, carried: { devices: [KEY], pcs: [E(1)] }, skip: { keys: [], endpoints: [E(2)] }, enc: KEY, at: 5,
  };

  test("a birth, a refusal, a notice and a hand-over each read back as written", () => {
    expect(readBirth(birthText(birth))).toEqual(birth);
    expect(readRetired(retiredText(LIST, { at: 9, keys: [KEY], endpoints: [E(1)] }))).toEqual({ list: LIST, refusal: { at: 9, keys: [KEY], endpoints: [E(1)] } });
    expect(readRetired(retiredText(LIST, null))).toEqual({ list: LIST, refusal: null });
    // a birth let go is no birth to send, and a kept one no birth let go
    expect(readBirth(retiredText(LIST, null))).toBeNull();
    expect(readRetired(birthText(birth))).toBeNull();
    expect(readNotice(noticeRecord({ list: LIST, first: KEY, devices: [KEY], pcs: [E(1)], seen: false }))).toEqual({ list: LIST, first: KEY, devices: [KEY], pcs: [E(1)], seen: false });
    const handOver = { list: LIST, signIn: KEY, member: KEY, enc: KEY, on: { seq: 4, hash: LIST }, entry: "e", link: { member: "m", device: "d" }, refused_at: null };
    expect(readHandOver(handOverRecord(handOver))).toEqual(handOver);
  });

  test("one out of form is none", () => {
    expect(readBirth(JSON.stringify({ ...JSON.parse(birthText(birth)) as object, entries: ["only one"] }))).toBeNull();
    expect(readBirth(JSON.stringify({ ...JSON.parse(birthText(birth)) as object, v: 2 }))).toBeNull();
    expect(readRetired(JSON.stringify({ v: 1, retired: LIST, refusal: { at: -1, keys: [], endpoints: [] } }))).toBeNull();
    expect(readBirth("not json")).toBeNull();
    expect(readNotice({ v: 1, list: "x", first: KEY, devices: [], pcs: [], seen: false })).toBeNull();
    expect(readHandOver({ v: 1, list: LIST, signIn: KEY, on: { seq: 1 }, entry: "e", link: { member: "m", device: "d" }, refused_at: null })).toBeNull();
  });
});

describe("which app this page runs in, for the QA twin's factor", () => {
  test("the app's own word on its application id sets the page's factor; a browser and an app that says nothing stay at 1", async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const items = new Map<string, string>([["ovis-migrate-qa-scale", "3600"]]);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => items.get(key) ?? null } });
    try {
      await readAppId({ has: () => false, call: async () => ({ id: QA_TWIN_APP }) });
      expect(pageScale()).toBe(1);
      await readAppId({ has: () => true, call: async () => ({ id: "sh.ovis.app" }) });
      expect(pageScale()).toBe(1);
      await readAppId({ has: () => true, call: async () => ({ id: QA_TWIN_APP }) });
      expect(pageScale()).toBe(3600);
      await readAppId({ has: () => true, call: async () => { throw new Error("refused"); } });
      expect(pageScale()).toBe(1);
    } finally {
      if (saved === undefined) delete (globalThis as Record<string, unknown>).localStorage;
      else Object.defineProperty(globalThis, "localStorage", saved);
    }
  });
});

describe("the keys this device holds a removal against itself (R-F)", () => {
  test("a Not me's blocks it keeps until the service confirms them, and the removals it signed, of this account alone", async () => {
    const store = memoryAccountStore();
    await store.set("unsent_blocks", {
      a: { account: "acct", sign_in_id: "s", records: [{ target: "K1" }, { target: "K2" }] },
      b: { account: "other", sign_in_id: "s", records: [{ target: "K9" }] },
    } as never);
    await store.set("removals", { K3: { account: "acct", key: "K3" }, K8: { account: "other", key: "K8" } } as never);
    expect((await ownRemovals(store, "acct")).sort()).toEqual(["K1", "K2", "K3"]);
    expect(await ownRemovals(memoryAccountStore(), "acct")).toEqual([]);
  });
});

describe("the device's own signed removals count as its own (astra-migapp 5)", () => {
  test("a `remove` it signed and keeps among its devices' records, of this account alone", async () => {
    const store = memoryAccountStore();
    await store.set("devices", { K4: { kind: "remove", account: "acct", key: "K4" }, K5: { kind: "add", account: "acct", key: "K5" }, K6: { kind: "remove", account: "other", key: "K6" } } as never);
    expect(await ownRemovals(store, "acct")).toEqual(["K4"]);
  });
});
