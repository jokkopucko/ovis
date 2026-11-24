/**
 * The PC's own part of following its account's signed list (list-follow.ts): when it reads without being told to,
 * what it keeps across a restart, and what work in flight may still do. The account service here only serves the log
 * a real account wrote; the clock, the binding and the disk are the test's.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { entryFromText, entryHash, readBody } from "../../shared/account-list-entry.ts";
import { readKind } from "../../shared/account-list.ts";
import { PC_READ_SECONDS, pinList, writeSave } from "../../shared/account-list-follower.ts";
import { importPublicKey, importSecretKey } from "../../shared/relay-e2ee.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { answerServerChallenge } from "../../shared/relay-server-proof.ts";
import { loadRelayIdentity } from "../relay/identity.ts";
import { privateStateFs } from "../private-state.ts";
import type { ListCommit } from "./account-device-state.ts";
import { ACCOUNT_LIST_ALLOW_FILE, ACCOUNT_LIST_FILE, ACCOUNT_LIST_OWED_FILE, ListFollow, type ListFollowDeps } from "./list-follow.ts";
import { ACCOUNT_LIST_KEYS_FILE, ListKeyStore } from "./list-keys.ts";
import { claimKey, listMember, memberCard, TestList } from "./list.test-helpers.ts";
import { AccountServiceRefusal } from "./mailbox.ts";

const ACCOUNT = "acct_1";
const SERVICE = "https://account.test";
const BIND = "ab".repeat(16);

const dirs: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A PC's follower over a state folder of its own, an account's real list, and a clock the test moves (seconds). */
async function following(options: { stateDir?: string; seconds?: number; account?: TestList; service?: FakeAccountService; pinned?: string | null; alarmed?: boolean; real?: boolean } = {}) {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "ovis-list-follow-"));
  if (options.stateDir === undefined) dirs.push(stateDir);
  const world = {
    seconds: options.seconds ?? 1_800_000_000, bound: true, bind: BIND, calls: [] as string[],
    /** what the service answers a log request with, in the log's place */
    log: null as ((body: Record<string, unknown>) => Record<string, unknown>) | null,
    /** each call waits for this before it answers */
    gate: null as Promise<void> | null,
    until: null as number | null,
    /** the list the binding is pinned to, as account-pc.json keeps it */
    pinned: options.pinned ?? null as string | null,
    /** whether the binding keeps that an alarm rose, as account-pc.json does */
    alarmed: options.alarmed ?? false,
    /** the binding's file does not take the alarm */
    alarmFails: false,
    /** the record of a removal (the evidence file) cannot be written */
    forgets: false,
    /** what the PC did by its list: the keys it kept as removed, the rows it committed, the times it left and looked at its sessions again */
    removed: [] as string[], commits: [] as ListCommit[], left: 0, rechecks: 0,
    /** whether the clock is the real one, from `seconds` on */
    real: options.real === true ? Date.now() : null as number | null,
  };
  const seconds = () => world.real === null ? world.seconds : world.seconds + Math.floor((Date.now() - world.real) / 1000);
  const service = options.service ?? new FakeAccountService(() => seconds() * 1000);
  service.listAccounts = "*";
  const account = options.account ?? await TestList.start(service, ACCOUNT, undefined, seconds);
  const identity = loadRelayIdentity(stateDir);
  const endpoint = bytesToHex(importPublicKey(identity.public_key));
  // the account lists this PC, so the service serves it the list's routes on its own proof
  const listed = await service.fetch(new Request(`${SERVICE}/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${service.issueToken(ACCOUNT, { twoStep: true })}` },
    body: JSON.stringify({ label: "PC", public_key: endpoint, relay: "wss://relay.ovis.sh" }) }));
  if (!listed.ok) throw new Error(`The PC was not listed: ${listed.status}`);
  const prove = async () => {
    const challenge = await (await service.fetch(new Request(`${SERVICE}/v1/pc/challenge`, { method: "POST", body: JSON.stringify({ server_id: identity.server_id, public_key: endpoint }) }))).json() as { challenge_id: string; frame: string };
    return { server_id: identity.server_id, public_key: endpoint, challenge_id: challenge.challenge_id, proof: answerServerChallenge(challenge.frame, importSecretKey(identity.secret_key), { server_id: identity.server_id, role: "account", connection_id: challenge.challenge_id })! };
  };
  const deps: ListFollowDeps = {
    stateDir, keys: new ListKeyStore(stateDir), identity: () => identity,
    binding: () => world.bound ? { account: ACCOUNT, id: world.bind, list: world.pinned, alarmed: world.alarmed } : null,
    pin: (_bindId, id) => { world.pinned = id; return true; },
    alarm: () => { if (world.alarmFails) return false; world.alarmed = true; return true; },
    bind: (account, id, _serverId) => { world.bound = true; world.pinned = id; return { id: world.bind, account, list: id, won: true }; },
    removedFrom: () => false,
    rowKey: () => null,
    now: () => world.real === null ? world.seconds * 1000 : world.seconds * 1000 + (Date.now() - world.real),
    removed: (key) => { if (world.forgets) throw new Error("the removal's record could not be written"); world.removed.push(key); },
    commit: (rows) => { world.commits.push(rows); },
    leave: () => { world.left++; world.bound = false; return true; },
    recheck: () => { world.rechecks++; },
    call: async (path, body, ready) => {
      world.calls.push(path);
      if (world.gate !== null) await world.gate;
      if (world.log !== null && path === "/v2/pc/list/log") return world.log(body);
      const proof = await prove();
      ready?.();
      const answer = await service.fetch(new Request(`${SERVICE}${path}`, { method: "POST", body: JSON.stringify({ ...proof, ...body }) }));
      const said = await answer.json() as Record<string, unknown>;
      if (!answer.ok) throw new AccountServiceRefusal(answer.status, (said.error as { code?: string } | undefined)?.code ?? null, path);
      return path === "/v2/pc/list/keys" && world.until !== null ? { ...said, until: world.until } : said;
    },
  };
  const list = new ListFollow(deps);
  stops.push(() => list.stop());
  const hint = () => { const held = service.accountList(ACCOUNT)!; return { id: held.id, head: held.head }; };
  /** A mailbox pull that named the list as the service holds it, followed to its end. */
  const pull = async () => { list.heard(ACCOUNT, hint()); await list.settled(); };
  const reads = () => world.calls.filter((path) => path === "/v2/pc/list/log").length;
  /** Resolves once a log request is out that was not when this was called (`after`: the count then), within ten seconds. */
  const asked = async (after = 0) => {
    const deadline = Date.now() + 10_000;
    while (reads() <= after) { if (Date.now() > deadline) throw new Error("The PC asked for no log"); await Bun.sleep(5); }
  };
  /** A member adds this PC from the keys it posted: from then on the list answers for its devices. */
  const addPc = async () => { await pull(); await account.addPostedPc(endpoint); await pull(); };
  /** The PC as one a person pinned to this list. */
  const pin = async () => {
    expect(await list.wantList(account.id)).toMatchObject({ status: { pinned: false } });
    await addPc();
    expect(list.status()).toMatchObject({ pinned: true, standing: "in" });
  };
  /** The key the list holds this PC by. */
  const ownKey = async () => (await deps.keys.keysFor(identity.server_id)).key;
  return { list, world, service, account, stateDir, pull, reads, hint, deps, addPc, pin, ownKey, endpoint, asked };
}

