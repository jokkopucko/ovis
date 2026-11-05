import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { KO } from "../src/lib/i18n.ko.ts";

// Settings → Phone & devices on the unmodified app over the demo's fixture transport: revoking
// every paired device, and the line every open window gets when a device pairs. The demo pairs
// no real device and holds no credential; `?demo_devices=` picks its states (site/demo/transport.ts).
// What is checked: the row warns the caller that their own pairing goes too and what does not
// (the access token, this PC, its Tailscale login); the confirmation asks again, with Cancel in
// focus, and a refused write stays in the dialog with the server's words; a confirmed revocation
// empties the list; a device that only watches sees the words and no working button; a fictional
// pairing shows one notice, whose action opens Phone & devices and whose X dismisses it. Nothing
// overflows a 390 px phone, and its touch targets are 44 px. With UI_EVIDENCE_DIR set, each state
// is captured at 390 (phone emulation) and 1440, light and dark, plus Korean at 390, with a manifest.
// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-device-security-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR || "";
const NOTICE = '[data-testid="device-paired-notice"]';
const PAIRS_WITHIN_MS = 10_000;
/** how far under a whole pixel a measured box may fall from layout rounding alone (a fractional offset above the list) */
const SUBPIXEL = 0.01;

type Theme = "light" | "dark";
type Language = "en" | "ko";
interface Shot { file: string; width: number; height: number; theme: Theme; language: Language; state: string; sha256: string; capturedAt: string; note?: string }
const manifest: Shot[] = [];
/** What a PNG cannot carry, per configuration: hit rectangles, accessible names and contrast ratios. */
const measurements: Record<string, Record<string, unknown>> = {};
/** The visual states no demo can show, listed with the reason so the set is read as complete. */
const notCaptured = [
  { state: "hover", reason: "at 390 only: a touch phone has no hover; captured at 1440" },
  { state: "focus-visible", reason: "at 390 only: a touch phone shows no keyboard focus ring; captured at 1440" },
];

const strings = (language: Language): Record<string, string> => language === "ko" ? KO : {};
const settingsOf = (language: Language, theme: Theme) => JSON.stringify({ language, theme });

async function open(context: BrowserContext, port: number, search: string): Promise<{ page: Page; errors: string[] }> {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // the demo answers its device routes only when asked (`demo_devices`); `list` is the fictional devices
  const devices = search.includes("demo_devices=") ? "" : "&demo_devices=list";
  await page.goto(`http://127.0.0.1:${port}/herdr-web-ui/demo/app/?settings=devices${devices}${search}`);
  await page.locator(".conn-live").waitFor();
  await page.locator(".settings-dialog").waitFor();
  return { page, errors };
}

/** Scrolls the Settings page so `target` sits at the bottom of the viewport, as a reader scrolling down sees it. */
async function reveal(target: Locator): Promise<void> {
  await target.evaluate((node) => node.scrollIntoView({ block: "end" }));
}

/**
 * A phone's sheet rises with an animation, and a closed one drops as its last frame, put back inert
 * and aria-hidden at the end of <body> until it has slid out (lib/sheets.ts): a capture waits two
 * frames for that drop to be set up, then for it to be gone and for every finite animation to end.
 */
async function settled(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.waitForFunction(() => ![...document.body.children].some((node) => node instanceof HTMLElement && node.inert && node.getAttribute("aria-hidden") === "true" && node.childElementCount === 0));
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
    .map((animation) => animation.finished.catch(() => undefined))));
}

async function capture(page: Page, name: string, about: Omit<Shot, "file" | "sha256" | "capturedAt">): Promise<string> {
  if (!evidence) return "";
  await settled(page);
  const file = join(evidence, `${name}.png`);
  await page.screenshot({ path: file });
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  manifest.push({ file: basename(file), ...about, sha256, capturedAt: new Date().toISOString() });
  return sha256;
}

/** Each button's hit rectangle and accessible name; the name is checked by the role query a screen reader's would match. */
async function buttons(page: Page, selector: string): Promise<{ name: string; x: number; y: number; width: number; height: number }[]> {
  const found = await page.evaluate((selector) => [...document.querySelectorAll<HTMLElement>(selector)].map((node) => {
    const box = node.getBoundingClientRect();
    return { name: (node.getAttribute("aria-label") ?? node.textContent ?? "").trim(), x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  }), selector);
  for (const item of found) assert.ok(await page.getByRole("button", { name: item.name, exact: true }).count() > 0, `"${item.name}" is a button's accessible name`);
  return found;
}

/**
 * A colour of `selector` over the backgrounds under it, composited, and their WCAG contrast ratio:
 * its text (`color`, which an icon's strokes follow), its edge (`border-top-color`) or its focus
 * ring (`outline-color`, drawn outside it, so over its parent's background). Also its computed
 * font size, for text.
 */
async function contrast(page: Page, selector: string, property: "color" | "border-top-color" | "outline-color" = "color"): Promise<{ color: string; background: string; ratio: number; fontSize: string }> {
  return page.evaluate(([selector, property]) => {
    const target = document.querySelector<HTMLElement>(selector!);
    if (!target) throw new Error(`no ${selector}`);
    const node = property === "outline-color" ? target.parentElement! : target;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const rgba = (css: string): number[] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!, a! / 255];
    };
    const over = (top: number[], below: number[]): number[] => [0, 1, 2].map((i) => top[i]! * top[3]! + below[i]! * (1 - top[3]!)).concat(1);
    const layers: number[][] = [];
    for (let at: HTMLElement | null = node; at; at = at.parentElement) {
      const layer = rgba(getComputedStyle(at).backgroundColor);
      if (layer[3]! > 0) layers.push(layer);
      if (layer[3] === 1) break;
    }
    let background = [255, 255, 255, 1];
    for (const layer of layers.reverse()) background = over(layer, background);
    const text = over(rgba(getComputedStyle(target).getPropertyValue(property!)), background);
    const luminance = (c: number[]): number => {
      const [r, g, b] = c.slice(0, 3).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const [light, dark] = [luminance(text), luminance(background)].sort((a, b) => b - a);
    const css = (c: number[]): string => `rgb(${c.slice(0, 3).map(Math.round).join(", ")})`;
    return { color: css(text), background: css(background), ratio: Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100, fontSize: getComputedStyle(target).fontSize };
  }, [selector, property] as const);
}

