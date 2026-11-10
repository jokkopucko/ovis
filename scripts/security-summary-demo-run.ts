import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices, type Browser, type BrowserContext, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsFolds } from "./settings-page.ts";
import { DEMO_FILE_PREVIEW_SCRIPT } from "./demo-file-preview.ts";
import { KO } from "../src/lib/i18n.ko.ts";

/**
 * The access facts on Settings → Phone & devices, over the demo's fictional answers
 * (site/demo/transport.ts, `?demo_security=`): each fact on its own labelled line, no control to
 * change any of them, public reachability unknown unless the request proved it, an older server
 * and a failed check shown as such rather than filled in, and the open-LAN warning exactly as
 * before. No herdr session is opened; the app is served on loopback from a temporary directory.
 *
 * The capture parts write the capture matrix into UI_EVIDENCE_DIR
 * (`security-summary-<390|1440>-<light|dark>[-ko]-<state>.png`) and the measurements behind it.
 */
const app = mkdtempSync(join(tmpdir(), "herdr-security-summary-demo-"));
const evidence = process.env["UI_EVIDENCE_DIR"] || "";
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
    // nothing sticks out of its card, and the page does not scroll sideways
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

/**
 * Holds the demo's opening turn (site/demo/transport.ts ends it on its one 4500 ms timer) for the
 * whole page: every check and capture sees the same mid-turn demo, however fast this machine is.
 */
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

/** demo answers whose pairing gate is closed, so devices have been paired: the list beside the facts is a real one */
const PAIRED = ["known", "watch", "funnel", "tailnet", "gated", "older", "error", "loading"];

/**
 * The demo pairs no devices (its /api/devices is a 404 by design, scripts/conventions.test.ts), so
 * for the variants above this answers GET /api/devices with two fictional ones, in front of the
 * demo's own fetch: Access is then seen beside a populated Devices list, as on a real server.
 */
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

/** Opens Phone & devices at its Access group for one demo answer, once that answer has been drawn. */
async function open(context: BrowserContext, variant: string, settings = true, label: (name: string) => string = (name) => name): Promise<Page> {
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(`${variant}: ${error.message}`));
  // the page, not `&section=`: a linked group is focused, and its ring would sit in every capture
  await page.goto(`${url}?demo_security=${variant}${settings ? "&settings=devices" : ""}`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  assert.equal(await page.evaluate(() => (window as unknown as { heldOpeningTurn: boolean }).heldOpeningTurn), true, `${variant}: the demo's opening turn is held`);
  if (!settings) return page;
  // the Access facts sit in the page's More settings fold
  await page.locator(".settings-body:not([hidden])").waitFor();
  await openSettingsFolds(page);
  await page.locator(SECTION).waitFor();
  await page.locator(SECTION).scrollIntoViewIfNeeded();
  if (variant in STATUS) await page.locator(`${SECTION} [role='status']`, { hasText: label(STATUS[variant]!) }).waitFor();
  else await page.locator(`${SECTION} .settings-fact`).nth(4).waitFor();
  // the Devices group beside it has its list: the two fictional devices, or none where nothing is paired
  if (PAIRED.includes(variant)) await page.locator(".settings-body:not([hidden]) .devices-row").nth(1).waitFor();
  else await page.locator(".settings-body:not([hidden]) .devices-panel").getByText(label("No devices paired yet.")).waitFor();
  return page;
}

/** errors any page raised; every run ends by asserting there were none */
const pageErrors: string[] = [];
const verdicts = /\b(safe|secure|protected|local only)\b/i;

