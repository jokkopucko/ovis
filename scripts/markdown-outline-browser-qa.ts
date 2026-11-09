/** The Markdown outline (#636), always on, in the real viewer, built with the app's CSP: column, drawer, docked, and a stored old "off" ignored; on a phone a stroke begun on a table, code, a diagram or a failed image still scrolls the document (#3287, #3475). */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { build as viteBuild } from "vite";
import { serveStatic } from "../server/static.ts";
import { chromePath } from "./chrome-path.ts";
import { sheetsSettled } from "./sheets-settled.ts";

// a title, then sections that each end in a "Notes" heading: the same title thirty times
const SECTIONS = 30;
const prose = "A paragraph long enough to wrap over a few lines of the preview, so each section takes room. ".repeat(4);
// a table and a code block: boxes that scroll sideways only, in the document's first screens
const table = ["| Name | Value |", "| --- | --- |", ...Array.from({ length: 12 }, (_, index) => `| row ${index + 1} | value ${index + 1} |`)].join("\n");
const code = ["```ts", ...Array.from({ length: 12 }, (_, index) => `const line${index + 1} = ${index + 1};`), "```"].join("\n");
// a diagram and an image that cannot load: boxes that clip their content, and scroll nothing
const mermaid = ["```mermaid", "flowchart TD", "  A[Start] --> B[Read]", "  B --> C[Write]", "  C --> D[Done]", "```"].join("\n");
// absolute: the fixture's document path (guide.md) has no folder to resolve a relative one against
const image = "![x](/missing.png)";
const markdown = ["# Guide", prose, table, code, mermaid, image, ...Array.from({ length: SECTIONS }, (_, index) => [
  `## Section ${index + 1}`, prose, prose, "### Notes", prose,
].join("\n\n"))].join("\n\n") + "\n";
const ENTRIES = 1 + SECTIONS * 2;

const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-markdown-outline-")));
const evidence = process.env.UI_EVIDENCE_DIR;
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

