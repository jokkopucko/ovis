import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineEvent } from "../shared/machines.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { createServer } from "./index.ts";
import { authenticatedWebSocket } from "./remote-websocket.ts";

// What a plugin reports on a pane (#1209) reaches the browsers' roster as herdr sends it, and
// changes there when herdr's events say so: a token through pane.updated, the agent's line
// through a status event of the same status. herdr's agent rows come on the same stream.
it("carries a plugin's pane tokens and agent line to the browsers' roster, live, beside herdr's agent rows", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-test-pane-tokens-"));
  const herdrConfigPath = join(stateDir, "config.toml");
  writeFileSync(herdrConfigPath, `[ui.sidebar.agents]\nrows = [["state_icon", "workspace"], ["agent", "$quota"]]\n`);
  const workspace = await workspaceCreate({ cwd: stateDir, label: "ovis-test-pane-tokens" });
  const paneId = workspace.root_pane.pane_id;
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "test-token", tailscaleOwner: null, herdrConfigPath });
  const abort = new AbortController();
  try {
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" });
    const events: MachineEvent[] = [];
    const response = await fetch(`http://127.0.0.1:${server.port}/api/machines/events`, { headers: { authorization: "Bearer test-token" }, signal: abort.signal });
    expect(response.status).toBe(200);
    void (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as MachineEvent);
        }
      }
    })().catch(() => undefined);
    const waitFor = async (what: string, found: (event: MachineEvent) => boolean): Promise<void> => {
      for (const deadline = Date.now() + 15_000; !events.some(found);) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(25);
      }
    };
    const pane = (event: MachineEvent) => event.type === "machines" ? event.machines[0]?.snapshot?.panes.find((candidate) => candidate.pane_id === paneId) : undefined;

    await waitFor("herdr's agent rows", (event) => event.type === "herdr-sidebar" && JSON.stringify(event.agents) === JSON.stringify({ rows: [{ name: "quota" }], by_agent: {} }));
    await waitFor("the pane in the roster", (event) => pane(event)?.agent === "claude");

    await herdrRpc("pane.report_metadata", { pane_id: paneId, source: "plugin:quota", tokens: { quota: "5h 95% · Wk 67%" } });
    await waitFor("the token", (event) => pane(event)?.tokens?.["quota"] === "5h 95% · Wk 67%");

    await herdrRpc("pane.report_metadata", { pane_id: paneId, source: "plugin:quota", tokens: { quota: "5h 40% · Wk 70%" } });
    await waitFor("the token's new value", (event) => pane(event)?.tokens?.["quota"] === "5h 40% · Wk 70%");

    await herdrRpc("pane.report_metadata", { pane_id: paneId, source: "plugin:board", applies_to_source: "manual", display_agent: "needs a login · 8m ago" });
    await waitFor("the agent's line", (event) => pane(event)?.display_agent === "needs a login · 8m ago");
    const last = [...events].reverse().find((event) => pane(event)?.display_agent === "needs a login · 8m ago");
    expect(pane(last!)?.agent_status).toBe("idle");

    await herdrRpc("pane.report_metadata", { pane_id: paneId, source: "plugin:quota", tokens: { quota: null } });
    await waitFor("the token cleared", (event) => pane(event) !== undefined && pane(event)?.tokens?.["quota"] === undefined && pane(event)?.display_agent === "needs a login · 8m ago" && events.indexOf(event) > events.indexOf(last!));
  } finally {
    abort.abort();
    server.stop();
    await workspaceClose(workspace.workspace.workspace_id).catch(() => undefined);
    rmSync(stateDir, { recursive: true, force: true });
  }
}, 60_000);

