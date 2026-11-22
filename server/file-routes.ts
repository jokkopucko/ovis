/**
 * The dispatcher in index.ts runs the access gate first and hands over who asks: a page's media
 * plays only for the client and device that rendered it (file-view.ts).
 */
import { isAbsolute, sep } from "node:path";

import type { ProjectFavicon } from "../shared/files.ts";
import type { Access } from "./access.ts";
import { isSecureRequest } from "./auth.ts";
import { claudeSessionTempDir, claudeTempBases } from "./claude-store.ts";
import { claudePaneSession } from "./conversation.ts";
import { MAX_TEXT_SAVE_BODY_BYTES, readCappedText, saveEditableText, TextEditRefused } from "./file-edit.ts";
import { fileTask } from "./file-pool.ts";
import type { TextTaskResult } from "./file-tasks.ts";
import { fileResponse, findFile, crossSiteFileRead, pageMediaResponse, pageMediaSource, PAGE_MEDIA_PATH, watchPageMedia } from "./file-view.ts";
import { paneGet } from "./herdr/client.ts";
import { badRequest, errorResponse, isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import { paneContext, resolveAgent } from "./pane-context.ts";
import { findProjectFavicon } from "./project-favicon.ts";

/** Who asks, as the dispatcher's access gate worked it out. */
export interface FileRequester { bridgeAuthorized: boolean; requestHost: string | null; forwarded: boolean; client: string | null; access: Access }

const mayBeClaudeTemp = (path: string): boolean => claudeTempBases().some((base) => path.startsWith(base + sep));

async function claudeTempFolder(paneId: string): Promise<string | null> {
  try {
    const pane = await paneGet(paneId);
    if (resolveAgent(pane).agent !== "claude") return null;
    const session = await claudePaneSession(pane);
    return session === null ? null : await claudeSessionTempDir(session.path);
  } catch { return null; }
}

export async function handleFileRequest(request: Request, url: URL, pathname: string, { bridgeAuthorized, requestHost, forwarded, client, access }: FileRequester): Promise<Response | null> {
  if (pathname === "/api/fs/stat" || pathname === "/api/fs/file" || pathname === "/api/fs/favicon") {
    setRequestRoute(pathname);
    if (request.method !== "GET" && request.method !== "HEAD") return badRequest("method_not_allowed", "use GET");
    if (crossSiteFileRead(request)) return jsonResponse({ error: { code: "cross_site", message: "A file is read from this app or opened in a tab, not loaded by another page" } }, 403);
    // a device revoked, or a client signed out, while this request finds and draws a page gets none
    // of its media addresses (file-view.ts)
    const watch = watchPageMedia();
    try { return await fileRoute(request, url, pathname, { bridgeAuthorized, requestHost, forwarded, client, access }, watch); } catch (error) { return errorResponse(error); } finally { watch.done(); }
  }

  // a text file read to edit and saved (file-edit.ts); who may is checked by the dispatcher (textEditAllowed)
  if (pathname === "/api/fs/text") {
    setRequestRoute(pathname);
    if (request.method !== "GET" && request.method !== "PUT") return badRequest("method_not_allowed", "use GET or PUT");
    if (crossSiteFileRead(request)) return jsonResponse({ error: { code: "cross_site", message: "A file is edited from this app only" } }, 403);
    try { return await textRoute(request, url); } catch (error) {
      if (error instanceof TextEditRefused) return jsonResponse({ error: { code: error.code, message: error.message, ...(error.revision ? { revision: error.revision } : {}) } }, error.status);
      return errorResponse(error);
    }
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

/** GET and PUT /api/fs/text (shared/files.ts): the pane's folder is the one a file may be edited in. */
async function textRoute(request: Request, url: URL): Promise<Response> {
  if (request.method === "GET") {
    const paneId = url.searchParams.get("pane_id") ?? "";
    if (paneId === "") return badRequest("missing_pane", "pane_id is required");
    return textAnswer(await fileTask<TextTaskResult>({ op: "text-read", path: url.searchParams.get("path") ?? "", cwd: (await paneContext(paneId)).cwd }));
  }
  // JSON only: a form or a text/plain body from another page is refused before it is read
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return jsonResponse({ error: { code: "invalid_content_type", message: "send application/json" } }, 415);
  let body: unknown;
  try { body = JSON.parse(await readCappedText(request, MAX_TEXT_SAVE_BODY_BYTES)); } catch (error) {
    if (error instanceof TextEditRefused) throw error;
    return badRequest("invalid_json", "request body must be JSON");
  }
  if (!isJsonObject(body)) return badRequest("invalid_body", "request body must be a JSON object");
  const { pane_id: paneId, path, revision, text } = body;
  if (typeof paneId !== "string" || paneId === "") return badRequest("missing_pane", "pane_id is required");
  if (typeof path !== "string" || typeof revision !== "string" || typeof text !== "string") return badRequest("invalid_body", "path, revision and text are strings");
  const cwd = (await paneContext(paneId)).cwd;
  return jsonResponse(saveEditableText(path, cwd, revision, text));
}

function textAnswer(result: TextTaskResult): Response {
  if ("done" in result) return jsonResponse(result.done);
  const { status, code, message, revision } = result.refused;
  return jsonResponse({ error: { code, message, ...(revision ? { revision } : {}) } }, status);
}

/** GET/HEAD /api/fs/stat, /api/fs/file and /api/fs/favicon, past the method and site checks. */
async function fileRoute(request: Request, url: URL, pathname: string, { bridgeAuthorized, requestHost, forwarded, client, access }: FileRequester, watch: ReturnType<typeof watchPageMedia>): Promise<Response> {
  if (pathname === "/api/fs/favicon") {
    const root = url.searchParams.get("root") ?? "";
    if (root.trim() === "") return badRequest("missing_root", "root is required");
    return jsonResponse({ icon: await findProjectFavicon(root) } satisfies ProjectFavicon);
  }
  const paneId = url.searchParams.get("pane_id");
  let cwd: string | null = null;
  let paneUnread = false;
  if (paneId) {
    try { cwd = (await paneContext(paneId)).cwd; } catch { paneUnread = true; }
  }
  const path = url.searchParams.get("path") ?? "";
  const found = await findFile(path, cwd, () => paneId ? claudeTempFolder(paneId) : Promise.resolve(null), paneId ? mayBeClaudeTemp : undefined);
  if (found === null && paneUnread && !isAbsolute(path)) return jsonResponse({ error: { code: "pane_unknown", message: "the pane a relative path belongs to could not be read" } }, 404);
  if (found === null) return jsonResponse({ error: { code: "not_found", message: "no readable file at that path" } }, 404);
  if ("candidates" in found) return jsonResponse({ error: { code: "ambiguous_path", message: "several files have that name", candidates: found.candidates } }, 409);
  const mediaSource = bridgeAuthorized || (access.level === "full" && access.via === "relay") ? null : pageMediaSource(requestHost, isSecureRequest(request), forwarded ? request.headers.get("x-forwarded-host") : null);
  // its media plays only for the client address that rendered it, and ends with that device (file-view.ts)
  const media = mediaSource === null ? null : { source: mediaSource, client, device: access.level === "full" ? access.device?.id ?? null : null };
  return pathname === "/api/fs/stat" ? jsonResponse(found.info) : await fileResponse(found.info, url.searchParams.get("download") === "1", url.searchParams.get("render") === "1", media, request, watch, found.within ?? null, access.level === "full" && access.via === "relay");
}
