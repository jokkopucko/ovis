import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";
import { RELAY_MAX_BODY_BYTES } from "../server/push.ts";
import {
  DEVICE_RATE_LIMIT, ENDPOINTS_PER_TOKEN, ENDPOINT_TTL_SECONDS, FALLBACK_BODY, RATE_LIMIT, RATE_WINDOW_SECONDS,
  expire, handle, readRegistration, verifyVapid, type Env,
} from "./worker.ts";

const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");
const RELAY = "https://push.test";
const TOKEN = "a1".repeat(32);
/** a P-256 key pair and auth secret the app keeps; the relay never sees the private half */
const device = { p256dh: webpush.generateVAPIDKeys().publicKey, auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url") };
const pcKey = webpush.generateVAPIDKeys();
const otherPcKey = webpush.generateVAPIDKeys();
const message = JSON.stringify({ pane_id: "w1-1", title: "secret-project - claude", body: "Needs your input", tag: "pane-w1-1" });

const apnsPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pem = async (key: CryptoKey) => `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey("pkcs8", key)).toString("base64").replace(/.{64}/g, "$&\n")}\n-----END PRIVATE KEY-----\n`;
const apnsPem = await pem(apnsPair.privateKey);
const googlePair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const googlePem = await pem(googlePair.privateKey);
/** an FCM registration token: mixed case and a colon, as Firebase hands them out */
const FCM_TOKEN = `dGhpcyBpcyBub3Q6${"Ab_-".repeat(36)}`;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
let accounts = 0;

interface ApnsCall { url: string; headers: Record<string, string>; body: string }

function fakeLimiter(name: string, asked: string[]) {
  const limiter = { allow: true, limit: async ({ key }: { key: string }) => { asked.push(`${name}:${key}`); return { success: limiter.allow }; } };
  return limiter;
}

function relay(keyId = "KEY1234567", options: { fcm?: boolean } = {}) {
  const db = new Database(":memory:");
  db.exec(schema);
  const limiterKeys: string[] = [];
  const perAddress = fakeLimiter("address", limiterKeys);
  const global = fakeLimiter("global", limiterKeys);
  const env: Env = {
    DB: { prepare: (query) => ({ bind: (...values) => ({
      first: async <T>() => (db.query(query).get(...(values as (string | number | null)[])) ?? null) as T | null,
      run: async () => db.query(query).run(...(values as (string | number | null)[])),
    }) }) },
    REGISTER_LIMITER: perAddress,
    REGISTER_GLOBAL_LIMITER: global,
    APNS_KEY: apnsPem, APNS_KEY_ID: keyId, APNS_TEAM_ID: "TEAM123456", APNS_TOPIC: "sh.ovis.app",
    ...(options.fcm === false ? {} : { FCM_SERVICE_ACCOUNT: JSON.stringify({ type: "service_account", project_id: "ovis-test", client_email: `relay-${++accounts}@ovis-test.iam.gserviceaccount.com`, private_key: googlePem }) }),
  };
  const calls: ApnsCall[] = [];
  const tokenCalls: { body: string }[] = [];
  let apnsAnswer = (): Response => new Response(null, { status: 200 });
  let tokenAnswer = (): Response => Response.json({ access_token: `ya29.test-${tokenCalls.length}`, expires_in: 3599, token_type: "Bearer" });
  const send = async (url: string, init: RequestInit) => {
    if (url === GOOGLE_TOKEN_URL) {
      tokenCalls.push({ body: init.body as string });
      return tokenAnswer();
    }
    calls.push({ url, headers: init.headers as Record<string, string>, body: init.body as string });
    return apnsAnswer();
  };
  return {
    db, env, calls, tokenCalls, limiterKeys, perAddress, global,
    answer(next: () => Response) { apnsAnswer = next; },
    answerToken(next: () => Response) { tokenAnswer = next; },
    handle: (request: Request, now = new Date()) => handle(request, env, now, send),
    rows: () => db.query("SELECT * FROM endpoints ORDER BY rowid").all() as Record<string, unknown>[],
  };
}
type Relay = ReturnType<typeof relay>;

const registration = (body: unknown, type = "application/json") =>
  new Request(`${RELAY}/v1/register`, { method: "POST", headers: { "content-type": type, "cf-connecting-ip": "203.0.113.9" }, body: typeof body === "string" ? body : JSON.stringify(body) });

async function register(r: Relay, body: Record<string, unknown> = {}, now = new Date()): Promise<string> {
  const response = await r.handle(registration({ token: TOKEN, vapid_key: pcKey.publicKey, ...body }), now);
  expect(response.status).toBe(201);
  return ((await response.json()) as { endpoint: string }).endpoint;
}
const idOf = (endpoint: string) => endpoint.split("/").at(-1)!;

function pushRequest(endpoint: string, options: { key?: { publicKey: string; privateKey: string }; payload?: string; urgency?: "normal" | "high"; TTL?: number; topic?: string; to?: string } = {}) {
  const key = options.key ?? pcKey;
  const details = webpush.generateRequestDetails({ endpoint, keys: device }, options.payload ?? message, {
    vapidDetails: { subject: "https://github.com/devswha/ovis", publicKey: key.publicKey, privateKey: key.privateKey },
    TTL: options.TTL ?? 43_200, urgency: options.urgency ?? "high", contentEncoding: "aes128gcm",
    ...(options.topic ? { topic: options.topic } : {}),
  });
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(details.headers)) if (name.toLowerCase() !== "content-length") headers[name] = String(value);
  const body = new Uint8Array(details.body);
  return { request: new Request(options.to ?? details.endpoint, { method: "POST", headers, body }), body, headers };
}

