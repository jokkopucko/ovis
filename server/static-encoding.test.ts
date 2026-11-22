import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from "node:zlib";
import { compressResponse } from "./compress.ts";

/** a WebAssembly module's magic and version, then zeros: what the terminal's libghostty-vt module starts with */
const WASM = Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), Buffer.alloc(4096)]);

async function fixture(check: (serve: (path: string, encoding?: string | null) => Promise<Response>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "herdr-static-encoding-"));
  mkdirSync(join(root, "server")); mkdirSync(join(root, "shared")); mkdirSync(join(root, "dist", "assets"), { recursive: true });
  const body = 'console.log("synthetic static file");\n';
  for (const file of ["static.ts", "entries.ts"]) writeFileSync(join(root, "server", file), readFileSync(join(import.meta.dir, file)));
  writeFileSync(join(root, "shared", "web-policy.ts"), readFileSync(join(import.meta.dir, "..", "shared", "web-policy.ts")));
  writeFileSync(join(root, "dist", "index.html"), "<html>fixture shell</html>");
  writeFileSync(join(root, "dist", "sw.js"), body);
  writeFileSync(join(root, "dist", "assets", "legacy.js"), body);
  writeFileSync(join(root, "dist", "assets", "large.js"), body.repeat(100));
  writeFileSync(join(root, "dist", "assets", "large.js.gz"), gzipSync(body.repeat(100)));
  for (const [name, value] of [["app-hash.js", body], ["style-hash.css", "body { display: block; }"]]) {
    const path = join(root, "dist", "assets", name!);
    writeFileSync(path, value!); writeFileSync(path + ".gz", gzipSync(value!)); writeFileSync(path + ".br", brotliCompressSync(value!));
  }
  const wasm = join(root, "dist", "assets", "module-hash.wasm");
  writeFileSync(wasm, WASM); writeFileSync(wasm + ".gz", gzipSync(WASM)); writeFileSync(wasm + ".br", brotliCompressSync(WASM));
  const gzipOnly = join(root, "dist", "assets", "gzip-only.js");
  writeFileSync(gzipOnly, body);
  writeFileSync(`${gzipOnly}.gz`, gzipSync(body));
  const exported = process.env["OVIS_ASSETS"];
  delete process.env["OVIS_ASSETS"];
  try { await check((await import(join(root, "server", "static.ts"))).serveStatic); }
  finally {
    if (exported !== undefined) process.env["OVIS_ASSETS"] = exported;
    rmSync(root, { recursive: true, force: true });
  }
}

