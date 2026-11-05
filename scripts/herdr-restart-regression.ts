/** A restored pane keeps its ID but gets a new terminal: the open browser must attach to it. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type WebSocket as BrowserSocket } from "playwright-core";
import type { ServerMessage } from "../shared/protocol.ts";
import { chromePath } from "./chrome-path.ts";
import { SOCKET_PATH_MAX } from "./check.ts";

// This script stops its herdr, so it must not share even the browser lane's test session.
const root = mkdtempSync(join(tmpdir(), "herdr-restart-"));
const session = "ovis-test-restart";
const config = join(root, "config");
const state = join(root, "state");
mkdirSync(config);
mkdirSync(state);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(HERDR|OMO|SENPI|PI)_/.test(name))),
  XDG_CONFIG_HOME: config, XDG_STATE_HOME: state, SHELL: "/bin/bash",
};
const binary = process.env.OVIS_HERDR_BIN || "herdr";
const socketPath = join(config, "herdr", "sessions", session, "herdr.sock");
const socketBytes = Buffer.byteLength(socketPath);
if (socketBytes > SOCKET_PATH_MAX) {
  rmSync(root, { recursive: true, force: true });
  throw new Error(`${socketPath} is too long for a unix socket (${socketBytes} > ${SOCKET_PATH_MAX} bytes); set TMPDIR to a shorter path`);
}
process.env.HERDR_SOCKET = socketPath;
const { createServer } = await import("../server/index.ts");
const { workspaceCreate, sessionSnapshot, paneRead } = await import("../server/herdr/client.ts");
let daemon: ReturnType<typeof Bun.spawn> | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Browser | undefined;

async function startHerdr(): Promise<void> {
  const child = Bun.spawn([binary, "--session", session, "server"], { env, stdout: "ignore", stderr: "pipe" });
  daemon = child;
  const reader = child.stderr.getReader();
  const timer = setTimeout(() => child.kill(), 15_000);
  let output = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`herdr exited before readiness: ${output}`);
      output += new TextDecoder().decode(value);
      if (output.includes("api socket:")) break;
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

async function stopHerdr(): Promise<void> {
  const child = Bun.spawn([binary, "--session", session, "server", "stop"], { env, stdout: "inherit", stderr: "inherit" });
  assert.equal(await child.exited, 0);
  await daemon?.exited;
  daemon = undefined;
}

function frame(socket: BrowserSocket, label: string, accepts: (message: ServerMessage) => boolean): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("framereceived", received);
      reject(new Error(`Timed out: ${label}`));
    }, 20_000);
    const received = ({ payload }: { payload: string | Buffer }): void => {
      const message: ServerMessage = JSON.parse(String(payload));
      if (!accepts(message)) return;
      clearTimeout(timer);
      socket.off("framereceived", received);
      resolve(message);
    };
    socket.on("framereceived", received);
  });
}

try {
  // Given an attached browser and its own persisted shell pane.
  await startHerdr();
  const made = await workspaceCreate({ cwd: root, label: "restart-regression" }, socketPath);
  const pane = made.root_pane.pane_id;
  const other = (await workspaceCreate({ cwd: root, label: "restart-cached" }, socketPath)).root_pane.pane_id;
  server = createServer({ hostname: "127.0.0.1", port: 0, stateDir: join(root, "web"), token: "" });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(({ pane }) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
    localStorage.setItem(`ovis:view:${pane}`, "terminal");
  }, { pane });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let initial: Promise<ServerMessage> | undefined;
  page.once("websocket", (socket) => {
    initial = frame(socket, "initial input-ready", (m) => m.type === "input-ready" && m.pane_id === pane && m.ready !== false);
  });
  const opened = page.waitForEvent("websocket");
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  const socket = await opened;
  assert.ok(initial);
  await initial;
  // Visit the other workspace once: its cached renderer must not acquire a new attachment.
  const otherReady = frame(socket, "other pane ready", (m) => m.type === "input-ready" && m.pane_id === other && m.ready !== false);
  await page.locator(`.pane-select[title^="${other} —"]`).click();
  await otherReady;
  await page.locator(`.pane-select[title^="${pane} —"]`).click();
  // A warm tab keeps its original attachment, so returning needs no new input-ready receipt.
  await page.locator(`[data-layout-pane="${pane}"] [data-pane-content]`).waitFor();
  const attaches: string[] = [];
  socket.on("framesent", ({ payload }) => {
    const message: { type: string; pane_id?: string } = JSON.parse(String(payload));
    if (message.type === "attach" && message.pane_id) attaches.push(message.pane_id);
  });
  const original = (await sessionSnapshot(socketPath)).panes.find((p) => p.pane_id === pane);
  assert.ok(original);
  console.log("Before restart", { pane: original.pane_id, terminal: original.terminal_id });
  await page.evaluate(() => { document.documentElement.dataset.restartProof = "same-document"; });

  // When herdr stays down until the bridge ends the old attach, then restores the same pane.
  const ended = frame(socket, "old attachment exited", (m) => m.type === "pty-exit" && m.pane_id === pane);
  await stopHerdr();
  console.log("Old attachment", await ended);
  const recovered = frame(socket, "open pane automatically reattaches after herdr restart",
    (m) => m.type === "input-ready" && m.pane_id === pane && m.ready !== false);
  // Handle failure immediately while the restored roster is inspected.
  const recovery = recovered.then(() => null, (error: unknown) => error);
  await startHerdr();
  const restored = (await sessionSnapshot(socketPath)).panes.find((p) => p.pane_id === pane);
  assert.ok(restored);
  assert.notEqual(restored.terminal_id, original.terminal_id);
  console.log("Restored", { pane: restored.pane_id, terminal: restored.terminal_id });
  const failure = await recovery;
  if (failure) {
    console.log("Visible status", await page.locator(".terminal-banner").allTextContents());
    throw failure;
  }

  // Then the original document accepts fresh input, renders it and clears the ended state.
  await page.locator(`[data-layout-pane="${pane}"] .xterm-helper-textarea`).focus();
  const output = frame(socket, "fresh command output", (m) => m.type === "pty-data" && m.pane_id === pane && m.data.includes("REATTACH-OK"));
  // The echoed command does not contain the output sentinel, so only execution satisfies it.
  await page.keyboard.type("printf 'REATTACH-%s\\n' OK");
  await page.keyboard.press("Enter");
  await output;
  const read = await paneRead({ paneId: pane, source: "visible" }, socketPath);
  assert.match(read.text, /(?:^|\n)REATTACH-OK(?:\r?\n|$)/);
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error("terminal ended notice did not clear")); }, 5_000);
    function check(): void {
      if ([...document.querySelectorAll(".terminal-banner")].some((banner) => banner.textContent?.includes("terminal ended"))) return;
      clearTimeout(timer);
      observer.disconnect();
      resolve();
    }
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    check();
  }));
  assert.equal(await page.getByText("terminal ended", { exact: true }).count(), 0);
  assert.deepEqual(attaches, [pane], "only the presented pane reattaches; the cached tab waits");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.restartProof), "same-document");
  assert.deepEqual(errors, []);
  console.log("PASS same pane reattached without re-pick/reload; fresh input works; terminal ended cleared");
} finally {
  await browser?.close();
  await server?.stop();
  if (daemon?.exitCode === null) await stopHerdr();
  rmSync(root, { recursive: true, force: true });
}
