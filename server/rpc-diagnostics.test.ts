import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError, herdrRpc, socketAddress } from "./herdr/client.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "herdr-rpc-diagnostics-"));
  const path = join(root, "private-herdr.sock");
  let mode: "stall" | "success" | "bad_frame" | "refuse" = "stall";
  let requests = 0;
  // A request marked stall is never answered. It is counted apart: on a busy PC the client's 30 ms
  // can run out before its request is written, or the bytes it wrote can be read only after the
  // test moved on to answering, so how many of them arrive is not the test's to fix.
  let stalled = 0;
  const sockets = new Set<Socket>();
  const daemon = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.split("\n")[0]!);
      buffer = "";
      if (request.params?.stall === true) { stalled++; return; }
      requests++;
      if (mode === "stall") return;
      if (mode === "bad_frame") { socket.end("private-provider-secret\n"); return; }
      if (mode === "refuse") { socket.end(JSON.stringify({ id: request.id, error: { code: "pane_not_found", message: "private-pane-name" } }) + "\n"); return; }
      socket.end(JSON.stringify({ id: request.id, result: { ok: true } }) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => { daemon.once("error", reject); daemon.listen(socketAddress(path), resolve); });
  const lines: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation((line) => { lines.push(String(line)); });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
    warn.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });
  return { path, root, lines, set: (value: typeof mode) => { mode = value; }, requests: () => requests, stalled: () => stalled, records: () => lines.map((line) => JSON.parse(line)) };
}

describe("RPC diagnostic wiring", () => {
  it("logs a timeout once, then one recovery without private parameters or socket paths", async () => {
    const f = await fixture();
    // long enough to connect on a busy PC, so the timeout it logs is the response's
    await expect(herdrRpc("fixture.read", { token: "private-input-secret", stall: true }, f.path, 500)).rejects.toBeInstanceOf(HerdrError);
    await expect(herdrRpc("fixture.read", { stall: true }, f.path, 30)).rejects.toThrow("timed out");
    expect(f.records()).toHaveLength(1);
    expect(f.records()[0]).toMatchObject({ event: "herdr.rpc.failed", code: "timeout", operation: "fixture.read", phase: "response", timeout_ms: 500 });
    expect(f.records()[0].elapsed_ms).toBeGreaterThanOrEqual(495);
    f.set("success");
    expect(await herdrRpc<{ ok: boolean }>("fixture.read", {}, f.path, 1000)).toEqual({ ok: true });
    await herdrRpc("fixture.read", {}, f.path, 1000);
    expect(f.records()).toHaveLength(2);
    expect(f.records()[1]).toMatchObject({ event: "herdr.rpc.recovered", episode_id: f.records()[0].episode_id, failures: 2, suppressed: 1 });
    expect(f.lines.join("\n")).not.toContain(f.root);
    expect(f.lines.join("\n")).not.toContain("private-input-secret");
    expect(f.requests()).toBe(2);
    // the first, with 500 ms, always arrives; the second's 30 ms may run out before it is written
    expect(f.stalled()).toBeGreaterThanOrEqual(1);
    expect(f.stalled()).toBeLessThanOrEqual(2);
  });

  it("logs a bad frame without the daemon's raw text", async () => {
    const f = await fixture();
    f.set("bad_frame");
    await expect(herdrRpc("fixture.read", {}, f.path, 1000)).rejects.toThrow("unparseable frame");
    expect(f.records()).toHaveLength(1);
    expect(f.records()[0].code).toBe("bad_frame");
    expect(f.lines.join("\n")).not.toContain("private-provider-secret");
  });

  it("does not log ordinary application refusals as connection failures", async () => {
    const f = await fixture();
    f.set("refuse");
    await expect(herdrRpc("fixture.read", {}, f.path, 1000)).rejects.toThrow("private-pane-name");
    expect(f.records()).toHaveLength(0);
  });

  it("logs a failed connect without publishing the socket path", async () => {
    const f = await fixture();
    await expect(herdrRpc("fixture.read", {}, join(f.root, "missing.sock"), 1000)).rejects.toThrow("cannot reach herdr");
    expect(f.records()).toHaveLength(1);
    expect(f.records()[0]).toMatchObject({ code: "connect_failed", phase: "connect" });
    expect(f.lines.join("\n")).not.toContain(f.root);
  });

  it("does not log or send a request whose authority guard cancelled it", async () => {
    const f = await fixture();
    await expect(herdrRpc("fixture.read", { text: "private-input-secret" }, f.path, 1000, () => false)).rejects.toThrow("not sent");
    expect(f.records()).toHaveLength(0);
    expect(f.requests()).toBe(0);
  });
});
