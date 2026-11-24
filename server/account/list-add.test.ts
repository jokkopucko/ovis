/** The number a PC shows while it is added to an account's signed list (list-add.ts): how long it lasts, what replaces it, what ends the add. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardBinding } from "../../shared/account-list.ts";
import { fromBase64Url, pairCommitment, pairDigits, randomPairNonce, toBase64Url } from "../../shared/relay-pair-sas.ts";
import { ADD_ATTEMPT_MS, ADD_COMMITMENTS_MAX, ADD_POLL_MS, ADD_WINDOW_MS, ListAdd, type ListAddDeps } from "./list-add.ts";
import type { JoinOutcome } from "./list-follow.ts";
import { ListKeyStore } from "./list-keys.ts";
import { listMember } from "./list.test-helpers.ts";

const ACCOUNT = "acct_1";
const LIST = "0f484e9226ad290aaac6dea9244aced4e2b7b97297ecd8d52d437a57c33e5383";
const SERVER = "0123456789abcdef0123456789abcdef";
const ENDPOINT = "8f40c5adb68f25624ae5b214ea767a6ec94d829d3d7b5e1ad1ba6f3e2138285f";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Open { adder: string; commitment: string; nonce: string | null; reveal: string | null }

/** A PC's add against an account service that only carries the four messages, and a clock the test moves. */
async function adding(options: { list?: string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ovis-list-add-"));
  dirs.push(dir);
  const keys = await new ListKeyStore(dir).keysFor(SERVER);
  const phone = await listMember();
  const binding = cardBinding({ key: keys.key, enc: keys.enc, list: LIST, endpoint: ENDPOINT, invite: null });
  const world = { now: 1_800_000_000_000, serverId: SERVER, open: null as Open | null, calls: [] as string[], joins: 0, by: undefined as string | null | undefined, joined: { waiting: "waiting" } as JoinOutcome, told: 0, phone: phone.key,
    /** What happens while the list is read, with what the join was handed. */
    during: null as ((given: Parameters<ListAddDeps["join"]>[0]) => void) | null,
    /** What happens while a call to the account service is out. */
    calling: null as ((path: string, body: Record<string, unknown>) => void) | null,
    /** The account and list this PC is pinned to, as its follower says. */
    pinnedTo: null as { account: string; list: string } | null };
  const add = new ListAdd({
    own: async () => ({ serverId: world.serverId, endpoint: ENDPOINT, keys }),
    listNamed: async () => options.list === undefined ? LIST : options.list,
    call: async (path, body) => {
      world.calling?.(path, body);
      world.calls.push(body.nonce === undefined ? path : `${path} nonce`);
      if (path === "/v2/pc/list/keys") return {};
      const open = world.open;
      if (body.nonce === undefined) return { attempt: open };
      if (open === null || open.commitment !== body.commitment || (open.nonce !== null && open.nonce !== body.nonce)) throw new Error("attempt_changed");
      world.open = { ...open, nonce: body.nonce as string };
      return { attempt: world.open };
    },
    join: async (given) => { world.joins++; world.by = given.by; world.during?.(given); return world.joined; },
    joined: async () => { world.told++; },
    joinedTo: (account, list) => world.pinnedTo !== null && world.pinnedTo.account === account && world.pinnedTo.list === list,
    now: () => world.now,
    mono: () => world.now,
  });
  /** The phone opens an attempt; `reveal` gives its nonce away once the PC answered, and says the number the phone shows. */
  const commits = (adder = phone.key) => {
    const nonce = randomPairNonce();
    const commitment = toBase64Url(pairCommitment(binding, adder, nonce));
    world.open = { adder, commitment, nonce: null, reveal: null };
    return {
      commitment,
      reveal: (given: Uint8Array = nonce): string => {
        if (world.open === null || world.open.commitment !== commitment || world.open.nonce === null) throw new Error("The PC has not answered this commitment");
        world.open = { ...world.open, reveal: toBase64Url(given) };
        return pairDigits(binding, adder, nonce, fromBase64Url(world.open.nonce!));
      },
    };
  };
  /** One ask of the PC, a poll's time after the one before. */
  const next = async () => { world.now += ADD_POLL_MS; return await add.state(); };
  /** A number on the PC's screen, compared the whole way. */
  const number = async (): Promise<string> => {
    const attempt = commits();
    await next();
    const digits = attempt.reveal();
    expect(await next()).toMatchObject({ state: "number", digits });
    return digits;
  };
  return { add, world, phone, commits, next, number };
}

test("the PC posts its card, answers the phone's commitment once, and shows the phone's number only after the reveal holds", async () => {
  const { add, world, commits, next } = await adding();
  expect(await add.start(ACCOUNT)).toMatchObject({ state: "waiting", account: ACCOUNT, list: LIST });
  expect(world.calls).toEqual(["/v2/pc/list/keys", "/v2/pc/list/attempt"]);
  const attempt = commits();
  // the commitment alone gives no number: the PC's nonce went out before the phone's came
  expect(await next()).toMatchObject({ state: "waiting" });
  expect(world.open?.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const digits = attempt.reveal();
  expect(await next()).toMatchObject({ state: "number", digits });
  expect(world.calls.filter((call) => call.endsWith("nonce"))).toHaveLength(1);
});

test("an answer that did not arrive is sent again with the same nonce, never with another", async () => {
  const { add, world, commits, next } = await adding();
  await add.start(ACCOUNT);
  const attempt = commits();
  await next();
  const first = world.open!.nonce;
  // the service lost it
  world.open = { ...world.open!, nonce: null };
  await next();
  expect(world.open.nonce).toBe(first);
  const digits = attempt.reveal();
  expect(await next()).toMatchObject({ state: "number", digits });
});

test("a reveal that does not open the commitment shows no number", async () => {
  const { add, commits, next } = await adding();
  await add.start(ACCOUNT);
  const attempt = commits();
  await next();
  attempt.reveal(randomPairNonce());
  expect(await next()).toMatchObject({ state: "waiting" });
  // and that commitment gets no second answer
  expect(await next()).toMatchObject({ state: "waiting" });
});

test("it asks the account service at most once in a poll's time", async () => {
  const { add, world } = await adding();
  await add.start(ACCOUNT);
  const asked = world.calls.length;
  await add.state();
  world.now += ADD_POLL_MS - 1;
  await add.state();
  expect(world.calls).toHaveLength(asked);
  world.now += 1;
  await add.state();
  expect(world.calls).toHaveLength(asked + 1);
});

test("a number lasts two minutes: after them a yes to it confirms nothing", async () => {
  const { add, world, number } = await adding();
  await add.start(ACCOUNT);
  const digits = await number();
  world.now += ADD_ATTEMPT_MS;
  expect(await add.confirm(digits)).toEqual({ mismatch: true });
  expect(await add.state()).toMatchObject({ state: "waiting" });
  expect(world.joins).toBe(0);
});

test("a new commitment takes the place of the number on the screen: never two, and the old one cannot be confirmed", async () => {
  const { add, world, commits, number, next } = await adding();
  await add.start(ACCOUNT);
  const first = await number();
  const second = commits();
  expect(await next()).toMatchObject({ state: "waiting" });
  expect(await add.confirm(first)).toEqual({ mismatch: true });
  const digits = second.reveal();
  expect(await next()).toMatchObject({ state: "number", digits });
  expect(world.joins).toBe(0);
});

test("a commitment the PC has answered before gets no second nonce and no number", async () => {
  const { add, world, commits, next } = await adding();
  await add.start(ACCOUNT);
  const first = commits();
  await next();
  const replayed = { ...world.open! };
  commits();
  await next();
  // the service shows the first commitment again, as if it were new
  world.open = { ...replayed, nonce: null, reveal: null };
  expect(await next()).toMatchObject({ state: "waiting" });
  expect(world.open.nonce).toBeNull();
  expect(world.open.commitment).toBe(first.commitment);
  expect(world.calls.filter((call) => call.endsWith("nonce"))).toHaveLength(2);
});

test("one add answers three commitments; the fourth ends it", async () => {
  const { add, commits, next } = await adding();
  await add.start(ACCOUNT);
  for (let index = 0; index < ADD_COMMITMENTS_MAX; index++) { commits(); expect(await next()).toMatchObject({ state: "waiting" }); }
  commits();
  expect(await next()).toMatchObject({ state: "ended", account: ACCOUNT, why: "attempts" });
  expect(await next()).toMatchObject({ state: "ended", account: ACCOUNT, why: "attempts" });
});

test("after the yes the PC asks for no further number and joins once its entry is there", async () => {
  const { add, world, commits, number, next } = await adding();
  await add.start(ACCOUNT);
  const digits = await number();
  expect(await add.confirm(digits)).toMatchObject({ confirmed: { state: "confirmed" } });
  expect(world.joins).toBe(1);
  // the entry that adds this PC must be the one the device whose number was confirmed signed
  expect(world.by).toBe(world.phone);
  const asked = world.calls.length;
  commits();
  expect(await next()).toMatchObject({ state: "confirmed" });
  expect(world.calls).toHaveLength(asked);
  world.joined = { joined: {} as never };
  expect(await next()).toMatchObject({ state: "added", account: ACCOUNT, list: LIST });
  expect(world.told).toBe(1);
  expect(await next()).toMatchObject({ state: "added", account: ACCOUNT, list: LIST });
  expect(world.told).toBe(1);
});

test("the add ends ten minutes after it began, confirmed or not, and with a refusal of the list", async () => {
  const waiting = await adding();
  await waiting.add.start(ACCOUNT);
  waiting.world.now += ADD_WINDOW_MS;
  expect(await waiting.add.state()).toMatchObject({ state: "ended", account: ACCOUNT, why: "timeout" });

  const confirmed = await adding();
  await confirmed.add.start(ACCOUNT);
  await confirmed.add.confirm(await confirmed.number());
  // the entry is there by the time the ten minutes are over: it joins nothing any more
  confirmed.world.joined = { joined: {} as never };
  confirmed.world.now += ADD_WINDOW_MS;
  const joins = confirmed.world.joins;
  expect(await confirmed.add.state()).toMatchObject({ state: "ended", account: ACCOUNT, why: "timeout" });
  expect(confirmed.world.joins).toBe(joins);
  expect(confirmed.world.told).toBe(0);

  const refused = await adding();
  await refused.add.start(ACCOUNT);
  refused.world.joined = { refused: "removed" };
  expect(await refused.add.confirm(await refused.number())).toMatchObject({ confirmed: { state: "ended", account: ACCOUNT, why: "removed" } });
});

test("the ten minutes and a No are asked at the binding itself: a read of the list that ends after either binds nothing", async () => {
  const late = await adding();
  await late.add.start(ACCOUNT);
  const digits = await late.number();
  // the time runs out while the confirmed add reads the list: the join is handed what says so at its write
  const seen: boolean[] = [];
  late.world.during = (given) => { seen.push(given.live()); late.world.now += ADD_WINDOW_MS; seen.push(given.live()); };
  expect(await late.add.confirm(digits)).toMatchObject({ confirmed: { state: "ended", why: "timeout" } });
  expect(seen).toEqual([true, false]);

  const no = await adding();
  await no.add.start(ACCOUNT);
  const shown = await no.number();
  // the person at the PC says no while the list is read: the No does not wait for that read to be seen
  const told: boolean[] = [];
  let cancelled: Promise<unknown> | null = null;
  no.world.during = (given) => { cancelled = no.add.cancel(); told.push(given.live()); };
  expect(await no.add.confirm(shown)).toMatchObject({ confirmed: { state: "ended", why: "cancelled" } });
  expect(await cancelled).toMatchObject({ state: "ended", why: "cancelled" });
  expect(told).toEqual([false]);
  expect(no.world.told).toBe(0);
});

test("an add whose PC is in the account by that list when its ten minutes end says so, not that it timed out", async () => {
  const { add, world, number } = await adding();
  await add.start(ACCOUNT);
  const digits = await number();
  // the PC is pinned, and its first copy has not reached the disk yet
  world.joined = { waiting: "in" };
  expect(await add.confirm(digits)).toMatchObject({ confirmed: { state: "confirmed" } });
  world.pinnedTo = { account: ACCOUNT, list: LIST };
  world.now += ADD_WINDOW_MS;
  expect(await add.state()).toMatchObject({ state: "added", account: ACCOUNT, list: LIST });
  expect(world.told).toBe(1);
  // and one that is not in by then timed out, as before
  const late = await adding();
  await late.add.start(ACCOUNT);
  late.world.joined = { waiting: "in" };
  await late.add.confirm(await late.number());
  late.world.now += ADD_WINDOW_MS;
  expect(await late.add.state()).toMatchObject({ state: "ended", why: "timeout" });
});

test("a poll that was out at the account service when the person said No answers no commitment", async () => {
  const { add, world, commits, next } = await adding();
  await add.start(ACCOUNT);
  commits();
  let cancelled: Promise<unknown> | null = null;
  world.calling = (path, body) => { if (path === "/v2/pc/list/attempt" && body.nonce === undefined && cancelled === null) cancelled = add.cancel(); };
  expect(await next()).toMatchObject({ state: "ended", why: "cancelled" });
  expect(await cancelled).toMatchObject({ state: "ended", why: "cancelled" });
  expect(world.calls.filter((call) => call.endsWith("nonce"))).toEqual([]);
  expect(world.open?.nonce).toBeNull();
});

test("a relay identity reset meanwhile ends the add: it was the old PC's", async () => {
  const { add, world, number } = await adding();
  await add.start(ACCOUNT);
  const digits = await number();
  world.serverId = "f".repeat(32);
  expect(await add.confirm(digits)).toMatchObject({ confirmed: { state: "ended", account: ACCOUNT, why: "unavailable" } });
  expect(world.joins).toBe(0);
});

test("an account the service names no list for posts no card", async () => {
  const { add, world } = await adding({ list: null });
  expect(await add.start(ACCOUNT)).toEqual({ state: "no_list", account: ACCOUNT });
  expect(await add.state()).toEqual({ state: "no_list", account: ACCOUNT });
  expect(world.calls).toEqual([]);
});

test("starting again while an add runs goes on with it; after its end it starts anew", async () => {
  const { add, world, number } = await adding();
  await add.start(ACCOUNT);
  const digits = await number();
  world.now += ADD_POLL_MS;
  expect(await add.start(ACCOUNT)).toMatchObject({ state: "number", digits });
  await add.cancel();
  expect(await add.state()).toMatchObject({ state: "ended", why: "cancelled" });
  world.now += ADD_POLL_MS;
  expect(await add.start(ACCOUNT)).toMatchObject({ state: "waiting" });
});

test("a yes to another number than the one on the screen ends that number, and the answer names none", async () => {
  const { add, world, number, next } = await adding();
  await add.start(ACCOUNT);
  const digits = await number();
  const wrong = digits === "000000" ? "000001" : "000000";
  const answer = await add.confirm(wrong);
  expect(answer).toEqual({ mismatch: true });
  expect(JSON.stringify(answer)).not.toContain(digits);
  // the number is gone: the right one confirms nothing any more, and the device has to ask again
  expect(await add.confirm(digits)).toEqual({ mismatch: true });
  expect(await next()).toMatchObject({ state: "waiting" });
  expect(world.joins).toBe(0);
});

test("once confirmed, only the number it was confirmed with is answered as confirmed", async () => {
  const { add, number } = await adding();
  await add.start(ACCOUNT);
  const digits = await number();
  expect(await add.confirm(digits)).toMatchObject({ confirmed: { state: "confirmed" } });
  expect(await add.confirm(digits)).toMatchObject({ confirmed: { state: "confirmed" } });
  expect(await add.confirm(digits === "111111" ? "222222" : "111111")).toEqual({ mismatch: true });
});

test("a poll, a yes and a cancel that name another run than the one this PC holds learn nothing of it and change nothing", async () => {
  const { add, world, number } = await adding();
  const started = await add.start(ACCOUNT) as { run: string };
  const digits = await number();
  expect(await add.state("0".repeat(16))).toEqual({ state: "replaced" });
  expect(await add.confirm(digits, "0".repeat(16))).toEqual({ state: "replaced" });
  expect(await add.cancel("0".repeat(16))).toEqual({ state: "replaced" });
  world.now += ADD_POLL_MS;
  expect(await add.state(started.run)).toMatchObject({ state: "number", digits, run: started.run });
  expect(await add.cancel(started.run)).toMatchObject({ state: "ended", why: "cancelled" });
});

test("the PC's clock set back gives a number no more time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-list-add-"));
  dirs.push(dir);
  const keys = await new ListKeyStore(dir).keysFor(SERVER);
  const phone = await listMember();
  const binding = cardBinding({ key: keys.key, enc: keys.enc, list: LIST, endpoint: ENDPOINT, invite: null });
  const clock = { wall: 1_800_000_000_000, mono: 0 };
  let open: Open | null = null;
  const add = new ListAdd({
    own: async () => ({ serverId: SERVER, endpoint: ENDPOINT, keys }), listNamed: async () => LIST,
    call: async (path, body) => {
      if (path === "/v2/pc/list/keys") return {};
      if (body.nonce !== undefined && open !== null) open = { ...open, nonce: body.nonce as string };
      return { attempt: open };
    },
    join: async () => ({ waiting: "waiting" }), now: () => clock.wall, mono: () => clock.mono,
  });
  await add.start(ACCOUNT);
  const nonce = randomPairNonce();
  open = { adder: phone.key, commitment: toBase64Url(pairCommitment(binding, phone.key, nonce)), nonce: null, reveal: null };
  clock.mono += ADD_POLL_MS;
  await add.state();
  open = { ...(open as Open), reveal: toBase64Url(nonce) };
  clock.mono += ADD_POLL_MS;
  const shown = await add.state() as { digits: string };
  expect(shown.digits).toMatch(/^[0-9]{6}$/);
  // two minutes pass, and the clock on the wall is set back an hour
  clock.mono += ADD_ATTEMPT_MS;
  clock.wall -= 3_600_000;
  expect(await add.confirm(shown.digits)).toEqual({ mismatch: true });
});
