import type { ClientConnectionEvent, ClientConnectionEventKind, ClientConnectionTrace } from "../shared/protocol.ts";
import { badRequest, jsonResponse } from "./http.ts";

const KINDS: readonly ClientConnectionEventKind[] = ["connect", "open", "connect_timeout", "close", "socket_error", "pagehide", "pageshow", "hidden", "visible", "online", "probe", "probe_retry", "probe_overdue", "probe_drop", "pong", "submit_sent", "submit_result", "submit_timeout", "submit_disconnect", "input_held", "probe_input_blocked", "closing_wait"];
const MAX_BYTES = 8192;
// Report bodies read at once, server-wide: 16 x 8 KiB at most, whatever peer keys callers rotate.
const MAX_READING = 16;
// A body still arriving after this long gives up its read slot, however steadily it trickles in.
const READ_DEADLINE_MS = 10_000;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;

function readTrace(value: unknown): ClientConnectionTrace | null {
  if (!object(value) || typeof value.client_id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.client_id)
    || (value.target !== "local" && value.target !== "remote") || !Array.isArray(value.events) || value.events.length < 1 || value.events.length > 16) return null;
  const events: ClientConnectionEvent[] = [];
  for (const row of value.events) {
    if (!object(row) || !integer(row.seq) || !integer(row.at) || !integer(row.connection)
      || typeof row.kind !== "string" || !KINDS.includes(row.kind as ClientConnectionEventKind)
      || (row.socket_state !== null && !integer(row.socket_state, 3))
      || (row.visibility !== "visible" && row.visibility !== "hidden" && row.visibility !== "unknown")
      || (row.online !== null && typeof row.online !== "boolean")) return null;
    const event: ClientConnectionEvent = {
      seq: row.seq, at: row.at, connection: row.connection, kind: row.kind as ClientConnectionEventKind,
      socket_state: row.socket_state, visibility: row.visibility as ClientConnectionEvent["visibility"], online: row.online,
    };
    for (const field of ["code", "elapsed_ms", "pending", "request_id", "attempt"] as const) {
      if (row[field] !== undefined) {
        if (!integer(row[field], 604_800_000)) return null;
        event[field] = row[field];
      }
    }
    if (row.result !== undefined) {
      if (row.result !== "ok" && row.result !== "refused") return null;
      event.result = row.result;
    }
    events.push(event);
  }
  // Only these explicit fields reach the log. Unknown fields, URLs, reasons and text are discarded.
  return { client_id: value.client_id, target: value.target, events };
}

/** Auth/origin policy belongs to createServer. This endpoint never invokes Herdr or accepts input. */
export class ClientConnectionLog {
  private peers = new Map<string, { at: number; count: number }>();
  private global = { at: 0, count: 0 };
  private reading = 0;
  constructor(private write: (line: string) => void = (line) => console.warn(line), private now: () => number = Date.now, private readDeadlineMs = READ_DEADLINE_MS) {}

  async handle(request: Request, peer: string): Promise<Response> {
    if (request.method !== "POST") return jsonResponse({ error: { code: "method_not_allowed", message: "use POST" } }, 405, { allow: "POST" });
    const now = this.now();
    if (now - this.global.at >= 60_000) this.global = { at: now, count: 0 };
    let quota = this.peers.get(peer);
    if (!quota || now - quota.at >= 60_000) {
      if (this.peers.size >= 128) this.peers.delete(this.peers.keys().next().value!);
      quota = { at: now, count: 0 }; this.peers.set(peer, quota);
    }
    // The global quota is charged only once a report validates, so malformed POSTs cannot starve real ones.
    if (quota.count >= 4) return jsonResponse({ error: { code: "trace_rate_limited", message: "Connection diagnostics are rate limited" } }, 429, { "retry-after": "60" });
    quota.count++;
    // Bodies being read are bounded server-wide, whatever peer key a caller rotates; the report
    // quota below is charged only after validation, so sequential malformed POSTs starve nothing.
    if (this.reading >= MAX_READING) return jsonResponse({ error: { code: "trace_rate_limited", message: "Connection diagnostics are rate limited" } }, 429, { "retry-after": "60" });
    this.reading++;
    try { return await this.accept(request, now); }
    finally { this.reading--; }
  }

  private async accept(request: Request, now: number): Promise<Response> {
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return badRequest("invalid_trace", "Connection diagnostics must be JSON");
    const tooLarge = () => jsonResponse({ error: { code: "trace_too_large", message: "Connection diagnostics are too large" } }, 413);
    if (Number(request.headers.get("content-length")) > MAX_BYTES) return tooLarge();
    if (!request.body) return badRequest("invalid_trace", "Connection diagnostics are required");
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    // One deadline for the whole body, not per chunk: the timer covers a body that stops arriving,
    // the clock check after each chunk a body that keeps arriving slowly.
    const deadline = this.now() + this.readDeadlineMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolve) => { timer = setTimeout(() => resolve("expired"), this.readDeadlineMs); });
    const timedOut = () => { void reader.cancel().catch(() => {}); return jsonResponse({ error: { code: "trace_timeout", message: "Connection diagnostics took too long to arrive" } }, 408); };
    try {
      for (;;) {
        const next = await Promise.race([reader.read(), expired]);
        if (next === "expired") return timedOut();
        const { value, done } = next;
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { void reader.cancel().catch(() => {}); return tooLarge(); }
        chunks.push(value);
        if (this.now() >= deadline) return timedOut();
      }
    } catch { return badRequest("invalid_trace", "Connection diagnostics could not be read"); }
    finally { clearTimeout(timer); reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let trace: ClientConnectionTrace | null;
    try { trace = readTrace(JSON.parse(new TextDecoder().decode(bytes))); }
    catch { trace = null; }
    if (!trace) return badRequest("invalid_trace", "Invalid connection diagnostics");
    if (this.global.count >= 16) return jsonResponse({ error: { code: "trace_rate_limited", message: "Connection diagnostics are rate limited" } }, 429, { "retry-after": "60" });
    this.global.count++;
    try { this.write(JSON.stringify({ time: new Date(now).toISOString(), event: "client.connection_trace", client_reported: true, client_id: trace.client_id, target: trace.target, events: trace.events })); }
    catch {}
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }
}
