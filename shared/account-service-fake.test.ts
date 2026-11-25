import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { bytesToHex } from "@noble/hashes/utils.js";
import { exportAccountKey, newRecordId, pcAddSigningBytes, signAccountRecord, signSafetyRecord, type AccountRecord, type PcAddPurpose } from "./account-records.ts";
import { assembleSnapshot, parseSnapshotPage, type AccountSnapshotPage } from "./account-snapshot.ts";
import { SNAPSHOT_PAGE, ACCESS_TOKEN_TTL_S, ADMISSION_TTL_MS, ACCOUNT_RING, ADMISSIONS_PER_WINDOW, DEVICE_POLL_S, DIRECTORY_MAX, FakeAccountService, isAllowedRedirect, LISTING_ASKS_MS, MAILBOX_TTL_MS, PC_ADD_CHALLENGE_TTL_MS, PC_LEFT_MS, WEB_REDIRECT, type FakePc } from "./account-service-fake.ts";
import { toBase64Url } from "./relay-pair-sas.ts";
import { answerServerChallenge, deriveServerId, serverChallenge, verifyServerProof, type ProofRoute } from "./relay-server-proof.ts";
import { signInviteRedeem, type InviteRedeem } from "./account-list-invite.ts";
import { newInvite, readJoinLine } from "./account-list-join.ts";

/** How a PC on the test service reads a join line: lines for that service only, and none that names a list. */
const READER = { service: "https://account.test", followsLists: false } as const;

const BASE = "https://account.test";

async function client() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { pair, spki: await exportAccountKey(pair.publicKey) };
}

function pc() {
  const keys = nacl.box.keyPair();
  return { keys, serverId: deriveServerId(keys.publicKey), publicKey: bytesToHex(keys.publicKey) };
}

const post = (path: string, body: unknown, token?: string) => new Request(BASE + path, {
  method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
});

async function removeRecord(account: string, signer: Awaited<ReturnType<typeof client>>, key: string): Promise<AccountRecord> {
  return signAccountRecord({ v: 1, kind: "remove", account, key, issued_at: new Date().toISOString(), id: newRecordId(), signer: signer.spki }, signer.pair.privateKey);
}

async function pull(service: FakeAccountService, machine: ReturnType<typeof pc>, ack: number | null, role: ProofRoute["role"] = "account", account = "acct_1") {
  const challenge = await (await service.fetch(post("/v1/pc/challenge", { server_id: machine.serverId, public_key: machine.publicKey }))).json() as { challenge_id: string; frame: string };
  const proof = answerServerChallenge(challenge.frame, machine.keys.secretKey, { server_id: machine.serverId, role, connection_id: challenge.challenge_id });
  const response = await service.fetch(post("/v1/pc/mailbox", { server_id: machine.serverId, challenge_id: challenge.challenge_id, proof, ack, account }));
  return { status: response.status, body: await response.json() as { records?: { seq: number; record: AccountRecord }[]; error?: { code: string } }, challenge, proof };
}

