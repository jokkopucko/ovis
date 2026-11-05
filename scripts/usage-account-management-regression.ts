/** Real account HTTP routes and private PTYs behind the demo shell; only disposable credentials. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import type { UsageContext } from "../server/usage.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-account-management-"));
process.env["HERDR_SOCKET"] = join(root, "absent-herdr.sock");
const { createServer } = await import("../server/index.ts");
const { UsageLoginService } = await import("../server/usage-login.ts");
const { UsageService, USAGE_PROVIDERS } = await import("../server/usage.ts");
const evidence = process.env["UI_EVIDENCE_DIR"] || join(root, "evidence");
mkdirSync(evidence, { recursive: true });
const app = join(root, "app");
let api: ReturnType<typeof createServer> | undefined;
let web: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
try {
  await buildDemoApp(app);
  const html = readFileSync(join(app, "index.html"), "utf8").replace('<script type="module"', `<script>window.accountNativeFetch=window.fetch.bind(window)</script>
<script src="./demo-transport.js"></script>
<script>
const fixtureFetch=window.fetch;
window.fetch=(input,init)=>{
  const url=new URL(typeof input==='string'?input:input.url||input.href,location.href);
  return (url.pathname.startsWith('/api/usage')||url.pathname==='/api/preferences')?window.accountNativeFetch(input,init):fixtureFetch(input,init);
};
</script><script type="module"`);
  web = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/usage") || url.pathname === "/api/preferences") {
      if (!api) return new Response("not started", { status: 503 });
      const backend = `http://127.0.0.1:${api.port}`;
      const headers = new Headers(request.headers);
      headers.set("host", new URL(backend).host);
      if (headers.has("origin")) headers.set("origin", backend);
      const response = await fetch(new Request(`${backend}${url.pathname}${url.search}`, { method: request.method, headers, body: request.body }));
      const decoded = new Headers(response.headers);
      decoded.delete("content-encoding"); decoded.delete("content-length");
      return new Response(await response.arrayBuffer(), { status: response.status, headers: decoded });
    }
    if (url.pathname === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    const path = decodeURIComponent(url.pathname).slice(1);
    if (path.split("/").includes("..") || path.includes("\\")) return new Response("bad path", { status: 400 });
    const file = Bun.file(join(app, path));
    return await file.exists() ? new Response(file) : new Response("not found", { status: 404 });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  for (const width of [1440, 390]) for (const theme of ["dark", "light"] as const) {
    const at = `${width}-${theme}`;
    const home = join(root, at);
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    for (const name of ["work", "home", "expired"]) {
      const dir = join(home, `.claude-${name}`);
      mkdirSync(dir);
      writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: name, emailAddress: `${name}@example.test` } }));
      writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: `fixture-${name}`, expiresAt: name === "expired" ? 1 : 9_999_999_999_999, subscriptionType: "max" } }));
    }
    const workCredentials = join(home, ".claude-work", ".credentials.json");
    const original = readFileSync(workCredentials, "utf8");
    writeFileSync(join(bin, "claude"), `#!${process.execPath}
import { join } from "node:path";
if (process.argv.includes("--help")) { console.log("login"); process.exit(0); }
const home = process.env.CLAUDE_CONFIG_DIR;
process.stdout.write(await Bun.file(${JSON.stringify(join(import.meta.dir, "../server/fixtures/usage-login/claude.pty"))}).text());
for await (const code of console) {
  if (code === "fail") process.exit(1);
  await Bun.write(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-renewed-" + home, expiresAt: 9999999999999, subscriptionType: "max" } }));
  if (!await Bun.file(join(home, ".claude.json")).exists()) await Bun.write(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "added", emailAddress: "added@example.test" } }));
  process.exit(0);
}
`, { mode: 0o755 });
    const ctx: UsageContext = {
      home, env: {}, platform: "linux", now: Date.now,
      fetch: async () => Response.json({ five_hour: { utilization: 20 } }),
      keychain: async () => ({ status: "missing" }), run: async () => null, has: () => false,
    };
    const start = () => createServer({
      port: 0, hostname: "127.0.0.1", token: "", stateDir: join(home, "state"), machines: false, registerBridge: false,
      terminalAttach: false, sidecar: false, herdrConfigPath: join(home, "herdr.toml"),
      usage: new UsageService(ctx, USAGE_PROVIDERS.filter((provider) => provider.id === "claude")),
      usageLogin: new UsageLoginService(home, { PATH: bin }, ctx),
    });
    api = start();
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, locale: "en-US", colorScheme: theme, isMobile: width === 390, hasTouch: width === 390 });
    await context.addInitScript((theme) => {
      if (!localStorage.getItem("ovis:settings")) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme, showUsage: true }));
    }, theme);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const capture = async (name: string) => {
      await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity)).map((animation) => animation.finished.catch(() => undefined))));
      await page.screenshot({ path: join(evidence, `${name}-${at}.png`) });
    };
    const open = async () => {
      await page.goto(`${web?.url.origin}/?settings=agents`);
      const toggle = page.locator(".agents-item[data-agent='claude'] .agents-toggle");
      await toggle.waitFor();
      if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
      await page.locator(".agents-item[data-agent='claude'] .usage-accounts-row").first().waitFor();
    };
    try {
      await open();
      const agent = page.locator(".agents-item[data-agent='claude']");
      const rows = agent.locator("ol.agents-accounts > .usage-accounts-row");
      const removedRows = agent.locator(".usage-removed .usage-accounts-row");
      const dialogFits = async () => {
        const box = await page.locator(".usage-account-dialog").first().boundingBox();
        assert.ok(box !== null && box.x + box.width <= await page.evaluate(() => innerWidth));
      };
      assert.equal(await rows.count(), 3);
      await capture("1-accounts");
      const expired = rows.filter({ hasText: "expired@example.test" });
      for (const code of ["fail", "success"]) {
        await expired.getByRole("button", { name: /^Sign in again/ }).click();
        const dialog = page.getByRole("dialog", { name: "Sign in to Claude Code", exact: true });
        await dialog.getByLabel("Paste the code the page shows", { exact: true }).fill(code);
        await dialog.getByRole("button", { name: "Send code", exact: true }).click();
        await dialog.getByRole(code === "fail" ? "alert" : "status").filter({ hasText: code === "fail" ? "without signing in" : "Signed in as expired@example.test." }).waitFor();
        await capture(code === "fail" ? "2-failed-login" : "3-renewed");
        await dialogFits();
        await dialog.getByRole("button", { name: "Done", exact: true }).click();
      }
      await expired.getByText("Signed in", { exact: true }).waitFor();
      await agent.getByRole("button", { name: "Add account", exact: true }).click();
      const add = page.locator(".usage-account-dialog").first();
      await add.getByRole("button", { name: /^On this PC/ }).click();
      await add.locator("#usage-account-name").fill("added");
      await add.getByRole("button", { name: "Start sign-in", exact: true }).click();
      const adding = page.getByRole("dialog", { name: "Sign in to Claude Code", exact: true });
      await adding.getByLabel("Paste the code the page shows", { exact: true }).fill("success");
      await adding.getByRole("button", { name: "Send code", exact: true }).click();
      await adding.getByText("Signed in as added@example.test.", { exact: true }).waitFor();
      await dialogFits();
      await adding.getByRole("button", { name: "Done", exact: true }).click();
      await rows.filter({ hasText: "added@example.test" }).waitFor();
      assert.equal(await rows.count(), 4);
      const work = rows.filter({ hasText: "work@example.test" });
      await work.getByRole("button", { name: /^Remove/ }).click();
      const confirmation = page.getByRole("alertdialog");
      await capture("4-remove-confirmation");
      await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(await rows.count(), 4);
      await work.getByRole("button", { name: /^Remove/ }).click();
      await confirmation.getByRole("button", { name: "Remove", exact: true }).click();
      await work.waitFor({ state: "detached" });
      assert.equal(readFileSync(workCredentials, "utf8"), original);
      await removedRows.filter({ hasText: "work@example.test" }).waitFor();
      const before = await rows.locator(".usage-accounts-account").allTextContents();
      const saved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/preferences" && response.request().method() === "PUT");
      await rows.last().getByRole("button", { name: /^Move .* up$/ }).click();
      assert.equal((await saved).status(), 200);
      const order = await rows.locator(".usage-accounts-account").allTextContents();
      assert.deepEqual(order, [...before.slice(0, -2), before[before.length - 1], before[before.length - 2]]);
      assert.equal(await rows.first().getByRole("button", { name: /^Move .* up$/ }).isVisible(), false);
      assert.equal(await rows.last().getByRole("button", { name: /^Move .* down$/ }).isVisible(), false);
      await capture("5-removed-reordered");
      api.stop(); api = start();
      await open();
      assert.deepEqual(await rows.locator(".usage-accounts-account").allTextContents(), order);
      assert.equal(await work.count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await rows.evaluateAll((rows) => rows.every((row) => row.scrollWidth <= row.clientWidth)), true);
      await capture("6-after-restart");
      // the removed account waits under Removed from Ovis, and Restore lists it again
      const removedWork = removedRows.filter({ hasText: "work@example.test" });
      await removedWork.getByRole("button", { name: /^Restore .*work@example\.test$/ }).click();
      await work.waitFor();
      await removedWork.waitFor({ state: "detached" });
      assert.equal(await agent.locator(".usage-removed").count(), 0);
      assert.equal(readFileSync(workCredentials, "utf8"), original);
      await capture("7-restored");
      assert.deepEqual(errors, []);
      console.log(`PASS account-specific re-login, failed-login outcome, add, confirmed removal, restore, credential preservation, reorder, reload and server restart (${at})`);
    } finally {
      await context.close();
      api.stop(); api = undefined;
    }
  }
} finally {
  await browser?.close();
  web?.stop(true);
  api?.stop();
  rmSync(root, { recursive: true, force: true });
}
