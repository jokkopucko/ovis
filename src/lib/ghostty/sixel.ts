type Rgb = readonly [number, number, number];

interface SixelImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

const MAX_SIDE = 16_380;
const REGISTERS = 4096;
const littleEndian = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;
const DOTS = Array.from({ length: 64 }, (_, bits) => {
  let count = 0;
  for (let n = bits; n; n &= n - 1) count++;
  return count;
});

function opaque([r, g, b]: Rgb): number {
  return littleEndian ? r | g << 8 | b << 16 | 255 << 24 : r << 24 | g << 16 | b << 8 | 255;
}

function rgbPercent(r: number, g: number, b: number): number {
  return opaque([Math.round(r * 255 / 100), Math.round(g * 255 / 100), Math.round(b * 255 / 100)]);
}

// DEC VT340 colour registers, in percent (VT330/VT340 Programmer Reference, §2.4).
const VT340 = [
  [0, 0, 0], [20, 20, 80], [80, 13, 13], [20, 80, 20],
  [80, 20, 80], [20, 80, 80], [80, 80, 20], [53, 53, 53],
  [26, 26, 26], [33, 33, 60], [60, 26, 26], [33, 60, 33],
  [60, 33, 60], [33, 60, 60], [60, 60, 33], [80, 80, 80],
].map(([r = 0, g = 0, b = 0]) => rgbPercent(r, g, b));

const cubeLevel = (step: number): number => step === 0 ? 0 : 55 + 40 * step;
const DEFAULT_PALETTE = new Uint32Array(256);
DEFAULT_PALETTE.set(VT340);
DEFAULT_PALETTE.set(Uint32Array.from({ length: 240 }, (_, i) => {
  if (i < 216) {
    return opaque([cubeLevel(Math.floor(i / 36)), cubeLevel(Math.floor(i / 6) % 6), cubeLevel(i % 6)]);
  }
  const gray = 8 + (i - 216) * 10;
  return opaque([gray, gray, gray]);
}), 16);

function hls(hue: number, lightness: number, saturation: number): number {
  // DEC puts blue, not red, at 0 degrees.
  const h = ((hue + 240) % 360) / 30;
  const l = lightness / 100;
  const a = saturation / 100 * Math.min(l, 1 - l);
  const channel = (n: number): number => {
    const k = (n + h) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return opaque([channel(0), channel(8), channel(4)]);
}

export function decodeSixel(body: string, options: {
  readonly transparent: boolean;
  readonly background: Rgb;
  readonly pixelLimit: number;
}): SixelImage | null {
  const { transparent, background, pixelLimit } = options;
  let width = 0;
  let height = 0;
  const fits = (): boolean => width <= MAX_SIDE && height <= MAX_SIDE && width * height < pixelLimit;
  // First measure and validate; the second pass can then paint directly into one bounded RGBA buffer.
  const scan = (pixels?: Uint32Array): boolean => {
    let x = 0;
    let y = 0;
    let work = 0;
    let color = opaque([255, 255, 255]);
    const palette = pixels && new Uint32Array(REGISTERS);
    palette?.set(DEFAULT_PALETTE);
    const params = /\d{0,8}(?:;\d{0,8}){0,4}/y;
    for (let at = 0; at < body.length;) {
      let ch = body.charCodeAt(at++);
      let repeat = 1;
      if (ch === 0x21 || ch === 0x22 || ch === 0x23) { // ! " #
        params.lastIndex = at;
        const arg = params.exec(body)?.[0] ?? "";
        at += arg.length;
        const values = arg.split(";");
        const [a = 0, b = 0, c = 0, d = 0, e = 0] = values.map(Number);
        const count = values.length;
        if (ch === 0x21) {
          if (count !== 1 || a < 1) return false;
          repeat = a;
          ch = body.charCodeAt(at++);
          if (!(ch >= 0x3f && ch <= 0x7e)) return false;
        } else if (ch === 0x22) {
          if (count > 4 || /[\d;]/.test(body.charAt(at))) return false;
          if (!pixels) {
            // Pan/Pad are pixel aspect hints; like xterm, paint one square pixel per bit.
            width = Math.max(width, c);
            height = Math.max(height, d);
            if (!fits()) return false;
          }
          continue;
        } else {
          if (a >= REGISTERS || (count !== 1 && count !== 5) || /[\d;]/.test(body.charAt(at))) return false;
          if (count === 5 && ((b !== 1 && b !== 2) || c > (b === 1 ? 360 : 100) || d > 100 || e > 100)) return false;
          if (palette) {
            if (count === 5) palette[a] = b === 1 ? hls(c, d, e) : rgbPercent(c, d, e);
            color = palette[a] ?? 0;
          }
          continue;
        }
      }
      if (ch === 0x24) { x = 0; continue; } // $
      if (ch === 0x2d) { // -
        x = 0;
        y += 6;
        if (!pixels) {
          height = Math.max(height, y);
          if (!fits()) return false;
        }
        continue;
      }
      if (ch < 0x20 || ch === 0x7f) continue;
      if (ch < 0x3f || ch > 0x7e) return false;
      const bits = ch - 0x3f;
      const end = x + repeat;
      if (!pixels) {
        width = Math.max(width, end);
        height = Math.max(height, y + (32 - Math.clz32(bits)));
        // Repeated overpainting after `$` must not turn a small raster into unbounded work.
        work += (DOTS[bits] ?? 0) * repeat;
        if (!fits() || work > 4 * pixelLimit) return false;
      } else {
        for (let bit = 0; bit < 6; bit++) {
          if ((bits & (1 << bit)) !== 0) {
            const row = (y + bit) * width;
            pixels.fill(color, row + x, row + end);
          }
        }
      }
      x = end;
    }
    return true;
  };
  if (!scan() || width === 0 || height === 0) return null;
  const pixels = new Uint32Array(width * height);
  if (!transparent) pixels.fill(opaque(background));
  scan(pixels);
  return { width, height, rgba: new Uint8Array(pixels.buffer) };
}
