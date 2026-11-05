import { getTransport } from "./transport.ts";
import type { ClientConnectionEvent, ClientConnectionEventKind, ClientConnectionTrace } from "../../shared/protocol.ts";

type Context = Pick<ClientConnectionEvent, "connection" | "socket_state" | "visibility" | "online">;
type Detail = Partial<Pick<ClientConnectionEvent, "connection" | "socket_state" | "code" | "elapsed_ms" | "pending" | "request_id" | "attempt" | "result">>;
type Post = (trace: ClientConnectionTrace) => Promise<number>;

function browserPost(): Post | null {
  // Unit/SSR code has no browser transport. In particular, never use Bun's global fetch here.
  if (typeof window === "undefined" || typeof document === "undefined" || typeof document.createElement !== "function" || typeof window.fetch !== "function") return null;
  return async (trace) => (await getTransport().fetch("/api/connection-diagnostics", {
    method: "POST", credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store",
    headers: { "content-type": "application/json" }, body: JSON.stringify(trace), keepalive: true, signal: AbortSignal.timeout(5000),
  })).status;
}

function traceId(): string | null {
  try {
    // randomUUID is absent on plain-HTTP LAN origins; getRandomValues also works there.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch { return null; } // an unavailable diagnostic ID must never prevent the app connecting
}

const live = new Set<ConnectionTrace>();

/** A sign-in on this page lifts the pause a 401 put on reporting; a 403/404 stays disabled. */
export function resumeConnectionTraces(): void { for (const trace of live) trace.resume(); }

/** A bounded breadcrumb trail, not telemetry: only incidents are sent to this app's own server. */
export class ConnectionTrace {
  private readonly id = traceId();
  private readonly events: ClientConnectionEvent[] = [];
  private incidentContext: ClientConnectionEvent[] = [];
  private following: ClientConnectionEvent[] = [];
  private seq = 0;
  private incident = 0;
  private reported = 0;
  private posting = false;
  private disabled = false;
  private unauthorized = false;
  // Bumped by each sign-in, so a 401 answering a report sent before it cannot pause reporting again.
  private signIn = 0;
  private stopped = false;
  private nextPost = -Infinity;
  private readonly target: "local" | "remote";

  constructor(url: string, private context: () => Context, private post: Post | null = browserPost(), private now: () => number = Date.now) {
    // Retain neither the URL nor machine/host names. One connection object already owns one PC.
    live.add(this);
    try { const machine = new URL(url).searchParams.get("machine_id"); this.target = machine && machine !== "local" ? "remote" : "local"; }
    catch { this.target = "local"; }
  }

  record(kind: ClientConnectionEventKind, detail: Detail = {}, incident = false): void {
    if (this.stopped) return;
    try {
      const c = this.context();
      const event: ClientConnectionEvent = {
        seq: ++this.seq, at: this.now(), connection: c.connection, kind,
        socket_state: c.socket_state, visibility: c.visibility, online: c.online,
      };
      // Pick fields explicitly: never accept params, messages, close reasons or arbitrary objects.
      if (detail.socket_state === null || (typeof detail.socket_state === "number" && Number.isInteger(detail.socket_state) && detail.socket_state >= 0 && detail.socket_state <= 3)) event.socket_state = detail.socket_state;
      for (const key of ["connection", "code", "elapsed_ms", "pending", "request_id", "attempt"] as const) {
        const value = detail[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) event[key] = Math.min(604_800_000, Math.round(value));
      }
      if (detail.result === "ok" || detail.result === "refused") event.result = detail.result;
      this.events.push(event);
      if (this.events.length > 32) this.events.shift();
      if (incident) {
        this.incident = event.seq;
        this.incidentContext = this.events.slice(-16);
        this.following = [];
      } else if (this.incident > this.reported) {
        // Keep the trigger even if healthy ping/pong traffic overwrites the recent ring while
        // a report is throttled or offline. Retain at most four following context records.
        this.following.push(event);
        if (this.following.length > 4) this.following.shift();
        while (this.incidentContext.length + this.following.length > 16) this.incidentContext.shift();
      }
      this.flush();
    } catch { /* observing a connection must never affect its authority or delivery */ }
  }

  flush(): void {
    if (this.stopped || this.disabled || this.unauthorized || !this.id || !this.post || this.posting || this.incident <= this.reported || this.now() < this.nextPost) return;
    const incident = this.incident;
    const trace: ClientConnectionTrace = { client_id: this.id, target: this.target, events: [...this.incidentContext, ...this.following] };
    this.posting = true;
    this.nextPost = this.now() + 10_000;
    const signIn = this.signIn;
    try {
      void this.post(trace).then((status) => {
        // A 4xx other than 401/403/404/429 is a refusal of this batch: drop it, never re-post it.
        const refused = status >= 400 && status < 500 && ![401, 403, 404, 429].includes(status);
        if ((status >= 200 && status < 300) || refused) {
          this.reported = Math.max(this.reported, incident);
          if (this.incident <= this.reported) { this.incidentContext = []; this.following = []; }
        }
        if (status === 401 && signIn === this.signIn) this.unauthorized = true;
        if (status === 403 || status === 404) this.disabled = true;
        if (status === 429) this.nextPost = this.now() + 60_000;
      }).catch(() => { /* retained metadata can go with the next connection event, never input */ })
        .finally(() => { this.posting = false; });
    } catch { this.posting = false; }
  }

  resume(): void { this.unauthorized = false; this.signIn++; }

  close(): void { live.delete(this); this.stopped = true; this.disabled = true; this.events.length = 0; this.incidentContext = []; this.following = []; }
}
