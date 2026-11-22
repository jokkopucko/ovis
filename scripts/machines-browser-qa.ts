import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { herdrRpc } from "../server/herdr/client.ts";
import { paneStorageId } from "../shared/machines.ts";
import { openSettingsPage } from "./settings-page.ts";
import { chromePath } from "./chrome-path.ts";
const fixture = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { root: string; remoteHome: string; port: number; machineId: string; secondMachineId: string; paneId: string };
const { machineId: a, secondMachineId: b, paneId } = fixture;
const origin = `http://127.0.0.1:${fixture.port}`;
const evidence = join(process.cwd(), "evidence/machines"); mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await context.newPage(); page.setDefaultTimeout(15_000);
const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
const inputs: { machine: string; pane: string }[] = [];
const pendingActions: { machine: string; pane: string; action: string }[] = [];
page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
  const message = JSON.parse(String(payload));
  const machine = new URL(socket.url()).searchParams.get("machine_id")!;
  if (message.type === "input" || message.type === "submit") inputs.push({ machine, pane: message.pane_id });
  if (message.type === "pending-action") pendingActions.push({ machine, pane: message.pane_id, action: message.action });
}));
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
async function select(name: string) {
  const group = page.getByRole("region", { name: `PC ${name}`, exact: true });
  await group.locator(`.pane-select[title^="${paneId} —"]`).click();
  await page.locator(".context .machine-context-name").filter({ hasText: name }).waitFor();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
}
async function addPcOverSsh() {
  const sheet = page.getByRole("dialog", { name: "Add a connection", exact: true });
  await sheet.locator('.connect-tabs [data-tab="direct"]').click();
  await sheet.getByLabel("Address or SSH", { exact: true }).fill("qa@pc.invalid");
  await sheet.locator(".connect-ssh-form").getByRole("button", { name: "Connect", exact: true }).click();
}
const composer = page.getByRole("textbox", { name: "Message", exact: true });
let releaseUpload = () => {};
const socket = join(fixture.remoteHome, ".config/herdr/sessions/ssh-qa/herdr.sock");
let pendingProgramRunning = false;
try {
  await page.goto(`${origin}/?machine=${a}&pane=${encodeURIComponent(paneId)}`);
  await page.locator(".conn-live").waitFor();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await composer.fill("PC A draft");
  await select("QA second PC");
  assert.equal(await composer.inputValue(), "");
  await composer.fill("PC B draft");
  await select("QA remote");
  assert.equal(await composer.inputValue(), "PC A draft");
  console.log("PASS same pane ID on two PCs retains separate drafts and header identity");

  const gate = new Promise<void>((resolve) => { releaseUpload = resolve; });
  const uploads: string[] = [];
  await page.route(`**/api/machines/${a}/pane/image`, async (route) => { uploads.push(route.request().url()); await gate; await route.continue(); });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1kAAAAASUVORK5CYII=", "base64");
  await page.locator('input[type="file"]').setInputFiles([{ name: "first.png", mimeType: "image/png", buffer: png }, { name: "second.png", mimeType: "image/png", buffer: png }]);
  for (let i = 0; i < 100 && uploads.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(uploads.length, 2);
  await select("QA second PC");
  const uploaded = page.waitForResponse((r) => r.url().endsWith(`${a}/pane/image`));
  releaseUpload(); assert.equal((await uploaded).status(), 200);
  assert.equal(await composer.inputValue(), "PC B draft");
  assert.equal(uploads.length, 2, "both late uploads went to PC A, none to PC B");
  console.log("PASS late image response and upload batch stay on their original PC");

  await composer.fill("printf 'browser_pc_b_ok\\n'");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  assert.deepEqual(inputs.at(-1), { machine: b, pane: paneId });
  await select("QA remote");
  // SSH_TEST_KEEP creates a loopback fixture with a private remoteHome.
  assert.match(fixture.root, /\/herdr-ssh-qa-[^/]+$/);
  assert.equal(fixture.remoteHome, join(fixture.root, "remote"));
  const program = join(fixture.remoteHome, "claude"); copyFileSync(process.execPath, program); chmodSync(program, 0o755);
  const log = join(fixture.remoteHome, "browser-pending.jsonl");
  const script = join(fixture.remoteHome, "browser-pending.cjs");
  writeFileSync(script, `const fs=require("node:fs");const log=process.argv[2];process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write("\\x1b[?2004h\\n› Message\\n",()=>fs.writeFileSync(log,""));process.stdin.on("data",c=>{if(c.includes(3))process.exit(0);fs.appendFileSync(log,JSON.stringify(c.toString("utf8"))+"\\n");});`);
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `'${program}' '${script}' '${log}'\n` }, socket);
  pendingProgramRunning = true;
  await until(() => existsSync(log), "remote pending recorder");
  const bytes = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string).join("");
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "working" }, socket);
  await page.locator('.composer-status[data-status="working"]').waitFor();
  await until(async () => await page.locator(".composer-agent-label").innerText() === "Claude", "remote foreground agent identity");
  const pendingRows = page.locator(".pending-message");
  for (const [index, text] of ["PENDING_A_SEND_NOW", "PENDING_A_MUST_NOT_REPLAY"].entries()) {
    await composer.fill(text);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await until(async () => await pendingRows.count() === index + 1 && await composer.inputValue() === "", "remote pending accepted");
    assert.deepEqual(inputs.at(-1), { machine: a, pane: paneId });
  }
  assert.equal(bytes(), "", "working Send retains text at the bridge");
  await pendingRows.first().getByRole("button", { name: /^Send now:/ }).click();
  await until(async () => await pendingRows.count() === 1 && bytes().endsWith("\r"), "remote explicit Send now");
  const delivered = "\u001b[200~PENDING_A_SEND_NOW\u001b[201~\r";
  assert.equal(bytes(), delivered);
  assert.deepEqual(pendingActions.at(-1), { machine: a, pane: paneId, action: "steer" });
  const count = inputs.length;
  await page.reload();
  await page.locator('.pending-message[data-state="uncertain"]').waitFor();
  assert.equal(await page.locator(".pending-message-bubble").innerText(), "PENDING_A_MUST_NOT_REPLAY");
  assert.equal(await page.locator(".pending-message-send").count(), 0, "unknown delivery cannot retry");
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" }, socket);
  await page.locator('.composer-status:not([data-status="working"])').waitFor();
  await page.waitForTimeout(400); // fixed wait: no saved input may be sent after the reload
  assert.equal(inputs.length, count, "reload and status changes never dispatch saved pending input");
  assert.equal(bytes(), delivered, "no automatic replay reaches the remote pty");
  await select("QA second PC");
  assert.equal(await pendingRows.count(), 0);
  await select("QA remote");
  assert.equal(await page.locator(".pending-message-bubble").innerText(), "PENDING_A_MUST_NOT_REPLAY");
  await page.getByRole("button", { name: "Discard saved copy", exact: true }).click();
  await pendingRows.waitFor({ state: "hidden" });
  // Older versions' held messages remain editable, manual and scoped to their PC.
  await page.evaluate(({ owner }) => localStorage.setItem(`ovis:queue:${owner}`, JSON.stringify({ version: 1, messages: [{ id: "legacy-machine-browser", text: "HELD_A_MUST_NOT_SEND" }] })), { owner: paneStorageId(a, paneId) });
  await page.reload(); await page.locator(".composer-queue-text").waitFor();
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "blocked" }, socket);
  await page.locator('.composer-status[data-status="blocked"]').waitFor();
  await page.waitForTimeout(400); // fixed wait: no held input may be sent while blocked
  assert.equal(bytes(), delivered, "legacy held input does not advance through blocked status");
  await select("QA second PC");
  assert.equal(await page.locator(".composer-queue-text").count(), 0);
  await select("QA remote");
  assert.equal(await page.locator(".composer-queue-text").inputValue(), "HELD_A_MUST_NOT_SEND");
  const heldToggle = page.locator(".composer-queue-toggle");
  if (await heldToggle.count() && await heldToggle.getAttribute("aria-expanded") !== "true") await heldToggle.click();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await herdrRpc("pane.send_text", { pane_id: paneId, text: "\u0003" }, socket); pendingProgramRunning = false;
  console.log("PASS remote Send/Send now targets its PC once; saved pending and legacy held input never replay or cross PCs");

  await page.getByRole("button", { name: "New workspace on QA second PC", exact: true }).click();
  const create = page.getByRole("dialog", { name: "New workspace · QA second PC", exact: true });
  await create.waitFor(); await create.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.locator(".sidebar-footer").getByRole("button", { name: "Settings", exact: true }).click();
  await openSettingsPage(page, "Devices and PCs");
  await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Add a connection", exact: true }).click();
  await addPcOverSsh();
  const dialog = page.getByRole("dialog", { name: "Add PC", exact: true }); await dialog.waitFor();
  await page.screenshot({ path: join(evidence, "desktop-add-pc-dark.png") });
  await dialog.getByRole("button", { name: "Close PC setup" }).click();
  await page.screenshot({ path: join(evidence, "desktop-dark.png") });
  await page.locator(".sidebar-footer").getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Light", exact: true }).click();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.screenshot({ path: join(evidence, "desktop-light.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
  await page.waitForFunction(() => Math.abs(document.querySelector(".sidebar.is-open")!.getBoundingClientRect().x) < 1);
  await page.screenshot({ path: join(evidence, "mobile-light.png") });
  await page.locator(".sidebar-footer").getByRole("button", { name: "Settings", exact: true }).click();
  await openSettingsPage(page, "Devices and PCs");
  await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Add a connection", exact: true }).click();
  await addPcOverSsh();
  await page.getByRole("dialog", { name: "Add PC", exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "mobile-add-pc-light.png") });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.getByRole("button", { name: "Close PC setup" }).click();
  await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
  await page.locator(".sidebar-footer").getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await openSettingsPage(page, "Appearance");
  await settings.getByRole("button", { name: "Dark", exact: true }).click();
  await settings.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
  await page.waitForFunction(() => Math.abs(document.querySelector(".sidebar.is-open")!.getBoundingClientRect().x) < 1);
  await page.screenshot({ path: join(evidence, "mobile-dark.png") });
  assert.deepEqual(errors, []);
  console.log("PASS desktop/mobile, light/dark, PC creation target and setup modal; no browser errors");
} finally {
  releaseUpload();
  if (pendingProgramRunning) await herdrRpc("pane.send_text", { pane_id: paneId, text: "\u0003" }, socket).catch(() => {});
  await browser.close();
}
