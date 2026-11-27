import "./test-herdr.ts";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { WAITING_SEND_MS } from "../src/lib/sentWaiting.ts";
import { checkChromeTmpdir } from "./chrome-path.ts";

if (process.platform !== "linux") { console.log("SKIP fictional agent processes require Linux"); process.exit(0); }
const EARLIER = "The fictional earlier answer is long enough for the chat to tie this rollout to the screen that shows it, as a real one is.";
const root = mkdtempSync(join(tmpdir(), "herdr-unanswered-send-"));
const codexHome = join(root, "codex");
const rollout = join(codexHome, "sessions", "rollout.jsonl");
mkdirSync(join(codexHome, "sessions"), { recursive: true });
const db = new Database(join(codexHome, "state_5.sqlite"));
db.exec("CREATE TABLE threads (rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, updated_at INTEGER)");
db.query("INSERT INTO threads VALUES (?, ?, 0, NULL, 1)").run(rollout, root);
db.close();

mkdirSync(join(root, "bin"));
const codex = join(root, "bin", "codex");
writeFileSync(codex, `#!/bin/sh\nprintf '%s\\n' '${EARLIER}' | fold -s -w 60 | sed '1s/^/• /;2,$s/^/  /'\ncat > /dev/null\n`);
chmodSync(codex, 0o755);
const evidence = process.env.UI_EVIDENCE_DIR;
const message = "Fictional request the agent never records";
let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-unanswered-send", focus: false });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  // as server/codex.contract.test.ts binds its stand-in: the session reported, the Codex started, its rollout written
  await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "codex", state: "idle", agent_session_path: rollout });
  await herdrRpc("pane.send_text", { pane_id: pane, text: `${codex}\n` });
  for (const deadline = Date.now() + 10_000; !(await herdrRpc<{ read: { text: string } }>("pane.read", { pane_id: pane, source: "visible", format: "text" })).read.text.includes("• The fictional");) {
    if (Date.now() > deadline) throw new Error("the fictional Codex did not start");
    await Bun.sleep(50);
  }
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), codexHome, tailscaleOwner: null });
  const now = new Date().toISOString();
  writeFileSync(rollout, [
    { type: "session_meta", payload: { id: "01a0c7a1-56d9-7e20-9f08-f7a2d973bcbc", cwd: root } },
    { type: "turn_context", payload: { model: "codex-test-model", effort: "low" } },
    { type: "response_item", timestamp: now, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Earlier question" }] } },
    { type: "response_item", timestamp: now, payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: EARLIER }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  checkChromeTmpdir();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((id) => localStorage.setItem(`ovis:view:${id}`, "chat"), pane);
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  const frame = page.locator(`.pane-frame[data-layout-pane="${pane}"]`);
  await frame.getByRole("log").getByText(EARLIER).waitFor();
  const box = frame.getByRole("textbox").first();
  await box.fill(message);
  await box.press("Enter");
  const note = frame.locator(".chat-unanswered-note");
  await frame.locator(".chat-turn-waiting").getByText(message).waitFor();
  await note.waitFor({ timeout: WAITING_SEND_MS + 15_000 });
  assert.match(await note.innerText(), /Not in the conversation\. If Codex showed an error, it is in the terminal\./u);
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.reload();
    await frame.locator(".chat-turn-unanswered").getByText(message).waitFor();
    await frame.getByRole("log").getByText(EARLIER).waitFor();
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, `chat-unanswered-send-${viewport.width}.png`) });
    }
  }
  await note.getByRole("button", { name: "Dismiss" }).click();
  await frame.locator(".chat-turn-unanswered").waitFor({ state: "detached" });
  await page.reload();
  await frame.getByRole("log").getByText(EARLIER).waitFor();
  assert.equal(await frame.locator(".chat-turn-unanswered").count(), 0, "a dismissed send stays dismissed");
  assert.deepEqual(errors, []);
  console.log("PASS a send the agent never records is said unanswered after a minute at rest, kept over a reload, and dismissed, at 1280 and 390");
} finally {
  const errors: unknown[] = [];
  try { await browser?.close(); } catch (error) { errors.push(error); }
  try { server?.stop(); } catch (error) { errors.push(error); }
  try { if (workspace) await workspaceClose(workspace); } catch (error) { errors.push(error); }
  try { rmSync(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  if (errors.length) { console.error(new AggregateError(errors, "unanswered send QA cleanup failed")); process.exitCode = 1; }
}
