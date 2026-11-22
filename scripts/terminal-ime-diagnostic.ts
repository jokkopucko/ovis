/**
 * Native IME trace on an owned pane. Open the printed URL in Safari and type with
 * the OS input method; WebDriver text insertion is not a native IME reproduction.
 * No tracing is added to the normal app build. Ctrl+C closes the owned workspace.
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Socket } from "node:net";
import { build, preview, type Plugin, type PreviewServer } from "vite";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose, paneSendText } from "../server/herdr/client.ts";

assert(process.env.HERDR_TEST_LIVE !== "1", "This diagnostic requires an isolated test session");
assert(process.env.HERDR_TEST_MODE !== "unit", "This diagnostic requires a test herdr");
process.env.HERDR_TEST_SESSION ||= "ovis-test-ime";
await import("./test-herdr.ts");
assert(Bun.which("herdr") || process.env.OVIS_HERDR_BIN, "herdr is required");
assert(Bun.which("node"), "Node is required for the owned PTY capture process");

const root = mkdtempSync(join(tmpdir(), "herdr-ime-diagnostic-"));
const events = join(root, "events.ndjson");
const received = join(root, "received.bin");
const ready = join(root, "ready");
const capture = join(root, "capture.cjs");
writeFileSync(events, "");
writeFileSync(received, "");
writeFileSync(capture, `const fs = require('node:fs');
process.stdin.setRawMode(true);
process.stdout.write('Owned IME capture ready\\r\\n');
fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
process.stdin.on('data', bytes => {
  fs.appendFileSync(${JSON.stringify(received)}, bytes);
  process.stdout.write(bytes);
});
`);

function installTrace(pane: string): void {
  localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "direct" }));
  localStorage.setItem(`ovis:view:${pane}`, "terminal");
  let sequence = 0;
  let pending = Promise.resolve<unknown>(undefined);
  const trace = (row: Record<string, unknown>): void => {
    if (sequence >= 20_000) return;
    const record = { sequence: sequence++, at: performance.now(), ...row };
    pending = pending.then(() => fetch("/__ime_trace", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(record),
    })).catch((error) => console.error("IME trace could not be saved", error));
  };
  Object.assign(window, { terminalImeTrace: trace });
  trace({ kind: "environment", userAgent: navigator.userAgent, platform: navigator.platform });
  for (const type of ["keydown", "keypress", "keyup", "compositionstart", "compositionupdate", "compositionend", "beforeinput", "input", "focus", "blur"]) {
    document.addEventListener(type, (event) => {
      if (!(event.target instanceof HTMLTextAreaElement)) return;
      const box = event.target;
      if (box.id !== "ime-control" && !box.classList.contains("xterm-helper-textarea")) return;
      const key = event as KeyboardEvent;
      const input = event as InputEvent;
      trace({
        kind: "dom", type, target: box.id || box.className, key: key.key, code: key.code,
        keyCode: key.keyCode, ctrl: key.ctrlKey, meta: key.metaKey, alt: key.altKey, shift: key.shiftKey,
        isComposing: key.isComposing ?? input.isComposing, inputType: input.inputType, data: input.data,
        isTrusted: event.isTrusted, composed: event.composed, defaultPrevented: event.defaultPrevented,
        value: box.value, start: box.selectionStart, end: box.selectionEnd,
      });
    }, true);
  }
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data === "string") {
      try {
        const frame = JSON.parse(data);
        if (frame.type === "input" && frame.pane_id === pane) trace({ kind: "ws", ...frame });
      } catch {}
    }
    return send.call(this, data);
  };
  addEventListener("DOMContentLoaded", () => {
    const panel = document.createElement("div");
    panel.style.cssText = "position:fixed;right:16px;top:60px;z-index:99999;background:var(--bg-panel);color:var(--text);padding:10px";
    const label = document.createElement("label");
    label.textContent = "Native IME control ";
    const control = document.createElement("textarea");
    control.id = "ime-control";
    control.setAttribute("aria-label", "Native IME control");
    label.append(control);
    panel.append(label);
    document.body.append(panel);
  });
}

let api: ReturnType<typeof createServer> | undefined;
let web: PreviewServer | undefined;
let workspace: string | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
const connections = new Set<Socket>();
let stopping: Promise<void> | undefined;
function stop(): Promise<void> {
  return stopping ??= (async () => {
    clearTimeout(deadline);
    api?.stop();
    // HTTP close alone waits forever for an open terminal's upgraded WS connection.
    for (const socket of connections) socket.destroy();
    await new Promise<void>((done, fail) => web ? web.httpServer.close((error) => error ? fail(error) : done()) : done());
    if (workspace) await workspaceClose(workspace);
    const records = readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const emitted = records.filter((row) => row.kind === "onData").map((row) => row.data).join("");
    const sent = records.filter((row) => row.kind === "ws").map((row) => row.text).join("");
    const bytes = readFileSync(received);
    writeFileSync(join(root, "summary.json"), JSON.stringify({
      events: records.length, onData: emitted, ws: sent, received: bytes.toString("utf8"),
      receivedHex: bytes.toString("hex"), onDataMatchesWs: emitted === sent,
      wsMatchesPty: Buffer.from(sent).equals(bytes),
      // Equality alone does not show that the intended Korean text was composed.
      nativeImeVerified: false, cleanup: "owned workspace and servers closed",
    }, null, 2) + "\n");
    console.log(`CLEANUP owned workspace and servers closed; artifacts: ${root}`);
  })();
}

try {
  api = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), registerBridge: false });
  const made = await workspaceCreate({ cwd: root, label: "ovis-test-native-ime" });
  workspace = made.workspace.workspace_id;
  const pane = made.root_pane.pane_id;
  const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
  await paneSendText(pane, `exec ${quote(Bun.which("node")!)} ${quote(capture)}\r`);
  for (const until = Date.now() + 10_000; !existsSync(ready);) {
    assert(Date.now() < until, "owned capture process did not become ready");
    await Bun.sleep(25);
  }
  const trace: Plugin = {
    name: "owned-terminal-ime-trace", enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("/src/lib/useTerminalMount.ts")) return;
      const anchor = "const onData = term.onData((data) => {";
      assert.equal(code.split(anchor).length, 2, "onData trace anchor changed");
      return code.replace(anchor, `${anchor}\n(window as any).terminalImeTrace({kind: "onData", data, pane: paneRef.current});`);
    },
    transformIndexHtml() {
      return [{ tag: "script", children: `(${installTrace.toString()})(${JSON.stringify(pane)});`, injectTo: "head-prepend" }];
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__ime_trace", (request, response) => {
        if (request.method !== "POST" || request.headers["content-type"] !== "application/json"
          || request.headers.origin !== `http://${request.headers.host}`) { response.writeHead(403).end(); return; }
        let body = "";
        request.on("data", (part) => { body += part; if (body.length > 65_536) request.destroy(); });
        request.on("end", () => {
          try { appendFileSync(events, JSON.stringify(JSON.parse(body)) + "\n"); response.end("ok"); }
          catch { response.writeHead(400).end(); }
        });
      });
    },
  };
  const outDir = join(root, "dist");
  await build({ root: resolve(import.meta.dir, ".."), plugins: [trace], build: { outDir, emptyOutDir: true }, logLevel: "warn" });
  web = await preview({ root: resolve(import.meta.dir, ".."), plugins: [trace], build: { outDir }, preview: {
    host: "127.0.0.1", port: 0, proxy: {
      "/api": { target: `http://127.0.0.1:${api.port}`, changeOrigin: false },
      "/ws": { target: `ws://127.0.0.1:${api.port}`, ws: true },
    },
  } });
  const address = web.httpServer.address();
  assert(address && typeof address !== "string");
  web.httpServer.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  console.log(`Native IME diagnostic: http://127.0.0.1:${address.port}/?pane=${encodeURIComponent(pane)}`);
  console.log(`Artifacts: ${root}\nType abc → switch to Korean → 한글 → Space in the control, then the terminal.\nCtrl+C finishes; this diagnostic closes automatically after 15 minutes.`);
  writeFileSync(join(root, "run.json"), JSON.stringify({ pane, workspace, port: address.port, testSession: process.env.HERDR_TEST_SESSION }, null, 2));
  const finish = () => { void stop().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); }); };
  process.on("SIGINT", finish);
  process.on("SIGTERM", finish);
  deadline = setTimeout(finish, 15 * 60_000);
} catch (error) {
  await stop();
  throw error;
}
