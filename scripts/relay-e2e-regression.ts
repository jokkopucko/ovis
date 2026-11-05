/**
 * The relay end to end, cross-origin as in production: the hosted shell (dist-shell/, served as
 * Cloudflare Pages serves it by scripts/pages-static.ts, under its real _headers and _redirects)
 * on one loopback origin, two PCs (`createServer`, each with its own mkdtemp state dir, on the
 * isolated herdr test session) on others, and one Bun relay (relay/bun.ts) between them. The page
 * never reaches a PC except through the relay WebSocket. Run after `bun run build:shell`.
 *
 * The shell accepts only a wss: relay and a PC only a wss: relay origin, so both name
 * `wss://relay.test`: the PCs' outbound sockets reach the local relay through RelayService's
 * `connect` seam, the browser's through Playwright's WebSocket routing (relay-browser-bridge.ts).
 * Every page runs on a frozen clock; a deadline is reached by advancing it, never by waiting.
 *
 * After its own journey (pairing, terminal, roster, reload, the relay lost mid-session, storage,
 * network, revoke) it runs relay-shell-browser-qa.ts (the shell's states, push per PC and its
 * rotation, version skew) and relay-media-browser-qa.ts (both PCs' files and media, a remote PC,
 * isolation in worker and blob mode, MP4 seek and Range), all against the same server tree. The
 * media part encodes its video with FFMPEG (default `ffmpeg`; CI: scripts/ci-ffmpeg.sh).
 *
 *   bun scripts/relay-e2e-regression.ts                  this checkout's shell against this checkout's server
 *   RELAY_E2E_SERVER_DIR=<tree> bun scripts/relay-e2e-regression.ts
 *                                                        this shell against the server in <tree>
 *   bun scripts/relay-e2e-regression.ts --skew <tag>     the same against a worktree of <tag>, removed afterwards
 *
 * UI_EVIDENCE_DIR=<dir> keeps the trace, screenshots, network log and report there (task-23-*).
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { startBunRelay } from "../relay/bun.ts";
import type { BunRelay } from "../relay/bun.ts";
import { paneRead, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { decodeOffer, encodeOffer } from "../shared/relay-offer.ts";
import type { RelayOffer } from "../shared/relay-offer.ts";
import { chromePath } from "./chrome-path.ts";
import { assertCspClean, watchCsp } from "./csp-violations.ts";
import type { CspWatch } from "./csp-violations.ts";
import { servePagesSite } from "./pages-static.ts";
import { relayBrowserSocket, relayServerTree } from "./relay-browser-bridge.ts";
import { relayMediaQa } from "./relay-media-browser-qa.ts";
import { relayShellQa } from "./relay-shell-browser-qa.ts";

const repo = join(import.meta.dir, "..");

// ---- --skew <tag>: this run again, against a worktree of the tag's server ----

const skewAt = process.argv.indexOf("--skew");
if (skewAt !== -1) {
  const tag = process.argv[skewAt + 1];
  if (!tag) throw new Error("--skew needs a tag");
  const tree = mkdtempSync(join(tmpdir(), "ovis-relay-e2e-skew-"));
  await $`git worktree add --detach ${tree} ${tag}`.cwd(repo);
  try {
    await $`bun install --frozen-lockfile`.cwd(tree);
    const run = await $`bun ${import.meta.path}`.cwd(repo).env({ ...process.env, RELAY_E2E_SERVER_DIR: tree }).nothrow();
    process.exitCode = run.exitCode;
  } finally {
    await $`git worktree remove --force ${tree}`.cwd(repo).quiet().nothrow();
  }
} else {
  await main();
}

async function main(): Promise<void> {
  if (!existsSync(join(repo, "dist-shell/index.html"))) throw new Error("dist-shell/ is missing: run `bun run build:shell` first");
  // the server under test: this checkout's, or the older tree's (todo 19); the shell and relay are always this checkout's
  const tree = await relayServerTree();
  const { createServer, RelayService } = tree;
  const serverDir = tree.dir;

  const evidence = process.env["UI_EVIDENCE_DIR"] || null;
  if (evidence) mkdirSync(evidence, { recursive: true });
  const keep = (name: string, text: string): void => { if (evidence) writeFileSync(join(evidence, `task-23-${name}`), text); };
  const shot = async (page: Page, name: string): Promise<void> => { if (evidence) await page.screenshot({ path: join(evidence, `task-23-${name}.png`), animations: "disabled" }); };
  const report: string[] = [`server tree: ${serverDir}${serverDir === repo ? " (this checkout)" : ""}`];
  const note = (line: string): void => { report.push(line); console.log(line); };

  const RELAY = "wss://relay.test";
  /** The page's fake time: fixed, so nothing in the page runs on the wall clock. */
  const T0 = new Date("2026-10-30T00:00:00Z");

  async function bounded<T>(promise: Promise<T>, what: string, ms = 30_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms); })]); }
    finally { clearTimeout(timer); }
  }

  const root = mkdtempSync(join(tmpdir(), "ovis-relay-e2e-"));
  const relayOptions = { port: 0, limits: { perAddressPerMinute: 10_000, globalPerMinute: 10_000 } };
  let relay: BunRelay | null = startBunRelay(relayOptions);
  let relayPort = relay.port;
  const relayAddress = (url: string): string => { const target = new URL(url); return `ws://127.0.0.1:${relayPort}${target.pathname}${target.search}`; };

  const pcs: Awaited<ReturnType<typeof startPc>>[] = [];
  const workspaces: string[] = [];
  const csp: CspWatch[] = [];
  const contexts: BrowserContext[] = [];
  const network: string[] = [];
  let browser: Browser | undefined;
  const site = servePagesSite(join(repo, "dist-shell"), 0);
  const origin = `http://127.0.0.1:${site.port}`;

  /** A PC: its own state dir and files, its relay through the seam, a sync event per (re)connection. */
  async function startPc(name: string) {
    const stateDir = mkdtempSync(join(root, `${name}-state-`));
    const dir = mkdtempSync(join(root, `${name}-files-`));
    let synced = Promise.withResolvers<void>();
    const service = new RelayService({ stateDir, relay: RELAY, connect: (url) => {
      const socket = new WebSocket(relayAddress(url));
      socket.addEventListener("message", (event) => { if (typeof event.data === "string" && event.data.includes('"sync"')) synced.resolve(); });
      return socket;
    } });
    const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, relay: service, pushLoopbackHttp: true });
    const base = `http://127.0.0.1:${app.port}`;
    const post = (path: string) => fetch(`${base}/api/relay${path}`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } });
    const pc = {
      name, stateDir, dir, service, app, base,
      devices: app.context.services.devices,
      push: app.context.services.core.push,
      /** turns its relay on through the API and resolves once its control socket synced */
      async start(): Promise<void> {
        synced = Promise.withResolvers<void>();
        const response = await post("/start");
        assert.equal(response.status, 200, `${name} relay start: ${await response.text()}`);
        await bounded(synced.promise, `${name} synced with the relay`);
      },
      async stop(): Promise<void> { assert.equal((await post("/stop")).status, 200); },
      /** the next sync: the PC's link reconnecting to a restarted relay by itself */
      resynced(): Promise<void> { synced = Promise.withResolvers<void>(); return synced.promise; },
      /** a pairing offer through the API, re-based onto the shell host */
      async offer(): Promise<RelayOffer> {
        const response = await post("/offer");
        const body = await response.text();
        assert.equal(response.status, 200, `${name} offer: ${body}`);
        const offer = decodeOffer((JSON.parse(body) as { url: string }).url);
        assert.ok(offer, `${name} gave no offer`);
        return { ...offer, name };
      },
    };
    return pc;
  }

  // ---- the browser side ----

  interface Opened { context: BrowserContext; page: Page }

  /**
   * A fresh context on a frozen clock: its own storage, relay sockets carried to the relay, every
   * request logged. `blob` takes the service worker away, as a
   * native WebView has none, so resources load as blobs.
   */
  async function open(options: { width?: number; blob?: boolean; trace?: boolean } = {}): Promise<Opened> {
    assert.ok(browser);
    const width = options.width ?? 1440;
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
    contexts.push(context);
    if (options.trace && evidence) await context.tracing.start({ screenshots: true, snapshots: true });
    await context.routeWebSocket(/^wss:\/\/relay\.test\//, (ws) => {
      network.push(`WS ${ws.url()}`);
      relayBrowserSocket(ws, () => relayAddress(ws.url()));
    });
    context.on("request", (request) => network.push(`${request.method()} ${request.url()}`));
    await context.addInitScript(({ blob }) => {
      if (window !== window.top) return;
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", ...JSON.parse(localStorage.getItem("ovis:settings") ?? "{}") as object }));
      if (blob) Reflect.deleteProperty(Navigator.prototype, "serviceWorker");
      const results: unknown[] = [];
      Object.defineProperty(window, "isolationResults", { value: results });
      addEventListener("message", (event) => {
        if ((event.data as { type?: string } | null)?.type === "isolation") { results.push((event.data as { result: unknown }).result); dispatchEvent(new Event("isolation-result")); }
      });
    }, { blob: options.blob === true });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => console.error("page error", error.stack));
    page.on("console", (message) => { if (message.type() === "error" || message.type() === "warning") console.error(`page ${message.type()}: ${message.text()}`); });
    await page.clock.install({ time: T0 });
    await page.clock.pauseAt(new Date(T0.getTime() + 1000));
    csp.push(await watchCsp(page));
    return { context, page };
  }
  /** Another page of a context, on the same frozen clock and policy watch. */
  async function tab(context: BrowserContext): Promise<Page> {
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.clock.install({ time: T0 });
    await page.clock.pauseAt(new Date(T0.getTime() + 1000));
    csp.push(await watchCsp(page));
    return page;
  }
  /** Runs the page's frozen clock a frame at a time until `check` holds: paint and the app's own timers, in page time only. */
  async function frames(page: Page, what: string, check: () => Promise<boolean>, limitMs = 20_000): Promise<void> {
    for (let ran = 0; !(await check()); ran += 16) {
      if (ran >= limitMs) throw new Error(`${what}: not within ${limitMs} ms of page time`);
      await page.clock.runFor(16);
    }
  }
  const state = (page: Page, name: string) => page.locator(`main[data-relay-state="${name}"]`);
  const inApp = async (page: Page): Promise<void> => {
    await page.locator(".app").waitFor();
    assert.equal(await page.locator("main[data-relay-state]").count(), 0, "the shell's screen is gone once the app is up");
  };
  const scopeOf = (id: string): string => `${origin}/s/${id}/`;
  /** Opens a pairing link as the PC's QR code gives it, confirms, and lands in the app. */
  async function pair(page: Page, offer: RelayOffer): Promise<void> {
    await page.goto(encodeOffer(offer, origin));
    await state(page, "confirm").waitFor();
    await page.getByRole("heading", { name: `Pair with ${offer.name}?` }).waitFor();
    assert.ok(!page.url().includes("#offer"), "the offer left the address before the question");
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await inApp(page);
  }
  /** The phone's saved record for a PC, or null. */
  const saved = (page: Page, serverId: string): Promise<{ device_id: string; extractable: boolean } | null> => page.evaluate(async (serverId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ovis-relay", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<{ device_id: string; extractable: boolean } | null>((resolve, reject) => {
        const request = db.transaction("devices", "readonly").objectStore("devices").get(serverId);
        request.onsuccess = () => resolve(request.result ? { device_id: request.result.device_id, extractable: (request.result.private_key as CryptoKey).extractable } : null);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }, serverId);
  const terminalText = (page: Page, pane: string): Promise<string> => page.evaluate((pane) => [...document.querySelectorAll(`.terminal-stack[data-pane-owner="${pane}"] .xterm-rows > div`)].map((row) => (row.textContent ?? "").replaceAll("\u00a0", " ")).join("\n"), pane);

  try {
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    pcs.push(await startPc("Desk PC"), await startPc("Laptop"));
    const [desk, laptop] = pcs as [Awaited<ReturnType<typeof startPc>>, Awaited<ReturnType<typeof startPc>>];
    for (const pc of pcs) {
      const status = await (await fetch(`${pc.base}/api/relay`)).json() as { phase: string };
      assert.equal(status.phase, "off", `${pc.name}: the relay is off until turned on`);
      await pc.start();
    }
    const deskOffer = await desk.offer();
    const laptopOffer = await laptop.offer();
    assert.notEqual(deskOffer.server_id, laptopOffer.server_id);
    assert.notEqual(new URL(origin).origin, new URL(desk.base).origin, "the shell is not on the PC's origin");
    note(`shell ${origin}; PCs ${desk.base} and ${laptop.base}; relay ws://127.0.0.1:${relayPort} as ${RELAY}; both relays turned on through POST /api/relay/start`);

    // ---- pairing, the terminal, the roster, a reload ----
    const main = await open({ trace: true });
    const { page } = main;
    const deskScope = scopeOf(deskOffer.server_id);
    const workspace = await workspaceCreate({ cwd: desk.dir, label: "relay-e2e" });
    workspaces.push(workspace.workspace.workspace_id);
    const pane = workspace.root_pane.pane_id;
    await pair(page, deskOffer);
    const deskDevice = await saved(page, deskOffer.server_id);
    assert.ok(deskDevice, "the phone saved the pairing");
    assert.equal(deskDevice.extractable, false, "the device key cannot be exported");
    assert.ok(desk.devices.list(null).some((device) => device.id === deskDevice.device_id && device.via_relay), "the PC enrolled the phone via the relay");
    await shot(page, "paired");
    note(`paired: ${deskScope}#offer=… -> confirm -> app; device ${deskDevice.device_id} enrolled via the relay, key not extractable`);

    await page.locator(`.workspace-group[data-workspace=${JSON.stringify(workspace.workspace.workspace_id)}] .workspace-select`).first().click();
    const screen = page.locator(`.terminal-stack[data-pane-owner=${JSON.stringify(pane)}] .xterm-screen`);
    await screen.waitFor({ state: "attached" });
    const live = async (): Promise<boolean> => await page.locator(".terminal-banner-warning").count() === 0 && (await terminalText(page, pane)).trim() !== "";
    await frames(page, "the pane's terminal attached and drew its prompt", live);
    await screen.click();
    await page.keyboard.type("echo relay-ok");
    await page.keyboard.press("Enter");
    await frames(page, "relay-ok in the terminal", async () => /^relay-ok\s*$/m.test(await terminalText(page, pane)));
    const herdrSaw = (await paneRead({ paneId: pane })).text;
    assert.match(herdrSaw, /^relay-ok\s*$/m, "herdr's own pane printed it");
    await shot(page, "terminal");
    note(`terminal: workspace opened from the sidebar, pane ${pane} attached, typed "echo relay-ok" + Enter -> relay-ok in xterm and in herdr's pane.read`);

    const roster = await workspaceCreate({ cwd: desk.dir, label: "relay-e2e-roster" });
    workspaces.push(roster.workspace.workspace_id);
    await page.locator(`.workspace-group[data-workspace=${JSON.stringify(roster.workspace.workspace_id)}]`).waitFor();
    note(`roster: workspace ${roster.workspace.workspace_id} created in herdr -> its sidebar row arrived over the relay's event stream`);

    const enrolled = desk.devices.list(null).length;
    await page.reload();
    await inApp(page);
    assert.equal(await page.locator('main[data-relay-state="confirm"]').count(), 0);
    assert.equal(desk.devices.list(null).length, enrolled, "a reload pairs nothing new");
    assert.equal((await saved(page, deskOffer.server_id))?.device_id, deskDevice.device_id, "the same saved device after the reload");
    note(`reload: ${page.url()} -> app from IndexedDB, no pairing question, PC still lists ${enrolled} device(s)`);

    // ---- the relay goes down mid-session: typed input is held, never sent; the relay returns and the app recovers ----
    const marker = `held-${randomBytes(3).toString("hex")}`;
    await page.locator(`.workspace-group[data-workspace=${JSON.stringify(workspace.workspace.workspace_id)}] .workspace-select`).first().click();
    await screen.waitFor({ state: "attached" });
    await frames(page, "the terminal reattached after the reload", live);
    const back = desk.resynced();
    const laptopBack = laptop.resynced();
    await relay.stop();
    relay = null;
    await page.locator(".terminal-banner-warning", { hasText: "Reconnecting to Ovis" }).waitFor();
    await screen.click();
    await page.keyboard.type(marker);
    await page.locator(".terminal-banner-warning .draft-held", { hasText: marker }).waitFor();
    await shot(page, "relay-down");
    const fresh = await tab(main.context);
    await fresh.goto(deskScope);
    await state(fresh, "relay-unreachable").waitFor();
    await fresh.getByRole("heading", { name: "The relay could not be reached" }).waitFor();
    if (evidence) await fresh.screenshot({ path: join(evidence, "task-23-relay-down.png"), animations: "disabled" });
    note(`relay down: relay stopped mid-session -> "Reconnecting to Ovis…" with "${marker}" held; a second tab opening the paired PC shows relay-unreachable`);
    relay = startBunRelay(relayOptions);
    relayPort = relay.port;
    await bounded(back, "Desk PC reconnected to the restarted relay by itself", 45_000);
    await bounded(laptopBack, "Laptop reconnected to the restarted relay by itself", 45_000);
    // the app's retry is a page timer: the frozen clock runs it
    await frames(page, "the app reconnected through the restarted relay", async () => await page.locator(".terminal-banner-draft .draft-text", { hasText: marker }).count() === 1, 60_000);
    assert.ok(!(await paneRead({ paneId: pane })).text.includes(marker), "the held input never reached the pane");
    assert.ok(!(await terminalText(page, pane)).includes(marker), "the held input is not on the terminal");
    await shot(page, "relay-back");
    await page.getByRole("button", { name: "Discard held input" }).click();
    await page.locator(".terminal-banner-draft").waitFor({ state: "detached" });
    await fresh.getByRole("button", { name: "Try again" }).click();
    await inApp(fresh);
    await fresh.close();
    note(`relay back: relay restarted on a new port, both PCs resynced by themselves, the app reconnected; "${marker}" waits in the draft, not in the pane; Try again on the second tab -> app`);

    // ---- what the shell keeps and where it went ----
    {
      const storage = await page.evaluate(() => [...Object.entries(localStorage), ...Object.entries(sessionStorage)]);
      const secrets = [deskOffer.code, deskOffer.server_public_key, deskDevice.device_id, laptopOffer.code];
      const leaked = storage.filter(([key, value]) => /relay|private|secret|offer/i.test(key) || secrets.some((secret) => secret !== undefined && value.includes(secret)));
      assert.deepEqual(leaked, [], "localStorage and sessionStorage hold no relay key, code or device id");
      keep("storage.txt", `# localStorage + sessionStorage of the shell page (${storage.length} entries); none holds a relay secret\n${storage.map(([key, value]) => `${key} = ${value.slice(0, 160)}`).join("\n")}\n`);
      const pcOrigins = pcs.map((pc) => pc.base);
      const direct = network.filter((line) => pcOrigins.some((base) => line.includes(` ${base}`)));
      assert.deepEqual(direct, [], "the shell never reached a PC except through the relay");
      // blob:, data: and the browser's own chrome:// and PDF viewer pages are not network requests
      const foreign = network.filter((line) => / (https?|wss?):\/\//.test(line) && !line.includes(` ${origin}/`) && !line.startsWith(`WS ${RELAY}/`));
      assert.deepEqual(foreign, [], "every request stayed on the shell's origin or the relay socket");
      keep("network.txt", `# every request of every page (${network.length}); shell ${origin}; PCs ${pcOrigins.join(", ")} (never reached); relay ${RELAY}\n${network.join("\n")}\n`);
      note(`storage: ${storage.length} entries, no relay secret; network: ${network.length} requests, all on ${origin} or ${RELAY}, none to ${pcOrigins.join(" or ")}`);
    }

    // ---- revoked from the PC's side ----
    {
      const removed = await fetch(`${desk.base}/api/devices/${deskDevice.device_id}`, { method: "DELETE", headers: { origin: desk.base, "x-herdr-machine": "1" } });
      assert.equal(removed.status, 204, await removed.text());
      // the session ends; the app's next sign-in, a page timer away, is refused for good
      await frames(page, "the revoked screen", async () => await state(page, "revoked").count() === 1, 60_000);
      await page.getByRole("heading", { name: "This phone was removed from Desk PC" }).waitFor();
      assert.equal(await page.locator(".app").count(), 0, "the app is gone once the PC turned the phone away");
      assert.equal(await saved(page, deskOffer.server_id), null, "the revoked phone forgot its key");
      await shot(page, "revoked");
      note(`revoked: DELETE ${desk.base}/api/devices/${deskDevice.device_id} -> revoked screen, app unmounted, key deleted`);
    }

    assertCspClean(csp, "the hosted shell, cross-origin through the relay");
    note(`csp: ${csp.length} pages watched under the shell policy, no violation`);
    if (evidence) await main.context.tracing.stop({ path: join(evidence, "task-23-trace.zip") });
    keep("report.txt", `${report.join("\n")}\n`);
  } catch (error) {
    keep("failure.txt", `${error instanceof Error ? error.stack : String(error)}\n\n${report.join("\n")}\n\n${network.join("\n")}\n`);
    if (evidence) for (const [index, context] of contexts.entries()) for (const [tab, page] of context.pages().entries()) {
      await page.screenshot({ path: join(evidence, `task-23-failure-${index}-${tab}.png`) }).catch(() => undefined);
      keep(`failure-${index}-${tab}.html`, await page.content().catch(() => ""));
    }
    throw error;
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await browser?.close();
    site.stop(true);
    for (const pc of pcs) { await pc.service.shutdown(); pc.app.stop(); }
    await relay?.stop();
    for (const id of workspaces) await workspaceClose(id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }

  // The rest of the journey, on the same server tree, each suite with its own relay, shell host and
  // browser: the shell's states on their exact deadlines, push from each PC and a subscription rotated
  // with no window open (relay-shell-browser-qa.ts), then both PCs' files and media: image, chat
  // attachment, PDF, rendered page and SVG escape attempts in worker and blob mode, a 30 MiB MP4 sought
  // to 80% with its Range at the right PC only, and a remote PC behind PC 1 (relay-media-browser-qa.ts).
  note("relay e2e: shell states, push and its rotation");
  await relayShellQa(tree);
  note("relay e2e: files, media and isolation of two PCs");
  await relayMediaQa(tree);
  console.log("PASS relay end to end");
}
