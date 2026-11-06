import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices, type Browser, type BrowserContext, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import type { Machine } from "../shared/machines.ts";
import { paneStorageId } from "../shared/machines.ts";
import type { SharedPreferences } from "../shared/preferences.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import { handlePreferencesRequest, PreferenceStore } from "../server/preferences.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { contextMenuKey } from "./context-menu-key.ts";

/**
 * The Agents list's Mute alerts (#1052) on the unmodified app over the demo's fixture transport,
 * with the shared preferences served by the real PreferenceStore (server/preferences.ts) through
 * this script's loopback server, so two tabs are two browsers of one server. Status events are
 * injected into the app's event stream, the tab's Notification and AudioContext are spies, and a
 * control pane's visible status change is the barrier that says an event was handled before a
 * "nothing happened" assertion. No herdr session is opened; every file stays in a temp directory.
 */

interface RosterPatch { secondPc?: "connected" | "disconnected" | null; longLabel?: { paneId: string; label: string } | null; empty?: boolean; loading?: boolean }
declare global {
  interface Window {
    muteFixture: {
      documents: SharedPreferences[];
      spies: { notifications: { title: string; body?: string; tag?: string }[]; oscillators: number };
      frame(machineId: string, message: ServerMessage): void;
      roster(patch: RosterPatch): Promise<void>;
      hide(hidden: boolean): void;
    };
  }
}

function installMuteFixture(): void {
  const watch = new URLSearchParams(location.search).get("mute-fixture") === "watch";
  const spies = { notifications: [] as { title: string; body?: string; tag?: string }[], oscillators: 0 };
  const documents: SharedPreferences[] = [];
  const patch: RosterPatch = {};
  const patched = (machines: Machine[]): Machine[] => {
    const local = machines[0];
    if (!local?.snapshot) return machines;
    if (patch.loading) return [{ ...local, snapshot: null }];
    if (patch.empty) return [{ ...local, snapshot: { ...local.snapshot, panes: [], agents: [], workspaces: [], tabs: [], layouts: [] } }];
    const long = patch.longLabel;
    if (long) for (const pane of local.snapshot.panes) if (pane.pane_id === long.paneId) pane.label = long.label;
    if (patch.secondPc) return [...machines, { ...structuredClone(local), id: "pc-2", name: "Laptop", state: patch.secondPc, error: null }];
    return machines;
  };
  const fetchDemo = window.fetch;
  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    // the shared document lives in this script's server, as it lives in the web ui server: the demo's own copy is bypassed
    if (url.pathname === "/api/preferences") return fetchDemo("/fixture/preferences", init);
    const response = await fetchDemo(input, init);
    if (url.pathname === "/api/health" && watch) {
      const body = await response.json();
      return Response.json({ ...body, auth: { ...body.auth, role: "watch" } });
    }
    if (url.pathname === "/api/machines") {
      const body = await response.json();
      return Response.json({ ...body, machines: patched(body.machines) });
    }
    return response;
  }, fetchDemo);

  const handlers = new Map<EventSource, (event: MessageEvent<string>) => void>();
  const primed = new WeakSet<EventSource>();
  const inject = (body: unknown): void => {
    for (const handler of handlers.values()) handler(new MessageEvent("message", { data: JSON.stringify(body) }));
  };
  const DemoSource = window.EventSource;
  window.EventSource = class extends DemoSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      if (new URL(String(url), location.href).pathname !== "/api/machines/events") return;
      Object.defineProperty(this, "onmessage", {
        get: () => (event: MessageEvent<string>) => {
          const body = JSON.parse(event.data);
          // the demo's own document is not the one shared here: the fixture server's stream stands in for it
          if (body.type === "preferences") return;
          if (body.type === "machines") body.machines = patched(body.machines);
          handlers.get(this)?.(new MessageEvent("message", { data: JSON.stringify(body) }));
          // as the server's stream opens with the shared document: the latest heard follows the roster
          if (body.type === "machines" && !primed.has(this) && documents.length > 0) {
            primed.add(this);
            handlers.get(this)?.(new MessageEvent("message", { data: JSON.stringify({ type: "preferences", preferences: documents[documents.length - 1] }) }));
          }
        },
        set: (handler: (event: MessageEvent<string>) => void) => { handlers.set(this, handler); },
      });
    }
    close(): void { handlers.delete(this); super.close(); }
  };
  const feed = new DemoSource("/fixture/preferences/events");
  feed.onmessage = (event: MessageEvent<string>) => {
    const document = JSON.parse(event.data) as SharedPreferences;
    documents.push(document);
    inject({ type: "preferences", preferences: document });
  };

  class FakeNotification {
    static permission = "granted";
    static requestPermission = async () => "granted";
    constructor(title: string, options?: { body?: string; tag?: string }) { spies.notifications.push({ title, body: options?.body, tag: options?.tag }); }
    addEventListener(): void {}
    close(): void {}
  }
  Object.defineProperty(window, "Notification", { value: FakeNotification, configurable: true });
  class FakeAudioContext {
    state = "running";
    destination = {};
    private readonly started = performance.now();
    // a clock that runs: a chime that sounds (lib/alertSound.ts) tells the alerts that come while it does
    get currentTime(): number { return (performance.now() - this.started) / 1000; }
    async resume(): Promise<void> {}
    async close(): Promise<void> {}
    createOscillator() { spies.oscillators++; return { type: "sine", frequency: { value: 0 }, connect: (node: unknown) => node, start(): void {}, stop(): void {} }; }
    createGain() { return { gain: { setValueAtTime(): void {}, exponentialRampToValueAtTime(): void {} }, connect: (node: unknown) => node }; }
  }
  Object.defineProperty(window, "AudioContext", { value: FakeAudioContext, configurable: true });
  let hidden = false;
  Object.defineProperty(document, "hidden", { get: () => hidden, configurable: true });
  Object.defineProperty(document, "visibilityState", { get: () => hidden ? "hidden" : "visible", configurable: true });

  window.muteFixture = {
    documents,
    spies,
    frame(machineId, message) { inject({ type: "machine-message", machine_id: machineId, message }); },
    async roster(next) {
      Object.assign(patch, next);
      const { machines } = await (await window.fetch("/api/machines")).json();
      inject({ type: "machines", machines });
    },
    hide(flag) { hidden = flag; document.dispatchEvent(new Event("visibilitychange")); },
  };
}

