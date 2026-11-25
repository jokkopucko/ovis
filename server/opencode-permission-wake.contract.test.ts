import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane } from "../shared/protocol.ts";
import * as herdr from "./herdr/client.ts";
import { closeOpenCodeNative, onOpenCodePermissionChange, openCodePaneService } from "./opencode-native.ts";
import { forgetOpenCodeService, openCodeServiceOptions } from "./opencode-service.ts";
import recording from "./fixtures/opencode-permission-2.2.2.json";

/**
 * The permission events of OpenCode 2.2.2's GET /api/event, replayed as recorded: two sessions of one directory, each
 * request asked and then replied. A wake names the verified pane of the event's session; the stream's every open
 * names every pane on it, since what it missed while down is gone.
 */
const [first, second] = [...new Set(recording.events.map((event) => event.data.sessionID))] as [string, string];
const root = mkdtempSync(join(tmpdir(), "opencode-permission-wake-"));
const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [] } } as never);
afterAll(() => {
  closeOpenCodeNative();
  rpc.mockRestore();
  delete openCodeServiceOptions.stateDir;
  forgetOpenCodeService();
  rmSync(root, { recursive: true, force: true });
});

function recordedService(name: string) {
  const dir = join(root, name);
  const encoder = new TextEncoder();
  let connected = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const cancelled = Promise.withResolvers<void>();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/info") return Response.json({ version: recording.opencode, pid: process.pid });
    if (url.pathname.startsWith("/api/session/")) return Response.json({ data: { id: decodeURIComponent(url.pathname.split("/").at(-1)!) } });
    if (url.pathname === "/api/event") {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("data: {\"type\":\"server.connected\",\"data\":{}}\n\n"));
          connected.resolve(controller);
        },
        cancel() { cancelled.resolve(); },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(null, { status: 404 });
  } });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "service.json"), JSON.stringify({ url: server.url.origin, pid: process.pid, password: "x", version: recording.opencode }));
  return {
    dir, server,
    connection: () => connected.promise,
    cancelled: cancelled.promise,
    expectConnection() { connected = Promise.withResolvers(); },
    send(controller: ReadableStreamDefaultController<Uint8Array>, ...events: unknown[]) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
  };
}

const pane = (paneId: string, session: string) => ({ pane_id: paneId, agent: "opencode", agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value: session } }) as unknown as HerdrPane;
const within = <T>(promise: Promise<T>, what: string, ms = 3_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not happen`)), ms); })]).finally(() => clearTimeout(timer));
};

function wakes() {
  const seen: string[] = [];
  let waiting: { count: number; resolve(): void } | null = null;
  const stop = onOpenCodePermissionChange((paneId) => {
    seen.push(paneId);
    if (waiting && seen.length >= waiting.count) { waiting.resolve(); waiting = null; }
  });
  const reach = (count: number): Promise<void> => {
    if (seen.length >= count) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    waiting = { count, resolve };
    return within(promise, `wake ${count}`);
  };
  return { seen, reach, stop };
}

const services: { server: { stop(force: boolean): void } }[] = [];
const listeners: (() => void)[] = [];
afterEach(() => {
  closeOpenCodeNative();
  for (const stop of listeners.splice(0)) stop();
  for (const service of services.splice(0)) service.server.stop(true);
});

async function verified(name: string) {
  const service = recordedService(name);
  services.push(service);
  openCodeServiceOptions.stateDir = service.dir;
  forgetOpenCodeService();
  const woken = wakes();
  listeners.push(woken.stop);
  expect(await openCodePaneService(pane("p_first", first))).not.toBeNull();
  const stream = await within(service.connection(), "the stream opening");
  await woken.reach(1);
  expect(await openCodePaneService(pane("p_second", second))).not.toBeNull();
  expect(woken.seen.splice(0)).toEqual(["p_first"]);
  return { service, stream, woken };
}

describe("OpenCode 2.2.2 permission events wake the prompt watch of their session's pane", () => {
  it("wakes the pane of each recorded event's session only, two sessions of one directory apart", async () => {
    const { service, stream, woken } = await verified("replay");
    service.send(stream, { type: "session.execution.succeeded", created: 1, data: { sessionID: first } }, ...recording.events);
    await woken.reach(recording.events.length);
    expect(woken.seen).toEqual(recording.events.map((event) => event.data.sessionID === first ? "p_first" : "p_second"));
  });

  it("wakes again for a duplicate, and for a reply that comes before its ask; a session no pane holds wakes none", async () => {
    const { service, stream, woken } = await verified("disorder");
    const [asked, replied] = recording.events as [typeof recording.events[number], typeof recording.events[number]];
    const stranger = { ...asked, data: { ...asked.data, sessionID: "ses_nobody" } };
    const last = recording.events.at(-1)!;
    service.send(stream, replied, stranger, asked, asked);
    service.send(stream, last);
    await woken.reach(4);
    expect(woken.seen).toEqual(["p_first", "p_first", "p_first", "p_second"]);
  });

  it("wakes every pane on the stream when it opens again, as the events it missed are gone", async () => {
    const { service, stream, woken } = await verified("dropped");
    service.expectConnection();
    service.send(stream, recording.events[0]);
    await woken.reach(1);
    stream.close();
    await within(service.connection(), "the stream opening again");
    await woken.reach(3);
    expect(woken.seen.slice(1).sort()).toEqual(["p_first", "p_second"]);
  });

  it("wakes a pane for the session its newest verification found, whichever verification ends last", async () => {
    const service = recordedService("superseded");
    services.push(service);
    openCodeServiceOptions.stateDir = service.dir;
    forgetOpenCodeService();
    const woken = wakes();
    listeners.push(woken.stop);
    const olderAsked = Promise.withResolvers<void>();
    const olderRoots = Promise.withResolvers<unknown>();
    let calls = 0;
    rpc.mockImplementation((async () => {
      calls += 1;
      if (calls === 1) { olderAsked.resolve(); return olderRoots.promise; }
      return { process_info: { foreground_processes: [] } };
    }) as never);
    try {
      const older = openCodePaneService(pane("p_moved", first));
      await within(olderAsked.promise, "the older verification's process read");
      expect(await openCodePaneService(pane("p_moved", second))).not.toBeNull();
      const stream = await within(service.connection(), "the stream opening");
      await woken.reach(1);
      olderRoots.resolve({ process_info: { foreground_processes: [] } });
      expect(await older).not.toBeNull();
      woken.seen.splice(0);
      const [ofFirst, ofSecond] = [recording.events[0], recording.events.at(-1)];
      service.send(stream, ofSecond);
      await woken.reach(1);
      service.send(stream, ofFirst, ofSecond, ofSecond);
      await woken.reach(3);
      expect(woken.seen).toEqual(["p_moved", "p_moved", "p_moved"]);
    } finally { rpc.mockResolvedValue({ process_info: { foreground_processes: [] } } as never); }
  });

  it("follows a service that replaced the first: its events wake, and the first's stream is gone", async () => {
    const { service: old, woken } = await verified("before-swap");
    const replaced = recordedService("after-swap");
    services.push(replaced);
    openCodeServiceOptions.stateDir = replaced.dir;
    forgetOpenCodeService();
    expect(await openCodePaneService(pane("p_first", first))).not.toBeNull();
    const stream = await within(replaced.connection(), "the new service's stream opening");
    await within(old.cancelled, "the first service's stream closing");
    await woken.reach(1);
    expect(woken.seen.splice(0)).toEqual(["p_first"]);
    replaced.send(stream, recording.events.at(-1), recording.events[0]);
    await woken.reach(1);
    expect(woken.seen).toEqual(["p_first"]);
  });
});
