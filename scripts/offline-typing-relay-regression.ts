/**
 * Typing into a terminal while the device's network is gone is held on screen and reaches the pane only when
 * the person sends it. The hosted shell (dist-shell/) on a phone (390 px) and a PC (1440 px) reaches one PC
 * only through a Bun relay (relay/bun.ts). The network goes as a phone's does: the browser says offline
 * (Playwright's setOffline) while the relay socket stays open and holds every frame both ways, then delivers
 * them in order once the network is back, as TCP does after a short outage. What was typed meanwhile stays a
 * held draft through the recovery: at 390 px once over the same connection, where it is discarded, and once
 * over a new one after the old was dropped, where it is sent; at 1440 px over a new one, where it is sent. The pane
 * sees it only after Send. Then the link goes and comes back once more over a half-typed line (which xterm keeps
 * in its field), with nothing typed meanwhile: Korean typed after that goes to the pane at once, at 390 px as Gboard
 * types it (every key a 229 key event and a composition), at 1440 px as a desktop input method composes it. Run after `bun run build:shell`; UI_EVIDENCE_DIR=<dir> keeps the
 * screenshots and the report.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, Page, WebSocketRoute } from "playwright-core";
import { startBunRelay } from "../relay/bun.ts";
import { paneRead, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { createServer } from "../server/index.ts";
import { RelayService } from "../server/relay/service.ts";
import { decodeOffer, encodeOffer } from "../shared/relay-offer.ts";
import { chromePath } from "./chrome-path.ts";
import { servePagesSite } from "./pages-static.ts";
import { shownRow } from "./shown-rows.ts";

const repo = join(import.meta.dir, "..");
if (!existsSync(join(repo, "dist-shell/index.html"))) throw new Error("dist-shell/ is missing: run `bun run build:shell` first");
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
if (evidence) mkdirSync(evidence, { recursive: true });
const report: string[] = [];
const note = (line: string): void => { report.push(line); console.log(line); };

const RELAY = "wss://relay.test";
const T0 = new Date("2026-11-15T00:00:00Z");
const root = mkdtempSync(join(tmpdir(), "ovis-offline-typing-"));
const relay = startBunRelay({ port: 0, limits: { perAddressPerMinute: 10_000, globalPerMinute: 10_000 } });
const relayAddress = (url: string): string => { const target = new URL(url); return `ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`; };
const site = servePagesSite(join(repo, "dist-shell"), 0);
const origin = `http://127.0.0.1:${site.port}`;
const stateDir = mkdtempSync(join(root, "state-"));
const dir = mkdtempSync(join(root, "files-"));
const synced = Promise.withResolvers<void>();
const service = new RelayService({ stateDir, relay: RELAY, connect: (url) => {
  const socket = new WebSocket(relayAddress(url));
  socket.addEventListener("message", (event) => { if (typeof event.data === "string" && event.data.includes('"sync"')) synced.resolve(); });
  return socket;
} });
// This transport test pairs an unsigned browser by the Step 1 code, not a Step 2 screen confirmation.
const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, relay: service, pushLoopbackHttp: true, accountOpensAll: false });
/** Every terminal connection the PC's server opens and closes: a relay session calls these for each browser socket. */
const sockets = { opened: 0, closed: 0 };
const handlers = app.context.services.core.socketHandlers;
const { open: openSocket, close: closeSocket } = handlers;
handlers.open = (peer) => { sockets.opened += 1; return openSocket(peer); };
handlers.close = (peer, code, reason) => { sockets.closed += 1; closeSocket(peer, code, reason); };
const base = `http://127.0.0.1:${app.port}`;
const post = (path: string): Promise<Response> => fetch(`${base}/api/relay${path}`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } });
let browser: Browser | undefined;
let workspaceId: string | null = null;

/** The network between the page and the relay: while it is down every frame waits, in order, for it to come back. */
const network = { down: false, waiting: [] as (() => void)[] };
const across = (deliver: () => void): void => { if (network.down) network.waiting.push(deliver); else deliver(); };