// ---- the fixture server: the demo build, and the shared preferences on the real store ----------

const P = panes.omp;             // "Plan the config file": the pane that is muted
const CONTROL = panes.web;       // "Guard the export button": its status change is the barrier
const OPENED = panes.api;        // "Idempotent payments": on screen, so the demo's own finish alerts nothing
const LONG_LABEL = "Rewrite the whole configuration loader so that every environment variable is validated before the service boots";
const app = mkdtempSync(join(tmpdir(), "herdr-pane-mute-demo-"));
const stateRoot = mkdtempSync(join(tmpdir(), "herdr-pane-mute-state-"));
let stores = 0;
const fixture = { store: new PreferenceStore(join(stateRoot, "fresh-0")), old: false, error: false, watch: false, puts: [] as Record<string, unknown>[] };
const strip = (document: SharedPreferences): SharedPreferences => {
  if (!fixture.old) return document;
  const { muted_panes: _muted, ...older } = document;
  return older;
};
/** a store of its own: fresh, or over a file from before the mute list existed */
function openStore(kind: "fresh" | "pre-feature"): void {
  const dir = join(stateRoot, `${kind}-${++stores}`);
  mkdirSync(dir, { recursive: true });
  if (kind === "pre-feature") writeFileSync(join(dir, "preferences.json"), JSON.stringify({ revision: 3, settings: {}, pins: [] }));
  fixture.store = new PreferenceStore(dir);
  fixture.puts.length = 0;
}
function storeHolds(what: string, found: (document: SharedPreferences) => boolean): Promise<SharedPreferences> {
  return new Promise((resolve, reject) => {
    if (found(fixture.store.get())) { resolve(fixture.store.get()); return; }
    const timer = setTimeout(() => { stop(); reject(new Error(`timed out waiting for ${what}`)); }, 10_000);
    const stop = fixture.store.subscribe((document) => { if (found(document)) { clearTimeout(timer); stop(); resolve(document); } });
  });
}

