/**
 * Two builds, each served with the app's own Content-Security-Policy (server/static.ts): the
 * production build at the root, and the demo's relative build under /herdr-web-ui/demo/app/.
 * No herdr session and no user state: loopback servers on port 0 and temporary directories, all
 * removed at the end.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices, type Browser, type BrowserContextOptions, type Page, type Response } from "playwright-core";
import { CONTENT_SECURITY_POLICY } from "../server/static.ts";
import { loadSettings, resolveTheme } from "../src/lib/settings.ts";
import { themeFor } from "../src/lib/themeFor.ts";
import { rowFor, type ThemeEntry } from "../src/lib/themes.ts";
import { isReportableWindowError } from "../src/lib/uncaughtErrors.ts";
import { chromePath } from "./chrome-path.ts";
import { unlessGone } from "./response-gone.ts";
import { buildDemoApp } from "./demo-build.ts";

const repo = join(import.meta.dir, "..");
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
const SETTINGS_KEY = "ovis:settings";
const THEMES_KEY = "ovis:themes";
const DEMO_PREFIX = "/herdr-web-ui/demo/app/";

type Stored = string | object | null;
interface Case {
  name: string;
  main: Stored;
  themes: Stored;
  scheme: "dark" | "light";
  blocked?: boolean;
  cssFails?: boolean;
  expected: [id: string, mode: "dark" | "light"];
  headline?: string;
  widths?: readonly ("390" | "1440")[];
  korean?: boolean;
}

const CASES: Case[] = [
  { name: "saved Black", main: { theme: "dark", darkTheme: "black" }, themes: null, scheme: "light", expected: ["black", "dark"], headline: "black" },
  { name: "Black on the light side", main: { theme: "light", lightTheme: "black" }, themes: null, scheme: "light", expected: ["black", "dark"] },
  { name: "saved light", main: { theme: "light", darkTheme: "codex", lightTheme: "codex" }, themes: { darkTheme: "codex", lightTheme: "codex" }, scheme: "dark", expected: ["codex", "light"], headline: "light" },
  { name: "saved dark", main: { theme: "dark", darkTheme: "nord", lightTheme: "codex" }, themes: { darkTheme: "nord", lightTheme: "codex" }, scheme: "light", expected: ["nord", "dark"], headline: "dark" },
  { name: "saved light, Korean", main: { language: "ko", theme: "light", darkTheme: "codex", lightTheme: "codex" }, themes: { darkTheme: "codex", lightTheme: "codex" }, scheme: "dark", korean: true, expected: ["codex", "light"], headline: "light-ko", widths: ["390"] },
  { name: "saved dark, Korean", main: { language: "ko", theme: "dark", darkTheme: "nord", lightTheme: "codex" }, themes: { darkTheme: "nord", lightTheme: "codex" }, scheme: "light", korean: true, expected: ["nord", "dark"], headline: "dark-ko", widths: ["390"] },
  { name: "Dracula on the light side", main: { theme: "light", lightTheme: "dracula" }, themes: null, scheme: "light", expected: ["dracula", "dark"], headline: "single-mode" },
  { name: "system dark", main: { theme: "system", darkTheme: "tokyo-night", lightTheme: "tokyo-night-day" }, themes: null, scheme: "dark", expected: ["tokyo-night", "dark"] },
  { name: "system light", main: { theme: "system", darkTheme: "tokyo-night", lightTheme: "tokyo-night-day" }, themes: null, scheme: "light", expected: ["tokyo-night-day", "light"], headline: "system" },
  { name: "nothing saved, light system", main: null, themes: null, scheme: "light", expected: ["codex", "light"] },
  { name: "nothing saved, dark system", main: null, themes: null, scheme: "dark", expected: ["codex", "dark"] },
  { name: "corrupt main record, protected themes, light system", main: "{not json", themes: { darkTheme: "gruvbox", lightTheme: "gruvbox-light" }, scheme: "light", expected: ["gruvbox-light", "light"] },
  { name: "corrupt main record, protected themes, dark system", main: "{not json", themes: { darkTheme: "gruvbox", lightTheme: "gruvbox-light" }, scheme: "dark", expected: ["gruvbox", "dark"] },
  { name: "corrupt protected record", main: { theme: "light", lightTheme: "one-light" }, themes: "{not json", scheme: "dark", expected: ["one-light", "light"] },
  { name: "both records corrupt, light system", main: "[", themes: "{", scheme: "light", expected: ["codex", "light"] },
  { name: "both records corrupt, dark system", main: "[", themes: "{", scheme: "dark", expected: ["codex", "dark"] },
  { name: "protected sides win", main: { theme: "light", darkTheme: "codex", lightTheme: "codex" }, themes: { darkTheme: "nord", lightTheme: "solarized-light" }, scheme: "dark", expected: ["solarized-light", "light"] },
  { name: "old palette record", main: { theme: "light", palette: "catppuccin" }, themes: null, scheme: "dark", expected: ["catppuccin", "light"] },
  { name: "old System pair", main: { theme: "system", palette: "amber", paletteLight: "catppuccin", paletteDark: "charcoal" }, themes: null, scheme: "light", expected: ["catppuccin", "light"] },
  { name: "unknown theme id", main: { theme: "light", darkTheme: "nope", lightTheme: "nope" }, themes: null, scheme: "dark", expected: ["codex", "light"] },
  { name: "storage blocked, light system", main: { theme: "dark", darkTheme: "nord" }, themes: null, scheme: "light", blocked: true, expected: ["codex", "light"] },
  { name: "storage blocked, dark system", main: { theme: "light", lightTheme: "one-light" }, themes: null, scheme: "dark", blocked: true, expected: ["codex", "dark"] },
  { name: "stylesheet fails, saved light", main: { theme: "light", lightTheme: "rose-pine-dawn" }, themes: null, scheme: "dark", cssFails: true, expected: ["rose-pine-dawn", "light"], headline: "light-error" },
  { name: "stylesheet fails, saved dark", main: { theme: "dark", darkTheme: "kanagawa" }, themes: null, scheme: "light", cssFails: true, expected: ["kanagawa", "dark"], headline: "dark-error" },
];

const VIEWPORTS = {
  "390": { ...devices["iPhone 14"], colorScheme: undefined } as BrowserContextOptions,
  "1440": { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } as BrowserContextOptions,
};

function appRow(item: Case): ThemeEntry {
  const records = new Map<string, string>();
  if (item.main !== null) records.set(SETTINGS_KEY, typeof item.main === "string" ? item.main : JSON.stringify(item.main));
  if (item.themes !== null) records.set(THEMES_KEY, typeof item.themes === "string" ? item.themes : JSON.stringify(item.themes));
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    get localStorage() {
      if (item.blocked) throw new Error("SecurityError");
      return { getItem: (key: string) => records.get(key) ?? null };
    },
    matchMedia: () => ({ matches: item.scheme === "dark" }),
  } });
  try {
    const settings = loadSettings();
    return themeFor(settings, resolveTheme(settings.theme));
  } finally {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

function rgb(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  assert.ok(match, `not a #rrggbb surface: ${hex}`);
  return [parseInt(match[1]!, 16), parseInt(match[2]!, 16), parseInt(match[3]!, 16)];
}
const near = (a: readonly number[], b: readonly number[]): boolean => a.every((value, index) => Math.abs(value - b[index]!) <= 2);

function pageSetup({ main, themes, blocked, keys }: { main: Stored; themes: Stored; blocked: boolean; keys: [string, string] }): void {
  const [settingsKey, themesKey] = keys;
  const seen = { violations: [] as string[], errors: [] as { thrown: boolean; message: string }[], values: [] as string[], cssAt: -1, bootAt: -1, appAt: -1, bootBackground: "",
    parsedAt: -1, bootBeforeParse: false };
  (window as unknown as { __boot: typeof seen }).__boot = seen;
  if (blocked) {
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("The operation is insecure.", "SecurityError"); } });
  } else {
    localStorage.clear();
    if (main !== null) localStorage.setItem(settingsKey, typeof main === "string" ? main : JSON.stringify(main));
    if (themes !== null) localStorage.setItem(themesKey, typeof themes === "string" ? themes : JSON.stringify(themes));
  }
  document.addEventListener("securitypolicyviolation", (event) => seen.violations.push(`${event.violatedDirective} ${event.blockedURI}`));
  window.addEventListener("error", (event) => seen.errors.push({ thrown: event.error != null, message: String(event.message) }));
  const signal = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve = (): void => undefined;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  };
  const boot = signal(), css = signal(), app = signal(), parsed = signal();
  Object.assign(window, { __bootApplied: boot.promise, __cssLoaded: css.promise, __appApplied: app.promise, __parsed: parsed.promise });
  const record = (records: MutationRecord[]): void => {
    for (const change of records) {
      const root = change.target as HTMLElement;
      if (change.attributeName === "data-density") {
        if (seen.appAt < 0) { seen.appAt = performance.now(); app.resolve(); }
        continue;
      }
      seen.values.push(`${change.attributeName}=${root.getAttribute(change.attributeName ?? "")}`);
      if (change.attributeName === "data-palette" && seen.bootAt < 0) { seen.bootAt = performance.now(); seen.bootBackground = root.style.backgroundColor; boot.resolve(); }
    }
  };
  const observer = new MutationObserver(record);
  observer.observe(document, { subtree: true, attributes: true, attributeFilter: ["data-theme", "data-palette", "data-density"] });
  // the parser's end, which held modules and a held stylesheet do not delay: latches whether the boot
  // script had set the theme by then (its pending records taken first), so the order is the page's own
  // and not when a check happens to ask
  document.addEventListener("readystatechange", () => {
    if (seen.parsedAt >= 0) return;
    record(observer.takeRecords());
    seen.parsedAt = performance.now();
    seen.bootBeforeParse = seen.bootAt >= 0;
    parsed.resolve();
  });
  for (const type of ["load", "error"]) {
    document.addEventListener(type, (event) => {
      const link = event.target as HTMLLinkElement;
      if (link.tagName === "LINK" && link.rel === "stylesheet" && seen.cssAt < 0) { seen.cssAt = performance.now(); css.resolve(); }
    }, true);
  }
}

interface Frame { phase: string; center: number[]; corner: number[]; luminance: number; ok: boolean; png?: string }
interface BootOrder { bootAt: number; parsedAt: number; booted: boolean }
interface Run { case: string; base: string; width: string; expected: { id: string; mode: string; bg: string }; frames: Frame[]; firstVisible: Frame | null; preCss: Record<string, string | null>;
  bootOrder: { atCommit: BootOrder; afterApp: BootOrder }; lang: string; locale: string;
  boot: Record<string, unknown> | null; documentCsp: string | null; violations: string[]; errors: string[]; values: string[]; finalBackground: string; failures: string[] }

function bootOrder(page: Page): Promise<BootOrder> {
  return page.evaluate(async () => {
    const signals = window as unknown as { __bootApplied: Promise<void>; __parsed: Promise<void>; __boot: { bootAt: number; parsedAt: number; bootBeforeParse: boolean } };
    await Promise.race([signals.__bootApplied, signals.__parsed]);
    const { bootAt, parsedAt, bootBeforeParse } = signals.__boot;
    return { bootAt, parsedAt, booted: bootAt >= 0 && (parsedAt < 0 || bootBeforeParse) };
  });
}

const builds = mkdtempSync(join(tmpdir(), "herdr-theme-first-paint-"));
const demoDir = join(builds, "demo");
const rootDir = join(builds, "root");
const servers: ReturnType<typeof Bun.serve>[] = [];
let browser: Browser | null = null;
const runs: Run[] = [];
const warm: Record<string, unknown>[] = [];
let failed = false;

function serve(dir: string, prefix: string): string {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const csp = { "content-security-policy": CONTENT_SECURITY_POLICY };
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/") || path === "/ws") return Response.json({ error: "no server in this check" }, { status: 503, headers: csp });
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404, headers: csp });
    let file = decodeURIComponent(path.slice(prefix.length));
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400, headers: csp });
    const body = Bun.file(join(dir, file));
    if (!(await body.exists())) return new Response("not found", { status: 404, headers: csp });
    return new Response(body, { headers: { ...csp, "content-type": body.type, "cache-control": file.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache" } });
  } });
  servers.push(server);
  return `http://127.0.0.1:${server.port}${prefix}`;
}

async function sample(decoder: Page, png: string): Promise<{ center: number[]; corner: number[]; luminance: number }> {
  return decoder.evaluate(async (data) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const at = (x: number, y: number): number[] => { const i = (y * bitmap.width + x) * 4; return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!]; };
    let sum = 0, count = 0;
    for (let y = 0; y < bitmap.height; y += Math.max(1, Math.floor(bitmap.height / 32))) {
      for (let x = 0; x < bitmap.width; x += Math.max(1, Math.floor(bitmap.width / 32))) {
        const [r, g, b] = at(x, y);
        sum += (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255;
        count++;
      }
    }
    return { center: at(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2)), corner: at(bitmap.width - 4, bitmap.height - 4), luminance: sum / count };
  }, png);
}

function nextFrame(frames: { count: number; waiters: (() => void)[] }, what: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no frame was painted after ${what}`)), 15_000);
    frames.waiters.push(() => { clearTimeout(timer); resolve(); });
  });
}

async function runCase(item: Case, base: "root" | "demo", url: string, width: "390" | "1440", decoder: Page): Promise<Run> {
  const row = appRow(item);
  const [id, mode] = item.expected;
  const failures: string[] = [];
  if (row !== rowFor(id, mode) || row.id !== id || row.mode !== mode) failures.push(`loadSettings draws ${row.id}/${row.mode}, the case expects ${id}/${mode}`);
  const locale = item.korean ? "ko-KR" : "en-US";
  const context = await browser!.newContext({ ...VIEWPORTS[width], colorScheme: item.scheme, locale, serviceWorkers: "block" });
  try {
    await context.addInitScript(pageSetup, { main: item.main, themes: item.themes, blocked: item.blocked ?? false, keys: [SETTINGS_KEY, THEMES_KEY] as [string, string] });
    const page = await context.newPage();
    const origin = new URL(url).origin;
    let boot: Record<string, unknown> | null = null;
    let documentCsp: string | null = null;
    page.on("response", async (response) => {
      const address = new URL(response.url());
      if (response.request().isNavigationRequest()) {
        const headers = await unlessGone(response, (answer) => answer.allHeaders());
        if (headers) documentCsp = headers["content-security-policy"] ?? null;
      }
      if (!/\/assets\/theme-bootstrap-[0-9a-f]{10}\.js$/.test(address.pathname)) return;
      const body = await unlessGone(response, (answer) => answer.body());
      if (body === undefined) return;
      boot = { url: response.url(), sameOrigin: address.origin === origin, status: response.status(), contentType: response.headers()["content-type"],
        resourceType: response.request().resourceType(), fromServiceWorker: response.fromServiceWorker(), bytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"), csp: response.headers()["content-security-policy"] ?? null };
    });
    const bootFailures: string[] = [];
    page.on("requestfailed", (request) => { if (request.url().includes("theme-bootstrap")) bootFailures.push(`${request.url()} ${request.failure()?.errorText}`); });
    let openCss = (): void => undefined, openApp = (): void => undefined;
    const cssGate = new Promise<void>((resolve) => { openCss = resolve; });
    const appGate = new Promise<void>((resolve) => { openApp = resolve; });
    await page.route((address) => /\/assets\/index-[\w-]+\.css$/.test(address.pathname), async (route) => { await cssGate; await (item.cssFails ? route.abort("failed") : route.continue()); });
    await page.route((address) => /\/assets\/index-[\w-]+\.js$/.test(address.pathname), async (route) => { await appGate; await route.continue(); });

    const cdp = await context.newCDPSession(page);
    const raw: { phase: string; png: string }[] = [];
    let phase = "before the stylesheet";
    const frames = { count: 0, waiters: [] as (() => void)[] };
    cdp.on("Page.screencastFrame", (frame) => {
      raw.push({ phase, png: frame.data });
      frames.count++;
      for (const waiter of frames.waiters.splice(0)) waiter();
      cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
    });
    await page.goto(url, { waitUntil: "commit" });
    // the boot script has run (a classic script the parser waits for), the stylesheet is still held;
    // a page without one sets nothing until the app runs, which is held: that is a failure, and the
    // frames are still recorded to show what it painted instead
    const atCommit = await bootOrder(page);
    if (!atCommit.booted) failures.push("nothing set the theme before the stylesheet: the page was parsed without it");
    await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    const preCss = await page.evaluate(() => ({ theme: document.documentElement.dataset["theme"] ?? null, palette: document.documentElement.dataset["palette"] ?? null,
      background: document.documentElement.style.backgroundColor, colorScheme: document.documentElement.style.colorScheme,
      meta: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null }));
    const bg = rgb(row.bg);
    if (preCss.theme !== mode || preCss.palette !== id) failures.push(`before the stylesheet the root holds ${preCss.theme}/${preCss.palette}`);
    if (preCss.colorScheme !== mode) failures.push(`before the stylesheet color-scheme is ${preCss.colorScheme || "unset"}`);
    if (preCss.background !== `rgb(${bg.join(", ")})`) failures.push(`before the stylesheet the root background is ${preCss.background || "unset"}, expected ${row.bg}`);
    if (preCss.meta !== row.bgPanel) failures.push(`theme-color ${preCss.meta}, expected ${row.bgPanel}`);
    const styled = nextFrame(frames, "the stylesheet");
    phase = item.cssFails ? "before the stylesheet" : "first styled shell";
    openCss();
    await page.evaluate(() => (window as unknown as { __cssLoaded: Promise<void> }).__cssLoaded);
    await styled;
    phase = "first app frame";
    const appFrame = nextFrame(frames, "the app started");
    openApp();
    await page.evaluate(() => (window as unknown as { __appApplied: Promise<void> }).__appApplied);
    await appFrame;
    await cdp.send("Page.stopScreencast");
    cdp.removeAllListeners("Page.screencastFrame");
    await cdp.detach();
    const afterApp = await bootOrder(page);
    if (afterApp.booted !== atCommit.booted || afterApp.bootAt !== atCommit.bootAt) failures.push(`the boot order read late (${JSON.stringify(afterApp)}) differs from the one read at commit (${JSON.stringify(atCommit)})`);
    const lang = await page.evaluate(() => document.documentElement.lang);
    const pageLocale = await page.evaluate(() => navigator.language);
    if (pageLocale !== locale) failures.push(`the page ran in ${pageLocale}, the case seeds ${locale}`);

    const recorded = await page.evaluate(() => (window as unknown as { __boot: { violations: string[]; errors: { thrown: boolean; message: string }[]; values: string[] } }).__boot);
    // the errors main.tsx itself reports: not the browser's benign ResizeObserver notice
    const seen = { ...recorded, errors: recorded.errors.filter((error) => isReportableWindowError(error.thrown ? true : null, error.message)).map((error) => error.message) };
    const finalBackground = await page.evaluate((failed) => getComputedStyle(failed ? document.documentElement : document.body).backgroundColor, item.cssFails ?? false);
    const rootInline = await page.evaluate(() => document.documentElement.style.backgroundColor);
    if (item.cssFails && rootInline !== `rgb(${bg.join(", ")})`) failures.push(`with no stylesheet the app left the root background at ${rootInline || "unset"}, expected ${row.bg}`);
    if (!item.cssFails && rootInline !== "") failures.push("the app left the boot background on the root");
    if (finalBackground !== `rgb(${bg.join(", ")})`) failures.push(`the page's background settled at ${finalBackground}, expected ${row.bg}`);
    const wrongValues = seen.values.filter((value) => value !== `data-theme=${mode}` && value !== `data-palette=${id}`);
    if (wrongValues.length) failures.push(`the root took other values: ${wrongValues.join(", ")}`);
    if (seen.violations.length) failures.push(`CSP violations: ${seen.violations.join("; ")}`);
    if (seen.errors.length) failures.push(`page errors: ${seen.errors.join("; ")}`);
    if (bootFailures.length) failures.push(`boot request failed: ${bootFailures.join("; ")}`);
    const bootResponse = boot as Record<string, unknown> | null;
    if (!bootResponse) failures.push("no boot script response");
    else if (!bootResponse["sameOrigin"] || bootResponse["status"] !== 200 || bootResponse["resourceType"] !== "script" || !String(bootResponse["contentType"]).includes("javascript")) failures.push(`boot response ${JSON.stringify(bootResponse)}`);
    if (documentCsp !== CONTENT_SECURITY_POLICY) failures.push(`the page was served with ${documentCsp}`);

    const sampled: Frame[] = [];
    for (const frame of raw) {
      const { center, corner, luminance } = await sample(decoder, frame.png);
      const beforeApp = frame.phase === "before the stylesheet" || frame.phase === "first styled shell";
      const ok = beforeApp ? near(center, bg) : item.cssFails ? near(corner, bg) : (mode === "dark" ? luminance < 0.5 : luminance > 0.5);
      sampled.push({ phase: frame.phase, center, corner, luminance: Math.round(luminance * 1000) / 1000, ok, png: frame.png });
    }
    if (!sampled.some((frame) => frame.phase === (item.cssFails ? "before the stylesheet" : "first styled shell"))) failures.push("no frame of the shell before the app");
    if (!sampled.some((frame) => frame.phase === "first app frame")) failures.push("no frame of the app");
    for (const frame of sampled) if (!frame.ok) failures.push(`a frame in "${frame.phase}" shows center ${frame.center.join(",")} corner ${frame.corner.join(",")} luminance ${frame.luminance}, not ${row.bg} in ${mode}`);
    if (evidence && item.headline) {
      const dir = join(evidence, "frames");
      mkdirSync(dir, { recursive: true });
      for (const label of ["before the stylesheet", "first styled shell", "first app frame"]) {
        const frame = sampled.find((candidate) => candidate.phase === label);
        if (frame?.png) writeFileSync(join(dir, `theme-boot-${base}-${width}-${item.headline}-${label.replaceAll(" ", "-")}.png`), Buffer.from(frame.png, "base64"));
      }
    }
    return { case: item.name, base, width, expected: { id, mode, bg: row.bg }, frames: sampled.map(({ png: _png, ...frame }) => frame),
      firstVisible: sampled[0] ? { ...sampled[0], png: undefined } : null, preCss, bootOrder: { atCommit, afterApp }, lang, locale: pageLocale, boot: bootResponse, documentCsp, violations: seen.violations,
      errors: seen.errors, values: [...new Set(seen.values)], finalBackground, failures };
  } finally {
    await context.close();
  }
}

function controlled(page: Page): Promise<"already controlled" | "controllerchange"> {
  return page.evaluate((limit) => new Promise<"already controlled" | "controllerchange">((resolve, reject) => {
    const worker = navigator.serviceWorker;
    const done = (how: "already controlled" | "controllerchange"): void => {
      clearTimeout(timer);
      worker.removeEventListener("controllerchange", changed);
      resolve(how);
    };
    const changed = (): void => done("controllerchange");
    const timer = setTimeout(() => {
      worker.removeEventListener("controllerchange", changed);
      reject(new Error(`no service worker controlled the page within ${limit} ms`));
    }, limit);
    worker.addEventListener("controllerchange", changed);
    if (worker.controller !== null) done("already controlled");
  }), 30_000);
}

function workerCache(worker: string): string | null {
  const name = /^const CACHE_NAME = "([^"]+)";$/m.exec(worker)?.[1];
  const build = /^const BUILD = "([^"]*)";$/m.exec(worker)?.[1];
  if (!name || build === undefined) return null;
  return build ? `${name}-${build}` : name;
}

/**
 * The root build loaded again from its installed service worker. Its answers are this build's boot
 * script, and the worker's own cache holds this shell and the script's exact bytes. Then a load with
 * the HTTP cache emptied and the network cut, proven cut for the worker too, still gets the script
 * from the worker and sets the theme. fromServiceWorker() alone cannot prove the worker's cache: it
 * is also true when a cache-first answer missed and the worker passed the request on.
 */