function decodeJwt(token: string) {
  const [header, claims, signature] = token.split(".") as [string, string, string];
  const json = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  return { header: json(header), claims: json(claims), signature: Buffer.from(signature, "base64url"), signed: `${header}.${claims}` };
}

describe("push relay: registration", () => {
  test("hands back an endpoint on this relay holding a random ID, pinned to the PC's key, never the token", async () => {
    const r = relay();
    const now = new Date();
    const response = await r.handle(registration({ token: TOKEN.toUpperCase(), vapid_key: pcKey.publicKey }), now);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text.toLowerCase()).not.toContain(TOKEN);
    const { endpoint } = JSON.parse(text) as { endpoint: string };
    expect(endpoint).toMatch(/^https:\/\/push\.test\/v1\/push\/[A-Za-z0-9_-]{22}$/);
    const seconds = Math.floor(now.getTime() / 1000);
    expect(r.rows()).toEqual([{
      id: idOf(endpoint), token: TOKEN, service: "apns", environment: "production", vapid_key: pcKey.publicKey,
      created_at: seconds, used_at: seconds, window_start: 0, window_count: 0,
    }]);
    // the address only keys its limiter: it is not stored
    expect(r.limiterKeys).toEqual(["address:203.0.113.9", "global:all"]);
    expect(JSON.stringify(r.rows())).not.toContain("203.0.113.9");
    // each registration is an endpoint of its own: one per PC, each pinned to its PC's key
    expect(await register(r, { vapid_key: otherPcKey.publicKey })).not.toBe(endpoint);
  });

  test("refuses what is not one registration", async () => {
    const r = relay();
    const valid = { token: TOKEN, vapid_key: pcKey.publicKey };
    const shortKey = Buffer.from(new Uint8Array(32).fill(4)).toString("base64url");
    const compressed = Buffer.from([2, ...new Uint8Array(64).fill(7)]).toString("base64url");
    for (const body of [
      "not json", "[]", {}, { token: TOKEN }, { vapid_key: pcKey.publicKey },
      { ...valid, token: 42 }, { ...valid, token: "a1".repeat(31) }, { ...valid, token: "zz".repeat(32) }, { ...valid, token: `${TOKEN}0` },
      { ...valid, environment: "development" }, { ...valid, email: "person@example.com" },
      { ...valid, vapid_key: shortKey }, { ...valid, vapid_key: compressed }, { ...valid, vapid_key: "not base64!" }, { ...valid, vapid_key: 7 },
    ]) expect((await r.handle(registration(body))).status).toBe(400);
    expect((await r.handle(registration(valid, "text/plain"))).status).toBe(415);
    expect((await r.handle(registration({ ...valid, pad: "x".repeat(1100) }))).status).toBe(413);
    expect((await r.handle(new Request(`${RELAY}/v1/register`))).status).toBe(405);
    expect(r.rows()).toEqual([]);
    // the key is kept in one spelling, so a padded or base64 copy of it pins the same key
    const padded = Buffer.from(pcKey.publicKey, "base64url").toString("base64");
    expect(readRegistration({ token: TOKEN, environment: "sandbox", vapid_key: padded })).toEqual({ service: "apns", token: TOKEN, environment: "sandbox", vapid_key: pcKey.publicKey });
  });

  test("a registration its address's limiter refuses writes nothing, whatever token it names, and leaves the global cap alone", async () => {
    const r = relay();
    r.perAddress.allow = false;
    for (const token of [TOKEN, "b2".repeat(32), "c3".repeat(32)]) {
      const refused = await r.handle(registration({ token, vapid_key: pcKey.publicKey }));
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("60");
    }
    // a refused request is refused before its body is read
    expect((await r.handle(registration("not json"))).status).toBe(429);
    expect(r.rows()).toEqual([]);
    // one address over its limit never counts against the cap every phone shares
    expect(r.limiterKeys).toEqual(Array(4).fill("address:203.0.113.9"));
    r.perAddress.allow = true;
    await register(r);
    expect(r.rows()).toHaveLength(1);
  });

  test("the global cap refuses a registration its address may make, before any write", async () => {
    const r = relay();
    r.global.allow = false;
    const refused = await r.handle(registration({ token: TOKEN, vapid_key: pcKey.publicKey }));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    // refused before its body is read: a malformed body is not a 400
    expect((await r.handle(registration("not json"))).status).toBe(429);
    expect(r.rows()).toEqual([]);
    expect(r.limiterKeys).toEqual(["address:203.0.113.9", "global:all", "address:203.0.113.9", "global:all"]);
    r.global.allow = true;
    await register(r);
    expect(r.rows()).toHaveLength(1);
  });

  test(`keeps the ${ENDPOINTS_PER_TOKEN} most recently registered endpoints of one token`, async () => {
    const r = relay();
    const start = Date.now();
    const endpoints: string[] = [];
    for (let i = 0; i < ENDPOINTS_PER_TOKEN - 1; i++) endpoints.push(await register(r, {}, new Date(start + i * 1000)));
    r.db.query("INSERT INTO endpoints (id, token, environment, vapid_key, created_at, used_at) VALUES (?, ?, 'production', ?, ?, ?)")
      .run("old_endpoint_000000000", TOKEN, pcKey.publicKey, Math.floor(start / 1000) - 3600, Math.floor(start / 1000));
    const newest = await register(r, {}, new Date(start + 60_000));
    await register(r, { token: "b2".repeat(32) });
    const ids = new Set(r.rows().map((row) => row["id"]));
    expect(ids.size).toBe(ENDPOINTS_PER_TOKEN + 1);
    expect(ids.has("old_endpoint_000000000")).toBe(false);
    expect(ids.has(idOf(endpoints[0]!))).toBe(true);
    expect(ids.has(idOf(newest))).toBe(true);
  });

  test(`deletes endpoints unused for ${ENDPOINT_TTL_SECONDS / 86_400} days, and only those`, async () => {
    const r = relay();
    const start = Date.now() - 30 * 86_400_000;
    const pushed = await register(r, {}, new Date(start));
    const idle = await register(r, {}, new Date(start));
    expect((await r.handle(pushRequest(pushed).request)).status).toBe(201);
    await expire(r.env, new Date(start + ENDPOINT_TTL_SECONDS * 1000 - 1000));
    expect(r.rows()).toHaveLength(2);
    await expire(r.env, new Date(start + ENDPOINT_TTL_SECONDS * 1000 + 1000));
    expect(r.rows().map((row) => row["id"])).toEqual([idOf(pushed)]);
    expect((await r.handle(pushRequest(idle).request)).status).toBe(404);
  });
});

