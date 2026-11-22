/** Usage: bun scripts/sidebar-machine-removal-demo-regression.ts */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
import { prepareMachineControlsDemo } from "./sidebar-machine-controls-fixture.ts";
import { SUPPORTED_ENTRIES } from "../src/lib/themes.ts";
import { serveDemo } from "./demo-server.ts";

const app = mkdtempSync(join(tmpdir(), "herdr-sidebar-machine-removal-"));
const evidenceDir = process.env.UI_EVIDENCE_DIR;
const REMOTE_NAME = "Demo remote PC";
const RENAME_LABEL = "Rename…";
const REMOVE_ITEM = "Remove PC…";
const CONFIRM_LABEL = "Remove PC";
const REMOVE_EXPLANATION = "Removes this registration. Remote sessions keep running.";

interface Scenario { theme: "dark" | "light" }

const scenarios: Scenario[] = [{ theme: "dark" }, { theme: "light" }];
const machineGroup = (page: Page): Locator => page.locator(".machine-group").filter({ has: page.locator(".machine-name", { hasText: REMOTE_NAME }) });

async function fixtureValue(page: Page, key: string): Promise<unknown> {
  return page.evaluate((path) => {
    const fixture = (window as unknown as { machineControlsFixture: { calls: Record<string, unknown> } }).machineControlsFixture;
    let value: unknown = fixture;
    for (const part of path.split(".")) {
      if (typeof value !== "object" || value === null) return null;
      value = (value as Record<string, unknown>)[part];
    }
    return value;
  }, key);
}

interface DangerStyle {
  textContrast: number;
  borderContrast: number;
  tintMatches: boolean;
  borderMatches: boolean;
  textMatches: boolean;
  opacity: number;
  focusVisible: boolean;
  borderColor: string;
  outlineStyle: string;
  outlineWidth: number;
  boxShadow: string;
}

