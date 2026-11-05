/**
 * The in-browser sign-in on the demo build (`?demo_sign_in=1`, site/demo/transport.ts), which plays
 * the flows recorded from Claude Code 2.1.312 and codex-cli 0.163.0, at 1280 and 390, dark and light:
 *
 * - Settings → Agents: Claude Code has no account, so its row offers Sign in. The dialog shows the
 *   sign-in page as a link on claude.com and a box for the code that page shows; a sent code signs it
 *   in, and the dialog names the account. Open terminal is there until it ends.
 * - Codex's Add account → On this PC → Start sign-in follows the login in the browser: its device page
 *   on auth.openai.com and its one-time code, then the account it signed in.
 * - The setup guide offers Sign in under its tiles for an installed Claude Code without an account.
 *
 * With UI_EVIDENCE_DIR, each step is captured under agents-sign-in/.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const app = mkdtempSync(join(tmpdir(), "ovis-agents-sign-in-"));
const evidence = process.env["UI_EVIDENCE_DIR"] ? join(process.env["UI_EVIDENCE_DIR"], "agents-sign-in") : null;
if (evidence) mkdirSync(evidence, { recursive: true });
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity)).map((animation) => animation.finished.catch(() => undefined))).then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))));

let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const root = `http://127.0.0.1:${server.port}/app/?pane=${encodeURIComponent(panes.api)}&demo_sign_in=1`;
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  for (const width of [1280, 390] as const) {
    for (const theme of ["dark", "light"] as const) {
      const at = `${width}-${theme}`;
      const context = await browser.newContext(width === 390
        ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: "en-US", colorScheme: theme }
        : { viewport: { width: 1280, height: 800 }, locale: "en-US", colorScheme: theme });
      await context.addInitScript((value) => { localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: value, showUsage: true })); }, theme);
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const shot = async (name: string): Promise<void> => {
        if (!evidence) return;
        await settled(page);
        await page.screenshot({ path: join(evidence, `${name}-${at}.png`) });
      };
      const press = (locator: ReturnType<Page["locator"]>) => width === 390 ? locator.tap() : locator.click();
      try {
        // Claude Code's first sign-in, from its Agents row
        await page.goto(`${root}&settings=agents`);
        const claude = page.locator(".agents-item[data-agent='claude']");
        await claude.waitFor();
        const signIn = claude.getByRole("button", { name: "Sign in to Claude Code", exact: true });
        await signIn.waitFor();
        await press(signIn);
        const dialog = page.getByRole("dialog", { name: "Sign in to Claude Code", exact: true });
        const link = dialog.getByRole("link", { name: "Open sign-in page", exact: true });
        await link.waitFor();
        const href = await link.getAttribute("href");
        assert.ok(href?.startsWith("https://claude.com/cai/oauth/authorize?"), `the link is Claude's own page ${at}: ${href}`);
        assert.equal(await link.getAttribute("target"), "_blank");
        assert.match(await link.getAttribute("rel") ?? "", /noopener/);
        assert.equal(await dialog.locator(".usage-sign-in-host").textContent(), "claude.com");
        assert.equal(await dialog.getByRole("button", { name: "Open terminal", exact: true }).count(), 1, `Open terminal is the way out ${at}`);
        const box = dialog.getByLabel("Paste the code the page shows", { exact: true });
        await box.waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no sideways scroll ${at}`);
        await shot("1-claude-paste");
        await box.fill("demo-code#demo-state");
        await press(dialog.getByRole("button", { name: "Send code", exact: true }));
        await dialog.getByText("Signed in as me@example.test.", { exact: true }).waitFor();
        assert.equal(await box.count(), 0, "the code box goes once the code is sent");
        await shot("2-claude-signed-in");
        await press(dialog.getByRole("button", { name: "Done", exact: true }));
        await dialog.waitFor({ state: "detached" });
        console.log(`PASS Claude Code signs in from its Agents row: its page on claude.com, the pasted code, the account named (${at})`);

        // Codex's Add account → On this PC, followed in the browser
        const codex = page.locator(".agents-item[data-agent='codex']");
        await press(codex.locator(".agents-toggle"));
        await press(codex.getByRole("button", { name: "Add account", exact: true }));
        const add = page.locator(".usage-account-dialog").first();
        await press(add.getByRole("button", { name: /^On this PC/ }));
        await add.locator("#usage-account-name").fill("home");
        await press(add.getByRole("button", { name: "Start sign-in", exact: true }));
        const follow = page.getByRole("dialog", { name: "Sign in to Codex", exact: true });
        await follow.locator(".usage-sign-in-code code").waitFor();
        assert.equal(await follow.locator(".usage-sign-in-code code").textContent(), "PDLB-SLDUA");
        assert.equal(await follow.getByRole("link", { name: "Open sign-in page", exact: true }).getAttribute("href"), "https://auth.openai.com/codex/device");
        await shot("3-codex-device-code");
        await follow.getByText("Signed in as codex@example.test.", { exact: true }).waitFor();
        await shot("4-codex-signed-in");
        await press(follow.getByRole("button", { name: "Done", exact: true }));
        // Done ends the whole Add account flow: no dialog is left behind
        await page.locator(".usage-account-dialog").first().waitFor({ state: "detached" });
        console.log(`PASS Codex's Add account follows its device code in the browser, then names the account (${at})`);

        // Sign in again on a shut row: the dialog lives on the page, so a click into it toggles no row
        // and the end of the expiry it was opened for does not take it away
        await page.goto(`${root}&demo_usage=refused&settings=agents`);
        const expired = page.locator(".agents-item[data-agent='claude']");
        const renew = expired.getByRole("button", { name: /^Sign in again/ });
        await renew.waitFor();
        await press(renew);
        const renewing = page.getByRole("dialog", { name: "Sign in to Claude Code", exact: true });
        const renewBox = renewing.getByLabel("Paste the code the page shows", { exact: true });
        await renewBox.waitFor();
        await press(renewBox);
        await press(renewing.locator(".usage-sign-in-host"));
        assert.equal(await expired.locator(".agents-toggle").getAttribute("aria-expanded"), "false", `a click in the dialog leaves its row shut ${at}`);
        await renewBox.fill("demo-code#demo-state");
        await press(renewing.getByRole("button", { name: "Send code", exact: true }));
        await renewing.getByRole("status").filter({ hasText: /^(Signed in as me@example\.test\.|The sign-in finished\.)$/ }).waitFor();
        await press(renewing.getByRole("button", { name: "Done", exact: true }));
        await renewing.waitFor({ state: "detached" });
        console.log(`PASS Sign in again on a shut row stays open through clicks and the end of the expiry, to its outcome (${at})`);

        // closing the dialog stops the sign-in: Escape while Claude's waits for its code cancels it by its id
        await page.goto(`${root}&settings=agents`);
        await page.evaluate(() => {
          const passing = window.fetch;
          const seen: string[] = [];
          (window as unknown as { cancels: string[] }).cancels = seen;
          window.fetch = (input, init) => {
            const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
            if (path === "/api/usage/login/cancel") seen.push(String(init?.body ?? ""));
            return passing(input, init);
          };
        });
        await press(page.locator(".agents-item[data-agent='claude']").getByRole("button", { name: "Sign in to Claude Code", exact: true }));
        const closing = page.getByRole("dialog", { name: "Sign in to Claude Code", exact: true });
        await closing.getByLabel("Paste the code the page shows", { exact: true }).waitFor();
        await page.keyboard.press("Escape");
        await closing.waitFor({ state: "detached" });
        await page.waitForFunction(() => (window as unknown as { cancels: string[] }).cancels.length === 1);
        assert.match((await page.evaluate(() => (window as unknown as { cancels: string[] }).cancels))[0]!, /"login":"demo-login-\d+"/, `Escape cancels the running sign-in ${at}`);
        console.log(`PASS closing the dialog stops the sign-in it was following (${at})`);

        // the setup guide offers the first sign-in under its tiles
        await page.goto(`${root}&settings=agents`);
        await page.locator(".agents-item").first().waitFor();
        await press(page.getByRole("button", { name: "Open setup guide", exact: true }));
        const guide = page.getByRole("region", { name: "Setup guide", exact: true });
        await guide.waitFor();
        const guideSignIn = guide.getByRole("button", { name: "Sign in to Claude Code", exact: true });
        await guideSignIn.waitFor();
        await shot("5-guide-sign-in");
        await press(guideSignIn);
        await page.getByRole("dialog", { name: "Sign in to Claude Code", exact: true }).getByLabel("Paste the code the page shows", { exact: true }).waitFor();
        console.log(`PASS the setup guide offers Claude Code's sign-in under its tiles and follows it in the browser (${at})`);

        assert.deepEqual(errors, [], `no page errors ${at}`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(app, { recursive: true, force: true });
  console.log("CLEANUP browser closed, loopback demo server stopped, demo app removed");
}
