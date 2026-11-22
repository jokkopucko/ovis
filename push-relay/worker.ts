/**
 * The push relay of the Ovis phone app (docs/native-app.md, "Notifications"). The app's web view
 * gets no Web Push, so this Cloudflare Worker looks to the PC's server/push.ts like one more Web
 * Push service and hands each push to Apple's push service (APNs) or, for Android, to Firebase
 * Cloud Messaging (FCM):
 *
 * - POST /v1/register { token, environment?, vapid_key } (an APNs device token) or
 *   { service: "fcm", token, vapid_key } (an FCM registration token): the app hands over its
 *   token and the VAPID public key of the PC it registers for (the PC's GET /api/push), and gets
 *   back an endpoint URL holding a random ID for them. The token never leaves the relay. The key
 *   is pinned to the endpoint from the start, as a browser binds a subscription to its
 *   applicationServerKey, so no one can claim an endpoint by pushing to it first.
 * - POST /v1/push/<id>: a Web Push request (RFC 8030), its body encrypted for keys only the app
 *   holds (RFC 8291, aes128gcm) and signed with the PC's VAPID key (RFC 8292). A push signed by
 *   any other key is refused. Each endpoint, and each phone across its endpoints, is
 *   rate-limited. The ciphertext goes on as it came: to APNs in a mutable-content push that the
 *   iOS app's Notification Service Extension decrypts, to FCM in a data message that the Android
 *   app decrypts. The relay never holds a key that could read it. APNs or FCM saying a token is
 *   gone deletes its endpoints for that service (and APNs environment) and answers 410, which the
 *   PC takes as an unsubscribe.
 *
 * Per endpoint it keeps the token, its service and (for APNs) its environment, the pinned key, when the endpoint was
 * registered and last used, and the current rate window (schema.sql), and nothing else. An
 * endpoint unused for ENDPOINT_TTL_SECONDS is deleted by the daily cron. The sender's address is
 * read only as the key of Cloudflare's rate limiter for registrations, never stored, and nothing
 * is logged. Deploy: push-relay/README.md.
 */

interface D1Statement { bind(...values: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> } }
export interface Env {
  DB: { prepare(query: string): D1Statement };
  /** Cloudflare's Rate Limiting binding (wrangler.toml), keyed by the registering address */
  REGISTER_LIMITER: RateLimiter;
  /** the backstop over all addresses together, asked only for a registration its address may make */
  REGISTER_GLOBAL_LIMITER: RateLimiter;
  /** secret: the APNs auth key (.p8 file contents, PKCS #8 PEM) */
  APNS_KEY: string;
  /** secret: the ID Apple shows for that key */
  APNS_KEY_ID: string;
  /** secret: the Apple developer team the key belongs to */
  APNS_TEAM_ID: string;
  APNS_TOPIC: string;
  /**
   * secret, for Android: the JSON key of a Google service account allowed to send FCM messages
   * for the app's Firebase project. Without it the relay registers no FCM token.
   */
  FCM_SERVICE_ACCOUNT?: string;
}
interface RateLimiter { limit(options: { key: string }): Promise<{ success: boolean }> }
type Environment = "production" | "sandbox";
type Send = (url: string, init: RequestInit) => Promise<Response>;

/** pushes one endpoint may make per window; more answer 429 until the window ends */
export const RATE_LIMIT = 60;
/** pushes one phone (device token) takes per window across all its endpoints */
export const DEVICE_RATE_LIMIT = 120;
export const RATE_WINDOW_SECONDS = 600;
/** endpoints one device token may hold (one per PC); registering one more drops the oldest */
export const ENDPOINTS_PER_TOKEN = 32;
export const ENDPOINT_TTL_SECONDS = 60 * 24 * 60 * 60;
/** what a phone shows when its extension cannot decrypt a push (or does not run) */
export const FALLBACK_BODY = "herdr needs you";
const MAX_REGISTER_BYTES = 1024;
/** RFC 8030 section 7.2: the payload size every push service takes */
const MAX_PUSH_BYTES = 4096;
/**
 * what APNs takes for a push's JSON; base64 makes the ciphertext a third larger. FCM takes 4096
 * bytes of data too, which the same ciphertext always fits once it fits APNs' wrapper.
 */
