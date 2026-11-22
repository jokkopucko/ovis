/**
 * The desktop app's built-in browser: tabs drawn by the main process (WebContentsView) where the
 * Ovis page keeps their place, in one of two profiles that share no cookie or storage: `mine`, the
 * tabs a person opens, and `agent`, the tabs an agent drives. Every request, navigation, redirect,
 * frame and socket of either profile is decided by shared/browser-policy.ts before it leaves the PC.
 * A tab carries no preload and no bridge to the app; a window it opens is a tab of its profile. A
 * tab is listed only once an address it committed was allowed, with that address shown without
 * its query.
 */
import { BrowserWindow, screen, session as sessions, WebContentsView, type Session, type WebContents } from "electron";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { BrowserResults, type BrowserResult } from "./browserResults.ts";
import { stageSupported } from "./browserState.ts";
import { isIP } from "node:net";
import { canonicalHost, decide, machineHost, ovisAt, shownAddress, urlPort, type Allowed, type BrowserPolicy } from "../../../shared/browser-policy.ts";
import { hostForm } from "./browserState.ts";

export const BROWSER_PROFILES = ["mine", "agent"] as const;
export type BrowserProfile = (typeof BROWSER_PROFILES)[number];
export const MAX_BROWSER_TABS = 8;
/** what `work` settles to, or null when it fails or takes longer than PICTURE_MS */
async function settledWithin<T>(work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((done) => { timer = setTimeout(() => done(null), PICTURE_MS); });
  return Promise.race([work.catch(() => null), late]).finally(() => clearTimeout(timer));
}

/** a 320 px wide picture of a page as it is drawn, or null when it has none or does not answer in time */
async function capture(contents: WebContents): Promise<string | null> {
  const image = await settledWithin(contents.capturePage(undefined, { stayHidden: true }));
  return image === null || image.isEmpty() ? null : image.resize({ width: 320 }).toDataURL();
}

/** whether `bounds` overlap any screen */
function onScreen(bounds: { x: number; y: number; width: number; height: number }): boolean {
  return screen.getAllDisplays().some(({ bounds: area }) => bounds.x < area.x + area.width && bounds.x + bounds.width > area.x && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y);
}

/** how many frames, this far apart, a tab brought to the top of the stage gets to paint before its picture is given up */
const STAGE_FRAMES = 8;
/** how long one capture may take before it is given up (one that never answers would hold every later picture) */
const PICTURE_MS = 1000;
/** the isolated world a picture waits for the page's frames in (none of the page's own scripts run there) */
const PICTURE_WORLD = 1_017;
/** a tab smaller than this on a side has no room to draw a picture in, and is laid out as a desktop window first */
const MIN_PICTURED = 100;
const DESKTOP_SIZE = { width: 1280, height: 800 };
const STAGE_FRAME_MS = 50;
const AGENT_OPEN_MS = 30_000;
/** a download larger than this is cancelled, and a profile keeps at most MAX_DOWNLOADS from one start of the app */
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
export const MAX_DOWNLOADS = 50;
/**
 * The BrowserTabs each session answers to now (a setting turned off and on makes a new BrowserTabs). Its
 * request and permission handlers are set again by each new one; its download listener, an event, is added once.
 */
const owners = new WeakMap<Session, BrowserTabs>();
/** the sessions whose download listener (an event, which would stack) is added */
const downloadsWatched = new WeakSet<Session>();
const downloads = new WeakMap<Session, number>();

export interface BrowserTab {
  id: number;
  profile: BrowserProfile;
  address: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** an agent tab a person holds: the agent's tools wait, and the tab takes the person's input */
  held: boolean;
  /** the pane whose agent opened it; null for a tab of the person's own */
  owner: string | null;
}

/** the downloads of this run of the app, of both profiles */
const results = new BrowserResults();

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Tab {
  id: number;
  profile: BrowserProfile;
  /** the pane whose agent opened it (browserBroker.ts); its tools see no other tab */
  owner: string | null;
  view: WebContentsView;
  allowed: Allowed | null;
  title: string;
  held: boolean;
}

