import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { SLEEP } from "./fixtures/sleep.ts";
import { checkChromeTmpdir } from "./chrome-path.ts";

if (process.platform !== "linux") { console.log("SKIP fictional agent processes require Linux"); process.exit(0); }
const root = mkdtempSync(join(tmpdir(), "herdr-chat-unavailable-"));
const cases = [
  { agent: "droid", words: "Ovis can't read Droid conversations yet. Use the terminal to work with it." },
  { agent: "claude", words: "Claude Code has not recorded a conversation Ovis can find for this pane yet." },
];
const workspaces: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), tailscaleOwner: null });
  checkChromeTmpdir();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
  for (const { agent, words } of cases) {
    const folder = join(root, agent);
    mkdirSync(folder);
    const executable = join(folder, agent);
    copyFileSync(SLEEP, executable); chmodSync(executable, 0o755);
    const created = await workspaceCreate({ cwd: folder, label: `ovis-test-unavailable-${agent}` });
    workspaces.push(created.workspace.workspace_id);
    const pane = created.root_pane.pane_id;
    await herdrRpc("pane.send_text", { pane_id: pane, text: `${executable} 600\n` });
    for (const deadline = Date.now() + 10_000;;) {
      if ((await sessionSnapshot()).panes.find((p) => p.pane_id === pane)?.agent === agent) break;
      if (Date.now() > deadline) throw new Error(`fictional ${agent} process was not recognized`);
      await Bun.sleep(50);
    }
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport, locale: "en-US" });
      page.setDefaultTimeout(12_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript((id) => localStorage.setItem(`ovis:view:${id}`, "chat"), pane);
      await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
      const log = page.locator(`.pane-frame[data-layout-pane="${pane}"]`).getByRole("log");
      const reason = log.locator(".chat-unavailable-reason");
      await reason.getByText(words, { exact: false }).waitFor();
      const box = await reason.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width, "the reason fits the width");
      if (process.env.UI_EVIDENCE_DIR) {
        mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `chat-unavailable-${agent}-${viewport.width}.png`) });
      }
      await reason.getByRole("button", { name: "Open Terminal" }).click();
      await page.locator(`.pane-frame[data-layout-pane="${pane}"] .xterm`).first().waitFor();
      assert.equal(await page.locator(".terminal-banner-command").count(), 0, "no command banner after Open Terminal");
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
  console.log("PASS the chat says why it has no conversation (no reader, none recorded yet) at 1280 and 390, and opens the terminal");
} finally {
  const errors: unknown[] = [];
  try { await browser?.close(); } catch (error) { errors.push(error); }
  try { server?.stop(); } catch (error) { errors.push(error); }
  for (const workspace of workspaces) try { await workspaceClose(workspace); } catch (error) { errors.push(error); }
  try { rmSync(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  if (errors.length) { console.error(new AggregateError(errors, "chat unavailable QA cleanup failed")); process.exitCode = 1; }
}