const MAX_APNS_BYTES = 4096;
/** the longest a push waits at APNs for a phone that is offline */
const MAX_TTL_SECONDS = 28 * 24 * 60 * 60;
/** RFC 8292 section 2: a VAPID token expires within 24 hours */
const VAPID_MAX_SECONDS = 24 * 60 * 60;
/** APNs takes a provider token for an hour and refuses a new one more often than every 20 minutes */
const PROVIDER_TOKEN_SECONDS = 50 * 60;
const APNS_TIMEOUT_MS = 10_000;
const FCM_TIMEOUT_MS = 10_000;
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Google's access tokens last an hour; a new one is fetched a little before */
const ACCESS_TOKEN_SECONDS = 50 * 60;
/** FCM error codes (google.firebase.fcm.v1.FcmError) that mean the token will never take a message again */
const FCM_GONE = new Set(["UNREGISTERED", "SENDER_ID_MISMATCH"]);
const APNS_HOSTS: Record<Environment, string> = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" };
/** APNs reasons (with a 400) that mean the token will never take a push again */
const GONE_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic"]);
/** APNs reasons (with a 403) that mean the provider token must be signed again */
const PROVIDER_TOKEN_REASONS = new Set(["ExpiredProviderToken", "InvalidProviderToken"]);
const ID = /^[A-Za-z0-9_-]{22}$/;
/** an APNs device token as hex; Apple asks not to rely on its length (32 bytes today) */
const TOKEN = /^(?:[0-9a-f]{2}){32,256}$/;
/** an FCM registration token: Google documents no format, only these characters so far (about 160 of them) */
const FCM_TOKEN = /^[A-Za-z0-9_:-]{32,900}$/;
/** RFC 8030 section 5.4 */
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;

const status = (code: number, headers?: Record<string, string>) => new Response(null, { status: code, headers });