// The snapshots a browser reads besides the roster (#2160): the session read, its local alias and the
// /ws snapshot frame leave out the token values herdr's rows hide; another Ovis server reading this PC
// with its bridge token gets them whole, as it applies its own rows.
describe("a browser's own snapshots", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-test-pane-tokens-"));
  const herdrConfigPath = join(stateDir, "config.toml");
  const bridge = "b".repeat(64);
  let server: ReturnType<typeof createServer>;
  let workspaceId = "";
  let paneId = "";
  type Snapshot = { panes: { pane_id: string; tokens?: Record<string, unknown> }[] };
  const tokensIn = (snapshot: Snapshot) => snapshot.panes.find((pane) => pane.pane_id === paneId)?.tokens;

  beforeAll(async () => {
    writeFileSync(herdrConfigPath, `[ui.sidebar.agents]\nrows = [["agent", { token = "$quota", rules = [{ starts_with = "off", hide = true }] }, "$eta"]]\n`);
    const workspace = await workspaceCreate({ cwd: stateDir, label: "ovis-test-pane-tokens-snapshots" });
    workspaceId = workspace.workspace.workspace_id;
    paneId = workspace.root_pane.pane_id;
    server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "test-token", bridgeToken: bridge, tailscaleOwner: null, herdrConfigPath });
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" });
    await herdrRpc("pane.report_metadata", { pane_id: paneId, source: "plugin:quota", tokens: { quota: "off · private", eta: "soon" } });
  }, 60_000);
  afterAll(async () => {
    server?.stop();
    await workspaceClose(workspaceId).catch(() => undefined);
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("leaves them out of a browser's session read and its local alias, not a bridge's", async () => {
    const session = async (path: string, token: string) => {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      return tokensIn(((await response.json()) as { snapshot: Snapshot }).snapshot);
    };
    for (const path of ["/api/session", "/api/machines/local/session"]) expect(await session(path, "test-token")).toEqual({ eta: "soon" });
    expect(await session("/api/session", bridge)).toEqual({ quota: "off · private", eta: "soon" });
  }, 60_000);

  it("leaves them in every snapshot of a bridge this app starts on a PC, whose only client is its connection server", async () => {
    const bridgeState = mkdtempSync(join(tmpdir(), "ovis-test-pane-tokens-bridge-"));
    const managed = createServer({ port: 0, hostname: "127.0.0.1", stateDir: bridgeState, token: "registered-credential", machines: false, bridgeOnly: true, tailscaleOwner: null, herdrConfigPath });
    // a server without machines that browsers do reach still leaves them out
    const plainState = mkdtempSync(join(tmpdir(), "ovis-test-pane-tokens-plain-"));
    const plain = createServer({ port: 0, hostname: "127.0.0.1", stateDir: plainState, token: "browser-token", machines: false, tailscaleOwner: null, herdrConfigPath });
    try {
      const browserRead = await fetch(`http://127.0.0.1:${plain.port}/api/session`, { headers: { authorization: "Bearer browser-token" } });
      expect(tokensIn(((await browserRead.json()) as { snapshot: Snapshot }).snapshot)).toEqual({ eta: "soon" });
      const response = await fetch(`http://127.0.0.1:${managed.port}/api/session`, { headers: { authorization: "Bearer registered-credential" } });
      expect(tokensIn(((await response.json()) as { snapshot: Snapshot }).snapshot)).toEqual({ quota: "off · private", eta: "soon" });
      const socket = authenticatedWebSocket(`ws://127.0.0.1:${managed.port}/ws`, "registered-credential");
      const frame = Promise.withResolvers<Snapshot>();
      const deadline = setTimeout(() => frame.reject(new Error("timed out waiting for the snapshot frame")), 15_000);
      socket.onmessage = (event) => { const message = JSON.parse(String(event.data)); if (message.type === "snapshot") frame.resolve(message.snapshot); };
      try { expect(tokensIn(await frame.promise)).toEqual({ quota: "off · private", eta: "soon" }); } finally { clearTimeout(deadline); socket.close(); }
    } finally {
      managed.stop();
      plain.stop();
      rmSync(bridgeState, { recursive: true, force: true });
      rmSync(plainState, { recursive: true, force: true });
    }
  }, 60_000);

  it("leaves them out of a browser's /ws snapshot frame, not a bridge's", async () => {
    const firstSnapshot = async (token: string) => {
      const socket = authenticatedWebSocket(`ws://127.0.0.1:${server.port}/ws`, token);
      const frame = Promise.withResolvers<Snapshot>();
      const deadline = setTimeout(() => frame.reject(new Error("timed out waiting for the snapshot frame")), 15_000);
      socket.onmessage = (event) => { const message = JSON.parse(String(event.data)); if (message.type === "snapshot") frame.resolve(message.snapshot); };
      socket.onerror = () => frame.reject(new Error("websocket error"));
      try { return tokensIn(await frame.promise); } finally { clearTimeout(deadline); socket.close(); }
    };
    expect(await firstSnapshot("test-token")).toEqual({ eta: "soon" });
    expect(await firstSnapshot(bridge)).toEqual({ quota: "off · private", eta: "soon" });
  }, 60_000);
});
