/**
 * A mirrored pane wider than a phone (a Windows PC: herdr has no terminal attach there, so the bridge
 * repaints the pane at its size on that PC) is drawn folded to the screen's width, with nothing cut off
 * on the right; the pane menu's "Original width" draws the grid as it is again, remembered for this
 * device, and a desktop keeps the original width until it chooses "Wrap to screen". An attached pane
 * whose pty another device sized wider than the phone folds the same way while the phone does not drive
 * it (watching, or under its keyboard), and never while it drives. On the unmodified app over the demo's
 * fixture transport: no herdr, no user state.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { appFaces } from "./app-faces.ts";
import { shownRow, shownRows } from "./shown-rows.ts";
import { openMoreGroup } from "./header-more.ts";

const COLS = 120;
const ROWS = 40;
const LINK = "https://example.com/fold-link";
const OSC8 = "https://example.com/osc8-target";
const OSC8_SHOWN = "https://example.org/display-label";
const OSC8_REAL = "https://example.com/real-target";

interface FoldFixture {
  sockets: Array<WebSocket & { push(frame: Record<string, unknown>): void }>;
  offsets: number[];
  reads: number;
  offset: number;
}
declare global { interface Window { foldFixture: FoldFixture } }

/**
 * The demo owns metadata and auth; this makes its PC a mirror, as a Windows PC is, and gives `fixedPane`
 * a fixed grid of its own and a stand-in for herdr's history. `?fold=off` leaves the demo as it is: an
 * attached PC. `?fold=attached` keeps the PC attached but gives the pane the same wide pty grid, which a
 * watching phone adopts.
 */
function installFoldFixture(screen: string, cols: number, rows: number, fixedPane: string): void {
  const mode = new URL(location.href).searchParams.get("fold");
  if (mode === "off") return;
  const fixed = mode !== "attached";
  const state: FoldFixture = { sockets: [], offsets: [], reads: 0, offset: 0 };
  window.foldFixture = state;
  const fetchDemo = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.pathname === "/api/pane/scroll") {
      if (init?.method === "POST") {
        state.offset = Math.max(0, Math.min(200, (JSON.parse(String(init.body)) as { offset_from_bottom: number }).offset_from_bottom));
        state.offsets.push(state.offset);
      } else state.reads++;
      return new Response(JSON.stringify({ scroll: { offset_from_bottom: state.offset, max_offset_from_bottom: 200, viewport_rows: rows } }), { headers: { "content-type": "application/json" } });
    }
    const response = await fetchDemo(input, init);
    if (!fixed || url.pathname !== "/api/health" || url.search !== "") return response;
    const body = await response.json() as { herdr: Record<string, unknown> };
    body.herdr = { ...body.herdr, terminal_attach: false, terminal_mirror: true };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof window.fetch;
  const Demo = window.WebSocket;
  const Recorded = function (url: string | URL, protocols?: string | string[]) {
    const socket = new Demo(url, protocols) as FoldFixture["sockets"][number];
    state.sockets.push(socket);
    const push = socket.push.bind(socket);
    socket.push = (frame) => {
      if (frame.pane_id !== fixedPane) push(frame);
      else if (frame.type === "pane-geometry") push({ ...frame, cols, rows, ...(fixed ? { fixed: true } : {}) });
      // the demo's own recording would draw over the fixture's screen
      else if (frame.type === "pty-data" && frame.fixture !== "fold") return;
      else if (frame.type === "pty-data") {
        const { fixture: _, ...output } = frame;
        push(output);
      }
      else push(frame);
    };
    const send = socket.send.bind(socket);
    socket.send = (raw) => {
      send(raw);
      const frame = JSON.parse(String(raw)) as { type: string; pane_id?: string };
      if (frame.type !== "attach" || frame.pane_id !== fixedPane) return;
      socket.push({ type: "pane-geometry", pane_id: frame.pane_id, cols, rows, ...(fixed ? { fixed: true } : {}) });
      // herdr's attach stream turns mouse reporting on for every pane, a plain shell's too: an attached grid
      // here is one whose program reports the mouse, as each one does
      socket.push({ type: "pty-data", fixture: "fold", pane_id: frame.pane_id, data: (fixed ? "" : "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h") + screen });
    };
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(Recorded, name, { value: Demo[name] });
  window.WebSocket = Recorded as unknown as typeof WebSocket;
}