async function check(browser: Browser, width: 390 | 1440): Promise<void> {
  const context = await browser.newContext(width === 390 ? { ...devices["iPhone 14"] } : { viewport: { width: 1440, height: 900 } });
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
    // a failed check replaces the facts it last showed, and the next answer brings them back
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
    // an earlier check that answers after a newer one failed never brings its facts back: hold a
    // successful read, let the next one fail, then release the first
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
        // once its body is read, the held read handles it and goes straight on to the full health, in
        // the same run of microtasks: no poll can come between, so this request is that read's own
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
    // the released answer has been handled; let React commit whatever it was told before looking
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

/** Every capture state of the todo's matrix, with the demo answer behind it. */
const STATES: Array<{ state: string; variant: string; desktopOnly?: boolean; settings?: boolean }> = [
  { state: "rest", variant: "known" },
  { state: "focus", variant: "known" },
  { state: "hover", variant: "known", desktopOnly: true },
  { state: "watch", variant: "watch" },
  { state: "older", variant: "older" },
  { state: "loading", variant: "loading" },
  { state: "error", variant: "error" },
  { state: "long", variant: "unavailable" },
  { state: "proxy", variant: "proxy" },
  { state: "funnel", variant: "funnel" },
  { state: "tailnet", variant: "tailnet" },
  { state: "unknown", variant: "unknown" },
  { state: "lan", variant: "unknown", settings: false },
  { state: "offline", variant: "known" },
  { state: "end", variant: "known" },
];

type Captured = { file: string; width: number; height: number; theme: string; language: string; state: string; variant: string; sha256: string; capturedAt: string };

/** contrast of each text against what is drawn behind it, and the sizes a PNG cannot show */
async function measure(page: Page): Promise<unknown> {
  return await page.evaluate((section) => {
    const rgb = (value: string): number[] => (value.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]): number => { const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!); };
    const behind = (node: Element): string => { for (let at: Element | null = node; at; at = at.parentElement) { const bg = getComputedStyle(at).backgroundColor; const parts = rgb(bg); if (parts.length >= 3 && (parts.length < 4 || parts[3]! > 0.99)) return bg; } return "rgb(255, 255, 255)"; };
    const ratio = (node: Element): number => { const a = lum(rgb(getComputedStyle(node).color)); const b = lum(rgb(behind(node))); return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100; };
    const root = document.querySelector(section);
    const texts = root ? [...root.querySelectorAll(".settings-label, .settings-fact, .settings-description, h3")].map((node) => ({
      class: node.className, text: node.textContent?.trim().slice(0, 40), fontSize: getComputedStyle(node).fontSize, contrast: ratio(node), userSelect: getComputedStyle(node).userSelect,
    })) : [];
    // the actions around the facts: the Devices group's buttons and the page's own navigation
    const actions = [...document.querySelectorAll<HTMLElement>(".settings-body:not([hidden]) [data-section='devices'] button, .settings-dialog .modal-header button")]
      .filter((node) => node.getBoundingClientRect().width > 0)
      .map((node) => { const box = node.getBoundingClientRect(); return { name: node.getAttribute("aria-label") ?? node.textContent?.trim().slice(0, 30), width: Math.round(box.width), height: Math.round(box.height) }; });
    const active = document.activeElement as HTMLElement | null;
    const focus = active && active !== document.body ? { name: active.getAttribute("aria-label") ?? active.textContent?.trim().slice(0, 30), focusVisible: active.matches(":focus-visible"), outline: getComputedStyle(active).outlineStyle + " " + getComputedStyle(active).outlineWidth, boxShadow: getComputedStyle(active).boxShadow } : null;
    const pointed = [...document.querySelectorAll<HTMLElement>(":hover")].at(-1)?.closest<HTMLElement>("button, a, summary") ?? null;
    const hover = pointed && pointed !== document.documentElement ? { name: pointed.getAttribute("aria-label") ?? pointed.textContent?.trim().slice(0, 30), background: getComputedStyle(pointed).backgroundColor } : null;
    return { texts, actions, focus, hover };
  }, SECTION);
}

