import assert from "node:assert/strict";
import { devices, type Browser, type BrowserContext, type Page } from "playwright-core";
import { appContext } from "./app-context.ts";
import { withDemoBrowser } from "./demo-browser.ts";
import { openSettingsFolds } from "./settings-page.ts";
import { DEMO_FILE_PREVIEW_SCRIPT } from "./demo-file-preview.ts";
import { KO } from "../src/lib/i18n.ko.ts";

/**
 * The access facts on Settings → Phone & devices, over the demo's fictional answers
 * (site/demo/transport.ts, `?demo_security=`): each fact on its own labelled line, no control to
 * change any of them, public reachability unknown unless the request proved it, an older server
 * and a failed check shown as such rather than filled in, and the open-LAN warning exactly as
 * before. No herdr session is opened; the app is served on loopback from a temporary directory.
 */
const SECTION = '.settings-body:not([hidden]) [data-section="access"]';
const LAN = '[data-testid="lan-exposure-notice"]';
const LAN_TEXT = "Anyone who can reach 0.0.0.0 on your network can type into every pane: no access token is set and no device is paired yet.Devices and PCs";

const known = { "Access token": "Set", "Pairing gate": "Closed", "Listens on": "Loopback", "This connection": "Through Tailscale", "Public internet": "Unknown" };
const FACTS: Record<string, Record<string, string>> = {
  known,
  watch: known,
  unknown: { "Access token": "Not set", "Pairing gate": "Not yet closed", "Listens on": "Other address", "This connection": "Unknown", "Public internet": "Unknown" },
  proxy: { "Access token": "Not set", "Pairing gate": "Not yet closed", "Listens on": "Loopback", "This connection": "Through a proxy", "Public internet": "Unknown" },
  gated: { "Access token": "Not set", "Pairing gate": "Closed", "Listens on": "Other address", "This connection": "No proxy seen", "Public internet": "Unknown" },
  funnel: { "Access token": "Set", "Pairing gate": "Closed", "Listens on": "Loopback", "This connection": "Through Tailscale Funnel", "Public internet": "Reachable" },
  tailnet: { "Access token": "Set", "Pairing gate": "Closed", "Listens on": "Tailscale address", "This connection": "No proxy seen", "Public internet": "Unknown" },
  unavailable: { "Access token": "Not set", "Pairing gate": "Unavailable", "Listens on": "Other address", "This connection": "No proxy seen", "Public internet": "Unknown" },
};
const STATUS: Record<string, string> = {
  older: "This server does not report these facts. Updating it adds them.",
  error: "The server did not answer, so these facts are unavailable. Nothing from an earlier check is shown. This page asks again by itself; if this message stays, check that the server is running and that this device can reach it.",
  loading: "Loading…",
};

type Seen = { facts: Record<string, string>; described: boolean; status: string | null; controls: string[]; text: string; overflow: string[] };

async function read(page: Page): Promise<Seen> {
  return await page.locator(SECTION).evaluate((section) => {
    const facts: Record<string, string> = {};
    let described = true;
    for (const row of section.querySelectorAll(".settings-row")) {
      const label = row.querySelector(".settings-label")?.textContent?.trim() ?? "";
      facts[label] = row.querySelector(".settings-fact")?.textContent?.trim() ?? "";
      described &&= label !== "" && (row.querySelector(".settings-description")?.textContent?.trim() ?? "") !== "";
    }
    const controls = [...section.querySelectorAll("button, input, select, textarea, a, [role='switch'], [contenteditable], [tabindex]:not([tabindex='-1'])")].map((node) => node.outerHTML.slice(0, 80));
    const body = section.closest<HTMLElement>(".settings-body")!;
    const card = section.querySelector(".settings-card")!.getBoundingClientRect();
    const overflow = [...section.querySelectorAll<HTMLElement>(".settings-row, .settings-fact, .settings-label, .settings-description")]
      .filter((node) => { const box = node.getBoundingClientRect(); return box.right > card.right + 0.5 || box.left < card.left - 0.5; })
      .map((node) => `${node.className}: ${node.textContent?.slice(0, 30)}`);
    if (body.scrollWidth > body.clientWidth) overflow.push(`settings body scrolls sideways (${body.scrollWidth} > ${body.clientWidth})`);
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth) overflow.push("the page scrolls sideways");
    return { facts, described, status: section.querySelector("[role='status']")?.textContent?.trim() ?? null, controls, text: section.textContent ?? "", overflow };
  });
}