function decodeBase64(value: string): Uint8Array<ArrayBuffer> | null {
  const base64 = value.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*$/.test(base64)) return null;
  try {
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const encodeBase64Url = (bytes: Uint8Array) => encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** a P-256 public key as VAPID's `k=` and the Push API's applicationServerKey carry it, in one spelling (base64url, unpadded); null when it is not one */
function publicKey(value: string): string | null {
  const key = decodeBase64(value);
  return key && key.length === 65 && key[0] === 4 ? encodeBase64Url(key) : null;
}

function jsonObject(bytes: Uint8Array | null): Record<string, unknown> | null {
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * The sender's VAPID public key (base64url) when `header` is a valid RFC 8292 `vapid t=..., k=...`
 * for this relay (`audience`, its origin) at `nowSeconds`; null otherwise.
 */
export async function verifyVapid(header: string | null, audience: string, nowSeconds: number): Promise<string | null> {
  const match = header ? /^vapid\s+(.+)$/i.exec(header.trim()) : null;
  if (!match) return null;
  const params = new Map<string, string>();
  for (const part of match[1]!.split(",")) {
    const equals = part.indexOf("=");
    if (equals < 0) return null;
    params.set(part.slice(0, equals).trim().toLowerCase(), part.slice(equals + 1).trim());
  }
  const key = publicKey(params.get("k") ?? "");
  if (!key) return null;
  const parts = (params.get("t") ?? "").split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const jwtHeader = jsonObject(decodeBase64(encodedHeader));
  const claims = jsonObject(decodeBase64(encodedClaims));
  if (jwtHeader?.["alg"] !== "ES256" || claims?.["aud"] !== audience) return null;
  const expires = claims["exp"];
  if (typeof expires !== "number" || expires <= nowSeconds || expires > nowSeconds + VAPID_MAX_SECONDS) return null;
  const signature = decodeBase64(encodedSignature);
  if (!signature || signature.length !== 64) return null;
  try {
    const verifier = await crypto.subtle.importKey("raw", decodeBase64(key)!, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, signature, new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`));
    return valid ? key : null;
  } catch {
    return null;
  }
}

/** the APNs provider token this isolate signed last, reused while APNs takes it */
let providerToken: { teamId: string; keyId: string; key: string; issuedAt: number; token: string } | null = null;

async function apnsToken(env: Env, nowSeconds: number): Promise<string> {
  const cached = providerToken;
  if (cached && cached.teamId === env.APNS_TEAM_ID && cached.keyId === env.APNS_KEY_ID && cached.key === env.APNS_KEY
    && nowSeconds >= cached.issuedAt && nowSeconds - cached.issuedAt < PROVIDER_TOKEN_SECONDS) return cached.token;
  const der = decodeBase64(env.APNS_KEY.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, ""));
  if (!der) throw new Error("APNS_KEY is not a PEM key");
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const part = (value: object) => encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${part({ alg: "ES256", kid: env.APNS_KEY_ID })}.${part({ iss: env.APNS_TEAM_ID, iat: nowSeconds })}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned)));
  const token = `${unsigned}.${encodeBase64Url(signature)}`;
  providerToken = { teamId: env.APNS_TEAM_ID, keyId: env.APNS_KEY_ID, key: env.APNS_KEY, issuedAt: nowSeconds, token };
  return token;
}

/** the body, or null as soon as it passes `limit` bytes (without waiting for the rest) */
async function readBody(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { void reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export type Registration =
  | { service: "apns"; token: string; environment: Environment; vapid_key: string }
  | { service: "fcm"; token: string; vapid_key: string };

export function readRegistration(body: unknown): Registration | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const { service = "apns", token, vapid_key } = value;
  const key = typeof vapid_key === "string" ? publicKey(vapid_key) : null;
  if (!key || typeof token !== "string") return null;
  if (service === "fcm") {
    if (Object.keys(value).some((name) => name !== "service" && name !== "token" && name !== "vapid_key")) return null;
    // FCM tokens are case-sensitive, unlike APNs' hex
    return FCM_TOKEN.test(token) ? { service, token, vapid_key: key } : null;
  }
  if (service !== "apns" || Object.keys(value).some((name) => name !== "service" && name !== "token" && name !== "environment" && name !== "vapid_key")) return null;
  const { environment = "production" } = value;
  if (!TOKEN.test(token.toLowerCase())) return null;
  if (environment !== "production" && environment !== "sandbox") return null;
  return { service, token: token.toLowerCase(), environment, vapid_key: key };
}

async function register(request: Request, env: Env, nowSeconds: number): Promise<Response> {
  if (request.method !== "POST") return status(405, { allow: "POST" });
  // before any write: a registration proves nothing about the token, so made-up tokens must not
  // fill the database. The address is the limiter's key only; it is not stored. The global cap is
  // asked second, so one address over its own limit never uses up the cap every phone shares.
  const perAddress = await env.REGISTER_LIMITER.limit({ key: request.headers.get("cf-connecting-ip") ?? "" });
  if (!perAddress.success) return status(429, { "retry-after": "60" });
  const global = await env.REGISTER_GLOBAL_LIMITER.limit({ key: "all" });
  if (!global.success) return status(429, { "retry-after": "60" });
  if (!request.headers.get("content-type")?.startsWith("application/json")) return status(415);
  const bytes = await readBody(request, MAX_REGISTER_BYTES);
  if (bytes === null) return status(413);
  let registration: Registration | null;
  try { registration = readRegistration(JSON.parse(new TextDecoder().decode(bytes))); } catch { registration = null; }
  if (!registration) return status(400);
  // a relay without FCM credentials could never deliver to this token
  if (registration.service === "fcm" && !env.FCM_SERVICE_ACCOUNT) return status(501);
  const id = encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare("INSERT INTO endpoints (id, token, service, environment, vapid_key, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, registration.token, registration.service, registration.service === "apns" ? registration.environment : null, registration.vapid_key, nowSeconds, nowSeconds).run();
  await env.DB.prepare("DELETE FROM endpoints WHERE token = ? AND id NOT IN (SELECT id FROM endpoints WHERE token = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)")
    .bind(registration.token, registration.token, ENDPOINTS_PER_TOKEN).run();
  return Response.json({ endpoint: `${new URL(request.url).origin}/v1/push/${id}` }, { status: 201, headers: { "cache-control": "no-store" } });
}

async function apnsReason(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const reason = (body as { reason?: unknown } | null)?.reason;
    return typeof reason === "string" ? reason : "";
  } catch {
    return "";
  }
}

async function push(request: Request, env: Env, id: string, nowSeconds: number, send: Send): Promise<Response> {
  if (request.method !== "POST") return status(405, { allow: "POST" });
  const key = await verifyVapid(request.headers.get("authorization"), new URL(request.url).origin, nowSeconds);
  if (!key) return status(401, { "www-authenticate": "vapid" });
  // the extension decrypts RFC 8291's aes128gcm only
  if (request.headers.get("content-encoding")?.toLowerCase() !== "aes128gcm") return status(415);
  const ttlHeader = request.headers.get("ttl");
  if (ttlHeader === null || !/^\d{1,10}$/.test(ttlHeader)) return status(400);
  const ttl = Math.min(Number(ttlHeader), MAX_TTL_SECONDS);
  const topic = request.headers.get("topic");
  if (topic !== null && !TOPIC.test(topic)) return status(400);
  const body = await readBody(request, MAX_PUSH_BYTES);
  if (body === null) return status(413);
  if (body.byteLength === 0) return status(400);
  const ciphertext = encodeBase64(body);
  const payload = JSON.stringify({ aps: { alert: { body: FALLBACK_BODY }, "mutable-content": 1 }, ovis: ciphertext });
  if (new TextEncoder().encode(payload).byteLength > MAX_APNS_BYTES) return status(413);

  const endpoint = await env.DB.prepare("SELECT token, vapid_key FROM endpoints WHERE id = ?").bind(id).first<{ token: string; vapid_key: string }>();
  if (!endpoint) return status(404);
  if (endpoint.vapid_key !== key) return status(403);
  const windowStart = nowSeconds - RATE_WINDOW_SECONDS;
  // the phone's budget across its endpoints, so registering more endpoints buys no more pushes
  const device = await env.DB.prepare("SELECT COALESCE(SUM(window_count), 0) AS pushes, MIN(window_start) AS oldest FROM endpoints WHERE token = ? AND window_start > ?")
    .bind(endpoint.token, windowStart).first<{ pushes: number; oldest: number | null }>();
  if (device && device.pushes >= DEVICE_RATE_LIMIT) {
    return status(429, { "retry-after": String(Math.max(1, (device.oldest ?? nowSeconds) + RATE_WINDOW_SECONDS - nowSeconds)) });
  }
  const allowed = await env.DB.prepare(
    "UPDATE endpoints SET window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END, window_count = CASE WHEN window_start <= ? THEN 1 ELSE window_count + 1 END, used_at = ? WHERE id = ? AND (window_start <= ? OR window_count < ?) RETURNING token, service, environment",
  ).bind(windowStart, nowSeconds, windowStart, nowSeconds, id, windowStart, RATE_LIMIT).first<{ token: string; service: "apns" | "fcm"; environment: Environment | null }>();
  if (!allowed) {
    const window = await env.DB.prepare("SELECT window_start FROM endpoints WHERE id = ?").bind(id).first<{ window_start: number }>();
    return status(429, { "retry-after": String(Math.max(1, (window?.window_start ?? nowSeconds) + RATE_WINDOW_SECONDS - nowSeconds)) });
  }

  if (allowed.service === "fcm") return sendFcm(env, allowed.token, ciphertext, { urgent: request.headers.get("urgency") === "high", ttl, topic }, nowSeconds, send);
  const environment = allowed.environment ?? "production";

  const deliver = async (): Promise<Response> => {
    const headers: Record<string, string> = {
      authorization: `bearer ${await apnsToken(env, nowSeconds)}`,
      "apns-topic": env.APNS_TOPIC,
      "apns-push-type": "alert",
      "apns-priority": request.headers.get("urgency") === "high" ? "10" : "5",
      // 0: deliver now or never, as a TTL of 0 asks
      "apns-expiration": String(ttl === 0 ? 0 : nowSeconds + ttl),
      "content-type": "application/json",
    };
    if (topic !== null) headers["apns-collapse-id"] = topic;
    return send(`${APNS_HOSTS[environment]}/3/device/${allowed.token}`, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(APNS_TIMEOUT_MS) });
  };
  let apns: Response;
  let reason = "";
  try {
    apns = await deliver();
    if (!apns.ok) reason = await apnsReason(apns);
    if (apns.status === 403 && PROVIDER_TOKEN_REASONS.has(reason)) {
      // the cached provider token went stale: sign a new one and try this push once more
      providerToken = null;
      apns = await deliver();
      reason = apns.ok ? "" : await apnsReason(apns);
    }
  } catch {
    return status(502);
  }
  if (apns.ok) return status(201, { ttl: String(ttl) });
  if (apns.status === 410 || (apns.status === 400 && GONE_REASONS.has(reason))) {
    // the token is gone for every PC: all its endpoints in this APNs environment go, and their next
    // push is a 404. Only this environment's: APNs calls a production token sent to the sandbox a
    // BadDeviceToken, so a leaked token registered once as the other one must not wipe the real ones.
    // An FCM row has no environment (schema.sql's CHECK), so it never matches.
    await env.DB.prepare("DELETE FROM endpoints WHERE token = ? AND environment = ?").bind(allowed.token, environment).run();
    return status(410);
  }
  if (apns.status === 429) return status(429);
  return status(502);
}

/** the Google access token this isolate got last, reused while it lasts */
let accessToken: { account: string; issuedAt: number; token: string; projectId: string } | null = null;

/**
 * An OAuth access token for FCM (Google's service-account flow: an RS256 JWT exchanged at its
 * token endpoint), and the Firebase project it sends for.
 */
async function fcmAccessToken(env: Env, nowSeconds: number, send: Send): Promise<{ token: string; projectId: string }> {
  const account = env.FCM_SERVICE_ACCOUNT ?? "";
  const cached = accessToken;
  if (cached && cached.account === account && nowSeconds >= cached.issuedAt && nowSeconds - cached.issuedAt < ACCESS_TOKEN_SECONDS) return cached;
  const key = JSON.parse(account) as { project_id?: unknown; client_email?: unknown; private_key?: unknown };
  if (typeof key.project_id !== "string" || typeof key.client_email !== "string" || typeof key.private_key !== "string") throw new Error("FCM_SERVICE_ACCOUNT is not a service account key");
  const der = decodeBase64(key.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, ""));
  if (!der) throw new Error("FCM_SERVICE_ACCOUNT has no PEM private key");
  const signingKey = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const part = (value: object) => encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: key.client_email, scope: FCM_SCOPE, aud: GOOGLE_TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 })}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(unsigned)));
  const response = await send(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${encodeBase64Url(signature)}` }).toString(),
    signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
  });
  const answer = (response.ok ? await response.json() : null) as { access_token?: unknown } | null;
  if (typeof answer?.access_token !== "string") throw new Error(`Google's token endpoint answered ${response.status}`);
  accessToken = { account, issuedAt: nowSeconds, token: answer.access_token, projectId: key.project_id };
  return accessToken;
}

