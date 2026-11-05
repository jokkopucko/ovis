// Cloudflare Pages advanced-mode Worker (https://developers.cloudflare.com/pages/functions/advanced-mode/).
// _routes.json sends only /demo and /demo/* here; every other path is served as before, _redirects
// and _headers included. The browser demo is built with the app into GitHub Pages (site/,
// https://herdrweb.dev/demo/); fetching it from here keeps the address a visitor sees at ovis.sh,
// where a 302 used to show them herdrweb.dev. The demo is built with relative asset paths, so it
// runs unchanged under this origin.
const DEMO_ORIGIN = "https://herdrweb.dev";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/demo" && !url.pathname.startsWith("/demo/")) return env.ASSETS.fetch(request);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    if (url.pathname === "/demo") return Response.redirect(`${url.origin}/demo/${url.search}`, 301);
    const upstream = await fetch(`${DEMO_ORIGIN}${url.pathname}${url.search}`, {
      method: request.method,
      headers: { accept: request.headers.get("accept") ?? "*/*", "accept-encoding": request.headers.get("accept-encoding") ?? "identity" },
      redirect: "manual",
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      // keep a redirect inside this origin (GitHub Pages adds the trailing slash itself)
      const location = upstream.headers.get("location");
      const target = location ? new URL(location, `${DEMO_ORIGIN}${url.pathname}`) : null;
      if (target && target.origin === DEMO_ORIGIN && target.pathname.startsWith("/demo")) return Response.redirect(`${url.origin}${target.pathname}${target.search}`, upstream.status);
      return new Response("Not Found", { status: 404 });
    }
    const headers = new Headers();
    for (const name of ["content-type", "content-length", "cache-control", "etag", "last-modified", "vary", "content-encoding"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("x-robots-tag", "noindex");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
