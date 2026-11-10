/**
 * Find in a file's diff on the static demo (Files → Changes → src/money.ts): Ctrl/Cmd+F or the
 * header's Find opens a bar of the dialog's own; a query is matched literally over the loaded patch,
 * context included, with its count, the active match's kind and line in words, its row ringed and
 * its text painted; Enter, Shift+Enter, Next and Previous step across both sides and wrap; an absent
 * term and pattern punctuation find nothing; Escape closes Find and gives the focus back, then the
 * viewer; a binary file leaves Find off; no request leaves the page while searching, and the
 * terminal's own find never opens. At 1440 and on a phone (390, DPR 3, touch), light and dark, and
 * in Korean on the phone; with UI_EVIDENCE_DIR set, each state is captured there as
 * `diff-find-<width>-<theme>[-ko]-<state>.png`. On an iPad (1180 and 820, touch, the platform iPadOS
 * reports) the focused query is at least 16px, the size under which Safari zooms the page into a field.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const evidence = process.env.UI_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
const HINT = { en: "Searches this loaded patch, including context. Content outside the patch is not searched.", ko: "불러온 이 패치를 문맥까지 포함해\u00a0검색합니다. 패치 밖의 내용은 검색하지\u00a0않습니다." } as const;
type Language = keyof typeof HINT;

/** The bar as a user reads it: the count, the active match's place, the hint, the ringed row and the painted text. */
async function bar(page: Page): Promise<{ count: string; place: string; hint: string; ringed: string[]; painted: string[] }> {
  return page.evaluate(() => {
    const status = document.querySelector(".repo-diff-find .find-bar-count");
    const shadow = document.querySelector(".repo-diff diffs-container")?.shadowRoot;
    const highlight = CSS.highlights.get("repo-diff-find");
    return {
      count: [...(status?.childNodes ?? [])].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(""),
      place: document.querySelector(".repo-diff-find-place")?.textContent ?? "",
      hint: document.querySelector(".repo-diff-find .find-bar-hint")?.textContent ?? "",
      ringed: [...(shadow?.querySelectorAll<HTMLElement>("[data-line][data-find-active]") ?? [])].map((row) => `${row.dataset["lineType"]} ${row.dataset["line"]}`),
      painted: highlight ? [...highlight].map((range) => (range as Range).toString()) : [],
    };
  });
}
/** Waits for the bar to say `count` and `place` with the active row ringed and its text painted. */
async function settled(page: Page, count: string, place: string, step: string): Promise<{ ringed: string[]; painted: string[] }> {
  try {
    await page.waitForFunction(([count, place]) => {
      const status = [...(document.querySelector(".repo-diff-find .find-bar-count")?.childNodes ?? [])].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join("");
      const ringed = document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelectorAll("[data-line][data-find-active]").length ?? 0;
      return status === count && (document.querySelector(".repo-diff-find-place")?.textContent ?? "") === place && ringed === (place === "" ? 0 : 1) && (CSS.highlights.get("repo-diff-find")?.size ?? 0) === (place === "" ? 0 : 1);
    }, [count, place] as const);
  } catch (error) {
    throw new Error(`${step}: the bar never said ${count} / ${place}: ${JSON.stringify(await bar(page))}`, { cause: error });
  }
  return bar(page);
}
/**
 * A sheet rising or dropping (a closed one is drawn until its slide ends, lib/sheets.ts) or a button's
 * hover fading would be caught at a moment of its own: every finite animation ends first, then any
 * transition still running is taken to its end for the shot.
 */
async function shot(page: Page, name: string, state: string): Promise<void> {
  if (!evidence) return;
  await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined))));
  await page.screenshot({ path: join(evidence, `diff-find-${name}-${state}.png`), animations: "disabled" });
}
/**
 * The page's clock is Playwright's (installed before the load, it runs on its own): run past the demo's
 * one-shot turn completion (site/demo/transport.ts, 4500 ms after load), so every shot shows its
 * finished status, and its finish droplet is not drawn, as in terminal-keyboard-demo-regression.ts.
 */
async function pastDemoTurn(page: Page): Promise<void> {
  await page.clock.runFor(5_000);
  await page.addStyleTag({ content: ".droplet { visibility: hidden !important; }" });
}
/** Files → Changes → a file's diff, from the header on a computer or More on a phone. */
async function openDiff(page: Page, phone: boolean, path: string): Promise<void> {
  if (!(await page.getByRole("dialog", { name: "Files", exact: true }).isVisible())) {
    if (phone) {
      await page.locator(".header-more-button").tap();
      await page.getByRole("dialog", { name: "More", exact: true }).getByRole("button", { name: "Browse files", exact: true }).tap();
    } else await page.locator(".header-files-button").click();
    await page.getByRole("dialog", { name: "Files", exact: true }).waitFor();
    await page.getByRole("button", { name: "Changes", exact: true }).click();
  }
  await page.locator(".repo-changes:not([aria-busy='true']) .repo-change").first().waitFor();
  await page.locator(".repo-change").filter({ has: page.locator(".repo-change-path", { hasText: path }) }).first().click();
  await page.locator(".repo-diff-viewer").waitFor();
}
async function rows(page: Page): Promise<void> {
  await page.waitForFunction(() => (document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelectorAll("[data-line]").length ?? 0) > 0);
}

