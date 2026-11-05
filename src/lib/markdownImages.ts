import type { FileInfo } from "../../shared/protocol.ts";
import { fileUriPath } from "../../shared/fileUri.ts";
import { serverResourceUrl } from "./transport.ts";

/** Bigger images are offered as a download: a phone decodes an image whole. */
export const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

export type MarkdownImagePreview = { kind: "inline"; url: string; name: string }
  | { kind: "too-large"; size: number; downloadUrl: string } | { kind: "unavailable" };

/** Decode an eligible local image target once, leaving relative paths relative. */
function localImageTarget(src: string): string | null {
  const target = src.trim().replace(/[?#].*$/s, "");
  if (target === "" || target.startsWith("//")) return null;
  let path: string;
  if (/^[a-z][a-z\d+.-]*:/i.test(target)) {
    const local = fileUriPath(target);
    if (local === null) return null;
    path = local;
  } else {
    // The destination is URL-encoded, including literal # and ? in a filename. Decode once.
    try { path = decodeURIComponent(target); } catch { return null; }
  }
  if (path.startsWith("//") || /^~|^[A-Za-z]:|\\|[\u0000-\u001f\u007f]/.test(path)) return null;
  return path;
}

/** Resolve file-preview images from their Markdown document, never from the pane cwd. */
export function markdownImagePath(src: string, markdownPath: string): string | null {
  let path = localImageTarget(src);
  if (path === null) return null;
  if (!path.startsWith("/")) {
    const folder = markdownPath.slice(0, markdownPath.lastIndexOf("/") + 1);
    if (!folder.startsWith("/")) return null;
    path = folder + path;
  }
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/**
 * Stat before loading. A null document path delegates relative targets to the pane's file API.
 * The inline URL stays a
 * server path, which ReservedImage resolves once; the download link is used as it is, so it is resolved here.
 */
export async function markdownImagePreview(
  src: string,
  markdownPath: string | null,
  fetchInfo: (path: string) => Promise<FileInfo | { candidates: string[] }>,
  fileUrl: (path: string, download: boolean) => string,
): Promise<MarkdownImagePreview | null> {
  const path = markdownPath === null ? localImageTarget(src) : markdownImagePath(src, markdownPath);
  if (path === null) return null;
  try {
    const info = await fetchInfo(path);
    if ("candidates" in info || info.kind !== "image") return null;
    return info.size > MAX_INLINE_IMAGE_BYTES
      ? { kind: "too-large", size: info.size, downloadUrl: await serverResourceUrl(fileUrl(info.path, true)) }
      : { kind: "inline", url: fileUrl(info.path, false), name: info.name };
  } catch (error) {
    // A missing file may still be being written. Other rejected files remain ordinary links.
    const status = error !== null && typeof error === "object" && "status" in error ? error.status : null;
    const retryable = status === null || status === 404 || status === 408 || status === 429 || (typeof status === "number" && status >= 500);
    if (markdownPath === null && retryable) return { kind: "unavailable" };
    return null;
  }
}