async function holdOpeningTurn(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const later = window.setTimeout.bind(window);
    const held = window as unknown as { heldOpeningTurn: boolean };
    held.heldOpeningTurn = false;
    window.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (ms === 4500 && !held.heldOpeningTurn) { held.heldOpeningTurn = true; return 0; }
      return later(callback, ms, ...args);
    }) as typeof window.setTimeout;
  });
}

const PAIRED = ["known", "watch", "funnel", "tailnet", "gated", "older", "error", "loading"];

async function pairedDevices(context: BrowserContext): Promise<void> {
  await context.addInitScript((paired) => {
    const variant = new URLSearchParams(location.search).get("demo_security") ?? "known";
    if (!paired.includes(variant)) return;
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const devices = [
      { id: "demo-phone", label: "iPhone (Safari)", role: variant === "watch" ? "watch" : "drive", created_at: ago(60 * 24 * 9), last_seen_at: ago(0), current: true },
      { id: "demo-tablet", label: "Galaxy Tab S9 (Chrome)", role: "drive", created_at: ago(60 * 24 * 30), last_seen_at: ago(60 * 3), current: false },
    ];
    const wrap = (inner: typeof window.fetch): typeof window.fetch => ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (url.pathname.endsWith("/api/devices") && method === "GET") return Promise.resolve(new Response(JSON.stringify({ devices }), { headers: { "content-type": "application/json" } }));
      return inner(input, init);
    }) as typeof window.fetch;
    let current = window.fetch;
    Object.defineProperty(window, "fetch", { configurable: true, get: () => current, set: (next: typeof window.fetch) => { current = wrap(next); } });
  }, PAIRED);
}

async function open(context: BrowserContext, variant: string, settings = true, label: (name: string) => string = (name) => name): Promise<Page> {
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(`${variant}: ${error.message}`));
  await page.goto(`${url}?demo_security=${variant}${settings ? "&settings=devices" : ""}`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  assert.equal(await page.evaluate(() => (window as unknown as { heldOpeningTurn: boolean }).heldOpeningTurn), true, `${variant}: the demo's opening turn is held`);
  if (!settings) return page;
  await page.locator(".settings-body:not([hidden])").waitFor();
  await openSettingsFolds(page);
  await page.locator(SECTION).waitFor();
  await page.locator(SECTION).scrollIntoViewIfNeeded();
  if (variant in STATUS) await page.locator(`${SECTION} [role='status']`, { hasText: label(STATUS[variant]!) }).waitFor();
  else await page.locator(`${SECTION} .settings-fact`).nth(4).waitFor();
  if (PAIRED.includes(variant)) await page.locator(".settings-body:not([hidden]) .devices-row").nth(1).waitFor();
  else await page.locator(".settings-body:not([hidden]) .devices-panel").getByText(label("No devices paired yet.")).waitFor();
  return page;
}

const pageErrors: string[] = [];
const verdicts = /\b(safe|secure|protected|local only)\b/i;

