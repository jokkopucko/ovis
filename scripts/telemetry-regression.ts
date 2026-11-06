/** The real telemetry UI and local API, with a fixture-only transport. Run after `bun run build`. */
import "./test-herdr.ts"; // a herdr session of its own: the server never reads the user's
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import { NOTICE_VERSION, type TelemetryActive, type TelemetryChange, type TelemetryEvent, type TelemetrySettings, type TelemetryStatus } from "../shared/telemetry.ts";
import { createServer } from "../server/index.ts";
import { Telemetry } from "../server/telemetry.ts";
import { UsageService } from "../server/usage.ts";
import { openSettingsPage, themeSide } from "./settings-page.ts";

const SEND_GRACE_MS = 24 * 60 * 60 * 1_000;

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(50);
  }
}

async function statusAt(origin: string): Promise<TelemetryStatus> {
  const response = await fetch(`${origin}/api/telemetry`);
  assert.equal(response.status, 200, "the owned local server serves the telemetry API");
  return await response.json() as TelemetryStatus;
}

function fixtureSettings() {
  return {
    language: "en",
    palette: "catppuccin",
    terminalInputMode: "line",
    terminalFontSize: 17,
    chatFontSize: 19,
    voiceLanguage: "en-GB",
    terminalFontFamily: "Fixture Terminal Font Canary",
    chatFontFamily: "Fixture Chat Font Canary",
    quickReplies: ["Fixture quick reply canary"],
    usageOrder: ["fictional-account-order-canary"],
    usageHidden: ["fictional-account-id-canary"],
  };
}

