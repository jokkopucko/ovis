import { expect, it } from "bun:test";
import { createServer as createSocketServer, type Socket } from "node:net";
import { get } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { forgetTranscriptState } from "./conversation.ts";
import { socketAddress } from "./herdr/client.ts";

/** One HTTP attempt: fetch may retry a connection that Bun's idle timer closed. */
function read(url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const request = get(url, { agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("error", reject);
      response.on("end", () => {
        try { resolve({ status: response.statusCode!, body: JSON.parse(body) }); }
        catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.setTimeout(25_000, () => request.destroy(new Error("chat response did not finish")));
  });
}

it("keeps chat history readable while valid sequential herdr calls outlast HTTP inactivity", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-chat-timeout-"));
  const previousSocket = process.env.HERDR_SOCKET;
  const socketPath = join(root, "herdr.sock");
  const codexHome = join(root, "codex");
  const path = join(codexHome, "sessions", "rollout.jsonl");
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  // long enough for the pane's screen to tell its conversation: herdr's report alone does not
  const answer = (index: number) => `Fictional answer ${index}: the history stays readable while each herdr call takes its time.`;
  writeFileSync(path, [
    { type: "session_meta", payload: { id: "00000000-0000-4000-8000-000000000001", cwd: "/synthetic/work" } },
    ...Array.from({ length: 120 }, (_, index) => [
      { type: "event_msg", payload: { type: "task_started", turn_id: `turn-${index}` } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Fictional question ${index}` }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: answer(index) }] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: `turn-${index}` } },
    ]).flat(),
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const pane = { pane_id: "fixture", cwd: "/synthetic/work", agent: "codex", agent_status: "working", agent_session: { agent: "codex", kind: "path", value: path } };
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let slow = false;
  // Only the external daemon is a stand-in. The HTTP handler, RPC client and transcript reader run unchanged.
  const daemon = createSocketServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const line = buffer.split("\n")[0]!;
      const { id, method } = JSON.parse(line);
      buffer = "";
      const { params } = JSON.parse(line) as { params?: { lines?: number } };
      // A lost daemon reply must still reach the caller as the RPC's bounded error. The chat's own
      // read of the pane's last 400 lines is answered: its newest answer shows there.
      if (method === "pane.read" && params?.lines !== 400) return;
      const result = method === "session.snapshot" ? { snapshot: { panes: [pane], agents: [], workspaces: [], tabs: [], layouts: [] } }
        : method === "agent.get" ? { agent: pane }
        // a Codex runs in the pane: a screen with none proves no conversation
        : method === "pane.process_info" ? { process_info: { foreground_processes: [{ pid: 2147483647, argv: ["/usr/bin/codex"] }] } }
        : method === "pane.read" ? { read: { text: `• ${answer(119)}\n\n› ` } } : {};
      const reply = () => { if (!socket.destroyed) socket.write(JSON.stringify({ id, result }) + "\n"); };
      if (slow && (method === "session.snapshot" || method === "agent.get")) {
        // Simulate daemon work, each reply inside its own 10 s RPC deadline; together over Bun's default 10 s.
        const timer = setTimeout(() => { timers.delete(timer); reply(); }, 6_000);
        timers.add(timer);
      } else reply();
    });
  });
  let app: ReturnType<typeof createServer> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { daemon.once("error", reject); daemon.listen(socketAddress(socketPath), resolve); });
    process.env.HERDR_SOCKET = socketPath;
    forgetTranscriptState();
    app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), codexHome, herdrProfiles: async () => [], registerBridge: false, tailscaleOwner: null });
    const base = `http://127.0.0.1:${app.port}/api/pane/`;
    const initial = await read(`${base}conversation?pane_id=fixture`);
    expect(initial.status).toBe(200);
    expect(initial.body.cursor).toBeString();
    slow = true;
    const [newest, history, stalled] = await Promise.all([
      read(`${base.replace("/api/pane/", "/api/machines/local/pane/")}conversation?pane_id=fixture`),
      read(`${base}conversation?pane_id=fixture&before=${encodeURIComponent(initial.body.cursor)}`),
      read(`${base}read?pane_id=fixture&source=recent`),
    ]);
    expect(newest.status).toBe(200);
    expect(newest.body.turns.at(-1).parts).toContainEqual({ kind: "text", text: answer(119) });
    expect(history.status).toBe(200);
    expect(history.body.turns.at(-1).parts).toContainEqual({ kind: "text", text: answer(69) });
    expect(stalled.status).toBe(502);
    expect(stalled.body.error.code).toBe("timeout");
  } finally {
    app?.stop();
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
    forgetTranscriptState();
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET;
    else process.env.HERDR_SOCKET = previousSocket;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