describe("push relay: pushes", () => {
  let r: Relay;
  beforeEach(() => { r = relay(); });

  test("forwards the ciphertext untouched to APNs in a mutable-content push it cannot read", async () => {
    const now = new Date();
    const own = relay("KEYFORWARD1");
    const endpoint = await register(own, {}, new Date(now.getTime() - 3_600_000));
    const { request, body } = pushRequest(endpoint, { topic: "pane-w1-1" });
    const response = await own.handle(request, now);
    expect(response.status).toBe(201);
    expect(response.headers.get("ttl")).toBe("43200");
    expect(own.calls).toHaveLength(1);
    const call = own.calls[0]!;
    expect(call.url).toBe(`https://api.push.apple.com/3/device/${TOKEN}`);
    const nowSeconds = Math.floor(now.getTime() / 1000);
    expect(call.headers).toMatchObject({
      "apns-topic": "sh.ovis.app", "apns-push-type": "alert", "apns-priority": "10",
      "apns-expiration": String(nowSeconds + 43_200), "apns-collapse-id": "pane-w1-1",
    });
    const payload = JSON.parse(call.body) as { aps: unknown; ovis: string };
    expect(payload.aps).toEqual({ alert: { body: FALLBACK_BODY }, "mutable-content": 1 });
    expect(new Uint8Array(Buffer.from(payload.ovis, "base64"))).toEqual(body);
    expect(call.body).not.toMatch(/secret-project|Needs your input|w1-1"/);
    // the provider token is Apple's ES256 JWT, signed with the APNs key
    const jwt = decodeJwt(call.headers["authorization"]!.replace(/^bearer /, ""));
    expect(jwt.header).toEqual({ alg: "ES256", kid: "KEYFORWARD1" });
    expect(jwt.claims).toEqual({ iss: "TEAM123456", iat: nowSeconds });
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, apnsPair.publicKey, jwt.signature, new TextEncoder().encode(jwt.signed))).toBe(true);
    expect(own.rows()[0]!["used_at"]).toBe(nowSeconds);
  });

  test("maps urgency to APNs priority, a sandbox token to Apple's sandbox, and TTL 0 to deliver-now-or-never", async () => {
    const endpoint = await register(r, { environment: "sandbox" });
    expect((await r.handle(pushRequest(endpoint, { urgency: "normal", TTL: 0 }).request)).status).toBe(201);
    expect(r.calls[0]!.url).toBe(`https://api.sandbox.push.apple.com/3/device/${TOKEN}`);
    expect(r.calls[0]!.headers).toMatchObject({ "apns-priority": "5", "apns-expiration": "0" });
    expect(r.calls[0]!.headers["apns-collapse-id"]).toBeUndefined();
  });

  test("reuses the APNs provider token for 50 minutes, then signs a new one", async () => {
    const own = relay("KEYREUSE01");
    const endpoint = await register(own);
    const start = new Date();
    for (const at of [start, new Date(start.getTime() + 49 * 60_000), new Date(start.getTime() + 51 * 60_000)]) {
      expect((await own.handle(pushRequest(endpoint).request, at)).status).toBe(201);
    }
    const tokens = own.calls.map((call) => call.headers["authorization"]);
    expect(tokens[1]).toBe(tokens[0]);
    expect(tokens[2]).not.toBe(tokens[0]);
  });

  test("a provider token APNs calls expired is signed again and the push sent once more", async () => {
    const own = relay("KEYRETRY01");
    const endpoint = await register(own);
    expect((await own.handle(pushRequest(endpoint).request)).status).toBe(201);
    let answers = [Response.json({ reason: "ExpiredProviderToken" }, { status: 403 }), new Response(null, { status: 200 })];
    own.answer(() => answers.shift()!);
    expect((await own.handle(pushRequest(endpoint).request)).status).toBe(201);
    const [first, stale, fresh] = own.calls.map((call) => call.headers["authorization"]);
    expect(stale).toBe(first);
    expect(fresh).not.toBe(stale);
    own.answer(() => new Response(null, { status: 200 }));
    expect((await own.handle(pushRequest(endpoint).request)).status).toBe(201);
    expect(own.calls.at(-1)!.headers["authorization"]).toBe(fresh);
    // once more only: a key APNs keeps refusing is a relay failure, and the endpoint stays
    answers = [];
    own.answer(() => Response.json({ reason: "InvalidProviderToken" }, { status: 403 }));
    const before = own.calls.length;
    expect((await own.handle(pushRequest(endpoint).request)).status).toBe(502);
    expect(own.calls.length - before).toBe(2);
    expect(own.rows()).toHaveLength(1);
  });

  test("refuses every key but the one pinned at registration, the first push included", async () => {
    const endpoint = await register(r);
    expect((await r.handle(pushRequest(endpoint, { key: otherPcKey }).request)).status).toBe(403);
    expect(r.calls).toEqual([]);
    expect(r.rows()[0]!["vapid_key"]).toBe(pcKey.publicKey);
    expect((await r.handle(pushRequest(endpoint).request)).status).toBe(201);
    expect((await r.handle(pushRequest(endpoint, { key: otherPcKey }).request)).status).toBe(403);
    expect(r.calls).toHaveLength(1);
  });

  test("refuses a push without a valid VAPID token for this relay", async () => {
    const endpoint = await register(r);
    const bare = pushRequest(endpoint);
    const send = (headers: Record<string, string>) => r.handle(new Request(endpoint, { method: "POST", headers, body: bare.body }));
    const { Authorization: authorization, ...unsigned } = bare.headers as Record<string, string>;
    expect((await send(unsigned)).status).toBe(401);
    expect((await send({ ...unsigned, Authorization: authorization!.replace(/^vapid/, "WebPush") })).status).toBe(401);
    // a signature that does not match the token
    const tampered = authorization!.replace(/t=([^,]+)/, (_, jwt: string) => `t=${jwt.slice(0, -4)}${jwt.endsWith("AAAA") ? "BBBB" : "AAAA"}`);
    expect((await send({ ...unsigned, Authorization: tampered })).status).toBe(401);
    // signed by another key than the one it names
    const otherK = authorization!.replace(/k=.+$/, `k=${otherPcKey.publicKey}`);
    expect((await send({ ...unsigned, Authorization: otherK })).status).toBe(401);
    // signed for another push service's audience
    expect((await r.handle(pushRequest(`https://elsewhere.test/v1/push/${idOf(endpoint)}`, { to: endpoint }).request)).status).toBe(401);
    expect(r.calls).toEqual([]);

    const header = pushRequest(endpoint).headers["Authorization"]!;
    const { claims } = decodeJwt(/t=([^,]+)/.exec(header)![1]!);
    const exp = claims["exp"] as number;
    expect(await verifyVapid(header, RELAY, exp - 60)).toBe(pcKey.publicKey);
    // expired, or valid for longer than RFC 8292's 24 hours
    expect(await verifyVapid(header, RELAY, exp)).toBeNull();
    expect(await verifyVapid(header, RELAY, exp - 24 * 3600 - 1)).toBeNull();
  });

  test(`rate-limits an endpoint to ${RATE_LIMIT} pushes per window, without counting refused senders`, async () => {
    const endpoint = await register(r);
    const start = new Date();
    for (let i = 0; i < RATE_LIMIT; i++) expect((await r.handle(pushRequest(endpoint).request, start)).status).toBe(201);
    const limited = await r.handle(pushRequest(endpoint).request, new Date(start.getTime() + 100_000));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe(String(RATE_WINDOW_SECONDS - 100));
    expect((await r.handle(pushRequest(endpoint, { key: otherPcKey }).request, start)).status).toBe(403);
    expect(r.calls).toHaveLength(RATE_LIMIT);
    expect((await r.handle(pushRequest(endpoint).request, new Date(start.getTime() + RATE_WINDOW_SECONDS * 1000))).status).toBe(201);
    expect(r.rows()[0]!["window_count"]).toBe(1);
  });

  test(`rate-limits a phone to ${DEVICE_RATE_LIMIT} pushes per window across its endpoints`, async () => {
    const start = new Date();
    const endpoints = [await register(r, {}, start), await register(r, {}, start), await register(r, {}, start)];
    const other = await register(r, { token: "b2".repeat(32) }, start);
    for (const endpoint of endpoints.slice(0, 2)) {
      for (let i = 0; i < DEVICE_RATE_LIMIT / 2; i++) expect((await r.handle(pushRequest(endpoint).request, start)).status).toBe(201);
    }
    // a fresh endpoint of the same phone buys no more pushes
    const limited = await r.handle(pushRequest(endpoints[2]!).request, new Date(start.getTime() + 60_000));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe(String(RATE_WINDOW_SECONDS - 60));
    expect(r.rows().find((row) => row["id"] === idOf(endpoints[2]!))!["window_count"]).toBe(0);
    expect((await r.handle(pushRequest(other).request, start)).status).toBe(201);
    expect((await r.handle(pushRequest(endpoints[2]!).request, new Date(start.getTime() + RATE_WINDOW_SECONDS * 1000))).status).toBe(201);
  });

  test("a token APNs calls gone deletes its endpoints in that environment and answers 410, which the PC takes as an unsubscribe", async () => {
    for (const [status, reason] of [[410, "Unregistered"], [410, "ExpiredToken"], [400, "BadDeviceToken"], [400, "DeviceTokenNotForTopic"]] as const) {
      const own = relay();
      const endpoint = await register(own);
      const sibling = await register(own, { vapid_key: otherPcKey.publicKey });
      // the same token in the other APNs environment, and as an FCM token: not what APNs called gone
      const sandbox = await register(own, { environment: "sandbox" });
      const asFcm = await register(own, { service: "fcm" });
      const other = await register(own, { token: "b2".repeat(32) });
      own.answer(() => Response.json({ reason }, { status }));
      expect((await own.handle(pushRequest(endpoint).request)).status).toBe(410);
      expect(own.rows().map((row) => row["id"])).toEqual([idOf(sandbox), idOf(asFcm), idOf(other)]);
      expect((await own.handle(pushRequest(endpoint).request)).status).toBe(404);
      expect((await own.handle(pushRequest(sibling, { key: otherPcKey }).request)).status).toBe(404);
      expect(own.calls).toHaveLength(1);
    }
  });

  test("a leaked token registered in the other environment cannot wipe the phone's real endpoints", async () => {
    // the phone's production endpoint, then someone with its token registers it as sandbox with their own key
    const real = await register(r);
    const planted = await register(r, { environment: "sandbox", vapid_key: otherPcKey.publicKey });
    r.answer(() => Response.json({ reason: "BadDeviceToken" }, { status: 400 }));
    expect((await r.handle(pushRequest(planted, { key: otherPcKey }).request)).status).toBe(410);
    expect(r.rows().map((row) => row["id"])).toEqual([idOf(real)]);
    r.answer(() => new Response(null, { status: 200 }));
    expect((await r.handle(pushRequest(real).request)).status).toBe(201);
    expect(r.calls.at(-1)!.url).toBe(`https://api.push.apple.com/3/device/${TOKEN}`);
  });

  test("any other APNs failure keeps the endpoint", async () => {
    const endpoint = await register(r);
    for (const [answer, expected] of [
      [() => Response.json({ reason: "TooManyRequests" }, { status: 429 }), 429],
      [() => Response.json({ reason: "BadCollapseId" }, { status: 400 }), 502],
      [() => Response.json({ reason: "InternalServerError" }, { status: 500 }), 502],
      [() => new Response("not json", { status: 503 }), 502],
      [() => { throw new Error("network down"); }, 502],
    ] as const) {
      r.answer(answer);
      expect((await r.handle(pushRequest(endpoint).request)).status).toBe(expected);
    }
    expect(r.rows()).toHaveLength(1);
  });

  test("refuses what is not one push before it reaches APNs or counts against the limit", async () => {
    const endpoint = await register(r);
    const { request, headers, body } = pushRequest(endpoint);
    const resend = (changed: Record<string, string | null>, content: BodyInit = body) => {
      const next: Record<string, string> = {};
      for (const [name, value] of Object.entries({ ...headers, ...changed })) if (value !== null) next[name] = value;
      return r.handle(new Request(endpoint, { method: "POST", headers: next, body: content }));
    };
    expect((await resend({ "Content-Encoding": "aesgcm" })).status).toBe(415);
    expect((await resend({ TTL: null })).status).toBe(400);
    expect((await resend({ TTL: "soon" })).status).toBe(400);
    expect((await resend({ Topic: "not a topic!" })).status).toBe(400);
    expect((await resend({}, new Uint8Array(0))).status).toBe(400);
    expect((await resend({}, new Uint8Array(4097))).status).toBe(413);
    // fits a push service, but not APNs once encoded
    expect((await r.handle(pushRequest(endpoint, { payload: "x".repeat(3200) }).request)).status).toBe(413);
    expect((await r.handle(new Request(endpoint))).status).toBe(405);
    expect(r.calls).toEqual([]);
    expect(r.rows()[0]!["window_count"]).toBe(0);
    expect((await r.handle(request)).status).toBe(201);
  });

  test("passes on a body of the size a PC counts on (server/push.ts RELAY_MAX_BODY_BYTES), and refuses one byte more", async () => {
    const endpoint = await register(r);
    const { headers } = pushRequest(endpoint);
    const send = (size: number) => r.handle(new Request(endpoint, { method: "POST", headers, body: new Uint8Array(size) }));
    expect((await send(RELAY_MAX_BODY_BYTES + 1)).status).toBe(413);
    expect(r.calls).toEqual([]);
    expect((await send(RELAY_MAX_BODY_BYTES)).status).toBe(201);
    expect(r.calls).toHaveLength(1);
  });

  test("an unknown endpoint is 404, like any other path", async () => {
    expect((await r.handle(pushRequest(`${RELAY}/v1/push/${"A".repeat(22)}`).request)).status).toBe(404);
    for (const path of ["/", "/v1/push/short", "/v1/push/", `/v1/push/${"A".repeat(22)}/x`]) {
      expect((await r.handle(new Request(`${RELAY}${path}`, { method: "POST" }))).status).toBe(404);
    }
    expect(r.calls).toEqual([]);
  });

  test("refuses an oversized push before it ends", async () => {
    const endpoint = await register(r);
    const { headers } = pushRequest(endpoint);
    // More than 4 KB arrive and the stream never closes: do not wait for the rest.
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(4097)); } });
    const request = new Request(endpoint, { method: "POST", headers, body, duplex: "half" } as RequestInit);
    expect((await r.handle(request)).status).toBe(413);
    expect(r.calls).toEqual([]);
  });
});

