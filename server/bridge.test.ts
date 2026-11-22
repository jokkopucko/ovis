import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import { descriptorLive, loopbackRelay, registerBridge, RELAY_CLIENT_AHEAD_BYTES, relayTarget, type BridgeDescriptor } from "./bridge.ts";
import { guardLibrary, guardPath, OwnerGuardReleaseFailed } from "./owner-guard.ts";
import { readProcessBirth } from "./process-owner.ts";

let root = "", path = "";
const earlierBirth = { platform: process.platform, value: process.platform === "linux" ? `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:1` : process.platform === "darwin" ? "Thu Jan 1 00:00:00 1970" : "1" };
const others: Bun.Subprocess<"pipe", "ignore", "ignore">[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bridge-registry-"));
  path = join(root, "bridges", "socket.json");
  mkdirSync(join(root, "bridges"));
});
afterEach(async () => {
  for (const other of others.splice(0)) { other.stdin.end(); await other.exited; }
  rmSync(root, { recursive: true, force: true });
});

function other() {
  const child = Bun.spawn([process.execPath, "-e", "for await (const _ of console) break;"], { stdin: "pipe", stdout: "ignore", stderr: "ignore", windowsHide: true });
  others.push(child);
  return child;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Signal 0 to `pid` is refused (EPERM), as another user's or a protected process refuses it; every other PID is probed for real. */
function refusing(pid: number) {
  const kill = process.kill.bind(process);
  return spyOn(process, "kill").mockImplementation(((target: number, signal?: NodeJS.Signals | number) => {
    if (target === pid) throw Object.assign(new Error(`kill ${target} EPERM`), { code: "EPERM" });
    return kill(target, signal);
  }) as typeof process.kill);
}
function descriptor(fields: Partial<BridgeDescriptor> & { pid: number }): string {
  return JSON.stringify({ port: 1, token: "old-bridge-secret", socket_path: "/old.sock", bridge_protocol: 1, bundle_version: "old", ...fields });
}
const read = () => JSON.parse(readFileSync(path, "utf8")) as BridgeDescriptor;

describe("bridge registration", () => {
  it("registers its PID with a birth and a generation", () => {
    const registration = registerBridge(4242, "new-token", { path });
    expect(registration.registered).toBe(true);
    const registered = read();
    expect(registered).toMatchObject({ port: 4242, token: "new-token", pid: process.pid, birth: { platform: process.platform } });
    expect(registered.generation).toBeString();
    expect(descriptorLive(registered)).toBe(true);
    registration.close();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(guardPath(path))).toBe(true);
  });

  it("replaces a descriptor whose PID another process now holds", () => {
    const reused = other();
    writeFileSync(path, descriptor({ pid: reused.pid, generation: "crashed", birth: earlierBirth }));
    registerBridge(4242, "new-token", { path });
    expect(read()).toMatchObject({ port: 4242, pid: process.pid });
    expect(alive(reused.pid)).toBe(true);
  });

  it("replaces a descriptor whose PID a process it may not signal now holds", () => {
    const reused = other();
    const reading = readProcessBirth(reused.pid);
    if (reading.state !== "identified") throw new Error(`no birth for ${reused.pid}`);
    const refused = refusing(reused.pid);
    try {
      writeFileSync(path, descriptor({ pid: reused.pid, generation: "crashed", birth: earlierBirth }));
      expect(registerBridge(4242, "new-token", { path }).registered).toBe(true);
      expect(read()).toMatchObject({ port: 4242, pid: process.pid });
      // a bridge runs as this user, which may always signal it: outside Windows, a refused probe
      // names someone else's process even under its recorded birth or an older version's PID-only
      // descriptor. On Windows another logon session of this user refuses it too, so the birth decides.
      const windows = process.platform === "win32";
      for (const fields of [{ birth: reading.birth }, {}]) {
        writeFileSync(path, descriptor({ pid: reused.pid, generation: "refused", ...fields }));
        expect(descriptorLive(read())).toBe(windows);
        expect(registerBridge(4243, "next-token", { path }).registered).toBe(!windows);
        expect(read().pid).toBe(windows ? reused.pid : process.pid);
      }
    } finally { refused.mockRestore(); }
    expect(alive(reused.pid)).toBe(true);
  });

  it("keeps a live bridge's descriptor, and an older version's whose PID runs", () => {
    const bridge = other();
    const reading = readProcessBirth(bridge.pid);
    if (reading.state !== "identified") throw new Error(`no birth for ${bridge.pid}`);
    for (const text of [descriptor({ pid: bridge.pid, generation: "live", birth: reading.birth }), descriptor({ pid: bridge.pid })]) {
      writeFileSync(path, text);
      const registration = registerBridge(4242, "new-token", { path });
      expect(registration.registered).toBe(false);
      expect(readFileSync(path, "utf8")).toBe(text);
      registration.close();
      expect(readFileSync(path, "utf8")).toBe(text);
    }
  });

  it("keeps a live bridge's descriptor whose recorded birth is malformed", () => {
    // regression: a missing, numeric or empty birth once read as another process's, and the live
    // bridge's descriptor and credential were overwritten
    const bridge = other();
    for (const birth of [{ platform: process.platform }, { platform: process.platform, value: 7 }, { platform: process.platform, value: "" }, { platform: process.platform, value: "an earlier process" }, null]) {
      const text = descriptor({ pid: bridge.pid, generation: "live", birth: birth as never });
      writeFileSync(path, text);
      const registration = registerBridge(4242, "new-token", { path });
      expect(readFileSync(path, "utf8")).toBe(text);
      expect(descriptorLive(JSON.parse(text))).toBe(true);
      registration.close();
      expect(readFileSync(path, "utf8")).toBe(text);
    }
    expect(alive(bridge.pid)).toBe(true);
  });

  it("refuses a descriptor that changed after it was sampled", () => {
    const reused = other(), bridge = other();
    const reading = readProcessBirth(bridge.pid);
    if (reading.state !== "identified") throw new Error(`no birth for ${bridge.pid}`);
    for (const replacement of [descriptor({ pid: bridge.pid, generation: "won", birth: reading.birth }), descriptor({ pid: reused.pid, generation: "other", birth: earlierBirth })]) {
      writeFileSync(path, descriptor({ pid: reused.pid, generation: "crashed", birth: earlierBirth }));
      const registration = registerBridge(4242, "new-token", { path, sampled() { writeFileSync(path, replacement); } });
      expect(registration.registered).toBe(false);
      expect(readFileSync(path, "utf8")).toBe(replacement);
      registration.close();
      expect(readFileSync(path, "utf8")).toBe(replacement);
    }
    expect(readdirSync(join(root, "bridges")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not remove another generation's descriptor on close", () => {
    const registration = registerBridge(4242, "new-token", { path });
    const later = JSON.stringify({ ...read(), generation: "a later registration" });
    writeFileSync(path, later);
    registration.close();
    expect(readFileSync(path, "utf8")).toBe(later);
  });

  it("fails a registration whose guard was not released, and logs a close that was not clean", () => {
    // one failing native call: the POSIX unlock, or Windows' UnlockFileEx; the real close still runs
    const fail = () => {
      if (process.platform === "win32") guardLibrary.windows = (calls) => ({ ...calls, UnlockFileEx: (...args: Parameters<typeof calls.UnlockFileEx>) => (calls.UnlockFileEx(...args), 0) });
      else guardLibrary.posix = (calls) => ({ ...calls, flock: (fd, operation) => operation === 8 ? -1 : calls.flock(fd, operation) });
    };
    const restore = () => { delete guardLibrary.posix; delete guardLibrary.windows; };
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      fail();
      expect(() => registerBridge(4242, "new-token", { path })).toThrow(OwnerGuardReleaseFailed);
      restore();
      rmSync(path);
      const registration = registerBridge(4242, "new-token", { path });
      fail();
      registration.close();
      expect(String(logged.mock.calls[0]?.[0])).toStartWith(`The bridge descriptor ${path} may have been left in place: ${guardPath(path)} was not released cleanly: unlocking failed`);
      expect(String(logged.mock.calls[0]?.[0])).not.toContain("new-token");
    } finally {
      restore();
      logged.mockRestore();
    }
    registerBridge(4243, "next-token", { path }).close();
  });

  it("fails closed when the guard is unavailable", () => {
    const reused = other();
    const stale = descriptor({ pid: reused.pid, generation: "crashed", birth: earlierBirth });
    writeFileSync(path, stale);
    const original = guardLibrary.path;
    const logged = spyOn(console, "error").mockImplementation(() => {});
    guardLibrary.path = join(root, "missing-libc.so.6");
    let message = "";
    try {
      const registration = registerBridge(4242, "new-token", { path });
      expect(registration.registered).toBe(false);
      registration.close();
      message = String(logged.mock.calls[0]?.[0]);
    } finally {
      guardLibrary.path = original;
      logged.mockRestore();
    }
    expect(readFileSync(path, "utf8")).toBe(stale);
    expect(message).toStartWith(`This bridge was not registered (descriptor ${path}): the file lock could not be loaded`);
    expect(message).not.toContain("old-bridge-secret");
    expect(message).not.toContain("new-token");
  });
});

describe("loopback relay", () => {
  const stops: (() => void)[] = [];
  afterEach(() => { for (const stop of stops.splice(0)) stop(); });
  function relayTo(port: number): number {
    const relay = loopbackRelay("127.0.0.1", port);
    stops.push(() => relay.stop());
    return relay.port;
  }

  it("passes requests, a large answer and a WebSocket through to the server", async () => {
    const big = "x".repeat(8 * 1024 * 1024);
    const server = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch(request, srv) {
        if (new URL(request.url).pathname === "/ws") return srv.upgrade(request) ? undefined : new Response("no", { status: 400 });
        return new Response(new URL(request.url).pathname === "/big" ? big : `${request.method} ${request.headers.get("authorization")}`);
      },
      websocket: { message(ws, message) { ws.send(`echo ${message}`); } },
    });
    stops.push(() => server.stop(true));
    const port = relayTo(server.port!);
    expect(port).not.toBe(server.port);
    expect(await (await fetch(`http://127.0.0.1:${port}/api/bridge`, { headers: { authorization: "Bearer t" } })).text()).toBe("GET Bearer t");
    expect((await (await fetch(`http://127.0.0.1:${port}/big`)).text()).length).toBe(big.length);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const echoed = new Promise<string>((resolve, reject) => { ws.onmessage = (event) => resolve(String(event.data)); ws.onerror = () => reject(new Error("WebSocket failed")); });
    ws.onopen = () => ws.send("hi");
    expect(await echoed).toBe("echo hi");
    ws.close();
  });

  it("makes the server wait for a client that stops reading, then delivers every byte", async () => {
    const size = 64 * 1024 * 1024;
    const piece = 16 * 1024;
    const blocked = Promise.withResolvers<"blocked">();
    const sent = Promise.withResolvers<"sent">();
    const payload = new Uint8Array(size);
    for (let i = 0; i < size; i++) payload[i] = (i ^ (i >>> 13)) & 0xff;
    type Writer = { data: { at: number }; write(chunk: Uint8Array): number; end(): void };
    const pump = (socket: Writer): void => {
      if (socket.data.at === size) { sent.resolve("sent"); socket.end(); return; }
      const want = Math.min(piece, size - socket.data.at);
      const written = Math.max(socket.write(payload.subarray(socket.data.at, socket.data.at + want)), 0);
      socket.data.at += written;
      if (written < want) { blocked.resolve("blocked"); return; }
      setImmediate(() => pump(socket));
    };
    const server = Bun.listen<{ at: number }>({ hostname: "127.0.0.1", port: 0, socket: {
      open(socket) { socket.data = { at: 0 }; pump(socket); },
      drain: pump,
      data() {},
    } });
    stops.push(() => server.stop(true));
    const received = new Uint8Array(size);
    let filled = 0;
    const done = Promise.withResolvers<void>();
    const client = await Bun.connect({ hostname: "127.0.0.1", port: relayTo(server.port), socket: {
      open(socket) { socket.pause(); },
      data(_socket, data) { received.set(data.subarray(0, size - filled), filled); filled += data.byteLength; },
      close() { done.resolve(); },
    } });
    expect(await Promise.race([blocked.promise, sent.promise])).toBe("blocked");
    client.resume();
    await done.promise;
    expect(filled).toBe(size);
    expect(Buffer.compare(received, payload)).toBe(0);
  });

  async function stuckUpstream(total: number): Promise<{ client: Socket; relay: { stop(): void }; written: Promise<void>; clientClosed: Promise<void>; upstreamClosed: Promise<void> }> {
    const upstreamClosed = Promise.withResolvers<void>();
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
      open(socket) { socket.pause(); },
      data() {},
      close() { upstreamClosed.resolve(); },
    } });
    stops.push(() => server.stop(true));
    const relay = loopbackRelay("127.0.0.1", server.port);
    stops.push(() => relay.stop());
    const written = Promise.withResolvers<void>();
    const clientClosed = Promise.withResolvers<void>();
    const chunk = new Uint8Array(1024 * 1024).fill(3);
    let sent = 0;
    const push = (socket: Socket) => {
      while (sent < total) {
        const want = Math.min(chunk.byteLength, total - sent);
        const accepted = socket.write(chunk.subarray(0, want));
        if (accepted <= 0) return;
        sent += accepted;
        if (accepted < want) return;
      }
      written.resolve();
    };
    const client = await Bun.connect({ hostname: "127.0.0.1", port: relay.port, socket: { open: push, drain: push, data() {}, close() { clientClosed.resolve(); } } });
    return { client, relay, written: written.promise, clientClosed: clientClosed.promise, upstreamClosed: upstreamClosed.promise };
  }

  it("lets go of a server that reads nothing once its client leaves", async () => {
    const { client, written, upstreamClosed } = await stuckUpstream(16 * 1024 * 1024);
    await written;
    client.terminate();
    await upstreamClosed;
  });

  it("lets go of a server that reads nothing when it stops", async () => {
    const { relay, written, upstreamClosed } = await stuckUpstream(16 * 1024 * 1024);
    await written;
    relay.stop();
    await upstreamClosed;
  });

  it("cuts off a client that gets too far ahead of a server that reads nothing", async () => {
    const { clientClosed, upstreamClosed } = await stuckUpstream(RELAY_CLIENT_AHEAD_BYTES + 16 * 1024 * 1024);
    await Promise.all([clientClosed, upstreamClosed]);
  });

  // macOS gives its loopback interface 127.0.0.1 alone
  it.skipIf(process.platform === "darwin")("reaches a server on another loopback address", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.2", fetch: () => new Response("two") });
    stops.push(() => server.stop(true));
    expect(relayTarget("127.0.0.2")).toBe("127.0.0.2");
    const relay = loopbackRelay("127.0.0.2", server.port!);
    stops.push(() => relay.stop());
    expect(await (await fetch(`http://127.0.0.1:${relay.port}/`)).text()).toBe("two");
  });

  it("closes a connection when nothing listens behind it", async () => {
    const gone = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const closed = gone.port;
    gone.stop(true);
    await expect(fetch(`http://127.0.0.1:${relayTo(closed)}/`, { signal: AbortSignal.timeout(5000) })).rejects.toThrow();
  });

  it("relays an IP address that does not answer on 127.0.0.1, and never a host name", () => {
    expect(["127.0.0.2", "100.64.0.7", "::1", "[FD7A:115C:A1E0::7]"].map(relayTarget)).toEqual(["127.0.0.2", "100.64.0.7", "::1", "fd7a:115c:a1e0::7"]);
    // 127.0.0.1 and a wildcard need none; a host name may resolve elsewhere by the next connection
    expect(["127.0.0.1", "0.0.0.0", "::", "[::]", "localhost", "pc.example", "pc.tail1234.ts.net"].map(relayTarget)).toEqual([null, null, null, null, null, null, null]);
  });
});
