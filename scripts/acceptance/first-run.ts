/**
 * A person's first run of Ovis through the relay, as one acceptance run of about fifteen steps: two PCs added to an
 * account with `ovis add`, a phone (390) and a desktop browser (1440) of that account pairing through the relay,
 * opening the PCs, typing, the relay lost and back, and a PC forgotten on a device. Each step gets one verdict
 * (scripts/acceptance/verdict.ts) and the run prints the table.
 *
 * Everything runs on this machine: the PCs are `createServer` on mkdtemp state folders and the isolated herdr test
 * session, `ovis add` is scripts/plugin-link.ts's own `link` against them, the relay is relay/bun.ts on a free port, the
 * account service is the in-memory fake (shared/account-service-fake.ts), and the hosted app is dist-shell/ served as
 * Pages serves it. The browsers reach the app, the account service and the relay at their real names through routes of
 * their own; any other request is refused and fails the last step. Nothing waits a fixed time: every wait is for a
 * state, bounded.
 *
 *   bun run build:shell && bun scripts/acceptance/first-run.ts
 *
 * ACCEPTANCE_DIR=<dir> keeps the table (first-run.md, first-run.json) and a screenshot of each screen there.
 * Not part of CI: it is run on demand, against a checkout or a release's tree.
 */
import "../test-herdr.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { startBunRelay, type BunRelay } from "../../relay/bun.ts";
import { paneRead, workspaceClose, workspaceCreate } from "../../server/herdr/client.ts";
import { createServer } from "../../server/index.ts";
import { RelayService } from "../../server/relay/service.ts";
import { UsageService } from "../../server/usage.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { decodeOffer, encodeOffer, type RelayOffer } from "../../shared/relay-offer.ts";
import { DEFAULT_ACCOUNT_SERVICE } from "../../shared/web-policy.ts";
import { chromePath } from "../chrome-path.ts";
import { servePagesSite } from "../pages-static.ts";
import { link } from "../plugin-link.ts";
import { relayBrowserSocket } from "../relay-browser-bridge.ts";
import { shownRow } from "../shown-rows.ts";
import { exitCode, runSteps, table, type Step } from "./verdict.ts";

const APP = "https://app.ovis.sh";
const RELAY = "wss://relay.test";
const ACCOUNT = "acct_first_run";
const repo = join(import.meta.dir, "../..");
const evidence = process.env["ACCEPTANCE_DIR"] || null;
if (evidence) mkdirSync(evidence, { recursive: true });

async function bounded<T>(promise: Promise<T>, what: string, ms = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms); })]);
  } finally { clearTimeout(timer); }
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const root = mkdtempSync(join(tmpdir(), "ovis-first-run-"));
const cleanup: (() => unknown)[] = [() => rmSync(root, { recursive: true, force: true })];
const fake = new FakeAccountService();
const token = fake.issueToken(ACCOUNT);
const relayOptions = { port: 0, limiters: { perAddress: { async limit() { return { success: true }; } }, global: { async limit() { return { success: true }; } } } };
let relay: BunRelay | null = startBunRelay(relayOptions);
let relayPort = relay.port;
cleanup.push(() => relay?.stop());
const relayAddress = (url: string): string => { const target = new URL(url); return `ws://127.0.0.1:${relayPort}${target.pathname}${target.search}`; };

async function startPc(label: string) {
  const stateDir = mkdtempSync(join(root, `${label}-state-`));
  const dir = mkdtempSync(join(root, `${label}-files-`));
  let synced = Promise.withResolvers<void>();
  const service = new RelayService({ stateDir, relay: RELAY, connect: (url) => {
    const socket = new WebSocket(relayAddress(url));
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try { if ((JSON.parse(event.data) as { type?: unknown }).type === "sync") synced.resolve(); } catch { /* not a control frame */ }
    });
    return socket;
  } });
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, relay: service,
    accountService: { url: DEFAULT_ACCOUNT_SERVICE, fetch: fake.fetch }, usage: new UsageService(undefined, []),
    tailnetPcs: { readStatus: async () => null }, sshCandidates: { sshDir: join(stateDir, "no-ssh"), readStatus: async () => null } });
  cleanup.push(async () => { await service.shutdown(); app.stop(); });
  const base = `http://127.0.0.1:${app.port}`;
  const workspace = await workspaceCreate({ cwd: dir, label: `first-run-${label}` });
  cleanup.push(() => workspaceClose(workspace.workspace.workspace_id).catch(() => undefined));
  return {
    label, base, dir, devices: app.context.services.devices,
    workspace: workspace.workspace.workspace_id, pane: workspace.root_pane.pane_id,
    offer: null as RelayOffer | null,
    async start(): Promise<void> {
      synced = Promise.withResolvers<void>();
      const response = await fetch(`${base}/api/relay/start`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } });
      assert.equal(response.status, 200, `${label}: the relay turns on: ${await response.text()}`);
      await bounded(synced.promise, `${label} reached the relay`);
    },
    resynced(): Promise<void> { synced = Promise.withResolvers<void>(); return synced.promise; },
  };
}
type Pc = Awaited<ReturnType<typeof startPc>>;