describe("a PC that holds a list reads it at its own pace", () => {
  test("a mailbox that names no list hides no removal: the PC reads the log when its own time has come", async () => {
    const pc = await following();
    await pc.pull();
    const phone = await listMember();
    await pc.account.addDevice(phone);
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ devices: 2, head: pc.account.place });
    await pc.account.remove(phone.key);
    const before = pc.reads();
    // the mailbox goes on naming no list
    pc.list.heard(ACCOUNT, null);
    await pc.list.settled();
    expect(pc.reads()).toBe(before);
    pc.world.seconds += PC_READ_SECONDS;
    pc.list.heard(ACCOUNT, null);
    await pc.list.settled();
    expect(pc.reads()).toBe(before + 1);
    expect(pc.list.status()).toMatchObject({ devices: 1, head: pc.account.place });
  });

  test("and with no mailbox answer at all: its clock alone brings the read", async () => {
    const pc = await following();
    await pc.pull();
    await pc.account.addDevice(await listMember());
    const before = pc.reads();
    pc.list.tick();
    await pc.list.settled();
    expect(pc.reads()).toBe(before);
    pc.world.seconds += PC_READ_SECONDS;
    pc.list.tick();
    await pc.list.settled();
    expect(pc.reads()).toBe(before + 1);
    expect(pc.list.status()).toMatchObject({ devices: 2 });
  });

  test("a PC whose account never had a list asks for no log, whatever its clock shows", async () => {
    const pc = await following();
    pc.list.heard(ACCOUNT, null);
    pc.world.seconds += 10 * PC_READ_SECONDS;
    pc.list.tick();
    await pc.list.settled();
    expect(pc.world.calls).toEqual([]);
  });

  test("after a restart it holds its saved copy before any mailbox answer", async () => {
    const pc = await following();
    await pc.account.addDevice(await listMember());
    await pc.pull();
    const held = pc.list.status();
    pc.list.stop();
    const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service });
    again.list.start();
    await again.list.settled();
    expect(again.list.status()).toMatchObject({ list: held.list, head: held.head, devices: 2 });
    expect(again.world.calls).toEqual([]);
  });
});

describe("what the account service names is only its word", () => {
  test("a list id it named, of which the PC verified no entry, gives way to the one it names next", async () => {
    const pc = await following();
    const real = pc.hint();
    // the first answer names a list whose log the service does not serve
    pc.list.heard(ACCOUNT, { id: "ef".repeat(32), head: { seq: 3, hash: "cd".repeat(32) } });
    await pc.list.settled();
    expect(pc.list.status()).toMatchObject({ list: "ef".repeat(32), head: null });
    pc.list.heard(ACCOUNT, real);
    await pc.list.settled();
    expect(pc.list.status()).toMatchObject({ list: real.id, head: real.head, last_verdict: "caught_up" });
  });

  test("a list of which it verified an entry does not give way", async () => {
    const pc = await following();
    await pc.pull();
    const held = pc.list.status();
    pc.list.heard(ACCOUNT, { id: "ef".repeat(32), head: { seq: 3, hash: "cd".repeat(32) } });
    await pc.list.settled();
    expect(pc.list.status()).toMatchObject({ list: held.list, head: held.head, last_verdict: "not_my_list" });
  });
});

describe("the PC's clock never counts for less than it once showed", () => {
  test("an hour a decision turned on is saved: a restart with the clock set back does not let an expired device in again", async () => {
    const pc = await following({ seconds: 1_800_000_000 });
    const watcher = await listMember();
    await pc.account.addDevice(watcher, { role: "watch", power: "bound", until: 1_800_000_050 });
    await pc.addPc();
    const said: string[] = [];
    const log = spyOn(console, "info").mockImplementation((line: unknown) => { said.push(String(line)); });
    try {
      // the same head, five seconds past the device's time and under a minute since the last save: only the
      // decision itself saves the hour. The shadow says the list would not let it in
      pc.world.seconds = 1_800_000_055;
      await pc.pull();
      pc.list.shadowSnapshot([watcher.key]);
      await pc.list.settled();
      expect(said.some((line) => line.includes('"list":"expired"'))).toBe(true);
      pc.list.stop();
      said.length = 0;
      // the clock is set back to before that time
      const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, seconds: 1_800_000_040 });
      again.list.start();
      again.list.shadowSnapshot([watcher.key]);
      await again.list.settled();
      expect(said.some((line) => line.includes('"list":"expired"'))).toBe(true);
      expect(said.some((line) => line.includes('"list":"watch"'))).toBe(false);
    } finally { log.mockRestore(); }
  });
});

describe("work in flight when the PC leaves its account", () => {
  test("a read that answers after the binding was cleared writes no copy and posts no card", async () => {
    const pc = await following();
    let release = () => {};
    pc.world.gate = new Promise((resolve) => { release = resolve; });
    pc.list.heard(ACCOUNT, pc.hint());
    // the log request is out
    await pc.asked();
    const file = Bun.file(join(pc.stateDir, ACCOUNT_LIST_FILE));
    const before = await file.exists() ? await file.text() : null;
    pc.world.bound = false;
    release();
    await pc.list.settled();
    expect(pc.world.calls).toEqual(["/v2/pc/list/log"]);
    // what the file held when the PC left is all it holds: nothing the late answer brought
    expect(await file.exists() ? await file.text() : null).toBe(before);
    expect(pc.list.status().list).toBeNull();
  });

  test("and nothing is posted after stop", async () => {
    const pc = await following();
    let release = () => {};
    pc.world.gate = new Promise((resolve) => { release = resolve; });
    pc.list.heard(ACCOUNT, pc.hint());
    await pc.asked();
    pc.list.stop();
    release();
    await pc.list.settled();
    expect(pc.world.calls).toEqual(["/v2/pc/list/log"]);
  });
});

describe("what the PC says of itself", () => {
  test("a copy file that could not be read is read again once it can be", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const pc = await following();
    await pc.account.addDevice(await listMember());
    await pc.pull();
    pc.list.stop();
    const path = join(pc.stateDir, ACCOUNT_LIST_FILE);
    chmodSync(path, 0o000);
    // a PC that is not pinned holds only a copy: it reads the list again from the service and replaces the file
    const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service });
    await again.pull();
    expect(again.list.status()).toMatchObject({ list: pc.account.id, head: pc.account.place, error: null });
    expect(again.reads()).toBeGreaterThan(0);
  });

  test("a pinned PC whose copy file could not be read lets nobody in by it, and takes the file once it reads, with no restart", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const pc = await following();
    expect(await pc.list.wantList(pc.account.id)).toMatchObject({ status: { pinned: false } });
    await pc.addPc();
    expect(pc.list.status()).toMatchObject({ pinned: true, standing: "in" });
    pc.list.stop();
    const path = join(pc.stateDir, ACCOUNT_LIST_FILE);
    chmodSync(path, 0o000);
    const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, pinned: pc.account.id });
    await again.pull();
    expect(again.list.status()).toMatchObject({ pinned: true, list: null });
    expect(again.list.status().error).toContain(`${ACCOUNT_LIST_FILE} cannot be read`);
    expect(again.list.role(pc.account.first.key)).toBeNull();
    expect(again.reads()).toBe(0);
    chmodSync(path, 0o600);
    again.list.tick();
    await again.list.settled();
    expect(again.list.status()).toMatchObject({ pinned: true, list: pc.account.id, head: pc.account.place, standing: "in", error: null });
    expect(again.list.role(pc.account.first.key)).toBe("drive");
  });

  test("it names no post of its keys once the list holds it", async () => {
    const pc = await following();
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ standing: "waiting" });
    expect(pc.list.status().posted_until).not.toBeNull();
    // a member adds it from that post
    await pc.account.addPostedPc(bytesToHex(importPublicKey(pc.deps.identity()!.public_key)));
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ standing: "in", posted_until: null });
  });

  test("a post's end the service names out of any range does not break what the PC says", async () => {
    const pc = await following();
    pc.world.until = Number.MAX_SAFE_INTEGER;
    await pc.pull();
    expect(() => pc.list.status()).not.toThrow();
    expect(pc.list.status()).toMatchObject({ standing: "waiting", posted_until: null });
  });

  test("a key only the snapshot or only the list holds is said as a difference of credentials: the two may be one phone", async () => {
    const pc = await following();
    const member = await listMember();
    const signIn = await listMember();
    await pc.account.addDevice(member);
    await pc.addPc();
    const said: Record<string, unknown>[] = [];
    const log = spyOn(console, "info").mockImplementation((line: unknown) => { try { said.push(JSON.parse(String(line)) as Record<string, unknown>); } catch { /* another line */ } });
    try {
      // the snapshot names the phone by the key of its sign-in, the list by its member key
      pc.list.shadowSnapshot([signIn.key, pc.account.first.key]);
      await pc.list.settled();
    } finally { log.mockRestore(); }
    const differences = said.filter((line) => line.event === "account.list.differs").map(({ snapshot, list, of }) => ({ snapshot, list, of }));
    expect(differences).toEqual([{ snapshot: "admitted", list: "never_added", of: "credential" }, { snapshot: "none", list: "drive", of: "credential" }]);
  });
});

