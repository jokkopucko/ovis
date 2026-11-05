/** omp's and Codex's pictures end to end in Chrome, from their recorded sessions: parsed page -> prompt,
 * work line or row -> the real image endpoint's bytes -> a decoded <img>. omp's pictures live in its
 * blob store and load with the line; a Codex tool's load only once its row is opened. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { codexTranscriptImage } from "../server/codex-images.ts";
import { codexToolImage, ompTranscriptImage, transcriptPage } from "../server/conversation.ts";
import type { ConversationResponse } from "../shared/protocol.ts";
import { chromePath } from "./chrome-path.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-omp-codex-image-browser-"));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const fixture = (name: string) => readFileSync(new URL(`../server/fixtures/${name}`, import.meta.url));

// omp 18.8.7's session as recorded, laid out in an agent directory as omp keeps it, with one more
// prompt that is only a picture (a paste: `@file` adds the file's name as text)
const blob = fixture("omp-pictures-18.8.7-blob.webp");
const agent = join(root, "omp", "agent");
mkdirSync(join(agent, "sessions", "-tmp-omp-pictures-"), { recursive: true });
mkdirSync(join(agent, "blobs"), { recursive: true });
writeFileSync(join(agent, "blobs", createHash("sha256").update(blob).digest("hex")), blob);
const ompPath = join(agent, "sessions", "-tmp-omp-pictures-", "2026-10-26T08-51-22-788Z_01a17768.jsonl");
const pasted = { type: "message", id: "p1c7u2e0", parentId: "16568bb3", timestamp: "2026-10-26T08:53:00.000Z", message: { role: "user", content: [{ type: "image", mimeType: "image/webp", data: `blob:sha256:${createHash("sha256").update(blob).digest("hex")}` }], attribution: "user", timestamp: 1793004780000 } };
const answered = { type: "message", id: "a9e1c3b5", parentId: "p1c7u2e0", timestamp: "2026-10-26T08:53:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "The same red square." }], stopReason: "stop", timestamp: 1793004782000 } };
writeFileSync(ompPath, fixture("omp-pictures-18.8.7-session.jsonl").toString("utf8") + [pasted, answered].map((row) => JSON.stringify(row)).join("\n") + "\n");

// codex-cli 0.163.0's rollout as recorded: view_image through the exec tool
const codexHome = join(root, "codex");
mkdirSync(codexHome, { recursive: true });
const codexPath = join(root, "rollout-2026-10-26T18-01-48-01a17771-c993-7f01-9f21-0e02bad40fd0.jsonl");
writeFileSync(codexPath, fixture("codex-pictures-0.163.0-rollout.jsonl"));
// the prompt's attachment, `-i shot.png` in the session's directory
const codexCwd = join(root, "codex-pictures");
mkdirSync(codexCwd, { recursive: true });
const attached = /"image_url":"data:image\/png;base64,([A-Za-z0-9+/=]+)"/.exec(readFileSync(codexPath, "utf8"))![1]!;
writeFileSync(join(codexCwd, "shot.png"), Buffer.from(attached, "base64"));

const page = (source: "omp-transcript" | "codex-transcript", path: string): ConversationResponse => {
  const { turns, metadata } = transcriptPage(source, path, {}, codexHome);
  return { source, history_id: "fixture", cursor: null, turns, metadata };
};
const served: string[] = [];
const mentionedPath = "/Users/fixture/Library/Mobile Documents/notes/.ovis/paste-20261103-065352-8f69b25b.png";
const mentionedReads: URL[] = [];

/**
 * The size of every picture `selector` matches, once Chrome has decoded each one: loading="lazy"
 * defers a fetch until the picture is near the viewport, and naturalWidth only settles once what came
 * back is decoded. Throws when one is not decoded in time, a 404 or a broken picture included.
 */
async function decoded(view: Page, selector: string): Promise<number[][]> {
  await view.waitForFunction((matched) => {
    const imgs = [...document.querySelectorAll<HTMLImageElement>(matched)];
    return imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0);
  }, selector, { timeout: 10_000 });
  return view.locator(selector).evaluateAll((imgs) => imgs.map((img) => [(img as HTMLImageElement).naturalWidth, (img as HTMLImageElement).naturalHeight]));
}

const pageErrors = new Map<Page, string[]>();

