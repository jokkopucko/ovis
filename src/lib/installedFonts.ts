/**
 * The Local Font Access API (queryLocalFonts) exists in Chromium only and asks permission on a user
 * gesture.
 */
interface LocalFontData {
  readonly family: string;
}
type QueryLocalFonts = () => Promise<readonly LocalFontData[]>;

export type InstalledFonts = { status: "granted"; families: string[] } | { status: "unavailable" };

function queryFunction(): QueryLocalFonts | null {
  const query = typeof window === "undefined" ? undefined : (window as { queryLocalFonts?: unknown }).queryLocalFonts;
  return typeof query === "function" ? (query as QueryLocalFonts).bind(window) : null;
}

export function canListInstalledFonts(): boolean {
  return queryFunction() !== null;
}

export function uniqueFamilies(fonts: readonly { family: string }[]): string[] {
  const seen = new Set<string>();
  for (const { family } of fonts) {
    const name = typeof family === "string" ? family.normalize("NFC").trim() : "";
    if (name !== "") seen.add(name);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export function filterFamilies(families: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  return needle === "" ? [...families] : families.filter((family) => family.toLowerCase().includes(needle));
}

/**
 * Asks for the installed fonts. Call it from a click: the permission prompt needs a gesture.
 * Refusal, a missing API and any failure all answer "unavailable", never throw.
 */
export async function queryInstalledFonts(): Promise<InstalledFonts> {
  const query = queryFunction();
  if (query === null) return { status: "unavailable" };
  try {
    const families = uniqueFamilies(await query());
    return families.length === 0 ? { status: "unavailable" } : { status: "granted", families };
  } catch {
    return { status: "unavailable" };
  }
}

const ADVANCE_TOLERANCE = 0.01;
const PROBE_VARIANTS = ["normal 400", "normal 700", "italic 400", "italic 700"] as const;
const PROBE_GLYPHS = ["i", "M", "W", "0", "@", "#", ".", " "] as const;

export function advancesAreMonospace(advances: readonly number[]): boolean {
  const reference = advances[0];
  if (reference === undefined || reference <= 0 || advances.some((advance) => !Number.isFinite(advance) || advance <= 0)) return true;
  return advances.every((advance) => Math.abs(advance - reference) < ADVANCE_TOLERANCE);
}

let probe: CanvasRenderingContext2D | null | undefined;

export function isMonospaceFamily(family: string): boolean {
  const name = family.replace(/["\\]/g, "").trim();
  if (name === "" || typeof document === "undefined") return true;
  try {
    probe ??= document.createElement("canvas").getContext("2d");
    if (probe === null) return true;
    const context = probe;
    // a generic monospace behind it: a face that is absent measures as monospace
    return PROBE_VARIANTS.every((variant) => {
      context.font = `${variant} 32px "${name}", monospace`;
      return advancesAreMonospace(PROBE_GLYPHS.map((glyph) => context.measureText(glyph).width));
    });
  } catch {
    return true;
  }
}
