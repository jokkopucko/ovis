/**
 * End-to-end checks of a built desktop app, on a PC without herdr: everything runs in a fresh
 * temporary HOME with its own hc session, user data folder and PATH, so the PC's own herdr, hc
 * core and Ovis state are never touched.
 *
 *   bun scripts/e2e.ts dist/Ovis-<version>-<arch>.AppImage     Linux (on an Xvfb display of its own)
 *   bun scripts/e2e.ts dist/mac-arm64/Ovis.app                  macOS (needs a logged-in desktop session)
 *   bun scripts/e2e.ts --update                                 Linux: packages two versions from stage/ and out/
 *                                                               and updates the older one from a local feed
 *   bun scripts/e2e.ts --update --from-tray                     the same, restarting from the tray with the window's
 *                                                               line closed (without it: from that line's button)
 *
 * Options: --out <dir> (screenshots and results.json; default a new temporary folder, kept), --keep (leave
 * the temporary HOME behind). Exit code 0 when every check passed.
 *
 * The app's main process is driven through its Node inspector (`--inspect-brk`): before the app's
 * own code runs, the tray's menu is wrapped, and `shell.openExternal` and the showing of a
 * notification are replaced, so the checks can press the tray's items, see what would open in the
 * browser and read (and click) what the app notified of. The app's hourly update check is kept as
 * it is scheduled, so a check can be run without waiting an hour. Everything else is the app as built.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { UPDATE_CHECK_INTERVAL_MS } from "../src/updates.ts";

type Check = { name: string; ok: boolean; detail: string; known?: string };

const here = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const updateMode = flag("--update");
const fromTray = flag("--from-tray");
const keep = flag("--keep");
const appArg = argv.find((arg, index) => !arg.startsWith("--") && argv[index - 1] !== "--out");
if (!updateMode && !appArg) throw new Error("Usage: bun scripts/e2e.ts <Ovis AppImage or Ovis.app> | --update [--from-tray] [--out dir] [--keep]");
if (updateMode && process.platform !== "linux") throw new Error("--update runs on Linux only (a macOS update needs a signed app)");

// macOS's own temporary folder is too deep for hc's socket path (at most 103 bytes there)
const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ovis-e2e-"));
// outside the root, which the run removes
const out = resolve(option("--out") ?? mkdtempSync(join(tmpdir(), "ovis-e2e-out-")));
mkdirSync(out, { recursive: true });
/** in the environment of every process the run starts, and inherited by theirs: what cleanup ends, and the inspector proves */
const runId = randomUUID();
const checks: Check[] = [];
const owned: ChildProcess[] = [];
const session = `e2e-${process.pid}`;
const PUSH_ISSUE = "#2802";

function check(name: string, ok: boolean, detail = ""): boolean {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  return ok;
}

/** a check that fails for a filed bug: told, and left out of the exit code until the bug is fixed */
function knownBug(name: string, ok: boolean, issue: string, detail = ""): void {
  checks.push({ name, ok, detail, known: issue });
  console.log(`${ok ? "PASS" : "KNOWN"} ${name}${ok ? "" : ` (${issue})`}${detail ? `  (${detail})` : ""}`);
}

function log(message: string): void {
  console.log(`      ${message}`);
}

/** `promise`, or a rejection once `ms` have gone by */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)}s`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** waits for `probe` to give a value other than null/false, at most `timeoutMs` (a probe that hangs counts against it) */
async function until<T>(what: string, probe: () => Promise<T | null | false> | T | null | false, timeoutMs = 60_000, everyMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await within(Promise.resolve(probe()), Math.max(deadline - Date.now(), 1), what);
      if (value !== null && value !== false) return value;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(everyMs);
  }
  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = probe.address();
      probe.close(() => resolvePort(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function exited(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  const deadline = Date.now() + timeoutMs;
  while (!gone() && Date.now() < deadline) await Bun.sleep(100);
  return gone();
}

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// The isolated PC: a HOME, PATH and runtime folders of its own, and on Linux a display.

const home = join(root, "home");
const fakeBin = join(root, "bin");
for (const dir of [home, fakeBin, join(root, "run"), join(root, "tmp"), join(root, "work")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const systemPath = process.platform === "darwin" ? "/usr/bin:/bin:/usr/sbin:/sbin" : "/usr/bin:/bin";
// a stand-in coding agent: a program called `claude` that stays up like one
writeFileSync(join(fakeBin, "claude"), "#!/bin/sh\necho 'fake claude for the desktop e2e'\nwhile :; do sleep 3600; done\n");
chmodSync(join(fakeBin, "claude"), 0o755);
const PATH = `${fakeBin}:${systemPath}`;
// a login shell (macOS terminals) sets its PATH afresh: the stand-in stays on it as a user's agent would
for (const profile of [".profile", ".bash_profile", ".zprofile", ".zshrc", ".bashrc"]) writeFileSync(join(home, profile), `export PATH="${fakeBin}:$PATH"\n`);
for (const program of ["herdr", "hc", "herdr-core"]) {
  check(`no ${program} on the app's PATH`, Bun.which(program, { PATH }) === null, Bun.which(program, { PATH }) ?? "");
}