async function check(browser: Browser, origin: string, width: 390 | 1440, theme: "light" | "dark", language: Language): Promise<void> {
  const phone = width === 390;
  const name = `${width}-${theme}${language === "ko" ? "-ko" : ""}`;
  const label = `${width}px ${theme} ${language}`;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, colorScheme: theme, locale: language === "ko" ? "ko-KR" : "en-US" });
  try {
    // English to reach the diff by name; a Korean run switches its language once the diff is open (a reload restores it)
    await context.addInitScript((theme) => { if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme })); }, theme);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    await page.clock.install();
    await page.goto(origin);
    await pastDemoTurn(page);
    await openDiff(page, phone, "src/money.ts");
    if (language === "ko") {
      await page.evaluate((theme) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "ko", theme })), theme);
      await page.reload();
      await pastDemoTurn(page);
      await page.locator(".repo-diff-viewer").waitFor();
    }
    await rows(page);
    const findButton = page.locator(".repo-diff-group .repo-diff-action").first();
    const query = page.locator(".repo-diff-find input");
    const [previous, next] = [page.locator(".repo-diff-find .find-bar-controls button").nth(0), page.locator(".repo-diff-find .find-bar-controls button").nth(1)];
    assert.equal(await findButton.getAttribute("aria-label"), language === "ko" ? "변경 내용에서 찾기" : "Find in diff", `${label}: the header's first action is Find`);
    await shot(page, name, "rest");
    if (!phone) {
      await findButton.hover();
      await shot(page, name, "hover");
    }

    // the diff and file requests the page makes while it searches: none (the demo's transport answers /api/ in the page; the app's own polling goes on)
    await page.evaluate(() => {
      const record = window as unknown as { findRequests: string[] };
      record.findRequests = [];
      const own = window.fetch;
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (/\/workspace\/diff\/|\/fs\//.test(url)) record.findRequests.push(url);
        return own(input, init);
      }) as typeof window.fetch;
    });
    if (!phone) {
      // the palette over the diff keeps Ctrl/Cmd+F and its typing: Find stays closed underneath
      const palette = page.locator(".command-palette input");
      await page.keyboard.press("ControlOrMeta+Shift+K");
      await palette.waitFor();
      await page.keyboard.press("ControlOrMeta+f");
      await page.keyboard.type("amount");
      assert.equal(await palette.inputValue(), "amount", `${label}: the palette keeps what was typed`);
      assert.equal(await query.count(), 0, `${label}: Find stays closed under the palette`);
      await page.keyboard.press("Escape");
      await palette.waitFor({ state: "detached" });
      await page.locator(".repo-diff-viewer").waitFor();
    }
    if (phone) await findButton.tap();
    else await page.keyboard.press("ControlOrMeta+f");
    await query.waitFor();
    assert.equal(await query.evaluate((input) => input === document.activeElement), true, `${label}: the query has the focus`);
    assert.equal(await page.locator('.find-bar[aria-label="Find in terminal"]').count(), 0, `${label}: the terminal's find stays closed`);
    assert.equal(await findButton.getAttribute("aria-pressed"), "true", `${label}: Find shows as on`);
    assert.equal((await bar(page)).hint, HINT[language], `${label}: the bar says what it searches`);
    await shot(page, name, "empty");
    await shot(page, name, "pressed");

    if (language === "ko") {
      await query.fill("amount");
      await settled(page, "4개 중 1", "변경 없는 줄 4", `${label} first`);
      await shot(page, name, "context");
      await query.press("Enter");
      await settled(page, "4개 중 2", "삭제된 줄 4", `${label} removed`);
      await shot(page, name, "deleted");
      await query.press("Enter");
      await settled(page, "4개 중 3", "추가된 줄 5", `${label} added`);
      await shot(page, name, "added");
      await query.fill("zzz");
      await page.locator(".repo-diff-find .find-bar-count").filter({ hasText: "검색 결과 없음" }).waitFor();
      await shot(page, name, "no-match");
      await query.fill("x".repeat(300));
      await shot(page, name, "long");
    } else {
      // "amount": an unchanged line, the removed line and two added lines, in the patch's order
      await query.fill("amount");
      let at = await settled(page, "1 of 4", "Unchanged line 4", `${label} first`);
      assert.deepEqual([at.ringed, at.painted], [["context 4"], ["amount"]], `${label}: the first hit is the unchanged line`);
      await shot(page, name, "context");
      await query.press("Enter");
      at = await settled(page, "2 of 4", "Removed line 4", `${label} removed`);
      assert.deepEqual(at.ringed, ["change-deletion 4"], `${label}: the second is the removed line`);
      await shot(page, name, "deleted");
      await query.press("Enter");
      at = await settled(page, "3 of 4", "Added line 5", `${label} added`);
      assert.deepEqual(at.ringed, ["change-addition 5"], `${label}: the third is an added line`);
      await shot(page, name, "added");
      await query.press("Enter");
      await settled(page, "4 of 4", "Added line 7", `${label} last`);
      await query.press("Enter");
      await settled(page, "1 of 4", "Unchanged line 4", `${label} wraps forward`);
      await query.press("Shift+Enter");
      await settled(page, "4 of 4", "Added line 7", `${label} wraps back`);
      // the buttons step as Enter does; a keyboard reaches them with Tab, ringed
      await query.press("Tab");
      assert.equal(await previous.evaluate((button) => button === document.activeElement && button.matches(":focus-visible")), true, `${label}: Tab reaches Previous, focus-visible`);
      await shot(page, name, "focus");
      if (phone) await next.tap();
      else {
        await next.hover();
        await shot(page, name, "hover-next");
        await page.mouse.down();
        await shot(page, name, "pressed-next");
        await page.mouse.up();
      }
      await settled(page, "1 of 4", "Unchanged line 4", `${label} Next`);
      if (phone) await previous.tap();
      else await previous.click();
      await settled(page, "4 of 4", "Added line 7", `${label} Previous`);
      // literal: pattern punctuation is text, case counts, an absent term finds nothing
      await query.fill("Math.abs(");
      at = await settled(page, "1 of 1", "Added line 5", `${label} punctuation`);
      assert.deepEqual(at.painted, ["Math.abs("], `${label}: the literal text is painted`);
      await query.fill("export type Cents");
      await settled(page, "1 of 1", "Unchanged line 1", `${label} context`);
      for (const absent of [".*", "[a-z]+", "AMOUNT", "zzz"]) {
        await query.fill(absent);
        await settled(page, "No matches", "", `${label} ${absent}`);
        assert.equal(await next.isDisabled(), true, `${label}: nothing to step to for ${absent}`);
      }
      await shot(page, name, "no-match");
      await query.fill("x".repeat(300));
      await settled(page, "No matches", "", `${label} long`);
      const fits = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth, bar: document.querySelector(".repo-diff-find")!.getBoundingClientRect().right }));
      assert.ok(fits.page <= fits.viewport && fits.bar <= fits.viewport + 0.5, `${label}: a long query scrolls in its field: ${JSON.stringify(fits)}`);
      await shot(page, name, "long");
      if (!phone) {
        // the same match in split
        await query.fill("amount");
        await settled(page, "1 of 4", "Unchanged line 4", `${label} split first`);
        await query.press("Enter");
        await page.getByRole("button", { name: "Split", exact: true }).click();
        await page.waitForFunction(() => document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelector("pre")?.getAttribute("data-diff-type") === "split");
        at = await settled(page, "2 of 4", "Removed line 4", `${label} split`);
        assert.equal(await page.evaluate(() => document.querySelector(".repo-diff diffs-container")!.shadowRoot!.querySelector("[data-find-active]")!.closest("code")!.hasAttribute("data-deletions")), true, `${label}: split rings the old side`);
        await shot(page, name, "split-deleted");
        await query.press("Enter");
        await settled(page, "3 of 4", "Added line 5", `${label} split added`);
        await shot(page, name, "split-added");
        await page.getByRole("button", { name: "Unified", exact: true }).click();
        await settled(page, "3 of 4", "Added line 5", `${label} unified again`);
      }
      assert.deepEqual(await page.evaluate(() => (window as unknown as { findRequests: string[] }).findRequests), [], `${label}: searching sent no request`);
      // Escape closes Find and gives the focus back, then the viewer
      await page.keyboard.press("Escape");
      await query.waitFor({ state: "detached" });
      await page.locator(".repo-diff-viewer").waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.closest(".repo-diff-viewer") !== null), true, `${label}: the focus stays in the viewer`);
      assert.deepEqual((await bar(page)).ringed, [], `${label}: no row stays ringed`);
      assert.equal(await findButton.getAttribute("aria-pressed"), "false", `${label}: Find shows as off`);
      await page.keyboard.press("Escape");
      await page.locator(".repo-diff-viewer").waitFor({ state: "detached" });
      // a binary file has no lines to search: Find is off, and Ctrl/Cmd+F opens nothing
      await openDiff(page, phone, "docs/checkout-flow.png");
      await page.locator(".repo-diff-note").filter({ hasText: "This is a binary file; there are no lines to compare." }).waitFor();
      assert.equal(await findButton.isDisabled(), true, `${label}: Find is off for a binary file`);
      assert.equal(await findButton.getAttribute("title"), "There is no loaded patch to search.", `${label}: and says why`);
      if (!phone) {
        await page.keyboard.press("ControlOrMeta+f");
        assert.equal(await query.count(), 0, `${label}: Ctrl/Cmd+F opens nothing without a patch`);
      }
      await shot(page, name, "disabled");
    }
    assert.deepEqual(errors, [], `${label}: no errors`);
    console.log(`PASS ${label}: find counts, steps, wraps, rings and paints the match, explains its scope${language === "en" ? ", takes text literally, closes before the viewer and stays off without a patch" : ""}`);
  } finally {
    await context.close();
  }
}

