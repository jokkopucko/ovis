import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Machine, SetupRequest } from "../shared/machines.ts";

const snapshot = { version: "0.9.3", protocol: 22, focused_workspace_id: null, focused_tab_id: null, focused_pane_id: null, workspaces: [], tabs: [], panes: [], layouts: [], agents: [] };
const local = { id: "local", name: "QA host", kind: "local", state: "connected", enabled: true, error: null, snapshot } as Machine;
const reason = "This PC uses a newer bridge (v99); this app requires v1. Update this app, then reconnect. The remote bridge was left running.";
const pc: Machine = { ...local, id: "qa-remote", name: "QA remote", kind: "ssh", target: { destination: "qa.invalid" }, state: "error", error: reason, action_required: "bridge_conflict" };
const requests: SetupRequest[] = [];
let roster: Machine[] = [local, pc];
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
const tell = (event: unknown) => { for (const stream of streams) stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); };
let removed = 0;
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
  if (path === `/api/machines/${pc.id}` && request.method === "DELETE") {
    roster = [local];
    tell({ type: "machines", machines: roster });
    await Bun.sleep(500); // fixed wait: the tab must see the roster before the answer, as on a real server
    removed += 1;
    return Response.json({ ok: true });
  }
  if (path === "/api/session") return Response.json({ snapshot });
  if (path === "/api/machines/settings") return Response.json({ auto_update_bridges: false });
  if (path === "/api/machines/setup" && request.method === "POST") {
    const body = await request.json() as SetupRequest; requests.push(body);
    return Response.json({ id: "qa-job", machine_id: pc.id, target: { destination: body.destination }, phase: "connected", step: "Connected", challenge: null, installations: [], error: null, ssh_output: null }, { status: 202 });
  }
  if (path.startsWith("/api/") || path === "/ws") return Response.json({ error: { code: "qa", message: "Unavailable in fixture" } }, { status: 404 });
  const file = Bun.file(resolve("dist", path === "/" ? "index.html" : path.slice(1)));
  return new Response(await file.exists() ? file : Bun.file("dist/index.html"));
} });
const browser = await chromium.launch({ headless: true, executablePath: process.env["CHROME_PATH"] || chromium.executablePath() });
const shots = resolve("evidence/machine-conflict"); mkdirSync(shots, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
  await page.goto(server.url.href);
  const notice = page.locator(".machine-action");
  await notice.getByText("Bridge connection conflict", { exact: true }).waitFor({ timeout: 10_000 });
  await notice.getByText(reason, { exact: true }).waitFor();
  await page.locator(".update-notice").getByText("QA remote has a bridge connection conflict.", { exact: true }).waitFor();
  assert.equal(await page.getByText("Setup needed", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Set up…", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Update bridge", exact: true }).count(), 0);
  await page.screenshot({ path: `${shots}/conflict.png` });
  await notice.getByRole("button", { name: "Reconnect", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Reconnect PC", exact: true });
  await dialog.locator("button[type=submit]").click();
  await dialog.getByRole("button", { name: "Open PC", exact: true }).waitFor();
  assert.equal(requests.length, 1); assert.equal(requests[0]!.machine_id, pc.id); assert.equal(requests[0]!.update_remote, undefined);
  await dialog.getByRole("button", { name: "Close PC setup" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator(".update-notice").getByRole("button", { name: "Reconnect", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${shots}/conflict-mobile.png` });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(([key, id]) => { for (const storage of [sessionStorage, localStorage]) storage.setItem(key!, JSON.stringify({ machine_id: id, pane_id: null })); }, ["ovis:selection", pc.id]);
  await page.reload();
  const group = page.locator(`section.machine-group.is-current[aria-label="PC ${pc.name}"]`);
  await group.waitFor({ timeout: 10_000 });
  await group.getByRole("button", { name: `Manage ${pc.name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Remove PC…", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove PC", exact: true }).click();
  await page.locator(`section.machine-group.is-current[aria-label="PC ${local.name}"]`).waitFor();
  await page.waitForFunction(() => document.querySelector(`section.machine-group[aria-label="PC QA remote"]`) === null);
  const deadline = Date.now() + 5_000;
  while (removed === 0) { if (Date.now() > deadline) throw new Error("Remove PC never sent DELETE"); await Bun.sleep(25); }
  assert.equal(await page.locator(".header-note", { hasText: "That link's PC is not set up here" }).count(), 0, "removing the selected PC here is not a link to a missing PC");
  assert.deepEqual(errors, []);
  console.log("PASS: a bridge conflict is named as one in the sidebar and under the header, and Reconnect starts a plain setup; removing the selected PC opens this one without a note; screenshots:", shots);
} finally { await browser.close(); server.stop(true); }