describe("a pinned PC and what its list removes", () => {
  test("a device the list removed before it removed the PC is put out in the same read, before the PC leaves", async () => {
    const pc = await following();
    const phone = await listMember();
    await pc.account.addDevice(phone);
    await pc.pin();
    // both while the PC was away: the phone, then the PC itself
    await pc.account.remove(phone.key);
    await pc.account.remove(await pc.ownKey());
    await pc.pull();
    expect(pc.world.removed).toEqual([phone.key]);
    expect(pc.world.left).toBe(1);
  });

  test("a removal whose save fails is enforced all the same, said as not saved, and saved once the disk takes it", async () => {
    const pc = await following();
    const phone = await listMember();
    const tablet = await listMember();
    await pc.account.addDevice(phone);
    await pc.account.addDevice(tablet);
    await pc.pin();
    const before = pc.list.status().head;
    const failing = spyOn(privateStateFs, "renameSync").mockImplementation((_from, to) => {
      if (String(to).endsWith(ACCOUNT_LIST_FILE)) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    });
    try {
      await pc.account.remove(phone.key);
      await pc.pull();
      // out at once, from memory
      expect(pc.world.removed).toEqual([phone.key]);
      expect(pc.list.role(phone.key)).toBeNull();
      expect(pc.list.status().error).toContain("could not be written");
      // a page a device hands over is not answered as taken while it is not on disk
      const removal = await pc.account.remove(tablet.key);
      const ask = pc.list.asks()!;
      expect(await pc.list.takeFromPeer({ list: ask.list, after: ask.after, entries: [removal], head: pc.account.place })).toBe("not_saved");
      expect(pc.world.removed).toEqual([phone.key, tablet.key]);
      expect(pc.list.role(tablet.key)).toBeNull();
    } finally { failing.mockRestore(); }
    // the disk takes it again: the copy is saved at the next tick, and a restart holds both removals
    pc.list.tick();
    await pc.list.settled();
    pc.list.stop();
    const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, pinned: pc.account.id });
    again.list.start();
    await again.list.settled();
    expect(again.list.status().head).toEqual(pc.account.place);
    expect(again.list.status().head).not.toEqual(before);
    expect(again.world.calls).toEqual([]);
  });
});

describe("a device the list lets in until a time", () => {
  test("is put out when that time comes, by a timer of its own: no tick, no read", async () => {
    const pc = await following({ seconds: Math.floor(Date.now() / 1000), real: true });
    const guest = await listMember();
    await pc.account.addDevice(guest, { role: "watch", power: "bound", until: Math.floor(Date.now() / 1000) + 2 });
    await pc.pin();
    expect(pc.list.role(guest.key)).toBe("watch");
    const rechecks = pc.world.rechecks;
    const deadline = Date.now() + 10_000;
    while (pc.world.rechecks === rechecks) { if (Date.now() > deadline) throw new Error("The device's time passed and nothing looked at its session"); await Bun.sleep(25); }
    expect(pc.list.role(guest.key)).toBeNull();
    expect(pc.world.commits.at(-1)!.devices.find((row) => row.key === guest.key)).toMatchObject({ eligible: false });
  });

  test("whose time passed while Ovis was stopped stays out after a second restart with the clock set back", async () => {
    const pc = await following({ seconds: 1_800_000_000 });
    const guest = await listMember();
    await pc.account.addDevice(guest, { role: "watch", power: "bound", until: 1_800_000_050 });
    await pc.pin();
    pc.list.stop();
    const eligible = (of: Awaited<ReturnType<typeof following>>) => of.world.commits.at(-1)!.devices.find((row) => row.key === guest.key)?.eligible;
    // Ovis starts after the device's time, with the service away, and stops again before anything else is saved
    const late = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, pinned: pc.account.id, seconds: 1_800_000_100 });
    late.world.log = () => { throw new Error("away"); };
    late.list.start();
    await late.list.settled();
    expect(eligible(late)).toBe(false);
    late.list.stop();
    // the clock is set back to before that time
    const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, pinned: pc.account.id, seconds: 1_800_000_010 });
    again.world.log = () => { throw new Error("away"); };
    again.list.start();
    await again.list.settled();
    expect(eligible(again)).toBe(false);
  });

  test("stays out after a restart with the clock set back, also when the account service was away as its time passed", async () => {
    const pc = await following({ seconds: 1_800_000_000 });
    const guest = await listMember();
    await pc.account.addDevice(guest, { role: "watch", power: "bound", until: 1_800_000_050 });
    await pc.pin();
    // the service is away from here on
    pc.world.log = () => { throw new Error("away"); };
    pc.world.seconds = 1_800_000_055;
    expect(pc.list.role(guest.key)).toBeNull();
    pc.list.stop();
    const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, pinned: pc.account.id, seconds: 1_800_000_010 });
    again.world.log = () => { throw new Error("away"); };
    again.list.start();
    await again.list.settled();
    expect(again.list.role(guest.key)).toBeNull();
    expect(again.list.role(pc.account.first.key)).toBe("drive");
  });
});

