import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pagePolicy } from "../server/file-view.ts";
import { shellContentSecurityPolicy } from "../server/static.ts";
import { applyHeaders, loadPagesSite, pagesResponse, parseHeaders, parseRedirects, pathPattern, redirectFor } from "./pages-static.ts";
import { shellHeaders, shellRedirects } from "./shell-build.ts";

const ID = "ab".repeat(16);

describe("Pages path patterns", () => {
  it("match a splat greedily and a placeholder for one segment", () => {
    expect(pathPattern("/s/*").test(`/s/${ID}/deep/er`)).toBe(true);
    expect(pathPattern("/s/*").test("/other")).toBe(false);
    expect(pathPattern("/s/:id/sw.js").exec(`/s/${ID}/sw.js`)?.groups).toEqual({ id: ID });
    expect(pathPattern("/s/:id/sw.js").test(`/s/${ID}/x/sw.js`)).toBe(false);
    expect(pathPattern("/s/:id/~render").test(`/s/${ID}/~render`)).toBe(true);
  });
});

describe("the shell's Pages files, as Pages reads them", () => {
  const redirects = parseRedirects(shellRedirects());
  const headers = parseHeaders(shellHeaders());

  it("rewrite a PC's scope to the shell, its manifest, its worker and the render host, and send a slashless scope to its slash", () => {
    expect(redirectFor(redirects, `/s/${ID}/`)).toEqual({ to: "/index.html", status: 200 });
    expect(redirectFor(redirects, `/s/${ID}/anything/else`)).toEqual({ to: "/index.html", status: 200 });
    expect(redirectFor(redirects, `/s/${ID}/manifest.webmanifest`)).toEqual({ to: "/manifest.webmanifest", status: 200 });
    expect(redirectFor(redirects, `/s/${ID}/sw.js`)).toEqual({ to: "/sw.js", status: 200 });
    expect(redirectFor(redirects, `/s/${ID}/~render`)).toEqual({ to: "/render.html", status: 200 });
    expect(redirectFor(redirects, `/s/${ID}`)).toEqual({ to: `/s/${ID}/`, status: 301 });
    expect(redirectFor(redirects, "/")).toBeNull();
    expect(redirectFor(redirects, "/assets/index-abc.js")).toBeNull();
  });

  it("give every page the shell policy and the render host the page policy alone", () => {
    expect(applyHeaders(headers, `/s/${ID}/`, new Headers()).get("content-security-policy")).toBe(shellContentSecurityPolicy());
    expect(applyHeaders(headers, "/", new Headers()).get("content-security-policy")).toBe(shellContentSecurityPolicy());
    expect(applyHeaders(headers, `/s/${ID}/~render`, new Headers()).get("content-security-policy")).toBe(pagePolicy(null));
    expect(applyHeaders(headers, "/assets/index-abc.js", new Headers()).get("cache-control")).toBe("public, max-age=31536000, immutable");
    for (const path of [`/s/${ID}/`, `/s/${ID}/sw.js`, "/sw.js", "/manifest.webmanifest", "/"]) expect(applyHeaders(headers, path, new Headers()).get("cache-control")).toBe("no-cache");
  });

  it("join a header two rules set, as Pages does, which is why the render host detaches first", () => {
    const rules = parseHeaders("/*\n  X-Test: one\n\n/page\n  X-Test: two\n\n/clean\n  ! X-Test\n  X-Test: three\n");
    expect(applyHeaders(rules, "/page", new Headers()).get("x-test")).toBe("one, two");
    expect(applyHeaders(rules, "/clean", new Headers()).get("x-test")).toBe("three");
  });
});

describe("the loopback Pages server", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it("serves the rewritten file under the requested address with that address's headers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pages-static-"));
    dirs.push(dir);
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>shell</title>");
    writeFileSync(join(dir, "sw.js"), "// worker");
    writeFileSync(join(dir, "manifest.webmanifest"), "{}");
    writeFileSync(join(dir, "assets", "a.js"), "1");
    writeFileSync(join(dir, "_redirects"), shellRedirects());
    writeFileSync(join(dir, "_headers"), shellHeaders());
    const site = loadPagesSite(dir);
    const get = (path: string) => pagesResponse(site, new Request(`http://pages.test${path}`));
    const scope = await get(`/s/${ID}/`);
    expect(scope.status).toBe(200);
    expect(await scope.text()).toContain("shell");
    expect(scope.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(scope.headers.get("content-security-policy")).toBe(shellContentSecurityPolicy());
    expect(scope.headers.get("cache-control")).toBe("no-cache");
    const worker = await get(`/s/${ID}/sw.js`);
    expect(await worker.text()).toBe("// worker");
    expect(worker.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const slashless = await get(`/s/${ID}`);
    expect(slashless.status).toBe(301);
    expect(slashless.headers.get("location")).toBe(`/s/${ID}/`);
    expect((await get(`/s/${ID}/~render`)).status).toBe(404);
    expect((await get("/_headers")).status).toBe(404);
    expect((await get("/assets/a.js")).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await get("/assets/missing.js")).status).toBe(404);
  });
});
