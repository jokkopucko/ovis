/**
 * One pixel of a PNG a browser script took as a screenshot: what a frame whose scripts are off draws can only be
 * seen from outside it, as no script (a test driver's included) runs inside. Reads the 8-bit RGB and RGBA,
 * non-interlaced PNGs that Playwright writes.
 */
import { inflateSync } from "node:zlib";

export function pngPixel(png: Uint8Array, x: number, y: number): [number, number, number] {
  const bytes = Buffer.from(png);
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), depth = bytes[24], kind = bytes[25], interlace = bytes[28];
  if (depth !== 8 || (kind !== 2 && kind !== 6) || interlace !== 0) throw new Error(`a PNG this reader does not read: depth ${depth}, colour type ${kind}, interlace ${interlace}`);
  if (x < 0 || y < 0 || x >= width || y >= height) throw new Error(`(${x}, ${y}) is outside the ${width}x${height} picture`);
  const data: Buffer[] = [];
  for (let at = 8; at < bytes.length;) {
    const size = bytes.readUInt32BE(at), type = bytes.toString("latin1", at + 4, at + 8);
    if (type === "IDAT") data.push(bytes.subarray(at + 8, at + 8 + size));
    at += 12 + size;
  }
  const raw = inflateSync(Buffer.concat(data)), channels = kind === 6 ? 4 : 3, stride = width * channels;
  // each row is filtered against the one above and the pixel to its left: rows are undone down to the one asked for
  let above = Buffer.alloc(stride), row = above;
  for (let line = 0; line <= y; line++) {
    const filter = raw[line * (stride + 1)]!;
    row = Buffer.from(raw.subarray(line * (stride + 1) + 1, (line + 1) * (stride + 1)));
    for (let at = 0; at < stride; at++) {
      const left = at >= channels ? row[at - channels]! : 0, up = above[at]!, corner = at >= channels ? above[at - channels]! : 0;
      const guess = left + up - corner, nearLeft = Math.abs(guess - left), nearUp = Math.abs(guess - up), nearCorner = Math.abs(guess - corner);
      const paeth = nearLeft <= nearUp && nearLeft <= nearCorner ? left : nearUp <= nearCorner ? up : corner;
      row[at] = (row[at]! + (filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth : 0)) & 255;
    }
    above = row;
  }
  return [row[x * channels]!, row[x * channels + 1]!, row[x * channels + 2]!];
}