/**
 * Whether an FCM v1 error answer says the token will never take a message again: an FcmError of
 * FCM_GONE, or INVALID_ARGUMENT about the token itself, as APNs' BadDeviceToken. FCM names a field
 * it refuses in a google.rpc.BadRequest detail, and an invalid token comes with none (or with
 * message.token); INVALID_ARGUMENT naming any other field is the relay's message at fault, and the
 * token stays.
 */
async function fcmTokenGone(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as { error?: { details?: { "@type"?: unknown; errorCode?: unknown; fieldViolations?: { field?: unknown }[] }[] } } | null;
    const details = body?.error?.details ?? [];
    const code = details.find((item) => item["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError")?.errorCode;
    if (typeof code === "string" && FCM_GONE.has(code)) return true;
    if (code !== "INVALID_ARGUMENT") return false;
    return details.filter((item) => item["@type"] === "type.googleapis.com/google.rpc.BadRequest")
      .flatMap((item) => item.fieldViolations ?? []).every((violation) => violation.field === "message.token");
  } catch {
    return false;
  }
}

/**
 * Sends a push to an FCM token as a data message (FCM HTTP v1) whose "ovis" field is the
 * ciphertext, standard base64: no notification part, so Android hands it to the app, which
 * decrypts it and shows it. Urgency high is FCM's high priority (it may wake the phone), else
 * normal. A refused access token is fetched again once, as APNs' provider token is signed again.
 */
