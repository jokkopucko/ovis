/**
 * The card of a PC a sign-in code listed in the account and no one added (src/components/UnconfirmedPcNotices.tsx), on
 * the PC's own window in a real browser at a phone's width (390, touch) and a PC's (1280):
 *
 * - a listing from another day says its date beside the time;
 * - Close (X) hides the card on this device, and a reload keeps it hidden; the PC stays in the account, unconfirmed;
 * - Manage account's PCs lists that PC as not added, and removes its listing after one confirm;
 * - another PC listed by a sign-in code is told of in a card of its own.
 *
 * The PC is a real one (createServer); the account service is the in-memory fake (shared/account-service-fake.ts), a
 * route of the browser context. Nothing leaves this machine.
 *
 *   bun run check run --build -- bun scripts/unconfirmed-pc-notice-regression.ts
 *
 * UI_EVIDENCE_DIR=<dir> keeps a screenshot of each step, in English and in Korean; without it the checks run in English.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import { deriveServerId } from "../shared/relay-server-proof.ts";
import { translate, type Language } from "../src/lib/i18n.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage, pressInSettings, sheetRisen } from "./settings-page.ts";

const ACCOUNT = "acct_unconfirmed_card";
const ACCOUNT_SERVICE = "https://account.fixture.test";
const PHONE = { width: 390, height: 844 } as const;
const DESK = { width: 1280, height: 800 } as const;
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
const cleanup: (() => unknown)[] = [];
const previousService = process.env["OVIS_ACCOUNT_SERVICE_URL"];
process.env["OVIS_ACCOUNT_SERVICE_URL"] = ACCOUNT_SERVICE;
cleanup.push(() => {
  if (previousService === undefined) delete process.env["OVIS_ACCOUNT_SERVICE_URL"];
  else process.env["OVIS_ACCOUNT_SERVICE_URL"] = previousService;
});

// each run starts from an account of its own; the PC's server and the page reach whichever is current
let fake = new FakeAccountService();
const accountService = { url: ACCOUNT_SERVICE, fetch: (input: RequestInfo | URL, init?: RequestInit) => fake.fetch(input, init) };

const stateDir = mkdtempSync(join(tmpdir(), "ovis-unconfirmed-pc-"));
cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
const pc = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false,
  accountService, accountOpensAll: true, platform: "linux", usage: new UsageService(undefined, []) });
cleanup.push(() => pc.stop());
const origin = `http://127.0.0.1:${pc.port}`;

/** a PC types a sign-in code into the account: listed, unconfirmed (PCL-1); `at` when, by the service's clock */
async function listedByCode(label: string, at?: number): Promise<string> {
  const key = randomBytes(32);
  const serverId = deriveServerId(key);
  const response = await fake.fetch(`${ACCOUNT_SERVICE}/v1/pcs/${serverId}`, { method: "PUT",
    headers: { authorization: `Bearer ${fake.issueToken(ACCOUNT, { device: true })}`, "content-type": "application/json" },
    body: JSON.stringify({ label, public_key: bytesToHex(key), relay: "wss://relay.ovis.sh" }) });
  assert.ok(response.ok, `${label} is listed`);
  if (at !== undefined) fake.pcs(ACCOUNT).find((row) => row.server_id === serverId)!.added_at = new Date(at).toISOString();
  return serverId;
}

const unconfirmed = (): string[] => fake.pcs(ACCOUNT).filter((row) => row.listed_by_device === true).map((row) => row.server_id);

async function shot(page: Page, name: string): Promise<void> {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: "disabled" });
}

async function openManagePcs(page: Page, language: Language) {
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await page.locator(".settings-dialog").waitFor();
  await sheetRisen(page);
  await openSettingsPage(page, translate(language, "Devices and PCs"), translate(language, "Back to settings"));
  await pressInSettings(page.locator("[data-section='account'] [data-action='manage-account']"));
  return page.locator("[data-testid='manage-account'] [data-testid='account-pcs']");
}

