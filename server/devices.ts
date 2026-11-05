/**
 * Paired devices: the per-device credential a phone (or anyone the owner lets in) uses
 * instead of the shared token. The owner starts a pairing on the PC and gets a short code
 * that lives ten minutes; the device sends the code once and receives a token of its own
 * in an HttpOnly cookie. Only a hash of that token is stored, so devices.json in the state
 * dir (0600, written whole, and flushed before it replaces the old list whenever access
 * changes: private-state.ts) reveals nothing if read. Revocation also closes that device's
 * active streams; revoking all is one write of an empty, gated registry, after which every
 * credential (paired, pending or unconfirmed) is void. A device is either allowed to drive
 * (type, answer, manage) or only to watch. A durable enrollment is announced (`onPaired`) once
 * its write succeeded, so every other session can hear of a device it did not pair.
 */
import { createHash, createPublicKey, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type DevicePairedEvent, type DevicePairToken, type DeviceRole, type DevicesRevokedAll, type PairedDevice, STREAM_COOKIE_PREFIX } from "../shared/protocol.ts";
import type { Access } from "./access.ts";
import { CLEAR_LEGACY_DEVICE_COOKIE, COOKIE_MAX_AGE_SECONDS, DEVICE_COOKIE_CLEARED, deviceCookie, isSecureRequest, noContent, parseCookies } from "./auth.ts";
import { badRequest, isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import { sameOrigin } from "./machine-security.ts";
import { writePrivateState } from "./private-state.ts";

const CODE_TTL_MS = 10 * 60_000;
const CODE_ATTEMPTS = 5;
const LAST_SEEN_WRITE_MS = 60_000;
const UNCONFIRMED_FIRST_PAIR_LIMIT = 8;
const LABEL_MAX = 48;
const PAIRING_WINDOW_MS = 10 * 60_000;

export class PairingRateLimitedError extends Error {
  readonly code = "pairing_rate_limited";
  constructor(readonly retryAfter: number) {
    super("Too many pairing attempts; try again later");
  }
}

/** Canonical base64url SPKI containing a public P-256 key, never private key material. */
function isRelayPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) return false;
  try {
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1"
      && key.export({ format: "der", type: "spki" }).equals(bytes);
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

export interface StoredDevice {
  id: string;
  label: string;
  role: DeviceRole;
  token_hash: string;
  relay_public_key?: string;
  created_at: string;
  last_seen_at: string | null;
}

interface UnconfirmedFirstPair {
  device: StoredDevice;
  expires: number;
  /** the stream keys of the browser that asked for it (`streamKeys`), told with its enrollment so that browser's streams skip it */
  origin: readonly string[];
}

/**
 * A browser's stream keys (shared/protocol.ts, "Browser stream keys"): HttpOnly cookies named
 * `ovis_stream_<32 hex>` with the value `1`. They grant nothing. The key is in the NAME, so
 * two answers that each issue one (two tabs opening at once, before either had a key) add two
 * cookies instead of the second overwriting the first: every later request of that browser,
 * the pairing included, carries every key any of its streams was opened with.
 */
/** keys read from one request; issuance happens only when a request carries none, so a browser holds only as many as answers raced */
const STREAM_KEYS_MAX = 8;
const STREAM_KEY = /^[0-9a-f]{32}$/;

/** The browser's stream keys, in the order it sent them. Malformed names or values are ignored, never refused. */
export function streamKeys(request: Request): string[] {
  const keys: string[] = [];
  for (const [name, value] of parseCookies(request.headers.get("cookie"))) {
    if (!name.startsWith(STREAM_COOKIE_PREFIX) || value !== "1") continue;
    const key = name.slice(STREAM_COOKIE_PREFIX.length);
    if (STREAM_KEY.test(key) && !keys.includes(key)) keys.push(key);
    if (keys.length === STREAM_KEYS_MAX) break;
  }
  return keys;
}

/** The request names `application/json` among the types it accepts: a browser's fetch sends `*\/*` and never asks. */
function acceptsJson(request: Request): boolean {
  return (request.headers.get("accept") ?? "").split(",").some((type) => type.split(";")[0]!.trim().toLowerCase() === "application/json");
}

export function newStreamKey(): string {
  return randomBytes(16).toString("hex");
}

export function streamCookie(key: string, secure: boolean): string {
  return `${STREAM_COOKIE_PREFIX}${key}=1; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

/** whether two sets of stream keys name the same browser */
export function sameBrowser(a: readonly string[], b: readonly string[]): boolean {
  return a.some((key) => b.includes(key));
}

export interface PairingCode {
  code: string;
  expires_at: string;
}

/** What a request's device cookie resolved to. */
export interface DeviceMatch {
  id: string;
  label: string;
  role: DeviceRole;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const same = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function normalizeLabel(value: unknown, fallback: string): string {
  const label = typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) : "";
  return label || fallback;
}

export function isDeviceRole(value: unknown): value is DeviceRole {
  return value === "drive" || value === "watch";
}

/**
 * A devices.json as it is on disk: absent, a valid registry, or one that cannot be read or is not valid.
 * `placeholder`: written only to close the gate where there was no registry (state-merge.ts); it says
 * nothing about which devices were revoked. The store's next save drops the mark.
 */
export type DeviceRegistry = { kind: "missing" } | { kind: "ok"; gateClosedAt: string | null; devices: StoredDevice[]; placeholder: boolean } | { kind: "bad" };

export function readDeviceRegistry(path: string): DeviceRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "bad" };
  }
  if (!isJsonObject(parsed) || !Array.isArray(parsed.devices)
    || !(parsed.gate_closed_at === null || typeof parsed.gate_closed_at === "string")
    || !parsed.devices.every((d) => isJsonObject(d) && typeof d.id === "string"
      && typeof d.token_hash === "string" && isDeviceRole(d.role)
      && (d.relay_public_key === undefined || isRelayPublicKey(d.relay_public_key))
      && typeof d.label === "string" && typeof d.created_at === "string"
      && (d.last_seen_at === null || typeof d.last_seen_at === "string"))) return { kind: "bad" };
  return { kind: "ok", gateClosedAt: parsed.gate_closed_at, devices: parsed.devices as StoredDevice[], placeholder: parsed.placeholder === true && parsed.devices.length === 0 };
}

export class DeviceStore {
  private devices: StoredDevice[] = [];
  /** when the first device was paired: from then on, only this PC, the owner's login, a device or the token get in */
  private gateClosedAt: string | null = null;
  private pending: { code: string; expires: number; attempts: number } | null = null;
  private codeIssues: number[] = [];
  private relayFailures: number[] = [];
  private relayBlockedUntil = 0;
  /** First-pair cookies are not devices, and do not close the gate, until one returns. */
  private unconfirmedFirstPairs: UnconfirmedFirstPair[] = [];
  private readonly path: string;
  private readonly revocations = new Map<string, Set<() => void>>();
  private readonly pairings = new Set<(event: DevicePairedEvent, origin: readonly string[]) => void>();
  readonly error: string | null = null;

  /**
   * `blocked`: why the registry may lack devices that must stay paired (state-merge.ts could not
   * take over the other state dir's): the store then stays gated and changes nothing, as for a
   * damaged registry, while the devices it holds still get in.
   */
  constructor(stateDir: string, blocked: string | null = null) {
    this.path = join(stateDir, "devices.json");
    const read = readDeviceRegistry(this.path);
    if (read.kind === "ok") {
      this.gateClosedAt = read.gateClosedAt;
      this.devices = read.devices;
    } else if (read.kind === "bad") {
      // A damaged registry is not a first installation. Keep it intact for recovery and
      // let the existing local/token/Tailscale routes provide access to the owner.
      this.error = `Cannot read ${this.path}. Restore a valid devices.json or fix its permissions, then restart the server. External access without a token or trusted Tailscale login remains blocked.`;
      console.error(this.error);
    }
    if (blocked !== null && this.error === null) {
      this.error = blocked;
      console.error(this.error);
    }
  }

  /**
   * Whether the gate is closed to strangers: it is from the first pairing on, and stays so when
   * every device is revoked (revoking must never reopen the LAN); this PC itself always gets in.
   */
  get gated(): boolean {
    return this.error !== null || this.gateClosedAt !== null || this.devices.length > 0;
  }

  /** Relay opt-in closes open LAN access before any outbound connection is made. */
  closeGate(): void {
    this.assertWritable();
    if (this.gated) return;
    const gate = new Date().toISOString();
    this.save(this.devices, gate);
    this.gateClosedAt = gate;
    this.pending = null;
    this.unconfirmedFirstPairs = [];
  }

  /** Ends stale authority on revocation or role changes, never a label-only update. Called immediately for an already-revoked identity. */
  onRevoke(id: string, close: () => void): () => void {
    if (!this.devices.some((device) => device.id === id)) { close(); return () => {}; }
    const listeners = this.revocations.get(id) ?? new Set<() => void>();
    listeners.add(close);
    this.revocations.set(id, listeners);
    return () => {
      listeners.delete(close);
      if (listeners.size === 0) this.revocations.delete(id);
    };
  }

  /**
   * Hears of every durable enrollment: a gated pairing, or a first-pair cookie confirmed. Never an
   * unconfirmed credential, a last-seen write or a failed one. Each announcement carries its own
   * `event_id`, so a browser that hears it twice shows it once.
   */
  onPaired(listener: (event: DevicePairedEvent, origin: readonly string[]) => void): () => void {
    this.pairings.add(listener);
    return () => { this.pairings.delete(listener); };
  }

  /**
   * After the registry write that made `device` durable, and only then. `enrolledAt` is that write's
   * moment, not the credential's issue: a first-pair cookie confirmed later is enrolled when it returns.
   * `origin` holds the stream keys of the browser that asked for the pairing (`streamKeys`), empty if it had none.
   */
  private announce(device: StoredDevice, enrolledAt: number, origin: readonly string[]): void {
    const event: DevicePairedEvent = { type: "device-paired", event_id: randomBytes(8).toString("hex"), device_id: device.id, label: device.label, enrolled_at: new Date(enrolledAt).toISOString() };
    for (const listener of this.pairings) listener(event, origin);
  }

  private assertWritable(): void {
    if (this.error !== null) throw new Error(this.error);
  }

  list(currentId: string | null): PairedDevice[] {
    return this.devices.map((d) => ({ id: d.id, label: d.label, role: d.role, created_at: d.created_at, last_seen_at: d.last_seen_at, current: d.id === currentId, ...(d.relay_public_key === undefined ? {} : { via_relay: true as const }) }));
  }

  /** The current code when it can still be used, without changing its attempts or expiry. */
  activePairing(now = Date.now()): PairingCode | null {
    const pending = this.pending;
    if (pending === null || now > pending.expires || pending.attempts >= CODE_ATTEMPTS) return null;
    return { code: pending.code, expires_at: new Date(pending.expires).toISOString() };
  }

  /** A fresh six-digit code, replacing any code still pending. */
  startPairing(now = Date.now()): PairingCode {
    this.assertWritable();
    this.pruneUnconfirmedFirstPairs(now);
    this.codeIssues = this.codeIssues.filter((at) => now - at < PAIRING_WINDOW_MS);
    if (this.codeIssues.length >= 10) throw new PairingRateLimitedError(Math.ceil(((this.codeIssues[0] ?? now) + PAIRING_WINDOW_MS - now) / 1000));
    this.codeIssues.push(now);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.pending = { code, expires: now + CODE_TTL_MS, attempts: 0 };
    return { code, expires_at: new Date(this.pending.expires).toISOString() };
  }

  /** `{ token }` when the code is right; null when it is wrong, spent or expired. */
  pair(code: string, label: string, role: DeviceRole, now = Date.now(), origin: readonly string[] = []): { token: string; device: DeviceMatch } | null {
    this.assertWritable();
    this.pruneUnconfirmedFirstPairs(now);
    if (!this.checkPairingCode(code, now)) return null;
    const token = randomBytes(32).toString("hex");
    const device: StoredDevice = { id: randomBytes(8).toString("hex"), label, role, token_hash: hash(token), created_at: new Date(now).toISOString(), last_seen_at: null };
    if (!this.gated) {
      this.pending = null;
      this.unconfirmedFirstPairs.push({ device, expires: now + CODE_TTL_MS, origin });
      if (this.unconfirmedFirstPairs.length > UNCONFIRMED_FIRST_PAIR_LIMIT) this.unconfirmedFirstPairs.shift();
      return { token, device: { id: device.id, label: device.label, role: device.role } };
    }
    this.enroll(device, now, origin);
    return { token, device: { id: device.id, label: device.label, role: device.role } };
  }

  /** Both transports spend the same pending code's five guesses. */
  private checkPairingCode(code: string, now: number): boolean {
    const pending = this.pending;
    if (pending === null || now > pending.expires) { this.pending = null; return false; }
    if (!same(code.replace(/\D/g, ""), pending.code)) {
      pending.attempts += 1;
      if (pending.attempts >= CODE_ATTEMPTS) this.pending = null;
      return false;
    }
    return true;
  }

  /** One authorization write precedes every state change and enrollment announcement. */
  private enroll(device: StoredDevice, now: number, origin: readonly string[]): void {
    const next = [...this.devices, device];
    const gate = this.gateClosedAt ?? device.created_at;
    this.save(next, gate);
    this.devices = next;
    this.gateClosedAt = gate;
    this.pending = null;
    // A relay enrollment closes the gate immediately, invalidating every first-cookie candidate.
    if (device.relay_public_key !== undefined) this.unconfirmedFirstPairs = [];
    this.announce(device, now, origin);
  }

  /** No cookie is issued: even the first relay pairing is durable and closes the gate at once. */
  pairRelay(code: string, label: string, publicKey: string, now = Date.now()): { device: DeviceMatch } | null {
    this.assertWritable();
    if (now < this.relayBlockedUntil) throw new PairingRateLimitedError(Math.ceil((this.relayBlockedUntil - now) / 1000));
    this.relayFailures = this.relayFailures.filter((at) => now - at < PAIRING_WINDOW_MS);
    if (!this.checkPairingCode(code, now) || !isRelayPublicKey(publicKey)) {
      this.relayFailures.push(now);
      if (this.relayFailures.length >= 20) this.relayBlockedUntil = now + PAIRING_WINDOW_MS;
      return null;
    }
    const device: StoredDevice = {
      id: randomBytes(8).toString("hex"), label: normalizeLabel(label, "Device"), role: "drive",
      token_hash: hash(randomBytes(32).toString("hex")), relay_public_key: publicKey,
      // PAIR authenticates this relay session too, so the device is seen as it pairs.
      created_at: new Date(now).toISOString(), last_seen_at: new Date(now).toISOString(),
    };
    this.enroll(device, now, []);
    return { device: { id: device.id, label: device.label, role: device.role } };
  }

  /** The transport owns a fresh 32-byte nonce per session and consumes AUTH only once. */
  async matchRelay(deviceId: string, nonce: Uint8Array, signature: string, serverId: string, now = Date.now()): Promise<DeviceMatch | null> {
    if (nonce.byteLength !== 32 || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return null;
    const signed = Buffer.from(signature, "base64url");
    if (signed.length !== 64 || signed.toString("base64url") !== signature) return null;
    const device = this.devices.find((d) => d.id === deviceId && d.relay_public_key !== undefined);
    if (device?.relay_public_key === undefined) return null;
    const message = Buffer.concat([Buffer.from("ovis-relay-auth/1"), nonce, Buffer.from(serverId)]);
    try {
      const key = await crypto.subtle.importKey("spki", Buffer.from(device.relay_public_key, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      const verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signed, message);
      // Authorization changes during WebCrypto invalidate the proof; a rename does not.
      const current = this.devices.find((d) => d.id === deviceId);
      if (!verified || !current || current.role !== device.role || current.relay_public_key !== device.relay_public_key) return null;
      this.noteSeen(current, now);
      return { id: current.id, label: current.label, role: current.role };
    } catch (error) {
      if (error instanceof DOMException) return null;
      throw error;
    }
  }

  /** The device a cookie token belongs to, noting when it was last seen (at most once a minute on disk). */
  match(token: string | undefined, now = Date.now()): DeviceMatch | null {
    this.pruneUnconfirmedFirstPairs(now);
    if (!token) return null;
    const digest = hash(token);
    const candidateIndex = this.unconfirmedFirstPairs.findIndex(({ device }) => same(digest, device.token_hash));
    if (candidateIndex !== -1) {
      const { device: candidate, origin } = this.unconfirmedFirstPairs[candidateIndex]!;
      const confirmed = { ...candidate, last_seen_at: new Date(now).toISOString() };
      const next = [...this.devices, confirmed];
      const gate = this.gateClosedAt ?? confirmed.created_at;
      // This is an authorization write, not last-seen telemetry: do not match the cookie
      // unless the device and closed gate reached disk together.
      this.save(next, gate);
      this.devices = next;
      this.gateClosedAt = gate;
      // Once one first-pair cookie closes the gate, every sibling candidate is stale:
      // subsequent devices must be issued through the gated pairing flow.
      this.unconfirmedFirstPairs = [];
      this.announce(confirmed, now, origin);
      return { id: confirmed.id, label: confirmed.label, role: confirmed.role };
    }
    for (const device of this.devices) {
      if (!same(digest, device.token_hash)) continue;
      this.noteSeen(device, now);
      return { id: device.id, label: device.label, role: device.role };
    }
    return null;
  }

  /** Notes when a device was last seen, at most once a minute on disk. */
  private noteSeen(device: StoredDevice, now: number): void {
    const seen = device.last_seen_at === null ? 0 : Date.parse(device.last_seen_at);
    // A blocked registry stays as it is on disk until the server restarts.
    if (this.error !== null || now - seen < LAST_SEEN_WRITE_MS) return;
    try {
      const next = this.devices.map((d) => d === device ? { ...d, last_seen_at: new Date(now).toISOString() } : d);
      // devices.json is also the authorization registry: a torn write here would lock every device out
      this.save(next);
      this.devices = next;
    } catch { /* last-seen telemetry must not deny an otherwise valid credential */ }
  }

  update(id: string, patch: { label?: string; role?: DeviceRole }): PairedDevice | null {
    this.assertWritable();
    const device = this.devices.find((d) => d.id === id);
    if (!device) return null;
    const updated = { ...device, ...(patch.label === undefined ? {} : { label: patch.label }), ...(patch.role === undefined ? {} : { role: patch.role }) };
    const next = this.devices.map((d) => d === device ? updated : d);
    this.save(next);
    this.devices = next;
    if (updated.role !== device.role) {
      const listeners = this.revocations.get(id);
      this.revocations.delete(id);
      for (const close of listeners ?? []) close();
    }
    return { id: updated.id, label: updated.label, role: updated.role, created_at: updated.created_at, last_seen_at: updated.last_seen_at, current: false, ...(updated.relay_public_key === undefined ? {} : { via_relay: true as const }) };
  }

  revoke(id: string): boolean {
    this.assertWritable();
    const next = this.devices.filter((d) => d.id !== id);
    if (next.length === this.devices.length) return false;
    // A valid older/manual registry can have devices without a gate timestamp. Removing its
    // last device must still leave durable evidence that this store was once gated.
    const gate = this.gateClosedAt ?? this.devices[0]?.created_at ?? null;
    this.save(next, gate);
    this.devices = next;
    this.gateClosedAt = gate;
    const listeners = this.revocations.get(id);
    this.revocations.delete(id);
    for (const close of listeners ?? []) close();
    return true;
  }

  /**
   * Every paired device loses its access in one durable write, the caller's own included; the
   * ids it returns are for the cleanup that follows (push subscriptions, page media). The write
   * comes first and alone: until it succeeds nothing changes, and if it throws, the registry,
   * every credential and every listener stay as they were. After it, the pending code and every
   * unconfirmed first-pair credential are void as well, and every revoked device's streams close.
   * The gate stays closed, with a timestamp even when nothing was ever confirmed (only first-pair
   * candidates existed): revoking must never reopen the LAN, not even after a restart.
   */
  revokeAll(): string[] {
    this.assertWritable();
    const gate = this.gateClosedAt ?? this.devices[0]?.created_at ?? new Date().toISOString();
    this.save([], gate);
    const revoked = this.devices.map((device) => device.id);
    this.devices = [];
    this.gateClosedAt = gate;
    this.pending = null;
    this.unconfirmedFirstPairs = [];
    const listeners = [...this.revocations.values()];
    this.revocations.clear();
    for (const closes of listeners) for (const close of closes) close();
    return revoked;
  }

  has(id: string): boolean { return this.devices.some((device) => device.id === id); }

  private pruneUnconfirmedFirstPairs(now: number): void {
    this.unconfirmedFirstPairs = this.unconfirmedFirstPairs.filter(({ expires }) => now <= expires);
  }

  private save(devices = this.devices, gateClosedAt = this.gateClosedAt): void {
    writePrivateState(this.path, { gate_closed_at: gateClosedAt, devices });
  }
}

/**
 * /api/devices*. Pairing itself is public, like /api/auth: it is how a device gets in. The
 * rest reaches here only through the gate in index.ts, and anything that changes the list
 * needs the app's own mutation guard (same origin + X-Herdr-Machine), like the other mutations.
 * `onRevoked` is told the id of every device a request revoked, once the registry says so: the
 * cleanup that follows (push subscriptions, page media) works from those ids, never from the path.
 */
export async function handleDeviceRequest(request: Request, pathname: string, store: DeviceStore, access: Access, onRevoked?: (ids: string[]) => void): Promise<Response> {
  if (store.error !== null) return jsonResponse({ error: { code: "device_store_unavailable", message: access.level === "full" ? store.error : "Device pairing is unavailable; ask the owner to check Settings → Devices on the host." } }, 503);
  const json = async (): Promise<Record<string, unknown> | Response> => {
    try {
      const body = (await request.json()) as unknown;
      return isJsonObject(body) ? body : badRequest("invalid_body", "request body must be a JSON object");
    } catch { return badRequest("invalid_json", "request body must be JSON"); }
  };
  if (pathname === "/api/devices/pair") {
    setRequestRoute(pathname);
    if (access.level === "full" && access.via === "relay") return jsonResponse({ error: { code: "device_key_required", message: "Pair relay devices through the encrypted channel" } }, 403);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const body = await json();
    if (body instanceof Response) return body;
    if (typeof body["code"] !== "string") return badRequest("missing_code", "code is required");
    const firstPair = !store.gated;
    const paired = store.pair(body["code"], normalizeLabel(body["label"], "Device"), "drive", Date.now(), streamKeys(request));
    if (paired === null) return jsonResponse({ error: { code: "invalid_code", message: "the code is wrong, spent or expired; start a new pairing on the PC" } }, 401);
    const cookies = [deviceCookie(paired.token, isSecureRequest(request)), CLEAR_LEGACY_DEVICE_COOKIE];
    if (!acceptsJson(request)) return noContent(...cookies);
    // a script asked for the token itself, to send as `Authorization: Device <token>` (#2744); a
    // browser never asks, so its page never reads the credential its HttpOnly cookie keeps. A first
    // pairing waits in memory for its cookie to come back; a script may store the token and use it
    // after a restart, so its pairing is confirmed (written, gate closed) before the answer
    if (firstPair) store.match(paired.token);
    const answer = jsonResponse({ token: paired.token } satisfies DevicePairToken, 200, { "cache-control": "no-store" });
    for (const cookie of cookies) answer.headers.append("set-cookie", cookie);
    return answer;
  }
  if (pathname === "/api/devices") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    return jsonResponse({ devices: store.list(access.level === "full" ? access.device?.id ?? null : null) }, 200, { "cache-control": "no-store" });
  }
  if (!sameOrigin(request) || request.headers.get("x-herdr-machine") !== "1") return jsonResponse({ error: { code: "invalid_origin", message: "Manage devices from this app" } }, 403);
  if (access.level === "full" && access.role === "watch") return jsonResponse({ error: { code: "read_only", message: "this device can only watch" } }, 403);
  if (pathname === "/api/devices/pair/start") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    try {
      return jsonResponse(store.startPairing(), 200, { "cache-control": "no-store" });
    } catch (error) {
      if (error instanceof PairingRateLimitedError) return jsonResponse({ error: { code: error.code, message: error.message } }, 429, { "retry-after": String(error.retryAfter), "cache-control": "no-store" });
      throw error;
    }
  }
  if (pathname === "/api/devices/revoke-all") {
    setRequestRoute("/api/devices/revoke-all");
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const revoked = store.revokeAll();
    onRevoked?.(revoked);
    // the caller's own device cookie, if it holds one, names a device that is gone, under either name
    const answer = jsonResponse({ revoked: revoked.length } satisfies DevicesRevokedAll, 200, { "cache-control": "no-store" });
    answer.headers.append("set-cookie", DEVICE_COOKIE_CLEARED);
    answer.headers.append("set-cookie", CLEAR_LEGACY_DEVICE_COOKIE);
    return answer;
  }
  const id = pathname.slice("/api/devices/".length);
  setRequestRoute("/api/devices/:device_id");
  if (!/^[0-9a-f]{16}$/.test(id)) return badRequest("invalid_device", "no such device");
  if (request.method === "DELETE") {
    if (!store.revoke(id)) return jsonResponse({ error: { code: "not_found", message: "no such device" } }, 404);
    onRevoked?.([id]);
    return noContent();
  }
  if (request.method === "PATCH") {
    const body = await json();
    if (body instanceof Response) return body;
    const updated = store.update(id, { label: normalizeLabel(body["label"], "Device") });
    return updated ? jsonResponse(updated) : jsonResponse({ error: { code: "not_found", message: "no such device" } }, 404);
  }
  return badRequest("method_not_allowed", "use PATCH or DELETE");
}
