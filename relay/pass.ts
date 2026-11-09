/**
 * Which PCs a relay lets in by their relay pass (shared/relay-pass.ts; README.md, "Relay pass"):
 * the mode, the account service's public keys and the server_ids taken off the relay. Both the
 * Cloudflare Worker and the Bun server read it from the same settings:
 *
 * - `RELAY_PASS_MODE`: `off` (the default: every PC, as before), `grace` (every PC, and the PC is
 *   told whether its pass holds and from when it will be needed) or `enforce` (a PC socket without
 *   a pass that holds closes 4402).
 * - `RELAY_PASS_ENFORCE_AT`: an ISO date; `grace` acts as `enforce` from then on.
 * - `RELAY_PASS_KEYS`: `kid:hex[,kid:hex]`, the Ed25519 public keys passes are checked with.
 * - `RELAY_PASS_REVOKED`: server_ids whose passes are refused, comma separated.
 */
import { RELAY_PASS_LIFETIME_S, RELAY_PASS_REQUIRED, RELAY_PASS_SKEW_S, checkRelayPass, importRelayPassKey, parseRelayPass, relayPassAdmitsNewSessions } from "../shared/relay-pass.ts";

export type PassMode = "off" | "grace" | "enforce";

export interface PassPolicy {
  readonly mode: PassMode;
  /** when `grace` turns into `enforce` (ms), or null */
  readonly enforceAt: number | null;
  readonly keys: ReadonlyMap<string, CryptoKey>;
  readonly revoked: ReadonlySet<string>;
}

/** What the relay made of a PC socket's pass; `exp` (ms) only when it holds, and `noNew` when it holds and allows no new client sessions (a v2 pass with `new` 0). */
export type PassState = "ok" | "missing" | "invalid" | "expired";
export interface PassResult { readonly state: PassState; readonly reason?: string; readonly exp?: number; readonly kid?: string; readonly noNew?: true }

export interface PassSettings {
  readonly RELAY_PASS_MODE?: string;
  readonly RELAY_PASS_ENFORCE_AT?: string;
  readonly RELAY_PASS_KEYS?: string;
  readonly RELAY_PASS_REVOKED?: string;
}

export const PASS_OFF: PassPolicy = { mode: "off", enforceAt: null, keys: new Map(), revoked: new Set() };

/** The mode at `now` (ms). */
export function passMode(policy: PassPolicy, now: number): PassMode {
  return policy.mode === "grace" && policy.enforceAt !== null && now >= policy.enforceAt ? "enforce" : policy.mode;
}

/** An ISO 8601 UTC instant (`2027-01-01T00:00:00Z`, seconds and milliseconds optional) in ms, or undefined for anything else, an impossible day included. */
function isoUtc(text: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(text)) return undefined;
  const at = Date.parse(text);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 16) === text.slice(0, 16) ? at : undefined;
}

/**
 * The policy the settings name. An unknown mode is off, with a log line; other settings that do not
 * parse throw (the Bun relay then does not start; the Worker logs it and runs with passes off, so it
 * never stops routing).
 */
export async function passPolicy(settings: PassSettings): Promise<PassPolicy> {
  const mode = settings.RELAY_PASS_MODE?.trim() || "off";
  if (mode !== "off" && mode !== "grace" && mode !== "enforce") {
    console.error(JSON.stringify({ event: "relay.pass.mode_unknown", mode: mode.slice(0, 32), using: "off" }));
    return PASS_OFF;
  }
  if (mode === "off") return PASS_OFF;
  const at = settings.RELAY_PASS_ENFORCE_AT?.trim();
  const enforceAt = at ? isoUtc(at) : null;
  if (enforceAt !== null && enforceAt === undefined) throw new Error("RELAY_PASS_ENFORCE_AT must be an ISO 8601 UTC date such as 2027-01-01T00:00:00Z");
  const keys = new Map<string, CryptoKey>();
  for (const entry of (settings.RELAY_PASS_KEYS ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
    const [kid, hex, extra] = entry.split(":");
    if (!kid || !/^[0-9a-f]{8}$/.test(kid) || !hex || extra !== undefined) throw new Error("RELAY_PASS_KEYS must be kid:hex pairs");
    keys.set(kid, await importRelayPassKey(hex));
  }
  if (keys.size === 0) throw new Error("RELAY_PASS_KEYS must name at least one key outside off");
  const revoked = new Set((settings.RELAY_PASS_REVOKED ?? "").split(",").map((part) => part.trim()).filter(Boolean));
  for (const id of revoked) if (!/^[0-9a-f]{32}$/.test(id)) throw new Error("RELAY_PASS_REVOKED must list server_ids");
  return { mode, enforceAt, keys, revoked };
}

/**
 * Whether a pass could hold for `serverId` at `now` (ms): everything checkRelayPass checks but the signature, so what
 * fails here costs no signature check.
 */
export function passMayHold(policy: PassPolicy, pass: string | null, serverId: string, now: number): boolean {
  const parsed = parseRelayPass(pass);
  if (!parsed || policy.revoked.has(serverId)) return false;
  const { kid, sid, iat, exp } = parsed.payload;
  const seconds = Math.floor(now / 1000);
  return policy.keys.has(kid) && sid === serverId && iat <= seconds + RELAY_PASS_SKEW_S && exp - iat <= RELAY_PASS_LIFETIME_S && exp + RELAY_PASS_SKEW_S > seconds;
}

/** Checks the pass a PC socket of `serverId` came with, at `now` (ms). */
export async function checkPass(policy: PassPolicy, pass: string | null | undefined, serverId: string, now: number): Promise<PassResult> {
  if (policy.revoked.has(serverId)) return pass ? { state: "invalid", reason: "relay pass invalid" } : { state: "missing", reason: RELAY_PASS_REQUIRED };
  const check = await checkRelayPass(pass, policy.keys, serverId, Math.floor(now / 1000));
  if (check.ok) return { state: "ok", exp: check.payload.exp * 1000, kid: check.payload.kid, ...(relayPassAdmitsNewSessions(check.payload) ? {} : { noNew: true as const }) };
  return { state: check.reason === RELAY_PASS_REQUIRED ? "missing" : check.reason === "relay pass expired" ? "expired" : "invalid", reason: check.reason };
}

/** The `relay_pass` field the relay adds to a PC's `sync` and a client's `assigned` outside `off`. */
export function passNotice(policy: PassPolicy, state: PassState): { state: PassState; enforce_at: string | null } {
  return { state, enforce_at: policy.enforceAt === null ? null : new Date(policy.enforceAt).toISOString() };
}
