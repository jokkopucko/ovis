import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
import { shownRow } from "./shown-rows.ts";
import { checkWindowsFitDemotion } from "./windows-fit-demotion.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

/** Run only with a disposable named daemon and private state; never discover a user's default socket. */
const name = process.env["HERDR_TEST_SESSION"], root = process.env["XDG_CONFIG_HOME"];
assert.equal(process.platform, "win32");
assert(root && name && name.startsWith("ovis-fit-") && process.env["HERDR_TEST_LIVE"] !== "1");
assert.equal(process.env["HERDR_SOCKET"], join(root, "herdr", "sessions", name, "herdr.sock"));
const { createServer } = await import("../server/index.ts");
const { ping, workspaceCreate, workspaceClose, paneSendText, paneSendKeys, paneScrollInfo } = await import("../server/herdr/client.ts");
const { WindowsControl } = await import("../server/windows-control.ts");
const identity = await ping();
const state = join(root, "fit-qa");
mkdirSync(state, { recursive: false });
const evidence = process.env["UI_EVIDENCE_DIR"];
if (evidence) mkdirSync(evidence, { recursive: true });
let pane: string;
let server: ReturnType<typeof createServer> | undefined;
const sockets: WebSocket[] = [];
let external: InstanceType<typeof WindowsControl> | undefined;
async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const end = Date.now() + 10_000;
  for (;;) {
    const result = read();
    if (result !== undefined) return result;
    if (Date.now() > end) throw new Error(`Timed out: ${what}`);
    await Bun.sleep(20);
  }
}
async function consoleSize(): Promise<string> {
  const path = join(state, crypto.randomUUID());
  await paneSendText(pane, `[IO.File]::WriteAllText('${path.replaceAll("'", "''")}',([string][Console]::WindowWidth+'x'+[Console]::WindowHeight))`);
  await paneSendKeys(pane, ["Enter"]);
  return until(() => { try { return readFileSync(path, "utf8") || undefined; } catch { return undefined; } }, "PowerShell console dimensions");
}
async function browserTakeover(url: string, previous: { cols: number; rows: number }): Promise<void> {
  // Two independent devices: opening the small browser must not hide the owner or release its size.
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 580, height: 720 }, locale: "en-US" });
    type Grid = { cols: number; rows: number };
    type Receipt = { held?: boolean; fixed?: Grid; granted?: Grid; beforeData?: Grid; cellWidth?: number };
    type Probe = { fitQa: Receipt };
    const receipt = () => page.evaluate(() => (window as unknown as Probe).fitQa);
    await page.addInitScript((target: string) => {
      const state: Receipt = {};
      Object.assign(window, { fitQa: state });
      class Recording extends WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          // Installed before the app listener: sample the Ghostty grid before its first owned bytes.
          this.addEventListener("message", event => {
            const m = JSON.parse(String(event.data)) as ServerMessage;
            if (!("pane_id" in m) || m.pane_id !== target) return;
            if (m.type === "error" && m.code === "attach_held") {
              state.held = true;
            } else if (m.type === "pane-geometry" && m.windows_fit) {
              const grid = { cols: m.cols, rows: m.rows };
              if (m.fixed) state.fixed = grid;
              if (m.fixed === false) state.granted = grid;
            } else if (m.type === "pty-data" && state.granted && !state.beforeData && state.cellWidth) {
              const layer = document.querySelector<HTMLElement>(".pane-terminal .ghostty-layer");
              const text = layer?.querySelector(".ghostty-text");
              if (!layer || !text) throw new Error("Ghostty grid missing before the first owned frame");
              state.beforeData = { cols: Math.round(parseFloat(layer.style.width) / state.cellWidth), rows: text.childElementCount };
            }
          });
        }
      }
      Object.assign(window, { WebSocket: Recording });
    }, pane);
    await page.goto(url);
    await page.waitForFunction(() => (window as unknown as Probe).fitQa.held).catch(cause => {
      throw new Error("Second browser did not receive attach_held", { cause });
    });
    const openHere = page.getByRole("button", { name: "Open here", exact: true });
    await openHere.waitFor();
    await page.waitForFunction(({ cols, rows }) => {
      const { fitQa } = window as unknown as Probe;
      const fixed = fitQa.fixed;
      const layer = document.querySelector<HTMLElement>(".pane-terminal .ghostty-layer");
      if (fixed?.cols !== cols || fixed.rows !== rows || !layer || layer.querySelector(".ghostty-text")?.childElementCount !== rows) return false;
      const width = parseFloat(layer.style.width);
      if (!(width > 0)) return false;
      fitQa.cellWidth = width / cols;
      return true;
    }, previous);
    const shot = async (p: Page, name: string) => {
      if (evidence) await p.locator(".pane-terminal").screenshot({ path: join(evidence, name) });
    };
    await shot(page, "before-open-here.png");
    await openHere.click();
    await page.waitForFunction(() => !!(window as unknown as Probe).fitQa.beforeData);
    const { granted, beforeData } = await receipt();
    assert(granted && beforeData);
    assert.ok(granted.cols < previous.cols && granted.rows < previous.rows, "takeover exercised differently sized viewers");
    assert.deepEqual(beforeData, granted, "Ghostty must already match the grant before receiving the controller's first frame");
    await shot(page, "after-open-here.png");
    assert.equal(await consoleSize(), `${granted.cols}x${granted.rows}`);
    const typed = join(state, crypto.randomUUID());
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(`[IO.File]::WriteAllText('${typed.replaceAll("'", "''")}','typed-by-new-controller')`);
    await page.keyboard.press("Enter");
    await until(() => { try { return readFileSync(typed, "utf8") === "typed-by-new-controller" || undefined; } catch { return undefined; } }, "typed browser input reaches PowerShell");
    console.log(`PASS Open here: fixed ${previous.cols}x${previous.rows} -> Ghostty ${beforeData.cols}x${beforeData.rows} before the first owned frame; native console ${granted.cols}x${granted.rows}, browser-typed PowerShell input received`);
  } finally { await browser.close(); }
}
async function connect(mode: "observe" | "interact") {
  assert(server);
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  sockets.push(ws);
  const frames: ServerMessage[] = [];
  ws.onmessage = ({ data }) => { const frame = JSON.parse(String(data)) as ServerMessage; if (frame.type !== "pty-data" && frame.type !== "snapshot") frames.push(frame); };
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("WebSocket failed")); });
  const send = (frame: ClientMessage) => ws.send(JSON.stringify(frame));
  const wait = (test: (frame: ServerMessage) => boolean, what: string) => until(() => {
    const index = frames.findIndex(test);
    return index < 0 ? undefined : frames.splice(index, 1)[0];
  }, what);
  send({ type: "role", mode });
  await wait(f => f.type === "role-ack" && f.mode === mode, "role");
  return { send, wait, close: () => ws.close(), attach: (cols: number, rows: number, keep_size = false) => send({ type: "attach", pane_id: pane, cols, rows, keep_size, windows_fit: true }),
    grid: (cols: number, rows: number) => wait(f => f.type === "pane-geometry" && f.fixed === false && f.windows_fit === true && f.cols === cols && f.rows === rows, "confirmed owner geometry") };
}
const created = await workspaceCreate({ cwd: state, label: "ovis-fit-disposable" });
try {
  pane = created.root_pane.pane_id;
  server = createServer({ hostname: "127.0.0.1", port: 0, token: "", stateDir: state });
  console.log(`Native herdr ${identity.version}, protocol ${identity.protocol}`);
  const original = await consoleSize();
  const observer = await connect("observe");
  observer.attach(34, 12);
  await observer.wait(f => f.type === "pane-geometry", "observed grid");
  observer.send({ type: "resize", pane_id: pane, cols: 34, rows: 12 });
  await observer.wait(f => f.type === "error" && f.code === "read_only", "observe refusal");
  assert.equal(await consoleSize(), original);
  const owner = await connect("interact");
  owner.attach(40, 15, true);
  await owner.wait(f => f.type === "pane-geometry", "kept grid");
  assert.equal(await consoleSize(), original);
  let externalReady = false;
  external = new WindowsControl({ command: process.env["OVIS_HERDR_BIN"] || "herdr", target: pane, socket: process.env["HERDR_SOCKET"]!,
    cols: 51, rows: 18, takeover: false, onFrame: () => { externalReady = true; }, onEnd() {} });
  await until(() => externalReady || undefined, "independent controller");
  owner.attach(120, 40);
  await owner.wait(f => f.type === "error" && f.code === "attach_held", "native holder refusal");
  assert.equal(await consoleSize(), "51x18");
  owner.send({ type: "take-over", pane_id: pane }); await owner.grid(120, 40);
  await external.exited;
  assert.equal(await consoleSize(), "120x40");
  owner.send({ type: "resize", pane_id: pane, cols: 40, rows: 15 }); await owner.grid(40, 15);
  assert.equal(await consoleSize(), "40x15");
  const other = await connect("interact");
  other.attach(67, 24);
  await other.wait(f => f.type === "error" && f.code === "attach_held", "contended attach");
  other.send({ type: "resize", pane_id: pane, cols: 67, rows: 24 });
  other.send({ type: "ping", id: 1 });
  await other.wait(f => f.type === "pong" && f.id === 1, "fence rejected resize");
  assert.equal(await consoleSize(), "40x15");
  other.send({ type: "take-over", pane_id: pane }); await other.grid(67, 24);
  assert.equal(await consoleSize(), "67x24");
  owner.send({ type: "resize", pane_id: pane, cols: 39, rows: 14 });
  owner.send({ type: "ping", id: 2 });
  await owner.wait(f => f.type === "pong" && f.id === 2, "fence retired owner's resize");
  assert.equal(await consoleSize(), "67x24");
  other.send({ type: "resize", pane_id: pane, cols: 120, rows: 40 }); await other.grid(120, 40);
  assert.equal(await consoleSize(), "120x40");
  console.log(`PASS observer, keep-size, exclusive claim, explicit takeover, retired owner and real console 120x40 -> 40x15 -> 67x24 -> 120x40 (unattached: ${original})`);
  // Clear the earlier claimant so it cannot take the slot before the demotion probe.
  owner.send({ type: "detach", pane_id: pane });
  owner.send({ type: "ping", id: 3 });
  await owner.wait(f => f.type === "pong" && f.id === 3, "earlier claimant detached");
  const afterDemotion = await checkWindowsFitDemotion(other, () => connect("interact"), pane);
  assert.equal(await consoleSize(), afterDemotion);
  console.log("PASS demotion releases native control before the demoted socket closes");
  for (const ws of sockets) ws.close();
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const grants: { cols: number; rows: number }[] = [];
    page.on("websocket", ws => ws.on("framereceived", ({ payload }) => {
      const m = JSON.parse(String(payload)) as ServerMessage;
      if (m.type === "pane-geometry" && m.pane_id === pane && m.fixed === false && m.windows_fit) grants.push(m);
    }));
    await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
    const wide = await until(() => grants.at(-1), "browser attach");
    await page.setViewportSize({ width: 580, height: 720 });
    const narrow = await until(() => grants.find(g => g.cols < wide.cols), "browser resizes the native console");
    assert.equal(await consoleSize(), `${narrow.cols}x${narrow.rows}`);
    console.log(`PASS browser viewport changes native console from ${wide.cols}x${wide.rows} to ${narrow.cols}x${narrow.rows}`);
    await paneSendText(pane, '1..120 | ForEach-Object { Write-Output ("WFROW-{0:D3}" -f $_) }');
    await paneSendKeys(pane, ["Enter"]);
    const last = page.locator(shownRow()).filter({ hasText: "WFROW-120" }).first();
    await last.waitFor({ timeout: 15_000 });
    await page.locator(".pane-terminal").hover();
    await page.mouse.wheel(0, -350);
    await last.waitFor({ state: "hidden", timeout: 15_000 });
    assert.ok(((await paneScrollInfo(pane))?.offset_from_bottom ?? 0) > 0);
    console.log("PASS a fitted PowerShell terminal still shows shell history after a wheel scroll");
    await page.setViewportSize({ width: 1200, height: 900 });
    await until(() => grants.at(-1)?.cols === wide.cols || undefined, "wide controller restored");
    await paneSendText(pane, 'function prompt { "QA> " }; Clear-Host; Write-Output "Disposable Windows terminal fit check"');
    await paneSendKeys(pane, ["Enter"]);
    await page.locator(shownRow()).filter({ hasText: /^Disposable Windows terminal fit check\s*$/ }).first().waitFor();
    await browserTakeover(page.url(), grants.at(-1)!);
  } finally { await browser.close(); }
} finally {
  try {
    external?.kill();
    for (const ws of sockets) ws.close();
    server?.stop();
  } finally { await workspaceClose(created.workspace.workspace_id); }
}