/** Linux: a display of the run's own, never the caller's (its X cookie stays in the caller's HOME) */
async function startDisplay(): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  const xvfb = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1440x900x24", "-nolisten", "tcp"], { stdio: ["ignore", "pipe", "ignore"] });
  owned.push(xvfb);
  const number = await new Promise<string>((done, reject) => {
    xvfb.stdout!.once("data", (chunk: Buffer) => done(chunk.toString().trim()));
    xvfb.once("error", () => reject(new Error("Xvfb did not start: install xvfb")));
    xvfb.once("exit", () => reject(new Error("Xvfb did not start")));
  });
  return `:${number}`;
}

let display: string | undefined;
/** an AppImage runs through FUSE 2; without libfuse.so.2 it is unpacked and run instead */
const noFuse2 = process.platform === "linux" && !(await Bun.$`ldconfig -p`.nothrow().quiet().text()).includes("libfuse.so.2");

function appEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: home,
    PATH,
    LANG: "C.UTF-8",
    TMPDIR: join(root, "tmp"),
    XDG_RUNTIME_DIR: join(root, "run"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    HC_SESSION: session,
    OVIS_E2E_RUN: runId,
    OVIS_UPDATES: "0",
    ...(display ? { DISPLAY: display } : {}),
    ...(noFuse2 ? { APPIMAGE_EXTRACT_AND_RUN: "1" } : {}),
    ...extra,
  };
}

// The app, driven through its main process's inspector.

