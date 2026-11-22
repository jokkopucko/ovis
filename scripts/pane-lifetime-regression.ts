/**
 * herdr gives pane IDs out again once it is replaced (#1608): what was typed for a pane of the
 * previous herdr must not show in the pane that now has its ID.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type WebSocket as BrowserSocket } from "playwright-core";
import type { ServerMessage } from "../shared/protocol.ts";
import { chromePath } from "./chrome-path.ts";
import { SOCKET_PATH_MAX } from "./check.ts";

// This script stops its herdr, so it must not share even the browser lane's test session.
const root = mkdtempSync(join(tmpdir(), "pane-lifetime-"));
const session = "ovis-test-lifetime";
const config = join(root, "config");
const state = join(root, "state");
mkdirSync(config);
mkdirSync(state);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(HERDR|OMO|SENPI|PI)_/.test(name))),
  XDG_CONFIG_HOME: config, XDG_STATE_HOME: state, SHELL: "/bin/bash",
};
const binary = process.env.OVIS_HERDR_BIN || "herdr";
const socketPath = join(config, "herdr", "sessions", session, "herdr.sock");
const socketBytes = Buffer.byteLength(socketPath);
if (socketBytes > SOCKET_PATH_MAX) {
  rmSync(root, { recursive: true, force: true });
  throw new Error(`${socketPath} is too long for a unix socket (${socketBytes} > ${SOCKET_PATH_MAX} bytes); set TMPDIR to a shorter path`);
}
process.env.HERDR_SOCKET = socketPath;
const { createServer } = await import("../server/index.ts");
const { herdrRpc, paneRead, workspaceCreate } = await import("../server/herdr/client.ts");
let daemon: ReturnType<typeof Bun.spawn> | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Browser | undefined;

async function startHerdr(): Promise<void> {
  const child = Bun.spawn([binary, "--session", session, "server"], { env, stdout: "ignore", stderr: "pipe" });
  daemon = child;
  const reader = child.stderr.getReader();
  const timer = setTimeout(() => child.kill(), 15_000);
  let output = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`herdr exited before readiness: ${output}`);
      output += new TextDecoder().decode(value);
      if (output.includes("api socket:")) break;
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

async function stopHerdr(): Promise<void> {
  const child = Bun.spawn([binary, "--session", session, "server", "stop"], { env, stdout: "inherit", stderr: "inherit" });
  assert.equal(await child.exited, 0);
  await daemon?.exited;
  daemon = undefined;
}

const reportAgent = (pane: string): Promise<unknown> => herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "idle" }, socketPath);

function frame(socket: BrowserSocket, label: string, accepts: (message: ServerMessage) => boolean): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("framereceived", received);
      reject(new Error(`Timed out: ${label}`));
    }, 20_000);
    const received = ({ payload }: { payload: string | Buffer }): void => {
      const message: ServerMessage = JSON.parse(String(payload));
      if (!accepts(message)) return;
      clearTimeout(timer);
      socket.off("framereceived", received);
      resolve(message);
    };
    socket.on("framereceived", received);
  });
}

const stored = (page: Page): Promise<Record<string, string>> => page.evaluate(() => Object.fromEntries(
  Object.keys(localStorage).filter((key) => /^ovis:(composer-draft|terminal-line|terminal-draft|view|pane-lifetime|unsent):/.test(key))
    .map((key) => [key, localStorage.getItem(key) ?? ""]),
));
const lens = (page: Page): Promise<string | null> => page.evaluate(() => document.querySelector(".view-switch button[aria-pressed='true']")?.getAttribute("title") ?? null);
const chatButton = (page: Page) => page.locator(".view-switch button[title^='Chat transcript']");
const box = (page: Page) => page.locator(".composer-text");

async function select(page: Page, pane: string): Promise<void> {
  await page.locator(`.pane-select[title^="${pane} —"]`).click();
  await page.locator(`.agent-item[data-pane="${pane}"].is-selected`).waitFor();
}

async function openPaneMenu(page: Page): Promise<void> {
  await page.locator(".tab-strip").hover();
  await page.locator(".tab-strip-item.is-active .tab-strip-menu").click();
}

async function openRecovery(page: Page) {
  await openPaneMenu(page);
  await page.getByRole("menuitem", { name: "Recover unsent text" }).click();
  const dialog = page.getByRole("dialog", { name: /^Unsent text/ });
  await dialog.waitFor();
  return dialog;
}

function nextSnapshot(page: Page, watch: (socket: BrowserSocket) => void): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    page.once("websocket", (socket) => {
      watch(socket);
      frame(socket, "snapshot after a reconnect", (message) => message.type === "snapshot").then(resolve, reject);
    });
  });
}

async function newPage(context: BrowserContext, url: string, errors: string[]): Promise<{ page: Page; socket: BrowserSocket }> {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const opened = page.waitForEvent("websocket");
  await page.goto(url);
  return { page, socket: await opened };
}

try {
  await startHerdr();
  const one = (await workspaceCreate({ cwd: root, label: "lifetime-one" }, socketPath)).root_pane.pane_id;
  const two = (await workspaceCreate({ cwd: root, label: "lifetime-two" }, socketPath)).root_pane.pane_id;
  for (const pane of [one, two]) await reportAgent(pane);
  server = createServer({ hostname: "127.0.0.1", port: 0, stateDir: join(root, "web"), token: "" });
  const port = server.port;
  const origin = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", alertsOn: false }));
  });
  const errors: string[] = [];
  const { page, socket } = await newPage(context, `${origin}/?pane=${encodeURIComponent(one)}`, errors);
  const submits: string[] = [];
  const watchSubmits = (watched: BrowserSocket): void => {
    watched.on("framesent", ({ payload }) => {
      const message: { type: string; text?: string } = JSON.parse(String(payload));
      if (message.type === "submit") submits.push(message.text ?? "");
    });
  };
  watchSubmits(socket);

  for (const [pane, text] of [[one, "for the old one"], [two, "for the old two"]] as const) {
    await select(page, pane);
    await chatButton(page).click();
    await box(page).fill(text);
  }
  await select(page, one);
  assert.equal(await box(page).inputValue(), "for the old one");
  const before = await stored(page);
  assert.equal(before[`ovis:composer-draft:${one}`], "for the old one");
  assert.equal(before[`ovis:view:${one}`], "chat");

  await server.stop();
  const resnapshot = nextSnapshot(page, watchSubmits);
  server = createServer({ hostname: "127.0.0.1", port, stateDir: join(root, "web"), token: "" });
  await resnapshot;
  assert.equal(await box(page).inputValue(), "for the old one", "a server restart leaves the draft in the box");
  await page.reload();
  await box(page).waitFor();
  assert.equal(await box(page).inputValue(), "for the old one", "a server restart leaves the draft stored");
  assert.match(await lens(page) ?? "", /^Chat transcript/, "a server restart leaves the lens picked");
  assert.deepEqual(await stored(page), before, "a server restart retires nothing");
  console.log("PASS a web server restart keeps the draft and the lens");

  await stopHerdr();
  await startHerdr();
  for (const pane of [one, two]) await reportAgent(pane);

  await page.waitForFunction((was) => { const now = localStorage.getItem("ovis:pane-lifetime:local"); return now !== null && now !== was; },
    before["ovis:pane-lifetime:local"] ?? null, { timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector(".view-switch button[aria-pressed='true']")?.getAttribute("title")?.startsWith("Live terminal") === true,
    undefined, { timeout: 20_000 }).catch(async (error: unknown) => {
    const roster = await (await fetch(`${origin}/api/machines`)).json() as { machines: { id: string; state: string; snapshot: { herdr_lifetime?: string; panes: { pane_id: string; agent?: string }[] } | null }[] };
    console.log("After the herdr restart", JSON.stringify({
      roster: roster.machines.map((machine) => ({ id: machine.id, state: machine.state, lifetime: machine.snapshot?.herdr_lifetime, panes: machine.snapshot?.panes.map((item) => `${item.pane_id}:${item.agent ?? "-"}`) })),
      stored: await stored(page), lens: await lens(page), selected: await page.locator(".agent-item.is-selected").getAttribute("data-pane").catch(() => null),
    }));
    throw error;
  });
  await chatButton(page).click();
  assert.equal(await box(page).inputValue(), "", "the pane of the new herdr starts with an empty box");
  await select(page, two);
  assert.match(await lens(page) ?? "", /^Live terminal/, "the other pane is back on its default lens too");
  await chatButton(page).click();
  assert.equal(await box(page).inputValue(), "", "the other pane's box is empty too");
  const after = await stored(page);
  assert.notEqual(after["ovis:pane-lifetime:local"], before["ovis:pane-lifetime:local"], "the new herdr has a lifetime of its own");
  assert.equal(after[`ovis:composer-draft:${one}`], undefined);
  const archived = Object.entries(after).filter(([key]) => key.startsWith("ovis:unsent:")).map(([, value]) => JSON.parse(value) as { pane_id: string; text: string; kind: string });
  assert.deepEqual(archived.map(({ pane_id, text, kind }) => ({ pane_id, text, kind })).sort((a, b) => a.pane_id.localeCompare(b.pane_id)),
    [{ pane_id: one, text: "for the old one", kind: "message" }, { pane_id: two, text: "for the old two", kind: "message" }].sort((a, b) => a.pane_id.localeCompare(b.pane_id)));
  console.log("PASS a herdr restart opens the reused pane IDs empty, on their default lens, and keeps the text for recovery");

  await select(page, one);
  let dialog = await openRecovery(page);
  assert.match(await dialog.locator(".modal-title").textContent() ?? "", /lifetime-one/, "the dialog title names the destination workspace");
  assert.match(await dialog.locator(".unsent-lead").textContent() ?? "", /lifetime-one/, "the lead names the destination before recovery");
  const oldOne = dialog.locator(".unsent-item", { hasText: "for the old one" });
  await oldOne.getByRole("button", { name: "Put in message box" }).click();
  await box(page).waitFor();
  assert.equal(await box(page).inputValue(), "for the old one", "Recover fills the box");
  assert.match(await lens(page) ?? "", /^Chat transcript/, "Recover shows the box it filled");
  assert.deepEqual(submits, [], "nothing was sent");
  assert.doesNotMatch((await paneRead({ paneId: one, source: "visible" }, socketPath)).text, /for the old one/);
  dialog = await openRecovery(page);
  assert.equal(await dialog.locator(".unsent-item").count(), 1, "a recovered text leaves the list");
  await dialog.locator(".unsent-item", { hasText: "for the old two" }).getByRole("button", { name: "Discard" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(Object.keys(await stored(page)).filter((key) => key.startsWith("ovis:unsent:")).length, 0);
  await openPaneMenu(page);
  await page.getByRole("menuitem", { name: "Close pane" }).waitFor();
  assert.equal(await page.getByRole("menuitem", { name: "Recover unsent text" }).count(), 0);
  await page.keyboard.press("Escape");
  console.log("PASS Recover fills the box without sending, Discard removes the text");
  await page.close();

  // A server that names no herdr lifetime (an older bridge): a draft lives in the page, never in storage.
  await server.stop();
  server = createServer({ hostname: "127.0.0.1", port, stateDir: join(root, "web"), token: "", herdrIdentity: () => null });
  const older = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await older.addInitScript(() => { localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", alertsOn: false })); });
  const legacy = await newPage(older, `${origin}/?pane=${encodeURIComponent(one)}`, errors);
  await select(legacy.page, one);
  await chatButton(legacy.page).click();
  await box(legacy.page).fill("typed under an older bridge");
  assert.deepEqual(await stored(legacy.page), {}, "neither the draft nor the lens is stored");
  await server.stop();
  const again = nextSnapshot(legacy.page, () => undefined);
  server = createServer({ hostname: "127.0.0.1", port, stateDir: join(root, "web"), token: "", herdrIdentity: () => null });
  await again;
  assert.equal(await box(legacy.page).inputValue(), "typed under an older bridge", "the draft survives a reconnect in the page");
  await older.close();
  console.log("PASS an older bridge keeps the draft in the page and out of storage");
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server?.stop();
  if (daemon?.exitCode === null) await stopHerdr();
  rmSync(root, { recursive: true, force: true });
}
