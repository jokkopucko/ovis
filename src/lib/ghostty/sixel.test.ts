import { expect, test } from "bun:test";
import { decodeSixel } from "./sixel.ts";

const options = { transparent: true, background: [12, 34, 56], pixelLimit: 100 } as const;

test("paints VT340 colours and RGB and DEC HLS register definitions", () => {
  const image = decodeSixel("#1@#2;2;50;100;0@#3;1;0;50;100@#4;1;120;50;100@#2@", options);
  expect(image).toEqual({ width: 5, height: 1, rgba: Uint8Array.of(
    51, 51, 204, 255, 128, 255, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255, 128, 255, 0, 255,
  ) });
});

test("preloads the ANSI cube and grayscale and lets an explicit register override them", () => {
  const image = decodeSixel("#16@#196@#232@#255@#196;2;0;100;0@", options);
  expect(image?.rgba).toEqual(Uint8Array.of(
    0, 0, 0, 255, 255, 0, 0, 255, 8, 8, 8, 255, 238, 238, 238, 255, 0, 255, 0, 255,
  ));
});

test("uses repeats, overlays colour after carriage return and advances in six-pixel bands", () => {
  const image = decodeSixel('"1;1;3;8#2!3@$#3A-@', options);
  expect([image?.width, image?.height]).toEqual([3, 8]);
  const red = [204, 33, 33, 255], green = [51, 204, 51, 255], clear = [0, 0, 0, 0];
  expect(image?.rgba).toEqual(Uint8Array.of(
    ...red, ...red, ...red,
    ...green, ...clear, ...clear,
    ...Array(4).fill([...clear, ...clear, ...clear]).flat(),
    ...green, ...clear, ...clear,
    ...clear, ...clear, ...clear,
  ));
});

test("fills only unset pixels with the P2 background in opaque mode", () => {
  const image = decodeSixel('"1;1;2;1#0@', { ...options, transparent: false });
  expect(image?.rgba).toEqual(Uint8Array.of(0, 0, 0, 255, 12, 34, 56, 255));
});

test.each(['"1;1;100;100@', "!10000000~", "!2", "#1;3;0;0;0@", "!15~$".repeat(5)])(
  "drops malformed or over-cap raster data (%s)", (body) => {
    expect(decodeSixel(body, options)).toBeNull();
  },
);
