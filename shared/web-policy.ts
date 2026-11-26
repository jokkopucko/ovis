export const DEFAULT_ACCOUNT_SERVICE = "https://account.ovis.sh";
export const accountServiceOff = (value: string): boolean => value.trim().toLowerCase() === "off";

/** The hosted shell's Pages `_headers` (scripts/shell-build.ts) caches by the same rules. */
export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
export const REVALIDATE = "no-cache";

/**
 * The app's own Content-Security-Policy, sent with the shell and every static file. The file
 * viewer's own answers (`/api/fs/*`) do not pass through here: `fileResponse` (file-view.ts) sends
 * them its own, stricter `sandbox; default-src 'none'`, except a PDF, which gets no policy at all
 * (the browser's PDF viewer refuses a sandboxed document).
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
 *   third-party HTML into the page. `'wasm-unsafe-eval'` lets the page compile WebAssembly
 *   and nothing else (no eval, no string to script). The bundled libghostty-vt module
 *   draws the terminal and its inline images.
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
export const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
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
 * What the hosted shell (dist-shell/, app.ovis.sh) changes in the policy above, and nothing else:
 * its server is reached through a relay's WebSocket, not its own origin, so `connect-src` admits
 * any wss: address (relay.ovis.sh, or a self-hosted relay from OVIS_RELAY_URL), and a video or a
 * PDF it cannot address by URL (the native app's WebView has no service worker, todo 17) plays or
 * frames from a blob: URL it fetched over the relay. Every other directive, `style-src
 * 'unsafe-inline'` and `font-src 'self' data:` among them, stays for the reasons given above.
 */
const SHELL_SOURCES: Record<string, string> = {
  // the account service the shell signs in to (docs/account.md); a self-hosted one is not added yet
  "connect-src": `'self' wss: ${DEFAULT_ACCOUNT_SERVICE}`,
  "media-src": "'self' blob:",
  "frame-src": "'self' blob:",
};

/**
 * The hosted shell's policy: `CONTENT_SECURITY_POLICY` with only the transport-related sources
 * changed (SHELL_SOURCES). `connect` adds origins the shell may fetch from: the hosted build passes
 * the regional copies of the app, whose build its first script compares (scripts/shell-build.ts).
 */
export function shellContentSecurityPolicy(connect: readonly string[] = []): string {
  return CSP_DIRECTIVES.map((directive) => {
    const name = directive.slice(0, directive.indexOf(" "));
    const sources = SHELL_SOURCES[name];
    if (sources === undefined) return directive;
    return name === "connect-src" && connect.length ? `${name} ${sources} ${connect.join(" ")}` : `${name} ${sources}`;
  }).join("; ");
}

/**
 * The account service the PC's own pages sign in to: OVIS_ACCOUNT_SERVICE_URL's origin when it is
 * https, account.ovis.sh when it is unset, and none when it is `off` or not https.
 */
export function accountServiceOrigin(value = process.env["OVIS_ACCOUNT_SERVICE_URL"] ?? DEFAULT_ACCOUNT_SERVICE): string | null {
  if (!value || accountServiceOff(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /^[a-z0-9.-]+(?::[0-9]+)?$/i.test(url.host) ? url.origin : null;
  } catch { return null; }
}

/**
 * An HTML page drawn as a page (the report or chart an agent wrote): its own script runs, but in
 * a sandbox without `allow-same-origin`, so it has no origin, no cookie and no storage of this
 * app's, and with no `connect-src` it cannot fetch, open a socket or beacon anything, here or
 * anywhere. Only this app may frame it.
 * What it takes from its own folder (a screenshot beside the report, its stylesheet and script)
 * is put into the page before it is sent (`pageWithLocalFiles`), so it still asks for nothing.
 * The one exception is a video or sound too large to put into it, which plays from
 * `mediaSource` (`PAGE_MEDIA_PATH`): that path answers only the addresses this render gave out,
 * and only to the client that rendered it.
 * The hosted shell's render host (`/s/<id>/~render`, scripts/shell-build.ts) carries this same
 * policy with no media source, as its Pages `_headers`; no hash or nonce is ever added to it,
 * since a hash in `script-src` would make browsers ignore `'unsafe-inline'` and block the page's
 * own inline scripts.
 */
export const pagePolicy = (mediaSource: string | null): string => [
  "sandbox allow-scripts",
  "default-src 'none'",
  // nothing from the web either: the page holds its own folder's files (below), and a script that
  // could reach any https URL could send them there
  "script-src 'unsafe-inline' 'unsafe-eval' data:",
  "style-src 'unsafe-inline' data:",
  "img-src data: blob:",
  mediaSource === null ? "media-src data: blob:" : `media-src data: blob: ${mediaSource}`,
  "font-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");
