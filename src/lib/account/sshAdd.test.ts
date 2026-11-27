import { readSeenPcs } from "./seenPcs.ts";
import { describe, expect, it } from "bun:test";
import { FakeAccountService } from "../../../shared/account-service-fake.ts";
import type { AccountAddTarget } from "../../../shared/machines.ts";
import { exportPublicKey, generateKeyPair, importPublicKey } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { AccountService } from "./service.ts";
import { addOverSsh, sshAddListed, sshAddOffered, type SshTake } from "./sshAdd.ts";
import { memoryAccountStore } from "./store.ts";

const ACCOUNT = "acct_1";
const SERVICE = "https://account.test";

function pcFields(account: string | null = null): AccountAddTarget {
  const key = generateKeyPair().publicKey;
  return { server_id: deriveServerId(key), public_key: exportPublicKey(key), relay: "wss://relay.example", label: "nuc", account };
}

const ONLINE = { relay: { phase: "online", blocked: null } } as const;

async function window(options: { twoStep: boolean | null; used?: boolean; said?: SshTake; clock?: () => number }) {
  const fake = new FakeAccountService(options.clock);
  fake.opensAll = true;
  // the rule these cases are about: an account service that asks a used account's admit for two-step
  fake.admitAsksTwoStep = true;
  const store = memoryAccountStore();
  await store.set("session", { service: SERVICE, account: ACCOUNT, provider: "google", access_token: fake.issueToken(ACCOUNT, { twoStep: options.twoStep }), refresh_token: "r", expires_at: Date.now() + 3600_000 });
  const service = new AccountService({ store, fetch: fake.fetch });
  // this PC itself, listed in the account it is in: a used account, as any PC that adds another over SSH is
  if (options.used !== false) {
    const own = generateKeyPair().publicKey;
    await service.putPc(deriveServerId(own), { label: "desk", public_key: Array.from(own, (byte) => byte.toString(16).padStart(2, "0")).join(""), relay: "wss://relay.example" });
  }
  const takes: string[] = [];
  const take = async (jobId: string, serverId: string): Promise<SshTake> => { takes.push(`${jobId} ${serverId}`); return options.said ?? ONLINE; };
  return { fake, store, service, takes, take };
}

const listedIds = async (service: AccountService) => (await service.listPcs()).map((pc) => pc.server_id);

