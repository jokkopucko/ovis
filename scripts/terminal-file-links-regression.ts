import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { paneSendText, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

const cwd = process.cwd();
const shortUri = "file:///etc/hosts";
const workspace = await workspaceCreate({ cwd, label: "ovis-test-file-links" });
const pane = workspace.root_pane.pane_id;
// its own state dir: the default is the user's real devices and push registry
const stateDir = mkdtempSync(join(tmpdir(), "herdr-file-links-"));
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir });
  browser = await chromium.launch({
    executablePath: chromePath(),
    headless: true,
  });
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: width === 390, isMobile: width === 390 });
    await context.addInitScript((id) => localStorage.setItem(`ovis:view:${id}`, "terminal"), pane);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(".conn-live").waitFor();
    await paneSendText(pane, `printf '\\033[2J\\033[HFILELINK ${shortUri}\\n'\r`);
    const row = page.locator(".xterm-rows > div", { hasText: /^FILELINK file:\/\// }).first();
    await row.waitFor();
    await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("file:///etc/hosts"));
    const span = row.locator("span").filter({ hasText: "file://" }).first();
    const box = await span.boundingBox();
    assert.ok(box);
    // The output's prefix is nine cells; xterm links use character-cell coordinates.
    const rowBox = await row.boundingBox();
    assert.ok(rowBox);
    const cols = await row.evaluate((el) => el.textContent?.length ?? 0);
    assert.ok(cols > 0);
    const cellWidth = await row.evaluate((el) => {
      const range = document.createRange();
      const text = el.querySelector("span")?.firstChild;
      if (!text) throw new Error("missing terminal text");
      range.setStart(text, 0); range.setEnd(text, 1);
      return range.getBoundingClientRect().width;
    });
    if (width === 390) {
      await page.touchscreen.tap(rowBox.x + cellWidth * 12.5, rowBox.y + rowBox.height / 2);
    } else {
      await page.mouse.move(rowBox.x + cellWidth * 12.5, rowBox.y + rowBox.height / 2);
      await page.waitForFunction(() => document.querySelector(".xterm-cursor-pointer") !== null);
      await page.mouse.click(rowBox.x + cellWidth * 12.5, rowBox.y + rowBox.height / 2);
    }
    // a dialog over the terminal: files open in the popup unless Settings puts them beside the pane
    await page.locator(".modal.file-viewer").waitFor();
    console.log(`VIEWER ${width}: ${await page.locator(".file-viewer").innerText()}`);
    await page.locator(".file-viewer-text").waitFor();
    assert.match(await page.locator(".file-viewer-text").innerText(), /localhost/);
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.UI_EVIDENCE_DIR}/terminal-file-link-${width}.png` });
    console.log(`PASS terminal file click opens viewer at ${width}px`);
    if (width === 390) {
      await page.locator(".file-viewer-header button").last().click();
      await page.locator(".file-viewer").waitFor({ state: "hidden" });
      // a tap has no Cmd or Ctrl: a bare name stays text, and the tap lands on the terminal
      await paneSendText(pane, `printf '\\033[2J\\033[HBARE README.md\\n'\r`);
      const bare = page.locator(".xterm-rows > div", { hasText: /^BARE README/ }).first();
      await bare.waitFor();
      const bareBox = await bare.boundingBox();
      assert.ok(bareBox);
      await page.touchscreen.tap(bareBox.x + cellWidth * 9.5, bareBox.y + bareBox.height / 2);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
      assert.equal(await page.locator(".file-viewer").count(), 0, "a tap on a bare file name opened the file viewer");
      console.log("PASS a tap on a bare name opens nothing at 390px");
    }
    if (width === 1280) {
      await page.locator(".file-viewer-header button").last().click();
      await page.locator(".file-viewer").waitFor({ state: "hidden" });
      // one row with a path and a bare name: `MIXED ` is six cells, the path the next 21, the name from cell 28
      await paneSendText(pane, `printf '\\033[2J\\033[HMIXED scripts/test-herdr.ts README.md\\n'\r`);
      const mixed = page.locator(".xterm-rows > div", { hasText: /^MIXED scripts\// }).first();
      await mixed.waitFor();
      const mixedBox = await mixed.boundingBox();
      assert.ok(mixedBox);
      const y = mixedBox.y + mixedBox.height / 2;
      const pointer = (shown: boolean) => page.waitForFunction((want) => (document.querySelector(".xterm-cursor-pointer") !== null) === want, shown);
      // off the row first, so xterm reads its links anew; its pointer says when it has
      await page.mouse.move(mixedBox.x + cellWidth * 10.5, mixedBox.y + mixedBox.height * 6.5);
      await pointer(false);
      await page.mouse.move(mixedBox.x + cellWidth * 10.5, y);
      await pointer(true);
      // A bare name is what a terminal is full of: it is no link, so the pointer goes and a
      // click opens nothing.
      await page.mouse.move(mixedBox.x + cellWidth * 31.5, y);
      await pointer(false);
      await page.mouse.click(mixedBox.x + cellWidth * 31.5, y);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
      assert.equal(await page.locator(".file-viewer").count(), 0, "a bare file name in the terminal opened the file viewer");
      console.log("PASS a path with a folder is a link and a bare name beside it stays text");
      // Cmd (Ctrl off a Mac) makes it one, as in VS Code's terminal: drawn while the key is held,
      // text again when it goes up, and opened by a click with the key
      const key = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.down(key);
      await pointer(true);
      await page.keyboard.up(key);
      await pointer(false);
      await page.keyboard.down(key);
      await pointer(true);
      await page.mouse.click(mixedBox.x + cellWidth * 31.5, y);
      await page.keyboard.up(key);
      await page.locator(".modal.file-viewer").waitFor();
      await page.waitForFunction(() => document.querySelector(".file-viewer-header")?.textContent?.includes("README.md"));
      console.log("PASS a bare name opens on a click with the key held");
      await page.locator(".file-viewer-header button").last().click();
      await page.locator(".file-viewer").waitFor({ state: "hidden" });
      // a name several files under the pane's folder have: the viewer lists them to choose from
      await paneSendText(pane, `printf '\\033[2J\\033[HTWO access.ts\\n'\r`);
      const two = page.locator(".xterm-rows > div", { hasText: /^TWO access/ }).first();
      await two.waitFor();
      const twoBox = await two.boundingBox();
      assert.ok(twoBox);
      await page.mouse.move(twoBox.x + cellWidth * 10.5, twoBox.y + twoBox.height * 6.5);
      await pointer(false);
      await page.keyboard.down(key);
      await page.mouse.move(twoBox.x + cellWidth * 8.5, twoBox.y + twoBox.height / 2);
      await pointer(true);
      await page.mouse.click(twoBox.x + cellWidth * 8.5, twoBox.y + twoBox.height / 2);
      await page.keyboard.up(key);
      const choices = page.locator(".file-viewer-choices button");
      await choices.first().waitFor();
      assert.deepEqual(await choices.allInnerTexts(), [join(cwd, "server/access.ts"), join(cwd, "shared/access.ts")]);
      if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.UI_EVIDENCE_DIR}/terminal-bare-name-choices-${width}.png` });
      await choices.last().click();
      await page.locator(".file-viewer-text").waitFor();
      assert.match(await page.locator(".file-viewer-text").innerText(), /export/);
      console.log("PASS a bare name several files have lists them, and a choice opens one");
    }
    await context.close();
  }
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      server?.stop();
    } finally {
      await workspaceClose(workspace.workspace.workspace_id);
      rmSync(stateDir, { recursive: true, force: true });
    }
  }
}
