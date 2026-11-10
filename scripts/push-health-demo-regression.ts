/**
 * The alerts health notice and Settings → Alerts on the unmodified app over the demo's fixture
 * transport, with a stand-in PushManager lent to the page: a push service that retired this
 * device's subscription is told once, over the pane and in Settings alike, repaired once from
 * Settings, and the line leaves on the success the repair proves. Then the states around it: a
 * refusal (no repair, Alerts opens Settings), a key mismatch, a denied permission, no push
 * support, the PC out of reach, a look still under way, and a test refused to a watching
 * device. No notification is sent to any real device; all files and HTTP traffic stay in this
 * disposable, loopback-only app, and no herdr session is opened.
 *
 * UI_EVIDENCE_DIR: push-health-<390|1440>-<light|dark>[-ko][-<state>].png and manifest.json.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { DEMO_PUSH } from "../site/demo/fixtures.ts";
import { JA } from "../src/lib/i18n.ja.ts";
import { KO } from "../src/lib/i18n.ko.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";

type Theme = "light" | "dark";
type Language = "en" | "ko";
interface Shot { file: string; width: number; height: number; theme: Theme; language: Language; state: string; sha256: string; capturedAt: string }

const EVIDENCE = process.env.UI_EVIDENCE_DIR;
const manifest: Shot[] = [];
const results: Record<string, unknown> = {};
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const NOTICE = '[data-testid="push-health-notice"]';
const HINT = '[data-testid="push-health-hint"]';
const QA_KEY = "ovis:push-health-qa";

/**
 * Lent to the page after the demo transport: a PushManager whose subscriptions are the fixtures
 * (site/demo/fixtures.ts) or fresh ones, and a gate on the transport's fetch so an answer can be
 * held back, counted, refused or lost. `localStorage[QA_KEY]` picks the state the page loads in.
 */
const STAND_IN = `<script>(() => {
  const FIXTURES = ${JSON.stringify({ retired: DEMO_PUSH.retired.subscription, refused: DEMO_PUSH.refused.subscription, key: DEMO_PUSH.publicKey })};
  const mode = localStorage.getItem(${JSON.stringify(QA_KEY)}) ?? "fresh";
  const keyBuffer = (text) => { const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=")); const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i); return bytes.buffer; };
  const serverKey = keyBuffer(FIXTURES.key);
  let issued = 0;
  let live = null;
  const standIn = (endpoint, keys, key) => ({ endpoint, options: { applicationServerKey: key }, unsubscribe: async () => { if (live && live.endpoint === endpoint) live = null; return true; }, toJSON: () => ({ endpoint, keys }) });
  const fresh = (key) => { issued += 1; return standIn("https://push.example.test/demo/device-" + issued, { p256dh: "device-" + issued + "-p256dh", auth: "device-" + issued + "-auth" }, key); };
  if (mode === "refused") live = standIn(FIXTURES.refused.endpoint, FIXTURES.refused.keys, serverKey);
  else if (mode !== "unsupported") live = fresh(serverKey);
  const pushManager = {
    getSubscription: async () => live,
    subscribe: async (options) => { if (hook.subscribeFails) throw new DOMException("push service off", "NotAllowedError"); live = fresh(options.applicationServerKey.buffer.slice(options.applicationServerKey.byteOffset, options.applicationServerKey.byteOffset + options.applicationServerKey.byteLength)); return live; },
  };
  if (mode !== "unsupported") {
    Object.defineProperty(globalThis, "PushManager", { value: class PushManager {}, configurable: true });
    Object.defineProperty(navigator.serviceWorker, "ready", { value: Promise.resolve({ pushManager }), configurable: true });
    Object.defineProperty(navigator.serviceWorker, "getRegistration", { value: async () => ({ pushManager }), configurable: true });
  }
  if (mode === "denied") Object.defineProperty(Notification, "permission", { get: () => "denied", configurable: true });
  const transportFetch = window.fetch;
  const holds = new Map();
  const counts = {};
  const answers = {};
  const hook = {
    counts, offline: false, subscribeFails: false,
    hold(key) { let release; holds.set(key, new Promise((resolve) => { release = resolve; })); hook.releases[key] = release; },
    releases: {},
    release(key) { const release = hook.releases[key]; holds.delete(key); delete hook.releases[key]; if (release) release(); },
    refuse(key, status, code) { answers[key] = { status, body: { error: { code, message: code } } }; },
    respond(key, body) { answers[key] = { status: 200, body }; },
    answerAgain(key) { delete answers[key]; },
    holdSubscription(name) { live = name === "mismatch" ? standIn("https://push.example.test/demo/other-key", { p256dh: "other-p256dh", auth: "other-auth" }, new Uint8Array(65).fill(7).buffer) : standIn(FIXTURES[name].endpoint, FIXTURES[name].keys, serverKey); },
    endpoint: () => live && live.endpoint,
  };
  window.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!url.pathname.startsWith("/api/push")) return transportFetch(input, init);
    const key = (init && init.method ? init.method : "GET").toUpperCase() + " " + url.pathname;
    counts[key] = (counts[key] ?? 0) + 1;
    const answer = () => {
      if (hook.offline && url.pathname === "/api/push/status") return Promise.reject(new TypeError("Failed to fetch"));
      const refused = answers[key];
      if (refused) return Promise.resolve(new Response(JSON.stringify(refused.body), { status: refused.status, headers: { "content-type": "application/json" } }));
      return transportFetch(input, init);
    };
    const hold = holds.get(key);
    return hold ? hold.then(answer) : answer();
  };
  window.__push = hook;
})();</script>`;