/** A frame as it is right now, animations included: no wait for them to end (`capture` waits). */
async function frame(page: Page, name: string, about: Omit<Shot, "file" | "sha256" | "capturedAt">): Promise<string> {
  if (!evidence) return "";
  const file = join(evidence, `${name}.png`);
  await page.screenshot({ path: file, animations: "allow" });
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  manifest.push({ file: basename(file), ...about, sha256, capturedAt: new Date().toISOString() });
  return sha256;
}

/** The names of the finite animations running on a dialog's scrim or surface, the closed sheet's drop included. */
async function dialogAnimations(page: Page): Promise<string[]> {
  return page.evaluate(() => ((window as unknown as { herdrAnimations?: () => Animation[] }).herdrAnimations?.() ?? document.getAnimations())
    .filter((animation) => ((animation.effect as KeyframeEffect | null)?.target as Element | null)?.closest?.(".modal-scrim") && animation.effect!.getTiming().iterations !== Infinity && animation.playState !== "finished")
    .map((animation) => (animation as CSSAnimation).animationName));
}

/**
 * Every running animation of a dialog's scrim and surface held at `share` of its duration: 0 is its
 * first frame, 1 its last. Returns the surface's top edge then, read from the animation's own target,
 * which for a closed sheet's drop sits in a closed shadow root no query reaches (src/lib/sheets.ts).
 */
async function holdAt(page: Page, share: number): Promise<number> {
  return page.evaluate((share) => {
    const held = ((window as unknown as { herdrAnimations?: () => Animation[] }).herdrAnimations?.() ?? document.getAnimations()).filter((animation) => ((animation.effect as KeyframeEffect | null)?.target as Element | null)?.closest?.(".modal-scrim") && animation.effect!.getTiming().iterations !== Infinity);
    if (held.length === 0) throw new Error("no dialog animation is running");
    let top = Number.NaN;
    for (const animation of held) {
      animation.pause();
      const duration = Number(animation.effect!.getComputedTiming().duration);
      // the very last frame would end it, and a drop's end takes its sheet away
      animation.currentTime = Math.max(0, Math.min(duration * share, duration - 1));
      const target = (animation.effect as KeyframeEffect).target as HTMLElement;
      if (target.classList.contains("modal")) top = target.getBoundingClientRect().top;
    }
    return top;
  }, share);
}

/**
 * Holds the next dialog animation at its first moment, whatever the host's load: each one that
 * starts on a dialog's scrim or surface is paused as the node it runs on is put in, and the closed
 * sheet's fallback removal (src/lib/sheets.ts LEAVE_MS, 600 ms) is not scheduled, so its drop stays
 * until it has played out. `disarm` undoes both; `release` also lets the held animations run on.
 */
async function arm(page: Page): Promise<void> {
  await page.evaluate(() => {
    const hook = window as unknown as { herdrHoldMotion?: () => void; herdrAnimations?: () => Animation[]; herdrShadowRoots?: ShadowRoot[] };
    if (hook.herdrHoldMotion) return;
    // a closed sheet's drop runs in a closed shadow root, which document.getAnimations() does not reach:
    // the roots attached while armed are kept, and every lookup reads them too
    const roots = hook.herdrShadowRoots ??= [];
    // only the confirmation's own: CSS animations (no hover transitions) on a scrim other than Settings' own
    hook.herdrAnimations = () => [...document.getAnimations(), ...roots.flatMap((root) => root.host.isConnected ? root.getAnimations() : [])].filter((animation) => {
      const scrim = ((animation.effect as KeyframeEffect | null)?.target as Element | null)?.closest?.(".modal-scrim");
      return animation instanceof CSSAnimation && scrim !== null && scrim !== undefined && scrim.querySelector(".settings-dialog") === null;
    });
    const realAttach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function attachShadow(this: Element, init: ShadowRootInit) { const root = realAttach.call(this, init); roots.push(root); return root; };
    const realTimeout = window.setTimeout;
    const pause = (): void => {
      for (const animation of hook.herdrAnimations!()) {
        const target = (animation.effect as KeyframeEffect | null)?.target as Element | null;
        if (target?.closest?.(".modal-scrim") && animation.effect!.getTiming().iterations !== Infinity && animation.playState === "running") animation.pause();
      }
    };
    const observer = new MutationObserver(pause);
    observer.observe(document.body, { childList: true, subtree: true });
    window.setTimeout = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) => ms === 600 ? 0 : realTimeout(handler, ms, ...rest)) as typeof window.setTimeout;
    hook.herdrHoldMotion = () => { observer.disconnect(); window.setTimeout = realTimeout; Element.prototype.attachShadow = realAttach; delete hook.herdrHoldMotion; };
  });
}