const cellWidth = (text: string): number => [...text].reduce((sum, char) => sum + (/[\u1100-\u115f\uac00-\ud7a3\u3000-\u303f\uff00-\uff60]/u.test(char) ? 2 : 1), 0);
/** `head`, filled with `fill` to the grid's width less the row's END marker, then the marker */
const row = (index: number, head: string, fill = "."): string => {
  const marker = `END${index}`;
  let text = head;
  while (cellWidth(text) + cellWidth(fill) <= COLS - marker.length) text += fill;
  return text + " ".repeat(COLS - marker.length - cellWidth(text)) + marker;
};
const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
const screenRows: string[] = [];
for (let index = 1; index <= ROWS; index++) {
  if (index === 3) screenRows.push(`\x1b[31mRED-SEGMENT\x1b[0m${row(index, " ").slice("RED-SEGMENT".length)}`);
  else if (index === 5) screenRows.push(row(index, "한글 줄바꿈: 오른쪽 끝까지 보여야 합니다 ", "가"));
  else if (index === 7) screenRows.push(row(index, `R07 ${LINK} `));
  // a labelled OSC 8 hyperlink: the row shows OSC8-LABEL, its target is OSC8
  // an OSC 8 hyperlink whose label is itself an address: its target, not the label, is what opens
  else if (index === 11) screenRows.push(`R11 \x1b]8;;${OSC8_REAL}\x1b\\${OSC8_SHOWN}\x1b]8;;\x1b\\${row(index, " ").slice(`R11 ${OSC8_SHOWN}`.length)}`);
  else if (index === 9) screenRows.push(`R09 \x1b]8;;${OSC8}\x1b\\OSC8-LABEL\x1b]8;;\x1b\\${row(index, " ").slice("R09 OSC8-LABEL".length)}`);
  else if (index === ROWS) screenRows.push(row(index, "FOLD-LAST "));
  else screenRows.push(row(index, `R${String(index).padStart(2, "0")} the quick brown fox `));
}
for (const text of screenRows) assert.equal(cellWidth(plain(text)), COLS, `a fixture row is the grid's width: ${plain(text)}`);
// what server/mirror.ts sends for a whole screen: line wrap off while the rows are drawn
const frameOf = (rows: string[]): string => `\x1b[?25l\x1b[0m\x1b[H\x1b[2J\x1b[?7l${rows.join("\r\n")}\x1b[0m\x1b[?7h`;
const SCREEN = frameOf(screenRows);
// a full-screen program's frame, as btop draws one: a box as wide as the grid, on the alternate screen
const tuiRows = Array.from({ length: ROWS }, (_, index) => index === 0 ? `┌${"─".repeat(COLS - 2)}┐`
  : index === ROWS - 1 ? `└${"─".repeat(COLS - 2)}┘` : `│${` cpu${String(index).padStart(2, "0")} ${"#".repeat(index)}`.padEnd(COLS - 2)}│`);
for (const text of tuiRows) assert.equal(cellWidth(text), COLS, `a TUI row is the grid's width: ${text}`);
const TUI = `\x1b[?1049h${frameOf(tuiRows)}`;
/** the mouse modes herdr's terminal attach turns on for every pane (herdr 0.9.5) */
const HERDR_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";

interface Visible { folded: boolean; cut: string[]; hostScrollWidth: number; hostClientWidth: number }
/** Whether every row's END marker is inside the pane's visible width, in whichever view draws it. */
const visibleMarkers = (page: Page): Promise<Visible> => page.evaluate(({ rows, grid }) => {
  const host = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal")!;
  const folded = host.hasAttribute("data-folded");
  const drawn = host.querySelector<HTMLElement>(folded ? ".terminal-fold" : grid)!;
  const box = host.getBoundingClientRect();
  const left = box.left + host.clientLeft;
  const right = left + host.clientWidth;
  const cut: string[] = [];
  // one child per grid row in either view; a marker may span text nodes (xterm draws the cell under
  // its hidden cursor, the last row's end, in a span of its own)
  const rowNodes = [...drawn.children];
  for (let index = 1; index <= rows; index++) {
    const marker = `END${index}`;
    const nodes: Text[] = [];
    const row = rowNodes[index - 1];
    if (row) for (let walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT), node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    const text = nodes.map((node) => node.data).join("");
    const at = text.lastIndexOf(marker);
    let found: DOMRect | null = null;
    if (at >= 0) {
      const place = (offset: number): [Text, number] => {
        let left = offset;
        for (const node of nodes) {
          if (left <= node.data.length) return [node, left];
          left -= node.data.length;
        }
        return [nodes.at(-1)!, nodes.at(-1)!.data.length];
      };
      const range = document.createRange();
      range.setStart(...place(at));
      range.setEnd(...place(at + marker.length));
      found = range.getBoundingClientRect();
    }
    if (!found || found.left < left - 1 || found.right > right + 1) cut.push(found ? `${marker} at ${Math.round(found.left)}-${Math.round(found.right)} of ${Math.round(left)}-${Math.round(right)}` : `${marker} not drawn`);
  }
  return { folded, cut, hostScrollWidth: host.scrollWidth, hostClientWidth: host.clientWidth };
}, { rows: ROWS, grid: shownRows() });

/** The rectangle of `text` in the folded rows, and the pane's visible box, both in viewport pixels. */
const foldedText = (page: Page, text: string): Promise<{ rect: { left: number; top: number; right: number; bottom: number } | null; box: { top: number; bottom: number } }> => page.evaluate((wanted) => {
  const host = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal")!;
  const box = host.getBoundingClientRect();
  const visible = { top: box.top + host.clientTop, bottom: box.top + host.clientTop + host.clientHeight };
  for (let walker = document.createTreeWalker(host.querySelector(".terminal-fold") ?? host, NodeFilter.SHOW_TEXT), node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = (node as Text).data.indexOf(wanted);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + wanted.length);
    const { left, top, right, bottom } = range.getBoundingClientRect();
    return { rect: { left, top, right, bottom }, box: visible };
  }
  return { rect: null, box: visible };
}, text);
const inView = (seen: Awaited<ReturnType<typeof foldedText>>): boolean => seen.rect !== null && seen.rect.top >= seen.box.top - 1 && seen.rect.bottom <= seen.box.bottom + 1;