async function check(browser: Browser, width: 390 | 1440): Promise<void> {
  const context = await appContext(browser, width === 390 ? { ...devices["iPhone 14"] } : { viewport: { width: 1440, height: 900 } });
  try {
    await holdOpeningTurn(context);
    await pairedDevices(context);
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark" })));
    for (const variant of [...Object.keys(FACTS), ...Object.keys(STATUS)]) {
      const page = await open(context, variant);
      const seen = await read(page);
      if (variant in FACTS) {
        assert.deepEqual(seen.facts, FACTS[variant], `${variant} @${width}: each fact on its own line`);
        assert.ok(seen.described, `${variant} @${width}: every fact has its label and its explanation`);
        assert.equal(seen.status, null);
      } else {
        assert.deepEqual(seen.facts, {}, `${variant} @${width}: no fact is shown, from an earlier answer or a guess`);
        assert.equal(seen.status, STATUS[variant], `${variant} @${width}`);
      }
      assert.deepEqual(seen.controls, [], `${variant} @${width}: read-only, with nothing to press or change`);
      assert.doesNotMatch(seen.text, verdicts, `${variant} @${width}: no safety verdict`);
      assert.deepEqual(seen.overflow, [], `${variant} @${width}: nothing clipped or scrolling sideways`);
      // the open-LAN warning is unchanged and only where the server sends it
      const lan = page.locator(LAN);
      if (variant === "unknown") assert.equal((await lan.textContent())?.trim(), LAN_TEXT);
      else assert.equal(await lan.count(), 0, `${variant}: no LAN warning`);
      await page.close();
    }
    const page = await open(context, "known");
    const refresh = (next: string) => page.evaluate((value) => { sessionStorage.setItem("ovis:demo-security", value); document.dispatchEvent(new Event("visibilitychange")); }, next);
    await refresh("error");
    await page.locator(`${SECTION} [role='status']`, { hasText: STATUS["error"]! }).waitFor();
    assert.equal(await page.locator(`${SECTION} .settings-fact`).count(), 0, "an unanswered check shows no earlier fact");
    await refresh("older");
    await page.locator(`${SECTION} [role='status']`, { hasText: STATUS["older"]! }).waitFor();
    await refresh("known");
    await page.locator(`${SECTION} .settings-fact`).nth(4).waitFor();
    assert.deepEqual((await read(page)).facts, known);
    await page.evaluate(() => {
      const original = window.fetch;
      const probe = { hold: true, pending: false, consumed: false, after: false, release: () => {} };
      (window as unknown as { healthProbe: typeof probe }).healthProbe = probe;
      window.fetch = async (input, init) => {
        const target = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
        if (target.includes("/api/health") && target.includes("scope=bridge") && probe.hold) {
          probe.hold = false;
          const answer = await original(input, init);
          const json = answer.json.bind(answer);
          answer.json = async () => { const body: unknown = await json(); probe.consumed = true; return body; };
          return await new Promise<Response>((resolve) => { probe.release = () => resolve(answer); probe.pending = true; });
        }
        if (target.includes("/api/health") && !target.includes("scope=bridge") && probe.consumed) probe.after = true;
        return await original(input, init);
      };
    });
    type Probe = { pending: boolean; after: boolean; release: () => void };
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForFunction(() => (window as unknown as { healthProbe: Probe }).healthProbe.pending);
    await refresh("error");
    await page.locator(`${SECTION} [role='status']`, { hasText: STATUS["error"]! }).waitFor();
    await page.evaluate(() => (window as unknown as { healthProbe: Probe }).healthProbe.release());
    await page.waitForFunction(() => (window as unknown as { healthProbe: Probe }).healthProbe.after);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const late = await read(page);
    assert.deepEqual(late.facts, {}, "an older answer landing after a newer failure shows none of its facts");
    assert.equal(late.status, STATUS["error"]);
    await page.close();
    assert.deepEqual(pageErrors, [], "no page raised an error");
    console.log(`PASS @${width}: current, unknown, proxy, gated, funnel, unavailable, watch, older-server, loading and error states; no controls; LAN warning unchanged; no stale facts`);
  } finally {
    await context.close();
  }
}

/** a Korean phone in the light theme: each fact, its value and an unanswered check in Korean */
async function checkKorean(browser: Browser): Promise<void> {
  const ko = (name: string): string => { assert.ok(KO[name], `"${name}" has a Korean entry`); return KO[name]!; };
  const context = await appContext(browser, { ...devices["iPhone 14"], locale: "ko" });
  try {
    await holdOpeningTurn(context);
    await pairedDevices(context);
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "ko", theme: "light" })));
    for (const variant of ["known", "error"]) {
      const page = await open(context, variant, true, ko);
      const seen = await read(page);
      if (variant === "known") assert.deepEqual(seen.facts, Object.fromEntries(Object.entries(known).map(([name, value]) => [ko(name), ko(value)])), "ko: each fact and its value in Korean");
      else assert.equal(seen.status, ko(STATUS[variant]!), "ko: an unanswered check says so in Korean");
      assert.deepEqual(seen.overflow, [], `${variant} ko: nothing clipped or scrolling sideways`);
      await page.close();
    }
    assert.deepEqual(pageErrors, [], "no page raised an error");
    console.log("PASS @390 Korean, light: the facts and the error state in Korean, nothing clipped");
  } finally {
    await context.close();
  }
}

let url = "";
export async function runSecuritySummary(): Promise<void> {
  await withDemoBrowser({ tempPrefix: "herdr-security-summary-demo-", afterTransport: DEMO_FILE_PREVIEW_SCRIPT }, async ({ browser, baseUrl }) => {
    url = baseUrl;
    await check(browser, 1440);
    await check(browser, 390);
    await checkKorean(browser);
  });
}