/**
 * Run around the demo transport's own script: the transport ends the turn it opens with on a 4500 ms timer
 * (site/demo/transport.ts, "the turn in progress"), which would land at whatever moment a capture is taken.
 * That one timer is held, never run, so every frame shows the same turn in progress; the page's own timers
 * are untouched once the transport has loaded.
 */
const HOLD_DEMO_TURN = `<script>(() => { const later = window.setTimeout; window.__laterTimeout = later; window.setTimeout = (callback, ms, ...args) => ms === 4500 ? (window.__heldDemoTurn = callback, 0) : later(callback, ms, ...args); })();</script>`;
const RELEASE_TIMERS = `<script>window.setTimeout = window.__laterTimeout;</script>`;

declare global {
  interface Window {
    __heldDemoTurn?: () => void;
    __push: {
      counts: Record<string, number>;
      offline: boolean;
      /** the browser will not make a subscription (Brave with its push service off): a repair fails as "refused" */
      subscribeFails: boolean;
      hold(key: string): void;
      release(key: string): void;
      refuse(key: string, status: number, code: string): void;
      respond(key: string, body: object): void;
      answerAgain(key: string): void;
      holdSubscription(name: "retired" | "refused" | "mismatch"): void;
      endpoint(): string | null;
    };
  }
}

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

async function capture(page: Page, width: number, theme: Theme, language: Language, state: string): Promise<void> {
  if (!EVIDENCE) return;
  const file = `push-health-${width}-${theme}${language === "ko" ? "-ko" : ""}${state === "rest" ? "" : `-${state}`}.png`;
  const path = join(EVIDENCE, file);
  // a sheet still rising or dropping is drawn at its end, so a capture never lands mid-slide
  await page.screenshot({ path, animations: "disabled" });
  const viewport = page.viewportSize()!;
  manifest.push({ file, width: viewport.width, height: viewport.height, theme, language, state, sha256: sha256(path), capturedAt: new Date().toISOString() });
}

