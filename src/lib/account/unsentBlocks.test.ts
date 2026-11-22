import { expect, it } from "bun:test";
import { newRecordId, signSafetyRecord, type BlockRecord } from "../../../shared/account-records.ts";
import { keepUnsent, postKept, refusalShown, unsentBlocks } from "./unsentBlocks.ts";
import { AccountService, AccountServiceError, AccountServiceUnreachableError } from "./service.ts";
import { leaveAccount } from "./leave.ts";
import { FakeAccountService } from "../../../shared/account-service-fake.ts";
import { MemoryDeviceStore } from "../relay/device.test.ts";
import { memoryAccountStore, newKey, type AccountSession } from "./store.ts";

const session: AccountSession = { service: "https://account.example", account: "acct", provider: "github", sign_in_id: "this-sign-in", access_token: "a", refresh_token: "r", expires_at: Date.now() + 3_600_000 };

async function block(): Promise<BlockRecord> {
  const own = await newKey();
  return await signSafetyRecord({
    v: 1, kind: "block", account: "acct", target: (await newKey()).public_spki, target_no: 3, signer: own.public_spki, signer_no: 1,
    signed_at: new Date().toISOString(), nonce: newRecordId(),
  }, own.private_key);
}

it("S32-1: kept before any delivery, and dropped once the service confirms it", async () => {
  const store = memoryAccountStore();
  await store.set("session", session);
  const record = await block();
  await keepUnsent(store, session, [record]);
  expect((await unsentBlocks(store, session)).flatMap((kept) => kept.records)).toEqual([record]);
  expect(await postKept(store, session, [record], async () => {})).toBe("sent");
  expect(await unsentBlocks(store, session)).toEqual([]);
});

it("S32-1: a post a retry may change (no answer, 5xx, 401, 408, 429) keeps the exact record and throws", async () => {
  for (const failure of [new AccountServiceUnreachableError({ cause: new TypeError("down") }), new AccountServiceError(503, "unavailable", "busy"), new AccountServiceError(401, "unauthorized", "x"), new AccountServiceError(408, "timeout", "x"), new AccountServiceError(429, "too_many", "x"), new DOMException("slow", "TimeoutError")]) {
    const store = memoryAccountStore();
  await store.set("session", session);
    const record = await block();
    await keepUnsent(store, session, [record]);
    await expect(postKept(store, session, [record], async () => { throw failure; })).rejects.toBe(failure);
    expect((await unsentBlocks(store, session)).flatMap((kept) => kept.records)).toEqual([record]);
  }
});

it("S32-1: target_removed leaves the queue at once; a final refusal stays, marked refused, until it was shown", async () => {
  const store = memoryAccountStore();
  await store.set("session", session);
  const removed = await block();
  await keepUnsent(store, session, [removed]);
  expect(await postKept(store, session, [removed], async () => { throw new AccountServiceError(409, "target_removed", "gone"); })).toBe("done");
  expect(await unsentBlocks(store, session)).toEqual([]);
  for (const failure of [new AccountServiceError(403, "signer_not_older", "x"), new AccountServiceError(400, "record_invalid", "x")]) {
    const record = await block();
    await keepUnsent(store, session, [record]);
    expect(await postKept(store, session, [record], async () => { throw failure; })).toBe("refused");
    expect(await unsentBlocks(store, session)).toEqual([{ account: session.account, sign_in_id: session.sign_in_id, records: [record], refused: true }]);
    // another account's page showing it removes nothing
    await refusalShown(store, "other", [record.id]);
    expect(await unsentBlocks(store, session)).toHaveLength(1);
    await refusalShown(store, session.account, [record.id]);
    expect(await unsentBlocks(store, session)).toEqual([]);
  }
});

