import { USER_FONTS_PATH, type UserFont, type UserFontList } from "../../shared/user-fonts.ts";
import { apiFetch } from "./api-request-id.ts";
import { faceArrived } from "./fontFaces.ts";
import { sanitizeFontFamily } from "./fontFamily.ts";
import { serverIdOfPath, serverScopePath } from "./shellMode.ts";

// public/sw.js's FILES, the one cache its keepShell never retires: a cache of another name is deleted on the next open
const CACHE = "ovis-files-v1";
const LIST_TIMEOUT_MS = 10_000;
const FILE_TIMEOUT_MS = 120_000;

const lists = new Map<string, Promise<readonly UserFont[]>>();
const faces = new Map<string, Promise<void>>();

function namesIn(family: string): string[] {
  return [...new Set(sanitizeFontFamily(family).split(",").map((name) => name.trim().replace(/^"(.*)"$/, "$1").toLowerCase()).filter((name) => name !== ""))].sort();
}

async function fetchList(): Promise<readonly UserFont[]> {
  const response = await apiFetch(USER_FONTS_PATH, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`${USER_FONTS_PATH} answered ${response.status}`);
  return ((await response.json()) as UserFontList).fonts;
}

async function bytesOf(font: UserFont): Promise<ArrayBuffer> {
  const path = `${USER_FONTS_PATH}/${encodeURIComponent(font.file)}`;
  const url = `${path}?v=${encodeURIComponent(font.version)}`;
  // every PC's app shares the hosted shell's origin: its files are kept under its own scope
  const serverId = typeof location === "undefined" ? null : serverIdOfPath(location.pathname);
  const keptPath = serverId === null ? path : `${serverScopePath(serverId).slice(0, -1)}${path}`;
  const keptUrl = `${keptPath}?v=${encodeURIComponent(font.version)}`;
  const cache = typeof caches === "undefined" ? null : await caches.open(CACHE).catch(() => null);
  const kept = await cache?.match(keptUrl).catch(() => undefined);
  if (kept) return kept.arrayBuffer();
  const response = await apiFetch(url, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (cache) {
    try {
      for (const old of await cache.keys()) if (new URL(old.url).pathname === keptPath) await cache.delete(old);
      await cache.put(keptUrl, new Response(bytes));
    } catch (error) {
      console.warn(`The font ${font.file} could not be kept for the next load`, error);
    }
  }
  return bytes;
}

function addFace(font: UserFont, fonts: Pick<FontFaceSet, "add">): Promise<void> {
  const key = `${font.file}\n${font.version}`;
  let added = faces.get(key);
  if (added) return added;
  added = bytesOf(font).then(async (bytes) => {
    // the name as it is: FontFace takes it literally (quotes would become part of it), digits, "." and "+" too
    const face = new FontFace(font.family, bytes, { weight: String(font.weight), style: font.style });
    fonts.add(face);
    await face.loaded;
    // a face made from bytes is loaded as it is made, and adding it fires no event the font set's watchers hear
    faceArrived();
  }).catch((error: unknown) => {
    faces.delete(key);
    console.warn(`The font ${font.file} served by this PC could not be loaded`, error);
  });
  faces.set(key, added);
  return added;
}

export async function addServedFonts(family: string, fonts: Pick<FontFaceSet, "add"> | undefined = typeof document === "undefined" ? undefined : document.fonts): Promise<void> {
  const names = namesIn(family);
  if (names.length === 0 || !fonts || typeof FontFace === "undefined") return;
  const key = names.join(",");
  let listed = lists.get(key);
  if (!listed) {
    listed = fetchList().catch((error: unknown) => {
      lists.delete(key);
      console.warn("The fonts this PC serves could not be listed", error);
      return [];
    });
    lists.set(key, listed);
  }
  const named = new Set(names);
  const served = (await listed).filter((font) => named.has(font.family.normalize("NFC").toLowerCase()));
  await Promise.all(served.map((font) => addFace(font, fonts)));
}
