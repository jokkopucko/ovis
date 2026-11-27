import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions } from "playwright-core";
import { appContext } from "./app-context.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { DEMO_PREFIX, serveDemo } from "./demo-server.ts";

export interface DemoBrowserOptions {
  /** Temporary directory prefix under `os.tmpdir()`. */
  readonly tempPrefix: string;
  /** URL path prefix served by `serveDemo` (default: `DEMO_PREFIX`). */
  readonly prefix?: string;
  /**
   * The script's own server of the built app in `app`, for what `serveDemo` does not do (a header, a path beside the
   * app, an API stand-in). It serves the app under `prefix`, which then only names where `baseUrl` points.
   */
  readonly serve?: (app: string) => ReturnType<typeof Bun.serve>;
  /** Optional HTML/script snippet injected directly before `./demo-transport.js`. */
  readonly beforeTransport?: string;
  /** Optional HTML/script snippet injected directly after `./demo-transport.js`, before the app's own module. */
  readonly afterTransport?: string;
  /** Chromium launch args (default: `["--no-sandbox"]`). */
  readonly args?: string[];
  /** Playwright's own launch args to leave out, such as `--hide-scrollbars` (default: none). */
  readonly ignoreDefaultArgs?: string[];
}

export interface DemoBrowserSession {
  readonly app: string;
  readonly browser: Browser;
  /** A context from the shared factory (`appContext` in scripts/app-context.ts): no service worker, English; `overrides` win. */
  readonly newContext: (overrides?: BrowserContextOptions) => Promise<BrowserContext>;
  readonly origin: string;
  readonly baseUrl: string;
  readonly port: number;
  readonly evidence: string | null;
}

/**
 * Builds the disposable demo app, injects `./demo-transport.js`, serves it over loopback via
 * `serveDemo` (or the script's own `serve`), launches headless Chromium with `chromePath()`, and tears everything down in
 * `finally` (browser, server, temp dir). Creates `UI_EVIDENCE_DIR` when non-empty. A script opens its
 * contexts with the session's `newContext`, so every demo script starts from the same one.
 */
export async function withDemoBrowser<T>(
  options: DemoBrowserOptions,
  run: (session: DemoBrowserSession) => Promise<T>,
): Promise<T> {
  const { tempPrefix, prefix = DEMO_PREFIX, beforeTransport = "", afterTransport = "", args = ["--no-sandbox"], ignoreDefaultArgs = [], serve = (dir: string) => serveDemo(dir, { prefix }) } = options;
  const app = mkdtempSync(join(tmpdir(), tempPrefix));
  const evidence = process.env["UI_EVIDENCE_DIR"] || null;
  try {
    await buildDemoApp(app);
    const index = join(app, "index.html");
    const html = readFileSync(index, "utf8");
    assert.match(html, /<script type="module"/);
    writeFileSync(index, html.replace(/<script type="module"/, () => `${beforeTransport}<script src="./demo-transport.js"></script>${afterTransport}\n    <script type="module"`));
    const server = serve(app);
    try {
      if (evidence !== null) mkdirSync(evidence, { recursive: true });
      const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args, ignoreDefaultArgs });
      try {
        const port = server.port!;
        const origin = `http://127.0.0.1:${port}`;
        return await run({ app, browser, newContext: (overrides) => appContext(browser, overrides), origin, baseUrl: `${origin}${prefix}`, port, evidence });
      } finally {
        await browser.close();
      }
    } finally {
      server.stop(true);
    }
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
}
