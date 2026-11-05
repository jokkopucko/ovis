/**
 * The receiver of herdr web ui's anonymous install and update counts and daily active messages
 * (server/telemetry.ts). A Cloudflare Worker over two D1 tables: /v1/events fills `events`, and
 * /v1/active fills `active`, one row per install and UTC day, which a later message that day
 * replaces (the harness kinds and the day's usage may grow). It never reads the visitor's address or any header
 * beyond the content type; of where a request came from it keeps the country Cloudflare names
 * and nothing finer. It keeps the day rather than the time, and stores each
 * (install, event, version) once, so a replayed event counts once. It stores only the app's
 * validated, allowlisted settings snapshot. Deploy: telemetry/README.md.
 */

import { ACTIVE_LATE_DAYS, telemetryHarnesses, telemetrySettings, telemetryUsage, type TelemetryHarness, type TelemetryRuntime, type TelemetrySettings, type TelemetryUsage } from "../shared/telemetry.ts";

/** the part of Cloudflare's D1 binding this Worker uses */
interface D1Statement { bind(...values: unknown[]): { run(): Promise<unknown> } }
export interface Env { DB: { prepare(query: string): D1Statement } }

export interface StoredEvent {
  day: string;
  event: "install" | "update";
  install_id: string;
  version: string;
  previous_version: string | null;
  os: string;
  arch: string;
  install_method: "plugin" | "managed" | "source";
  /** complete validated snapshot, or null when the sender has not provided one */
  settings: TelemetrySettings | null;
  /** the terminal runtime, from senders since it was added; null from older ones */
  runtime: TelemetryRuntime | null;
}

export interface StoredActive {
  /** the UTC day of the visit, as the message names it */
  day: string;
  install_id: string;
  version: string;
  os: string;
  arch: string;
  install_method: "plugin" | "managed" | "source";
  harnesses: TelemetryHarness[];
  /** the day's use, from senders since NOTICE_VERSION 5; null from older ones */
  usage: TelemetryUsage | null;
  /** the terminal runtime, from senders since it was added; null from older ones */
  runtime: TelemetryRuntime | null;
}

const MAX_BODY_BYTES = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** a release, or a prerelease of one (0.5.0-rc.1): the sender reports package.json's version as it is */
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9a-z.]{1,24})?$/;
const WORD = /^[a-z0-9_]{1,16}$/;
const EVENTS = new Set(["install", "update"]);
const METHODS = new Set(["plugin", "managed", "source"]);
const RUNTIMES = new Set(["herdr", "herdr-core"]);

/** the sender's `runtime` when it has one: an older sender has none (null); anything else is not a message (undefined) */
function readRuntime(value: Record<string, unknown>): TelemetryRuntime | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, "runtime")) return null;
  const runtime = value["runtime"];
  return typeof runtime === "string" && RUNTIMES.has(runtime) ? runtime as TelemetryRuntime : undefined;
}
/** ISO 3166-1 alpha-2 */
const COUNTRY = /^[A-Z]{2}$/;

/**
 * The country Cloudflare worked out for this request; null off Cloudflare or when it names none.
 * Its two non-countries are dropped too: XX (unknown), and T1, which would say the sender uses Tor.
 */
export function requestCountry(request: Request): string | null {
  const country = (request as { cf?: { country?: unknown } }).cf?.country;
  return typeof country === "string" && COUNTRY.test(country) && country !== "XX" ? country : null;
}

/** the event as it is stored, or null when the body is not one */
/** the fields an event has ever carried; `changed_settings` is what senders before 0.4.9 told and is not kept */
const EVENT_KEYS = new Set(["event", "install_id", "version", "previous_version", "os", "arch", "install_method", "settings", "changed_settings", "runtime"]);

export function readEvent(body: unknown, now: Date): StoredEvent | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !EVENT_KEYS.has(key))) return null;
  const { event, install_id, version, previous_version, os, arch, install_method } = value;
  if (typeof event !== "string" || !EVENTS.has(event)) return null;
  if (typeof install_id !== "string" || !UUID.test(install_id)) return null;
  if (typeof version !== "string" || !VERSION.test(version)) return null;
  if (previous_version !== null && (typeof previous_version !== "string" || !VERSION.test(previous_version))) return null;
  if (event === "install" && previous_version !== null) return null;
  if (typeof os !== "string" || !WORD.test(os) || typeof arch !== "string" || !WORD.test(arch)) return null;
  if (typeof install_method !== "string" || !METHODS.has(install_method)) return null;
  const hasSettings = Object.prototype.hasOwnProperty.call(value, "settings");
  const settingsValue = hasSettings ? value["settings"] : null;
  const settings = settingsValue === null ? null : telemetrySettings(settingsValue);
  if (hasSettings && settingsValue !== null && settings === null) return null;
  const runtime = readRuntime(value);
  if (runtime === undefined) return null;
  return {
    day: now.toISOString().slice(0, 10),
    event: event as StoredEvent["event"], install_id, version, previous_version, os, arch,
    install_method: install_method as StoredEvent["install_method"],
    settings,
    runtime,
  };
}

