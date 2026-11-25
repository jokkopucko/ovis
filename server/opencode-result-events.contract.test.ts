import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane } from "../shared/protocol.ts";
import * as herdr from "./herdr/client.ts";
import * as prompt from "./prompt.ts";
import { commandInvocations, type CommandSend } from "./outcome.ts";
import { closeOpenCodeNative, onOpenCodePermissionChange, openCodePaneService, startOpenCodeWatch } from "./opencode-native.ts";
import { forgetOpenCodeService, openCodeServiceOptions } from "./opencode-service.ts";
import recording from "./fixtures/opencode-result-events-2.2.2.json";

/**
 * OpenCode 2.2.2's GET /api/event as recorded from an isolated service: a prompt, then a compact. The TUI runs /compact
 * itself and enqueues no message of its text: its result is the compaction it started. Replayed at today's time, as a
 * send is followed for a while only.
 */
const shift = Date.now() - recording.events[0]!.created;
const events = recording.events.map((event) => ({ ...event, created: event.created + shift }));
type Event = (typeof events)[number];
const session = events[0]!.data.sessionID;
const of = (type: string): Event => events.find((event) => event.type === type)!;
const [enqueued, started, ended] = [events.find((event) => event.data.item?.type === "compaction")!, of("session.compaction.started"), of("session.compaction.ended")];
const root = mkdtempSync(join(tmpdir(), "opencode-result-events-"));
const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [] } } as never);
afterAll(() => {
  closeOpenCodeNative();
  rpc.mockRestore();
  delete openCodeServiceOptions.stateDir;
  forgetOpenCodeService();
  rmSync(root, { recursive: true, force: true });
});

const servers: { stop(force: boolean): void }[] = [];
const listeners: (() => void)[] = [];
afterEach(() => {
  closeOpenCodeNative();
  for (const stop of listeners.splice(0)) stop();
  for (const server of servers.splice(0)) server.stop(true);
});

const within = <T>(promise: Promise<T>, what: string, ms = 3_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not happen`)), ms); })]).finally(() => clearTimeout(timer));
};

async function replaying(name: string) {
  const dir = join(root, name);
  const encoder = new TextEncoder();
  const connected = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
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
      }), { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(null, { status: 404 });
  } });
  servers.push(server);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "service.json"), JSON.stringify({ url: server.url.origin, pid: process.pid, password: "x", version: recording.opencode }));
  openCodeServiceOptions.stateDir = dir;
  forgetOpenCodeService();
  // a permission event wakes the pane once every event before it was read; the stream's open wakes it first
  let woken = 0;
  let waiting: { count: number; resolve(): void } | null = null;
  listeners.push(onOpenCodePermissionChange(() => { woken += 1; if (waiting && woken >= waiting.count) { waiting.resolve(); waiting = null; } }));
  const wakes = (count: number): Promise<void> => {
    if (woken >= count) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    waiting = { count, resolve };
    return within(promise, `wake ${count}`);
  };
  const pane = { pane_id: `p_${name}`, agent: "opencode", agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value: session } } as unknown as HerdrPane;
  expect(await openCodePaneService(pane)).not.toBeNull();
  const stream = await within(connected.promise, "the stream opening");
  await wakes(1);
  const send = (...sent: unknown[]) => { for (const event of sent) stream.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); };
  return {
    send,
    async read(): Promise<void> {
      send({ type: "permission.asked", created: Date.now(), data: { sessionID: session } });
      await wakes(woken + 1);
    },
    sent(text: string, at: number): CommandSend & { store: null } {
      const command: CommandSend & { store: null } = { id: `${name}-${at}`, text, at, agent: "opencode", identity: "fixture", screen: "", form: null, store: null,
        invocations: commandInvocations("opencode", text, []) };
      const watch = startOpenCodeWatch(pane, command)!;
      prompt.noteSubmitted(pane.pane_id, text, command, command.at);
      watch.commit(command, [{ typed: text }], []);
      return command;
    },
  };
}

const settledAt = (at: number) => ({ state: "result-observed" as const, evidence: [{ kind: "native" as const, at: new Date(at).toISOString() }] });
const outcomeOf = (sent: CommandSend) => ({ state: sent.outcome?.state, evidence: sent.outcome?.evidence });

describe("OpenCode 2.2.2's /compact settles a Chat send from the compaction it started", () => {
  it("takes the compaction's end, as recorded", async () => {
    const replay = await replaying("recorded");
    const compact = replay.sent("/compact", enqueued.created - 1);
    replay.send(...events.filter((event) => event.created >= enqueued.created));
    await replay.read();
    expect(outcomeOf(compact)).toEqual(settledAt(ended.created));
  });

  it("takes neither a compaction OpenCode began by itself nor one begun before the send", async () => {
    const replay = await replaying("others");
    const compact = replay.sent("/compact", started.created);
    const auto = { reason: "auto" };
    replay.send({ ...started, created: started.created + 1, data: { ...started.data, ...auto, inputID: "msg_auto" } },
      { ...ended, created: started.created + 2, data: { ...ended.data, ...auto } }, { ...ended, created: started.created + 3 });
    await replay.read();
    expect(compact.outcome?.state).not.toBe("result-observed");
    replay.send({ ...started, created: started.created + 4, data: { ...started.data, inputID: "msg_own" } }, { ...ended, created: started.created + 5 });
    await replay.read();
    expect(outcomeOf(compact)).toEqual(settledAt(started.created + 5));
  });

  it("drops the send's watch when its own compaction fails", async () => {
    const replay = await replaying("failed");
    const compact = replay.sent("/compact", enqueued.created - 1);
    replay.send(started, { type: "session.compaction.failed", created: started.created + 1, data: { sessionID: session, reason: "manual", inputID: started.data.inputID } },
      { ...started, created: started.created + 2, data: { ...started.data, inputID: "msg_next" } }, { ...ended, created: started.created + 3 });
    await replay.read();
    expect(compact.outcome?.state).not.toBe("result-observed");
  });

  it("follows no /compact with anything around it, which the TUI sends as a prompt", async () => {
    const replay = await replaying("spaced");
    const spaced = replay.sent("/compact ", enqueued.created - 1);
    replay.send(...events.filter((event) => event.created >= enqueued.created));
    await replay.read();
    expect(spaced.outcome?.state).not.toBe("result-observed");
  });
});
