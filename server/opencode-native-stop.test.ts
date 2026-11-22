import { afterAll, afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane } from "../shared/protocol.ts";
import { createServer } from "./index.ts";
import { closeOpenCodeNative, openCodeNativeState, openCodePaneService } from "./opencode-native.ts";
import { forgetOpenCodeService, openCodeServiceOptions } from "./opencode-service.ts";

const root = mkdtempSync(join(tmpdir(), "opencode-native-stop-"));
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  closeOpenCodeNative();
});
afterAll(() => {
  delete openCodeServiceOptions.stateDir;
  forgetOpenCodeService();
  rmSync(root, { recursive: true, force: true });
});

const within = <T>(promise: Promise<T>, what: string, ms = 3_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not happen`)), ms); })]).finally(() => clearTimeout(timer));
};

/** a stand-in OpenCode v2 service: its info, any session, and the event stream it holds open */
function opencodeService(name: string) {
  const dir = join(root, name);
  const streamOpened = Promise.withResolvers<void>();
  const streamClosed = Promise.withResolvers<void>();
  const lookupSeen = Promise.withResolvers<void>();
  let held: (() => void)[] | null = null;
  const service = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/info") return Response.json({ version: "2.0.32", pid: process.pid, urls: [], paths: { tmp: dir } });
    if (url.pathname.startsWith("/api/session/")) {
      const answer = () => Response.json({ data: { id: decodeURIComponent(url.pathname.split("/").at(-1)!) } });
      lookupSeen.resolve();
      return held ? new Promise<Response>((resolve) => held!.push(() => resolve(answer()))) : answer();
    }
    if (url.pathname === "/api/event") {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("data: {\"type\":\"server.connected\",\"data\":{}}\n\n")); streamOpened.resolve(); },
        cancel() { streamClosed.resolve(); },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(null, { status: 404 });
  } });
  const release = () => { for (const answer of held?.splice(0) ?? []) answer(); held = null; };
  cleanups.push(() => { release(); service.stop(true); });
  mkdirSync(dir, { recursive: true });
  return {
    dir, service, streamOpened: streamOpened.promise, streamClosed: streamClosed.promise, lookupSeen: lookupSeen.promise,
    hold() { held = []; }, release,
  };
}

function useService(fake: ReturnType<typeof opencodeService>): void {
  writeFileSync(join(fake.dir, "service.json"), JSON.stringify({ url: fake.service.url.origin, pid: process.pid, password: "x", version: "2.0.32" }));
  openCodeServiceOptions.stateDir = fake.dir;
  forgetOpenCodeService();
  closeOpenCodeNative();
}

function server(): ReturnType<typeof createServer> {
  const stateDir = mkdtempSync(join(tmpdir(), "opencode-native-stop-state-"));
  const instance = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false });
  cleanups.push(() => { instance.stop(); rmSync(stateDir, { recursive: true, force: true }); });
  return instance;
}

const opencodePane = (paneId: string) => ({ pane_id: paneId, agent: "opencode", agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value: `ses_${paneId.replace(/[^A-Za-z0-9]/gu, "")}` } }) as unknown as HerdrPane;

it("closes the OpenCode event stream a verified pane opened when the server stops (#1548)", async () => {
  const fake = opencodeService("single");
  useService(fake);
  const instance = server();
  expect(await openCodePaneService(opencodePane("p_stop"))).not.toBeNull();
  await within(fake.streamOpened, "the stream opening");
  instance.stop();
  expect(openCodeNativeState()).toEqual({ stream: false, panes: [] });
  await within(fake.streamClosed, "the stream closing at the service");
});

it("keeps the stream and the verified panes of a server that still runs when another one stops", async () => {
  const fake = opencodeService("shared");
  useService(fake);
  const first = server();
  const second = server();
  expect(await openCodePaneService(opencodePane("p_shared"))).not.toBeNull();
  await within(fake.streamOpened, "the stream opening");
  first.stop();
  expect(openCodeNativeState()).toEqual({ stream: true, panes: ["p_shared"] });
  // a second stop of the same server releases nothing more
  first.stop();
  expect(openCodeNativeState()).toEqual({ stream: true, panes: ["p_shared"] });
  second.stop();
  expect(openCodeNativeState()).toEqual({ stream: false, panes: [] });
  await within(fake.streamClosed, "the stream closing at the service");
});

it("opens no stream for a verification that arrives after the last server stopped", async () => {
  const fake = opencodeService("late");
  useService(fake);
  server().stop();
  expect(await openCodePaneService(opencodePane("p_late"))).toBeNull();
  expect(openCodeNativeState()).toEqual({ stream: false, panes: [] });
  // a server started again verifies panes as before
  server();
  expect(await openCodePaneService(opencodePane("p_late"))).not.toBeNull();
  expect(openCodeNativeState()).toEqual({ stream: true, panes: ["p_late"] });
});

it("keeps a verification under way at the last server's stop from opening a stream once a new server runs", async () => {
  const fake = opencodeService("restart");
  useService(fake);
  const first = server();
  fake.hold();
  const verifying = openCodePaneService(opencodePane("p_restart"));
  await within(fake.lookupSeen, "the session lookup");
  first.stop();
  server();
  fake.release();
  expect(await verifying).toBeNull();
  expect(openCodeNativeState()).toEqual({ stream: false, panes: [] });
});
