/**
 * The relay pass: what lets a PC onto Ovis's own relays (docs/relay.md, "Relay pass"). The account
 * service signs one for a PC whose relay key it saw proven and that an account lists; the relay
 * checks it offline with the service's public key, once per socket, never per frame. A pass names
 * the PC (`sid`, its server_id) and nothing about the account, and is only ever accepted together
 * with the server proof of that server_id's key, so a copied pass does not open a socket.
 *
 * Text form: `ovp1.<payload>.<signature>`, both base64url without padding. The signature is Ed25519
 * (WebCrypto) over the ASCII bytes `ovis-relay-pass/1.` followed by the payload's base64url text.
 * The payload is JSON with exactly `v` (1), `kid`, `aud`, `sid`, `iat` and `exp` (seconds), or a v2
 * payload: those fields with `v` 2 and `new`, 1 when new client sessions to the PC are allowed and 0
 * when they are not for the pass's lifetime. A v1 pass allows them. A relay that enforces passes
 * closes a client the PC identified as a device new to it (relay/README.md "New sessions") with
 * RELAY_NEW_SESSIONS_CLOSE while the room's pass says `new` 0; the PC's other clients stay. The prefix and signing prefix stay `1`: the signature covers the payload's
 * text, `v` and `new` included, so a v2 pass cannot be passed off as v1 or have `new` edited, and a
 * relay that knows only v1 refuses a v2 pass by its shape.
 */

/** The upgrade request header a PC sends its pass in; never the URL. */
export const RELAY_PASS_HEADER = "x-ovis-relay-pass";
/** How long a pass is good for, and when the PC asks for the next one (seconds from issue). */
export const RELAY_PASS_LIFETIME_S = 48 * 3600;
export const RELAY_PASS_REFRESH_S = 12 * 3600;
/** Clock difference the relay allows between itself and the account service. */
export const RELAY_PASS_SKEW_S = 300;
/** The only audience: Ovis's relays. */
export const RELAY_PASS_AUDIENCE = "ovis-relay";

/** Close code for a PC socket refused for its pass, and its reasons. */
export const RELAY_PASS_CLOSE = 4402;
export const RELAY_PASS_REQUIRED = "relay pass required";
export const RELAY_PASS_EXPIRED = "relay pass expired";
export const RELAY_PASS_INVALID = "relay pass invalid";
/** Close code for a client the PC identified as a device new to it, while its pass allows no new sessions (account limits), and its reason. */
export const RELAY_NEW_SESSIONS_CLOSE = 4403;
export const RELAY_NEW_SESSIONS_REFUSED = "no new sessions for this server";

const PREFIX = "ovp1.";
const SIGNING_PREFIX = "ovis-relay-pass/1.";
/** A pass is about 250 characters; anything far past that is not one. */
const MAX_LENGTH = 512;
const HEX32 = /^[0-9a-f]{32}$/;
const KID = /^[0-9a-f]{8}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

interface RelayPassFields {
  readonly kid: string;
  readonly aud: typeof RELAY_PASS_AUDIENCE;
  readonly sid: string;
  readonly iat: number;
  readonly exp: number;
}
export type RelayPassPayload = (RelayPassFields & { readonly v: 1 }) | (RelayPassFields & { readonly v: 2; readonly new: 0 | 1 });

/** Whether this pass allows new client sessions to the PC it is for. */
export function relayPassAdmitsNewSessions(payload: RelayPassPayload): boolean {
  return payload.v === 1 || payload.new === 1;
}

export type RelayPassCheck =
  | { readonly ok: true; readonly payload: RelayPassPayload }
  | { readonly ok: false; readonly reason: typeof RELAY_PASS_REQUIRED | typeof RELAY_PASS_EXPIRED | typeof RELAY_PASS_INVALID };

const encoder = new TextEncoder();

function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!B64URL.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch { return null; }
}