describe("what the PC acted on and could not save", () => {
  /** The disk takes no write of the list's copy; every other file is written. */
  const copyUnwritable = () => spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
    if (String(to).endsWith(ACCOUNT_LIST_FILE)) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    renameSync(String(from), String(to));
  });

  test("a PC that stopped with a removal acted on and not saved lets nobody of its list in after the restart, until it has read the list again", async () => {
    const pc = await following();
    const phone = await listMember();
    await pc.account.addDevice(phone);
    await pc.pin();
    await pc.account.remove(phone.key);
    const failing = copyUnwritable();
    try {
      await pc.pull();
      // acted on, from memory
      expect(pc.world.removed).toContain(phone.key);
      expect(pc.list.role(phone.key)).toBeNull();
      // and the PC stops before the disk takes the copy
      pc.list.stop();
    } finally { failing.mockRestore(); }
    expect(existsSync(join(pc.stateDir, ACCOUNT_LIST_OWED_FILE))).toBe(true);
    // the copy on disk still holds the phone, and the account service is away
    const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, pinned: pc.account.id });
    again.world.log = () => { throw new Error("away"); };
    again.list.start();
    await again.pull();
    expect(again.list.role(phone.key)).toBeNull();
    expect(again.list.role(pc.account.first.key)).toBeNull();
    expect(again.list.status().reason).toContain("before it could save");
    expect(again.world.commits.at(-1)!.devices.every((row) => !row.eligible)).toBe(true);
    // the service answers: the list is read to its end, and decides again
    again.world.log = null;
    await again.pull();
    expect(again.list.role(phone.key)).toBeNull();
    expect(again.list.role(pc.account.first.key)).toBe("drive");
    expect(again.list.status().reason).toBeNull();
    expect(existsSync(join(pc.stateDir, ACCOUNT_LIST_OWED_FILE))).toBe(false);
  });

  test("the mark names the removal it owes: a head the PC already held discharges nothing, and the removed device stays out when the copy and the removal's record were both lost", async () => {
    const pc = await following();
    const phone = await listMember();
    await pc.account.addDevice(phone);
    await pc.pin();
    await pc.account.remove(phone.key);
    // neither the copy nor the record of the removal reaches the disk
    pc.world.forgets = true;
    const failing = copyUnwritable();
    try {
      await pc.pull();
      expect(pc.list.role(phone.key)).toBeNull();
      pc.list.stop();
    } finally { failing.mockRestore(); }
    const mark = JSON.parse(readFileSync(join(pc.stateDir, ACCOUNT_LIST_OWED_FILE), "utf8")) as { removed: { key: string; seq: number }[] };
    expect(mark.removed).toEqual([{ key: phone.key, seq: pc.account.place.seq }]);
    // the service shows this PC only the list as it stood before the removal, and names that old head
    const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, pinned: pc.account.id });
    again.service.tamperList(pc.account.id, { withholdAfter: pc.account.place.seq - 1 });
    again.list.start();
    await again.list.settled();
    const held = again.list.status().head ?? (await again.list.settled(), again.list.status().head);
    again.list.heard(ACCOUNT, { id: pc.account.id, head: held! });
    await again.list.settled();
    // nobody is let in on the old head's word
    expect(again.list.role(pc.account.first.key)).toBeNull();
    // a whole read of the service, which still withholds the removal: the others come back, the removed device does not
    await again.pull();
    again.world.seconds += PC_READ_SECONDS;
    again.list.tick();
    await again.list.settled();
    expect(again.list.role(pc.account.first.key)).toBe("drive");
    expect(again.list.role(phone.key)).toBeNull();
    expect(again.world.commits.at(-1)!.devices.find((row) => row.key === phone.key)?.eligible).toBe(false);
    expect(existsSync(join(pc.stateDir, ACCOUNT_LIST_OWED_FILE))).toBe(true);
    // an hour on, the PC says so, and still keeps the device out
    again.world.seconds += 3_700;
    expect(again.list.status().reason).toContain("has not been shown");
    expect(again.list.role(phone.key)).toBeNull();
    // the service shows the removal at last: the copy holds it, it is saved, and the mark goes
    again.service.untamperList(pc.account.id);
    await again.pull();
    again.list.tick();
    await again.list.settled();
    expect(again.list.role(phone.key)).toBeNull();
    expect(existsSync(join(pc.stateDir, ACCOUNT_LIST_OWED_FILE))).toBe(false);
    expect(again.list.status().reason).toBeNull();
  });

  test("the mark is read before the copy and without it: with the copy gone, the PC reads the list anew and lets the removed device in at no moment", async () => {
    const pc = await following();
    const phone = await listMember();
    await pc.account.addDevice(phone);
    await pc.pin();
    await pc.account.remove(phone.key);
    pc.world.forgets = true;
    const failing = copyUnwritable();
    try { await pc.pull(); pc.list.stop(); } finally { failing.mockRestore(); }
    rmSync(join(pc.stateDir, ACCOUNT_LIST_FILE));
    const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, pinned: pc.account.id });
    // the service shows the list up to the entry before the removal
    again.service.tamperList(pc.account.id, { withholdAfter: pc.account.place.seq - 1 });
    again.list.start();
    await again.pull();
    again.world.seconds += PC_READ_SECONDS;
    again.list.tick();
    await again.list.settled();
    expect(again.list.status()).toMatchObject({ standing: "in" });
    expect(again.list.role(phone.key)).toBeNull();
    expect(again.world.commits.every((rows) => rows.devices.find((row) => row.key === phone.key)?.eligible !== true)).toBe(true);
  });

  test("the mark for a time that passed goes only once the copy on disk holds that hour: a second restart with the clock set back lets the guest in at no moment", async () => {
    const pc = await following({ seconds: 1_800_000_000 });
    const guest = await listMember();
    await pc.account.addDevice(guest, { role: "watch", power: "bound", until: 1_800_000_050 });
    await pc.pin();
    // the copy was last saved ten seconds before the guest's time
    pc.world.seconds = 1_800_000_040;
    await pc.pull();
    const failing = copyUnwritable();
    try {
      pc.world.seconds = 1_800_000_055;
      expect(pc.list.role(guest.key)).toBeNull();
      pc.list.stop();
    } finally { failing.mockRestore(); }
    expect((JSON.parse(readFileSync(join(pc.stateDir, ACCOUNT_LIST_OWED_FILE), "utf8")) as { expired: unknown[] }).expired).toEqual([{ key: guest.key, until: 1_800_000_050 }]);
    // a restart with the clock before that time, and a mailbox that names the head the PC holds; nobody asks for the guest
    const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, pinned: pc.account.id, seconds: 1_800_000_020 });
    again.list.start();
    await again.pull();
    again.list.stop();
    // and once more, still before that time
    const third = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, pinned: pc.account.id, seconds: 1_800_000_025 });
    third.world.log = () => { throw new Error("away"); };
    third.list.start();
    await third.pull();
    expect(third.list.role(guest.key)).toBeNull();
    expect(third.world.commits.at(-1)!.devices.find((row) => row.key === guest.key)?.eligible).toBe(false);
    expect(third.list.role(pc.account.first.key)).toBe("drive");
  });

  test("the mark for a removal goes only once the removal's own record is written: a saved copy that shows the key out is not enough, also over a restart", async () => {
    const pc = await following();
    const phone = await listMember();
    await pc.account.addDevice(phone);
    await pc.pin();
    await pc.account.remove(phone.key);
    // the copy is saved; the record of the removal is not
    pc.world.forgets = true;
    await pc.pull();
    expect(pc.list.role(phone.key)).toBeNull();
    const mark = join(pc.stateDir, ACCOUNT_LIST_OWED_FILE);
    expect(existsSync(mark)).toBe(true);
    pc.list.stop();
    // the restart finds a copy that shows the phone out: the mark stays while the record still cannot be written
    const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, pinned: pc.account.id });
    again.world.forgets = true;
    again.world.log = () => { throw new Error("away"); };
    again.list.start();
    await again.list.settled();
    again.list.tick();
    await again.list.settled();
    expect(existsSync(mark)).toBe(true);
    expect(again.list.role(phone.key)).toBeNull();
    // the record is written: the mark goes
    again.world.forgets = false;
    again.list.tick();
    await again.list.settled();
    expect(again.world.removed).toContain(phone.key);
    expect(existsSync(mark)).toBe(false);
  });

  test("a page the PC refuses, and a read the service does not answer to its end, are no whole read: the list stays closed to everybody", async () => {
    const pc = await following();
    const phone = await listMember();
    await pc.account.addDevice(phone);
    await pc.pin();
    await pc.account.remove(phone.key);
    pc.world.forgets = true;
    const failing = copyUnwritable();
    try { await pc.pull(); pc.list.stop(); } finally { failing.mockRestore(); }
    const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, pinned: pc.account.id });
    // the service answers the log with a page out of form
    again.world.log = () => ({ list: pc.account.id, entries: "none", head: null });
    again.list.start();
    await again.pull();
    expect(again.list.status().last_verdict).toContain("refused");
    expect(again.list.role(pc.account.first.key)).toBeNull();
    // a read that reaches the service's head lets the others in again
    again.world.log = null;
    await again.pull();
    again.world.seconds += PC_READ_SECONDS;
    again.list.tick();
    await again.list.settled();
    expect(again.list.role(pc.account.first.key)).toBe("drive");
    expect(again.list.role(phone.key)).toBeNull();
  });

  test("a naming that waited when the follower stopped makes no keys", async () => {
    const pc = await following();
    const naming = pc.list.wantList(pc.account.id);
    pc.list.stop();
    await naming;
    await pc.list.settled();
    expect(existsSync(join(pc.stateDir, ACCOUNT_LIST_KEYS_FILE))).toBe(false);
  });

  test("a restart with nothing owed lets the list's devices in with the service away, and leaves no mark behind a saved change", async () => {
    const pc = await following();
    const phone = await listMember();
    await pc.account.addDevice(phone);
    await pc.pin();
    await pc.account.remove(phone.key);
    await pc.pull();
    expect(existsSync(join(pc.stateDir, ACCOUNT_LIST_OWED_FILE))).toBe(false);
    pc.list.stop();
    const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, pinned: pc.account.id });
    again.world.log = () => { throw new Error("away"); };
    again.list.start();
    await again.pull();
    expect(again.list.role(pc.account.first.key)).toBe("drive");
    expect(again.list.role(phone.key)).toBeNull();
  });

  test("a device's time that passed while the copy could not be saved stays passed after a restart with the clock set back", async () => {
    const pc = await following({ seconds: 1_800_000_000 });
    const guest = await listMember();
    await pc.account.addDevice(guest, { role: "watch", power: "bound", until: 1_800_000_050 });
    await pc.pin();
    const failing = copyUnwritable();
    try {
      pc.world.seconds = 1_800_000_055;
      expect(pc.list.role(guest.key)).toBeNull();
      pc.list.stop();
    } finally { failing.mockRestore(); }
    // the clock is set back to before that time, and the service answers
    const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, pinned: pc.account.id, seconds: 1_800_000_010 });
    again.list.start();
    await again.pull();
    expect(again.list.role(pc.account.first.key)).toBe("drive");
    expect(again.list.role(guest.key)).toBeNull();
  });
});

