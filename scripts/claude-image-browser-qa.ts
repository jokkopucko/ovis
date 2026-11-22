import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { claudeProjectDir } from "../server/claude-store.ts";
import { createServer } from "../server/index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

if (process.platform !== "linux" && process.platform !== "darwin") { console.log("SKIP the Claude stand-in needs a Unix process table"); process.exit(0); }

const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-claude-image-browser-")));
const store = join(root, ".claude");
const SESSION = "c1a0de00-0000-4000-8000-000000000992";
// real 1x1 files, so Chrome decodes them: a naturalWidth of 1 proves the bytes that arrived are a
// picture, not a broken-image placeholder
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GIF = "R0lGODlhAQABAPAAAAAA/////yH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==";
const ids = { ask: "00000000-0000-4000-8000-0000000000a1", read: "00000000-0000-4000-8000-0000000000a2", result: "00000000-0000-4000-8000-0000000000a3", answer: "00000000-0000-4000-8000-0000000000a4", abandoned: "00000000-0000-4000-8000-0000000000a5", abandonedAnswer: "00000000-0000-4000-8000-0000000000a6", picture: "00000000-0000-4000-8000-0000000000a7", pictureAnswer: "00000000-0000-4000-8000-0000000000a8" };
const at = (second: number) => `2026-10-24T00:00:${String(second).padStart(2, "0")}.000Z`;
const base = { isSidechain: false, userType: "external", cwd: root, sessionId: SESSION, version: "2.1.304" };
const user = (uuid: string, parentUuid: string | null, content: unknown, second: number) => ({ ...base, type: "user", uuid, parentUuid, timestamp: at(second), message: { role: "user", content } });
const assistant = (uuid: string, parentUuid: string, content: unknown[], stop_reason: string, second: number) => ({ ...base, type: "assistant", uuid, parentUuid, timestamp: at(second), message: { role: "assistant", content, stop_reason } });
const image = (media_type: string, data: string) => ({ type: "image", source: { type: "base64", media_type, data } });
const records = [
  user(ids.ask, null, "What is in shot.png?", 1),
  assistant(ids.read, ids.ask, [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: join(root, "shot.png") } }], "tool_use", 2),
  user(ids.result, ids.read, [{ type: "tool_result", tool_use_id: "toolu_read", content: [image("image/png", PNG)] }], 3),
  assistant(ids.answer, ids.result, [{ type: "text", text: "It is a single red pixel." }], "end_turn", 4),
  user(ids.abandoned, ids.answer, "A question the rewind took back", 5),
  assistant(ids.abandonedAnswer, ids.abandoned, [{ type: "text", text: "An answer the rewind took back." }], "end_turn", 6),
  user(ids.picture, ids.answer, [image("image/gif", GIF)], 7),
  assistant(ids.pictureAnswer, ids.picture, [{ type: "text", text: "That one is a blue pixel." }], "end_turn", 8),
];
const toolRef = `${ids.result}:0:0`;
const promptRef = `${ids.picture}:0`;

// the stand-in Claude: a renamed runtime that records itself as the session's process, the way
// Claude Code does under its config dir, and says when it has
const standIn = `
const fs = require("node:fs");
const net = require("node:net");
const [home, sessionId, port] = process.argv.slice(2);
if (process.platform === "linux") process.title = "claude";
const procStart = process.platform === "linux"
  ? fs.readFileSync("/proc/self/stat", "utf8").split(") ").pop().split(" ")[19]
  : require("node:child_process").execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, encoding: "utf8" }).trim();
const store = process.env.CLAUDE_CONFIG_DIR;
fs.mkdirSync(store + "/sessions", { recursive: true });
fs.writeFileSync(store + "/sessions/" + process.pid + ".json", JSON.stringify({ pid: process.pid, sessionId, cwd: home, procStart, kind: "interactive" }));
net.connect(Number(port), "127.0.0.1", function () { this.end(String(process.pid)); });
process.stdin.resume();
`;