async function warmServiceWorker(url: string): Promise<Record<string, unknown>> {
  const item = CASES[0]!;
  const row = appRow(item);
  const context = await browser!.newContext({ ...VIEWPORTS["1440"], colorScheme: item.scheme, serviceWorkers: "allow" });
  try {
    await context.addInitScript(pageSetup, { main: item.main, themes: item.themes, blocked: false, keys: [SETTINGS_KEY, THEMES_KEY] as [string, string] });
    const page = await context.newPage();
    await page.goto(url);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    const firstControl = await controlled(page);
    const answered = async (response: Response): Promise<{ url: string; fromServiceWorker: boolean; status: number; sha256: string }> => ({ url: response.url(), fromServiceWorker: response.fromServiceWorker(),
      status: response.status(), sha256: createHash("sha256").update(await response.body()).digest("hex") });
    const kept = page.waitForResponse((response) => /\/assets\/theme-bootstrap-/.test(response.url()));
    await page.reload({ waitUntil: "commit" });
    const first = await answered(await kept);
    await page.evaluate(() => (window as unknown as { __appApplied: Promise<void> }).__appApplied);
    const again = page.waitForResponse((response) => /\/assets\/theme-bootstrap-/.test(response.url()));
    await page.reload({ waitUntil: "commit" });
    const second = await answered(await again);
    await page.evaluate(() => (window as unknown as { __appApplied: Promise<void> }).__appApplied);
    const reloadedControl = await controlled(page);
    const seen = await page.evaluate(() => (window as unknown as { __boot: { values: string[]; violations: string[] } }).__boot);
    const html = readFileSync(join(rootDir, "index.html"), "utf8");
    const file = /<script src="\/(assets\/theme-bootstrap-[0-9a-f]{10}\.js)"><\/script>/.exec(html)?.[1];
    const onDisk = file ? createHash("sha256").update(readFileSync(join(rootDir, file))).digest("hex") : null;
    const worker = readFileSync(join(rootDir, "sw.js"), "utf8");
    const cacheName = workerCache(worker);
    // what the worker's cache holds: keepShell runs after the page has its answer (waitUntil), so
    // read until the shell is in, bounded; with "/" kept, every file the shell starts with is too
    const inCache = (): Promise<{ shell: boolean; sha256: string | null }> => page.evaluate(async ({ name, path }) => {
      if (!name || !path || !(await caches.has(name))) return { shell: false, sha256: null };
      const cache = await caches.open(name);
      const shell = (await cache.match("/")) !== undefined;
      const copy = await cache.match(path);
      if (!copy) return { shell, sha256: null };
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await copy.arrayBuffer()));
      return { shell, sha256: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
    }, { name: cacheName, path: file ? `/${file}` : null });
    let cached = await inCache();
    const cacheDeadline = Date.now() + 30_000;
    while (!(cached.shell && cached.sha256) && Date.now() < cacheDeadline) {
      await Bun.sleep(25);
      cached = await inCache();
    }
    // the browser's HTTP cache emptied (the server marks /assets/ immutable, and a worker's fetch()
    // that missed its own cache would be answered from there even offline), then the network cut,
    // for the worker too: a file no cache holds, asked for through it, cannot be fetched
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.clearBrowserCache");
    await cdp.detach();
    await context.setOffline(true);
    const probe = await page.evaluate(async (path) => {
      try {
        const response = await fetch(path, { cache: "no-store" });
        return `answered ${response.status}`;
      } catch (error) {
        return error instanceof TypeError ? "failed" : String(error);
      }
    }, `/assets/offline-probe-${Date.now()}.js`);
    const bootUrl = (address: string): boolean => /\/assets\/theme-bootstrap-/.test(address);
    const cutAnswer = page.waitForResponse((response) => bootUrl(response.url())).then(answered);
    const cutFailure = page.waitForEvent("requestfailed", (request) => bootUrl(request.url()))
      .then((request) => ({ url: request.url(), fromServiceWorker: false, status: 0, sha256: `failed: ${request.failure()?.errorText ?? "unknown"}` }));
    cutAnswer.catch(() => undefined);
    cutFailure.catch(() => undefined);
    await page.reload({ waitUntil: "commit" });
    const offline = await Promise.race([cutAnswer, cutFailure]);
    // the theme set before the parser ended, which only the classic boot script can do (modules wait for it)
    const offlineOrder = await bootOrder(page);
    const offlineSeen = await page.evaluate(() => (window as unknown as { __boot: { values: string[]; violations: string[] } }).__boot);
    await context.setOffline(false);
    const result = {
      case: "warm service worker", expected: { id: row.id, mode: row.mode },
      bootFile: file, listedForWorker: file ? worker.includes(`"/${file}"`) : false,
      control: { firstLoad: firstControl, reloaded: reloadedControl },
      responses: [first, second],
      cache: { name: cacheName, ...cached }, offline: { probe, response: offline, order: offlineOrder },
      onDisk, values: [...new Set([...seen.values, ...offlineSeen.values])], violations: [...seen.violations, ...offlineSeen.violations],
    };
    const failures: string[] = [];
    if (!result.listedForWorker) failures.push("the worker does not list the boot script");
    if (reloadedControl !== "already controlled") failures.push(`the reloaded page was not controlled when asked: ${reloadedControl}`);
    for (const response of [...result.responses, offline]) {
      if (!response.url.endsWith(`/${file}`)) failures.push(`the page asked for ${response.url}, not this build's ${file}`);
      if (response.sha256 !== onDisk) failures.push(`the boot script served ${response.sha256}, the build holds ${onDisk}`);
    }
    if (!result.responses.some((response) => response.fromServiceWorker)) failures.push("the worker never answered the boot script");
    if (!cacheName) failures.push("the built worker names no cache");
    if (!cached.shell) failures.push(`the worker's cache ${cacheName} never kept the shell`);
    if (cached.sha256 !== onDisk) failures.push(`the worker's cache holds ${cached.sha256 ?? "no copy"} for the boot script, the build holds ${onDisk}`);
    if (probe !== "failed") failures.push(`the network was not cut for the worker: an uncached file was ${probe}`);
    if (!offline.fromServiceWorker || offline.status !== 200) failures.push(`offline, the boot script came ${offline.fromServiceWorker ? "from the worker" : "not from the worker"} with ${offline.status}`);
    if (!offlineOrder.booted) failures.push(`offline, nothing set the theme before the page was parsed: ${JSON.stringify(offlineOrder)}`);
    if (result.values.some((value) => value !== `data-theme=${row.mode}` && value !== `data-palette=${row.id}`)) failures.push(`root values ${result.values.join(", ")}`);
    if (result.violations.length) failures.push(`CSP violations ${result.violations.join("; ")}`);
    return { ...result, failures };
  } finally {
    await context.close();
  }
}

