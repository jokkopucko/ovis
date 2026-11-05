/**
 * Ovis for the desktop: one window on the Ovis server this app runs itself, on the herdr-core
 * (`hc`) and Bun it carries. Until the server answers, or when it stops, the window shows the
 * connection screen (renderer/connect.html) with what failed. Closing the window keeps Ovis in
 * the tray; Quit stops the server. The core and its terminals keep running, as for every hc client.
 */
import { app, BrowserWindow, ipcMain, Menu, nativeImage, session, shell, Tray, type MenuItemConstructorOptions } from "electron";
import { existsSync, readFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChildProcess } from "node:child_process";
import { choosePort, coreEnv, endLeftover, installCore, isFile, layout, openLog, processCommand, processStartSync, readSaved, serverEnv, startCore, startServer, stopServer, writeSaved, type RunningServer } from "./children.ts";
import { updateChannel, updatePlan } from "./updates.ts";

type StepState = "pending" | "ok" | "failed";
export interface Status {
  core: StepState;
  server: StepState | "stopped";
  detail: string;
  versions: { hc: string; bun: string } | null;
}

const resources = app.isPackaged ? join(process.resourcesPath, "ovis") : process.env["OVIS_DESKTOP_STAGE"] || join(app.getAppPath(), "stage");
const programs = layout(resources);
const versions = (() => {
  try { return JSON.parse(readFileSync(join(resources, "versions.json"), "utf8")) as { hc: string; bun: string }; } catch { return null; }
})();
const logs = join(app.getPath("userData"), "logs");
const savedPath = join(app.getPath("userData"), "desktop.json");
const stateDir = process.env["OVIS_STATE_DIR"] || join(app.getPath("userData"), "server");
// from the app's root (this folder, or app.asar): the bundler fixes __dirname to where it was built
const connectPage = join(app.getAppPath(), "renderer", "connect.html");
const connectPageUrl = pathToFileURL(connectPage).href;
const preload = join(app.getAppPath(), "out", "preload.js");
const iconPath = app.isPackaged ? join(process.resourcesPath, "icon.png") : join(app.getAppPath(), "..", "assets", "icon-only.png");

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: RunningServer | null = null;
/** the start or restart in progress; another one asked for meanwhile is dropped */
let busy: Promise<void> | null = null;
/** the server being started, before it says where it listens */
let spawning: ChildProcess | null = null;
let quitting = false;
let stopped = false;
let updateReady: (() => void) | null = null;
let status: Status = { core: "pending", server: "pending", detail: "", versions };

function serverOrigin(): string | null {
  return server ? new URL(server.url).origin : null;
}

function ours(url: string): boolean {
  try { return new URL(url).origin === serverOrigin(); } catch { return false; }
}

function openOutside(url: string): void {
  try {
    if (["http:", "https:", "mailto:"].includes(new URL(url).protocol)) void shell.openExternal(url);
  } catch { /* not an address */ }
}

function setStatus(next: Partial<Status>): void {
  status = { ...status, ...next };
  window?.webContents.send("ovis:status", status);
  rebuildTrayMenu();
}

function showConnect(): void {
  if (window && !window.webContents.getURL().startsWith("file:")) void window.loadFile(connectPage);
}

function showWindow(): void {
  if (!window) createWindow();
  window!.show();
  window!.focus();
}

function lifecycle(task: () => Promise<void>): Promise<void> {
  if (busy !== null || quitting) return busy ?? Promise.resolve();
  busy = task().finally(() => {
    busy = null;
    rebuildTrayMenu();
  });
  rebuildTrayMenu();
  return busy;
}

const start = () => lifecycle(launch);

const restart = () => lifecycle(async () => {
  const running = server;
  server = null;
  if (running) await stopServer(running);
  await launch();
});

