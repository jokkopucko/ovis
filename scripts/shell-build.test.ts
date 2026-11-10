import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pagePolicy } from "../server/file-view.ts";
import { CONTENT_SECURITY_POLICY, IMMUTABLE_CACHE, REVALIDATE, shellContentSecurityPolicy } from "../server/static.ts";
import { REGIONAL_APPS } from "../shared/relay-regions.ts";
import { injectBootstrap } from "./theme-bootstrap-build.ts";
import { ANDROID_APP_FINGERPRINTS, APP_ID, IOS_APP_ID, RENDER_PATH, SHELL_META, shellCaddyfile, shellFiles, shellHeaders, shellIndexHtml, shellManifest, shellRedirects } from "./shell-build.ts";

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
  /** the render host's own script, run against a stand-in for its page: what it wrote, and the frames it put in its body */
  const renderHost = () => {
    const html = shellFiles(manifest)["render.html"] ?? "";
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
    expect(script).toBeDefined();
    const listeners = new Set<(event: unknown) => void>();
    const parent = { postMessage() {} };
    const calls: string[] = [], frames: Array<{ sandbox: string | null; srcdoc: string }> = [];
    const document = {
      open: () => calls.push("open"), write: (html: string) => calls.push(html), close: () => calls.push("close"),
      createElement: (tag: string) => { const attrs = new Map<string, string>(); return { tag, srcdoc: "", style: { cssText: "" }, setAttribute: (name: string, value: string) => { attrs.set(name, value); }, attrs }; },
      body: { replaceChildren: (node: { tag: string; srcdoc: string; attrs: Map<string, string> }) => { calls.push(`frame:${node.tag}`); frames.push({ sandbox: node.attrs.get("sandbox") ?? null, srcdoc: node.srcdoc }); } },
    };
    new Function("parent", "document", "addEventListener", "removeEventListener", script ?? "")(parent, document,
      (_type: string, listener: (event: unknown) => void) => listeners.add(listener),
      (_type: string, listener: (event: unknown) => void) => listeners.delete(listener));
    const fire = (source: unknown, data: unknown) => { for (const listener of listeners) listener({ source, data }); };
    return { parent, calls, frames, listeners, fire };
  };

  it("renders exactly one parent message through document.open/write/close, when the person asked for the page's scripts", () => {
    const { parent, calls, frames, listeners, fire } = renderHost();
    fire({}, { type: "ovis-render", html: "foreign", scripts: true });
    fire(parent, { type: "ovis-render", html: 1, scripts: true });
    expect(calls).toEqual([]);
    fire(parent, { type: "ovis-render", html: "<body>owned</body>", scripts: true });
    fire(parent, { type: "ovis-render", html: "second", scripts: true });
    expect(calls).toEqual(["open", "<body>owned</body>", "close"]);
    expect(frames).toEqual([]);
    expect(listeners.size).toBe(0);
  });

  it("draws a page whose scripts were not asked for in a frame of its own that runs none, and never writes it into its own document", () => {
    // anything but `scripts: true` is a page without its scripts: a message that says nothing about them too
    for (const scripts of [false, undefined, "true", 1]) {
      const { parent, calls, frames, listeners, fire } = renderHost();
      fire({}, { type: "ovis-render", html: "foreign", scripts });
      expect(calls).toEqual([]);
      fire(parent, { type: "ovis-render", html: "<body><script>run()</script>owned</body>", ...(scripts === undefined ? {} : { scripts }) });
      fire(parent, { type: "ovis-render", html: "second", scripts: true });
      expect(calls).toEqual(["frame:iframe"]);
      expect(frames).toEqual([{ sandbox: "", srcdoc: "<body><script>run()</script>owned</body>" }]);
      expect(listeners.size).toBe(0);
    }
  });

  it("carries the shell meta, which the app's page does not", () => {
    const html = shellIndexHtml(indexHtml);
    expect(html).toContain(SHELL_META);
    expect(indexHtml).not.toContain('name="ovis-shell"');
    expect(html.indexOf(SHELL_META)).toBeLessThan(html.indexOf("</head>"));
    // the blocking theme boot script reads the mode where it stands, whichever plugin writes first
    const script = '<script src="/boot.js">';
    for (const page of [injectBootstrap(html, "/boot.js"), shellIndexHtml(injectBootstrap(indexHtml, "/boot.js"))]) {
      expect(page.indexOf(SHELL_META)).toBeGreaterThan(-1);
      expect(page.indexOf(SHELL_META)).toBeLessThan(page.indexOf(script));
    }
  });

  it("links its manifest relative to the page, so a PC's scope installs its own", () => {
    const html = shellIndexHtml(indexHtml);
    expect(html).toMatch(/<link rel="manifest" href="manifest\.webmanifest\?v=\d+" crossorigin="use-credentials" \/>/);
    expect(html).not.toContain('href="/manifest.webmanifest');
    expect(() => shellIndexHtml("<html><head></head></html>")).toThrow(/manifest/);
  });

  it("names account.ovis.sh unless the build names another https service or none", () => {
    expect(shellIndexHtml(indexHtml)).toContain('<meta name="ovis-account-service" content="https://account.ovis.sh" />');
    for (const off of ["off", "", "http://account.example"]) expect(shellIndexHtml(indexHtml, { OVIS_ACCOUNT_SERVICE_URL: off })).not.toContain("ovis-account");
    const github = shellIndexHtml(indexHtml, { OVIS_ACCOUNT_SERVICE_URL: "https://account.example/v1/" });
    expect(github).toContain('<meta name="ovis-account-service" content="https://account.example" />');
    expect(github).not.toContain("ovis-account-providers");
    const both = shellIndexHtml(indexHtml, { OVIS_ACCOUNT_SERVICE_URL: "https://account.example", OVIS_ACCOUNT_PROVIDERS: "github, apple, \"><script>" });
    expect(both).toContain('<meta name="ovis-account-providers" content="github,apple" />');
    expect(both.indexOf("ovis-account-providers")).toBeLessThan(both.indexOf("</head>"));
  });

  it("changes nothing else in the page", () => {
    const html = shellIndexHtml(indexHtml, { OVIS_ACCOUNT_SERVICE_URL: "off" }).replace(`  ${SHELL_META}\n  `, "").replace('href="manifest.webmanifest', 'href="/manifest.webmanifest');
    expect(html).toBe(indexHtml);
  });
});