describe("the fake account service", () => {
  test("PCR-1 compat: a device code's own listing that completed or was digit-admitted is not its to end", async () => {
    const service = new FakeAccountService();
    const cli = service.issueToken("acct_1", { device: true });
    const put = (machine: ReturnType<typeof pc>) => service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, {
      method: "PUT", body: JSON.stringify({ label: "pc", public_key: machine.publicKey, relay: "wss://relay.test" }), headers: { "content-type": "application/json", authorization: `Bearer ${cli}` },
    }));
    const remove = async (machine: ReturnType<typeof pc>) => {
      const answer = await service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, { method: "DELETE", headers: { authorization: `Bearer ${cli}` } }));
      return answer.status === 204 ? 204 : `${answer.status} ${((await answer.json()) as { error?: { code?: string } }).error?.code}`;
    };
    for (const after of [{ completed_at: new Date().toISOString() }, { digit_admitted: true }] as Partial<FakePc>[]) {
      const machine = pc();
      expect((await put(machine)).status).toBe(200);
      Object.assign(service.pcs("acct_1").find((entry) => entry.server_id === machine.serverId)!, after);
      expect(await remove(machine)).toBe("403 own_sign_in_required");
    }
  });

  test("PCR-1: a device code's listing made while Step 2 was off stays a member once Step 2 is on: its end counts as a removal", async () => {
    const service = new FakeAccountService();
    const used = () => (service as unknown as { usedAccounts: Set<string> }).usedAccounts.has("acct_1");
    const cli = service.issueToken("acct_1", { device: true });
    const machine = pc();
    expect((await service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, {
      method: "PUT", body: JSON.stringify({ label: "pc", public_key: machine.publicKey, relay: "wss://relay.test" }), headers: { "content-type": "application/json", authorization: `Bearer ${cli}` },
    }))).status).toBe(200);
    service.opensAll = true;
    expect((await service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, { method: "DELETE", headers: { authorization: `Bearer ${cli}` } }))).status).toBe(204);
    expect(used()).toBe(true);
  });

  test("PCR-1 ruling (b): with Step 2 off a device code's own listing is a member: its end counts as a removal, and another sign-in's is 403", async () => {
    const service = new FakeAccountService();
    const used = () => (service as unknown as { usedAccounts: Set<string> }).usedAccounts.has("acct_1");
    const put = (token: string, machine: ReturnType<typeof pc>) => service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, {
      method: "PUT", body: JSON.stringify({ label: "pc", public_key: machine.publicKey, relay: "wss://relay.test" }), headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    }));
    const remove = (token: string, machine: ReturnType<typeof pc>) => service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }));
    const cli = service.issueToken("acct_1", { device: true });
    const mine = pc();
    expect((await put(cli, mine)).status).toBe(200);
    expect((await remove(service.issueToken("acct_1", { device: true }), mine)).status).toBe(403);
    expect(used()).toBe(false);
    expect((await remove(cli, mine)).status).toBe(204);
    expect(service.pcs("acct_1")).toEqual([]);
    expect(used()).toBe(true);
  });

  test("PCR-1 compat: a device code's sign-in ends only its own pending listing, logging nothing; everything else is 403", async () => {
    const service = new FakeAccountService();
    // Step 2 on: the device code's listing is pending, never a member
    service.opensAll = true;
    const put = (token: string, machine: ReturnType<typeof pc>) => service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, {
      method: "PUT", body: JSON.stringify({ label: "pc", public_key: machine.publicKey, relay: "wss://relay.test" }), headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    }));
    const remove = async (token: string, machine: ReturnType<typeof pc>) => {
      const answer = await service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }));
      return answer.status === 204 ? 204 : `${answer.status} ${((await answer.json()) as { error?: { code?: string } }).error?.code}`;
    };
    const cli = service.issueToken("acct_1", { device: true });
    const mine = pc();
    expect((await put(cli, mine)).status).toBe(200);
    // another device code's sign-in, then the lister itself, which can list it again
    expect(await remove(service.issueToken("acct_1", { device: true }), mine)).toBe("403 own_sign_in_required");
    expect(await remove(cli, mine)).toBe(204);
    expect(service.pcs("acct_1")).toEqual([]);
    expect((await put(cli, mine)).status).toBe(200);
    // confirmed or admitted since: no longer its own to end
    for (const after of [{ listed_by_device: false }, { admitted_at: new Date().toISOString() }, { listed_by_session: undefined }] as Partial<FakePc>[]) {
      const machine = pc();
      expect((await put(cli, machine)).status).toBe(200);
      Object.assign(service.pcs("acct_1").find((entry) => entry.server_id === machine.serverId)!, after);
      expect(await remove(cli, machine)).toBe("403 own_sign_in_required");
    }
    expect(await remove(cli, pc())).toBe("403 own_sign_in_required");
  });

  test("a record a client queues reaches each listed PC once it proves its key, and an ack clears it", async () => {
    const service = new FakeAccountService();
    const token = service.issueToken("acct_1");
    const phone = await client();
    const lost = await client();
    const [a, b] = [pc(), pc()];
    for (const machine of [a, b]) await service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, { method: "PUT", body: JSON.stringify({ label: "pc", public_key: machine.publicKey, relay: "wss://relay.ovis.sh" }), headers: { authorization: `Bearer ${token}` } }));
    const record = await removeRecord("acct_1", phone, lost.spki);
    expect((await service.fetch(post("/v1/records", { server_ids: [a.serverId, b.serverId], record }, token))).status).toBe(200);

    const first = await pull(service, a, null);
    expect(first.body.records?.map((entry) => entry.record)).toEqual([record]);
    const second = await pull(service, a, first.body.records![0]!.seq);
    expect(second.body.records).toEqual([]);
    expect(service.mailbox(b.serverId, "acct_1")).toEqual([record]);
  });

  test("a client cannot queue a forged record, another account's record, or one for a PC outside its directory", async () => {
    const service = new FakeAccountService();
    const token = service.issueToken("acct_1");
    const phone = await client();
    const machine = pc();
    await service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, { method: "PUT", body: JSON.stringify({ label: "pc", public_key: machine.publicKey, relay: "wss://relay.ovis.sh" }), headers: { authorization: `Bearer ${token}` } }));
    const record = await removeRecord("acct_1", phone, (await client()).spki);
    const cases: [Request, string][] = [
      [post("/v1/records", { server_ids: [machine.serverId], record: { ...record, issued_at: "2026-11-05T00:00:00.000Z" } }, token), "signature_invalid"],
      [post("/v1/records", { server_ids: [machine.serverId], record: await removeRecord("acct_2", phone, (await client()).spki) }, token), "account_mismatch"],
      [post("/v1/records", { server_ids: [pc().serverId], record }, token), "unknown_pc"],
      [post("/v1/records", { server_ids: [machine.serverId], record: { ...record, extra: true } }, token), "record_invalid"],
      [post("/v1/records", { server_ids: [machine.serverId], record }), "unauthorized"],
    ];
    for (const [request, code] of cases) expect(((await (await service.fetch(request)).json()) as { error: { code: string } }).error.code).toBe(code);
    expect(service.mailbox(machine.serverId, "acct_1")).toEqual([]);
  });

  test("a mailbox opens only to a proof with the account role, once per challenge", async () => {
    const service = new FakeAccountService();
    const machine = pc();
    expect((await pull(service, machine, null, "control")).status).toBe(401);
    const ok = await pull(service, machine, null);
    expect(ok.status).toBe(200);
    const replay = await service.fetch(post("/v1/pc/mailbox", { server_id: machine.serverId, challenge_id: ok.challenge.challenge_id, proof: ok.proof, ack: null, account: "acct_1" }));
    expect(replay.status).toBe(401);
    const stranger = pc();
    const refused = await service.fetch(post("/v1/pc/challenge", { server_id: machine.serverId, public_key: stranger.publicKey }));
    expect(refused.status).toBe(401);
  });

  test("another account that lists a PC can neither fill its account's mailbox nor see it come by", async () => {
    const service = new FakeAccountService();
    const owner = service.issueToken("acct_1");
    const attacker = service.issueToken("acct_evil");
    const machine = pc();
    for (const token of [owner, attacker]) await service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, { method: "PUT", body: JSON.stringify({ label: "pc", public_key: machine.publicKey, relay: "wss://relay.ovis.sh" }), headers: { authorization: `Bearer ${token}` } }));
    const evil = await client();
    for (let index = 0; index < 5; index++) await service.fetch(post("/v1/records", { server_ids: [machine.serverId], record: await removeRecord("acct_evil", evil, (await client()).spki) }, attacker));
    const phone = await client();
    const removal = await removeRecord("acct_1", phone, (await client()).spki);
    await service.fetch(post("/v1/records", { server_ids: [machine.serverId], record: removal }, owner));

    const pulled = await pull(service, machine, null);
    expect(pulled.body.records?.map((entry) => entry.record)).toEqual([removal]);
    const seen = await (await service.fetch(new Request(`${BASE}/v1/pcs`, { headers: { authorization: `Bearer ${attacker}` } }))).json() as { pcs: FakePc[] };
    expect(seen.pcs[0]?.last_seen_at).toBeNull();
  });

  test("the address book keeps a PC's key and relay only when the key gives its server_id", async () => {
    const service = new FakeAccountService();
    const token = service.issueToken("acct_1");
    const machine = pc();
    const put = (body: unknown) => service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, { method: "PUT", body: JSON.stringify(body), headers: { authorization: `Bearer ${token}` } }));
    expect((await put({ label: "pc", public_key: pc().publicKey, relay: "wss://relay.ovis.sh" })).status).toBe(400);
    expect((await put({ label: "pc", public_key: machine.publicKey, relay: "https://relay.ovis.sh" })).status).toBe(400);
    expect((await put({ label: "pc", public_key: machine.publicKey, relay: "wss://relay.ovis.sh" })).status).toBe(200);
    const listed = await (await service.fetch(new Request(`${BASE}/v1/pcs`, { headers: { authorization: `Bearer ${token}` } }))).json() as { pcs: FakePc[] };
    expect(listed.pcs).toEqual([expect.objectContaining({ server_id: machine.serverId, public_key: machine.publicKey, relay: "wss://relay.ovis.sh" })]);
  });

  test("an answer given for the account role does not open a relay route", () => {
    const machine = pc();
    const route: ProofRoute = { server_id: machine.serverId, role: "control", connection_id: null };
    const relay = serverChallenge(machine.keys.publicKey, route);
    const accountAnswer = answerServerChallenge(relay.frame, machine.keys.secretKey, { ...route, role: "account" });
    expect(verifyServerProof(accountAnswer, relay.expected)).toBe(false);
    expect(verifyServerProof(answerServerChallenge(relay.frame, machine.keys.secretKey, route), relay.expected)).toBe(true);
  });

  test("a PC's mailbox carries its account's admissions for ten minutes, each naming the waiting device's key", async () => {
    let now = Date.parse("2026-11-05T00:00:00.000Z");
    const service = new FakeAccountService(() => now);
    const [mine, other] = [service.issueToken("acct_1"), service.issueToken("acct_2")];
    const machine = pc();
    for (const token of [mine, other]) await service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, { method: "PUT", body: JSON.stringify({ label: "pc", public_key: machine.publicKey, relay: "wss://relay.ovis.sh" }), headers: { authorization: `Bearer ${token}` } }));
    const waiting = await client();
    expect((await service.fetch(post("/v1/admissions", { server_id: machine.serverId, label: "Mac" }, mine))).status).toBe(400);
    await service.fetch(post("/v1/admissions", { server_id: machine.serverId, label: "Mac", key: waiting.spki }, mine));
    await service.fetch(post("/v1/admissions", { server_id: machine.serverId, label: "Other", key: (await client()).spki }, other));
    const first = (await pull(service, machine, null)).body as { admissions?: { key: string }[] };
    expect(first.admissions?.map(({ key }) => key)).toEqual([waiting.spki]);
    now += ADMISSION_TTL_MS;
    expect(((await pull(service, machine, null)).body as { admissions?: unknown[] }).admissions).toEqual([]);
  });

  test("a quiet admission is kept apart from the ordinary ones and reaches the PC in a field of its own while the account lists it", async () => {
    const service = new FakeAccountService();
    const [mine, phone] = [service.issueToken("acct_1"), service.issueToken("acct_1")];
    await service.fetch(new Request(`${BASE}/v1/push`, { method: "PUT", body: JSON.stringify({ endpoint: "https://push.test/1", keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } }), headers: { authorization: `Bearer ${phone}` } }));
    const machine = pc();
    await service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, { method: "PUT", body: JSON.stringify({ label: "pc", public_key: machine.publicKey, relay: "wss://relay.ovis.sh" }), headers: { authorization: `Bearer ${mine}` } }));
    const rings = service.rings().length;
    const [quiet, ordinary] = [await client(), await client()];
    expect((await service.fetch(post("/v1/admissions", { server_id: machine.serverId, label: "Mac", key: quiet.spki, quiet: "yes" }, mine))).status).toBe(400);
    expect((await service.fetch(post("/v1/admissions", { server_id: machine.serverId, label: "Mac", key: quiet.spki, quiet: true }, mine))).status).toBe(200);
    expect(service.rings().length).toBe(rings);
    await service.fetch(post("/v1/admissions", { server_id: machine.serverId, label: "Mac", key: ordinary.spki }, mine));
    expect(service.rings().length).toBe(rings + 1);
    const listed = await (await service.fetch(new Request(`${BASE}/v1/admissions`, { headers: { authorization: `Bearer ${mine}` } }))).json() as { admissions: { key: string }[] };
    expect(listed.admissions.map(({ key }) => key)).toEqual([ordinary.spki]);
    const read = async () => (await pull(service, machine, null)).body as { admissions: { key: string }[]; quiet_admissions: { key: string }[] };
    const first = await read();
    expect([first.admissions.map(({ key }) => key), first.quiet_admissions.map(({ key }) => key)]).toEqual([[ordinary.spki], [quiet.spki]]);
    await service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, { method: "DELETE", headers: { authorization: `Bearer ${mine}` } }));
    expect((await read()).quiet_admissions).toEqual([]);
  });

  test("an admission lists the system the device sent and the place its request came from; an unknown system is kept as unknown", async () => {
    const service = new FakeAccountService(() => Date.parse("2026-11-05T00:00:00.000Z"));
    service.requestPlace = { country: "KR", city: "Seoul" };
    const token = service.issueToken("acct_1");
    const machine = pc();
    await service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, { method: "PUT", body: JSON.stringify({ label: "pc", public_key: machine.publicKey, relay: "wss://relay.ovis.sh" }), headers: { authorization: `Bearer ${token}` } }));
    const [phone, tablet] = [await client(), await client()];
    await service.fetch(post("/v1/admissions", { server_id: machine.serverId, label: "iPhone", key: phone.spki, os: "ios" }, token));
    await service.fetch(post("/v1/admissions", { server_id: machine.serverId, label: "Tablet", key: tablet.spki, os: "plan9" }, token));
    const listed = await (await service.fetch(new Request(`${BASE}/v1/admissions`, { headers: { authorization: `Bearer ${token}` } }))).json() as { admissions: { label: string; os: unknown; country: unknown; city: unknown }[] };
    expect(listed.admissions.map(({ label, os, country, city }) => ({ label, os, country, city }))).toEqual([
      { label: "iPhone", os: "ios", country: "KR", city: "Seoul" },
      { label: "Tablet", os: null, country: "KR", city: "Seoul" },
    ]);
  });

  test("a member lists its own account's admissions of the last ten minutes, and no other account's", async () => {
    let now = Date.parse("2026-11-05T00:00:00.000Z");
    const service = new FakeAccountService(() => now);
    const [mine, other] = [service.issueToken("acct_1"), service.issueToken("acct_2")];
    const machine = pc();
    for (const token of [mine, other]) await service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, { method: "PUT", body: JSON.stringify({ label: "pc", public_key: machine.publicKey, relay: "wss://relay.ovis.sh" }), headers: { authorization: `Bearer ${token}` } }));
    const waiting = await client();
    await service.fetch(post("/v1/admissions", { server_id: machine.serverId, label: "Mac", key: waiting.spki }, mine));
    await service.fetch(post("/v1/admissions", { server_id: machine.serverId, label: "Other", key: (await client()).spki }, other));
    const list = async () => (await (await service.fetch(new Request(`${BASE}/v1/admissions`, { headers: { authorization: `Bearer ${mine}` } }))).json()) as { admissions: unknown[] };
    expect((await list()).admissions).toEqual([{ key: waiting.spki, label: "Mac", server_id: machine.serverId, at: "2026-11-05T00:00:00.000Z", os: null, country: null, city: null }]);
    now += ADMISSION_TTL_MS;
    expect((await list()).admissions).toEqual([]);
    expect((await service.fetch(new Request(`${BASE}/v1/admissions`))).status).toBe(401);
  });

  test("records older than thirty days are gone", async () => {
    let now = Date.parse("2026-11-05T00:00:00.000Z");
    const service = new FakeAccountService(() => now);
    const token = service.issueToken("acct_1");
    const phone = await client();
    const machine = pc();
    await service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, { method: "PUT", body: JSON.stringify({ label: "pc", public_key: machine.publicKey, relay: "wss://relay.ovis.sh" }), headers: { authorization: `Bearer ${token}` } }));
    await service.fetch(post("/v1/records", { server_ids: [machine.serverId], record: await removeRecord("acct_1", phone, (await client()).spki) }, token));
    now += MAILBOX_TTL_MS + 1;
    expect((await pull(service, machine, null)).body.records).toEqual([]);
  });
});

async function pkce() {
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge };
}

async function signIn(service: FakeAccountService, redirect = WEB_REDIRECT, mode?: string) {
  const { verifier, challenge } = await pkce();
  const url = `${BASE}/v1/signin/github?redirect_uri=${encodeURIComponent(redirect)}&state=s1&code_challenge=${challenge}&code_challenge_method=S256${mode ? `&response_mode=${mode}` : ""}`;
  const answer = await service.fetch(new Request(url));
  const back = new URL(answer.headers.get("location") ?? "about:blank");
  const params = back.hash ? new URLSearchParams(back.hash.slice(1)) : back.searchParams;
  return { answer, back, params, verifier, redirect, code: params.get("code") ?? "" };
}

