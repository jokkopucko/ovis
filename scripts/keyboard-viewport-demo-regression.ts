import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { checkMobileViewport } from "./mobile-viewport-regression.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { serveDemo } from "./demo-server.ts";

const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-viewport-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));

  const server = serveDemo(app);

  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
    try {
      await checkMobileViewport(browser, `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app`, panes.api);
    } finally {
      await browser.close();
    }
  } finally {
    server.stop();
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
