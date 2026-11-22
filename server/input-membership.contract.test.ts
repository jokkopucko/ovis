import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "./index.ts";
import { herdrRpc, paneRead } from "./herdr/client.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

/**
 * RC2: the `input` frame's mirror/RPC branch — the one taken when this PC cannot attach a
 * terminal, so typing goes to herdr instead — never checked that the client was a member of
 * the pane's attachment. The pty branch below it refuses a client that is not one; this one
 * did not, so a connection could type into a pane held by someone else's attach.
 *
 * Both cases assert what landed in the pane rather than whether an error arrived: a guard that
 * refused everything would pass an "no error came back" check while breaking the key bar and
 * an older bridge's composer send, which is the regression this narrower guard exists to avoid.
 */
const root = mkdtempSync(join(tmpdir(), "herdr-input-membership-"));
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: root, terminalAttach: false });
const sockets: WebSocket[] = [];
const workspaces: string[] = [];

afterAll(async () => {
  for (const socket of sockets) socket.close();
  server.stop();
  for (const workspace of workspaces) await herdrRpc("workspace.close", { workspace_id: workspace });
  rmSync(root, { recursive: true, force: true });
});

async function until(check: () => Promise<boolean>, label: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(25);
  }
}

interface Client {
  send: (message: ClientMessage) => void;
  errors: () => string[];
  ready: (paneId: string) => boolean;
  snapshotted: () => boolean;
}

function connect(port: number): Client {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const codes: string[] = [];
  const readyPanes: string[] = [];
  let snapshotted = false;
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as ServerMessage;
    if (frame.type === "error") codes.push(frame.code);
    if (frame.type === "input-ready" && frame.pane_id) readyPanes.push(frame.pane_id);
    if (frame.type === "snapshot") snapshotted = true;
  });
  return { send: (message) => ws.send(JSON.stringify(message)), errors: () => codes, ready: (paneId) => readyPanes.includes(paneId), snapshotted: () => snapshotted };
}

async function pane(label: string): Promise<string> {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: `ovis-test-${label}`, cwd: root, focus: false },
  );
  workspaces.push(created.workspace.workspace_id);
  return created.root_pane.pane_id;
}

async function screen(paneId: string): Promise<string> {
  return (await paneRead({ paneId, source: "visible", format: "text" })).text;
}

describe("typing into a pane held by another connection", () => {
  it("is refused, and the refusal keeps the text out of the pane", async () => {
    const held = await pane("input-held");
    const holder = connect(server.port);
    const stranger = connect(server.port);
    await until(async () => holder.snapshotted() && stranger.snapshotted(), "both snapshots");

    holder.send({ type: "attach", pane_id: held, cols: 80, rows: 24 });
    await until(async () => holder.ready(held), "the holder's attach to become ready");

    const trespass = "typed past someone else's attach";
    stranger.send({ type: "input", pane_id: held, text: trespass });
    await until(async () => stranger.errors().length > 0, "the refusal to reach the stranger");
    expect(stranger.errors()).toEqual(["input_not_ready"]);
    expect(await screen(held)).not.toContain(trespass);
  });

  it("still reaches a pane nobody has attached, which is the key bar and an older bridge", async () => {
    const unheld = await pane("input-unheld");
    const keyBar = connect(server.port);
    await until(async () => keyBar.snapshotted(), "snapshot");

    const typed = "key-bar-arrow-with-nothing-attached";
    keyBar.send({ type: "input", pane_id: unheld, text: typed });
    await until(async () => (await screen(unheld)).includes(typed), "the typed text to reach the pane");
    expect(keyBar.errors()).toEqual([]);
  });
});