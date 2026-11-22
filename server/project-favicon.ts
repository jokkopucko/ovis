import { join } from "node:path";

import type { FileInfo } from "../shared/protocol.ts";
import { findFile } from "./file-view.ts";

/**
 * Where a project keeps its icon, best first. A site's favicon leads; then the icons frameworks
 * and app builders keep (Next.js app/, Electron's build/ and resources/, Expo and Flutter
 * assets/), then a square logo, which may be a wordmark.
 */
export const FAVICON_CANDIDATES = [
  "favicon.svg", "favicon.ico", "favicon.png",
  "public/favicon.svg", "public/favicon.ico", "public/favicon.png",
  "static/favicon.svg", "static/favicon.ico", "static/favicon.png",
  "app/icon.svg", "app/icon.png", "app/favicon.ico",
  "src/app/icon.svg", "src/app/icon.png", "src/app/favicon.ico",
  "public/icon.svg", "public/icon.png", "public/apple-touch-icon.png",
  "icon.svg", "icon.png", "build/icon.png", "resources/icon.png", "assets/icon.png",
  "logo.svg", "logo.png", "assets/logo.svg", "assets/logo.png", "public/logo.svg", "public/logo.png",
  "src/assets/logo.svg", "src/assets/logo.png", ".github/logo.svg", ".github/logo.png",
] as const;

/**
 * The best candidate in `root` that is an image, or null. Each place is read as GET /api/fs/stat
 * reads `<root>/<place>` with no pane: `root` is absolute or `~/…`, and a relative one, with no
 * pane folder to be relative to, keeps no icon.
 */
export async function findProjectFavicon(root: string): Promise<FileInfo | null> {
  for (const candidate of FAVICON_CANDIDATES) {
    const found = await findFile(join(root, candidate), null, () => Promise.resolve(null));
    if (found !== null && "info" in found && found.info.kind === "image") return found.info;
  }
  return null;
}
