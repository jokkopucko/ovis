import { expect, it, jest } from "bun:test";

import { sshCandidates } from "./ssh-candidates.ts";
import { resolver, sshDir, twoPeers } from "./ssh-candidates.fixture.ts";

it("shares one listing between concurrent requests and keeps the lookups in flight bounded across listings", async () => {
  const dir = sshDir({ config: Array.from({ length: 40 }, (_, index) => `Host n${index}`).join("\n") });
  let statusReads = 0;
  let lookups = 0;
  const options = { sshDir: dir, readStatus: async () => { statusReads++; return twoPeers; }, resolve: () => { lookups++; return new Promise<string[]>(() => {}); }, resolveTimeoutMs: 0 };
  await Promise.all([sshCandidates(options), sshCandidates(options)]);
  expect(statusReads).toBe(1);
  const first = lookups;
  for (let round = 0; round < 4; round++) await sshCandidates(options);
  expect(statusReads).toBe(5);
  expect(first).toBeLessThanOrEqual(16);
  expect(lookups).toBe(first);
});

it("looks up every name past the lookups in flight at once, each claiming the PC it resolves to", async () => {
  const dir = sshDir({ config: Array.from({ length: 20 }, (_, index) => `Host n${index}`).join("\n") });
  const looked: string[] = [];
  const resolve = async (host: string): Promise<string[]> => { looked.push(host); return [Number(host.slice(1)) % 2 === 0 ? "100.64.0.2" : "100.64.0.1"]; };
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => twoPeers, resolve });
  expect([...looked].sort()).toEqual(Array.from({ length: 20 }, (_, index) => `n${index}`).sort());
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual(
    Array.from({ length: 20 }, (_, index) => [`n${index}`, index % 2 === 0 ? "other.tail.ts.net" : "box.tail.ts.net"]),
  );
});

it("looks a name up again on each listing, so a changed DNS or hosts answer counts at once", async () => {
  const dir = sshDir({ config: "Host alias\n" });
  const table: Record<string, string[]> = { alias: ["100.64.0.1"] };
  const options = { sshDir: dir, readStatus: async () => twoPeers, resolve: resolver(table) };
  expect((await sshCandidates(options))[0]!.tailnet).toBe("box.tail.ts.net");
  table.alias = ["100.64.0.2"];
  expect((await sshCandidates(options))[0]!.tailnet).toBe("other.tail.ts.net");
});

it("never hands a lookup no listing waits on any more to a later listing, which looks the name up afresh", async () => {
  const [first, second] = [sshDir({ config: "Host box\n" }), sshDir({ config: "Host box\nHost probe\n" })];
  const table: Record<string, string[]> = { box: ["100.64.0.1"] };
  const looked: string[] = [];
  let answerOld: ((addresses: string[]) => void) | undefined;
  const resolve = (host: string): Promise<string[]> => {
    looked.push(host);
    if (host === "box" && answerOld === undefined) return new Promise((answer) => { answerOld = answer; });
    if (host === "probe") answerOld?.(["100.64.0.1"]);
    return Promise.resolve(table[host] ?? []);
  };
  await sshCandidates({ sshDir: first, readStatus: async () => twoPeers, resolve, resolveTimeoutMs: 0 });
  table.box = ["100.64.0.2"];
  const candidates = await sshCandidates({ sshDir: second, readStatus: async () => twoPeers, resolve, resolveTimeoutMs: 60_000 });
  expect(candidates.find((candidate) => candidate.name === "box")?.tailnet).toBe("other.tail.ts.net");
  expect(looked).toEqual(["box", "box", "probe"]);
});

it("leaves a host whose lookup is late or fails unclaimed, never matched by its name", async () => {
  const dir = sshDir({ config: "Host box\n" });
  for (const resolve of [() => new Promise<string[]>(() => {}), async (): Promise<string[]> => { throw new Error("no answer"); }]) {
    const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => twoPeers, resolve, resolveTimeoutMs: 0 });
    expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([["box", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]]);
  }
});

function heldResolver(ready: Record<string, string[]>) {
  const looked: string[] = [];
  const held = new Map<string, (addresses: string[]) => void>();
  const unanswered = { now: 0, most: 0 };
  const waiters: { count: number; reached: () => void }[] = [];
  const resolve = (host: string): Promise<string[]> => {
    looked.push(host);
    for (const waiter of waiters) if (looked.length >= waiter.count) waiter.reached();
    if (ready[host] !== undefined) return Promise.resolve(ready[host]);
    unanswered.most = Math.max(unanswered.most, ++unanswered.now);
    return new Promise((answer) => held.set(host, (addresses) => { unanswered.now--; answer(addresses); }));
  };
  const called = (count: number) => new Promise<void>((reached) => { waiters.push({ count, reached }); if (looked.length >= count) reached(); });
  return { looked, resolve, unanswered, called, answer: (host: string) => { ready[host] = []; held.get(host)?.([]); held.delete(host); } };
}

it("holds a lookup's slot until its resolver answers, however long that takes, so at most 16 resolver calls are ever outstanding", async () => {
  const dir = sshDir({ config: Array.from({ length: 17 }, (_, index) => `Host n${index}`).join("\n") });
  const ready: Record<string, string[]> = {};
  const { looked, resolve, unanswered, called, answer } = heldResolver(ready);
  const options = { sshDir: dir, readStatus: async () => twoPeers, resolveTimeoutMs: 1, resolve };
  jest.useFakeTimers();
  try {
    const listing = sshCandidates(options);
    await called(16);
    jest.advanceTimersByTime(1);
    await listing;
    // far past the 1.5 s after which a lookup used to give its slot up while its resolver call was still unanswered
    jest.advanceTimersByTime(60_000);
  } finally { jest.useRealTimers(); }
  await new Promise<void>((settled) => setImmediate(settled));
  expect(unanswered).toEqual({ now: 16, most: 16 });
  expect(looked).not.toContain("n16");
  for (let index = 0; index < 16; index++) answer(`n${index}`);
  ready.n16 = ["100.64.0.2"];
  const candidates = await sshCandidates({ ...options, resolveTimeoutMs: 60_000 });
  expect(looked.filter((host) => host === "n16")).toHaveLength(1);
  expect(candidates.find((candidate) => candidate.name === "n16")?.tailnet).toBe("other.tail.ts.net");
});

it("drops the queued lookups of a listing that gave up, so a freed slot never starts one", async () => {
  const dir = sshDir({ config: Array.from({ length: 17 }, (_, index) => `Host n${index}`).join("\n") });
  const { looked, resolve, answer } = heldResolver({});
  await sshCandidates({ sshDir: dir, readStatus: async () => twoPeers, resolveTimeoutMs: 0, resolve });
  expect(looked).toHaveLength(16);
  answer("n0");
  await new Promise<void>((settled) => setImmediate(settled));
  expect(looked).not.toContain("n16");
});
