/**
 * The hosted shell: the same client, built for a static host (Cloudflare Pages, app.ovis.sh)
 * instead of a PC's own server, `vite build --mode shell` -> dist-shell/. A phone that scanned a
 * pairing code opens it and reaches its PC through the Ovis relay (src/lib/relay/boot.ts).
 *
 * Each PC is its own app on that one origin, under `/s/<server_id>/`: an installed app's scope,
 * its service worker and so its push subscription are per PC (one PushSubscription per service
 * worker scope and VAPID key), so a second PC never takes the first one's alerts. The host has
 * no code of its own: `_redirects` answers every such path with the one index.html, the manifest
 * and the worker (200 rewrites, the address stays), and `_headers` carries the policy the PC's
 * server would send, derived from it (server/static.ts `shellContentSecurityPolicy`).
 *
 * The shell is told apart from the server-served build by one meta, `<meta name="ovis-shell"
 * content="relay">`, which only this mode writes: without it the client is the native one and
 * nothing here runs (src/lib/shellMode.ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { pagePolicy } from "../server/file-view.ts";
import { IMMUTABLE_CACHE, REVALIDATE, shellContentSecurityPolicy } from "../server/static.ts";

/** Vite's `--mode` that builds the shell; the build's output directory. */
export const SHELL_MODE = "shell";
export const SHELL_OUT_DIR = "dist-shell";

export const SHELL_META = '<meta name="ovis-shell" content="relay" />';

const MANIFEST_LINK = /<link rel="manifest" href="\/manifest\.webmanifest(\?[^"]*)?"/;

/**
 * index.html as the shell: the meta that names the mode, and the manifest named relative to the
 * page, so a PC's page at `/s/<id>/` installs from `/s/<id>/manifest.webmanifest` (its own scope)
 * and the front page from `/manifest.webmanifest`.
 */
export function shellIndexHtml(html: string): string {
  if (!MANIFEST_LINK.test(html)) throw new Error("index.html must link /manifest.webmanifest for the shell to make it relative");
  const linked = html.replace(MANIFEST_LINK, (_, query: string | undefined) => `<link rel="manifest" href="manifest.webmanifest${query ?? ""}"`);
  const head = linked.indexOf("</head>");
  if (head === -1) throw new Error("index.html must hold a </head>");
  return `${linked.slice(0, head)}  ${SHELL_META}\n  ${linked.slice(head)}`;
}

/**
 * The shell's manifest, from the app's: `id`, `start_url` and `scope` relative to the manifest's
 * own address, so at `/s/<id>/manifest.webmanifest` every PC is an app of its own scope (and the
 * front page, at `/manifest.webmanifest`, the origin's). Everything else, icons included, stays.
 */
export function shellManifest(manifest: string): string {
  return `${JSON.stringify({ ...JSON.parse(manifest) as Record<string, unknown>, id: "./", start_url: "./", scope: "./" }, null, 2)}\n`;
}

/** Where the hosted shell's render host for a PC's rendered pages answers (todo 17's page); only its policy is reserved here. */
export const RENDER_PATH = "/s/:id/~render";

/**
 * Pages `_redirects`: a PC's scope is the shell, its manifest and its worker under its own path.
 * The first matching rule wins, so the files come before the scope's catch-all; a scope named
 * without its slash is sent to it, so the page's relative manifest resolves inside the scope.
 */
export function shellRedirects(): string {
  return [
    "# Each PC's app lives under its own scope, /s/<server_id>/ (scripts/shell-build.ts)",
    "/s/:id /s/:id/ 301",
    "/s/:id/manifest.webmanifest /manifest.webmanifest 200",
    "/s/:id/sw.js /sw.js 200",
    `${RENDER_PATH} /render.html 200`,
    "/s/* /index.html 200",
    "",
  ].join("\n");
}

/**
 * Pages `_headers`: the shell's policy on everything, the render host's own policy on its path
 * (the first is detached there: Pages joins a header set twice with a comma), and the caching
 * rules the PC's server applies (server/static.ts): hashed assets for good, the shell, the worker
 * and the manifest revalidated on every load, under a PC's scope too.
 */
export function shellHeaders(): string {
  return [
    "# Derived from the PC server's policy: server/static.ts shellContentSecurityPolicy() (scripts/shell-build.ts)",
    "/*",
    `  Content-Security-Policy: ${shellContentSecurityPolicy()}`,
    "",
    `${RENDER_PATH}`,
    "  ! Content-Security-Policy",
    `  Content-Security-Policy: ${pagePolicy(null)}`,
    "",
    "/assets/*",
    `  Cache-Control: ${IMMUTABLE_CACHE}`,
    "",
    ...["/", "/index.html", "/sw.js", "/manifest.webmanifest", "/s/*"].flatMap((path) => [path, `  Cache-Control: ${REVALIDATE}`, ""]),
  ].join("\n");
}

/** The files the shell build writes beside Vite's output. */
export function shellFiles(manifest: string): Record<string, string> {
  return {
    "render.html": `<!doctype html><html><head><meta charset="utf-8"><title>Ovis</title></head><body><script>
function render(event) {
  if (event.source !== parent || event.data?.type !== "ovis-render" || typeof event.data.html !== "string") return;
  removeEventListener("message", render);
  document.open();
  document.write(event.data.html);
  document.close();
}
addEventListener("message", render);
parent.postMessage({ type: "ovis-render-ready" }, "*");
</script></body></html>`,
    "manifest.webmanifest": shellManifest(manifest),
    _redirects: shellRedirects(),
    _headers: shellHeaders(),
  };
}

/** The Vite plugin for `--mode shell`: the meta in the page, the relative manifest, and the Pages files in the output. */
export function shellBuild(): Plugin {
  let manifest = "";
  return {
    name: "shell-build",
    apply: "build",
    configResolved(config) {
      const path = join(config.root, "public", "manifest.webmanifest");
      if (!existsSync(path)) throw new Error("public/manifest.webmanifest is missing: the shell derives its manifest from it");
      manifest = readFileSync(path, "utf8");
    },
    transformIndexHtml: {
      order: "post",
      handler: (html) => shellIndexHtml(html),
    },
    // after Vite copied public/ (the app's manifest among it), which these replace or join
    writeBundle(options) {
      if (!options.dir) throw new Error("the shell build has no output directory");
      mkdirSync(options.dir, { recursive: true });
      for (const [name, content] of Object.entries(shellFiles(manifest))) writeFileSync(join(options.dir, name), content);
    },
  };
}