describe("push relay: Android (FCM)", () => {
  const fcm = { service: "fcm", token: FCM_TOKEN };
  /** an FCM v1 error answer: its FcmError code (if any), and the fields a google.rpc.BadRequest detail names */
  const fcmError = (status: number, errorCode: string | null, fields: readonly string[] = []) => () => Response.json({ error: { code: status, details: [
    ...(errorCode ? [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode }] : []),
    ...(fields.length ? [{ "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations: fields.map((field) => ({ field, description: `Invalid value at '${field}'` })) }] : []),
  ] } }, { status });

  test("registers an FCM token as it is, case and all, pinned to the PC's key, and keeps it out of the answer", async () => {
    const r = relay();
    const response = await r.handle(registration({ ...fcm, vapid_key: pcKey.publicKey }));
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain(FCM_TOKEN);
    const { endpoint } = JSON.parse(text) as { endpoint: string };
    expect(r.rows()).toMatchObject([{ id: idOf(endpoint), token: FCM_TOKEN, service: "fcm", environment: null, vapid_key: pcKey.publicKey }]);
    expect(readRegistration({ service: "apns", token: TOKEN, vapid_key: pcKey.publicKey })).toEqual({ service: "apns", token: TOKEN, environment: "production", vapid_key: pcKey.publicKey });
  });

  test("refuses what is not an FCM registration, and every FCM token without FCM credentials", async () => {
    const r = relay();
    for (const body of [
      { service: "fcm", vapid_key: pcKey.publicKey }, { ...fcm }, { ...fcm, token: 42, vapid_key: pcKey.publicKey },
      { ...fcm, token: "short", vapid_key: pcKey.publicKey }, { ...fcm, token: `${FCM_TOKEN}!`, vapid_key: pcKey.publicKey },
      { ...fcm, vapid_key: pcKey.publicKey, environment: "production" }, { service: "gcm", token: FCM_TOKEN, vapid_key: pcKey.publicKey },
      { token: FCM_TOKEN, vapid_key: pcKey.publicKey },
    ]) expect((await r.handle(registration(body))).status).toBe(400);
    const without = relay("KEY1234567", { fcm: false });
    expect((await without.handle(registration({ ...fcm, vapid_key: pcKey.publicKey }))).status).toBe(501);
    expect([...r.rows(), ...without.rows()]).toEqual([]);
  });

  test("sends the ciphertext untouched as an FCM data message, signed in with the service account", async () => {
    const r = relay();
    const endpoint = await register(r, fcm);
    const now = new Date();
    const { request, body } = pushRequest(endpoint, { topic: "pane-w1-1" });
    const response = await r.handle(request, now);
    expect(response.status).toBe(201);
    expect(response.headers.get("ttl")).toBe("43200");

    // Google's service-account flow: an RS256 JWT for the FCM scope, exchanged for an access token
    expect(r.tokenCalls).toHaveLength(1);
    const form = new URLSearchParams(r.tokenCalls[0]!.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const jwt = decodeJwt(form.get("assertion")!);
    const nowSeconds = Math.floor(now.getTime() / 1000);
    expect(jwt.header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(jwt.claims).toMatchObject({ scope: "https://www.googleapis.com/auth/firebase.messaging", aud: GOOGLE_TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 });
    expect(jwt.claims["iss"]).toMatch(/@ovis-test\.iam\.gserviceaccount\.com$/);
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", googlePair.publicKey, jwt.signature, new TextEncoder().encode(jwt.signed))).toBe(true);

    expect(r.calls).toHaveLength(1);
    const call = r.calls[0]!;
    expect(call.url).toBe("https://fcm.googleapis.com/v1/projects/ovis-test/messages:send");
    expect(call.headers["authorization"]).toBe("Bearer ya29.test-1");
    const sent = JSON.parse(call.body) as { message: { token: string; data: Record<string, string>; android: Record<string, string>; notification?: unknown } };
    expect(sent.message.token).toBe(FCM_TOKEN);
    expect(Object.keys(sent.message.data)).toEqual(["ovis"]);
    expect(new Uint8Array(Buffer.from(sent.message.data["ovis"]!, "base64"))).toEqual(body);
    expect(sent.message.android).toEqual({ priority: "HIGH", ttl: "43200s", collapse_key: "pane-w1-1" });
    // a data message only: a notification part would be shown by Android without the app decrypting it
    expect(sent.message.notification).toBeUndefined();
    // the Topic header is the push service's to read anyway; nothing of the message itself is
    expect(call.body).not.toMatch(/secret-project|Needs your input|pane_id/);
  });

  test("refuses a push signed by another key than the one pinned at registration, before FCM", async () => {
    const r = relay();
    const endpoint = await register(r, fcm);
    expect((await r.handle(pushRequest(endpoint, { key: otherPcKey }).request)).status).toBe(403);
    expect(r.calls).toEqual([]);
    expect(r.tokenCalls).toEqual([]);
  });

  test("maps urgency to FCM priority and TTL 0 to deliver-now-or-never, and reuses the access token", async () => {
    const r = relay();
    const endpoint = await register(r, fcm);
    const start = new Date();
    expect((await r.handle(pushRequest(endpoint, { urgency: "normal", TTL: 0 }).request, start)).status).toBe(201);
    expect(JSON.parse(r.calls[0]!.body).message.android).toEqual({ priority: "NORMAL", ttl: "0s" });
    expect((await r.handle(pushRequest(endpoint).request, new Date(start.getTime() + 49 * 60_000))).status).toBe(201);
    expect(r.tokenCalls).toHaveLength(1);
    expect((await r.handle(pushRequest(endpoint).request, new Date(start.getTime() + 51 * 60_000))).status).toBe(201);
    expect(r.tokenCalls).toHaveLength(2);
    expect(r.calls[2]!.headers["authorization"]).toBe("Bearer ya29.test-2");
  });

  test("holds an FCM endpoint, and a phone across its FCM endpoints, to the same limits, before FCM", async () => {
    const r = relay();
    const start = new Date();
    const endpoints = [await register(r, fcm, start), await register(r, fcm, start), await register(r, fcm, start)];
    for (let i = 0; i < RATE_LIMIT; i++) expect((await r.handle(pushRequest(endpoints[0]!).request, start)).status).toBe(201);
    const limited = await r.handle(pushRequest(endpoints[0]!).request, new Date(start.getTime() + 100_000));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe(String(RATE_WINDOW_SECONDS - 100));
    for (let i = 0; i < DEVICE_RATE_LIMIT - RATE_LIMIT; i++) expect((await r.handle(pushRequest(endpoints[1]!).request, start)).status).toBe(201);
    // a fresh endpoint of the same phone buys no more pushes
    const phoneLimited = await r.handle(pushRequest(endpoints[2]!).request, new Date(start.getTime() + 60_000));
    expect(phoneLimited.status).toBe(429);
    expect(phoneLimited.headers.get("retry-after")).toBe(String(RATE_WINDOW_SECONDS - 60));
    expect(r.rows().find((row) => row["id"] === idOf(endpoints[2]!))!["window_count"]).toBe(0);
    expect(r.calls).toHaveLength(DEVICE_RATE_LIMIT);
    expect((await r.handle(pushRequest(endpoints[2]!).request, new Date(start.getTime() + RATE_WINDOW_SECONDS * 1000))).status).toBe(201);
  });

  test("a token FCM calls gone or invalid deletes its FCM endpoints and answers 410, leaving any APNs ones", async () => {
    for (const [status, errorCode, fields] of [
      [404, "UNREGISTERED", []], [403, "SENDER_ID_MISMATCH", []],
      // a token that is not one (Google's own example names no field), as APNs' BadDeviceToken
      [400, "INVALID_ARGUMENT", []], [400, "INVALID_ARGUMENT", ["message.token"]],
    ] as const) {
      const r = relay();
      // FCM endpoints with the token an APNs endpoint has too: only the FCM ones are gone
      const endpoint = await register(r, { ...fcm, token: TOKEN });
      const second = await register(r, { ...fcm, token: TOKEN, vapid_key: otherPcKey.publicKey });
      await register(r);
      r.answer(fcmError(status, errorCode, fields));
      expect((await r.handle(pushRequest(endpoint).request)).status).toBe(410);
      expect(r.rows().map((row) => row["service"])).toEqual(["apns"]);
      expect((await r.handle(pushRequest(endpoint).request)).status).toBe(404);
      expect((await r.handle(pushRequest(second, { key: otherPcKey }).request)).status).toBe(404);
    }
  });

  test("a refused access token is fetched again once; other FCM or sign-in failures keep the endpoint", async () => {
    const r = relay();
    const endpoint = await register(r, fcm);
    let first = true;
    r.answer(() => {
      // what FCM answers an expired or revoked access token
      if (first) { first = false; return Response.json({ error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }, { status: 401 }); }
      return new Response("{}", { status: 200 });
    });
    expect((await r.handle(pushRequest(endpoint).request)).status).toBe(201);
    expect(r.tokenCalls).toHaveLength(2);
    expect(r.calls.map((call) => call.headers["authorization"])).toEqual(["Bearer ya29.test-1", "Bearer ya29.test-2"]);

    for (const [answer, expected] of [
      [fcmError(429, "QUOTA_EXCEEDED"), 429],
      // a field of the relay's message refused, not the token: the token stays
      [fcmError(400, "INVALID_ARGUMENT", ["message.android.ttl"]), 502],
      [fcmError(400, "INVALID_ARGUMENT", ["message.token", "message.android.collapse_key"]), 502],
      [fcmError(400, null, ["message.data[0].value"]), 502],
      [fcmError(503, "UNAVAILABLE"), 502],
      [() => new Response("not json", { status: 500 }), 502],
      [() => { throw new Error("network down"); }, 502],
    ] as const) {
      r.answer(answer);
      expect((await r.handle(pushRequest(endpoint).request)).status).toBe(expected);
    }

    const refused = relay();
    const other = await register(refused, fcm);
    refused.answerToken(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    expect((await refused.handle(pushRequest(other).request)).status).toBe(502);
    expect(refused.calls).toEqual([]);
    expect([...r.rows(), ...refused.rows()]).toHaveLength(2);
  });
});
