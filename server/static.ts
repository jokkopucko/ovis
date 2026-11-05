/**
 * Serves the built client out of dist/.
 *
 * Cache-Control is decided per file on purpose: Vite fingerprints everything under
 * /assets/, so those are safe to pin for a year, while the service worker, the web
 * manifest and the index.html shell must revalidate on every load - a cached sw.js
 * or shell pins the installed PWA to a build the user can no longer get rid of.
 */

import type { BunFile } from "bun";
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";

// A URL's pathname is not a file path: on Windows it is `/C:/...`, and spaces come percent-encoded.
const DIST_DIR = join(import.meta.dir, "..", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Files whose URL never changes but whose contents decide what the app becomes. */
const REVALIDATED_PATHS = new Set(["/sw.js", "/manifest.webmanifest"]);

/** The hosted shell's Pages `_headers` (scripts/shell-build.ts) caches by the same rules. */
export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const SHORT_CACHE = "public, max-age=86400";
export const REVALIDATE = "no-cache";

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return MIME[path.slice(dot)] ?? "application/octet-stream";
}

function cacheControlFor(pathname: string): string {
  if (REVALIDATED_PATHS.has(pathname)) return REVALIDATE;
  if (pathname.startsWith("/assets/")) return IMMUTABLE_CACHE;
  return SHORT_CACHE;
}

/**
 * The app's own Content-Security-Policy, sent with the shell and every static file. The file
 * viewer's own answers (`/api/fs/*`, a PDF in a frame, images in an <img>) do not pass through
 * here: `fileResponse` (file-view.ts) sends them its own, stricter `sandbox; default-src 'none'`.
 * Every directive is here for a reason, and none of them is a guess:
 *
 * - `default-src 'self'`: the fallback for anything not named below. Nothing is fetched
 *   from another host: the API, the terminal socket, the machines event stream, the
 *   fonts (bundled woff2, `src/fonts/`), the PC bundle and the push endpoints are all
 *   same-origin, and the remote PCs are reached through this server's own /api/machines
 *   proxy rather than from the browser.
 * - `script-src 'self'`: both entry points are Vite modules (index.html), nothing in the
 *   app evaluates a string, and there is no inline handler attribute. This is the
 *   directive that matters: KaTeX output and the agent marks are the two places that put
 *   third-party HTML into the page.
 * - `style-src 'self' 'unsafe-inline'`: inline style attributes are how measured layout
 *   reaches the DOM (AgentPicker, RowMenu, Droplet, UsageMeters), and KaTeX writes one on
 *   every expression it cannot render. It is also load-bearing for the terminal itself:
 *   xterm.js builds its layers by appending a <style> element to the DOM, and a
 *   DOM-inserted <style> is subject to style-src, so without 'unsafe-inline' the pane
 *   loses its cursor and its layers. The unsafe part is styles, not script.
 * - `img-src 'self' data: blob:`: same-origin icons, pane images and file-viewer images;
 *   `blob:` for a pasted image previewed before it is uploaded; `data:` for the inline
 *   agent marks.
 * - `font-src 'self' data:`: every face is bundled (the app's own and KaTeX's, both
 *   through Vite). No font CDN. The `data:` is Vite's own inlining: an asset under ~4 KB
 *   is emitted as a data: URL inside the CSS rather than as a file, and KaTeX_Size3's
 *   3 KB woff2 is one of them. That data: is app-bundled bytes, never anything an agent
 *   or a transcript can reach. Measured in Chromium: without it the load reports one
 *   `font-src` violation per maths-bearing page, and the browser falls through to the
 *   same-origin .woff of the same face, so the maths still draws.
 * - `connect-src 'self'`: every fetch is a relative /api path, the terminal socket is
 *   window.location.host over ws:/wss: (which 'self' matches — confirmed in Chromium:
 *   an explicit `new WebSocket("ws://<same host>/ws")` and the machines event stream both
 *   connect under the enforcing header).
 * - `media-src 'self'`: the file viewer's <video>/<audio>, same-origin.
 * - `frame-src 'self'`: the PDF viewer frames /api/fs/file, same-origin. With the request's
 *   origin known, also any port of the host the browser used for the app: the web panel
 *   (src/lib/webPanel.ts) frames a page served by this PC, a dev server's localhost:5173 named
 *   under that host. No other host is framed.
 * - `worker-src 'self'`: the service worker is /sw.js, same-origin.
 * - `object-src 'none'`: no <object>/<embed> in the app, and none may appear.
 * - `base-uri 'self'`: no <base>, and a tag that adds one changes what every relative URL
 *   in the page means.
 * - `form-action 'self'`: every form is submitted by script, but a form that ever grows
 *   an action must not post this PC's credentials somewhere else.
 * - `frame-ancestors 'none'`: nothing frames the app itself.
 */
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self'",
  "frame-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];

