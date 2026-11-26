/** The core and its terminals keep running, as for every hc client. */
import { app, autoUpdater as squirrel, BrowserWindow, ipcMain, Menu, nativeImage, Notification, powerMonitor, powerSaveBlocker, session, shell, Tray, type MenuItemConstructorOptions } from "electron";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, rmSync, watch, type FSWatcher, type WriteStream } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { choosePort, coreEnv, coreSession, endLeftover, installCore, isFile, layout, openLog, processCommand, processStartSync, readSaved, serverEnv, startCore, startServer, stopServer, writeSaved, type RunningServer } from "./children.ts";
import { accountServiceOf, startLoopbackSignIn, type LoopbackSignIn } from "./accountSignIn.ts";
import { awakeLabel, DESKTOP_ACTIVITY_FILE, holdAwake, readAwakeSettings, readWorking, writeAwakeSettings, type AwakeSettings } from "./awake.ts";
import { appUpdateState, checkForUpdates, debInstallCommand, downloadsUpdate, nextOffer, NO_OFFER, readUpdateNotices, stillHeld, UPDATE_CHECK_INTERVAL_MS, updateChannel, updateNotice, updatePlan, writeUpdateNotices, type AppCheck, type AppUpdateState, type HeldUpdate, type UpdateNotices, type UpdateOffer, type UpdaterEvent } from "./updates.ts";
import { extractedAppDir, othersRunFrom } from "./appimage.ts";
import { desktopLocale, desktopText } from "./text.ts";
import { hideWindow } from "./windowClose.ts";
import { argvLinkQuery, LINK_SCHEME, openLinkQuery, tellsLink } from "./openLink.ts";
import { openOutside } from "./openOutside.ts";
import { findBrowsers, readLinkBrowser, webAddress, writeLinkBrowser, type FoundBrowsers, type LinkBrowser } from "./browsers.ts";
import { BrowserTabs, type BrowserBounds } from "./browserTabs.ts";
import { debuggingSwitch, ownAddresses, readBrowserState } from "./browserState.ts";
import { homedir, networkInterfaces } from "node:os";
import { commandState, installCommand, READ_TERMINAL_PATH, SHELL_PATH_SCRIPT, shellPath, writeLauncher, type CommandHost } from "./terminalCommand.ts";
import { BrowserBroker, brokerPath } from "./browserBroker.ts";
import { readStagingProfile } from "./stagingProfile.ts";
import { BROWSER_TOKENS_DIR } from "../../../shared/browser-broker.ts";

type StepState = "pending" | "ok" | "failed";
export interface Status {
  core: StepState;
  server: StepState | "stopped";
  detail: string;
  versions: { hc: string; bun: string } | null;
}
export interface UpdateLine {
  version: string;
  closed: boolean;
  text: string;
  action: string;
}

const resources = app.isPackaged ? join(process.resourcesPath, "ovis") : process.env["OVIS_DESKTOP_STAGE"] || join(app.getAppPath(), "stage");
const staging = app.isPackaged && process.platform === "darwin" ? readStagingProfile({ resources, env: process.env }) : null;
if (staging) {
  Object.assign(process.env, staging.env);
  if (!app.commandLine.hasSwitch("user-data-dir")) {
    mkdirSync(staging.userData, { recursive: true, mode: 0o700 });
    app.setPath("userData", staging.userData);
    app.setPath("sessionData", staging.userData);
  }
}
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
let cancelHide: (() => void) | null = null;
let tray: Tray | null = null;
let server: RunningServer | null = null;
let busy: Promise<void> | null = null;
let spawning: ChildProcess | null = null;
let quitting = false;
let stopped = false;
let offer: UpdateOffer = NO_OFFER;
let installOffer: (() => void) | null = null;
let installWaiters: (() => void)[] = [];
/** the app's own check (Settings → About), and the check itself once updates are on */
let appCheck: AppCheck = { is: "idle" };
let checkNow: (() => Promise<void>) | null = null;
const noticesPath = join(app.getPath("userData"), "update-notice.json");
let notices = readUpdateNotices(noticesPath);
/** held so its click still arrives: a notification nothing holds is collected, and its click with it */
let updateNotification: Notification | null = null;
let handedToNotify: string | null = null;
let status: Status = { core: "pending", server: "pending", detail: "", versions };
const awakePath = join(app.getPath("userData"), "awake.json");
let awake = readAwakeSettings(awakePath);
let awakeBlocker: number | null = null;
let awakeWorking = 0;
const linkBrowserPath = join(app.getPath("userData"), "link-browser.json");
let linkBrowser = readLinkBrowser(linkBrowserPath);
let browsersFound: Promise<FoundBrowsers> | null = null;
let text = desktopText("en");
/** the pane an `ovis://open` link names (openLink.ts), as its query: told to the server's page once it shows */
let pendingLink: string | null = null;
/** the built-in browser while its setting is on (browserTabs.ts), and the port of the server it keeps out */
let browser: BrowserTabs | null = null;
let browserPort: number | null = null;
let stateWatch: FSWatcher | null = null;
/** the agents' way into it (browserBroker.ts), open only while it is on; none where there is no local-only socket (Windows) */
const brokerSocket = brokerPath(app.getPath("userData"), process.platform);
const broker = brokerSocket === null ? null : new BrowserBroker(() => browser, join(stateDir, BROWSER_TOKENS_DIR), brokerSocket);

