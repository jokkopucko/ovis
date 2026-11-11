import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { bytesToHex } from "@noble/hashes/utils.js";
import { exportAccountKey, newRecordId, signAccountRecord, type AccountRecord } from "./account-records.ts";
import { ACCESS_TOKEN_TTL_S, ADMISSION_TTL_MS, ACCOUNT_RING, ADMISSIONS_PER_WINDOW, DEVICE_POLL_S, DIRECTORY_MAX, FakeAccountService, isAllowedRedirect, MAILBOX_TTL_MS, WEB_REDIRECT, type FakePc } from "./account-service-fake.ts";
import { answerServerChallenge, deriveServerId, serverChallenge, verifyServerProof, type ProofRoute } from "./relay-server-proof.ts";

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