/**
 * An iPad in its wide layout (#3483): the query a tap on the header's Find focuses, or a tap on the query itself,
 * is 16px while it has the focus, the size from which Safari does not zoom the page into a field, and the
 * interface's size again once the focus leaves. An interface size over 16px is kept as it is. Chromium stands
 * in for Safari here: the platform and its touch points are the ones iPadOS reports, and the size is what
 * Safari would read; its zoom itself is not exercised.
 */
async function checkIpad(browser: Browser, origin: string, width: 1180 | 820, uiFontSize: number | null): Promise<void> {
  const label = `iPad ${width}px${uiFontSize === null ? "" : ` at a ${uiFontSize}px interface`}`;
  const context = await browser.newContext({ viewport: { width, height: width === 1180 ? 820 : 1180 }, deviceScaleFactor: 2, hasTouch: true });
  try {
    await context.addInitScript((uiFontSize) => {
      Object.defineProperty(Navigator.prototype, "platform", { configurable: true, get: () => "MacIntel" });
      Object.defineProperty(Navigator.prototype, "maxTouchPoints", { configurable: true, get: () => 5 });
      if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", ...(uiFontSize === null ? {} : { uiFontSize }) }));
    }, uiFontSize);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    await page.clock.install();
    await page.goto(origin);
    await pastDemoTurn(page);
    await openDiff(page, false, "src/money.ts");
    await rows(page);
    const query = page.locator(".repo-diff-find input");
    const size = () => query.evaluate((input) => getComputedStyle(input).fontSize);
    const rest = uiFontSize === null ? "14px" : `${uiFontSize}px`;
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).fontSize), rest, `${label}: the interface's body size`);
    const armed = uiFontSize === null ? "16px" : `${uiFontSize}px`;
    await page.locator(".repo-diff-group .repo-diff-action").first().tap();
    await query.waitFor();
    assert.equal(await query.evaluate((input) => input === document.activeElement), true, `${label}: Find gives the query the focus`);
    assert.equal(await size(), armed, `${label}: the query Find focuses`);
    await shot(page, `ipad-${width}${uiFontSize === null ? "" : `-${uiFontSize}px`}`, "focused");
    await query.evaluate((input: HTMLElement) => input.blur());
    assert.equal(await size(), rest, `${label}: the interface size once the focus leaves`);
    await query.tap();
    assert.equal(await query.evaluate((input) => input === document.activeElement), true, `${label}: a tap gives the query the focus`);
    assert.equal(await size(), armed, `${label}: the query a tap focuses`);
    assert.deepEqual(errors, [], `${label}: no errors`);
    console.log(`PASS ${label}: the focused Find in diff query is ${armed}, ${rest} at rest`);
  } finally {
    await context.close();
  }
}

const app = mkdtempSync(join(tmpdir(), "herdr-diff-find-demo-"));
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => '<script src="./demo-transport.js"></script>\n    <script type="module"'));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const prefix = "/herdr-web-ui/demo/app/";
    if (!path.startsWith(prefix) && !path.startsWith("/icons/")) return new Response("not found", { status: 404 });
    let file = decodeURIComponent(path.startsWith("/icons/") ? path.slice(1) : path.slice(prefix.length));
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const origin = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;
  for (const [width, theme, language] of [[1440, "dark", "en"], [1440, "light", "en"], [390, "dark", "en"], [390, "light", "en"], [390, "light", "ko"], [390, "dark", "ko"]] as const) {
    await check(browser, origin, width, theme, language);
  }
  for (const [width, uiFontSize] of [[1180, null], [820, null], [1180, 20]] as const) await checkIpad(browser, origin, width, uiFontSize);
  console.log("diff find: demo OK (count, steps, wrap, ring and paint, scope hint, literal text, Escape order, no patch, no requests, Korean, the iPad's field size)");
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
