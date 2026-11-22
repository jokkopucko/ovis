/**
 * The chat's list (@legendapp/list) pads its content for a frame when it moves the scroll past the
 * content's end, then removes the padding if it still reads back as set. Chromium rounds a long
 * fraction ("214.1875px" reads "214.188px"), so before the patch in patches/ that padding stayed,
 * grew with every later adjustment and left a blank under the chat until it was reopened.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
import type {} from "./chat-scroll-padding-fixture.tsx";

const STEPS = 150;
const root = mkdtempSync(join(tmpdir(), "herdr-chat-padding-"));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  const build = await Bun.build({
    entrypoints: ["scripts/chat-scroll-padding-fixture.tsx"], outdir: root, target: "browser",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  assert.ok(build.success, String(build.logs));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response('<!doctype html><html lang="en"><body style="margin:0"><div id="root"></div><script type="module" src="/chat-scroll-padding-fixture.js"></script></body></html>', { headers: { "content-type": "text/html" } });
    // a path the build did not write (the browser's /favicon.ico) is a 404: a Bun.file of a
    // missing path fails the response with ENOENT, and that exits the script with 1
    const file = Bun.file(join(root, path.slice(1)));
    return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  // a Retina screen: scroll offsets and row edges fall between whole pixels
  const page = await (await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 800, height: 700 } })).newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.waitForSelector(".padding-qa-footer");
  await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".padding-qa-content");
    if (!content) throw new Error("no list content");
    const seen: string[] = [];
    (window as unknown as { paddings: string[] }).paddings = seen;
    new MutationObserver(() => { if (content.style.paddingBottom) seen.push(content.style.paddingBottom); }).observe(content, { attributes: true, attributeFilter: ["style"] });
  });
  const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  for (let step = 0; step < STEPS; step++) {
    await page.evaluate((step) => {
      const scroller = document.querySelector<HTMLElement>(".padding-qa-scroller");
      if (!scroller) throw new Error("no list scroller");
      scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - ((step * 13) % 17) * 23.3;
    }, step);
    await frames();
    await page.evaluate((step) => {
      window.paddingQa.header(20 + ((step * 37) % 11) * 97.13);
      if (step % 3 === 0) window.paddingQa.add(41.3 + (step % 7) * 23.71);
      if (step % 5 === 0) window.paddingQa.resize(-((step % 4) * 61.7));
    }, step);
    await frames();
    await frames();
    const left = await page.evaluate(() => {
      const content = document.querySelector<HTMLElement>(".padding-qa-content");
      const scroller = document.querySelector<HTMLElement>(".padding-qa-scroller");
      const footer = document.querySelector(".padding-qa-footer");
      if (!content || !scroller || !footer) throw new Error("list parts missing");
      return {
        padding: content.style.paddingBottom,
        afterFooter: Math.round(scroller.scrollHeight - scroller.scrollTop - (footer.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top)),
      };
    });
    assert.equal(left.padding, "", `step ${step}: the list's temporary end padding stayed (${JSON.stringify(left)})`);
    assert.ok(left.afterFooter <= 1, `step ${step}: blank space under the footer (${JSON.stringify(left)})`);
  }
  // the path ran: at least one padding at Chromium's six-digit limit, which a longer fraction is rounded to
  const paddings = await page.evaluate(() => (window as unknown as { paddings: string[] }).paddings);
  assert.ok(paddings.some((value) => /\.\d{3}px$/.test(value)), `no rounded padding was exercised: ${JSON.stringify(paddings)}`);
  console.log(`ok: ${STEPS} adjustments, no padding left (${paddings.length} temporary paddings, e.g. ${paddings.find((value) => /\.\d{3}px$/.test(value))})`);
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
}
