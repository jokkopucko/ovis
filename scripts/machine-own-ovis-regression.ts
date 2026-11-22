import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Machine, RemoteOvis } from "../shared/machines.ts";
import { chromePath } from "./chrome-path.ts";
import { sheetEntryLeft } from "./sheets-settled.ts";

const snapshot = { version: "0.9.3", protocol: 22, focused_workspace_id: null, focused_tab_id: null, focused_pane_id: null, workspaces: [], tabs: [], panes: [], layouts: [], agents: [] };
const local = { id: "local", name: "QA host", kind: "local", state: "connected", enabled: true, error: null, snapshot } as Machine;
const updatable: RemoteOvis = { version: "0.4.16", latest_version: "0.4.18", updatable: true, reason: null, address: "qa.invalid:7317", url: null };
const refusal = "That PC's Ovis asks for its own access token (OVIS_TOKEN), which this app does not read. Update it on that PC (Settings → Updates), then reconnect.";
const offered: Machine = { ...local, id: "qa-remote", name: "QA remote", kind: "ssh", target: { destination: "devswha@qa.invalid" }, state: "error", action_required: "update_bridge", remote_ovis: updatable,
  error: "This PC runs its own Ovis v0.4.16, older than this app. Update it to v0.4.18 to reconnect; it updates itself, and herdr sessions keep running." };
const refused = (url: string | null): Machine => ({ ...offered, action_required: "setup", remote_ovis: { ...updatable, updatable: false, reason: refusal, url },
  error: `This socket uses an independently managed web server. Update it through its own Settings, then reconnect; it was left running. It cannot be updated from here: ${refusal}` });
