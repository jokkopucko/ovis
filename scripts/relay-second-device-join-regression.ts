/**
 * The sighting does not prove the machine is in the
 * account still (after Revoke all and a listing again its row keeps it), so the join sheet keeps Type the number, which
 * turns it into the typed-number sheet. The shell is the real build on
 * https://app.ovis.sh (routed here), the account service the in-memory fake with the directory answered here; no
 * relay or PC takes part (every WebSocket is closed at once), so nothing is paired.
 *
 * The shell is SHELL_DIR when set, else dist-shell/, else a build of its own when neither is there.
 *
 *   UI_EVIDENCE_DIR=<dir> bun scripts/relay-second-device-join-regression.ts
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import { generateKeyPair } from "../shared/relay-e2ee.ts";
import { deriveServerId } from "../shared/relay-server-proof.ts";
import { chromePath } from "./chrome-path.ts";
import { servePagesSite } from "./pages-static.ts";
import { closeMarked, whileOpen } from "./relay-qa-teardown.ts";

const APP = "https://app.ovis.sh";
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
if (evidence) mkdirSync(evidence, { recursive: true });
const root = join(import.meta.dir, "..");

const machines = [{ label: "m1-box", seenAgo: 30_000 }, { label: "desk2", seenAgo: null }].map((spec) => {
  const { publicKey } = generateKeyPair();
  return { ...spec, server_id: deriveServerId(publicKey), public_key: Buffer.from(publicKey).toString("hex") };
});
const directory = () => machines.map((pc) => ({
  server_id: pc.server_id, label: pc.label, public_key: pc.public_key, relay: "wss://relay.ovis.sh",
  added_at: new Date(Date.now() - 2 * 60_000).toISOString(),
  last_seen_at: pc.seenAgo === null ? null : new Date(Date.now() - pc.seenAgo).toISOString(),
}));

const fail = (what: string): never => { throw new Error(what); };
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations()
  .filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined))));

const laneShell = join(root, "dist-shell");
let shellDir = process.env["SHELL_DIR"] || (existsSync(join(laneShell, "index.html")) ? laneShell : null);
const built = shellDir === null ? mkdtempSync(join(tmpdir(), "ovis-second-device-join-")) : null;
let code = 0;
try {
  if (built !== null) {
    const build = Bun.spawn([process.execPath, "--bun", join(root, "node_modules/.bin/vite"), "build", "--mode", "shell", "--outDir", built, "--emptyOutDir", "--logLevel", "warn"], {
      cwd: root, env: process.env, stdin: "ignore", stdout: "inherit", stderr: "inherit",
    });
    if (await build.exited !== 0) fail("the shell build failed");
    shellDir = built;
  }
  const site = servePagesSite(shellDir!, 0, "127.0.0.1");
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    const cases = [
      ...[390, 1440].flatMap((width) => (["light", "dark"] as const).map((theme) => ({ width, theme, language: "en" as const }))),
      ...(["light", "dark"] as const).map((theme) => ({ width: 390, theme, language: "ko" as const })),
    ];
    for (const { width, theme, language } of cases) {
      const name = `${width}-${theme}-${language}`;
      const phone = width < 600;
      const context = await browser.newContext({
        viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, isMobile: phone, hasTouch: phone,
        deviceScaleFactor: phone ? 2 : 1, locale: language === "ko" ? "ko-KR" : "en-US", serviceWorkers: "block",
      });
      try {
        const fake = new FakeAccountService();
        const errors: string[] = [];
        await context.route(/.*/, async (route) => { errors.push(`unexpected request ${route.request().url()}`); await route.abort(); });
        await context.route(/^https:\/\/app\.ovis\.sh\//, whileOpen(context, async (route) => {
          const url = new URL(route.request().url());
          await route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:${site.port}${url.pathname}${url.search}` }) });
        }));
        await context.route(/^https:\/\/account\.ovis\.sh\//, async (route) => {
          const request = route.request();
          const cors = { "access-control-allow-origin": APP, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
          if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors }); return; }
          if (request.method() === "GET" && new URL(request.url()).pathname === "/v1/pcs" && request.headers()["authorization"]) {
            await route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ pcs: directory() }) });
            return;
          }
          const body = request.postDataBuffer();
          const answer = await fake.fetch(new Request(request.url(), { method: request.method(), headers: request.headers(), ...(body === null ? {} : { body: new Uint8Array(body) }) }));
          const location = answer.headers.get("location");
          if (answer.status === 302 && location?.startsWith(APP)) {
            await route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><meta http-equiv="refresh" content="0;url=${location.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">` });
            return;
          }
          await route.fulfill({ status: answer.status, headers: { ...Object.fromEntries(answer.headers), ...cors }, body: Buffer.from(await answer.arrayBuffer()) });
        });
        await context.routeWebSocket(/.*/, (ws) => { ws.close(); });
        await context.addInitScript(({ theme, language }) => { localStorage.setItem("ovis:settings", JSON.stringify({ theme, language })); }, { theme, language });
        const page = await context.newPage();
        page.setDefaultTimeout(20_000);
        page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
        const shot = async (what: string): Promise<void> => { await settled(page); if (evidence) await page.screenshot({ path: join(evidence, `${name}-${what}.png`) }); };

        await page.goto(`${APP}/`);
        await page.locator(".account-provider").first().click();
        // a sign-in lands on Add a PC, never the dashboard: that opens only by its own address
        await page.locator('main.relay-add-screen[data-account-state="signed-in"] .relay-add, [data-add-pc-mode]').first().waitFor({ timeout: 45_000 });
        await page.goto(`${APP}/#overview`);
        await page.locator('.relay-dash[data-dashboard-mode="account"]').waitFor({ timeout: 45_000 });

        const card = (label: string) => page.locator(".relay-overview-attention-row").filter({ hasText: label }).locator("[data-attention-action]");
        await card("desk2").waitFor();
        const cards = { m1: await card("m1-box").getAttribute("data-attention-action"), desk2: await card("desk2").getAttribute("data-attention-action") };
        await shot("overview");
        if (cards.m1 !== "join" || cards.desk2 !== "add") fail(`${name}: attention cards ${JSON.stringify(cards)}, want m1-box join and desk2 add`);

        await page.evaluate(() => { location.hash = "#pcs"; });
        await page.locator('.relay-dash[data-dashboard-view="pcs"]').waitFor();
        const row = (label: string) => page.locator("[data-pc-list] [data-pc-id]").filter({ visible: true }).filter({ hasText: label });
        await row("m1-box").waitFor();
        const rows = { m1: await row("m1-box").locator("[data-pc-action]").getAttribute("data-pc-action"), desk2: await row("desk2").locator("[data-pc-action]").getAttribute("data-pc-action") };
        await shot("row");
        if (rows.m1 !== "join" || rows.desk2 !== "add") fail(`${name}: row actions ${JSON.stringify(rows)}, want m1-box join and desk2 add`);

        await row("m1-box").locator(".relay-pc-name-btn").click();
        const details = page.locator(`[data-pc-details="${machines[0]!.server_id}"]`);
        await details.waitFor();
        const panel = await details.evaluate((element) => ({
          actions: element.querySelectorAll(".relay-pc-details-actions .btn").length,
          reasons: [...element.querySelectorAll(".relay-pc-details-sub")].filter((line) => (line.textContent ?? "").trim() !== "").length,
        }));
        await shot("details");
        if (panel.actions !== 1 || panel.reasons === 0) fail(`${name}: details ${JSON.stringify(panel)}, want one action and a reason line`);
        await details.locator(".relay-pc-details-actions .btn").click();
        const sheet = await page.locator("[role=dialog][data-add-pc-mode]").getAttribute("data-add-pc-mode");
        if (sheet !== "join") fail(`${name}: the details action opened the ${sheet} sheet, want join`);
        await page.locator('[role=dialog][data-add-pc-mode="join"][data-add-pc-phase="start"]').waitFor();
        await shot("sheet-join");
        // the number on the machine's own screen stays a way in: the directory cannot say the machine is in the account now
        await page.locator('[role=dialog][data-add-pc-mode="join"] [data-action="type-number"]').click();
        const typing = page.locator('[role=dialog][data-add-pc-mode="new"][data-add-pc-phase="start"]');
        await typing.waitFor();
        if (!await typing.evaluate((element) => element.contains(document.activeElement))) fail(`${name}: focus left the sheet when it turned to Type the number`);
        await shot("sheet-join-type-number");
        if (phone) await page.evaluate(() => {
          document.documentElement.dataset["qaSteppedOff"] = "no";
          addEventListener("popstate", () => { document.documentElement.dataset["qaSteppedOff"] = "yes"; }, { once: true });
        });
        await page.keyboard.press("Escape");
        await page.locator("[data-add-pc-phase]").waitFor({ state: "detached" });
        if (phone) await page.locator('html[data-qa-stepped-off="yes"]').waitFor({ state: "attached", timeout: 5_000 });
        await page.keyboard.press("Escape");
        await details.waitFor({ state: "detached" });

        await row("desk2").locator('[data-pc-action="add"]').click();
        const fresh = page.locator('[role=dialog][data-add-pc-mode="new"][data-add-pc-phase="start"]');
        await fresh.waitFor();
        await shot("sheet-new");
        await fresh.locator('[data-action="ask-to-join"]').click();
        const joining = page.locator('[role=dialog][data-add-pc-mode="join"][data-add-pc-phase="start"]');
        await joining.waitFor();
        if (!await joining.evaluate((element) => element.contains(document.activeElement))) fail(`${name}: focus left the sheet when it turned to Ask to join`);
        await shot("sheet-new-ask-to-join");
        await page.keyboard.press("Escape");
        await page.locator("[data-add-pc-phase]").waitFor({ state: "detached" });

        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
        if (overflow) fail(`${name}: the page scrolls sideways`);
        if (errors.length > 0) fail(`${name}: ${errors.slice(0, 3).join("; ")}`);
        console.log(`PASS ${name}: m1-box (seen by the directory) offers Join on its card, row and details, into the join sheet with Type the number; desk2 (never seen) keeps Add, whose sheet offers Ask to join`);
      } finally {
        await closeMarked(context);
      }
    }
  } finally {
    await closeMarked(browser);
    await site.stop(true);
  }
} catch (error) {
  code = 1;
  console.error("FAIL second device join:", error instanceof Error ? error.message : error);
} finally {
  if (built !== null) rmSync(built, { recursive: true, force: true });
}
process.exit(code);