describe("adding another PC to the account over SSH, from this PC's own window", () => {
  it("lists that PC, admits it with this window's own two-step sign-in, then has this PC hand it the account", async () => {
    const { service, take, takes } = await window({ twoStep: true });
    const target = pcFields();
    const kept = new Map<string, string>();
    const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, value); }, removeItem: (key: string) => { kept.delete(key); } } });
    try {
      expect(await addOverSsh(service, { id: "job-1", account_add: target }, { account: ACCOUNT, running: () => true, take })).toBe("added");
      // what this device did for that PC is kept in its own record of its PCs, by the relay key the PC gave
      const endpoint = Array.from(importPublicKey(target.public_key), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const deadline = Date.now() + 2_000;
      while (readSeenPcs(ACCOUNT).pcs[endpoint] === undefined) {
        if (Date.now() > deadline) throw new Error("the SSH add was not written to the record");
        await Bun.sleep(5);
      }
      expect(readSeenPcs(ACCOUNT).pcs[endpoint]).toEqual({ how: "ssh" });
    } finally {
      if (saved) Object.defineProperty(globalThis, "localStorage", saved); else Reflect.deleteProperty(globalThis, "localStorage");
    }
    expect(await listedIds(service)).toContain(target.server_id);
    expect(takes).toEqual([`job-1 ${target.server_id}`]);
  });

  it("keeps the add as this device's own act once the account admitted the PC, whatever the hand-over then finds of the PC's relay", async () => {
    const { service } = await window({ twoStep: true });
    const target = pcFields();
    const kept = new Map<string, string>();
    const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, value); }, removeItem: (key: string) => { kept.delete(key); } } });
    try {
      // the PC's relay is still connecting when it takes the account
      const outcome = await addOverSsh(service, { id: "job-1", account_add: target }, { account: ACCOUNT, running: () => true, take: async () => ({ relay: { phase: "connecting", blocked: null, error: null } } as unknown as SshTake) });
      expect(outcome).not.toBe("added");
      const endpoint = Array.from(importPublicKey(target.public_key), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const deadline = Date.now() + 2_000;
      while (readSeenPcs(ACCOUNT).pcs[endpoint] === undefined) {
        if (Date.now() > deadline) throw new Error(`the SSH add was not written to the record (${outcome})`);
        await Bun.sleep(5);
      }
      expect(readSeenPcs(ACCOUNT).pcs[endpoint]).toEqual({ how: "ssh" });
    } finally {
      if (saved) Object.defineProperty(globalThis, "localStorage", saved); else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  it("Google without two-step on a used account: told to add it with the number on that PC, and nothing is handed over", async () => {
    const { service, take, takes } = await window({ twoStep: false });
    const target = pcFields();
    expect(await addOverSsh(service, { id: "job-1", account_add: target }, { account: ACCOUNT, running: () => true, take })).toBe("number");
    expect(takes).toEqual([]);
  });

  it("a never-used account needs no two-step: the service's first-PC exception admits it", async () => {
    const { service, take } = await window({ twoStep: false, used: false });
    expect(await addOverSsh(service, { id: "job-1", account_add: pcFields() }, { account: ACCOUNT, running: () => true, take })).toBe("added");
  });

  it("a PC already in this account, or in another, is neither listed nor admitted", async () => {
    const { service, take, takes } = await window({ twoStep: true });
    const before = await listedIds(service);
    const already = pcFields(ACCOUNT);
    expect(await addOverSsh(service, { id: "job-1", account_add: already }, { account: ACCOUNT, running: () => true, take })).toBe("already");
    expect(await addOverSsh(service, { id: "job-1", account_add: pcFields("acct_other") }, { account: ACCOUNT, running: () => true, take })).toBe("other-account");
    expect(await listedIds(service)).toEqual(before);
    // the one in this account is still taken, which turns its relay on: one added before that may have it off
    expect(takes).toEqual([`job-1 ${already.server_id}`]);
  });

  it("says added only once that PC says its relay is online", async () => {
    for (const [said, outcome] of [
      [ONLINE, "added"],
      [{ relay: { phase: "connecting", blocked: null } }, "not-online"],
      [{ relay: { phase: "off", blocked: "serve_only" } }, "not-online"],
      // an Ovis there from before this says nothing of its relay: in the account, never taken for online
      [{ relay: null }, "added-unchecked"],
      // the take's answer was lost and a second look found it in the account
      [{ relay: null, unanswered: true }, "added-unanswered"],
    ] as const) {
      const { service, take } = await window({ twoStep: true, said });
      expect(await addOverSsh(service, { id: "job-1", account_add: pcFields() }, { account: ACCOUNT, running: () => true, take })).toBe(outcome);
    }
    for (const [said, outcome] of [
      [{ relay: { phase: "connecting", blocked: null } }, "not-online"],
      [{ relay: null }, "already-unchecked"],
      [{ relay: null, unanswered: true }, "already-unanswered"],
      // its owner turned its relay off there: said so, not "not online yet"
      [{ relay: { phase: "off", blocked: null } }, "relay-off"],
    ] as const) {
      const { service, take } = await window({ twoStep: true, said });
      expect(await addOverSsh(service, { id: "job-1", account_add: pcFields(ACCOUNT) }, { account: ACCOUNT, running: () => true, take })).toBe(outcome);
    }
  });

  it("a take whose SSH connection ended says so, apart from any other refusal", async () => {
    for (const [code, outcome] of [["disconnected", "disconnected"], ["job_not_found", "disconnected"], ["no_admission", "refused"], ["take_unanswered", "maybe"]] as const) {
      const { service, take } = await window({ twoStep: true, said: { refused: code } });
      expect(await addOverSsh(service, { id: "job-1", account_add: pcFields() }, { account: ACCOUNT, running: () => true, take })).toBe(outcome);
    }
  });

  it("a take this PC gave no answer to may have gone out: maybe, never refused", async () => {
    const { service } = await window({ twoStep: true });
    const take = async (): Promise<SshTake> => { throw new TypeError("Failed to fetch"); };
    expect(await addOverSsh(service, { id: "job-1", account_add: pcFields() }, { account: ACCOUNT, running: () => true, take })).toBe("maybe");
  });

  it("a sign-in too old to admit asks for a fresh one; the fresh one, as it was handed in, then adds it", async () => {
    let now = Date.now();
    const { fake, store, service, take, takes } = await window({ twoStep: true, clock: () => now });
    now += 11 * 60_000;
    const target = pcFields();
    expect(await addOverSsh(service, { id: "job-1", account_add: target }, { account: ACCOUNT, running: () => true, take })).toBe("sign-in-again");
    expect(takes).toEqual([]);
    const fresh = { service: SERVICE, account: ACCOUNT, provider: "google" as const, access_token: fake.issueToken(ACCOUNT, { twoStep: true }), refresh_token: "fresh", expires_at: Date.now() + 3600_000 };
    await store.set("session", fresh);
    expect(await addOverSsh(service, { id: "job-1", account_add: target }, { account: ACCOUNT, running: () => true, take, signIn: fresh })).toBe("added");
    expect(takes).toEqual([`job-1 ${target.server_id}`]);
  });

  it("a fresh sign-in that is no longer the one stored (another tab signed in meanwhile) writes nothing", async () => {
    const { fake, store, service, take, takes } = await window({ twoStep: true });
    const fresh = { service: SERVICE, account: ACCOUNT, provider: "google" as const, access_token: fake.issueToken(ACCOUNT, { twoStep: true }), refresh_token: "fresh", expires_at: Date.now() + 3600_000 };
    const target = pcFields();
    expect(await addOverSsh(service, { id: "job-1", account_add: target }, { account: ACCOUNT, running: () => true, take, signIn: fresh })).toBe("refused");
    expect(await listedIds(service)).not.toContain(target.server_id);
    expect(takes).toEqual([]);
    expect((await store.get("session"))?.refresh_token).toBe("r");
  });

  it("a window signed in to another account than this PC's writes nothing", async () => {
    const { service, take, takes } = await window({ twoStep: true });
    const before = await listedIds(service);
    expect(await addOverSsh(service, { id: "job-1", account_add: pcFields() }, { account: "acct_other", running: () => true, take })).toBe("refused");
    expect(await listedIds(service)).toEqual(before);
    expect(takes).toEqual([]);
  });

  it("an attempt given up writes nothing more", async () => {
    const { service, take, takes } = await window({ twoStep: true });
    const target = pcFields();
    expect(await addOverSsh(service, { id: "job-1", account_add: target }, { account: ACCOUNT, running: () => false, take })).toBe("refused");
    expect(await listedIds(service)).not.toContain(target.server_id);
    expect(takes).toEqual([]);
  });

  it("is offered only in this PC's own window, signed in to the account this PC is in", () => {
    expect(sshAddOffered({ ownWindow: true, signedInAccount: ACCOUNT, pcAccount: ACCOUNT })).toBe(true);
    expect(sshAddOffered({ ownWindow: true, signedInAccount: null, pcAccount: ACCOUNT })).toBe(false);
    expect(sshAddOffered({ ownWindow: true, signedInAccount: ACCOUNT, pcAccount: null })).toBe(false);
    expect(sshAddOffered({ ownWindow: true, signedInAccount: "acct_other", pcAccount: ACCOUNT })).toBe(false);
    expect(sshAddOffered({ ownWindow: false, signedInAccount: ACCOUNT, pcAccount: ACCOUNT })).toBe(false);
  });
});

