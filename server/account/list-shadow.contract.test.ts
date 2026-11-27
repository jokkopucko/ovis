/**
 * The PC shadows its account's signed list (docs/account.md, "The account's signed list on a PC"): it reads the list
 * with its own proof, checks it, saves it and says where it would decide otherwise than the snapshot. It lets nobody
 * in and puts nobody out by it, whatever the account service shows.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { entryFromText, entryHash } from "../../shared/account-list-entry.ts";
import { accountDeviceId } from "../../shared/account-records.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { handleRequest } from "../dispatch.ts";
import { relayConnection, relayFixture } from "../relay/test-helpers.ts";
import { ACCOUNT_LIST_FILE } from "./list-follow.ts";
import { ACCOUNT_LIST_KEYS_FILE } from "./list-keys.ts";
import { listMember, memberCard, TestList, type ListMember } from "./list.test-helpers.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

/** A PC in an account whose snapshot lets one device in ("Laptop"), and the account on the service's list switch. */
async function shadowPc() {
  const pc = await createListedPc((close) => closes.push(close));
  pc.service.listAccounts = "*";
  const { services } = pc.fixture.app.context;
  const identity = services.relay.currentIdentity()!;
  const endpoint = bytesToHex(importPublicKey(identity.public_key));
  const list = services.accountList!;
  /** One mailbox pull, with the snapshot read after it, and the list followed to the end of what it heard. */
  const pull = async () => { await services.accountMailbox.pull(); await list.settled(); };
  const laptop = await listMember(pc.device.keys);
  const rows = () => services.accountRows!.rows().map((row) => ({ key: row.key, state: row.state }));
  const signsIn = async (device: { keys: CryptoKeyPair; publicKey: string; id: string }) => {
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    return await link.auth(device).then(() => true, () => false);
  };
  return { ...pc, services, endpoint, list, pull, laptop, rows, signsIn };
}

const idOf = (serverId: string, member: ListMember) => ({ keys: member.keys, publicKey: member.key, id: accountDeviceId(serverId, member.key) });