describe("an entry this PC signed and does not know to be placed", () => {
  test("is kept over a restart: the next Allow at the same head sends that very entry, and signs no other", async () => {
    const pc = await following();
    await pc.pin();
    const phone = await listMember();
    const device = { key: phone.key, enc: phone.enc, card: await claimKey(pc.service, ACCOUNT, pc.account.id, phone), label: "Phone" };
    const sent: string[] = [];
    const watch = (of: Awaited<ReturnType<typeof following>>, away: boolean) => {
      const real = of.deps.call;
      return spyOn(of.deps, "call").mockImplementation(async (path, body, ready) => {
        if (path === "/v2/pc/list/entries") sent.push((body.entries as string[])[0]!);
        // nothing of the service answers: whether the entry was placed is not known
        if (away && (path === "/v2/pc/list/entries" || path === "/v2/pc/list/log")) throw new Error("no answer");
        return await real(path, body, ready);
      });
    };
    const first = watch(pc, true);
    try { expect(await pc.list.allowDevice(device, true)).toMatchObject({ refused: "service_away" }); } finally { first.mockRestore(); }
    expect(new Set(sent).size).toBe(1);
    const signed = sent[0]!;
    pc.list.stop();
    const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, pinned: pc.account.id });
    sent.length = 0;
    const second = watch(again, false);
    try { expect(await again.list.allowDevice(device, true)).toMatchObject({ allowed: { id: pc.account.id } }); } finally { second.mockRestore(); }
    expect(sent).toEqual([signed]);
    expect(existsSync(join(pc.stateDir, ACCOUNT_LIST_ALLOW_FILE))).toBe(false);
  });

  /** A pinned PC, two devices that claimed their keys, and what the PC sent to place entries; `away`: nothing of the service answers; `proving`: run before each placement's proof. */
  async function twoAsked() {
    const pc = await following();
    await pc.pin();
    const asking = async (label: string) => { const member = await listMember(); return { key: member.key, enc: member.enc, card: await claimKey(pc.service, ACCOUNT, pc.account.id, member), label }; };
    const phone = await asking("Phone");
    const tablet = await asking("Tablet");
    const sent: string[] = [];
    const state = { away: false, proving: null as (() => Promise<unknown>) | null };
    const real = pc.deps.call;
    const calls = spyOn(pc.deps, "call").mockImplementation(async (path, body, ready) => {
      // what happens while this PC proves itself for the placement
      if (path === "/v2/pc/list/entries") await state.proving?.();
      if (state.away && (path === "/v2/pc/list/entries" || path === "/v2/pc/list/log")) {
        if (path === "/v2/pc/list/entries") sent.push((body.entries as string[])[0]!);
        throw new Error("no answer");
      }
      return await real(path, body, path !== "/v2/pc/list/entries" ? ready : () => { ready?.(); sent.push((body.entries as string[])[0]!); });
    });
    stops.push(() => calls.mockRestore());
    const signer = (text: string) => { const kind = readKind(readBody(entryFromText(text).body)); return kind?.kind === "device" ? kind.key : null; };
    return { pc, phone, tablet, sent, state, signer, kept: join(pc.stateDir, ACCOUNT_LIST_ALLOW_FILE) };
  }

  test("goes first when another device is allowed at the same head: no second entry is signed on the head it stands on", async () => {
    const { pc, phone, tablet, sent, state, signer } = await twoAsked();
    state.away = true;
    expect(await pc.list.allowDevice(phone, true)).toMatchObject({ refused: "service_away" });
    const first = sent[0]!;
    sent.length = 0;
    state.away = false;
    expect(await pc.list.allowDevice(tablet, true)).toMatchObject({ allowed: { id: pc.account.id } });
    // the phone's entry as it was signed, then the tablet's on the head that followed
    expect(sent[0]).toBe(first);
    expect(sent.map(signer)).toEqual([phone.key, tablet.key]);
    const held = pc.service.accountList(ACCOUNT)!;
    expect(held.state.signers[tablet.key]!.seq).toBe(held.state.signers[phone.key]!.seq + 1);
  });

  test("of a device this PC has come to hold back is not sent, and nothing else is signed on its head", async () => {
    const { pc, phone, tablet, sent, state } = await twoAsked();
    state.away = true;
    expect(await pc.list.allowDevice(phone, true)).toMatchObject({ refused: "service_away" });
    sent.length = 0;
    state.away = false;
    pc.deps.mayAdmit = (key) => key !== phone.key;
    expect(await pc.list.allowDevice(tablet, true)).toEqual({ refused: "not_written", detail: "place_kept" });
    expect(sent).toEqual([]);
    expect(pc.service.accountList(ACCOUNT)!.state.signers[tablet.key]).toBeUndefined();
  });

  test("is forgotten when the account service itself says it did not place it", async () => {
    const { pc, phone, sent, kept } = await twoAsked();
    // a card nobody of the account claimed: the service refuses the entry by name
    const stranger = await listMember();
    const unclaimed = { key: stranger.key, enc: stranger.enc, card: await memberCard(stranger, pc.account.id), label: "Stranger" };
    expect(await pc.list.allowDevice(unclaimed, true)).toMatchObject({ refused: "not_claimed" });
    expect(existsSync(kept)).toBe(false);
    sent.length = 0;
    expect(await pc.list.allowDevice(phone, true)).toMatchObject({ allowed: { id: pc.account.id } });
    expect(sent).toHaveLength(1);
  });

  test("that the PC cannot read lets it sign nobody in: what it signed is not known", async () => {
    const { pc, phone, sent, kept } = await twoAsked();
    writeFileSync(kept, "{ not an entry", { mode: 0o600 });
    expect(await pc.list.allowDevice(phone, true)).toEqual({ refused: "not_written", detail: "kept_unreadable" });
    expect(sent).toEqual([]);
    expect(pc.service.accountList(ACCOUNT)!.state.signers[phone.key]).toBeUndefined();
  });

  test("that the PC cannot read holds its Allows only at the head where it found it so: once its verified head moved past that, the file goes and the PC signs again, and meanwhile its status says why", async () => {
    const { pc, phone, sent, kept } = await twoAsked();
    writeFileSync(kept, "{ not an entry", { mode: 0o600 });
    expect(await pc.list.allowDevice(phone, true)).toEqual({ refused: "not_written", detail: "kept_unreadable" });
    expect(pc.list.status().reason).toContain(ACCOUNT_LIST_ALLOW_FILE);
    expect(pc.list.summary()?.reason).toContain(ACCOUNT_LIST_ALLOW_FILE);
    // asked again at the same head: still nothing, and the file stays for a person to look at
    expect(await pc.list.allowDevice(phone, true)).toEqual({ refused: "not_written", detail: "kept_unreadable" });
    expect(existsSync(kept)).toBe(true);
    expect(sent).toEqual([]);
    // a member writes: the list moves on past the head at which the file was found unreadable
    await pc.account.addDevice(await listMember());
    expect(await pc.list.allowDevice(phone, true)).toMatchObject({ allowed: { id: pc.account.id } });
    expect(sent).toHaveLength(1);
    expect(existsSync(kept)).toBe(false);
    expect(pc.list.status().reason).toBeNull();
  });

  test("of a device this PC has come to hold back stops holding other Allows at its head ten minutes after it was kept", async () => {
    const { pc, phone, tablet, sent, state, kept } = await twoAsked();
    state.away = true;
    expect(await pc.list.allowDevice(phone, true)).toMatchObject({ refused: "service_away" });
    sent.length = 0;
    state.away = false;
    pc.deps.mayAdmit = (key) => key !== phone.key;
    expect(await pc.list.allowDevice(tablet, true)).toEqual({ refused: "not_written", detail: "place_kept" });
    expect(pc.list.status().reason).toContain("waits behind");
    // kept ten minutes ago and more: it is not sent, and no longer holds the place for another device
    const then = new Date(Date.now() - 10 * 60_000 - 1_000);
    utimesSync(kept, then, then);
    expect(await pc.list.allowDevice(tablet, true)).toMatchObject({ allowed: { id: pc.account.id } });
    const held = pc.service.accountList(ACCOUNT)!;
    expect(held.state.signers[phone.key]).toBeUndefined();
    expect(held.state.signers[tablet.key]).toBeDefined();
    expect(pc.list.status().reason).toBeNull();
  });

  test("of a device this PC has come to hold back gives its place up at once when the person at the PC declines that device's join, and no other entry goes so", async () => {
    const { pc, phone, tablet, sent, state, kept } = await twoAsked();
    state.away = true;
    expect(await pc.list.allowDevice(phone, true)).toMatchObject({ refused: "service_away" });
    sent.length = 0;
    state.away = false;
    pc.deps.mayAdmit = (key) => key !== phone.key;
    expect(await pc.list.allowDevice(tablet, true)).toEqual({ refused: "not_written", detail: "place_kept" });
    // the reason says that an Allow waits behind an earlier one, and until when
    const until = new Date(Date.now() + 10 * 60_000).toISOString().slice(0, 15);
    expect(pc.list.status().reason).toContain("waits behind");
    expect(pc.list.status().reason).toContain(until);
    // a decline of another device's join drops nothing
    pc.list.declinedHere(tablet.key);
    expect(existsSync(kept)).toBe(true);
    // the person at the PC declines the phone's join, which asked again: its entry goes, and the tablet takes the place
    pc.list.declinedHere(phone.key);
    expect(existsSync(kept)).toBe(false);
    expect(await pc.list.allowDevice(tablet, true)).toMatchObject({ allowed: { id: pc.account.id } });
    expect(pc.service.accountList(ACCOUNT)!.state.signers[phone.key]).toBeUndefined();
  });

  test("is not sent once this PC may sign no more: what a member's page brought while the PC proved itself is asked before the entry goes out", async () => {
    const { pc, phone, sent, state } = await twoAsked();
    // a device hands this PC an entry this Ovis is too old to read, while the PC's proof for the placement is made
    const later = await pc.account.signLater();
    const head = pc.account.place;
    state.proving = () => pc.list.takeFromPeer({ list: pc.account.id, after: head.seq, entries: [later], head: { seq: head.seq + 1, hash: entryHash(entryFromText(later).body) } });
    expect(await pc.list.allowDevice(phone, true)).toEqual({ refused: "behind", detail: null });
    expect(pc.list.status().behind).toBe(true);
    expect(sent).toEqual([]);
    expect(pc.service.accountList(ACCOUNT)!.state.signers[phone.key]).toBeUndefined();
  });

  test("is the one another Ovis on the same state folder sends: two servers on one folder sign one entry for one place", async () => {
    const { pc, phone, tablet, sent, state, signer } = await twoAsked();
    const other = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, pinned: pc.account.id });
    const otherSent: string[] = [];
    const real = other.deps.call;
    const calls = spyOn(other.deps, "call").mockImplementation(async (path, body, ready) =>
      await real(path, body, path !== "/v2/pc/list/entries" ? ready : () => { ready?.(); otherSent.push((body.entries as string[])[0]!); }));
    stops.push(() => calls.mockRestore());
    // that server has looked for a kept entry before, and found none
    const stranger = await listMember();
    expect(await other.list.allowDevice({ key: stranger.key, enc: stranger.enc, card: await memberCard(stranger, pc.account.id), label: "Stranger" }, true)).toMatchObject({ refused: "not_claimed" });
    otherSent.length = 0;
    state.away = true;
    expect(await pc.list.allowDevice(phone, true)).toMatchObject({ refused: "service_away" });
    // the other server on this folder is asked for another device while the first one's entry is not known to be placed
    expect(await other.list.allowDevice(tablet, true)).toMatchObject({ allowed: { id: pc.account.id } });
    expect(otherSent[0]).toBe(sent[0]!);
    expect(otherSent.map(signer)).toEqual([phone.key, tablet.key]);
  });

  test("whose answer was lost, and whose place the log cannot show, is told as not known: the service is away, not that the head was lost", async () => {
    const { pc, phone, sent } = await twoAsked();
    let lost = false;
    const down = { reads: false };
    // the service's own answers are changed under the PC's calls
    const answers = pc.service.fetch.bind(pc.service);
    const fetched = spyOn(pc.service, "fetch").mockImplementation(async (input, init) => {
      const path = new URL((input as Request).url).pathname;
      if (path === "/v2/pc/list/log" && down.reads) throw new Error("the read failed");
      const answer = await answers(input, init);
      if (path === "/v2/pc/list/entries" && !lost) { lost = true; down.reads = true; throw new Error("the answer was lost"); }
      return answer;
    });
    stops.push(() => fetched.mockRestore());
    // placed, the answer lost; every later try is answered head_moved, and no read shows the new head
    expect(await pc.list.allowDevice(phone, true)).toMatchObject({ refused: "service_away" });
    expect(new Set(sent).size).toBe(1);
    expect(pc.service.accountList(ACCOUNT)!.state.signers[phone.key]).toBeDefined();
  });

  test("of another binding of this PC is none of this one's", async () => {
    const { pc, phone, sent, kept } = await twoAsked();
    writeFileSync(kept, JSON.stringify({ v: 1, server_id: loadRelayIdentity(pc.stateDir).server_id, bind_id: "cd".repeat(16), list: pc.account.id, seq: 0, on_head: "00".repeat(32), key: phone.key, enc: phone.enc, entries: ["x"], wraps: [] }), { mode: 0o600 });
    expect(await pc.list.allowDevice(phone, true)).toMatchObject({ allowed: { id: pc.account.id } });
    expect(sent).toHaveLength(1);
    expect(existsSync(kept)).toBe(false);
  });
});

