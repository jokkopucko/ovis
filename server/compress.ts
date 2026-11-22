/**
 * gzip for the text this server answers with, when the browser takes it. A conversation page is
 * JSON of up to a few megabytes, polled every 2 s while it changes; over a Tailscale relay or a
 * phone's link those bytes were most of a session switch (2026-10-08: 2.1 MB → about a fifth).
 *
 * Only finished bodies of a text type: the event stream (SSE) and a WebSocket upgrade pass
 * untouched, and so do files a user downloads, a range answer and anything already encoded.
 * Every answer whose form depends on Accept-Encoding says so in `Vary`, the plain one and a 304
 * too, so a cache never hands one form to a client that asked for the other.
 */
import { errorResponse } from "./http.ts";

const COMPRESSIBLE = /^(?:application\/(?:json|javascript|manifest\+json)|text\/(?:html|css|javascript|plain)|image\/svg\+xml)\b/i;
const MIN_BYTES = 1024;
const KEPT_BYTES = 8 * 1024 * 1024;
const KEPT_ENTRY_BYTES = 2 * 1024 * 1024;
const kept = new Map<string, Uint8Array<ArrayBuffer>>();
let keptBytes = 0;

/** Whether Accept-Encoding takes gzip: named (or `*`) with a quality above 0, a named gzip outranking `*`. */
function acceptsGzip(request: Request): boolean {
  let gzip: number | null = null;
  let any: number | null = null;
  for (const part of (request.headers.get("accept-encoding") ?? "").split(",")) {
    const [name, ...params] = part.split(";").map((piece) => piece.trim().toLowerCase());
    const q = params.find((param) => /^q\s*=/.test(param));
    const quality = q === undefined ? 1 : Number(q.replace(/^q\s*=\s*/, ""));
    if (name === "gzip" || name === "x-gzip") gzip = quality;
    else if (name === "*") any = quality;
  }
  const quality = gzip ?? any ?? 0;
  return Number.isFinite(quality) && quality > 0;
}

function negotiable(pathname: string, response: Response): boolean {
  // Immutable static variants have already selected br/gzip/identity by quality.
  // Recompressing their identity choice would override the browser's preference.
  if (pathname.startsWith("/assets/") && /\bimmutable\b/i.test(response.headers.get("cache-control") ?? "") && /\baccept-encoding\b/i.test(response.headers.get("vary") ?? "")) return false;
  if (/\/fs\/file$/.test(pathname)) return false;
  if (response.status === 304) return true;
  if (response.status !== 200 || response.headers.has("content-encoding") || response.headers.has("content-range")) return false;
  const type = response.headers.get("content-type") ?? "";
  return COMPRESSIBLE.test(type) && !/^text\/event-stream/i.test(type) && !/attachment/i.test(response.headers.get("content-disposition") ?? "");
}

function gzipOf(body: Uint8Array<ArrayBuffer>, keep: boolean): Uint8Array<ArrayBuffer> {
  const gzip = (): Uint8Array<ArrayBuffer> => Bun.gzipSync(body, { level: 6 }) as Uint8Array<ArrayBuffer>;
  if (!keep) return gzip();
  const key = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  const hit = kept.get(key);
  if (hit !== undefined) {
    kept.delete(key);
    kept.set(key, hit);
    return hit;
  }
  const gzipped = gzip();
  if (gzipped.byteLength > KEPT_ENTRY_BYTES) return gzipped;
  kept.set(key, gzipped);
  keptBytes += gzipped.byteLength;
  for (const [oldest, value] of kept) {
    if (keptBytes <= KEPT_BYTES) break;
    kept.delete(oldest);
    keptBytes -= value.byteLength;
  }
  return gzipped;
}

export async function compressResponse(request: Request, response: Response | undefined): Promise<Response | undefined> {
  if (response === undefined) return response;
  const { pathname } = new URL(request.url);
  if (!negotiable(pathname, response)) return response;
  const headers = new Headers(response.headers);
  if (!/\baccept-encoding\b/i.test(headers.get("vary") ?? "")) headers.append("vary", "accept-encoding");
  const init = { status: response.status, statusText: response.statusText, headers };
  if (response.status !== 200 || request.method === "HEAD" || !acceptsGzip(request)) return new Response(response.body, init);
  let body: Uint8Array<ArrayBuffer>;
  try { body = new Uint8Array(await response.arrayBuffer()); } catch (error) { return errorResponse(error); }
  if (body.byteLength < MIN_BYTES) return new Response(body, init);
  const gzipped = gzipOf(body, !pathname.startsWith("/api/"));
  headers.set("content-encoding", "gzip");
  headers.delete("content-length");
  // the gzipped bytes are not the plain ones: a strong tag must not claim they are
  const etag = headers.get("etag");
  if (etag !== null && !etag.startsWith("W/")) headers.set("etag", `W/${etag}`);
  return new Response(gzipped, init);
}