/** `ovis add` on `pc`, as a person runs it in a terminal; the account approves its sign-in code as soon as it is shown. */
function ovisAdd(pc: Pc) {
  const out: string[] = [];
  const stop = new AbortController();
  const signedIn = Promise.withResolvers<string>();
  const drawn = Promise.withResolvers<string>();
  let offerUrl: string | null = null;
  let scanShown = false;
  const whenBoth = (): void => { if (scanShown && offerUrl !== null) drawn.resolve(offerUrl); };
  const run = link([], {
    origin: pc.base, headers: {}, accountService: DEFAULT_ACCOUNT_SERVICE, serviceFetch: fake.fetch, signal: stop.signal,
    lines: { next: () => new Promise(() => {}) }, terminal: true, isTty: true,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const response = await fetch(request);
      if (new URL(request.url).pathname === "/api/relay/offer" && response.ok) { offerUrl = (await response.clone().json() as { url: string }).url; whenBoth(); }
      return response;
    },
    out: (text) => {
      out.push(text);
      const code = /code:? ([A-Z0-9-]{4,16})\b/.exec(text)?.[1];
      if (code !== undefined && out.filter((line) => /code:? [A-Z0-9-]{4,16}\b/.test(line)).length === 1) { fake.approveDevice(code, ACCOUNT); signedIn.resolve(code); }
      if (text.includes("Scan this QR code")) { scanShown = true; whenBoth(); }
    },
  });
  cleanup.push(async () => { stop.abort(); await run.catch(() => 1); });
  const ended = run.then((code) => { throw new Error(`ovis add ended (exit ${code}) first: ${out.join("").slice(-600)}`); });
  ended.catch(() => undefined);
  return {
    run, text: () => out.join(""),
    signedIn: () => Promise.race([signedIn.promise, ended]),
    qr: () => Promise.race([drawn.promise, ended]),
  };
}
type Adding = ReturnType<typeof ovisAdd>;

const requests: string[] = [];
const refused: string[] = [];
let browser: Browser | null = null;
const site = servePagesSite(join(repo, "dist-shell"), 0, "127.0.0.1");
cleanup.push(() => site.stop(true));
const shellOrigin = `http://127.0.0.1:${site.port}`;

/** A browser of the account at `width`: the app, the account service and the relay reached at their names, nothing else. */
async function device(width: 390 | 1440) {
  assert.ok(browser);
  const mobile = width < 600;
  const context = await browser.newContext({ viewport: mobile ? { width, height: 844 } : { width, height: 900 }, deviceScaleFactor: mobile ? 3 : 1,
    isMobile: mobile, hasTouch: mobile, serviceWorkers: "block", locale: "en-US", colorScheme: "light" });
  cleanup.push(() => context.close().catch(() => undefined));
  await context.addInitScript(() => { if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })); });
  // registered first, so it answers only what the routes below do not
  await context.route(() => true, (route) => { refused.push(`${width} ${route.request().method()} ${route.request().url()}`); return route.abort(); });
  await context.route(/^https:\/\/account\.ovis\.sh\//, async (route) => {
    const request = route.request();
    const cors = { "access-control-allow-origin": APP, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const body = request.postDataBuffer();
    const answer = await fake.fetch(new Request(request.url(), { method: request.method(), headers: request.headers(), ...(body === null ? {} : { body: new Uint8Array(body) }) }));
    return route.fulfill({ status: answer.status, headers: { ...Object.fromEntries(answer.headers), ...cors }, body: Buffer.from(await answer.arrayBuffer()) });
  });
  await context.route(/^https:\/\/app\.ovis\.sh\//, async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: `${shellOrigin}${url.pathname}${url.search}` }) });
  });
  await context.routeWebSocket(() => true, (ws) => { refused.push(`${width} WS ${ws.url()}`); return ws.close(); });
  await context.routeWebSocket(/^wss:\/\/relay\.test\//, (ws) => relayBrowserSocket(ws, () => relayAddress(ws.url())));
  context.on("request", (request) => requests.push(`${width} ${request.method()} ${request.url()}`));
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
  await signIn(page);
  return { width, context, page };
}
type Device = Awaited<ReturnType<typeof device>>;

