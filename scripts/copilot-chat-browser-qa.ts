/** Owned native Copilot-shaped fixture -> Herdr -> HTTP -> built React chat. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, paneProcessInfo, paneRead, sessionSnapshot, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { UsageService } from "../server/usage.ts";
import { chromePath } from "./chrome-path.ts";

if (process.platform !== "linux") {
  console.log("SKIP native Copilot store requires Linux process descriptors");
  process.exit(0);
}
const root = mkdtempSync(join(tmpdir(), "herdr-copilot-browser-"));
const home = join(root, "copilot-home");
const id = "12aa83d8-48bc-41f2-a498-7055c5c44a01";
const directory = join(home, "session-state", id);
const transcript = join(directory, "events.jsonl");
const executable = join(root, "copilot.js");
const input = join(root, "received.txt");
const event = (type: string, data: object) => JSON.stringify({
  type, data, id: crypto.randomUUID(), timestamp: new Date().toISOString(), parentId: null,
}) + "\n";
const output = "fixture output ".repeat(430) + "COPILOT_OUTPUT_END";
let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  mkdirSync(directory, { recursive: true });
  writeFileSync(input, "");
  writeFileSync(transcript, event("session.start", { sessionId: id, copilotVersion: "1.0.102-1" })
    + event("user.message", { content: "A native Copilot prompt", transformedContent: "not visible", parentAgentTaskId: "root-task-id" })
    + event("assistant.message", { content: "Looking up the answer.", phase: "commentary", model: "fixture-model",
      toolRequests: [{ toolCallId: "fixture-call", name: "shell", arguments: { command: "pwd" }, toolTitle: "Check folder" },
        { toolCallId: "ask-call", name: "ask_user", arguments: { question: "Proceed with this choice?", choices: ["Yes", "No"] }, toolTitle: "Ask user" }] })
    + event("tool.execution_start", { toolCallId: "fixture-call", toolName: "shell", arguments: { command: "pwd" } })
    + event("tool.execution_complete", { toolCallId: "fixture-call", success: true, result: { content: output } })
    + event("tool.execution_complete", { toolCallId: "ask-call", success: true, result: { content: "Yes" } })
    + event("assistant.message", { content: "Native Copilot answer.", phase: "final_answer", model: "fixture-model" }));
  // A Node script named copilot is a genuine foreground process with a PID-held native
  // marker; its stdin remains the pane's PTY so the regular composer can reach it.
  writeFileSync(executable, `import { appendFileSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
process.title = "copilot";
const home = process.env.COPILOT_HOME;
const marker = join(home, "session-state", process.argv[2], \`inuse.\${process.pid}.hold\`);
mkdirSync(join(home, "session-state", process.argv[2]), { recursive: true });
openSync(marker, "w");
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at; (at = buffer.indexOf("\\n")) !== -1;) {
    appendFileSync(process.argv[3], buffer.slice(0, at) + "\\n");
    buffer = buffer.slice(at + 1);
  }
});
console.log("fixture ready");`);
  chmodSync(executable, 0o755);
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-copilot-browser" });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: pane, text: `COPILOT_HOME=${home} node ${executable} ${id} ${input}\n` });
  for (const deadline = Date.now() + 10_000;;) {
    if ((await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === pane)?.agent === "copilot") break;
    if (Date.now() > deadline) throw new Error(`owned Copilot fixture process was not detected: ${JSON.stringify({
      pane: (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === pane),
      process: await paneProcessInfo(pane),
      screen: await paneRead({ paneId: pane, source: "visible", format: "text" }),
    })}`);
    await Bun.sleep(50);
  }
  await herdrRpc("pane.report_agent_session", { pane_id: pane, agent: "copilot", source: "herdr:copilot",
    agent_session_id: id, seq: Date.now() * 1000 });
  server = createServer({ hostname: "127.0.0.1", port: 0, token: "", stateDir: join(root, "state"),
    herdrConfigPath: join(root, "config.toml"), usage: new UsageService(undefined, []), tailscaleOwner: null });
  const endpoint = `http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(pane)}`;
  const body = await (await fetch(endpoint)).json() as { source: string };
  assert.equal(body.source, "copilot-transcript");

  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, locale: "en-US" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(15_000);
  await page.addInitScript((paneId) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
    localStorage.setItem(`ovis:view:${paneId}`, "chat");
  }, pane);
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  const log = page.locator(`.pane-frame[data-layout-pane="${pane}"]`).getByRole("log");
  await log.getByText("Native Copilot answer.", { exact: true }).waitFor();
  await log.getByText("A native Copilot prompt", { exact: true }).waitFor();
  assert.equal((await log.innerText()).includes("not visible"), false);
  const head = log.locator(".work-block-head").first();
  if (await head.getAttribute("aria-expanded") !== "true") await head.click();
  await log.locator(".work-row-head").first().click();
  await log.locator(".chat-tool-more").click();
  // a long whole output opens folded to its head: its own Show all unfolds it
  await log.locator(".chat-tool-io.is-whole + .chat-tool-result-more[aria-expanded=false]").click();
  await log.getByText(/COPILOT_OUTPUT_END/).waitFor();
  await log.locator(".work-row-head").nth(1).click();
  await log.getByText("Proceed with this choice?").waitFor();
  await log.locator(".chat-ask-options").getByText("Yes", { exact: true }).waitFor();
  await log.locator(".chat-ask-options").getByText("No", { exact: true }).waitFor();
  appendFileSync(transcript, event("session.resume", { selectedModel: "fixture-model" })
    + event("user.message", { content: "Follow-up prompt" })
    + event("assistant.message", { content: "Follow-up answer.", phase: "final_answer", model: "fixture-model" }));
  await log.getByText("Follow-up answer.", { exact: true }).waitFor();
  appendFileSync(transcript, event("user.message", { content: "Finish task" })
    + event("assistant.message", { toolRequests: [{ toolCallId: "finish-call", name: "task_complete",
      arguments: { summary: "Autopilot finished this task." } }] })
    + event("tool.execution_complete", { toolCallId: "finish-call", success: true, result: { content: "done" } })
    + event("session.task_complete", { summary: "Autopilot finished this task." }));
  await log.getByText("Autopilot finished this task.", { exact: true }).waitFor();
  // Capture readable conversation, not a 6 KiB expanded tool detail.
  if (await head.getAttribute("aria-expanded") === "true") await head.click();
  if (process.env.UI_EVIDENCE_DIR) {
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "copilot-native-desktop.png"), animations: "disabled" });
  }
  for (const viewport of [{ width: 1100, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width === 390) {
      await page.locator("#workspace-drawer").waitFor({ state: "hidden" });
      await page.waitForFunction(() => {
        const drawer = document.querySelector("#workspace-drawer");
        return drawer === null || drawer.getBoundingClientRect().right <= 0 || getComputedStyle(drawer).display === "none";
      });
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "document must fit viewport");
    assert.equal(await log.evaluate((node) => node.scrollWidth <= node.clientWidth), true, "chat must not overflow horizontally");
  }
  if (process.env.UI_EVIDENCE_DIR) {
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "copilot-native-mobile.png"), animations: "disabled" });
  }
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Fixture composer send");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  for (const deadline = Date.now() + 10_000;;) {
    if (readFileSync(input, "utf8").includes("Fixture composer send")) break;
    if (Date.now() > deadline) throw new Error("composer text never reached owned Copilot fixture PTY");
    await Bun.sleep(50);
  }
  let unavailable = true;
  const conversationRoute = /\/api\/pane\/conversation\?/;
  await page.route(conversationRoute, (route) => unavailable
    ? route.fulfill({ json: { source: "scrollback", turns: [] } })
    : route.continue());
  appendFileSync(transcript, event("user.message", { content: "Recover after a transient lookup" })
    + event("assistant.message", { content: "Conversation recovered without switching lenses.", phase: "final_answer" }));
  await page.locator(".chat-terminal-fallback summary").waitFor();
  assert.equal(await log.getByText("Native Copilot answer.", { exact: true }).count(), 0, "unverified history is hidden");
  unavailable = false;
  await log.getByText("Conversation recovered without switching lenses.", { exact: true }).waitFor({ timeout: 4000 });
  await page.locator(".chat-terminal-fallback").waitFor({ state: "detached" });
  await page.unroute(conversationRoute);
  const readableHistory = readFileSync(transcript, "utf8");
  for (const [type, data] of [
    ["user.message", { content: [{ type: "text", text: "unsupported native content" }] }],
    ["assistant.message", { content: [{ type: "text", text: "unsupported native content" }] }],
    ["assistant.message", { toolRequests: ["unreadable request"] }],
    ["assistant.message", { content: "", toolRequests: { toolCallId: "call", name: "shell" } }],
  ] as const) {
    writeFileSync(transcript, event("session.start", { sessionId: id })
      + event(type, data));
    await page.locator(".chat-terminal-fallback summary").waitFor();
    assert.equal(await log.getByText("Conversation recovered without switching lenses.", { exact: true }).count(), 0);
    writeFileSync(transcript, readableHistory);
    await log.getByText("Conversation recovered without switching lenses.", { exact: true }).waitFor();
    await page.locator(".chat-terminal-fallback").waitFor({ state: "detached" });
  }
  assert.deepEqual(errors, []);
  console.log("PASS Copilot native HTTP/React, tool detail, append, desktop/mobile, PTY send, transient recovery and unsupported-content terminal fallback");
} finally {
  const failures: unknown[] = [];
  try { await browser?.close(); } catch (error) { failures.push(error); }
  try { server?.stop(); } catch (error) { failures.push(error); }
  try { if (workspace) await workspaceClose(workspace); } catch (error) { failures.push(error); }
  try { rmSync(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  if (failures.length) {
    console.error(new AggregateError(failures, "Copilot browser fixture cleanup failed"));
    process.exitCode = 1;
  }
}
