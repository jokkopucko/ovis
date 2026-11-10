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
import { dirname, join } from "node:path";
import type { Plugin } from "vite";
import { pagePolicy } from "../server/file-view.ts";
import { accountServiceOrigin, DEFAULT_ACCOUNT_SERVICE, IMMUTABLE_CACHE, REVALIDATE, shellContentSecurityPolicy } from "../server/static.ts";
import { REGIONAL_APPS } from "../shared/relay-regions.ts";

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
/**
 * The account metas the shell is built with: `ovis-account-service`, account.ovis.sh unless
 * OVIS_ACCOUNT_SERVICE_URL names another https origin (none when it is `off` or not https, and the
 * shell offers no sign-in), as on the PC's own pages; and `ovis-account-providers` from
 * OVIS_ACCOUNT_PROVIDERS (GitHub alone without it, until the service's own list answers).
 */
export function accountMetas(env: Record<string, string | undefined>): string[] {
  const origin = accountServiceOrigin(env["OVIS_ACCOUNT_SERVICE_URL"] ?? DEFAULT_ACCOUNT_SERVICE);
  if (origin === null) return [];
  const providers = (env["OVIS_ACCOUNT_PROVIDERS"] ?? "").split(",").map((name) => name.trim()).filter((name) => name === "github" || name === "google" || name === "apple");
  return [`<meta name="ovis-account-service" content="${origin}" />`, ...(providers.length > 0 ? [`<meta name="ovis-account-providers" content="${providers.join(",")}" />`] : [])];
}

export function shellIndexHtml(html: string, env: Record<string, string | undefined> = {}): string {
  if (!MANIFEST_LINK.test(html)) throw new Error("index.html must link /manifest.webmanifest for the shell to make it relative");
  const linked = html.replace(MANIFEST_LINK, (_, query: string | undefined) => `<link rel="manifest" href="manifest.webmanifest${query ?? ""}"`);
  // first in <head>: the theme boot script (scripts/theme-bootstrap-build.ts) runs where it stands and reads the mode
  const head = /<head>\n?/.exec(linked);
  if (head === null) throw new Error("index.html must hold a <head>");
  const at = head.index + head[0].length;
  return `${linked.slice(0, at)}${[SHELL_META, ...accountMetas(env)].map((meta) => `    ${meta}\n`).join("")}${linked.slice(at)}`;
}

/**
 * The shell's manifest, from the app's: `id`, `start_url` and `scope` relative to the manifest's
 * own address, so at `/s/<id>/manifest.webmanifest` every PC is an app of its own scope (and the
 * front page, at `/manifest.webmanifest`, the origin's). Everything else, icons included, stays.
 */
export function shellManifest(manifest: string): string {
  return `${JSON.stringify({ ...JSON.parse(manifest) as Record<string, unknown>, id: "./", start_url: "./", scope: "./" }, null, 2)}\n`;
}

/** The phone apps' id: the Android package and the iOS bundle (app/capacitor.config.json). */
export const APP_ID = "sh.ovis.app";

/**
 * The certificates an Android app that may open `https://app.ovis.sh/s/` links is signed with:
 * Google Play's app signing key (Play Console, App integrity), which signs every copy Play
 * installs, and the upload key (the certificate in a bundle built for upload), which signs a
 * release build installed by hand.
 */
export const ANDROID_APP_FINGERPRINTS = [
  "7A:F3:97:1A:B8:7A:22:3B:A4:6D:58:13:89:ED:7A:EB:A9:31:3F:97:E5:A1:03:87:63:74:BE:CB:54:1C:1D:63",
  "BD:49:0B:C8:3D:3F:22:C8:55:9E:57:60:C4:7D:71:63:7D:34:22:92:95:82:C9:B4:05:E3:E6:79:AD:8E:29:C6",
];

/** The iOS app as Apple names it in a Universal Link: the Apple team, then the bundle id. */
export const IOS_APP_ID = `5987KT43TJ.${APP_ID}`;

/**
 * The files that let the phone apps open a PC's page on app.ovis.sh (a pairing link tapped in a
 * message, or the camera reading the PC's QR code) instead of the browser: Android checks
 * `assetlinks.json` for the app's `autoVerify` link (app/android/app/src/main/AndroidManifest.xml),
 * iOS `apple-app-site-association` for an app whose Associated Domains name this host. Only a PC's
 * scope, `/s/`, is the app's: the front page stays the hosted shell's.
 */