const ACTIVE_KEYS = ["event", "day", "install_id", "version", "os", "arch", "install_method", "harnesses"];
/** a sender since NOTICE_VERSION 5 adds `usage`, and a later one `runtime`; an older one keeps sending the keys above alone */
const ACTIVE_KEY_SETS = [ACTIVE_KEYS, [...ACTIVE_KEYS, "usage"], [...ACTIVE_KEYS, "usage", "runtime"]];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** the active message as it is stored, or null when the body is not one, or names a day outside [today - ACTIVE_LATE_DAYS, today] */
export function readActive(body: unknown, now: Date): StoredActive | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const keys = Object.keys(value);
  const expected = ACTIVE_KEY_SETS.find((set) => set.length === keys.length);
  if (!expected || expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return null;
  const { event, day, install_id, version, os, arch, install_method } = value;
  if (event !== "active") return null;
  if (typeof day !== "string" || !DAY.test(day)) return null;
  const date = new Date(day + "T00:00:00Z");
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) return null;
  const today = now.toISOString().slice(0, 10);
  const earliest = new Date(now.getTime() - ACTIVE_LATE_DAYS * DAY_MS).toISOString().slice(0, 10);
  if (day < earliest || day > today) return null;
  if (typeof install_id !== "string" || !UUID.test(install_id)) return null;
  if (typeof version !== "string" || !VERSION.test(version)) return null;
  if (typeof os !== "string" || !WORD.test(os) || typeof arch !== "string" || !WORD.test(arch)) return null;
  if (typeof install_method !== "string" || !METHODS.has(install_method)) return null;
  const harnesses = telemetryHarnesses(value["harnesses"]);
  if (!harnesses) return null;
  const usage = expected.includes("usage") ? telemetryUsage(value["usage"]) : null;
  if (expected.includes("usage") && usage === null) return null;
  const runtime = readRuntime(value);
  if (runtime === undefined) return null;
  return { day, install_id, version, os, arch, install_method: install_method as StoredActive["install_method"], harnesses, usage, runtime };
}

/** the body as text, or null as soon as it passes MAX_BODY_BYTES (without waiting for the rest) */
async function readBody(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { void reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

/** the parsed JSON body of a POST, or the response refusing it */
async function readJson(request: Request): Promise<{ body: unknown } | Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  if (!request.headers.get("content-type")?.startsWith("application/json")) return new Response(null, { status: 415 });
  const text = await readBody(request);
  if (text === null) return new Response(null, { status: 413 });
  try { return { body: JSON.parse(text) as unknown }; } catch { return new Response(null, { status: 400 }); }
}

export async function handle(request: Request, env: Env, now = new Date()): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/events" && url.pathname !== "/v1/active") return new Response(null, { status: 404 });
  const parsed = await readJson(request);
  if (parsed instanceof Response) return parsed;
  const { body } = parsed;
  if (url.pathname === "/v1/active") {
    const active = readActive(body, now);
    if (!active) return new Response(null, { status: 400 });
    await env.DB.prepare(
      // a later message that day replaces the usage too; one from an older sender (no usage) leaves it
      "INSERT INTO active (day, install_id, version, os, arch, install_method, country, harnesses, usage, runtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (day, install_id) DO UPDATE SET version = excluded.version, os = excluded.os, arch = excluded.arch, install_method = excluded.install_method, country = COALESCE(excluded.country, active.country), harnesses = excluded.harnesses, usage = COALESCE(excluded.usage, active.usage), runtime = COALESCE(excluded.runtime, active.runtime)",
    ).bind(active.day, active.install_id, active.version, active.os, active.arch, active.install_method, requestCountry(request), JSON.stringify(active.harnesses), active.usage === null ? null : JSON.stringify(active.usage), active.runtime).run();
    return new Response(null, { status: 204 });
  }
  const stored = readEvent(body, now);
  if (!stored) return new Response(null, { status: 400 });
  const settings = stored.settings === null ? null : JSON.stringify(stored.settings);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO events (day, event, install_id, version, previous_version, os, arch, install_method, runtime, country, settings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(stored.day, stored.event, stored.install_id, stored.version, stored.previous_version, stored.os, stored.arch, stored.install_method, stored.runtime, requestCountry(request), settings).run();
  return new Response(null, { status: 204 });
}

export default { fetch: (request: Request, env: Env) => handle(request, env) };