/**
 * The policy both headers carry. A browser script that serves a build of its own sends it as it is:
 * serveStatic reads only this checkout's dist/, and sends no policy before that is built.
 */
export const CONTENT_SECURITY_POLICY = CSP_DIRECTIVES.join("; ");

/**
 * What the hosted shell (dist-shell/, app.ovis.sh) changes in the policy above, and nothing else:
 * its server is reached through a relay's WebSocket, not its own origin, so `connect-src` admits
 * any wss: address (relay.ovis.sh, or a self-hosted relay from OVIS_RELAY_URL), and a video or a
 * PDF it cannot address by URL (the native app's WebView has no service worker, todo 17) plays or
 * frames from a blob: URL it fetched over the relay. Every other directive, `style-src
 * 'unsafe-inline'` and `font-src 'self' data:` among them, stays for the reasons given above.
 */
const SHELL_SOURCES: Record<string, string> = {
  "connect-src": "'self' wss:",
  "media-src": "'self' blob:",
  "frame-src": "'self' blob:",
};

/** The hosted shell's policy: `CONTENT_SECURITY_POLICY` with only the transport-related sources changed (SHELL_SOURCES). */
export function shellContentSecurityPolicy(): string {
  return CSP_DIRECTIVES.map((directive) => {
    const name = directive.slice(0, directive.indexOf(" "));
    const sources = SHELL_SOURCES[name];
    return sources === undefined ? directive : `${name} ${sources}`;
  }).join("; ");
}

/** A host name or bracketed IPv6 address, nothing that could end or add a directive. */
const FRAMEABLE_HOST = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/i;

/** The policy for a request from `origin` (requestOrigin): its host's other ports may be framed. */
export function contentSecurityPolicy(origin?: string): string {
  let host: string | null = null;
  try {
    host = origin === undefined ? null : new URL(origin).hostname;
  } catch {
    host = null;
  }
  if (host === null || !FRAMEABLE_HOST.test(host)) return CONTENT_SECURITY_POLICY;
  return CSP_DIRECTIVES.map((directive) => directive === "frame-src 'self'" ? `frame-src 'self' http://${host}:* https://${host}:*` : directive).join("; ");
}

/**
 * OVIS_CSP=report-only measures the policy above without enforcing it: the browser
 *   logs what the policy would have blocked and the app keeps working. `report-only` is the
 *   measurement mode; anything else enforces.
 */
function cspHeader(origin?: string): Record<string, string> {
  const mode = process.env["OVIS_CSP"];
  const policy = contentSecurityPolicy(origin);
  return mode === "report-only"
    ? { "content-security-policy-report-only": policy }
    : { "content-security-policy": policy };
}

/**
 * OVIS_APP_NAME names the installed app. Each PC is its own origin, so two PCs installed
 * on one phone are two apps, and both would be called "Ovis" (#476). Unset or blank, every
 * file is served as built. Read on every request, like OVIS_CSP; the manifest and the
 * shell revalidate on every load, so an installed app learns a new name without a reinstall.
 */
export function appName(): string | null {
  const name = process.env["OVIS_APP_NAME"]?.trim();
  return name ? name : null;
}

/** The manifest under another name: `short_name` is the home-screen label, `name` the rest. */
export function renameManifest(manifest: string, name: string): string {
  return JSON.stringify({ ...JSON.parse(manifest), name, short_name: name }, null, 2);
}

/**
 * The manifest with the app's own absolute id as a related application. Chromium's
 * getInstalledRelatedApps() matches `platform: "webapp"` entries by absolute id only, so a tab
 * in the browser can find the installed copy of the same origin. The origin differs per PC and
 * per proxy, so it is added per request, never written into public/manifest.webmanifest.
 */
export function relateManifest(text: string, origin: string): string {
  return JSON.stringify({ ...JSON.parse(text), related_applications: [{ platform: "webapp", id: `${origin}/` }] }, null, 2);
}

/** What /manifest.webmanifest answers: renamed under OVIS_APP_NAME, then related to its origin. */
export function manifestBody(text: string, origin: string): string {
  const name = appName();
  return relateManifest(name ? renameManifest(text, name) : text, origin);
}