export function appLinkFiles(): Record<string, string> {
  return {
    ".well-known/assetlinks.json": `${JSON.stringify([{
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: APP_ID, sha256_cert_fingerprints: ANDROID_APP_FINGERPRINTS },
    }], null, 2)}\n`,
    ".well-known/apple-app-site-association": `${JSON.stringify({ applinks: { details: [{ appIDs: [IOS_APP_ID], components: [{ "/": "/s/*" }] }] } }, null, 2)}\n`,
  };
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
    "# Derived from the PC server's policy: server/static.ts shellContentSecurityPolicy(Object.values(REGIONAL_APPS)) (scripts/shell-build.ts)",
    "/*",
    `  Content-Security-Policy: ${shellContentSecurityPolicy(Object.values(REGIONAL_APPS))}`,
    "",
    `${RENDER_PATH}`,
    "  ! Content-Security-Policy",
    `  Content-Security-Policy: ${pagePolicy(null)}`,
    "",
    "/assets/*",
    `  Cache-Control: ${IMMUTABLE_CACHE}`,
    "",
    // the app links' files (appLinkFiles): apple-app-site-association has no extension
    "/.well-known/*",
    "  Content-Type: application/json",
    "",
    ...["/", "/index.html", "/sw.js", "/manifest.webmanifest", "/s/*"].flatMap((path) => [path, `  Cache-Control: ${REVALIDATE}`, ""]),
  ].join("\n");
}

/**
 * The same site for Caddy, for a copy of the shell served beside a regional relay
 * (relay/shell-mirror.ts keeps `<root>` current): the rewrites of shellRedirects() and the headers
 * of shellHeaders(), from the same sources. `bun scripts/shell-caddy.ts <site> [root]` prints it.
 */
export function shellCaddyfile(site: string, root = "/opt/ovis-shell/current"): string {
  if (!/^[a-z0-9.-]+$/.test(site) || !/^\/[\w./-]+$/.test(root)) throw new Error("not a site address or a folder");
  const scope = "^/s/[0-9a-f]{32}";
  return [
    `${site} {`,
    `\troot * ${root}`,
    `\t@bare path_regexp bare ^/s/([0-9a-f]{32})$`,
    `\tredir @bare /s/{re.bare.1}/ 301`,
    `\t@render path_regexp render ${scope}/~render$`,
    `\t@notrender not path_regexp ${scope}/~render$`,
    `\t@manifest path_regexp manifest ${scope}/manifest\\.webmanifest$`,
    `\t@worker path_regexp worker ${scope}/sw\\.js$`,
    `\t@revalidate path / /index.html /sw.js /manifest.webmanifest /s/*`,
    `\t@hidden path /_headers /_redirects`,
    `\theader @notrender Content-Security-Policy "${shellContentSecurityPolicy(Object.values(REGIONAL_APPS))}"`,
    `\theader @render Content-Security-Policy "${pagePolicy(null)}"`,
    `\theader /assets/* Cache-Control "${IMMUTABLE_CACHE}"`,
    `\theader @revalidate Cache-Control "${REVALIDATE}"`,
    // as Pages answers it: the first script on app.ovis.sh compares this copy's build with its own
    `\theader /build.json Access-Control-Allow-Origin "*"`,
    `\trespond @hidden 404`,
    `\thandle @render {\n\t\trewrite * /render.html\n\t}`,
    `\thandle @manifest {\n\t\trewrite * /manifest.webmanifest\n\t}`,
    `\thandle @worker {\n\t\trewrite * /sw.js\n\t}`,
    `\thandle_path /s/* {\n\t\trewrite * /index.html\n\t}`,
    // relay/shell-mirror.ts drops the precompressed copies, which Pages never serves as files
    `\tencode zstd gzip`,
    `\tfile_server`,
    "}",
    "",
  ].join("\n");
}

/** The files the shell build writes beside Vite's output. */
export function shellFiles(manifest: string): Record<string, string> {
  return {
    "render.html": `<!doctype html><html><head><meta charset="utf-8"><title>Ovis</title></head><body><script>
function render(event) {
  if (event.source !== parent || event.data?.type !== "ovis-render" || typeof event.data.html !== "string") return;
  removeEventListener("message", render);
  if (event.data.scripts !== true) {
    // The page's scripts are off until the person asks for them: it is drawn in a frame of its own that runs
    // none. That frame keeps this document's policy, so the page's styles, pictures and fonts draw as they do
    // with scripts.
    const page = document.createElement("iframe");
    page.setAttribute("sandbox", "");
    page.srcdoc = event.data.html;
    page.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0";
    document.body.replaceChildren(page);
    return;
  }
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
    ...appLinkFiles(),
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
      handler: (html) => shellIndexHtml(html, process.env),
    },
    // after Vite copied public/ (the app's manifest among it), which these replace or join
    writeBundle(options) {
      if (!options.dir) throw new Error("the shell build has no output directory");
      mkdirSync(options.dir, { recursive: true });
      for (const [name, content] of Object.entries(shellFiles(manifest))) {
        mkdirSync(dirname(join(options.dir, name)), { recursive: true });
        writeFileSync(join(options.dir, name), content);
      }
    },
  };
}
