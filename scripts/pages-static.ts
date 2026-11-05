/**
 * Serves a Cloudflare Pages output directory (dist-shell/) the way Pages does, for a browser run
 * on this PC: `_redirects` is read in file order, the first matching rule wins, a 200 rewrites
 * the path and any other status redirects; `_headers` rules are applied in order, each matching
 * rule's `! Name` lines removing a header and its `Name: value` lines setting it (a header two
 * rules set is joined with a comma, as Pages joins it). Paths match as Pages matches them: one
 * `*` splat for anything, `:name` for one path segment. Nothing here is the deployed host; it is
 * the closest thing to it that runs in a test.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";

export interface RedirectRule { from: RegExp; to: string; status: number }
export interface HeaderRule { path: RegExp; set: [string, string][]; unset: string[] }

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8",
  ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
};

const escape = (text: string): string => text.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

/** A Pages path pattern as a regular expression: `*` is a greedy splat, `:name` one segment. */
export function pathPattern(rule: string): RegExp {
  const splat = rule.split("*").map(escape).join("(?<splat>.*)");
  return new RegExp(`^${splat.replace(/:([A-Za-z]\w*)/g, (_, name: string) => `(?<${name}>[^/]+)`)}$`);
}

export function parseRedirects(text: string): RedirectRule[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#")).map((line) => {
    const [from, to, status] = line.split(/\s+/);
    if (!from || !to) throw new Error(`_redirects: not a rule: ${line}`);
    return { from: pathPattern(from), to, status: status === undefined ? 302 : Number(status) };
  });
}

export function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) { rules.push({ path: pathPattern(raw.trim()), set: [], unset: [] }); continue; }
    const rule = rules.at(-1);
    if (!rule) throw new Error(`_headers: a header line before any path: ${raw}`);
    const line = raw.trim();
    if (line.startsWith("!")) { rule.unset.push(line.slice(1).trim()); continue; }
    const colon = line.indexOf(":");
    if (colon === -1) throw new Error(`_headers: not a header: ${raw}`);
    rule.set.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return rules;
}

/** The matched placeholders and splat put into a rule's target. */
function fill(target: string, groups: Record<string, string> | undefined): string {
  let out = target;
  for (const [name, value] of Object.entries(groups ?? {})) out = out.replaceAll(`:${name}`, value);
  return out;
}

/** The first redirect rule `pathname` matches: where to, and whether to rewrite (200) or redirect. */
export function redirectFor(rules: RedirectRule[], pathname: string): { to: string; status: number } | null {
  for (const rule of rules) {
    const match = rule.from.exec(pathname);
    if (match) return { to: fill(rule.to, match.groups), status: rule.status };
  }
  return null;
}

/** `headers` after every rule `pathname` matches, in order: unset first, then set (joined when set twice). */
export function applyHeaders(rules: HeaderRule[], pathname: string, headers: Headers): Headers {
  const setByRules = new Set<string>();
  for (const rule of rules) {
    const match = rule.path.exec(pathname);
    if (!match) continue;
    for (const name of rule.unset) headers.delete(name);
    for (const [name, value] of rule.set) {
      const filled = fill(value, match.groups);
      if (setByRules.has(name.toLowerCase())) headers.append(name, filled);
      else { headers.set(name, filled); setByRules.add(name.toLowerCase()); }
    }
  }
  return headers;
}

export interface PagesSite {
  dir: string;
  redirects: RedirectRule[];
  headers: HeaderRule[];
}

export function loadPagesSite(dir: string): PagesSite {
  const read = (name: string): string => existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "";
  return { dir, redirects: parseRedirects(read("_redirects")), headers: parseHeaders(read("_headers")) };
}

/** The response Pages would give `request` from `site`: redirects and rewrites, then the file, then the headers. */
export async function pagesResponse(site: PagesSite, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const requested = url.pathname;
  const redirect = redirectFor(site.redirects, requested);
  if (redirect !== null && redirect.status !== 200) {
    return new Response(null, { status: redirect.status, headers: { location: redirect.to + url.search } });
  }
  const served = redirect === null ? requested : redirect.to;
  let response: Response;
  if (served === "/_headers" || served === "/_redirects") response = new Response("Not found", { status: 404 });
  else {
    const relative = normalize(decodeURIComponent(served)).replace(/^(\.\.[/\\])+/, "");
    let path = join(site.dir, relative);
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    if (!path.startsWith(site.dir) || !existsSync(path) || statSync(path).isDirectory()) response = new Response("Not found", { status: 404 });
    else {
      const dot = path.lastIndexOf(".");
      response = new Response(Bun.file(path), { headers: { "content-type": MIME[path.slice(dot)] ?? "application/octet-stream" } });
    }
  }
  applyHeaders(site.headers, requested, response.headers);
  return response;
}

/** The site on loopback; `port` 0 picks a free one. `seen` is told every request that reaches the host, as the host itself would log it. */
export function servePagesSite(dir: string, port = 0, hostname = "127.0.0.1", seen?: (request: Request) => void): ReturnType<typeof Bun.serve> {
  const site = loadPagesSite(dir);
  return Bun.serve({ hostname, port, fetch: (request) => { seen?.(request); return pagesResponse(site, request); } });
}

if (import.meta.main) {
  const dir = process.argv[2] ?? join(import.meta.dir, "..", "dist-shell");
  const server = servePagesSite(dir, Number(process.argv[3] ?? 0));
  console.log(`serving ${dir} at ${server.url.href}`);
}
