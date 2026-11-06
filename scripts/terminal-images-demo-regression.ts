/**
 * Settings -> Terminal -> Pictures in the terminal: an inline picture a pane prints is drawn, turning the
 * setting off takes the pictures away and draws none meanwhile, and turning it on again draws the next
 * picture only where it was printed. The image addon keeps a picture's id in its cells and a new addon
 * numbers from 1 again: one loaded anew drew its first picture into the cells an old picture 1 had
 * left. With no choice stored on the device, a herdr-core server (`terminal-history`) draws them, the
 * picture in a pane's first output included, and the switch shows on; herdr's own server draws none.
 * Demo fixtures only: no herdr, hc or user state.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsFolds } from "./settings-page.ts";
import { shownRows } from "./shown-rows.ts";

interface ImagesFixture { print(data: string): void }
/** `core`: the server lists `terminal-history`, as herdr-core does; `first`: the output an attach replays first */
interface ImagesConfig { core?: boolean; first?: string }
declare global { interface Window { imagesFixture: ImagesFixture; imagesConfig?: ImagesConfig } }

/** The demo serves the pane; its own recording is held back, and the test prints what it needs. */
function installImagesFixture(): void {
  const sockets: Array<WebSocket & { push(frame: Record<string, unknown>): void }> = [];
  let pane: string | null = null;
  window.imagesFixture = {
    print: (data) => { for (const socket of sockets) if (pane) socket.push({ type: "pty-data", fixture: "images", pane_id: pane, data }); },
  };
  const Demo = window.WebSocket;
  const Recorded = function (url: string | URL, protocols?: string | string[]) {
    const socket = new Demo(url, protocols) as (typeof sockets)[number];
    sockets.push(socket);
    const push = socket.push.bind(socket);
    socket.push = (frame) => {
      if ((frame.type === "snapshot" || frame.type === "features") && Array.isArray(frame.features) && window.imagesConfig?.core) {
        return push({ ...frame, features: [...(frame.features as string[]), "terminal-history"] });
      }
      if (frame.type !== "pty-data") return push(frame);
      // the demo's own recording would move the screen under the test
      if (frame.fixture !== "images") return;
      const { fixture: _, ...output } = frame;
      push(output);
    };
    const send = socket.send.bind(socket);
    socket.send = (raw) => {
      const frame = JSON.parse(String(raw)) as { type: string; pane_id?: string };
      send(raw);
      if (frame.type === "attach" && frame.pane_id) {
        pane = frame.pane_id;
        const first = window.imagesConfig?.first;
        if (first) {
          window.imagesConfig!.first = undefined;
          push({ type: "pty-data", pane_id: pane, replay: true, data: first });
        }
      }
    };
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(Recorded, name, { value: Demo[name] });
  window.WebSocket = Recorded as unknown as typeof WebSocket;
}

/**
 * A 24x24 PNG square of one colour as an iTerm2 inline image. iTerm2's pictures decode in the browser
 * itself; sixel's WebAssembly decoder starts after the addon loads, so a first sixel could be missed.
 */
const squarePng = (rgb: [number, number, number]): Buffer => {
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
  const row = Buffer.concat([Buffer.from([0]), ...Array.from({ length: 24 }, () => Buffer.from(rgb))]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: 24 }, () => row)))), chunk("IEND", new Uint8Array())]);
  return png;
};
const square = (rgb: [number, number, number]): string => {
  const png = squarePng(rgb);
  return `\x1b]1337;File=inline=1;size=${png.length}:${png.toString("base64")}\x07`;
};
const RED = square([255, 0, 0]);
const BLUE = square([0, 0, 255]);

/** iTerm2's own imgcat: the picture's arguments, then its base64 in 200-character pieces, then the end (#3147) */
const multipart = (rgb: [number, number, number]): string => {
  const png = squarePng(rgb);
  const base64 = png.toString("base64");
  let out = `\x1b]1337;MultipartFile=inline=1;size=${png.length};name=c3F1YXJlLnBuZw==\x07`;
  for (let i = 0; i < base64.length; i += 200) out += `\x1b]1337;FilePart=${base64.slice(i, i + 200)}\x07`;
  return `${out}\x1b]1337;FileEnd\x07`;
};

