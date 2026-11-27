import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { DEMO_PREFIX, serveDemo } from "./demo-server.ts";

export interface DemoBrowserOptions {
  /** Temporary directory prefix under `os.tmpdir()`. */
  readonly tempPrefix: string;
  /** URL path prefix served by `serveDemo` (default: `DEMO_PREFIX`). */
  readonly prefix?: string;
  /** Optional HTML/script snippet injected directly before `./demo-transport.js`. */
  readonly beforeTransport?: string;
  /** Chromium launch args (default: `["--no-sandbox"]`). */
  readonly args?: string[];
}

export interface DemoBrowserSession {
  readonly app: string;
  readonly browser: Browser;
  readonly origin: string;
  readonly baseUrl: string;
  readonly port: number;
  readonly evidence: string | null;
}

/**
 * Builds the disposable demo app, injects `./demo-transport.js`, serves it over loopback via
 * `serveDemo`, launches headless Chromium with `chromePath()`, and tears everything down in
 * `finally` (browser, server, temp dir). Creates `UI_EVIDENCE_DIR` when non-empty.
 */
export async function withDemoBrowser<T>(
  options: DemoBrowserOptions,
  run: (session: DemoBrowserSession) => Promise<T>,
): Promise<T> {
  const { tempPrefix, prefix = DEMO_PREFIX, beforeTransport = "", args = ["--no-sandbox"] } = options;
  const app = mkdtempSync(join(tmpdir(), tempPrefix));
  const evidence = process.env["UI_EVIDENCE_DIR"] || null;
  try {
    await buildDemoApp(app);
    const index = join(app, "index.html");
    const html = readFileSync(index, "utf8");
    assert.match(html, /<script type="module"/);
    writeFileSync(index, html.replace(/<script type="module"/, () => `${beforeTransport}<script src="./demo-transport.js"></script>\n    <script type="module"`));
    const server = serveDemo(app, { prefix });
    try {
      if (evidence !== null) mkdirSync(evidence, { recursive: true });
      const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args });
      try {
        const port = server.port!;
        const origin = `http://127.0.0.1:${port}`;
        return await run({ app, browser, origin, baseUrl: `${origin}${prefix}`, port, evidence });
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
