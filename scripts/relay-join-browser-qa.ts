/** Explicit dashboard consent starts pairing once; external offers keep their confirmation. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import { chromePath } from "./chrome-path.ts";
import { directoryOf, fleetOf } from "./relay-dashboard-fixtures.ts";
import { servePagesSite } from "./pages-static.ts";
import { closeMarked, whileOpen } from "./relay-qa-teardown.ts";

const APP = "https://app.ovis.sh";
const evidence = process.env["UI_EVIDENCE_DIR"];
if (!evidence) throw new TypeError("UI_EVIDENCE_DIR is required");
mkdirSync(evidence, { recursive: true });
const root = join(import.meta.dir, "..");
const built = mkdtempSync(join(tmpdir(), "ovis-relay-join-qa-"));
const report: object[] = [];

try {
  const build = Bun.spawn([process.execPath, "--bun", join(root, "node_modules/.bin/vite"), "build", "--mode", "shell", "--outDir", built, "--emptyOutDir", "--logLevel", "warn"], {
    cwd: root, env: process.env, stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  if (await build.exited !== 0) throw new TypeError("Shell build failed");
  const site = servePagesSite(built, 0, "127.0.0.1");
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    for (const width of [390, 1440, 1920]) for (const theme of ["light", "dark"] as const) for (const language of ["en", "ko"]) for (const mode of ["new", "join"] as const) {
      const name = `${mode}-${width}-${theme}-${language}`;
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme,
        isMobile: width === 390, hasTouch: width === 390, deviceScaleFactor: 1, serviceWorkers: "block",
      });
      try {
        const fake = new FakeAccountService();
        const errors: string[] = [];
        await context.route(/.*/, async (route) => { errors.push(`Unexpected host: ${new URL(route.request().url()).host}`); await route.abort(); });
        await context.route(/^https:\/\/app\.ovis\.sh\//, whileOpen(context, async (route) => {
          const url = new URL(route.request().url());
          await route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:${site.port}${url.pathname}${url.search}` }) });
        }));
        await context.route(/^https:\/\/account\.ovis\.sh\//, async (route) => {
          const request = route.request();
          const cors = { "access-control-allow-origin": APP, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
          if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors }); return; }
          if (new URL(request.url()).pathname === "/v1/pcs" && request.headers()["authorization"]) {
            await route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ pcs: directoryOf(fleetOf("FREADY"), Date.now()) }) });
            return;
          }
          const body = request.postDataBuffer();
          const answer = await fake.fetch(new Request(request.url(), { method: request.method(), headers: request.headers(), ...(body === null ? {} : { body }) }));
          const location = answer.headers.get("location");
          if (answer.status === 302 && location?.startsWith(APP)) {
            await route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><meta http-equiv="refresh" content="0;url=${location.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">` });
            return;
          }
          await route.fulfill({ status: answer.status, headers: { ...Object.fromEntries(answer.headers), ...cors }, body: Buffer.from(await answer.arrayBuffer()) });
        });
        await context.routeWebSocket(/.*/, () => {});
        await context.addInitScript(({ theme, language }) => {
          localStorage.setItem("ovis:settings", JSON.stringify({ theme, language }));
        }, { theme, language });
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(APP);
        await page.locator(".account-provider").first().click();
        // a sign-in lands on Add a PC, never the dashboard: that opens only by its own address
        await page.locator('main.relay-add-screen[data-account-state="signed-in"] .relay-add, [data-add-pc-mode]').first().waitFor({ timeout: 45_000 });
        await page.goto(`${APP}/#overview`);
        await page.locator('[data-dashboard-mode="account"]').waitFor();
        const pc = mode === "new" ? "New mini PC" : "Old MacBook";
        const row = page.locator(':is(tr,li)[data-pc-state]').filter({ hasText: pc })
          .filter({ has: page.locator("[data-pc-action]") }).first();
        await row.locator("[data-pc-action]").first().click();
        const sheet = page.locator(`[data-add-pc-mode="${mode}"][data-add-pc-phase="start"]`);
        await sheet.waitFor();
        await sheet.locator("[data-sheet-primary]").click();
        await page.locator(`[data-add-pc-mode="${mode}"][data-add-pc-phase="connecting"]`).waitFor({ timeout: 15_000 });
        await page.evaluate(() => document.fonts.ready);
        await page.locator("[data-add-pc-phase]").evaluate(async (element) => {
          await Promise.all(element.getAnimations({ subtree: true })
            .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
            .map((animation) => animation.finished));
        });
        const geometry = await page.locator("[data-add-pc-phase]").evaluate((element) => ({
          phase: element.getAttribute("data-add-pc-phase"),
          name: element.querySelector(".modal-title")?.textContent,
          visibleStatus: element.querySelector('[role="status"]')?.textContent,
          overflow: document.documentElement.scrollWidth > innerWidth,
          focusInside: element.contains(document.activeElement),
          footerBottom: element.querySelector(".modal-footer")?.getBoundingClientRect().bottom,
          viewportHeight: innerHeight,
        }));
        await page.screenshot({ path: join(evidence, `${name}.png`) });
        if (geometry.overflow || !geometry.focusInside || !geometry.visibleStatus?.includes(pc)
          || geometry.footerBottom === undefined || geometry.footerBottom > geometry.viewportHeight + 1) {
          throw new TypeError(`${name}: ${JSON.stringify(geometry)}`);
        }
        if (errors.length) throw new TypeError(`${name}: ${errors.join("; ")}`);
        report.push({ name, ...geometry });
        console.log(`PASS ${name}: one confirmation reaches connecting; focus and footer contained`);
        await page.keyboard.press("Escape");
        await page.locator('[data-dashboard-mode="account"]').waitFor();
        if (await page.locator("[data-add-pc-phase]").count() !== 0) throw new TypeError(`${name}: Cancel retained the sheet`);
      } finally {
        await closeMarked(context);
      }
    }
  } finally {
    await closeMarked(browser);
    await site.stop(true);
  }
} finally {
  writeFileSync(join(evidence, "results.json"), JSON.stringify(report, null, 2));
  rmSync(built, { recursive: true, force: true });
}