describe("adding another PC over SSH, on the account service since key proofs", () => {
  /** this PC's own window, signed in `age` ago; it registers no key of its own (only the phone app and app.ovis.sh do) */
  async function signedIn(age: number) {
    let now = Date.now();
    const fake = new FakeAccountService(() => now);
    fake.opensAll = true;
    const store = memoryAccountStore();
    const token = fake.issueToken(ACCOUNT, { twoStep: true });
    await store.set("session", { service: SERVICE, account: ACCOUNT, provider: "google", access_token: token, refresh_token: "r", expires_at: now + 365 * 86_400_000, sign_in_id: "here", signed_in_at: now });
    now += age;
    const service = new AccountService({ store, fetch: fake.fetch, now: () => now });
    const takes: string[] = [];
    const take = async (jobId: string, serverId: string): Promise<SshTake> => { takes.push(`${jobId} ${serverId}`); return ONLINE; };
    return { fake, service, takes, take, challenges: () => fake.requests.filter((line) => line === "POST /v1/pcs/challenge").length };
  }

  it("a fresh sign-in adds as before, proving nothing", async () => {
    const { service, take, challenges } = await signedIn(0);
    expect(await addOverSsh(service, { id: "job-1", account_add: pcFields() }, { account: ACCOUNT, running: () => true, take })).toBe("added");
    expect(challenges()).toBe(0);
  });

  it("a sign-in older than an add takes, with no key of its own to prove it by, asks to sign in again before anything is sent", async () => {
    // this window's own sign-in, 17 minutes old: the account service would refuse the admission (session_not_fresh), and
    // each call before that refusal can take long on a slow service, so the person is asked at once
    const { fake, service, take, takes } = await signedIn(17 * 60_000);
    const before = fake.requests.length;
    expect(await addOverSsh(service, { id: "job-1", account_add: pcFields() }, { account: ACCOUNT, running: () => true, take })).toBe("sign-in-again");
    expect(fake.requests.slice(before)).toEqual([]);
    expect(takes).toEqual([]);
  });

  it("a sign-in days old asks to sign in again, and nothing is handed over", async () => {
    const { fake, service, take, takes } = await signedIn(3 * 86_400_000);
    expect(await addOverSsh(service, { id: "job-1", account_add: pcFields() }, { account: ACCOUNT, running: () => true, take })).toBe("sign-in-again");
    expect(fake.pcs(ACCOUNT)).toEqual([]);
    expect(takes).toEqual([]);
  });
});