describe("a PC in an account that has a signed list", () => {
  test("reads the list with its own proof, checks it and says what it holds", async () => {
    const pc = await shadowPc();
    const account = await TestList.start(pc.service, ACCOUNT);
    await account.addDevice(pc.laptop);
    await pc.pull();
    expect(pc.list.status()).toMatchObject({
      account: ACCOUNT, list: account.id, pinned: false, standing: "waiting", head: account.place, devices: 2, pcs: 0, alarm: null,
      last_verdict: "caught_up", keys: "ready", error: null,
    });
    expect(Date.parse(pc.list.status().last_read_at!)).toBeGreaterThan(Date.now() - 60_000);
  });

  test("an account that has no list, or is off the service's switch, is followed by nobody and reads no log", async () => {
    const pc = await shadowPc();
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ list: null, pinned: false, standing: null, last_verdict: "none", error: null });
    await TestList.start(pc.service, ACCOUNT);
    pc.service.listAccounts = "";
    await pc.pull();
    expect(pc.list.status().list).toBeNull();
    expect(pc.service.requests.some((request) => request.includes("/v2/pc/list"))).toBe(false);
    expect(existsSync(join(pc.fixture.stateDir, ACCOUNT_LIST_FILE))).toBe(false);
  });

  test("posts its keys and its card, so a member can add it, and is in the list once a member has", async () => {
    const pc = await shadowPc();
    const account = await TestList.start(pc.service, ACCOUNT);
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ standing: "waiting", pcs: 0 });
    expect(Date.parse(pc.list.status().posted_until!)).toBeGreaterThan(Date.now());
    await account.addPostedPc(pc.endpoint);
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ standing: "in", pcs: 1, head: account.place, pinned: false });
  });

  test("a quiet list costs no read of the log: the head the mailbox names is the copy's own", async () => {
    const pc = await shadowPc();
    await TestList.start(pc.service, ACCOUNT);
    await pc.pull();
    const reads = () => pc.service.requests.filter((request) => request.includes("/v2/pc/list/log")).length;
    const before = reads();
    expect(before).toBeGreaterThan(0);
    await pc.pull();
    expect(reads()).toBe(before);
    expect(pc.list.status().last_verdict).toBe("same");
  });

  test("saves its copy in a file only this user reads, and a restart goes on from it without reading the log again", async () => {
    const pc = await shadowPc();
    const account = await TestList.start(pc.service, ACCOUNT);
    await account.addDevice(pc.laptop);
    await pc.pull();
    const path = join(pc.fixture.stateDir, ACCOUNT_LIST_FILE);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const held = pc.list.status();
    pc.fixture.app.stop();
    const again = relayFixture(false, { stateDir: pc.fixture.stateDir, accountOpensAll: true, accountService: { url: "https://account.test", fetch: pc.service.fetch } });
    closes.push(() => again.app.stop());
    const { accountMailbox, accountList } = again.app.context.services;
    const reads = pc.service.requests.filter((request) => request.includes("/v2/pc/list/log")).length;
    await accountMailbox.pull();
    await accountList!.settled();
    expect(accountList!.status()).toMatchObject({ list: held.list, head: held.head, devices: held.devices, standing: held.standing, last_verdict: "same" });
    expect(pc.service.requests.filter((request) => request.includes("/v2/pc/list/log")).length).toBe(reads);
    // and from there on it takes what comes after its saved head
    const phone = await listMember();
    await account.addDevice(phone);
    await accountMailbox.pull();
    await accountList!.settled();
    expect(accountList!.status()).toMatchObject({ head: account.place, devices: 3 });
  });
  test("a file that is no copy is read again from the service, and decides nothing meanwhile", async () => {
    const pc = await shadowPc();
    const account = await TestList.start(pc.service, ACCOUNT);
    await account.addDevice(pc.laptop);
    await pc.pull();
    const held = pc.list.status();
    pc.fixture.app.stop();
    writeFileSync(join(pc.fixture.stateDir, ACCOUNT_LIST_FILE), "{ not a copy");
    const again = relayFixture(false, { stateDir: pc.fixture.stateDir, accountOpensAll: true, accountService: { url: "https://account.test", fetch: pc.service.fetch } });
    closes.push(() => again.app.stop());
    const { accountMailbox, accountList } = again.app.context.services;
    await accountMailbox.pull();
    await accountList!.settled();
    expect(accountList!.status()).toMatchObject({ list: held.list, head: held.head, devices: held.devices, error: null });
  });
});

describe("the list decides nothing yet", () => {
  test("a device the list lets in and the snapshot does not is not let in", async () => {
    const pc = await shadowPc();
    const account = await TestList.start(pc.service, ACCOUNT);
    await pc.pull();
    await account.addPostedPc(pc.endpoint);
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ standing: "in", devices: 1 });
    expect(pc.rows().map((row) => row.key)).toEqual([pc.device.publicKey]);
    expect(await pc.signsIn(idOf(pc.serverId, account.first))).toBe(false);
  });

  test("a device the list put out and the snapshot still names keeps its sign-in", async () => {
    const pc = await shadowPc();
    const account = await TestList.start(pc.service, ACCOUNT);
    await account.addDevice(pc.laptop);
    await pc.pull();
    await account.addPostedPc(pc.endpoint);
    await account.remove(pc.laptop.key);
    // the account service retires the laptop's registered key with its removal (its member key is that key, D11.4): only a
    // snapshot that is wrong, or behind, still names it, which a PC from before the list trusts
    pc.service.tamperAccount(ACCOUNT, { eligibleAgain: [pc.device.publicKey] });
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ standing: "in", devices: 1 });
    expect(pc.rows()).toEqual([{ key: pc.device.publicKey, state: "hold" }]);
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 11_000);
    try { expect(await pc.signsIn(pc.device)).toBe(true); } finally { clock.mockRestore(); }
  });

  test("a PC the list put out stays in its account and keeps its rows", async () => {
    const pc = await shadowPc();
    const account = await TestList.start(pc.service, ACCOUNT);
    await pc.pull();
    await account.addPostedPc(pc.endpoint);
    await pc.pull();
    const posted = account.service.accountList(ACCOUNT)!.state.pcs[pc.endpoint]!.key!;
    await account.remove(posted);
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ standing: "out", pcs: 0 });
    expect(pc.services.devices.account()).toBe(ACCOUNT);
    expect(pc.rows().map((row) => row.key)).toEqual([pc.device.publicKey]);
  });
});