const failure = "That PC's Ovis could not update itself: bun install failed (exit 1) Check its Settings → Updates there, then reconnect.";
const differs = "This PC's Ovis updated itself, but its version still differs from this app's (v36; this app requires v37). Update it on that PC (Settings → Updates), then reconnect; it was left running.";
const updates: string[] = [];
let roster: Machine[] = [local, offered];
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
const tell = () => { for (const stream of streams) stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "machines", machines: roster })}\n\n`)); };
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/api/health") return Response.json({ ok: true, auth: { authenticated: true, required: false, role: "drive" }, herdr: { version: "0.9.3", protocol: 22 }, web_ui: { revision: null, boot_id: "qa" } });
  if (path === "/api/machines") return Response.json({ machines: roster });
  if (path === "/api/machines/events") {
    let held: ReadableStreamDefaultController<Uint8Array> | undefined;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { held = controller; streams.add(controller); controller.enqueue(new TextEncoder().encode(": open\n\n")); },
      cancel() { if (held) streams.delete(held); },
    }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  }
  if (path === `/api/machines/${offered.id}/update-bridge` && request.method === "POST") {
    updates.push(path);
    roster = [local, { ...offered, updating: { job_id: "qa-job", step: "This PC's own Ovis is updating itself to v0.4.18: building…", progress: null, ovis: true } }];
    tell();
    return Response.json({ id: "qa-job", machine_id: offered.id, target: offered.target, phase: "installing", step: "Asking this PC's own Ovis to update itself to v0.4.18…", challenge: null, installations: [], error: null, ssh_output: null }, { status: 202 });
  }
  if (path === "/api/session") return Response.json({ snapshot });
  if (path === "/api/machines/settings") return Response.json({ auto_update_bridges: false });
  if (path.startsWith("/api/") || path === "/ws") return Response.json({ error: { code: "qa", message: "Unavailable in fixture" } }, { status: 404 });
  const file = Bun.file(resolve("dist", path === "/" ? "index.html" : path.slice(1)));
  return new Response(await file.exists() ? file : Bun.file("dist/index.html"));
} });
const browser = await chromium.launch({ headless: true, executablePath: chromePath() });
const shots = resolve("evidence/machine-own-ovis"); mkdirSync(shots, { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
  const card = page.locator(".machine-action");

  await page.goto(server.url.href);
  await card.getByText("This PC's Ovis is older than this app", { exact: true }).waitFor({ timeout: 10_000 });
  await page.locator(".update-notice").getByText("QA remote's own Ovis needs an update to reconnect.", { exact: true }).waitFor();
  assert.equal(await page.getByText("Bridge update needed", { exact: true }).count(), 0, "not called a bridge this app installs");
  assert.equal(await card.locator(".machine-action-reason").count(), 0, "a plain offer shows no reason");
  await page.screenshot({ path: `${shots}/offer.png` });
  await card.getByRole("button", { name: "Update this PC's Ovis to v0.4.18", exact: true }).click();
  await card.getByText("Updating this PC's Ovis", { exact: true }).waitFor();
  await page.locator(".update-notice").getByText("Updating QA remote's own Ovis", { exact: false }).waitFor();
  assert.deepEqual(updates, [`/api/machines/${offered.id}/update-bridge`]);
  await page.screenshot({ path: `${shots}/updating.png` });

  roster = [local, { ...offered, error: failure }];
  await page.reload();
  await card.getByText("Updating this PC's Ovis failed", { exact: true }).waitFor({ timeout: 10_000 });
  await card.getByText(failure, { exact: true }).waitFor();
  await card.getByRole("button", { name: "Update this PC's Ovis to v0.4.18", exact: true }).waitFor();
  await page.locator(".update-notice").getByText("Updating QA remote's own Ovis failed.", { exact: true }).waitFor();
  assert.equal(await page.locator(".update-notice span[title]").getAttribute("title"), failure, "the line under the header holds why on hover");
  await page.screenshot({ path: `${shots}/failed.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator(".update-notice").getByText("Updating QA remote's own Ovis failed.", { exact: true }).waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
  await card.getByText(failure, { exact: true }).waitFor();
  await page.waitForFunction(() => document.getAnimations().every((animation) => !(animation instanceof CSSTransition) || animation.playState !== "running"));
  assert.equal(await card.evaluate((element) => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; }), true, "the failed card lies inside the phone's width");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${shots}/failed-mobile.png` });
  await page.setViewportSize({ width: 1280, height: 900 });
  // the drawer, opened at the phone's width, held a history entry: widened, it steps off it, and a
  // reload asked for before that step lands is dropped (net::ERR_ABORTED)
  await sheetEntryLeft(page);

  roster = [local, refused(null)];
  await page.reload();
  await card.getByText("Update this PC's Ovis on that PC", { exact: true }).waitFor({ timeout: 10_000 });
  await card.getByText(refusal, { exact: true }).waitFor();
  await card.getByText("Open it on that PC or through its own tailnet address:", { exact: true }).waitFor();
  assert.equal(await card.locator(".machine-own-address code").textContent(), "qa.invalid:7317");
  assert.equal(await page.getByRole("link", { name: "Open that PC's Ovis" }).count(), 0);
  await page.locator(".update-notice").getByText("QA remote's own Ovis needs an update on that PC.", { exact: true }).waitFor();
  await card.getByRole("button", { name: "Copy address", exact: true }).click();
  await card.getByRole("button", { name: "Copied", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "qa.invalid:7317");
  await page.screenshot({ path: `${shots}/refused.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator(".update-notice").getByText("QA remote's own Ovis needs an update on that PC.", { exact: true }).waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
  await card.getByRole("button", { name: "Copy address", exact: true }).waitFor();
  await page.waitForFunction(() => document.getAnimations().every((animation) => !(animation instanceof CSSTransition) || animation.playState !== "running"));
  assert.equal(await card.evaluate((element) => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; }), true, "the card lies inside the phone's width");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${shots}/refused-mobile.png` });

  roster = [local, { ...offered, action_required: "setup", error: "This PC's Ovis updated itself, but its version still differs from this app's (v36; this app requires v37). Update it on that PC (Settings → Updates), then reconnect; it was left running." }];
  await page.reload();
  await page.locator(".update-notice").getByText("QA remote needs web access setup.", { exact: true }).waitFor({ timeout: 10_000 });
  await page.locator(".update-notice").getByRole("button", { name: "Set up web access", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /Update this PC's Ovis/ }).count(), 0);
  assert.equal(await card.getByText("Setup needed", { exact: true }).count(), 1);

  await page.setViewportSize({ width: 1280, height: 900 });
  roster = [local, { ...offered, action_required: "setup", error: differs, remote_ovis: { ...updatable, version: null, latest_version: null, updatable: false, reason: differs } }];
  await page.reload();
  await card.getByText("Update this PC's Ovis on that PC", { exact: true }).waitFor({ timeout: 10_000 });
  await card.getByText(differs, { exact: true }).waitFor();
  assert.equal(await card.locator(".machine-own-address code").textContent(), "qa.invalid:7317");
  await page.locator(".update-notice").getByText("QA remote's own Ovis needs an update on that PC.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /Update this PC's Ovis/ }).count(), 0);
  await page.screenshot({ path: `${shots}/differs.png` });

  await page.setViewportSize({ width: 1280, height: 900 });
  roster = [local, refused("https://home-server.example.ts.net")];
  await page.reload();
  const link = card.getByRole("link", { name: "Open that PC's Ovis", exact: true });
  await link.waitFor({ timeout: 10_000 });
  assert.equal(await link.getAttribute("href"), "https://home-server.example.ts.net");
  assert.equal(await card.locator(".machine-own-address code").textContent(), "home-server.example.ts.net");
  assert.equal(await card.getByRole("button", { name: "Copy address", exact: true }).count(), 0);
  await page.screenshot({ path: `${shots}/refused-link.png` });

  const choosing: Machine = { ...offered, action_required: "choose_herdr", remote_ovis: null, error: "Choose this PC's Ovis server or a running herdr session.",
    found_ovis: [{ socket_path: "/home/qa/.config/ovis/herdr-core.sock", runtime: "herdr-core" }],
    found_herdr_sessions: [{ session: "work", label: "work", socket_path: "/home/qa/.config/herdr/sessions/work/herdr.sock" }, { label: "Default session", socket_path: "/home/qa/.config/herdr/herdr.sock" }] };
  for (const width of [1280, 390]) {
    roster = [local, choosing];
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.reload();
    if (width === 390) await page.getByRole("button", { name: "Open workspace list", exact: true }).click({ timeout: 10_000 });
    const answers = card.getByRole("button");
    await answers.first().waitFor({ timeout: 10_000 });
    await page.waitForFunction(() => document.getAnimations().every((animation) => !(animation instanceof CSSTransition) || animation.playState !== "running"));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${shots}/choose-${width}.png` });
    // beside the PC's Ovis its herdr sessions wait under a closed Advanced settings fold
    assert.deepEqual(await answers.allTextContents(), ["Use Ovis on this PC (herdr-core)"]);
    assert.equal(await answers.first().evaluate((button) => button.classList.contains("btn-primary")), true);
    await card.locator("summary").click();
    assert.deepEqual(await answers.allTextContents(), ["Use Ovis on this PC (herdr-core)", "Use work", "Use Default session", "Start a new herdr here"]);
    assert.equal(await card.evaluate((element) => element.classList.contains("is-setup")), true, "the choice is drawn as a question, not as an error");
    const section = page.locator(".machine-group").filter({ has: card });
    assert.equal(await section.locator(".machine-dot.is-error").count(), 0, "the PC's dot does not say error while it waits for a choice");
    assert.equal(await section.locator(".machine-dot").getAttribute("title"), "Choose what to connect to");
    await page.locator(".update-notice").getByText("Choose what QA remote connects to.", { exact: true }).waitFor();
    assert.equal(await page.locator(".update-notice").getByRole("button", { name: "Choose", exact: true }).count(), 1);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await sheetEntryLeft(page);
  roster = [local, { ...offered, action_required: "choose_herdr", remote_ovis: null, target: { ...offered.target!, own_ovis: "/home/qa/.config/ovis/herdr-core.sock" },
    error: "Start Ovis on that PC, or start a new herdr here", found_ovis: [], found_herdr_sessions: [] }];
  await page.reload();
  await card.getByText("Start Ovis on that PC, or start a new herdr here", { exact: true }).waitFor({ timeout: 10_000 });
  assert.equal(await card.evaluate((element) => element.classList.contains("is-setup")), false, "a chosen Ovis that is gone is drawn as a failure");
  const failedSection = page.locator(".machine-group").filter({ has: card });
  assert.equal(await failedSection.locator(".machine-dot.is-error").count(), 1, "its dot says error too");
  assert.equal(await page.locator(".update-notice").getByText("Choose what QA remote connects to.", { exact: true }).count(), 0, "the line under the header does not ask it as a fresh choice");
  const gone = "The herdr session chosen for this PC is no longer running. Start it on that PC and reconnect, or choose again.";
  roster = [local, { ...offered, action_required: "choose_herdr", remote_ovis: null, target: { ...offered.target!, herdr_socket: "/home/qa/.config/herdr/sessions/old/herdr.sock" },
    error: gone, found_ovis: [], found_herdr_sessions: [{ session: "work", label: "work", socket_path: "/home/qa/.config/herdr/sessions/work/herdr.sock" }] }];
  await page.reload();
  await card.getByText(gone, { exact: true }).waitFor({ timeout: 10_000 });
  assert.equal(await card.evaluate((element) => element.classList.contains("is-setup")), false, "a chosen session that stopped is drawn as a failure");
  assert.equal(await failedSection.locator(".machine-dot.is-error").count(), 1, "its dot says error");
  assert.equal(await page.locator(".update-notice").getByText("Choose what QA remote connects to.", { exact: true }).count(), 0);
  await card.getByRole("button", { name: "Use work", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS: an older PC's own Ovis is offered its own update on the card, shown updating under its own title, and otherwise named with why and where it answers; screenshots:", shots);
} finally { await browser.close(); server.stop(true); }
