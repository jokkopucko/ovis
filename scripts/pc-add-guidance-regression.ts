import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { PcAccountState } from "../server/account/pc-binding.ts";
import { RelayService } from "../server/relay/service.ts";
import { startBunRelay } from "../relay/bun.ts";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage, sheetRisen } from "./settings-page.ts";

const dir = mkdtempSync(join(tmpdir(), "pc-add-guidance-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
if (!evidence) throw new Error("UI_EVIDENCE_DIR must name disposable evidence storage");
mkdirSync(evidence, { recursive: true });
const serviceUrl = "https://account.fixture.test";
process.env["OVIS_ACCOUNT_SERVICE_URL"] = serviceUrl;
const account = new FakeAccountService();
account.opensAll = true;
PcAccountState.open(dir).migrate("acct_guidance", true);
const relay = startBunRelay({ port: 0, limiters: {
  perAddress: { async limit() { return { success: true }; } }, global: { async limit() { return { success: true }; } },
} });
const service = new RelayService({ stateDir: dir, relay: `wss://127.0.0.1:${relay.port}`, connect: url => {
  const target = new URL(url);
  return new WebSocket(`ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`);
} });
const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: dir, token: "", platform: "linux",
  accountOpensAll: true, tailscaleOwner: "fixture@example.test", sidecar: false, registerBridge: false,
  relay: service, accountService: { url: serviceUrl, fetch: account.fetch } });
const base = `http://127.0.0.1:${app.port}`;
const browser = await chromium.launch({ headless: true, executablePath: chromePath(), args: ["--no-sandbox"] });
try {
  assert.equal((await fetch(`${base}/api/relay/start`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } })).status, 200);
  for (const language of ["en", "ko"] as const) for (const width of [390, 1440]) for (const theme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme });
    try {
      await context.addInitScript(({ language, theme }) => localStorage.setItem("ovis:settings", JSON.stringify({ language, theme })), { language, theme });
      await context.route(`${serviceUrl}/**`, async route => {
        const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "GET, POST, PUT, DELETE" };
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        const body = route.request().postData();
        const response = await account.fetch(route.request().url(), { method: route.request().method(), headers: route.request().headers(),
          ...(body === null ? {} : { body }) });
        await route.fulfill({ status: response.status, headers: { ...Object.fromEntries(response.headers), ...cors }, body: await response.text() });
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await page.keyboard.press("ControlOrMeta+Shift+Comma");
      await openSettingsPage(page, language === "en" ? "Devices and PCs" : "기기와 PC", language === "en" ? "Back to settings" : "설정으로 돌아가기");
      await page.locator('.settings-dialog [data-section="devices"]').getByRole("button", { name: language === "en" ? "Add a connection" : "연결 추가", exact: true }).click();
      const sheet = page.locator(".connect-phone-dialog");
      await sheetRisen(page, ".connect-phone-dialog");
      await sheet.locator('.connect-tabs [data-tab="relay"]').click();
      const message = sheet.getByTestId("pc-add-source-bound");
      await message.waitFor();
      assert.equal(await message.locator("p").innerText(), language === "en"
        ? "This PC is in an account. Add PCs from your account." : "이 PC는 계정에 연결돼 있어요. 계정에서 PC를 추가하세요.");
      assert.equal(await message.getByRole("button").innerText(), language === "en" ? "Add from account" : "계정에서 추가");
      assert.equal(await message.getByRole("button").count(), 1);
      assert.ok(!(await sheet.innerText()).includes("acct_"));
      assert.equal(await sheet.evaluate(el => el.scrollWidth <= el.clientWidth), true, "No horizontal clipping");
      await page.screenshot({ path: join(evidence, `source-${language}-${width}-${theme}.png`) });
      assert.deepEqual(errors, []);
      console.log(`PASS source ${language} ${width} ${theme}`);
      await message.getByRole("button").click();
      const signin = sheet.getByTestId("connect-signin");
      await signin.getByText(language === "en" ? "Sign in to this PC's account." : "이 PC의 계정으로 로그인하세요.", { exact: true }).waitFor();
      const provider = signin.getByRole("button", { name: /GitHub/ });
      assert.equal(await provider.isEnabled(), true);
      assert.equal(await provider.evaluate(el => el === document.activeElement), true);
      assert.ok(!(await sheet.innerText()).includes("acct_"));
      await page.screenshot({ path: join(evidence, `signin-${language}-${width}-${theme}.png`) });
      console.log(`PASS signin ${language} ${width} ${theme}`);
    } finally { await context.close(); }
  }
} finally {
  await browser.close(); await app.stop(); await service.shutdown(); relay.stop();
  rmSync(dir, { recursive: true, force: true });
}
