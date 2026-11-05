import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError, herdrRpc, socketAddress } from "./client.ts";

/** A real peer: no replacement for Bun.connect or the client's write/drain callbacks. */
async function peer(accept: (socket: Socket) => void) {
  const root = mkdtempSync(join(tmpdir(), "ovis-rpc-write-"));
  const path = join(root, "rpc.sock");
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    accept(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketAddress(path), resolve);
  });
  return { path, connections: () => connections, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  } };
}

it.each(["x", "🙂"])("delivers one complete large %s frame across real socket backpressure", async (character) => {
  const text = character.repeat(2 * 1024 * 1024);
  const chunks: Buffer[] = [];
  let lines = 0;
  // the peer reads nothing until the first write was made, so that write can only be partial
  const started = Promise.withResolvers<void>();
  const fixture = await peer((socket) => {
    socket.pause();
    void started.promise.then(() => socket.resume());
    socket.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
      if (!chunk.includes(10)) return;
      const request = JSON.parse(Buffer.concat(chunks).toString()) as { id: string; method: string; params: { text: string } };
      lines++;
      socket.end(`${JSON.stringify({ id: request.id, result: { method: request.method, text: request.params.text } })}\n`);
    });
  });
  try {
    // the guard is asked before every write: more than one ask is more than one write
    let writes = 0;
    const guard = () => { writes++; started.resolve(); return true; };
    const result = await herdrRpc<{ method: string; text: string }>("fixture.write", { text }, fixture.path, 2_000, guard);
    expect(result).toEqual({ method: "fixture.write", text });
    expect(writes).toBeGreaterThan(1);
    expect(lines).toBe(1);
    expect(fixture.connections()).toBe(1);
  } finally { await fixture.close(); }
});

it("cuts a request short, never completing it, when the sender loses the right to send mid-request", async () => {
  const frame = 8 * 1024 * 1024;
  const chunks: Buffer[] = [];
  const started = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  const fixture = await peer((socket) => {
    socket.pause();
    socket.on("data", (chunk: Buffer) => { chunks.push(Buffer.from(chunk)); });
    socket.on("end", () => ended.resolve());
    // revoked after the first (partial) write; only then does the peer read what was sent
    void started.promise.then(() => socket.resume());
  });
  try {
    let allowed = true;
    let asks = 0;
    const guard = () => {
      asks++;
      const answer = allowed;
      if (asks === 1) { allowed = false; started.resolve(); }
      return answer;
    };
    const error = await herdrRpc("fixture.write", { text: "y".repeat(frame) }, fixture.path, 2_000, guard).catch((e: unknown) => e);
    await ended.promise;
    const received = Buffer.concat(chunks);
    expect(error).toBeInstanceOf(HerdrError);
    expect((error as HerdrError).code).toBe("socket_error");
    expect(asks).toBeGreaterThan(1);
    // herdr got part of one request and no newline: nothing it can act on
    expect(received.length).toBeGreaterThan(0);
    expect(received.length).toBeLessThan(frame);
    expect(received.includes(10)).toBe(false);
    expect(fixture.connections()).toBe(1);
  } finally { await fixture.close(); }
});

it("keeps a connected serialization failure distinct from connect_failed", async () => {
  let received = 0;
  const fixture = await peer((socket) => socket.on("data", (chunk) => { received += chunk.length; }));
  try {
    const params = { toJSON() { throw new Error("fixture serialization failed"); } };
    const error = await herdrRpc("fixture.write", params, fixture.path, 2_000).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(HerdrError);
    expect((error as HerdrError).code).toBe("socket_error");
    expect(received).toBe(0);
  } finally { await fixture.close(); }
});

it("does not reconnect after the peer closes during a large request", async () => {
  const fixture = await peer((socket) => socket.once("data", () => socket.destroy()));
  try {
    const error = await herdrRpc("fixture.write", { text: "x".repeat(8 * 1024 * 1024) }, fixture.path, 2_000)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(HerdrError);
    expect(["closed", "socket_error"]).toContain((error as HerdrError).code);
    expect(fixture.connections()).toBe(1);
  } finally { await fixture.close(); }
});
