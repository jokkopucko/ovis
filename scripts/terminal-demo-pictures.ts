import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import type { Page } from "playwright-core";

export function squarePng(rgb: [number, number, number]): Buffer {
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
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: 24 }, () => row)))), chunk("IEND", new Uint8Array())]);
}

export const ghosttyPicture = (page: Page) => page.evaluate(() => {
  const canvases = [...document.querySelectorAll<HTMLCanvasElement>(".pane-frame.is-current .ghostty-image")];
  if (canvases.length !== 1) return canvases.length === 0 ? null : { count: canvases.length };
  const canvas = canvases[0];
  const rgba = canvas?.getContext("2d")?.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
  return canvas && rgba ? { rgb: [...rgba.slice(0, 3)], width: canvas.style.width, top: canvas.style.top } : null;
});

export async function checkGhosttySixel(page: Page, print: (page: Page, data: string, marker: string) => Promise<void>): Promise<void> {
  const marker = "SIXEL-AFTER";
  const sixel = `\x1bP0;1q"1;1;24;48#1;2;0;100;0${Array(8).fill("!24~").join("-")}\x1b\\`;
  await print(page, `\x1b_Ga=d,d=A\x1b\\\x1b[2J\x1b[2;3H${sixel}`, marker);
  assert.deepEqual((await ghosttyPicture(page))?.rgb, [0, 255, 0], "core, sixel: libghostty draws the image without handing over");
  const cursor = await page.evaluate((marker) => {
    const layer = document.querySelector(".pane-frame.is-current .ghostty-layer");
    if (!layer) return null;
    const rows = [...layer.querySelectorAll(".ghostty-row")];
    const row = rows.findIndex((element) => element.textContent?.includes(marker));
    const line = rows[row];
    if (!line) return null;
    const text = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = text.nextNode(); node; node = text.nextNode()) {
      const start = node.textContent?.indexOf(marker) ?? -1;
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + 1);
      const style = getComputedStyle(layer);
      const height = parseFloat(style.getPropertyValue("--ghostty-ch"));
      const width = parseFloat(style.getPropertyValue("--ghostty-cw"));
      return { row, expectedRow: Math.ceil(48 / height), column: (range.getBoundingClientRect().left - layer.getBoundingClientRect().left) / width };
    }
    return null;
  }, marker);
  assert.ok(cursor && cursor.row === cursor.expectedRow && Math.abs(cursor.column - 2) < 0.1,
    `core, sixel: text lands on the last image row in the starting column (${JSON.stringify(cursor)})`);
}