/**
 * The origin a browser used to reach this request: the scheme from X-Forwarded-Proto when a
 * proxy states one (http or https), else the request URL's, and the host from the Host header.
 */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const scheme = forwarded === "http" || forwarded === "https" ? forwarded : url.protocol.slice(0, -1);
  return `${scheme}://${request.headers.get("host") ?? url.host}`;
}

const APPLE_TITLE = /(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/;

/** The shell under another name: an iOS home-screen install takes its label from this meta. */
export function renameShell(html: string, name: string): string {
  const content = name.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return html.replace(APPLE_TITLE, (_, start: string, end: string) => `${start}${content}${end}`);
}

/** The file as built, or the manifest and the shell under OVIS_APP_NAME. */
async function body(file: BunFile, kind: "manifest" | "shell" | null, origin?: string): Promise<BunFile | string> {
  if (kind === "manifest" && origin !== undefined) return manifestBody(await file.text(), origin);
  const name = appName();
  if (!name || !kind) return file;
  return kind === "manifest" ? renameManifest(await file.text(), name) : renameShell(await file.text(), name);
}

/** Accepted representations, with a server preference for br over gzip on ties.
 * An implicit identity is the fallback; explicit identity quality participates. */
function encodings(header: string | null | undefined): Array<"br" | "gzip" | "identity"> {
  if (!header?.trim()) return ["identity"];
  const weights = new Map<string, number>();
  for (const item of header.split(",")) {
    const match = /^\s*([\w*-]+)\s*(?:;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?\s*$/i.exec(item);
    // x-gzip is gzip's older name (RFC 9110 §8.4.1.3): one weight for both
    if (match) weights.set(match[1]!.toLowerCase().replace(/^x-gzip$/, "gzip"), match[2] === undefined ? 1 : Number(match[2]));
  }
  const weight = (coding: string): number => weights.get(coding) ?? (coding === "identity" ? (weights.get("*") === 0 ? 0 : 0.001) : weights.get("*") ?? 0);
  return (["br", "gzip", "identity"] as const).filter(coding => weight(coding) > 0).sort((a, b) => weight(b) - weight(a));
}

/** `origin` is what requestOrigin answers; a caller that has no request (a QA script) may leave it out. */
export async function serveStatic(pathname: string, acceptEncoding?: string | null, origin?: string): Promise<Response> {
  const indexPath = join(DIST_DIR, "index.html");
  if (!existsSync(indexPath)) {
    return new Response(
      "Ovis server is running, but the browser client has not been built yet.\nRun: bun run build\n",
      { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const candidate = join(DIST_DIR, relative);
  if (candidate.startsWith(DIST_DIR) && relative !== "/" && existsSync(candidate)) {
    const file = Bun.file(candidate);
    if ((await file.exists()) && !(await file.stat()).isDirectory()) {
      // Only immutable JS/CSS get build-time sidecars. Never compress user/API
      // data, the service worker, or the shell on a request's hot path.
      if (pathname.startsWith("/assets/") && /\.(?:js|css)$/.test(pathname)) {
        for (const encoding of encodings(acceptEncoding)) {
          const body = encoding === "identity" ? file : Bun.file(`${candidate}.${encoding === "br" ? "br" : "gz"}`);
          if (!await body.exists()) continue;
          return new Response(body, { headers: { "content-type": contentTypeFor(candidate), "cache-control": IMMUTABLE_CACHE,
            vary: "Accept-Encoding", ...cspHeader(), ...(encoding === "identity" ? {} : { "content-encoding": encoding }) } });
        }
        return new Response(null, { status: 406, headers: { vary: "Accept-Encoding", ...cspHeader() } });
      }
      const kind = pathname === "/manifest.webmanifest" ? "manifest" : candidate === indexPath ? "shell" : null;
      return new Response(await body(file, kind, origin), {
        headers: { "content-type": contentTypeFor(candidate), "cache-control": cacheControlFor(pathname), ...cspHeader(origin) },
      });
    }
  }
  // a missing file is not a page: the shell under a bundle's URL fails as a script anyway, and a
  // service worker would keep it there. An old tab asks for its own build's chunks after an update.
  if (pathname.startsWith("/assets/") || pathname.startsWith("/icons/")) {
    return new Response(null, { status: 404, headers: { "cache-control": REVALIDATE, ...cspHeader() } });
  }
  return new Response(await body(Bun.file(indexPath), "shell"), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": REVALIDATE, ...cspHeader(origin) },
  });
}