/** what the agents' tools may hold of a tab: one of the owner's, while the person does not hold it */
export interface AgentTab {
  id: number;
  contents: WebContents;
  address: string;
  shown: boolean;
}

const PARTITION: Record<BrowserProfile, string> = { mine: "persist:ovis-browser-mine", agent: "persist:ovis-browser-agent" };
/** what a page of the person's own tabs may use; an agent tab gets nothing it would have to ask for */
const MINE_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen"]);

export class BrowserTabs {
  private tabs = new Map<number, Tab>();
  private nextId = 1;
  private shown: number | null = null;
  /**
   * Where an agent's tab nobody looks at is drawn while its picture is taken (thumbnail): a window of its own, off the
   * screen and closed to the pointer (Linux ignores a window's opacity, so off the screen is what hides it). None on a
   * Wayland desktop, which does not place a window off the screen: there a tab has a picture only while shown.
   */
  private stage: BrowserWindow | null = null;
  /** the stage turned out visible here (the window manager placed it on a screen): it is not made again */
  private noStage = false;
  /** the picture being taken, which the next one waits for, and each tab's picture asked for and not yet taken */
  private pictures: Promise<void> = Promise.resolve();
  private waitingPictures = new Map<number, Promise<string | null>>();
  /** the sessions this BrowserTabs has guarded: webRequest and permission handlers replace the previous ones */
  private guarded = new Set<Session>();

  constructor(
    private window: () => BrowserWindow | null,
    private policy: BrowserPolicy,
    private downloads: string,
    private changed: (tabs: BrowserTab[]) => void,
    /** this PC's addresses outside loopback, read on each request (Wi-Fi, a VPN or Tailscale may come up any time) */
    private ownAddresses: () => readonly string[] = () => [],
    /** told of each request as its name starts to resolve (browserTabs.test.ts orders its steps by it) */
    private waiting: (url: string) => void = () => {},
    private maxDownloadBytes = MAX_DOWNLOAD_BYTES,
  ) {}

  /** A new policy applies to every request from now on; a tab whose page it now refuses closes. */
  setPolicy(policy: BrowserPolicy): void {
    this.policy = policy;
    for (const tab of [...this.tabs.values()]) {
      const url = tab.view.webContents.getURL();
      if (url !== "" && !this.decide(url, null).allowed) this.close(tab.id);
    }
  }

  /** the tab whose page `contents` is, null for another */
  tabOf(contents: WebContents): number | null {
    for (const tab of this.tabs.values()) if (tab.view.webContents === contents) return tab.id;
    return null;
  }

  /** the downloads of this run of the app, newest first */
  results(): BrowserResult[] {
    return results.list();
  }

  /** where a finished download was kept, for the person to see in its folder (main never opens it) */
  resultPath(id: string): string | null {
    return results.path(id);
  }

  list(): BrowserTab[] {
    return [...this.tabs.values()].flatMap((tab) => tab.allowed === null ? [] : [{
      id: tab.id,
      profile: tab.profile,
      address: shownAddress(tab.allowed),
      title: tab.title,
      loading: tab.view.webContents.isLoading(),
      canGoBack: tab.view.webContents.navigationHistory.canGoBack(),
      canGoForward: tab.view.webContents.navigationHistory.canGoForward(),
      held: tab.held,
      owner: tab.owner,
    }]);
  }