describe("where Add a connection's relay tab lists the PCs to add over SSH", () => {
  const mine = { pcAddFromAccount: true as const, signedInAccount: "acct_a", pcAccount: "acct_a" };
  it("is this PC's own window only, signed in to the account this PC is in, with the account's rules on", () => {
    expect(sshAddListed({ ...mine, auth: { via: "local" }, hostname: "127.0.0.1" })).toBe(true);
    expect(sshAddListed({ ...mine, auth: { via: "token" }, hostname: "localhost" })).toBe(true);
    // a device paired over the LAN, signed in to the same account: not this PC's own window
    expect(sshAddListed({ ...mine, auth: { via: "token" }, hostname: "192.168.1.5" })).toBe(false);
    expect(sshAddListed({ ...mine, auth: { via: "relay" }, hostname: "app.ovis.sh" })).toBe(false);
    expect(sshAddListed({ ...mine, auth: { via: "tailscale" }, hostname: "desk.tail.ts.net" })).toBe(false);
    expect(sshAddListed({ ...mine, auth: null, hostname: "127.0.0.1" })).toBe(false);
    expect(sshAddListed({ ...mine, auth: { via: "local" }, hostname: "127.0.0.1", signedInAccount: "acct_b" })).toBe(false);
    expect(sshAddListed({ ...mine, auth: { via: "local" }, hostname: "127.0.0.1", signedInAccount: null })).toBe(false);
    expect(sshAddListed({ ...mine, auth: { via: "local" }, hostname: "127.0.0.1", pcAddFromAccount: "unavailable" })).toBe(false);
    expect(sshAddListed({ ...mine, auth: { via: "local" }, hostname: "127.0.0.1", pcAddFromAccount: undefined })).toBe(false);
  });
});


