/**
 * Pictures in the terminal: libghostty draws iTerm2 and sixel pictures the browser converts to Kitty ones, the setting
 * takes them away and brings them back only where they are printed again (an old picture's cells draw nothing).
 * Demo fixtures only: no herdr, hc or user state.
 */
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { withDemoBrowser } from "./demo-browser.ts";
import { openSettingsFolds } from "./settings-page.ts";
import { shownRows } from "./shown-rows.ts";
import { squarePng } from "./terminal-demo-pictures.ts";

interface ImagesFixture { print(data: string): void }
interface ImagesConfig { core?: boolean; first?: string }
declare global { interface Window { imagesFixture: ImagesFixture; imagesConfig?: ImagesConfig } }

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

const pixel = (page: Page, x: number, y: number) => page.evaluate(({ x, y }) => {
  const ghostty = document.querySelector(".pane-frame.is-current .ghostty-layer");
  if (ghostty) {
    const origin = ghostty.getBoundingClientRect();
    for (const canvas of [...ghostty.querySelectorAll<HTMLCanvasElement>("canvas.ghostty-image")].reverse()) {
      const rect = canvas.getBoundingClientRect();
      const dx = origin.left + x - rect.left, dy = origin.top + y - rect.top;
      if (dx < 0 || dy < 0 || dx >= rect.width || dy >= rect.height) continue;
      const rgba = canvas.getContext("2d")?.getImageData(dx * canvas.width / rect.width, dy * canvas.height / rect.height, 1, 1).data;
      if (rgba && rgba[3]) return [...rgba.slice(0, 3)];
    }
    return null;
  }
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

await withDemoBrowser({ tempPrefix: "terminal-images-demo-", afterTransport: `\n<script>(${installImagesFixture.toString()})()</script>` }, async ({ newContext, baseUrl }) => {
  const context = await newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", terminalInputMode: "direct", alertsOn: false }));
    localStorage.setItem("ovis:terminal-pictures", "true");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}?pane=${encodeURIComponent(panes.shell)}&view=terminal`);
  await page.locator(".pane-frame.is-current .pane-terminal[data-renderer=ghostty]").waitFor();
  await settled(page);

  // A PNG for the sample pixel, independent of sixel startup
  await print(page, `\x1b[H\x1b[2J\x1bPq\x1b\\${RED}`, "RED-PRINTED");
  assert.deepEqual(await pixel(page, 4, 4), [255, 0, 0], "the picture is drawn where it is printed");

  await setPictures(page, false);
  assert.equal(await pixel(page, 4, 4), null, "off: the pictures go");
  await print(page, `\x1b[12;1H${BLUE}`, "BLUE-WHILE-OFF");
  assert.equal(await pixel(page, 4, 4), null, "off: a picture printed meanwhile is not drawn");

  await setPictures(page, true);
  await print(page, `\x1b[20;1H${BLUE}`, "BLUE-PRINTED");
  const below = await page.evaluate(() => {
    const layer = document.querySelector(".pane-frame.is-current .ghostty-layer")!;
    const tops = [...layer.querySelectorAll<HTMLCanvasElement>("canvas.ghostty-image")].map((canvas) => canvas.getBoundingClientRect().top - layer.getBoundingClientRect().top);
    return { first: tops.length ? Math.min(...tops) : -1, pictures: tops.length };
  });
  assert.ok(below.first > 0, `on again: the new picture is drawn lower down, where it was printed (${JSON.stringify(below)})`);
  assert.deepEqual(await pixel(page, 4, below.first + 4), [0, 0, 255], "on again: the new picture is drawn where it was printed");
  assert.equal(await pixel(page, 4, 4), null, "on again: the cells the first picture left draw nothing, not the new picture");

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

  for (const core of [true, false]) {
    const fresh = await newContext({ viewport: { width: 1280, height: 900 } });
    await fresh.addInitScript((config) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", terminalInputMode: "direct", alertsOn: false }));
      window.imagesConfig = config;
    }, { core, first: `\x1b[H\x1b[2J${RED}FIRST-PRINTED\r\n` });
    const page = await fresh.newPage();
    page.setDefaultTimeout(10000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseUrl}?pane=${encodeURIComponent(panes.shell)}&view=terminal`);
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
});