const accountService = accountServiceOf(process.env);
/** the `ovis` command (terminalCommand.ts): written on each start, linked onto the PATH from Settings → About */
const commandDir = join(app.getPath("userData"), "cli");
let commandLauncher: string | null = null;

const accountProviders = (process.env["OVIS_ACCOUNT_PROVIDERS"] ?? "").split(",").map((name) => name.trim()).filter((name) => name === "github" || name === "google" || name === "apple");

function serverOrigin(): string | null {
  return server ? new URL(server.url).origin : null;
}

function writeCommand(): void {
  if (!isFile(programs.serverBinary)) return;
  try {
    commandLauncher = writeLauncher(commandDir, process.platform, {
      serverBinary: programs.serverBinary,
      desktopJson: savedPath,
      stateDir,
      configDir: join(app.getPath("userData"), "cli-settings"),
      coreSession: coreSession(process.env),
      accountService: process.env["OVIS_ACCOUNT_SERVICE_URL"]?.trim() || null,
    });
  } catch (error) {
    console.error(`Writing the ovis command in ${commandDir} failed: ${message(error)}`);
  }
}

function programOutput(program: string, args: readonly string[], timeoutMs: number, env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(program, args, { env: { ...process.env, ...env }, timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, out: String(stdout) });
    });
  });
}

async function terminalPath(): Promise<string> {
  if (process.platform === "win32") {
    const { code, out } = await programOutput("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", READ_TERMINAL_PATH], 15_000);
    return code === 0 ? out : process.env["PATH"] ?? "";
  }
  const { out } = await programOutput(process.env["SHELL"] || "/bin/sh", ["-ilc", SHELL_PATH_SCRIPT], 5_000);
  return shellPath(out) ?? process.env["PATH"] ?? "";
}

function commandHost(launcher: string): CommandHost {
  return { platform: process.platform, home: homedir(), shell: process.env["SHELL"] || "/bin/zsh", launcher, isFile, terminalPath, run: async (program, args, env) => (await programOutput(program, args, 60_000, env)).code };
}

function ours(url: string): boolean {
  try { return new URL(url).origin === serverOrigin(); } catch { return false; }
}

/**
 * The server's own page, by its frame's real origin, not its address: the server also shows a file's HTML at its
 * own address, in an opaque origin.
 */
function serverPage(frame: Electron.WebFrameMain | null | undefined): boolean {
  return frame != null && frame.parent === null && frame.origin === serverOrigin() && ours(frame.url);
}

function setStatus(next: Partial<Status>): void {
  status = { ...status, ...next };
  window?.webContents.send("ovis:status", status);
  rebuildTrayMenu();
}

function showConnect(): void {
  browser?.hide();
  if (window && !window.webContents.getURL().startsWith("file:")) void window.loadFile(connectPage);
}

/**
 * The built-in browser follows its setting in the server's state folder, read again on each change
 * there: off, it has no tab and no profile in use; on, a new block list closes the tabs it refuses.
 */
function updateBrowser(): void {
  const state = readBrowserState(stateDir, browserPort, debuggingSwitch((name) => app.commandLine.hasSwitch(name)));
  const was = browser !== null;
  if (!state.enabled) {
    if (browser) broker?.stop();
    browser?.closeAll();
    browser = null;
  } else if (browser) {
    browser.setPolicy(state.policy);
    // a quit that did not happen (a refused update) stopped the socket: it listens again once that quit is over (start
    // is a no-op while it listens); never while the app is on its way out
    if (!quitting) broker?.start().catch((error: unknown) => console.error(`The built-in browser's agent socket did not open: ${message(error)}`));
  } else {
    browser = new BrowserTabs(() => window, state.policy, join(app.getPath("userData"), "browser-downloads"), tellBrowser, () => ownAddresses(networkInterfaces()));
    broker?.start().catch((error: unknown) => console.error(`The built-in browser's agent socket did not open: ${message(error)}`));
  }
  if (was !== (browser !== null)) tellBrowser();
}

