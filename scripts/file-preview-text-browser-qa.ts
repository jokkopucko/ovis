import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { build as viteBuild } from "vite";
import { serveStatic } from "../server/static.ts";
import { chromePath } from "./chrome-path.ts";
const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-text-preview-")));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  const repo = join(import.meta.dir, ".."), output = join(root, "dist");
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repo, "scripts/file-preview-text-fixture.tsx"), join(root, "fixture.tsx"));
  writeFileSync(join(root, "index.html"), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  await viteBuild({ configFile: join(repo, "vite.config.ts"), root, publicDir: false, logLevel: "warn", build: { outDir: output, emptyOutDir: true } });
  const policy = (await serveStatic("/")).headers.get("content-security-policy");
  assert.ok(policy, "build the app before its enforcing CSP regression");
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const delayed = (fn: () => void, ms: number) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); };
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url), path = url.searchParams.get("path");
    if (url.pathname === "/api/fs/stat") return Response.json({ path, name: path, kind: "text", size: 3, mime: "text/plain", modified: "2026-01-01T00:00:00Z" });
    if (url.pathname === "/api/fs/file") {
      if (path === "error") return new Response("PRIVATE ERROR BODY", { status: 401 });
      if (path === "large") return new Response("x".repeat(300_000));
      if (path === "headers") return new Promise<Response>((resolve) => delayed(() => resolve(new Response("LATE HEADER")), 7_000));
      if (path === "body" || path === "close") return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        delayed(() => { try { controller.enqueue(new TextEncoder().encode("LATE BODY")); controller.close(); } catch {} }, 7_000);
      } }));
      return new Response("한글 complete");
    }
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    return new Response(Bun.file(join(output, url.pathname === "/" ? "index.html" : url.pathname.slice(1))), { headers: { "content-security-policy": policy } });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage(); page.setDefaultTimeout(10_000);
  await page.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
  const errors: string[] = [], cancelled: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => cancelled.push(request.url()));
  await page.goto(`http://127.0.0.1:${server.port}`);
  const open = async (path: string) => { await page.evaluate((path) => window.previewQA.open(path), path); await page.getByRole("dialog").waitFor(); };
  await open("error");
  // a 401 says what to do about it (lib/fileFailure.ts), never the body it came with
  await page.getByRole("alert").filter({ hasText: "Pair this browser again to open the file." }).waitFor();
  assert.equal(await page.locator(".file-viewer-text").count(), 0);
  assert.ok(!(await page.locator("body").innerText()).includes("PRIVATE ERROR BODY"));
  await open("large"); await page.locator(".file-viewer-text").waitFor();
  assert.equal((await page.locator(".file-viewer-text").textContent())?.length, 256 * 1024);
  await page.getByText("Only part of this file is shown. Download it to read the rest.", { exact: true }).waitFor();
  if (process.env.UI_EVIDENCE_DIR) {
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByText("Only part of this file is shown. Download it to read the rest.", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "text-preview-mobile.png") });
  }
  {
    const start = performance.now(); await open("headers");
    await page.getByRole("alert").filter({ hasText: "The file request timed out. Reopen it to try again." }).waitFor();
    assert.ok(performance.now() - start < 6_500, "headers has a bounded deadline");
    assert.equal(await page.locator(".file-viewer-text").count(), 0);
  }
  {
    const start = performance.now(); await open("body");
    await page.getByText("Only part of this file is shown. Download it to read the rest.", { exact: true }).waitFor();
    assert.ok(performance.now() - start < 6_500, "body has a bounded deadline");
    assert.equal(await page.locator(".file-viewer-text").textContent(), "partial");
    assert.ok(!(await page.locator("body").innerText()).includes("LATE BODY"));
  }
  const closingResponse = page.waitForResponse((response) => new URL(response.url()).searchParams.get("path") === "close");
  await open("close");
  await closingResponse;
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await open("good"); await page.getByText("한글 complete", { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector(".file-viewer-text")?.textContent === "한글 complete");
  assert.ok(cancelled.some((url) => new URL(url).searchParams.get("path") === "close"), "closing aborts the active response");
  assert.deepEqual(errors, []);
  for (const timer of timers) clearTimeout(timer);
  console.log("text preview: browser OK (HTTP errors, ignored Range and stale stat, UTF-8, header deadline, stalled body kept as a cut prefix, close-abort and recovery)");
} finally {
  await browser?.close(); server?.stop(true); rmSync(root, { recursive: true, force: true });
}
