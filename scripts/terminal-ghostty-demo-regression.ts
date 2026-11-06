/**
 * libghostty draws every pane over its xterm: on a herdr-core server (`terminal-history`) from every byte
 * xterm was given, the ones before its module loaded included; a Kitty graphics picture is drawn where it
 * was placed and goes when the program deletes it; typing still goes through xterm. herdr's own server is
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

interface Frame { type: string; pane_id?: string; data?: string; text?: string; features?: string[] }
interface GhosttyFixture { inputs: Frame[]; print(data: string): void }
declare global { interface Window { ghosttyFixture: GhosttyFixture } }

/** The demo serves the pane; its features and the pane's bytes are the test's. */
function installGhosttyFixture(): void {
  const core = new URL(location.href).searchParams.get("server") === "core";
  // printed at attach, before libghostty's module can have loaded: it comes from the held bytes
  const first = "\x1b[H\x1b[2JBEFORE-LOAD\r\n";
  const sockets: Array<WebSocket & { push(frame: Record<string, unknown>): void }> = [];
  let pane: string | null = null;
  // a server lists its features before any pane's bytes; the demo lists them in its snapshot, after the attach
  let featured = false;
  let waiting: (() => void) | null = null;
  const state: GhosttyFixture = {
    inputs: [],
    print: (data) => { for (const socket of sockets) if (pane) socket.push({ type: "pty-data", fixture: "ghostty", pane_id: pane, data }); },
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
        // the demo's own recording would move the screen under the test
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

/** a 4x4 square of one colour as a Kitty graphics picture, raw RGBA sent in the escape itself, shown 4 columns by 2 rows */
const kittySquare = (id: number, rgb: [number, number, number]): string => {
  const pixels = Buffer.alloc(4 * 4 * 4);
  for (let i = 0; i < 16; i++) pixels.set([...rgb, 255], i * 4);
  return `\x1b_Ga=T,f=32,s=4,v=4,i=${id},c=4,r=2,q=2;${pixels.toString("base64")}\x1b\\`;
};

/** an iTerm2 inline picture (OSC 1337): a 24x24 PNG, as terminal-images-demo-regression.ts sends */
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
/** the colour at the middle of the pane's one Kitty picture, or null when it draws none */
const picture = (page: Page) => page.evaluate(() => {
  const canvases = [...document.querySelectorAll<HTMLCanvasElement>(".pane-frame.is-current .ghostty-image")];
  if (canvases.length !== 1) return canvases.length === 0 ? null : { count: canvases.length };
  const canvas = canvases[0]!;
  const [r, g, b] = canvas.getContext("2d")!.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
  return { rgb: [r, g, b], width: canvas.style.width, top: canvas.style.top };
});

/** `storedOff`: the old Draw with libghostty switch was turned off on this device; `noModule`: libghostty's module cannot load */
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
  // attached, not visible: once libghostty draws, xterm's own rows are hidden under it
  await page.locator(".pane-frame.is-current .xterm-rows", { hasText: "BEFORE-LOAD" }).waitFor({ state: "attached" });
  return { page, wasm, errors };
}

const app = mkdtempSync(join(tmpdir(), "terminal-ghostty-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n<script>(${installGhosttyFixture.toString()})()</script>\n<script type="module"`));
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
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      {
        const { page, wasm, errors } = await open(browser, server.port, prefix, "core");
        await page.locator(".pane-frame.is-current .pane-terminal[data-renderer='ghostty']").waitFor();
        await page.waitForFunction(() => [...document.querySelectorAll(".pane-frame.is-current .ghostty-row")].some((row) => row.textContent?.includes("BEFORE-LOAD")));
        assert.equal(wasm.length, 1, "core: the module is fetched once");
        assert.equal(await page.locator(".pane-frame.is-current .xterm-rows").evaluate((rows) => getComputedStyle(rows).visibility), "hidden", "core: xterm's own text is hidden under libghostty's");

        // what the pane opened on is read, not announced; what comes after is announced, and xterm's hidden rows are left as they were
        const announced = () => page.evaluate(() => document.querySelector(".pane-frame.is-current .ghostty-layer [aria-live]")?.textContent ?? null);
        assert.equal(await announced(), "", "core: the screen a pane opens on is not announced");
        await print(page, "SPOKEN-LINE\r\n", "SPOKEN-DONE");
        assert.ok((await announced())?.includes("SPOKEN-LINE"), `core: a line the program writes is announced (${JSON.stringify(await announced())})`);
        assert.equal(await page.locator(".pane-frame.is-current .xterm-rows", { hasText: "SPOKEN-LINE" }).count(), 0, "core: xterm no longer redraws its hidden rows");
        // a full screen that scrolls by one line announces that line, not every row that moved up
        await print(page, Array.from({ length: 60 }, (_, i) => `OLD-${String(i).padStart(2, "0")}`).join("\r\n") + "\r\n", "FILL-DONE");
        await print(page, "NEW-ONLY-LINE\r\n", "NEW-DONE");
        const scrolled = await announced();
        assert.ok(scrolled?.includes("NEW-ONLY-LINE") && !scrolled.includes("OLD-"), `core: a scroll announces only the new line (${JSON.stringify(scrolled)})`);

        // scrolling back through the history writes nothing: the rows it brings in are not announced (#2963)
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

        // a dark palette names no ANSI colours: they are xterm's own, not black
        await print(page, "\x1b[31mRED-TEXT\x1b[0m\r\n", "COLOURED");
        const ansiRed = await page.evaluate(() => {
          const span = [...document.querySelectorAll<HTMLElement>(".pane-frame.is-current .ghostty-row span")].find((s) => s.textContent?.includes("RED-TEXT"))!;
          const rgb = (css: string) => `#${(css.match(/\d+/g) ?? []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
          return { color: rgb(getComputedStyle(span).color), background: rgb(getComputedStyle(document.querySelector(".pane-frame.is-current .xterm-viewport")!).backgroundColor) };
        });
        // xterm draws it at its minimum contrast (4.5) against the background, as terminalFold.ts computes it
        assert.equal(ansiRed.color, readableColor("#cc0000", ansiRed.background, 4.5), "core: ANSI red is xterm's red under a palette that names none, made readable as xterm makes it");

        // a wide character after a combining accent keeps its two cells: the accent is part of the cell before it
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

        // glyphs fit their cells as xterm's rows fit them (terminalGlyphs.ts): an underlined Hangul syllable fills its two
        // cells and keeps its underline, and a Nerd Font icon stays in its one cell, so the text after both keeps its column
        await print(page, "\x1b[4m\uD55C\x1b[24m\ue0a0Q|\ue0b0\r\nPLAIN-Q\r\n", "GLYPHS");
        // the icon and Hangul faces load once a row asks for them; the rows are fitted again when they arrive
        await page.evaluate(() => document.fonts.ready);
        await settled(page);
        const glyphs = await page.evaluate(() => {
          const layer = document.querySelector(".pane-frame.is-current .ghostty-layer")!;
          const cw = parseFloat(getComputedStyle(layer).getPropertyValue("--ghostty-cw"));
          const row = [...layer.querySelectorAll<HTMLElement>(".ghostty-row")].find((r) => r.textContent?.includes("Q|"))!;
          // the box one character of the row is drawn in, wherever its text node starts
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

        // typing still goes through xterm, to the pane
        await page.locator(".pane-frame.is-current .pane-terminal").click();
        await page.keyboard.type("x");
        await page.waitForFunction(() => window.ghosttyFixture.inputs.some((frame) => frame.type === "input" && frame.text === "x"));
        assert.deepEqual(errors, [], "core: no page errors");
        await page.context().close();
      }
      {
        // an iTerm2 picture (Pictures in the terminal): libghostty cannot draw it, xterm's image addon does and moves its
        // cursor past it, so the text after it must be shown on the row xterm alone shows it on (#2980)
        // xterm alone: libghostty's module cannot load, and xterm draws the pane by itself, never a blank one
        const shownRow = async (ghostty: boolean) => {
          const { page, errors } = await open(browser, server.port, prefix, "core", { noModule: !ghostty, images: true });
          if (ghostty) await page.locator(".pane-frame.is-current .pane-terminal[data-renderer=ghostty]").waitFor();
          else await page.locator(".pane-frame.is-current .xterm-rows", { hasText: "BEFORE-LOAD" }).waitFor();
          // the image addon loads on its own; until then xterm passes the picture by
          await page.waitForFunction(() => typeof (document.querySelector(".pane-frame.is-current .xterm") as { imageAt?: unknown } | null)?.imageAt === "function");
          await page.evaluate((data) => window.ghosttyFixture.print(data), `\x1b[2J\x1b[H${itermSquare()}IT2-AFTER\r\n`);
          const row = await page.waitForFunction(() => {
            const layer = document.querySelector(".pane-frame.is-current .pane-terminal[data-renderer=ghostty]");
            const rows = [...document.querySelectorAll(layer ? ".pane-frame.is-current .ghostty-row" : ".pane-frame.is-current .xterm-rows > div")];
            const index = rows.findIndex((row) => row.textContent?.includes("IT2-AFTER"));
            return index >= 0 ? { index } : null;
          }).then(async (handle) => (await handle.jsonValue())!.index);
          // libghostty handed the pane to xterm at the picture; xterm draws it, picture included
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
        // herdr's own server: libghostty draws its panes too, from the bytes xterm was given before the module loaded
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
        // a device that turned the old Draw with libghostty switch off: there is no switch now, libghostty draws
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