const settled = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const foldState = (page: Page, folded: boolean): Promise<unknown> => page.waitForFunction((want) => {
  const host = document.querySelector(".pane-frame.is-current .pane-terminal");
  return host !== null && host.hasAttribute("data-folded") === want && (!want || host.querySelector(".terminal-fold-row") !== null);
}, folded);
// kept in a key of its own (lib/settings.ts MIRROR_WRAP_STORAGE_KEY), out of an older tab's whole-record save
const savedWrap = (page: Page): Promise<unknown> => page.evaluate(() => JSON.parse(localStorage.getItem("ovis:mirror-wrap") ?? "null"));
/** Every row's END marker inside the pane's visible width, waited for: the view settles a frame or a resize after it is drawn. */
const rowsWhole = async (page: Page, label: string): Promise<Visible> => {
  let seen = await visibleMarkers(page);
  for (const deadline = Date.now() + 10_000; seen.cut.length > 0 && Date.now() < deadline;) {
    await settled(page);
    seen = await visibleMarkers(page);
  }
  assert.deepEqual(seen.cut, [], `${label}: rows cut off on the right ${JSON.stringify(seen)}`);
  return seen;
};
/** Picks `label` from the pane's actions: a phone's header More (a bottom sheet of buttons; its title lists the tabs), a desktop's tab menu (a popover of menu items, RowMenu). */
const choose = async (page: Page, label: string, phone: boolean): Promise<void> => {
  // a phone layout is waited for, not sampled: just after a resize from a desktop-wide window the header
  // still holds the desktop's tab row, which the phone layout then takes away
  if (phone) {
    await page.locator(".app-header .context-tabs").waitFor();
    await page.locator(".header-more-button").click();
    await page.locator(".row-sheet").waitFor();
    // the pane's actions are under More's Pane and tab… (G-143)
    await openMoreGroup(page, "pane");
  } else {
    // a desktop's tab strip shows the selected tab's actions button under the pointer (ui-regression.ts)
    await page.locator(".tab-strip").first().hover();
    const button = page.locator(".tab-strip-item.is-active .tab-strip-menu").first();
    await button.waitFor({ state: "visible" });
    await button.click();
  }
  const item = page.locator('.row-sheet-item, [role="menuitem"], [role="menuitemcheckbox"]').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) });
  try { await item.waitFor({ timeout: 5_000 }); }
  catch (cause) {
    const menu = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], .row-sheet-item')].map((node) => node.textContent?.trim()));
    throw new Error(`the pane menu offers no "${label}": ${JSON.stringify(menu)}`, { cause });
  }
  await item.click();
};
/**
 * Taps a character of `text` in the folded row that holds it (`at`: its index in `text`, `-1` the last one),
 * three quarters across the glyph, where the caret lies after it. The point is measured against the row and
 * Playwright clicks the row there once it holds still, so the view scrolling between measuring and tapping
 * (a late resize settling, the rows following the cursor) cannot move the tap off the glyph.
 */
const tapFolded = async (page: Page, text: string, at: number): Promise<void> => {
  const row = page.locator(".pane-frame.is-current .terminal-fold-row").filter({ hasText: text }).first();
  const position = await row.evaluate((node, { text, at }) => {
    const nodes: Text[] = [];
    for (let walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), each = walker.nextNode(); each; each = walker.nextNode()) nodes.push(each as Text);
    const start = nodes.map((each) => each.data).join("").indexOf(text);
    let index = start + (at < 0 ? text.length + at : at);
    for (const each of nodes) {
      if (index >= each.data.length) { index -= each.data.length; continue; }
      const range = document.createRange();
      range.setStart(each, index);
      range.setEnd(each, index + 1);
      const glyph = range.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      return { x: glyph.left + glyph.width * 0.75 - box.left, y: glyph.top + glyph.height / 2 - box.top };
    }
    throw new Error(`no "${text}" in the folded row`);
  }, { text, at });
  await row.click({ position });
};
/** Taps with `tap` and waits for `url` to open in a tab; when none opens, says what the tap reached and what the page tried to open. */
const opensTab = async (page: Page, url: string, tap: () => Promise<void>): Promise<void> => {
  const opened = page.context().waitForEvent("page", { timeout: 15_000 });
  await tap();
  let tab: Page;
  try { tab = await opened; }
  catch (cause) {
    const seen = await page.evaluate(() => ({ ...(window as unknown as { foldSeen: unknown }).foldSeen as object, selection: window.getSelection()?.toString() ?? "", focused: document.activeElement?.className ?? "",
      scrollTop: document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal")?.scrollTop, location: location.href })).catch(() => null);
    throw new Error(`tapping for ${url} opened no tab: ${JSON.stringify(seen)}`, { cause });
  }
  await tab.waitForURL(url);
  await tab.close();
};
const pushScreen = (page: Page, data: string): Promise<void> => page.evaluate(({ pane, data }) => window.foldFixture.sockets.at(-1)!.push({ type: "pty-data", fixture: "fold", pane_id: pane, data }), { pane: panes.shell, data });
/** Whether the pane is drawn folded, and whether what it draws fits its width (nothing to pan sideways). */
const fitState = (page: Page): Promise<{ folded: boolean; fold: boolean; fits: boolean }> => page.evaluate(() => {
  const host = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal")!;
  return { folded: host.hasAttribute("data-folded"), fold: host.querySelector(".terminal-fold") !== null, fits: host.scrollWidth <= host.clientWidth + 1 };
});
/** A one-finger swipe across the middle of the pane by (dx, dy), in the moves a phone sends. */
const swipe = async (page: Page, dx: number, dy: number): Promise<void> => {
  const box = await page.locator(".pane-frame.is-current .pane-terminal").boundingBox();
  assert.ok(box);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 6; step++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * step / 6, y: y + dy * step / 6 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
};
const hostScroll = (page: Page): Promise<{ top: number; left: number }> => page.evaluate(() => {
  const host = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal")!;
  return { top: host.scrollTop, left: host.scrollLeft };
});
/** The labels of the pane's actions on a phone (its header More: the title lists the tabs; Pane and tab… under it, G-143), closed again with Escape. */
const sheetItems = async (page: Page): Promise<string[]> => {
  await page.locator(".header-more-button").click();
  await page.locator(".row-sheet").waitFor();
  await openMoreGroup(page, "pane");
  const items = await page.locator(".row-sheet .row-sheet-item .row-sheet-label").allTextContents();
  await page.keyboard.press("Escape");
  await page.locator(".row-sheet").waitFor({ state: "detached" });
  return items;
};
/** A Korean syllable composed in xterm's focused input: in view, and drawn over the folded rows. The composition is cancelled after. */
const preeditOverFold = async (page: Page, label: string): Promise<void> => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "한글", selectionStart: 2, selectionEnd: 2 });
  await page.locator(".pane-frame.is-current .composition-view.active").waitFor();
  const preedit = await page.evaluate(() => {
    const view = document.querySelector<HTMLElement>(".pane-frame.is-current .composition-view.active")!;
    const host = view.closest<HTMLElement>(".pane-terminal")!;
    const rect = view.getBoundingClientRect();
    const box = host.getBoundingClientRect();
    const top = document.elementFromPoint(rect.left + Math.min(rect.width / 2, 8), rect.top + rect.height / 2);
    return { rect: { top: rect.top, bottom: rect.bottom }, view: { top: box.top + host.clientTop, bottom: box.top + host.clientTop + host.clientHeight }, onTop: top === view || view.contains(top), topmost: top?.className ?? null };
  });
  assert.ok(preedit.onTop && preedit.rect.top >= preedit.view.top - 1 && preedit.rect.bottom <= preedit.view.bottom + 1, `${label}: the preedit is in view and drawn over the folded rows ${JSON.stringify(preedit)}`);
  // the composition cancelled: nothing reaches the pane
  await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
  await page.locator(".pane-frame.is-current .composition-view.active").waitFor({ state: "detached" });
  await cdp.detach();
};
const SETTINGS = { language: "en", defaultView: "terminal", terminalInputMode: "direct", terminalFontFamily: "JetBrains Mono Web", terminalWheelSpeed: 2, alertsOn: false };