const count = (page: Page, key: string): Promise<number> => page.evaluate((k) => window.__push.counts[k] ?? 0, key);
const waitForCount = (page: Page, key: string, least: number): Promise<unknown> => page.waitForFunction(([k, n]) => (window.__push.counts[k] ?? 0) >= n, [key, least] as const);
const cameToFront = (page: Page): Promise<void> => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
/** Nothing in the page scrolls sideways: no control reaches past the viewport. */
const noSidewaysScroll = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth && [...document.querySelectorAll<HTMLElement>(".settings-dialog, .pane-column")].every((el) => el.scrollWidth <= el.clientWidth + 0.5));
const touchSized = (locator: Locator): Promise<boolean> => locator.evaluate((el) => { const box = el.getBoundingClientRect(); return box.width >= 44 && box.height >= 44; });

async function run(browser: Browser, origin: string, width: number, theme: Theme, language: Language): Promise<void> {
  const label = (text: string): string => language === "ko" ? KO[text] ?? text : text;
  const phone = width === PHONE.width;
  const viewport = phone ? PHONE : DESKTOP;
  const tag = `${width} ${theme} ${language}`;
  const open = async (mode: string) => {
    const context = await browser.newContext({ viewport, ...(phone ? { deviceScaleFactor: 3, isMobile: true, hasTouch: true } : {}), locale: language === "ko" ? "ko-KR" : "en-US", permissions: ["notifications"] });
    await context.addInitScript(([settings, key, state]) => { localStorage.setItem("ovis:settings", settings); localStorage.setItem(key, state); }, [JSON.stringify({ language, theme, alertsOn: true }), QA_KEY, mode] as const);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await page.locator(".conn-live").waitFor();
    assert.equal(await page.evaluate(() => typeof window.__heldDemoTurn), "function", `${tag}: the demo's turn is held, so no capture races its end`);
    assert.equal(await page.evaluate(() => document.documentElement.dataset["theme"]), theme, `${tag}: the page is drawn in the ${theme} theme`);
    return { context, page, errors };
  };
  const openAlerts = async (page: Page): Promise<Locator> => {
    const dialog = page.locator(".settings-dialog");
    if (await dialog.count() === 0) await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, label("Alerts"), label("Back to settings"));
    return dialog;
  };
  const closeSettings = async (page: Page): Promise<void> => {
    await page.getByRole("button", { name: label("Close settings"), exact: true }).click();
    await page.locator(".settings-dialog").waitFor({ state: "detached" });
    // a phone's sheet drops out of sight after React removed it: its last frame hangs on an inert host at
    // the end of <body> (lib/sheets.ts) until it has slid out, and a capture waits for it to go
    await page.waitForFunction(() => ![...document.body.children].some((node) => node instanceof HTMLDivElement && node.inert && node.getAttribute("aria-hidden") === "true" && node.childElementCount === 0));
  };
  const notice = (page: Page): Locator => page.locator(NOTICE);
  const hint = (page: Page): Locator => page.locator(HINT);
  const GONE = label("The push service retired this device's subscription. Turn alerts on again to make a new one.");
  const SENT = label("Test notification sent. Check this device for the alert.");
  const REPAIR = label("Turn alerts on again");
  const REPAIRING = label("Turning alerts on…");

  // ---- the retired device: told once, repaired once from Settings ----------------------------
  {
    const { context, page, errors } = await open("fresh");
    try {
      await waitForCount(page, "POST /api/push/status", 1);
      assert.equal(await notice(page).count(), 0, `${tag}: a registered subscription with a clean record shows no notice`);
      // the push service retired this device's subscription since: the app comes to the front and reads it
      await page.evaluate(() => window.__push.holdSubscription("retired"));
      await cameToFront(page);
      await notice(page).waitFor();
      assert.equal(await notice(page).getAttribute("data-problem"), "gone");
      assert.equal(await notice(page).locator("span").textContent(), GONE);
      assert.equal(await notice(page).count(), 1, `${tag}: one notice`);
      assert.ok(await noSidewaysScroll(page), `${tag}: nothing scrolls sideways with the notice`);
      const button = notice(page).getByRole("button", { name: REPAIR, exact: true });
      if (phone) assert.ok(await touchSized(button), `${tag}: the notice's button is a finger-sized target`);
      // one line at every width (G-103): Close shares the button's row and keeps to the notice's right end
      {
        const close = (await notice(page).getByRole("button", { name: language === "ko" ? "닫기" : "Dismiss", exact: true }).boundingBox())!;
        const repairBox = (await button.boundingBox())!;
        const line = (await notice(page).boundingBox())!;
        assert.ok(Math.abs((close.y + close.height / 2) - (repairBox.y + repairBox.height / 2)) < 2, `${tag}: Close sits on the button's line`);
        assert.ok(close.x > repairBox.x + repairBox.width && line.x + line.width - (close.x + close.width) < 24, `${tag}: Close is the line's last control, at its right end`);
      }
      await capture(page, width, theme, language, "rest");
      if (!phone) {
        await button.hover();
        await capture(page, width, theme, language, "hover");
        await page.mouse.move(0, 0);
      }
      await button.focus();
      if (!(await button.evaluate((el) => el.matches(":focus-visible")))) { await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab"); }
      assert.ok(await button.evaluate((el) => el.matches(":focus-visible") && document.activeElement === el), `${tag}: the button shows its focus ring from the keyboard`);
      await capture(page, width, theme, language, "focus");
      const box = (await button.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await capture(page, width, theme, language, "pressed");
      await page.mouse.move(0, 0);
      await page.mouse.up();
      assert.equal(await count(page, "POST /api/push/subscribe"), 1, `${tag}: a press let go elsewhere starts no repair`);

      // a look still under way: nothing changes until the answer comes
      await page.evaluate(() => window.__push.hold("POST /api/push/status"));
      await cameToFront(page);
      await waitForCount(page, "POST /api/push/status", 3);
      await capture(page, width, theme, language, "loading");
      assert.equal(await notice(page).count(), 1);
      await page.evaluate(() => window.__push.release("POST /api/push/status"));
      // the PC out of reach: what was known stands
      await page.evaluate(() => { window.__push.offline = true; });
      await cameToFront(page);
      await waitForCount(page, "POST /api/push/status", 4);
      await page.locator(".conn-live").waitFor();
      assert.equal(await notice(page).count(), 1, `${tag}: the notice stays while the PC is out of reach`);
      await capture(page, width, theme, language, "offline");
      await page.evaluate(() => { window.__push.offline = false; });

      // Settings says the same, once; the repair runs there
      const dialog = await openAlerts(page);
      await hint(page).filter({ hasText: GONE }).waitFor();
      assert.equal(await page.locator(".update-notice.is-alerts").count(), 1, `${tag}: Settings adds no second banner`);
      const repair = dialog.getByRole("button", { name: REPAIR, exact: true });
      if (phone) assert.ok(await touchSized(repair), `${tag}: the repair button in Settings is finger-sized`);
      assert.ok(await noSidewaysScroll(page), `${tag}: Settings fits`);
      await capture(page, width, theme, language, "settings");
      await page.evaluate(() => { window.__push.hold("POST /api/push/subscribe"); window.__push.hold("POST /api/push/test"); });
      await repair.click();
      await dialog.getByRole("button", { name: REPAIRING, exact: true }).waitFor();
      assert.equal(await dialog.getByRole("button", { name: REPAIRING, exact: true }).isDisabled(), true);
      assert.equal(await notice(page).getByRole("button", { name: REPAIRING, exact: true }).isDisabled(), true, `${tag}: the notice's button waits with Settings'`);
      assert.equal(await dialog.getByRole("button", { name: label("Send test"), exact: true }).isDisabled(), true);
      await capture(page, width, theme, language, "repairing");
      // the retired endpoint is refused and a new subscription made, then the confirmation push, then the look that clears the line
      await page.evaluate(() => window.__push.release("POST /api/push/subscribe"));
      await waitForCount(page, "POST /api/push/test", 1);
      assert.equal(await notice(page).count(), 1, `${tag}: still one notice until the push is proven`);
      await page.evaluate(() => window.__push.release("POST /api/push/test"));
      await hint(page).filter({ hasText: SENT }).waitFor();
      await notice(page).waitFor({ state: "detached" });
      assert.equal(await count(page, "POST /api/push/subscribe"), 3, `${tag}: the retired endpoint was handed over, refused, and a new one registered`);
      assert.equal(await count(page, "POST /api/push/test"), 1, `${tag}: one confirmation push`);
      assert.match((await page.evaluate(() => window.__push.endpoint())) ?? "", /device-2$/);
      await capture(page, width, theme, language, "result");
      if (phone) {
        await page.locator(".settings-body:not([hidden])").evaluate((body) => { body.scrollTop = body.scrollHeight; });
        await capture(page, width, theme, language, "settings-end");
      }
      results[`${tag} retired-device-repair`] = { notices: 1, subscribeCalls: 3, testCalls: 1, cleared: true };

      // a watching device: it may receive alerts, but its test is refused (403 read_only); the line says it can only
      // watch, Send test becomes unavailable, nothing is registered and no banner appears
      await page.evaluate(() => window.__push.refuse("POST /api/push/test", 403, "read_only"));
      const registered = await count(page, "POST /api/push/subscribe");
      await dialog.getByRole("button", { name: label("Send test"), exact: true }).click();
      await hint(page).filter({ hasText: label("This device can only watch.") }).waitFor();
      assert.equal(await count(page, "POST /api/push/subscribe"), registered, `${tag}: a refused test changes no registration`);
      assert.equal(await page.locator(".update-notice.is-alerts").count(), 0);
      assert.equal(await dialog.getByRole("button", { name: label("Send test"), exact: true }).isDisabled(), true, `${tag}: a watching device cannot send a test`);
      await capture(page, width, theme, language, "observe");
      await page.evaluate(() => window.__push.answerAgain("POST /api/push/test"));
      await closeSettings(page);

      // a subscription made for another server key: the longest line, repaired from the notice
      await page.evaluate(() => window.__push.holdSubscription("mismatch"));
      await cameToFront(page);
      await notice(page).waitFor();
      assert.equal(await notice(page).getAttribute("data-problem"), "key-mismatch");
      assert.ok(await noSidewaysScroll(page), `${tag}: the longest line fits`);
      await capture(page, width, theme, language, "key-mismatch");
      await openAlerts(page);
      await hint(page).filter({ hasText: label("This device's push subscription was made for another server key. Turn alerts on again to make a new one.") }).waitFor();
      await capture(page, width, theme, language, "key-mismatch-settings");
      await closeSettings(page);
      const before = await count(page, "POST /api/push/subscribe");
      await notice(page).getByRole("button", { name: REPAIR, exact: true }).click();
      await notice(page).waitFor({ state: "detached" });
      assert.equal(await count(page, "POST /api/push/subscribe"), before + 1, `${tag}: a mismatched key is replaced with one registration`);
      await capture(page, width, theme, language, "repaired");

      // the server no longer knows this subscription: told as missing, with the same repair
      await page.evaluate(() => window.__push.refuse("POST /api/push/status", 404, "subscription_not_found"));
      await cameToFront(page);
      await notice(page).and(page.locator('[data-problem="missing"]')).waitFor();
      assert.equal(await notice(page).locator("span").textContent(), label("This device's push subscription is missing. Turn alerts on again."));
      assert.ok(await noSidewaysScroll(page), `${tag}: the missing line fits`);
      await capture(page, width, theme, language, "missing");

      // a transient failure newer than the last success: a line in Settings, never a notice, no repair
      await page.evaluate(() => window.__push.respond("POST /api/push/status", { registered: true, last_success_at: "2026-10-20T08:12:00.000Z", last_failure_at: "2026-10-21T07:41:00.000Z", last_failure: "network" }));
      await cameToFront(page);
      await notice(page).waitFor({ state: "detached" });
      const settings = await openAlerts(page);
      await hint(page).filter({ hasText: label("The last alert did not reach this device; the next one is tried as usual. Send a test to check.") }).waitFor();
      assert.equal(await settings.getByRole("button", { name: REPAIR, exact: true }).count(), 0, `${tag}: a transient failure offers no re-subscription`);
      await capture(page, width, theme, language, "transient");
      await page.evaluate(() => window.__push.answerAgain("POST /api/push/status"));
      await closeSettings(page);
      assert.deepEqual(errors, [], `${tag}: no page errors`);
    } finally { await context.close(); }
  }

  // ---- a refusal: told, and Alerts opens Settings where Send test answers it -------------------
  {
    const { context, page, errors } = await open("refused");
    try {
      await notice(page).waitFor();
      assert.equal(await notice(page).getAttribute("data-problem"), "rejected");
      assert.equal(await notice(page).getByRole("button", { name: REPAIR, exact: true }).count(), 0, `${tag}: a refusal offers no re-subscription`);
      await capture(page, width, theme, language, "refused");
      await notice(page).getByRole("button", { name: label("Alerts"), exact: true }).click();
      await page.locator(".settings-dialog").getByRole("tabpanel", { name: label("Alerts"), exact: true }).waitFor();
      await hint(page).filter({ hasText: label("The push service refused the last alert to this device. Send a test to check whether it still does.") }).waitFor();
      await capture(page, width, theme, language, "refused-settings");
      await page.locator(".settings-dialog").getByRole("button", { name: label("Send test"), exact: true }).click();
      await hint(page).filter({ hasText: SENT }).waitFor();
      await notice(page).waitFor({ state: "detached" });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }

  // ---- a denied permission: guidance in Settings, no notice, no repair ------------------------
  {
    const { context, page, errors } = await open("denied");
    try {
      await openAlerts(page);
      await hint(page).filter({ hasText: label("Allow notifications in your browser settings, then try again.") }).waitFor();
      assert.equal(await notice(page).count(), 0, `${tag}: a denied permission is no notice`);
      assert.equal(await page.locator(".settings-dialog").getByRole("button", { name: REPAIR, exact: true }).count(), 0);
      await capture(page, width, theme, language, "permission");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }

  // ---- no push here: the line says what push needs ---------------------------------------------
  {
    const { context, page, errors } = await open("unsupported");
    try {
      await openAlerts(page);
      await hint(page).filter({ hasText: label("Push alerts need HTTPS or localhost, and on iPhone the home-screen app.") }).waitFor();
      assert.equal(await notice(page).count(), 0);
      assert.equal(await count(page, "POST /api/push/status"), 0, `${tag}: no push, no question`);
      await capture(page, width, theme, language, "unsupported");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  console.log(`PASS push health ${tag}: one notice over the pane and in Settings, repaired once, cleared on the proven push; refusal, key mismatch, missing, transient, denied, unsupported, offline, loading and a watching device's refused test`);
}

/**
 * A repair that fails says why in full (repairFailureText): on a narrow phone at the largest interface text the
 * sentence keeps most of the line's width, the repair button drops under it, Close stays at the top right, and the
 * notice stays within the screen, scrolling inside itself when it must (G-103). A wide screen keeps the line's row:
 * only the sentence wraps, the repair button and Close stay beside it.
 */
async function checkFailedRepairAtLargeText(browser: Browser, origin: string, width: number): Promise<void> {
  const wide = width > 640;
  const viewport = wide ? DESKTOP : { width, height: width === 320 ? 568 : 844 };
  const tag = `${width} failed repair at 20px`;
  const context = await browser.newContext({ viewport, ...(wide ? {} : { deviceScaleFactor: 3, isMobile: true, hasTouch: true }), locale: "en-US", permissions: ["notifications"] });
  await context.addInitScript(([settings, key]) => { localStorage.setItem("ovis:settings", settings); localStorage.setItem(key, "fresh"); }, [JSON.stringify({ language: "en", theme: "light", alertsOn: true, uiFontSize: 20 }), QA_KEY] as const);
  try {
    const page = await context.newPage();
    await page.goto(origin);
    await page.locator(".conn-live").waitFor();
    await waitForCount(page, "POST /api/push/status", 1);
    // the subscription is gone from this device, and the browser will not make another: the repair fails for the
    // fault it was meant to mend, which keeps its reason on the line
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await (await registration!.pushManager.getSubscription())?.unsubscribe();
      window.__push.subscribeFails = true;
    });
    await cameToFront(page);
    const notice = page.locator(NOTICE);
    await notice.waitFor();
    await notice.getByRole("button", { name: "Turn alerts on again", exact: true }).click();
    // whichever way the browser's refusal is told (refused, no worker, not registered), the line says why in full
    await page.locator(`${NOTICE}:is([data-result="refused"], [data-result="no-worker"], [data-result="unregistered"])`).waitFor();
    const box = async (locator: Locator) => (await locator.boundingBox())!;
    const line = await box(notice);
    const reason = await box(notice.locator("span"));
    const action = await box(notice.getByRole("button", { name: "Turn alerts on again", exact: true }));
    const close = await box(notice.getByRole("button", { name: "Dismiss", exact: true }));
    if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `push-health-${width}-light-failed-repair-20px.png`) });
    if (wide) {
      const middle = (b: { y: number; height: number }) => b.y + b.height / 2;
      assert.ok(Math.abs(middle(action) - middle(close)) < 2 && action.x >= reason.x + reason.width - 1, `${tag}: the repair button and Close stay on one row beside the reason`);
      assert.ok(line.x + line.width - (close.x + close.width) < 24, `${tag}: Close stays at the line's right end`);
      console.log(`PASS ${tag}: the line keeps its row, the reason beside the repair button and Close`);
      return;
    }
    assert.ok(reason.width >= line.width * 0.6, `${tag}: the reason keeps most of the line's width (${Math.round(reason.width)} of ${Math.round(line.width)}px)`);
    assert.ok(action.y >= reason.y + reason.height - 1, `${tag}: the repair button sits under the reason`);
    assert.ok(close.y - line.y < 24 && line.x + line.width - (close.x + close.width) < 24, `${tag}: Close stays at the top right`);
    assert.ok(line.y + line.height <= viewport.height / 2 + 1, `${tag}: the notice keeps to the top half of the screen (${Math.round(line.height)}px tall)`);
    // what does not fit is read by scrolling the notice itself
    assert.ok(await notice.evaluate((node) => node.scrollHeight <= node.clientHeight + 1 || getComputedStyle(node).overflowY === "auto"), `${tag}: an overflowing reason scrolls inside the notice`);
    console.log(`PASS ${tag}: the reason reads at width, the button under it, Close at the top right, the notice within the screen`);
  } finally { await context.close(); }
}