function isPayload(value: unknown): value is RelayPassPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  const version = keys.length === 6 && fields["v"] === 1
    || keys.length === 7 && fields["v"] === 2 && (fields["new"] === 0 || fields["new"] === 1);
  return version && typeof fields["kid"] === "string" && KID.test(fields["kid"])
    && fields["aud"] === RELAY_PASS_AUDIENCE && typeof fields["sid"] === "string" && HEX32.test(fields["sid"])
    && Number.isSafeInteger(fields["iat"]) && Number.isSafeInteger(fields["exp"])
    && (fields["exp"] as number) > (fields["iat"] as number);
}

/** The pass's parts, or null when it is not shaped like one. Checks no signature and no time. */
export function parseRelayPass(text: unknown): { payload: RelayPassPayload; signed: Uint8Array<ArrayBuffer>; signature: Uint8Array<ArrayBuffer> } | null {
  if (typeof text !== "string" || text.length > MAX_LENGTH || !text.startsWith(PREFIX)) return null;
  const parts = text.slice(PREFIX.length).split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const json = fromBase64url(body);
  const signature = fromBase64url(sig);
  if (!json || !signature || signature.length !== 64) return null;
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json)); } catch { return null; }
  if (!isPayload(payload)) return null;
  return { payload, signed: encoder.encode(SIGNING_PREFIX + body), signature };
}

/** An Ed25519 public key (32 bytes, lowercase hex) for checking passes. */
export function importRelayPassKey(hex: string): Promise<CryptoKey> {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("A relay pass key is 64 lowercase hex digits");
  const raw = Uint8Array.from(hex.match(/../g)!, (pair) => parseInt(pair, 16));
  return crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
}

/** What else a pass says: with `newSessions` it is a v2 pass whose `new` follows it, without it a v1 pass. */
export interface RelayPassSignOptions { readonly newSessions?: boolean }

/** Signs a pass for `sid`, good from `now` (seconds) for `lifetime` seconds. The account service's side. */
export async function signRelayPass(key: CryptoKey, kid: string, sid: string, now: number, lifetime = RELAY_PASS_LIFETIME_S, options: RelayPassSignOptions = {}): Promise<string> {
  const fields = { kid, aud: RELAY_PASS_AUDIENCE, sid, iat: now, exp: now + lifetime } as const;
  const payload: RelayPassPayload = options.newSessions === undefined ? { v: 1, ...fields } : { v: 2, ...fields, new: options.newSessions ? 1 : 0 };
  if (!isPayload(payload)) throw new Error("Invalid relay pass fields");
  const body = toBase64url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, encoder.encode(SIGNING_PREFIX + body)));
  return `${PREFIX}${body}.${toBase64url(signature)}`;
}

/**
 * Checks a pass for the socket of `serverId` at `now` (seconds): its shape, a known `kid`, the
 * server_id, issue and expiry times (with RELAY_PASS_SKEW_S either way), then the signature. The
 * cheap checks come first, so a pass that cannot hold costs no signature check.
 */
export async function checkRelayPass(text: string | null | undefined, keys: ReadonlyMap<string, CryptoKey>, serverId: string, now: number): Promise<RelayPassCheck> {
  if (text === null || text === undefined || text === "") return { ok: false, reason: RELAY_PASS_REQUIRED };
  const pass = parseRelayPass(text);
  const key = pass ? keys.get(pass.payload.kid) : undefined;
  if (!pass || !key || pass.payload.sid !== serverId || pass.payload.iat > now + RELAY_PASS_SKEW_S) return { ok: false, reason: RELAY_PASS_INVALID };
  // no pass is good for longer than the account service issues them
  if (pass.payload.exp - pass.payload.iat > RELAY_PASS_LIFETIME_S) return { ok: false, reason: RELAY_PASS_INVALID };
  if (pass.payload.exp + RELAY_PASS_SKEW_S <= now) return { ok: false, reason: RELAY_PASS_EXPIRED };
  try {
    if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, pass.signature, pass.signed))) return { ok: false, reason: RELAY_PASS_INVALID };
  } catch { return { ok: false, reason: RELAY_PASS_INVALID }; }
  return { ok: true, payload: pass.payload };
}
