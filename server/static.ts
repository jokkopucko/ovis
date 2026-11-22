/**
 * Cache-Control is decided per file on purpose: Vite fingerprints everything under
 * /assets/, so those are safe to pin for a year, while the service worker, the web
 * manifest and the index.html shell must revalidate on every load - a cached sw.js
 * or shell pins the installed PWA to a build the user can no longer get rid of.
 */

import type { BunFile } from "bun";
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { accountServiceOrigin, CSP_DIRECTIVES, DEFAULT_ACCOUNT_SERVICE, IMMUTABLE_CACHE, REVALIDATE, shellContentSecurityPolicy } from "../shared/web-policy.ts";
import { ASSETS } from "./entries.ts";

export { accountServiceOrigin, DEFAULT_ACCOUNT_SERVICE, IMMUTABLE_CACHE, REVALIDATE, shellContentSecurityPolicy };

// A URL's pathname is not a file path: on Windows it is `/C:/...`, and spaces come percent-encoded.
const DIST_DIR = join(ASSETS, "dist");

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
  ".wasm": "application/wasm",
};

/** Files whose URL never changes but whose contents decide what the app becomes. */
const REVALIDATED_PATHS = new Set(["/sw.js", "/manifest.webmanifest", "/index.html"]);

const SHORT_CACHE = "public, max-age=86400";

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
 * The policy both headers carry, before contentSecurityPolicy() adds the request's host to `frame-src`
 * and the account service to `connect-src`. A browser script that serves a build of its own sends it as it is:
 * serveStatic reads only this checkout's dist/, and sends no policy before that is built.
 */
export const CONTENT_SECURITY_POLICY = CSP_DIRECTIVES.join("; ");

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
  const frameable = host !== null && FRAMEABLE_HOST.test(host);
  const account = accountServiceOrigin();
  return CSP_DIRECTIVES.map((directive) => {
    if (directive === "frame-src 'self'" && frameable) return `frame-src 'self' http://${host}:* https://${host}:*`;
    if (directive === "connect-src 'self'" && account !== null) return `connect-src 'self' ${account}`;
    return directive;
  }).join("; ");
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
 * Each PC is its own origin, so two PCs installed on one phone are two apps, and both would be called
 * "Ovis" (#476). Read on every request, like OVIS_CSP; the manifest and the shell revalidate on every
 * load, so an installed app learns a new name without a reinstall.
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

/**
 * The shell with the account service its own pages sign in to (`ovis-pc-account-service`, read by
 * src/lib/account/service.ts): the very origin `connect-src` admits, so the two never disagree, and
 * none when the account is off. The hosted shell's `ovis-account-service` is another meta.
 */
export function accountShell(html: string): string {
  const origin = accountServiceOrigin();
  return origin === null ? html : html.replace("</head>", `<meta name="ovis-pc-account-service" content="${origin}" />\n</head>`);
}

async function body(file: BunFile, kind: "manifest" | "shell" | null, origin?: string): Promise<BunFile | string> {
  if (kind === "manifest" && origin !== undefined) return manifestBody(await file.text(), origin);
  const name = appName();
  if (kind === "shell") return accountShell(name ? renameShell(await file.text(), name) : await file.text());
  if (!name || !kind) return file;
  return renameManifest(await file.text(), name);
}

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
      // Only immutable JS/CSS/WebAssembly get build-time sidecars (scripts/compressed-assets.ts).
      // Never compress user/API data, the service worker, or the shell on a request's hot path.
      if (pathname.startsWith("/assets/") && /\.(?:js|css|wasm)$/.test(pathname)) {
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
    // a sign-in's return carries its code in the address (src/lib/account/ownWindow.ts): no cache keeps that page
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": pathname === "/callback" ? "no-store" : REVALIDATE, ...cspHeader(origin) },
  });
}