/** The account's sign-in as a finished sign-in keeps it in the app's account store. */
async function signIn(page: Page): Promise<void> {
  await page.evaluate(({ service, account, accessToken }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("ovis-account", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("account"); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const tx = request.result.transaction("account", "readwrite");
      tx.objectStore("account").put({ service, account, provider: "github", access_token: accessToken, refresh_token: "fixture-refresh", expires_at: Date.now() + 3_600_000 }, "session");
      tx.oncomplete = () => { request.result.close(); resolve(); };
      tx.onabort = () => reject(tx.error);
    };
  }), { service: DEFAULT_ACCOUNT_SERVICE, account: ACCOUNT, accessToken: token });
}

async function shot(page: Page, name: string): Promise<void> {
  if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`), animations: "disabled" });
}

const inApp = async (page: Page): Promise<void> => {
  await page.locator(".app").waitFor();
  assert.equal(await page.locator("main[data-relay-state]").count(), 0, "the relay screen is gone once the app is up");
};

async function pair(device: Device, pc: Pc, url: string): Promise<string> {
  const offer = decodeOffer(url);
  assert.ok(offer, `${pc.label}: the QR code holds an offer`);
  pc.offer = offer;
  const { page } = device;
  await page.goto(encodeOffer(offer, APP), { waitUntil: "domcontentloaded" });
  const question = page.getByRole("heading", { name: new RegExp(`^(Pair with ${escaped(offer.name ?? "")}|Add ${escaped(offer.name ?? "")} to your account)\\?$`) });
  await question.waitFor();
  const asked = await question.innerText();
  await shot(page, `pair-question-${device.width}`);
  await page.getByRole("button", { name: /^(Pair|Add and pair)$/ }).click();
  await inApp(page);
  assert.ok(pc.devices.list(null).some((one) => one.via_relay), `${pc.label} lists a device paired through the relay`);
  await shot(page, `paired-${device.width}`);
  return asked;
}

async function added(adding: Adding, pc: Pc): Promise<string> {
  const code = await bounded(adding.run, `ovis add on ${pc.label} ended`, 60_000);
  assert.equal(code, 0, `ovis add on ${pc.label} exits 0: ${adding.text().slice(-600)}`);
  assert.match(adding.text(), /This PC is in your account/, `ovis add on ${pc.label} says the PC is in the account`);
  return "ovis add said \"This PC is in your account\" and exited 0";
}

const terminalText = (page: Page, pane: string): Promise<string> => page.evaluate((rows) => [...document.querySelectorAll(rows)].map((row) => (row.textContent ?? "").replaceAll("\u00a0", " ")).join("\n"), shownRow(`.terminal-stack[data-pane-owner="${pane}"]`));

/** Opens `workspace` from the sidebar (a phone's drawer first) and waits for its terminal to draw. */
async function openWorkspace(device: Device, workspace: string, pane: string): Promise<void> {
  const { page } = device;
  if (device.width < 600) await page.locator("#drawer-toggle").click();
  await page.locator(`.workspace-group[data-workspace="${workspace}"] > .workspace-header .workspace-select`).click();
  const stack = page.locator(`.terminal-stack[data-pane-owner="${pane}"]`);
  await stack.locator(".xterm-screen").waitFor({ state: "visible" });
  await page.waitForFunction(({ rows, owner }) => {
    const banner = document.querySelector(`.terminal-stack[data-pane-owner="${owner}"] .terminal-banner-warning`);
    return banner === null && [...document.querySelectorAll(rows)].some((row) => (row.textContent ?? "").trim() !== "");
  }, { rows: shownRow(`.terminal-stack[data-pane-owner="${pane}"]`), owner: pane });
}

async function typeInto(device: Device, pane: string, what: string): Promise<string> {
  const { page } = device;
  const marker = `${what}-${randomBytes(3).toString("hex")}`;
  // the phone's key bar enables its keyboard key once the terminal takes input again: typing earlier is held as a draft
  if (device.width < 600) await page.locator('.key-bar .key[data-key="keyboard"]:not([disabled])').first().waitFor();
  await page.locator(`.terminal-stack[data-pane-owner="${pane}"] .xterm-helper-textarea`).focus();
  await page.keyboard.type(`echo ${marker}`);
  await page.keyboard.press("Enter");
  const printed = new RegExp(`^${marker}\\s*$`, "m");
  await page.waitForFunction(({ rows, marker }) => [...document.querySelectorAll(rows)].some((row) => (row.textContent ?? "").replaceAll("\u00a0", " ").trim() === marker),
    { rows: shownRow(`.terminal-stack[data-pane-owner="${pane}"]`), marker });
  assert.match((await paneRead({ paneId: pane })).text, printed, "herdr's pane printed it");
  return marker;
}

async function listedPcs(device: Device): Promise<string[]> {
  const { page } = device;
  await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-pc-list] [data-pc-id]").first().waitFor();
  return page.locator("[data-pc-list] [data-pc-id]").evaluateAll((rows) => [...new Set(rows.map((row) => row.getAttribute("data-pc-id") ?? ""))]);
}

async function openFromList(device: Device, pc: Pc, page = device.page): Promise<void> {
  if (page.url() !== `${APP}/`) await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
  await page.locator(`[data-pc-list] [data-pc-id="${pc.offer?.server_id}"] [data-pc-action="open"]`).first().click();
  await inApp(page);
}

const savedKey = (page: Page, serverId: string): Promise<boolean> => page.evaluate(async (serverId) => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("ovis-relay", 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const request = db.transaction("devices", "readonly").objectStore("devices").get(serverId);
      request.onsuccess = () => resolve(request.result !== undefined);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}, serverId);

/**
 * Stops the relay for as long as `away` runs, then starts it again on a new port and waits for every PC to reach it by
 * itself; `away` gets the moment the relay is back (`back`), and the relay comes back also when `away` throws.
 */
async function withoutRelay(pcs: readonly Pc[], away: (back: () => Promise<void>) => Promise<void>): Promise<void> {
  await relay?.stop();
  relay = null;
  const synced = pcs.map((pc) => pc.resynced());
  const back = async (): Promise<void> => {
    if (relay !== null) return;
    relay = startBunRelay(relayOptions);
    relayPort = relay.port;
    await Promise.all(synced.map((one, index) => bounded(one, `${pcs[index]!.label} reached the restarted relay by itself`, 60_000)));
  };
  try { await away(back); } finally { await back(); }
}

const paneBanner = (page: Page, pane: string, kind: "warning" | "draft") => page.locator(`.terminal-stack[data-pane-owner="${pane}"] .terminal-banner-${kind}`);

interface World { desk: Pc; laptop: Pc; deskAdd: Adding | null; laptopAdd: Adding | null; phone: Device | null; desktop: Device | null }

const steps: Step<World>[] = [
  { id: "relay.pcs-online", title: "Two PCs turn their relay on and reach it", run: async (w) => {
    await w.desk.start();
    await w.laptop.start();
    return `${w.desk.base} and ${w.laptop.base} synced with the relay`;
  } },
  { id: "add.sign-in", title: "`ovis add` on the first PC shows a sign-in code, and goes on once the account approves it", needs: ["relay.pcs-online"], run: async (w) => {
    w.deskAdd = ovisAdd(w.desk);
    const code = await bounded(w.deskAdd.signedIn(), "a sign-in code");
    return `sign-in code ${code} shown and approved`;
  } },
  { id: "add.qr-code", title: "`ovis add` draws the QR code, and the account lists the PC", needs: ["add.sign-in"], run: async (w) => {
    const url = await bounded(w.deskAdd!.qr(), "the QR code", 60_000);
    const offer = decodeOffer(url);
    assert.ok(offer, "the QR code holds an offer");
    assert.ok(fake.pcs(ACCOUNT).some((pc) => pc.server_id === offer.server_id), "the account lists the PC before its QR code is drawn");
    w.desk.offer = offer;
    return `QR code drawn for ${offer.server_id}; the account lists it`;
  } },
  { id: "phone.pairs", title: "The phone (390), signed in, opens the QR code's link, is asked about the PC and pairs through the relay", needs: ["add.qr-code"], run: async (w) => {
    w.phone = await device(390);
    const asked = await pair(w.phone, w.desk, encodeOffer(w.desk.offer!, APP));
    return `asked "${asked}"; paired; the PC lists the phone as a relay device`;
  } },
  { id: "add.ends", title: "`ovis add` says the PC is in the account and ends", needs: ["phone.pairs"], run: async (w) => added(w.deskAdd!, w.desk) },
  { id: "phone.terminal", title: "The phone opens the PC's workspace and types a command; herdr's pane prints it", needs: ["phone.pairs"], run: async (w) => {
    await openWorkspace(w.phone!, w.desk.workspace, w.desk.pane);
    const marker = await typeInto(w.phone!, w.desk.pane, "first-run");
    await shot(w.phone!.page, "terminal-390");
    return `"echo ${marker}" printed in the phone's terminal and in herdr's pane`;
  } },
  { id: "phone.new-workspace", title: "A workspace made on the PC appears on the phone", needs: ["phone.terminal"], run: async (w) => {
    const made = await workspaceCreate({ cwd: w.desk.dir, label: "first-run-later" });
    cleanup.push(() => workspaceClose(made.workspace.workspace_id).catch(() => undefined));
    await w.phone!.page.locator(`.workspace-group[data-workspace="${made.workspace.workspace_id}"]`).waitFor({ state: "attached" });
    return `workspace ${made.workspace.workspace_id} listed on the phone`;
  } },
  { id: "phone.relay-lost", title: "The relay goes away and comes back: the phone says it is reconnecting, then carries on by itself", needs: ["phone.terminal"], run: async (w) => {
    const { page } = w.phone!;
    if (await page.locator("#workspace-drawer, .scrim.is-open").count() > 0) await page.keyboard.press("Escape");
    await withoutRelay([w.desk, w.laptop], async (back) => {
      await paneBanner(page, w.desk.pane, "warning").filter({ hasText: "Reconnecting to Ovis" }).waitFor({ timeout: 30_000 });
      await shot(page, "relay-lost-390");
      await back();
    });
    await paneBanner(page, w.desk.pane, "warning").waitFor({ state: "detached", timeout: 60_000 });
    const marker = await typeInto(w.phone!, w.desk.pane, "after-relay");
    return `"Reconnecting to Ovis" shown; both PCs and the phone came back; "echo ${marker}" reached herdr after it`;
  } },
  { id: "phone.typing-held", title: "Text typed in the open terminal while the relay is away waits as a draft after it comes back", needs: ["phone.relay-lost"], run: async (w) => {
    const { page } = w.phone!;
    const marker = `held-${randomBytes(3).toString("hex")}`;
    await withoutRelay([w.desk, w.laptop], async (back) => {
      await paneBanner(page, w.desk.pane, "warning").filter({ hasText: "Reconnecting to Ovis" }).waitFor({ timeout: 30_000 });
      await page.locator(`.terminal-stack[data-pane-owner="${w.desk.pane}"] .xterm-helper-textarea`).focus();
      await page.keyboard.type(marker);
      await paneBanner(page, w.desk.pane, "warning").locator(".draft-held", { hasText: marker }).waitFor({ timeout: 30_000 });
      await back();
    });
    await paneBanner(page, w.desk.pane, "draft").locator(".draft-text", { hasText: marker }).waitFor({ timeout: 60_000 });
    assert.ok(!(await paneRead({ paneId: w.desk.pane })).text.includes(marker), "the held text never reached herdr's pane");
    assert.ok(!(await terminalText(page, w.desk.pane)).includes(marker), "the held text is not on the terminal");
    await shot(page, "typing-held-390");
    await page.getByRole("button", { name: "Discard held input" }).click();
    await paneBanner(page, w.desk.pane, "draft").waitFor({ state: "detached" });
    return `"${marker}" waited in the draft through the reconnect, never reached the pane, and was discarded`;
  } },
  { id: "desktop.adds-second-pc", title: "The desktop browser (1440), signed in, pairs the second PC from its `ovis add` QR code", needs: ["relay.pcs-online"], timeoutMs: 240_000, run: async (w) => {
    w.laptopAdd = ovisAdd(w.laptop);
    await bounded(w.laptopAdd.signedIn(), "a sign-in code");
    const url = await bounded(w.laptopAdd.qr(), "the QR code", 60_000);
    w.desktop = await device(1440);
    const asked = await pair(w.desktop, w.laptop, url);
    return `asked "${asked}"; paired; ${await added(w.laptopAdd, w.laptop)}`;
  } },
  { id: "list.both-pcs", title: "Each device's list of the account's PCs shows both PCs", needs: ["phone.pairs", "desktop.adds-second-pc"], run: async (w) => {
    const ids = [w.desk.offer!.server_id, w.laptop.offer!.server_id];
    for (const one of [w.phone!, w.desktop!]) {
      const listed = await listedPcs(one);
      assert.deepEqual(ids.filter((id) => !listed.includes(id)), [], `${one.width}: both PCs listed (${listed.join(", ")})`);
      await shot(one.page, `list-${one.width}`);
    }
    return `390 and 1440 list ${ids.join(" and ")}`;
  } },
  { id: "desktop.opens-from-list", title: "The desktop opens the second PC from the list in a new tab and types into it; herdr's pane prints it", needs: ["list.both-pcs"], run: async (w) => {
    const tab = await w.desktop!.context.newPage();
    tab.setDefaultTimeout(30_000);
    await tab.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
    await openFromList(w.desktop!, w.laptop, tab);
    const opened = { ...w.desktop!, page: tab };
    await openWorkspace(opened, w.laptop.workspace, w.laptop.pane);
    const marker = await typeInto(opened, w.laptop.pane, "desktop");
    await shot(tab, "opened-from-list-1440");
    await tab.close();
    return `opened from the list; "echo ${marker}" reached herdr`;
  } },
  { id: "phone.opens-from-list", title: "The phone opens the first PC again from its list", needs: ["list.both-pcs"], run: async (w) => {
    await openFromList(w.phone!, w.desk);
    await openWorkspace(w.phone!, w.desk.workspace, w.desk.pane);
    await shot(w.phone!.page, "opened-from-list-390");
    return "opened from the list; its terminal drew";
  } },
  { id: "desktop.forgets-pc", title: "The desktop forgets the second PC: its key is deleted there and the list no longer opens it", needs: ["desktop.opens-from-list"], run: async (w) => {
    const { page } = w.desktop!;
    const id = w.laptop.offer!.server_id;
    await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
    await page.locator(`[data-pc-list] [data-pc-id="${id}"]`).first().click();
    const details = page.locator(`[data-pc-details="${id}"]`);
    await details.getByRole("button", { name: "Forget this PC" }).click();
    await page.getByRole("button", { name: "Forget", exact: true }).click();
    await page.waitForFunction((id) => document.querySelector(`[data-pc-list] [data-pc-id="${id}"] [data-pc-action="open"]`) === null, id);
    assert.equal(await savedKey(page, id), false, "the desktop's key for the PC is gone");
    await shot(page, "forgot-1440");
    return "Forget this PC deleted the key; the row offers no Open";
  } },
  { id: "network.stays-in", title: "Every request of both devices went to the app, the account service or the relay; none reached a PC directly", run: async (w) => {
    const pcs = [w.desk.base, w.laptop.base];
    assert.deepEqual(refused, [], "no request left for another address");
    assert.deepEqual(requests.filter((line) => pcs.some((base) => line.includes(` ${base}`))), [], "no request reached a PC directly");
    return `${requests.length} requests and every WebSocket, all to ${APP}, ${DEFAULT_ACCOUNT_SERVICE} (the in-memory fake) or ${RELAY}`;
  } },
];

let code = 1;
try {
  if (!existsSync(join(repo, "dist-shell/index.html"))) throw new Error("dist-shell/ is missing: run `bun run build:shell` first");
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  cleanup.push(() => browser?.close());
  const world: World = { desk: await startPc("desk"), laptop: await startPc("laptop"), deskAdd: null, laptopAdd: null, phone: null, desktop: null };
  const results = await runSteps(steps, world, async (result) => {
    console.log(`${result.verdict.padEnd(13)} ${result.id}: ${result.detail}`);
    if (result.verdict !== "FAIL") return;
    for (const one of [world.phone, world.desktop]) if (one !== null) await shot(one.page, `failed-${result.id}-${one.width}`).catch(() => undefined);
  });
  const heading = `First run acceptance, ${new Date().toISOString()}`;
  const report = table(heading, results);
  console.log(`\n${report}`);
  if (evidence) {
    writeFileSync(join(evidence, "first-run.md"), report);
    writeFileSync(join(evidence, "first-run.json"), `${JSON.stringify({ heading, results }, null, 2)}\n`);
  }
  code = exitCode(results);
} catch (error) {
  console.error("first run acceptance could not run:", error);
} finally {
  for (const close of cleanup.reverse()) {
    try { await close(); } catch { /* the run's own verdicts stand */ }
  }
}
process.exit(code);