const token = (service: FakeAccountService, body: unknown) => service.fetch(post("/v1/token", body));
const pcs = (service: FakeAccountService, access: string) => service.fetch(new Request(`${BASE}/v1/pcs`, { headers: { authorization: `Bearer ${access}` } }));

describe("signing in to the fake account service", () => {
  test("a sign-in returns a code with its state, and only the matching code_verifier turns it into tokens, once", async () => {
    const service = new FakeAccountService();
    service.signInAs("github", "acct_7");
    const flow = await signIn(service);
    expect(flow.answer.status).toBe(302);
    expect(flow.back.origin + flow.back.pathname).toBe(flow.redirect);
    // on the web the code comes back in the fragment, which never reaches app.ovis.sh
    expect(flow.back.search).toBe("");
    expect(flow.params.get("state")).toBe("s1");
    const wrong = await token(service, { grant_type: "authorization_code", code: flow.code, code_verifier: (await pkce()).verifier, redirect_uri: flow.redirect });
    expect(wrong.status).toBe(400);
    const again = await signIn(service);
    const granted = await (await token(service, { grant_type: "authorization_code", code: again.code, code_verifier: again.verifier, redirect_uri: again.redirect })).json() as Record<string, unknown>;
    expect(granted).toMatchObject({ account: "acct_7", provider: "github", expires_in: ACCESS_TOKEN_TTL_S });
    expect((await pcs(service, String(granted.access_token))).status).toBe(200);
    expect((await token(service, { grant_type: "authorization_code", code: again.code, code_verifier: again.verifier, redirect_uri: again.redirect })).status).toBe(400);
  });

  test("a code is spent at sixty seconds, and an Apple identity token needs a real nonce", async () => {
    let now = 0;
    const service = new FakeAccountService(() => now);
    const flow = await signIn(service);
    now = 60_000;
    expect((await token(service, { grant_type: "authorization_code", code: flow.code, code_verifier: flow.verifier, redirect_uri: flow.redirect })).status).toBe(400);
    expect((await token(service, { grant_type: "apple_id_token", id_token: service.appleIdToken("acct_apple", ""), nonce: "" })).status).toBe(400);
  });

  test("only the listed redirects are allowed, exactly", () => {
    for (const ok of ["https://app.ovis.sh/", "ovis://account/callback", "http://127.0.0.1:53117/callback"]) expect(isAllowedRedirect(ok)).toBe(true);
    for (const bad of ["https://app.ovis.sh/account/callback", "https://app.ovis.sh", "https://app.ovis.sh/s/x/", "https://evil.example/account/callback", "http://localhost:53117/callback",
      "http://127.0.0.1:53117/other", "http://127.0.0.1:53117/callback/elsewhere", "http://127.0.0.1:99999/callback", "https://app.ovis.sh/account/callback?x=1"]) expect(isAllowedRedirect(bad)).toBe(false);
  });

  test("a refresh token rotates, and using an old one again ends the whole family", async () => {
    const service = new FakeAccountService();
    const flow = await signIn(service);
    const first = await (await token(service, { grant_type: "authorization_code", code: flow.code, code_verifier: flow.verifier, redirect_uri: flow.redirect })).json() as Record<string, string>;
    const second = await (await token(service, { grant_type: "refresh_token", refresh_token: first.refresh_token })).json() as Record<string, string>;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await pcs(service, second.access_token!)).status).toBe(200);
    expect((await token(service, { grant_type: "refresh_token", refresh_token: first.refresh_token })).status).toBe(400);
    expect((await pcs(service, second.access_token!)).status).toBe(401);
    expect((await token(service, { grant_type: "refresh_token", refresh_token: second.refresh_token })).status).toBe(400);
  });

  test("an access token ends when it expires and when its family signs out", async () => {
    let now = Date.parse("2026-11-05T00:00:00.000Z");
    const service = new FakeAccountService(() => now);
    const flow = await signIn(service);
    const granted = await (await token(service, { grant_type: "authorization_code", code: flow.code, code_verifier: flow.verifier, redirect_uri: flow.redirect })).json() as Record<string, string>;
    now += ACCESS_TOKEN_TTL_S * 1000;
    expect((await pcs(service, granted.access_token!)).status).toBe(401);
    const fresh = await (await token(service, { grant_type: "refresh_token", refresh_token: granted.refresh_token })).json() as Record<string, string>;
    expect((await service.fetch(new Request(`${BASE}/v1/signout`, { method: "POST", headers: { authorization: `Bearer ${fresh.access_token}` } }))).status).toBe(204);
    expect((await pcs(service, fresh.access_token!)).status).toBe(401);
    expect((await token(service, { grant_type: "refresh_token", refresh_token: fresh.refresh_token })).status).toBe(400);
  });

  test("an iOS app signs in with Apple's identity token only for the plain nonce whose hash Apple was given, once", async () => {
    const service = new FakeAccountService();
    const nonce = "nonce-0123456789ab";
    const hashed = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce))).toString("hex");
    expect((await token(service, { grant_type: "apple_id_token", id_token: service.appleIdToken("acct_apple", hashed), nonce: "nonce-ba9876543210" })).status).toBe(400);
    expect((await token(service, { grant_type: "apple_id_token", id_token: service.appleIdToken("acct_apple", nonce), nonce })).status).toBe(400);
    const idToken = service.appleIdToken("acct_apple", hashed);
    expect(await (await token(service, { grant_type: "apple_id_token", id_token: idToken, nonce })).json()).toMatchObject({ account: "acct_apple", provider: "apple" });
    expect((await token(service, { grant_type: "apple_id_token", id_token: idToken, nonce })).status).toBe(400);
  });

  test("a headless PC signs in with GitHub's device flow: pending, slow down, then tokens once", async () => {
    let now = 0;
    const service = new FakeAccountService(() => now);
    const started = await (await service.fetch(post("/v1/signin/github/device", {}))).json() as { device_code: string; user_code: string; interval: number };
    expect(started.interval).toBe(DEVICE_POLL_S);
    const poll = async () => ((await (await token(service, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: started.device_code })).json()) as { error?: { code: string }; account?: string });
    expect((await poll()).error?.code).toBe("authorization_pending");
    expect((await poll()).error?.code).toBe("slow_down");
    now += 60_000;
    service.approveDevice(started.user_code, "acct_head");
    expect((await poll()).account).toBe("acct_head");
    now += 60_000;
    expect((await poll()).error?.code).toBe("expired_token");
  });

  test("a sign-in made with a device code cannot delete the account, before and after a refresh (web_sign_in_required)", async () => {
    let now = 0;
    const service = new FakeAccountService(() => now);
    const started = await (await service.fetch(post("/v1/signin/github/device", {}))).json() as { device_code: string; user_code: string };
    service.approveDevice(started.user_code, "acct_head");
    now += 60_000;
    const session = await (await token(service, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: started.device_code })).json() as { access_token: string; refresh_token: string };
    const del = (access: string) => service.fetch(new Request(`${BASE}/v1/account`, { method: "DELETE", headers: { authorization: `Bearer ${access}` } }));
    const refused = await del(session.access_token);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("web_sign_in_required");
    const refreshed = await (await token(service, { grant_type: "refresh_token", refresh_token: session.refresh_token })).json() as { access_token: string };
    expect((await del(refreshed.access_token)).status).toBe(403);
    expect(service.deleted("acct_head")).toBe(false);
  });

  test("signing out every device ends each sign-in of the account, the caller's and device codes' included, from a fresh own sign-in only", async () => {
    let now = 0;
    const service = new FakeAccountService(() => now);
    const all = (access: string) => service.fetch(post("/v1/signout/all", {}, access));
    const caller = service.issueToken("acct_all");
    const browser = service.issueToken("acct_all");
    const typed = service.issueToken("acct_all", { device: true });
    const other = service.issueToken("acct_other");
    const refusal = async (response: Response) => [response.status, ((await response.json()) as { error: { code: string } }).error.code];
    expect(await refusal(await all(typed))).toEqual([403, "web_sign_in_required"]);
    now += 11 * 60_000;
    const fresh = service.issueToken("acct_all");
    expect(await refusal(await all(caller))).toEqual([403, "reauth_required"]);
    for (const access of [caller, browser, typed]) expect((await pcs(service, access)).status).toBe(200);
    expect((await all(fresh)).status).toBe(204);
    for (const access of [fresh, caller, browser, typed]) expect((await pcs(service, access)).status).toBe(401);
    expect((await pcs(service, other)).status).toBe(200);
  });

  test("a device sign-in started with a challenge says so, and redeems only with its verifier", async () => {
    let now = 0;
    const service = new FakeAccountService(() => now);
    const { verifier, challenge } = await pkce();
    const started = await (await service.fetch(post("/v1/signin/github/device", { code_challenge: challenge, code_challenge_method: "S256" }))).json() as { device_code: string; user_code: string; code_challenge_method?: string };
    expect(started.code_challenge_method).toBe("S256");
    service.approveDevice(started.user_code, "acct_page");
    const poll = async (code_verifier?: string) => (await (await token(service, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: started.device_code, ...(code_verifier ? { code_verifier } : {}) })).json()) as { error?: { code: string }; account?: string };
    expect((await poll()).error?.code).toBe("invalid_grant");
    expect((await poll((await pkce()).verifier)).error?.code).toBe("invalid_grant");
    // the refused polls did not move the interval: the right verifier gets the tokens at once
    expect((await poll(verifier)).account).toBe("acct_page");
  });

  test("a device sign-in refused at GitHub answers access_denied", async () => {
    const service = new FakeAccountService();
    const started = await (await service.fetch(post("/v1/signin/github/device", {}))).json() as { device_code: string; user_code: string };
    service.denyDevice(started.user_code);
    expect(((await (await token(service, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: started.device_code })).json()) as { error: { code: string } }).error.code).toBe("access_denied");
  });

  test("the loopback redirect takes the code in its query, and the app's own scheme may ask for the fragment", async () => {
    const service = new FakeAccountService();
    const loopback = await signIn(service, "http://127.0.0.1:53117/callback");
    expect(loopback.back.hash).toBe("");
    expect(loopback.back.searchParams.get("code")).toBe(loopback.code);
    expect((await signIn(service, "http://127.0.0.1:53117/callback", "fragment")).answer.status).toBe(400);
    expect((await signIn(service, WEB_REDIRECT, "query")).answer.status).toBe(400);
    const app = await signIn(service, "ovis://account/callback", "fragment");
    expect(app.back.search).toBe("");
    expect(app.params.get("code")).toBe(app.code);
  });

  test("a sign-in without S256 PKCE, state, or to another redirect is refused before any code", async () => {
    const service = new FakeAccountService();
    const { challenge } = await pkce();
    for (const query of [
      `redirect_uri=${encodeURIComponent("https://evil.example/cb")}&state=s&code_challenge=${challenge}&code_challenge_method=S256`,
      `redirect_uri=${encodeURIComponent("ovis://account/callback")}&state=s&code_challenge=${challenge}&code_challenge_method=plain`,
      `redirect_uri=${encodeURIComponent("ovis://account/callback")}&code_challenge=${challenge}&code_challenge_method=S256`,
    ]) expect((await service.fetch(new Request(`${BASE}/v1/signin/github?${query}`))).status).toBe(400);
  });
});