async function dangerStyle(button: Locator): Promise<DangerStyle> {
  return button.evaluate((element) => {
    interface Color { r: number; g: number; b: number; a: number }
    const parseColor = (source: string): Color => {
      const value = source.trim();
      const hex = value.match(/^#([\da-f]{3,8})$/i)?.[1];
      if (hex) {
        const expanded = hex.length === 3 || hex.length === 4 ? [...hex].map((part) => `${part}${part}`).join("") : hex;
        return {
          r: Number.parseInt(expanded.slice(0, 2), 16),
          g: Number.parseInt(expanded.slice(2, 4), 16),
          b: Number.parseInt(expanded.slice(4, 6), 16),
          a: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
        };
      }
      const numbers = value.match(/[\d.]+/g)?.map(Number);
      if (!numbers || numbers.length < 3) throw new Error(`Unsupported computed color: ${source}`);
      return { r: numbers[0]!, g: numbers[1]!, b: numbers[2]!, a: numbers.length > 3 ? numbers[3]! : 1 };
    };
    const composite = (front: Color, back: Color): Color => {
      const a = front.a + back.a * (1 - front.a);
      if (!a) return { r: 0, g: 0, b: 0, a: 0 };
      return {
        r: (front.r * front.a + back.r * back.a * (1 - front.a)) / a,
        g: (front.g * front.a + back.g * back.a * (1 - front.a)) / a,
        b: (front.b * front.a + back.b * back.a * (1 - front.a)) / a,
        a,
      };
    };
    const linear = (channel: number) => { const value = channel / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
    const luminance = (color: Color) => 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
    const contrast = (first: Color, second: Color) => {
      const a = luminance(first), b = luminance(second);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const same = (first: Color, second: Color) => Math.abs(first.r - second.r) < 1 && Math.abs(first.g - second.g) < 1 && Math.abs(first.b - second.b) < 1 && Math.abs(first.a - second.a) < 0.01;
    const style = getComputedStyle(element);
    const panel = element.closest(".modal");
    if (!panel) throw new Error("danger button is outside its dialog");
    const panelBackground = parseColor(getComputedStyle(panel).backgroundColor);
    const buttonBackground = parseColor(style.backgroundColor);
    const text = parseColor(style.color);
    const border = parseColor(style.borderTopColor);
    const opacity = Number.parseFloat(style.opacity);
    const paintedBackground = composite(buttonBackground, panelBackground);
    const actualBackground = composite({ ...paintedBackground, a: paintedBackground.a * opacity }, panelBackground);
    const paintedText = composite(text, paintedBackground);
    const actualText = composite({ ...paintedText, a: paintedText.a * opacity }, panelBackground);
    const paintedBorder = composite(border, paintedBackground);
    const actualBorder = composite({ ...paintedBorder, a: paintedBorder.a * opacity }, panelBackground);
    const expectedTint = parseColor(getComputedStyle(document.documentElement).getPropertyValue("--danger-tint"));
    const expectedBorder = parseColor(getComputedStyle(document.documentElement).getPropertyValue("--status-blocked"));
    const expectedText = parseColor(getComputedStyle(document.documentElement).getPropertyValue("--danger-text"));
    const focus = getComputedStyle(element);
    return {
      textContrast: contrast(actualText, actualBackground),
      borderContrast: contrast(actualBorder, actualBackground),
      tintMatches: same(buttonBackground, expectedTint),
      borderMatches: same(border, expectedBorder),
      textMatches: same(text, expectedText),
      opacity,
      focusVisible: element.matches(":focus-visible"),
      borderColor: style.borderTopColor,
      outlineStyle: focus.outlineStyle,
      outlineWidth: Number.parseFloat(focus.outlineWidth) || 0,
      boxShadow: focus.boxShadow,
    };
  });
}

async function settleButton(button: Locator): Promise<void> {
  await button.evaluate(async (element) => {
    // Flush the interaction's style change before discovering its CSS transitions.
    void getComputedStyle(element).backgroundColor;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
}

async function checkDangerPresentation(page: Page, theme: Scenario["theme"], stage: string, button: Locator): Promise<void> {
  await page.mouse.move(0, 0);
  await button.evaluate((element) => (element as HTMLElement).blur());
  await settleButton(button);
  const normal = await dangerStyle(button);
  await button.hover();
  await settleButton(button);
  const hover = await dangerStyle(button);
  await page.mouse.move(0, 0);
  await button.evaluate((element) => (element as HTMLElement).blur());
  await button.focus();
  await page.keyboard.press("Shift");
  await settleButton(button);
  const focus = await dangerStyle(button);

  for (const [state, style] of [["normal", normal], ["hover", hover], ["focus", focus]] as const) {
    assert.ok(style.tintMatches, `${theme} ${stage} ${state} keeps the danger tint token: ${JSON.stringify(style)}`);
    assert.ok(style.borderMatches, `${theme} ${stage} ${state} keeps the blocked border token: ${JSON.stringify(style)}`);
    assert.ok(style.textMatches, `${theme} ${stage} ${state} keeps the danger text token: ${JSON.stringify(style)}`);
    assert.ok(style.textContrast >= 4.5, `${theme} ${stage} ${state} text contrast is ${style.textContrast.toFixed(2)}:1`);
    assert.ok(style.borderContrast >= 3, `${theme} ${stage} ${state} border contrast is ${style.borderContrast.toFixed(2)}:1`);
    console.log(`CONTRAST ${theme} ${stage} ${state}: text ${style.textContrast.toFixed(2)}:1, border ${style.borderContrast.toFixed(2)}:1`);
  }
  assert.notEqual(hover.boxShadow, normal.boxShadow, `${theme} ${stage} hover shows on the danger button: ${JSON.stringify({ normal, hover })}`);
  assert.ok(hover.boxShadow.includes(hover.borderColor) && hover.boxShadow.includes("inset"), `${theme} ${stage} the hover ring is drawn inside, in the button's own border color: ${JSON.stringify(hover)}`);
  assert.ok(focus.focusVisible && (focus.outlineStyle !== "none" && focus.outlineWidth > 0 || focus.boxShadow !== "none"), `${theme} ${stage} danger button has a visible keyboard focus indicator: ${JSON.stringify(focus)}`);
}

async function checkEveryPalette(button: Locator, theme: Scenario["theme"]): Promise<void> {
  const page = button.page();
  const shown = await page.evaluate(() => document.documentElement.dataset.palette);
  for (const { id: palette } of SUPPORTED_ENTRIES.filter((entry) => entry.mode === theme)) {
    await page.evaluate((palette) => { document.documentElement.dataset.palette = palette; }, palette);
    await settleButton(button);
    const themed = await dangerStyle(button);
    assert.ok(themed.tintMatches && themed.borderMatches && themed.textMatches, `${palette} ${theme} Remove PC keeps its danger tokens: ${JSON.stringify(themed)}`);
    assert.ok(themed.textContrast >= 4.5, `${palette} ${theme} Remove PC text stays readable: ${themed.textContrast.toFixed(2)}:1`);
    assert.ok(themed.borderContrast >= 3, `${palette} ${theme} Remove PC border stays visible: ${themed.borderContrast.toFixed(2)}:1`);
    console.log(`CONTRAST ${palette} ${theme} Remove PC: text ${themed.textContrast.toFixed(2)}:1, border ${themed.borderContrast.toFixed(2)}:1`);
  }
  await page.evaluate((palette) => { if (palette === undefined) delete document.documentElement.dataset.palette; else document.documentElement.dataset.palette = palette; }, shown);
}

async function checkDangerItem(item: Locator, theme: Scenario["theme"]): Promise<void> {
  const contrast = await item.evaluate((element) => {
    const parse = (source: string) => { const numbers = source.match(/[\d.]+/g)!.map(Number); return { r: numbers[0]!, g: numbers[1]!, b: numbers[2]! }; };
    const linear = (channel: number) => { const value = channel / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
    const luminance = (color: { r: number; g: number; b: number }) => 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
    const text = luminance(parse(getComputedStyle(element).color));
    const back = luminance(parse(getComputedStyle(element.closest(".menu")!).backgroundColor));
    return (Math.max(text, back) + 0.05) / (Math.min(text, back) + 0.05);
  });
  assert.ok(contrast >= 4.5, `${theme} Remove PC… text on the menu is ${contrast.toFixed(2)}:1`);
  console.log(`CONTRAST ${theme} Remove PC… item: ${contrast.toFixed(2)}:1`);
}

async function capture(target: Locator, scenario: Scenario, state: "menu" | "confirm"): Promise<void> {
  if (!evidenceDir) return;
  await target.screenshot({ path: join(evidenceDir, `sidebar-machine-removal-${scenario.theme}-${state}.png`) });
}

async function openMenu(page: Page, group: Locator): Promise<Locator> {
  await group.locator(".machine-header").hover();
  await group.locator(".machine-manage").click();
  const menu = page.locator(".row-menu");
  await menu.waitFor({ state: "visible" });
  return menu;
}

async function withScenario(browser: Awaited<ReturnType<typeof chromium.launch>>, url: string, scenario: Scenario): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", deviceScaleFactor: 1 });
  const errors: string[] = [];
  try {
    await context.addInitScript((theme) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme, density: "comfortable", defaultView: "chat" }));
      localStorage.setItem("ovis:sidebar-width", "520");
    }, scenario.theme);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    assert.equal(await page.locator("html").getAttribute("data-theme"), scenario.theme, `${scenario.theme} theme is active`);

    const group = machineGroup(page);
    await group.waitFor({ state: "attached" });
    let menu = await openMenu(page, group);
    const removeItem = menu.getByRole("menuitem", { name: REMOVE_ITEM, exact: true });
    assert.match(await removeItem.getAttribute("class") ?? "", /\bis-danger\b/, `${scenario.theme} Remove PC… is a danger item`);
    await checkDangerItem(removeItem, scenario.theme);
    await capture(menu, scenario, "menu");

    await removeItem.click();
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor();
    assert.equal(await fixtureValue(page, "calls.deleteAttempts"), 0, `${scenario.theme} Remove PC… sends no DELETE`);
    assert.ok((await dialog.textContent() ?? "").includes(REMOVE_EXPLANATION), `${scenario.theme} the dialog says what removal affects`);
    const confirm = dialog.getByRole("button", { name: CONFIRM_LABEL, exact: true });
    assert.equal(await confirm.getAttribute("class"), "btn btn-danger", `${scenario.theme} the dialog's Remove PC is danger styled`);
    await capture(dialog, scenario, "confirm");
    await checkDangerPresentation(page, scenario.theme, "confirm", confirm);
    await checkEveryPalette(confirm, scenario.theme);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(await fixtureValue(page, "calls.deleteAttempts"), 0, `${scenario.theme} Cancel sends no DELETE`);

    menu = await openMenu(page, group);
    await menu.getByRole("menuitem", { name: RENAME_LABEL, exact: true }).click();
    const input = page.locator(".machine-rename-input");
    await input.fill("Renamed demo PC");
    await page.evaluate(() => (window as unknown as { machineControlsFixture: { holdNextMutation(): void } }).machineControlsFixture.holdNextMutation());
    await input.press("Enter");
    await page.waitForFunction(() => (window as unknown as { machineControlsFixture: { calls: { mutations: unknown[] } } }).machineControlsFixture.calls.mutations.length === 1);
    menu = await openMenu(page, group);
    assert.equal(await menu.getByRole("menuitem", { name: REMOVE_ITEM, exact: true }).getAttribute("aria-disabled"), "true", `${scenario.theme} Remove PC… waits while a rename runs`);
    assert.equal(await menu.getByRole("menuitem", { name: RENAME_LABEL, exact: true }).getAttribute("aria-disabled"), "true", `${scenario.theme} Rename… waits while a rename runs`);
    await menu.getByRole("menuitem", { name: REMOVE_ITEM, exact: true }).dispatchEvent("click");
    assert.equal(await page.getByRole("alertdialog").count(), 0, `${scenario.theme} a waiting Remove PC… opens nothing`);
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    await page.evaluate(() => (window as unknown as { machineControlsFixture: { releaseMutation(success: boolean): void } }).machineControlsFixture.releaseMutation(true));
    await page.locator(".machine-name", { hasText: "Renamed demo PC" }).waitFor();
    assert.equal(await fixtureValue(page, "calls.deleteAttempts"), 0, `${scenario.theme} a rename sends no DELETE`);

    const renamed = page.locator(".machine-group").filter({ has: page.locator(".machine-name", { hasText: "Renamed demo PC" }) });
    menu = await openMenu(page, renamed);
    await menu.getByRole("menuitem", { name: REMOVE_ITEM, exact: true }).click();
    await dialog.waitFor();
    await page.evaluate(() => (window as unknown as { machineControlsFixture: { holdNextMutation(): void } }).machineControlsFixture.holdNextMutation());
    await confirm.click();
    await page.waitForFunction(() => (window as unknown as { machineControlsFixture: { calls: { deleteAttempts: number } } }).machineControlsFixture.calls.deleteAttempts === 1);
    assert.equal(await confirm.isDisabled(), true, `${scenario.theme} confirmation stays disabled while DELETE is held`);
    assert.equal(await confirm.getAttribute("class"), "btn btn-danger", `${scenario.theme} the pending confirmation keeps its danger class`);
    await confirm.evaluate((button) => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.equal(await fixtureValue(page, "calls.deleteAttempts"), 1, `${scenario.theme} duplicate clicks while busy issue no additional DELETE`);

    await page.evaluate(() => (window as unknown as { machineControlsFixture: { releaseMutation(success: boolean): void } }).machineControlsFixture.releaseMutation(false));
    await dialog.getByRole("alert").waitFor();
    assert.match(await dialog.getByRole("alert").textContent() ?? "", /Fixture mutation rejected/);
    assert.equal(await renamed.count(), 1, `${scenario.theme} rejected removal retains the PC`);
    assert.equal(await renamed.getByRole("alert").count(), 0, `${scenario.theme} the failure is said in the dialog, not again under the PC`);
    assert.equal(await fixtureValue(page, "calls.deleteCount"), 0, `${scenario.theme} rejected DELETE is not counted as a successful removal`);
    assert.equal(await confirm.isDisabled(), false, `${scenario.theme} failed removal clears busy state`);

    await confirm.click();
    await renamed.waitFor({ state: "detached" });
    await dialog.waitFor({ state: "detached" });
    assert.equal(await fixtureValue(page, "calls.deleteAttempts"), 2, `${scenario.theme} one retry sends one additional DELETE`);
    assert.equal(await fixtureValue(page, "calls.deleteCount"), 1, `${scenario.theme} successful retry removes exactly once`);
    console.log(`PASS ${scenario.theme} PC removal styling, confirmation, busy guard, failure recovery and one successful retry`);
    assert.deepEqual(errors, [], `${scenario.theme} has no uncaught browser errors`);
  } finally {
    await context.close();
  }
}

let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
  await prepareMachineControlsDemo(app);
  server = serveDemo(app, { prefix: "/" });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const url = `http://127.0.0.1:${server.port}/`;
  for (const scenario of scenarios) await withScenario(browser, url, scenario);
  console.log("PASS sidebar machine removal visual and behavior regression");
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