/** A page of the fixture at `width`×`height`, with the old outline switch stored as given (it is ignored now). */
async function open(width: number, height: number, { outline, theme = "dark", docked = false }: { outline: boolean; theme?: "dark" | "light"; docked?: boolean }): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const touch = width < 600;
  const context = await browser!.newContext({ viewport: { width, height }, isMobile: touch, hasTouch: touch, locale: "en-US" });
  await context.addInitScript(([outline, theme]) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme }));
    localStorage.setItem("ovis:markdown-outline", JSON.stringify(outline));
  }, [outline, theme] as const);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server!.port}/${docked ? "?docked" : ""}`);
  await page.locator(".file-viewer-markdown > h3").nth(ENTRIES - 1).waitFor();
  // the diagram is drawn once its chunk loads and the image gives up: both change the document's height
  await page.locator(".markdown-mermaid svg").waitFor();
  await page.locator(".image-slot.is-failed").waitFor();
  await sheetsSettled(page);
  return { page, errors, close: () => context.close() };
}

/** The document's scroll box brought to `index`'s heading, as a reader's scroll would; `markedAt` waits for the outline to follow. */
async function scrollToHeading(page: Page, index: number): Promise<void> {
  await page.evaluate((index) => {
    const body = document.querySelector<HTMLElement>(".file-viewer-body")!;
    const heading = document.querySelectorAll<HTMLElement>(".file-viewer-markdown > h3")[index]!;
    body.scrollTop += heading.getBoundingClientRect().top - body.getBoundingClientRect().top - 4;
  }, index);
}

/** Where the marked entry sits: its words, its center against the list's, and the list's scroll and range. */
function marked(page: Page) {
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(".markdown-outline")!;
    const item = list.querySelector<HTMLElement>("[aria-current]");
    const box = list.getBoundingClientRect();
    const rect = item?.getBoundingClientRect();
    return {
      text: item?.textContent ?? null,
      index: item === null ? -1 : [...list.querySelectorAll("button")].indexOf(item as HTMLButtonElement),
      offCenter: rect === undefined ? null : Math.abs((rect.top + rect.height / 2) - (box.top + list.clientTop + list.clientHeight / 2)),
      scrollTop: list.scrollTop,
      maxScroll: list.scrollHeight - list.clientHeight,
    };
  });
}

/** Waits until the marked entry is the `index`-th one. */
async function markedAt(page: Page, index: number): Promise<void> {
  await page.waitForFunction((index) => {
    const list = document.querySelector(".markdown-outline");
    const item = list?.querySelector("[aria-current]");
    return list !== null && item !== null && item !== undefined && [...list.querySelectorAll("button")].indexOf(item as HTMLButtonElement) === index;
  }, index);
}

try {
  const repo = join(import.meta.dir, ".."), output = join(root, "dist");
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repo, "scripts/markdown-outline-fixture.tsx"), join(root, "fixture.tsx"));
  writeFileSync(join(root, "index.html"), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  await viteBuild({ configFile: join(repo, "vite.config.ts"), root, publicDir: false, logLevel: "warn", build: { outDir: output, emptyOutDir: true } });
  const policy = (await serveStatic("/")).headers.get("content-security-policy");
  assert.ok(policy, "build the app before its enforcing CSP regression");
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url), path = url.searchParams.get("path");
    // the image is listed as one, but its bytes are gone: its slot stays, "Image unavailable"
    if (path?.endsWith("missing.png")) {
      if (url.pathname === "/api/fs/stat") return Response.json({ path, name: "missing.png", kind: "image", size: 100, mime: "image/png", modified: "2026-01-01T00:00:00Z" });
      if (url.pathname === "/api/fs/file") return new Response("gone", { status: 404 });
    }
    if (url.pathname === "/api/fs/stat") return Response.json({ path, name: path, kind: "text", size: markdown.length, mime: "text/markdown", modified: "2026-01-01T00:00:00Z" });
    if (url.pathname === "/api/fs/file") return new Response(markdown);
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    return new Response(Bun.file(join(output, url.pathname === "/" ? "index.html" : url.pathname.slice(1))), { headers: { "content-security-policy": policy } });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  if (evidence) mkdirSync(evidence, { recursive: true });

  {
    // a device that stored the old switch off still gets the outline: the choice is gone
    const { page, errors, close } = await open(1280, 800, { outline: false });
    await page.getByRole("navigation", { name: "Outline" }).waitFor();
    assert.deepEqual(errors, []);
    await close();
    console.log("PASS a stored old off is ignored: the outline is drawn");
  }

  for (const theme of ["dark", "light"] as const) {
    // a wide popup: the outline is a column beside the document
    const { page, errors, close } = await open(1280, 800, { outline: true, theme });
    const nav = page.getByRole("navigation", { name: "Outline" });
    await nav.waitFor();
    assert.equal(await nav.evaluate((element) => element.classList.contains("is-drawer")), false, "wide: a column, not a drawer");
    assert.equal(await nav.getByRole("button").count(), ENTRIES, "every heading listed, each Notes its own entry");
    const toggle = page.getByRole("button", { name: "Outline", exact: true });
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    const layout = await page.evaluate(() => {
      const width = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().width;
      return { split: width(".file-viewer-split"), body: width(".file-viewer-body"), nav: width(".markdown-outline") };
    });
    assert.ok(Math.abs(layout.body + layout.nav - layout.split) <= 1, `wide: the body and the column share the row ${JSON.stringify(layout)}`);
    assert.deepEqual(await nav.locator(".markdown-outline-item").evaluateAll((items) => items.slice(0, 3).map((item) => item.className)),
      ["markdown-outline-item is-depth-0", "markdown-outline-item is-depth-1", "markdown-outline-item is-depth-2"], "levels kept: # ## ###");
    await markedAt(page, 0);
    assert.equal((await marked(page)).scrollTop, 0, "at the start the list is at its own start");

    // reading on: the heading being read is marked and centered in the list; the document and the focus stay put
    const focused = await page.evaluate(() => document.activeElement?.className ?? null);
    await scrollToHeading(page, 31);
    const bodyTop = await page.locator(".file-viewer-body").evaluate((element) => element.scrollTop);
    await markedAt(page, 31);
    const middle = await marked(page);
    assert.equal(middle.text, "Section 16");
    assert.ok(middle.offCenter !== null && middle.offCenter <= 2, `the marked entry is centered ${JSON.stringify(middle)}`);
    assert.equal(await page.locator(".file-viewer-body").evaluate((element) => element.scrollTop), bodyTop, "following the reading never moves the document");
    assert.equal(await page.evaluate(() => document.activeElement?.className ?? null), focused, "following the reading never moves the focus");
    if (evidence) await page.screenshot({ path: join(evidence, `outline-1280-${theme}.png`) });

    // at the end the list is held to its own range
    await page.locator(".file-viewer-body").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await markedAt(page, ENTRIES - 1);
    const end = await marked(page);
    assert.ok(Math.abs(end.scrollTop - end.maxScroll) <= 1, `at the end the list is at its own end ${JSON.stringify(end)}`);

    // a repeated title: the third Notes entry goes to the third Notes heading, not the first
    await nav.getByRole("button", { name: "Notes", exact: true }).nth(2).click();
    await markedAt(page, 6);
    const landed = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>(".file-viewer-body")!;
      const heading = document.querySelectorAll<HTMLElement>(".file-viewer-markdown > h3")[6]!;
      return { text: heading.textContent, offset: heading.getBoundingClientRect().top - body.getBoundingClientRect().top };
    });
    assert.equal(landed.text, "Notes");
    assert.ok(Math.abs(landed.offset - 8) <= 1, `the chosen heading comes to the top ${JSON.stringify(landed)}`);

    // a heading the end keeps from the top: chosen, it stays the marked one, not the last in view
    await nav.getByRole("button", { name: "Section 30", exact: true }).click();
    await markedAt(page, ENTRIES - 2);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal((await marked(page)).index, ENTRIES - 2, "the choice holds once the document rests");

    // the button folds the column and brings it back
    await toggle.click();
    assert.equal(await nav.count(), 0, "the column folds");
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    await toggle.click();
    await nav.waitFor();
    assert.deepEqual(errors, []);
    await close();
    console.log(`PASS wide ${theme}: column, levels, centered mark, document and focus untouched, clamped ends, repeated titles, fold`);
  }

  for (const theme of ["dark", "light"] as const) {
    // a phone: no column; the Outline button opens a drawer over the document, which keeps its width
    const { page, errors, close } = await open(390, 844, { outline: true, theme });
    const toggle = page.getByRole("button", { name: "Outline", exact: true });
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".markdown-outline").count(), 0, "narrow: the outline waits for its button");
    const bodyWidth = await page.locator(".file-viewer-body").evaluate((element) => element.clientWidth);
    await scrollToHeading(page, 41);
    await toggle.tap();
    const drawer = page.locator(".markdown-outline.is-drawer");
    await drawer.waitFor();
    await markedAt(page, 41);
    assert.equal(await page.locator(".file-viewer-body").evaluate((element) => element.clientWidth), bodyWidth, "the drawer does not narrow the document");
    const opened = await marked(page);
    assert.equal(opened.text, "Section 21");
    assert.ok(opened.offCenter !== null && opened.offCenter <= 2, `opening, the drawer centers the heading being read ${JSON.stringify(opened)}`);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-current")), "location", "the drawer takes the focus on the marked entry");
    if (evidence) await page.screenshot({ path: join(evidence, `outline-390-${theme}.png`) });

    // Escape closes the drawer alone, and the focus goes back to its button
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "detached" });
    assert.equal(await page.getByRole("dialog").count(), 1, "the viewer stays open");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Outline");

    // the header's More menu opened over the drawer takes the first Escape alone; the second closes the drawer
    await toggle.tap();
    await drawer.waitFor();
    await page.getByRole("button", { name: "More", exact: true }).focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "More" });
    await menu.waitFor();
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert.equal(await drawer.count(), 1, "Escape in the More menu leaves the drawer open");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "More", "the focus goes back to More");
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "detached" });
    assert.equal(await page.getByRole("dialog").count(), 1, "the viewer stays open");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Outline");

    // a choice brings its heading up and closes the drawer
    await toggle.tap();
    await drawer.getByRole("button", { name: "Section 5", exact: true }).tap();
    await drawer.waitFor({ state: "detached" });
    await page.waitForFunction(() => {
      const body = document.querySelector<HTMLElement>(".file-viewer-body")!;
      const heading = document.querySelectorAll<HTMLElement>(".file-viewer-markdown > h3")[9]!;
      return Math.abs(heading.getBoundingClientRect().top - body.getBoundingClientRect().top - 8) <= 1;
    });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Outline", "the focus goes back to the button");

    // a press on the document closes it too
    await toggle.tap();
    await drawer.waitFor();
    await page.touchscreen.tap(40, 500);
    await drawer.waitFor({ state: "detached" });

    // a dialog in front of the viewer (Settings opened over it) keeps its own Escape; the drawer stays
    await toggle.tap();
    await drawer.waitFor();
    await page.evaluate(() => {
      window.outlineQA.keyboard(false);
      const front = document.createElement("div");
      front.id = "front";
      front.setAttribute("role", "dialog");
      front.setAttribute("aria-modal", "true");
      front.append(Object.assign(document.createElement("button"), { textContent: "Front" }));
      document.body.append(front);
      front.querySelector("button")!.focus();
      window.addEventListener("keydown", (event) => { if (event.key === "Escape") front.dataset["escaped"] = "yes"; });
    });
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#front").getAttribute("data-escaped"), "yes", "Escape reaches the dialog in front");
    assert.equal(await drawer.count(), 1, "the drawer behind it stays open");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Front", "the focus stays in the dialog in front");
    await page.evaluate(() => {
      document.getElementById("front")!.remove();
      window.outlineQA.keyboard(true);
    });

    // a downward stroke on the drawer at its top scrolls nothing and leaves the viewer in place: the
    // sheet is not dragged from it
    await drawer.evaluate((element) => { element.scrollTop = 0; });
    const start = (await drawer.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const x = start.x + start.width / 2, y = start.y + 40;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (const step of [20, 60, 120, 240]) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + step }] });
    assert.equal(await page.locator(".file-viewer").evaluate((element) => (element as HTMLElement).style.transform), "", "the sheet is not dragged from the drawer");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.equal(await page.getByRole("dialog", { name: "guide.md" }).count(), 1, "the viewer stays open");
    await toggle.tap();
    await drawer.waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
    await close();
    console.log(`PASS narrow ${theme}: drawer on request, full-width document, centered on open, Escape/choice/outside close it, the More menu's Escape is its own`);
  }

  {
    // a phone: an upward stroke begun on a table or a code block scrolls the document; the box,
    // which scrolls only sideways, does not keep the stroke to itself (#3287). Nor does a box that
    // only clips: a diagram, or the slot of an image that cannot load (#3475)
    const { page, errors, close } = await open(390, 844, { outline: true });
    const cdp = await page.context().newCDPSession(page);
    for (const selector of [".markdown-table-wrap", ".markdown-code .hl-code", ".markdown-mermaid", ".image-slot.is-failed"]) {
      const before = await page.locator(".file-viewer-body").evaluate((body, selector) => {
        const box = document.querySelector<HTMLElement>(selector)!;
        body.scrollTop += box.getBoundingClientRect().top - body.getBoundingClientRect().top - 40;
        // the stroke's fling ends past its start; the next stroke waits for it, or the fling still
        // moving the document would carry it off the box
        const done = body.scrollTop + 60;
        body.dataset["flung"] = "";
        const ended = () => { if (body.scrollTop < done) return; body.dataset["flung"] = "yes"; body.removeEventListener("scrollend", ended); };
        body.addEventListener("scrollend", ended);
        return body.scrollTop;
      }, selector);
      const box = (await page.locator(selector).first().boundingBox())!;
      const x = box.x + box.width / 2, y = box.y + Math.min(box.height / 2, 120);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let step = 1; step <= 8; step++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - step * 20 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForFunction(([before]) => document.querySelector<HTMLElement>(".file-viewer-body")!.scrollTop >= before! + 60, [before])
        .catch((error: unknown) => { throw new Error(`a stroke begun on ${selector} did not scroll the document`, { cause: error }); });
      await page.locator(".file-viewer-body[data-flung=yes]").waitFor();
    }
    assert.deepEqual(errors, []);
    await close();
    console.log("PASS narrow: a stroke begun on a table, a code block, a diagram or a failed image scrolls the document");
  }

  {
    // docked beside a pane: the panel is narrow, so the toolbar's Outline button opens a drawer
    const { page, errors, close } = await open(1280, 800, { outline: true, docked: true });
    const toggle = page.locator(".file-viewer-toolbar").getByRole("button", { name: "Outline", exact: true });
    await toggle.click();
    await page.locator(".file-panel .markdown-outline.is-drawer").waitFor();
    await markedAt(page, 0);
    if (evidence) await page.screenshot({ path: join(evidence, "outline-docked-1280-dark.png") });
    // the pane beside the panel keeps its own Escape (a terminal's): the drawer neither takes it nor pulls the focus
    const paneInput = page.getByRole("textbox", { name: "Pane input" });
    await paneInput.focus();
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Pane input", "the focus stays in the pane");
    assert.equal(await page.locator(".file-panel .markdown-outline.is-drawer").count(), 1, "the drawer did not take the pane's Escape");
    assert.deepEqual(errors, []);
    await close();
    console.log("PASS docked: the toolbar's Outline button opens a drawer over the panel; the pane beside it keeps its Escape");
  }
  console.log("markdown outline: browser OK");
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
}
