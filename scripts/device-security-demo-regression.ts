import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { BrowserContext, Locator, Page } from "playwright-core";
import { withDemoBrowser } from "./demo-browser.ts";
import { KO } from "../src/lib/i18n.ko.ts";

// The demo pairs no real device and holds no credential; `?demo_devices=` picks its states (site/demo/transport.ts).
// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const evidence = process.env.UI_EVIDENCE_DIR || "";
const NOTICE = '[data-testid="device-paired-notice"]';
const ROW = ".devices-panel .devices-row";
const PAIRS_WITHIN_MS = 10_000;
/** how far under a whole pixel a measured box may fall from layout rounding alone (a fractional offset above the list) */
const SUBPIXEL = 0.01;

type Theme = "light" | "dark";
type Language = "en" | "ko";
interface Shot { file: string; width: number; height: number; theme: Theme; language: Language; state: string; sha256: string; capturedAt: string; note?: string }
const manifest: Shot[] = [];
const measurements: Record<string, Record<string, unknown>> = {};
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
  const devices = search.includes("demo_devices=") ? "" : "&demo_devices=list";
  await page.goto(`http://127.0.0.1:${port}/herdr-web-ui/demo/app/?settings=devices${devices}${search}`);
  await page.locator(".conn-live").waitFor();
  await page.locator(".settings-dialog").waitFor();
  const more = page.locator('.settings-dialog .settings-fold[data-fold="more"]');
  if (await more.count() > 0) await more.evaluate((fold) => { (fold as HTMLDetailsElement).open = true; });
  return { page, errors };
}

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

