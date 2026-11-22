/**
 * herdr's own server is
 * drawn by libghostty too, and so is a device that turned the old Draw with libghostty switch off; xterm
 * draws an iTerm2 picture by itself. Demo fixtures only: no herdr, hc or user state.
 */
import { deflateSync } from "node:zlib";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { readableColor } from "../src/lib/terminalFold.ts";
import { openSettingsPage } from "./settings-page.ts";
import { serveDemo } from "./demo-server.ts";

interface Frame { type: string; pane_id?: string; data?: string; text?: string; features?: string[] }
interface GhosttyFixture { inputs: Frame[]; print(data: string): void; geometry(cols: number, rows: number): void }
interface RulerColumns { latin: number; hangul: number; after: number }
declare global { interface Window { ghosttyFixture: GhosttyFixture; ghosttyRuler?: () => RulerColumns } }

function installGhosttyFixture(): void {
  const core = new URL(location.href).searchParams.get("server") === "core";
  const first = "\x1b[H\x1b[2JBEFORE-LOAD\r\n";
  const sockets: Array<WebSocket & { push(frame: Record<string, unknown>): void }> = [];
  let pane: string | null = null;
  let featured = false;
  let waiting: (() => void) | null = null;
  const state: GhosttyFixture = {
    inputs: [],
    print: (data) => { for (const socket of sockets) if (pane) socket.push({ type: "pty-data", fixture: "ghostty", pane_id: pane, data }); },
    geometry: (cols, rows) => { for (const socket of sockets) if (pane) socket.push({ type: "pane-geometry", pane_id: pane, cols, rows }); },
  };
  window.ghosttyFixture = state;
  const Demo = window.WebSocket;
  const Recorded = function (url: string | URL, protocols?: string | string[]) {
    const socket = new Demo(url, protocols) as (typeof sockets)[number];
    sockets.push(socket);
    const push = socket.push.bind(socket);
    socket.push = (frame) => {
      if ((frame.type === "snapshot" || frame.type === "features") && Array.isArray(frame.features) && core) {
        push({ ...frame, features: [...(frame.features as string[]), "terminal-history"] });
      } else if (frame.type === "pty-data") {
        if (frame.fixture !== "ghostty") return;
        const { fixture: _, ...output } = frame;
        push(output);
      } else push(frame);
      if (frame.type === "snapshot" || frame.type === "features") {
        featured = true;
        waiting?.();
        waiting = null;
      }
    };
    const send = socket.send.bind(socket);
    socket.send = (raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      if (["input", "keys", "submit"].includes(frame.type)) state.inputs.push(frame);
      send(raw);
      if (frame.type === "attach" && frame.pane_id) {
        pane = frame.pane_id;
        const paint = () => socket.push({ type: "pty-data", fixture: "ghostty", pane_id: frame.pane_id, data: first });
        if (featured) paint();
        else waiting = paint;
      }
    };
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(Recorded, name, { value: Demo[name] });
  window.WebSocket = Recorded as unknown as typeof WebSocket;
}

const kittySquare = (id: number, rgb: [number, number, number]): string => {
  const pixels = Buffer.alloc(4 * 4 * 4);
  for (let i = 0; i < 16; i++) pixels.set([...rgb, 255], i * 4);
  return `\x1b_Ga=T,f=32,s=4,v=4,i=${id},c=4,r=2,q=2;${pixels.toString("base64")}\x1b\\`;
};

const itermSquare = (): string => {
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(Bun.hash.crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(24, 0);
  header.writeUInt32BE(24, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), ...Array.from({ length: 24 }, () => Buffer.from([0, 128, 0]))]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: 24 }, () => row)))), chunk("IEND", new Uint8Array())]);
  return `\x1b]1337;File=inline=1;size=${png.length}:${png.toString("base64")}\x07`;
};