async function run(browser: Browser, size: typeof PHONE | typeof DESK, language: Language): Promise<void> {
  const where = `${size.width}px, ${language}`;
  const name = (step: string) => `unconfirmed-pc-${language}-${size.width}-${step}`;
  fake = new FakeAccountService();
  fake.opensAll = true;
  const token = fake.issueToken(ACCOUNT);
  const old = await listedByCode("Old desk", Date.now() - 30 * 3_600_000);

  const phone = size === PHONE;
  const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone, locale: language === "ko" ? "ko-KR" : "en-US", timezoneId: "Asia/Seoul" });
  try {
    await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ language, theme: "light" }));
    await context.route("**/api/access", (route) => route.fulfill({ json: { port: 0, tailscale: { state: "missing", dns_name: null, serving_url: null, serve_command: null, serve_url: null } } }));
    await context.route(`${ACCOUNT_SERVICE}/**`, async (route) => {
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      const body = route.request().postData();
      const response = await fake.fetch(route.request().url(), { method: route.request().method(), headers: route.request().headers(), ...(body === null ? {} : { body }) });
      return route.fulfill({ status: response.status, headers: { ...Object.fromEntries(response.headers), ...cors }, body: await response.text() });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    // signed in with the app's own sign-in, as the PC's own window keeps it
    await page.evaluate(({ url, account, accessToken }) => new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("ovis-account", 1);
      request.onupgradeneeded = () => { request.result.createObjectStore("account"); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const tx = request.result.transaction("account", "readwrite");
        tx.objectStore("account").put({ service: url, account, provider: "github", access_token: accessToken, refresh_token: "fixture-refresh", expires_at: Date.now() + 3_600_000 }, "session");
        tx.oncomplete = () => { request.result.close(); resolve(); };
        tx.onabort = () => reject(tx.error);
      };
    }), { url: ACCOUNT_SERVICE, account: ACCOUNT, accessToken: token });
    await page.reload({ waitUntil: "domcontentloaded" });

    const card = (serverId: string) => page.locator(`[data-unconfirmed-pc="${serverId}"]`);
    await card(old).waitFor();
    await shot(page, name("1-card"));
    // listed the day before, by the browser's own day: its date is said beside the time
    const day = await page.evaluate(({ at, language }) => new Date(at).toLocaleDateString(language, { month: "short", day: "numeric" }), { at: Date.parse(fake.pcs(ACCOUNT).find((row) => row.server_id === old)!.added_at), language });
    assert.ok((await card(old).innerText()).includes(day), `the card says the day it was listed, ${day} (${where})`);

    // Manage account lists it as not added, with Remove
    const pcs = await openManagePcs(page, language);
    const row = pcs.locator(`[data-unconfirmed-pc-row][data-pc-id="${old}"]`);
    await row.waitFor();
    await shot(page, name("2-manage-account"));
    assert.equal(await row.locator("[data-action='remove-pc']").count(), 1, `Manage account offers Remove for the PC no one added (${where})`);
    await page.keyboard.press("Escape");
    await page.locator("[data-testid='manage-account']").waitFor({ state: "detached" });
    await pressInSettings(page.getByRole("button", { name: translate(language, "Close settings"), exact: true }));
    await page.locator(".settings-dialog").waitFor({ state: "detached" });

    // Close hides the card here; nothing is asked of the account service
    await card(old).getByRole("button", { name: translate(language, "Close"), exact: true }).click();
    await card(old).waitFor({ state: "detached" });
    await shot(page, name("3-closed"));

    // another PC listed by a sign-in code is told of in a card of its own after a reload, which drew the same read
    // without the closed one
    const fresh = await listedByCode("New laptop");
    await page.reload({ waitUntil: "domcontentloaded" });
    await card(fresh).waitFor();
    assert.equal(await card(old).count(), 0, `a closed card stays closed after a reload, beside a new one (${where})`);
    assert.deepEqual(unconfirmed().sort(), [old, fresh].sort(), `the closed PC stays in the account, unconfirmed (${where})`);
    await shot(page, name("4-new-pc"));

    // Remove in Manage account ends the closed PC's listing after one confirm
    const again = await openManagePcs(page, language);
    await again.locator(`[data-unconfirmed-pc-row][data-pc-id="${old}"] [data-action='remove-pc']`).click();
    const confirm = page.getByRole("alertdialog");
    await confirm.waitFor();
    await shot(page, name("5-remove-confirm"));
    await confirm.getByRole("button", { name: translate(language, "Remove"), exact: true }).click();
    await again.locator(`[data-unconfirmed-pc-row][data-pc-id="${old}"]`).waitFor({ state: "detached" });
    assert.deepEqual(unconfirmed(), [fresh], `the removal ended that listing only (${where})`);
    assert.deepEqual(errors, [], `no page error (${where})`);
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ headless: true, executablePath: chromePath(), args: ["--no-sandbox"] });
cleanup.push(() => browser.close());
let code = 0;
try {
  for (const language of evidence ? (["en", "ko"] as const) : (["en"] as const)) {
    for (const size of [DESK, PHONE]) await run(browser, size, language);
  }
  console.log("PASS the unconfirmed PC's card says its date, closes for good on this device, comes back for a new listing, and Manage account removes the closed one");
} catch (error) {
  console.error(error);
  code = 1;
} finally {
  for (const step of cleanup.reverse()) await Promise.resolve(step()).catch(() => undefined);
}
process.exit(code);