describe("where the list would decide otherwise, the PC says so once", () => {
  async function differing() {
    const pc = await shadowPc();
    const account = await TestList.start(pc.service, ACCOUNT);
    await pc.pull();
    await account.addPostedPc(pc.endpoint);
    await pc.pull();
    return { pc, account };
  }
  const said = (log: { mock: { calls: unknown[][] } }): Record<string, unknown>[] => log.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("account.list.differs"))
    .map((line) => { const { time: _time, ...event } = JSON.parse(line) as Record<string, unknown>; return event; });

  test("a device only the snapshot names, and one only the list names", async () => {
    const log = spyOn(console, "info").mockImplementation(() => {});
    try {
      const { pc } = await differing();
      // the first pull's snapshot read met a list that does not hold this PC yet, the second one that does
      expect(said(log)).toEqual([
        { event: "account.list.differs", snapshot: "admitted", list: "waiting", of: "device" },
        { event: "account.list.differs", snapshot: "admitted", list: "never_added", of: "credential" },
        { event: "account.list.differs", snapshot: "none", list: "drive", of: "credential" },
      ]);
      await pc.pull();
      await pc.pull();
      expect(said(log)).toHaveLength(3);
      expect(pc.list.status().differences).toBe(3);
    } finally { log.mockRestore(); }
  });

  test("a sign-in is compared too, and a difference already said is not said again", async () => {
    const { pc, account } = await differing();
    const log = spyOn(console, "info").mockImplementation(() => {});
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 11_000);
    try {
      const before = pc.list.status().differences;
      expect(await pc.signsIn(pc.device)).toBe(true);
      expect(await pc.signsIn(idOf(pc.serverId, account.first))).toBe(false);
      // a stranger's key, and the first device's id with a signature of another key, are no difference
      expect(await pc.signsIn(idOf(pc.serverId, await listMember()))).toBe(false);
      expect(await pc.signsIn({ ...idOf(pc.serverId, account.first), keys: (await listMember()).keys })).toBe(false);
      await pc.list.settled();
      expect(pc.list.status().differences).toBe(before);
      expect(said(log)).toEqual([]);
    } finally { clock.mockRestore(); log.mockRestore(); }
  });

  test("a sign-in of a device the list alone lets in is a difference only for the proof of its key", async () => {
    const pc = await shadowPc();
    const account = await TestList.start(pc.service, ACCOUNT);
    await pc.pull();
    await account.addPostedPc(pc.endpoint);
    await pc.pull();
    // a device the list lets in after the last snapshot read: only its sign-in can say so
    const phone = await listMember();
    await account.addDevice(phone);
    // the snapshot is not served meanwhile, so no whole read says it first
    pc.service.opensAll = false;
    await pc.pull();
    const log = spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await pc.signsIn({ ...idOf(pc.serverId, phone), keys: (await listMember()).keys })).toBe(false);
      await pc.list.settled();
      expect(said(log)).toEqual([]);
      expect(await pc.signsIn(idOf(pc.serverId, phone))).toBe(false);
      await pc.list.settled();
      expect(said(log)).toEqual([{ event: "account.list.differs", snapshot: "none", list: "drive", of: "credential" }]);
    } finally { log.mockRestore(); }
  });

  test("a device the list lets in only to watch, or only until a time that has passed", async () => {
    const pc = await shadowPc();
    const account = await TestList.start(pc.service, ACCOUNT);
    await pc.pull();
    await account.addPostedPc(pc.endpoint);
    await account.addDevice(pc.laptop, { role: "watch", until: Math.floor(Date.now() / 1000) + 3600, power: "bound" });
    const log = spyOn(console, "info").mockImplementation(() => {});
    try {
      await pc.pull();
      expect(said(log).filter((event) => event.snapshot === "admitted")).toEqual([{ event: "account.list.differs", snapshot: "admitted", list: "watch", of: "device" }]);
      const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 3601_000);
      try {
        await pc.signsIn(pc.device);
        expect(said(log).filter((event) => event.snapshot === "admitted").at(-1)).toEqual({ event: "account.list.differs", snapshot: "admitted", list: "expired", of: "device" });
      } finally { clock.mockRestore(); }
    } finally { log.mockRestore(); }
  });
});

