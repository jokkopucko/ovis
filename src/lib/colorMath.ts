/**
 * Colour arithmetic on `#rrggbb` values: OKLab for moving a colour's lightness while its hue and
 * chroma stay, and the WCAG contrast ratio. Pure, and shared by the offline theme tools (scripts/
 * herdr-theme-proposal.ts) and the app's own derivation of an imported theme (themeDerive.ts).
 */
export type Vector = readonly [number, number, number];

export function rgb(hex: string): Vector {
  if (!/^#[0-9a-f]{6}$/.test(hex)) throw new Error(`Expected #rrggbb, got ${hex}`);
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

export function hex([r, g, b]: Vector): string {
  return `#${[r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0")).join("")}`;
}

export const linear = (c: number): number => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const gamma = (c: number): number => c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;

/** OKLab a,b preserve OKLCH hue/chroma while L changes; dE is 100 * Euclidean OKLab. */
export function lab([red, green, blue]: Vector): Vector {
  const r = linear(red / 255), g = linear(green / 255), b = linear(blue / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

export function fromLab([L, a, b]: Vector): Vector {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) * 255,
    gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) * 255,
    gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s) * 255];
}

export function deltaE(from: string, to: string): number {
  const a = lab(rgb(from)), b = lab(rgb(to));
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** `from` moved a tenth of the way to `to`, in OKLCH: the hover step of a filled button. */
export function mix(from: string, to: string): string {
  const [l, a, b] = lab(rgb(from)), [L, A, B] = lab(rgb(to));
  const c = Math.hypot(a, b), C = Math.hypot(A, B);
  const h = Math.atan2(b, a), H = Math.atan2(B, A);
  const hue = h + 0.1 * (Math.atan2(Math.sin(H - h), Math.cos(H - h)));
  const chroma = c * 0.9 + C * 0.1;
  return hex(fromLab([l * 0.9 + L * 0.1, chroma * Math.cos(hue), chroma * Math.sin(hue)]));
}

export const rgba = (value: string, alpha: number): string => `rgba(${rgb(value).join(", ")}, ${alpha})`;

export function luminance([r, g, b]: Vector): number {
  return 0.2126 * linear(r / 255) + 0.7152 * linear(g / 255) + 0.0722 * linear(b / 255);
}

/** The WCAG contrast ratio of two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
  const x = luminance(rgb(a)), y = luminance(rgb(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `color` laid over `ground` at `alpha`, channel by channel. */
export function over(color: Vector, ground: Vector, alpha: number): Vector {
  return [color[0] * alpha + ground[0] * (1 - alpha), color[1] * alpha + ground[1] * (1 - alpha), color[2] * alpha + ground[2] * (1 - alpha)];
}