async function open(conversation: ConversationResponse, viewport: { width: number; height: number }, mobile = false): Promise<Page> {
  const context = await browser!.newContext({ viewport, isMobile: mobile, hasTouch: mobile, locale: "en-US" });
  const view = await context.newPage();
  const errors: string[] = [];
  pageErrors.set(view, errors);
  view.on("pageerror", (error) => errors.push(error.message));
  await view.route("**/api/pane/conversation?*", (route) => route.fulfill({ json: conversation }));
  await view.goto(`http://127.0.0.1:${server!.port}/`);
  return view;
}

/** Closes a page opened with `open`, once it threw nothing. */
async function close(view: Page): Promise<void> {
  assert.deepEqual(pageErrors.get(view), [], "the page threw nothing");
  await view.context().close();
}

try {
  const build = await Bun.build({ entrypoints: ["scripts/chat-history-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"development"' } });
  assert.ok(build.success, String(build.logs));
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/fs/file") {
      mentionedReads.push(url);
      assert.equal(url.searchParams.get("path"), mentionedPath);
      assert.equal(url.searchParams.get("pane_id"), "a");
      return new Response(Buffer.from(attached, "base64"), { headers: { "content-type": "image/png" } });
    }
    if (url.pathname === "/api/pane/conversation/image") {
      // answered by the endpoint's own readers, from the files as the agents wrote them
      const ref = url.searchParams.get("ref") ?? "";
      served.push(ref);
      const image = ref.startsWith("codex-tool:") ? await codexToolImage(codexPath, ref, codexHome)
        : ref.startsWith("codex-") ? await codexTranscriptImage([{ path: codexPath, end: Bun.file(codexPath).size }], ref, codexCwd)
        : await ompTranscriptImage(ompPath, ref);
      return image ? new Response(image.bytes, { headers: { "content-type": image.mediaType } }) : new Response(JSON.stringify({ error: { code: "image_not_found" } }), { status: 404 });
    }
    const path = url.pathname;
    if (path.endsWith("/pane/commands")) return Response.json({ commands: [] });
    return path === "/" ? new Response('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/chat-history-fixture.css"></head><body><div id="root"></div><script type="module" src="/chat-history-fixture.js"></script></body></html>', { headers: { "Content-Type": "text/html" } }) : new Response(Bun.file(join(root, path.slice(1))));
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const evidence = process.env["UI_EVIDENCE_DIR"];
  if (evidence) mkdirSync(evidence, { recursive: true });

  // omp: three prompts with a picture (the last only a picture) and a `read` that returned one
  const omp = page("omp-transcript", ompPath);
  assert.ok(!JSON.stringify(omp).includes("blob:sha256"), "the page carries refs, never omp's blob refs or bytes");
  const ompView = await open(omp, { width: 1200, height: 800 });
  await ompView.getByText("The same red square.").waitFor();
  const prompts = ompView.locator(".chat-turn-user");
  assert.equal(await prompts.count(), 4);
  assert.deepEqual(await prompts.evaluateAll((turns) => turns.map((turn) => turn.querySelectorAll(".chat-user-images img").length)), [1, 0, 1, 1]);
  assert.equal(await prompts.nth(3).locator(".chat-bubble").count(), 0, "a picture alone draws no empty bubble");
  const sizes = await decoded(ompView, ".chat-turn-user .chat-user-images img");
  assert.equal(sizes.length, 3);
  assert.ok(sizes.every(([width, height]) => width! > 1 && width === height), `Chrome decoded omp's WebP from the blob store: ${JSON.stringify(sizes)}`);
  console.log(`PASS omp prompt pictures, a picture-only prompt its own turn, decoded from the blob store (${JSON.stringify(sizes[0])})`);
  // the read's picture is on its folded work line: omp's refs are pi's, which the browser keeps
  assert.equal(await ompView.locator(".work-block-head").first().getAttribute("aria-expanded"), "false");
  const ompLine = ompView.locator(".work-block-line .work-images");
  assert.equal(await ompLine.count(), 1);
  const lineSizes = await decoded(ompView, ".work-block-line .work-image img");
  assert.ok(lineSizes.length === 1 && lineSizes[0]![0]! > 1, `Chrome decoded the read's picture on the line: ${JSON.stringify(lineSizes)}`);
  assert.ok(served.some((ref) => /^pi:call_[0-9a-f]+\|fc_[0-9a-f]+:0$/.test(ref)), "the read's picture is fetched by its call, `|` and all");
  await ompLine.locator(".work-image").first().click();
  const viewer = ompView.getByRole("dialog", { name: "Image viewer" });
  await viewer.waitFor();
  await ompView.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached" });
  await ompView.mouse.move(5, 5);
  if (evidence) await ompView.screenshot({ path: join(evidence, "omp-pictures-desktop.png"), fullPage: true });
  await close(ompView);
  console.log("PASS omp's read picture on its folded work line, decoded, and opens the viewer");

  // Codex: the exec tool's picture loads only once its row is opened (its refs are served no-store)
  const codex = page("codex-transcript", codexPath);
  assert.ok(!JSON.stringify(codex).includes("iVBORw0KGgo"), "the page carries refs, never the picture's bytes");
  const codexView = await open(codex, { width: 1200, height: 800 });
  await codexView.getByText("Blue").waitFor();
  assert.deepEqual(await decoded(codexView, ".chat-turn-user .chat-user-images img"), [[32, 32]], "the prompt's attachment, as before");
  const before = served.length;
  // folded, the page holds no element that could fetch the tool's picture, so none is fetched later
  assert.equal(await codexView.locator(".work-block-line .work-images").count(), 0, "a Codex picture stays off the folded line");
  assert.equal(await codexView.locator('img[src*="codex-tool%3A"]').count(), 0, "no picture element asks for the tool's picture while its row is folded");
  assert.equal(served.filter((ref) => ref.startsWith("codex-tool:")).length, 0, "nothing was fetched while the row is folded");
  await codexView.locator(".work-block-head").last().click();
  const row = codexView.locator(".work-row-head").filter({ hasText: "exec" });
  await row.first().click();
  assert.deepEqual(await decoded(codexView, ".chat-tool-images img"), [[32, 32]], "Chrome decoded view_image's 32x32 PNG from the endpoint's bytes");
  assert.deepEqual(served.slice(before).filter((ref) => ref.startsWith("codex-tool:")), ["codex-tool:call_c14dcc9fd54946c7bc093bac1ec706fd:0"]);
  if (evidence) await codexView.screenshot({ path: join(evidence, "codex-tool-picture-desktop.png"), fullPage: true });
  await close(codexView);
  console.log("PASS a Codex tool's picture loads once its row is opened, decoded from the endpoint's bytes");

  // Composer uploads are plain @paths in the transcript, including spaces in an iCloud cwd.
  const mentioned: ConversationResponse = { source: "codex-transcript", history_id: "fixture", cursor: null, turns: [
    { role: "user", ts: null, parts: [{ kind: "text", text: `@${mentionedPath} Can you check this image?` }] },
    { role: "assistant", ts: null, parts: [{ kind: "text", text: "A blue square." }] },
  ] };
  for (const width of [1200, 390]) {
    const view = await open(mentioned, { width, height: 844 }, width === 390);
    assert.deepEqual(await decoded(view, ".chat-turn-user .chat-user-images img"), [[32, 32]]);
    await view.locator(".chat-user-image").click();
    const dialog = view.getByRole("dialog", { name: "Image viewer" });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole("link", { name: "Download", exact: true }).getAttribute("download"), "paste-20261103-065352-8f69b25b.png");
    await view.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.ok(await view.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    if (evidence) await view.screenshot({ path: join(evidence, `spaced-image-mention-${width}.png`), fullPage: true });
    await close(view);
  }
  assert.ok(mentionedReads.length >= 2);
  console.log("PASS spaced attachment paths decode and open the image viewer at desktop and phone widths");

  // a phone: the same prompts and line fit the screen
  const phone = await open(omp, { width: 390, height: 844 }, true);
  await phone.getByText("The same red square.").waitFor();
  const phoneSizes = await decoded(phone, ".chat-turn-user .chat-user-images img");
  assert.ok(phoneSizes.length === 3 && phoneSizes.every(([width]) => width! > 1), `the prompts' pictures decode on a phone: ${JSON.stringify(phoneSizes)}`);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `nothing spills past a 390px screen (${overflow}px)`);
  if (evidence) await phone.screenshot({ path: join(evidence, "omp-pictures-phone.png"), fullPage: true });
  await close(phone);
  console.log("PASS omp and Codex pictures: browser OK (3 omp prompt pictures and its read's, a Codex tool's on open, phone width)");
} finally {
  await browser?.close();
  server?.stop();
  rmSync(root, { recursive: true, force: true });
}
