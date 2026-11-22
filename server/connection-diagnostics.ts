import { randomUUID } from "node:crypto";

const REPEAT_MS = 30_000;
const MAX_FAILURES = 128;
const TRANSPORT_CODES = ["timeout", "connect_failed", "socket_error", "closed", "bad_frame", "server_unavailable"] as const;
type TransportCode = typeof TRANSPORT_CODES[number];
type FailureCode = TransportCode | "refresh_failed" | "connection_lost" | "action_required" | "conversation_unavailable" | "conversation_read_pending";

export function transportFailureCode(code: string): TransportCode | null {
  return TRANSPORT_CODES.find((known) => known === code) ?? null;
}

interface Fields {
  /** A code-owned operation name, never a URL, pane ID, target, or error message. */
  operation: string;
  request_id?: string;
  machine_id?: string;
  elapsed_ms?: number;
  connect_ms?: number;
  timeout_ms?: number;
  pending?: number;
  phase?: "connect" | "response";
  close_code?: number;
}
interface Failure {
  id: string;
  since: number;
  loggedAt: number;
  code: FailureCode;
  count: number;
  suppressed: number;
  active: boolean;
  visible: boolean;
}

/** Bounded failure episodes: no access log, input, credentials, peer names, or exception text. */
export class ConnectionDiagnostics {
  private failures = new Map<string, Failure>();

  constructor(
    private component: "herdr.rpc" | "machine.local" | "machine.remote" | "websocket" | "conversation",
    private write: (line: string) => unknown = (line) => console.warn(line),
    private now: () => number = Date.now,
    private wallNow: () => number = () => Date.now(),
  ) {}

  failed(key: string, code: FailureCode, fields: Fields): void {
    const now = this.now();
    let failure = this.failures.get(key);
    if (failure) {
      this.failures.delete(key);
    } else {
      // Retain recent healthy keys too: clearing their throttle lets rapid failure/recovery
      // cycles flood the log.
      if (this.failures.size >= MAX_FAILURES) this.failures.delete(this.failures.keys().next().value!);
      failure = { id: randomUUID(), since: now, loggedAt: -Infinity, code, count: 0, suppressed: 0, active: false, visible: false };
    }
    this.failures.set(key, failure);
    if (!failure.active && failure.count === 0) {
      failure.id = randomUUID();
      failure.since = now;
    }
    failure.active = true;
    failure.count++;
    failure.code = code;
    if (now - failure.loggedAt < REPEAT_MS) {
      failure.suppressed++;
      return;
    }
    if (!this.emit("failed", failure, fields, now)) {
      failure.suppressed++;
      return;
    }
    failure.loggedAt = now;
    failure.visible = true;
    failure.suppressed = 0;
  }

  recovered(key: string, fields: Fields): void {
    const failure = this.failures.get(key);
    if (!failure?.active) return;
    failure.active = false;
    if (!failure.visible) return;
    this.emit("recovered", failure, fields, this.now());
    failure.visible = false;
    failure.count = 0;
    failure.suppressed = 0;
  }

  private emit(event: "failed" | "recovered", failure: Failure, fields: Fields, now: number): boolean {
    // Pick fields explicitly. Never spread an exception, request, response, or caller's object.
    const record: Record<string, string | number> = {
      time: new Date(this.wallNow()).toISOString(), event: `${this.component}.${event}`, episode_id: failure.id,
      operation: /^[a-z][a-z0-9_.]{0,95}$/.test(fields.operation) ? fields.operation : "unknown",
      code: failure.code, failures: failure.count, suppressed: failure.suppressed,
      since_first_failure_ms: Math.max(0, now - failure.since),
    };
    if (fields.request_id && (/^br-[a-z0-9]+-[0-9]+$/.test(fields.request_id) || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(fields.request_id))) record.request_id = fields.request_id;
    if (fields.machine_id && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(fields.machine_id)) record.machine_id = fields.machine_id;
    if (fields.phase === "connect" || fields.phase === "response") record.phase = fields.phase;
    for (const field of ["elapsed_ms", "connect_ms", "timeout_ms", "pending", "close_code"] as const) {
      const value = fields[field];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) record[field] = Math.round(value);
    }
    try { return this.write(JSON.stringify(record)) !== false; } catch { /* diagnostics must not change delivery or cleanup */ return true; }
  }
}