test("serves compressed immutable scripts with original MIME and encoding-specific bytes", () => fixture(async serve => {
  const gzip = await serve("/assets/app-hash.js", "gzip");
  expect(gzip.headers.get("content-encoding")).toBe("gzip");
  expect(gzip.headers.get("vary")).toBe("Accept-Encoding");
  expect(gzip.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(gzip.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(gzip.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(gunzipSync(await gzip.arrayBuffer()).toString()).toBe('console.log("synthetic static file");\n');
  const br = await serve("/assets/style-hash.css", "br, gzip");
  expect(br.headers.get("content-encoding")).toBe("br");
  expect(br.headers.get("content-type")).toBe("text/css; charset=utf-8");
  expect(br.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(brotliDecompressSync(await br.arrayBuffer()).toString()).toBe("body { display: block; }");
}));

test("serves the terminal's WebAssembly module compressed, as application/wasm", () => fixture(async serve => {
  const br = await serve("/assets/module-hash.wasm", "br, gzip");
  expect(br.headers.get("content-encoding")).toBe("br");
  expect(br.headers.get("content-type")).toBe("application/wasm");
  expect(br.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(brotliDecompressSync(await br.arrayBuffer())).toEqual(WASM);
  const gzip = await serve("/assets/module-hash.wasm", "gzip");
  expect(gzip.headers.get("content-encoding")).toBe("gzip");
  expect(gunzipSync(await gzip.arrayBuffer())).toEqual(WASM);
  const plain = await serve("/assets/module-hash.wasm", null);
  expect(plain.headers.get("content-encoding")).toBeNull();
  expect(plain.headers.get("content-type")).toBe("application/wasm");
}));

test("honors encoding preferences, explicit exclusions, wildcards and identity fallback", () => fixture(async serve => {
  for (const [header, wanted] of [["br;q=0, gzip;q=1", "gzip"], ["gzip;q=0.8, br;q=0.4", "gzip"], ["gzip;q=0, br;q=0", null], ["*;q=1, br;q=0", "gzip"], ["identity;q=1, gzip;q=0.5", null], ["", null], [null, null]] as const) {
    const response = await serve("/assets/app-hash.js", header);
    expect(response.headers.get("content-encoding")).toBe(wanted);
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
  }
  // x-gzip is gzip under its older name: accepted as gzip, and excluded with it
  expect((await serve("/assets/app-hash.js", "x-gzip, identity;q=0")).headers.get("content-encoding")).toBe("gzip");
  expect((await serve("/assets/app-hash.js", "*;q=1, x-gzip;q=0, br;q=0, identity;q=0")).status).toBe(406);
  const rejected = await serve("/assets/app-hash.js", "*;q=0, identity;q=0");
  expect(rejected.status).toBe(406);
  expect(rejected.headers.get("content-security-policy")).toContain("script-src 'self'");
}));

test("old builds without sidecars still work and shell/service worker retain revalidation", () => fixture(async serve => {
  const legacy = await serve("/assets/legacy.js", "br, gzip");
  expect(legacy.status).toBe(200);
  expect(legacy.headers.get("content-encoding")).toBeNull();
  expect(await legacy.text()).toBe('console.log("synthetic static file");\n');
  expect((await serve("/assets/legacy.js", "identity;q=0, br, gzip")).status).toBe(406);
  const shell = await serve("/", "br");
  expect(shell.headers.get("content-encoding")).toBeNull();
  expect(shell.headers.get("cache-control")).toBe("no-cache");
  const sw = await serve("/sw.js", "gzip");
  expect(sw.headers.get("content-encoding")).toBeNull();
  expect(sw.headers.get("cache-control")).toBe("no-cache");
}));

test("uses an available sidecar when the preferred representation is absent", () => fixture(async serve => {
  const fallback = await serve("/assets/gzip-only.js", "br, gzip");
  expect(fallback.headers.get("content-encoding")).toBe("gzip");
  expect(gunzipSync(await fallback.arrayBuffer()).toString()).toBe('console.log("synthetic static file");\n');
  expect((await serve("/assets/gzip-only.js", "br, gzip;q=0, identity;q=0")).status).toBe(406);
}));

test("the production gzip wrapper preserves the representation already negotiated by static", () => fixture(async serve => {
  const request = new Request("http://127.0.0.1/assets/large.js", { headers: { "accept-encoding": "identity;q=1, gzip;q=0.5" } });
  const direct = await serve("/assets/large.js", request.headers.get("accept-encoding"));
  const wrapped = await compressResponse(request, direct);
  expect(wrapped?.headers.get("content-encoding")).toBeNull();
  expect(await wrapped?.text()).toBe('console.log("synthetic static file");\n'.repeat(100));
  const gzipRequest = new Request(request.url, { headers: { "accept-encoding": "gzip" } });
  const gzip = await compressResponse(gzipRequest, await serve("/assets/large.js", "gzip"));
  expect(gzip?.headers.get("content-encoding")).toBe("gzip");
}));

test("answers a file the build does not have with a 404, and any other path with the shell", () => fixture(async serve => {
  // a tab of the build before an update asks for its own chunk: the shell under a script's URL
  // fails as a module anyway, and a service worker would keep it there
  for (const path of ["/assets/katex-old.js", "/assets/nested/", "/assets/", "/icons/icon-512-old.png"]) {
    const missing = await serve(path, "gzip");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toBeNull();
    expect(missing.headers.get("cache-control")).toBe("no-cache");
    expect(await missing.text()).toBe("");
  }
  for (const path of ["/", "/settings", "/assetsx/thing.js"]) {
    const shell = await serve(path);
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await shell.text()).toBe("<html>fixture shell</html>");
  }
}));
