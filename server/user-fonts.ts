/**
 * GET /api/fonts and GET /api/fonts/<file>: the font files the user put in the state folder's
 * `fonts/` (shared/user-fonts.ts). Access is decided before this point, as for every /api route.
 * Only what the list shows is served: a regular file (no link, which could name any file this user
 * may read) with a font's extension, a plain name and at most USER_FONT_MAX_BYTES.
 */

import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

import { USER_FONTS_PATH, type UserFont, type UserFontList } from "../shared/user-fonts.ts";
import { errorResponse, jsonResponse, setRequestRoute } from "./http.ts";

/** A CJK font as woff2 is a few MB, as ttf about 20: past this a phone would wait on every font change. */
export const USER_FONT_MAX_BYTES = 32 * 1024 * 1024;
const USER_FONTS_MAX = 64;

const FONT_TYPES: Readonly<Record<string, string>> = { ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf" };
// letters and digits of any script, then spaces, _ + . - too: never a quote, comma or slash a family or a path would trip on
const PLAIN_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _+.-]*$/u;
const FACE_SUFFIX: Readonly<Record<string, Pick<UserFont, "weight" | "style">>> = {
  regular: { weight: 400, style: "normal" },
  bold: { weight: 700, style: "normal" },
  italic: { weight: 400, style: "italic" },
  bolditalic: { weight: 700, style: "italic" },
};

function fontOf(file: string, bytes: number, modified: number): UserFont | null {
  const type = extname(file);
  const stem = file.slice(0, -type.length).normalize("NFC");
  if (!Object.hasOwn(FONT_TYPES, type.toLowerCase()) || !PLAIN_NAME.test(stem) || bytes > USER_FONT_MAX_BYTES) return null;
  const dash = stem.lastIndexOf("-");
  const suffix = dash > 0 ? stem.slice(dash + 1).toLowerCase() : "";
  // own keys only: "-constructor" is no face
  const face = Object.hasOwn(FACE_SUFFIX, suffix) ? FACE_SUFFIX[suffix] : undefined;
  const family = face ? stem.slice(0, dash).trim() : stem;
  return { file, family, ...(face ?? { weight: 400, style: "normal" }), bytes, version: `${bytes}-${Math.trunc(modified)}` };
}

async function listUserFonts(dir: string): Promise<UserFont[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const fonts: UserFont[] = [];
  for (const file of names.sort()) {
    if (fonts.length >= USER_FONTS_MAX) break;
    const stat = await lstat(join(dir, file)).catch(() => null);
    if (!stat?.isFile()) continue;
    const font = fontOf(file, stat.size, stat.mtimeMs);
    if (font) fonts.push(font);
  }
  return fonts;
}

function fileOf(pathname: string): string | null | undefined {
  if (pathname === USER_FONTS_PATH) return null;
  try {
    return decodeURIComponent(pathname.slice(USER_FONTS_PATH.length + 1));
  } catch {
    // a malformed escape names no file of the list
    return undefined;
  }
}

export async function handleUserFontsRequest(request: Request, pathname: string, dir: string, search = ""): Promise<Response> {
  const file = fileOf(pathname);
  setRequestRoute(file === null ? USER_FONTS_PATH : `${USER_FONTS_PATH}/:file`);
  if (request.method !== "GET" && request.method !== "HEAD") return jsonResponse({ error: { code: "method_not_allowed", message: "GET only" } }, 405);
  try {
    const fonts = await listUserFonts(dir);
    if (file === null) return jsonResponse({ fonts } satisfies UserFontList, 200, { "cache-control": "no-store" });
    const font = fonts.find((candidate) => candidate.file === file);
    const missing = () => jsonResponse({ error: { code: "not_found", message: "no such font" } }, 404);
    if (!font) return missing();
    // where the platform has O_NOFOLLOW, a link swapped in after the listing is refused by the open itself
    const handle = await open(join(dir, font.file), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ELOOP" || error.code === "ENOENT") return null;
      throw error;
    });
    if (!handle) return missing();
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > USER_FONT_MAX_BYTES) return missing();
      const versioned = new URLSearchParams(search).get("v") === font.version;
      return new Response(await handle.readFile(), {
        headers: { "content-type": FONT_TYPES[extname(font.file).toLowerCase()]!, "cache-control": versioned ? "private, max-age=31536000, immutable" : "private, no-cache" },
      });
    } finally {
      await handle.close();
    }
  } catch (error) {
    return errorResponse(error);
  }
}
