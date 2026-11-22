import { join } from "node:path";

export const DEMO_PREFIX = "/herdr-web-ui/demo/app/";

/**
 * Serves the files of `dir` on 127.0.0.1 at a free port, under `prefix` as the site serves the
 * demo: a path ending in "/" gets its index.html, and a path that does not decode or that would
 * leave `dir` is refused. A script that also needs API stand-ins or other headers keeps its own
 * server (`scripts/conventions.test.ts` lists those).
 */
export function serveDemo(dir: string, { prefix = DEMO_PREFIX }: { prefix?: string } = {}): ReturnType<typeof Bun.serve> {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(dir, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
}