async function capture(browser: Browser, themes: ReadonlyArray<"light" | "dark">): Promise<void> {
  const shots: Captured[] = [];
  const measurements: Record<string, unknown> = {};
  for (const width of [390, 1440] as const) {
    for (const theme of themes) {
      for (const language of width === 390 ? ["en", "ko"] as const : ["en"] as const) {
        const label = (name: string) => language === "ko" ? KO[name] ?? name : name;
        const context = await browser.newContext(width === 390 ? { ...devices["iPhone 14"], locale: language } : { viewport: { width: 1440, height: 900 }, locale: language });
        try {
          await holdOpeningTurn(context);
          await pairedDevices(context);
          await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ language, theme }));
          for (const { state, variant, desktopOnly, settings } of STATES) {
            if (desktopOnly && width !== 1440) continue;
            const page = await open(context, variant, settings ?? true, label);
            if (settings === false) await page.locator(LAN).waitFor();
            if (state === "focus" || state === "hover") {
              // the neighbouring control before the facts: keyboard focus from the group, or the pointer
              await page.locator(SECTION).focus();
              await page.keyboard.press("Shift+Tab");
              const neighbour = page.locator(":focus");
              await neighbour.scrollIntoViewIfNeeded();
              if (state === "focus") await page.waitForFunction(() => document.activeElement?.matches(":focus-visible") === true);
              else {
                // a read-only fact has no hover of its own: the pointer rests on the page list beside it
                await neighbour.evaluate((node) => (node as HTMLElement).blur());
                await page.getByRole("tab", { name: "Devices and PCs", exact: true }).hover();
              }
            }
            if (state === "offline") {
              await page.evaluate(() => { sessionStorage.setItem("ovis:demo-security", "error"); document.dispatchEvent(new Event("visibilitychange")); });
              await page.locator(`${SECTION} [role='status']`, { hasText: label(STATUS["error"]!) }).waitFor();
            }
            if (state === "end") await page.locator(".settings-body:not([hidden])").evaluate((body) => { body.scrollTop = body.scrollHeight; });
            else if (settings !== false && state !== "focus" && state !== "hover") await page.locator(SECTION).scrollIntoViewIfNeeded();
            // the dialog puts focus on its first control; only the focus state keeps a ring
            if (state !== "focus") await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
            await page.evaluate(() => document.fonts.ready);
            const name = `security-summary-${width}-${theme}${language === "ko" ? "-ko" : ""}-${state}.png`;
            const png = await page.screenshot({ path: join(evidence, name), animations: "disabled" });
            const viewport = page.viewportSize()!;
            shots.push({ file: name, width: viewport.width, height: viewport.height, theme, language, state, variant, sha256: createHash("sha256").update(png).digest("hex"), capturedAt: new Date().toISOString() });
            if (settings !== false) measurements[name] = await measure(page);
            await page.close();
          }
        } finally {
          await context.close();
        }
      }
    }
  }
  assert.deepEqual(pageErrors, [], "no page raised an error");
  // the serial lane hands every script the same evidence folder: each capture part's two files have names of their own there
  writeFileSync(join(evidence, `security-summary-captures-${themes.join("-")}.json`), JSON.stringify(shots, null, 1));
  writeFileSync(join(evidence, `security-summary-measurements-${themes.join("-")}.json`), JSON.stringify(measurements, null, 1));
  console.log(`captured ${shots.length} screenshots into ${evidence}`);
}

export type SecuritySummaryPart = "checks" | "captures-light" | "captures-dark";

let url = "";
/**
 * Runs one part of this check. Each part is a browser script of its own, so that the browser
 * lane's workers share the check instead of one of them running all of it: the checks at both
 * widths (security-summary-demo-regression.ts), and the capture matrix, one theme to a script
 * (security-summary-captures-<light|dark>-demo-regression.ts).
 */
export async function runSecuritySummary(part: SecuritySummaryPart): Promise<void> { try {
  // a capture part makes nothing but the capture matrix: with no folder to write it into, it has nothing to run
  if (part !== "checks" && !evidence) { console.log(`SKIP ${part} of the security summary: UI_EVIDENCE_DIR is not set, and this part only writes its captures there`); return; }
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>${DEMO_FILE_PREVIEW_SCRIPT}\n    <script type="module"`));
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
  url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      if (part === "checks") {
        await check(browser, 1440);
        await check(browser, 390);
      } else { mkdirSync(evidence, { recursive: true }); await capture(browser, [part === "captures-light" ? "light" : "dark"]); }
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
} }