describe("the shell's app links", () => {
  const files = shellFiles(manifest);

  it("let the Android app open a PC's pages, signed with Play's key or the upload key", () => {
    expect(JSON.parse(files[".well-known/assetlinks.json"] ?? "null")).toEqual([{
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: APP_ID, sha256_cert_fingerprints: ANDROID_APP_FINGERPRINTS },
    }]);
    expect(APP_ID).toBe(JSON.parse(readFileSync(join(root, "app", "capacitor.config.json"), "utf8")).appId);
    for (const fingerprint of ANDROID_APP_FINGERPRINTS) expect(fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it("name the same app and only a PC's pages for iOS", () => {
    expect(JSON.parse(files[".well-known/apple-app-site-association"] ?? "null")).toEqual({
      applinks: { details: [{ appIDs: [IOS_APP_ID], components: [{ "/": "/s/*" }] }] },
    });
    expect(IOS_APP_ID).toBe(`5987KT43TJ.${APP_ID}`);
  });

  it("are sent as JSON, which iOS asks of a file with no extension", () => {
    expect(headerBlocks(shellHeaders()).get("/.well-known/*")).toEqual(["Content-Type: application/json"]);
  });

  it("match the Android app's verified link", () => {
    const androidManifest = readFileSync(join(root, "app", "android", "app", "src", "main", "AndroidManifest.xml"), "utf8");
    expect(androidManifest).toMatch(/<intent-filter android:autoVerify="true">[^]*?<data android:scheme="https" android:host="app\.ovis\.sh" android:pathPrefix="\/s\/" \/>[^]*?<\/intent-filter>/);
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
    expect(blocks.get("/*")).toEqual([`Content-Security-Policy: ${shellContentSecurityPolicy(Object.values(REGIONAL_APPS))}`]);
    expect(shellContentSecurityPolicy(Object.values(REGIONAL_APPS))).not.toBe(CONTENT_SECURITY_POLICY);
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

describe("the shell's Caddy site", () => {
  it("sends the policies and caching the Pages headers send", () => {
    const site = shellCaddyfile("app-ap.ovis.sh");
    expect(site).toContain(`header @notrender Content-Security-Policy "${shellContentSecurityPolicy(Object.values(REGIONAL_APPS))}"`);
    expect(site).toContain(`header @render Content-Security-Policy "${pagePolicy(null)}"`);
    expect(site).toContain(`header /assets/* Cache-Control "${IMMUTABLE_CACHE}"`);
    expect(site).toContain(`Cache-Control "${REVALIDATE}"`);
    for (const value of [shellContentSecurityPolicy(Object.values(REGIONAL_APPS)), pagePolicy(null)]) expect(value).not.toContain('"');
  });

  it("refuses a site or folder that would break out of the file", () => {
    expect(() => shellCaddyfile("app-ap.ovis.sh {\n}")).toThrow();
    expect(() => shellCaddyfile("app-ap.ovis.sh", "/opt/x }")).toThrow();
  });
});
