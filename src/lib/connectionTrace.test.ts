import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { ClientConnectionTrace } from "../../shared/protocol.ts";
import { ConnectionTrace, resumeConnectionTraces } from "./connectionTrace.ts";
import { nativeTransport, setTransport, type Transport } from "./transport.ts";

const context = () => ({ connection: 1, socket_state: 1, visibility: "visible" as const, online: true });
// A macrotask turn: every promise continuation of the report has run, whatever its depth.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
// Every trace a test opens is closed after it, so resumeConnectionTraces() in a later test reaches only its own.
const opened: ConnectionTrace[] = [];
const open = (...args: ConstructorParameters<typeof ConnectionTrace>) => { const trace = new ConnectionTrace(...args); opened.push(trace); return trace; };
afterEach(() => { for (const trace of opened.splice(0)) trace.close(); });
function fixture(status = 204) {
  let now = 1000;
  const sent: ClientConnectionTrace[] = [];
  const trace = open("wss://private-host/ws?machine_id=private-id&token=private-credential", context, async (batch) => { sent.push(batch); return status; }, () => now);
  return { trace, sent, advance: (ms: number) => { now += ms; } };
}

describe("client connection breadcrumbs", () => {
  it("stays quiet for healthy traffic, then sends bounded context for an incident", () => {
    const { trace, sent } = fixture();
    for (let i = 0; i < 40; i++) trace.record("probe");
    expect(sent).toHaveLength(0);
    trace.record("probe_drop", { pending: 1 }, true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.events).toHaveLength(16);
    expect(sent[0]!.events[0]!.seq).toBe(26);
    expect(sent[0]!.events.at(-1)).toMatchObject({ kind: "probe_drop", pending: 1 });
    expect(JSON.stringify(sent)).not.toContain("private-");
    expect(sent[0]!.target).toBe("remote");
  });

  it("copies metadata explicitly and never sends arbitrary input or close reasons", () => {
    const { trace, sent } = fixture();
    trace.record("close", { code: 1005, ...{ reason: "private-message", text: "private-credential", payload: "private-body" } }, true);
    expect(JSON.stringify(sent)).not.toContain("private-");
    expect(sent[0]!.events[0]).toEqual({ seq: 1, at: 1000, connection: 1, kind: "close", socket_state: 1, visibility: "visible", online: true, code: 1005 });
  });

  it("keeps an old socket's close assigned to its own connection epoch", () => {
    const { trace, sent } = fixture();
    trace.record("close", { connection: 0, socket_state: 3, code: 1005 }, true);
    expect(sent[0]!.events[0]).toMatchObject({ connection: 0, socket_state: 3 });
  });

  it("rate-limits flapping without changing or resending any input", async () => {
    const { trace, sent, advance } = fixture();
    trace.record("close", {}, true); await settle();
    for (let i = 0; i < 100; i++) { trace.record("open"); trace.record("close", {}, true); }
    expect(sent).toHaveLength(1);
    advance(10_000); trace.record("open");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.events).toHaveLength(16);
  });

  it("pins the incident while healthy traffic overwrites the ring during throttling", async () => {
    const { trace, sent, advance } = fixture();
    trace.record("probe_retry", {}, true); await settle();
    advance(1000); trace.record("probe_drop", { pending: 1 }, true);
    for (let i = 0; i < 100; i++) { trace.record("probe"); trace.record("pong"); }
    expect(sent).toHaveLength(1);
    advance(10_000); trace.record("open");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.events.map((event) => event.kind)).toContain("probe_drop");
    expect(sent[1]!.events.length).toBeLessThanOrEqual(16);
  });

  it("retains an incident recorded while an earlier report is in flight", async () => {
    let finish!: (status: number) => void; let now = 0;
    const sent: ClientConnectionTrace[] = [];
    const trace = open("ws://fixture/ws", context, (batch) => { sent.push(batch); return new Promise((resolve) => { finish = resolve; }); }, () => now);
    trace.record("probe_retry", {}, true);
    trace.record("probe_drop", {}, true);
    finish(204); await settle(); now += 10_000;
    trace.record("open");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.events.map((event) => event.kind)).toContain("probe_drop");
    finish(204); await settle();
  });

  it("defers a failed HTTP report until a later connection event, with no new timer", async () => {
    let now = 0, calls = 0;
    const trace = open("ws://fixture/ws", context, async () => { calls++; throw new Error("network unavailable"); }, () => now);
    trace.record("pagehide", {}, true); await settle();
    trace.record("pageshow"); expect(calls).toBe(1);
    now += 10_000; trace.record("open"); expect(calls).toBe(2);
    await settle();
  });

  it("backs off a server rate limit and disables a missing/locked endpoint", async () => {
    const limited = fixture(429);
    limited.trace.record("close", {}, true); await settle();
    limited.advance(10_000); limited.trace.record("open"); expect(limited.sent).toHaveLength(1);
    limited.advance(50_000); limited.trace.record("open"); expect(limited.sent).toHaveLength(2);
    for (const status of [401, 403, 404]) {
      const old = fixture(status); old.trace.record("close", {}, true); await settle();
      old.advance(60_000); old.trace.record("close", {}, true); expect(old.sent).toHaveLength(1);
    }
  });

  it("drops a batch the server refuses with another 4xx instead of re-posting it", async () => {
    for (const status of [400, 405, 413]) {
      const refused = fixture(status);
      refused.trace.record("close", {}, true); await settle();
      for (let i = 0; i < 5; i++) { refused.advance(10_000); refused.trace.record("open"); await settle(); }
      expect(refused.sent).toHaveLength(1);
      refused.advance(10_000); refused.trace.record("close", {}, true);
      expect(refused.sent).toHaveLength(2);
    }
  });

  it("resumes after signing in again on the same page, but a 403/404 stays disabled", async () => {
    const signedOut = fixture(401);
    signedOut.trace.record("close", {}, true); await settle();
    signedOut.advance(60_000); signedOut.trace.record("close", {}, true);
    expect(signedOut.sent).toHaveLength(1);
    resumeConnectionTraces();
    signedOut.trace.record("close", {}, true);
    expect(signedOut.sent).toHaveLength(2);
    for (const status of [403, 404]) {
      const gone = fixture(status);
      gone.trace.record("close", {}, true); await settle();
      resumeConnectionTraces(); gone.advance(60_000); gone.trace.record("close", {}, true);
      expect(gone.sent).toHaveLength(1);
    }
    signedOut.trace.close();
  });

  it("ignores a 401 that answers a report sent before signing in again", async () => {
    let finish!: (status: number) => void; let now = 0;
    const sent: ClientConnectionTrace[] = [];
    const trace = open("ws://fixture/ws", context, (batch) => { sent.push(batch); return new Promise((resolve) => { finish = resolve; }); }, () => now);
    trace.record("close", {}, true);
    resumeConnectionTraces();
    finish(401); await settle();
    now += 60_000; trace.record("close", {}, true);
    expect(sent).toHaveLength(2);
    finish(204); await settle();
    trace.close();
  });

  it("does not throw into the socket when a reporter fails synchronously", () => {
    const trace = open("ws://fixture/ws", context, () => { throw new Error("reporter failed"); });
    expect(() => trace.record("close", {}, true)).not.toThrow();
  });

  it("keeps diagnostics optional when crypto is unavailable, and never needs secure-context randomUUID", () => {
    const uuid = spyOn(crypto, "randomUUID").mockImplementation(() => { throw new Error("not a secure context"); });
    try {
      const normal = fixture(); normal.trace.record("close", {}, true);
      expect(normal.sent).toHaveLength(1);
      const random = spyOn(crypto, "getRandomValues").mockImplementation(() => { throw new Error("crypto unavailable"); });
      try {
        let calls = 0;
        const trace = open("ws://fixture/ws", context, async () => { calls++; return 204; });
        expect(() => trace.record("close", {}, true)).not.toThrow();
        expect(calls).toBe(0);
      } finally { random.mockRestore(); }
    } finally { uuid.mockRestore(); }
  });

  it("uses only a fixed same-origin POST, bounded timeout and keepalive in a browser", async () => {
    const globals = globalThis as unknown as { window?: unknown; document?: unknown };
    const before = { window: globals.window, document: globals.document };
    const requests: { url: string; init: RequestInit }[] = [];
    const post = async (url: string, init: RequestInit) => { requests.push({ url, init }); return { status: 204 }; };
    globals.window = { fetch: post };
    globals.document = { createElement() {} };
    setTransport({ ...nativeTransport, fetch: post as unknown as Transport["fetch"] });
    try {
      const trace = open("wss://private-host/ws?token=private-credential", context);
      trace.record("pagehide", {}, true); await settle();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ url: "/api/connection-diagnostics", init: { method: "POST", credentials: "same-origin", mode: "same-origin", redirect: "error", keepalive: true } });
      expect(requests[0]!.init.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.stringify(requests)).not.toContain("private-");
      expect(requests[0]!.init.headers).toEqual({ "content-type": "application/json" });
      trace.close();
    } finally { globals.window = before.window; globals.document = before.document; setTransport(nativeTransport); }
  });

  it("stops reporting on explicit disposal", async () => {
    const { trace, sent, advance } = fixture();
    trace.record("close", {}, true); await settle(); trace.close(); advance(60_000);
    trace.record("close", {}, true); expect(sent).toHaveLength(1);
  });
});
