/** Real browser and HTTP bytes; the pane API fixture has a foreground cwd different from the hint. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { chromium } from "playwright-core";
import { chromePath } from "./chrome-path.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-chat-images-"));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let status = 503;
let kind = "image";
const stats: URL[] = [];
const reads: string[] = [];
// set, a stat and a byte read wait until the page has seen the frames it needs
let held: { promise: Promise<void>; release: () => void } | null = null;
const foreground = "/repo/subproject";
const foregroundPath = `${foreground}/out/diagram.svg`;
const image = (width: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="80"><rect width="${width}" height="80" fill="teal"/></svg>`;

try {
  const build = await Bun.build({ entrypoints: ["scripts/chat-markdown-images-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"production"' } });
  assert.ok(build.success, String(build.logs));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/release-stat") { held?.release(); return new Response(null, { status: 204 }); }
    if (url.pathname === "/api/machines/fixture-pc/fs/stat") {
      stats.push(url);
      await held?.promise;
      assert.equal(url.searchParams.get("pane_id"), "w1:p1");
      if (status !== 200) return Response.json({ error: { code: "not_found", message: "not ready" } }, { status });
      const target = url.searchParams.get("path")!;
      const path = posix.isAbsolute(target) ? target : posix.resolve(foreground, target);
      return Response.json({ path, name: posix.basename(path), size: 100, modified: "2026-10-30T00:00:00Z", mime: "image/svg+xml", kind });
    }
    if (url.pathname === "/api/machines/fixture-pc/fs/file") {
      assert.equal(url.searchParams.get("pane_id"), "w1:p1");
      const path = url.searchParams.get("path")!;
      reads.push(path);
      await held?.promise;
      return new Response(image(path === foregroundPath ? 240 : 16), { headers: { "content-type": "image/svg+xml", "cache-control": "no-store" } });
    }
    if (url.pathname === "/") return new Response('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/chat-markdown-images-fixture.css"></head><body><div id="root"></div><script type="module" src="/chat-markdown-images-fixture.js"></script></body></html>', { headers: { "content-type": "text/html" } });
    if (/^\/chat-markdown-images-fixture\.(?:js|css)$/.test(url.pathname)) return new Response(Bun.file(join(root, url.pathname.slice(1))));
    return new Response("not found", { status: 404 });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  const decoded = () => page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>("img.markdown-image");
    return image?.complete && image.naturalWidth === 240;
  });
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await retry.waitFor();
  const before = stats.length;
  await page.evaluate(() => window.imageQa.update("Updated answer: ![Diagram](./out/diagram.svg)"));
  await page.getByText("Updated answer:", { exact: true }).waitFor();
  assert.equal(stats.length, before, "text updates neither hide Retry nor start an automatic loop");
  status = 200;
  await retry.click();
  await decoded();
  assert.equal(stats.length, before + 1);
  assert.equal(stats.at(-1)!.searchParams.get("path"), "./out/diagram.svg");
  assert.equal(reads.at(-1), foregroundPath);
  console.log("PASS A 503 recovers on Try again without reconnect or remount; relative stat and canonical bytes keep the owning PC and pane");

  status = 404;
  await page.reload();
  await retry.waitFor();
  status = 200;
  await retry.click();
  await decoded();
  console.log("PASS A missing image can be retried after it becomes available");

  kind = "text";
  await page.reload();
  await page.getByText("Diagram", { exact: true }).waitFor();
  assert.equal(await retry.count(), 0);
  assert.equal(await page.locator("img.markdown-image").count(), 0);
  console.log("PASS A non-image reference stays fallback without a retry button");
  kind = "image";
  await page.reload();
  await decoded();
  await page.getByRole("button", { name: "Diagram", exact: true }).click();
  const viewer = page.getByRole("dialog", { name: "Image viewer", exact: true });
  await viewer.waitFor();
  assert.equal(await viewer.getByRole("link", { name: "Download", exact: true }).getAttribute("download"), "diagram.svg");
  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached" });
  console.log("PASS The recovered image still opens in the viewer with its actual filename");

  // A reopened chat draws a known image at its final height from the first frame (#2548).
  await page.evaluate(() => window.imageQa.update("Answer\n\n![Diagram](./out/diagram.svg)\n\nAfter the image."));
  // `complete` is true a task before `load` fires; the slot gives its box up only on `load`
  await page.waitForFunction(() => document.querySelector("img.markdown-image")?.closest(".image-slot:not(.is-loading)") != null);
  const statsBefore = stats.length;
  const hold = Promise.withResolvers<void>();
  held = { promise: hold.promise, release: hold.resolve };
  const tops = await page.evaluate(() => new Promise<number[]>((done) => {
    const seen: number[] = [];
    const top = () => [...document.querySelectorAll("p")].find((node) => node.textContent === "After the image.")?.getBoundingClientRect().top ?? -1;
    const old = document.querySelector("img.markdown-image")!;
    const frame = () => {
      // from the first frame the new mount is in, whatever it draws
      const image = document.querySelector<HTMLImageElement>("img.markdown-image");
      const remounted = !document.contains(old);
      if (remounted) seen.push(top());
      // the stat and the bytes answer only after five frames of the new mount, as a slow PC or link would
      if (seen.length === 5) void fetch("/release-stat");
      // ten more frames after the bytes are in, so a late move is seen too
      // a regression that never settles fails on what it showed, not on CI's timeout
      if (seen.length > 600) { done(seen); return; }
      if (remounted && image?.complete && image.naturalWidth === 240 && document.querySelector(".image-slot.is-loading") === null) {
        if (seen.length > 10 && seen.slice(-10).every((value) => value === seen.at(-1))) { done(seen); return; }
      }
      requestAnimationFrame(frame);
    };
    window.imageQa.reopen();
    requestAnimationFrame(frame);
  }));
  assert.deepEqual([...new Set(tops)], [tops.at(-1)], `the text below a reopened image never moves (tops by frame: ${tops.join(", ")})`);
  assert.equal(stats.length, statsBefore + 1, "a reopen checks the image again, once");
  held = null;
  console.log("PASS A reopened image holds its final height from the first frame");

  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server?.stop();
  rmSync(root, { recursive: true, force: true });
}