it("S32-1: a record code on an answer that is not that refusal's status keeps it (target_removed on a 503, signer_not_older on a 500)", async () => {
  for (const failure of [new AccountServiceError(503, "target_removed", "x"), new AccountServiceError(500, "signer_not_older", "x")]) {
    const store = memoryAccountStore();
    await store.set("session", session);
    const record = await block();
    await keepUnsent(store, session, [record]);
    await expect(postKept(store, session, [record], async () => { throw failure; })).rejects.toBe(failure);
    expect(await unsentBlocks(store, session)).toEqual([{ account: session.account, sign_in_id: session.sign_in_id, records: [record] }]);
  }
});

it("S32-1: a refusal shown while another account is the stored sign-in removes nothing", async () => {
  const store = memoryAccountStore();
  await store.set("session", session);
  const record = await block();
  await keepUnsent(store, session, [record]);
  expect(await postKept(store, session, [record], async () => { throw new AccountServiceError(403, "signer_not_older", "x"); })).toBe("refused");
  await store.set("session", { ...session, account: "other", sign_in_id: "b" });
  await refusalShown(store, session.account, [record.id]);
  expect(await unsentBlocks(store, session)).toHaveLength(1);
  await store.set("session", undefined);
  await refusalShown(store, session.account, [record.id]);
  expect(await unsentBlocks(store, session)).toHaveLength(1);
});

it("S32-1: only a 200 with the record's id confirms it: a 202 pending or another success keeps it", async () => {
  for (const answer of [
    (id: string) => Response.json({ id, status: "pending" }, { status: 202 }),
    (id: string) => Response.json({ id }, { status: 201 }),
    () => new Response(null, { status: 204 }),
  ]) {
    const store = memoryAccountStore();
    await store.set("session", session);
    const record = await block();
    await keepUnsent(store, session, [record]);
    const service = new AccountService({ store, fetch: async () => answer(record.id) });
    await expect(postKept(store, session, [record], (kept) => service.postSafetyRecord(kept))).rejects.toThrow();
    expect((await unsentBlocks(store, session)).flatMap((kept) => kept.records)).toEqual([record]);
  }
  const store = memoryAccountStore();
  await store.set("session", session);
  const record = await block();
  await keepUnsent(store, session, [record]);
  const service = new AccountService({ store, fetch: async () => Response.json({ id: record.id }) });
  expect(await postKept(store, session, [record], (kept) => service.postSafetyRecord(kept))).toBe("sent");
  expect(await unsentBlocks(store, session)).toEqual([]);
});

it("S32-1: a redirect is no answer: a 303 the browser would follow to a 200 naming the id keeps the record", async () => {
  const store = memoryAccountStore();
  await store.set("session", session);
  const record = await block();
  await keepUnsent(store, session, [record]);
  const service = new AccountService({ store, fetch: async (_input, init) => {
    if (init?.redirect === "error") throw new TypeError("redirected");
    return Response.json({ id: record.id });
  } });
  await expect(postKept(store, session, [record], (kept) => service.postSafetyRecord(kept))).rejects.toThrow();
  expect((await unsentBlocks(store, session)).flatMap((kept) => kept.records)).toEqual([record]);
});

it("S32-1: a block post refused 401 again after a refresh that worked leaves the entry open, not refused", async () => {
  const store = memoryAccountStore();
  await store.set("session", session);
  const record = await block();
  await keepUnsent(store, session, [record]);
  const service = new AccountService({ store, fetch: async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/token") return Response.json({ access_token: "fresh", refresh_token: "fresh-r", expires_in: 3600, account: session.account, provider: "github" });
    return Response.json({ error: { code: "unauthorized", message: "x" } }, { status: 401 });
  } });
  await expect(postKept(store, session, [record], (kept) => service.postSafetyRecord(kept))).rejects.toMatchObject({ status: 401 });
  expect(await unsentBlocks(store, session)).toEqual([{ account: session.account, sign_in_id: session.sign_in_id, records: [record] }]);
  expect((await store.get("session"))?.access_token).toBe("fresh");
});