async function disarm(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { herdrHoldMotion?: () => void }).herdrHoldMotion?.());
}

/** Lets every held animation run on, and waits for the page to settle. */
async function release(page: Page): Promise<void> {
  await disarm(page);
  await page.evaluate(() => { for (const animation of ((window as unknown as { herdrAnimations?: () => Animation[] }).herdrAnimations?.() ?? document.getAnimations())) if (animation.playState === "paused") animation.play(); });
  await settled(page);
}

/** Controls and text past the viewport's right edge, and a page or Settings body that scrolls sideways. */
async function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth) out.push(`the page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
    const body = document.querySelector<HTMLElement>(".settings-body:not([hidden])");
    if (body && body.scrollWidth > body.clientWidth) out.push(`Settings scrolls sideways (${body.scrollWidth} > ${body.clientWidth})`);
    for (const node of document.querySelectorAll<HTMLElement>(".devices-panel button, .devices-panel .settings-label, .devices-panel .settings-description, .confirm-dialog button, .confirm-dialog p, [data-testid='device-paired-notice'] *")) {
      const box = node.getBoundingClientRect();
      if (box.width > 0 && (box.right > innerWidth + 0.5 || box.left < -0.5)) out.push(`${node.tagName.toLowerCase()}.${node.className} ${(node.getAttribute("aria-label") ?? node.textContent ?? "").trim().slice(0, 40)} reaches past the edge`);
    }
    return out;
  });
}

async function touchTargets(page: Page, selector: string): Promise<{ label: string; width: number; height: number }[]> {
  return page.evaluate((selector) => [...document.querySelectorAll<HTMLElement>(selector)].map((node) => {
    const box = node.getBoundingClientRect();
    return { label: (node.getAttribute("aria-label") ?? node.textContent ?? "").trim().slice(0, 30), width: box.width, height: box.height };
  }), selector);
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));
  if (evidence) mkdirSync(evidence, { recursive: true });

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
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const matrix: { width: number; theme: Theme; language: Language }[] = [
        { width: 390, theme: "light", language: "en" }, { width: 390, theme: "dark", language: "en" },
        { width: 1440, theme: "light", language: "en" }, { width: 1440, theme: "dark", language: "en" },
        { width: 390, theme: "light", language: "ko" },
      ];
      for (const { width, theme, language } of matrix) {
        const phone = width === 390;
        const height = phone ? 844 : 900;
        const label = (name: string): string => strings(language)[name] ?? name;
        const prefix = `device-security-${width}-${theme}${language === "ko" ? "-ko" : ""}`;
        const about = (state: string) => ({ width, height, theme, language, state });
        const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, locale: language === "ko" ? "ko-KR" : "en-US" });
        try {
          await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), settingsOf(language, theme));
          const press = async (target: Locator): Promise<void> => { if (phone) await target.tap(); else await target.click(); };
          const closeSettings = async (page: Page): Promise<void> => {
            // Pair a device's code is in the Connect a phone dialog, which closes by itself once the device is in
            await page.locator(".connect-phone-dialog").waitFor({ state: "detached", timeout: PAIRS_WITHIN_MS });
            await page.keyboard.press("Escape");
            await page.locator(".settings-dialog").waitFor({ state: "detached" });
            await settled(page);
          };
          const errorsOf: string[][] = [];

          // the page as it comes: the list with its long label, and the row that ends every pairing
          {
            const { page, errors } = await open(context, server.port, "");
            errorsOf.push(errors);
            const row = page.locator(".devices-revoke-all");
            await row.waitFor();
            const rowButton = row.getByRole("button", { name: label("Revoke all"), exact: true });
            assert.equal(await page.locator(".devices-row").count(), 3, "the demo lists its three devices");
            assert.equal(await row.locator(".settings-label").innerText(), label("Revoke every device"));
            const words = await row.locator(".settings-description").innerText();
            assert.equal(words, label("Every paired device, this one included, loses its pairing access at once. The access token, this PC and its Tailscale login are not affected."), "the row warns the caller that their own pairing goes, and names what stays");
            assert.equal(await rowButton.isEnabled(), true);
            // three places on one short page, each its own frame: the row at rest just come into view at the bottom
            // edge, the long label at that edge, and the true end (a target past the end would clamp them all into one)
            await reveal(row);
            const rest = await capture(page, `${prefix}-rest`, about("rest"));
            measurements[prefix] = {
              rowIconButtons: await buttons(page, ".devices-row button"),
              settingsClose: await buttons(page, ".settings-dialog .modal-header button"),
              revokeAllRowCopy: await contrast(page, ".devices-revoke-all .settings-description"),
              revokeAllRowLabel: await contrast(page, ".devices-revoke-all .settings-label"),
              revokeAllButtonText: await contrast(page, ".devices-revoke-all button"),
              // the button's edge, and the glyphs of the row icons beside the list (non-text, 3:1)
              revokeAllButtonEdge: await contrast(page, ".devices-revoke-all button", "border-top-color"),
              rowIconGlyph: await contrast(page, ".devices-row .icon-button"),
              revokeAllButtonUserSelect: await rowButton.evaluate((node) => getComputedStyle(node).userSelect),
            };
            // the longest label wraps inside its row, its rename and revoke buttons still beside it
            await reveal(page.locator(".devices-row").filter({ hasText: "Kitchen laptop" }));
            const longLabel = await capture(page, `${prefix}-long-label`, about("long-label"));
            // the true end: the Settings page scrolled as far as it goes, the devices card closed below its last row
            const scroller = await row.evaluateHandle((node) => {
              let at: HTMLElement | null = node.parentElement;
              while (at && !(at.scrollHeight > at.clientHeight && /auto|scroll/.test(getComputedStyle(at).overflowY))) at = at.parentElement;
              return at ?? document.scrollingElement as HTMLElement;
            });
            await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight; });
            assert.equal(await scroller.evaluate((node) => Math.ceil(node.scrollTop + node.clientHeight) >= node.scrollHeight), true, "Settings is scrolled to its end");
            assert.equal(await page.locator(".devices-panel").evaluate((node, scroller) => {
              const card = node.closest<HTMLElement>(".settings-card") ?? node;
              return card.getBoundingClientRect().bottom <= (scroller as HTMLElement).getBoundingClientRect().bottom + 0.5;
            }, scroller), true, "the devices card ends inside the view, its bottom padding included");
            const end = await capture(page, `${prefix}-scrolled-end`, about("scrolled-end"));
            if (evidence) assert.equal(new Set([rest, longLabel, end]).size, 3, "rest, long label and the end are three different frames");
            assert.deepEqual(await overflow(page), [], `nothing reaches past the edge at ${width}`);
            if (phone) {
              const targets = await touchTargets(page, ".devices-panel button");
              for (const target of targets) assert.ok(target.width >= 44 - SUBPIXEL && target.height >= 44 - SUBPIXEL, `${target.label}: ${target.width}x${target.height} is a 44 px target`);
            }
            if (!phone) {
              await rowButton.hover();
              await capture(page, `${prefix}-hover`, about("hover"));
              // keyboard focus: Tab from the control before it, so the ring is the keyboard's
              await page.getByRole("button", { name: label("Pair a device"), exact: true }).focus();
              await page.keyboard.press("Tab");
              assert.equal(await rowButton.evaluate((node) => node === document.activeElement && node.matches(":focus-visible")), true, "Tab reaches Revoke all with a visible focus ring");
              const focused = await capture(page, `${prefix}-focus-visible`, about("focus-visible"));
              // the ring, over what is around the button
              measurements[prefix]!.focusRing = { ...await contrast(page, ".devices-revoke-all button", "outline-color"), outline: await rowButton.evaluate((node) => `${getComputedStyle(node).outlineWidth} ${getComputedStyle(node).outlineStyle}, offset ${getComputedStyle(node).outlineOffset}`) };
              // a mouse press draws only on an icon button (styles.css .icon-button:active; a .btn keeps its
              // hover look): the first device's revoke icon, held down, and let go away from it so nothing is clicked
              const icon = page.locator(".devices-row").first().locator("button").last();
              await icon.scrollIntoViewIfNeeded();
              const box = (await icon.boundingBox())!;
              await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
              await page.mouse.down();
              assert.equal(await icon.evaluate((node) => node.matches(":active")), true, "the icon is held down");
              const pressed = await capture(page, `${prefix}-pressed`, { ...about("pressed"), note: "mouse held down on the first device's revoke icon button: on a desktop only icon buttons draw :active" });
              await page.mouse.move(0, 0);
              await page.mouse.up();
              if (evidence) assert.notEqual(pressed, focused, "the pressed frame is not the focus frame");
              await press(rowButton);
            } else {
              // Revoke all held down: the touch rule (styles.css, pointer: coarse) dims what is pressed. Headless
              // Chrome holds no :active for a synthetic touch, so the pointer is held under the same touch
              // emulation, and let go away from the button so nothing is clicked
              // the scrolled-end frame may have taken the row out of view (Settings groups below Devices)
              await reveal(row);
              const box = (await rowButton.boundingBox())!;
              const resting = evidence ? createHash("sha256").update(await page.screenshot()).digest("hex") : "";
              await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
              await page.mouse.down();
              await page.waitForFunction(() => {
                const node = document.querySelector(".devices-revoke-all button");
                return node !== null && node.matches(":active") && getComputedStyle(node).opacity === "0.55";
              }, undefined, { timeout: 5000 });
              const pressed = await capture(page, `${prefix}-pressed`, { ...about("pressed"), note: "Revoke all held down under touch emulation: the touch rule dims a pressed control to 0.55" });
              await page.mouse.move(0, 0);
              await page.mouse.up();
              if (evidence) assert.notEqual(pressed, resting, "the pressed frame differs from the same view at rest");
              assert.equal(await page.locator(".confirm-dialog").count(), 0, "letting go away from the button clicked nothing");
              await press(rowButton);
            }
            // the question: Cancel holds the focus, Escape is a no, and nothing changed
            const dialog = page.getByRole("alertdialog", { name: label("Revoke every paired device?"), exact: true });
            await dialog.waitFor();
            assert.equal(await dialog.locator(".confirm-body").innerText(), label("Every paired device loses its pairing access, this one included, and needs a new code to get back in. The access token, this PC and its Tailscale login still get in."));
            assert.equal(await page.evaluate(() => document.activeElement?.textContent), label("Cancel"), "Cancel takes the focus, so Enter answers no");
            await capture(page, `${prefix}-confirm`, about("confirm"));
            measurements[prefix]!.confirmBody = await contrast(page, ".confirm-dialog .confirm-body");
            measurements[prefix]!.confirmTitle = await contrast(page, ".confirm-dialog .modal-title");
            measurements[prefix]!.confirmCancelText = await contrast(page, ".confirm-dialog .modal-footer .btn:not(.btn-danger)");
            measurements[prefix]!.confirmCancelEdge = await contrast(page, ".confirm-dialog .modal-footer .btn:not(.btn-danger)", "border-top-color");
            measurements[prefix]!.confirmActionText = await contrast(page, ".confirm-dialog .btn-danger");
            // Cancel holds the focus as the dialog opens: its ring
            measurements[prefix]!.confirmCancelFocus = { focusVisible: await page.evaluate(() => document.activeElement?.matches(":focus-visible") ?? false), ...await contrast(page, ".confirm-dialog .modal-footer .btn:not(.btn-danger)", "outline-color") };
            assert.deepEqual(await overflow(page), [], "the confirmation fits");
            if (phone) {
              const targets = await touchTargets(page, ".confirm-dialog button");
              for (const target of targets) assert.ok(target.height >= 44, `${target.label}: ${target.height} px tall`);
            }
            await page.keyboard.press("Escape");
            await dialog.waitFor({ state: "detached" });
            assert.equal(await page.locator(".devices-row").count(), 3, "Escape revoked nothing");
            // the deed, from the row again: the list empties, the row goes, and the answer is said
            await press(rowButton);
            await dialog.waitFor();
            await press(dialog.getByRole("button", { name: label("Revoke all"), exact: true }));
            await dialog.waitFor({ state: "detached" });
            const revoked = page.getByText(label("Every paired device was revoked. The access token, this PC and its Tailscale login get in as before."), { exact: true });
            await revoked.waitFor();
            assert.equal(await page.locator(".devices-row").count(), 0, "every device went");
            assert.equal(await row.count(), 0, "with nothing paired there is nothing to revoke");
            await page.getByText(label("No devices paired yet."), { exact: true }).waitFor();
            await reveal(revoked);
            await capture(page, `${prefix}-revoked`, about("revoked"));
            await page.close();
          }

          // the confirmation in motion (light, English, both widths): its entrance and exit frame by frame, a close
          // and a swipe that interrupt the entrance, and the same dialog under reduced motion. Each frame holds the
          // animations at a set share of their duration, so no frame depends on timing
          if (theme === "light" && language === "en") {
            const { page, errors } = await open(context, server.port, "");
            errorsOf.push(errors);
            const row = page.locator(".devices-revoke-all");
            const rowButton = row.getByRole("button", { name: label("Revoke all"), exact: true });
            const dialog = page.getByRole("alertdialog", { name: label("Revoke every paired device?"), exact: true });
            await reveal(row);
            await settled(page);
            const motion: Record<string, unknown> = {};
            // the entrance: first frame, half way, last frame
            await arm(page);
            await press(rowButton);
            await dialog.waitFor();
            motion.entrance = await dialogAnimations(page);
            if (phone) {
              assert.deepEqual([...(motion.entrance as string[])].sort(), ["scrim-in", "sheet-in"], "a phone's sheet rises over a darkening scrim");
              const tops: number[] = [];
              for (const [share, name] of [[0, "start"], [0.5, "mid"], [1, "end"]] as const) {
                tops.push(await holdAt(page, share));
                await frame(page, `${prefix}-confirm-enter-${name}`, { ...about(`confirm-enter-${name}`), note: `entrance held at ${share * 100}% of its duration` });
              }
              assert.ok(tops[0]! > tops[1]! && tops[1]! > tops[2]!, `the sheet rises steadily: ${tops.join(" > ")}`);
              await release(page);
              const restTop = await page.locator(".confirm-dialog").evaluate((node) => node.getBoundingClientRect().top);
              // the exit: Cancel, and the closed sheet's last frame drops from where it rested
              await arm(page);
              await press(dialog.getByRole("button", { name: label("Cancel"), exact: true }));
              await dialog.waitFor({ state: "detached" });
              assert.deepEqual([...await dialogAnimations(page)].sort(), ["scrim-out", "sheet-out"], "the closed sheet drops over a lightening scrim");
              const exits: number[] = [];
              for (const [share, name] of [[0, "start"], [0.5, "mid"], [1, "end"]] as const) {
                exits.push(await holdAt(page, share));
                await frame(page, `${prefix}-confirm-exit-${name}`, { ...about(`confirm-exit-${name}`), note: `exit held at ${share * 100}% of its duration` });
              }
              assert.ok(Math.abs(exits[0]! - restTop) <= 1, `the drop starts where the sheet rested (${exits[0]} vs ${restTop}): the exit mirrors the entrance`);
              assert.ok(exits[0]! < exits[1]! && exits[1]! < exits[2]!, `the sheet drops steadily: ${exits.join(" < ")}`);
              motion.entranceTops = tops;
              motion.exitTops = exits;
              motion.restTop = restTop;
              await release(page);

              // a close that interrupts the entrance: Cancel answers while the sheet is half way up
              await arm(page);
              await press(rowButton);
              await dialog.waitFor();
              const midTop = await holdAt(page, 0.5);
              await frame(page, `${prefix}-confirm-interrupted-mid`, { ...about("confirm-interrupted-mid"), note: "entrance held half way, just before Cancel is pressed" });
              await press(dialog.getByRole("button", { name: label("Cancel"), exact: true }));
              await dialog.waitFor({ state: "detached", timeout: 5000 });
              assert.equal(await page.locator(".devices-row").count(), 3, "the interrupted dialog answered no");
              assert.ok((await dialogAnimations(page)).includes("sheet-out"), "the interrupted sheet drops");
              const dropTop = await holdAt(page, 0);
              await frame(page, `${prefix}-confirm-interrupted-exit-start`, { ...about("confirm-interrupted-exit-start"), note: "first frame of the drop after Cancel was pressed half way up" });
              motion.interruptedClose = { inputGated: false, midTop, dropStartTop: dropTop, jumpPx: Math.round(dropTop - midTop) };
              await release(page);

              // a swipe that interrupts the entrance: the finger takes the sheet half way up, and lets go near the top
              await arm(page);
              await press(rowButton);
              await dialog.waitFor();
              const heldTop = await holdAt(page, 0.5);
              // the finger's own handling (src/lib/sheets.ts) takes it from here
              await disarm(page);
              const header = (await page.locator(".confirm-dialog .modal-header").boundingBox())!;
              const x = header.x + header.width / 2;
              const y = header.y + header.height / 2;
              const cdp = await context.newCDPSession(page);
              await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
              for (const dy of [10, 20, 30]) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + dy }] });
              const draggedTop = await page.locator(".confirm-dialog").evaluate((node) => node.getBoundingClientRect().top);
              await frame(page, `${prefix}-confirm-swipe-held`, { ...about("confirm-swipe-held"), note: "a finger took the rising sheet half way up and holds it 30 px down" });
              await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
              await cdp.detach();
              await settled(page);
              assert.equal(await dialog.isVisible(), true, "a short drag springs the sheet back");
              motion.interruptedSwipe = { heldTop, draggedTop, restTop, jumpPx: Math.round(draggedTop - heldTop), followsFingerFromRest: Math.abs(draggedTop - (restTop + 30)) <= 2 };
              await page.keyboard.press("Escape");
              await dialog.waitFor({ state: "detached" });
              await settled(page);
            } else {
              // at 1440 a dialog is a centred modal: it appears with no entrance or exit of its own
              assert.deepEqual(motion.entrance, [], "a desktop modal has no entrance animation");
              await release(page);
              await frame(page, `${prefix}-confirm-enter-end`, { ...about("confirm-enter-end"), note: "the modal's first frame is its last: no entrance animation at 1440" });
              await arm(page);
              await page.keyboard.press("Escape");
              await dialog.waitFor({ state: "detached" });
              motion.exit = await dialogAnimations(page);
              assert.deepEqual(motion.exit, [], "a desktop modal has no exit animation");
              await release(page);
            }
            measurements[prefix]!.motion = motion;
            await page.close();

            if (phone) {
              // reduced motion: nothing rises or drops, the dialog is there and gone in one frame each
              const reduced = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "en-US", reducedMotion: "reduce" });
              try {
                await reduced.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), settingsOf(language, theme));
                const still = await open(reduced, server.port, "");
                errorsOf.push(still.errors);
                const stillRow = still.page.locator(".devices-revoke-all");
                await reveal(stillRow);
                await settled(still.page);
                // armed as above: an animation that did start would be held, and so seen
                await arm(still.page);
                await stillRow.getByRole("button", { name: label("Revoke all"), exact: true }).tap();
                const stillDialog = still.page.getByRole("alertdialog");
                await stillDialog.waitFor();
                const opening = await dialogAnimations(still.page);
                assert.deepEqual(opening, [], "under reduced motion the sheet does not rise");
                await frame(still.page, `${prefix}-reduced-motion-confirm`, { ...about("reduced-motion-confirm"), note: "prefers-reduced-motion: reduce; the first frame after the tap is the settled dialog" });
                await stillDialog.getByRole("button", { name: label("Cancel"), exact: true }).tap();
                await stillDialog.waitFor({ state: "detached" });
                const closing = await dialogAnimations(still.page);
                const leftBehind = await still.page.evaluate(() => [...document.body.children].filter((node) => node instanceof HTMLElement && node.inert && node.getAttribute("aria-hidden") === "true").length);
                assert.deepEqual(closing, [], "under reduced motion the sheet does not drop");
                assert.equal(leftBehind, 0, "no closed sheet is put back to drop");
                await frame(still.page, `${prefix}-reduced-motion-closed`, { ...about("reduced-motion-closed"), note: "prefers-reduced-motion: reduce; the first frame after Cancel has no dialog" });
                measurements[prefix]!.reducedMotion = { opening, closing, leftBehind };
                await release(still.page);
                await still.page.close();
              } finally {
                await reduced.close();
              }
            }
          }

          // a write the server refuses: the dialog stays, with the server's words, and nothing changed
          {
            const { page, errors } = await open(context, server.port, "&demo_devices=error");
            errorsOf.push(errors);
            const row = page.locator(".devices-revoke-all");
            await press(row.getByRole("button", { name: label("Revoke all"), exact: true }));
            const dialog = page.getByRole("alertdialog");
            await dialog.waitFor();
            await press(dialog.getByRole("button", { name: label("Revoke all"), exact: true }));
            const failure = dialog.locator(".confirm-error");
            await failure.waitFor();
            // what did not happen, and what to do next, with the server's log reference and no file name or machine words
            assert.equal(await failure.innerText(), label("Nothing was revoked: the PC could not save the change. Try again; if it keeps failing, look up {reference} in the server's log on the PC.").replace("{reference}", "d3m0f41l0001"));
            assert.doesNotMatch(await failure.innerText(), /devices\.json|internal error/, "no file name or machine words");
            assert.equal(await dialog.isVisible(), true, "a refused write keeps the question open");
            assert.equal(await page.locator(".devices-row").count(), 3, "a refused write revoked nothing");
            await capture(page, `${prefix}-save-error`, about("save-error"));
            measurements[prefix]!.saveError = await contrast(page, ".confirm-dialog .confirm-error");
            // the dialog's two buttons stay usable after the refusal: their words and edges
            measurements[prefix]!.saveErrorCancelText = await contrast(page, ".confirm-dialog .modal-footer .btn:not(.btn-danger)");
            measurements[prefix]!.saveErrorActionText = await contrast(page, ".confirm-dialog .btn-danger");
            assert.deepEqual(await overflow(page), [], "the failure fits");
            await press(dialog.getByRole("button", { name: label("Cancel"), exact: true }));
            await dialog.waitFor({ state: "detached" });
            await page.close();
          }

          // a device that only watches: the words, and no working button
          {
            const { page, errors } = await open(context, server.port, "&demo_devices=watch");
            errorsOf.push(errors);
            const row = page.locator(".devices-revoke-all");
            await row.waitFor();
            // no button at all: a disabled one would be a faint dead control; the words say who can
            assert.equal(await row.getByRole("button").count(), 0, "a watching device has no revoke-all button");
            assert.equal(await row.locator(".settings-description").innerText(), label("Every paired device, this one included, would lose its pairing access at once. A device that only watches cannot do it: use the PC or a device that can drive."));
            await reveal(row);
            await capture(page, `${prefix}-watch`, { ...about("disabled-watch"), note: "a watching device gets the explanation and no button (no disabled control is drawn)" });
            measurements[prefix]!.watchCopy = await contrast(page, ".devices-revoke-all .settings-description");
            assert.deepEqual(await overflow(page), [], "the watch words fit");
            // the current device's pill beside names of every length up to a long one (#1179: "iPhone · Safari"
            // at 390 split it between its two words): one box each time, on the name's line or the next, and one
            // line high, as beside a one-letter name (a box of its own could still wrap its words inside it).
            // The name is set in place and put back, so React's own text stays what it rendered
            const split = await page.locator(".devices-current").evaluate(async (badge) => {
              const name = badge.parentElement!.firstChild as Text;
              const rendered = name.data;
              const long = "iPhone · Safari on the long-named phone";
              const broken: string[] = [];
              // every glyph the long name needs is loaded first: a font arriving mid-loop changes the pill's height
              name.data = long;
              await document.fonts.ready;
              name.data = long.slice(0, 1);
              const oneLine = badge.getBoundingClientRect().height;
              for (let n = 1; n <= long.length; n++) {
                name.data = long.slice(0, n);
                if (badge.getClientRects().length !== 1 || badge.getBoundingClientRect().height !== oneLine) broken.push(name.data);
              }
              // a column narrower than the pill itself (Japanese at 320 with Revoke? open beside it): its words wrap
              // inside it, and it stays in the column instead of running under the row's buttons. The column is as
              // wide as the pill's widest word and its margin (measured with wrapping allowed), the least any pill needs
              const column = badge.closest<HTMLElement>(".devices-name")!;
              badge.style.whiteSpace = "normal";
              badge.style.width = "min-content";
              const narrow = Math.ceil(badge.getBoundingClientRect().width + parseFloat(getComputedStyle(badge).marginLeft));
              badge.style.whiteSpace = "";
              badge.style.width = "";
              column.style.maxWidth = `${narrow}px`;
              if (badge.getBoundingClientRect().right > column.getBoundingClientRect().right + 0.5) broken.push(`pill past a ${narrow}px column`);
              column.style.maxWidth = "";
              name.data = rendered;
              return broken;
            });
            assert.deepEqual(split, [], `the this-device pill stays one box beside every name, and inside a narrow column, at ${width}`);
            await page.close();
          }

          // nothing paired: no row to revoke with
          {
            const { page, errors } = await open(context, server.port, "&demo_devices=empty");
            errorsOf.push(errors);
            await page.getByText(label("No devices paired yet."), { exact: true }).waitFor();
            assert.equal(await page.locator(".devices-revoke-all").count(), 0, "an empty list offers no revoke-all");
            await page.locator(".devices-panel").evaluate((node) => node.scrollIntoView({ block: "end" }));
            await capture(page, `${prefix}-empty`, about("empty"));
            await page.close();
          }

          // the list still on its way
          {
            const { page, errors } = await open(context, server.port, "&demo_devices=slow");
            errorsOf.push(errors);
            const loading = page.locator(".devices-panel [role='status']", { hasText: label("Loading…") });
            await loading.waitFor();
            await page.locator(".devices-panel").evaluate((node) => node.scrollIntoView({ block: "end" }));
            await capture(page, `${prefix}-loading`, about("loading"));
            // the list was held for the whole capture, and only now is let go
            assert.equal(await page.locator(".devices-row").count(), 0, "no device row was drawn while the loading state was captured");
            assert.equal(await loading.isVisible(), true, "the loading line is still up after the capture");
            await page.evaluate(() => (globalThis as { herdrDemoReleaseDevices?: () => void }).herdrDemoReleaseDevices!());
            await page.locator(".devices-row").first().waitFor();
            assert.equal(await loading.count(), 0, "the loading line goes once the list arrives");
            await page.close();
          }

          // a pairing: the fictional phone enters the code, and every window hears of it once
          {
            // the fictional phone waits until it is let go (site/demo/transport.ts `demo_pairing=held`), so the
            // code is seen before its enrollment takes it away
            const { page, errors } = await open(context, server.port, "&demo_pairing=held");
            errorsOf.push(errors);
            const notice = page.locator(NOTICE);
            const letPhonePair = async (): Promise<void> => assert.equal(await page.evaluate(() => (globalThis as { herdrDemoReleasePairing?: () => boolean }).herdrDemoReleasePairing!()), true, "a pairing was waiting to be let go");
            await press(page.getByRole("button", { name: label("Pair a device"), exact: true }));
            await page.locator(".devices-code").waitFor();
            assert.equal(await page.locator(".devices-code").innerText(), "482 913", "the code is shown");
            assert.equal(await notice.count(), 0, "nothing is announced before the device enrolls");
            await letPhonePair();
            await notice.waitFor({ state: "attached", timeout: PAIRS_WITHIN_MS });
            await page.getByText(label("Paired: {name}.").replace("{name}", "Living-room iPad"), { exact: true }).waitFor();
            assert.equal(await page.locator(".devices-code").count(), 0, "the code goes once the device paired with it");
            await closeSettings(page);
            await notice.waitFor({ state: "visible" });
            assert.equal(await notice.count(), 1, "one line per enrollment");
            const text = (await notice.innerText()).replace(/\s+/g, " ").trim();
            assert.ok(text.includes("Living-room iPad"), `the line names the device: ${text}`);
            const tail = label("A new device was paired at {time}: {name}. If that was not you, revoke it.").split("{name}.")[1]!.trim();
            assert.ok(text.includes(tail), `the line carries the warning in words: ${text}`);
            await capture(page, `${prefix}-notice`, about("notice"));
            measurements[prefix]!.noticeButtons = await buttons(page, `${NOTICE} button`);
            measurements[prefix]!.noticeCopy = await contrast(page, `${NOTICE} span`);
            // what is not text: the glyph that is the line's cue, its X, and its button's edge
            measurements[prefix]!.noticeGlyph = await contrast(page, `${NOTICE} > svg`);
            measurements[prefix]!.noticeDismissGlyph = await contrast(page, `${NOTICE} .update-notice-dismiss`);
            measurements[prefix]!.noticeActionText = await contrast(page, `${NOTICE} .device-paired-actions .btn`);
            measurements[prefix]!.noticeActionEdge = await contrast(page, `${NOTICE} .device-paired-actions .btn`, "border-top-color");
            assert.deepEqual(await overflow(page), [], "the notice fits");
            if (phone) {
              const targets = await touchTargets(page, `${NOTICE} button`);
              for (const target of targets) assert.ok(target.width >= 44 - SUBPIXEL && target.height >= 44 - SUBPIXEL, `${target.label}: ${target.width}x${target.height} is a 44 px target`);
            }
            // its action: Phone & devices opens, and the line is read
            await press(notice.getByRole("button", { name: label("Phone & devices"), exact: true }));
            await page.locator(".settings-dialog").waitFor();
            assert.equal((await page.locator(".settings-dialog .modal-title").innerText()).trim(), label("Phone & devices"));
            assert.equal(await notice.count(), 0, "opening Phone & devices dismisses the line");
            assert.equal(await page.locator(".devices-row").count(), 4, "the new device is on the list");
            // a second pairing, dismissed by its X
            await press(page.getByRole("button", { name: label("Pair a device"), exact: true }));
            await page.locator(".devices-code").waitFor();
            await letPhonePair();
            await notice.waitFor({ state: "attached", timeout: PAIRS_WITHIN_MS });
            await closeSettings(page);
            await press(notice.getByRole("button", { name: label("Dismiss"), exact: true }));
            await notice.waitFor({ state: "detached" });
            await page.close();
          }

          // the connection lost after a pairing was heard: the line stays, next to the header's reconnecting
          {
            const { page, errors } = await open(context, server.port, "&demo_connection=drops&demo_pairing=held");
            errorsOf.push(errors);
            const notice = page.locator(NOTICE);
            await press(page.getByRole("button", { name: label("Pair a device"), exact: true }));
            await page.locator(".devices-code").waitFor();
            assert.equal(await page.evaluate(() => (globalThis as { herdrDemoReleasePairing?: () => boolean }).herdrDemoReleasePairing!()), true, "a pairing was waiting to be let go");
            await notice.waitFor({ state: "attached", timeout: PAIRS_WITHIN_MS });
            await closeSettings(page);
            await page.locator(".conn-reconnecting").waitFor({ state: "visible" });
            await notice.waitFor({ state: "visible" });
            assert.equal(await page.locator(".conn-live").count(), 0, "the header no longer says live");
            assert.equal(await notice.count(), 1, "the line stays while the connection is gone");
            await capture(page, `${prefix}-offline-reconnect`, about("offline-reconnect"));
            assert.deepEqual(await overflow(page), [], "the line and the reconnecting header fit together");
            await page.close();
          }

          for (const errors of errorsOf) assert.deepEqual(errors, [], "the page raised no error");
          console.log(`PASS ${width}px ${theme} ${language}: caller warning, confirmation, refused write, watch, empty, loading, revocation and the pairing notice`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
  if (evidence) {
    writeFileSync(join(evidence, "device-security-manifest.json"), `${JSON.stringify({ captures: manifest, notCaptured }, null, 2)}\n`);
    writeFileSync(join(evidence, "device-security-measurements.json"), `${JSON.stringify(measurements, null, 2)}\n`);
    console.log(`captured ${manifest.length} states into ${evidence}`);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
