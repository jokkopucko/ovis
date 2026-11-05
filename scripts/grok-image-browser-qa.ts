/** Grok's pictures end to end in Chrome, from a recorded 1.0.67 session: parsed page -> prompt
 * thumbnail and the read_file tool's work line -> <img> bytes read back by grokImage, as the image
 * endpoint reads them. */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { transcriptPage } from "../server/conversation.ts";
import { grokImage } from "../server/grok.ts";
import type { ConversationResponse } from "../shared/protocol.ts";
import { chromePath } from "./chrome-path.ts";

// canonical: grokImage serves only a session file by its real path, and macOS tmpdir() is under /var, a link
const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-grok-image-browser-")));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
// the recorded session: a red 48x48 picture sent with the prompt, a blue one read_file read
const RED = "grok-image:db47bba5fe6470a832370fa0ca3cbfd9194dd1e36eaa3d67fdd33bea01d4b66a";
const BLUE = "grok-image:c75fe07b33afb7b182fa53cd500727a7cfa1699443a17d87d053d6536ad65438";
const served: string[] = [];

async function decoded(page: Page, selector: string): Promise<number[][]> {
  await page.waitForFunction((selector) => {
    const imgs = [...document.querySelectorAll<HTMLImageElement>(selector)];
    return imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0);
  }, selector);
  return page.locator(selector).evaluateAll((imgs) => imgs.map((img) => [(img as HTMLImageElement).naturalWidth, (img as HTMLImageElement).naturalHeight]));
}

try {
  const path = join(root, "sessions", "%2Ftmp%2Fgrok-proj", "01a19135-9ed8-7802-9f7f-c2c74a10a956", "updates.jsonl");
  mkdirSync(join(path, ".."), { recursive: true });
  copyFileSync(new URL("../server/fixtures/grok/pictures-1.0.67.jsonl", import.meta.url), path);
  const { source, turns, metadata } = transcriptPage("grok-transcript", path);
  const conversation: ConversationResponse = { source, history_id: "fixture", cursor: null, turns, metadata };
  const build = await Bun.build({ entrypoints: ["scripts/chat-history-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"development"' } });
  assert.ok(build.success, String(build.logs));
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/pane/conversation/image") {
      const ref = url.searchParams.get("ref") ?? "";
      served.push(ref);
      const image = await grokImage(path, ref);
      return image ? new Response(image.bytes, { headers: { "content-type": image.mediaType } }) : new Response(JSON.stringify({ error: { code: "image_not_found" } }), { status: 404 });
    }
    if (url.pathname.endsWith("/pane/commands")) return Response.json({ commands: [] });
    return url.pathname === "/" ? new Response('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/chat-history-fixture.css"></head><body><div id="root"></div><script type="module" src="/chat-history-fixture.js"></script></body></html>', { headers: { "Content-Type": "text/html" } }) : new Response(Bun.file(join(root, url.pathname.slice(1))));
  } });

  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const evidence = process.env["UI_EVIDENCE_DIR"];
  for (const [label, options] of [
    ["desktop", { viewport: { width: 1200, height: 800 } }],
    ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
  ] as const) {
    const context = await browser.newContext({ ...options, locale: "en-US" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/pane/conversation?*", (route) => route.fulfill({ json: conversation }));
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.getByText("blue", { exact: true }).waitFor();
    // the picture sent with the prompt sits under its words, decoded from the bytes Grok logged
    assert.deepEqual(await decoded(page, ".chat-turn-user .chat-user-images img"), [[48, 48]]);
    // the read_file picture shows on the folded work line
    assert.deepEqual(await decoded(page, ".work-block-line .work-image img"), [[48, 48]]);
    assert.deepEqual(errors, []);
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, `grok-images-${label}.png`) });
      await page.locator(".work-block-head").click();
      await page.locator(".work-row-head").first().click();
      assert.deepEqual(await decoded(page, ".chat-tool-images img"), [[48, 48]]);
      await page.screenshot({ path: join(evidence, `grok-images-${label}-open.png`) });
    }
    await context.close();
    console.log(`PASS ${label}: a Grok prompt's picture and its read_file picture decode from the recorded session`);
  }
  assert.deepEqual([...new Set(served)].sort(), [RED, BLUE].sort(), "only the two recorded pictures are fetched");
} finally {
  await browser?.close();
  server?.stop();
  rmSync(root, { recursive: true, force: true });
}