async function launch(): Promise<void> {
  setStatus({ core: "pending", server: "pending", detail: "" });
  showConnect();
  let log: WriteStream | null = null;
  try {
    if (!isFile(programs.bun) || !isFile(programs.hc)) {
      setStatus({ core: "failed", detail: `This build has no bundled herdr-core and Bun in ${resources}. Build it with \`bun scripts/build.ts stage\` in app/electron.` });
      return;
    }
    log = openLog(join(logs, "ovis.log"));
    let hc: string;
    try {
      hc = await installCore(programs.hc, join(app.getPath("userData"), "bin"), coreEnv(process.env), log);
      await startCore(hc, coreEnv(process.env), log);
      setStatus({ core: "ok" });
    } catch (error) {
      setStatus({ core: "failed", detail: message(error) });
      return;
    }
    const saved = readSaved(savedPath);
    if (await endLeftover(saved.server)) await waitUntilEnded(saved.server!.pid, 10_000);
    const port = await choosePort(saved.port);
    // a quit during the steps above: no server is started for it
    if (quitting) return;
    try {
      // recorded as soon as it runs, so a crash of the app before it listens still leaves its pid behind
      const running = await startServer(programs, serverEnv(process.env, { hc, stateDir, port }), log, 60_000, (child) => {
        spawning = child;
        writeSaved(savedPath, { port, server: { pid: child.pid!, bun: programs.bun, started: processStartSync(child.pid!) } });
      });
      spawning = null;
      if (quitting) {
        await stopServer(running);
        writeSaved(savedPath, { port, server: null });
        return;
      }
      server = running;
      const runLog = log;
      void running.exited.then((code) => {
        runLog.end();
        if (server !== running) return;
        server = null;
        writeSaved(savedPath, { port, server: null });
        if (quitting) return;
        const how = code !== null ? `exit code ${code}` : `signal ${running.child.signalCode ?? "unknown"}`;
        setStatus({ server: "stopped", detail: `The Ovis server stopped (${how}). Its output is in the logs.` });
        showConnect();
      });
      setStatus({ server: "ok" });
    } catch (error) {
      spawning = null;
      writeSaved(savedPath, { port, server: null });
      setStatus({ server: "failed", detail: message(error) });
    }
  } finally {
    if (log && !server) log.end();
  }
  // a load that fails (or another one cut it short) leaves the server running and recorded
  if (server) await window?.loadURL(server.url).catch((error: unknown) => console.error(`Opening ${server?.url} failed: ${message(error)}`));
}

async function waitUntilEnded(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && await processCommand(pid) !== null) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** stops the server once; a quit (or an update's) waits for it, then goes ahead */
async function stopForQuit(): Promise<void> {
  quitting = true;
  // a server still starting ends now; the start in progress then returns
  spawning?.kill("SIGTERM");
  await busy;
  const running = server;
  if (running) await stopServer(running).catch(() => {});
  stopped = true;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 420,
    minHeight: 480,
    title: "Ovis",
    backgroundColor: "#12100e",
    autoHideMenuBar: true,
    show: false,
    ...(process.platform === "linux" ? { icon: iconPath } : {}),
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.once("ready-to-show", () => window?.show());
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window?.hide();
  });
  window.on("closed", () => { window = null; });
  guard(window.webContents);
  void window.loadFile(connectPage);
}

/**
 * The server's own pages may open more Ovis windows; any other address goes to the default browser.
 * A blank window a page opens to send somewhere next (a sign-in) is allowed: once it heads for
 * another address, that address opens in the default browser and the window closes.
 */
