/**
 * The theme boot script (src/theme-bootstrap.ts) as the page loads it: one classic, blocking
 * <script src> in <head>, ahead of the stylesheet and the app's modules, so the saved theme is on
 * the document before anything is painted. A module, async or deferred script could run after the
 * first paint, and an inline one is refused by the app's `script-src 'self'`.
 */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

// import.meta.url, not import.meta.dir: Vite bundles its config elsewhere and rewrites only the URL to this file's own
const ENTRY = fileURLToPath(new URL("../src/theme-bootstrap.ts", import.meta.url));
export const DEV_PATH = "@theme-bootstrap.js";

export async function bundleThemeBootstrap(entry: string = ENTRY): Promise<string> {
  const result = await Bun.build({ entrypoints: [entry], target: "browser", format: "iife", minify: true });
  if (!result.success) throw new Error(`the theme boot script did not build:\n${result.logs.map(String).join("\n")}`);
  const [output] = result.outputs;
  if (!output || result.outputs.length !== 1) throw new Error(`the theme boot script built into ${result.outputs.length} files, not one`);
  return output.text();
}

export function bootstrapFileName(source: string): string {
  return `assets/theme-bootstrap-${createHash("sha256").update(source).digest("hex").slice(0, 10)}.js`;
}

export function bootstrapUrl(base: string, file: string): string {
  if (base === "" || base === "./") return `./${file}`;
  return `${base.endsWith("/") ? base : `${base}/`}${file}`;
}

const TITLE_END = "</title>";

/**
 * The page with the script right after its <title>: below the theme-color meta it updates, above
 * the stylesheet and the module scripts Vite adds at the end of <head>.
 */
export function injectBootstrap(html: string, src: string): string {
  const at = html.indexOf(TITLE_END);
  if (at === -1) return html;
  const head = html.indexOf("</head>");
  if (html.indexOf(TITLE_END, at + 1) !== -1 || head === -1 || at > head) throw new Error(`index.html must hold exactly one ${TITLE_END} inside <head>`);
  const end = at + TITLE_END.length;
  return `${html.slice(0, end)}\n    <script src="${src}"></script>${html.slice(end)}`;
}

export function themeBootstrapBuild(entry: string = ENTRY): Plugin {
  let base = "/";
  let command: "build" | "serve" = "build";
  let fileName = "";
  return {
    name: "theme-bootstrap-build",
    configResolved(config) { base = config.base; command = config.command; },
    async buildStart() {
      if (command !== "build") return;
      const source = await bundleThemeBootstrap(entry);
      fileName = bootstrapFileName(source);
      this.emitFile({ type: "asset", fileName, source });
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split("?")[0] !== `${base}${DEV_PATH}`) return next();
        try {
          response.setHeader("content-type", "text/javascript; charset=utf-8");
          response.setHeader("cache-control", "no-store");
          response.end(await bundleThemeBootstrap(entry));
        } catch (error) {
          next(error);
        }
      });
    },
    transformIndexHtml: {
      // after Vite has written its own tags, which leaves a classic script it did not bundle as written
      order: "post",
      handler(html) {
        return injectBootstrap(html, command === "build" ? bootstrapUrl(base, fileName) : `${base}${DEV_PATH}`);
      },
    },
  };
}