/**
 * The fault's line at the largest interface text in Japanese, whose repair label is the longest (#3498): on a 320px
 * phone the label has no room beside Close even with the sentence cut to nothing, so it wraps inside its button and
 * Close stays on the screen at the line's right end, a finger's size, and closes the line. At 390 the label fits: the
 * button keeps its one line and its height.
 */
async function checkLineAtLargeText(browser: Browser, origin: string, width: number): Promise<void> {
  const viewport = { width, height: width === 320 ? 568 : 844 };
  const tag = `${width} ja line at 20px`;
  const context = await browser.newContext({ viewport, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "ja-JP", permissions: ["notifications"] });
  await context.addInitScript(([settings, key]) => { localStorage.setItem("ovis:settings", settings); localStorage.setItem(key, "fresh"); }, [JSON.stringify({ language: "ja", theme: "light", alertsOn: true, uiFontSize: 20 }), QA_KEY] as const);
  try {
    const page = await context.newPage();
    await page.goto(origin);
    await page.locator(".conn-live").waitFor();
    await waitForCount(page, "POST /api/push/status", 1);
    await page.evaluate(() => window.__push.holdSubscription("retired"));
    await cameToFront(page);
    const notice = page.locator(NOTICE);
    await notice.waitFor();
    const close = notice.getByRole("button", { name: JA["Dismiss"]!, exact: true });
    const fits = async (state: string, name: string): Promise<void> => {
      const action = notice.getByRole("button", { name, exact: true });
      const line = (await notice.boundingBox())!;
      const actionBox = (await action.boundingBox())!;
      const closeBox = (await close.boundingBox())!;
      assert.ok(closeBox.x >= actionBox.x + actionBox.width && closeBox.x + closeBox.width <= viewport.width, `${tag}, ${state}: Close is whole on the screen after the button (${Math.round(closeBox.x)} to ${Math.round(closeBox.x + closeBox.width)} of ${viewport.width}px)`);
      assert.ok(line.x + line.width - (closeBox.x + closeBox.width) < 24, `${tag}, ${state}: Close keeps to the line's right end`);
      assert.ok(await touchSized(close) && await touchSized(action), `${tag}, ${state}: the button and Close are finger-sized targets`);
      assert.ok(await action.evaluate((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight), `${tag}, ${state}: the label stays inside its button`);
      assert.ok(await noSidewaysScroll(page) && await notice.evaluate((el) => el.scrollWidth <= el.clientWidth), `${tag}, ${state}: nothing reaches past the screen`);
      if (width > 320) assert.ok(actionBox.height < 45, `${tag}, ${state}: a label that fits keeps its one line (${Math.round(actionBox.height)}px tall)`);
    };
    await fits("rest", JA["Turn alerts on again"]!);
    if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `push-health-${width}-light-ja-20px.png`) });
    // while the repair runs the button says so, and still leaves Close its place
    await page.evaluate(() => window.__push.hold("POST /api/push/subscribe"));
    await notice.getByRole("button", { name: JA["Turn alerts on again"]!, exact: true }).tap();
    await notice.getByRole("button", { name: JA["Turning alerts on…"]!, exact: true }).waitFor();
    await fits("repairing", JA["Turning alerts on…"]!);
    await close.tap();
    await notice.waitFor({ state: "detached" });
    await page.evaluate(() => window.__push.release("POST /api/push/subscribe"));
    console.log(`PASS ${tag}: Close on the screen at the line's right end beside the repair button, and it closes the line`);
  } finally { await context.close(); }
}

const app = mkdtempSync(join(tmpdir(), "herdr-push-health-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `${HOLD_DEMO_TURN}<script src="./demo-transport.js"></script>${RELEASE_TIMERS}${STAND_IN}\n    <script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const prefix = "/herdr-web-ui/demo/app/";
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const origin = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;
      for (const [width, theme, language] of [[PHONE.width, "light", "en"], [PHONE.width, "dark", "en"], [DESKTOP.width, "light", "en"], [DESKTOP.width, "dark", "en"], [PHONE.width, "light", "ko"]] as const) {
        await run(browser, origin, width, theme, language);
      }
      for (const width of [320, PHONE.width, DESKTOP.width]) await checkFailedRepairAtLargeText(browser, origin, width);
      for (const width of [320, PHONE.width]) await checkLineAtLargeText(browser, origin, width);
    } finally { await browser.close(); }
  } finally { server.stop(true); }
  if (EVIDENCE) {
    writeFileSync(join(EVIDENCE, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(EVIDENCE, "push-health-result.json"), `${JSON.stringify({ script: "scripts/push-health-demo-regression.ts", ok: true, results, captures: manifest.length }, null, 2)}\n`);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