  /** a tab of `profile` on `url`, or null when the address is refused or the tabs are at their limit */
  open(url: string, profile: BrowserProfile, owner: string | null = null): number | null {
    // each profile has its own limit: a person's tabs never leave an agent without one, nor the other way round
    const sameProfile = [...this.tabs.values()].filter((tab) => tab.profile === profile).length;
    if (sameProfile >= MAX_BROWSER_TABS || !this.decide(url, null).allowed) return null;
    const partition = sessions.fromPartition(PARTITION[profile]);
    this.guard(partition, profile);
    const view = new WebContentsView({ webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false, safeDialogs: true } });
    // a page lays out at its view's size, drawn or not: one no person has placed yet gets a desktop window's
    view.setBounds({ x: 0, y: 0, ...DESKTOP_SIZE });
    const tab: Tab = { id: this.nextId++, profile, owner: profile === "agent" ? owner : null, view, allowed: null, title: "", held: false };
    this.tabs.set(tab.id, tab);
    this.watch(tab);
    void view.webContents.loadURL(url).catch(() => {});
    return tab.id;
  }

  close(id: number): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.tabs.delete(id);
    if (this.shown === id) this.hide();
    if (this.stage && !this.stage.isDestroyed()) this.stage.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    this.tell();
  }

  closeAll(): void {
    for (const id of [...this.tabs.keys()]) this.close(id);
    // let go of it first: its "closed" handler gives up the stage only when something else closed it
    const stage = this.stage;
    this.stage = null;
    if (stage && !stage.isDestroyed()) stage.destroy();
  }

  /** Draws the tab in `bounds` of the window (in the page's CSS pixels), over the place the page keeps for it. */
  show(id: number, bounds: BrowserBounds): void {
    const tab = this.tabs.get(id);
    const window = this.window();
    if (!tab || tab.allowed === null || !window) return;
    if (this.shown !== null && this.shown !== id) this.hide();
    const zoom = window.webContents.getZoomFactor();
    const [width = 0, height = 0] = window.getContentSize();
    const x = Math.max(0, Math.round(bounds.x * zoom)), y = Math.max(0, Math.round(bounds.y * zoom));
    tab.view.setBounds({ x, y, width: Math.max(0, Math.min(Math.round(bounds.width * zoom), width - x)), height: Math.max(0, Math.min(Math.round(bounds.height * zoom), height - y)) });
    if (this.stage && !this.stage.isDestroyed()) this.stage.contentView.removeChildView(tab.view);
    // a window made anew (the old one closed) holds no view yet
    if (!window.contentView.children.includes(tab.view)) window.contentView.addChildView(tab.view);
    this.shown = id;
  }

  hide(): void {
    const tab = this.shown === null ? undefined : this.tabs.get(this.shown);
    this.shown = null;
    const window = this.window();
    if (tab && window && !window.isDestroyed()) window.contentView.removeChildView(tab.view);
  }

  /**
   * A picture of the tab as PNG data, or null when it cannot be drawn. A tab nobody looks at paints nothing, so it is put
   * on the stage (an off-screen window) only while its picture is taken, and taken off again: it costs nothing between
   * pictures. Pictures are taken one at a time and each waits for a frame the page drew on the stage (up to PICTURE_MS),
   * so with many agent tabs the right panel's cards refresh more slowly than every 4 s: correct pictures over cadence.
   */
  thumbnail(id: number): Promise<string | null> {
    // one picture of a tab asked for while another is waiting is that one
    const waiting = this.waitingPictures.get(id);
    if (waiting) return waiting;
    // one picture at a time: two tabs on the stage at once would cover each other
    const taken = this.pictures.then(() => this.takePicture(id));
    this.waitingPictures.set(id, taken);
    this.pictures = taken.then(() => undefined, () => undefined);
    void taken.finally(() => this.waitingPictures.delete(id));
    return taken;
  }

  private async takePicture(id: number): Promise<string | null> {
    const tab = this.tabs.get(id);
    if (!tab || tab.allowed === null) return null;
    if (this.shown === id) return capture(tab.view.webContents);
    // only an agent's tab is pictured while nobody looks at it (the right panel's cards); a person's own tab only shown
    if (tab.profile !== "agent") return null;
    const stage = this.stageWindow();
    if (stage === null) return null;
    stage.contentView.addChildView(tab.view);
    try {
      // put in as it is, not resized (a page the agent works on gets no resize event from a picture), unless it was
      // left with no room to draw in (hidden while its window had none). The first frame it has there may still be the
      // one from when it was last drawn, so the picture is the frame after it.
      const { width, height } = tab.view.getBounds();
      if (width < MIN_PICTURED || height < MIN_PICTURED) tab.view.setBounds({ x: 0, y: 0, ...DESKTOP_SIZE });
      // two animation frames in the page (in a world of its own, which the page never sees) mean a frame drawn since it
      // came on the stage; a page that does not answer in time is taken from the second frame it has, as below
      const painted = await settledWithin(tab.view.webContents.executeJavaScriptInIsolatedWorld(PICTURE_WORLD, [{ code: "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))" }]));
      let primed = painted === true;
      for (let attempt = 0; attempt < STAGE_FRAMES; attempt++) {
        await new Promise((next) => setTimeout(next, STAGE_FRAME_MS));
        // shown or closed meanwhile: show() has placed it, or it is gone
        if (!this.onStage(tab) || tab.view.webContents.isDestroyed()) return null;
        const picture = await capture(tab.view.webContents);
        if (picture !== null && primed) return picture;
        primed ||= picture !== null;
      }
      return null;
    } finally {
      if (this.onStage(tab)) this.stage?.contentView.removeChildView(tab.view);
    }
  }

  private onStage(tab: Tab): boolean {
    const stage = this.stage;
    return stage !== null && !stage.isDestroyed() && stage.contentView.children.includes(tab.view);
  }

  private stageWindow(): BrowserWindow | null {
    if (this.noStage) return null;
    if (this.stage && !this.stage.isDestroyed()) return this.stage;
    if (!stageSupported(process.platform, process.env)) return null;
    const stage = new BrowserWindow({ show: false, x: -20000, y: -20000, width: 1280, height: 800, frame: false, focusable: false, skipTaskbar: true, hasShadow: false, title: "Ovis browser stage" });
    // nor in macOS's Window menu
    stage.excludedFromShownWindowsMenu = true;
    stage.setIgnoreMouseEvents(true);
    stage.showInactive();
    stage.setPosition(-20000, -20000);
    // closed from outside (a window manager): its tabs are not staged again, as on Wayland
    stage.on("closed", () => { if (this.stage === stage) { this.stage = null; this.noStage = true; } });
    // a window manager that keeps windows on the screen would show it: then no stage, as on Wayland
    // dropped after the window manager's move is done: destroying a window inside its own move crashes Electron
    const check = () => { if (!stage.isDestroyed() && onScreen(stage.getBounds())) setImmediate(() => { if (this.stage === stage) this.dropStage(); }); };
    stage.on("move", check);
    this.stage = stage;
    check();
    return this.stage;
  }

  /**
   * Gives up the stage for good: tabs nobody looks at have no picture from then on. The window is hidden, not destroyed
   * (a picture being taken may still hold a tab in it); closeAll destroys it.
   */
  private dropStage(): void {
    this.noStage = true;
    if (this.stage && !this.stage.isDestroyed()) this.stage.hide();
  }

  navigate(id: number, url: string): boolean {
    const tab = this.tabs.get(id);
    if (!tab || !this.decide(url, null).allowed) return false;
    void tab.view.webContents.loadURL(url).catch(() => {});
    return true;
  }

  go(id: number, step: "back" | "forward" | "reload" | "stop"): void {
    const contents = this.tabs.get(id)?.view.webContents;
    if (!contents) return;
    if (step === "back") contents.navigationHistory.goBack();
    else if (step === "forward") contents.navigationHistory.goForward();
    else if (step === "reload") contents.reload();
    else contents.stop();
  }

  /** A person takes an agent tab (its input becomes theirs, the agent's tools wait) or hands it back. */
  hold(id: number, held: boolean): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.profile !== "agent" || tab.held === held) return;
    tab.held = held;
    this.tell();
  }

  /**
   * An agent tab for `owner` on `url`: its id once the first address it commits is allowed, or null
   * when it is refused, fails to load or the tabs are at their limit (and then it is gone).
   */
  async openFor(owner: string, url: string): Promise<number | null> {
    const id = this.open(url, "agent", owner);
    const tab = id === null ? undefined : this.tabs.get(id);
    if (!tab) return null;
    const contents = tab.view.webContents;
    const listed = await new Promise<boolean>((settle) => {
      const stopped = () => done(tab.allowed !== null);
      const failed = (_event: unknown, code: number, _text: string, _url: string, isMainFrame: boolean) => { if (isMainFrame && code !== -3) done(false); };
      const gone = () => done(false);
      // a page that never stops loading is listed if its first address was allowed, by then
      const timer = setTimeout(() => done(tab.allowed !== null), AGENT_OPEN_MS);
      function done(result: boolean): void {
        clearTimeout(timer);
        contents.off("did-stop-loading", stopped);
        contents.off("did-fail-load", failed);
        contents.off("destroyed", gone);
        settle(result);
      }
      contents.on("did-stop-loading", stopped);
      contents.on("did-fail-load", failed);
      contents.on("destroyed", gone);
    });
    if (!listed) this.close(tab.id);
    return listed ? tab.id : null;
  }

  ownTabs(owner: string): BrowserTab[] {
    return this.list().filter((tab) => this.tabs.get(tab.id)?.owner === owner);
  }

  /** An owner's tab its tools may use now, or the reason they may not. */
  agentTab(owner: string, id: number): AgentTab | string {
    const tab = this.tabs.get(id);
    if (!tab || tab.owner !== owner || tab.allowed === null) return "No such tab of yours: list them with browser_tabs.";
    if (tab.held) return "The user has taken control of this tab: wait until they hand it back.";
    return { id, contents: tab.view.webContents, address: shownAddress(tab.allowed), shown: this.shown === id };
  }

  private decide(url: string, frameOrigin: string | null) {
    return decide(url, this.policy, frameOrigin);
  }

  /**
   * Whether an address the policy allowed reaches an Ovis server after all: at any port on one of this PC's own
   * addresses (`tailscale serve` or a proxy may front the server on any port of them), or at a name that resolves,
   * in the profile's own resolver, to one of those or to an Ovis server of the policy. A loopback name was decided
   * by the policy, and a dev server is reached under it. A name this PC cannot resolve is let through: the browser
   * cannot resolve it either, so it reaches no address of this PC except through a proxy, which sees no loopback.
   */
  private async reachesOvis(partition: Session, address: string): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return false;
    }
    if (url.protocol === "blob:" || url.protocol === "filesystem:") return false;
    const host = canonicalHost(url.hostname);
    if (this.ownAddresses().includes(host)) return true;
    if (host === "" || machineHost(host) === "localhost" || isIP(host.replace(/^\[|\]$/g, "")) !== 0) return false;
    const port = urlPort(url);
    try {
      const { endpoints } = await partition.resolveHost(host);
      // read once the answer is in: an interface may have come up while the name resolved
      const own = new Set(this.ownAddresses());
      return endpoints.some(({ address: resolved }) => {
        const form = hostForm(resolved);
        return own.has(form) || ovisAt(form, port, this.policy);
      });
    } catch {
      return false;
    }
  }

  tell(): void {
    this.changed(this.list());
  }

  /** The profile's own guards, once per session: requests, permissions and downloads. */
  private guard(partition: Session, profile: BrowserProfile): void {
    owners.set(partition, this);
    if (this.guarded.has(partition)) return;
    this.guarded.add(partition);
    // every request of the profile: pages, frames, redirects (each hop comes here again), subresources and sockets. The one
    // guard: a navigation reaches the network only through it, and refusing a frame's navigation earlier (will-frame-navigate)
    // takes down its page in Electron 45
    partition.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, answer) => {
      const initiator = details.initiatorOrigin ?? null;
      if (!this.decide(details.url, initiator).allowed) return answer({ cancel: true });
      // decided again once its name has resolved: the policy may have changed meanwhile (a site blocked)
      this.waiting(details.url);
      void this.reachesOvis(partition, details.url)
        .then((ovis) => answer({ cancel: ovis || !this.decide(details.url, initiator).allowed }), () => answer({ cancel: true }));
    });
    const allowed = (permission: string) => profile === "mine" && MINE_PERMISSIONS.has(permission);
    partition.setPermissionRequestHandler((_contents, permission, answer) => answer(allowed(permission)));
    partition.setPermissionCheckHandler((_contents, permission) => allowed(permission));
    partition.setDevicePermissionHandler(() => false);
    partition.setDisplayMediaRequestHandler((_request, answer) => answer({}));
    // a download is kept in the app's folder for it and never opened; no site fills the disk: a size and a count cap
    if (downloadsWatched.has(partition)) return;
    downloadsWatched.add(partition);
    partition.on("will-download", (_event, item, from) => {
      const tabs = owners.get(partition);
      const count = (downloads.get(partition) ?? 0) + 1;
      downloads.set(partition, count);
      if (!tabs || count > MAX_DOWNLOADS || item.getTotalBytes() > tabs.maxDownloadBytes) return item.cancel();
      item.on("updated", () => { if (item.getReceivedBytes() > tabs.maxDownloadBytes) item.cancel(); });
      const folder = join(tabs.downloads, profile);
      mkdirSync(folder, { recursive: true });
      const path = join(folder, `${Date.now()}-${basename(item.getFilename()).replace(/[^\w.-]+/g, "_").slice(-120) || "download"}`);
      item.setSavePath(path);
      const tab = tabs.tabOf(from);
      const id = `d${count}-${profile}`;
      results.add({ id, kind: "download", name: item.getFilename().slice(0, 200), at: Date.now(), bytes: item.getTotalBytes() || null, done: false, tab, profile }, path);
      tabs.tell();
      item.once("done", (_done, state) => {
        if (state === "completed") results.finish(id, item.getReceivedBytes());
        else results.drop(id);
        owners.get(partition)?.tell();
      });
    });
  }

  private watch(tab: Tab): void {
    const contents: WebContents = tab.view.webContents;
    if (tab.profile === "agent") contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    contents.setWindowOpenHandler(({ url }) => {
      if (!this.tabs.has(tab.id)) return { action: "deny" };
      // a window the page opens is a tab of the same profile and, for an agent's, of the same pane
      this.open(url, tab.profile, tab.owner);
      this.tell();
      return { action: "deny" };
    });
    const committed = (url: string) => {
      const decision = this.decide(url, null);
      if (!decision.allowed) {
        this.close(tab.id);
        return;
      }
      tab.allowed = decision;
      this.tell();
    };
    contents.on("did-navigate", (_event, url) => committed(url));
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => { if (isMainFrame) committed(url); });
    contents.on("page-title-updated", (_event, title) => {
      tab.title = title.slice(0, 200);
      this.tell();
    });
    contents.on("did-start-loading", () => this.tell());
    // a first navigation that ends without a page (a 204, a refused or failed load) leaves a tab nobody can see: it goes
    contents.on("did-stop-loading", () => {
      if (tab.allowed === null) this.close(tab.id);
      else this.tell();
    });
    // an agent's tab takes no input from a person until they hold it
    const ignored = () => tab.profile === "agent" && !tab.held;
    contents.on("before-input-event", (event) => { if (ignored()) event.preventDefault(); });
    contents.on("before-mouse-event", (event) => { if (ignored()) event.preventDefault(); });
    contents.on("render-process-gone", () => this.close(tab.id));
    contents.on("destroyed", () => { if (this.tabs.get(tab.id) === tab) this.close(tab.id); });
  }
}
