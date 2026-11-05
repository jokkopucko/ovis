/** pi's pictures end to end in Chrome: parsed page -> prompt, work line or row -> <img> bytes. A
 * prompt that is only a picture is a turn of its own; a tool result's picture shows on its work line. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { transcriptPage } from "../server/conversation.ts";
import type { ConversationResponse } from "../shared/protocol.ts";
import { chromePath } from "./chrome-path.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-image-browser-"));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
// real 1x1 files, so Chrome decodes them: a naturalWidth of 1 proves the bytes that arrived
// are a picture, not a broken-image placeholder
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const png = { type: "image", mimeType: "image/png", data: PNG };
// pi's own record shapes: the picture sits in the tool result, beside the text it returns
const entries = [
  { type: "session", version: 3, id: "s", timestamp: "2026-09-30T00:00:00Z", cwd: root },
  { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-30T00:00:00Z", provider: "test", modelId: "qwen-test" },
  // a picture sent with no words: pi keeps it in the prompt
  { type: "message", id: "u0", parentId: "m1", timestamp: "2026-09-30T00:00:00Z", message: { role: "user", content: [{ type: "image", mimeType: "image/gif", data: GIF }] } },
  { type: "message", id: "a0", parentId: "u0", timestamp: "2026-09-30T00:00:00Z", message: { role: "assistant", model: "qwen-test", provider: "test", stopReason: "stop", usage: { input: 4, output: 2 }, content: [{ type: "text", text: "A single pixel." }] } },
  { type: "message", id: "u1", parentId: "a0", timestamp: "2026-09-30T00:00:01Z", message: { role: "user", content: "what is in this screenshot?" } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-30T00:00:02Z", message: {
    role: "assistant", model: "qwen-test", provider: "test", stopReason: "toolUse", usage: { input: 10, output: 4 },
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "shot.png" } }],
  } },
  { type: "message", id: "r1", parentId: "a1", timestamp: "2026-09-30T00:00:03Z", message: {
    role: "toolResult", toolCallId: "call-1", toolName: "read", content: [
      { type: "text", text: "read 2 images" },
      png,
      { type: "image", mimeType: "image/gif", data: GIF },
    ],
  } },
  // a second call's four pictures: the folded line holds the latest four, the first two counted on a tile
  { type: "message", id: "a2", parentId: "r1", timestamp: "2026-09-30T00:00:04Z", message: {
    role: "assistant", model: "qwen-test", provider: "test", stopReason: "toolUse", usage: { input: 10, output: 4 },
    content: [{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "shots" } }],
  } },
  { type: "message", id: "r2", parentId: "a2", timestamp: "2026-09-30T00:00:05Z", message: {
    role: "toolResult", toolCallId: "call-2", toolName: "read", content: [{ type: "text", text: "read 4 images" }, png, png, png, png],
  } },
];
const LATEST = ["pi:call-2:0", "pi:call-2:1", "pi:call-2:2", "pi:call-2:3"];
let conversation: ConversationResponse;
const bytes = new Map<string, { data: Buffer; type: string }>();
const served: string[] = [];

// loading="lazy" defers the fetch until a picture is near the viewport, and naturalWidth only
// settles once Chrome has decoded what came back
async function decoded(page: Page, selector: string): Promise<number[][]> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await page.locator(selector).evaluateAll((imgs) => imgs.length > 0 && imgs.every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0))) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  return page.locator(selector).evaluateAll((imgs) => imgs.map((img) => [(img as HTMLImageElement).naturalWidth, (img as HTMLImageElement).naturalHeight]));
}

try {
  const build = await Bun.build({ entrypoints: ["scripts/chat-history-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"development"' } });
  assert.ok(build.success, String(build.logs));
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/pane/conversation/image") {
      // served for real rather than by page.route: a fulfilled binary body is the harness's
      // business, and the point here is that the browser decodes the bytes the endpoint gives
      const image = bytes.get(url.searchParams.get("ref") ?? "");
      served.push(url.searchParams.get("ref") ?? "");
      return image ? new Response(new Uint8Array(image.data), { headers: { "content-type": image.type } }) : new Response(JSON.stringify({ error: { code: "image_not_found" } }), { status: 404 });
    }
    const path = url.pathname;
    if (path.endsWith("/pane/commands")) return Response.json({ commands: [] });
    return path === "/" ? new Response('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/chat-history-fixture.css"></head><body><div id="root"></div><script type="module" src="/chat-history-fixture.js"></script></body></html>', { headers: { "Content-Type": "text/html" } }) : new Response(Bun.file(join(root, path.slice(1))));
  } });
  const write = (rows: unknown[]) => {
    const path = join(root, "session.jsonl");
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const { source, turns, metadata } = transcriptPage("pi-transcript", path);
    conversation = { source, history_id: "fixture", cursor: null, turns, metadata, version: 1 };
  };
  write(entries);
  for (const part of conversation.turns.flatMap((turn) => turn.parts)) {
    const images = part.kind === "tool" ? part.images ?? [] : part.kind === "image" ? [part] : [];
    for (const image of images) bytes.set(image.ref, image.media_type === "image/png" ? { data: Buffer.from(PNG, "base64"), type: "image/png" } : { data: Buffer.from(GIF, "base64"), type: "image/gif" });
  }
  assert.equal(bytes.size, 7, "the page should address every picture: the prompt's and the six the tools returned");

  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/pane/conversation?*", (route) => route.fulfill({ json: conversation }));
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.getByText("what is in this screenshot?").waitFor();

  // the prompt that is only a picture is a turn of its own: its thumbnail, decoded, and no empty bubble
  const sent = page.locator(".chat-turn-user").first();
  assert.equal(await sent.locator(".chat-user-images img").count(), 1);
  assert.equal(await sent.locator(".chat-bubble").count(), 0, "a picture alone draws no empty bubble");
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>(".chat-turn-user .chat-user-images img");
    return img !== null && img.complete && img.naturalWidth === 1;
  });
  assert.ok(served.includes("pi-prompt:u0:0"), "the prompt's picture loads with the prompt");
  console.log("PASS a pi prompt that is only a picture is its own turn, its thumbnail decoded from the served bytes");

  // a settled turn's work is folded, and its line shows what the tools returned: the latest four
  // small, the two before them on a "+2" tile; the conversation itself carries refs only
  assert.equal(await page.locator(".work-block-head").getAttribute("aria-expanded"), "false");
  const line = page.locator(".work-block-line .work-images");
  assert.equal(await line.getAttribute("aria-label"), "Pictures from this work");
  assert.equal(await line.locator(".work-image.is-more").textContent(), "+2");
  assert.equal(await line.locator(".work-image.is-more").getAttribute("aria-label"), "All 6 pictures");
  assert.deepEqual(await decoded(page, ".work-block-line .work-image img"), [[1, 1], [1, 1], [1, 1], [1, 1]], "Chrome decoded the line's four thumbnails");
  assert.deepEqual([...new Set(served.filter((ref) => ref.startsWith("pi:")))].sort(), LATEST, "only the pictures the line shows are fetched");
  assert.equal(await page.locator(".chat-tool-images").count(), 0, "no row is open");
  console.log("PASS a folded block's line shows its latest four pictures and counts the rest, fetching only those four");

  // hovering a thumbnail shows it larger, with the tool's name and its place among the block's
  const second = line.locator(".work-image:not(.is-more)").nth(1);
  await second.hover();
  const preview = page.locator(".work-image-preview");
  await preview.waitFor();
  assert.equal(await preview.locator(".work-image-preview-bar").textContent(), "read4 of 6");
  assert.deepEqual(await decoded(page, ".work-image-preview img"), [[1, 1]]);
  const [thumbBox, previewBox] = [await second.boundingBox(), await preview.boundingBox()];
  // above its thumbnail where that fits, else under it: never over it
  assert.ok(thumbBox !== null && previewBox !== null && (previewBox.y + previewBox.height <= thumbBox.y || previewBox.y >= thumbBox.y + thumbBox.height), "the preview leaves its thumbnail in view");
  await page.mouse.move(5, 5);
  await preview.waitFor({ state: "detached" });
  console.log("PASS a hover shows the picture larger, named by its tool and place, and leaving takes it away");

  // a click opens the viewer on all six at that one; the tile opens it at the first
  await second.click();
  const viewer = page.getByRole("dialog", { name: "Image viewer" });
  await viewer.waitFor();
  assert.equal(await viewer.locator(".image-lightbox-count").textContent(), "4 of 6");
  assert.equal(await preview.count(), 0, "the viewer takes the preview's place");
  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached" });
  // by keyboard: Enter on a thumbnail opens the viewer, and the focus Escape gives back to the
  // thumbnail is a return, not a reader reaching it, so the preview stays away
  await page.mouse.move(5, 5);
  await second.focus();
  await page.keyboard.press("Enter");
  await viewer.waitFor();
  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached" });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("work-image") && document.activeElement.matches(":focus-visible")), true);
  assert.equal(await preview.count(), 0, "closing the viewer with Escape does not bring the preview back");
  await line.locator(".work-image.is-more").click();
  await viewer.waitFor();
  assert.equal(await viewer.locator(".image-lightbox-count").textContent(), "1 of 6");
  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached" });
  console.log("PASS a click opens the viewer on every picture of the block, at the one clicked or at the first from the tile");

  // opened, the block's line gives its pictures to its rows, each on its own line; an opened row
  // shows them larger in its detail
  await page.locator(".work-block-head").click();
  assert.equal(await page.locator(".work-block-line .work-images").count(), 0, "an open block's line carries none");
  assert.equal(await page.locator(".work-row-line .work-images").count(), 2);
  assert.equal(await page.locator(".work-row-line .work-images").first().locator(".work-image").count(), 2, "the first row's two");
  await page.locator(".work-row-head").first().click();
  assert.equal(await page.locator(".work-row-line .work-images").count(), 1, "an open row's line gives its pictures to its detail");
  assert.deepEqual(await decoded(page, ".chat-tool-images img"), [[1, 1], [1, 1]], "Chrome decoded both of the row's pictures from the served bytes");
  assert.deepEqual([...new Set(served.filter((ref) => ref.startsWith("pi:")))].sort(), ["pi:call-1:0", "pi:call-1:1", ...LATEST]);
  assert.equal(await page.locator(".chat-tool-output pre").first().textContent(), "read 2 images", "the text answer stays beside the pictures");
  assert.deepEqual(errors, []);

  const evidence = process.env["UI_EVIDENCE_DIR"];
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    await page.locator(".work-row-head").first().click();
    await page.locator(".work-block-head").click();
    await second.hover();
    await preview.waitFor();
    await page.screenshot({ path: join(evidence, "work-images-preview.png") });
    await page.mouse.move(5, 5);
    await page.locator(".work-block-head").click();
    await page.locator(".work-row-head").first().click();
  }

  // a picture the endpoint cannot answer leaves the line and the count, and the one before it moves up
  bytes.delete("pi:call-2:3");
  const reloaded = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" });
  await reloaded.route("**/api/pane/conversation?*", (route) => route.fulfill({ json: conversation }));
  await reloaded.goto(`http://127.0.0.1:${server.port}/`);
  const reloadedLine = reloaded.locator(".work-block-line .work-images");
  await reloadedLine.locator(".work-image.is-more").waitFor();
  await reloaded.waitForFunction(() => document.querySelectorAll(".work-block-line .work-image:not(.is-more)").length === 4 && document.querySelector(".work-block-line .work-image.is-more")?.textContent === "+1");
  assert.equal(await reloadedLine.locator(".work-image.is-more").getAttribute("aria-label"), "All 5 pictures");
  assert.deepEqual(await decoded(reloaded, ".work-block-line .work-image img"), [[1, 1], [1, 1], [1, 1], [1, 1]], "no broken icon is left on the line");
  await reloaded.close();
  console.log("PASS a picture that fails to load leaves the line, and the line fills from the ones before it");

  // beside a finger each thumbnail is a --touch-target square, three to the line
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
  const small = await phone.newPage();
  await small.route("**/api/pane/conversation?*", (route) => route.fulfill({ json: conversation }));
  await small.goto(`http://127.0.0.1:${server.port}/`);
  const smallLine = small.locator(".work-block-line .work-images");
  await smallLine.locator(".work-image.is-more").waitFor();
  assert.equal(await smallLine.locator(".work-image:not(.is-more)").count(), 3);
  const boxes = await smallLine.locator(".work-image").evaluateAll((buttons) => buttons.map((button) => [button.getBoundingClientRect().width, button.getBoundingClientRect().height]));
  assert.deepEqual(boxes, [[44, 44], [44, 44], [44, 44], [44, 44]], "every thumbnail and the tile is a 44px square");
  // the virtual list first places its rows at estimated heights and moves them once it has measured
  // them: two separate reads can fall on either side of that move. Both boxes come from one frame's
  // layout, taken once two frames in a row agree. The deadline is a timer, not a frame: a page that
  // stops drawing frames still fails here instead of leaving the evaluate waiting forever
  type Box = { x: number; y: number; width: number; height: number };
  const [head, strip] = await small.evaluate(() => new Promise<[Box, Box]>((settled, fail) => {
    let before = "";
    const deadline = setTimeout(() => fail(new Error(`the phone's folded line never settled: ${before}`)), 5000);
    const box = (selector: string): Box => {
      const found = document.querySelectorAll(selector);
      if (found.length !== 1) throw new Error(`expected one ${selector}, found ${found.length}`);
      const { x, y, width, height } = found[0]!.getBoundingClientRect();
      return { x, y, width, height };
    };
    const frame = () => {
      let boxes: [Box, Box];
      try { boxes = [box(".work-block-head"), box(".work-block-line .work-images")]; } catch (error) { clearTimeout(deadline); return fail(error); }
      const now = JSON.stringify(boxes);
      if (now === before) { clearTimeout(deadline); return settled(boxes); }
      before = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
  assert.ok(strip.x + strip.width <= 390 && Math.abs(strip.y - head.y) < 1, "the strip stays on the folded line, inside the screen");
  await smallLine.locator(".work-image:not(.is-more)").first().tap();
  await small.getByRole("dialog", { name: "Image viewer" }).waitFor();
  assert.equal(await small.locator(".work-image-preview").count(), 0, "a tap opens the viewer, with no hover preview");
  await phone.close();
  console.log("PASS on a phone the line holds three 44px thumbnails and a tap opens the viewer");

  // a result whose pictures vanish (the branch moved, the file changed) must not strand an <img>
  const kept = entries.filter((entry) => !["r1", "a2", "r2"].includes((entry as { id?: string }).id ?? ""));
  write(kept);
  await page.evaluate(() => window.qa.refresh());
  await page.locator(".work-block-head").click(); // fold, then unfold, so the row re-renders
  assert.equal(await page.locator(".work-images").count(), 0, "no picture, no line thumbnails");
  await page.locator(".work-block-head").click();
  assert.equal(await page.locator(".chat-tool-images").count(), 0, "no image, no container");
  console.log("PASS pi pictures: browser OK (a prompt's picture, 6 tool pictures served, the folded line's four first, text answer intact)");
} finally {
  await browser?.close();
  server?.stop();
  rmSync(root, { recursive: true, force: true });
}