function watchState(): void {
  if (stateWatch) return;
  try {
    stateWatch = watch(stateDir, (_event, name) => {
      if (name === null || name === "preferences.json" || name === "address-pcs.json") updateBrowser();
    });
  } catch (error) {
    console.error(`Watching ${stateDir} failed: ${message(error)}`);
  }
}

function browserView(): { tabs: ReturnType<BrowserTabs["list"]>; results: ReturnType<BrowserTabs["results"]> } | null {
  return browser ? { tabs: browser.list(), results: browser.results() } : null;
}

/** to the server's own page alone */
function tellBrowser(): void {
  const contents = window?.webContents;
  if (contents && serverPage(contents.mainFrame)) contents.send("ovis:tabs", browserView());
}

function showWindow(): void {
  cancelHide?.();
  cancelHide = null;
  if (!window) createWindow();
  window!.show();
  window!.focus();
}

/** An `ovis://open` link: the window comes forward and its page selects the link's pane, now or once the server's page has loaded. */
function openLink(query: string): void {
  pendingLink = query;
  if (!app.isReady()) return;
  showWindow();
  tellLink();
}

/** To the server's page alone, once it has loaded (openLink.ts tellsLink); preload.ts holds it until the page listens. */
function tellLink(loaded = false): void {
  const contents = window?.webContents;
  const page = contents ? { ours: ours(contents.getURL()), loadingMainFrame: contents.isLoadingMainFrame() } : null;
  if (!contents || !tellsLink(pendingLink, page, loaded)) return;
  contents.send("ovis:open-link", pendingLink);
  pendingLink = null;
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
    if (!isFile(programs.serverBinary) || !isFile(programs.hc)) {
      setStatus({ core: "failed", detail: `This build has no bundled herdr-core and Ovis server in ${resources}. Build it with \`bun scripts/build.ts stage\` in app/electron.` });
      return;
    }
    let hc: string;
    try {
      log = openLog(join(logs, "ovis.log"));
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
    if (quitting) return;
    try {
      // recorded as soon as it runs, so a crash of the app before it listens still leaves its pid behind
      const running = await startServer(programs, { ...serverEnv(process.env, { hc, stateDir, port }), OVIS_DESKTOP_COMMAND_RECORD: savedPath }, log, 60_000, (child) => {
        spawning = child;
        if (child.pid === undefined) return;
        writeSaved(savedPath, { port, server: { pid: child.pid, bun: programs.serverBinary, started: processStartSync(child.pid), ready: false } });
      });
      spawning = null;
      if (quitting) {
        await stopServer(running);
        writeSaved(savedPath, { port, server: null });
        return;
      }
      server = running;
      const listeningRecord = readSaved(savedPath).server;
      if (listeningRecord !== null && listeningRecord.pid === running.child.pid) {
        writeSaved(savedPath, { port, server: { ...listeningRecord, ready: true } });
      }
      browserPort = port;
      watchState();
      updateBrowser();
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
  if (server) await window?.loadURL(server.url).catch((error: unknown) => console.error(`Opening ${server?.url} failed: ${message(error)}`));
}

async function waitUntilEnded(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && await processCommand(pid) !== null) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function stopForQuit(): Promise<void> {
  quitting = true;
  broker?.stop(true);
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
    cancelHide?.();
    cancelHide = window ? hideWindow(window, process.platform) : null;
  });
  window.on("closed", () => { window = null; cancelHide = null; });
  guard(window.webContents);
  window.webContents.on("did-finish-load", () => tellLink(true));
  window.webContents.on("did-start-navigation", (details) => { if (details.isMainFrame && !details.isSameDocument) browser?.hide(); });
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

/** the browsers as last found, or found now: Settings finds them again each time it lists them */
function browsers(again = false): Promise<FoundBrowsers> {
  if (again || browsersFound === null) browsersFound = findBrowsers();
  return browsersFound;
}

/**
 * A web link of the server's page, in the browser chosen in Settings. When that browser is gone or
 * cannot start (or quits within two seconds with an error), the system browser opens it and a notification says so.
 */
async function openWebLink(url: string): Promise<void> {
  const address = webAddress(url);
  const chosen = linkBrowser;
  if (address === null || chosen === null) return openOutside(url);
  const browser = (await browsers()).browsers.find((found) => found.id === chosen);
  if (browser === undefined) return openInstead(null, address);
  const [program, ...args] = browser.command(address);
  const started = Date.now();
  let failed = false;
  const fail = () => {
    if (failed) return;
    failed = true;
    openInstead(browser, address);
  };
  try {
    const child = spawn(program!, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", fail);
    // a launcher that hands the link to a running browser exits at once with 0; one that cannot start fails (or crashes) within a moment
    child.once("exit", (code, signal) => { if ((code !== 0 || signal !== null) && Date.now() - started < 2_000) fail(); });
    child.unref();
  } catch {
    fail();
  }
}

function openInstead(browser: LinkBrowser | null, address: string): void {
  openOutside(address);
  updateLog(`The browser chosen for links (${browser?.name ?? linkBrowser}) could not open a link: the system browser opened it.`);
  if (!Notification.isSupported()) return;
  new Notification({ title: text("The link opened in the system browser"), body: browser ? text("{name} could not open it.", { name: browser.name }) : text("The browser chosen for links is no longer on this computer."), silent: true }).show();
}

function updateAwake(): void {
  const working = server ? readWorking(join(stateDir, DESKTOP_ACTIVITY_FILE)) : 0;
  const hold = holdAwake({ settings: awake, working, onBattery: powerMonitor.isOnBatteryPower(), serverRunning: server !== null });
  const changed = hold !== (awakeBlocker !== null) || (hold && working !== awakeWorking);
  awakeWorking = working;
  if (hold && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start("prevent-app-suspension");
  if (!hold && awakeBlocker !== null) {
    powerSaveBlocker.stop(awakeBlocker);
    awakeBlocker = null;
  }
  if (changed) rebuildTrayMenu();
}

function setAwake(next: AwakeSettings): void {
  awake = next;
  try { writeAwakeSettings(awakePath, next); } catch (error) { console.error(`Saving ${awakePath} failed: ${message(error)}`); }
  updateAwake();
  rebuildTrayMenu();
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const url = server?.url ?? null;
  const holding = awakeBlocker !== null ? awakeLabel(awakeWorking, text) : null;
  tray.setToolTip(holding ? `Ovis: ${holding}` : "Ovis");
  const items: MenuItemConstructorOptions[] = [
    ...(holding ? [{ label: holding, enabled: false }, { type: "separator" as const }] : []),
    { label: text("Open Ovis"), click: showWindow },
    { label: text("Open in Browser"), enabled: url !== null, click: () => url && openOutside(url) },
    { type: "separator" },
    {
      label: text("Keep Computer Awake"),
      submenu: [
        { label: text("While an Agent Is Working"), type: "checkbox", checked: awake.whileWorking, click: (item) => setAwake({ ...awake, whileWorking: item.checked }) },
        { label: text("Also on Battery"), type: "checkbox", checked: awake.onBattery, enabled: awake.whileWorking, click: (item) => setAwake({ ...awake, onBattery: item.checked }) },
      ],
    },
    { type: "separator" },
    { label: text("Restart Ovis Server"), enabled: busy === null, click: () => void restart() },
    ...(offer.ready ? [{ label: text("Restart to Update"), click: installUpdate }] : []),
    { type: "separator" },
    { label: text("Quit Ovis"), click: () => app.quit() },
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
  const openInBrowser: MenuItemConstructorOptions = { label: text("Open in Browser"), click: () => server && openOutside(server.url) };
  const view: MenuItemConstructorOptions = {
    label: text("View"),
    submenu: [
      { label: text("Reload"), accelerator: "CmdOrCtrl+R", click: () => window?.webContents.reload() },
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
    ? [{ role: "appMenu" }, { label: text("File"), submenu: [openInBrowser, { type: "separator" }, { role: "close" }] }, { role: "editMenu" }, view, { role: "windowMenu" }]
    : [{ label: text("File"), submenu: [openInBrowser, { type: "separator" }, { label: text("Quit"), accelerator: "CmdOrCtrl+Q", click: () => app.quit() }] }, { role: "editMenu" }, view];
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

function updateLog(line: string): void {
  console.log(line);
  try {
    mkdirSync(logs, { recursive: true });
    appendFileSync(join(logs, "ovis.log"), `${line}\n`);
  } catch (error) { console.error(`Writing to ${logs} failed: ${message(error)}`); }
}

function updateLine(): UpdateLine | null {
  if (!offer.ready) return null;
  const { version } = offer.ready;
  return { version, closed: !updateNotice(version, notices).line, text: text("Ovis {version} is ready", { version }), action: text("Restart to Update") };
}

/** to the app's window: the windows a page opens carry no preload, and so no line */
function sendUpdateLine(): void {
  window?.webContents.send("ovis:update", updateLine());
}

/** an update whose file is gone is not offered here either (heldUpdate), checked each time this is told */
function appUpdate(): AppUpdateState {
  heldUpdate();
  return appUpdateState(app.getVersion(), checkNow !== null, appCheck, offer);
}

/** to the server's own page alone, as About is drawn only there (tellBrowser) */
function sendAppUpdate(): void {
  const contents = window?.webContents;
  if (contents && serverPage(contents.mainFrame)) contents.send("ovis:update-state", appUpdate());
}

function setAppCheck(next: AppCheck): void {
  appCheck = next;
  sendAppUpdate();
}

function heldUpdate(): HeldUpdate | null {
  if (offer.ready !== null && stillHeld(offer.ready, existsSync) === null) {
    updateLog(`The downloaded update ${offer.ready.version} is gone from the updater's folder: no longer offered until it is downloaded again.`);
    offer = { ...offer, ready: null };
    rebuildTrayMenu();
    sendUpdateLine();
    sendAppUpdate();
  }
  return offer.ready;
}

function saveNotices(next: UpdateNotices): void {
  notices = next;
  try { writeUpdateNotices(noticesPath, next); } catch (error) { console.error(`Saving ${noticesPath} failed: ${message(error)}`); }
}

/**
 * A version counts as announced once the system showed it, so one that could not be shown (no
 * notification service, an unsigned Mac build) is tried again by the next start.
 */
function announceUpdate(): void {
  sendUpdateLine();
  if (!offer.ready) return;
  const { version } = offer.ready;
  if (handedToNotify === version || !updateNotice(version, notices).notify || !Notification.isSupported()) return;
  handedToNotify = version;
  const notification = new Notification({
    title: text("Ovis {version} is ready", { version }),
    body: text("Restart to update."),
    silent: true,
    // a Linux desktop draws the app's own icon only for an installed package
    ...(process.platform === "linux" ? { icon: nativeImage.createFromPath(iconPath).resize({ width: 128 }) } : {}),
  });
  updateNotification?.close();
  updateNotification = notification;
  notification.on("click", showWindow);
  notification.once("show", () => saveNotices({ ...notices, notified: version }));
  notification.on("failed", (_event, error) => updateLog(`The notification of update ${version} could not be shown${error ? `: ${error}` : ""}.`));
  notification.show();
}

/**
 * Once the app is on its way out (this already pressed, or a quit) another press is dropped, and so
 * is one for an update whose file is gone: installing stops the server first, and would then find
 * nothing to install.
 */
function installUpdate(): void {
  if (quitting || heldUpdate() === null) return;
  installOffer?.();
}

/**
 * Restart to Update where the app is replaced as it runs (the AppImage, Windows, a Mac): the
 * server stops first, since the new copy starts at once. An install that then cannot go ahead
 * (the held file gone while the server stopped, an installer that fails at once) starts Ovis
 * again as it was, instead of leaving the window on a server that is gone.
 */
async function stopAndInstall(updater: { quitAndInstall(): void; once(event: "error", listener: () => void): unknown; removeListener(event: "error", listener: () => void): unknown }): Promise<void> {
  await stopForQuit();
  let refused = heldUpdate() === null;
  if (!refused) {
    // an installer that fails at once says so before quitAndInstall returns
    const failed = () => { refused = true; };
    updater.once("error", failed);
    updater.quitAndInstall();
    updater.removeListener("error", failed);
  }
  if (!refused) return;
  updateLog("Restart to Update could not install the update: Ovis starts again as it was.");
  quitting = false;
  stopped = false;
  for (const answer of installWaiters.splice(0)) answer();
  void start();
}

async function startUpdates(): Promise<void> {
  let linuxPackage: string | null = null;
  try { linuxPackage = readFileSync(join(process.resourcesPath, "package-type"), "utf8").trim(); } catch {}
  const writable = (folder: string) => {
    try { accessSync(folder, constants.W_OK | constants.X_OK); return true; } catch { return false; }
  };
  const plan = updatePlan({ packaged: app.isPackaged, env: process.env, platform: process.platform, builtWithFeed: existsSync(join(process.resourcesPath, "app-update.yml")),
    // a staging (preview) build reads only the preview feed it was built with: the beta channel would swap in the public beta feed
    channel: staging ? "stable" : updateChannel(process.env, stateDir), linuxPackage, execPath: process.execPath, writable });
  if (!plan.enabled) {
    updateLog(`Updates are off: ${plan.reason}.`);
    return;
  }
  const updater = await import("electron-updater");
  // one privileged apt-get and nothing else. DebUpdater's own dpkg path follows any failure with
  // `apt-get install -f` (a cancelled prompt asked again, and a no-op repair restarted Ovis on its
  // old version); its apt path allows unauthenticated, downgraded and held packages.
  class OvisDebUpdater extends updater.DebUpdater {
    protected override doInstall(options: { isForceRunAfter: boolean }): boolean {
      const file = this.installerPath;
      if (file == null) {
        this.dispatchError(new Error("No downloaded update to install"));
        return false;
      }
      try {
        this.runCommandWithSudoIfNeeded(debInstallCommand(file, !this.isRunningAsRoot()));
      } catch (error) {
        this.dispatchError(error instanceof Error ? error : new Error(String(error)));
        return false;
      }
      if (options.isForceRunAfter) app.relaunch();
      return true;
    }
  }
  const autoUpdater = plan.installer === "deb" ? new OvisDebUpdater() : plan.installer === "appimage" ? new updater.AppImageUpdater() : updater.autoUpdater;
  if (plan.feed) autoUpdater.setFeedURL({ provider: "generic", url: plan.feed });
  // beta-mac.yml and beta-linux.yml on beta, latest-*.yml otherwise; setting a channel allows downgrades, which stay off
  autoUpdater.channel = plan.channel === "beta" ? "beta" : "latest";
  autoUpdater.allowPrerelease = plan.channel === "beta";
  autoUpdater.allowDowngrade = false;
  autoUpdater.autoDownload = false;
  updateLog(`Updates: ${plan.channel} channel.`);
  // a .deb installs behind a password prompt: only when asked for (the tray's or a line's Restart to Update), never on a plain quit
  if (plan.installer === "deb") autoUpdater.autoInstallOnAppQuit = false;
  let failed = false;
  const told = (event: UpdaterEvent) => {
    const before = offer.ready;
    offer = nextOffer(offer, event, process.platform);
    sendAppUpdate();
    if (offer.ready === before) return;
    rebuildTrayMenu();
    announceUpdate();
  };
  autoUpdater.on("error", (error) => {
    failed = true;
    updateLog(`Update failed: ${message(error)}`);
    appCheck = { is: "failed", error: message(error) };
    told({ is: "error" });
    // a download that failed emptied the updater's folder, the update held until now with it
    heldUpdate();
  });
  // the .deb installs first and the app quits (stopping the server) only once it did, then starts again;
  // a cancelled prompt leaves the app and its server running. The AppImage starts its new copy at
  // once, so the server stops before.
  installOffer = plan.installer === "deb" ? () => autoUpdater.quitAndInstall() : () => void stopAndInstall(autoUpdater);
  const mac = process.platform === "darwin";
  autoUpdater.on("update-downloaded", (downloaded) => {
    failed = false;
    updateLog(`Update ${downloaded.version} is downloaded: ${mac ? "the system's updater takes it now" : "Restart to Update installs it"}.`);
    told({ is: "downloaded", update: { version: downloaded.version, file: downloaded.downloadedFile } });
  });
  // a Mac: the update is offered once Squirrel says it holds it (updates.ts UpdateOffer)
  if (mac) {
    squirrel.on("update-downloaded", () => {
      if (offer.staging) updateLog(`Update ${offer.staging.version} is ready: Restart to Update installs it.`);
      told({ is: "staged" });
    });
  }
  autoUpdater.on("download-progress", (progress) => {
    if (appCheck.is === "downloading") setAppCheck({ ...appCheck, percent: Math.floor(progress.percent) });
  });
  // one check at a time: the hourly one and About's button join a check under way
  let checking: Promise<void> | null = null;
  const check = (): Promise<void> => {
    // not once the app is on its way out: a download that fails then empties the folder the install reads
    if (quitting) return Promise.resolve();
    checking ??= (async () => {
      setAppCheck({ is: "checking" });
      const outcome = await checkForUpdates(autoUpdater, updateLog, (version) => {
        const wanted = !quitting && downloadsUpdate({ found: version, held: offer.staging ?? heldUpdate(), failed, exists: existsSync });
        if (wanted) setAppCheck({ is: "downloading", version, percent: null });
        return wanted;
      });
      // a downloaded or held update is the offer's to show (updates.ts appUpdateState)
      setAppCheck(outcome.is === "failed" ? { is: "failed", error: outcome.error } : outcome.is === "latest" ? { is: "latest" } : { is: "idle" });
    })().finally(() => { checking = null; });
    return checking;
  };
  checkNow = check;
  void check();
  setInterval(() => void check(), UPDATE_CHECK_INTERVAL_MS);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // a second start shows the window, on the pane of the link it was handed (Windows, Linux)
  app.on("second-instance", (_event, argv) => {
    const query = argvLinkQuery(argv);
    if (query !== null) openLink(query);
    else showWindow();
  });
  // a Mac hands a link to the running app, or to one it starts for it before it is ready
  app.on("open-url", (event, url) => {
    event.preventDefault();
    const query = openLinkQuery(url);
    if (query !== null) openLink(query);
    else if (app.isReady()) showWindow();
  });
  ipcMain.handle("ovis:status", () => status);
  ipcMain.on("ovis:retry", (event) => {
    if (event.senderFrame?.url.startsWith("file:")) void (server ? restart() : start());
  });
  ipcMain.on("ovis:logs", (event) => {
    if (event.senderFrame?.url.startsWith("file:")) void shell.openPath(logs);
  });
  // the downloaded update's line: for the connection screen and the server's own pages, nothing else
  const ownPage = (url: string | undefined) => url !== undefined && (url.startsWith("file:") || ours(url));
  ipcMain.handle("ovis:update", (event) => ownPage(event.senderFrame?.url) ? updateLine() : null);
  ipcMain.handle("ovis:update-install", (event) => {
    if (!ownPage(event.senderFrame?.url)) return undefined;
    installUpdate();
    // Answered at once when the install returned: a .deb's prompt
    // cancelled, with Ovis running on (or a .deb installed, a moment before it quits)
    return quitting ? new Promise<void>((answer) => { installWaiters.push(answer); }) : undefined;
  });
  // Settings → About: the app's version and its own check, which the button there starts now
  // only the server's own page by its frame's origin: the server also shows a file's HTML at its own address
  ipcMain.handle("ovis:update-state", (event) => serverPage(event.senderFrame) ? appUpdate() : null);
  ipcMain.handle("ovis:update-check", (event) => {
    if (serverPage(event.senderFrame)) void checkNow?.();
  });
  ipcMain.on("ovis:update-close", (event, version: unknown) => {
    if (!ownPage(event.senderFrame?.url) || !offer.ready || version !== offer.ready.version) return;
    saveNotices({ ...notices, closed: offer.ready.version });
    sendUpdateLine();
  });
  // signing in to the account (accountSignIn.ts): only the server's own pages may, and only to the account service named
  let signIn: LoopbackSignIn | null = null;
  ipcMain.on("ovis:account-service", (event) => {
    event.returnValue = ours(event.senderFrame?.url ?? "") && accountService !== null ? { service: accountService, providers: accountProviders } : null;
  });
  ipcMain.handle("ovis:account-start", async (event) => {
    if (!ours(event.senderFrame?.url ?? "") || accountService === null) throw new Error("Signing in is not offered here");
    signIn = await startLoopbackSignIn();
    return signIn.redirectUri;
  });
  ipcMain.handle("ovis:account-open", async (event, url: unknown) => {
    if (!ours(event.senderFrame?.url ?? "") || accountService === null || signIn === null) throw new Error("No sign-in is waiting");
    if (typeof url !== "string" || new URL(url).origin !== accountService) throw new Error("That is not the account service");
    const waiting = signIn;
    const state = new URL(url).searchParams.get("state");
    if (state === null) throw new Error("That sign-in names no state");
    waiting.expect(state);
    openOutside(url);
    try { return await waiting.returned; } finally { if (signIn === waiting) signIn = null; }
  });
  // Settings → Browser for links: the server's own page lists the browsers, chooses one by its id and opens its web links in it.
  ipcMain.handle("ovis:browsers", async (event) => {
    if (!serverPage(event.senderFrame)) return null;
    const found = await browsers(true);
    return { browsers: found.browsers.map(({ id, name }) => ({ id, name })), systemDefault: found.systemDefault, chosen: linkBrowser };
  });
  ipcMain.handle("ovis:browser-choose", async (event, id: unknown) => {
    if (!serverPage(event.senderFrame)) throw new Error("Choosing a browser is not offered here");
    if (id !== null && (typeof id !== "string" || !(await browsers()).browsers.some((browser) => browser.id === id))) throw new Error("That browser is not on this computer");
    writeLinkBrowser(linkBrowserPath, id);
    linkBrowser = id;
  });
  ipcMain.on("ovis:browser-open", (event, url: unknown) => {
    if (serverPage(event.senderFrame) && typeof url === "string") void openWebLink(url);
  });
  // Settings → About → Terminal command (terminalCommand.ts): only the server's own page, and only once the launcher is written
  ipcMain.handle("ovis:command", (event) => serverPage(event.senderFrame) && commandLauncher !== null ? commandState(commandHost(commandLauncher)) : null);
  ipcMain.handle("ovis:command-install", (event) => {
    if (!serverPage(event.senderFrame) || commandLauncher === null) throw new Error("Adding the ovis command is not offered here");
    return installCommand(commandHost(commandLauncher));
  });

  // the built-in browser (browserTabs.ts): only the server's own page reaches it, and only while its setting is on.
  // The page opens tabs of the person's own profile; it steers an agent's tab only while the person holds it
  const browserFor = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => serverPage(event.senderFrame) ? browser : null;
  const tabId = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) ? value : null;
  const steered = (tabs: BrowserTabs, id: number | null) => id !== null && tabs.list().some((tab) => tab.id === id && (tab.profile === "mine" || tab.held));
  ipcMain.handle("ovis:tabs", (event) => browserFor(event) ? browserView() : null);
  ipcMain.handle("ovis:tabs-open", (event, url: unknown) => typeof url === "string" ? browserFor(event)?.open(url, "mine") ?? null : null);
  ipcMain.on("ovis:tabs-show", (event, id: unknown, bounds: unknown) => {
    const box = bounds as Partial<BrowserBounds> | null;
    const numbers = box !== null && typeof box === "object" && [box.x, box.y, box.width, box.height].every((value) => typeof value === "number" && Number.isFinite(value));
    const tabs = browserFor(event), tab = tabId(id);
    if (tabs && tab !== null && numbers) tabs.show(tab, box as BrowserBounds);
  });
  ipcMain.on("ovis:tabs-hide", (event) => browserFor(event)?.hide());
  ipcMain.handle("ovis:tabs-thumbnail", (event, id: unknown) => {
    const tab = tabId(id);
    return tab === null ? null : browserFor(event)?.thumbnail(tab) ?? null;
  });
  // shows a kept download in its folder; main never opens it
  ipcMain.on("ovis:tabs-reveal", (event, id: unknown) => {
    const path = typeof id === "string" ? browserFor(event)?.resultPath(id) ?? null : null;
    if (path !== null) shell.showItemInFolder(path);
  });
  ipcMain.on("ovis:tabs-close", (event, id: unknown) => {
    const tab = tabId(id);
    if (tab !== null) browserFor(event)?.close(tab);
  });
  ipcMain.handle("ovis:tabs-navigate", (event, id: unknown, url: unknown) => {
    const tabs = browserFor(event), tab = tabId(id);
    return tabs !== null && tab !== null && typeof url === "string" && steered(tabs, tab) && tabs.navigate(tab, url);
  });
  ipcMain.on("ovis:tabs-go", (event, id: unknown, step: unknown) => {
    const tabs = browserFor(event), tab = tabId(id);
    if (tabs && tab !== null && steered(tabs, tab) && (step === "back" || step === "forward" || step === "reload" || step === "stop")) tabs.go(tab, step);
  });
  ipcMain.on("ovis:tabs-hold", (event, id: unknown, held: unknown) => {
    const tab = tabId(id);
    if (tab !== null && typeof held === "boolean") browserFor(event)?.hold(tab, held);
  });
  app.on("before-quit", (event) => {
    if (stopped) return;
    event.preventDefault();
    // quit again only once this cancelled quit is over: a quit asked for inside it is dropped
    if (!quitting) void stopForQuit().then(() => setImmediate(() => app.quit()));
  });
  // an AppImage run unpacked (no FUSE) leaves its folder in the temporary folder: the server, the
  // last user of its files, has stopped by now (the core runs from its own copy). Another copy of the
  // same AppImage runs from the same folder: then it stays
  const unpacked = process.platform === "linux" ? extractedAppDir(process.env, process.execPath) : null;
  if (unpacked) {
    app.on("quit", () => {
      try {
        if (!othersRunFrom(unpacked, process.pid)) rmSync(unpacked, { recursive: true, force: true });
      } catch (error) {
        console.error(`Removing ${unpacked} failed: ${message(error)}`);
      }
    });
  }
  app.on("activate", showWindow);
  app.on("window-all-closed", () => {});
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());
  void app.whenReady().then(() => {
    text = desktopText(desktopLocale(app.getLocale()));
    // Windows opens a link by starting the app with it: the installer does not register the scheme, so
    // the app does (a Mac's Info.plist and Linux's .desktop file name it: electron-builder.yml `protocols`),
    // and only while no program has it: another program's ovis:// stays its own, and this app's own
    // registration needs no writing again. The `--` ends Chromium's switches, so a link is never read as
    // one. The uninstaller removes the registration only when it starts this install (windows/installer.nsh)
    if (app.isPackaged && process.platform === "win32" && !app.getApplicationNameForProtocol(`${LINK_SCHEME}://`)) {
      app.setAsDefaultProtocolClient(LINK_SCHEME, process.execPath, ["--"]);
    }
    pendingLink ??= argvLinkQuery(process.argv);
    writeCommand();
    // found before the first link: on Windows that takes several registry reads
    if (linkBrowser !== null) void browsers();
    allowPermissions();
    createMenu();
    createWindow();
    createTray();
    setInterval(updateAwake, 5_000);
    powerMonitor.on("on-ac", updateAwake);
    powerMonitor.on("on-battery", updateAwake);
    void start().then(startUpdates);
  });
}