describe("the fake account service's doorbell and limits", () => {
  const p256dh = "B" + "A".repeat(86);
  const auth = "A".repeat(22);
  const put = (service: FakeAccountService, token: string, path: string, body: unknown, method = "PUT") =>
    service.fetch(new Request(`${BASE}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${token}` } }));

  test("other signed-in devices are rung, with no content, when a PC joins the directory or a device waits at one", async () => {
    const service = new FakeAccountService();
    const [phone, laptop] = [service.issueToken("acct_1"), service.issueToken("acct_1")];
    expect((await put(service, phone, "/v1/push", { endpoint: "https://push.ovis.sh/p/1", keys: { p256dh, auth } })).status).toBe(204);
    const machine = pc();
    await put(service, laptop, `/v1/pcs/${machine.serverId}`, { label: "pc", public_key: machine.publicKey, relay: "wss://relay.ovis.sh" });
    await put(service, laptop, `/v1/pcs/${machine.serverId}`, { label: "renamed", public_key: machine.publicKey, relay: "wss://relay.ovis.sh" });
    await service.fetch(post("/v1/admissions", { server_id: machine.serverId, label: "Mac", key: (await client()).spki }, laptop));
    await service.fetch(post("/v1/admissions", { server_id: machine.serverId, label: "Mac", key: (await client()).spki }, phone));
    expect(service.rings()).toEqual([
      { account: "acct_1", endpoint: "https://push.ovis.sh/p/1", payload: ACCOUNT_RING },
      { account: "acct_1", endpoint: "https://push.ovis.sh/p/1", payload: ACCOUNT_RING },
    ]);
    expect((await put(service, phone, "/v1/push", undefined, "DELETE")).status).toBe(204);
    await service.fetch(post("/v1/admissions", { server_id: machine.serverId, label: "Mac", key: (await client()).spki }, laptop));
    expect(service.rings().length).toBe(2);
  });

  test("a directory holds at most a hundred PCs, and an account rings for admissions ten times in ten minutes", async () => {
    const service = new FakeAccountService();
    const token = service.issueToken("acct_1");
    let last = pc();
    for (let index = 0; index < DIRECTORY_MAX; index++) {
      last = pc();
      expect((await put(service, token, `/v1/pcs/${last.serverId}`, { label: "pc", public_key: last.publicKey, relay: "wss://relay.ovis.sh" })).status).toBe(200);
    }
    const extra = pc();
    expect(((await (await put(service, token, `/v1/pcs/${extra.serverId}`, { label: "pc", public_key: extra.publicKey, relay: "wss://relay.ovis.sh" })).json()) as { error: { code: string } }).error.code).toBe("directory_full");
    for (let index = 0; index < ADMISSIONS_PER_WINDOW; index++) expect((await service.fetch(post("/v1/admissions", { server_id: last.serverId, label: "Mac", key: (await client()).spki }, token))).status).toBe(200);
    expect((await service.fetch(post("/v1/admissions", { server_id: last.serverId, label: "Mac", key: (await client()).spki }, token))).status).toBe(429);
  });
});