function guard(contents: Electron.WebContents, blank?: BrowserWindow): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (ours(url) || (url === "about:blank" && ours(contents.getURL()))) {
      return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: "#12100e", webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } } };
    }
    openOutside(url);
    return { action: "deny" };
  });
  contents.on("did-create-window", (child, { url }) => guard(child.webContents, url === "about:blank" ? child : undefined));
  contents.on("will-navigate", (event, url) => {
    if (ours(url) || url === connectPageUrl) return;
    event.preventDefault();
    openOutside(url);
    blank?.close();
  });
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const url = server?.url ?? null;
  const items: MenuItemConstructorOptions[] = [
    { label: "Open Ovis", click: showWindow },
    { label: "Open in Browser", enabled: url !== null, click: () => url && openOutside(url) },
    { type: "separator" },
    { label: "Restart Ovis Server", enabled: busy === null, click: () => void restart() },
    ...(updateReady ? [{ label: "Restart to Update", click: updateReady }] : []),
    { type: "separator" },
    { label: "Quit Ovis", click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray(): void {
  const image = nativeImage.createFromPath(iconPath).resize({ width: process.platform === "darwin" ? 18 : 24 });
  tray = new Tray(image);
  tray.setToolTip("Ovis");
  tray.on("click", showWindow);
  rebuildTrayMenu();
}

function createMenu(): void {
  const openInBrowser: MenuItemConstructorOptions = { label: "Open in Browser", click: () => server && openOutside(server.url) };
  const view: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => window?.webContents.reload() },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };
  const template: MenuItemConstructorOptions[] = process.platform === "darwin"
    ? [{ role: "appMenu" }, { label: "File", submenu: [openInBrowser, { type: "separator" }, { role: "close" }] }, { role: "editMenu" }, view, { role: "windowMenu" }]
    : [{ label: "File", submenu: [openInBrowser, { type: "separator" }, { label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => app.quit() }] }, { role: "editMenu" }, view];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function allowPermissions(): void {
  // the Ovis page may use the microphone (dictation, never the camera), the clipboard and notifications; nothing else asks
  const allowed = new Set(["clipboard-sanitized-write", "clipboard-read", "notifications", "fullscreen"]);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    if (!ours(details.requestingUrl)) return callback(false);
    if (permission === "media") {
      const types = "mediaTypes" in details ? details.mediaTypes ?? [] : [];
      return callback(types.length > 0 && types.every((type) => type === "audio"));
    }
    callback(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin, details) => {
    if (!ours(origin)) return false;
    if (permission === "media") return details.mediaType === "audio";
    return allowed.has(permission);
  });
}

async function startUpdates(): Promise<void> {
  const plan = updatePlan({ packaged: app.isPackaged, env: process.env, platform: process.platform, builtWithFeed: existsSync(join(process.resourcesPath, "app-update.yml")),
    channel: updateChannel(process.env, stateDir) });
  if (!plan.enabled) {
    console.log(`Updates are off: ${plan.reason}.`);
    return;
  }
  const { autoUpdater } = await import("electron-updater");
  if (plan.feed) autoUpdater.setFeedURL({ provider: "generic", url: plan.feed });
  // beta-mac.yml and beta-linux.yml on beta, latest-*.yml otherwise; setting a channel allows downgrades, which stay off
  autoUpdater.channel = plan.channel === "beta" ? "beta" : "latest";
  autoUpdater.allowPrerelease = plan.channel === "beta";
  autoUpdater.allowDowngrade = false;
  console.log(`Updates: ${plan.channel} channel.`);
  autoUpdater.on("error", (error) => console.error(`Update check failed: ${message(error)}`));
  autoUpdater.on("update-downloaded", () => {
    updateReady = () => void stopForQuit().then(() => autoUpdater.quitAndInstall());
    rebuildTrayMenu();
  });
  const check = () => void autoUpdater.checkForUpdates().catch((error: unknown) => console.error(`Update check failed: ${message(error)}`));
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  ipcMain.handle("ovis:status", () => status);
  ipcMain.on("ovis:retry", (event) => {
    if (event.senderFrame?.url.startsWith("file:")) void (server ? restart() : start());
  });
  ipcMain.on("ovis:logs", (event) => {
    if (event.senderFrame?.url.startsWith("file:")) void shell.openPath(logs);
  });
  app.on("before-quit", (event) => {
    if (stopped) return;
    event.preventDefault();
    // quit again only once this cancelled quit is over: a quit asked for inside it is dropped
    if (!quitting) void stopForQuit().then(() => setImmediate(() => app.quit()));
  });
  app.on("activate", showWindow);
  // the app stays in the tray with its window closed
  app.on("window-all-closed", () => {});
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());
  void app.whenReady().then(() => {
    allowPermissions();
    createMenu();
    createWindow();
    createTray();
    void start().then(startUpdates);
  });
}