/** The shell's wss: relay carried to the test relay through `network`; a socket opened while it is down fails. */
function carry(ws: WebSocketRoute): void {
  if (network.down) { void ws.close({ code: 1011, reason: "network down" }); return; }
  const queue: (string | Uint8Array<ArrayBuffer>)[] = [];
  const upstream = new WebSocket(relayAddress(ws.url()));
  upstream.binaryType = "arraybuffer";
  let closed = false;
  ws.onMessage((message) => across(() => {
    const data = typeof message === "string" ? message : new Uint8Array(message);
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data); else queue.push(data);
  }));
  ws.onClose(() => { closed = true; upstream.close(); });
  upstream.onopen = () => { for (const message of queue.splice(0)) upstream.send(message); };
  upstream.onmessage = (event) => across(() => { if (!closed) ws.send(event.data instanceof ArrayBuffer ? Buffer.from(event.data) : String(event.data)); });
  upstream.onclose = (event) => { if (!closed) void ws.close({ code: [1005, 1006, 1015].includes(event.code) ? 1011 : event.code, reason: event.reason || "relay connection lost" }); };
}

/** Runs the page's frozen clock a frame at a time until `check` holds, in page time only. */
async function frames(page: Page, check: () => Promise<boolean>, limitMs: number): Promise<boolean> {
  for (let ran = 0; !(await check()); ran += 16) {
    if (ran >= limitMs) return false;
    await page.clock.runFor(16);
  }
  return true;
}

/** Korean syllables as an input method builds them: the jamo steps of each, the last one committed. */
const HANGUL = [["ㅎ", "하", "한"], ["ㄱ", "그", "글"]] as const;

/**
 * One device width; `act` is what the person does with the held input once the network is back, `replaced` keeps
 * the network down until the socket is dropped, so the terminal comes back on a new one, and `ime` is how Korean is
 * typed after the recovery.
 */
