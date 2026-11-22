import { afterEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_ASK_EVENTS, type PiAskBridgeState, type PiBridgeCommands } from "../shared/pi-ask-bridge.ts";
import { createPiAskBridge, piAgentDir, type PiAskBridge, type PiEventBus } from "./pi-ask.ts";
import fixture from "../server/fixtures/pi-ask-user-1.2.0-bridge.json";

const posix = process.platform !== "win32";
const roots: string[] = [];
const bridges: PiAskBridge[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** pi's event bus (core/event-bus.js): a node EventEmitter behind on/emit. */
function bus(): PiEventBus & { emitted: { channel: string; data: unknown }[] } {
  const emitter = new EventEmitter();
  const emitted: { channel: string; data: unknown }[] = [];
  return {
    emitted,
    emit: (channel, data) => { emitted.push({ channel, data }); emitter.emit(channel, data); },
    on: (channel, handler) => { emitter.on(channel, handler); return () => emitter.off(channel, handler); },
  };
}

function socketPath(): string {
  // short: a unix socket path must fit in about 100 bytes
  const root = mkdtempSync(join(tmpdir(), "pab-"));
  roots.push(root);
  return join(root, "ask", "4242.sock");
}

const ui = (file = "/sessions/one.jsonl", branch: () => unknown = () => []) => ({ hasUI: true, sessionManager: { getSessionFile: () => file, getBranch: branch } });
const started = { version: 1, flowId: "tool:call-1", toolCallId: "call-1", source: "tool", title: "Pick", questions: [{ id: "q", prompt: "Which?", options: [{ value: "a", label: "A" }] }], createdAt: 1 };

async function state(path: string): Promise<PiAskBridgeState> {
  return await (await fetch("http://localhost/v1/state", { unix: path })).json() as PiAskBridgeState;
}

async function listed(path: string): Promise<PiBridgeCommands> {
  return await (await fetch("http://localhost/v1/commands", { unix: path })).json() as PiBridgeCommands;
}

async function submit(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch("http://localhost/v1/submit", { unix: path, method: "POST", body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

describe("pi-ask bridge extension", () => {
  it("serves the open forms on a socket only the user can open", async () => {
    if (!posix) return;
    const events = bus();
    const path = socketPath();
    const bridge = createPiAskBridge({ events, socketPath: path, pid: 4242 });
    bridges.push(bridge);

    await bridge.start(ui());

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    expect(await state(path)).toEqual({ version: 1, pid: 4242, sessionFile: "/sessions/one.jsonl", flows: [], openCalls: [] });
    events.emit(PI_ASK_EVENTS.started, started);
    const { version: _version, ...flow } = started;
    expect((await state(path)).flows).toEqual([flow]);
    events.emit(PI_ASK_EVENTS.completed, { version: 1, flowId: "tool:call-1", result: {}, source: "tool", completedAt: 2 });
    expect((await state(path)).flows).toEqual([]);
  });

  it("relays an answer as pi-ask's submit event and returns its submit-result", async () => {
    if (!posix) return;
    const events = bus();
    // pi-ask's runtime (remote-ask.ts): every submit is answered on submit-result with its requestId
    events.on(PI_ASK_EVENTS.submit, (data) => {
      const { requestId, flowId } = data as { requestId: string; flowId: string };
      events.emit(PI_ASK_EVENTS.submitResult, { version: 1, requestId, flowId, ok: true });
    });
    const path = socketPath();
    const bridge = createPiAskBridge({ events, socketPath: path, pid: 4242 });
    bridges.push(bridge);
    await bridge.start(ui());
    events.emit(PI_ASK_EVENTS.started, started);
    const response = { kind: "answer", mode: "submit", answers: { q: { values: ["a"] } } };

    expect(await submit(path, { flowId: "tool:call-1", createdAt: 1, sessionFile: "/sessions/one.jsonl", response })).toEqual({ status: 200, body: { ok: true } });

    const sent = events.emitted.find((event) => event.channel === PI_ASK_EVENTS.submit)?.data as Record<string, unknown>;
    expect(sent).toMatchObject({ version: 1, flowId: "tool:call-1", response });
    expect(sent["requestId"]).toEqual(expect.stringMatching(/^herdr-web-ui-/));
  });

  it("passes pi-ask's refusal on and never submits to a form it was not told about", async () => {
    if (!posix) return;
    const events = bus();
    events.on(PI_ASK_EVENTS.submit, (data) => {
      const { requestId, flowId } = data as { requestId: string; flowId: string };
      events.emit(PI_ASK_EVENTS.submitResult, { version: 1, requestId, flowId, ok: false, error: "invalid_answer", message: "Unknown option value" });
    });
    const path = socketPath();
    const bridge = createPiAskBridge({ events, socketPath: path, pid: 4242 });
    bridges.push(bridge);
    await bridge.start(ui());

    expect((await submit(path, { flowId: "tool:other", createdAt: 1, sessionFile: "/sessions/one.jsonl", response: { kind: "cancel" } })).body).toMatchObject({ ok: false, error: "flow_not_found" });
    expect(events.emitted.some((event) => event.channel === PI_ASK_EVENTS.submit)).toBe(false);
    events.emit(PI_ASK_EVENTS.started, started);
    expect((await submit(path, { flowId: "tool:call-1", createdAt: 1, sessionFile: "/sessions/one.jsonl", response: { kind: "cancel" } })).body).toEqual({ ok: false, error: "invalid_answer", message: "Unknown option value" });
    expect((await submit(path, { response: {} })).status).toBe(400);
  });

  it("never hands an answer to a form reopened for the same call, or to another session", async () => {
    if (!posix) return;
    const events = bus();
    const path = socketPath();
    let file = "/sessions/one.jsonl";
    const bridge = createPiAskBridge({ events, socketPath: path, pid: 4242 });
    bridges.push(bridge);
    await bridge.start({ hasUI: true, sessionManager: { getSessionFile: () => file } });
    events.emit(PI_ASK_EVENTS.started, { ...started, createdAt: 2 });

    expect((await submit(path, { flowId: "tool:call-1", createdAt: 1, sessionFile: file, response: { kind: "cancel" } })).body).toMatchObject({ ok: false, error: "flow_not_found" });
    file = "/sessions/two.jsonl";
    expect((await submit(path, { flowId: "tool:call-1", createdAt: 2, sessionFile: "/sessions/one.jsonl", response: { kind: "cancel" } })).body).toMatchObject({ ok: false, error: "flow_not_found" });
    expect(events.emitted.some((event) => event.channel === PI_ASK_EVENTS.submit)).toBe(false);
  });

  it("forgets a form pi-ask says is gone, which it closed without a completed event", async () => {
    if (!posix) return;
    const events = bus();
    // pi-ask's runtime after its component was disposed: the flow is no longer active
    events.on(PI_ASK_EVENTS.submit, (data) => {
      const { requestId, flowId } = data as { requestId: string; flowId: string };
      events.emit(PI_ASK_EVENTS.submitResult, { version: 1, requestId, flowId, ok: false, error: "flow_not_found", message: "Ask flow is not active." });
    });
    const path = socketPath();
    const bridge = createPiAskBridge({ events, socketPath: path, pid: 4242 });
    bridges.push(bridge);
    await bridge.start(ui());
    events.emit(PI_ASK_EVENTS.started, started);

    expect((await submit(path, { flowId: "tool:call-1", createdAt: 1, sessionFile: "/sessions/one.jsonl", response: { kind: "cancel" } })).body).toMatchObject({ ok: false, error: "flow_not_found" });
    expect((await state(path)).flows).toEqual([]);
  });

  it("reports the ask_user calls open on pi's live branch, which a /tree move changes", async () => {
    if (!posix) return;
    const path = socketPath();
    const entries = fixture.transcript.slice(1);
    let leaf = 2;
    const bridge = createPiAskBridge({ events: bus(), socketPath: path, pid: 4242 });
    bridges.push(bridge);
    await bridge.start(ui("/sessions/one.jsonl", () => entries.slice(0, leaf + 1)));

    expect((await state(path)).openCalls).toEqual(["toolu_feat1202ask"]);
    leaf = entries.length - 1;
    expect((await state(path)).openCalls).toEqual([]);
    // back before the dismissal, as /tree does without writing to the file
    leaf = 2;
    expect((await state(path)).openCalls).toEqual(["toolu_feat1202ask"]);
  });

  it("says nothing of open calls when pi cannot tell its branch", async () => {
    if (!posix) return;
    const path = socketPath();
    const bridge = createPiAskBridge({ events: bus(), socketPath: path, pid: 4242 });
    bridges.push(bridge);
    await bridge.start(ui("/sessions/one.jsonl", () => { throw new Error("no branch"); }));
    expect((await state(path)).openCalls).toBeNull();
  });

  it("answers timeout when pi-ask never confirms", async () => {
    if (!posix) return;
    const events = bus();
    const path = socketPath();
    const bridge = createPiAskBridge({ events, socketPath: path, pid: 4242, submitTimeoutMs: 50 });
    bridges.push(bridge);
    await bridge.start(ui());
    events.emit(PI_ASK_EVENTS.started, started);

    expect(await submit(path, { flowId: "tool:call-1", createdAt: 1, sessionFile: "/sessions/one.jsonl", response: { kind: "cancel" } })).toEqual({ status: 504, body: { ok: false, error: "timeout", message: "pi-ask did not confirm the answer." } });
  });

  it("serves nothing without a UI or on Windows, and removes its socket on shutdown", async () => {
    if (!posix) return;
    const headless = socketPath();
    const quiet = createPiAskBridge({ events: bus(), socketPath: headless, pid: 4242 });
    bridges.push(quiet);
    await quiet.start({ hasUI: false, sessionManager: { getSessionFile: () => "/x.jsonl" } });
    expect(existsSync(headless)).toBe(false);

    const windows = socketPath();
    const onWindows = createPiAskBridge({ events: bus(), socketPath: windows, pid: 4242, platform: "win32" });
    bridges.push(onWindows);
    await onWindows.start(ui());
    expect(existsSync(windows)).toBe(false);

    const path = socketPath();
    const bridge = createPiAskBridge({ events: bus(), socketPath: path, pid: 4242 });
    await bridge.start(ui());
    expect(existsSync(path)).toBe(true);
    await bridge.stop();
    expect(existsSync(path)).toBe(false);
  });

  it("lists the commands pi's extensions registered, from pi's own list, and none when pi cannot say (#1448)", async () => {
    if (!posix) return;
    const path = socketPath();
    const info = (scope: string, origin: string) => ({ path: "/x/index.ts", source: "local", scope, origin });
    // pi.getCommands() (pi 1.3.0 core/agent-session.ts): extension commands, then prompt templates, then skills
    let commands = (): unknown => [
      { name: "team", description: "Start specialist agents", source: "extension", sourceInfo: info("user", "top-level") },
      { name: "ponytail", source: "extension", sourceInfo: info("project", "package") },
      { name: "review", description: "Review the diff", source: "prompt", sourceInfo: info("user", "top-level") },
      { name: "skill:lint", description: "Lint", source: "skill", sourceInfo: info("user", "top-level") },
    ];
    const bridge = createPiAskBridge({ events: bus(), socketPath: path, pid: 4242, commands: () => commands() });
    bridges.push(bridge);
    await bridge.start(ui());

    expect(await listed(path)).toEqual({ version: 1, pid: 4242, commands: [
      { name: "team", description: "Start specialist agents", scope: "user", origin: "top-level" },
      { name: "ponytail", scope: "project", origin: "package" },
    ] });
    // the runtime pi has not bound yet, or one a /reload left behind, throws
    commands = () => { throw new Error("Extension runtime not initialized"); };
    expect((await listed(path)).commands).toBeNull();

    const older = socketPath();
    const bare = createPiAskBridge({ events: bus(), socketPath: older, pid: 4242 });
    bridges.push(bare);
    await bare.start(ui());
    expect((await listed(older)).commands).toBeNull();
  });

  it("finds the agent directory as pi does", () => {
    expect(piAgentDir({}, "/home/me")).toBe(join("/home/me", ".pi", "agent"));
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "~/alt" }, "/home/me")).toBe(join("/home/me", "alt"));
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "/opt/pi" }, "/home/me")).toBe(join("/opt/pi"));
    if (posix) expect(piAgentDir({ PI_CODING_AGENT_DIR: "file:///tmp/pi%20profile" }, "/home/me")).toBe("/tmp/pi profile");
  });
});