try {
  // one after the other: both builds write the same xterm source cache (vite.config.ts)
  await buildDemoApp(demoDir);
  const vite = Bun.spawn([process.execPath, "--bun", join(repo, "node_modules/.bin/vite"), "build", "--outDir", rootDir, "--emptyOutDir", "--logLevel", "warn"], { cwd: repo, stdout: "ignore", stderr: "pipe" });
  if ((await vite.exited) !== 0) throw new Error(`the production build failed:\n${await new Response(vite.stderr).text()}`);
  const demoIndex = join(demoDir, "index.html");
  writeFileSync(demoIndex, readFileSync(demoIndex, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
  for (const dir of [rootDir, demoDir]) {
    const html = readFileSync(join(dir, "index.html"), "utf8");
    const boot = html.indexOf("theme-bootstrap-");
    assert.ok(boot > 0 && boot < html.indexOf('rel="stylesheet"') && boot < html.indexOf('type="module"'), `${dir}: the boot script is not ahead of the stylesheet and the modules`);
  }
  const urls = { root: serve(rootDir, "/"), demo: serve(demoDir, DEMO_PREFIX) };
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const decoderContext = await browser.newContext();
  const decoder = await decoderContext.newPage();
  for (const base of ["root", "demo"] as const) {
    for (const item of CASES) {
      for (const width of item.widths ?? (item.headline ? (["390", "1440"] as const) : (["390"] as const))) {
        const run = await runCase(item, base, urls[base], width, decoder);
        runs.push(run);
        const status = run.failures.length ? "FAIL" : "ok";
        console.log(`${status} ${base} ${width} ${item.name}: ${run.expected.id}/${run.expected.mode}, ${run.frames.length} frames${run.failures.length ? `\n  ${run.failures.join("\n  ")}` : ""}`);
      }
    }
  }
  const warmRun = await warmServiceWorker(urls.root);
  warm.push(warmRun);
  console.log(`${(warmRun["failures"] as string[]).length ? "FAIL" : "ok"} root warm service worker${(warmRun["failures"] as string[]).length ? `\n  ${(warmRun["failures"] as string[]).join("\n  ")}` : ""}`);
  await decoderContext.close();
  failed = runs.some((run) => run.failures.length > 0) || warm.some((run) => (run["failures"] as string[]).length > 0);
} finally {
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "theme-first-paint-report.json"), `${JSON.stringify({ csp: CONTENT_SECURITY_POLICY, runs, warm }, null, 1)}\n`);
  }
  await browser?.close();
  for (const server of servers) await server.stop(true);
  rmSync(builds, { recursive: true, force: true });
}
assert.ok(runs.length > 0, "no case ran");
assert.equal(failed, false, "a frame showed another theme than the saved one; see the lines above");
console.log(`theme first paint: ${runs.length} runs and the warm service worker drew the saved row from the first frame`);
