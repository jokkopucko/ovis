/** Mobile history regression using a real chat transcript and an owned herdr pane. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { forgetPageMedia, PAGE_MEDIA_LIFETIME_MS, pageFileHooks, pageMediaResponse } from "../server/file-view.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { openSettingsPage } from "./settings-page.ts";

/** a file action: its button in the header, or up to 600px the item in the header's More menu */
async function fileAction(scope: Locator | Page, name: string): Promise<Locator> {
  const link = scope.getByRole("link", { name, exact: true });
  if (await link.isVisible()) return link;
  const item = scope.getByRole("menuitem", { name, exact: true });
  if (!(await item.isVisible())) await scope.getByRole("button", { name: "More", exact: true }).click();
  await item.waitFor();
  return item;
}
import { sheetsSettled } from "./sheets-settled.ts";
import { runMoreItem } from "./header-more.ts";
import type { Machine } from "../shared/protocol.ts";
import { chromePath } from "./chrome-path.ts";
import { routeDrained } from "./drained-route.ts";
// machine events stay on SSE here: these checks hold or watch /api/machines/events (the socket transport has its own checks)
process.env["OVIS_MACHINE_EVENTS_WS"] = "0";

const openFiles = async (page: import("playwright-core").Page) => {
  const headerButton = page.locator(".header-files-button");
  if (await headerButton.isVisible()) await headerButton.click();
  else await runMoreItem(page, "Browse files");
};

// A loaded or reloaded chat scrolls to its end once its conversation is measured; the chat frame
// names its content only once it is presented there. Even then a link far above the end is no
// steady target for a pointer: a follow to the end still on its way moves it between pointer down
// and up, or takes its row and the focus away before a key, and nothing opens. Not even a wheel
// read back first holds still: the follow undid one in looped runs. Steps that check history and
// presentation, not pointer targeting, wait for the chat and activate the link where it is.
const transcriptSettled = (page: Page) => page.locator(".chat-frame[data-pane-content]").waitFor({ state: "attached" });
// A reload opens the chat where the reader left it (chatScrollMemory): one who clicked a link above the
// end comes back there, and the chat presents nothing away from the end. The reloads before a step that
// waits for the chat are a following reader's: the end, once the chat remembers it.
const reloadFollowingEnd = async (page: Page): Promise<void> => {
  await page.evaluate(() => { for (const node of document.querySelectorAll(".chat-view")) node.scrollTop = node.scrollHeight; });
  await page.waitForFunction(() => (JSON.parse(sessionStorage.getItem("ovis:chat-positions") ?? "[]") as [string, { atEnd: boolean }][]).every(([, place]) => place.atEnd));
  await page.reload();
};
const activateInTranscript = async (page: Page, link: Locator): Promise<void> => {
  await transcriptSettled(page);
  await link.dispatchEvent("click");
};