const settled = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const print = async (page: Page, data: string, marker: string) => {
  await page.evaluate((data) => window.ghosttyFixture.print(data), `${data}${marker}\r\n`);
  await page.waitForFunction((marker) => [...document.querySelectorAll(".pane-frame.is-current .ghostty-row")].some((row) => row.textContent?.includes(marker)), marker);
  await settled(page);
};
const picture = (page: Page) => page.evaluate(() => {
  const canvases = [...document.querySelectorAll<HTMLCanvasElement>(".pane-frame.is-current .ghostty-image")];
  if (canvases.length !== 1) return canvases.length === 0 ? null : { count: canvases.length };
  const canvas = canvases[0]!;
  const [r, g, b] = canvas.getContext("2d")!.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
  return { rgb: [r, g, b], width: canvas.style.width, top: canvas.style.top };
});

async function open(browser: Browser, server: number, prefix: string, kind: "core" | "herdr", { storedOff = false, noModule = false, images = false } = {}): Promise<{ page: Page; wasm: string[]; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await context.addInitScript(([storedOff, images]) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", terminalInputMode: "direct", alertsOn: false }));
    if (storedOff) localStorage.setItem("ovis:terminal-ghostty", "false");
    localStorage.setItem("ovis:terminal-pictures", JSON.stringify(images));
  }, [storedOff, images] as const);
  if (noModule) await context.route(/\.wasm$/, (route) => route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const wasm: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => { if (request.url().endsWith(".wasm")) wasm.push(request.url()); });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "warning" && message.text().includes("libghostty")) errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server}${prefix}?pane=${encodeURIComponent(panes.shell)}&view=terminal&server=${kind}`);
  // Either renderer can paint the first replay; xterm stops painting once libghostty takes over.
  await page.locator(".pane-frame.is-current :is(.xterm-rows, .ghostty-row)", { hasText: "BEFORE-LOAD" }).filter({ visible: true }).first().waitFor();
  return { page, wasm, errors };
}

const app = mkdtempSync(join(tmpdir(), "terminal-ghostty-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n<script>(${installGhosttyFixture.toString()})()</script>\n<script type="module"`));
  const prefix = "/herdr-web-ui/demo/app/";
  const server = serveDemo(app, { prefix });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      {
        const { page, wasm, errors } = await open(browser, server.port, prefix, "core");
        await page.locator(".pane-frame.is-current .pane-terminal[data-renderer='ghostty']").waitFor();
        await page.waitForFunction(() => [...document.querySelectorAll(".pane-frame.is-current .ghostty-row")].some((row) => row.textContent?.includes("BEFORE-LOAD")));
        assert.equal(wasm.length, 1, "core: the module is fetched once");
        assert.equal(await page.locator(".pane-frame.is-current .xterm-rows").evaluate((rows) => getComputedStyle(rows).visibility), "hidden", "core: xterm's own text is hidden under libghostty's");

        const announced = () => page.evaluate(() => document.querySelector(".pane-frame.is-current .ghostty-layer [aria-live]")?.textContent ?? null);
        assert.equal(await announced(), "", "core: the screen a pane opens on is not announced");
        await print(page, "SPOKEN-LINE\r\n", "SPOKEN-DONE");
        assert.ok((await announced())?.includes("SPOKEN-LINE"), `core: a line the program writes is announced (${JSON.stringify(await announced())})`);
        assert.equal(await page.locator(".pane-frame.is-current .xterm-rows", { hasText: "SPOKEN-LINE" }).count(), 0, "core: xterm no longer redraws its hidden rows");
        await print(page, Array.from({ length: 60 }, (_, i) => `OLD-${String(i).padStart(2, "0")}`).join("\r\n") + "\r\n", "FILL-DONE");
        await print(page, "NEW-ONLY-LINE\r\n", "NEW-DONE");
        const scrolled = await announced();
        assert.ok(scrolled?.includes("NEW-ONLY-LINE") && !scrolled.includes("OLD-"), `core: a scroll announces only the new line (${JSON.stringify(scrolled)})`);

        const topRow = () => page.evaluate(() => document.querySelector(".pane-frame.is-current .ghostty-row")?.textContent ?? "");
        const screenBox = (await page.locator(".pane-frame.is-current .xterm-screen").boundingBox())!;
        await page.mouse.move(screenBox.x + screenBox.width / 2, screenBox.y + screenBox.height / 3);
        const shownTop = await topRow();
        await page.mouse.wheel(0, -600);
        await page.waitForFunction((top) => document.querySelector(".pane-frame.is-current .ghostty-row")?.textContent !== top, shownTop);
        await settled(page);
        assert.equal(await announced(), scrolled, "core: scrolling back announces nothing");
        await page.mouse.wheel(0, 20000);
        await page.waitForFunction((top) => document.querySelector(".pane-frame.is-current .ghostty-row")?.textContent === top, shownTop);
        await settled(page);
        assert.equal(await announced(), scrolled, "core: scrolling back down announces nothing");

        await print(page, `\x1b[5;3H${kittySquare(7, [255, 0, 0])}`, "RED-PLACED");
        const red = await picture(page);
        assert.deepEqual(red?.rgb, [255, 0, 0], `core: the Kitty picture is drawn (${JSON.stringify(red)})`);
        const cell = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".pane-frame.is-current .ghostty-layer")!).getPropertyValue("--ghostty-ch")));
        assert.equal(red?.top, `${4 * cell}px`, "core: at the row it was placed on");

        await print(page, "\x1b[31mRED-TEXT\x1b[0m\r\n", "COLOURED");
        const ansiRed = await page.evaluate(() => {
          const span = [...document.querySelectorAll<HTMLElement>(".pane-frame.is-current .ghostty-row span")].find((s) => s.textContent?.includes("RED-TEXT"))!;
          const rgb = (css: string) => `#${(css.match(/\d+/g) ?? []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
          return { color: rgb(getComputedStyle(span).color), background: rgb(getComputedStyle(document.querySelector(".pane-frame.is-current .xterm-viewport")!).backgroundColor), token: getComputedStyle(document.documentElement).getPropertyValue("--term-red").trim() || "#cc0000" };
        });
        assert.equal(ansiRed.color, readableColor(ansiRed.token, ansiRed.background, 4.5), "core: ANSI red follows the theme token (or xterm's default), made readable as xterm makes it");

        await print(page, "e\u0301\u754cX\r\n", "COMBINED");
        assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".pane-frame.is-current .ghostty-wide")].map((cell) => cell.textContent)), ["\u754c"], "core: the wide cell is the CJK character, not the accent");

        // an emoji ZWJ sequence is one two-column cell, as xterm (the cursor, selection and links) counts it
        await print(page, "ABC\u{1F468}\u200D\u{1F469}\u200D\u{1F467}XYZ\r\n", "ZWJ");
        const zwj = await page.evaluate(() => {
          const layer = document.querySelector(".pane-frame.is-current .ghostty-layer")!;
          const span = [...layer.querySelectorAll<HTMLElement>(".ghostty-row > span")].find((s) => s.textContent?.includes("XYZ"))!;
          const node = [...span.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.startsWith("XYZ"))!;
          const range = document.createRange();
          range.setStart(node, 0);
          range.setEnd(node, 1);
          const cw = parseFloat(getComputedStyle(layer).getPropertyValue("--ghostty-cw"));
          return { column: (range.getBoundingClientRect().left - layer.getBoundingClientRect().left) / cw, wide: [...span.querySelectorAll(".ghostty-wide")].map((cell) => cell.textContent) };
        });
        assert.deepEqual(zwj.wide, ["\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"], "core: the ZWJ family is one wide cell");
        assert.ok(Math.abs(zwj.column - 5) < 0.1, `core: the text after a ZWJ family starts at xterm's column 5 (${zwj.column})`);

        const cursorLeft = () => page.evaluate(() => parseFloat(document.querySelector<HTMLElement>(".pane-frame.is-current .ghostty-cursor")!.style.left));
        await page.evaluate(() => window.ghosttyFixture.print("ab"));
        await page.waitForFunction(() => parseFloat(document.querySelector<HTMLElement>(".pane-frame.is-current .ghostty-cursor")!.style.left) > 0);
        const afterText = await cursorLeft();
        await page.evaluate(() => window.ghosttyFixture.print("\x1b[D"));
        await page.waitForFunction((left) => parseFloat(document.querySelector<HTMLElement>(".pane-frame.is-current .ghostty-cursor")!.style.left) < left, afterText);
        assert.ok(Math.abs(await cursorLeft() - afterText / 2) < 0.5, `core: a Left arrow moves the drawn cursor back one cell (${afterText} -> ${await cursorLeft()})`);
        await print(page, "\r\n", "ARROWS");

        await print(page, "\x1b[4m\uD55C\x1b[24m\ue0a0Q|\ue0b0\r\nPLAIN-Q\r\n", "GLYPHS");
        await page.evaluate(() => document.fonts.ready);
        await settled(page);
        const glyphs = await page.evaluate(() => {
          const layer = document.querySelector(".pane-frame.is-current .ghostty-layer")!;
          const cw = parseFloat(getComputedStyle(layer).getPropertyValue("--ghostty-cw"));
          const row = [...layer.querySelectorAll<HTMLElement>(".ghostty-row")].find((r) => r.textContent?.includes("Q|"))!;
          const plain = [...layer.querySelectorAll<HTMLElement>(".ghostty-row")].find((r) => r.textContent?.includes("PLAIN-Q"))!;
          const box = (char: string, within = row) => {
            const walker = document.createTreeWalker(within, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              const at = node.textContent?.indexOf(char) ?? -1;
              if (at < 0) continue;
              const range = document.createRange();
              range.setStart(node, at);
              range.setEnd(node, at + char.length);
              return { rect: range.getBoundingClientRect(), parent: node.parentElement! };
            }
            throw new Error(`no ${char} in the row`);
          };
          const hangul = box("\uD55C");
          const icon = box("\ue0a0");
          const left = layer.getBoundingClientRect().left;
          const top = row.getBoundingClientRect().top;
          const ch = parseFloat(getComputedStyle(layer).getPropertyValue("--ghostty-ch"));
          return {
            fill: hangul.rect.width / (2 * cw),
            underline: getComputedStyle(hangul.parent).textDecorationLine,
            icon: icon.rect.width / cw,
            iconInRow: icon.rect.top >= top - 0.5 && icon.rect.bottom <= top + ch + 0.5,
            separator: box("\ue0b0").rect.height / ch,
            textDrop: (box("Q").rect.top - top) - (box("Q", plain).rect.top - plain.getBoundingClientRect().top),
            column: (box("Q").rect.left - left) / cw,
          };
        });
        assert.ok(glyphs.fill >= 0.88, `core: a Hangul syllable fills its two cells as xterm draws it (${glyphs.fill})`);
        assert.ok(glyphs.underline.includes("underline"), `core: an underlined Hangul syllable is underlined (${glyphs.underline})`);
        assert.ok(glyphs.icon <= 1.05, `core: a Nerd Font icon stays in its one cell (${glyphs.icon} cells)`);
        assert.ok(glyphs.iconInRow, "core: a fitted icon stands inside its row, not on its clipped box's bottom edge");
        assert.ok(glyphs.separator >= 0.75, `core: a Powerline separator keeps the row's full height (${glyphs.separator} rows)`);
        assert.ok(Math.abs(glyphs.textDrop) < 0.5, `core: the text after an icon stands on the row's baseline (${glyphs.textDrop}px lower)`);
        assert.ok(Math.abs(glyphs.column - 3) < 0.1, `core: the text after them starts at xterm's column 3 (${glyphs.column})`);

        // a bold, coloured, underlined wide cell: bold (xterm's own rule would set its box to normal), and its underline in its colour
        await print(page, "\x1b[1;32;4m\uAC00\x1b[0m|\r\n", "BOLDLINE");
        const boldLine = await page.evaluate(() => {
          const glyph = [...document.querySelectorAll<HTMLElement>(".pane-frame.is-current .ghostty-wide, .pane-frame.is-current .ghostty-fit")].filter((el) => el.textContent === "\uAC00").at(-1)!;
          const lined = glyph.closest<HTMLElement>("[style*='text-decoration']")!;
          return { weight: getComputedStyle(glyph).fontWeight, glyph: getComputedStyle(glyph).color, line: getComputedStyle(lined).textDecorationColor, lineColor: getComputedStyle(lined).color };
        });
        assert.ok(Number(boldLine.weight) >= 600, `core: a bold wide cell is drawn bold (${boldLine.weight})`);
        assert.equal(boldLine.line === "currentcolor" ? boldLine.lineColor : boldLine.line, boldLine.glyph, "core: an underline is in its text's colour");

        await print(page, "\x1b_Ga=d,d=I,i=7,q=2\x1b\\", "RED-DELETED");
        assert.equal(await picture(page), null, "core: a picture the program deletes goes");

        await print(page, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\uAC00~\r\n", "RULER");
        await page.evaluate(() => { window.ghosttyRuler = () => {
          const layer = document.querySelector(".pane-frame.is-current .ghostty-layer")!;
          const cw = parseFloat(getComputedStyle(layer).getPropertyValue("--ghostty-cw"));
          const row = [...layer.querySelectorAll<HTMLElement>(".ghostty-row")].find((r) => r.textContent?.startsWith("ABCDEFGHIJ"))!;
          const at = (char: string) => {
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              const index = node.textContent?.indexOf(char) ?? -1;
              if (index < 0) continue;
              const range = document.createRange();
              range.setStart(node, index);
              range.setEnd(node, index + 1);
              return (range.getBoundingClientRect().left - row.getBoundingClientRect().left) / cw;
            }
            throw new Error(`no ${char} in the ruler`);
          };
          return { latin: at("j"), hangul: at("\uAC00"), after: at("~") };
        }; });
        const columnsKept = async (when: string) => {
          const kept = await page.waitForFunction(() => {
            const columns = window.ghosttyRuler!();
            return Math.abs(columns.latin - 35) < 0.2 && Math.abs(columns.hangul - 36) < 0.2 && Math.abs(columns.after - 38) < 0.2;
          }, undefined, { timeout: 5000 }).then(() => true, () => false);
          assert.ok(kept, `core, ${when}: Latin keeps xterm's cells, and the Hangul and Latin after it their columns (${JSON.stringify(await page.evaluate(() => window.ghosttyRuler!()))})`);
        };
        // the spacing a fit taken against xterm's old screen leaves behind (the cell read as 928px over 110 columns instead of
        // 119): the next fit, at the new grid, must space the layer from the font alone, not from what is left
        const staleFit = () => page.evaluate(() => { document.querySelector<HTMLElement>(".pane-frame.is-current .ghostty-layer")!.style.letterSpacing = "0.64px"; });
        for (const width of [1100, 1137, 1174, 1211]) {
          await staleFit();
          await page.setViewportSize({ width, height: 900 });
          await columnsKept(`a ${width}px window after a fit against the old screen`);
        }
        for (const view of ["Chat", "Terminal", "Chat", "Terminal"]) {
          await page.getByRole("radio", { name: view, exact: true }).or(page.getByRole("button", { name: view, exact: true })).first().click();
          if (view === "Terminal") {
            await page.locator(".pane-frame.is-current .pane-terminal[data-renderer='ghostty']").waitFor();
            await columnsKept("back from Chat");
          }
        }
        // the chat lens adopts the pane's grid as another device sizes it. xterm's renderer is paused under it: it tells a resize
        // at once but resizes its screen from an idle task, and the screen sits in a `content-visibility: hidden` subtree where
        // no ResizeObserver fires. A grid widened and given back under Chat left a layer sized from the screen measuring the
        // wide screen against this device's columns, every cell three times its glyph once back (#3366)
        const grid = await page.evaluate(() => {
          const layer = document.querySelector(".pane-frame.is-current .ghostty-layer")!;
          const screen = document.querySelector<HTMLElement>(".pane-frame.is-current .xterm-screen")!;
          const cell = (name: string) => parseFloat(getComputedStyle(layer).getPropertyValue(name));
          return { cols: Math.round(screen.offsetWidth / cell("--ghostty-cw")), rows: Math.round(screen.offsetHeight / cell("--ghostty-ch")), width: screen.style.width };
        });
        await page.getByRole("radio", { name: "Chat", exact: true }).or(page.getByRole("button", { name: "Chat", exact: true })).first().click();
        await page.waitForFunction(() => getComputedStyle(document.querySelector(".pane-frame.is-current .pane-terminal")!).contentVisibility === "hidden", undefined, { timeout: 5000 });
        await settled(page);
        await page.evaluate(({ cols, rows }) => window.ghosttyFixture.geometry(cols * 3, rows), grid);
        await page.waitForFunction((width) => document.querySelector<HTMLElement>(".pane-frame.is-current .xterm-screen")!.style.width !== width, grid.width);
        await page.evaluate(({ cols, rows }) => window.ghosttyFixture.geometry(cols, rows), grid);
        await page.getByRole("radio", { name: "Terminal", exact: true }).or(page.getByRole("button", { name: "Terminal", exact: true })).first().click();
        await page.locator(".pane-frame.is-current .pane-terminal[data-renderer='ghostty']").waitFor();
        // xterm resizes its screen from an idle task: compare cells once the screen is the given-back grid's again
        await page.waitForFunction((width) => document.querySelector<HTMLElement>(".pane-frame.is-current .xterm-screen")!.style.width === width, grid.width, { timeout: 5000 });
        const cells = await page.evaluate((cols) => ({
          layer: parseFloat(getComputedStyle(document.querySelector(".pane-frame.is-current .ghostty-layer")!).getPropertyValue("--ghostty-cw")),
          xterm: document.querySelector<HTMLElement>(".pane-frame.is-current .xterm-screen")!.offsetWidth / cols,
        }), grid.cols);
        assert.ok(Math.abs(cells.layer - cells.xterm) < 0.01, `core, back from Chat after a grid widened and given back there: the layer's cell is xterm's (${JSON.stringify(cells)})`);
        await columnsKept("back from Chat, where another device widened the grid and gave it back");
        await page.getByRole("button", { name: "Settings", exact: true }).first().click();
        await openSettingsPage(page, "Appearance");
        for (const step of ["Increase", "Increase", "Increase", "Decrease", "Decrease"]) {
          await staleFit();
          await page.getByRole("button", { name: `${step} terminal font size`, exact: true }).click();
          await columnsKept(`${step} terminal font size after a fit against the old screen`);
        }
        await page.keyboard.press("Escape");
        await page.locator(".settings-dialog").waitFor({ state: "detached" });

        await page.locator(".pane-frame.is-current .pane-terminal").click();
        await page.keyboard.type("x");
        await page.waitForFunction(() => window.ghosttyFixture.inputs.some((frame) => frame.type === "input" && frame.text === "x"));
        assert.deepEqual(errors, [], "core: no page errors");
        await page.context().close();
      }
      {
        // an iTerm2 picture (Pictures in the terminal): libghostty cannot draw it, xterm's image addon does and moves its
        // cursor past it, so the text after it must be shown on the row xterm alone shows it on (#2980)
        const shownRow = async (ghostty: boolean) => {
          const { page, errors } = await open(browser, server.port, prefix, "core", { noModule: !ghostty, images: true });
          if (ghostty) await page.locator(".pane-frame.is-current .pane-terminal[data-renderer=ghostty]").waitFor();
          else await page.locator(".pane-frame.is-current .xterm-rows", { hasText: "BEFORE-LOAD" }).waitFor();
          await page.waitForFunction(() => typeof (document.querySelector(".pane-frame.is-current .xterm") as { imageAt?: unknown } | null)?.imageAt === "function");
          await page.evaluate((data) => window.ghosttyFixture.print(data), `\x1b[2J\x1b[H${itermSquare()}IT2-AFTER\r\n`);
          const row = await page.waitForFunction(() => {
            const layer = document.querySelector(".pane-frame.is-current .pane-terminal[data-renderer=ghostty]");
            const rows = [...document.querySelectorAll(layer ? ".pane-frame.is-current .ghostty-row" : ".pane-frame.is-current .xterm-rows > div")];
            const index = rows.findIndex((row) => row.textContent?.includes("IT2-AFTER"));
            return index >= 0 ? { index } : null;
          }).then(async (handle) => (await handle.jsonValue())!.index);
          assert.equal(await page.locator(".pane-frame.is-current .pane-terminal[data-renderer]").count(), 0, `core, iTerm2 picture${ghostty ? "" : ", no module"}: xterm draws the pane`);
          const picture = await page.evaluate(() => (document.querySelector(".pane-frame.is-current .xterm") as HTMLElement & { imageAt?: (col: number, row: number) => unknown }).imageAt?.(0, 0) ?? null);
          assert.notEqual(picture, null, `core, iTerm2 picture${ghostty ? "" : ", no module"}: the picture is drawn where it was placed`);
          assert.deepEqual(errors.filter((error) => !error.includes("libghostty") && !error.includes("wasm")), [], `core, iTerm2 picture${ghostty ? "" : ", no module"}: no page errors`);
          await page.context().close();
          return row;
        };
        const xtermRow = await shownRow(false);
        assert.ok(xtermRow > 0, `core, iTerm2 picture, no module: xterm moves past the picture (row ${xtermRow})`);
        assert.equal(await shownRow(true), xtermRow, "core, iTerm2 picture: the text after it is shown on xterm's row");
      }
      {
        const { page, wasm, errors } = await open(browser, server.port, prefix, "herdr");
        await page.locator(".pane-frame.is-current .pane-terminal[data-renderer='ghostty']").waitFor();
        await page.waitForFunction(() => [...document.querySelectorAll(".pane-frame.is-current .ghostty-row")].some((row) => row.textContent?.includes("BEFORE-LOAD")));
        await print(page, "HERDR-LINE\r\n", "HERDR-DONE");
        assert.equal(wasm.length, 1, "herdr: the module is fetched once");
        assert.equal(await page.locator(".pane-frame.is-current .xterm-rows").evaluate((rows) => getComputedStyle(rows).visibility), "hidden", "herdr: xterm's own text is hidden under libghostty's");
        await page.locator(".pane-frame.is-current .pane-terminal").click();
        await page.keyboard.type("y");
        await page.waitForFunction(() => window.ghosttyFixture.inputs.some((frame) => frame.type === "input" && frame.text === "y"));
        assert.deepEqual(errors, [], "herdr: no page errors");
        await page.context().close();
      }
      for (const kind of ["herdr", "core"] as const) {
        const { page, wasm, errors } = await open(browser, server.port, prefix, kind, { storedOff: true });
        await page.locator(".pane-frame.is-current .pane-terminal[data-renderer='ghostty']").waitFor();
        await print(page, "STORED-OFF\r\n", "STORED-OFF-DONE");
        assert.equal(wasm.length, 1, `${kind}, switch once turned off: the module is fetched`);
        assert.deepEqual(errors, [], `${kind}, switch once turned off: no page errors`);
        await page.context().close();
      }
      console.log("PASS libghostty: draws every pane, a herdr-core one from its first byte with Kitty pictures, herdr's own too, also where the old switch was turned off");
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