describe("what this device keeps as its own evidence of an add over SSH, and when (astra-sshapp)", () => {
  /** The browser's storage for the record of this device's PCs, for the length of `run`. */
  async function withStorage<T>(run: () => Promise<T>): Promise<T> {
    const kept = new Map<string, string>();
    const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, value); }, removeItem: (key: string) => { kept.delete(key); } } });
    try { return await run(); } finally { if (saved) Object.defineProperty(globalThis, "localStorage", saved); else Reflect.deleteProperty(globalThis, "localStorage"); }
  }
  const endpointOf = (target: AccountAddTarget) => Array.from(importPublicKey(target.public_key), (byte) => byte.toString(16).padStart(2, "0")).join("");

  it("a take that refused, or whose end is not known, keeps no evidence: nothing is written before the take, nor for a refusal", async () => {
    for (const code of ["list_cannot_add", "that_pc_old", "list_removed", "list_unbound", "list_not_added", "take_unanswered", "account_changed", "refused"]) {
      await withStorage(async () => {
        const { service } = await window({ twoStep: true });
        const target = pcFields();
        let seenAtTake: unknown = "not asked";
        const take = async (): Promise<SshTake> => { seenAtTake = readSeenPcs(ACCOUNT).pcs[endpointOf(target)]; return { refused: code }; };
        await addOverSsh(service, { id: "job-1", account_add: target }, { account: ACCOUNT, running: () => true, take });
        expect([code, seenAtTake]).toEqual([code, undefined]);
        expect([code, readSeenPcs(ACCOUNT).pcs[endpointOf(target)]]).toEqual([code, undefined]);
      });
    }
  });

  it("a take that confirmed the add of that PC to that account keeps `ssh`, written only after it answered", async () => {
    await withStorage(async () => {
      const { service } = await window({ twoStep: true });
      const target = pcFields();
      let seenAtTake: unknown = "not asked";
      const take = async (): Promise<SshTake> => { seenAtTake = readSeenPcs(ACCOUNT).pcs[endpointOf(target)]; return ONLINE; };
      expect(await addOverSsh(service, { id: "job-1", account_add: target }, { account: ACCOUNT, running: () => true, take })).toBe("added");
      expect(seenAtTake).toBeUndefined();
      expect(readSeenPcs(ACCOUNT).pcs[endpointOf(target)]).toEqual({ how: "ssh" });
    });
  });

  it("a PC in the account already: the sign-in is read before the take, and a take that found it there keeps nothing", async () => {
    await withStorage(async () => {
      const { service, store, take, takes } = await window({ twoStep: true });
      const target = pcFields(ACCOUNT);
      expect(await addOverSsh(service, { id: "job-1", account_add: target }, { account: ACCOUNT, running: () => true, take })).toBe("already");
      expect(readSeenPcs(ACCOUNT).pcs[endpointOf(target)]).toBeUndefined();
      // signed out in another tab after the add was offered: this take may sign, so it is not sent
      await store.set("session", undefined);
      expect(await addOverSsh(service, { id: "job-2", account_add: target }, { account: ACCOUNT, running: () => true, take })).toBe("refused");
      expect(takes).toEqual([`job-1 ${target.server_id}`]);
    });
  });

  it("a PC in the account from before its list that this take put in the list: added, and kept as this device's add", async () => {
    await withStorage(async () => {
      const { service } = await window({ twoStep: true, said: { ...ONLINE, listJoined: true } });
      const target = pcFields(ACCOUNT);
      const take = async (): Promise<SshTake> => ({ ...ONLINE, listJoined: true });
      expect(await addOverSsh(service, { id: "job-1", account_add: target }, { account: ACCOUNT, running: () => true, take })).toBe("added");
      expect(readSeenPcs(ACCOUNT).pcs[endpointOf(target)]).toEqual({ how: "ssh" });
    });
  });

  it("an attempt that ended while its take was out (the dialog closed, or another attempt took its place) writes no record (PR #4649 review)", async () => {
    await withStorage(async () => {
      const { service } = await window({ twoStep: true });
      const target = pcFields();
      let running = true;
      const take = async (): Promise<SshTake> => { running = false; return ONLINE; };
      await addOverSsh(service, { id: "job-1", account_add: target }, { account: ACCOUNT, running: () => running, take });
      expect(readSeenPcs(ACCOUNT).pcs[endpointOf(target)]).toBeUndefined();
    });
  });

  it("a sign-in store that fails to read ends the add as not added, with nothing taken", async () => {
    const { service, take, takes } = await window({ twoStep: true });
    let reads = 0;
    const session = service.session.bind(service);
    service.session = async () => { reads += 1; if (reads > 1) throw new DOMException("The store went away", "UnknownError"); return await session(); };
    expect(await addOverSsh(service, { id: "job-1", account_add: pcFields() }, { account: ACCOUNT, running: () => true, take })).toBe("refused");
    expect(takes).toEqual([]);
  });
});