async function width(px: number, pane: string, act: "Send" | "Discard", replaced: boolean, ime: "gboard" | "desktop"): Promise<string[]> {
  assert.ok(browser);
  const phone = px < 769;
  const context = await browser.newContext({ viewport: { width: px, height: phone ? 844 : 900 }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone, colorScheme: "dark", locale: "en-US" });
  const faults: string[] = [];
  let page: Page | undefined;
  try {
    await context.routeWebSocket(/^wss:\/\/relay\.test\//, carry);
    await context.addInitScript(() => { if (window === window.top) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark" })); });
    page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => console.error("page error", error.stack));
    await page.clock.install({ time: T0 });
    await page.clock.pauseAt(new Date(T0.getTime() + 1000));
    const shown = page;
    const shot = async (name: string): Promise<void> => { if (evidence) await shown.screenshot({ path: join(evidence, `offline-typing-${name}-${px}.png`), animations: "disabled" }); };

    // precondition: paired, in the app, the pane attached and answering
    const response = await post("/offer");
    const body = await response.text();
    assert.equal(response.status, 200, `offer: ${body}`);
    const offer = decodeOffer((JSON.parse(body) as { url: string }).url);
    assert.ok(offer, "the PC gave no offer");
    await page.goto(encodeOffer({ ...offer, name: "Desk PC" }, origin));
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await page.locator(".app").waitFor();
    // the pane by its address, at both widths (the shell moves the query into the fragment, lib/relay/boot.ts)
    await page.goto(`${origin}/s/${offer.server_id}/?pane=${encodeURIComponent(pane)}&view=terminal`);
    await page.locator(".app").waitFor();
    const stack = page.locator(`.terminal-stack[data-pane-owner=${JSON.stringify(pane)}]`);
    const text = (): Promise<string> => shown.evaluate((rows) => [...document.querySelectorAll(rows)].map((row) => (row.textContent ?? "").replaceAll("\u00a0", " ")).join("\n"), shownRow(`.terminal-stack[data-pane-owner="${pane}"]`));
    const waiting = stack.locator(".terminal-banner", { hasText: "Waiting for terminal input" });
    const live = async (): Promise<boolean> => await stack.locator(".terminal-banner-warning").count() === 0 && await waiting.count() === 0 && (await text()).trim() !== "";
    const line = (output: string) => async (): Promise<boolean> => new RegExp(`^${output}\\s*$`, "m").test(await text());
    // a precondition: when it fails, the screen is kept and the run ends here
    if (!(await frames(page, live, 20_000))) {
      await shot("not-attached");
      throw new Error(`${px}: the pane's terminal never attached`);
    }
    const typeHere = async (keys: string): Promise<void> => {
      await stack.locator(".xterm-helper-textarea").focus();
      await shown.keyboard.type(keys);
    };
    const id = randomBytes(3).toString("hex");
    await typeHere(`echo on-${id}`);
    await page.keyboard.press("Enter");
    assert.ok(await frames(page, line(`on-${id}`), 20_000), `${px}: typing online never reached the pane`);

    const before = { ...sockets };

    // the network goes: typed keys must stay on this device, and the screen must say they were not sent
    const marker = `held-${id}`;
    network.down = true;
    await context.setOffline(true);
    await typeHere(`echo ${marker}`);
    const held = page.locator(".terminal-banner-draft .draft-text, .composer-notice code", { hasText: marker });
    const said = await frames(page, async () => await held.count() > 0 && await waiting.count() > 0, 2_500);
    await shot("offline");
    if (!said) faults.push(`${px}: with the network gone the screen did not say "${marker}" was held and the terminal was waiting`);
    // no pong comes through the dead network: the probe drops the connection (the terminal says it is reconnecting),
    // and every new one fails until the network is back; otherwise the same connection recovers
    const reconnecting = stack.locator(".terminal-banner-warning", { hasText: "Reconnecting" });
    if (replaced && !(await frames(page, async () => await reconnecting.count() > 0, 30_000))) {
      faults.push(`${px}: the connection was never dropped while the network was gone`);
    }

    // the network back: the frames a live socket held arrive in order (a dropped one's close among them), then the
    // connection answers. The PC's server counts the connections: the old one closed and a new one opened, or neither
    await context.setOffline(false);
    network.down = false;
    for (const deliver of network.waiting.splice(0)) deliver();
    const replacedOnServer = (): boolean => sockets.closed > before.closed && sockets.opened > before.opened;
    const back = async (): Promise<boolean> => (!replaced || replacedOnServer()) && await live();
    if (!(await frames(page, back, 20_000))) faults.push(`${px}: the terminal never took input again after the network came back`);
    const counted = `${sockets.closed - before.closed} closed, ${sockets.opened - before.opened} opened`;
    if (replaced ? !replacedOnServer() : sockets.closed !== before.closed || sockets.opened !== before.opened) {
      faults.push(`${px}: the PC's server saw ${counted}, where ${replaced ? "the old connection was to be replaced" : "the same one was to recover"}`);
    }
    if (await held.count() === 0) faults.push(`${px}: the held "${marker}" was not on screen after the reconnect`);
    await shot("back");
    if ((await paneRead({ paneId: pane })).text.includes(marker)) faults.push(`${px}: "${marker}" reached the pane before anyone sent it`);

    // the person acts on the held input; an Enter after it runs whatever the pane's prompt then holds, so a copy
    // delivered by itself shows up in the output ("held-…echo …") and the exact line below never appears
    const button = page.getByRole("button", { name: `${act} held input` }).filter({ visible: true });
    if (await button.count() === 0) faults.push(`${px}: no ${act} button for the held input`);
    else {
      await button.first().click();
      if (!(await frames(page, async () => await held.count() === 0, 2_500))) faults.push(`${px}: the held input stayed on screen after ${act}`);
    }
    if (act === "Send") {
      await stack.locator(".xterm-helper-textarea").focus();
      await page.keyboard.press("Enter");
      if (!(await frames(page, line(marker), 20_000))) faults.push(`${px}: the held "echo ${marker}" did not run once after Send`);
    } else {
      await typeHere(`echo after-${id}`);
      await page.keyboard.press("Enter");
      if (!(await frames(page, line(`after-${id}`), 20_000))) faults.push(`${px}: the command typed after Discard did not run on its own`);
      if ((await paneRead({ paneId: pane })).text.includes(marker)) faults.push(`${px}: the discarded "${marker}" reached the pane`);
    }

    // Korean typed after a recovery, on a line half-typed before the link went: xterm keeps that line in its field,
    // and nothing is typed while the link is down, so the Korean goes to the pane at once
    const paneShows = (pattern: RegExp) => async (): Promise<boolean> => pattern.test((await paneRead({ paneId: pane })).text);
    await typeHere("echo ");
    if (!(await frames(page, paneShows(/echo\s*$/m), 20_000))) faults.push(`${px}: the half-typed "echo " never reached the pane`);
    const again = { ...sockets };
    network.down = true;
    await context.setOffline(true);
    if (replaced) {
      if (!(await frames(page, async () => await reconnecting.count() > 0, 30_000))) faults.push(`${px}: the connection was never dropped the second time`);
    } else await shown.clock.runFor(500);
    await context.setOffline(false);
    network.down = false;
    for (const deliver of network.waiting.splice(0)) deliver();
    const backAgain = async (): Promise<boolean> => (!replaced || (sockets.closed > again.closed && sockets.opened > again.opened)) && await live();
    if (!(await frames(page, backAgain, 20_000))) faults.push(`${px}: the terminal never took input again after the second outage`);
    const cdp = await context.newCDPSession(shown);
    const key229 = async (type: "rawKeyDown" | "keyUp"): Promise<void> => {
      if (ime === "gboard") await cdp.send("Input.dispatchKeyEvent", { type, key: "Unidentified", code: "", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
    };
    const insert = async (text: string): Promise<void> => {
      await key229("rawKeyDown");
      await cdp.send("Input.insertText", { text });
      await key229("keyUp");
      await shown.clock.runFor(16);
    };
    for (const steps of HANGUL) {
      for (const step of steps) {
        await key229("rawKeyDown");
        await cdp.send("Input.imeSetComposition", { text: step, selectionStart: step.length, selectionEnd: step.length });
        await key229("keyUp");
      }
      await insert(steps[steps.length - 1]!);
    }
    for (const char of `-${id}`) await insert(char);
    await shown.keyboard.press("Enter");
    if (!(await frames(page, paneShows(new RegExp(`^한글-${id}\\s*$`, "m")), 20_000))) {
      faults.push(`${px}: Korean typed after the recovery (${ime}) on a half-typed line did not run at once`);
    }

    // a composition begun with the link up and let out after an outage counts as typed when it began: it is held (#4249)
    const late = `late-${id}`;
    // on an empty line: nothing of it reaches the pane, so the next run's line starts clean
    await key229("rawKeyDown");
    await cdp.send("Input.imeSetComposition", { text: "한", selectionStart: 1, selectionEnd: 1 });
    await key229("keyUp");
    const third = { ...sockets };
    network.down = true;
    await context.setOffline(true);
    if (replaced) {
      if (!(await frames(page, async () => await reconnecting.count() > 0, 30_000))) faults.push(`${px}: the connection was never dropped the third time`);
    } else await shown.clock.runFor(500);
    await context.setOffline(false);
    network.down = false;
    for (const deliver of network.waiting.splice(0)) deliver();
    const backThird = async (): Promise<boolean> => (!replaced || (sockets.closed > third.closed && sockets.opened > third.opened)) && await live();
    if (!(await frames(page, backThird, 20_000))) faults.push(`${px}: the terminal never took input again after the third outage`);
    await insert("한");
    for (const char of late) await insert(char);
    await shown.keyboard.press("Enter");
    const lateHeld = page.locator(".terminal-banner-draft .draft-text, .composer-notice code", { hasText: `한${late}` });
    if (!(await frames(page, async () => await lateHeld.count() > 0, 20_000))) faults.push(`${px}: a composition begun before the outage and let out after it was not held`);
    if ((await paneRead({ paneId: pane })).text.includes(late)) faults.push(`${px}: a composition begun before the outage and let out after it reached the pane`);
    await cdp.detach();
    await shot("after");
    note(`${px}: online "on-${id}" reached the pane; offline "${marker}" ${said ? "held on screen" : "NOT held"}; back on ${replaced ? "a new" : "the same"} connection; ${act} and Korean (${ime}) ${faults.length === 0 ? "did what they say" : `FAILED: ${faults.join("; ")}`}`);
  } catch (error) {
    if (evidence) await page?.screenshot({ path: join(evidence, `offline-typing-failure-${px}.png`) }).catch(() => undefined);
    throw error;
  } finally {
    network.down = false;
    network.waiting.length = 0;
    await context.close();
  }
  return faults;
}

try {
  const started = await post("/start");
  assert.equal(started.status, 200, `relay start: ${await started.text()}`);
  await synced.promise;
  const created = await workspaceCreate({ cwd: dir, label: "offline-typing" });
  workspaceId = created.workspace.workspace_id;
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const faults = [
    ...await width(390, created.root_pane.pane_id, "Discard", false, "gboard"),
    ...await width(390, created.root_pane.pane_id, "Send", true, "gboard"),
    ...await width(1440, created.root_pane.pane_id, "Send", true, "desktop"),
  ];
  if (evidence) writeFileSync(join(evidence, "offline-typing-report.txt"), `${[...report, ...faults].join("\n")}\n`);
  assert.deepEqual(faults, [], "nothing typed while the network was gone is sent until the person sends it");
  console.log("PASS keys typed while offline are held through a recovery on the same socket and on a new one, and reach the pane only on Send; Korean typed after the recovery goes at once");
} finally {
  await browser?.close();
  site.stop(true);
  await service.shutdown();
  app.stop();
  await relay.stop();
  if (workspaceId !== null) await workspaceClose(workspaceId).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
