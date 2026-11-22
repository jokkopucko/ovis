/**
 * The browser is Playwright's headless shell, whose clipboard is its own: a real Cmd+C here never
 * touches the clipboard of the PC running the check.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { build as viteBuild } from "vite";
import { serveStatic } from "../server/static.ts";
import { formatBytes } from "../src/lib/bridgeProgress.ts";
import { SOURCE_PREVIEW_LINES, TEXT_PREVIEW_BYTES } from "../src/lib/filePreviewText.ts";
import { VIRTUAL_HIGHLIGHT_LINES, VIRTUAL_SOURCE_LINES } from "../src/lib/sourcePreview.ts";

function numberedSource(lines: number, longLines: boolean): string {
  const out: string[] = [];
  for (let line = 1; line <= lines; line++) {
    if (line % 10 === 0) out.push("");
    else if (longLines && line % 250 === 1) out.push(`// ${"a long comment that wraps on a phone ".repeat(12)}${line}`);
    else out.push(`export const line_${String(line).padStart(6, "0")} = ${line}; // numbered line ${line}`);
  }
  return `${out.join("\n")}\n`;
}

const FAR_LINE = 123_456;
const BIG_LINES = 123_500;
const files: Record<string, string> = {
  "/src/big.ts": numberedSource(BIG_LINES, true),
  "/src/mid.ts": numberedSource(3_000, false),
  "/src/small.ts": numberedSource(50, false),
  "/src/lines.txt": "x\n".repeat(SOURCE_PREVIEW_LINES + 50_000),
  "/src/huge.log": `${"0123456789".repeat(9)}\n`.repeat(Math.ceil((9 * 1024 * 1024) / 91)),
  "/docs/long.md": "# Notes\n\nA paragraph of ordinary notes, with *emphasis* and a [link](./other.md).\n\n".repeat(8_000),
  "/docs/notes.md": "## Section\n\n- an item of the list\n\n".repeat(800),
};
assert.ok(files["/src/big.ts"]!.length < 8 * 1024 * 1024 && files["/src/big.ts"]!.split("\n").length === BIG_LINES + 1, "big.ts is whole under the source budget");
assert.ok(files["/src/mid.ts"]!.length <= TEXT_PREVIEW_BYTES && 3_000 <= VIRTUAL_HIGHLIGHT_LINES && 3_000 > VIRTUAL_SOURCE_LINES, "mid.ts is virtualized and colorable");
assert.ok(files["/docs/long.md"]!.length > TEXT_PREVIEW_BYTES, "long.md is past the Preview's budget");
const encoder = new TextEncoder();
const bodies = new Map(Object.entries(files).map(([path, text]) => [path, encoder.encode(text)] as const));
const bigLines = files["/src/big.ts"]!.split("\n");
const midLines = files["/src/mid.ts"]!.split("\n");

const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-virtual-source-")));
const evidence = process.env.UI_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const requests: string[] = [];

const shadowRows = () => Array.from(document.querySelector("diffs-container")?.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]") ?? []);
const scrollRoot = () => document.querySelector<HTMLElement>(".virtual-source-scroll");
const rowInView = (row: Element) => {
  const view = scrollRoot()?.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  return view !== undefined && rect.top >= view.top - 1 && rect.bottom <= view.bottom + 1;
};

async function open(page: Page, path: string, machine = "local"): Promise<void> {
  await page.evaluate(([path, machine]) => window.virtualQA.open(path, machine), [path, machine] as const);
  await page.getByRole("dialog").waitFor();
}
async function close(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
}
async function waitRows(page: Page): Promise<void> {
  await page.waitForFunction(() => (document.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-line]").length ?? 0) > 0);
}
interface Mounted { rows: number; first: number; last: number; inView: number; nodes: number }
async function mounted(page: Page): Promise<Mounted> {
  return page.evaluate(([shadowRowsSource, rowInViewSource, scrollRootSource]) => {
    const scrollRoot = new Function(`return (${scrollRootSource})()`) as () => HTMLElement | null;
    const rows = (new Function(`return (${shadowRowsSource})()`) as () => HTMLElement[])();
    const inView = new Function("row", `const scrollRoot = ${scrollRootSource}; return (${rowInViewSource})(row)`) as (row: Element) => boolean;
    const lines = rows.map((row) => Number(row.dataset["line"]));
    void scrollRoot;
    return { rows: rows.length, first: Math.min(...lines), last: Math.max(...lines), inView: rows.filter(inView).length, nodes: document.querySelector("diffs-container")!.shadowRoot!.querySelectorAll("*").length };
  }, [shadowRows.toString(), rowInView.toString(), scrollRoot.toString()] as const);
}
async function nativeSelection(page: Page, text: string): Promise<string> {
  return page.evaluate((text) => {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = text;
    pre.append(code);
    document.body.append(pre);
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const result = selection.toString();
    selection.removeAllRanges();
    pre.remove();
    return result;
  }, text);
}
async function selectRows(page: Page, from: number, to: number, startOffset?: number, endOffset?: number): Promise<string> {
  return page.evaluate(([from, to, startOffset, endOffset]) => {
    const shadow = document.querySelector("diffs-container")!.shadowRoot!;
    const content = (line: number) => {
      const row = shadow.querySelector<HTMLElement>(`[data-line="${line}"]`);
      if (row === null) throw new Error(`row ${line} is not mounted`);
      return row;
    };
    const textNodeAt = (row: HTMLElement, offset: number): [Node, number] => {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const length = (node as Text).data.length;
        if (seen + length >= offset) return [node, offset - seen];
        seen += length;
      }
      throw new Error(`offset ${offset} is past row ${row.dataset["line"]}`);
    };
    const range = document.createRange();
    const first = content(from), last = content(to);
    if (startOffset === undefined) range.setStart(first, 0); else range.setStart(...textNodeAt(first, startOffset));
    if (endOffset === undefined) range.setEnd(last, last.childNodes.length); else range.setEnd(...textNodeAt(last, endOffset));
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    (window as unknown as { selectedRows: HTMLElement[] }).selectedRows = [first, last];
    return selection.toString();
  }, [from, to, startOffset, endOffset] as const);
}
/**
 * Selects rows as `selectRows` does and copies them with a real Cmd+C. Shortly after a mount the
 * virtualizer rebuilds the rows it already drew (its first intersection pass resets the render
 * range, and a highlight pass renders again), which drops a live selection, so the copy is empty;
 * a load (CI's parallel browsers) delays that rebuild past "rows mounted". A copy whose selected
 * rows were replaced underneath it is selected and copied again, a few times at most: only a
 * detected rebuild retries, so a copy that is wrong over unchanged rows still fails.
 */
