/**
 * The file routes: what a file is and its bytes (GET/HEAD /api/fs/stat, /api/fs/file), a folder's
 * project icon (/api/fs/favicon) and a rendered page's own media (/api/fs/page-media/:media_id).
 * The dispatcher in index.ts runs the access gate first and hands over who asks: a page's media
 * plays only for the client and device that rendered it (file-view.ts).
 */
import { sep } from "node:path";

import type { ProjectFavicon } from "../shared/files.ts";
import type { Access } from "./access.ts";
import { isSecureRequest } from "./auth.ts";
import { claudeSessionTempDir, claudeTempBases } from "./claude-store.ts";
import { claudePaneSession } from "./conversation.ts";
import { fileResponse, findFile, crossSiteFileRead, pageMediaResponse, pageMediaSource, PAGE_MEDIA_PATH, watchPageMedia } from "./file-view.ts";
import { paneGet } from "./herdr/client.ts";
import { badRequest, errorResponse, jsonResponse, setRequestRoute } from "./http.ts";
import { paneContext, resolveAgent } from "./pane-context.ts";
import { findProjectFavicon } from "./project-favicon.ts";

/** Who asks, as the dispatcher's access gate worked it out. */
export interface FileRequester { bridgeAuthorized: boolean; requestHost: string | null; forwarded: boolean; client: string | null; access: Access }

/** Whether `path` may lie in a Claude Code session's temp folder, told before herdr is asked which one the pane's is. */
const mayBeClaudeTemp = (path: string): boolean => claudeTempBases().some((base) => path.startsWith(base + sep));

/** The temp folder of the Claude Code session in a pane, or null when the pane runs none or it has none. */
async function claudeTempFolder(paneId: string): Promise<string | null> {
  try {
    const pane = await paneGet(paneId);
    if (resolveAgent(pane).agent !== "claude") return null;
    const session = await claudePaneSession(pane);
    return session === null ? null : await claudeSessionTempDir(session.path);
  } catch { return null; /* herdr busy or the pane gone: the path stays not found */ }
}

/** The answer for a file route, or null when the path is not one. */
export async function handleFileRequest(request: Request, url: URL, pathname: string, { bridgeAuthorized, requestHost, forwarded, client, access }: FileRequester): Promise<Response | null> {
  if (pathname === "/api/fs/stat" || pathname === "/api/fs/file" || pathname === "/api/fs/favicon") {
    setRequestRoute(pathname);
    if (request.method !== "GET" && request.method !== "HEAD") return badRequest("method_not_allowed", "use GET");
    if (crossSiteFileRead(request)) return jsonResponse({ error: { code: "cross_site", message: "A file is read from this app or opened in a tab, not loaded by another page" } }, 403);
    // a device revoked, or a client signed out, while this request finds and draws a page gets none
    // of its media addresses (file-view.ts)
    const watch = watchPageMedia();
    // every file thread busy, or the disk too slow to answer in time: 503 (file-pool.ts)
    try { return await fileRoute(request, url, pathname, { bridgeAuthorized, requestHost, forwarded, client, access }, watch); } catch (error) { return errorResponse(error); } finally { watch.done(); }
  }

  // a rendered page's own video, by the address its render gave it: the page has no origin and
  // no cookie, so the address is all it holds (requiresAuth lets this path through)
  if (pathname.startsWith(PAGE_MEDIA_PATH)) {
    setRequestRoute("/api/fs/page-media/:media_id");
    if (request.method !== "GET" && request.method !== "HEAD") return badRequest("method_not_allowed", "use GET");
    const media = pageMediaResponse(pathname.slice(PAGE_MEDIA_PATH.length), client, request);
    return media ?? jsonResponse({ error: { code: "not_found", message: "no such page media" } }, 404);
  }
  return null;
}

/** GET/HEAD /api/fs/stat, /api/fs/file and /api/fs/favicon, past the method and site checks. */
async function fileRoute(request: Request, url: URL, pathname: string, { bridgeAuthorized, requestHost, forwarded, client, access }: FileRequester, watch: ReturnType<typeof watchPageMedia>): Promise<Response> {
  // a folder's project icon: every place it may be kept, in one answer that a miss is part of
  if (pathname === "/api/fs/favicon") {
    const root = url.searchParams.get("root") ?? "";
    if (root.trim() === "") return badRequest("missing_root", "root is required");
    return jsonResponse({ icon: await findProjectFavicon(root) } satisfies ProjectFavicon);
  }
  const paneId = url.searchParams.get("pane_id");
  let cwd: string | null = null;
  if (paneId) {
    try { cwd = (await paneContext(paneId)).cwd; } catch { /* an absolute path still opens */ }
  }
  const path = url.searchParams.get("path") ?? "";
  const found = await findFile(path, cwd, () => paneId ? claudeTempFolder(paneId) : Promise.resolve(null), paneId ? mayBeClaudeTemp : undefined);
  if (found === null) return jsonResponse({ error: { code: "not_found", message: "no readable file at that path" } }, 404);
  // several files end in that name: the viewer lists them to choose from
  if ("candidates" in found) return jsonResponse({ error: { code: "ambiguous_path", message: "several files have that name", candidates: found.candidates } }, 409);
  // a page another PC's server asks for through its bridge is played from that server's address, which this one cannot name: it is drawn as before
  const mediaSource = bridgeAuthorized || (access.level === "full" && access.via === "relay") ? null : pageMediaSource(requestHost, isSecureRequest(request), forwarded ? request.headers.get("x-forwarded-host") : null);
  // its media plays only for the client address that rendered it, and ends with that device (file-view.ts)
  const media = mediaSource === null ? null : { source: mediaSource, client, device: access.level === "full" ? access.device?.id ?? null : null };
  return pathname === "/api/fs/stat" ? jsonResponse(found.info) : await fileResponse(found.info, url.searchParams.get("download") === "1", url.searchParams.get("render") === "1", media, request, watch, found.within ?? null, access.level === "full" && access.via === "relay");
}