const evidence = process.env["UI_EVIDENCE_DIR"];
if (evidence) mkdirSync(evidence, { recursive: true });
const manifest: { file: string; width: number; height: number; scale: number; theme: string; language: string; state: string; sha256: string; capturedAt: string }[] = [];
async function capture(page: Page, theme: string, language: string, state: string): Promise<void> {
  if (!evidence) return;
  const viewport = page.viewportSize()!;
  const file = `pane-mute-${viewport.width}-${theme}${language === "ko" ? "-ko" : ""}-${state}.png`;
  const path = join(evidence, file);
  // a sheet that just closed or a drawer that just opened is drawn before the shot: two frames, then any finite animation
  // but an alert's, whose countdown is its life and would outlast it; a closed sheet slides out as a copy in an inert
  // host at the end of <body> (lib/sheets.ts `leave`), gone once it has slid out
  await page.waitForFunction(() => ![...document.body.children].some((node) => node instanceof HTMLDivElement && node.inert && node.getAttribute("aria-hidden") === "true" && node.childElementCount === 0));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    return animation.effect?.getComputedTiming().endTime !== Infinity && !(target instanceof Element && target.closest(".droplet") !== null);
  }).map((animation) => animation.finished)));
  await page.screenshot({ path, animations: "disabled" });
  manifest.push({ file, width: viewport.width, height: viewport.height, scale: viewport.width === 390 ? 3 : 1, theme, language, state, sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), capturedAt: new Date().toISOString() });
}

// ---- the pages -----------------------------------------------------------------------------------

const row = (page: Page, machineId: string, paneId: string) => page.locator(`.agents-sidebar .agent-item[data-machine="${machineId}"][data-pane="${paneId}"]`);
const status = (page: Page, machineId: string, paneId: string, value: string) => row(page, machineId, paneId).locator(`.sidebar-status[data-status="${value}"]`);
const muteItem = (page: Page) => page.locator('.row-menu [role="menuitemcheckbox"], .row-sheet-item[aria-pressed]');
const droplet = (page: Page) => page.locator(".droplet-card");
// an alert leaves by itself after its hold (DROPLET_HOLD_MS): a Dismiss pressed after a slow capture can find it
// already leaving, so each step that needs it gone waits for it to go
let url = "";

async function newContext(browser: Browser, phone: boolean, settings: Record<string, unknown>): Promise<BrowserContext> {
  const context = await browser.newContext(phone ? { ...devices["iPhone 14"], locale: settings["language"] === "ko" ? "ko-KR" : "en-US" } : { viewport: { width: 1440, height: 900 }, locale: "en-US" });
  await context.addInitScript((stored) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", alertsOn: true, alertInput: true, alertDone: "always", alertSound: true, ...stored }));
  }, settings);
  return context;
}

