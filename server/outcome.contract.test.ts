import { expect, it } from "bun:test";
import { EventEmitter, once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PanePromptResponse, ServerMessage } from "../shared/protocol.ts";
import { claudeProjectDir } from "./claude-store.ts";
import { createServer } from "./index.ts";
import { herdrRpc, workspaceCreate } from "./herdr/client.ts";

const RECORDER = `
const fs = require("node:fs");
const net = require("node:net");
const [file, port] = process.argv.slice(2);
const signal = (text) => {
  const socket = net.connect(Number(port), "127.0.0.1", () => socket.end(text + "\\n"));
};
let input = "";
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\\x1b[?2004h> ", () => signal("ready"));
process.stdin.on("data", (chunk) => {
  input += chunk.toString().replace(/\\x1b\\[20[01]~/g, "");
  if (!input.includes("\\r")) return;
  const text = input.split("\\r")[0].trim();
  input = "";
  if (text === "/context") {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(file, [
      { type: "system", subtype: "local_command", timestamp, content: "<command-name>/context</command-name>\\n<command-message>context</command-message>\\n<command-args></command-args>" },
      { type: "system", subtype: "local_command", timestamp, content: "<local-command-stdout>fixture-context-result</local-command-stdout>" }
    ].map(JSON.stringify).join("\\n") + "\\n");
  }
  process.stdout.write("\\r\\n> " + text + "\\r\\n> ");
  signal(text);
});
`;

it("follows Chat /context through the HTTP route and keeps /btw terminal-required on an isolated native transcript fixture", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-command-outcome-"));
  const config = join(root, ".claude");
  const id = "1f478344-f736-489c-89af-327029230021";
  const project = join(config, "projects", claudeProjectDir(root));
  mkdirSync(project, { recursive: true });
  const transcript = join(project, `${id}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ type: "system", version: "2.1.301", cwd: root })}\n`);
  copyFileSync(process.execPath, join(root, "claude"));
  writeFileSync(join(root, "recorder.cjs"), RECORDER);
  const events = new EventEmitter();
  const listener = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: { data(socket, bytes) { events.emit(bytes.toString().trim()); socket.end(); } },
  });
  const event = (name: string) => once(events, name, { signal: AbortSignal.timeout(10_000) });
  let workspace: string | undefined;
  let socket: WebSocket | undefined;
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: join(root, "state") });
  try {
    const created = await herdrRpc<Awaited<ReturnType<typeof workspaceCreate>>>("workspace.create", { cwd: root, label: "ovis-test-command-outcomes", focus: false });
    workspace = created.workspace.workspace_id;
    const pane = created.root_pane.pane_id;
    const ready = event("ready");
    await herdrRpc("pane.send_text", {
      pane_id: pane, text: `exec env HOME='${root}' CLAUDE_CONFIG_DIR='${config}' '${join(root, "claude")}' '${join(root, "recorder.cjs")}' '${transcript}' ${listener.port}\n`,
    });
    await ready;
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "idle" });
    await herdrRpc("pane.report_agent_session", { pane_id: pane, source: "herdr:claude", agent: "claude", seq: 1, agent_session_id: id });
    const frames = new EventEmitter();
    socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as ServerMessage;
      if (frame.type === "submit-result") frames.emit(`submit-${frame.id}`, frame);
      if (frame.type === "snapshot") frames.emit("snapshot");
    });
    await once(frames, "snapshot", { signal: AbortSignal.timeout(10_000) });
    const submit = async (text: string, requestId: number): Promise<void> => {
      const recorded = event(text);
      const result = once(frames, `submit-${requestId}`, { signal: AbortSignal.timeout(10_000) });
      socket?.send(JSON.stringify({ type: "submit", id: requestId, pane_id: pane, text, payload: text }));
      expect((await result)[0]).toMatchObject({ ok: true });
      await recorded;
    };
    const read = async (): Promise<PanePromptResponse> => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`);
      expect(response.status).toBe(200);
      return await response.json() as PanePromptResponse;
    };
    await submit("/context", 1);
    const happy = await read();
    expect(happy.outcomes?.at(-1)).toMatchObject({ text: "/context", state: "result-observed", evidence: [{ kind: "transcript" }] });
    await submit("/context", 2);
    const repeated = await read();
    expect(repeated.outcomes?.slice(-2).map((outcome) => outcome.state)).toEqual(["result-observed", "result-observed"]);
    expect(new Set(repeated.outcomes?.map((outcome) => outcome.id)).size).toBe(2);
    await submit("/btw hi", 3);
    const failure = await read();
    expect(failure.outcomes?.at(-1)).toMatchObject({ text: "/btw hi", state: "terminal-required", evidence: [] });
    console.log(`OUTCOME_QA ${JSON.stringify({ mode: "native-envelope-fixture", happy, repeated, failure })}`);
  } finally {
    socket?.close();
    server.stop();
    listener.stop(true);
    if (workspace) await herdrRpc("workspace.close", { workspace_id: workspace });
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