describe("the fake's snapshot wire (device table P6, G1, P16)", () => {
  async function read(service: FakeAccountService, machine: ReturnType<typeof pc>, ask: { snapshot?: string; page?: number }, listed = true) {
    // only a PC the account lists reads its snapshot
    if (listed) {
      const body = JSON.stringify({ label: "pc", public_key: machine.publicKey, relay: "wss://relay.ovis.sh" });
      await service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, { method: "PUT", body, headers: { authorization: `Bearer ${service.issueToken("acct_1")}` } }));
    }
    const challenge = await (await service.fetch(post("/v1/pc/challenge", { server_id: machine.serverId, public_key: machine.publicKey }))).json() as { challenge_id: string; frame: string };
    const proof = answerServerChallenge(challenge.frame, machine.keys.secretKey, { server_id: machine.serverId, role: "account", connection_id: challenge.challenge_id });
    const response = await service.fetch(post("/v1/pc/snapshot", { server_id: machine.serverId, challenge_id: challenge.challenge_id, proof, account: "acct_1", ...ask }));
    return { status: response.status, body: await response.json() as AccountSnapshotPage & { error?: { code: string } } };
  }

  test("with the flag off the routes do not exist", async () => {
    const service = new FakeAccountService();
    expect((await read(service, pc(), {}, false)).status).toBe(404);
    expect((await service.fetch(post("/v1/safety-records", { record: {} }, service.issueToken("acct_1")))).status).toBe(404);
  });

  test("every page of a read is one snapshot, and a dropped snapshot answers snapshot_gone", async () => {
    const service = new FakeAccountService();
    service.opensAll = true;
    const machine = pc();
    const keys = await Promise.all(Array.from({ length: SNAPSHOT_PAGE + 1 }, client));
    keys.forEach((device, index) => expect(service.registerDevice("acct_1", device.spki, `Device ${index}`)).toBe(index + 1));
    const first = await read(service, machine, {});
    service.registerDevice("acct_1", (await client()).spki, "Later");
    const second = await read(service, machine, { snapshot: first.body.snapshot, page: 1 });
    const whole = assembleSnapshot([parseSnapshotPage(first.body), parseSnapshotPage(second.body)], { account: "acct_1", server_id: machine.serverId, lastApplied: null });
    expect(whole.devices.map((device) => device.no)).toEqual(keys.map((_, index) => index + 1));
    const elsewhere = await read(service, pc(), { snapshot: first.body.snapshot, page: 1 });
    expect({ status: elsewhere.status, code: elsewhere.body.error?.code }).toEqual({ status: 410, code: "snapshot_gone" });
    service.dropSnapshots();
    const gone = await read(service, machine, { snapshot: first.body.snapshot, page: 1 });
    expect({ status: gone.status, code: gone.body.error?.code }).toEqual({ status: 410, code: "snapshot_gone" });
  });

  test("a PC the account does not list reads nothing of it", async () => {
    const service = new FakeAccountService();
    service.opensAll = true;
    service.registerDevice("acct_1", (await client()).spki, "Phone");
    const stranger = await read(service, pc(), {}, false);
    expect({ status: stranger.status, code: stranger.body.error?.code }).toEqual({ status: 403, code: "not_listed" });
  });

  test("removed keys are paged like devices, so no page passes the page size", async () => {
    const service = new FakeAccountService();
    service.opensAll = true;
    const machine = pc();
    const keys = await Promise.all(Array.from({ length: SNAPSHOT_PAGE + 1 }, client));
    for (const [index, device] of keys.entries()) {
      service.registerDevice("acct_1", device.spki, `Device ${index}`);
      service.removeDevice("acct_1", device.spki);
    }
    const first = await read(service, machine, {});
    expect({ last: first.body.last, removed: first.body.removed.length }).toEqual({ last: false, removed: SNAPSHOT_PAGE });
    const second = await read(service, machine, { snapshot: first.body.snapshot, page: 1 });
    const whole = assembleSnapshot([parseSnapshotPage(first.body), parseSnapshotPage(second.body)], { account: "acct_1", server_id: machine.serverId, lastApplied: null });
    expect(whole.removed.length).toBe(SNAPSHOT_PAGE + 1);
  });

  test("only a list-eligible older device lifts a block; otherwise the freeze stays (T52)", async () => {
    const service = new FakeAccountService();
    service.opensAll = true;
    const token = service.issueToken("acct_1");
    const [eligibleOld, unready, blocked] = [await client(), await client(), await client()];
    const eligibleNo = service.registerDevice("acct_1", eligibleOld.spki, "Phone");
    const unreadyNo = service.registerDevice("acct_1", unready.spki, "Old tablet", false);
    const blockedNo = service.registerDevice("acct_1", blocked.spki, "Laptop");
    const signed = { v: 1 as const, account: "acct_1", signed_at: new Date().toISOString() };
    const block = await signSafetyRecord({ ...signed, kind: "block", target: blocked.spki, target_no: blockedNo, signer: eligibleOld.spki, signer_no: eligibleNo, nonce: newRecordId() }, eligibleOld.pair.privateKey);
    expect((await service.fetch(post("/v1/safety-records", { record: block }, token))).status).toBe(200);
    const early = await signSafetyRecord({ ...signed, kind: "lift", target: block.id, signer: unready.spki, signer_no: unreadyNo }, unready.pair.privateKey);
    const response = await service.fetch(post("/v1/safety-records", { record: early }, token));
    expect({ status: response.status, code: ((await response.json()) as { error?: { code: string } }).error?.code }).toEqual({ status: 403, code: "not_eligible" });
    const machine = pc();
    const body = JSON.stringify({ label: "pc", public_key: machine.publicKey, relay: "wss://relay.ovis.sh" });
    await service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, { method: "PUT", body, headers: { authorization: `Bearer ${token}` } }));
    expect(parseSnapshotPage((await read(service, machine, {})).body).freezes.map((line) => line.block)).toEqual([block.id]);
  });

  test("as the service, a signer signs only on the sign-in that registered its key: another sign-in of the account is refused, a kept record too", async () => {
    const service = new FakeAccountService();
    service.opensAll = true;
    const [first, later] = [service.issueToken("acct_1"), service.issueToken("acct_1")];
    const [phone, stranger] = [await client(), await client()];
    const phoneNo = service.registerSessionKey(first, phone.spki, "Phone");
    const strangerNo = service.registerDevice("acct_1", stranger.spki, "Stranger");
    const block = await signSafetyRecord({ v: 1, account: "acct_1", signed_at: new Date().toISOString(), kind: "block", target: stranger.spki, target_no: strangerNo,
      signer: phone.spki, signer_no: phoneNo, nonce: newRecordId() }, phone.pair.privateKey);
    const sent = async (token: string) => {
      const response = await service.fetch(post("/v1/safety-records", { record: block }, token));
      return { status: response.status, code: ((await response.json()) as { error?: { code: string } }).error?.code };
    };
    expect(await sent(later)).toEqual({ status: 403, code: "signer_not_member" });
    expect(await sent(first)).toEqual({ status: 200, code: undefined });
    expect(await sent(later)).toEqual({ status: 403, code: "signer_not_member" });
  });

  test("a block from an older device commits whole and a lift ends its freeze line", async () => {
    const service = new FakeAccountService();
    service.opensAll = true;
    const token = service.issueToken("acct_1");
    const [older, newer] = [await client(), await client()];
    const olderNo = service.registerDevice("acct_1", older.spki, "Phone");
    const newerNo = service.registerDevice("acct_1", newer.spki, "Laptop");
    const signed = { v: 1 as const, account: "acct_1", signed_at: new Date().toISOString() };
    const refusal = async (record: unknown) => {
      const response = await service.fetch(post("/v1/safety-records", { record }, token));
      return { status: response.status, code: ((await response.json()) as { error?: { code: string } }).error?.code };
    };
    const wrongWay = await signSafetyRecord({ ...signed, kind: "block", target: older.spki, target_no: olderNo, signer: newer.spki, signer_no: newerNo, nonce: newRecordId() }, newer.pair.privateKey);
    expect(await refusal(wrongWay)).toEqual({ status: 403, code: "signer_not_older" });
    expect(await refusal({ ...wrongWay, kind: "rename" })).toEqual({ status: 400, code: "record_invalid" });
    const block = await signSafetyRecord({ ...signed, kind: "block", target: newer.spki, target_no: newerNo, signer: older.spki, signer_no: olderNo, nonce: newRecordId() }, older.pair.privateKey);
    expect((await service.fetch(post("/v1/safety-records", { record: block }, token))).status).toBe(200);
    expect((await service.fetch(post("/v1/safety-records", { record: block }, token))).status).toBe(200);
    const again = await signSafetyRecord({ ...signed, kind: "block", target: newer.spki, target_no: newerNo, signer: older.spki, signer_no: olderNo, nonce: newRecordId() }, older.pair.privateKey);
    expect(await refusal(again)).toEqual({ status: 409, code: "target_removed" });
    const after = parseSnapshotPage((await read(service, pc(), {})).body);
    expect({ devices: after.devices.map((d) => d.no), removed: after.removed.map((r) => r.no), blocks: after.blocks.map((b) => b.id), freezes: after.freezes })
      .toEqual({ devices: [olderNo], removed: [newerNo], blocks: [block.id], freezes: [{ block: block.id, target: newer.spki, after: newerNo }] });
    // P16, G12: while the freeze stands, a key above its line is not list-eligible and signs nothing
    const later = await client();
    const laterNo = service.registerDevice("acct_1", later.spki, "Tablet");
    const frozen = parseSnapshotPage((await read(service, pc(), {})).body);
    expect(frozen.devices.map((d) => [d.no, d.eligible])).toEqual([[olderNo, true], [laterNo, false]]);
    const fromFrozen = await signSafetyRecord({ ...signed, kind: "block", target: older.spki, target_no: olderNo, signer: later.spki, signer_no: laterNo, nonce: newRecordId() }, later.pair.privateKey);
    expect(await refusal(fromFrozen)).toEqual({ status: 403, code: "frozen" });
    const lift = await signSafetyRecord({ ...signed, kind: "lift", target: block.id, signer: older.spki, signer_no: olderNo }, older.pair.privateKey);
    expect((await service.fetch(post("/v1/safety-records", { record: lift }, token))).status).toBe(200);
    const lifted = parseSnapshotPage((await read(service, pc(), {})).body);
    expect({ freezes: lifted.freezes, lifts: lifted.lifts.map((l) => l.id), version: lifted.version > after.version }).toEqual({ freezes: [], lifts: [lift.id], version: true });
  });

  test("P16, G12: a key above an active freeze line is left off the list, and a frozen key's block or lift is refused frozen", async () => {
    const service = new FakeAccountService();
    service.opensAll = true;
    const token = service.issueToken("acct_1");
    const [older, target, newest, later] = [await client(), await client(), await client(), await client()];
    const olderNo = service.registerDevice("acct_1", older.spki, "Phone");
    const targetNo = service.registerDevice("acct_1", target.spki, "Laptop");
    const newestNo = service.registerDevice("acct_1", newest.spki, "Tablet");
    const laterNo = service.registerDevice("acct_1", later.spki, "Watch");
    const signed = { v: 1 as const, account: "acct_1", signed_at: new Date().toISOString() };
    const send = async (record: unknown) => {
      const response = await service.fetch(post("/v1/safety-records", { record }, token));
      return { status: response.status, code: ((await response.json()) as { error?: { code: string } }).error?.code };
    };
    const block = await signSafetyRecord({ ...signed, kind: "block", target: target.spki, target_no: targetNo, signer: older.spki, signer_no: olderNo, nonce: newRecordId() }, older.pair.privateKey);
    expect((await send(block)).status).toBe(200);
    const frozen = parseSnapshotPage((await read(service, pc(), {})).body);
    expect(frozen.devices.filter((device) => device.eligible).map((device) => device.no)).toEqual([olderNo]);
    const byFrozen = await signSafetyRecord({ ...signed, kind: "block", target: later.spki, target_no: laterNo, signer: newest.spki, signer_no: newestNo, nonce: newRecordId() }, newest.pair.privateKey);
    expect(await send(byFrozen)).toEqual({ status: 403, code: "frozen" });
    const liftByFrozen = await signSafetyRecord({ ...signed, kind: "lift", target: block.id, signer: newest.spki, signer_no: newestNo }, newest.pair.privateKey);
    expect(await send(liftByFrozen)).toEqual({ status: 403, code: "frozen" });
    const lift = await signSafetyRecord({ ...signed, kind: "lift", target: block.id, signer: older.spki, signer_no: olderNo }, older.pair.privateKey);
    expect((await send(lift)).status).toBe(200);
    expect(parseSnapshotPage((await read(service, pc(), {})).body).devices.filter((device) => device.eligible).map((device) => device.no)).toEqual([olderNo, newestNo, laterNo]);
  });
});
describe("the fake's first-PC exemption, as the account service has it (account#62)", () => {
  const put = (service: FakeAccountService, token: string, machine: ReturnType<typeof pc>, extra: Record<string, unknown> = {}) => service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, {
    method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ label: "PC", public_key: machine.publicKey, relay: "wss://relay.example", ...extra }),
  }));
  const admit = async (service: FakeAccountService, token: string, machine: ReturnType<typeof pc>) => {
    const response = await service.fetch(post(`/v1/pcs/${machine.serverId}/admit`, {}, token));
    return response.ok ? "admitted" : (await response.json() as { error: { code: string } }).error.code;
  };
  // the exemption is from the two-step the service asked of a used account's admit until 2026-11-23
  const fresh = () => { const service = new FakeAccountService(); service.opensAll = true; service.admitAsksTwoStep = true; return service; };

  test("a phone signed in first, with no two-step, leaves the first PC's one press exempt", async () => {
    const service = fresh();
    const phone = service.issueToken("acct_1");
    service.registerSessionKey(phone, (await client()).spki, "Phone");
    const desk = pc();
    const owner = service.issueToken("acct_1");
    expect((await put(service, owner, desk)).ok).toBe(true);
    expect(await admit(service, owner, desk)).toBe("admitted");
  });

  test("a device code's pending listing under Step 2 leaves the account never used; a removal or a confirmed PC does not", async () => {
    const service = fresh();
    const typed = service.issueToken("acct_1", { device: true });
    expect((await put(service, typed, pc())).ok).toBe(true);
    const desk = pc();
    const owner = service.issueToken("acct_1");
    expect((await put(service, owner, desk)).ok).toBe(true);
    expect(await admit(service, owner, desk)).toBe("admitted");

    const removed = fresh();
    const removing = removed.issueToken("acct_1");
    const gone = pc();
    expect((await put(removed, removing, gone)).ok).toBe(true);
    await removed.fetch(new Request(`${BASE}/v1/pcs/${gone.serverId}`, { method: "DELETE", headers: { authorization: `Bearer ${removing}` } }));
    const next = pc();
    expect((await put(removed, removing, next)).ok).toBe(true);
    expect(await admit(removed, removing, next)).toBe("two_step_required");
  });

  test("since 2026-11-23 the admit asks no two-step: a used account's sign-in without it admits, and confirms a device code's listing", async () => {
    const service = fresh();
    service.admitAsksTwoStep = false;
    const owner = service.issueToken("acct_1");
    expect((await put(service, owner, pc())).ok).toBe(true);
    const typed = pc();
    expect((await put(service, service.issueToken("acct_1", { device: true }), typed)).ok).toBe(true);
    expect(await admit(service, owner, typed)).toBe("admitted");
    expect(service.pcs("acct_1").find((entry) => entry.server_id === typed.serverId)?.listed_by_device).toBe(false);
  });

  test("devices count once the account has a PC, and always for a confirm", async () => {
    const service = fresh();
    const phone = service.issueToken("acct_1");
    service.registerSessionKey(phone, (await client()).spki, "Phone");
    const typed = service.issueToken("acct_1", { device: true });
    const laptop = pc();
    expect((await put(service, typed, laptop)).ok).toBe(true);
    // the confirm writes no exempt admission, so a phone's key keeps it from passing without two-step
    const confirming = await put(service, service.issueToken("acct_1"), laptop, { confirm: true });
    expect(confirming.status).toBe(403);
    expect((await confirming.json() as { error: { code: string } }).error.code).toBe("two_step_required");
    const desk = pc();
    const owner = service.issueToken("acct_1");
    expect((await put(service, owner, desk)).ok).toBe(true);
    expect(await admit(service, owner, desk)).toBe("admitted");
    const second = pc();
    const again = service.issueToken("acct_1");
    expect((await put(service, again, second)).ok).toBe(true);
    expect(await admit(service, again, second)).toBe("two_step_required");
  });
});