async function buttons(page: Page, selector: string): Promise<{ name: string; x: number; y: number; width: number; height: number }[]> {
  const found = await page.evaluate((selector) => [...document.querySelectorAll<HTMLElement>(selector)].map((node) => {
    const box = node.getBoundingClientRect();
    return { name: (node.getAttribute("aria-label") ?? node.textContent ?? "").trim(), x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  }), selector);
  for (const item of found) assert.ok(await page.getByRole("button", { name: item.name, exact: true }).count() > 0, `"${item.name}" is a button's accessible name`);
  return found;
}

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

async function frame(page: Page, name: string, about: Omit<Shot, "file" | "sha256" | "capturedAt">): Promise<string> {
  if (!evidence) return "";
  const file = join(evidence, `${name}.png`);
  await page.screenshot({ path: file, animations: "allow" });
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  manifest.push({ file: basename(file), ...about, sha256, capturedAt: new Date().toISOString() });
  return sha256;
}

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

async function release(page: Page): Promise<void> {
  await disarm(page);
  await page.evaluate(() => { for (const animation of ((window as unknown as { herdrAnimations?: () => Animation[] }).herdrAnimations?.() ?? document.getAnimations())) if (animation.playState === "paused") animation.play(); });
  await settled(page);
}

async function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth) out.push(`the page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
    const body = document.querySelector<HTMLElement>(".settings-body:not([hidden])");
    if (body && body.scrollWidth > body.clientWidth) out.push(`Settings scrolls sideways (${body.scrollWidth} > ${body.clientWidth})`);
    for (const node of document.querySelectorAll<HTMLElement>(".devices-panel button, .devices-panel .settings-label, .devices-panel .settings-description, [data-testid='this-pc'] button, [data-testid='this-pc'] .settings-label, [data-testid='this-pc'] .settings-description, .confirm-dialog button, .confirm-dialog p, [data-testid='device-paired-notice'] *")) {
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

await withDemoBrowser({ tempPrefix: "herdr-device-security-demo-" }, async ({ newContext, port }) => {
  const server = { port };
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
    const context = await newContext({ viewport: { width, height }, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, locale: language === "ko" ? "ko-KR" : "en-US" });
    try {
      await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), settingsOf(language, theme));
      const press = async (target: Locator): Promise<void> => { if (phone) await target.tap(); else await target.click(); };
      const startCode = async (page: Page): Promise<void> => {
        await press(page.locator('.settings-dialog [data-section="devices"]').getByRole("button", { name: label("Add a connection"), exact: true }));
        // Pair with a code is under the relay tab, or under SSH where the PC has no relay tab
        const relayTab = page.locator('.connect-phone-dialog .connect-tabs [data-tab="relay"]');
        await press((await relayTab.count()) > 0 ? relayTab : page.locator('.connect-phone-dialog .connect-tabs [data-tab="ssh"]'));
        const pairByCode = page.locator('.connect-phone-dialog .connect-tab:not([hidden]) [data-testid="pair-with-code"]');
        const getCode = pairByCode.getByRole("button", { name: label("Get a pairing code"), exact: true });
        await pairByCode.locator(".compact-pair-code").or(getCode).first().waitFor();
        if (await getCode.count() > 0) await press(getCode);
      };
      const shownCode = (page: Page): Locator => page.locator('.connect-phone-dialog .connect-tab:not([hidden]) [data-testid="pair-with-code"] .compact-pair-code');
      const closeSettings = async (page: Page): Promise<void> => {
        await page.locator(".connect-phone-dialog").waitFor({ state: "detached", timeout: PAIRS_WITHIN_MS });
        await page.keyboard.press("Escape");
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        await settled(page);
      };
      const errorsOf: string[][] = [];

      {
        const { page, errors } = await open(context, server.port, "");
        errorsOf.push(errors);
        const row = page.locator(".devices-revoke-all");
        await row.waitFor();
        const rowButton = row.getByRole("button", { name: label("Revoke all"), exact: true });
        assert.equal(await page.locator(ROW).count(), 3, "the demo lists its three devices");
        assert.equal(await row.locator(".settings-label").innerText(), label("Revoke every device"));
        const words = await row.locator(".settings-description").innerText();
        assert.equal(words, label("Every paired device, this one included, loses its pairing access at once, and every Tailscale device this PC has seen is kept out until you allow it here. The access token and this PC are not affected."), "the row warns the caller that their own pairing goes, and names what stays");
        assert.equal(await rowButton.isEnabled(), true);
        // three places on one short page, each its own frame: the row at rest just come into view at the bottom
        // edge, the long label at that edge, and the true end (a target past the end would clamp them all into one)
        await reveal(row);
        const rest = await capture(page, `${prefix}-rest`, about("rest"));
        measurements[prefix] = {
          rowIconButtons: await buttons(page, `${ROW} button`),
          settingsClose: await buttons(page, ".settings-dialog .modal-header button"),
          revokeAllRowCopy: await contrast(page, ".devices-revoke-all .settings-description"),
          revokeAllRowLabel: await contrast(page, ".devices-revoke-all .settings-label"),
          revokeAllButtonText: await contrast(page, ".devices-revoke-all button"),
          revokeAllButtonEdge: await contrast(page, ".devices-revoke-all button", "border-top-color"),
          rowIconGlyph: await contrast(page, `${ROW} .icon-button`),
          revokeAllButtonUserSelect: await rowButton.evaluate((node) => getComputedStyle(node).userSelect),
        };
        await reveal(page.locator(ROW).filter({ hasText: "Kitchen laptop" }));
        const longLabel = await capture(page, `${prefix}-long-label`, about("long-label"));
        const scroller = await row.evaluateHandle((node) => {
          let at: HTMLElement | null = node.parentElement;
          while (at && !(at.scrollHeight > at.clientHeight && /auto|scroll/.test(getComputedStyle(at).overflowY))) at = at.parentElement;
          return at ?? document.scrollingElement as HTMLElement;
        });
        const scrolls = await scroller.evaluate((node) => node.scrollHeight > node.clientHeight + 1);
        await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight; });
        assert.equal(await scroller.evaluate((node) => Math.ceil(node.scrollTop + node.clientHeight) >= node.scrollHeight), true, "Settings is scrolled to its end");
        assert.equal(await page.locator(".devices-panel").evaluate((node, scroller) => {
          const card = node.closest<HTMLElement>(".settings-card") ?? node;
          return card.getBoundingClientRect().bottom <= (scroller as HTMLElement).getBoundingClientRect().bottom + 0.5;
        }, scroller), true, "the devices card ends inside the view, its bottom padding included");
        const end = await capture(page, `${prefix}-scrolled-end`, about("scrolled-end"));
        // Revoke every device sits in More settings, out of the devices card these frames were made to show; on a short
        // page two of them may be one picture, so they are kept as evidence without asserting that they differ
        void [rest, longLabel, end, scrolls];
        assert.deepEqual(await overflow(page), [], `nothing reaches past the edge at ${width}`);
        if (phone) {
          const targets = await touchTargets(page, ".devices-panel button");
          for (const target of targets) assert.ok(target.width >= 44 - SUBPIXEL && target.height >= 44 - SUBPIXEL, `${target.label}: ${target.width}x${target.height} is a 44 px target`);
        }
        if (!phone) {
          await rowButton.hover();
          await capture(page, `${prefix}-hover`, about("hover"));
          await rowButton.evaluate((button) => {
            const focusable = [...document.querySelectorAll<HTMLElement>("button, a[href], input, select, summary, [tabindex]:not([tabindex='-1'])")]
              .filter((node) => !node.matches(":disabled") && node.getClientRects().length > 0);
            focusable[focusable.indexOf(button as HTMLElement) - 1]?.focus();
          });
          await page.keyboard.press("Tab");
          assert.equal(await rowButton.evaluate((node) => node === document.activeElement && node.matches(":focus-visible")), true, "Tab reaches Revoke all with a visible focus ring");
          const focused = await capture(page, `${prefix}-focus-visible`, about("focus-visible"));
          measurements[prefix]!.focusRing = { ...await contrast(page, ".devices-revoke-all button", "outline-color"), outline: await rowButton.evaluate((node) => `${getComputedStyle(node).outlineWidth} ${getComputedStyle(node).outlineStyle}, offset ${getComputedStyle(node).outlineOffset}`) };
          // a mouse press draws only on an icon button (styles.css .icon-button:active; a .btn keeps its
          // hover look): the first device's revoke icon, held down, and let go away from it so nothing is clicked
          const icon = page.locator(ROW).first().locator("button").last();
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
        const dialog = page.getByRole("alertdialog", { name: label("Revoke every paired device?"), exact: true });
        await dialog.waitFor();
        assert.equal(await dialog.locator(".confirm-body").innerText(), label("Every paired device loses its pairing access, this one included, and needs a new code to get back in. Every Tailscale device this PC has seen is kept out too, until you allow it on this PC. The access token and this PC still get in."));
        assert.equal(await page.evaluate(() => document.activeElement?.textContent), label("Cancel"), "Cancel takes the focus, so Enter answers no");
        await capture(page, `${prefix}-confirm`, about("confirm"));
        measurements[prefix]!.confirmBody = await contrast(page, ".confirm-dialog .confirm-body");
        measurements[prefix]!.confirmTitle = await contrast(page, ".confirm-dialog .modal-title");
        measurements[prefix]!.confirmCancelText = await contrast(page, ".confirm-dialog .modal-footer .btn:not(.btn-danger)");
        measurements[prefix]!.confirmCancelEdge = await contrast(page, ".confirm-dialog .modal-footer .btn:not(.btn-danger)", "border-top-color");
        measurements[prefix]!.confirmActionText = await contrast(page, ".confirm-dialog .btn-danger");
        measurements[prefix]!.confirmCancelFocus = { focusVisible: await page.evaluate(() => document.activeElement?.matches(":focus-visible") ?? false), ...await contrast(page, ".confirm-dialog .modal-footer .btn:not(.btn-danger)", "outline-color") };
        assert.deepEqual(await overflow(page), [], "the confirmation fits");
        if (phone) {
          // sizes at rest: under the rising sheet's transform a rect reads 43.99994 for 44
          await settled(page);
          const targets = await touchTargets(page, ".confirm-dialog button");
          for (const target of targets) assert.ok(target.height >= 44, `${target.label}: ${target.height} px tall`);
        }
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        assert.equal(await page.locator(ROW).count(), 3, "Escape revoked nothing");
        await press(rowButton);
        await dialog.waitFor();
        await press(dialog.getByRole("button", { name: label("Revoke all"), exact: true }));
        await dialog.waitFor({ state: "detached" });
        const revoked = page.getByText(label("Every paired device was revoked, and the Tailscale devices this PC has seen are kept out. The access token and this PC get in as before."), { exact: true });
        await revoked.waitFor();
        assert.equal(await page.locator(ROW).count(), 0, "every device went");
        assert.equal(await row.count(), 0, "with nothing paired there is nothing to revoke");
        await page.getByText(label("No devices paired yet."), { exact: true }).waitFor();
        await reveal(revoked);
        await capture(page, `${prefix}-revoked`, about("revoked"));
        await page.close();
      }

      if (theme === "light" && language === "en") {
        const { page, errors } = await open(context, server.port, "");
        errorsOf.push(errors);
        const row = page.locator(".devices-revoke-all");
        const rowButton = row.getByRole("button", { name: label("Revoke all"), exact: true });
        const dialog = page.getByRole("alertdialog", { name: label("Revoke every paired device?"), exact: true });
        await reveal(row);
        await settled(page);
        const motion: Record<string, unknown> = {};
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

          await arm(page);
          await press(rowButton);
          await dialog.waitFor();
          const midTop = await holdAt(page, 0.5);
          await frame(page, `${prefix}-confirm-interrupted-mid`, { ...about("confirm-interrupted-mid"), note: "entrance held half way, just before Cancel is pressed" });
          await press(dialog.getByRole("button", { name: label("Cancel"), exact: true }));
          await dialog.waitFor({ state: "detached", timeout: 5000 });
          assert.equal(await page.locator(ROW).count(), 3, "the interrupted dialog answered no");
          assert.ok((await dialogAnimations(page)).includes("sheet-out"), "the interrupted sheet drops");
          const dropTop = await holdAt(page, 0);
          await frame(page, `${prefix}-confirm-interrupted-exit-start`, { ...about("confirm-interrupted-exit-start"), note: "first frame of the drop after Cancel was pressed half way up" });
          motion.interruptedClose = { inputGated: false, midTop, dropStartTop: dropTop, jumpPx: Math.round(dropTop - midTop) };
          await release(page);

          await arm(page);
          await press(rowButton);
          await dialog.waitFor();
          const heldTop = await holdAt(page, 0.5);
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
          const reduced = await newContext({ viewport: { width, height }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
          try {
            await reduced.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), settingsOf(language, theme));
            const still = await open(reduced, server.port, "");
            errorsOf.push(still.errors);
            const stillRow = still.page.locator(".devices-revoke-all");
            await reveal(stillRow);
            await settled(still.page);
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
        assert.equal(await page.locator(ROW).count(), 3, "a refused write revoked nothing");
        await capture(page, `${prefix}-save-error`, about("save-error"));
        measurements[prefix]!.saveError = await contrast(page, ".confirm-dialog .confirm-error");
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
        assert.equal(await row.getByRole("button").count(), 0, "a watching device has no revoke-all button");
        assert.equal(await row.locator(".settings-description").innerText(), label("Every paired device, this one included, would lose its pairing access at once. A device that only watches cannot do it: use the PC or a device that can drive."));
        await reveal(row);
        await capture(page, `${prefix}-watch`, { ...about("disabled-watch"), note: "a watching device gets the explanation and no button (no disabled control is drawn)" });
        measurements[prefix]!.watchCopy = await contrast(page, ".devices-revoke-all .settings-description");
        assert.deepEqual(await overflow(page), [], "the watch words fit");
        // The name is set in place and put back, so React's own text stays what it rendered. Read at rest:
        // under the rising sheet's transform, a pill on the next line reads a hair off the first one's height
        await settled(page);
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

      {
        const { page, errors } = await open(context, server.port, "&demo_devices=relay");
        errorsOf.push(errors);
        const self = page.locator('.settings-dialog [data-testid="this-pc"]');
        const check = self.getByRole("button", { name: label("Check now"), exact: true });
        await check.waitFor();
        assert.equal(await page.locator(".devices-check").count(), 0, "Check now has no line of its own");
        const placed = async (): Promise<Record<string, boolean>> => await self.evaluate((row) => {
          const box = row.getBoundingClientRect();
          const button = row.querySelector(".my-device-check button")!.getBoundingClientRect();
          const name = row.querySelector(".devices-name")!.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(row.querySelector(".settings-label")!.firstChild!);
          const words = [...range.getClientRects()];
          return {
            atRowEnd: Math.abs(box.right - button.right) <= 0.5,
            insideRow: button.top >= box.top - 0.5 && button.bottom <= box.bottom + 0.5,
            besideName: button.left >= name.right - 0.5,
            noTallerThanName: button.height <= name.height + 0.5,
            nameBeforeButton: words.length > 0 && words.every((rect) => rect.right <= button.left + 0.5 && rect.left >= box.left - 0.5),
          };
        });
        const where = { atRowEnd: true, insideRow: true, besideName: true, noTallerThanName: true, nameBeforeButton: true };
        assert.deepEqual(await placed(), where, `Check now sits at the end of this PC's row, beside its name and no taller, at ${width}`);
        await reveal(self);
        await capture(page, `${prefix}-check-now`, about("check-now"));
        for (const pcName of ["devswha-ThinkStation-P620", "devswhaThinkStationP620WorkstationLab"]) {
          await self.locator(".settings-label").evaluate((name, text) => { (name.firstChild as Text).data = text; }, pcName);
          assert.deepEqual(await placed(), where, `with the PC name ${pcName}, Check now keeps its place at ${width}`);
          assert.deepEqual(await overflow(page), [], `nothing reaches past the edge with the PC name ${pcName} at ${width}`);
        }
        if (phone) {
          // the button keeps the row's size; a finger's 44 px reaches it through its expander, read by hit-testing
          // half-pixel steps out from its edges (the device pixel grid may round the expander's edge by under a pixel)
          const reach = await check.evaluate((button) => {
            const box = button.getBoundingClientRect();
            const x = box.left + box.width / 2;
            let top = box.top, bottom = box.bottom;
            while (top > box.top - 30 && button.contains(document.elementFromPoint(x, top - 0.5))) top -= 0.5;
            while (bottom < box.bottom + 30 && button.contains(document.elementFromPoint(x, bottom + 0.5))) bottom += 0.5;
            return { button: box.height, reach: bottom - top };
          });
          assert.ok(reach.reach >= 43 && reach.reach <= Math.max(reach.button, 44) + 1, `Check now is ${reach.button}px tall and takes a finger ${reach.reach}px tall`);
        }
        await page.evaluate(() => {
          const inner = window.fetch;
          const held = window as unknown as { checks: number; releaseCheck?: () => void };
          held.checks = 0;
          window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
            if (!url.pathname.endsWith("/api/devices") || url.searchParams.get("check") !== "1") return inner(input, init);
            held.checks += 1;
            return new Promise<void>((resolve) => { held.releaseCheck = resolve; }).then(() => inner(input, init));
          }) as typeof window.fetch;
        });
        await press(check);
        const checking = self.getByRole("button", { name: label("Checking…"), exact: true });
        await checking.waitFor();
        assert.equal(await checking.isDisabled(), true, "Checking… holds the button while the PC asks");
        assert.equal(await page.evaluate(() => (window as unknown as { checks: number }).checks), 1, "a press asks the PC to check once");
        await page.evaluate(() => (window as unknown as { releaseCheck: () => void }).releaseCheck());
        await check.waitFor();
        assert.equal(await check.isEnabled(), true, "Check now is ready again after its check");
        await page.close();
      }

      {
        const { page, errors } = await open(context, server.port, "&demo_devices=empty");
        errorsOf.push(errors);
        await page.getByText(label("No devices paired yet."), { exact: true }).waitFor();
        assert.equal(await page.locator(".devices-revoke-all").count(), 0, "an empty list offers no revoke-all");
        await page.locator(".devices-panel").evaluate((node) => node.scrollIntoView({ block: "end" }));
        await capture(page, `${prefix}-empty`, about("empty"));
        await page.close();
      }

      {
        // no device paired here, two the PC's account let in, this one among them (site/demo/transport.ts `demo_devices=account`);
        // the relay is on, so a phone's own row also carries Use the relay
        const { page, errors } = await open(context, server.port, "&demo_devices=account&demo_relay=on");
        errorsOf.push(errors);
        const joined = page.locator(ROW, { hasText: "Galaxy S25" });
        await joined.waitFor();
        assert.equal(await joined.locator(".devices-kind", { hasText: label("Through your account") }).count(), 1, "the row says the account let it in");
        assert.equal(await page.getByText(label("No devices paired yet."), { exact: true }).count(), 0, "a list of such devices alone is not empty");
        assert.equal(await page.locator(".devices-revoke-all").count(), 0, "such devices alone offer no Revoke all");
        assert.equal(await joined.getByRole("button", { name: label("Revoke {name}").replace("{name}", "Galaxy S25"), exact: true }).count(), 1, "the row has its own Revoke");
        // this device's row wears three pills: its kind, the account, and this device; each whole, in the name, clear of the buttons
        const self = page.locator(ROW, { hasText: "iPhone · Safari" });
        // the button waits for the relay's status, read apart from the device list
        const relayButton = self.getByRole("button", { name: label("Use the relay"), exact: true });
        if (phone) await relayButton.waitFor();
        assert.equal(await relayButton.count(), phone ? 1 : 0, "only a touch phone's own row offers Use the relay");
        const pills = await self.evaluate((row) => {
          const name = row.querySelector(".devices-name")!.getBoundingClientRect();
          const buttons = [...row.querySelectorAll(".devices-actions > *")].map((button) => button.getBoundingClientRect());
          return [...row.querySelectorAll<HTMLElement>(".devices-kind, .devices-current")].map((pill) => {
            const box = pill.getBoundingClientRect();
            const clearOfButtons = buttons.every((button) => box.right <= button.left + 0.5 || box.left >= button.right - 0.5 || box.bottom <= button.top + 0.5 || box.top >= button.bottom - 0.5);
            return { text: pill.textContent, inName: box.left >= name.left - 0.5 && box.right <= name.right + 0.5, clearOfButtons, whole: pill.scrollWidth <= pill.clientWidth + 0.5 };
          });
        });
        // a row's buttons leave its name room for whole words: none breaks across two lines ("Connecte/d")
        const brokenWords = await page.locator(`${ROW} .devices-name`).evaluateAll((names) => names.flatMap((name) => {
          const broken: string[] = [];
          const walker = document.createTreeWalker(name, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            for (const word of (node.textContent ?? "").matchAll(/\S+/g)) {
              const range = document.createRange();
              range.setStart(node, word.index);
              range.setEnd(node, word.index + word[0].length);
              if (new Set([...range.getClientRects()].map((line) => Math.round(line.top))).size > 1) broken.push(word[0]);
            }
          }
          return broken;
        }));
        assert.deepEqual(brokenWords, [], `no word in a device row breaks across lines at ${width}`);
        assert.deepEqual(pills.map((pill) => pill.text), [label("Phone"), label("Through your account"), label("This device now")], "this device's row has its three pills");
        for (const pill of pills) assert.deepEqual({ inName: pill.inName, clearOfButtons: pill.clearOfButtons, whole: pill.whole }, { inName: true, clearOfButtons: true, whole: true }, `the pill ${pill.text} fits at ${width}`);
        assert.deepEqual(await overflow(page), [], "the pills fit the rows");
        await reveal(joined);
        await capture(page, `${prefix}-account`, about("account"));
        // renaming keeps the name field and its Save and Cancel inside the row
        await press(self.getByRole("button", { name: label("Rename {name}").replace("{name}", "iPhone · Safari"), exact: true }));
        const renaming = page.locator(`${ROW} .devices-rename`);
        await renaming.waitFor();
        const outside = await renaming.evaluate((form) => {
          const row = form.closest("li")!.getBoundingClientRect();
          return [...form.querySelectorAll<HTMLElement>("input, button")].filter((part) => {
            const box = part.getBoundingClientRect();
            return box.left < row.left - 0.5 || box.right > row.right + 0.5;
          }).map((part) => part.getAttribute("aria-label"));
        });
        assert.deepEqual(outside, [], `the rename field and its buttons fit the row at ${width}`);
        await press(renaming.getByRole("button", { name: label("Cancel"), exact: true }));
        await renaming.waitFor({ state: "detached" });
        await page.close();
      }

      {
        const { page, errors } = await open(context, server.port, "&demo_devices=slow");
        errorsOf.push(errors);
        const loading = page.locator(".devices-panel [role='status']", { hasText: label("Loading…") });
        await loading.waitFor();
        await page.locator(".devices-panel").evaluate((node) => node.scrollIntoView({ block: "end" }));
        await capture(page, `${prefix}-loading`, about("loading"));
        assert.equal(await page.locator(ROW).count(), 0, "no device row was drawn while the loading state was captured");
        assert.equal(await loading.isVisible(), true, "the loading line is still up after the capture");
        await page.evaluate(() => (globalThis as { herdrDemoReleaseDevices?: () => void }).herdrDemoReleaseDevices!());
        await page.locator(ROW).first().waitFor();
        assert.equal(await loading.count(), 0, "the loading line goes once the list arrives");
        await page.close();
      }

      {
        // the fictional phone waits until it is let go (site/demo/transport.ts `demo_pairing=held`), so the
        // code is seen before its enrollment takes it away
        const { page, errors } = await open(context, server.port, "&demo_pairing=held");
        errorsOf.push(errors);
        const notice = page.locator(NOTICE);
        const letPhonePair = async (): Promise<void> => assert.equal(await page.evaluate(() => (globalThis as { herdrDemoReleasePairing?: () => boolean }).herdrDemoReleasePairing!()), true, "a pairing was waiting to be let go");
        await startCode(page);
        await shownCode(page).filter({ hasText: "482 913" }).waitFor();
        assert.equal(await notice.count(), 0, "nothing is announced before the device enrolls");
        await letPhonePair();
        await notice.waitFor({ state: "attached", timeout: PAIRS_WITHIN_MS });
        await page.getByText(label("Paired: {name}.").replace("{name}", "Living-room iPad"), { exact: true }).waitFor();
        await closeSettings(page);
        assert.equal(await shownCode(page).count(), 0, "the code goes once the device paired with it");
        await notice.waitFor({ state: "visible" });
        assert.equal(await notice.count(), 1, "one line per enrollment");
        const text = (await notice.innerText()).replace(/\s+/g, " ").trim();
        assert.ok(text.includes("Living-room iPad"), `the line names the device: ${text}`);
        const tail = label("A new device was paired at {time}: {name}. If that was not you, revoke it.").split("{name}.")[1]!.trim();
        assert.ok(text.includes(tail), `the line carries the warning in words: ${text}`);
        await capture(page, `${prefix}-notice`, about("notice"));
        measurements[prefix]!.noticeButtons = await buttons(page, `${NOTICE} button`);
        measurements[prefix]!.noticeCopy = await contrast(page, `${NOTICE} span`);
        measurements[prefix]!.noticeGlyph = await contrast(page, `${NOTICE} > svg`);
        measurements[prefix]!.noticeDismissGlyph = await contrast(page, `${NOTICE} .update-notice-dismiss`);
        measurements[prefix]!.noticeActionText = await contrast(page, `${NOTICE} .device-paired-actions .btn`);
        measurements[prefix]!.noticeActionEdge = await contrast(page, `${NOTICE} .device-paired-actions .btn`, "border-top-color");
        assert.deepEqual(await overflow(page), [], "the notice fits");
        if (phone) {
          const targets = await touchTargets(page, `${NOTICE} button`);
          for (const target of targets) assert.ok(target.width >= 44 - SUBPIXEL && target.height >= 44 - SUBPIXEL, `${target.label}: ${target.width}x${target.height} is a 44 px target`);
        }
        await press(notice.getByRole("button", { name: label("Devices and PCs"), exact: true }));
        await page.locator(".settings-dialog").waitFor();
        assert.equal((await page.locator(".settings-dialog .modal-title").innerText()).trim(), label("Devices and PCs"));
        assert.equal(await notice.count(), 0, "opening Devices and PCs dismisses the line");
        await page.locator(ROW).nth(3).waitFor();
        assert.equal(await page.locator(ROW).count(), 4, "the new device is on the list");
        await startCode(page);
        await shownCode(page).filter({ hasText: /^\d{3} \d{3}$/ }).waitFor();
        await letPhonePair();
        await notice.waitFor({ state: "attached", timeout: PAIRS_WITHIN_MS });
        await closeSettings(page);
        await press(notice.getByRole("button", { name: label("Dismiss"), exact: true }));
        await notice.waitFor({ state: "detached" });
        await page.close();
      }

      {
        const { page, errors } = await open(context, server.port, "&demo_connection=drops&demo_pairing=held");
        errorsOf.push(errors);
        const notice = page.locator(NOTICE);
        await startCode(page);
        await shownCode(page).filter({ hasText: /^\d{3} \d{3}$/ }).waitFor();
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
      console.log(`PASS ${width}px ${theme} ${language}: caller warning, confirmation, refused write, watch, empty, a device through the account, loading, revocation, Check now in this PC's row and the pairing notice`);
    } finally {
      await context.close();
    }
  }
});
if (evidence) {
  writeFileSync(join(evidence, "device-security-manifest.json"), `${JSON.stringify({ captures: manifest, notCaptured }, null, 2)}\n`);
  writeFileSync(join(evidence, "device-security-measurements.json"), `${JSON.stringify(measurements, null, 2)}\n`);
  console.log(`captured ${manifest.length} states into ${evidence}`);
}
