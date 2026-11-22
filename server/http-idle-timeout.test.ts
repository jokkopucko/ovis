import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createSocketServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { forgetTranscriptState } from "./conversation.ts";
import { socketAddress } from "./herdr/client.ts";

/** One HTTP attempt. Some fetch implementations retry a socket Bun closed before its response. */
function request(base: string, path: string, payload?: object): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const req = httpRequest(base + path, {
      agent: false, method: body === undefined ? "GET" : "POST",
      headers: { origin: base, "x-herdr-machine": "1", ...(body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body).toString() }) },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("error", reject);
      response.on("end", () => {
        try { resolve({ status: response.statusCode!, body: JSON.parse(text) }); } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.setTimeout(35_000, () => req.destroy(new Error("fixture HTTP response did not finish")));
    req.end(body);
  });
}

it("returns results and bounded RPC errors after sequential reads exceed HTTP inactivity", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-http-idle-"));
  const socketPath = join(root, "herdr.sock");
  const previousSocket = process.env.HERDR_SOCKET;
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const calls: string[] = [];
  const answered = new Set(["events.subscribe", "session.snapshot", "pane.get", "pane.process_info", "worktree.open", "worktree.list"]);
  const unexpected: string[] = [];
  const daemon = createSocketServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const { id, method, params } = JSON.parse(input.split("\n")[0]!);
      input = "";
      let result: unknown = {};
      let error: object | undefined;
      let delay = 0;
      if (!answered.has(method)) { unexpected.push(method); error = { code: "unexpected_method", message: `fixture does not answer ${method}` }; }
      if (method === "session.snapshot") result = { snapshot: { panes: [], agents: [], workspaces: [], tabs: [], layouts: [] } };
      if (method === "pane.get") { result = { pane: { pane_id: "fixture", cwd: root, agent: null } }; delay = 7000; }
      if (method === "pane.process_info") { calls.push(method); return; }
      if (method === "worktree.open") {
        calls.push(`${method}:${params.workspace_id}`);
        if (params.workspace_id === "fixture-parent") return; // real client-side 10 s RPC timeout
        error = { code: "linked_worktree_source", message: "use the synthetic parent" };
        delay = 7000;
      }
      if (method === "worktree.list") { calls.push(method); result = { source: { source_workspace_id: "fixture-parent" }, worktrees: [] }; delay = 7000; }
      const answer = () => { if (!socket.destroyed) socket.end(JSON.stringify({ id, ...(error ? { error } : { result }) }) + "\n"); };
      if (delay === 0) answer();
      else {
        // Synthetic daemon work; each delayed answer remains inside its own 10 s RPC deadline.
        const timer = setTimeout(() => { timers.delete(timer); answer(); }, delay);
        timers.add(timer);
      }
    });
  });
  let app: ReturnType<typeof createServer> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { daemon.once("error", reject); daemon.listen(socketAddress(socketPath), resolve); });
    process.env.HERDR_SOCKET = socketPath;
    forgetTranscriptState();
    app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), herdrProfiles: async () => [], registerBridge: false, tailscaleOwner: null });
    const base = `http://127.0.0.1:${app.port}`;
    const [commands, aliasCommands, failure, aliasFailure] = await Promise.all([
      request(base, "/api/pane/commands?pane_id=fixture"),
      request(base, "/api/machines/local/pane/commands?pane_id=fixture"),
      request(base, "/api/worktree/open", { workspace_id: "fixture-source", branch: "fixture" }),
      request(base, "/api/machines/local/worktree/open", { workspace_id: "fixture-source", branch: "fixture" }),
    ]);
    expect(commands).toEqual({ status: 200, body: { commands: [] } });
    expect(aliasCommands).toEqual(commands);
    expect(failure.status).toBe(502);
    expect(failure.body.error.code).toBe("timeout");
    expect(aliasFailure.status).toBe(502);
    expect(aliasFailure.body.error.code).toBe("timeout");
    expect(calls.filter((call) => call === "worktree.open:fixture-source")).toHaveLength(2);
    expect(calls.filter((call) => call === "worktree.open:fixture-parent")).toHaveLength(2);
    expect(unexpected).toEqual([]);
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
}, 40_000);