describe("the wait of one sign-in", () => {
  test("a returning device's sign-in waits its few seconds and no longer, also behind a read the mailbox began", async () => {
    const pc = await following();
    await pc.pin();
    await pc.account.addDevice(await listMember());
    // the mailbox names the new head, and the account service does not answer the read that follows
    pc.world.gate = new Promise(() => {});
    const before = pc.reads();
    pc.list.heard(ACCOUNT, pc.hint());
    await pc.asked(before);
    const began = Date.now();
    await pc.list.readForSignIn(50, () => true);
    expect(Date.now() - began).toBeLessThan(2_000);
  });

  test("a sign-in whose few seconds were spent on the pull before waits no second time for the same read", async () => {
    const pc = await following();
    await pc.pin();
    // the copy is stale, and the account service does not answer
    pc.world.seconds += 120;
    pc.world.gate = new Promise(() => {});
    const began = Date.now();
    await pc.list.beforeSession(0);
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(pc.reads()).toBeGreaterThan(0);
  });
});

describe("what a pinned PC keeps beside its pin", () => {
  test("an alarm outlives the loss of the copy: the PC then lets nobody of its list in until a person unpins it", async () => {
    const pc = await following();
    await pc.pin();
    // the first device signs another continuation from entry 0, with a device this PC never saw, which signs on it: the alarm rises
    pc.service.tamperList(pc.account.id, { reader: { server_id: pc.deps.identity()!.server_id }, fork: (await pc.account.forkFromStart()).texts });
    await pc.pull();
    pc.world.seconds += PC_READ_SECONDS;
    pc.list.tick();
    await pc.list.settled();
    pc.service.untamperList(pc.account.id);
    expect(pc.list.status().alarm).toBe("fork");
    // what a person is told: what happened, whom the PC still lets in, and what to do
    expect(pc.list.status().reason).toContain("two versions of your account's list");
    expect(pc.list.summary()).toEqual({ pinned_list: pc.account.id, standing: "in", reason: pc.list.status().reason });
    expect(pc.world.alarmed).toBe(true);
    pc.list.stop();
    rmSync(join(pc.stateDir, ACCOUNT_LIST_FILE));
    const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, pinned: pc.account.id, alarmed: true });
    await again.pull();
    expect(again.list.status()).toMatchObject({ pinned: true, standing: "in", alarm: "fork" });
    expect(again.list.status().reason).toContain("its copy of the list was lost");
    expect(again.list.role(pc.account.first.key)).toBeNull();
  });

  test("a removal the PC verified is kept though the same read then stops at an entry this Ovis is too old to place", async () => {
    const pc = await following();
    const phone = await listMember();
    await pc.account.addDevice(phone);
    await pc.pin();
    expect(pc.list.role(phone.key)).toBe("drive");
    // a member removes the phone; a member with a newer Ovis then writes an entry this build cannot read, and a key this
    // build does not know writes one after it: there it stops
    await pc.account.remove(phone.key);
    const later = await pc.account.signLater();
    const beyond = await pc.account.signLater(await listMember(), { seq: pc.account.place.seq + 1, hash: entryHash(entryFromText(later).body) });
    pc.service.tamperList(pc.account.id, { inject: [later, beyond] });
    await pc.pull();
    expect(pc.list.status().last_verdict).toBe("needs_newer_client");
    expect(pc.world.removed).toContain(phone.key);
    expect(pc.list.status()).toMatchObject({ standing: "stopped", reason: expect.stringContaining("Update Ovis on this PC") });
  });

  test("work that waited in the queue when the follower stopped writes nothing", async () => {
    const pc = await following();
    await pc.pin();
    const commits = pc.world.commits.length;
    // a read is out, and a tick's turn waits behind it
    let release = () => {};
    pc.world.gate = new Promise<void>((resolve) => { release = resolve; });
    const before = pc.reads();
    pc.world.seconds += PC_READ_SECONDS;
    pc.list.tick();
    await pc.asked(before);
    pc.list.start();
    pc.list.stop();
    const onDisk = readFileSync(join(pc.stateDir, ACCOUNT_LIST_FILE), "utf8");
    // the read that was out comes back with a new entry: nothing of it reaches the disk either
    await pc.account.addDevice(await listMember());
    release();
    await pc.list.settled();
    expect(pc.world.commits.length).toBe(commits);
    expect(readFileSync(join(pc.stateDir, ACCOUNT_LIST_FILE), "utf8")).toBe(onDisk);
    expect(existsSync(join(pc.stateDir, ACCOUNT_LIST_OWED_FILE))).toBe(false);
  });

  test("says nothing is wrong while it follows its list, and why it lets nobody in while it reads the list again after its copy was lost", async () => {
    const pc = await following();
    expect(pc.list.summary()).toBeNull();
    await pc.pin();
    expect(pc.list.status().reason).toBeNull();
    expect(pc.list.summary()).toEqual({ pinned_list: pc.account.id, standing: "in", reason: null });
    pc.list.stop();
    rmSync(join(pc.stateDir, ACCOUNT_LIST_FILE));
    const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, pinned: pc.account.id });
    again.world.log = () => { throw new Error("away"); };
    await again.pull();
    expect(again.list.summary()).toMatchObject({ pinned_list: pc.account.id, standing: "waiting", reason: expect.stringContaining("reading your account's list again") });
    // one name for the list the PC is pinned to, in both answers
    expect(again.list.status()).toMatchObject({ pinned: true, pinned_list: pc.account.id });
    expect(pc.list.status().pinned_list).toBe(pc.account.id);
    expect(again.list.role(pc.account.first.key)).toBeNull();
  });

  test("a copy made for other keys than this PC holds is dropped on a pinned PC too: the list is read again with the PC's own", async () => {
    const pc = await following();
    await pc.pin();
    pc.list.stop();
    // the file holds a copy of the same list and binding, made for a key this PC does not hold (its other folder's old copy)
    const stranger = await listMember();
    const other = pinList(null, { account: ACCOUNT, list: pc.account.id, me: { key: stranger.key, endpoint: pc.endpoint }, pin: { how: "added" } });
    if (!other.pinned) throw new Error("no copy");
    const path = join(pc.stateDir, ACCOUNT_LIST_FILE);
    const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...file, save: writeSave(other.copy) }));
    const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, pinned: pc.account.id });
    again.list.start();
    await again.pull();
    expect(again.list.status()).toMatchObject({ pinned: true, standing: "in" });
    expect(again.list.role(pc.account.first.key)).toBe("drive");
  });

  test("an alarm the binding's file did not take is offered to it again, though the rows were written", async () => {
    const pc = await following();
    await pc.pin();
    pc.world.alarmFails = true;
    pc.service.tamperList(pc.account.id, { reader: { server_id: pc.deps.identity()!.server_id }, fork: (await pc.account.forkFromStart()).texts });
    await pc.pull();
    pc.world.seconds += PC_READ_SECONDS;
    pc.list.tick();
    await pc.list.settled();
    pc.service.untamperList(pc.account.id);
    expect(pc.list.status().alarm).toBe("fork");
    expect(pc.world.alarmed).toBe(false);
    // no pull, no change of the list: the clock alone brings the write again
    pc.world.alarmFails = false;
    pc.list.tick();
    await pc.list.settled();
    expect(pc.world.alarmed).toBe(true);
  });

  test("a naming that waited for the PC's keys while the PC left its account and joined again names nothing for the new binding", async () => {
    const pc = await following();
    await pc.pull();
    const real = pc.deps.keys.keysFor.bind(pc.deps.keys);
    let waiting = false;
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slow = spyOn(pc.deps.keys, "keysFor").mockImplementation(async (serverId) => { waiting = true; await held; return await real(serverId); });
    try {
      const naming = pc.list.wantList(pc.account.id);
      const deadline = Date.now() + 10_000;
      while (!waiting) { if (Date.now() > deadline) throw new Error("The naming asked for no keys"); await Bun.sleep(5); }
      // Revoke all, then the same account again: another binding, which nobody named a list for
      pc.world.bind = "cd".repeat(16);
      expect(pc.list.status().want).toBeNull();
      release();
      expect(await naming).toEqual({ refused: "unavailable" });
    } finally { slow.mockRestore(); }
    expect(pc.list.status().want).toBeNull();
    // a member adds the PC: nothing pins the new binding
    await pc.addPc();
    expect(pc.list.status()).toMatchObject({ pinned: false });
    expect(pc.world.pinned).toBeNull();
  });

  test("a list named while the disk refuses the write is not the wanted one afterwards, and pins nothing later", async () => {
    const pc = await following();
    await pc.pull();
    const failing = spyOn(privateStateFs, "renameSync").mockImplementation((_from, to) => {
      if (String(to).endsWith(ACCOUNT_LIST_FILE)) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    });
    try { expect(await pc.list.wantList(pc.account.id)).toEqual({ refused: "unavailable" }); } finally { failing.mockRestore(); }
    expect(pc.list.status().want).toBeNull();
    // a member adds the PC all the same: nobody at this PC named the list, so nothing is pinned
    await pc.addPc();
    expect(pc.list.status()).toMatchObject({ pinned: false, standing: "in", want: null });
    expect(pc.world.pinned).toBeNull();
  });
});