describe("what the account service shows wrongly changes the copy's verdict and nothing else", () => {
  async function following(other?: ListMember) {
    const pc = await shadowPc();
    const account = await TestList.start(pc.service, ACCOUNT);
    await account.addDevice(pc.laptop);
    if (other !== undefined) await account.addDevice(other);
    await pc.pull();
    await account.addPostedPc(pc.endpoint);
    await pc.pull();
    const before = { rows: pc.rows(), account: pc.services.devices.account(), status: pc.list.status() };
    const unchanged = () => {
      expect(pc.rows()).toEqual(before.rows);
      expect(pc.services.devices.account()).toBe(before.account);
    };
    return { pc, account, before, unchanged, reader: { server_id: pc.serverId } };
  }

  test("an entry signed by a key that is no member is passed over: nobody comes in by it", async () => {
    const { pc, account, before, unchanged, reader } = await following();
    const stranger = await listMember();
    const injected = await account.sign({ kind: "device", key: stranger.key, power: "full", role: "drive", until: null, enc: stranger.enc,
      card: await memberCard(stranger, account.id), sealed: null, rotates: false }, stranger, before.status.head!);
    pc.service.tamperList(account.id, { reader, inject: [injected] });
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ devices: before.status.devices, pcs: 1, alarm: null });
    unchanged();
  });

  test("a withheld tail leaves the copy where it was", async () => {
    // a device whose member key no sign-in registered: putting it out signs nobody out of the account service (D11.4), so
    // the PC's rows are the snapshot's as before
    const other = await listMember();
    const { pc, account, before, unchanged, reader } = await following(other);
    pc.service.tamperList(account.id, { reader, withholdAfter: before.status.head!.seq });
    await account.remove(other.key);
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ head: before.status.head, devices: before.status.devices });
    unchanged();
    pc.service.untamperList(account.id);
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ head: account.place, devices: before.status.devices - 1 });
    unchanged();
  });

  test("an old head, replayed, changes nothing", async () => {
    const { pc, account, before, unchanged, reader } = await following();
    pc.service.tamperList(account.id, { reader, head: { seq: 0, hash: account.id }, withholdAfter: 0 });
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ head: before.status.head, devices: before.status.devices, pcs: 1, last_verdict: "older" });
    unchanged();
  });

  test("another history under what a member signed raises the alarm, and adds nobody", async () => {
    const { pc, account, before, unchanged, reader } = await following();
    const other = await listMember();
    // the first device signs a second continuation from entry 0: a history of its own that differs from the PC's
    const forked = await account.sign({ kind: "device", key: other.key, power: "full", role: "drive", until: null, enc: other.enc,
      card: await memberCard(other, account.id), sealed: null, rotates: false }, account.first, { seq: 0, hash: account.id });
    // That one entry alone is what a member signed and left behind when another got its place: the first device went on in the list the PC
    // holds, and nobody else signed on this one. It is refused, and no alarm rises.
    pc.service.tamperList(account.id, { reader, fork: [forked] });
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ alarm: null, last_verdict: "refused chain_broken", head: before.status.head, devices: before.status.devices });
    unchanged();
    // Another member signed on it: somebody lives on that history
    const lived = await account.sign({ kind: "remove", ends: other.key }, other, { seq: 1, hash: entryHash(entryFromText(forked).body) });
    pc.service.tamperList(account.id, { reader, fork: [forked, lived] });
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ alarm: "fork", head: before.status.head, devices: before.status.devices });
    unchanged();
  });

  test("another account's list under this account's id is not this PC's list", async () => {
    const { pc, account, before, unchanged, reader } = await following();
    const theirs = await TestList.start(pc.service, "acct_other");
    await theirs.addDevice(await listMember());
    pc.service.tamperList(account.id, { reader, answerList: theirs.id });
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ list: account.id, head: before.status.head, devices: before.status.devices });
    unchanged();
  });

  test("a changed byte of an entry is refused, and what held before it stays", async () => {
    const { pc, account, before, unchanged, reader } = await following();
    await account.addDevice(await listMember());
    pc.service.tamperList(account.id, { reader, flipEntry: { seq: account.place.seq } });
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ head: before.status.head, devices: before.status.devices });
    expect(pc.list.status().last_verdict).toStartWith("refused");
    unchanged();
  });

  test("a service that answers as if the account were off the switch is a service that is away: the copy stays", async () => {
    const { pc, account, before, unchanged } = await following();
    await account.addDevice(await listMember());
    pc.service.listAccounts = "";
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ list: account.id, head: before.status.head, devices: before.status.devices, standing: "in" });
    unchanged();
  });
});

