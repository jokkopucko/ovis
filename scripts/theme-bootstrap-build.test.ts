import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { serviceWorkerBuild } from "./service-worker-build.ts";
import { bootstrapFileName, bootstrapUrl, bundleThemeBootstrap, injectBootstrap, themeBootstrapBuild } from "./theme-bootstrap-build.ts";

const PAGE = `<!doctype html>
<html>
  <head>
    <meta name="theme-color" content="#1f1f1f" />
    <title>Ovis</title>
  </head>
  <body><div id="root"></div><script type="module" src="/main.ts"></script></body>
</html>
`;

const UNTITLED_PAGE = '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.ts"></script></body></html>';

async function buildFixture(base: string, page: string = PAGE): Promise<{ html: string; files: string[]; worker: string; boot: string }> {
  const root = mkdtempSync(join(tmpdir(), "herdr-theme-boot-build-"));
  try {
    writeFileSync(join(root, "index.html"), page);
    writeFileSync(join(root, "main.ts"), "document.body.dataset['app'] = 'on';\nimport './main.css';\n");
    writeFileSync(join(root, "main.css"), "body { margin: 0; }\n");
    mkdirSync(join(root, "public"));
    writeFileSync(join(root, "public", "sw.js"), 'const BUILD = "";\nconst BUILD_FILES = null;\n');
    const out = join(root, "dist");
    await build({ root, base, configFile: false, logLevel: "silent", plugins: [themeBootstrapBuild(), serviceWorkerBuild()], build: { outDir: out, emptyOutDir: true } });
    const files = readdirSync(join(out, "assets")).map((name) => `assets/${name}`);
    const boot = files.find((name) => name.startsWith("assets/theme-bootstrap-")) ?? "";
    return { html: readFileSync(join(out, "index.html"), "utf8"), files, worker: readFileSync(join(out, "sw.js"), "utf8"), boot: boot && readFileSync(join(out, boot), "utf8") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("theme boot script build", () => {
  test("its address follows the base: under it at the root, relative for the demo", () => {
    const file = "assets/theme-bootstrap-0123456789.js";
    expect(bootstrapUrl("/", file)).toBe("/assets/theme-bootstrap-0123456789.js");
    expect(bootstrapUrl("/herdr-web-ui/demo/app/", file)).toBe("/herdr-web-ui/demo/app/assets/theme-bootstrap-0123456789.js");
    expect(bootstrapUrl("/sub", file)).toBe("/sub/assets/theme-bootstrap-0123456789.js");
    expect(bootstrapUrl("./", file)).toBe("./assets/theme-bootstrap-0123456789.js");
    expect(bootstrapUrl("", file)).toBe("./assets/theme-bootstrap-0123456789.js");
  });

  test("it is one classic blocking script after the title, ahead of styles and modules", () => {
    const page = '<head><meta name="theme-color" content="#000"><title>Ovis</title>\n<script type="module" src="/a.js"></script><link rel="stylesheet" href="/a.css"></head>';
    const html = injectBootstrap(page, "/assets/theme-bootstrap-0123456789.js");
    const tag = '<script src="/assets/theme-bootstrap-0123456789.js"></script>';
    expect(html).toContain(`</title>\n    ${tag}`);
    expect(html.indexOf(tag)).toBeGreaterThan(html.indexOf('name="theme-color"'));
    expect(html.indexOf(tag)).toBeLessThan(html.indexOf('rel="stylesheet"'));
    expect(html.indexOf(tag)).toBeLessThan(html.indexOf('type="module"'));
    expect(() => injectBootstrap("<head><title>a</title><title>b</title></head>", "/x.js")).toThrow("exactly one </title>");
    expect(() => injectBootstrap("<head></head><body><title>a</title></body>", "/x.js")).toThrow("exactly one </title>");
  });

  test("a page with no title, like a browser script's fixture, is left as it is", () => {
    expect(injectBootstrap("<head></head>", "/x.js")).toBe("<head></head>");
    expect(injectBootstrap(UNTITLED_PAGE, "/x.js")).toBe(UNTITLED_PAGE);
  });

  test("the app's own page gets it", () => {
    const html = injectBootstrap(readFileSync(join(import.meta.dir, "..", "index.html"), "utf8"), "/x.js");
    expect(html).toContain('</title>\n    <script src="/x.js"></script>');
  });

  test("its file name changes with its contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-theme-boot-hash-"));
    try {
      writeFileSync(join(dir, "a.ts"), "document.documentElement.dataset['theme'] = 'dark';\n");
      writeFileSync(join(dir, "b.ts"), "document.documentElement.dataset['theme'] = 'light';\n");
      const [a, b, again] = await Promise.all([bundleThemeBootstrap(join(dir, "a.ts")), bundleThemeBootstrap(join(dir, "b.ts")), bundleThemeBootstrap(join(dir, "a.ts"))]);
      expect(bootstrapFileName(a)).toMatch(/^assets\/theme-bootstrap-[0-9a-f]{10}\.js$/);
      expect(bootstrapFileName(a)).not.toBe(bootstrapFileName(b));
      expect(bootstrapFileName(again)).toBe(bootstrapFileName(a));
      expect(a).not.toMatch(/^\s*(import|export)\b/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [base, prefix] of [["/", "/"], ["./", "./"]] as const) {
    test(`a build at base ${base} emits it, puts it first in the head and lists it for the service worker`, async () => {
      const { html, files, worker, boot } = await buildFixture(base);
      const file = files.find((name) => /^assets\/theme-bootstrap-[0-9a-f]{10}\.js$/.test(name));
      expect(file).toBeDefined();
      expect(file).toBe(bootstrapFileName(boot));
      const tag = `<script src="${prefix}${file}"></script>`;
      expect(html).toContain(tag);
      const head = html.slice(0, html.indexOf("</head>"));
      expect(head).toContain(tag);
      for (const later of ['rel="stylesheet"', 'type="module"']) {
        expect(head).toContain(later);
        expect(head.indexOf(tag)).toBeLessThan(head.indexOf(later));
      }
      expect(boot).toContain("localStorage");
      expect(worker).toContain(`"/${file}"`);
      expect(worker).toMatch(/^const BUILD = "[0-9a-f]{12}";$/m);
    }, 60_000);
  }

  test("a build of a page with no title succeeds and leaves the page without it", async () => {
    const { html } = await buildFixture("/", UNTITLED_PAGE);
    expect(html).not.toContain("theme-bootstrap-");
    expect(html).toContain('type="module"');
  }, 60_000);
});