async function sendFcm(env: Env, token: string, ciphertext: string, delivery: { urgent: boolean; ttl: number; topic: string | null }, nowSeconds: number, send: Send): Promise<Response> {
  const android: Record<string, string> = { priority: delivery.urgent ? "HIGH" : "NORMAL", ttl: `${delivery.ttl}s` };
  if (delivery.topic !== null) android["collapse_key"] = delivery.topic;
  const deliver = async (): Promise<Response> => {
    const access = await fcmAccessToken(env, nowSeconds, send);
    return send(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(access.projectId)}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json" },
      body: JSON.stringify({ message: { token, data: { ovis: ciphertext }, android } }),
      signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
    });
  };
  let fcm: Response;
  try {
    fcm = await deliver();
    if (fcm.status === 401) {
      accessToken = null;
      fcm = await deliver();
    }
  } catch {
    return status(502);
  }
  if (fcm.ok) return status(201, { ttl: String(delivery.ttl) });
  if (await fcmTokenGone(fcm)) {
    // the token is gone for every PC: all its FCM endpoints go, and their next push is a 404. Only
    // FCM's: the same string registered as an APNs token is not what FCM refused.
    await env.DB.prepare("DELETE FROM endpoints WHERE token = ? AND service = 'fcm'").bind(token).run();
    return status(410);
  }
  if (fcm.status === 401) accessToken = null;
  if (fcm.status === 429) return status(429);
  return status(502);
}

export async function expire(env: Env, now = new Date()): Promise<void> {
  await env.DB.prepare("DELETE FROM endpoints WHERE used_at < ?").bind(Math.floor(now.getTime() / 1000) - ENDPOINT_TTL_SECONDS).run();
}

export async function handle(request: Request, env: Env, now = new Date(), send: Send = fetch): Promise<Response> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const { pathname } = new URL(request.url);
  if (pathname === "/v1/register") return register(request, env, nowSeconds);
  const id = /^\/v1\/push\/([^/]+)$/.exec(pathname)?.[1];
  if (id !== undefined && ID.test(id)) return push(request, env, id, nowSeconds, send);
  return status(404);
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
  scheduled: (_controller: unknown, env: Env) => expire(env),
};
