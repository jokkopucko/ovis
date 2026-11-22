import { expect, it, spyOn } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrPane, ServerMessage } from "../shared/protocol.ts";
import { workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { createServer } from "./index.ts";
import * as native from "./omo.ts";
import { UsageService } from "./usage.ts";

function frame(socket: WebSocket, accepts: (value: ServerMessage) => boolean): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const seen: ServerMessage[] = [];
    const received = (event: MessageEvent) => {
      const value: ServerMessage = JSON.parse(String(event.data));
      seen.push(value);
      if (!accepts(value)) return;
      clearTimeout(timer);
      socket.removeEventListener("message", received);
      resolve(value);
    };
    const timer = setTimeout(() => {
      socket.removeEventListener("message", received);
      reject(new Error(`Detached eval status frame was not delivered (${accepts.toString()}), readyState=${socket.readyState}: ${JSON.stringify(seen)}`));
    }, 10_000);
    socket.addEventListener("message", received);
  });
}

it("serves BG for detached eval work and DONE after its notification turn stops", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-omo-detached-"));
  const created = await workspaceCreate({ cwd: root, label: "Detached eval fixture" });
  const paneId = created.root_pane.pane_id;
  const path = join(root, "2026_fixture-detached-session.jsonl");
  const record = (entry: Readonly<Record<string, unknown>>) => JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + "\n";
  const message = (role: string, stopReason?: string) => record({ type: "message", message: { role, content: [], ...(stopReason ? { stopReason } : {}) } });
  writeFileSync(path, record({ type: "session", id: "fixture-detached-session", cwd: root }) + message("user"));
  const discovery = spyOn(native, "omoPanes").mockImplementation(async () => new Map([[paneId, { path, startedAt: null }]]));
  const server = createServer({ port: 0, token: "", stateDir: join(root, "state"), machines: false, registerBridge: false, usage: new UsageService(undefined, []) });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const snapshot = async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/session`);
    expect(response.status).toBe(200);
    const body: { snapshot: { panes: HerdrPane[] } } = await response.json();
    return body.snapshot.panes.find((pane) => pane.pane_id === paneId);
  };
  const status = (value: ServerMessage) => value.type === "pane-status" && value.pane_id === paneId;
  try {
    await frame(socket, (value) => value.type === "snapshot");
    await server.statusReady;
    const background = frame(socket, (value) => status(value) && value.type === "pane-status" && value.background_wait === true);
    appendFileSync(path, record({ type: "message", message: { role: "toolResult", toolName: "eval", content: [
      { type: "text", text: "Eval cell fixture-cell detached and is running in the js kernel (0 other live cells)." },
    ] } }) + message("assistant", "stop"));
    const bgFrame = await background;
    const bgSnapshot = await snapshot();
    expect(bgFrame).toMatchObject({ agent_status: "done", background_tasks: 1, background_wait: true });
    expect(bgSnapshot).toMatchObject({ agent: "omo", agent_status: "done", background_tasks: 1, background_wait: true });

    const working = frame(socket, (value) => status(value) && value.type === "pane-status" && value.agent_status === "working");
    appendFileSync(path, record({ type: "custom_message", customType: "senpi-codemode:notification",
      content: "<system-reminder>Detached eval cell fixture-cell (js) completed.\n(no output)</system-reminder>" }));
    await working;
    const finished = frame(socket, (value) => status(value) && value.type === "pane-status" && value.agent_status === "done" && !value.background_wait);
    appendFileSync(path, message("assistant", "stop"));
    const doneFrame = await finished;
    const doneSnapshot = await snapshot();
    expect(doneFrame).toMatchObject({ background_tasks: 0 });
    expect(doneSnapshot?.agent_status).toBe("done");
    expect(doneSnapshot?.background_wait).not.toBe(true);
    expect(doneSnapshot?.background_tasks ?? 0).toBe(0);
    const evidence = process.env["UI_EVIDENCE_DIR"];
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, "omo-detached-surface.json"), JSON.stringify({ bgFrame, bgSnapshot, doneFrame, doneSnapshot }, null, 2));
    }
  } finally {
    socket.close();
    server.stop();
    discovery.mockRestore();
    await workspaceClose(created.workspace.workspace_id);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
