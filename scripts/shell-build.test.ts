import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pagePolicy } from "../server/file-view.ts";
import { CONTENT_SECURITY_POLICY, IMMUTABLE_CACHE, REVALIDATE, shellContentSecurityPolicy } from "../server/static.ts";
import { RENDER_PATH, SHELL_META, shellFiles, shellHeaders, shellIndexHtml, shellManifest, shellRedirects } from "./shell-build.ts";

const root = join(import.meta.dir, "..");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const manifest = readFileSync(join(root, "public", "manifest.webmanifest"), "utf8");

/** The `_headers` blocks: each path with its header lines, as Pages reads them. */
function headerBlocks(text: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  let path: string | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) { path = null; continue; }
    if (!line.startsWith(" ")) { path = line; blocks.set(path, []); continue; }
    if (path === null) throw new Error(`header line outside a block: ${line}`);
    blocks.get(path)!.push(line.trim());
  }
  return blocks;
}

describe("the shell's page", () => {
  it("renders exactly one parent message through document.open/write/close", () => {
    const html = shellFiles(manifest)["render.html"] ?? "";
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
    expect(script).toBeDefined();
    const listeners = new Set<(event: unknown) => void>();
    const parent = { postMessage() {} };
    const calls: string[] = [];
    const document = { open: () => calls.push("open"), write: (html: string) => calls.push(html), close: () => calls.push("close") };
    new Function("parent", "document", "addEventListener", "removeEventListener", script ?? "")(parent, document,
      (_type: string, listener: (event: unknown) => void) => listeners.add(listener),
      (_type: string, listener: (event: unknown) => void) => listeners.delete(listener));
    const fire = (source: unknown, data: unknown) => { for (const listener of listeners) listener({ source, data }); };
    fire({}, { type: "ovis-render", html: "foreign" });
    fire(parent, { type: "ovis-render", html: 1 });
    expect(calls).toEqual([]);
    fire(parent, { type: "ovis-render", html: "<body>owned</body>" });
    fire(parent, { type: "ovis-render", html: "second" });
    expect(calls).toEqual(["open", "<body>owned</body>", "close"]);
    expect(listeners.size).toBe(0);
  });

  it("carries the shell meta, which the app's page does not", () => {
    const html = shellIndexHtml(indexHtml);
    expect(html).toContain(SHELL_META);
    expect(indexHtml).not.toContain('name="ovis-shell"');
    expect(html.indexOf(SHELL_META)).toBeLessThan(html.indexOf("</head>"));
  });

  it("links its manifest relative to the page, so a PC's scope installs its own", () => {
    const html = shellIndexHtml(indexHtml);
    expect(html).toMatch(/<link rel="manifest" href="manifest\.webmanifest\?v=\d+" crossorigin="use-credentials" \/>/);
    expect(html).not.toContain('href="/manifest.webmanifest');
    expect(() => shellIndexHtml("<html><head></head></html>")).toThrow(/manifest/);
  });

  it("changes nothing else in the page", () => {
    const html = shellIndexHtml(indexHtml).replace(`  ${SHELL_META}\n  `, "").replace('href="manifest.webmanifest', 'href="/manifest.webmanifest');
    expect(html).toBe(indexHtml);
  });
});

describe("the shell's manifest", () => {
  it("is the app's with a relative id, start and scope", () => {
    const original = JSON.parse(manifest) as Record<string, unknown>;
    const hosted = JSON.parse(shellManifest(manifest)) as Record<string, unknown>;
    expect(hosted).toEqual({ ...original, id: "./", start_url: "./", scope: "./" });
    expect(new URL(hosted["scope"] as string, "https://app.example/s/0123/manifest.webmanifest").pathname).toBe("/s/0123/");
    expect(new URL(hosted["id"] as string, "https://app.example/manifest.webmanifest").pathname).toBe("/");
  });
});

describe("the shell's redirects", () => {
  it("rewrite a PC's scope to the shell, its manifest and its worker, the files before the catch-all", () => {
    const rules = shellRedirects().split("\n").filter((line) => line !== "" && !line.startsWith("#")).map((line) => line.split(" "));
    expect(rules).toEqual([
      ["/s/:id", "/s/:id/", "301"],
      ["/s/:id/manifest.webmanifest", "/manifest.webmanifest", "200"],
      ["/s/:id/sw.js", "/sw.js", "200"],
      [RENDER_PATH, "/render.html", "200"],
      ["/s/*", "/index.html", "200"],
    ]);
  });
});

describe("the shell's headers", () => {
  const blocks = headerBlocks(shellHeaders());

  it("send the policy derived from the app's on every path", () => {
    expect(blocks.get("/*")).toEqual([`Content-Security-Policy: ${shellContentSecurityPolicy()}`]);
    expect(shellContentSecurityPolicy()).not.toBe(CONTENT_SECURITY_POLICY);
  });

  it("give the render host the page policy alone, detaching the shell's first", () => {
    expect(blocks.get(RENDER_PATH)).toEqual(["! Content-Security-Policy", `Content-Security-Policy: ${pagePolicy(null)}`]);
    expect(pagePolicy(null)).not.toMatch(/'nonce-|'sha(?:256|384|512)-/);
    expect(pagePolicy(null)).toContain("sandbox allow-scripts");
  });

  it("cache hashed assets for good and revalidate the shell, the worker and the manifest, under a scope too", () => {
    expect(blocks.get("/assets/*")).toEqual([`Cache-Control: ${IMMUTABLE_CACHE}`]);
    for (const path of ["/", "/index.html", "/sw.js", "/manifest.webmanifest", "/s/*"]) expect(blocks.get(path)).toEqual([`Cache-Control: ${REVALIDATE}`]);
  });

  it("keep every line under Pages' limit", () => {
    for (const line of shellHeaders().split("\n")) expect(line.length).toBeLessThanOrEqual(2000);
  });
});