/** A real app page and local API; the injected transport cannot reach the production receiver. */
export async function checkTelemetrySettings(browser: Browser): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ovis-telemetry-regression-"));
  const serverState = join(root, "server-state");
  const telemetryState = join(root, "telemetry-state");
  const sent: TelemetryEvent[] = [];
  const changes: TelemetryChange[] = [];
  const fixture = fixtureSettings();
  let fixtureNow = Date.now();
  const privateMarkers = [
    fixture.quickReplies[0]!,
    fixture.terminalFontFamily,
    fixture.chatFontFamily,
    fixture.usageOrder[0]!,
    fixture.usageHidden[0]!,
  ];
  let telemetry: Telemetry | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let context: BrowserContext | undefined;
  try {
    mkdirSync(telemetryState, { recursive: true });
    writeFileSync(join(telemetryState, "telemetry.json"), JSON.stringify({
      install_id: randomUUID(),
      enabled: true,
      notice_seen_at: new Date(0).toISOString(),
      notice_version: NOTICE_VERSION - 1,
      reported_version: null,
      settings: null,
    }), { mode: 0o600 });

    telemetry = new Telemetry({
      stateDir: telemetryState,
      version: "0.0.0-telemetry-fixture",
      env: {},
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.body) sent.push(JSON.parse(String(init.body)) as TelemetryEvent);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
      now: () => fixtureNow,
      noticeGraceMs: SEND_GRACE_MS,
    });
    server = createServer({
      port: 0,
      hostname: "127.0.0.1",
      token: "",
      stateDir: serverState,
      telemetry,
      usage: new UsageService(undefined, []),
      registerBridge: false,
    });
    await server.statusReady;
    const origin = `http://127.0.0.1:${server.port}`;
    const initial = await statusAt(origin);
    assert.equal(initial.enabled, true);
    assert.equal(initial.notice_seen, false, "a persisted older notice version needs reacknowledgement");

    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
    await context.addInitScript((settings) => {
      localStorage.setItem("ovis:settings", JSON.stringify(settings));
    }, fixture);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/telemetry") return;
      changes.push(request.postDataJSON() as TelemetryChange);
    });

    await page.goto(origin);
    const notice = page.locator(".update-notice").filter({ hasText: "Ovis sends anonymous usage counts" }).first();
    await notice.waitFor({ state: "visible" });
    await until(async () => (await statusAt(origin)).notice_seen, "the visible notice is reacknowledged");
    assert.ok(changes.some((change) => change.notice_seen === true && change.notice_version === NOTICE_VERSION), "the browser acknowledges exactly the current notice version");
    assert.equal(changes.findIndex((change) => change.settings !== undefined), changes.findIndex((change) => change.notice_seen === true),
      "no settings snapshot leaves the browser before the notice is acknowledged; the first rides with the acknowledgement");
    await until(async () => {
      const settings = (await statusAt(origin)).next?.settings;
      return settings?.palette === "catppuccin" && settings.terminalFontSize === 17;
    }, "the server receives the full initial settings snapshot");

    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    const dialog = page.locator(".settings-dialog");
    await dialog.waitFor({ state: "visible" });
    await openSettingsPage(page, "About");
    const telemetrySection = dialog.locator(".settings-telemetry");
    await telemetrySection.locator("summary").click();
    const previews = telemetrySection.locator("pre.update-output");
    const preview = previews.first();
    await preview.waitFor({ state: "visible" });
    const previewText = await preview.innerText();
    const event = JSON.parse(previewText) as TelemetryEvent;
    assert.equal(event.settings?.palette, "catppuccin", "the preview shows the selected palette enum");
    assert.equal(event.settings?.terminalInputMode, "line", "the preview shows the selected input-mode enum");
    assert.equal(event.settings?.terminalFontSize, 17, "the preview shows the selected numeric font size");
    assert.equal(event.settings?.chatFontSize, 19);
    assert.equal(event.settings?.voiceLanguage, "en-GB");
    assert.equal(event.settings?.terminalFontCustom, true);
    assert.equal(event.settings?.chatFontCustom, true);
    assert.equal(event.settings?.quickRepliesCustom, true);
    assert.equal(event.settings?.quickReplyCount, 1);
    assert.equal(event.settings?.usageHiddenCount, 1);
    for (const marker of privateMarkers) {
      assert.equal(previewText.includes(marker), false, `the preview omits private fixture value ${marker}`);
    }
    // the daily active message, previewed next to the install/update event exactly as it would be sent
    assert.equal(await previews.count(), 2, "the About preview shows the install/update event and the active message");
    const activePreview = previews.nth(1);
    await activePreview.waitFor({ state: "visible" });
    const active = JSON.parse(await activePreview.innerText()) as TelemetryActive;
    assert.equal(active.event, "active", "the second preview is the daily active message");
    assert.ok(Array.isArray(active.harnesses), "the active preview carries a harnesses array");

    await openSettingsPage(page, "Appearance");
    // the fixture's mode is dark, so the dark side carries its palette and the legacy mirror follows a pick there
    const palette = themeSide(page, "dark");
    assert.equal(await palette.inputValue(), "catppuccin");
    await palette.selectOption("charcoal");
    await until(async () => {
      const settings = (await statusAt(origin)).next?.settings;
      return settings?.palette === "charcoal";
    }, "a non-default palette change reaches the server snapshot");
    for (const marker of privateMarkers) {
      assert.equal(JSON.stringify(changes).includes(marker), false, `the browser submission omits private fixture value ${marker}`);
    }

    await openSettingsPage(page, "About");
    await telemetrySection.locator("summary").click();
    const updatedPreview = JSON.parse(await preview.innerText()) as TelemetryEvent;
    assert.equal(updatedPreview.settings?.palette, "charcoal", "the preview refreshes with the server's updated snapshot");
    // a newer app's snapshot, herdr theme ids and both theme sides, is taken as it is; an unknown id is not
    const themed: TelemetrySettings = { ...updatedPreview.settings!, palette: "tokyo-night", darkTheme: "tokyo-night", lightTheme: "tokyo-night-day" };
    const postSettings = (settings: unknown) => fetch(`${origin}/api/telemetry`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify({ settings }) });
    assert.equal((await postSettings(themed)).status, 200, "the server takes a snapshot with herdr theme ids and the theme keys");
    assert.deepEqual((await statusAt(origin)).next?.settings, themed);
    assert.equal((await postSettings({ ...themed, palette: "not-a-theme" })).status, 400, "the server refuses an unknown theme id");
    assert.deepEqual((await statusAt(origin)).next?.settings, themed, "a refused snapshot leaves the last one in place");
    assert.equal(await notice.getByRole("button").count(), 3, "the line offers its sentence (Settings), Turn off and Dismiss, nothing else");
    const rows = await notice.locator(".update-notice-text").evaluate((text) => text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight));
    assert.ok(rows < 1.5, `the sentence stays on one row (${rows} rows)`);
    const sendSwitch = telemetrySection.getByRole("switch", { name: "Send anonymous usage counts", exact: true });
    await sendSwitch.click();
    await until(async () => !(await statusAt(origin)).enabled, "the Settings switch cancels the pending event");
    await sendSwitch.click();
    await until(async () => (await statusAt(origin)).enabled, "the Settings switch turns the counts on again");
    await dialog.getByRole("button", { name: "Close settings", exact: true }).click();
    // the line's own off: one tap, and the line leaves
    await notice.getByRole("button", { name: "Turn off", exact: true }).click();
    await until(async () => !(await statusAt(origin)).enabled, "Turn off on the line turns the counts off");
    await notice.waitFor({ state: "hidden" });
    fixtureNow += SEND_GRACE_MS + 1;
    await telemetry.report();
    assert.deepEqual(sent, [], "the grace period and fixture-only transport prevent outgoing telemetry");
    // turned off, a page keeps its settings to itself: the status is read, nothing is told
    const beforeReload = changes.length;
    const statusRead = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/telemetry" && response.request().method() === "GET");
    await page.reload();
    await statusRead;
    await page.locator(".conn-live").waitFor();
    await page.waitForTimeout(500); // fixed wait: an opted-out install may send no settings snapshot
    assert.equal(changes.slice(beforeReload).some((change) => change.settings !== undefined), false, "an opted-out install sends no settings snapshot to its server");
    assert.deepEqual(errors, []);
    console.log("PASS telemetry settings: current notice reacknowledged, snapshot first with the acknowledgement, safe preview and snapshot update, opt-out stops pending delivery and later snapshots");
  } finally {
    await context?.close();
    telemetry?.stop();
    server?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

// Focused QA entry point, e.g. `bun run check run --build bun scripts/telemetry-regression.ts`.
if (import.meta.main) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });
  try { await checkTelemetrySettings(browser); }
  finally { await browser.close(); }
}