it("S32-1: a redirect is no answer to any account call: a redirected /v1/pcs or /v1/token never ends a valid sign-in", async () => {
  for (const [path, followed] of [
    ["/v1/pcs", () => Response.json({ error: { code: "unauthorized" } }, { status: 401 })],
    ["/v1/token", () => Response.json({ error: { code: "invalid_grant" } }, { status: 400 })],
  ] as const) {
    const store = memoryAccountStore();
    // due for a refresh only where the refresh is the call under test
    const start = { ...session, expires_at: path === "/v1/token" ? Date.now() : session.expires_at };
    await store.set("session", start);
    const service = new AccountService({ store, fetch: async (_input, init) => {
      if (init?.redirect === "error") throw new TypeError("redirected");
      return followed();
    } });
    await expect(service.listPcs()).rejects.toBeInstanceOf(AccountServiceUnreachableError);
    expect((await store.get("session"))?.refresh_token).toBe(start.refresh_token);
  }
});

it("S32-1: a record still waiting is never removed as a shown refusal", async () => {
  const store = memoryAccountStore();
  await store.set("session", session);
  const record = await block();
  await keepUnsent(store, session, [record]);
  await refusalShown(store, session.account, [record.id]);
  expect((await unsentBlocks(store, session)).flatMap((kept) => kept.records)).toEqual([record]);
});

it("S32-1: a token refresh that fails in any way keeps the record: it was never sent, so nothing refused it", async () => {
  const unreachable = async (): Promise<Response> => { throw new TypeError("down"); };
  for (const token of [400, 401, 403, 404, 409, 429, 503].map((status) => async () => Response.json({ error: { code: "refused" } }, { status })).concat(unreachable)) {
    const store = memoryAccountStore();
    const expired = { ...session, expires_at: Date.now() };
    await store.set("session", expired);
    const record = await block();
    await keepUnsent(store, expired, [record]);
    const asked: string[] = [];
    const service = new AccountService({ store, fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      asked.push(path);
      return path === "/v1/token" ? token() : Response.json({ id: record.id });
    } });
    await expect(postKept(store, expired, [record], (kept) => service.postSafetyRecord(kept))).rejects.toThrow();
    expect(asked).toEqual(["/v1/token"]);
    expect(Object.values(await store.get("unsent_blocks") ?? {}).flatMap((kept) => kept.records)).toEqual([record]);
  }
});

it("S32-1: a 4xx that is no refusal of the record itself keeps it: a hidden route, try_again, a stale sign-in", async () => {
  for (const failure of [
    new AccountServiceError(404, "not_found", "x"), new AccountServiceError(409, "try_again", "x"),
    new AccountServiceError(403, "session_not_fresh", "x"), new AccountServiceError(400, "invalid_request", "x"),
  ]) {
    const store = memoryAccountStore();
    await store.set("session", session);
    const record = await block();
    await keepUnsent(store, session, [record]);
    await expect(postKept(store, session, [record], async () => { throw failure; })).rejects.toBe(failure);
    expect((await unsentBlocks(store, session)).flatMap((kept) => kept.records)).toEqual([record]);
  }
});

it("S32-1: while the service hides the route (step 2 off for this account), the block stays", async () => {
  const fake = new FakeAccountService();
  const store = memoryAccountStore();
  const signedIn = { ...session, access_token: fake.issueToken("acct") };
  await store.set("session", signedIn);
  const record = await block();
  await keepUnsent(store, signedIn, [record]);
  const service = new AccountService({ store, fetch: fake.fetch });
  await expect(postKept(store, signedIn, [record], (kept) => service.postSafetyRecord(kept))).rejects.toMatchObject({ status: 404 });
  expect((await unsentBlocks(store, signedIn)).flatMap((kept) => kept.records)).toEqual([record]);
});

