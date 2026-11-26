import "./test-herdr.ts";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { claudeProjectDir } from "../server/claude-store.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { checkChromeTmpdir } from "./chrome-path.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-claude-api-error-"));
const id = "11111111-2222-4333-8444-555555555555";
const file = join(root, ".claude", "projects", claudeProjectDir(root), `${id}.jsonl`);
mkdirSync(join(file, ".."), { recursive: true });
copyFileSync(join(import.meta.dir, "..", "server", "fixtures", "claude-api-error-2.1.321.jsonl"), file);
const originalHome = process.env["HOME"];
let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  process.env["HOME"] = root;
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-claude-api-error" });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "idle" });
  await herdrRpc("pane.report_agent_session", { pane_id: pane, source: "herdr:claude", agent: "claude", seq: Date.now() * 1000, agent_session_id: id });
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), tailscaleOwner: null });
  checkChromeTmpdir();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport, locale: "en-US" });
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((paneId) => localStorage.setItem(`ovis:view:${paneId}`, "chat"), pane);
    await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
    const row = page.locator(`.pane-frame[data-layout-pane="${pane}"] [data-failed-requests]`);
    await row.waitFor();
    assert.equal(await row.count(), 1);
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `claude-api-error-${viewport.width}.png`) });
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("PASS Claude Code's recorded API error reads as a failed request at 1280 and 390");
} finally {
  const errors: unknown[] = [];
  try { await browser?.close(); } catch (error) { errors.push(error); }
  try { server?.stop(); } catch (error) { errors.push(error); }
  try { if (workspace) await workspaceClose(workspace); } catch (error) { errors.push(error); }
  if (originalHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = originalHome;
  try { rmSync(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  if (errors.length) { console.error(new AggregateError(errors, "Claude API error QA cleanup failed")); process.exitCode = 1; }
}