async function openTab(context: BrowserContext, query = ""): Promise<Page> {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  (page as Page & { fixtureErrors: string[] }).fixtureErrors = errors;
  await page.goto(`${url}?pane=${encodeURIComponent(OPENED)}${query}`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await row(page, "local", P).waitFor({ state: "attached" });
  // the shared document arrived: the row menu offers what the server keeps
  await page.waitForFunction(() => window.muteFixture.documents.length > 0);
  // the demo's own turn on the open pane ends 4.5 s after load (site/demo/transport.ts): every count and
  // every capture comes after it, so none races that finish
  await page.locator(`.pane-item:has(.pane-select[title^="${OPENED} —"]) [data-status="idle"]`).first().waitFor({ state: "attached", timeout: 10_000 });
  return page;
}
const errorsOf = (page: Page): string[] => (page as Page & { fixtureErrors: string[] }).fixtureErrors;

/** the page's own GET, as the app makes it */
const getPreferences = (page: Page): Promise<SharedPreferences> => page.evaluate(async () => (await fetch("/api/preferences")).json() as Promise<SharedPreferences>);

async function openDrawer(page: Page): Promise<void> {
  const toggle = page.locator('button[aria-controls="workspace-drawer"]');
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.tap();
  const agents = page.locator(".agents-sidebar .agent-section-toggle");
  if (await agents.getAttribute("aria-expanded") !== "true") await agents.tap();
}

/** opens the row's menu: a right-click on a desktop, the ⋯ and its sheet on a phone */
async function openMenu(page: Page, phone: boolean, machineId: string, paneId: string): Promise<void> {
  const target = row(page, machineId, paneId);
  if (phone) {
    await openDrawer(page);
    await target.locator(".row-menu-toggle").tap();
    await page.locator(".row-sheet").waitFor();
  } else {
    await target.locator(".agent-select").click({ button: "right" });
    await page.locator(".row-menu").waitFor();
  }
  await page.locator('.row-menu [role="menuitem"], .row-sheet-item').first().waitFor();
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.locator(".row-menu, .row-sheet").waitFor({ state: "detached" });
}

async function toggleMute(page: Page, phone: boolean, machineId: string, paneId: string): Promise<void> {
  await openMenu(page, phone, machineId, paneId);
  if (phone) await muteItem(page).tap(); else await muteItem(page).click();
  await page.locator(".row-menu, .row-sheet").waitFor({ state: "detached" });
}

/** a status frame as the server sends one; `done` is a new finish each time */
let finishes = 100;
async function statusFrame(page: Page, machineId: string, paneId: string, agentStatus: "working" | "blocked" | "done" | "idle"): Promise<void> {
  const epoch = await page.evaluate(async () => ((await (await fetch("/api/session")).json()) as { snapshot: { finish_epoch: string } }).snapshot.finish_epoch);
  const message: ServerMessage = { type: "pane-status", pane_id: paneId, agent_status: agentStatus, finish_id: agentStatus === "done" ? ++finishes : finishes, finish_epoch: epoch };
  await page.evaluate(({ machineId, message }) => window.muteFixture.frame(machineId, message), { machineId, message });
}
async function endedFrame(page: Page, machineId: string, paneId: string): Promise<void> {
  await page.evaluate(({ machineId, message }) => window.muteFixture.frame(machineId, message), { machineId, message: { type: "pane-exited", pane_id: paneId } as ServerMessage });
}
/** the control pane changes between two statuses that alert nobody; once its cell shows the change, every frame before it was handled */
let controlWorking = false;
async function barrier(page: Page): Promise<void> {
  controlWorking = !controlWorking;
  const next = controlWorking ? "working" : "idle";
  await statusFrame(page, "local", CONTROL, next);
  await status(page, "local", CONTROL, next).waitFor({ state: "attached" });
}
const spies = (page: Page) => page.evaluate(() => ({ notifications: window.muteFixture.spies.notifications, chimes: window.muteFixture.spies.oscillators / 2 }));
async function quiet(page: Page, label: string): Promise<void> {
  await barrier(page);
  const seen = await spies(page);
  assert.equal(await droplet(page).count(), 0, `${label}: no in-app alert`);
  assert.deepEqual(seen, { notifications: [], chimes: 0 }, `${label}: no notification and no chime`);
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(join(app, "mute-fixture.js"), `(${installMuteFixture.toString()})();`);
  writeFileSync(index, html.replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script src="./mute-fixture.js"></script>\n    <script type="module"'));

  // the preferences stream stays open across the whole run: a heartbeat every 15 s, as the server's stream has, keeps it inside the idle limit
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/fixture/preferences") {
      if (request.method === "PUT") {
        const text = await request.text();
        fixture.puts.push(JSON.parse(text));
        if (fixture.watch) return Response.json({ error: { code: "read_only", message: "this device can only watch" } }, { status: 403 });
        if (fixture.error) return Response.json({ error: { code: "preferences_unwritable", message: "EACCES: permission denied, open '/state/preferences.json.7.tmp'" } }, { status: 500 });
        const body = fixture.old ? JSON.stringify(strip({ revision: 0, ...JSON.parse(text) })) : text;
        const answer = await handlePreferencesRequest(new Request(request.url, { method: "PUT", body }), fixture.store);
        return answer.status === 200 ? Response.json(strip(await answer.json() as SharedPreferences), { headers: { "cache-control": "no-store" } }) : answer;
      }
      return Response.json(strip(fixture.store.get()), { headers: { "cache-control": "no-store" } });
    }
    if (path === "/fixture/preferences/events") {
      const store = fixture.store;
      let stop = () => {};
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          const send = (document: SharedPreferences) => { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(strip(document))}\n\n`)); } catch { stop(); } };
          send(store.get());
          const unsubscribe = store.subscribe(send);
          const heartbeat = setInterval(() => { try { controller.enqueue(encoder.encode(": heartbeat\n\n")); } catch { stop(); } }, 15_000);
          stop = () => { clearInterval(heartbeat); unsubscribe(); try { controller.close(); } catch { /* closed already */ } };
          request.signal.addEventListener("abort", stop, { once: true });
        },
        cancel() { stop(); },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    }
    // the brand mark is root-absolute (<img src="/icons/..."> in src/App.tsx); the published demo rewrites it
    // (scripts/build-site.ts), this server serves it from the build as the web ui server does
    if (!path.startsWith("/herdr-web-ui/demo/app/") && !path.startsWith("/icons/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.startsWith("/icons/") ? path.slice(1) : path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;

  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const key = paneStorageId("local", P);
      const checks: string[] = [];

      // ---- a document from before the list, and a fresh one: both offer the first mute ----
      openStore("pre-feature");
      {
        const context = await newContext(browser, false, {});
        const page = await openTab(context);
        assert.deepEqual(await getPreferences(page), { revision: 3, settings: {}, pins: [], muted_panes: [] }, "GET of a pre-feature document carries the empty list");
        assert.deepEqual(await page.evaluate(() => window.muteFixture.documents[0]), { revision: 3, settings: {}, pins: [], muted_panes: [] }, "the stream's opening document carries the empty list");
        await openMenu(page, false, "local", P);
        assert.equal(await muteItem(page).getAttribute("aria-checked"), "false", "the row menu offers Mute alerts, unchecked");
        await muteItem(page).click();
        const saved = await storeHolds("the first mute", (document) => document.muted_panes?.includes(key) === true);
        // the first save names the state folder (shared/preferences.ts state_id)
        const { state_id: savedId, ...savedRest } = saved;
        assert.match(savedId ?? "", /^[0-9a-f]{32}$/, "the first save names the state folder");
        assert.deepEqual(savedRest, { revision: 4, settings: {}, pins: [], muted_panes: [key] }, "the first mute is saved over the pre-feature document");
        await page.waitForFunction((revision) => window.muteFixture.documents.some((document) => document.revision === revision), saved.revision);
        await row(page, "local", P).locator('[data-testid="alerts-muted"]').waitFor();
        assert.deepEqual(errorsOf(page), []);
        await context.close();
        checks.push("pre-feature document: GET and the opening stream say muted_panes: [], and the first mute is saved and broadcast");
      }
      openStore("fresh");
      {
        const context = await newContext(browser, false, {});
        const page = await openTab(context);
        assert.deepEqual(await getPreferences(page), { revision: 0, settings: {}, muted_panes: [] }, "GET of a fresh store carries the empty list");
        await toggleMute(page, false, "local", P);
        const saved = await storeHolds("the first mute of a fresh store", (document) => document.muted_panes?.includes(key) === true);
        const { state_id: savedId, ...savedRest } = saved;
        assert.match(savedId ?? "", /^[0-9a-f]{32}$/, "the first save names the state folder");
        assert.deepEqual(savedRest, { revision: 1, settings: {}, pins: [], muted_panes: [key] }, "the first mute is saved over the fresh store");
        await context.close();
        checks.push("fresh store: GET says muted_panes: [], and the first mute is saved as revision 1");
      }

      // ---- two tabs, four channels ----
      openStore("fresh");
      const context = await newContext(browser, false, {});
      const a = await openTab(context);
      const b = await openTab(context);
      // a key was pressed on the page: its chimes may play from here (lib/alertSound.ts unlocks on a gesture)
      await a.keyboard.press("Shift");
      await toggleMute(a, false, "local", P);
      const muted = await storeHolds("tab A's mute", (document) => document.muted_panes?.includes(key) === true);
      assert.equal(muted.revision, 1);
      // tab B hears the revision on its stream and draws the row muted
      await b.waitForFunction((revision) => window.muteFixture.documents.some((document) => document.revision === revision), muted.revision);
      await row(b, "local", P).locator('[data-testid="alerts-muted"]').waitFor();
      await row(a, "local", P).locator('[data-testid="alerts-muted"]').waitFor();
      checks.push("tab B received tab A's mute as preference revision 1 and draws the indicator");
      // a second PC with the same pane: the mute keys the pane with its PC
      await a.evaluate(() => window.muteFixture.roster({ secondPc: "connected" }));
      await row(a, "pc-2", P).waitFor({ state: "attached" });
      await a.locator(".droplet").waitFor({ state: "detached" });
      // the muted pane: blocked, done and ended reach the roster and no channel
      await statusFrame(a, "local", P, "working");
      await statusFrame(a, "local", P, "blocked");
      await status(a, "local", P, "blocked").waitFor({ state: "attached" });
      await quiet(a, "muted pane blocked");
      await statusFrame(a, "local", P, "done");
      await status(a, "local", P, "done").waitFor({ state: "attached" });
      await quiet(a, "muted pane done");
      await endedFrame(a, "local", P);
      await quiet(a, "muted pane ended");
      checks.push("local P blocked, done and exited while muted: no droplet, no chime, no notification; its row still shows each status");
      // the other PC's same-named pane: every channel the visible tab has
      await statusFrame(a, "pc-2", P, "working");
      await statusFrame(a, "pc-2", P, "blocked");
      await droplet(a).waitFor({ state: "visible" });
      assert.match(await droplet(a).getAttribute("aria-label") ?? "", /Plan the config file/);
      assert.equal(await a.locator(".droplet").getAttribute("data-kind"), "blocked");
      await capture(a, "dark", "en", "alert-blocked");
      await a.waitForFunction(() => window.muteFixture.spies.oscillators >= 2);
      await a.locator(".droplet").waitFor({ state: "detached" });
      await statusFrame(a, "pc-2", P, "done");
      await droplet(a).waitFor({ state: "visible" });
      assert.equal(await a.locator(".droplet").getAttribute("data-kind"), "done");
      await a.locator(".droplet").waitFor({ state: "detached" });
      await endedFrame(a, "pc-2", P);
      await droplet(a).waitFor({ state: "visible" });
      assert.equal(await a.locator(".droplet").getAttribute("data-kind"), "ended");
      await a.locator(".droplet").waitFor({ state: "detached" });
      let seen = await spies(a);
      // the three alerts came within one chime's length: the first sounds, and tells the others too
      assert.ok(seen.chimes >= 1, `the other PC's pane chimed: ${JSON.stringify(seen)}`);
      assert.deepEqual(seen.notifications, [], "a visible tab shows no system notification");
      checks.push("pc-2's same-named P: droplets for blocked, done and ended, and chimes, as before");
      // the hidden tab: the notification channel
      await a.evaluate(() => window.muteFixture.hide(true));
      await statusFrame(a, "local", P, "working");
      await statusFrame(a, "local", P, "blocked");
      await status(a, "local", P, "blocked").waitFor({ state: "attached" });
      await barrier(a);
      seen = await spies(a);
      assert.deepEqual(seen.notifications, [], "the muted pane raises no notification in a hidden tab");
      await statusFrame(a, "pc-2", P, "working");
      await statusFrame(a, "pc-2", P, "blocked");
      await a.waitForFunction(() => window.muteFixture.spies.notifications.length > 0);
      seen = await spies(a);
      assert.equal(seen.notifications.length, 1);
      assert.match(seen.notifications[0]!.title, /Laptop · Plan the config file/);
      assert.equal(seen.notifications[0]!.body, "waiting for your input");
      await a.evaluate(() => window.muteFixture.hide(false));
      checks.push("hidden tab: no notification for muted local P, one for pc-2's P");
      // an unmute tells only what changes after it
      const chimesBefore = seen.chimes;
      await toggleMute(a, false, "local", P);
      await storeHolds("tab A's unmute", (document) => document.muted_panes?.length === 0);
      await row(a, "local", P).locator('[data-testid="alerts-muted"]').waitFor({ state: "detached" });
      await row(b, "local", P).locator('[data-testid="alerts-muted"]').waitFor({ state: "detached" });
      await statusFrame(a, "local", P, "blocked");
      await barrier(a);
      assert.equal(await droplet(a).count(), 0, "the question that came while muted is not told by the unmute");
      await statusFrame(a, "local", P, "working");
      await statusFrame(a, "local", P, "blocked");
      await droplet(a).waitFor({ state: "visible" });
      assert.match(await droplet(a).getAttribute("aria-label") ?? "", /Plan the config file/);
      await a.waitForFunction((before) => window.muteFixture.spies.oscillators / 2 > before, chimesBefore);
      await a.locator(".droplet").waitFor({ state: "detached" });
      checks.push("after the unmute only a new transition alerts");
      // a PC that is away, or not in this page's roster at all, keeps its mutes through this page's changes
      const theirs = paneStorageId("pc-2", P);
      await toggleMute(a, false, "pc-2", P);
      await storeHolds("the other PC's mute", (document) => document.muted_panes?.includes(theirs) === true);
      await a.evaluate(() => window.muteFixture.roster({ secondPc: null }));
      await row(a, "pc-2", P).waitFor({ state: "detached" });
      await toggleMute(a, false, "local", P);
      let kept = await storeHolds("a mute made with the other PC missing", (document) => document.muted_panes?.includes(key) === true);
      assert.deepEqual([...kept.muted_panes!].sort(), [theirs, key].sort(), "a PC missing from the roster keeps its mute");
      await a.evaluate(() => window.muteFixture.roster({ secondPc: "disconnected" }));
      await row(a, "pc-2", P).and(a.locator(".is-offline")).waitFor({ state: "attached" });
      await toggleMute(a, false, "local", P);
      kept = await storeHolds("an unmute made with the other PC away", (document) => document.muted_panes?.includes(key) === false);
      assert.deepEqual(kept.muted_panes, [theirs], "a PC that is away keeps its mute");
      await a.evaluate(() => window.muteFixture.roster({ secondPc: "connected" }));
      await row(a, "pc-2", P).and(a.locator(":not(.is-offline)")).waitFor({ state: "attached" });
      await row(a, "pc-2", P).locator('[data-testid="alerts-muted"]').waitFor();
      await b.evaluate(() => window.muteFixture.roster({ secondPc: "connected" }));
      await row(b, "pc-2", P).locator('[data-testid="alerts-muted"]').waitFor();
      assert.deepEqual(errorsOf(a), []);
      assert.deepEqual(errorsOf(b), []);
      checks.push("a PC missing from the roster or away keeps its mute through this page's changes, and shows it again when back");
      await context.close();

      // ---- an older server: no list, no mute offered, none sent ----
      openStore("fresh");
      // a server that already holds pins: a pin alone is then a change that goes out (lib/preferencesSync.ts)
      fixture.store.set({ settings: {}, pins: [] });
      fixture.old = true;
      {
        const context = await newContext(browser, false, {});
        const page = await openTab(context);
        assert.equal("muted_panes" in (await getPreferences(page)), false, "the older server's document has no list");
        await openMenu(page, false, "local", P);
        assert.equal(await muteItem(page).count(), 0, "no Mute alerts on an older server");
        // a change of something else (a pin) goes out without a list
        await page.locator('.row-menu [role="menuitem"]', { hasText: "Pin agent" }).click();
        await storeHolds("the pin", (document) => (document.pins?.length ?? 0) > 0);
        assert.ok(fixture.puts.length > 0 && fixture.puts.every((body) => !("muted_panes" in body)), `no fabricated list was sent: ${JSON.stringify(fixture.puts)}`);
        assert.deepEqual(errorsOf(page), []);
        await context.close();
        checks.push("older server without muted_panes: the row menu offers no mute and no list is uploaded");
      }
      fixture.old = false;

      // ---- a watching device: the state, not the switch ----
      openStore("fresh");
      fixture.store.set({ settings: {}, muted_panes: [key] });
      fixture.watch = true;
      {
        const context = await newContext(browser, false, {});
        const page = await openTab(context, "&mute-fixture=watch");
        await row(page, "local", P).locator('[data-testid="alerts-muted"]').waitFor();
        await openMenu(page, false, "local", P);
        assert.equal(await muteItem(page).getAttribute("aria-checked"), "true", "a watching device sees the shared state");
        assert.equal(await muteItem(page).getAttribute("aria-disabled"), "true", "and cannot flip it");
        await muteItem(page).click({ force: true });
        await barrier(page);
        assert.equal(await page.locator(".row-menu").count(), 1, "a press on the disabled item leaves the menu open");
        assert.deepEqual(fixture.puts, [], "a watching device sends no change");
        assert.equal(fixture.store.get().revision, 1);
        await closeMenu(page);
        assert.deepEqual(errorsOf(page), []);
        await context.close();
        checks.push("watch device: Unmute alerts is shown checked and disabled, and no PUT goes out");
      }
      fixture.watch = false;

      // ---- the captures: both widths, both themes, Korean on a phone ----
      if (evidence) {
        for (const phone of [false, true]) for (const theme of ["dark", "light"]) for (const language of phone ? ["en", "ko"] : ["en"]) {
          if (language === "ko" && theme === "light") continue;
          openStore("fresh");
          const context = await newContext(browser, phone, { theme, language });
          const page = await openTab(context);
          if (phone) await openDrawer(page);
          await capture(page, theme, language, "rest-unmuted");
          await openMenu(page, phone, "local", P);
          await capture(page, theme, language, "menu-unmuted");
          if (!phone) {
            await muteItem(page).hover();
            await capture(page, theme, language, "menu-hover");
            await page.mouse.down();
            await capture(page, theme, language, "menu-pressed");
            await page.mouse.move(0, 0);
            await page.mouse.up();
          } else {
            // a finger held on the item: the sheet's row fills while pressed (RowMenu.css `:active`)
            const box = (await muteItem(page).boundingBox())!;
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await capture(page, theme, language, "menu-pressed");
            await page.mouse.move(box.x + box.width / 2, box.y - box.height);
            await page.mouse.up();
          }
          await closeMenu(page);
          if (phone) {
            // a phone with a keyboard: the arrows walk the sheet's items to the mute item
            await openMenu(page, phone, "local", P);
            for (let step = 0; step < 4 && !await muteItem(page).evaluate((item) => item === document.activeElement); step += 1) await page.keyboard.press("ArrowDown");
            await page.waitForFunction(() => document.activeElement?.matches(".row-sheet-item[aria-pressed]") === true);
            await capture(page, theme, language, "menu-focus-visible");
            await closeMenu(page);
          } else {
            await row(page, "local", P).locator(".agent-select").focus();
            await contextMenuKey(page);
            await page.locator(".row-menu").waitFor();
            await page.locator('.row-menu [role="menuitem"]').first().waitFor();
            await page.waitForFunction(() => document.activeElement?.closest(".row-menu") !== null);
            await page.keyboard.press("ArrowDown");
            await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitemcheckbox");
            await capture(page, theme, language, "menu-focus-visible");
            await closeMenu(page);
          }
          await toggleMute(page, phone, "local", P);
          await row(page, "local", P).locator('[data-testid="alerts-muted"]').waitFor();
          if (phone) await openDrawer(page);
          await capture(page, theme, language, "rest-muted");
          await openMenu(page, phone, "local", P);
          await capture(page, theme, language, "menu-muted");
          await closeMenu(page);
          if (language === "en") {
            await page.evaluate((label) => window.muteFixture.roster({ longLabel: { paneId: label.paneId, label: label.label } }), { paneId: P, label: LONG_LABEL });
            await row(page, "local", P).locator(".agent-title", { hasText: LONG_LABEL.slice(0, 20) }).waitFor();
            if (phone) await openDrawer(page);
            await capture(page, theme, language, "long-name");
            await page.evaluate(() => window.muteFixture.roster({ longLabel: null, secondPc: "connected" }));
            await row(page, "pc-2", P).waitFor({ state: "attached" });
            await page.locator(".droplet").waitFor({ state: "detached" });
            await toggleMute(page, phone, "pc-2", P);
            await row(page, "pc-2", P).locator('[data-testid="alerts-muted"]').waitFor();
            await page.evaluate(() => window.muteFixture.roster({ secondPc: "disconnected" }));
            await row(page, "pc-2", P).and(page.locator(".is-offline")).waitFor({ state: "attached" });
            if (phone) await openDrawer(page);
            // the offline PC's muted row at the list's bottom edge, with the rest of its rows still below
            await row(page, "pc-2", P).evaluate((item) => item.scrollIntoView({ block: "end" }));
            await capture(page, theme, language, "offline-pc");
            await page.locator(".agents-sidebar .agent-list-contents").evaluate((list) => { list.scrollTop = list.scrollHeight; });
            await capture(page, theme, language, "list-end");
            // the alert of a pane that is not muted draws as before, over the muted roster
            await page.evaluate(() => window.muteFixture.roster({ secondPc: "connected" }));
            await statusFrame(page, "local", CONTROL, "working");
            await statusFrame(page, "local", CONTROL, "blocked");
            await droplet(page).waitFor({ state: "visible" });
            await capture(page, theme, language, "alert-unmuted-pane");
            await page.locator(".droplet").waitFor({ state: "detached" });
            // the server cannot save: Settings says so
            fixture.error = true;
            await toggleMute(page, phone, "local", panes.cli);
            await page.keyboard.press("ControlOrMeta+Shift+Comma");
            await page.locator(".settings-dialog").waitFor();
            const alerts = page.locator(".settings-dialog").getByRole("tab", { name: "Alerts", exact: true });
            if (await alerts.count() > 0) await alerts.click();
            await page.locator(".settings-save-error").waitFor({ timeout: 10_000 });
            await capture(page, theme, language, "save-error");
            fixture.error = false;
            await page.keyboard.press("Escape");
            await page.locator(".settings-dialog").waitFor({ state: "detached" });
            // a watching device's menu
            fixture.watch = true;
            const watching = await openTab(context, "&mute-fixture=watch");
            await openMenu(watching, phone, "local", P);
            await capture(watching, theme, language, "menu-watch");
            await closeMenu(watching);
            await watching.close();
            fixture.watch = false;
            // the roster before it is known, and with nothing in it
            await page.evaluate(() => window.muteFixture.roster({ secondPc: null, loading: true }));
            if (phone) await openDrawer(page);
            await page.locator(".agents-sidebar .agent-empty", { hasText: "Loading" }).waitFor();
            await capture(page, theme, language, "roster-loading");
            await page.evaluate(() => window.muteFixture.roster({ loading: false, empty: true }));
            await page.locator(".agents-sidebar .agent-empty", { hasText: "No agents" }).waitFor();
            await capture(page, theme, language, "roster-empty");
          }
          assert.deepEqual(errorsOf(page), []);
          await context.close();
        }
        writeFileSync(join(evidence, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        checks.push(`${manifest.length} captures written to ${evidence}`);
      }
      for (const check of checks) console.log(`PASS ${check}`);
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
}
