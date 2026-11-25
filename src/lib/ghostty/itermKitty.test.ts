import { expect, test } from "bun:test";
import { itermKitty } from "./itermKitty.ts";

test.each([
  // JPEG SOI, baseline frame header (8192x8192), EOI. A decode spy must never receive it.
  { name: "over-cap JPEG", hex: "ffd8ffc0000b082000200001011100ffd9", attempts: 0 },
  { name: "in-cap JPEG", hex: "ffd8ffc0000b080001000101011100ffd9", attempts: 1 },
  { name: "over-cap GIF", hex: "47494638396100200020800000000000ffffff2c00000000010001000002024401003b", attempts: 0 },
  { name: "GIF frame outside its canvas", hex: "47494638396101000100800000000000ffffff2c00000000002000200002024401003b", attempts: 0 },
  { name: "in-cap GIF", hex: "47494638396101000100800000000000ffffff2c00000000010001000002024401003b", attempts: 1 },
])("only asks the browser to decode a bounded image ($name)", async ({ hex, attempts }) => {
  const base64 = Buffer.from(hex, "hex").toString("base64");
  const bitmap = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  const canvas = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
  let decodes = 0;
  try {
    Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: () => {
      decodes++;
      return Promise.reject(new DOMException("Invalid image"));
    } });
    Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, value: class {} });
    const result = itermKitty({ args: "inline=1", base64 }, { sizeLimit: 1000, pixelLimit: 4096 * 4096 },
      () => ({ cols: 20, rows: 10, cellW: 8, cellH: 16 }));
    expect(typeof result === "string" ? result : await result()).toBe("");
    expect(decodes).toBe(attempts);
  } finally {
    if (bitmap) Object.defineProperty(globalThis, "createImageBitmap", bitmap);
    else Reflect.deleteProperty(globalThis, "createImageBitmap");
    if (canvas) Object.defineProperty(globalThis, "OffscreenCanvas", canvas);
    else Reflect.deleteProperty(globalThis, "OffscreenCanvas");
  }
});