describe("a PC's own leave (account#65)", () => {
  async function proofOf(service: FakeAccountService, machine: ReturnType<typeof pc>) {
    const challenge = await (await service.fetch(post("/v1/pc/challenge", { server_id: machine.serverId, public_key: machine.publicKey }))).json() as { challenge_id: string; frame: string };
    return { challenge_id: challenge.challenge_id, proof: answerServerChallenge(challenge.frame, machine.keys.secretKey, { server_id: machine.serverId, role: "account", connection_id: challenge.challenge_id }) };
  }
  const put = (service: FakeAccountService, token: string, machine: ReturnType<typeof pc>, extra: Record<string, unknown> = {}) =>
    service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, { method: "PUT", body: JSON.stringify({ label: "pc", public_key: machine.publicKey, relay: "wss://relay.ovis.sh", ...extra }), headers: { authorization: `Bearer ${token}` } }));
  const listed = async (service: FakeAccountService, token: string) =>
    ((await (await service.fetch(new Request(`${BASE}/v1/pcs`, { headers: { authorization: `Bearer ${token}` } }))).json()) as { pcs: { server_id: string }[] }).pcs.map((entry) => entry.server_id);

  test("after a leave a PUT without the PC's proof answers 409 pc_left for 30 days; the PC's own proof lists it again and ends the mark", async () => {
    let now = Date.parse("2026-11-21T00:00:00Z");
    const service = new FakeAccountService(() => now);
    const token = service.issueToken("acct_1");
    const machine = pc();
    expect((await put(service, token, machine)).status).toBe(200);

    expect((await service.fetch(post(`/v1/pcs/${machine.serverId}/leave`, { server_id: machine.serverId, account: "acct_1", ...await proofOf(service, machine) }))).status).toBe(204);
    expect(await listed(service, token)).toEqual([]);

    const refused = await put(service, token, machine);
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: { code: string; left_at: string } }).error).toMatchObject({ code: "pc_left", left_at: new Date(now).toISOString() });
    // another PC's proof lifts nothing, and a spent one is refused
    const other = pc();
    expect((await put(service, token, machine, await proofOf(service, other))).status).toBe(401);
    const proof = await proofOf(service, machine);
    expect((await put(service, token, machine, proof)).status).toBe(200);
    expect(await listed(service, token)).toEqual([machine.serverId]);
    expect((await put(service, token, machine, proof)).status).toBe(401);
    // the mark is gone: upkeep needs no proof
    expect((await put(service, token, machine)).status).toBe(200);

    expect((await service.fetch(post(`/v1/pcs/${machine.serverId}/leave`, { server_id: machine.serverId, account: "acct_1", ...await proofOf(service, machine) }))).status).toBe(204);
    now += PC_LEFT_MS;
    expect((await put(service, token, machine)).status).toBe(200);
  });

  test("a leave needs the PC's own fresh proof for its own server_id", async () => {
    const service = new FakeAccountService();
    const token = service.issueToken("acct_1");
    const [machine, other] = [pc(), pc()];
    await put(service, token, machine);
    expect((await service.fetch(post(`/v1/pcs/${machine.serverId}/leave`, { server_id: machine.serverId, account: "acct_1" }))).status).toBe(400);
    expect((await service.fetch(post(`/v1/pcs/${machine.serverId}/leave`, { server_id: other.serverId, account: "acct_1", ...await proofOf(service, other) }))).status).toBe(400);
    expect((await service.fetch(post(`/v1/pcs/${machine.serverId}/leave`, { server_id: machine.serverId, account: "acct_1", ...await proofOf(service, other) }))).status).toBe(401);
    expect(await listed(service, token)).toEqual([machine.serverId]);
  });
});

describe("adding a PC with an old sign-in's key proof, and who asks", () => {
  const DAY = 24 * 60 * 60_000;
  /** the account service with Step 2 on, its clock, and an own sign-in made now with the key it registered */
  async function signedIn() {
    let now = Date.now();
    const service = new FakeAccountService(() => now);
    service.opensAll = true;
    const own = service.issueToken("acct_1");
    const key = await client();
    service.registerSessionKey(own, key.spki, "Phone");
    const send = (method: string, path: string, token: string, body?: unknown) => service.fetch(new Request(BASE + path, {
      method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const answer = async (response: Response) => response.ok ? response.status : `${response.status} ${((await response.json()) as { error?: { code?: string } }).error?.code}`;
    const entry = (machine: ReturnType<typeof pc>, extra: Record<string, unknown> = {}) => ({ label: "desk", public_key: machine.publicKey, relay: "wss://relay.test", ...extra });
    const listing = (machine: ReturnType<typeof pc>) => service.pcs("acct_1").find((row) => row.server_id === machine.serverId)?.listing_id ?? "";
    /** a proof by `signer` for this add, over the PC's current listing unless `over` names another */
    const proof = async (token: string, signer: Awaited<ReturnType<typeof client>>, purpose: PcAddPurpose, machine: ReturnType<typeof pc>, over?: string) => {
      const { challenge_id, challenge, expires_in } = await (await send("POST", "/v1/pcs/challenge", token, {})).json() as { challenge_id: string; challenge: string; expires_in: number };
      expect(expires_in * 1000).toBe(PC_ADD_CHALLENGE_TTL_MS);
      const bytes = pcAddSigningBytes(purpose, "acct_1", machine.serverId, over ?? listing(machine), challenge_id, challenge);
      return { challenge_id, signature: toBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer.pair.privateKey, bytes))) };
    };
    const typedIn = async (machine: ReturnType<typeof pc>, extra: Record<string, unknown> = {}) => expect(await answer(await send("PUT", `/v1/pcs/${machine.serverId}`, service.issueToken("acct_1", { device: true }), entry(machine, extra)))).toBe(200);
    return { service, own, key, send, answer, entry, proof, typedIn, pass: (ms: number) => { now += ms; } };
  }

  test("the challenge is an own sign-in's: a device code's is refused, and it does not exist with Step 2 off or before key proofs", async () => {
    const { service, own, send, answer } = await signedIn();
    expect(await answer(await send("POST", "/v1/pcs/challenge", own, {}))).toBe(200);
    expect(await answer(await send("POST", "/v1/pcs/challenge", service.issueToken("acct_1", { device: true }), {}))).toBe("403 own_sign_in_required");
    service.opensAll = false;
    expect(await answer(await send("POST", "/v1/pcs/challenge", own, {}))).toBe("404 not_found");
    service.opensAll = true;
    service.pcAddProofs = false;
    expect(await answer(await send("POST", "/v1/pcs/challenge", own, {}))).toBe("404 not_found");
  });

  test("an old own sign-in admits only with a proof by its own key for that PC's listing; a replay, a bad shape or another key adds nothing", async () => {
    const { service, own, key, send, answer, proof, typedIn, pass } = await signedIn();
    const machine = pc();
    pass(30 * DAY);
    await typedIn(machine);
    const admit = (body: unknown) => send("POST", `/v1/pcs/${machine.serverId}/admit`, own, body);
    expect(await answer(await admit({}))).toBe("403 session_not_fresh");
    expect(await answer(await admit({ key_proof: { challenge_id: "x", signature: "y" } }))).toBe("400 invalid_request");
    expect(await answer(await admit({ key_proof: await proof(own, await client(), "admit", machine) }))).toBe("403 session_not_fresh");
    expect(await answer(await admit({ key_proof: await proof(own, key, "confirm", machine) }))).toBe("403 session_not_fresh");
    expect(await answer(await admit({ key_proof: await proof(own, key, "admit", machine, "0".repeat(32)) }))).toBe("403 session_not_fresh");
    const good = await proof(own, key, "admit", machine);
    expect(await answer(await admit({ key_proof: good }))).toBe(200);
    expect(await answer(await admit({ key_proof: good }))).toBe("400 challenge_invalid");
    expect(service.pcs("acct_1")[0]?.listed_by_device).toBe(false);
  });

  test("a challenge is good for two minutes, and only for the sign-in that asked for it", async () => {
    const { service, own, key, send, answer, proof, typedIn, pass } = await signedIn();
    const machine = pc();
    pass(30 * DAY);
    await typedIn(machine);
    const late = await proof(own, key, "admit", machine);
    pass(PC_ADD_CHALLENGE_TTL_MS + 1);
    expect(await answer(await send("POST", `/v1/pcs/${machine.serverId}/admit`, own, { key_proof: late }))).toBe("400 challenge_invalid");
    const other = service.issueToken("acct_1");
    expect(await answer(await send("POST", `/v1/pcs/${machine.serverId}/admit`, other, { key_proof: await proof(own, key, "admit", machine) }))).toBe("400 challenge_invalid");
  });

  test("a confirm, and the listing of a PC the account does not list yet, ask the same; upkeep and a device code's listing ask nothing", async () => {
    const { service, own, key, send, answer, entry, proof, typedIn, pass } = await signedIn();
    pass(30 * DAY);
    const [typed, fresh, kept] = [pc(), pc(), pc()];
    await typedIn(typed);
    expect(await answer(await send("PUT", `/v1/pcs/${typed.serverId}`, own, entry(typed, { confirm: true })))).toBe("403 session_not_fresh");
    expect(await answer(await send("PUT", `/v1/pcs/${typed.serverId}`, own, entry(typed, { confirm: true, key_proof: await proof(own, key, "confirm", typed) })))).toBe(200);
    expect(await answer(await send("PUT", `/v1/pcs/${fresh.serverId}`, own, entry(fresh)))).toBe("403 session_not_fresh");
    expect(service.pcs("acct_1").map((row) => row.server_id)).not.toContain(fresh.serverId);
    expect(await answer(await send("PUT", `/v1/pcs/${fresh.serverId}`, own, entry(fresh, { key_proof: await proof(own, key, "list", fresh) })))).toBe(200);
    expect(service.pcs("acct_1").find((row) => row.server_id === fresh.serverId)?.listed_by_device).toBe(false);
    // upkeep of a PC the account lists reads no proof, and a device code lists unconfirmed, whatever their age
    expect(await answer(await send("PUT", `/v1/pcs/${fresh.serverId}`, own, entry(fresh, { label: "renamed" })))).toBe(200);
    const typedOld = service.issueToken("acct_1", { device: true });
    pass(30 * DAY);
    expect(await answer(await send("PUT", `/v1/pcs/${kept.serverId}`, typedOld, entry(kept)))).toBe(200);
    // with the service's list rule off, as it ships at first, a listing that sends no proof goes through; one sent is judged
    service.listProofRequired = false;
    const [quiet, badly] = [pc(), pc()];
    expect(await answer(await send("PUT", `/v1/pcs/${quiet.serverId}`, own, entry(quiet)))).toBe(200);
    expect(await answer(await send("PUT", `/v1/pcs/${badly.serverId}`, own, entry(badly, { key_proof: await proof(own, await client(), "list", badly) })))).toBe("403 session_not_fresh");
    service.listProofRequired = true;
    // before key proofs an old own sign-in listed a new PC without one, and a confirm was judged by its age alone
    service.pcAddProofs = false;
    const [before, typedBefore] = [pc(), pc()];
    expect(await answer(await send("PUT", `/v1/pcs/${before.serverId}`, own, entry(before)))).toBe(200);
    await typedIn(typedBefore);
    expect(await answer(await send("PUT", `/v1/pcs/${typedBefore.serverId}`, own, entry(typedBefore, { confirm: true, key_proof: { challenge_id: "0".repeat(32), signature: "A".repeat(86) } })))).toBe("403 session_not_fresh");
    expect(await answer(await send("POST", `/v1/pcs/${typedBefore.serverId}/admit`, own, { key_proof: { challenge_id: "0".repeat(32), signature: "A".repeat(86) } }))).toBe("400 invalid_request");
  });

  test("a listing that asks to join says who asks and until when, is let in only within its ten minutes, and any own sign-in says No to it", async () => {
    const { service, own, key, send, answer, entry, proof, typedIn, pass } = await signedIn();
    service.requestPlace = { country: "KR", city: "Seoul" };
    const [asking, lapsed, member] = [pc(), pc(), pc()];
    await typedIn(asking, { os: "linux" });
    const row = async (machine: ReturnType<typeof pc>) => ((await (await send("GET", "/v1/pcs?include=unconfirmed", own)).json()) as { pcs: Record<string, unknown>[] }).pcs.find((each) => each.server_id === machine.serverId);
    const { asking_os, asking_country, asking_city, asking_until } = (await row(asking))!;
    expect({ asking_os, asking_country, asking_city }).toEqual({ asking_os: "linux", asking_country: "KR", asking_city: "Seoul" });
    expect(Date.parse(asking_until as string) - Date.now()).toBeGreaterThan(LISTING_ASKS_MS - 60_000);
    await typedIn(lapsed);
    pass(LISTING_ASKS_MS + 1);
    expect(await answer(await send("POST", `/v1/pcs/${lapsed.serverId}/admit`, own, { key_proof: await proof(own, key, "admit", lapsed) }))).toBe("409 listing_expired");
    expect(await answer(await send("PUT", `/v1/pcs/${lapsed.serverId}`, own, entry(lapsed, { confirm: true, key_proof: await proof(own, key, "confirm", lapsed) })))).toBe("409 listing_expired");
    // No needs no new sign-in for a listing that asks; removing a PC that is the account's still does
    expect(await answer(await send("DELETE", `/v1/pcs/${lapsed.serverId}`, own))).toBe(204);
    expect(await answer(await send("PUT", `/v1/pcs/${member.serverId}`, own, entry(member, { key_proof: await proof(own, key, "list", member) })))).toBe(200);
    expect(await answer(await send("DELETE", `/v1/pcs/${member.serverId}`, own))).toBe("403 reauth_required");
    // the service before key proofs says nothing of who asks, and asks a new sign-in for every No
    service.pcAddProofs = false;
    expect(Object.keys((await row(asking))!).filter((name) => name.startsWith("asking_"))).toEqual([]);
    expect(await answer(await send("DELETE", `/v1/pcs/${asking.serverId}`, own))).toBe("403 reauth_required");
  });
});


