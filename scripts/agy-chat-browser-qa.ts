import "./test-herdr.ts";
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { resolveAgyStore } from "../server/agy-store.ts";
import { createServer } from "../server/index.ts";
import { herdrRpc, sessionSnapshot, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import { SLEEP } from "./fixtures/sleep.ts";
import { checkChromeTmpdir } from "./chrome-path.ts";

if (process.platform !== "linux") { console.log("SKIP Agy process fixture requires Linux"); process.exit(0); }
const root = mkdtempSync(join(tmpdir(), "herdr-agy-activity-"));
const session = "00000000-0000-4000-8000-000000000021";
const dir = join(root, "brain", session, ".system_generated", "logs");
mkdirSync(dir, { recursive: true });
mkdirSync(join(root, "conversations")); mkdirSync(join(root, "presence"));
const path = join(dir, "transcript_full.jsonl");
const lock = join(root, "presence", `${session}.lock`);
writeFileSync(path, ""); writeFileSync(lock, "");
const db = new Database(join(root, "conversations", `${session}.db`));
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY)");
let index = 0;
const add = (type: string, content = "", extra = {}) => {
  const step_index = index++;
  appendFileSync(path, JSON.stringify({ step_index, type, content, status: "DONE", ...extra }) + "\n");
  db.query("INSERT INTO steps VALUES (?)").run(step_index);
};
const executable = join(root, "agy");
copyFileSync(SLEEP, executable); chmodSync(executable, 0o755);
let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-agy-activity", focus: false });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: pane, text: `${executable} 600 3<${lock}\n` });
  for (const deadline = Date.now() + 10_000;;) {
    const active = (await sessionSnapshot()).panes.find((p) => p.pane_id === pane);
    if (active?.agent === "agy" && (await resolveAgyStore(active))?.session === session) break;
    if (Date.now() > deadline) throw new Error("fictional Agy process did not hold the fixture's presence lock");
    await Bun.sleep(50);
  }
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), tailscaleOwner: null });
  checkChromeTmpdir();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, locale: "en-US" });
  page.setDefaultTimeout(12_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(id => localStorage.setItem(`ovis:view:${id}`, "chat"), pane);
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  const log = page.locator(`.pane-frame[data-layout-pane="${pane}"]`).getByRole("log");
  const nativeLog = log.and(page.locator('[data-conversation-source="agy-transcript"]'));
  await nativeLog.waitFor();
  const activity = log.locator(".chat-activity");
  for (const viewport of [{ width: 1100, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    add("USER_INPUT", `Fictional task at width ${viewport.width}`);
    add("EPHEMERAL_MESSAGE", "hidden context");
    await log.getByText(`Fictional task at width ${viewport.width}`, { exact: true }).waitFor();
    await log.locator(".chat-activity", { hasText: "Working…" }).waitFor();
    assert.notEqual((await sessionSnapshot()).panes.find(p => p.pane_id === pane)?.agent_status, "working");
    const box = await activity.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height, "activity is visible above the composer");
    add("PLANNER_RESPONSE", "", { tool_calls: [{ name: "view_file", args: { AbsolutePath: "/fiction.txt" } }] });
    await log.locator(".work-block.is-live .work-row-head").last().waitFor({ state: "visible" });
    add("GENERIC", "Fictional tool result");
    await log.locator(".work-block.is-live .work-block-title", { hasText: "Working…" }).waitFor();
    await activity.waitFor({ state: "detached" });
    if (viewport.width === 390 && process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "agy-mobile-activity.png") });
    }
    add("PLANNER_RESPONSE", `Finished task at width ${viewport.width}`);
    await log.getByText(`Finished task at width ${viewport.width}`, { exact: true }).waitFor();
    await activity.waitFor({ state: "detached" });
    add("GENERIC", `Late result at width ${viewport.width}`);
    await page.reload();
    await log.getByText(`Finished task at width ${viewport.width}`, { exact: true }).waitFor();
    assert.equal(await activity.count(), 0, "a late tool result does not restart completed activity");
  }
  const rewind = index;
  add("USER_INPUT", "Remove this active prompt");
  const removedPrompt = log.getByText("Remove this active prompt", { exact: true });
  await removedPrompt.waitFor();
  await activity.waitFor();
  db.query("DELETE FROM steps WHERE idx >= ?").run(rewind);
  await activity.waitFor({ state: "detached" });
  await removedPrompt.waitFor({ state: "detached" });
  assert.equal(await removedPrompt.count(), 0);
  await nativeLog.getByText("Fictional task at width 390", { exact: true }).waitFor();
  db.exec("DROP TABLE steps");
  await log.locator(".chat-unavailable-reason").getByText(/couldn't find or read the file .* keeps this conversation in/u).waitFor();
  assert.equal(await log.getByText("Antigravity chat is unavailable. Open Terminal to see activity and tool calls.", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS Agy desktop/mobile native activity, live tools, completion, late results, rewind and unavailable-chat reason");
} finally {
  const errors: unknown[] = [];
  try { await browser?.close(); } catch (error) { errors.push(error); }
  try { server?.stop(); } catch (error) { errors.push(error); }
  try { db.close(); } catch (error) { errors.push(error); }
  try { if (workspace) await workspaceClose(workspace); } catch (error) { errors.push(error); }
  try { rmSync(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  if (errors.length) { console.error(new AggregateError(errors, "Agy browser cleanup failed")); process.exitCode = 1; }
}