it("S32-1: a token refresh that answers for another account is refused: nothing is posted under it and the record stays", async () => {
  const store = memoryAccountStore();
  const expired = { ...session, expires_at: Date.now() };
  await store.set("session", expired);
  const record = await block();
  await keepUnsent(store, expired, [record]);
  const asked: string[] = [];
  const service = new AccountService({ store, fetch: async (input) => {
    const path = new URL(String(input)).pathname;
    asked.push(path);
    return path === "/v1/token"
      ? Response.json({ access_token: "b-access", refresh_token: "b-refresh", expires_in: 3600, account: "another-account", provider: "github" })
      : Response.json({ id: record.id });
  } });
  await expect(postKept(store, expired, [record], (kept) => service.postSafetyRecord(kept))).rejects.toThrow();
  expect(asked).toEqual(["/v1/token"]);
  expect((await store.get("session"))?.account).toBe(session.account);
  expect((await unsentBlocks(store, expired)).flatMap((kept) => kept.records)).toEqual([record]);
});

it("S32-1: of a partly accepted set, only the records still unconfirmed stay", async () => {
  const store = memoryAccountStore();
  await store.set("session", session);
  const [taken, left] = [await block(), await block()];
  await keepUnsent(store, session, [taken, left]);
  await expect(postKept(store, session, [taken, left], async (record) => { if (record === left) throw new AccountServiceError(503, "unavailable", "busy"); })).rejects.toThrow();
  expect((await unsentBlocks(store, session)).flatMap((kept) => kept.records)).toEqual([left]);
  // the in-session retry sends the original set again: what the service takes now leaves, by record id
  expect(await postKept(store, session, [taken, left], async () => {})).toBe("sent");
  expect(await unsentBlocks(store, session)).toEqual([]);
});

it("S32-1: a later sign-in to the same account takes the queue on with the same records; another account never sees it", async () => {
  const store = memoryAccountStore();
  await store.set("session", session);
  const record = await block();
  await keepUnsent(store, session, [record]);
  expect((await unsentBlocks(store, { ...session, sign_in_id: "a-later-sign-in" })).flatMap((kept) => kept.records)).toEqual([record]);
  expect(await unsentBlocks(store, { ...session, account: "other" })).toEqual([]);
  // a post under the other account's sign-in removes nothing of this account's
  expect(await postKept(store, { ...session, account: "other" }, [record], async () => {})).toBe("sent");
  expect(Object.keys(await store.get("unsent_blocks") ?? {})).toEqual([record.id]);
});

it("S32-1: leaving the account keeps every unsent block: only the service's answer takes one away", async () => {
  const service = new FakeAccountService();
  const store = memoryAccountStore();
  const a = { ...session, service: "https://account.example", account: "acct", access_token: service.issueToken("acct") };
  await store.set("session", a);
  await keepUnsent(store, a, [await block()]);
  await store.update("unsent_blocks", (current) => ({ ...current, theirs: { account: "acct", sign_in_id: "b", records: [] } }));
  const before = await store.get("unsent_blocks");
  expect(Object.keys(before ?? {})).toHaveLength(2);
  await leaveAccount({ service: new AccountService({ store, fetch: service.fetch }), accountStore: store, relayStore: new MemoryDeviceStore(), session: a });
  expect(await store.get("unsent_blocks")).toEqual(before);
});

it("S32-1: a failed post never writes its records back into a queue that a sign-out cleared meanwhile", async () => {
  const store = memoryAccountStore();
  await store.set("session", session);
  const record = await block();
  await keepUnsent(store, session, [record]);
  await expect(postKept(store, session, [record], async () => {
    // this sign-in's queue goes with its sign-out; another sign-in's stays
    await store.set("unsent_blocks", { theirs: { account: session.account, sign_in_id: "another", records: [record] } });
    throw new AccountServiceError(503, "unavailable", "busy");
  })).rejects.toThrow();
  expect(Object.keys(await store.get("unsent_blocks") ?? {})).toEqual(["theirs"]);
});

it("S32-1: nothing is kept for a sign-in that is no longer the stored one", async () => {
  const store = memoryAccountStore();
  await store.set("session", { ...session, sign_in_id: "a-later-sign-in" });
  expect(await keepUnsent(store, session, [await block()])).toBe(false);
  expect(await store.get("unsent_blocks")).toBeUndefined();
  await store.set("session", session);
  expect(await keepUnsent(store, session, [await block()])).toBe(true);
});