const root = mkdtempSync(join(tmpdir(), "ovis-file-back-"));
const reportServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
  '<!doctype html><h1>Same-host report</h1><a href="#details">Report details</a><section id="details">Details</section>',
  { headers: { "content-type": "text/html; charset=utf-8" } },
) });
const reportUrl = `http://127.0.0.1:${reportServer.port}/report`;
const codexHome = join(root, "codex-home");
const thread = "01a0c7a1-56d9-7e20-9f08-f7a2d973bc11";
mkdirSync(join(codexHome, "sessions"), { recursive: true });
const transcript = join(codexHome, "sessions", `rollout-2026-09-28T00-00-00-${thread}.jsonl`);
const chatImages = [
  "![Chat relative](./preview.svg)",
  `![Chat absolute](${join(root, "preview.svg")})`,
  `![Chat URI](${new URL(`file://${join(root, "preview.svg")}`).href})`,
  "![Chat encoded](./chart%20%23%3F%20%25%20%ED%95%9C%EA%B8%80.svg)",
  "![Chat missing](./missing.png)",
  "![Chat text](./notes.txt)",
  "![Chat external](https://example.com/unrequested.png)",
  "Before ![Chat broken inline](./broken.png) after",
].join("\n\n");
const fidelitySources = ["const last = 7;\n\n", "first\n", "first\n\nlast", "\n"];
writeFileSync(transcript, [
  { type: "session_meta", payload: { id: thread, cwd: root } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Show me the demo video." }] } },
  { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `Open [demo video](./preview.webm) or [notes](./notes.txt) or [guide](./docs/guide.md) or [big](./big.txt) or [big code](./big.ts) or [mid code](./mid.ts) or [deep quotes](./deep.md) or [empty](./empty.txt) or [slow preview](./slow.md) or [long notes](./long.md) or [many lines](./lines.txt) or [long list](./list.md) or [contents page](./toc.html) or [file URI notes](${new URL(`file://${join(root, "notes.txt")}`).href}) or [folder](${new URL(`file://${root}`).href}) or [web report](${reportUrl}).\n\n${new URL(`file://${join(root, "notes.txt")}`).href}\n\n\`\`\`ts\nconst answer = 42;\n\nexport { answer };\n\`\`\`\n\n${chatImages}` }] } },
  // a block the highlighter is quadratic on (a line of dashes in YAML): seconds on the page
  { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "References: [source column](./target.ts:60:8), [source range](./target.ts#L60-L65), [Markdown line](./docs/guide.md#L6), [past end](./notes.txt:999), [past preview](./big.txt:999999), [capped line](./lines.txt:5)." }] } },
  { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `Dashes:\n\n\`\`\`yaml\n${"-".repeat(90_000)}\n\`\`\`` }] } },
  // more lines than are drawn one element each (LINE_ELEMENT_LIMIT): 30 000 elements held the page
  { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `Lines:\n\n\`\`\`\n${"x\n".repeat(30_000)}\`\`\`` }] } },
  ...fidelitySources.map((source, index) => ({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `\`\`\`${index === 0 ? "ts" : "text"}\n${source}\n\`\`\`` }] } })),
  // a tool's output and a log in a plain code block name the files they wrote
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Take the screenshots." }] } },
  { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "shoot", arguments: JSON.stringify({ cmd: "python3 shoot.py --out shots/report.html" }) } },
  { type: "response_item", payload: { type: "function_call_output", call_id: "shoot", output: `${join(root, "shots", "t00000.png")} (1600, 1000) -> (1255, 960)\nsaved shots/report.html\ndisplay image 1: [image/png]` } },
  { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `Shots:\n\n\`\`\`\n${join(root, "shots", "t00000.png")} (1600, 1000) -> (1255, 960)\n\`\`\`` }] } },
  { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Kinds: [extensionless](./README), [unknown text](./notes.custom), [dotted folder](./folder.txt), [page media](./media/page-media.html)." }] } },
].map((row) => JSON.stringify(row)).join("\n"));
const db = new Database(join(codexHome, "state_5.sqlite"));
db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, first_user_message TEXT)");
db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1, 'cli', ?)").run(thread, transcript, root, "Show me the demo video.");
// a second folder with a notes.txt of its own: its pane's ./notes.txt is a file of the same path as the first pane's
const side = join(root, "side");
mkdirSync(side);
writeFileSync(join(side, "notes.txt"), "Side pane notes\n");
const sideThread = "01a0c7a1-56d9-7e20-9f08-f7a2d973bc12";
const sideTranscript = join(codexHome, "sessions", `rollout-2026-09-28T00-00-01-${sideThread}.jsonl`);
writeFileSync(sideTranscript, [
  { type: "session_meta", payload: { id: sideThread, cwd: side } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Where are the side notes?" }] } },
  { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Open [side notes](./notes.txt)." }] } },
].map((row) => JSON.stringify(row)).join("\n"));
db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1, 'cli', ?)").run(sideThread, sideTranscript, side, "Where are the side notes?");
db.close();
const standIn = join(root, "codex");
writeFileSync(standIn, "#!/bin/sh\nsleep 600\n");
chmodSync(standIn, 0o755);
copyFileSync(join(import.meta.dir, "fixtures", "file-preview.webm"), join(root, "preview.webm"));
writeFileSync(join(root, "notes.txt"), "File preview history regression\n");
writeFileSync(join(root, "README"), "Extensionless text\n");
writeFileSync(join(root, "notes.custom"), "Unknown extension text\n");
mkdirSync(join(root, "folder.txt"));
writeFileSync(join(root, "folder.txt", "inside.txt"), "Chosen inside the popup\n");
// a rendered page whose recording is too large to put into it (EMBED_FILE_BYTES in server/file-view.ts),
// so it plays from the address its render gives out: 1 150 s of silence as 8 kHz 8-bit mono WAV, 9.2 MB
mkdirSync(join(root, "media"));
const takeRate = 8_000;
const take = Buffer.alloc(44 + takeRate * 1_150, 0x80);
take.write("RIFF", 0);
take.writeUInt32LE(take.length - 8, 4);
take.write("WAVEfmt ", 8);
take.writeUInt32LE(16, 16);
// PCM, one channel, one byte a sample
take.writeUInt16LE(1, 20);
take.writeUInt16LE(1, 22);
take.writeUInt32LE(takeRate, 24);
take.writeUInt32LE(takeRate, 28);
take.writeUInt16LE(1, 32);
take.writeUInt16LE(8, 34);
take.write("data", 36);
take.writeUInt32LE(take.length - 44, 40);
writeFileSync(join(root, "media", "take.wav"), take);
writeFileSync(join(root, "media", "page-media.html"), `<!doctype html><meta charset="utf-8"><title>Page media</title><audio id="take" src="take.wav" preload="metadata" muted controls></audio>`);
const targetSource = Array.from({ length: 80 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join("\n") + "\n\n";
writeFileSync(join(root, "target.ts"), targetSource);
// in a subfolder, so a link is resolved from the file's folder (../notes.txt), not the pane's
mkdirSync(join(root, "docs"));
writeFileSync(join(root, "docs", "guide.md"), "# Guide\n\nSee [notes](../notes.txt).\n\n```ts\nconst x = 1;\n```\n");
// the viewer loads the first 256 KB of a Markdown file (TEXT_PREVIEW_BYTES in src/lib/filePreviewText.ts),
// and up to 8 MB or 200 000 lines of any other text (SOURCE_PREVIEW_BYTES, SOURCE_PREVIEW_LINES)
const TEXT_LOAD_LIMIT = 256 * 1024;
const SOURCE_LOAD_LIMIT = 8 * 1024 * 1024;
// plain text past the source budget, in lines long enough that the bytes cut it before the line cap
writeFileSync(join(root, "big.txt"), `a line of plain text, ${"0123456789".repeat(8)}\n`.repeat(Math.ceil((SOURCE_LOAD_LIMIT + 1024 * 1024) / 103)));
// code past the colors bound of a virtualized source (VIRTUAL_HIGHLIGHT_CHARS in src/lib/sourcePreview.ts): whole, plain
writeFileSync(join(root, "big.ts"), "export const value = 1;\n".repeat(Math.ceil((TEXT_LOAD_LIMIT + 1024) / 24)));
// code past an element per line (VIRTUAL_SOURCE_LINES) but within the colors bound: colored in the virtualizer's worker
writeFileSync(join(root, "mid.ts"), Array.from({ length: 3_000 }, (_, index) => `export const value${index + 1} = ${index + 1};`).join("\n") + "\n");
// 20 KB of nested quotes: parsed one level per `>`, they overflowed the stack and blanked the app
writeFileSync(join(root, "deep.md"), `${">".repeat(20_000)} deepest\n`);
// a YAML block of dashes in a Markdown file: seconds for the highlighter in Chromium as in Bun (8 s at
// 64 KB), while the Markdown parser reads it in a millisecond. A line of "[a" is slow in Bun alone:
// Chromium highlights 256 KB of it in under half a second, within the worker's budget.
writeFileSync(join(root, "slow.md"), `Notes on a slow file.\n\n\`\`\`yaml\n${"-".repeat(90_000)}\n\`\`\`\n`);
// ordinary Markdown past the load limit: its start is previewed
const longNotes = "# Notes\n\nA paragraph of ordinary notes, with *emphasis* and a [link](./notes.txt).\n\n".repeat(4_000);
writeFileSync(join(root, "long.md"), longNotes);
const longPrefix = longNotes.slice(0, TEXT_LOAD_LIMIT);
const longPreviewHeadings = longPrefix.slice(0, longPrefix.lastIndexOf("\n") + 1).split("\n").filter((line) => line.startsWith("# ")).length;
// more lines than the source budget keeps (SOURCE_PREVIEW_LINES): 256 KB of line breaks, cut at the line cap
writeFileSync(join(root, "lines.txt"), "\n".repeat(TEXT_LOAD_LIMIT));
// more list items than a Preview draws (PREVIEW_ELEMENT_LIMIT): 65 536 of them held the page 1.6 s
writeFileSync(join(root, "list.md"), "- a\n".repeat(TEXT_LOAD_LIMIT / 4));
// an empty file has no first byte: its range answers 416, which is not an error
writeFileSync(join(root, "empty.txt"), "");
mkdirSync(join(root, "shots"));
// a 1x1 PNG
writeFileSync(join(root, "shots", "t00000.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"));
// a page whose script runs, and reports what it may not reach: the network and this app's storage
writeFileSync(join(root, "shots", "report.html"), `<!doctype html><meta charset="utf-8"><title>Report</title><body><h1 id="ran">static</h1><p id="net">waiting</p><p id="store"></p><img id="shot" alt="shot" src="t00000.png"><p id="pic">no picture</p><script>
document.getElementById("shot").decode().then(() => { document.getElementById("pic").textContent = "picture drawn"; }, () => {});
document.getElementById("ran").textContent = "script ran";
try { localStorage.length; document.getElementById("store").textContent = "storage reachable"; } catch { document.getElementById("store").textContent = "no storage"; }
fetch("/api/health").then(() => { document.getElementById("net").textContent = "network reachable"; }, () => { document.getElementById("net").textContent = "network blocked"; });
</script></body>`);
// a page with a table of contents: an anchor the reader clicks inside the frame is a navigation of
// the frame's own, an entry in the session history above the preview's (#1203)
writeFileSync(join(root, "toc.html"), `<!doctype html><meta charset="utf-8"><title>Contents</title><body><nav><a id="toc" href="#details">Details</a></nav><p id="ran">static</p><p style="height:1200px">body</p><h2 id="details">Details</h2><script>document.getElementById("ran").textContent = "contents ran";</script></body>`);
const markdownPath = join(root, "preview #1 & 한글.MD");
const markdownSource = "<p align=\"center\">\n  <img src=\"./preview.svg\" alt=\"Logo\" width=\"64\">\n</p>\n\n<p align=\"center\"><a href=\"https://example.com/\">website</a> &middot; <strong>bold</strong></p>\n\n# Markdown preview\n\n한글 문서도 새 탭에서 읽을 수 있습니다.\n\n| Item | State |\n| --- | --- |\n| Preview | Ready |\n\n- [x] Rendered\n\nSee [the other notes](other.md).\n\n```ts\nconst answer = 42;\n```\n\n![Local image](./preview.svg)\n\n```mermaid\ngraph LR\n  A[Read] --> B[Preview]\n```\n";
writeFileSync(markdownPath, markdownSource);
writeFileSync(join(root, "other.md"), "# Other notes\n\nLinked from the preview.\n");
writeFileSync(join(root, "chart #? % 한글.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="teal"/></svg>');
writeFileSync(join(root, "preview.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="teal"/></svg>');
writeFileSync(join(root, "broken.png"), "not PNG bytes");
let workspace: string | undefined;
// a second workspace, for the pane moves of the docked block alone
let otherWorkspace: string | undefined;
// a third, in a folder of its own, for two files of the same path on two panes
let sideWorkspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  // An unborn repository is enough for Changes to show the untracked file; no fixture commit.
  const init = Bun.spawn(["git", "init", "-q", "-b", "main", root], { stdout: "pipe", stderr: "pipe" });
  assert.equal(await init.exited, 0, await new Response(init.stderr).text());
  writeFileSync(join(root, ".gitignore"), "*\n!notes.txt\n!preview.webm\n");
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-file-back" });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: pane, text: `${standIn} resume ${thread}\n` });
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { argv?: string[] }[] } }>("pane.process_info", { pane_id: pane });
    if (info.process_info?.foreground_processes?.some((process) => process.argv?.includes(standIn))) break;
    if (attempt === 99) throw new Error("test Codex process did not start");
    await Bun.sleep(50);
  }
  await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "codex", state: "idle", agent_session_path: transcript });
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), codexHome, tailnetPcs: { readStatus: async () => null }, sshCandidates: { sshDir: join(root, "no-ssh"), readStatus: async () => null } });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  // seeded once: a later step changes a setting and reloads. The chat's own font size and
  // family are set, so a Markdown preview can be shown to take them over. Long tasks are recorded
  // from the first paint: nothing an agent writes may hold the page for a second
  await page.addInitScript(() => {
    // the app's own document only: a sandboxed HTML page the viewer frames has no storage to seed
    if (window.top !== window) return;
    if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", chatFontSize: 17, chatFontFamily: "Georgia", fileOpen: "panel", webLinks: "panel" }));
    const record = window as unknown as { longTasks: number[] };
    record.longTasks = [];
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) record.longTasks.push(entry.duration); }).observe({ type: "longtask" });
  });
  // a freeze these guard lasts many seconds (the slow Markdown file highlighted on the page's own
  // thread held it past a 10s click); a loaded CI runner stretches the app's ordinary work to just
  // over 1s (1065ms seen on CI), which is no freeze
  const frozen = async () => (await page.evaluate(() => (window as unknown as { longTasks?: number[] }).longTasks ?? [])).filter((duration) => duration >= 2_000);
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A known prior document proves explicit close leaves no invisible preview entry.
  await page.goto(`${origin}/api/health`);
  await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor();
  const videoLink = page.getByRole("button", { name: "demo video", exact: true });
  await videoLink.waitFor();
  await page.locator(".markdown-code").first().locator(".hl-keyword", { hasText: "const" }).waitFor();
  await page.locator(".markdown-code .hl-number", { hasText: "42" }).waitFor();
  console.log("PASS Chat fenced code block is syntax highlighted");
  // A reader's wheel stops follow before lazy images above the newest turn are brought into view.
  await page.mouse.move(195, 300);
  await page.mouse.wheel(0, -10_000);
  for (const alt of ["Chat relative", "Chat absolute", "Chat URI", "Chat encoded"]) {
    const image = page.locator(`.chat-transcript img.markdown-image[alt="${alt}"]`);
    await page.waitForFunction((alt) => {
      const image = document.querySelector<HTMLImageElement>(`.chat-transcript img.markdown-image[alt="${alt}"]`);
      // A late skill render can replace this node too; start loading on the current incarnation.
      if (image) image.loading = "eager";
      return image?.complete && image.naturalWidth > 0;
    }, alt, { timeout: 10_000 });
    assert.equal(await image.evaluate((node: HTMLImageElement) => node.naturalWidth), 240);
    const url = new URL((await image.getAttribute("src"))!, origin);
    assert.equal(url.pathname, "/api/fs/file");
    assert.equal(url.searchParams.get("path"), join(root, alt === "Chat encoded" ? "chart #? % 한글.svg" : "preview.svg"));
    assert.equal(url.searchParams.get("pane_id"), pane);
  }
  for (const name of ["Chat missing", "Chat text", "Chat external"]) {
    await page.getByRole(name === "Chat external" ? "link" : "button", { name, exact: true }).waitFor();
    assert.equal(await page.locator(`img[alt="${name}"]`).count(), 0, `${name} stays a link`);
  }
  console.log("PASS Chat local Markdown images load from the pane cwd, absolute paths and file URIs; unresolved and external images stay links");

  // a blank line must survive in the text a copy picks up
  const codeText = await page.locator(".markdown-code .hl-code").first().innerText();
  if (codeText !== "const answer = 42;\n\nexport { answer };") throw new Error(`Chat code block text lost its blank line: ${JSON.stringify(codeText)}`);
  console.log("PASS Chat code block keeps its blank line in the text");
  const checkCodeFidelity = async (mode: string) => {
    for (const [index, source] of fidelitySources.entries()) {
      const block = page.locator(".markdown-code").nth(3 + index);
      assert.equal(await block.locator("code").textContent(), source, `${mode}: source whitespace`);
      // found and selected in one task: an answer's Markdown is drawn again once the pane's skill
      // list arrives (Markdown.tsx), which can fall between a locator's element handle and a later
      // call on it and leave that handle on a detached <pre>
      const selections = await page.evaluate(({ nth, source }) => {
        const pre = document.querySelectorAll(".markdown-code")[nth]!.querySelector("pre")!;
        const selection = window.getSelection()!;
        const select = (node: Node) => {
          const range = document.createRange(); range.selectNodeContents(node);
          selection.removeAllRanges(); selection.addRange(range);
          return selection.toString();
        };
        const actual = select(pre);
        const baseline = document.createElement("pre");
        const code = document.createElement("code"); code.textContent = source;
        baseline.append(code); document.body.append(baseline);
        const expected = select(baseline);
        baseline.remove(); selection.removeAllRanges();
        return { actual, expected };
      }, { nth: 3 + index, source });
      assert.equal(selections.actual, selections.expected, `${mode}: selection matches native pre/code`);
    }
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      // the block's box read in one task too, for the same redraw; the page is shot within it
      const clip = await page.evaluate(() => {
        const block = document.querySelectorAll(".markdown-code")[3]!;
        block.scrollIntoView({ block: "nearest" });
        const { x, y, width, height } = block.getBoundingClientRect();
        return { x, y, width, height };
      });
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `code-fidelity-${mode}.png`), clip });
    }
    console.log(`PASS ${mode}: trailing and interior blank lines match source and native selection`);
  };
  await checkCodeFidelity("highlight-on");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Keep my mobile draft");
  const chatUrl = page.url();
  await page.evaluate(() => {
    history.replaceState({ ...history.state, testMarker: "preserved" }, "");
    (window as unknown as { testDocument: string }).testDocument = "same-document";
  });
  const baseline = await page.evaluate(() => history.length);
  // a dialog below 980px, a panel beside the pane (role complementary) from there
  const preview = page.getByRole("dialog", { name: "preview.webm", exact: true }).or(page.getByRole("complementary", { name: "preview.webm", exact: true }));
  await videoLink.click();
  await preview.locator("video").waitFor();
  await page.waitForFunction(() => (document.querySelector("video")?.readyState ?? 0) >= 1);
  assert.equal(await page.evaluate(() => history.length), baseline + 1);
  // a phone's file header is one row: the name, its actions and Close side by side, no size/folder line
  const headerRow = await preview.locator(".file-viewer-header").evaluate((header) => {
    const middle = (element: Element | null) => { const box = element?.getBoundingClientRect(); return box ? box.top + box.height / 2 : NaN; };
    const meta = header.querySelector(".file-viewer-meta");
    return {
      title: middle(header.querySelector(".modal-title")),
      actions: middle(header.querySelector(".file-viewer-actions")),
      close: middle(header.querySelector(".file-viewer-close")),
      metaShown: meta !== null && getComputedStyle(meta).display !== "none",
    };
  });
  assert.ok(Math.abs(headerRow.title - headerRow.close) < 4 && Math.abs(headerRow.actions - headerRow.close) < 4,
    `a phone's file header keeps the name, the actions and Close on one row (${JSON.stringify(headerRow)})`);
  assert.equal(headerRow.metaShown, false, "a phone's file header leaves the size and folder out");
  if (process.env.UI_EVIDENCE_DIR) {
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "mobile-video-open.png") });
  }
  // The Android system Back button uses this same browser history traversal.
  await page.goBack();
  await preview.waitFor({ state: "hidden" });
  assert.equal(page.url(), chatUrl);
  assert.equal(await composer.inputValue(), "Keep my mobile draft");
  assert.equal(await page.evaluate(() => (window as unknown as { testDocument: string }).testDocument), "same-document");
  assert.equal(await page.evaluate(() => history.state.testMarker), "preserved");
  await videoLink.waitFor();
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "mobile-back-to-chat.png") });
  console.log("PASS mobile Back closes a playable video and preserves the chat document and draft");

  await page.goForward();
  await preview.waitFor();
  await preview.getByRole("button", { name: "Close file", exact: true }).click();
  await preview.waitFor({ state: "hidden" });
  // Repeated opens must not accumulate extra history entries.
  await videoLink.click();
  await preview.waitFor();
  assert.equal(await page.evaluate(() => history.length), baseline + 1);
  await page.keyboard.press("Escape");
  await preview.waitFor({ state: "hidden" });
  await videoLink.click();
  await preview.waitFor();
  // A press on the backdrop itself closes the viewer. On a touch device the viewer fills the
  // scrim edge to edge, so the press is sent to the scrim rather than aimed at an exposed pixel.
  // (From 980px the file is a panel beside the pane, with no scrim: see the docked block below.)
  await page.locator(".file-viewer-scrim").evaluate((scrim) => scrim.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  await preview.waitFor({ state: "hidden" });
  console.log("PASS Forward restores the viewer; X, Escape and scrim close consume its entry");

  // the one-row header's worst case, a Markdown dialog at 320px: Show source, Copy, More and Close
  // leave the name room, and More holds new tab, raw and download
  await page.setViewportSize({ width: 320, height: 700 });
  const narrowGuide = page.getByRole("dialog", { name: "guide.md", exact: true });
  await page.getByRole("button", { name: "guide", exact: true }).click();
  await narrowGuide.locator(".file-viewer-header .file-viewer-close").waitFor();
  const narrowRow = await narrowGuide.locator(".file-viewer-header").evaluate((header) => {
    const box = (selector: string) => header.querySelector(selector)?.getBoundingClientRect();
    const title = box(".modal-title"), close = box(".file-viewer-close"), actions = box(".file-viewer-actions");
    return { titleWidth: title?.width ?? 0, titleMiddle: title ? title.top + title.height / 2 : NaN, closeMiddle: close ? close.top + close.height / 2 : NaN, actionsRight: actions?.right ?? NaN, closeLeft: close?.left ?? NaN };
  });
  assert.ok(Math.abs(narrowRow.titleMiddle - narrowRow.closeMiddle) < 4 && narrowRow.actionsRight <= narrowRow.closeLeft + 1,
    `a 320px Markdown header stays one row (${JSON.stringify(narrowRow)})`);
  assert.ok(narrowRow.titleWidth >= 64, `a 320px Markdown header leaves the name room (${narrowRow.titleWidth}px)`);
  await narrowGuide.getByRole("button", { name: "More", exact: true }).click();
  assert.deepEqual((await narrowGuide.getByRole("menuitem").allTextContents()).map((item) => item.trim()), ["Open in a new tab", "Open raw file", "Download"]);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Open in a new tab", "More's menu takes the focus on its first item");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Open raw file", "Down moves to the next item");
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "mobile-markdown-more-320.png") });
  await page.keyboard.press("Escape");
  await narrowGuide.getByRole("menu").waitFor({ state: "detached" });
  assert.equal(await narrowGuide.count(), 1, "Escape closes the More menu, not the file");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "More", "and gives the focus back to More");
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "mobile-markdown-320.png") });
  await page.goBack();
  await narrowGuide.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 390, height: 844 });
  console.log("PASS a phone's Markdown header stays one row at 320px and keeps new tab, raw and download in More");

  // The Settings shortcut must open a visible dialog above the preview. Its history entries
  // retain the file beneath it, so only Settings may handle Escape until those entries land.
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await videoLink.click();
    await preview.waitFor();
    const previewEntry = await page.evaluate(() => history.state["ovis:file-preview"]);
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.waitFor();
    await page.waitForFunction(() => history.state?.["ovis:settings"] !== undefined);
    // a phone's Settings rises over the preview (styles.css): look where it comes to rest
    await sheetsSettled(page);
    const settingsClose = settings.getByRole("button", { name: "Close settings", exact: true });
    assert.equal(await settingsClose.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return Boolean(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest(".settings-dialog"));
    }), true, `Settings is above the preview at ${width}px`);
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `settings-over-preview-${width}.png`) });
    // two traps are open: only the one in front moves the focus, so Tab walks Settings' controls
    // instead of being sent back to its first one by the preview's trap beneath
    const focused: string[] = [];
    for (let press = 0; press < 3; press++) {
      await page.keyboard.press("Tab");
      focused.push(await page.evaluate(() => {
        const active = document.activeElement;
        return active?.closest(".settings-dialog") ? active.outerHTML.slice(0, 120) : `outside: ${active?.outerHTML.slice(0, 80)}`;
      }));
    }
    assert.ok(focused.every((entry) => !entry.startsWith("outside")), `Tab stays inside Settings at ${width}px: ${focused.join(" | ")}`);
    // Settings has two stops on a phone (Close, and the one focusable tab of its roving list): Tab
    // moves between them; the trap beneath held it on the first
    assert.ok(new Set(focused).size >= 2 && focused[0] !== focused[1], `Tab moves through Settings at ${width}px: ${focused.join(" | ")}`);
    await page.keyboard.press("Escape");
    await settings.waitFor({ state: "hidden" });
    await page.waitForFunction(() => history.state?.["ovis:settings"] === undefined);
    await preview.waitFor();
    assert.deepEqual(await page.evaluate(() => history.state["ovis:file-preview"]), previewEntry, "Escape closes only Settings and preserves the preview entry");
    await preview.getByRole("button", { name: "Close file", exact: true }).click();
    await preview.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => history.state?.["ovis:file-preview"]), undefined, "one click on Close file consumes the preview entry");
    assert.equal(await composer.inputValue(), "Keep my mobile draft");

    // System Back follows the same order, preserving the document instead of closing the file.
    await videoLink.click();
    await preview.waitFor();
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await settings.waitFor();
    await page.waitForFunction(() => history.state?.["ovis:settings"] !== undefined);
    await page.goBack();
    await settings.waitFor({ state: "hidden" });
    await preview.waitFor();
    await preview.getByRole("button", { name: "Close file", exact: true }).click();
    await preview.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => (window as unknown as { testDocument: string }).testDocument), "same-document");
    console.log(`PASS Settings opens above the preview at ${width}px; Escape and Back preserve it, then X closes the file once`);
  }

  // Add PC from Settings over a preview: Settings closes, the preview stays mounted beneath, and
  // the native modal Add PC opens is on top. Tab walks Add PC's own controls; the preview's trap
  // must not take it back to its own, now inert, controls.
  await page.setViewportSize({ width: 1280, height: 800 });
  await videoLink.click();
  await preview.waitFor();
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  const settingsOverPreview = page.getByRole("dialog", { name: "Settings", exact: true });
  await settingsOverPreview.waitFor();
  await openSettingsPage(page, "Devices and PCs");
  // Add PC opens from Add a connection's SSH tab, with the address typed there
  await settingsOverPreview.getByRole("button", { name: "Add a connection", exact: true }).click();
  const connectDevice = page.getByRole("dialog", { name: "Add a connection", exact: true });
  await connectDevice.locator('.connect-tabs [data-tab="ssh"]').click();
  await connectDevice.getByLabel("Or type an SSH address", { exact: true }).fill("qa@pc.invalid");
  await connectDevice.locator(".connect-ssh-form").getByRole("button", { name: "Add", exact: true }).click();
  const addPc = page.locator("dialog.machine-dialog");
  await addPc.waitFor();
  await settingsOverPreview.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".file-viewer").count(), 1, "the preview stays beneath Add PC");
  await page.waitForFunction(() => Boolean(document.activeElement?.closest("dialog.machine-dialog")));
  const addPcFocus: string[] = [];
  for (let press = 0; press < 3; press++) {
    await page.keyboard.press("Tab");
    addPcFocus.push(await page.evaluate(() => {
      const active = document.activeElement;
      return active?.closest("dialog.machine-dialog") ? active.outerHTML.slice(0, 120) : `outside: ${active?.outerHTML.slice(0, 80)}`;
    }));
  }
  assert.ok(addPcFocus.every((entry) => !entry.startsWith("outside")), `Tab stays inside Add PC over a preview: ${addPcFocus.join(" | ")}`);
  assert.ok(new Set(addPcFocus).size >= 2, `Tab moves through Add PC over a preview: ${addPcFocus.join(" | ")}`);
  // Escape is Add PC's too: it closes Add PC alone, and the preview and its entry stay
  const previewUnderAddPc = await page.evaluate(() => history.state["ovis:file-preview"]);
  await page.keyboard.press("Escape");
  await addPc.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".file-viewer").count(), 1, "Escape over Add PC leaves the preview beneath it");
  assert.deepEqual(await page.evaluate(() => history.state["ovis:file-preview"]), previewUnderAddPc, "Escape over Add PC preserves the preview entry");
  await preview.getByRole("button", { name: "Close file", exact: true }).click();
  await preview.waitFor({ state: "hidden" });
  console.log("PASS Add PC opened from Settings over a preview keeps Tab inside Add PC, and its Escape closes Add PC alone");

  // With no preview beneath it, Settings stays on the layer every dialog shares, so the palette
  // its shortcut opens is drawn above Settings instead of taking focus and Escape unseen.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  const settingsAlone = page.getByRole("dialog", { name: "Settings", exact: true });
  await settingsAlone.waitFor();
  await page.waitForFunction(() => history.state?.["ovis:settings"] !== undefined);
  await page.keyboard.press("ControlOrMeta+Shift+K");
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
  const paletteSearch = palette.getByRole("searchbox", { name: "Search panes and actions", exact: true });
  await paletteSearch.waitFor();
  assert.equal(await paletteSearch.evaluate((input) => {
    const rect = input.getBoundingClientRect();
    return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input;
  }), true, "the command palette is above Settings");
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "palette-over-settings-1280.png") });
  await page.keyboard.press("Escape");
  await palette.waitFor({ state: "hidden" });
  await settingsAlone.waitFor();
  await page.keyboard.press("Escape");
  await settingsAlone.waitFor({ state: "hidden" });
  await page.waitForFunction(() => history.state?.["ovis:settings"] === undefined);
  console.log("PASS the command palette opens above Settings; Escape closes the palette, then Settings");

  // Over Settings raised above a preview, too, the palette it opens is the top layer: it takes
  // focus and Escape, so it must not be drawn beneath either of them.
  await videoLink.click();
  await preview.waitFor();
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await settingsAlone.waitFor();
  await page.waitForFunction(() => history.state?.["ovis:settings"] !== undefined);
  await page.keyboard.press("ControlOrMeta+Shift+K");
  await paletteSearch.waitFor();
  const topmost = (input: Element) => {
    const rect = input.getBoundingClientRect();
    return { above: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input, focused: document.activeElement === input };
  };
  // the palette takes focus once it has mounted: wait for that, then say which part is missing
  await page.waitForFunction((input) => {
    const rect = input!.getBoundingClientRect();
    return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input && document.activeElement === input;
  }, await paletteSearch.elementHandle(), { timeout: 5000 }).catch(() => undefined);
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "palette-over-settings-over-preview-1280.png") });
  assert.deepEqual(await paletteSearch.evaluate(topmost), { above: true, focused: true }, "the command palette is above Settings and the preview, and has focus");
  await page.keyboard.press("Escape");
  await palette.waitFor({ state: "hidden" });
  await settingsAlone.waitFor();
  await preview.waitFor();
  await page.keyboard.press("Escape");
  await settingsAlone.waitFor({ state: "hidden" });
  await preview.waitFor();
  await preview.getByRole("button", { name: "Close file", exact: true }).click();
  await preview.waitFor({ state: "hidden" });
  console.log("PASS the command palette opens above Settings over a preview; Escape closes the palette, then Settings, then X the file");

  // Wide windows choose by kind, and an explicit move replaces only the preview's entry.
  const notesLink = page.getByRole("button", { name: "notes", exact: true });
  const textPopup = page.getByRole("dialog", { name: "notes.txt", exact: true });
  const panel = page.locator("aside.file-panel");
  const setFileOpen = async (fileOpen: string | null) => {
    await page.evaluate((fileOpen) => {
      const { fileOpen: _, ...settings } = JSON.parse(localStorage.getItem("ovis:settings") ?? "{}") as Record<string, unknown>;
      localStorage.setItem("ovis:settings", JSON.stringify(fileOpen === null ? settings : { ...settings, fileOpen }));
    }, fileOpen);
    await reloadFollowingEnd(page);
  };
  // with Open files at its default, even text opens in the popup; Beside the pane is a choice
  await setFileOpen(null);
  await activateInTranscript(page, notesLink);
  await textPopup.getByText("File preview history regression", { exact: true }).waitFor();
  assert.equal(await panel.count(), 0, "text starts in the popup at 1280px by default");
  await textPopup.getByRole("button", { name: "Close file", exact: true }).click();
  await textPopup.waitFor({ state: "detached" });
  await setFileOpen("panel");
  console.log("PASS by default a text file opens in the popup on a wide window");
  const beforePlacement = await page.evaluate(() => history.state);
  // setFileOpen reloaded the page: its follow to the end can take the link from under a pointer
  await activateInTranscript(page, videoLink);
  await page.locator(".modal.file-viewer video").waitFor();
  assert.equal(await panel.count(), 0, "video starts in the popup at 1280px");
  const videoHistoryLength = await page.evaluate(() => history.length);
  await preview.getByRole("button", { name: "Show beside the pane", exact: true }).click();
  await panel.locator("video").waitFor();
  assert.equal(await page.evaluate(() => history.length), videoHistoryLength, "moving a video adds no entry");
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "video-moved-to-panel-1280.png") });
  await panel.getByRole("button", { name: "Close file", exact: true }).click();
  await panel.waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => history.state), beforePlacement, "one Close consumes the moved video's entry");
  await notesLink.press("Enter");
  await panel.getByText("File preview history regression", { exact: true }).waitFor();
  const textHistoryLength = await page.evaluate(() => history.length);
  await panel.getByRole("button", { name: "Show as a popup", exact: true }).click();
  await textPopup.waitFor();
  assert.equal(await panel.count(), 0, "moving text removes its panel");
  await page.reload();
  await textPopup.getByText("File preview history regression", { exact: true }).waitFor();
  assert.equal(await panel.count(), 0, "reload keeps the explicit popup choice");
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "text-moved-to-popup-1280.png") });
  await page.goBack();
  await textPopup.waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => history.state), beforePlacement, "one Back consumes the moved text entry");
  await page.goForward();
  await textPopup.waitFor();
  await textPopup.getByRole("button", { name: "Show beside the pane", exact: true }).click();
  await panel.getByText("File preview history regression", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => history.length), textHistoryLength, "reload, Forward and moves add no entry");
  await panel.getByRole("button", { name: "Close file", exact: true }).click();
  await panel.waitFor({ state: "detached" });
  console.log("PASS video defaults to popup, text defaults to panel, both move, reload and Forward keep the choice, and Close/Back consume one entry");

  // From 980px a text file opens in a panel beside the pane, not a dialog over it: no scrim, the pane
  // keeps its clicks, the panel's left edge drags its width (kept on this device across a reload),
  // Escape closes it only from inside it, and Close file takes the panel and its entry away.
  const panelWidth = () => panel.evaluate((element) => element.getBoundingClientRect().width);
  await notesLink.press("Enter");
  await panel.getByText("File preview history regression", { exact: true }).waitFor();
  assert.equal(await page.locator(".modal-scrim, .file-viewer-scrim, .modal.file-viewer, [aria-modal='true']").count(), 0, "a docked file has no scrim and no dialog");
  const paneBox = await page.locator(".app-body > .pane-column").boundingBox();
  const panelBox = await panel.boundingBox();
  assert.ok(paneBox && panelBox && paneBox.x + paneBox.width <= panelBox.x + 1, `the pane ends where the panel starts: ${JSON.stringify({ paneBox, panelBox })}`);
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "file-panel-docked-1280.png") });
  // a click on the pane lands in it (Playwright refuses a click a layer would take), and the panel stays
  await composer.click();
  assert.equal(await composer.evaluate((input) => document.activeElement === input), true, "the pane beside the panel takes a click");
  assert.equal(await panel.count(), 1, "a click in the pane leaves the panel open");
  assert.equal(await composer.inputValue(), "Keep my mobile draft");
  // Escape from inside the panel closes it and takes its entry off, and the focus it held goes
  // back to the link that opened the file, as it does from the popup
  await panel.locator(".file-panel-resizer").focus();
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => history.state?.["ovis:file-preview"]), undefined, "Escape in the panel consumes the preview entry");
  // A history traversal removes the panel and restores focus: detachment alone is not the
  // focus signal. Keep the focus assertion, but wait for the state it actually checks.
  await page.waitForFunction((link) => document.activeElement === link, await notesLink.elementHandle());
  assert.equal(await notesLink.evaluate((link) => document.activeElement === link), true, "Escape in the panel returns the focus to the link that opened the file");
  // the left edge dragged 100px to the left widens the panel by as much, and the width is stored
  await notesLink.press("Enter");
  await panel.getByText("File preview history regression", { exact: true }).waitFor();
  const before = await panelWidth();
  const grip = await panel.locator(".file-panel-resizer").boundingBox();
  assert.ok(grip, "the panel's edge is laid out");
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 100, grip.y + grip.height / 2, { steps: 5 });
  await page.mouse.up();
  const stored = Number(await (await page.waitForFunction(() => localStorage.getItem("ovis:file-panel-width"))).jsonValue());
  assert.ok(Math.abs(stored - (before + 100)) <= 2, `dragging the edge 100px widens the panel 100px: ${before} -> ${stored}`);
  await page.waitForFunction((want) => Math.abs((document.querySelector("aside.file-panel")?.getBoundingClientRect().width ?? 0) - want) <= 1, stored);
  // a reload restores the file from its entry, at the stored width
  await reloadFollowingEnd(page);
  await panel.getByText("File preview history regression", { exact: true }).waitFor();
  assert.ok(Math.abs(await panelWidth() - stored) <= 1, `a reload keeps the dragged width: ${await panelWidth()} vs ${stored}`);
  // a double-click on the edge puts the default width back and forgets the stored one, so the
  // steps after this one see the panel as a fresh device does
  await panel.locator(".file-panel-resizer").dblclick();
  await page.waitForFunction(() => localStorage.getItem("ovis:file-panel-width") === null);
  await page.waitForFunction((want) => Math.abs((document.querySelector("aside.file-panel")?.getBoundingClientRect().width ?? 0) - want) <= 1, before);
  await panel.getByRole("button", { name: "Close file", exact: true }).click();
  await panel.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => history.state?.["ovis:file-preview"]), undefined, "Close file consumes the preview entry");
  console.log("PASS from 980px a file is a panel beside the pane: no scrim, the pane takes clicks, its edge drags and keeps its width, Escape inside and Close file close it");
  // a page the reader navigates inside its frame (a click on its table of contents; a script setting
  // location.hash once the page has loaded does the same) puts an entry of its own above the
  // preview's in the session history: Close file and Escape must still close the panel and consume
  // the preview's entry, not step the frame back and leave the panel there (#1203)
  const contentsLink = page.getByRole("button", { name: "contents page", exact: true });
  for (const close of ["Close file", "Escape"]) {
    await activateInTranscript(page, contentsLink);
    const framed = page.frameLocator(".file-viewer-page");
    // a page's scripts wait for the person: the panel says so, and the press runs them
    await panel.getByRole("button", { name: "Run scripts", exact: true }).click();
    await framed.getByText("contents ran", { exact: true }).waitFor();
    const opened = await page.evaluate(() => history.length);
    // the frame's own navigation is under test, not where the panel lays the frame out: a pointer
    // aimed at the link while the panel settles can miss it, and no entry is made
    await framed.locator("#toc").dispatchEvent("click");
    await page.waitForFunction((length) => history.length === length + 1, opened);
    if (close === "Escape") { await panel.locator(".file-panel-resizer").focus(); await page.keyboard.press("Escape"); }
    else await panel.getByRole("button", { name: "Close file", exact: true }).click();
    await panel.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => history.state?.["ovis:file-preview"]), undefined, `${close} consumes the preview entry under a page the reader navigated inside its frame`);
  }
  console.log("PASS from 980px a page the reader navigated inside its frame still closes on Close file and Escape, consuming the preview's entry");
  // a file chosen in the Files dialog opens in the panel, and the dialog, which would cover it, closes
  await openFiles(page);
  const filesDialog = page.getByRole("dialog", { name: "Files", exact: true });
  await filesDialog.getByRole("button", { name: /preview\.webm/ }).click();
  await page.locator(".modal.file-viewer video").waitFor();
  assert.equal(await filesDialog.count(), 1, "a media popup stacks over Files");
  await preview.getByRole("button", { name: "Close file", exact: true }).click();
  await preview.waitFor({ state: "detached" });
  await filesDialog.waitFor();
  await filesDialog.getByRole("button", { name: /notes\.txt/ }).click();
  await filesDialog.waitFor({ state: "detached" });
  await panel.getByText("File preview history regression", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Close file", exact: true }).click();
  await panel.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => history.state?.["ovis:file-preview"]), undefined, "Close file consumes the entry of a file opened from Files");
  console.log("PASS from 980px a file opened from the Files dialog shows in the panel and the dialog closes");

  for (const [label, content] of [["extensionless", "Extensionless text"], ["unknown text", "Unknown extension text"]] as const) {
    const link = page.getByRole("button", { name: label, exact: true });
    // the panel just closed: the chat takes its width back and its rows move under a pointer. The
    // link that opens the file holds the focus, as a click leaves it, for the return checked below
    await transcriptSettled(page);
    await link.focus();
    await link.dispatchEvent("click");
    await panel.getByText(content, { exact: true }).waitFor();
    assert.equal(await page.locator(".modal.file-viewer").count(), 0, "real text metadata corrects an unknown-extension popup guess");
    await panel.getByRole("button", { name: "Close file", exact: true }).click();
    await panel.waitFor({ state: "detached" });
    // whether the panel was the first guess or the correction of a popup, Close file gives the focus back to the link
    assert.equal(await link.evaluate((button) => document.activeElement === button), true, `Close file returns the focus to the ${label} link that opened the file`);
  }
  await page.getByRole("button", { name: "dotted folder", exact: true }).click();
  const folderPopup = page.locator(".modal.file-viewer");
  await folderPopup.getByRole("button", { name: /inside\.txt/ }).waitFor();
  assert.equal(await panel.count(), 0, "a 404 directory listing corrects a text-extension panel guess");
  await folderPopup.getByRole("button", { name: /inside\.txt/ }).click();
  const insidePopup = page.getByRole("dialog", { name: "inside.txt", exact: true });
  await insidePopup.getByText("Chosen inside the popup", { exact: true }).waitFor();
  await page.reload();
  await insidePopup.getByText("Chosen inside the popup", { exact: true }).waitFor();
  assert.equal(await panel.count(), 0, "choosing text inside a popup keeps the popup across reload");
  await insidePopup.getByRole("button", { name: "Close file", exact: true }).click();
  await insidePopup.waitFor({ state: "detached" });
  console.log("PASS late metadata corrects extensionless text and a dotted directory; choosing a file inside keeps the presentation");

  // Remembered maxima must yield to the pane, both after reload and a viewport reduction.
  await notesLink.press("Enter");
  await panel.getByText("File preview history regression", { exact: true }).waitFor();
  await page.evaluate(() => {
    localStorage.setItem("ovis:sidebar-width", "520");
    localStorage.setItem("ovis:file-panel-width", "900");
  });
  await page.reload();
  await panel.getByText("File preview history regression", { exact: true }).waitFor();
  const showSidebar = page.getByRole("button", { name: "Show workspace list", exact: true });
  if (await showSidebar.count()) await showSidebar.click();
  for (const width of [1280, 981, 980]) {
    await page.setViewportSize({ width, height: 800 });
    if (width === 980) {
      await page.reload();
      await panel.getByText("File preview history regression", { exact: true }).waitFor();
    }
    const geometry = await page.evaluate(() => ({
      pane: document.querySelector(".pane-column")?.getBoundingClientRect().width ?? 0,
      panelRight: document.querySelector(".file-panel")?.getBoundingClientRect().right ?? Infinity,
      sidebar: document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0,
      viewport: window.innerWidth,
    }));
    assert.equal(geometry.sidebar, Math.min(520, width / 2), "the sidebar is expanded at its maximum");
    assert.ok(geometry.pane >= 320, `a maximum sidebar and panel leave a 320px pane: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.panelRight <= geometry.viewport, `the panel stays inside the viewport: ${JSON.stringify(geometry)}`);
    const separator = panel.getByRole("separator", { name: "Resize file panel", exact: true });
    await separator.focus();
    await page.keyboard.press("End");
    await page.waitForFunction(() => {
      const panel = document.querySelector(".file-panel");
      const edge = panel?.querySelector("[role='separator']");
      return edge?.getAttribute("aria-valuemax") === String(Math.floor(panel?.getBoundingClientRect().width ?? 0));
    });
    assert.equal(Number(await separator.getAttribute("aria-valuemin")), Math.min(320, Math.floor(width - geometry.sidebar - 320)));
    assert.ok(Number(await separator.getAttribute("aria-valuenow")) <= Number(await separator.getAttribute("aria-valuemax")), "fractional layout widths never exceed the integer ARIA maximum");
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `file-panel-maxima-${width}.png`) });
  }
  await panel.getByRole("button", { name: "Close file", exact: true }).click();
  await panel.waitFor({ state: "detached" });
  await page.evaluate(() => {
    localStorage.removeItem("ovis:sidebar-width");
    localStorage.removeItem("ovis:file-panel-width");
  });
  await page.reload();
  await videoLink.waitFor();
  console.log("PASS remembered width maxima at 1280px and 980px preserve a 320px pane, keep the panel onscreen, and match the resizer limits");

  // The file beside the pane is the pane's: selecting another pane closes it, and the move takes
  // the file's entry over, so Back returns to the first pane without the file (DESIGN.md)
  const other = await workspaceCreate({ cwd: root, label: "ovis-test-file-back-other" });
  otherWorkspace = other.workspace.workspace_id;
  const otherPane = other.root_pane.pane_id;
  const selectedPane = () => page.evaluate(() => new URLSearchParams(location.search).get("pane"));
  const rowOf = (paneId: string) => page.locator(`.workspace-select[data-pane=${JSON.stringify(paneId)}]`);
  if (await showSidebar.count()) await showSidebar.click();
  await rowOf(otherPane).waitFor();
  await notesLink.press("Enter");
  await panel.getByText("File preview history regression", { exact: true }).waitFor();
  const openLength = await page.evaluate(() => history.length);
  await rowOf(otherPane).click();
  await page.waitForFunction((paneId) => new URLSearchParams(location.search).get("pane") === paneId, otherPane);
  // the panel unmounts on the render after the address moves: wait for that, bounded, then judge
  await panel.waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
  assert.equal(await panel.count(), 0, "selecting another pane closes the file open beside the first");
  assert.equal(await page.evaluate(() => history.length), openLength, "the move takes the file's entry over: no entry is pushed");
  assert.equal(await page.evaluate(() => history.state?.["ovis:file-preview"]), undefined, "the other pane's entry holds no file");
  assert.equal(new URL(page.url()).searchParams.has("file"), false, "the other pane's address names no file");
  await page.goBack();
  await page.waitForFunction((paneId) => new URLSearchParams(location.search).get("pane") === paneId, pane);
  assert.equal(await panel.count(), 0, "Back returns to the first pane without the file");
  assert.equal(await page.evaluate(() => history.state?.["ovis:file-preview"]), undefined, "Back lands on no file entry");
  assert.equal(new URL(page.url()).searchParams.has("file"), false, "the first pane's address names no file either");
  console.log("PASS selecting another pane closes the panel and takes its entry over; Back returns to the pane without the file");
  // two moves (there and back) leave entries behind the pane: the handoff below then has room for a stray second step to show
  await rowOf(otherPane).click();
  await page.waitForFunction((paneId) => new URLSearchParams(location.search).get("pane") === paneId, otherPane);
  await rowOf(pane).click();
  await page.waitForFunction((paneId) => new URLSearchParams(location.search).get("pane") === paneId, pane);
  await videoLink.waitFor();

  await openFiles(page);
  await filesDialog.getByRole("button", { name: "Changes", exact: true }).click();
  const beforeMediaDiff = await page.evaluate(() => history.state);
  await filesDialog.locator(".repo-change").filter({ hasText: "preview.webm" }).click();
  const mediaDiff = page.locator(".repo-diff-viewer");
  await mediaDiff.waitFor();
  await mediaDiff.getByRole("button", { name: "Open file", exact: true }).click();
  await page.locator(".modal.file-viewer video").waitFor();
  assert.equal(await mediaDiff.count(), 1, "wide media popup keeps the diff beneath it");
  assert.equal(await panel.count(), 0, "wide media handoff does not dock");
  await preview.getByRole("button", { name: "Close file", exact: true }).click();
  await preview.waitFor({ state: "detached" });
  await mediaDiff.getByRole("button", { name: "Open file", exact: true }).click();
  await page.locator(".modal.file-viewer video").waitFor();
  await preview.getByRole("button", { name: "Show beside the pane", exact: true }).click();
  await panel.locator("video").waitFor();
  await mediaDiff.waitFor({ state: "detached" });
  await filesDialog.waitFor({ state: "detached" });
  await panel.getByRole("button", { name: "Close file", exact: true }).click();
  await panel.waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => history.state), beforeMediaDiff, "moving a stacked popup to the panel hands off the diff entry; one Close returns to its opener");
  // two clicks on Show beside the pane before the first has landed (or a text file's automatic
  // move in the same moment) collapse the stack once, not twice: a second pair of steps would
  // land on the pane moves above and open the file a second time
  await openFiles(page);
  await filesDialog.getByRole("button", { name: "Changes", exact: true }).click();
  await filesDialog.locator(".repo-change").filter({ hasText: "preview.webm" }).click();
  await mediaDiff.waitFor();
  await mediaDiff.getByRole("button", { name: "Open file", exact: true }).click();
  await page.locator(".modal.file-viewer video").waitFor();
  // both clicks in one task, before the traversal the first asks for can land
  await preview.getByRole("button", { name: "Show beside the pane", exact: true }).evaluate((button: HTMLElement) => { button.click(); button.click(); });
  await panel.locator("video").waitFor();
  await mediaDiff.waitFor({ state: "detached" });
  await panel.getByRole("button", { name: "Close file", exact: true }).click();
  await panel.waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => ({ state: history.state, pane: new URLSearchParams(location.search).get("pane") })), { state: beforeMediaDiff, pane }, "two clicks collapse once: one Close returns to the diff's opener, on the same pane");
  await openFiles(page);
  await filesDialog.getByRole("button", { name: "Changes", exact: true }).click();
  await filesDialog.locator(".repo-change").filter({ hasText: "preview.webm" }).click();
  await mediaDiff.waitFor();
  await mediaDiff.getByRole("button", { name: "Close diff", exact: true }).click();
  await mediaDiff.waitFor({ state: "detached" });
  await filesDialog.getByRole("button", { name: "Close files", exact: true }).click();
  await filesDialog.waitFor({ state: "detached" });
  console.log("PASS a wide video handoff stacks above the diff and Close file returns to the diff, also after two clicks");
  // back over the two pane moves, so the steps after this one start from the pane's own entry
  await page.goBack();
  await page.waitForFunction((paneId) => new URLSearchParams(location.search).get("pane") === paneId, otherPane);
  await page.goBack();
  await page.waitForFunction((paneId) => new URLSearchParams(location.search).get("pane") === paneId, pane);
  await videoLink.waitFor();

  // Reopen files on return (#3179): the file's entry keeps it under the move, Back shows it again on
  // its pane, and a switch back from the sidebar opens it over the move's entry as an entry of its own
  const setReopen = async (on: boolean) => {
    await page.evaluate((on) => {
      const { reopenFileOnReturn: _, ...settings } = JSON.parse(localStorage.getItem("ovis:settings") ?? "{}") as Record<string, unknown>;
      localStorage.setItem("ovis:settings", JSON.stringify(on ? { ...settings, reopenFileOnReturn: true } : settings));
    }, on);
    await reloadFollowingEnd(page);
    await videoLink.waitFor();
    if (await showSidebar.count()) await showSidebar.click();
    await rowOf(otherPane).waitFor();
  };
  const onPane = (paneId: string) => page.waitForFunction((paneId) => new URLSearchParams(location.search).get("pane") === paneId, paneId);
  const fileEntry = () => page.evaluate(() => (history.state?.["ovis:file-preview"] as { paneId?: string } | undefined)?.paneId ?? null);
  await setReopen(true);
  // the pane's own entry: the moves below go back to it, so the steps after them start from it again
  const entryIndex = () => page.evaluate(() => (window as unknown as { navigation: { currentEntry: { index: number } } }).navigation.currentEntry.index);
  const startIndex = await entryIndex();
  await notesLink.press("Enter");
  await panel.getByText("File preview history regression", { exact: true }).waitFor();
  const keptLength = await page.evaluate(() => history.length);
  await rowOf(otherPane).click();
  await onPane(otherPane);
  await panel.waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
  assert.equal(await panel.count(), 0, "with Reopen files on return, the file still closes on a switch to another tab");
  assert.equal(await page.evaluate(() => history.length), keptLength + 1, "the move is pushed over the file's entry, which keeps the file");
  assert.equal(await fileEntry(), null, "the other pane's entry holds no file");
  await page.goBack();
  await onPane(pane);
  await panel.getByText("File preview history regression", { exact: true }).waitFor();
  assert.equal(await fileEntry(), pane, "Back to the first tab shows its file again from its own entry");
  await rowOf(otherPane).click();
  await onPane(otherPane);
  await panel.waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
  await rowOf(pane).click();
  await onPane(pane);
  await panel.getByText("File preview history regression", { exact: true }).waitFor();
  assert.equal(await fileEntry(), pane, "a switch back from the sidebar opens the file on an entry of its own");
  await panel.getByRole("button", { name: "Close file", exact: true }).click();
  await panel.waitFor({ state: "detached" });
  assert.equal(await selectedPane(), pane, "closing the reopened file steps back onto the move's entry, on the same pane");
  assert.equal(await fileEntry(), null, "Close leaves no file entry");
  await rowOf(otherPane).click();
  await onPane(otherPane);
  await rowOf(pane).click();
  await onPane(pane);
  await videoLink.waitFor();
  await panel.waitFor({ state: "attached", timeout: 1_000 }).catch(() => {});
  assert.equal(await panel.count(), 0, "a file closed on its tab stays closed on the next return");
  const steps = startIndex - await entryIndex();
  await page.evaluate((steps) => { history.go(steps); }, steps);
  await page.waitForFunction((startIndex) => (window as unknown as { navigation: { currentEntry: { index: number } } }).navigation.currentEntry.index === startIndex, startIndex);
  await onPane(pane);
  await setReopen(false);
  assert.equal(await fileEntry(), null, "back on the pane's own entry, which holds no file");
  console.log("PASS Reopen files on return: Back and a sidebar switch show the file again; one closed on its tab stays closed");

  // two panes with a file of the same path (each pane's ./notes.txt): coming back to one shows its own
  // file, never the other pane's content kept by a viewer the switch reused (#3185 review)
  const sideCreated = await workspaceCreate({ cwd: side, label: "ovis-test-file-back-side" });
  sideWorkspace = sideCreated.workspace.workspace_id;
  const sidePane = sideCreated.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: sidePane, text: `${standIn} resume ${sideThread}\n` });
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { argv?: string[] }[] } }>("pane.process_info", { pane_id: sidePane });
    if (info.process_info?.foreground_processes?.some((process) => process.argv?.includes(standIn))) break;
    if (attempt === 99) throw new Error("side test Codex process did not start");
    await Bun.sleep(50);
  }
  await herdrRpc("pane.report_agent", { pane_id: sidePane, source: "manual", agent: "codex", state: "idle", agent_session_path: sideTranscript });
  await setReopen(true);
  await rowOf(sidePane).waitFor();
  const sameStart = await entryIndex();
  const sideNotes = page.getByRole("button", { name: "side notes", exact: true });
  await rowOf(sidePane).click();
  await onPane(sidePane);
  await activateInTranscript(page, sideNotes);
  await panel.getByText("Side pane notes", { exact: true }).waitFor();
  await rowOf(pane).click();
  await onPane(pane);
  await activateInTranscript(page, notesLink);
  await panel.getByText("File preview history regression", { exact: true }).waitFor();
  // the viewer showing the first pane's file is marked: a viewer the switch reused would keep that
  // file's loaded content, and show it for the side pane's file until it read its own
  await panel.evaluate((element) => { (element as HTMLElement & { firstPaneViewer?: boolean }).firstPaneViewer = true; });
  await rowOf(sidePane).click();
  await onPane(sidePane);
  await panel.getByText("Side pane notes", { exact: true }).waitFor();
  assert.equal(await panel.evaluate((element) => (element as HTMLElement & { firstPaneViewer?: boolean }).firstPaneViewer === true), false, "the side pane's file of the same path opens in a viewer of its own");
  assert.equal(await panel.getByText("File preview history regression", { exact: true }).count(), 0, "the side pane's file shows none of the first pane's content");
  await panel.getByRole("button", { name: "Close file", exact: true }).click();
  await panel.waitFor({ state: "detached" });
  await page.evaluate((steps) => { history.go(steps); }, sameStart - await entryIndex());
  await page.waitForFunction((index) => (window as unknown as { navigation: { currentEntry: { index: number } } }).navigation.currentEntry.index === index, sameStart);
  await onPane(pane);
  await setReopen(false);
  await workspaceClose(sideWorkspace);
  sideWorkspace = undefined;
  await rowOf(sidePane).waitFor({ state: "detached" });
  console.log("PASS two panes with a file of the same path: coming back to one shows its own file");

  // a Forward onto a file's entry whose pane has closed since selects no pane of the file's: the file
  // is left behind at once, not kept over a pane it is not from (#3185 review)
  const goTo = async (index: number) => {
    await page.evaluate((steps) => { history.go(steps); }, index - await entryIndex());
    await page.waitForFunction((index) => (window as unknown as { navigation: { currentEntry: { index: number } } }).navigation.currentEntry.index === index, index);
  };
  const paneIndex = await entryIndex();
  await rowOf(otherPane).click();
  await onPane(otherPane);
  await openFiles(page);
  await filesDialog.getByRole("button", { name: /notes\.txt/ }).click();
  await filesDialog.waitFor({ state: "detached" });
  await panel.getByText("File preview history regression", { exact: true }).waitFor();
  assert.equal(await fileEntry(), otherPane, "the other pane's file is on its own entry");
  const otherFileIndex = await entryIndex();
  await page.goBack();
  await panel.waitFor({ state: "detached" });
  await goTo(paneIndex);
  await onPane(pane);

  await workspaceClose(otherWorkspace);
  otherWorkspace = undefined;
  await rowOf(otherPane).waitFor({ state: "detached" });
  assert.equal(await selectedPane(), pane, "closing the other workspace leaves the selection on the pane");
  await goTo(otherFileIndex);
  await page.waitForFunction(() => history.state?.["ovis:file-preview"] === undefined, undefined, { timeout: 5_000 }).catch(() => {});
  assert.equal(await fileEntry(), null, "the closed pane's file is released from the entry Forward landed on");
  assert.equal(await panel.count(), 0, "the closed pane's file is not shown over another pane");
  // back to the pane's own entry, so the steps after this one start from it again
  await goTo(paneIndex);
  await onPane(pane);
  console.log("PASS Forward onto a closed pane's file entry leaves the file behind");

  // The actual App and server, with a readable file in the owned pane's repository.
  for (const width of [1280, 980, 979]) {
    await page.setViewportSize({ width, height: 800 });
    await openFiles(page);
    await filesDialog.getByRole("button", { name: "Changes", exact: true }).click();
    const beforeDiff = await page.evaluate(() => ({ state: history.state, url: location.href }));
    await filesDialog.locator(".repo-change").filter({ hasText: "notes.txt" }).click();
    const diff = page.locator(".repo-diff-viewer");
    await diff.waitFor();
    const diffLength = await page.evaluate(() => history.length);
    await diff.getByRole("button", { name: "Open file", exact: true }).click();
    if (width < 980) {
      const modal = page.getByRole("dialog", { name: "notes.txt", exact: true });
      await modal.getByText("File preview history regression", { exact: true }).waitFor();
      assert.equal(await diff.count(), 1, "below 980px the modal file keeps the diff beneath it");
      await modal.getByRole("button", { name: "Close file", exact: true }).click();
      await modal.waitFor({ state: "detached" });
      await diff.waitFor();
      await diff.getByRole("button", { name: "Close diff", exact: true }).click();
      await diff.waitFor({ state: "detached" });
      await filesDialog.getByRole("button", { name: "Close files", exact: true }).click();
      await filesDialog.waitFor({ state: "detached" });
      console.log("PASS real App below 980px keeps the modal file above the diff; Close file returns to the diff");
      continue;
    }
    await panel.getByText("File preview history regression", { exact: true }).waitFor();
    await diff.waitFor({ state: "detached" });
    await filesDialog.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => history.length), diffLength, "the file replaces rather than pushes over the diff");
    assert.equal(await page.evaluate(() => history.state?.["ovis:repo-diff"]), undefined, "no stale diff target remains in the file entry");
    const close = panel.getByRole("button", { name: "Close file", exact: true });
    assert.equal(await close.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }), true, "Close file is hit-testable in the interactive panel");
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `file-panel-diff-to-file-${width}.png`) });
    await close.click();
    await panel.waitFor({ state: "detached" });
    assert.equal(await diff.count(), 0, "one Close file does not uncover the diff");
    assert.deepEqual(await page.evaluate(() => ({ state: history.state, url: location.href })), beforeDiff, "one Close file returns to where the diff opened");
    await page.goForward();
    await panel.getByText("File preview history regression", { exact: true }).waitFor();
    await page.reload();
    await panel.getByText("File preview history regression", { exact: true }).waitFor();
    assert.equal(await page.locator(".repo-diff-scrim, .files-dialog").count(), 0, "reload restores only the file panel");
    await page.goBack();
    await panel.waitFor({ state: "detached" });
    assert.deepEqual(await page.evaluate(() => ({ state: history.state, url: location.href })), beforeDiff, "one Back consumes the handed-off entry after reload");
    console.log(`PASS real App ${width}px diff -> readable file closes both dialogs, exposes Close file, replaces history, reloads, and consumes one Close/Back without a stale diff`);
  }
  await page.setViewportSize({ width: 390, height: 844 });

  await page.getByRole("button", { name: "notes", exact: true }).click();
  const notes = page.getByRole("dialog", { name: "notes.txt", exact: true });
  await notes.getByText("File preview history regression", { exact: true }).waitFor();
  await reloadFollowingEnd(page);
  await notes.getByText("File preview history regression", { exact: true }).waitFor();
  await page.goBack();
  await notes.waitFor({ state: "hidden" });
  await videoLink.waitFor();
  // reloaded and gone back: the chat's follow to its end can take the link from under a pointer
  await videoLink.dispatchEvent("click");
  await preview.waitFor();
  await preview.getByRole("button", { name: "Close file", exact: true }).click();
  await preview.waitFor({ state: "hidden" });
  await page.goBack();
  assert.equal(page.url(), `${origin}/api/health`, "no ghost modal entry or back trap after explicit close");
  assert.deepEqual(errors, []);
  console.log("PASS text preview survives reload; closed viewers leave normal Back navigation intact");
  await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
  await page.getByRole("button", { name: "file URI notes", exact: true }).tap();
  await page.locator(".file-viewer-text").waitFor();
  assert.match(await page.locator(".file-viewer-text").innerText(), /File preview history regression/);
  console.log("PASS Chat file URI label opens file content through touch");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "folder", exact: true }).tap();
  await page.locator(".file-viewer .dir-browser").waitFor();
  await page.locator(".file-viewer .dir-browser").getByRole("button", { name: /notes.txt/ }).tap();
  await page.locator(".file-viewer-text").waitFor();
  assert.match(await page.locator(".file-viewer-text").innerText(), /File preview history regression/);
  console.log("PASS Chat folder URI opens directory browser through touch");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: new URL(`file://${join(root, "notes.txt")}`).href, exact: true }).tap();
  await page.locator(".file-viewer-text").waitFor();
  assert.match(await page.locator(".file-viewer-text").innerText(), /File preview history regression/);
  console.log("PASS Chat plain file URI opens content through touch");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });

  // Markdown: Show source, reader tab, Open raw file, Download, Copy; no Wrap (a setting)
  const guide = page.getByRole("dialog", { name: "guide.md", exact: true });
  await page.getByRole("button", { name: "guide", exact: true }).click();
  await guide.getByRole("heading", { name: "Guide", exact: true }).waitFor();
  await guide.locator(".hl-keyword", { hasText: "const" }).waitFor();
  assert.equal(await guide.getByRole("button", { name: "Show source", exact: true }).getAttribute("aria-pressed"), "false");
  // a new tab is an in-app view in an installed app on a phone, where saving is not always offered
  const download = guide.getByRole("link", { name: "Download", exact: true, includeHidden: true });
  assert.equal(await download.getAttribute("download"), "guide.md", "the file can be saved from the viewer");
  assert.match(await download.getAttribute("href") ?? "", /\/api\/fs\/file\?.*download=1/);
  assert.equal(await guide.getByRole("button", { name: "Wrap long lines", exact: true }).count(), 0, "Wrap is for code, not the rendered Markdown");
  console.log("PASS Markdown opens as a Preview with a highlighted code block");
  // the preview reads as the chat does: its font size and family, and at most its lane's width
  const textStyle = (selector: string) => page.locator(selector).first().evaluate((element) => {
    const style = getComputedStyle(element);
    const heading = element.querySelector(".markdown-h1");
    return { fontSize: style.fontSize, fontFamily: style.fontFamily, headingSize: heading === null ? null : getComputedStyle(heading).fontSize };
  });
  const chatText = await textStyle(".chat-transcript .chat-turn-agent .markdown");
  const previewText = await textStyle(".file-viewer-markdown");
  // a finger's screen reads the chat's prose one step up, --fs-lg (16px), at the chat's scale, 17 / 14
  assert.ok(Math.abs(Number.parseFloat(chatText.fontSize) - 16 * 17 / 14) < 0.05, `the chat font size is applied in the chat: ${chatText.fontSize}`);
  assert.match(chatText.fontFamily, /^Georgia,/);
  assert.equal(previewText.fontSize, chatText.fontSize, "the preview's text has the chat's font size");
  assert.equal(previewText.fontFamily, chatText.fontFamily, "the preview's text has the chat's font");
  // --md-h1-size (30px) at the chat's scale, 17 / 14
  assert.ok(Math.abs(Number.parseFloat(previewText.headingSize ?? "") - 30 * 17 / 14) < 0.05, `its headings scale with it: ${previewText.headingSize}`);
  assert.equal(await page.locator(".file-viewer-markdown").evaluate((element) => getComputedStyle(element).maxWidth), "820px", "Default is the chat's Default lane");
  // on a wide screen the Default lane follows the pane (71.43% of it, up to 60rem): the preview
  // follows with it, as wide as the chat beside it, not the 820px floor. The file is a panel beside
  // the pane at this width, so the window is wide enough for the pane to reach the 60rem cap beside it
  await page.setViewportSize({ width: 2560, height: 1080 });
  const maxWidth = await page.waitForFunction(() => {
    const preview = document.querySelector(".file-viewer-markdown");
    const chat = document.querySelector(".chat-transcript");
    const maxWidth = preview === null ? "" : getComputedStyle(preview).maxWidth;
    return chat !== null && maxWidth === `${chat.getBoundingClientRect().width}px` && maxWidth === "960px" ? maxWidth : false;
  });
  assert.equal(await maxWidth.jsonValue(), "960px", "Default is as wide as the chat's lane");
  // the lane is the opening pane's, written on the viewer: one length on the document would be
  // shared, and overwritten, by two panes side by side
  assert.deepEqual(await page.evaluate(() => ({
    root: document.documentElement.style.getPropertyValue("--chat-w"),
    // docked (this width), the viewer's surface is its panel
    viewer: (document.querySelector<HTMLElement>("aside.file-panel") ?? document.querySelector<HTMLElement>(".file-viewer"))?.style.getPropertyValue("--chat-w") !== "",
  })), { root: "", viewer: true }, "the viewer carries the lane, not the document");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.match(await guide.locator(".file-viewer-markdown pre, .file-viewer-markdown .hl-code").first().evaluate((element) => getComputedStyle(element).fontFamily), /monospace/, "its code stays monospace");
  console.log("PASS A Markdown preview takes the chat's font size, font and width");
  await guide.getByRole("button", { name: "Show source", exact: true }).click();
  await guide.locator(".file-viewer-text .hl-line").first().waitFor();
  // seven lines and the empty one after the final newline, which the source keeps (#710)
  assert.equal(await guide.locator(".file-viewer-text .hl-line").count(), 8);
  assert.match(await guide.locator(".file-viewer-text").innerText(), /# Guide/);
  // the gutter is drawn: every line counts itself in a box of its own, which the text leaves out
  assert.equal(await guide.locator(".file-viewer-text[data-line-numbers]").count(), 1, "a gutter");
  assert.match(await guide.locator(".file-viewer-text").evaluate((pre) => getComputedStyle(pre).counterReset), /\bline\b/);
  const gutter = await guide.locator(".file-viewer-text .hl-line").evaluateAll((lines) => lines.map((line) => {
    const before = getComputedStyle(line, "::before");
    return { content: before.content, width: parseFloat(before.width) || 0 };
  }));
  assert.ok(gutter.every((line) => line.content === "counter(line)" && line.width > 0), `numbers drawn: ${JSON.stringify(gutter)}`);
  assert.doesNotMatch(await guide.locator(".file-viewer-text").innerText(), /^1/);
  if (process.env.UI_EVIDENCE_DIR) await guide.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "code-line-numbers.png") });
  console.log("PASS Code shows the Markdown source, one numbered line each");
  const raw = guide.getByRole("link", { name: "Open raw file", exact: true, includeHidden: true });
  assert.equal(await raw.getAttribute("target"), "_blank");
  assert.match(await raw.getAttribute("href") ?? "", /\/api\/fs\/file/);
  await guide.getByRole("button", { name: "Copy file", exact: true }).waitFor();
  console.log("PASS Open raw file opens the original bytes in a new tab; Copy is offered");
  assert.equal(await guide.getByRole("button", { name: "Wrap long lines", exact: true }).count(), 0, "wrapping is a setting, not a header action");
  assert.equal(await guide.locator(".file-viewer-text[data-wrap]").count(), 0, "lines do not wrap by default");
  await guide.getByRole("button", { name: "Show source", exact: true }).click();
  // When nothing can copy (no clipboard API on plain-HTTP LAN, and the browser's copy command
  // refused) Copy selects the source: from a Preview it switches to Code first
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("no clipboard")) }, configurable: true });
    document.execCommand = () => false;
  });
  await guide.getByRole("button", { name: "Copy file", exact: true }).click();
  await guide.locator(".file-viewer-text .hl-line").first().waitFor();
  assert.equal(await guide.getByRole("button", { name: "Show source", exact: true }).getAttribute("aria-pressed"), "true");
  const sourceText = await guide.locator(".file-viewer-text").innerText();
  assert.match(sourceText, /See \[notes\]\(\.\.\/notes\.txt\)\./);
  assert.ok(sourceText.endsWith("\n"), "the Markdown source keeps its final newline");
  assert.equal(await guide.locator(".file-viewer-text code").textContent(), sourceText, "the source DOM keeps its final newline");
  // Chromium omits the final newline from Selection.toString() even for a plain pre/code.
  const selected = await page.evaluate((source) => {
    const selection = window.getSelection()!;
    const actual = selection.toString();
    const baseline = document.createElement("pre");
    const code = document.createElement("code"); code.textContent = source;
    baseline.append(code); document.body.append(baseline);
    const range = document.createRange(); range.selectNodeContents(baseline);
    selection.removeAllRanges(); selection.addRange(range);
    const expected = selection.toString();
    baseline.remove(); selection.removeAllRanges();
    return { actual, expected };
  }, sourceText);
  assert.equal(selected.actual, selected.expected, "the selection matches a native pre/code of the Markdown source");
  await guide.getByRole("button", { name: "Copy file", exact: true }).click();
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), selected.expected, "from Code, Copy selects the source in place");
  console.log("PASS When nothing can copy, Copy selects the Markdown source (switching a Preview to Code)");
  await guide.getByRole("button", { name: "Show source", exact: true }).click();
  await guide.getByRole("button", { name: "notes", exact: true }).click();
  const linked = page.getByRole("dialog", { name: "notes.txt", exact: true });
  await linked.waitFor();
  assert.doesNotMatch(await linked.locator(".file-viewer-meta").getAttribute("title") ?? "", /\/docs\//);
  console.log("PASS A link in a Markdown preview opens the file it names");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });

  // a text file past the source budget: its first 8 MB as a window of rows, shown in part, so it cannot be copied whole
  const virtualRows = () => page.evaluate(() => document.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-line]").length ?? 0);
  const coloredRows = () => page.evaluate(() => document.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-line] span[style*='--herdr-code-token']").length ?? 0);
  await page.getByRole("button", { name: "big", exact: true }).click();
  const big = page.getByRole("dialog", { name: "big.txt", exact: true });
  // the note is the header's size, where it is seen before the text: "8 MB of 9 MB"
  const cut = big.locator(".file-viewer-meta .file-viewer-notice");
  await cut.waitFor();
  assert.match(await cut.innerText(), /^8 MB of 9 MB/);
  assert.equal(await cut.getAttribute("title"), "Showing the first 8 MB of 9 MB.");
  assert.equal(await big.getByRole("button", { name: "Copy file", exact: true }).count(), 0);
  assert.equal(await big.getByText("Too long to highlight").count(), 0, "plain text is never too long to highlight");
  await page.waitForFunction(() => (document.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-line]").length ?? 0) > 0);
  assert.ok((await virtualRows()) < 500, "8 MB of text is a bounded window of rows");
  assert.equal(await big.locator(".file-viewer-text").count(), 0, "not an element per line");
  assert.deepEqual(await frozen(), [], "no task held the page for two seconds");
  console.log("PASS A text file past the source budget shows its first 8 MB as a window of rows, says so in its header and has no Copy");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });

  // code past the colors bound: whole, as a window of plain rows, and the header says why it is plain
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("ovis:settings") ?? "{}") as Record<string, unknown>;
    localStorage.setItem("ovis:settings", JSON.stringify({ ...settings, wrapCode: true }));
  });
  await reloadFollowingEnd(page);
  await page.locator(".conn-live").waitFor();
  // the reloaded chat's follow to its end can take the link from under a pointer
  await activateInTranscript(page, page.getByRole("button", { name: "big code", exact: true }));
  const bigCode = page.getByRole("dialog", { name: "big.ts", exact: true });
  await page.waitForFunction(() => (document.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-line]").length ?? 0) > 0);
  assert.equal(await bigCode.locator(".file-viewer-meta .file-viewer-notice").getAttribute("title"), "Too long to highlight");
  assert.equal(await coloredRows(), 0, "the rows are plain");
  await bigCode.getByRole("button", { name: "Copy file", exact: true }).waitFor();
  console.log("PASS Code past the colors bound opens whole as plain rows, and the header says why");
  assert.equal(await page.evaluate(() => document.querySelector("diffs-container")!.shadowRoot!.querySelector("pre")!.getAttribute("data-overflow")), "wrap");
  console.log("PASS Settings → Wrap long lines wraps the code");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });

  // code past an element per line but within the colors bound: colored in the virtualizer's worker, served by this server under its CSP
  await page.getByRole("button", { name: "mid code", exact: true }).click();
  const midCode = page.getByRole("dialog", { name: "mid.ts", exact: true });
  await page.waitForFunction(() => (document.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-line] span[style*='--herdr-code-token']").length ?? 0) > 0, undefined, { timeout: 20_000 });
  assert.equal(await midCode.locator(".file-viewer-notice").count(), 0, "a colored source has no notice");
  await midCode.getByRole("button", { name: "Copy file", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS Code of 3 000 lines is colored in the virtualizer's worker under the server's CSP");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });

  for (const label of ["source column", "source range"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    const target = page.getByRole("dialog", { name: "target.ts", exact: true });
    const marked = target.locator(".file-viewer-text .hl-line.is-marked");
    await marked.waitFor();
    await sheetsSettled(page);
    assert.equal(await marked.count(), 1);
    assert.equal(await marked.getAttribute("data-line"), "60");
    assert.equal(await marked.textContent(), "export const line60 = 60;");
    assert.equal(await target.locator(".file-viewer-text code").textContent(), targetSource);
    const visible = await marked.evaluate((line) => {
      const body = line.closest(".file-viewer-body");
      if (!body) return false;
      const target = line.getBoundingClientRect(), viewport = body.getBoundingClientRect();
      return target.top >= viewport.top && target.bottom <= viewport.bottom && body.scrollTop > 0;
    });
    assert.ok(visible, "requested first line is scrolled into the viewer");
    await target.getByRole("button", { name: "Close file", exact: true }).click();
    await target.waitFor({ state: "hidden" });
  }
  await page.getByRole("button", { name: "Markdown line", exact: true }).click();
  const anchored = page.getByRole("dialog", { name: "guide.md", exact: true });
  await anchored.locator(".hl-line.is-marked[data-line='6']").waitFor();
  assert.equal(await anchored.getByRole("button", { name: "Show source", exact: true }).getAttribute("aria-pressed"), "true");
  const popupOpened = page.waitForEvent("popup");
  await (await fileAction(anchored, "Open in a new tab")).click();
  const anchoredTab = await popupOpened;
  await anchoredTab.locator(".file-reader .hl-line.is-marked[data-line='6']").waitFor();
  assert.ok(new URL(anchoredTab.url()).searchParams.get("read")?.endsWith("guide.md#L6"));
  await anchoredTab.close();
  await anchored.getByRole("button", { name: "Show source", exact: true }).click();
  await anchored.locator(".file-viewer-markdown").getByRole("heading", { name: "Guide", exact: true }).waitFor();
  assert.equal(await anchored.locator(".hl-line.is-marked").count(), 0);
  await anchored.getByRole("button", { name: "Close file", exact: true }).click();
  await anchored.waitFor({ state: "hidden" });
  for (const [label, name, line] of [["past end", "notes.txt", "999"], ["past preview", "big.txt", "999999"]] as const) {
    await page.getByRole("button", { name: label, exact: true }).click();
    const target = page.getByRole("dialog", { name, exact: true });
    await target.locator(".file-viewer-text, diffs-container").first().waitFor();
    const notice = target.locator(".file-viewer-notice");
    await notice.waitFor();
    assert.ok((await notice.getAttribute("title"))?.includes(line), "notice names the unavailable requested line");
    assert.equal(await target.locator(".hl-line.is-marked").count(), 0, "no misleading jump");
    assert.equal(await page.evaluate(() => document.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-line][data-selected-line]").length ?? 0), 0, "no misleading mark");
    await target.getByRole("button", { name: "Close file", exact: true }).click();
    await target.waitFor({ state: "hidden" });
  }
  // a file cut at the line cap keeps every line it shows numbered, so a line within it is marked
  await page.getByRole("button", { name: "capped line", exact: true }).click();
  const capped = page.getByRole("dialog", { name: "lines.txt", exact: true });
  await page.waitForFunction(() => document.querySelector("diffs-container")?.shadowRoot?.querySelector('[data-line="5"][data-selected-line]') != null);
  assert.equal(await capped.locator(".file-viewer-notice").getAttribute("title"), "Showing the first 200,000 lines of this file. Download it to read the rest.");
  assert.equal(await capped.getByRole("button", { name: "Copy file", exact: true }).count(), 0, "a cut file has no Copy");
  await capped.getByRole("button", { name: "Close file", exact: true }).click();
  await capped.waitFor({ state: "hidden" });
  console.log("PASS Line references mark and scroll the first source line, survive Markdown reader tabs, and explain unavailable lines");

  // a quote nested 20 000 deep renders as a quote nested to the parser's limit, the rest its text
  await page.getByRole("button", { name: "deep quotes", exact: true }).click();
  const deep = page.getByRole("dialog", { name: "deep.md", exact: true });
  // one paragraph, in the innermost quote: the markers past the limit, then the text. At 390px the
  // quotes' padding and rails leave it no width, as the same quote does in the chat, so the step
  // checks that it is there and how deep, not that it can be read.
  const deepest = deep.locator(".file-viewer-markdown blockquote p", { hasText: "> deepest" });
  await deepest.waitFor({ state: "attached" });
  const quoteDepth = await deepest.evaluate((element) => {
    let depth = 0;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent.tagName === "BLOCKQUOTE") depth += 1;
    return depth;
  });
  // the parser nests 32 levels (MAX_QUOTE_DEPTH in shared/markdown.ts); the 33rd holds the rest as text
  assert.equal(quoteDepth, 33, "the quote nests to the parser's limit");
  assert.equal(await deep.getByRole("alert").count(), 0, "the preview renders, not its fallback");
  console.log("PASS A Markdown file of 20 000 nested quotes renders, and the app stays");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });

  // an empty file opens empty, whole, with Copy: not as an error
  await page.getByRole("button", { name: "empty", exact: true }).click();
  const empty = page.getByRole("dialog", { name: "empty.txt", exact: true });
  await empty.getByRole("button", { name: "Copy file", exact: true }).waitFor();
  assert.equal(await empty.getByRole("alert").count(), 0);
  assert.equal(await empty.locator(".file-viewer-notice").count(), 0, "an empty file is not cut short");
  console.log("PASS An empty file opens as an empty file, not as an error");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });

  // The real app and file server, not a component-only fixture: a fresh tab must render
  // the same document, while raw/download keep their byte-for-byte API contract.
  for (const width of [390, 1440]) {
    for (const theme of ["dark", "light"]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
      await context.addInitScript((theme) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme })), theme);
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}&file=${encodeURIComponent(markdownPath)}`);
      const markdown = page.locator(".file-viewer-markdown");
      await markdown.getByRole("heading", { name: "Markdown preview", exact: true }).waitFor();
      await markdown.getByRole("cell", { name: "Ready", exact: true }).waitFor();
      await markdown.locator(".markdown-mermaid svg").waitFor();
      await markdown.getByRole("button", { name: "Enlarge diagram", exact: true }).waitFor();
      // a README's HTML header is drawn, centered, never shown as tags
      assert.equal((await markdown.innerText()).includes("<p"), false, "HTML tags are not shown as text");
      assert.equal(await markdown.locator('.markdown-center img[alt="Logo"]').getAttribute("width"), "64");
      assert.equal(await markdown.locator(".markdown-center").first().evaluate((node) => getComputedStyle(node).textAlign), "center");
      await markdown.getByRole("link", { name: "website", exact: true }).waitFor();
      await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>(".file-viewer-markdown img");
        return image?.complete && image.naturalWidth === 240;
      });
      await sheetsSettled(page);
      if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `markdown-inline-${width}-${theme}.png`) });
      const popupReady = context.waitForEvent("page");
      await (await fileAction(page.locator(".file-viewer"), "Open in a new tab")).click();
      const popup = await popupReady;
      popup.setDefaultTimeout(10_000);
      await popup.setViewportSize({ width, height: 900 });
      // the tab is the document alone, not the app over it
      await popup.locator(".file-reader").waitFor();
      assert.ok(new URL(popup.url()).searchParams.get("read")?.endsWith("preview #1 & 한글.MD"), popup.url());
      const rendered = popup.locator(".file-viewer-markdown");
      await rendered.getByRole("heading", { name: "Markdown preview", exact: true }).waitFor();
      await rendered.getByRole("cell", { name: "Ready", exact: true }).waitFor();
      const sourceToggle = popup.getByRole("button", { name: "Show source", exact: true });
      await sourceToggle.click();
      await popup.locator(".file-viewer-text[data-line-numbers] .hl-line").first().waitFor();
      assert.equal(await popup.locator(".file-viewer-text code").textContent(), markdownSource);
      await popup.getByRole("button", { name: "Copy file", exact: true }).waitFor();
      await sourceToggle.click();
      await popup.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>(".file-viewer-markdown img");
        return image?.complete && image.naturalWidth === 240;
      });
      await rendered.locator(".markdown-mermaid svg").waitFor();
      const raw = await popup.getByRole("link", { name: "Open raw file", exact: true, includeHidden: true }).getAttribute("href");
      assert.ok(raw);
      assert.equal(await (await context.request.get(`${origin}${raw}`)).text(), markdownSource);
      const download = await popup.getByRole("link", { name: "Download", exact: true, includeHidden: true }).getAttribute("href");
      assert.ok(download);
      const saved = await context.request.get(`${origin}${download}`);
      assert.match(saved.headers()["content-disposition"] ?? "", /attachment/);
      assert.equal(await saved.text(), markdownSource);
      await popup.reload();
      await rendered.getByRole("heading", { name: "Markdown preview", exact: true }).waitFor();
      await rendered.locator(".markdown-mermaid svg").waitFor();
      await popup.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>(".file-viewer-markdown img");
        return image?.complete && image.naturalWidth === 240;
      });
      await sheetsSettled(popup);
      assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (process.env.UI_EVIDENCE_DIR) await popup.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `markdown-tab-${width}-${theme}.png`) });
      assert.equal(await popup.locator(".agents-sidebar, .terminal-host, .modal-scrim").count(), 0, "no app around the document");
      assert.equal(await popup.getByRole("button", { name: "Close file", exact: true }).count(), 0, "nothing to close: the tab is the document");
      assert.equal(await popup.getByRole("link", { name: "Open in a new tab", exact: true }).count(), 0);
      assert.match(await popup.title(), /^preview #1 & 한글\.MD · /);
      // a link to another file opens it here, from the document's folder, and Back returns
      await rendered.getByRole("button", { name: /the other notes/ }).click();
      await rendered.getByRole("heading", { name: "Other notes", exact: true }).waitFor();
      assert.ok(new URL(popup.url()).searchParams.get("read")?.endsWith("/other.md"), popup.url());
      await popup.goBack();
      await rendered.getByRole("heading", { name: "Markdown preview", exact: true }).waitFor();
      await popup.close();
      await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}&file=${encodeURIComponent(join(root, "target.ts") + ":60:8")}`);
      const marked = page.locator(".file-viewer-text .hl-line.is-marked");
      await marked.waitFor();
      await sheetsSettled(page);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      assert.equal(await marked.getAttribute("data-line"), "60");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `source-line-${width}-${theme}.png`) });
      await context.close();
      console.log(`PASS Markdown inline/new tab/reload/raw/download: ${width}px ${theme}`);
    }
  }
  // The copied read link is a document-only page, not a modal. Its frame must constrain the
  // body on both sides of the mobile header breakpoint; the page is not a second scroll owner.
  // Since the body is then the one scroll box, it opens with the focus, so the keys scroll it
  // before any click; and the bound is the screen's only, so printing it prints every page.
  for (const width of [1280, 601, 600, 390]) {
    const readerContext = await browser.newContext({ viewport: { width, height: 800 } });
    try {
      const readerPage = await readerContext.newPage();
      await readerPage.goto(`${origin}/?read=${encodeURIComponent(join(root, "long.md"))}`);
      const readerBody = readerPage.locator(".file-reader-body");
      await readerBody.locator(".file-viewer-markdown p").first().waitFor();
      // the whole loaded prefix drawn, not just its first progressive chunk: the keys and the wheel
      // then act on a settled document, not one still growing by a chunk of blocks per task
      await readerBody.locator(".file-viewer-markdown .markdown-h1").nth(longPreviewHeadings - 1).waitFor();
      const geometry = await readerBody.evaluate((element) => ({ height: element.clientHeight, scrollHeight: element.scrollHeight, viewport: innerHeight }));
      assert.ok(geometry.height < geometry.viewport, `${width}px: standalone reader body is bounded by the viewport`);
      assert.ok(geometry.scrollHeight > geometry.height, `${width}px: long document has an internal scroll range`);
      assert.equal(await readerBody.evaluate((element) => element === document.activeElement), true, `${width}px: the opened document holds the focus`);
      // One scroll of the body at a time, each awaited to its end. Page Down scrolls smoothly, and a
      // reset or a wheel sent while that animation still runs on the compositor races it, so the
      // first scroll frame is not the end. The listener is armed before the key, reset or wheel.
      const nextScrollEnd = async () => {
        const ended = await readerBody.evaluateHandle((element) => {
          const state: { top: number | null } = { top: null };
          element.addEventListener("scrollend", () => { state.top = element.scrollTop; }, { once: true });
          return state;
        });
        return async () => {
          await readerPage.waitForFunction((state) => state.top !== null, ended);
          return ended.evaluate((state) => state.top ?? 0);
        };
      };
      const pagedDown = await nextScrollEnd();
      await readerPage.keyboard.press("PageDown");
      assert.ok(await pagedDown() > 0, `${width}px: Page Down scrolls the document body`);
      assert.equal(await readerPage.evaluate(() => window.scrollY), 0, `${width}px: Page Down scrolls the document body, not the page`);
      const reset = await nextScrollEnd();
      await readerBody.evaluate((element) => { element.scrollTop = 0; });
      await reset();
      if (width === 1280) {
        // the print layout is the paper's, not the window's: one width is enough
        const pdf = (await readerPage.pdf({ format: "A4" })).toString("latin1");
        const printed = pdf.match(/\/Type\s*\/Page(?!s)\b/g)?.length ?? 0;
        assert.ok(printed > 10, `the printed document runs over its pages, not one screen cut off (${printed} pages)`);
      }
      await readerPage.mouse.move(width / 2, 400);
      const wheeled = await nextScrollEnd();
      await readerPage.mouse.wheel(0, 600);
      assert.ok(await wheeled() > 0, `${width}px: the wheel scrolls the document body`);
      assert.equal(await readerPage.evaluate(() => window.scrollY), 0, `${width}px: wheel scroll belongs to the document body, not the page`);
      console.log(`PASS standalone Markdown reader scroll ownership and keys${width === 1280 ? ", print" : ""}: ${width}px`);
    } finally {
      await readerContext.close();
    }
  }
  // A file-only link owns its PC even if this browser last selected another one.
  // The remote fixture has no panes; only the bridge hop is supplied here, and its
  // file requests still go through the real server's stat/Range implementation.
  const roster: { machines: Machine[] } = await (await context.request.get(`${origin}/api/machines`)).json();
  const local = roster.machines.find((machine) => machine.id === "local");
  assert.ok(local?.snapshot);
  const remote: Machine = { ...local, id: "remote-fixture", name: "Remote fixture", snapshot: { ...local.snapshot, panes: [], workspaces: [], tabs: [], layouts: [], agents: [] } };
  for (const target of ["remote-fixture", "local", "missing-fixture"]) {
    const ownerContext = await browser.newContext();
    const fileRequests: string[] = [];
    await ownerContext.addInitScript(({ stored, pane }) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
      sessionStorage.setItem("ovis:selection", JSON.stringify({ machine_id: stored, pane_id: pane }));
    }, { stored: target === "local" ? "remote-fixture" : "local", pane });
    const unrouteOwner = await routeDrained(ownerContext, "**/api/**", async (route) => {
      const request = new URL(route.request().url());
      if (request.pathname === "/api/machines/events") { await route.abort(); return; }
      if (request.pathname === "/api/machines") { await route.fulfill({ json: { machines: [...roster.machines, remote] } }); return; }
      if (request.pathname === "/api/machines/remote-fixture/session") { await route.fulfill({ json: { snapshot: remote.snapshot } }); return; }
      if (request.pathname.includes("/fs/")) {
        // the sidebar asks each workspace folder for its project icon on its own PC; only the
        // document's reads are the link's
        if (!request.pathname.endsWith("/fs/favicon")) fileRequests.push(request.pathname);
        if (request.pathname.startsWith("/api/machines/remote-fixture/")) {
          request.pathname = request.pathname.replace("/api/machines/remote-fixture/", "/api/");
          await route.fulfill({ response: await route.fetch({ url: request.href }) });
          return;
        }
      }
      await route.continue();
    });
    const ownerPage = await ownerContext.newPage();
    ownerPage.setDefaultTimeout(10_000);
    await ownerPage.goto(`${origin}/?machine=${target}&file=${encodeURIComponent(markdownPath)}`);
    if (target === "missing-fixture") {
      await ownerPage.getByText("That link's PC is not set up here", { exact: true }).waitFor();
      assert.equal(await ownerPage.locator(".file-viewer").count(), 0);
      assert.equal(fileRequests.length, 0, "an unknown PC never reads the local file");
      // nor does the document's own tab, for a PC that is not set up here
      const readerPage = await ownerContext.newPage();
      await readerPage.goto(`${origin}/?read=${encodeURIComponent(markdownPath)}&machine=${target}`);
      // The settled alert names the offline PC (503 machine_offline), without a generic error above it.
      await readerPage.locator(".file-reader .file-viewer-note[role=alert]").waitFor();
      assert.deepEqual(await readerPage.locator(".file-reader .file-viewer-note").allTextContents(), ["That PC is not reachable right now."]);
      assert.equal(fileRequests.some((path) => path.startsWith("/api/fs/")), false, "the reader never reads the local file for another PC");
      const rawLink = await readerPage.getByRole("link", { name: "Open raw file", exact: true }).getAttribute("href");
      assert.ok(rawLink, "the offline reader keeps its raw-file recovery route");
      const rawUrl = new URL(rawLink, origin);
      assert.equal(rawUrl.pathname, "/api/machines/missing-fixture/fs/file", "recovery stays on the file's PC");
      assert.equal(rawUrl.searchParams.get("path"), markdownPath, "recovery keeps the requested file");
      await readerPage.close();
    } else {
      await ownerPage.locator(".file-viewer-markdown").getByRole("heading", { name: "Markdown preview", exact: true }).waitFor();
      const prefix = target === "local" ? "/api/fs/" : "/api/machines/remote-fixture/fs/";
      assert.ok(fileRequests.length >= 2 && fileRequests.every((path) => path.startsWith(prefix)), fileRequests.join(", "));
      await ownerPage.waitForFunction((path) => new URLSearchParams(location.search).get("file") === path, markdownPath);
      const link = await ownerPage.getByRole("link", { name: "Open in a new tab", exact: true, includeHidden: true }).getAttribute("href");
      assert.ok(link);
      assert.equal(new URL(link, origin).searchParams.get("machine") ?? "local", target);
      // the document's own tab reads the file from that PC too
      fileRequests.length = 0;
      const readerPage = await ownerContext.newPage();
      await readerPage.goto(new URL(link, origin).href);
      await readerPage.locator(".file-reader .file-viewer-markdown").getByRole("heading", { name: "Markdown preview", exact: true }).waitFor();
      assert.ok(fileRequests.length >= 2 && fileRequests.every((path) => path.startsWith(prefix)), fileRequests.join(", "));
      await readerPage.close();
      await ownerPage.reload();
      await ownerPage.locator(".file-viewer-markdown").getByRole("heading", { name: "Markdown preview", exact: true }).waitFor();
    }
    // Images and project icons can still be fetching after the document's text is ready.
    // Finish their fetch/fulfill handlers before closing the context disposes its responses.
    await unrouteOwner();
    await ownerContext.close();
    console.log(`PASS file-only link PC ownership, stored selection and pane independence: ${target}`);
  }
  await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}&view=chat`);
  await page.locator(".markdown-code").first().waitFor();

  // a chat code block the highlighter gives up on stays plain and says so, and the page runs on
  await page.locator(".markdown-code .hl-note", { hasText: "Too long to highlight" }).waitFor();
  assert.equal(await page.locator(".markdown-code").nth(1).locator("code span:not(.hl-line)").count(), 0, "the slow block is plain");
  await page.locator(".markdown-code").first().locator(".hl-keyword", { hasText: "const" }).waitFor();
  console.log("PASS A chat code block too slow to highlight stays plain, the others are colored");
  // a block of more lines than are drawn one element each opens whole as one text
  const many = page.locator(".markdown-code").nth(2);
  await many.getByRole("button", { name: "Show all 30000 lines", exact: true }).click();
  await many.getByRole("button", { name: "Show less", exact: true }).waitFor();
  assert.equal(await many.locator(".hl-line").count(), 0, "no element per line");
  assert.equal((await many.locator(".hl-code").innerText()).split("\n").length, 30_000);
  assert.deepEqual(await frozen(), [], "no task held the page for two seconds");
  console.log("PASS A chat code block of 30 000 lines opens as one text, and the page never freezes");

  // a Markdown file the highlighter is slow on: its Preview shows, and its source stays plain with a
  // notice, while the page runs on
  await page.getByRole("button", { name: "slow preview", exact: true }).click();
  const slow = page.getByRole("dialog", { name: "slow.md", exact: true });
  await slow.locator(".file-viewer-markdown p").first().waitFor({ timeout: 15_000 });
  await slow.getByRole("button", { name: "Show source", exact: true }).click();
  const slowNote = slow.locator(".file-viewer-meta .file-viewer-notice");
  await page.waitForFunction(() => document.querySelector(".file-viewer-notice")?.getAttribute("title") === "Too long to highlight", undefined, { timeout: 15_000 });
  assert.equal(await slowNote.locator(".visually-hidden").innerText(), "Too long to highlight", "a screen reader still hears it");
  assert.equal(await slow.locator(".hl-note").count(), 0, "the note is not repeated under the code");
  await slow.locator(".file-viewer-text .hl-line").first().waitFor();
  assert.equal(await slow.locator(".file-viewer-text code span:not(.hl-line)").count(), 0, "the source is plain");
  assert.deepEqual(await frozen(), [], "no task held the page for two seconds");
  console.log("PASS A Markdown file the highlighter is slow on previews, its source stays plain, and the page never freezes");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });

  // a Markdown file past the load limit: its first 256 KB, previewed, and the header says it is cut
  await page.getByRole("button", { name: "long notes", exact: true }).click();
  const long = page.getByRole("dialog", { name: "long.md", exact: true });
  await long.locator(".file-viewer-markdown .markdown-h1").first().waitFor();
  assert.match(await long.locator(".file-viewer-meta .file-viewer-notice").getAttribute("title") ?? "", /^Showing the first 256 KB of /);
  // Let the whole loaded prefix render, not just its first progressive chunk, before closing it.
  await long.locator(".file-viewer-markdown .markdown-h1").nth(longPreviewHeadings - 1).waitFor();
  // The preview can contain thousands of file-link buttons. Query its toolbar, not every
  // accessible name in the document: the check itself must not monopolize the page.
  const longHeader = long.locator(".file-viewer-header");
  await longHeader.getByRole("button", { name: "Show source", exact: true }).waitFor();
  console.log("PASS A Markdown file past the load limit previews its first 256 KB and says it is cut");
  await longHeader.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });

  // a file of more lines than the source budget keeps shows its first 200 000 as a window of rows,
  // and a Markdown file of more than a Preview draws opens as its source; neither holds the page,
  // and the header says why
  await page.getByRole("button", { name: "many lines", exact: true }).click();
  const manyLines = page.getByRole("dialog", { name: "lines.txt", exact: true });
  await page.waitForFunction(() => document.querySelector(".file-viewer-notice")?.getAttribute("title") === "Showing the first 200,000 lines of this file. Download it to read the rest.");
  await page.waitForFunction(() => (document.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-line]").length ?? 0) > 0);
  assert.equal(await manyLines.locator(".file-viewer-text").count(), 0, "no element per line");
  assert.ok((await virtualRows()) < 500, "a bounded window of rows");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "long list", exact: true }).click();
  const longList = page.getByRole("dialog", { name: "list.md", exact: true });
  await page.waitForFunction(() => (document.querySelector(".file-viewer-notice")?.getAttribute("title") ?? "").includes("Too long to preview"), undefined, { timeout: 15_000 });
  // its 65 536-line source is past an element per line: a window of rows
  await page.waitForFunction(() => (document.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-line]").length ?? 0) > 0);
  assert.equal(await longList.locator(".file-viewer-markdown").count(), 0, "the Preview is not drawn");
  assert.deepEqual(await frozen(), [], "no task held the page for two seconds");
  console.log("PASS A file of too many lines shows its first 200 000 as rows, a Markdown file of too many elements as its source, and the page never freezes");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });

  // a path in a tool's output opens the file it names; the rest of the output stays its text
  const shotPath = join(root, "shots", "t00000.png");
  await page.locator(".work-block-head").last().click();
  await page.locator(".work-row-head", { hasText: "shoot.py" }).click();
  const output = page.locator(".chat-tool-output pre").last();
  assert.equal(await output.innerText(), `${shotPath} (1600, 1000) -> (1255, 960)\nsaved shots/report.html\ndisplay image 1: [image/png]`, "the output reads as it was written");
  assert.equal(await output.getByRole("button", { name: "image/png" }).count(), 0, "a MIME type is not a file");
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "tool-output-links.png") });
  await output.getByRole("button", { name: shotPath, exact: true }).tap();
  const shot = page.getByRole("dialog", { name: "t00000.png", exact: true });
  await shot.locator("img.file-viewer-media").waitFor();
  assert.equal(await shot.locator("img.file-viewer-media").evaluate((image: HTMLImageElement) => image.naturalWidth), 1);
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "tool-output-image-open.png") });
  await shot.getByRole("button", { name: "Close file", exact: true }).click();
  await shot.waitFor({ state: "hidden" });
  console.log("PASS A file path in a tool's output opens the picture through touch");
  // the command names one too; a relative path is found from the pane's folder
  await page.locator(".work-row-detail .chat-tool-io pre").getByRole("button", { name: "shots/report.html", exact: true }).first().tap();
  const report = page.getByRole("dialog", { name: "report.html", exact: true });
  const frame = page.frameLocator(".file-viewer-page");
  // the page is drawn without its scripts first: the frame allows none, and the line above it offers them
  await report.locator(".file-viewer-page").waitFor();
  assert.equal(await report.locator(".file-viewer-page").getAttribute("sandbox"), "", "a page's scripts do not run by themselves");
  assert.equal(await report.locator(".file-viewer-scripts").innerText().then((text) => text.replace(/\s+/g, " ").trim()), "Scripts in this page are off. Run scripts");
  await report.getByRole("button", { name: "Run scripts", exact: true }).click();
  await frame.getByText("script ran", { exact: true }).waitFor();
  await frame.getByText("network blocked", { exact: true }).waitFor();
  await frame.getByText("no storage", { exact: true }).waitFor();
  // a picture beside the page is put into it, so it draws though the page may ask this server for nothing
  await frame.getByText("picture drawn", { exact: true }).waitFor();
  assert.equal(await report.locator(".file-viewer-page").getAttribute("sandbox"), "allow-scripts");
  assert.equal(await report.getByRole("button", { name: "Show source", exact: true }).count(), 0, "HTML uses only Page | Source");
  assert.equal(await report.getByRole("button", { name: "Page", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await report.getByRole("link", { name: "Open in a new tab", includeHidden: true }).getAttribute("href").then((href) => href?.includes("render=1")), true, "the page opens as the page");
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "tool-output-html-page.png") });
  await report.getByRole("button", { name: "Source", exact: true }).click();
  await report.locator(".file-viewer-text[data-line-numbers] .hl-line").first().waitFor();
  await report.locator(".file-viewer-text .hl-string").first().waitFor();
  assert.equal(await report.locator(".file-viewer-text button").count(), 0, "file source paths remain text");
  await report.getByRole("button", { name: "Copy file", exact: true }).waitFor();
  assert.equal(await report.getByRole("link", { name: "Download", exact: true, includeHidden: true }).getAttribute("download"), "report.html");
  assert.match(await report.locator(".file-viewer-text").innerText(), /<h1 id="ran">static<\/h1>/);
  assert.equal(await report.getByRole("link", { name: "Open in a new tab", includeHidden: true }).getAttribute("href").then((href) => href?.includes("render=1")), false, "the source opens as the source");
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "tool-output-html-source.png") });
  await report.getByRole("button", { name: "Page", exact: true }).click();
  await frame.getByText("script ran", { exact: true }).waitFor();
  // Copy from a page has no source element yet: a refused clipboard must reveal and select it.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("no clipboard")) }, configurable: true });
    document.execCommand = () => false;
  });
  await report.getByRole("button", { name: "Copy file", exact: true }).click();
  await report.locator(".file-viewer-text[data-line-numbers]").waitFor();
  assert.equal(await report.getByRole("button", { name: "Source", exact: true }).getAttribute("aria-pressed"), "true");
  assert.match(await page.evaluate(() => window.getSelection()?.toString() ?? ""), /<h1 id="ran">static<\/h1>/);
  await report.getByRole("button", { name: "Close file", exact: true }).click();
  await report.waitFor({ state: "hidden" });
  console.log("PASS An HTML file a command names opens as its page, sandboxed with no network or storage, and as its source");
  // the same under the dialog: a page the reader navigated inside its frame still closes on Close
  // file and on the scrim (#1203)
  const contents = page.getByRole("dialog", { name: "toc.html", exact: true });
  for (const close of ["Close file", "scrim"]) {
    await contentsLink.tap();
    await contents.getByRole("button", { name: "Run scripts", exact: true }).click();
    await frame.getByText("contents ran", { exact: true }).waitFor();
    // the sheet is still rising when the page shows: a click aimed into the frame meanwhile lands beside the anchor
    await sheetsSettled(page);
    const opened = await page.evaluate(() => history.length);
    await frame.locator("#toc").click();
    await page.waitForFunction((length) => history.length === length + 1, opened);
    if (close === "scrim") await page.locator(".file-viewer-scrim").evaluate((scrim) => scrim.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    else await contents.getByRole("button", { name: "Close file", exact: true }).click();
    await contents.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => history.state?.["ovis:file-preview"]), undefined, `${close} consumes the preview entry under a page the reader navigated inside its frame`);
  }
  console.log("PASS A page the reader navigated inside its frame still closes on Close file and the scrim, consuming the preview's entry");
  // a log in a plain code block: its paths open as well
  const log = page.locator(".markdown-code").last();
  await log.getByRole("button", { name: shotPath, exact: true }).tap();
  await shot.locator("img.file-viewer-media").waitFor();
  await shot.getByRole("button", { name: "Close file", exact: true }).click();
  await shot.waitFor({ state: "hidden" });
  assert.equal(await log.locator(".hl-code").innerText(), `${shotPath} (1600, 1000) -> (1255, 960)`, "a copy of the block is still its text");
  assert.deepEqual(errors, []);
  console.log("PASS A file path in a plain code block opens the file, and the block's text is unchanged");

  // the file found, then its body refused (the file gone since, a remote PC dropped): the error's
  // JSON must never show as the file's text
  await page.route("**/api/fs/file?**", (route) => route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: { code: "machine_unavailable", message: "The PC connection was interrupted" } }) }), { times: 1 });
  await page.getByRole("button", { name: "notes", exact: true }).click();
  const refused = page.getByRole("dialog", { name: "notes.txt", exact: true });
  await refused.getByRole("alert").waitFor();
  // a PC dropped mid-read keeps its machine code (lib/fileFailure.ts): the alert names the PC as away
  assert.equal(await refused.getByRole("alert").innerText(), "That PC is not reachable right now.");
  assert.equal(await refused.getByText("machine_unavailable").count(), 0);
  assert.equal(await refused.locator(".file-viewer-text").count(), 0);
  console.log("PASS A file whose body is refused shows an error, not the error's JSON");
  assert.deepEqual(errors, []);

  // a rendered page's recording too large to put into it plays and seeks from the address its render
  // gave out, read from the descriptor that render checked; a lapsed or revoked address plays no more,
  // and closing the viewer lets go of every descriptor, each once (server/file-view.ts)
  const live = new Set<number>();
  let closedTwice = 0;
  let allClosed: (() => void) | null = null;
  pageFileHooks.opened = (fd) => { live.add(fd); };
  pageFileHooks.closed = (fd) => {
    if (!live.delete(fd)) closedTwice += 1;
    if (live.size === 0) allClosed?.();
  };
  try {
    await refused.getByRole("button", { name: "Close file", exact: true }).click();
    await refused.waitFor({ state: "hidden" });
    const mediaLink = page.getByRole("button", { name: "page media", exact: true });
    const mediaPage = page.getByRole("dialog", { name: "page-media.html", exact: true });
    const recording = mediaPage.frameLocator(".file-viewer-page").locator("#take");
    /** "loaded" once the recording's metadata came, "error" when its address was refused; with `query`, asked again by a new URL first, so no cache answers for the server */
    const loads = (query: string | null = null) => recording.evaluate((element: HTMLAudioElement, query) => new Promise<string>((done) => {
      if (query === null && element.readyState >= 1) return done("loaded");
      if (query === null && element.error !== null) return done("error");
      const settle = (outcome: string) => () => {
        element.removeEventListener("loadedmetadata", loaded);
        element.removeEventListener("error", failed);
        done(outcome);
      };
      const loaded = settle("loaded");
      const failed = settle("error");
      element.addEventListener("loadedmetadata", loaded);
      element.addEventListener("error", failed);
      if (query !== null) {
        const address = new URL(element.src);
        address.search = `?${query}`;
        element.src = address.href;
      }
    }), query);
    const openPage = async () => {
      await mediaLink.tap();
      // the recording is read from inside the frame, which takes the page's scripts being on
      await mediaPage.getByRole("button", { name: "Run scripts", exact: true }).click();
      const address = await recording.getAttribute("src") ?? "";
      assert.match(address, new RegExp(`^${origin}/api/fs/page-media/[A-Za-z0-9_-]{32}$`), "the recording plays from its address");
      assert.equal(await loads(), "loaded");
      return address;
    };
    const closePage = async () => {
      await mediaPage.getByRole("button", { name: "Close file", exact: true }).click();
      await mediaPage.waitFor({ state: "hidden" });
    };
    const first = await openPage();
    const played = await recording.evaluate((element: HTMLAudioElement) => new Promise<number>((done, fail) => {
      const start = element.currentTime;
      const moved = () => {
        if (element.currentTime <= start) return;
        element.removeEventListener("timeupdate", moved);
        element.pause();
        done(element.currentTime - start);
      };
      element.addEventListener("timeupdate", moved);
      element.play().catch(fail);
    }));
    assert.ok(played > 0, "the recording plays");
    const seeked = await recording.evaluate((element: HTMLAudioElement) => new Promise<number>((done, fail) => {
      element.addEventListener("seeked", () => done(element.currentTime), { once: true });
      element.addEventListener("error", () => fail(new Error(`media error ${element.error?.code}`)), { once: true });
      element.currentTime = 900;
    }));
    assert.equal(Math.round(seeked), 900, "the recording seeks");
    assert.equal(await loads("again"), "loaded", "its address answers again");
    // lapsed: past its lifetime the address is dropped, and the page's next ask is refused
    assert.equal(pageMediaResponse(first.slice(first.lastIndexOf("/") + 1), null, null, Date.now() + PAGE_MEDIA_LIFETIME_MS + 1), null);
    assert.equal(await loads("lapsed"), "error", "a lapsed address is refused");
    await closePage();
    // revoked: a new render gives a new address, which plays until its client signs out
    const second = await openPage();
    assert.notEqual(second, first, "a new render gives a new address");
    forgetPageMedia({ client: "127.0.0.1" });
    assert.equal(await loads("revoked"), "error", "a revoked address is refused");
    await closePage();
    if (live.size > 0) await new Promise<void>((done, fail) => {
      allClosed = done;
      AbortSignal.timeout(15_000).addEventListener("abort", () => fail(new Error(`${live.size} page media descriptors still open after the viewer closed`)));
    });
    assert.equal(closedTwice, 0, "no page media descriptor closed twice");
    assert.deepEqual(errors, []);
    console.log("PASS A rendered page's recording plays and seeks from its checked descriptor, a lapsed or revoked address is refused, and every descriptor closes once");
  } finally {
    delete pageFileHooks.opened;
    delete pageFileHooks.closed;
  }
  // Own document: a closed image sheet leaves forward entries, while the file-history checks
  // above deliberately begin with no forward entry.
  const imagePage = await context.newPage();
  imagePage.setDefaultTimeout(10_000);
  const imageErrors: string[] = [];
  imagePage.on("pageerror", (error) => imageErrors.push(error.message));
  // This case tests decode failure, not lazy loading. A late transcript/skill render can remount
  // the image, so activate every incarnation without acting on its transient viewer button.
  await imagePage.addInitScript(() => {
    new MutationObserver(() => {
      for (const image of document.querySelectorAll<HTMLImageElement>('img.markdown-image[alt="Chat broken inline"]')) image.loading = "eager";
    }).observe(document, { childList: true, subtree: true });
  });
  const brokenImage = imagePage.getByRole("button", { name: "Chat broken inline", exact: true }).and(imagePage.locator(".markdown-file"));
  const brokenFallback = brokenImage.waitFor({ state: "attached", timeout: 10_000 });
  await imagePage.goto(`${origin}/?pane=${encodeURIComponent(pane)}&view=chat`);
  await brokenFallback;
  await brokenImage.click({ trial: true });
  // A decode failure must replace the opener, never put a file button inside it.
  assert.equal(await imagePage.locator(".markdown-image-open button, .markdown-image-open a").count(), 0);
  assert.equal(await imagePage.getByRole("button", { name: "Chat broken inline", exact: true }).count(), 1);
  await brokenImage.click();
  const brokenFile = imagePage.getByRole("dialog", { name: "broken.png", exact: true });
  await brokenFile.waitFor();
  assert.equal(await imagePage.getByRole("dialog", { name: "Image viewer", exact: true }).count(), 0);
  await brokenFile.getByRole("button", { name: "Close file", exact: true }).click();
  await brokenFile.waitFor({ state: "detached" });
  console.log("PASS a failed inline Markdown image has one file action and never opens the image viewer");
  const markdownThumb = imagePage.getByRole("button", { name: "Chat relative", exact: true });
  await markdownThumb.click();
  const markdownGallery = imagePage.getByRole("dialog", { name: "Image viewer" });
  await markdownGallery.waitFor();
  await imagePage.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>(".image-lightbox img");
    return image?.complete && image.naturalWidth === 240;
  }, undefined, { timeout: 10_000 });
  assert.equal(await markdownGallery.getByRole("link", { name: "Download", exact: true }).getAttribute("download"), "preview.svg");
  await imagePage.goBack();
  await markdownGallery.waitFor({ state: "detached" });
  assert.equal(await markdownThumb.evaluate((node) => node === document.activeElement), true);
  await imagePage.keyboard.press("Enter");
  await markdownGallery.waitFor();
  await imagePage.keyboard.press("Escape");
  await markdownGallery.waitFor({ state: "detached" });
  assert.equal(await markdownThumb.evaluate((node) => node === document.activeElement), true);
  await imagePage.keyboard.press("Space");
  await markdownGallery.waitFor();
  await markdownGallery.getByRole("button", { name: "Close", exact: true }).click();
  await markdownGallery.waitFor({ state: "detached" });
  assert.equal(await markdownThumb.evaluate((node) => node === document.activeElement), true);
  assert.deepEqual(imageErrors, []);
  await imagePage.close();
  console.log("PASS Chat Markdown image opens by touch, Enter and Space with its filename; Back, Close and Escape restore the thumbnail");

  // Own document: report closes leave forward entries, while the file checks start without them.
  // The real App must provide and render the web panel even when no docked column fits.
  const reportPage = await context.newPage();
  reportPage.setDefaultTimeout(10_000);
  const reportErrors: string[] = [];
  reportPage.on("pageerror", (error) => reportErrors.push(error.message));
  await reportPage.goto(`${origin}/?pane=${encodeURIComponent(pane)}&view=chat`);
  await reportPage.locator(".conn-live").waitFor();
  const webReportLink = reportPage.getByRole("link", { name: "web report", exact: true });
  const conversationUrl = reportPage.url();
  for (const close of ["button", "back"] as const) {
    await webReportLink.tap();
    const popup = reportPage.locator(".web-panel-popup");
    await popup.waitFor();
    const reportFrame = reportPage.frameLocator(".web-panel-popup iframe");
    await reportFrame.getByRole("heading", { name: "Same-host report" }).waitFor();
    assert.equal(await reportPage.locator(".chat-transcript").count(), 1, "the conversation remains mounted under the report");
    if (close === "button") {
      const opened = await reportPage.evaluate(() => history.length);
      await reportFrame.getByRole("link", { name: "Report details" }).tap();
      await reportPage.waitForFunction((length) => history.length === length + 1, opened);
      await popup.getByRole("button", { name: "Close page", exact: true }).tap();
    } else await reportPage.goBack();
    await popup.waitFor({ state: "detached" });
    assert.equal(reportPage.url(), conversationUrl, `${close} closes the report without leaving the conversation`);
    assert.equal(await reportPage.evaluate(() => history.state?.["ovis:web-panel"]), undefined, `${close} consumes the report history entry`);
  }
  for (const close of ["Escape", "Back"] as const) {
    await webReportLink.tap();
    const popup = reportPage.locator(".web-panel-popup");
    await popup.waitFor();
    await reportPage.keyboard.press("ControlOrMeta+Shift+Comma");
    const settings = reportPage.getByRole("dialog", { name: "Settings", exact: true });
    await settings.waitFor();
    await reportPage.waitForFunction(() => history.state?.["ovis:settings"] !== undefined);
    await sheetsSettled(reportPage);
    assert.equal(await reportPage.evaluate(() => !!document.activeElement?.closest(".settings-dialog")), true, "opening Settings immediately keeps focus in Settings before Tab");
    const settingsClose = settings.getByRole("button", { name: "Close settings", exact: true });
    const settingsHit = await settingsClose.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { correct: Boolean(hit?.closest(".settings-dialog")), hit: hit?.outerHTML.slice(0, 300), scrim: button.closest(".modal-scrim")?.outerHTML.slice(0, 100), rect: rect.toJSON() };
    });
    assert.equal(settingsHit.correct, true, `Settings is above the web report: ${JSON.stringify(settingsHit)}`);
    const focused: string[] = [];
    for (let press = 0; press < 3; press++) {
      await reportPage.keyboard.press("Tab");
      focused.push(await reportPage.evaluate(() => document.activeElement?.closest(".settings-dialog") ? document.activeElement.outerHTML : "outside"));
    }
    assert.ok(focused.every((entry) => entry !== "outside") && new Set(focused).size >= 2, "Tab moves within Settings, not the web report");
    if (close === "Escape") await reportPage.keyboard.press("Escape");
    else await reportPage.goBack();
    await settings.waitFor({ state: "detached" });
    await popup.waitFor();
    assert.equal(await reportPage.evaluate(() => !!document.activeElement?.closest(".web-panel-popup")), true, `${close} restores focus to the report`);
    assert.ok(await reportPage.evaluate(() => history.state?.["ovis:web-panel"]), `${close} preserves the report history entry`);
    await popup.getByRole("button", { name: "Close page", exact: true }).click();
    await popup.waitFor({ state: "detached" });
  }
  await reportPage.setViewportSize({ width: 1280, height: 800 });
  await webReportLink.click();
  await reportPage.locator(".web-panel").waitFor();
  await reportPage.keyboard.press("ControlOrMeta+Shift+Comma");
  const settingsOverDocked = reportPage.getByRole("dialog", { name: "Settings", exact: true });
  await settingsOverDocked.waitFor();
  await reportPage.setViewportSize({ width: 900, height: 800 });
  await reportPage.locator(".web-panel-popup").waitFor();
  assert.equal(await reportPage.evaluate(() => !!document.activeElement?.closest(".settings-dialog")), true, "shrinking under Settings keeps focus in Settings");
  await reportPage.keyboard.press("Escape");
  await settingsOverDocked.waitFor({ state: "detached" });
  assert.equal(await reportPage.locator(".web-panel-popup").count(), 1, "Escape closes Settings only after shrinking");
  assert.equal(await reportPage.evaluate(() => !!document.activeElement?.closest(".web-panel-popup")), true, "focus returns to the report");
  await reportPage.getByRole("button", { name: "Close page", exact: true }).click();
  await reportPage.locator(".web-panel-popup").waitFor({ state: "detached" });
  await reportPage.setViewportSize({ width: 1280, height: 800 });
  await webReportLink.click();
  await reportPage.locator(".web-panel").waitFor();
  await reportPage.keyboard.press("ControlOrMeta+Shift+K");
  const reportPalette = reportPage.getByRole("dialog", { name: "Command palette", exact: true });
  const reportPaletteSearch = reportPalette.getByRole("searchbox", { name: "Search panes and actions", exact: true });
  await reportPaletteSearch.waitFor();
  await reportPage.setViewportSize({ width: 900, height: 800 });
  await reportPage.locator(".web-panel-popup").waitFor();
  assert.equal(await reportPaletteSearch.evaluate((input) => input === document.activeElement), true, "shrinking under the palette keeps its focus");
  await reportPage.keyboard.press("Tab");
  assert.equal(await reportPage.evaluate(() => !!document.activeElement?.closest(".command-palette")), true, "Tab stays in the palette");
  await reportPage.keyboard.press("Escape");
  await reportPalette.waitFor({ state: "hidden" });
  assert.equal(await reportPage.locator(".web-panel-popup").count(), 1, "Escape closes only the palette after shrinking");
  await reportPage.waitForFunction(() => !!document.activeElement?.closest(".web-panel-popup"));
  await reportPage.getByRole("button", { name: "Close page", exact: true }).click();
  await reportPage.locator(".web-panel-popup").waitFor({ state: "detached" });
  await reportPage.close();
  // The report and a docked file share one place and one history entry. Each row records the open
  // panel and the screen each Back reaches, beside what 6c78047f (before mobile reports) did; a row
  // that differs says why. "previous" is the page before the app. Rows with fileOpen "popup" open
  // the file as a popup ("file popup" when it is the only panel) and "dock" moves it beside the pane with Show beside the pane. "forward" is
  // the screen after a Forward right on the open panel, "forwards" the screens of Forwards after the Backs.
  type Screen = "none" | "web" | "file" | "file popup" | "web+file" | "previous";
  type Moves = { open: Screen; forward?: Screen; backs: Screen[]; forwards?: Screen[] };
  const transitions: Array<Moves & { name: string; fileOpen?: "popup"; steps: Array<"web" | "file" | "dock" | "diff" | "narrow" | "wide">; base: Moves | null; why?: string }> = [
    { name: "web → file", steps: ["web", "file"], open: "file", backs: ["none", "previous"], base: { open: "file", backs: ["none", "previous"] } },
    { name: "file → web", steps: ["file", "web"], open: "web", backs: ["none", "previous"], base: { open: "web", backs: ["previous"] }, why: "the report takes over the file's entry instead of waiting on a Back that dropped it" },
    { name: "file → web → file", steps: ["file", "web", "file"], open: "file", backs: ["none", "previous"], base: { open: "file", backs: ["none", "previous"] } },
    { name: "docked web (from the narrow popup) → file", steps: ["narrow", "web", "wide", "file"], open: "file", backs: ["none", "previous"], base: null, why: "narrow windows had no report before" },
    { name: "web → narrow → wide → file", steps: ["web", "narrow", "wide", "file"], open: "file", backs: ["none", "previous"], base: { open: "file", backs: ["none", "previous"] } },
    { name: "file popup → dock", fileOpen: "popup", steps: ["file", "dock"], open: "file", backs: ["none", "previous"], base: { open: "file", backs: ["none", "previous"] } },
    { name: "file popup → dock → web → file popup → dock", fileOpen: "popup", steps: ["file", "dock", "web", "file", "dock"], open: "file", backs: ["none", "previous"], base: { open: "file", backs: ["none", "previous"] } },
    { name: "file popup → dock → web → file popup → narrow → wide → dock", fileOpen: "popup", steps: ["file", "dock", "web", "file", "narrow", "wide", "dock"], open: "file", backs: ["none", "previous"], base: { open: "file", backs: ["none", "previous"] } },
    { name: "file popup → dock → web → file popup → dock, Forward", fileOpen: "popup", steps: ["file", "dock", "web", "file", "dock"], open: "file", forward: "file", backs: ["none", "previous"], base: { open: "file", forward: "file", backs: ["none", "previous"] } },
    { name: "file popup → dock → web → file popup → dock, Back → Forward", fileOpen: "popup", steps: ["file", "dock", "web", "file", "dock"], open: "file", backs: ["none"], forwards: ["file"], base: { open: "file", backs: ["none"], forwards: ["file"] } },
    { name: "file → web → Browse files → Changes → diff → Open file", steps: ["file", "web", "diff"], open: "file", backs: ["none", "previous"], base: { open: "file", backs: ["none", "previous"] } },
    { name: "docked web (from the narrow popup) → file popup", fileOpen: "popup", steps: ["narrow", "web", "wide", "file"], open: "web+file", backs: ["web", "none", "previous"], base: null, why: "narrow windows had no report before" },
    { name: "docked web (from the narrow popup) → file popup → dock", fileOpen: "popup", steps: ["narrow", "web", "wide", "file", "dock"], open: "file", backs: ["none", "previous"], base: null, why: "narrow windows had no report before" },
  ];
  for (const row of transitions) {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => reportErrors.push(error.message));
    await page.addInitScript((fileOpen) => {
      if (window.top !== window) return;
      const settings = JSON.parse(localStorage.getItem("ovis:settings") ?? "{}") as Record<string, unknown>;
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", chatFontSize: 17, chatFontFamily: "Georgia", webLinks: "panel", ...settings, fileOpen }));
    }, row.fileOpen ?? "panel");
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(reportUrl);
      await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}&view=chat`);
      await page.locator(".conn-live").waitFor();
      const screen = async (): Promise<Screen> => {
        if (page.url().startsWith(reportUrl)) return "previous";
        const web = await page.locator(".web-panel, .web-panel-popup").count() > 0;
        const docked = await page.locator("aside.file-panel").count() > 0;
        const popup = await page.locator(".modal.file-viewer").count() > 0;
        return web && (docked || popup) ? "web+file" : web ? "web" : docked ? "file" : popup ? "file popup" : "none";
      };
      const reaches = async (expected: Screen, label: string): Promise<void> => {
        const until = Date.now() + 5_000;
        while (await screen() !== expected && Date.now() < until) await page.waitForTimeout(50);
        // fixed wait: no stray Back may close the reached panel in this time
        await page.waitForTimeout(400);
        assert.equal(await screen(), expected, `${row.name}: ${label}`);
      };
      for (const step of row.steps) {
        if (step === "narrow" || step === "wide") {
          await page.setViewportSize({ width: step === "narrow" ? 900 : 1280, height: 800 });
          if (await screen() === "web") await page.locator(step === "narrow" ? ".web-panel-popup" : ".web-panel").waitFor();
        } else if (step === "web") {
          await activateInTranscript(page, page.getByRole("link", { name: "web report", exact: true }));
          await page.locator(".web-panel, .web-panel-popup").first().waitFor();
        } else if (step === "diff") {
          await openFiles(page);
          const files = page.locator(".files-dialog");
          await files.getByRole("button", { name: "Changes", exact: true }).click();
          await files.locator(".repo-change").filter({ hasText: "notes.txt" }).click();
          await page.locator(".repo-diff-viewer").getByRole("button", { name: "Open file", exact: true }).click();
          await page.locator("aside.file-panel").getByText("File preview history regression", { exact: true }).waitFor();
        } else if (step === "dock") {
          await page.getByRole("dialog", { name: "notes.txt", exact: true }).getByRole("button", { name: "Show beside the pane", exact: true }).click();
          await page.locator("aside.file-panel").getByText("File preview history regression", { exact: true }).waitFor();
        } else {
          await activateInTranscript(page, page.getByRole("button", { name: "notes", exact: true }));
          await page.locator(row.fileOpen === "popup" ? ".modal.file-viewer" : "aside.file-panel").getByText("File preview history regression", { exact: true }).waitFor();
        }
      }
      await reaches(row.open, "open panel");
      assert.equal(await page.evaluate(() => {
        const state = history.state ?? {};
        return Object.hasOwn(state, "ovis:file-preview") && (Object.hasOwn(state, "ovis:web-panel") || Object.hasOwn(state, "ovis:web-panel-docked"));
      }), false, `${row.name}: one panel owns the entry`);
      if (row.forward !== undefined) {
        await page.goForward();
        await reaches(row.forward, "Forward");
      }
      for (const [back, expected] of row.backs.entries()) {
        await page.goBack();
        await reaches(expected, `Back ${back + 1}`);
      }
      for (const [forward, expected] of (row.forwards ?? []).entries()) {
        await page.goForward();
        await reaches(expected, `Forward ${forward + 1} after the Backs`);
      }
      const moves = ({ open, forward, backs, forwards }: Moves): string =>
        `open ${open}${forward === undefined ? "" : `, Forward ${forward}`}, Back ${backs.join(" → ")}${forwards === undefined ? "" : `, Forward ${forwards.join(" → ")}`}`;
      if (row.base !== null && row.why === undefined) assert.deepEqual(moves(row), moves(row.base), `${row.name} matches 6c78047f`);
      console.log(`PASS transition ${row.name}: ${moves(row)}${row.base === null ? "" : `; 6c78047f: ${moves(row.base)}`}${row.why === undefined ? "" : ` (${row.why})`}`);
    } finally { await page.close(); }
  }
  assert.deepEqual(reportErrors, []);
  console.log("PASS App mobile chat report link opens in-app; Close skips frame history and Back returns to the conversation");
} finally {
  await browser?.close();
  reportServer.stop(true);
  server?.stop();
  if (otherWorkspace) await workspaceClose(otherWorkspace);
  if (sideWorkspace) await workspaceClose(sideWorkspace);
  if (workspace) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
}