describe("PC invites (POST /v1/pc-invites, /v1/pc-invites/redeem)", () => {
  async function proofOf(service: FakeAccountService, machine: ReturnType<typeof pc>) {
    const challenge = await (await service.fetch(post("/v1/pc/challenge", { server_id: machine.serverId, public_key: machine.publicKey }))).json() as { challenge_id: string; frame: string };
    return { challenge_id: challenge.challenge_id, proof: answerServerChallenge(challenge.frame, machine.keys.secretKey, { server_id: machine.serverId, role: "account", connection_id: challenge.challenge_id }) };
  }
  const answer = async (response: Response) => {
    const text = await response.text();
    return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown> & { error?: { code: string; message?: string } } };
  };
  const made = async (service: FakeAccountService, token: string, body: unknown) => answer(await service.fetch(post("/v1/pc-invites", body, token)));
  /** An invite as a device makes one: a fresh key pair, the line it shows, and the public key alone sent to the service. */
  const invite = async (service: FakeAccountService, account = "acct_1", auto = false): Promise<string> => {
    const fresh = await newInvite(BASE, account, null);
    const made_ = await made(service, service.issueToken(account), { invite_key: fresh.key, ...auto ? { auto: true } : {} });
    expect(made_.status).toBe(200);
    expect(made_.body.account).toBe(account);
    return fresh.line;
  };
  /** A redeem as the PC holding `line` sends it: its proof, and the line's signature over this account, PC and challenge. */
  const redeem = async (service: FakeAccountService, line: string, machine: ReturnType<typeof pc>, extra: Record<string, unknown> = {}, signed: Partial<Omit<InviteRedeem, "account">> = {}) => {
    const read = await readJoinLine(line, READER);
    const proof = await proofOf(service, machine);
    const invite_signature = await signInviteRedeem(read, { server_id: machine.serverId, public_key: machine.publicKey, challenge_id: proof.challenge_id, ...signed });
    return answer(await service.fetch(post("/v1/pc-invites/redeem", { invite_key: read.key, invite_signature, server_id: machine.serverId, public_key: machine.publicKey, relay: "wss://relay.ovis.sh", label: "Desk", os: "linux", ...proof, ...extra })));
  };
  const admission = async (service: FakeAccountService, machine: ReturnType<typeof pc>, account = "acct_1") =>
    answer(await service.fetch(post("/v1/pc/admission", { server_id: machine.serverId, account, with_listing_id: true, ...await proofOf(service, machine) })));
  const press = async (service: FakeAccountService, machine: ReturnType<typeof pc>) =>
    (await service.fetch(post(`/v1/pcs/${machine.serverId}/admit`, {}, service.issueToken("acct_1")))).status;

  test("an own, fresh sign-in makes one from the invite's public key alone, a key once, at most five open; a device code's or a stale sign-in makes none, and the body is strict", async () => {
    let now = Date.parse("2026-11-24T00:00:00Z");
    const service = new FakeAccountService(() => now);
    const token = service.issueToken("acct_1");
    const key = async () => (await newInvite(BASE, "acct_1", null)).key;
    const first = await newInvite(BASE, "acct_1", null);
    const answered = await made(service, token, { invite_key: first.key });
    expect(answered.status).toBe(200);
    expect(answered.body).toEqual({ id: answered.body.id, account: "acct_1", expires_at: new Date(now + 15 * 60_000).toISOString(), auto: false });
    expect(answered.body.id).toMatch(/^[0-9a-f]{32}$/);
    expect((await made(service, token, { invite_key: first.key })).body.error?.code).toBe("invite_key_used");
    expect((await made(service, service.issueToken("acct_2"), { invite_key: first.key })).body.error?.code).toBe("invite_key_used");
    expect((await made(service, token, { invite_key: await key(), auto: true })).body.auto).toBe(true);
    for (const body of [{}, { invite_key: await key(), auto: "yes" }, { invite_key: await key(), other: 1 }, { invite_key: "A".repeat(122) }, { invite_key: await key(), invite: "x" }, []]) {
      expect((await made(service, token, body)).body.error?.code).toBe("invalid_request");
    }
    expect((await made(service, service.issueToken("acct_1", { device: true }), { invite_key: await key() })).body.error?.code).toBe("own_sign_in_required");
    for (let open = 2; open < 5; open++) expect((await made(service, token, { invite_key: await key() })).status).toBe(200);
    expect(await made(service, token, { invite_key: await key() })).toMatchObject({ status: 409, body: { error: { code: "invites_full" } } });
    now += 11 * 60_000;
    expect(await made(service, token, { invite_key: await key() })).toMatchObject({ status: 403, body: { error: { code: "session_not_fresh" } } });
    service.pcInvites = false;
    expect((await made(service, service.issueToken("acct_1"), { invite_key: await key() })).status).toBe(404);
  });

  test("a plain invite lists the PC once, waiting for Add on its card; the same PC asking again gets the same answer, any other PC the one dead body", async () => {
    let now = Date.parse("2026-11-24T00:00:00Z");
    const service = new FakeAccountService(() => now);
    service.opensAll = true;
    const line = await invite(service);
    const machine = pc();
    const first = await redeem(service, line, machine);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ account: "acct_1", auto: false });
    expect(service.pcs("acct_1")).toMatchObject([{ server_id: machine.serverId, label: "Desk", listed_by_device: true, listing_id: first.body.listing_id }]);
    // a new challenge, so a new signature: the same answer
    expect(await redeem(service, line, machine)).toEqual(first);
    const dead = await redeem(service, line, pc());
    expect(dead).toEqual({ status: 400, body: { error: { code: "invite_invalid", message: "This invite does not work" } } });
    // nobody pressed Add yet; then a device of the account does, and the PC takes the admission
    expect((await admission(service, machine)).body.error?.code).toBe("no_admission");
    expect(await press(service, machine)).toBe(200);
    expect(await admission(service, machine)).toMatchObject({ status: 200, body: { account: "acct_1", listing_id: first.body.listing_id } });
    // after the 15 minutes, not even the same PC gets it again
    now += 15 * 60_000;
    expect(await redeem(service, line, machine)).toEqual(dead);
  });

  test("only the line's own signature over this account, this PC and this challenge redeems; an unknown, expired or revoked invite is the same dead body", async () => {
    let now = Date.parse("2026-11-24T00:00:00Z");
    const service = new FakeAccountService(() => now);
    // a PC of its own for each try: one PC is rate limited after ten in a window
    const line = await invite(service);
    const dead = { status: 400, body: { error: { code: "invite_invalid", message: "This invite does not work" } } };
    // a line the service never saw a key of, and signatures for anything but this redeem
    expect(await redeem(service, (await newInvite(BASE, "acct_1", null)).line, pc())).toEqual(dead);
    for (const signed of [{ server_id: pc().serverId }, { public_key: pc().publicKey }, { challenge_id: "0".repeat(32) }]) {
      expect([signed, await redeem(service, line, pc(), {}, signed)]).toEqual([signed, dead]);
    }
    // a line whose key acct_1 holds but that names another account: its signature is over that account, not the row's
    const elsewhere = await newInvite(BASE, "acct_2", null);
    expect((await made(service, service.issueToken("acct_1"), { invite_key: elsewhere.key })).status).toBe(200);
    expect(await redeem(service, elsewhere.line, pc())).toEqual(dead);
    const other = await readJoinLine((await newInvite(BASE, "acct_1", null)).line, READER);
    expect(await redeem(service, line, pc(), { invite_key: other.key })).toEqual(dead);
    expect(await redeem(service, line, pc(), { invite_signature: "A".repeat(86) })).toEqual(dead);
    // a request that carries a secret is refused as a whole, never read past
    expect((await redeem(service, line, pc(), { invite: line })).body.error?.code).toBe("invalid_request");
    expect((await redeem(service, line, pc(), { proof: "x".repeat(86) })).body.error?.code).toBe("proof_invalid");
    expect((await redeem(service, line, pc(), { public_key: pc().publicKey })).body.error?.code).toBe("server_key_mismatch");
    expect((await redeem(service, line, pc(), { relay: "https://relay.ovis.sh" })).body.error?.code).toBe("invalid_relay");
    expect((await redeem(service, line, pc(), { label: "a\u0007b" })).body.error?.code).toBe("invalid_label");
    expect((await redeem(service, line, pc(), { os: "beos" })).body.error?.code).toBe("invalid_request");
    // none of those spent it
    expect((await redeem(service, line, pc())).status).toBe(200);
    const expired = await invite(service);
    const revoked = await invite(service);
    const owner = service.issueToken("acct_1");
    const id = ((await (await service.fetch(new Request(`${BASE}/v1/pc-invites`, { headers: { authorization: `Bearer ${owner}` } }))).json()) as { invites: { id: string }[] }).invites.at(-1)!.id;
    expect((await service.fetch(new Request(`${BASE}/v1/pc-invites/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${owner}` } }))).status).toBe(204);
    expect(await redeem(service, revoked, pc())).toEqual(dead);
    now += 15 * 60_000;
    expect(await redeem(service, expired, pc())).toEqual(dead);
  });

  test("an auto invite admits the PC at once, until admission_until; an invite and its admission live with the sign-in that made it", async () => {
    let now = Date.parse("2026-11-24T00:00:00Z");
    const service = new FakeAccountService(() => now);
    service.opensAll = true;
    const machine = pc();
    const first = await redeem(service, await invite(service, "acct_1", true), machine);
    expect(first.body).toEqual({ account: "acct_1", listing_id: first.body.listing_id, auto: true, card_until: null, admission_until: "2026-11-24T00:10:00.000Z" });
    expect((await admission(service, machine)).status).toBe(200);
    const signOut = async (token: string) => expect((await service.fetch(post("/v1/signout", {}, token))).status).toBe(204);
    // made, then its maker signs out before a PC used it: it redeems nothing, and no longer shows as open
    const owner = service.issueToken("acct_1");
    const unused = await newInvite(BASE, "acct_1", null);
    expect((await made(service, owner, { invite_key: unused.key, auto: true })).status).toBe(200);
    await signOut(owner);
    expect((await redeem(service, unused.line, pc())).body.error?.code).toBe("invite_invalid");
    // redeemed, then its maker signs out before the PC took the admission: the admission ends with that sign-in, the
    // listing stays confirmed, and a rerun by the same PC answers the same listing with no admission to wait for
    const maker = service.issueToken("acct_1");
    const used = await newInvite(BASE, "acct_1", null);
    expect((await made(service, maker, { invite_key: used.key, auto: true })).status).toBe(200);
    const other = pc();
    const redeemedOnce = await redeem(service, used.line, other);
    expect(redeemedOnce.status).toBe(200);
    await signOut(maker);
    expect((await admission(service, other)).body.error?.code).toBe("no_admission");
    expect(service.pcs("acct_1").find((entry) => entry.server_id === other.serverId)?.listed_by_device).toBe(false);
    expect((await redeem(service, used.line, other)).body).toEqual({ ...redeemedOnce.body, admission_until: null });
  });

  test("past the account's daily one-press cap an auto invite is refused at making, and one made before answers pc_add_cap at its redeem and stays open", async () => {
    let now = Date.parse("2026-11-24T00:00:00Z");
    const service = new FakeAccountService(() => now);
    service.opensAll = true;
    expect((await redeem(service, await invite(service, "acct_1", true), pc())).status).toBe(200);
    const early = await invite(service, "acct_1", true);
    for (let added = 0; added < 2; added++) expect((await redeem(service, await invite(service, "acct_1", true), pc())).status).toBe(200);
    // the day's three adds are used: a new auto invite is refused where it is made, a plain one is not
    const refused = await service.fetch(post("/v1/pc-invites", { invite_key: (await newInvite(BASE, "acct_1", null)).key, auto: true }, service.issueToken("acct_1")));
    expect([refused.status, ((await refused.clone().json()) as { error: { code: string } }).error.code]).toEqual([429, "pc_add_cap"]);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await invite(service)).toStartWith("ovis-join:1:");
    const late = pc();
    const response = await redeem(service, early, late);
    expect(response.body.error?.code).toBe("pc_add_cap");
    expect(service.pcs("acct_1").some((entry) => entry.server_id === late.serverId)).toBe(false);
    // still open: asked again within its 15 minutes, it answers the same; after them it is dead
    expect((await redeem(service, early, late)).body.error?.code).toBe("pc_add_cap");
    now += 24 * 60 * 60_000;
    expect((await redeem(service, early, late)).body.error?.code).toBe("invite_invalid");
    expect((await redeem(service, await invite(service, "acct_1", true), late)).status).toBe(200);
  });

  test("an auto admission not taken within its 10 minutes is gone, and a plain invite's redeem names its card's end", async () => {
    let now = Date.parse("2026-11-24T00:00:00Z");
    const service = new FakeAccountService(() => now);
    service.opensAll = true;
    const slow = pc();
    expect((await redeem(service, await invite(service, "acct_1", true), slow)).status).toBe(200);
    now += 10 * 60_000 + 1;
    expect((await admission(service, slow)).body.error?.code).toBe("no_admission");
    const plain = await redeem(service, await invite(service), pc());
    expect(plain.body).toMatchObject({ auto: false, card_until: new Date(now + 10 * 60_000).toISOString(), admission_until: null });
  });

  test("a plain invite's card offers Add for 10 minutes: then Add and the PC's ask answer listing_expired; the PC's leave ends the listing", async () => {
    let now = Date.parse("2026-11-24T00:00:00Z");
    const service = new FakeAccountService(() => now);
    service.opensAll = true;
    const machine = pc();
    expect((await redeem(service, await invite(service), machine)).status).toBe(200);
    now += 10 * 60_000 + 1;
    expect((await admission(service, machine)).body.error?.code).toBe("listing_expired");
    const admit = await service.fetch(post(`/v1/pcs/${machine.serverId}/admit`, {}, service.issueToken("acct_1")));
    expect([admit.status, ((await admit.json()) as { error: { code: string } }).error.code]).toEqual([409, "listing_expired"]);
    const left = await service.fetch(post(`/v1/pcs/${machine.serverId}/leave`, { server_id: machine.serverId, account: "acct_1", ...await proofOf(service, machine) }));
    expect(left.status).toBe(204);
    expect(service.pcs("acct_1")).toEqual([]);
    // a new invite lists it again, with a new card
    expect((await redeem(service, await invite(service), machine)).status).toBe(200);
    expect((await admission(service, machine)).body.error?.code).toBe("no_admission");
  });

  test("the account's list of PCs can be full; a PC is rate limited after ten tries in a window", async () => {
    const service = new FakeAccountService();
    const token = service.issueToken("acct_1");
    for (let index = 0; index < DIRECTORY_MAX; index++) {
      const other = pc();
      expect((await service.fetch(new Request(`${BASE}/v1/pcs/${other.serverId}`, { method: "PUT", body: JSON.stringify({ label: "pc", public_key: other.publicKey, relay: "wss://relay.ovis.sh" }), headers: { authorization: `Bearer ${token}` } }))).status).toBe(200);
    }
    const line = await invite(service);
    const machine = pc();
    expect((await redeem(service, line, machine)).body.error?.code).toBe("directory_full");
    for (let tries = 1; tries < 10; tries++) await redeem(service, line, machine, { label: "" });
    const limited = await service.fetch(post("/v1/pc-invites/redeem", { invite_key: "x", invite_signature: "y", server_id: machine.serverId, public_key: machine.publicKey, relay: "wss://relay.ovis.sh", label: "Desk", ...await proofOf(service, machine) }));
    expect([limited.status, limited.headers.get("retry-after")]).toEqual([429, "60"]);
  });

  test("GET lists open invites and used ones for a day, with no key or line; DELETE revokes an open one and refuses a used one", async () => {
    let now = Date.parse("2026-11-24T00:00:00Z");
    const service = new FakeAccountService(() => now);
    service.requestPlace = { country: "KR", city: "Seoul" };
    const owner = service.issueToken("acct_1");
    const key = await client();
    service.registerSessionKey(owner, key.spki, "Pixel");
    const usedInvite = await newInvite(BASE, "acct_1", null);
    const used = (await made(service, owner, { invite_key: usedInvite.key, auto: true })).body;
    const open = (await made(service, service.issueToken("acct_1"), { invite_key: (await newInvite(BASE, "acct_1", null)).key })).body;
    const machine = pc();
    expect((await redeem(service, usedInvite.line, machine)).status).toBe(200);
    const list = async (token = owner) => answer(await service.fetch(new Request(`${BASE}/v1/pc-invites`, { headers: { authorization: `Bearer ${token}` } })));
    const listed = await list();
    expect(JSON.stringify(listed.body)).not.toContain(usedInvite.key);
    expect(listed.body.invites).toEqual([
      { id: used.id, made_at: "2026-11-24T00:00:00.000Z", expires_at: "2026-11-24T00:15:00.000Z", auto: true, device_no: 1, device_label: "Pixel", yours: true, used_at: "2026-11-24T00:00:00.000Z",
        used_by: { server_id: machine.serverId, listing_id: service.pcs("acct_1")[0]!.listing_id, label: "Desk", os: "linux", country: "KR", city: "Seoul" } },
      { id: open.id, made_at: "2026-11-24T00:00:00.000Z", expires_at: "2026-11-24T00:15:00.000Z", auto: false, device_no: null, device_label: null, yours: false, used_at: null, used_by: null },
    ]);
    const remove = async (id: unknown, token = owner) => answer(await service.fetch(new Request(`${BASE}/v1/pc-invites/${String(id)}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } })));
    expect((await remove(used.id)).body.error?.code).toBe("invite_used");
    expect((await remove(open.id)).status).toBe(204);
    expect((await remove(open.id, service.issueToken("acct_2"))).status).toBe(404);
    expect((await remove("0".repeat(32))).status).toBe(404);
    expect((await list(service.issueToken("acct_1", { device: true }))).body.error?.code).toBe("own_sign_in_required");
    // the revoked one is gone from the list; the used one stays a day
    expect(((await list()).body.invites as { id: string }[]).map((entry) => entry.id)).toEqual([used.id as string]);
    now += 24 * 60 * 60_000;
    expect((await list(service.issueToken("acct_1"))).body.invites).toEqual([]);
  });
});
