import { describe, expect, it } from "bun:test";
import { ClientConnectionLog } from "./client-connection-log.ts";

function body(extra: object = {}) {
  return { client_id: "00000000-0000-4000-8000-000000000001", target: "local", events: [{ seq: 1, at: 1000, connection: 1, kind: "close", socket_state: 3, visibility: "visible", online: true, code: 1005 }], ...extra };
}
function request(value: unknown, headers: Record<string, string> = {}) {
  return new Request("http://fixture/api/connection-diagnostics", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
}

describe("operator-local client diagnostic endpoint", () => {
  it("logs a normalized client report, never raw fields, peer addresses or credentials", async () => {
    const lines: string[] = [];
    const log = new ClientConnectionLog((line) => lines.push(line), () => 1000);
    const value = body({ text: "private-message", token: "private-credential", url: "private-host", events: [{ ...body().events[0], reason: "private-body", params: { text: "private-input" } }] });
    expect((await log.handle(request(value), "private-peer")).status).toBe(204);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("private-");
    expect(JSON.parse(lines[0]!)).toEqual({ time: "1970-01-01T00:00:01.000Z", event: "client.connection_trace", client_reported: true, ...body() });
  });

  it("refuses arbitrary strings, oversized batches and malformed metadata without echoing it", async () => {
    for (const value of [body({ client_id: "private-credential" }), body({ target: "private-host" }), body({ events: Array(17).fill(body().events[0]) }), body({ events: [{ ...body().events[0], kind: "private-message" }] }), body({ events: [{ ...body().events[0], visibility: ["visible"] }] }), body({ events: [{ ...body().events[0], socket_state: 9 }] }), body({ events: [{ ...body().events[0], elapsed_ms: -1 }] })]) {
      const lines: string[] = [];
      const response = await new ClientConnectionLog((line) => lines.push(line)).handle(request(value), "peer");
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("private-");
      expect(lines).toHaveLength(0);
    }
  });

  it("bounds both declared and streamed bodies to 8192 bytes", async () => {
    const log = new ClientConnectionLog(() => {});
    expect((await log.handle(request(body(), { "content-length": "8193" }), "one")).status).toBe(413);
    const data = new TextEncoder().encode(JSON.stringify(body({ padding: "x".repeat(8192) })));
    const stream = new ReadableStream({ start(controller) { controller.enqueue(data); controller.close(); } });
    const response = await log.handle(new Request("http://fixture/api/connection-diagnostics", { method: "POST", headers: { "content-type": "application/json" }, body: stream }), "two");
    expect(response.status).toBe(413);
  });

  it("bounds peer and global report rates even if a caller rotates client IDs or peer keys", async () => {
    let now = 1000; const lines: string[] = [];
    const log = new ClientConnectionLog((line) => lines.push(line), () => now);
    for (let i = 0; i < 4; i++) expect((await log.handle(request(body()), "same-peer")).status).toBe(204);
    const refused = await log.handle(request(body()), "same-peer");
    expect(refused.status).toBe(429); expect(refused.headers.get("retry-after")).toBe("60");
    for (let i = 0; i < 12; i++) expect((await log.handle(request(body()), `other-peer-${i}`)).status).toBe(204);
    expect((await log.handle(request(body()), "yet-another-peer")).status).toBe(429);
    expect(lines).toHaveLength(16);
    now += 60_000;
    expect((await log.handle(request(body()), "same-peer")).status).toBe(204);
  });

  it("charges the global quota only for reports that pass validation", async () => {
    const lines: string[] = [];
    const log = new ClientConnectionLog((line) => lines.push(line), () => 1000);
    for (let i = 0; i < 100; i++) expect((await log.handle(request({ ...body(), target: "x" }), `noisy-${i}`)).status).toBe(400);
    for (let i = 0; i < 16; i++) expect((await log.handle(request(body()), `real-${i}`)).status).toBe(204);
    expect((await log.handle(request(body()), "real-16")).status).toBe(429);
    expect(lines).toHaveLength(16);
  });

  it("bounds report bodies read at once, whatever peer key a caller rotates", async () => {
    const log = new ClientConnectionLog(() => {}, () => 1000);
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const open = (i: number) => log.handle(new Request("http://fixture/api/connection-diagnostics", {
      method: "POST", headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({ start(controller) { controllers.push(controller); } }),
    }), `rotating-${i}`);
    const reading = Array.from({ length: 16 }, (_, i) => open(i));
    expect((await open(16)).status).toBe(429);
    const data = new TextEncoder().encode(JSON.stringify(body()));
    for (const controller of controllers.slice(0, 16)) { controller.enqueue(data); controller.close(); }
    expect((await Promise.all(reading)).map((response) => response.status)).toEqual(Array(16).fill(204));
    expect((await log.handle(request({ ...body(), target: "x" }), "after")).status).toBe(400);
  });

  it("ends a body that keeps trickling in once the deadline for the whole body passes", async () => {
    let now = 1000;
    const log = new ClientConnectionLog(() => {}, () => now);
    const space = new TextEncoder().encode(" ");
    const trickle = new ReadableStream<Uint8Array>({ pull(controller) { now += 4_000; controller.enqueue(space); } });
    const response = await log.handle(new Request("http://fixture/api/connection-diagnostics", { method: "POST", headers: { "content-type": "application/json" }, body: trickle }), "slow");
    expect(response.status).toBe(408);
    expect(now).toBeLessThan(1000 + 30_000);
  });

  it("gives every read slot back when the bodies holding them stop arriving", async () => {
    const log = new ClientConnectionLog(() => {}, () => 1000, 1);
    const stalled = Array.from({ length: 16 }, (_, i) => log.handle(new Request("http://fixture/api/connection-diagnostics", {
      method: "POST", headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }),
    }), `stalled-${i}`));
    expect((await Promise.all(stalled)).map((response) => response.status)).toEqual(Array(16).fill(408));
    expect((await log.handle(request(body()), "after")).status).toBe(204);
  });

  it("returns method/JSON refusals and never fails a client because the log writer threw", async () => {
    const log = new ClientConnectionLog(() => { throw new Error("write failed"); });
    expect((await log.handle(new Request("http://fixture/api/connection-diagnostics"), "one")).status).toBe(405);
    expect((await log.handle(new Request("http://fixture/api/connection-diagnostics", { method: "POST", body: "private-input" }), "two")).status).toBe(400);
    expect((await log.handle(request(body()), "three")).status).toBe(204);
  });
});