let workspaceId: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const project = join(store, "projects", claudeProjectDir(root));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${SESSION}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  writeFileSync(join(root, "claude.cjs"), standIn);
  // Bun is self-contained on macOS, where Node's title setter would hide the environment ps reads
  const runtime = process.platform === "darwin" ? process.execPath : Bun.which("node");
  if (!runtime) throw new Error("the Claude stand-in needs Node");
  copyFileSync(runtime, join(root, "claude"));

  const created = await workspaceCreate({ cwd: root, label: "ovis-test-claude-image-browser" });
  workspaceId = created.workspace.workspace_id;
  const paneId = created.root_pane.pane_id;
  let ready: (pid: number) => void = () => {};
  const signal = new Promise<number>((resolve) => { ready = resolve; });
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(socket, data) { ready(Number(data.toString())); socket.end(); } } });
  const timeout = setTimeout(() => ready(0), 10_000);
  try {
    await herdrRpc("pane.send_text", { pane_id: paneId, text: `exec env CLAUDE_CONFIG_DIR=${JSON.stringify(store)} ${JSON.stringify(join(root, "claude"))} ${JSON.stringify(join(root, "claude.cjs"))} ${JSON.stringify(root)} ${SESSION} ${listener.port}\n` });
    if (!(await signal)) throw new Error("the Claude stand-in did not record its session");
  } finally { clearTimeout(timeout); listener.stop(true); }
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" });

  // tailscaleOwner null: the plain-HTTP page below must not be sent to pairing on a PC with Tailscale
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), tailscaleOwner: null });
  browser = await chromium.launch({ executablePath: chromePath(), headless: process.env["HEADED"] !== "1", args: ["--no-sandbox", "--no-proxy-server"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  const openChat = async (target: Page) => {
    await target.addInitScript((id) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
      localStorage.setItem(`ovis:view:${id}`, "chat");
    }, paneId);
    target.setDefaultTimeout(10_000);
    await target.goto(`http://127.0.0.1:${server!.port}/?pane=${encodeURIComponent(paneId)}`);
    await target.locator(".conn-live").waitFor();
    const chat = target.locator(`.pane-frame[data-layout-pane="${paneId}"]`).getByRole("log");
    await chat.getByText("That one is a blue pixel.", { exact: true }).waitFor();
    return chat;
  };
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const served = new Map<string, { status: number; type: string | null }>();
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.endsWith("/pane/conversation/image")) served.set(url.searchParams.get("ref") ?? "", { status: response.status(), type: response.headers()["content-type"] ?? null });
  });
  const log = await openChat(page);

  const prompts = log.locator(".chat-turn-user");
  assert.equal(await prompts.count(), 2, "the first question and the picture sent after the rewind");
  assert.equal(await log.getByText("A question the rewind took back").count(), 0, "the rewind's abandoned prompt stays hidden");
  assert.equal(await log.getByText("An answer the rewind took back.").count(), 0, "and so does its answer");
  const sent = prompts.nth(1).locator(".chat-user-images img");
  assert.equal(await sent.count(), 1);
  assert.equal(await prompts.nth(1).locator(".chat-bubble").count(), 0, "a picture alone draws no empty bubble");
  await sent.scrollIntoViewIfNeeded();
  await page.waitForFunction((ref) => [...document.querySelectorAll<HTMLImageElement>(".chat-user-images img")].some((img) => img.src.includes(encodeURIComponent(ref)) && img.complete && img.naturalWidth === 1), promptRef);
  assert.deepEqual(served.get(promptRef), { status: 200, type: "image/gif" });
  console.log("PASS a Claude prompt that is only a picture is its own turn, its thumbnail decoded, the rewind's turns hidden");

  const work = log.locator(".work-block-head");
  assert.equal(await work.count(), 1);
  assert.equal(await work.getAttribute("aria-expanded"), "false");
  const thumb = log.locator(".work-block-line .work-image img");
  assert.equal(await thumb.count(), 1);
  await thumb.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>(".work-block-line .work-image img");
    return img !== null && img.complete && img.naturalWidth === 1;
  });
  assert.deepEqual(served.get(toolRef), { status: 200, type: "image/png" });
  assert.equal(await log.locator(".work-block-line .work-image").getAttribute("aria-label"), "Image 1 from Read");
  console.log("PASS the folded line shows the picture Claude Code's Read returned, decoded from the served bytes");

  await work.click();
  assert.equal(await log.locator(".work-block-line .work-images").count(), 0);
  assert.equal(await log.locator(".work-row-line .work-image").count(), 1);
  await log.locator(".work-row-head").first().click();
  const shot = log.locator(".chat-tool-images img");
  assert.equal(await shot.count(), 1);
  await shot.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>(".chat-tool-images img");
    return img !== null && img.complete && img.naturalWidth === 1;
  });
  assert.equal(await shot.getAttribute("alt"), "Image 1 from Read");
  console.log("PASS an opened row shows the Read's picture in its detail");

  const missing = await page.request.get(`http://127.0.0.1:${server.port}/api/pane/conversation/image?${new URLSearchParams({ pane_id: paneId, ref: `${ids.result}:0:1` })}`);
  assert.equal(missing.status(), 404);
  assert.deepEqual(errors, []);

  const evidence = process.env["UI_EVIDENCE_DIR"];
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, "claude-images-desktop.png") });
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
    const small = await phone.newPage();
    const smallLog = await openChat(small);
    await small.screenshot({ path: join(evidence, "claude-images-phone-prompt.png") });
    const head = await smallLog.locator(".work-block-head").boundingBox();
    const line = await smallLog.locator(".work-block-line .work-image").boundingBox();
    assert.ok(head !== null && line !== null && Math.abs((line.y + line.height / 2) - (head.y + head.height / 2)) < 2, "the thumbnail sits on the folded line");
    await smallLog.locator(".work-block-head").click();
    await smallLog.locator(".work-row-head").first().click();
    await smallLog.locator(".chat-tool-images img").scrollIntoViewIfNeeded();
    await small.waitForFunction(() => document.querySelector<HTMLImageElement>(".chat-tool-images img")?.naturalWidth === 1);
    await small.screenshot({ path: join(evidence, "claude-images-phone-tool.png") });
    await phone.close();
  }
  console.log("PASS Claude Code pictures: browser OK");
} finally {
  await browser?.close();
  server?.stop();
  if (workspaceId !== undefined) await workspaceClose(workspaceId);
  rmSync(root, { recursive: true, force: true });
}