describe("found in review", () => {
  test("a read that ends after a sign-in moved the copy's clock on is kept", async () => {
    const pc = await following();
    await pc.addPc();
    const phone = await listMember();
    await pc.account.addDevice(phone);
    let release = () => {};
    pc.world.gate = new Promise((resolve) => { release = resolve; });
    const before = pc.reads();
    pc.list.heard(ACCOUNT, pc.hint());
    await pc.asked(before);
    // a sign-in is decided on the copy meanwhile, a second later
    pc.world.seconds += 1;
    pc.list.shadowSignIn({ deviceId: "0".repeat(16), nonce: new Uint8Array(32), signature: "x", serverId: pc.deps.identity()!.server_id, snapshot: "admitted" });
    pc.list.shadowSnapshot([pc.account.first.key]);
    release();
    pc.world.gate = null;
    await pc.list.settled();
    expect(pc.list.status()).toMatchObject({ head: pc.account.place, devices: 2 });
  });

  test("what was said of a binding the PC left is not said of the next", async () => {
    const pc = await following();
    pc.world.log = () => { throw new AccountServiceRefusal(500, "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE", "/v2/pc/list/log"); };
    await pc.pull();
    // the code the service sent is no code of its own form: it is not repeated
    expect(pc.list.status().error).toBe("The account service answered 500 to /v2/pc/list/log");
    expect(pc.list.status().last_verdict).not.toBeNull();
    pc.world.bound = false;
    expect(pc.list.status()).toMatchObject({ account: null, list: null, last_verdict: null, error: null, keys: null, differences: 0 });
  });

  test("a hint asked for under one binding is not followed under the next", async () => {
    const pc = await following();
    const asked = pc.list.scopeToken();
    pc.world.bind = "cd".repeat(16);
    pc.list.heard(ACCOUNT, pc.hint(), asked);
    await pc.list.settled();
    expect(pc.world.calls).toEqual([]);
    expect(pc.list.status().list).toBeNull();
    // one asked for under the binding the PC has is
    pc.list.heard(ACCOUNT, pc.hint(), pc.list.scopeToken());
    await pc.list.settled();
    expect(pc.list.status().list).toBe(pc.account.id);
  });

  test("a PC that waits to be added renews its post by its own clock, with no mailbox answer", async () => {
    const pc = await following();
    await pc.pull();
    const posts = () => pc.world.calls.filter((path) => path === "/v2/pc/list/keys").length;
    expect(posts()).toBe(1);
    pc.world.seconds += PC_READ_SECONDS;
    pc.list.tick();
    await pc.list.settled();
    expect(posts()).toBe(2);
  });

  test("a post whose end is not ahead is no post: it is not named, and is made again within a minute", async () => {
    const pc = await following();
    pc.world.until = 0;
    await pc.pull();
    const posts = () => pc.world.calls.filter((path) => path === "/v2/pc/list/keys").length;
    expect(pc.list.status().posted_until).toBeNull();
    expect(posts()).toBe(1);
    pc.world.until = null;
    pc.world.seconds += 61;
    await pc.pull();
    expect(posts()).toBe(2);
    expect(pc.list.status().posted_until).not.toBeNull();
  });
});