/** `chafa -f iterm`: an uncompressed RGBA TIFF with no size= argument, laid out as chafa writes it (#3147) */
const chafaTiff = (rgb: [number, number, number], side = 24): string => {
  const pixels = Buffer.alloc(side * side * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([...rgb, 255], i);
  const tags: Array<[number, number, number, number]> = [
    [256, 4, 1, side], [257, 4, 1, side], [258, 3, 4, 8 + pixels.length + 2 + 11 * 12 + 4], [262, 3, 1, 2], [273, 4, 1, 8],
    [274, 3, 1, 1], [277, 3, 1, 4], [278, 4, 1, side], [279, 4, 1, pixels.length], [284, 3, 1, 1], [338, 3, 1, 2],
  ];
  const tiff = Buffer.alloc(8 + pixels.length + 2 + tags.length * 12 + 4 + 8);
  tiff.write("II*\0", 0, "latin1");
  tiff.writeUInt32LE(8 + pixels.length, 4);
  pixels.copy(tiff, 8);
  let at = 8 + pixels.length;
  tiff.writeUInt16LE(tags.length, at);
  at += 2;
  for (const [tag, type, count, value] of tags) {
    tiff.writeUInt16LE(tag, at);
    tiff.writeUInt16LE(type, at + 2);
    tiff.writeUInt32LE(count, at + 4);
    if (type === 3 && count === 1) tiff.writeUInt16LE(value, at + 8);
    else tiff.writeUInt32LE(value, at + 8);
    at += 12;
  }
  for (let i = 0; i < 4; i++) tiff.writeUInt16LE(8, at + 4 + 2 * i);
  return `\x1b]1337;File=inline=1;width=3;height=2;preserveAspectRatio=0:${tiff.toString("base64")}\x07`;
};

/** the picture layer's pixel at a point given in its own pixels, or null where it draws nothing */
const pixel = (page: Page, x: number, y: number) => page.evaluate(({ x, y }) => {
  const layer = document.querySelector<HTMLCanvasElement>(".pane-frame.is-current canvas.xterm-image-layer");
  if (!layer || layer.width === 0) return null;
  const [r, g, b, a] = layer.getContext("2d")!.getImageData(x, y, 1, 1).data;
  return a === 0 ? null : [r, g, b];
}, { x, y });

const settled = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const print = async (page: Page, data: string, marker: string) => {
  await page.evaluate((data) => window.imagesFixture.print(data), `${data}${marker}\r\n`);
  await page.locator(shownRows(".pane-frame.is-current"), { hasText: marker }).waitFor();
  await settled(page);
};
/** the Pictures switch as Settings shows it, in an open Settings -> Terminal */
const picturesSwitch = async (page: Page) => {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("navigation", { name: "Settings" }).getByText("Terminal", { exact: true }).click();
  await openSettingsFolds(page);
  return page.getByRole("switch", { name: "Pictures in the terminal" });
};
const closeSettings = async (page: Page) => {
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Settings" }).waitFor({ state: "detached" });
};
const setPictures = async (page: Page, on: boolean) => {
  const toggle = await picturesSwitch(page);
  if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
  assert.equal(await toggle.getAttribute("aria-checked"), String(on));
  await closeSettings(page);
  await settled(page);
};

const app = mkdtempSync(join(tmpdir(), "terminal-images-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n<script>(${installImagesFixture.toString()})()</script>\n<script type="module"`));
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
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
      await context.addInitScript(() => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", terminalInputMode: "direct", alertsOn: false }));
        localStorage.setItem("ovis:terminal-pictures", "true");
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      // the addon is its own chunk, loaded once the terminal is there: a picture printed after it is drawn
      const addonLoaded = page.waitForResponse((response) => /addon-image-[^/]*\.js$/.test(new URL(response.url()).pathname));
      await page.goto(`http://127.0.0.1:${server.port}${prefix}?pane=${encodeURIComponent(panes.shell)}&view=terminal`);
      await page.locator(".pane-frame.is-current .xterm").waitFor();
      await addonLoaded;
      await settled(page);

      // a red square at the top left; the blue one later goes a few rows lower
      await print(page, `\x1b[H\x1b[2J${RED}`, "RED-PRINTED");
      assert.deepEqual(await pixel(page, 4, 4), [255, 0, 0], "a sixel picture is drawn where it is printed");

      await setPictures(page, false);
      assert.equal(await pixel(page, 4, 4), null, "off: the pictures go");
      await print(page, `\x1b[12;1H${BLUE}`, "BLUE-WHILE-OFF");
      assert.equal(await pixel(page, 4, 4), null, "off: a picture printed meanwhile is not drawn");

      await setPictures(page, true);
      await print(page, `\x1b[20;1H${BLUE}`, "BLUE-PRINTED");
      const below = await page.evaluate(() => {
        const layer = document.querySelector<HTMLCanvasElement>(".pane-frame.is-current canvas.xterm-image-layer")!;
        const data = layer.getContext("2d")!.getImageData(0, 0, layer.width, layer.height).data;
        let first = -1;
        for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) { first = Math.floor((i - 3) / 4 / layer.width); break; }
        return { first, height: layer.height };
      });
      assert.ok(below.first > 0, `on again: the new picture is drawn lower down, where it was printed (${JSON.stringify(below)})`);
      assert.equal(await pixel(page, 4, 4), null, "on again: the cells the first picture left draw nothing, not the new picture");
      // what the addon itself says those cells hold: drawn again (a scroll, a resize), they show it
      const held = await page.evaluate(() => (document.querySelector(".pane-frame.is-current .xterm") as HTMLElement & { imageAt?: (col: number, row: number) => number[] | null }).imageAt?.(0, 0));
      assert.notEqual(held, undefined, "the demo build's probe answers");
      assert.equal(held, null, `on again: the top left cell holds no picture (${JSON.stringify(held)})`);

      // imgcat's multipart form and chafa's TIFF without a size, which the addon takes neither of by itself (#3147)
      await print(page, `\x1b[H\x1b[2J${multipart([0, 255, 0])}`, "IMGCAT-PRINTED");
      assert.deepEqual(await pixel(page, 4, 4), [0, 255, 0], "imgcat's multipart picture is drawn");
      await print(page, `\x1b[H\x1b[2J${chafaTiff([255, 0, 255])}`, "CHAFA-PRINTED");
      assert.deepEqual(await pixel(page, 4, 4), [255, 0, 255], "chafa's TIFF picture is drawn");
      // 1700 x 1700 RGBA: about 15 million base64 characters, past the 10,000,000 xterm holds for a string handler (#3154)
      await print(page, `\x1b[H\x1b[2J${chafaTiff([0, 255, 255], 1700)}`, "CHAFA-LARGE-PRINTED");
      assert.deepEqual(await pixel(page, 4, 4), [0, 255, 255], "a TIFF past xterm's string handler cap is drawn");
      assert.deepEqual(errors, [], "no page errors");
      console.log("PASS pictures: drawn, gone while off, and on again only where printed; imgcat's multipart and chafa's TIFF drawn too, also past 10M characters");
      await context.close();

      // no choice stored on this device: the server decides. The demo's health names herdr, so the switch
      // follows what the terminal's own connection lists, not the health read.
      for (const core of [true, false]) {
        const fresh = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
        await fresh.addInitScript((config) => {
          localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", terminalInputMode: "direct", alertsOn: false }));
          window.imagesConfig = config;
        }, { core, first: `\x1b[H\x1b[2J${RED}FIRST-PRINTED\r\n` });
        const page = await fresh.newPage();
        page.setDefaultTimeout(10000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.port}${prefix}?pane=${encodeURIComponent(panes.shell)}&view=terminal`);
        await page.locator(shownRows(".pane-frame.is-current"), { hasText: "FIRST-PRINTED" }).waitFor();
        await settled(page);
        if (core) {
          assert.deepEqual(await pixel(page, 4, 4), [255, 0, 0], "herdr-core, nothing stored: the picture in the first output is drawn");
          await print(page, `\x1b[H\x1b[2J${BLUE}`, "CORE-BLUE-PRINTED");
          assert.deepEqual(await pixel(page, 4, 4), [0, 0, 255], "herdr-core, nothing stored: a later picture is drawn");
        } else {
          assert.equal(await pixel(page, 4, 4), null, "herdr, nothing stored: the first output draws no picture");
          await print(page, `\x1b[H\x1b[2J${BLUE}`, "HERDR-BLUE-PRINTED");
          assert.equal(await pixel(page, 4, 4), null, "herdr, nothing stored: a later picture is not drawn");
        }
        const toggle = await picturesSwitch(page);
        assert.equal(await toggle.getAttribute("aria-checked"), String(core), `nothing stored: the switch shows what the ${core ? "herdr-core" : "herdr"} terminal does`);
        await closeSettings(page);
        assert.deepEqual(errors, [], "no page errors");
        await fresh.close();
      }
      console.log("PASS pictures with nothing stored: herdr-core draws them, the first output's included, and shows the switch on; herdr draws none and shows it off");
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
