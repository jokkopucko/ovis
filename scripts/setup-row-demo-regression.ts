/** With UI_EVIDENCE_DIR, each state is captured under setup-row/. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const app = mkdtempSync(join(tmpdir(), "ovis-setup-row-"));
const evidence = process.env["UI_EVIDENCE_DIR"] ? join(process.env["UI_EVIDENCE_DIR"], "setup-row") : null;
if (evidence) mkdirSync(evidence, { recursive: true });
const DIALOG = "Set up Ovis";
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity)).map((animation) => animation.finished.catch(() => undefined))).then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))));

let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/icons/")) { const icon = Bun.file(join(app, path)); return (await icon.exists()) ? new Response(icon) : new Response("not found", { status: 404 }); }
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const root = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const sizes = [
    { width: 1920, height: 1080 },
    { width: 1280, height: 720 },
    { width: 390, height: 844, phone: true },
    { width: 700, height: 900, drawer: true },
  ] as const;
  for (const size of sizes) {
    for (const theme of ["dark", "light"] as const) {
      const at = `${size.width}x${size.height}-${theme}`;
      const phone = "phone" in size;
      const drawer = "drawer" in size;
      const context = await browser.newContext(phone
        ? { viewport: { width: size.width, height: size.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, locale: "en-US", colorScheme: theme }
        : { viewport: { width: size.width, height: size.height }, locale: "en-US", colorScheme: theme });
      await context.addInitScript(([value]) => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: value, palette: "codex", darkTheme: "codex", lightTheme: "codex" }));
        if (sessionStorage.getItem("seeded") === null) {
          localStorage.setItem("ovis:setup-guide", JSON.stringify({ status: "closed" }));
          localStorage.setItem("ovis:first-hints", "pending");
          localStorage.setItem("ovis:setup-row", "on");
          sessionStorage.setItem("seeded", "1");
        }
      }, [theme] as const);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const shot = async (name: string) => { if (evidence) { await settled(page); await page.screenshot({ path: join(evidence, `${name}-${at}.png`) }); } };
      try {
        await page.goto(root);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        if (phone || drawer) {
          await page.locator(".conn-live").waitFor({ state: "attached" });
          await page.getByText("Idempotent payments", { exact: true }).first().waitFor();
          await settled(page);
          await settled(page);
          assert.equal(await page.locator(".first-hint").count(), 0, `no hint where the sidebar is a drawer ${at}`);
          console.log(`PASS no first-start hint where the sidebar is a drawer (${at})`);
          continue;
        }

        const hint = page.getByRole("dialog", { name: "Chat or Terminal", exact: true });
        await hint.waitFor();
        await settled(page);
        assert.equal(await hint.locator(".first-hint-count").innerText(), "1/3", `the first hint counts itself ${at}`);
        const switchBox = (await page.locator(".view-switch").boundingBox())!;
        const hintBox = (await hint.boundingBox())!;
        assert.ok(hintBox.y >= switchBox.y + switchBox.height, `the first hint sits under the switch ${at}: ${JSON.stringify({ switchBox, hintBox })}`);
        assert.equal(await page.evaluate(() => document.activeElement?.closest(".first-hint") ?? null), null, `the hint takes no keyboard ${at}`);
        await shot("1-hint-chat");
        await hint.getByRole("button", { name: "Next", exact: true }).focus();
        await page.keyboard.press("Enter");
        const second = page.getByRole("dialog", { name: "Waiting agents first", exact: true });
        await second.waitFor();
        await settled(page);
        const agentsBox = (await page.locator(".agents-sidebar > .agent-section-toggle").boundingBox())!;
        assert.ok((await second.boundingBox())!.x >= agentsBox.x + agentsBox.width, `the second hint sits beside the Agents section ${at}`);
        assert.equal(await page.evaluate(() => document.activeElement?.closest(".first-hint")?.querySelector("h2")?.textContent ?? null), "Waiting agents first", `Next from the keyboard keeps the focus in the hints ${at}`);
        await shot("2-hint-agents");
        await second.getByRole("button", { name: "Next", exact: true }).focus();
        await page.keyboard.press("Escape");
        await second.waitFor({ state: "detached" });
        assert.equal(await page.evaluate(() => localStorage.getItem("ovis:first-hints")), "done", `closed hints stay done ${at}`);

        const row = page.locator(".sidebar-footer .setup-row-open");
        await row.waitFor();
        assert.equal((await row.innerText()).trim(), "Setup: 2 left", `the row counts what is left ${at}`);
        await shot("3-setup-row");
        await row.click();
        const dialog = page.getByRole("dialog", { name: DIALOG, exact: true });
        await dialog.getByRole("heading", { name: "Stay in touch", exact: true }).waitFor();
        await settled(page);
        await shot("4-reopened-at-phone");
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        await page.getByRole("button", { name: "Hide setup reminder", exact: true }).click();
        await row.waitFor({ state: "detached" });
        await page.reload();
        await page.locator(".workspace-group[data-workspace]").first().waitFor({ state: "attached" });
        await page.locator(".view-switch").first().waitFor();
        await settled(page);
        await settled(page);
        assert.equal(await page.locator(".setup-row-open").count(), 0, `a hidden row stays hidden ${at}`);
        assert.equal(await page.locator(".first-hint").count(), 0, `no hints after they were closed ${at}`);
        if (size.width === 1920) {
          const listed = await context.newPage();
          try {
            await listed.addInitScript(() => localStorage.setItem("ovis:setup-row", "on"));
            await listed.goto(`${root}?demo_devices=list`);
            await listed.locator(".sidebar-footer .setup-row-open").filter({ hasText: "Setup: 1 left" }).waitFor();
          } finally {
            await listed.close();
          }
        }
        console.log(`PASS the hints show one at a time by their anchors and close for good, and Setup: N left counts what is left and reopens the guide there (${at})`);
        assert.deepEqual(errors, [], `no page errors ${at}`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser?.close();
  await server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