describe("a PC in no account joins by the list", () => {
  test("is not said to have joined while the copy it read is not on disk; the next ask says so once it is", async () => {
    const pc = await following();
    pc.world.bound = false;
    const named = { account: ACCOUNT, list: pc.account.id, by: null };
    expect(await pc.list.joinList(named)).toEqual({ waiting: "waiting" });
    await pc.account.addPostedPc(pc.endpoint);
    const failing = spyOn(privateStateFs, "renameSync").mockImplementation((_from, to) => {
      if (String(to).endsWith(ACCOUNT_LIST_FILE)) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    });
    try {
      // bound and pinned by now, which is on disk with the binding; the copy is not
      expect(await pc.list.joinList(named)).toEqual({ waiting: "in" });
      expect(pc.world.pinned).toBe(pc.account.id);
      expect(await pc.list.joinList(named)).toEqual({ waiting: "in" });
    } finally { failing.mockRestore(); }
    expect(await pc.list.joinList(named)).toMatchObject({ joined: { pinned: true, standing: "in" } });
    pc.list.stop();
    const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, pinned: pc.account.id });
    again.list.start();
    await again.list.settled();
    expect(again.list.status()).toMatchObject({ pinned: true, standing: "in", head: pc.account.place });
    expect(again.world.calls).toEqual([]);
  });
});
