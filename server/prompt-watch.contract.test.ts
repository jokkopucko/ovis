import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage, PanePromptResponse, ServerMessage } from "../shared/protocol.ts";
import { createServer } from "./index.ts";
import { herdrRpc } from "./herdr/client.ts";

/**
 * Each pane runs Claude's folder-trust menu under the name `claude`, reported idle: `c` closes the menu and `o` draws it
 * again, as an idle agent opens and closes one without a status.
 */
const MENU = `
const { writeFileSync } = require("node:fs");
const [ready] = process.argv.slice(2);
let open = true;
const draw = () => process.stdout.write("\\u001b[2J\\u001b[H" + (open ? [
  " Accessing workspace:", "", " Quick safety check: Is this a project you created or one you trust?", "",
  " ❯ No, exit", "   Yes, I trust this folder", "", " Enter to confirm · Esc to cancel",
] : [" Nothing is asked here"]).join("\\r\\n"));
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  const key = chunk.toString("utf8");
  if (key === "c") open = false;
  if (key === "o") open = true;
  draw();
});
draw();
writeFileSync(ready, "");
`;

const root = mkdtempSync(join(tmpdir(), "ovis-prompt-watch-"));
const workspaces: string[] = [];
const sockets: WebSocket[] = [];
let server: { port: number; stop: () => void };

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

async function menuPane(label: string): Promise<{ pane: string; workspace: string }> {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: `ovis-test-prompt-watch-${label}`, cwd: root, focus: false },
  );
  workspaces.push(created.workspace.workspace_id);
  const ready = join(root, `${label}.ready`);
  await herdrRpc("pane.send_text", { pane_id: created.root_pane.pane_id, text: `exec '${join(root, "claude")}' '${join(root, "menu.js")}' '${ready}'\n` });
  await until(() => existsSync(ready), `${label} menu drawn`);
  await herdrRpc("pane.report_agent", { pane_id: created.root_pane.pane_id, source: "manual", agent: "claude", state: "idle" });
  return { pane: created.root_pane.pane_id, workspace: created.workspace.workspace_id };
}

class Socket {
  readonly frames: ServerMessage[] = [];
  readonly ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  constructor() {
    sockets.push(this.ws);
    this.ws.addEventListener("message", (event) => this.frames.push(JSON.parse(String(event.data)) as ServerMessage));
  }
  send(message: ClientMessage): void { this.ws.send(JSON.stringify(message)); }
  async waitFor(predicate: (frame: ServerMessage) => boolean, after = 0): Promise<ServerMessage> {
    let found: ServerMessage | undefined;
    await until(() => (found = this.frames.find((frame, index) => index >= after && predicate(frame))) !== undefined, "expected websocket frame");
    return found!;
  }
  async changed(paneId: string, after = 0): Promise<string> {
    const frame = await this.waitFor((candidate) => candidate.type === "prompt-changed" && candidate.pane_id === paneId, after);
    return frame.type === "prompt-changed" ? frame.signature : "";
  }
}

async function connect(): Promise<Socket> {
  const socket = new Socket();
  await socket.waitFor((frame) => frame.type === "snapshot");
  return socket;
}

async function cardId(paneId: string): Promise<string | undefined> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
  return ((await response.json()) as PanePromptResponse).prompt?.id;
}

beforeAll(() => {
  server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: join(root, "state"), terminalAttach: false });
  writeFileSync(join(root, "menu.js"), MENU);
  copyFileSync(process.execPath, join(root, "claude"));
  chmodSync(join(root, "claude"), 0o755);
});

afterAll(async () => {
  for (const ws of sockets) ws.close();
  server?.stop();
  for (const id of workspaces) await herdrRpc("workspace.close", { workspace_id: id }).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("prompt watches", () => {
  it("tell a watcher when the prompt opens, closes and opens again, without attaching the pane or moving the card's id", async () => {
    const { pane } = await menuPane("trust");
    const socket = await connect();
    const snapshot = socket.frames.find((frame) => frame.type === "snapshot");
    expect(snapshot?.type === "snapshot" && snapshot.features?.includes("prompt-watch")).toBe(true);
    socket.send({ type: "prompt-watch", pane_id: pane, enabled: true });
    const opened = await socket.changed(pane);
    const id = await cardId(pane);
    expect(id).toBeString();
    const later = await connect();
    later.send({ type: "prompt-watch", pane_id: pane, enabled: true });
    expect(await later.changed(pane)).toBe(opened);

    let after = socket.frames.length;
    await herdrRpc("pane.send_text", { pane_id: pane, text: "c" });
    expect(await socket.changed(pane, after)).not.toBe(opened);
    after = socket.frames.length;
    await herdrRpc("pane.send_text", { pane_id: pane, text: "o" });
    expect(await socket.changed(pane, after)).toBe(opened);
    expect(await cardId(pane)).toBe(id);
    expect(socket.frames.some((frame) => frame.type === "pty-data" || frame.type === "input-ready" || frame.type === "error")).toBe(false);
  }, 30_000);

  it("ends the watch of a pane that closes, and refuses malformed watches in-band", async () => {
    const { pane, workspace } = await menuPane("closing");
    const socket = await connect();
    socket.send({ type: "prompt-watch", pane_id: pane, enabled: true });
    await socket.changed(pane);
    const after = socket.frames.length;
    await herdrRpc("workspace.close", { workspace_id: workspace });
    await socket.waitFor((frame) => frame.type === "error" && frame.code === "prompt_watch_ended" && frame.pane_id === pane, after);

    for (const fields of [{ pane_id: pane }, { pane_id: pane, enabled: "true" }, { pane_id: " ", enabled: true }, { enabled: true }]) {
      const before = socket.frames.length;
      socket.ws.send(JSON.stringify({ type: "prompt-watch", ...fields }));
      await socket.waitFor((frame) => frame.type === "error" && frame.code === "invalid_prompt_watch", before);
    }
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);
  }, 30_000);
});