class Inspector {
  private next = 1;
  private waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private listeners: ((method: string, params: any) => void)[] = [];
  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const entry = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        if (message.error) entry?.reject(new Error(message.error.message));
        else entry?.resolve(message.result);
      } else for (const listener of this.listeners) listener(message.method, message.params);
    });
    socket.addEventListener("close", () => {
      for (const entry of this.waiting.values()) entry.reject(new Error("the inspector closed"));
      this.waiting.clear();
    });
  }

  static async connect(port: number): Promise<Inspector> {
    const url = await until("the app's inspector", async () => {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { webSocketDebuggerUrl: string }[];
      return list[0]?.webSocketDebuggerUrl ?? null;
    }, 60_000);
    const socket = new WebSocket(url);
    await new Promise((done, reject) => {
      socket.addEventListener("open", done, { once: true });
      socket.addEventListener("error", () => reject(new Error("inspector connection failed")), { once: true });
    });
    return new Inspector(socket);
  }

  send(method: string, params: object = {}): Promise<any> {
    const id = this.next++;
    return new Promise((resolveCall, reject) => {
      this.waiting.set(id, { resolve: resolveCall, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(listener: (method: string, params: any) => void): void {
    this.listeners.push(listener);
  }

  /** an expression in the main process, awaited; `e2e` holds what the hook set up */
  async eval<T = unknown>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", { expression: `(async () => { const e2e = globalThis.__ovisE2e; return (${expression}); })()`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value as T;
  }

  close(): void {
    this.socket.close();
  }
}

/** run before the app's own code: the tray's menu, the browser opener and the notifications, made visible to the checks */
const HOOK = `(() => {
  const electron = require("electron");
  const e2e = globalThis.__ovisE2e = { electron, fs: require("fs"), trayMenu: null, opened: [], loads: [], notifications: [], updateChecks: [] };
  electron.app.on("web-contents-created", (_event, contents) => contents.on("did-finish-load", () => e2e.loads.push(contents.getURL())));
  const setContextMenu = electron.Tray.prototype.setContextMenu;
  electron.Tray.prototype.setContextMenu = function (menu) { e2e.trayMenu = menu; return setContextMenu.call(this, menu); };
  electron.shell.openExternal = async (url) => { e2e.opened.push(url); };
  // kept instead of handed to the desktop, which the run has none of, and told it was shown
  electron.Notification.prototype.show = function () { e2e.notifications.push(this); this.emit("show"); };
  e2e.notified = () => e2e.notifications.map((notification) => ({ title: notification.title, body: notification.body }));
  // the hourly update check, scheduled as the app does and also kept here to be run at once
  const setTimer = globalThis.setInterval;
  globalThis.setInterval = function (run, ms, ...rest) { if (ms === ${UPDATE_CHECK_INTERVAL_MS}) e2e.updateChecks.push(run); return setTimer.call(this, run, ms, ...rest); };
  e2e.window = () => electron.BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.getParentWindow() === null) ?? null;
  e2e.tray = () => (e2e.trayMenu ? e2e.trayMenu.items.map((item) => item.type === "separator" ? "-" : item.label + (item.enabled ? "" : " (off)")) : null);
  e2e.press = (label) => { const item = e2e.trayMenu?.items.find((entry) => entry.label === label); if (!item) throw new Error("no tray item " + label); if (!item.enabled) throw new Error("tray item " + label + " is off"); item.click(); return true; };
  return true;
})()`;

interface App {
  proc: ChildProcess;
  inspector: Inspector;
  mainPid: number;
  userData: string;
}

function command(app: string): string {
  return app.endsWith(".app") ? join(app, "Contents", "MacOS", basename(app, ".app")) : app;
}

/** Electron's own user data folder in the run's HOME, as an app started without --user-data-dir uses */
const defaultUserData = () => process.platform === "darwin" ? join(home, "Library", "Application Support", "Ovis") : join(home, ".config", "Ovis");

/** `userData` null: the app's default folder, as a user (or an update's relaunch) starts it */
async function launch(app: string, userData: string | null, options: { env?: Record<string, string>; args?: string[]; label: string }): Promise<App> {
  const port = await freePort();
  const output = Bun.file(join(out, `${options.label}.log`)).writer();
  const dataArgs = userData === null ? [] : [`--user-data-dir=${userData}`];
  const proc = spawn(command(app), [`--inspect-brk=127.0.0.1:${port}`, ...dataArgs, "--lang=en-US", ...(options.args ?? [])], { env: appEnv(options.env), stdio: ["ignore", "pipe", "pipe"], cwd: join(root, "work") });
  owned.push(proc);
  proc.stdout!.on("data", (chunk: Buffer) => output.write(chunk));
  proc.stderr!.on("data", (chunk: Buffer) => output.write(chunk));
  proc.once("exit", () => void output.end());
  const inspector = await Inspector.connect(port);
  const paused = new Promise<any>((done) => inspector.on((method, params) => { if (method === "Debugger.paused") done(params); }));
  await inspector.send("Debugger.enable");
  await inspector.send("Runtime.enable");
  await inspector.send("Runtime.runIfWaitingForDebugger");
  const frame = (await within(paused, 60_000, "the app's first pause")).callFrames[0];
  // another program may have taken the port between the probe and the app: only this run's app is driven
  const whose = await inspector.send("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId, expression: "process.env.OVIS_E2E_RUN ?? null", returnByValue: true });
  if (whose.result?.value !== runId) throw new Error(`The inspector on port ${port} is not this run's app`);
  const hooked = await inspector.send("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId, expression: HOOK, returnByValue: true });
  if (hooked.exceptionDetails) throw new Error(`The hook failed: ${hooked.exceptionDetails.exception?.description ?? hooked.exceptionDetails.text}`);
  await inspector.send("Debugger.resume");
  await inspector.send("Debugger.disable");
  const mainPid = await inspector.eval<number>("process.pid");
  return { proc, inspector, mainPid, userData: userData ?? defaultUserData() };
}

async function screenshot(app: App, name: string): Promise<void> {
  try {
    const png = await app.inspector.eval<string | null>("e2e.window()?.webContents.capturePage().then((image) => image.toPNG().toString('base64')) ?? null");
    if (png) writeFileSync(join(out, `${name}.png`), Buffer.from(png, "base64"));
  } catch (error) {
    log(`screenshot ${name} failed: ${String(error)}`);
  }
}

type Saved = { port: number | null; server: { pid: number; bun: string; started: string | null } | null };
const saved = (app: Pick<App, "userData">): Saved => JSON.parse(readFileSync(join(app.userData, "desktop.json"), "utf8")) as Saved;

/** the window shows the server's page, loaded and drawn; resolves to the server's address */
async function ovisLoaded(app: App, timeoutMs = 120_000): Promise<string> {
  return until("Ovis to load in the window", async () => {
    const state = await app.inspector.eval<{ url: string; loading: boolean; drawn: number } | null>(`(async () => {
      const window = e2e.window();
      if (!window) return null;
      const url = window.webContents.getURL();
      if (!url.startsWith("http://127.0.0.1:") || window.webContents.isLoading()) return { url, loading: true, drawn: 0 };
      const drawn = await window.webContents.executeJavaScript("document.getElementById('root')?.childElementCount ?? 0");
      return { url, loading: false, drawn };
    })()`);
    return state && !state.loading && state.drawn > 0 ? new URL(state.url).origin : null;
  }, timeoutMs);
}

/** the text the window shows */
function pageText(app: App): Promise<string> {
  return app.inspector.eval<string>("e2e.window()?.webContents.executeJavaScript('document.body.innerText') ?? ''");
}

/** presses the first button in the page whose text starts with `label`; false when there is none */
function pressButton(app: App, label: string): Promise<boolean> {
  return app.inspector.eval<boolean>(`e2e.window().webContents.executeJavaScript(${JSON.stringify(`(() => { const button = [...document.querySelectorAll("button")].find((b) => b.innerText.trim().startsWith(${JSON.stringify(label)})); button?.click(); return !!button; })()`)})`);
}

/** whether the page has a button whose text starts with `label` */
function hasButton(app: App, label: string): Promise<boolean> {
  return app.inspector.eval<boolean>(`e2e.window().webContents.executeJavaScript(${JSON.stringify(`[...document.querySelectorAll("button")].some((b) => b.innerText.trim().startsWith(${JSON.stringify(label)}))`)})`);
}

/** the page's sidebar shows both workspaces this run made */
function listsBoth(app: App): Promise<boolean> {
  return until("the roster drawn", async () => { const text = await pageText(app); return (text.includes("e2e terminal") && text.includes("e2e agent")) || null; }, 30_000).catch(() => false);
}

async function api<T>(origin: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${origin}${path}`, body === undefined ? {} : { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

type Pane = { pane_id: string; agent?: string | null; workspace_id?: string };
async function panes(origin: string): Promise<Pane[]> {
  const { snapshot } = await api<{ snapshot: { panes: Pane[] } }>(origin, "/api/session");
  return snapshot.panes;
}

async function quit(app: App, how: "quit" | "tray"): Promise<boolean> {
  await app.inspector.eval(how === "tray" ? `e2e.press("Quit Ovis")` : "(e2e.electron.app.quit(), true)").catch(() => {});
  // a process with an inspector attached waits at its exit for it to go
  app.inspector.close();
  return exited(app.proc, 30_000);
}

/** a terminal as the app's hc tells it: its state and the program in front */
/** the stand-in agent in front: Linux names a script's process after it, macOS after its interpreter */
const runsClaude = (info: { foreground?: { name: string; argv?: string[] } | null } | null) => info?.foreground?.name === "claude" || (info?.foreground?.argv ?? []).some((arg) => arg.endsWith("/claude"));

async function terminalInfo(userData: string, id: string): Promise<{ state: string; foreground?: { name: string; argv?: string[] } | null } | null> {
  const got = await hc(userData, "get", id);
  return got.code === 0 ? JSON.parse(got.text) : null;
}

/** hc run with the app's own copy and session, as a terminal on this PC would */
async function hc(userData: string, ...args: string[]): Promise<{ code: number; text: string }> {
  const proc = Bun.spawn([join(userData, "bin", "herdr-core"), ...args], { env: appEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text() + await new Response(proc.stderr).text();
  return { code: await proc.exited, text };
}

// The scenarios.

async function lifecycle(app: string): Promise<void> {
  const userData = join(root, "user-data");
  const marker = `E2E_MARK_${process.pid}`;

  // 1. first launch on a PC with nothing installed: the connection screen, then Ovis
  let first = await launch(app, userData, { label: "1-first-launch" });
  const connect = await until("the first page", () => first.inspector.eval<string | null>("e2e.loads[0] ?? null"), 30_000).catch(() => "");
  check("first launch shows the connection screen first", connect.startsWith("file:") && connect.endsWith("connect.html"), connect);
  // a screenshot only while it is still up: on a fast PC the server answers before the window is shown
  const stillConnecting = await until("the window shown", () => first.inspector.eval<string | null>("(e2e.window()?.isVisible() && e2e.window().webContents.getURL()) || null"), 30_000).catch(() => "");
  if (stillConnecting.startsWith("file:")) await screenshot(first, "1-connection-screen");
  const origin = await ovisLoaded(first).catch((error) => (check("first launch opens Ovis", false, String(error)), null));
  if (!origin) {
    await screenshot(first, "1-failed");
    log(`the window says: ${(await pageText(first).catch(() => "")).replace(/\s+/g, " ").slice(0, 400)}`);
    return;
  }
  check("first launch opens Ovis", true, origin);
  await until("the page's sidebar", async () => (await pageText(first)).includes("New workspace") || null, 30_000).catch(() => null);
  const pushFault = await until("an alerts notice", async () => /push subscription is missing/.test(await pageText(first)) || null, 10_000).catch(() => false);
  knownBug("a fresh first launch shows no alerts fault", pushFault !== true, PUSH_ISSUE, pushFault === true ? "This device's push subscription is missing. Turn alerts on again." : "");
  await screenshot(first, "2-ovis-loaded");
  if (pushFault === true && await pressButton(first, "Turn alerts on again")) {
    const after = await until("the repair's answer", async () => { const text = await pageText(first); return /push subscription is missing\. Turn alerts on again\./.test(text) ? null : text; }, 15_000).catch(() => null);
    const notice = (after ?? await pageText(first)).split("\n").find((line) => /alert|push|notif/i.test(line)) ?? "no notice left";
    log(`after Turn alerts on again: ${notice}`);
    await screenshot(first, "2b-after-turn-alerts-on");
  }
  await pressButton(first, "I've used Ovis before");
  check("the core runs from a copy in the user data folder", existsSync(join(userData, "bin", "herdr-core")));

  // 2. a terminal and an agent pane in the app's own core
  const terminal = await api<{ pane_id: string }>(origin, "/api/workspace/create", { label: "e2e terminal", cwd: join(root, "work") });
  await until("the terminal's shell", () => api(origin, "/api/pane/input", { pane_id: terminal.pane_id, text: `echo ${marker}\r` }).then(() => true), 30_000);
  const echoed = await until("the marker on the terminal's screen", async () => {
    const read = await api<{ text?: string; content?: string }>(origin, `/api/pane/read?pane_id=${encodeURIComponent(terminal.pane_id)}&source=recent&lines=50`);
    return JSON.stringify(read).includes(`${marker}`) && JSON.stringify(read).split(marker).length > 2 ? true : null;
  }, 30_000).catch(() => false);
  check("a new terminal runs what is typed into it", echoed === true, terminal.pane_id);
  const agent = await api<{ pane_id: string; agent_started: boolean; error?: { message: string } }>(origin, "/api/workspace/create", { label: "e2e agent", cwd: join(root, "work"), agent: { kind: "claude" } });
  check("an agent pane starts", agent.agent_started, agent.error?.message ?? agent.pane_id);
  const running = await until("claude in front of the agent pane", async () => runsClaude(await terminalInfo(userData, agent.pane_id)) || null, 30_000).catch(() => false);
  const agentScreen = running === true ? "" : JSON.stringify(await api(origin, `/api/pane/read?pane_id=${encodeURIComponent(agent.pane_id)}&source=recent&lines=20`).catch(String)).slice(-400);
  check("the agent runs in its pane in the app's core", running === true, agentScreen);
  // hc names a pane's agent only from what the agent reports itself (its hooks); the stand-in reports nothing
  log(`roster agent for ${agent.pane_id}: ${(await panes(origin)).find((pane) => pane.pane_id === agent.pane_id)?.agent ?? "none"}`);
  await first.inspector.eval("e2e.window()?.webContents.reload()");
  await ovisLoaded(first);
  check("the window lists the terminal and the agent", await listsBoth(first));
  await screenshot(first, "3-terminal-and-agent");

  // 3. quit: the server stops, the terminals keep running
  const serverPid = saved(first).server?.pid ?? -1;
  check("quit ends the app", await quit(first, "quit"));
  check("quit stops the server", !alive(serverPid) && saved(first).server === null, `pid ${serverPid}`);
  const [term, agentTerm] = await Promise.all([terminalInfo(userData, terminal.pane_id), terminalInfo(userData, agent.pane_id)]);
  check("the terminals keep running after quit", term?.state === "live" && agentTerm?.state === "live" && runsClaude(agentTerm), `${term?.state} / ${agentTerm?.state} ${agentTerm?.foreground?.name ?? ""}`);

  // 4. relaunch finds them, on the same address
  let second = await launch(app, userData, { label: "2-relaunch" });
  const origin2 = await ovisLoaded(second);
  check("relaunch keeps the address (and the page's storage)", origin2 === origin, `${origin} -> ${origin2}`);
  const found = (await panes(origin2)).map((pane) => pane.pane_id);
  check("relaunch finds the terminal and the agent", found.includes(terminal.pane_id) && found.includes(agent.pane_id), found.join(", "));
  const kept = JSON.stringify(await api(origin2, `/api/pane/read?pane_id=${encodeURIComponent(terminal.pane_id)}&source=recent&lines=50`));
  check("the terminal kept its output", kept.includes(marker));
  check("after relaunch the window lists the terminal and the agent", await listsBoth(second));
  await screenshot(second, "4-after-relaunch");

  // 5. the tray
  const items = await until("the tray menu", () => second.inspector.eval<string[] | null>("e2e.tray()"), 10_000);
  check("the tray menu has its items", ["Open Ovis", "Open in Browser", "Restart Ovis Server", "Quit Ovis"].every((label) => items.includes(label)), items.join(" / "));
  await second.inspector.eval(`e2e.press("Open in Browser")`);
  const opened = await second.inspector.eval<string[]>("e2e.opened");
  check("tray: Open in Browser opens the server's address", opened.some((url) => url.startsWith(origin2)), opened.join(", "));
  await second.inspector.eval("e2e.window().close()");
  const hidden = await until("the window to hide", async () => (await second.inspector.eval<boolean>("e2e.window()?.isVisible() ?? false")) ? null : true, 5_000).catch(() => false);
  check("closing the window keeps Ovis in the tray", hidden === true && alive(second.mainPid) && saved(second).server !== null);
  await second.inspector.eval(`e2e.press("Open Ovis")`);
  const shown = await until("the window to show", () => second.inspector.eval<boolean>("e2e.window()?.isVisible() ?? false"), 5_000).catch(() => false);
  check("tray: Open Ovis shows the window again", shown === true);
  const before = saved(second).server?.pid ?? -1;
  await second.inspector.eval(`e2e.press("Restart Ovis Server")`);
  const after = await until("a new server", () => { const pid = saved(second).server?.pid; return pid !== undefined && pid !== before ? pid : null; }, 60_000).catch(() => -1);
  await ovisLoaded(second).catch(() => null);
  check("tray: Restart Ovis Server starts a new server", after !== -1 && !alive(before) && (await panes(origin2).catch(() => [])).length > 0, `${before} -> ${after}`);
  await until("the roster drawn", async () => (await pageText(second)).includes("e2e terminal") || null, 20_000).catch(() => null);
  await screenshot(second, "5-after-tray-restart");
  const server2 = saved(second).server?.pid ?? -1;
  check("tray: Quit Ovis ends the app", await quit(second, "tray"));
  check("tray: Quit Ovis stops the server", !alive(server2) && saved(second).server === null);

  // 6. killed outright: the next start ends the server left behind
  const third = await launch(app, userData, { label: "3-before-kill" });
  await ovisLoaded(third);
  const orphan = saved(third).server?.pid ?? -1;
  third.inspector.close();
  process.kill(third.mainPid, "SIGKILL");
  await exited(third.proc, 30_000);
  check("after kill -9 the server is left running", alive(orphan), `pid ${orphan}`);
  const fourth = await launch(app, userData, { label: "4-after-kill" });
  const origin4 = await ovisLoaded(fourth).catch(() => null);
  const ended = await until("the old server to end", () => !alive(orphan), 15_000).catch(() => false);
  check("the next start ends the server left behind", ended === true, `pid ${orphan}`);
  check("the next start serves Ovis again", origin4 !== null && (saved(fourth).server?.pid ?? orphan) !== orphan, origin4 ?? "");
  const found4 = origin4 ? (await panes(origin4)).map((pane) => pane.pane_id) : [];
  check("the terminals survive a killed app", found4.includes(terminal.pane_id) && found4.includes(agent.pane_id));
  await until("the roster drawn", async () => (await pageText(fourth)).includes("e2e terminal") || null, 20_000).catch(() => null);
  await screenshot(fourth, "6-after-kill-restart");
  await quit(fourth, "quit");
}

// Update: two builds of the same stage, the older one updated from a local https feed.

async function packageVersion(version: string, output: string, feed?: string): Promise<void> {
  const args = [join(here, "node_modules", ".bin", "electron-builder"), "--linux", `--${process.arch}`, "--publish", "never", `-c.extraMetadata.version=${version}`, `-c.directories.output=${output}`];
  if (feed) args.push("-c.publish.provider=generic", `-c.publish.url=${feed}`);
  const child = Bun.spawn(args, { cwd: here, env: process.env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`electron-builder failed for ${version}`);
}

async function update(): Promise<void> {
  if (!existsSync(join(here, "stage", "versions.json")) || !existsSync(join(here, "out", "main.js"))) throw new Error("Build first (bun run dist): --update packages stage/ and out/");
  const builds = join(root, "builds");
  // electron-builder writes latest-linux.yml only for a build that names a feed, as a release build does;
  // the old one is pointed at the local feed at run time with OVIS_UPDATE_URL
  await packageVersion("0.0.1", join(builds, "old"), "https://127.0.0.1/");
  await packageVersion("0.0.2", join(builds, "new"), "https://127.0.0.1/");
  const oldImage = readdirSync(join(builds, "old")).find((name) => name.endsWith(".AppImage"))!;
  const newImage = readdirSync(join(builds, "new")).find((name) => name.endsWith(".AppImage"))!;
  const feedDir = join(root, "feed");
  mkdirSync(feedDir);
  for (const name of readdirSync(join(builds, "new"))) if (name.endsWith(".AppImage") || name.endsWith(".yml") || name.endsWith(".blockmap")) copyFileSync(join(builds, "new", name), join(feedDir, name));
  check("the newer build writes its feed file", existsSync(join(feedDir, "latest-linux.yml")));

  // the feed, over https with a certificate made for it (the app is told to accept it)
  const cert = join(root, "cert");
  mkdirSync(cert);
  await Bun.$`openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1 -keyout ${join(cert, "key.pem")} -out ${join(cert, "cert.pem")}`.quiet();
  const requests: string[] = [];
  const feed = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 120,
    tls: { cert: Bun.file(join(cert, "cert.pem")), key: Bun.file(join(cert, "key.pem")) },
    fetch(request) {
      const name = basename(new URL(request.url).pathname);
      requests.push(name);
      const file = join(feedDir, name);
      return existsSync(file) ? new Response(Bun.file(file)) : new Response("not found", { status: 404 });
    },
  });
  try {
    const installed = join(root, "Applications", oldImage);
    mkdirSync(join(root, "Applications"));
    copyFileSync(join(builds, "old", oldImage), installed);
    chmodSync(installed, 0o755);

    // in a folder that cannot be written the AppImage cannot replace itself: it says its updates are off, and asks its feed for nothing
    if (process.getuid?.() === 0) {
      log("run as root, who can write everywhere: the AppImage in a folder that cannot be written is not checked");
    } else {
      const fixedData = join(root, "user-data-fixed");
      chmodSync(join(root, "Applications"), 0o555);
      try {
        const fixed = await launch(installed, fixedData, { label: "5a-update-unwritable", env: { OVIS_UPDATES: "1", OVIS_UPDATE_URL: `https://127.0.0.1:${feed.port}/` }, args: ["--ignore-certificate-errors"] });
        await ovisLoaded(fixed);
        const said = await until("the app's word on its updates", () => readFileSync(join(fixedData, "logs", "ovis.log"), "utf8").split("\n").find((line) => line.startsWith("Updates")) ?? null, 30_000).catch(() => "");
        check("an AppImage in a folder that cannot be written does not update itself", /^Updates are off: the AppImage is in a folder that cannot be written/.test(said) && requests.length === 0, `${said}; feed asked ${requests.length} times`);
        await quit(fixed, "quit");
        await within(hc(fixedData, "server", "stop"), 30_000, "hc server stop").catch(() => {});
      } finally {
        chmodSync(join(root, "Applications"), 0o755);
      }
    }

    // the app's default folder, as a user runs it: the relaunch after the update must find the same one
    const app = await launch(installed, null, {
      label: "5-update",
      env: { OVIS_UPDATES: "1", OVIS_UPDATE_URL: `https://127.0.0.1:${feed.port}/` },
      args: ["--ignore-certificate-errors"],
    });
    await ovisLoaded(app);
    check("the old build runs as 0.0.1", await app.inspector.eval<string>("e2e.electron.app.getVersion()") === "0.0.1");
    const items = await until("Restart to Update in the tray", async () => {
      const labels = await app.inspector.eval<string[] | null>("e2e.tray()");
      return labels?.includes("Restart to Update") ? labels : null;
    }, 180_000).catch(() => null);
    check("the update downloads and the tray offers Restart to Update", items !== null, `feed asked for: ${[...new Set(requests)].join(", ")}`);
    if (!items) return;

    // the update announces itself: one notification, whose click opens the window
    const ready = "Ovis 0.0.2 is ready";
    const notifies = await app.inspector.eval<boolean>("e2e.electron.Notification.isSupported()");
    if (notifies) {
      const notified = await until("the update's notification", async () => {
        const shown = await app.inspector.eval<{ title: string; body: string }[]>("e2e.notified()");
        return shown.length > 0 ? shown : null;
      }, 10_000).catch(() => []);
      check("the update is announced with one notification", notified.length === 1 && notified[0]!.title === ready && notified[0]!.body === "Restart to update.", JSON.stringify(notified));
      await app.inspector.eval("e2e.window().close()");
      await until("the window to hide", async () => (await app.inspector.eval<boolean>("e2e.window()?.isVisible() ?? false")) ? null : true, 5_000).catch(() => null);
      await app.inspector.eval("(e2e.notifications[0]?.emit('click'), true)");
      const shown = await until("the window to show", () => app.inspector.eval<boolean>("e2e.window()?.isVisible() ?? false"), 5_000).catch(() => false);
      check("the notification's click opens the window", shown === true);
      // the checks below look at the window either way
      if (shown !== true) await app.inspector.eval("(e2e.window()?.show(), true)");
    } else {
      log("this PC shows no notifications (no libnotify): the update's notification is not checked");
    }

    // and a line in the window, with the tray's action
    await pressButton(app, "I've used Ovis before");
    const lined = async () => { const text = await pageText(app); return text.includes(`${ready}.`) && await hasButton(app, "Restart to Update"); };
    const line = await until("the update's line in the window", async () => (await lined()) || null, 30_000).catch(() => false);
    check("the window says the update is ready, with Restart to Update", line === true);
    await screenshot(app, "7-update-ready");
    /** what the app keeps of what it said (src/updates.ts UpdateNotices); nothing while it has written none */
    const notices = (): { notified: string | null; closed: string | null } => {
      try { return JSON.parse(readFileSync(join(app.userData, "update-notice.json"), "utf8")); } catch { return { notified: null, closed: null }; }
    };
    /** the update's line among the lines over the pane, which share its row and its close button */
    const inLine = (find: string) => `[...document.querySelectorAll(".update-notice")].find((line) => line.innerText.includes(${JSON.stringify(ready)}))?.querySelector(${JSON.stringify(find)})?.click()`;
    if (fromTray) {
      await app.inspector.eval(`e2e.window().webContents.executeJavaScript(${JSON.stringify(inLine(".update-notice-dismiss"))})`);
      const gone = await until("the line to close", async () => (await lined()) ? null : true, 10_000).catch(() => false);
      check("the line closes for this version, and the tray keeps Restart to Update", gone === true && notices().closed === "0.0.2" && (await app.inspector.eval<string[] | null>("e2e.tray()"))?.includes("Restart to Update") === true, JSON.stringify(notices()));
    }

    // an hour later: the feed is asked again, and the version already held is neither downloaded nor announced again
    const feedAsked = () => requests.filter((name) => name === "latest-linux.yml").length;
    const downloadsLogged = () => readFileSync(join(app.userData, "logs", "ovis.log"), "utf8").split("\n").filter((line) => line.startsWith("Update 0.0.2 is downloaded")).length;
    const notifiedCount = async () => (await app.inspector.eval<unknown[]>("e2e.notified()")).length;
    const before = { asked: feedAsked(), downloads: downloadsLogged(), notified: await notifiedCount() };
    const hourly = await app.inspector.eval<number>("(e2e.updateChecks.forEach((run) => run()), e2e.updateChecks.length)");
    const askedAgain = await until("the feed asked again", () => feedAsked() > before.asked || null, 30_000).catch(() => false);
    // electron-updater answers a download of the version it holds from its file at once: a second download would be logged within these seconds
    const again = await until("the held version downloaded or announced again", async () => downloadsLogged() > before.downloads || await notifiedCount() > before.notified || null, 10_000).catch(() => false);
    check("a later check asks the feed and leaves the version already held alone", hourly === 1 && before.downloads === 1 && askedAgain === true && again === false,
      `hourly checks ${hourly}, feed asked ${before.asked} -> ${feedAsked()}, downloads logged ${before.downloads} -> ${downloadsLogged()}, notifications ${before.notified} -> ${await notifiedCount()}`);

    // the server stopped: the connection screen offers the update too, also with the line closed
    const stopped = saved(app).server?.pid;
    // never a pid that is not the server's: kill(-1) would end every process of the user
    if (stopped === undefined || stopped <= 0) {
      check("the server runs before it is stopped for the connection screen", false, "no server recorded");
      return;
    }
    process.kill(stopped, "SIGKILL");
    const offered = await until("the connection screen's update line", async () => {
      const text = await pageText(app);
      return (text.includes("Ovis stopped") && text.includes(ready) && await hasButton(app, "Restart to Update")) || null;
    }, 30_000).catch(() => false);
    check("the connection screen offers the update when the server has stopped", offered === true);
    await screenshot(app, "8-update-ready-connection-screen");
    await pressButton(app, "Try again");
    await ovisLoaded(app);
    let server = await until("a new server", () => { const pid = saved(app).server?.pid; return pid !== undefined && pid !== stopped ? pid : null; }, 60_000).catch(() => -1);
    if (notifies) check("one notification so far, recorded for its version", (await app.inspector.eval<unknown[]>("e2e.notified()")).length === 1 && notices().notified === "0.0.2", JSON.stringify(notices()));

    // the held file goes while the server stops for Restart to Update (as a later download that fails removes it):
    // Ovis starts again as it was, without the offer, and the next check brings the update back without announcing it twice
    const heldFile = join(home, ".cache", "ovis-desktop-updater", "pending", newImage);
    const offers = async () => (await app.inspector.eval<string[] | null>("e2e.tray()"))?.includes("Restart to Update") === true;
    // pressed and removed in one turn of the app: the press has passed its own look at the file, and the server has not stopped yet
    const lost = existsSync(heldFile) && await app.inspector.eval<boolean>(`(e2e.press("Restart to Update"), e2e.fs.rmSync(${JSON.stringify(heldFile)}), true)`).catch(() => false);
    const resumed = await until("Ovis started again", () => { const pid = saved(app).server?.pid; return pid !== undefined && pid !== server ? pid : null; }, 60_000).catch(() => -1);
    await ovisLoaded(app).catch(() => null);
    check("an update gone by the time the server has stopped starts Ovis again as it was, without the offer", lost === true && resumed !== -1 && !alive(server) && alive(app.mainPid) && !(await offers()),
      `server ${server} -> ${resumed}, tray: ${(await app.inspector.eval<string[] | null>("e2e.tray()"))?.join(" / ")}`);
    if (resumed !== -1) server = resumed;
    await app.inspector.eval("(e2e.updateChecks.forEach((run) => run()), true)");
    const back = await until("Restart to Update in the tray again", async () => (await offers()) || null, 120_000).catch(() => false);
    check("the next check downloads it again, and announces nothing twice", back === true && existsSync(heldFile) && (!notifies || await notifiedCount() === 1), `notifications ${await notifiedCount()}`);

    if (fromTray) {
      // a reload later, the closed line is still closed
      await until("the page's sidebar", async () => (await pageText(app)).includes("New workspace") || null, 30_000).catch(() => null);
      check("the closed line stays closed after the page loads again", !(await lined()));
      await app.inspector.eval(`e2e.press("Restart to Update")`).catch(() => {});
    } else {
      const again = await until("the update's line again", async () => (await lined()) || null, 30_000).catch(() => false);
      check("the line is back after the page loads again", again === true);
      // not awaited: the app answers only when it keeps running
      await app.inspector.eval(`(e2e.window().webContents.executeJavaScript(${JSON.stringify(inLine(".btn-primary"))}), true)`).catch(() => {});
    }
    app.inspector.close();
    check("Restart to Update quits the old build", await exited(app.proc, 60_000));
    check("Restart to Update stops the old server", !alive(server));
    const want = sha(join(feedDir, newImage));
    const replaced = await until("the new AppImage in place", () => readdirSync(join(root, "Applications")).find((name) => name.endsWith(".AppImage") && sha(join(root, "Applications", name)) === want) ?? null, 30_000).catch(() => null);
    check("the AppImage on disk is the new version", replaced !== null && readdirSync(join(root, "Applications")).length === 1, readdirSync(join(root, "Applications")).join(", "));
    // the app comes back up by itself, from the new file, with the same data (its saved port) and a new server
    const port = saved(app).port;
    const relaunched = await until("the updated app to serve Ovis", async () => {
      const now = saved(app).server;
      if (!now || now.pid === server || !(await fetch(`http://127.0.0.1:${port}/api/session`)).ok) return null;
      const list = await Bun.$`ps -eo args=`.quiet().text();
      return replaced && list.includes(join(root, "Applications", replaced)) ? now.pid : null;
    }, 120_000).catch(() => null);
    check("Restart to Update starts the updated app again, on its data", relaunched !== null, relaunched ? `server ${relaunched} on port ${port}` : "nothing started");
  } finally {
    feed.stop(true);
  }
}


/** the processes this run started, and theirs: every one whose environment carries the run's id */
async function runProcesses(): Promise<number[]> {
  const mark = `OVIS_E2E_RUN=${runId}`;
  if (process.platform === "linux") {
    return readdirSync("/proc").filter((name) => /^\d+$/.test(name)).filter((pid) => {
      try { return readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(mark); } catch { return false; }
    }).map(Number);
  }
  // macOS: ps -E adds a process's environment to its line (for the caller's own processes)
  const list = await Bun.$`ps -E -ww -A -o pid=,command=`.quiet().text();
  return list.split("\n").filter((line) => line.split(/\s+/).includes(mark)).map((line) => Number(line.trim().split(/\s+/)[0]));
}

let cleaned = false;
async function cleanUp(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  // the app's own core (and the one an updated app started), then every process this run started
  for (const userData of [join(root, "user-data"), defaultUserData()]) {
    if (existsSync(join(userData, "bin", "herdr-core"))) await within(hc(userData, "server", "stop"), 30_000, "hc server stop").catch(() => {});
  }
  // a server or app still up may start the core again while the others go: swept until none is left
  const sweep = async () => {
    const pids = (await runProcesses()).filter((pid) => pid !== process.pid);
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    return pids.length === 0;
  };
  const deadline = Date.now() + 20_000;
  while (!(await sweep()) && Date.now() < deadline) await Bun.sleep(200);
  for (const child of owned) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (!keep) rmSync(root, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void cleanUp().finally(() => process.exit(130)));

let crashed: unknown = null;
try {
  display = await startDisplay();
  if (updateMode) await update();
  else await lifecycle(resolve(appArg!));
} catch (error) {
  crashed = error;
  check("the run finished", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  try {
    writeFileSync(join(out, "results.json"), JSON.stringify({ platform: `${process.platform}-${process.arch}`, noFuse2, checks }, null, 2));
  } finally {
    await cleanUp();
  }
}
const failed = checks.filter((entry) => !entry.ok && !entry.known);
const known = checks.filter((entry) => !entry.ok && entry.known).length;
console.log(`\n${checks.length - failed.length - known}/${checks.length} checks passed${known ? `, ${known} known bug${known > 1 ? "s" : ""}` : ""}; screenshots and logs in ${out}`);
process.exit(failed.length === 0 && crashed === null ? 0 : 1);