async function selectAndCopy(page: Page, from: number, to: number, startOffset?: number, endOffset?: number): Promise<{ selected: string; copied: string }> {
  for (let attempt = 1; ; attempt += 1) {
    await page.evaluate(() => navigator.clipboard.writeText(""));
    const selected = await selectRows(page, from, to, startOffset, endOffset);
    await page.keyboard.press("ControlOrMeta+c");
    const [copied, intact] = await page.evaluate(async () => [await navigator.clipboard.readText(), (window as unknown as { selectedRows: HTMLElement[] }).selectedRows.every((row) => row.isConnected)] as const);
    if (intact || attempt === 3) return { selected, copied };
  }
}
async function scrollRootTo(page: Page, where: "middle" | "end"): Promise<void> {
  await page.evaluate((where) => {
    const root = document.querySelector<HTMLElement>(".virtual-source-scroll")!;
    root.scrollTop = where === "end" ? root.scrollHeight : Math.floor(root.scrollHeight / 2);
  }, where);
}
async function viewState(page: Page, line: number): Promise<string> {
  return page.evaluate((line) => {
    const shadow = document.querySelector("diffs-container")?.shadowRoot ?? null;
    const root = document.querySelector<HTMLElement>(".virtual-source-scroll");
    const rows = [...(shadow?.querySelectorAll<HTMLElement>("[data-line]") ?? [])].map((row) => Number(row.dataset["line"]));
    const row = shadow?.querySelector(`[data-line="${line}"]`) ?? null;
    const view = root?.getBoundingClientRect();
    const rect = row?.getBoundingClientRect();
    return JSON.stringify({ rows: rows.length, first: Math.min(...rows), last: Math.max(...rows), scrollTop: root?.scrollTop, scrollHeight: root?.scrollHeight, view: view && { width: view.width, height: view.height }, row: rect && view ? { top: rect.top - view.top, height: rect.height } : null });
  }, line);
}
async function settled(page: Page, line: number, step: string): Promise<void> {
  try {
    await page.waitForFunction((line) => {
      const row = document.querySelector("diffs-container")?.shadowRoot?.querySelector(`[data-line="${line}"]`);
      const view = document.querySelector(".virtual-source-scroll")?.getBoundingClientRect();
      if (!row || !view) return false;
      const rect = row.getBoundingClientRect();
      return rect.top >= view.top - 1 && rect.bottom <= view.bottom + 1;
    }, line, { timeout: 15_000 });
  } catch (error) {
    throw new Error(`${step}: line ${line} did not come into view: ${await viewState(page, line)}`, { cause: error });
  }
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await page.evaluate((line) => {
    const row = document.querySelector("diffs-container")!.shadowRoot!.querySelector(`[data-line="${line}"]`);
    const view = document.querySelector(".virtual-source-scroll")!.getBoundingClientRect();
    const rect = row!.getBoundingClientRect();
    return rect.top >= view.top - 1 && rect.bottom <= view.bottom + 1;
  }, line), true, `${step}: line ${line} stays in view`);
}
async function noticeTitle(page: Page): Promise<string> {
  const notice = page.locator(".file-viewer-meta .file-viewer-notice");
  await notice.waitFor();
  return (await notice.getAttribute("title")) ?? "";
}
async function assertSyntaxPalette(page: Page, tokenText = "export", variable = "--syntax-keyword"): Promise<void> {
  await page.waitForFunction(() => Boolean(document.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-line] span[style*='--herdr-code-token']")));
  const colors = await page.evaluate(({ tokenText, variable }) => {
    const shadow = document.querySelector("diffs-container")?.shadowRoot;
    const keyword = [...(shadow?.querySelectorAll<HTMLElement>("[data-line='1'] span[style]") ?? [])]
      .find((span) => span.textContent === tokenText);
    if (!keyword) throw new Error(`The fixture token ${tokenText} is not colored`);
    const probe = document.createElement("span");
    probe.style.color = `var(${variable})`;
    document.body.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return { expected, actual: getComputedStyle(keyword).color };
  }, { tokenText, variable });
  assert.equal(colors.actual, colors.expected, "virtualized syntax uses the current app palette");
}
async function shot(page: Page, name: string): Promise<void> {
  if (evidence) await page.screenshot({ path: join(evidence, `virtual-source-${name}.png`) });
}

try {
  const repo = join(import.meta.dir, ".."), output = join(root, "dist");
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repo, "scripts/virtual-source-fixture.tsx"), join(root, "fixture.tsx"));
  writeFileSync(join(root, "index.html"), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  await viteBuild({ configFile: join(repo, "vite.config.ts"), root, publicDir: false, logLevel: "warn", build: { outDir: output, emptyOutDir: true } });
  const policy = (await serveStatic("/")).headers.get("content-security-policy");
  assert.ok(policy, "build the app before its enforcing CSP regression");
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    const api = /^\/api\/(?:machines\/([^/]+)\/)?fs\/(stat|file)$/.exec(url.pathname);
    if (api) {
      requests.push(url.pathname);
      const path = url.searchParams.get("path") ?? "";
      const body = bodies.get(path);
      if (body === undefined) return Response.json({ error: { code: "not_found", message: "No readable file at this path." } }, { status: 404 });
      if (api[2] === "stat") return Response.json({ path, name: path.split("/").pop(), kind: "text", size: body.byteLength, mime: path.endsWith(".md") ? "text/markdown" : "text/plain", modified: "2026-01-01T00:00:00Z" });
      const range = /^bytes=0-(\d+)$/.exec(request.headers.get("range") ?? "");
      if (range && Number(range[1]) < body.byteLength - 1) {
        const end = Number(range[1]);
        return new Response(body.slice(0, end + 1), { status: 206, headers: { "content-range": `bytes 0-${end}/${body.byteLength}`, "content-type": "text/plain; charset=utf-8" } });
      }
      return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    return new Response(Bun.file(join(output, url.pathname === "/" ? "index.html" : url.pathname.slice(1))), { headers: { "content-security-policy": policy } });
  } });
  const origin = `http://127.0.0.1:${server.port}`;
  // the headless shell, not the full browser of CHROME_PATH: its clipboard is in memory, so the real copy below is owned here
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  assert.match(browser.version(), /^\d+\./, "a browser launched");

  for (const [width, theme] of [[1440, "dark"], [1440, "light"], [390, "dark"], [390, "light"]] as const) {
    const label = `${width}px ${theme}`;
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390, colorScheme: theme });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await context.addInitScript((theme) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme }));
      const record = window as unknown as { longTasks: number[] };
      record.longTasks = [];
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) record.longTasks.push(entry.duration); }).observe({ type: "longtask" });
    }, theme);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    await page.goto(origin);

    await open(page, "/src/big.ts");
    await waitRows(page);
    const top = await mounted(page);
    assert.ok(top.rows > 0 && top.rows < 500, `${label}: bounded rows at the top: ${JSON.stringify(top)}`);
    assert.equal(top.first, 1, `${label}: the first row is line 1`);
    assert.ok(top.inView > 0, `${label}: rows in view at the top`);
    assert.equal(await page.locator(".file-viewer-text").count(), 0, `${label}: not an element per line`);
    assert.equal(await noticeTitle(page), "Too long to highlight", `${label}: a source past the colors bound says so`);
    await page.getByRole("button", { name: "Copy file", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.querySelector("diffs-container")!.shadowRoot!.querySelectorAll("[data-line] span[style*='--herdr-code-token']").length), 0, `${label}: plain rows, no colors`);
    await shot(page, `top-${width}-${theme}`);
    await scrollRootTo(page, "middle");
    await page.waitForFunction((half) => { const rows = [...(document.querySelector("diffs-container")?.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]") ?? [])]; return rows.some((row) => Number(row.dataset["line"]) > half); }, Math.floor(BIG_LINES / 2) - 1000);
    const middle = await mounted(page);
    assert.ok(middle.rows > 0 && middle.rows < 500 && middle.inView > 0 && middle.first > 1000, `${label}: bounded rows in the middle: ${JSON.stringify(middle)}`);
    await scrollRootTo(page, "end");
    await page.waitForFunction((last) => [...(document.querySelector("diffs-container")?.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]") ?? [])].some((row) => Number(row.dataset["line"]) === last), BIG_LINES + 1);
    const end = await mounted(page);
    assert.ok(end.rows > 0 && end.rows < 500 && end.inView > 0, `${label}: bounded rows at the end: ${JSON.stringify(end)}`);
    assert.equal(end.last, BIG_LINES + 1, `${label}: the last row is the empty line after the final newline`);
    await shot(page, `end-${width}-${theme}`);
    const colors = await page.evaluate(() => {
      const probe = document.createElement("span");
      document.body.append(probe);
      const resolve = (token: string) => { probe.style.color = `var(${token})`; return getComputedStyle(probe).color; };
      const shadow = document.querySelector("diffs-container")!.shadowRoot!;
      const row = shadow.querySelector<HTMLElement>("[data-line]")!;
      const result = { text: resolve("--text"), row: getComputedStyle(row).color, bg: resolve("--bg"), pre: getComputedStyle(shadow.querySelector("pre")!).backgroundColor, host: getComputedStyle(document.querySelector("diffs-container")!).backgroundColor };
      probe.remove();
      return result;
    });
    assert.equal(colors.row, colors.text, `${label}: the rows read in the app's text color: ${JSON.stringify(colors)}`);
    assert.ok([colors.bg, "rgba(0, 0, 0, 0)"].includes(colors.pre) && [colors.bg, "rgba(0, 0, 0, 0)"].includes(colors.host), `${label}: no code background of the package's own: ${JSON.stringify(colors)}`);
    await close(page);
    assert.deepEqual(errors, [], `${label}: no errors while opening the big source`);
    console.log(`PASS ${label}: 120 000+ lines as a bounded window of rows at the top, the middle and the end (rows ${top.rows}/${middle.rows}/${end.rows})`);

    await open(page, `/src/big.ts:${FAR_LINE}`);
    await waitRows(page);
    await settled(page, FAR_LINE, `${label} reveal`);
    assert.equal(await page.evaluate((line) => document.querySelector("diffs-container")!.shadowRoot!.querySelector(`[data-line="${line}"]`)!.hasAttribute("data-selected-line"), FAR_LINE), true, `${label}: the requested line is marked`);
    assert.equal(await page.evaluate((line) => document.querySelector("diffs-container")!.shadowRoot!.querySelectorAll("[data-line][data-selected-line]").length, FAR_LINE), 1, `${label}: one line is marked`);
    const far = await mounted(page);
    assert.ok(far.rows < 500 && far.first <= FAR_LINE && far.last >= FAR_LINE, `${label}: the far line's rows are a bounded window: ${JSON.stringify(far)}`);
    await shot(page, `far-${width}-${theme}`);
    await page.evaluate(() => window.virtualQA.settings({ wrapCode: true }));
    await settled(page, FAR_LINE, `${label} wrap on`);
    assert.ok((await mounted(page)).rows < 500, `${label}: wrapped rows stay bounded`);
    await shot(page, `far-wrap-${width}-${theme}`);
    for (const fileFontSize of [24, null]) {
      const lineHeight = (): Promise<number> => page.evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector(".virtual-source")!).lineHeight));
      const was = await lineHeight();
      await page.evaluate((fileFontSize) => window.virtualQA.settings({ fileFontSize }), fileFontSize);
      await page.waitForFunction((was) => Number.parseFloat(getComputedStyle(document.querySelector(".virtual-source")!).lineHeight) !== was, was);
      await settled(page, FAR_LINE, `${label} wrapped, File text size ${fileFontSize ?? "reset"}`);
    }
    const other = width === 1440 ? { width: 390, height: 844 } : { width: 1440, height: 900 };
    await page.setViewportSize(other);
    await settled(page, FAR_LINE, `${label} resized to ${other.width}px`);
    assert.ok((await mounted(page)).rows < 500, `${label}: rows stay bounded after a resize`);
    await shot(page, `far-resized-${width}-${theme}`);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await settled(page, FAR_LINE, `${label} resized back`);
    await page.evaluate(() => window.virtualQA.settings({ wrapCode: false }));
    await settled(page, FAR_LINE, `${label} wrap off`);
    await close(page);
    assert.deepEqual(errors, [], `${label}: no errors around the far line`);
    console.log(`PASS ${label}: line ${FAR_LINE} marked and in view, with wrap off and on, across a File text size change while wrapped, after a resize to ${other.width}px and back`);

    await open(page, `/src/big.ts:${FAR_LINE}`);
    await waitRows(page);
    await settled(page, FAR_LINE, `${label} reopened`);
    await close(page);
    await open(page, "/src/mid.ts");
    await waitRows(page);
    await page.waitForFunction(() => document.querySelector("diffs-container")!.shadowRoot!.querySelectorAll("[data-line] span[style*='--herdr-code-token']").length > 0, undefined, { timeout: 20_000 });
    assert.equal(await page.locator(".file-viewer-notice").count(), 0, `${label}: a colored source has no notice`);
    await assertSyntaxPalette(page);
    await shot(page, `colored-${width}-${theme}`);
    await close(page);
    assert.deepEqual(errors, [], `${label}: no errors on reopen and colors`);
    console.log(`PASS ${label}: close and reopen, and a 3 000-line source colored in the worker`);

    const frozen = (await page.evaluate(() => (window as unknown as { longTasks?: number[] }).longTasks ?? [])).filter((duration) => duration >= 1_000);
    assert.deepEqual(frozen, [], `${label}: no task held the page for a second`);
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark" })));
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  await page.goto(origin);
  for (const [path, lines, colored] of [["/src/big.ts", bigLines, false], ["/src/mid.ts", midLines, true]] as const) {
    await open(page, path);
    await waitRows(page);
    if (colored) await page.waitForFunction(() => document.querySelector("diffs-container")!.shadowRoot!.querySelectorAll("[data-line] span[style*='--herdr-code-token']").length > 0, undefined, { timeout: 20_000 });
    const interior = lines.slice(24, 35).join("\n");
    const whole = await selectAndCopy(page, 25, 35);
    assert.equal(whole.selected, interior, `${path}: a selection over an interior blank line is the source's text`);
    assert.equal(whole.copied, interior, `${path}: a real copy of it is exact`);
    const partial = `${lines[25]!.slice(3)}\n${lines[26]!}\n${lines[27]!.slice(0, 5)}`;
    const part = await selectAndCopy(page, 26, 28, 3, 5);
    assert.equal(part.selected, partial, `${path}: a partial selection is exact`);
    assert.equal(part.copied, partial, `${path}: a real copy of a partial selection is exact`);
    const edges = lines.slice(29, 41).join("\n");
    assert.equal(await selectRows(page, 30, 41), await nativeSelection(page, edges), `${path}: blank first and last lines read as a native pre/code`);
    // the trailing blank line and the empty line after the final newline: the source's own tail,
    // where a native pre/code would drop the final newline
    await scrollRootTo(page, "end");
    await page.waitForFunction((last) => document.querySelector("diffs-container")!.shadowRoot!.querySelector(`[data-line="${last}"]`) !== null, lines.length);
    const tail = lines.slice(lines.length - 4).join("\n");
    assert.ok(tail.endsWith("\n\n"), `${path}: the fixture ends with a blank line and its newline`);
    const end = await selectAndCopy(page, lines.length - 3, lines.length);
    assert.equal(end.selected, tail, `${path}: a selection to the end keeps the trailing blank line and the final newline`);
    assert.equal(end.copied, tail, `${path}: a real copy of the tail is the source's tail`);
    const heights = await page.evaluate(() => [...document.querySelector("diffs-container")!.shadowRoot!.querySelectorAll<HTMLElement>("[data-line]")].map((row) => ({ line: Number(row.dataset["line"]), empty: row.textContent === "" || row.textContent === "\n", height: row.getBoundingClientRect().height })));
    const base = heights.find((row) => !row.empty)!.height;
    assert.ok(heights.some((row) => row.empty) && heights.filter((row) => row.empty).every((row) => row.height === base), `${path}: blank rows keep the row height ${base}: ${JSON.stringify(heights.filter((row) => row.empty).slice(0, 4))}`);
    await close(page);
    console.log(`PASS ${path}: native selection and a real copy keep blank, partial and trailing lines, without the gutter`);
  }
  await open(page, "/src/mid.ts");
  await waitRows(page);
  await page.getByRole("button", { name: "Copy file", exact: true }).click();
  await page.getByRole("button", { name: "File copied", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), files["/src/mid.ts"], "Copy file copies the whole source");
  await close(page);
  await open(page, "/src/mid.ts");
  await waitRows(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("no clipboard")) }, configurable: true });
    document.execCommand = () => false;
  });
  await page.getByRole("button", { name: "Copy file", exact: true }).click();
  const box = page.locator(".file-viewer-select-source");
  await box.waitFor();
  assert.deepEqual(await box.evaluate((element: HTMLTextAreaElement) => ({ focused: document.activeElement === element, start: element.selectionStart, end: element.selectionEnd, length: element.value.length, readOnly: element.readOnly })), { focused: true, start: 0, end: files["/src/mid.ts"]!.length, length: files["/src/mid.ts"]!.length, readOnly: true }, "the whole source is selected in a readonly box");
  assert.equal(await page.locator("diffs-container").count(), 0, "the rows give way to the box");
  await close(page);
  assert.deepEqual(errors, [], "no errors around selection and copy");
  console.log("PASS Copy file copies the whole source; without a clipboard it selects the source in a readonly box");

  await open(page, "/src/lines.txt");
  await waitRows(page);
  assert.equal(await noticeTitle(page), `Showing the first ${SOURCE_PREVIEW_LINES.toLocaleString("en-US")} lines of this file. Download it to read the rest.`, "a file past the line cap says so");
  assert.equal(await page.getByRole("button", { name: "Copy file", exact: true }).count(), 0, "a cut file has no Copy");
  await scrollRootTo(page, "end");
  await page.waitForFunction((last) => document.querySelector("diffs-container")!.shadowRoot!.querySelector(`[data-line="${last}"]`) !== null, SOURCE_PREVIEW_LINES);
  assert.equal((await mounted(page)).last, SOURCE_PREVIEW_LINES, "the rows end at the cap, without an artificial row after it");
  await close(page);
  await open(page, `/src/lines.txt:${SOURCE_PREVIEW_LINES}`);
  await waitRows(page);
  await settled(page, SOURCE_PREVIEW_LINES, "the line at the cap");
  assert.equal(await page.evaluate((line) => document.querySelector("diffs-container")!.shadowRoot!.querySelector(`[data-line="${line}"]`)!.hasAttribute("data-selected-line"), SOURCE_PREVIEW_LINES), true, "the line at the cap is marked");
  await close(page);
  await open(page, `/src/lines.txt:${SOURCE_PREVIEW_LINES + 1}`);
  await waitRows(page);
  const pastCap = await noticeTitle(page);
  assert.ok(pastCap.includes(`Line ${SOURCE_PREVIEW_LINES + 1} is past the part of this file shown here.`), `the line past the cap is unseen: ${pastCap}`);
  assert.equal(await page.evaluate(() => document.querySelector("diffs-container")!.shadowRoot!.querySelectorAll("[data-line][data-selected-line]").length), 0, "no row is marked for the line past the cap");
  assert.equal(await page.evaluate((line) => document.querySelector("diffs-container")!.shadowRoot!.querySelector(`[data-line="${line}"]`), SOURCE_PREVIEW_LINES + 1), null, "no row carries the number past the cap");
  await close(page);
  await open(page, "/src/huge.log");
  await waitRows(page);
  assert.equal(await noticeTitle(page), "Showing the first 8 MB of 9 MB.", "a file past the byte budget says so");
  assert.equal(await page.locator(".file-viewer-meta .file-viewer-notice span").first().innerText(), "8 MB of 9 MB", "the header's size is the part shown");
  assert.equal(await page.getByRole("button", { name: "Copy file", exact: true }).count(), 0, "a cut file has no Copy");
  const lastComplete = files["/src/huge.log"]!.slice(0, 8 * 1024 * 1024).split("\n").length - 1;
  await scrollRootTo(page, "end");
  await page.waitForFunction((last) => document.querySelector("diffs-container")!.shadowRoot!.querySelector(`[data-line="${last}"]`) !== null, lastComplete);
  const lastRow = await page.evaluate((last) => ({ last: Math.max(...[...document.querySelector("diffs-container")!.shadowRoot!.querySelectorAll<HTMLElement>("[data-line]")].map((row) => Number(row.dataset["line"]))), text: document.querySelector("diffs-container")!.shadowRoot!.querySelector(`[data-line="${last}"]`)!.textContent ?? "" }), lastComplete);
  assert.ok(lastRow.last === lastComplete && lastRow.text.length > 0, `a byte cut ends on its last complete line ${lastComplete}: ${JSON.stringify(lastRow).slice(0, 80)}`);
  await close(page);
  await open(page, "/src/small.ts");
  await page.locator(".file-viewer-text .hl-line").first().waitFor();
  assert.equal(await page.locator(".file-viewer-text .hl-line").count(), 51, "a small source stays an element per line");
  assert.equal(await page.locator("diffs-container").count(), 0, "and is not virtualized");
  await close(page);
  assert.deepEqual(errors, [], "no errors around the cuts");
  console.log("PASS a file past the line cap and one past the byte budget say so truthfully and end on their last complete line, the cap is marked and the line past it explained; a small source is unchanged");

  await open(page, "/src/mid.ts");
  await waitRows(page);
  await page.waitForFunction(() => document.querySelector("diffs-container")!.shadowRoot!.querySelectorAll("[data-line] span[style*='--herdr-code-token']").length > 0, undefined, { timeout: 20_000 });
  await page.evaluate(() => window.virtualQA.settings({ theme: "light" }));
  await page.locator(".virtual-source[data-colored]").waitFor();
  await waitRows(page);
  await page.waitForFunction(() => document.documentElement.dataset["theme"] === "light");
  const light = await page.evaluate(() => {
    const probe = document.createElement("span");
    document.body.append(probe);
    probe.style.color = "var(--text)";
    const text = getComputedStyle(probe).color;
    probe.remove();
    return { text, row: getComputedStyle(document.querySelector("diffs-container")!.shadowRoot!.querySelector("[data-line]")!).color };
  });
  assert.equal(light.row, light.text, `the rows follow the light theme's text color: ${JSON.stringify(light)}`);
  await assertSyntaxPalette(page);
  await close(page);
  await page.evaluate(() => window.virtualQA.settings({ theme: "dark" }));
  console.log("PASS Settings: the theme reaches the rows");

  await open(page, "/docs/long.md");
  await page.locator(".file-viewer-markdown .markdown-h1").first().waitFor();
  assert.equal(await noticeTitle(page), `Showing the first 256 KB of ${formatBytes(bodies.get("/docs/long.md")!.byteLength)}.`, "a Markdown file past the Preview's budget keeps it");
  await page.getByRole("button", { name: "Show source", exact: true }).click();
  await waitRows(page);
  assert.ok((await mounted(page)).rows < 500, "the Markdown source is virtualized");
  await close(page);
  await open(page, "/docs/notes.md");
  await page.locator(".file-viewer-markdown").waitFor();
  await page.getByRole("button", { name: "Show source", exact: true }).click();
  await waitRows(page);
  await page.waitForFunction(() => document.querySelector("diffs-container")!.shadowRoot!.querySelectorAll("[data-line] span[style*='--herdr-code-token']").length > 0, undefined, { timeout: 20_000 });
  await assertSyntaxPalette(page, "## Section", "--syntax-meta");
  await close(page);
  console.log("PASS Markdown keeps the Preview's budget, and its source is virtualized and colored");

  requests.length = 0;
  await open(page, "/src/mid.ts", "remote-fixture");
  await waitRows(page);
  assert.ok(requests.length >= 2 && requests.every((path) => path.startsWith("/api/machines/remote-fixture/fs/")), `remote requests: ${requests.join(", ")}`);
  await close(page);
  assert.deepEqual(errors, [], "no errors at the end");
  await context.close();
  console.log("PASS a remote PC's source reads through its bridge");
  console.log("virtual source: browser OK (bounded rows, far line, wrap and resize, native selection and real copy, whole copy and its fallback, cuts, settings, Markdown, remote)");
} finally {
  await browser?.close(); server?.stop(true); rmSync(root, { recursive: true, force: true });
}