async function open(browser: Browser, origin: string, viewport: { width: number; height: number }, phone: boolean, query = ""): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone, locale: "en-US" });
  // fixed metrics: the 120-column grid fits a 1440px desktop and no phone
  await context.addInitScript((settings) => {
    if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify(settings));
  }, SETTINGS);
  // what a tap reached and which links the page tried to open, for a failure to report
  await context.addInitScript(() => {
    const seen = { taps: [] as string[], anchors: [] as string[] };
    (window as unknown as { foldSeen: typeof seen }).foldSeen = seen;
    // the app opens a web link with a detached anchor's click (lib/terminalFileLinks.ts openWebLink), which no listener sees
    const anchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { seen.anchors.push(this.href); anchorClick.call(this); };
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target instanceof HTMLAnchorElement) seen.anchors.push(target.href);
      else seen.taps.push(`${target?.className ?? "?"} @${Math.round(event.clientX)},${Math.round(event.clientY)}`);
    }, true);
  });
  // a link the fold opens lands here, not on the internet
  await context.route(/^https:\/\/example\.(com|org)\//, (route) => route.fulfill({ status: 200, contentType: "text/plain", body: "fold link" }));
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  // a timed-out wait says which one it was and what the pane showed: Playwright's own stack does not reach this file
  const wait = page.waitForFunction.bind(page);
  page.waitForFunction = ((fn: never, arg?: never, options?: never) => {
    const where = new Error().stack?.split("\n")[2]?.trim() ?? "";
    return wait(fn, arg, options).catch(async (cause: unknown) => {
      const shown = await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal");
        return { folded: host?.hasAttribute("data-folded"), scrollTop: host?.scrollTop, scrollHeight: host?.scrollHeight, clientHeight: host?.clientHeight, focused: document.activeElement?.className, composing: document.querySelector(".composition-view.active") !== null };
      }).catch(() => null);
      throw new Error(`${cause instanceof Error ? cause.message : String(cause)} ${where} ${JSON.stringify(shown)}`, { cause });
    });
  }) as typeof page.waitForFunction;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}?pane=${encodeURIComponent(panes.shell)}&view=terminal${query}`);
  await page.locator(".conn-live").waitFor();
  await appFaces(page);
  return { page, errors, close: () => context.close() };
}
const drawnScreen = (page: Page): Promise<unknown> => page.waitForFunction((grid) => document.querySelector(grid)?.textContent?.includes("FOLD-LAST"), shownRows(".pane-frame.is-current"));

const app = mkdtempSync(join(tmpdir(), "herdr-mirror-fold-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () =>
    `<script src="./demo-transport.js"></script>\n<script>(${installFoldFixture.toString()})(${JSON.stringify(SCREEN)}, ${COLS}, ${ROWS}, ${JSON.stringify(panes.shell)})</script>\n<script type="module"`));
  const prefix = "/herdr-web-ui/demo/app/";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const origin = `http://127.0.0.1:${server.port}${prefix}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const phone = await open(browser, origin, { width: 390, height: 844 }, true);
      const { page } = phone;
      try {
        await drawnScreen(page);

        // a phone: every row whole, folded to the screen's width, and nothing to pan sideways
        let seen = await rowsWhole(page, "390px phone");
        assert.ok(seen.folded, "390px phone: the mirror is drawn folded");
        assert.ok(seen.hostScrollWidth <= seen.hostClientWidth, `390px phone: the folded pane has nothing to pan sideways ${JSON.stringify(seen)}`);
        const fold = await page.evaluate(() => {
          const view = document.querySelector<HTMLElement>(".pane-frame.is-current .terminal-fold")!;
          const rows = [...view.querySelectorAll<HTMLElement>(".terminal-fold-row")].map((node) => node.textContent ?? "");
          const red = [...view.querySelectorAll<HTMLElement>("span")].find((span) => span.textContent?.includes("RED-SEGMENT"));
          return { rows, red: red ? getComputedStyle(red).color : null, plain: getComputedStyle(view).color };
        });
        assert.deepEqual(fold.rows, screenRows.map((text) => plain(text).trimEnd()), "the folded rows hold the grid's rows, each whole and in order");
        assert.ok(fold.red !== null && fold.red !== fold.plain, `a coloured run keeps its colour when folded (${fold.red} against ${fold.plain})`);
        assert.ok(inView(await foldedText(page, "FOLD-LAST")), "the cursor's row, the last one with text, is in view");
        // the hidden grid holds xterm's input (its helper textarea, an IME's preedit): its cursor row is in view too
        const gridCursor = await page.evaluate((rows) => {
          const host = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal")!;
          const screen = host.querySelector<HTMLElement>(".xterm-screen")!.getBoundingClientRect();
          const box = host.getBoundingClientRect();
          return { top: screen.top + (rows - 1) * screen.height / rows, bottom: screen.top + screen.height, viewTop: box.top + host.clientTop, viewBottom: box.top + host.clientTop + host.clientHeight };
        }, ROWS);
        assert.ok(gridCursor.top >= gridCursor.viewTop - 1 && gridCursor.bottom <= gridCursor.viewBottom + 1, `the grid's cursor row stays in view under the folded rows ${JSON.stringify(gridCursor)}`);

        // a cleared shell, its prompt on the first row: the folded rows keep it in sight, not the blank rows under it
        await page.setViewportSize({ width: 390, height: 600 });
        await pushScreen(page, frameOf(["PROMPT-TOP C:\\>"]));
        await page.waitForFunction(() => document.querySelector(".pane-frame.is-current .terminal-fold")?.textContent?.includes("PROMPT-TOP"));
        await settled(page);
        const prompt = await foldedText(page, "PROMPT-TOP");
        assert.ok(inView(prompt), `a prompt on the first row stays in view ${JSON.stringify(prompt)}`);
        await pushScreen(page, SCREEN);
        await page.waitForFunction(() => document.querySelector(".pane-frame.is-current .terminal-fold")?.textContent?.includes("FOLD-LAST"));
        await page.setViewportSize({ width: 390, height: 844 });
        await settled(page);

        // a link in the folded rows opens as the grid's own does: tapped on its last character's right half
        await opensTab(page, LINK, () => tapFolded(page, LINK, -1));
        // a labelled OSC 8 hyperlink opens its target, as on the grid
        await opensTab(page, OSC8, () => tapFolded(page, "OSC8-LABEL", 3));
        await opensTab(page, OSC8_REAL, () => tapFolded(page, OSC8_SHOWN, 12));


        // a wheel past the folded rows' top scrolls herdr's history at the chosen speed (2), as on the grid
        await page.waitForFunction(() => window.foldFixture.reads > 0);
        const box = await page.locator(".pane-frame.is-current .pane-terminal").boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        // up through the folded rows by wheel, as a user reads back: that pans them, and sends herdr nothing
        const scrollTop = (): Promise<number> => page.evaluate(() => document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal")!.scrollTop);
        for (let turns = 0; await scrollTop() > 1; turns++) {
          assert.ok(turns < 40, "the folded rows pan up to their top");
          await page.mouse.wheel(0, -400);
          await settled(page);
        }
        assert.deepEqual(await page.evaluate(() => window.foldFixture.offsets), [], "panning the folded rows leaves herdr's history alone");
        await page.mouse.wheel(0, -120);
        await page.waitForFunction(() => window.foldFixture.offsets.length > 0).catch(async (cause) => {
          throw new Error(`a wheel past the folded rows' top scrolled no history: ${JSON.stringify(await page.evaluate(() => ({ ...window.foldFixture, sockets: undefined, scrollTop: document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal")!.scrollTop })))}`, { cause });
        });
        assert.equal(await page.evaluate(() => window.foldFixture.offset), 6, "one wheel step moves 3 lines at speed 2");
        // back down: the folded rows pan to their end first, as an oversized grid does, then history returns
        for (let turns = 0; await page.evaluate(() => window.foldFixture.offset) !== 0; turns++) {
          assert.ok(turns < 40, "wheeling down returns the history to its end");
          await page.mouse.wheel(0, 400);
          await settled(page);
        }

        // a smaller Android phone, then the phone on its side: still folded, still whole
        for (const [width, height] of [[360, 800], [844, 390]] as const) {
          const before = await page.evaluate(() => document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal")!.clientWidth);
          await page.setViewportSize({ width, height });
          // 844px is past the phone layout: the pane is narrower than the window, and still narrower than the grid
          await page.waitForFunction((was) => {
            const host = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal");
            return host !== null && host.clientWidth !== was && host.hasAttribute("data-folded");
          }, before);
          await rowsWhole(page, `${width}x${height}`);
        }

        // the pane menu's way back, for a full-screen program: the grid at its width, panned sideways
        await page.setViewportSize({ width: 390, height: 844 });
        await foldState(page, true);
        await choose(page, "Original width", true);
        await foldState(page, false);
        seen = await visibleMarkers(page);
        assert.ok(seen.hostScrollWidth > seen.hostClientWidth, "Original width: the grid is as wide as on the PC, and pans");
        assert.equal(await savedWrap(page), false, "the choice is kept in this device's settings");
        await page.reload();
        await page.locator(".conn-live").waitFor();
        await drawnScreen(page);
        await page.waitForFunction(() => {
          const host = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal");
          return host !== null && host.hasAttribute("data-adopted-grid") && !host.hasAttribute("data-folded") && host.scrollWidth > host.clientWidth;
        });
        assert.equal(await page.locator(".pane-frame.is-current .pane-terminal[data-folded]").count(), 0, "a reload keeps the original width");
        await choose(page, "Wrap to screen", true);
        await foldState(page, true);
        assert.equal(await savedWrap(page), true, "Wrap to screen is kept too");

        // a phone that only watches the pane folds it too: a mirror's grid is the PC's either way
        await page.evaluate(() => window.foldFixture.sockets.at(-1)!.send(JSON.stringify({ type: "role", mode: "observe" })));
        await page.locator(".pane-frame.is-current .terminal-banner-observe").waitFor();
        await settled(page);
        await foldState(page, true);
        await rowsWhole(page, "a watching phone");
        await page.evaluate(() => window.foldFixture.sockets.at(-1)!.send(JSON.stringify({ type: "role", mode: "interact" })));
        await page.locator(".pane-frame.is-current .terminal-banner-observe").waitFor({ state: "detached" });

        // a Korean syllable composed on the cursor's row shows over the folded rows, where it will be typed
        // a tap on text that is no link: the terminal takes the typing
        await tapFolded(page, "FOLD-LAST", 2);
        await page.waitForFunction(() => document.activeElement?.classList.contains("xterm-helper-textarea"));
        await preeditOverFold(page, "a mirror");

        // a desktop the grid fits: drawn as it is, as before
        await page.setViewportSize({ width: 1440, height: 900 });
        await foldState(page, false);
        await rowsWhole(page, "1440px desktop, the grid fits");
        assert.deepEqual(phone.errors, []);
      } finally { await phone.close(); }

      // a desktop window narrower than the grid keeps the original width until its menu says Wrap to screen
      const desk = await open(browser, origin, { width: 1000, height: 800 }, false);
      try {
        await drawnScreen(desk.page);
        await desk.page.waitForFunction(() => {
          const host = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal");
          return host !== null && host.hasAttribute("data-adopted-grid") && host.scrollWidth > host.clientWidth;
        });
        const unfolded = await visibleMarkers(desk.page);
        assert.ok(!unfolded.folded && unfolded.hostScrollWidth > unfolded.hostClientWidth, `a desktop draws a wide mirror at its width by default ${JSON.stringify(unfolded)}`);
        await choose(desk.page, "Wrap to screen", false);
        await foldState(desk.page, true);
        await rowsWhole(desk.page, "a desktop that chose Wrap to screen");
        assert.deepEqual(desk.errors, []);
      } finally { await desk.close(); }

      // an attached PC's pane (no mirror) on a phone: fitted to the screen as before, never folded
      const attached = await open(browser, origin, { width: 390, height: 844 }, true, "&fold=off");
      try {
        await attached.page.waitForFunction((grid) => (document.querySelector(grid)?.textContent?.trim().length ?? 0) > 0, shownRows(".pane-frame.is-current"));
        await settled(attached.page);
        const state = await attached.page.evaluate(() => {
          const host = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal")!;
          return { folded: host.hasAttribute("data-folded"), fold: host.querySelector(".terminal-fold") !== null, scrollWidth: host.scrollWidth, clientWidth: host.clientWidth };
        });
        assert.deepEqual({ folded: state.folded, fold: state.fold }, { folded: false, fold: false }, "an attached pane is never folded");
        assert.ok(state.scrollWidth <= state.clientWidth + 1, `an attached pane fits the phone ${JSON.stringify(state)}`);
        assert.deepEqual(attached.errors, []);
      } finally { await attached.close(); }

      // an attached PC's pane whose pty another device sized wider than the phone (`fold=attached`: every
      // geometry of the pane says 120x40, as a desktop holding the size would)
      const wide = await open(browser, origin, { width: 390, height: 844 }, true, "&fold=attached");
      try {
        const { page: phone } = wide;
        const host = (): Promise<{ width: number }> => phone.evaluate(() => ({ width: document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal")!.clientWidth }));
        await phone.waitForFunction((grid) => window.foldFixture?.sockets.length > 0 && (document.querySelector(grid)?.textContent?.trim().length ?? 0) > 0, shownRows(".pane-frame.is-current"));
        await settled(phone);
        // driving: the phone sizes the pty and the program draws at its width (the other device's grid is not
        // adopted), so there is nothing to fold, and the menu has no width to choose
        assert.deepEqual(await fitState(phone), { folded: false, fold: false, fits: true }, "a driving phone's grid is its own, fitted: nothing folded");
        assert.ok(!(await sheetItems(phone)).includes("Original width"), "a driving phone's menu offers no Original width");

        // watching (a device paired to watch): the grid is the pty's, the other device's, wider than the phone: folded whole
        await phone.evaluate(() => window.foldFixture.sockets.at(-1)!.send(JSON.stringify({ type: "role", mode: "observe" })));
        await phone.locator(".pane-frame.is-current .terminal-banner-observe").waitFor();
        await phone.evaluate(({ pane, cols, rows, data }) => {
          const socket = window.foldFixture.sockets.at(-1)!;
          socket.push({ type: "pane-geometry", pane_id: pane, cols, rows });
          socket.push({ type: "pty-data", fixture: "fold", pane_id: pane, data });
        }, { pane: panes.shell, cols: COLS, rows: ROWS, data: SCREEN });
        await foldState(phone, true);
        await phone.waitForFunction(() => document.querySelector(".pane-frame.is-current .terminal-fold")?.textContent?.includes("FOLD-LAST"));
        const watching = await rowsWhole(phone, "a phone watching an attached pane");
        assert.ok(watching.hostScrollWidth <= watching.hostClientWidth, `a watched pane folded has nothing to pan sideways ${JSON.stringify(watching)}`);
        assert.deepEqual(await phone.evaluate(() => [...document.querySelectorAll(".pane-frame.is-current .terminal-fold-row")].map((node) => node.textContent ?? "")),
          screenRows.map((text) => plain(text).trimEnd()), "the folded rows are the attach stream's rows, each whole and in order");
        // Korean folds at its spaces, each word whole (word-break: keep-all), its wide glyphs inside the screen
        const broken = await phone.evaluate((words) => {
          const row = [...document.querySelectorAll<HTMLElement>(".pane-frame.is-current .terminal-fold-row")].find((node) => node.textContent?.includes(words[0]!))!;
          const text = row.textContent ?? "";
          const nodes: Text[] = [];
          for (let walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT), node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
          const place = (offset: number): [Text, number] => {
            for (const node of nodes) {
              if (offset <= node.data.length) return [node, offset];
              offset -= node.data.length;
            }
            return [nodes.at(-1)!, nodes.at(-1)!.data.length];
          };
          return words.filter((word) => {
            const at = text.indexOf(word);
            const range = document.createRange();
            range.setStart(...place(at));
            range.setEnd(...place(at + word.length));
            return new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top))).size !== 1;
          });
        }, ["한글", "줄바꿈:", "오른쪽", "끝까지", "보여야", "합니다"]);
        assert.deepEqual(broken, [], "a watched pane's Korean words fold whole");
        assert.ok((await sheetItems(phone)).includes("Original width"), "a watching phone's menu offers Original width for the wide pane");
        // a larger Android phone, both phones on their side, and back: still folded, still whole
        for (const [width, height] of [[412, 915], [915, 412], [844, 390], [390, 844]] as const) {
          const before = (await host()).width;
          await phone.setViewportSize({ width, height });
          await phone.waitForFunction((was) => {
            const node = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal");
            return node !== null && node.clientWidth !== was && node.hasAttribute("data-folded");
          }, before);
          await rowsWhole(phone, `watching at ${width}x${height}`);
        }

        // Original width: the pty's grid as the other device sized it, panned sideways; a full-screen program's boxes whole
        await choose(phone, "Original width", true);
        await foldState(phone, false);
        assert.equal(await savedWrap(phone), false, "the choice is the same device setting as a mirror's");
        await pushScreen(phone, TUI);
        await phone.waitForFunction(({ top, row }) => document.querySelector(row)?.textContent === top, { top: tuiRows[0], row: shownRow(".pane-frame.is-current") });
        // a finger pans the grid sideways to the box's right edge
        for (let turns = 0; ; turns++) {
          const before = (await hostScroll(phone)).left;
          await swipe(phone, -240, 0);
          await settled(phone);
          const after = (await hostScroll(phone)).left;
          if (turns === 0) assert.ok(after > before, `Original width: a swipe pans the watched grid sideways (${before} -> ${after})`);
          if (after === before) break;
          assert.ok(turns < 20, "the swipes reach the grid's right edge");
        }
        const corner = await phone.evaluate((shown) => {
          const node = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal")!;
          const row = node.querySelector(shown)!;
          let last: Text | null = null;
          for (let walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT), each = walker.nextNode(); each; each = walker.nextNode()) if ((each as Text).data.length > 0) last = each as Text;
          const range = document.createRange();
          range.setStart(last!, last!.data.length - 1);
          range.setEnd(last!, last!.data.length);
          const glyph = range.getBoundingClientRect();
          const box = node.getBoundingClientRect();
          return { glyph: last!.data.at(-1), left: glyph.left, right: glyph.right, viewLeft: box.left + node.clientLeft, viewRight: box.left + node.clientLeft + node.clientWidth, scrollLeft: node.scrollLeft, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
        }, shownRow());
        assert.ok(corner.scrollWidth > corner.clientWidth && corner.scrollLeft > 0, `Original width: the watched grid pans sideways ${JSON.stringify(corner)}`);
        assert.ok(corner.glyph === "┐" && corner.left >= corner.viewLeft - 1 && corner.right <= corner.viewRight + 1, `a TUI's right edge comes into view when panned ${JSON.stringify(corner)}`);
        // Wrap to screen again: the boxes fold with the text, nothing cut off or panned
        await choose(phone, "Wrap to screen", true);
        await foldState(phone, true);
        await phone.waitForFunction(() => document.querySelector(".pane-frame.is-current .terminal-fold")?.textContent?.includes("┌"));
        assert.equal(await savedWrap(phone), true);
        assert.ok((await fitState(phone)).fits, "a folded TUI has nothing to pan sideways");
        await pushScreen(phone, `\x1b[?1049l${SCREEN}`);

        // driving again: the phone fits the pty once more, unfolded
        await phone.evaluate(() => window.foldFixture.sockets.at(-1)!.send(JSON.stringify({ type: "role", mode: "interact" })));
        await phone.locator(".pane-frame.is-current .terminal-banner-observe").waitFor({ state: "detached" });
        await phone.waitForFunction(() => {
          const node = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal");
          return node !== null && !node.hasAttribute("data-folded") && node.scrollWidth <= node.clientWidth + 1;
        });

        // under its soft keyboard a driving phone keeps the grid it shows (#1045) and draws the pane at the grid
        // another device left the pty at: folded until the keyboard goes, xterm's input where its text will show
        await phone.evaluate(({ pane, cols, rows }) => window.foldFixture.sockets.at(-1)!.push({ type: "pane-geometry", pane_id: pane, cols, rows }), { pane: panes.shell, cols: COLS, rows: ROWS });
        // the mouse reported, as herdr's attach always has it: the fold does not wait for a program that takes no clicks
        await pushScreen(phone, HERDR_MOUSE);
        await phone.evaluate(() => document.querySelector<HTMLTextAreaElement>(".pane-frame.is-current .xterm-helper-textarea")!.focus());
        await phone.setViewportSize({ width: 390, height: 470 });
        await phone.waitForFunction(() => document.documentElement.hasAttribute("data-keyboard"));
        await foldState(phone, true);
        await pushScreen(phone, SCREEN);
        await phone.waitForFunction(() => document.querySelector(".pane-frame.is-current .terminal-fold")?.textContent?.includes("FOLD-LAST"));
        await rowsWhole(phone, "under the keyboard, at another device's grid");
        assert.ok(inView(await foldedText(phone, "FOLD-LAST")), "under the keyboard, the cursor's row is in view");
        await preeditOverFold(phone, "under the keyboard, at another device's grid");
        // the folded rows pan under the keyboard too, by wheel and by finger, before a swipe scrolls the program
        const bottom = await hostScroll(phone);
        const middle = await phone.locator(".pane-frame.is-current .pane-terminal").boundingBox();
        assert.ok(middle);
        await phone.mouse.move(middle.x + middle.width / 2, middle.y + middle.height / 2);
        await phone.mouse.wheel(0, -200);
        await phone.waitForFunction((was) => document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal")!.scrollTop < was, bottom.top);
        const wheeled = await hostScroll(phone);
        await swipe(phone, 0, -120);
        await settled(phone);
        const swiped = await hostScroll(phone);
        assert.ok(swiped.top > wheeled.top, `under the keyboard, a swipe pans the folded rows (${wheeled.top} -> ${swiped.top})`);
        // a shell's caret in a long command line that folds into several lines, moved back into its first one,
        // then onto its last: the caret is drawn where it is, and a preedit stands on it, not at the line's end
        const command = `$ CARET-LINE ${"x".repeat(COLS - 30)} TAIL`;
        for (const at of [{ col: 6, glyph: "E", first: true }, { col: command.indexOf(" TAIL") + 2, glyph: "T", first: false }]) {
          await pushScreen(phone, `\x1b[?25l\x1b[0m\x1b[H\x1b[2J${[...Array.from({ length: ROWS - 1 }, (_, index) => `R${index + 1}`), command].join("\r\n")}\x1b[${ROWS};${at.col}H\x1b[?25h`);
          await phone.waitForFunction((glyph) => document.querySelector(".pane-frame.is-current .terminal-fold-cursor")?.textContent === glyph, at.glyph);
          await phone.evaluate(() => document.querySelector<HTMLTextAreaElement>(".pane-frame.is-current .xterm-helper-textarea")!.focus());
          await settled(phone);
          const caret = await phone.evaluate(() => {
            const node = document.querySelector<HTMLElement>(".pane-frame.is-current .terminal-fold-cursor")!;
            const row = node.closest<HTMLElement>(".terminal-fold-row")!;
            const box = node.getBoundingClientRect();
            const rowBox = row.getBoundingClientRect();
            const line = parseFloat(getComputedStyle(row).lineHeight);
            const style = getComputedStyle(node);
            return { top: box.top, left: box.left, rowTop: rowBox.top, rowHeight: rowBox.height, line,
              lineTop: rowBox.top + Math.floor((box.top + box.height / 2 - rowBox.top) / line) * line, background: style.backgroundColor, shadow: style.boxShadow };
          });
          assert.ok(caret.rowHeight >= caret.line * 2 - 1, `the command line folds into several lines ${JSON.stringify(caret)}`);
          assert.ok(at.first ? caret.lineTop === caret.rowTop : caret.lineTop > caret.rowTop, `the caret is on the ${at.first ? "first" : "last"} of them ${JSON.stringify(caret)}`);
          assert.ok(caret.background !== "rgba(0, 0, 0, 0)" || caret.shadow !== "none", `the caret is drawn ${JSON.stringify(caret)}`);
          const ime = await phone.context().newCDPSession(phone);
          await ime.send("Input.imeSetComposition", { text: "한", selectionStart: 1, selectionEnd: 1 });
          await phone.locator(".pane-frame.is-current .composition-view.active").waitFor();
          const preedit = await phone.evaluate(() => {
            const view = document.querySelector<HTMLElement>(".pane-frame.is-current .composition-view.active")!;
            const box = view.getBoundingClientRect();
            const host = view.closest<HTMLElement>(".pane-terminal")!;
            const xterm = host.querySelector<HTMLElement>(".xterm")!;
            // where the grid and the input stood, for a failure to say
            return { top: box.top, bottom: box.bottom, left: box.left, at: view.style.left, gridLeft: host.querySelector(".xterm-screen")!.getBoundingClientRect().left, shift: xterm.style.left, scrolled: xterm.scrollLeft };
          });
          const preeditMiddle = (preedit.top + preedit.bottom) / 2;
          assert.ok(Math.abs(preedit.left - caret.left) <= 2 && preeditMiddle >= caret.lineTop && preeditMiddle <= caret.lineTop + caret.line,
            `the preedit stands on the caret (${at.glyph}) ${JSON.stringify({ preedit, caret })}`);
          await ime.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
          await phone.locator(".pane-frame.is-current .composition-view.active").waitFor({ state: "detached" });
          await ime.detach();
        }
        // the keyboard goes: the catch-up fit takes the pane back to the phone's grid, unfolded
        await phone.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await phone.setViewportSize({ width: 390, height: 844 });
        await phone.waitForFunction(() => !document.documentElement.hasAttribute("data-keyboard"));
        await phone.waitForFunction(() => {
          const node = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal");
          return node !== null && !node.hasAttribute("data-folded") && node.scrollWidth <= node.clientWidth + 1;
        });
        assert.deepEqual(wide.errors, []);
      } finally { await wide.close(); }

      console.log(`PASS mirror fold: ${COLS}x${ROWS} mirror folded whole at 390, 360 and 844 (landscape), cursor rows and a top prompt in view, a preedit drawn over them, a link opens on its last glyph and an OSC 8 label (an address-shaped one too) opens its target, history wheels at speed, Original width pans and survives a reload, a watching phone folds, desktops keep the width until Wrap to screen, an attached pane folded while watched or under the keyboard at another device's wider grid (390, 412 and both on their side; panned by finger and wheel, with herdr's mouse reporting on; a caret back in a long folded line drawn, its preedit on it), Korean words whole, Original width pans a TUI to its edge by finger, and fitted, unfolded while it drives`);
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
