import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

import "./test-herdr.ts";
import { createServer } from "../server/index.ts";

/**
 * The line that says this server can be reached from the network with no token and nothing
 * paired (#698). It is drawn from `lan_exposure` on `/api/health`, which the server sends only
 * to a request that got in — so the check drives the real server, with a real herdr behind it,
 * rather than a canned answer, and asks two questions:
 *
 *   1. does it appear, name the address, and carry the danger tint, on a server bound past
 *      this PC with no token and nothing paired?
 *   2. does it stay away on the same empty configuration bound to loopback, which is
 *      unreachable from the network however it is addressed?
 */
const NOTICE = '[data-testid="lan-exposure-notice"]';

type Found = {
  visible: boolean;
  text: string | null;
  tint: { actual: string; danger: string } | null;
  settings: string | null;
};

async function notice(page: Page): Promise<Found> {
  const locator = page.locator(NOTICE);
  await locator.waitFor({ state: "attached", timeout: 5000 }).catch(() => undefined);
  const visible = await locator.isVisible().catch(() => false);
  if (!visible) return { visible, text: null, tint: null, settings: null };
  const text = (await locator.innerText()).replace(/\s+/g, " ").trim();
  const tint = await locator.evaluate((node) => {
    const probe = document.createElement("div");
    probe.style.background = "var(--danger-tint)";
    document.body.append(probe);
    const danger = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { actual: getComputedStyle(node).backgroundColor, danger };
  });
  await locator.locator("button").click();
  const title = page.locator(".settings-dialog .modal-title");
  await title.waitFor({ timeout: 5000 });
  return { visible, text, tint, settings: (await title.innerText()).trim() };
}

async function read(browser: Browser, hostname: string): Promise<Found> {
  const stateDir = mkdtempSync(join(tmpdir(), `herdr-lan-${hostname === "0.0.0.0" ? "exposed" : "loopback"}-`));
  // no token and nothing paired in both cases: the only difference is where it is reachable.
  // The token is pinned empty so a OVIS_TOKEN in the runner's environment cannot gate it.
  const server = createServer({ port: 0, hostname, stateDir, token: "" });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    // the absent case must not pass on a page that never asked: wait for the health answer the
    // notice is drawn from, and for the session to be live, before looking
    const health = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/health" && response.status() === 200, { timeout: 15_000 });
    await page.goto(`http://127.0.0.1:${server.port}`, { waitUntil: "load" });
    await health;
    await page.locator(".conn-live").waitFor({ timeout: 15_000 });
    const found = await notice(page);
    assert.deepEqual(errors, [], "the page raised no error");
    return found;
  } finally {
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

const dist = join(import.meta.dir, "..", "dist", "index.html");
if (!existsSync(dist)) {
  console.error("dist/index.html is missing: run `bun run build` first");
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
try {
  const exposed = await read(browser, "0.0.0.0");
  console.log(`exposed   : ${JSON.stringify(exposed)}`);
  assert.ok(exposed.visible, "the notice appears on a server reachable from the network");
  assert.ok(exposed.text?.includes("0.0.0.0"), "the notice names the address it is reachable at");
  assert.notEqual(exposed.tint?.actual, "rgba(0, 0, 0, 0)", "the notice carries a background of its own");
  assert.equal(exposed.tint?.actual, exposed.tint?.danger, "the notice's background is the danger tint");
  assert.equal(exposed.settings, "Devices and PCs", "the notice's button opens Settings on the devices page");
  console.log("PASS the open-to-the-network notice appears, names the address and opens Devices and PCs");

  const loopback = await read(browser, "127.0.0.1");
  console.log(`loopback  : ${JSON.stringify(loopback)}`);
  assert.ok(!loopback.visible, "the same empty configuration on a loopback bind shows no notice");
  console.log("PASS a loopback bind with no token and nothing paired shows no notice");
} finally {
  await browser.close();
}