describe("nothing secret leaves the PC", () => {
  test("no log line and no answer holds a key, and the keys file is this user's alone", async () => {
    const lines: string[] = [];
    const sinks: { mockRestore(): void }[] = (["info", "log", "warn", "error"] as const).map((name) => spyOn(console, name).mockImplementation((...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); }));
    try {
      const pc = await shadowPc();
      // every call of a list route, as the PC's own code hands it over to be proved and sent
      const route = spyOn(pc.services.accountMailbox, "listRoute");
      sinks.push(route);
      const account = await TestList.start(pc.service, ACCOUNT);
      await account.addDevice(pc.laptop);
      await pc.pull();
      await account.addPostedPc(pc.endpoint);
      await pc.pull();
      await pc.pull();
      const sent = route.mock.calls.map(([called, body]) => `${called} ${JSON.stringify(body)}`);
      const path = join(pc.fixture.stateDir, ACCOUNT_LIST_KEYS_FILE);
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
      const file = JSON.parse(readFileSync(path, "utf8")) as { signing: string; encryption: string };
      const own = pc.service.accountList(ACCOUNT)!.state.pcs[pc.endpoint]!;
      const answer = JSON.stringify(pc.list.status());
      const copy = readFileSync(join(pc.fixture.stateDir, ACCOUNT_LIST_FILE), "utf8");
      expect(lines.some((line) => line.includes("account.list.differs"))).toBe(true);
      for (const text of [...lines, answer]) {
        for (const secret of [file.signing, file.encryption, own.key!, own.enc!, pc.laptop.key, account.first.key, pc.endpoint]) expect(text).not.toContain(secret);
        expect(text).not.toMatch(/[A-Za-z0-9_-]{100,}/);
      }
      // the copy holds the list, which names public keys, and neither secret
      for (const secret of [file.signing, file.encryption]) expect(copy).not.toContain(secret);
      // what the account service was sent holds neither secret, whole or in part; and it was sent the keys post
      expect(sent.some((body) => body.includes(own.key!) && body.includes(own.enc!))).toBe(true);
      for (const body of sent) {
        for (const secret of [file.signing, file.encryption]) for (const part of [secret, secret.slice(40, 100), secret.slice(-60)]) expect(body).not.toContain(part);
      }
    } finally { for (const sink of sinks) sink.mockRestore(); }
  });

  test("only this PC's own window reads how it follows the list", async () => {
    const pc = await shadowPc();
    await TestList.start(pc.service, ACCOUNT);
    await pc.pull();
    const own = await fetch(`http://127.0.0.1:${pc.fixture.app.port}/api/account/list`);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ account: ACCOUNT, pinned: false, standing: "waiting", differences: expect.any(Number) });
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 11_000);
    try {
      const relayed = await handleRequest(new Request("https://relay.ovis.invalid/api/account/list"),
        { ...pc.fixture.app.context, peer: { kind: "relay", device: { id: pc.member.id, label: "Account phone", role: "drive" }, sessionId: "s", serverId: pc.serverId, key: pc.member.publicKey }, timeout: () => {} });
      expect([relayed?.status, ((await relayed!.json()) as { error: { code: string } }).error.code]).toEqual([403, "owner_only"]);
    } finally { clock.mockRestore(); }
  });
});
