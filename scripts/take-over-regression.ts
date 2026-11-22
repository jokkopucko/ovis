import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { UsageService } from "../server/usage.ts";

export async function checkTakeOver(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ovis-take-over-"));
  const cwd = join(root, "pane");
  mkdirSync(cwd);
  const created = await workspaceCreate({ cwd, label: "ovis-test-take-over" });
  const paneId = created.root_pane.pane_id;
  const other = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    await context.addInitScript(() => {
      if (!localStorage.getItem("ovis:settings")) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
      const frames: string[] = [];
      Object.assign(window, { takenText_: false });
      (window as unknown as { frames_: string[] }).frames_ = frames;
      const Native = window.WebSocket;
      class Recording extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener("message", (event) => { try {
            const message = JSON.parse(String(event.data));
            frames.push(message.type);
            if (message.type === "pty-data" && message.data.includes("terminal attach taken over")) Object.assign(window, { takenText_: true });
          } catch {} });
        }
      }
      Object.assign(window, { WebSocket: Recording });
    });
    const open = async (at: string): Promise<Page> => {
      const page = await context.newPage();
      await page.goto(`${at}/?pane=${encodeURIComponent(paneId)}`);
      await page.locator(".conn-live").waitFor();
      return page;
    };
    const told = (page: Page, type: string) => page.waitForFunction((t) => (window as unknown as { frames_: string[] }).frames_.includes(t), type, { timeout: 15_000 });
    const waiting = (page: Page) => page.getByText("Another app has this pane open.", { exact: false });
    const openHere = (page: Page) => page.getByRole("button", { name: "Open here", exact: true });

    const here = await open(origin);
    await told(here, "input-ready");
    const there = await open(`http://127.0.0.1:${other.port}`);
    await waiting(there).waitFor();
    await openHere(there).waitFor();
    if (process.env.UI_EVIDENCE_DIR) await there.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "take-over-waiting.png") });
    console.log("PASS a pane another web bridge holds offers Open here");

    await openHere(there).click();
    await told(there, "attach-resumed");
    await waiting(there).waitFor({ state: "detached" });
    await waiting(here).waitFor();
    await openHere(here).waitFor();
    if (process.env.UI_EVIDENCE_DIR) await here.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "take-over-taken.png") });
    assert.equal(await here.evaluate(() => (window as unknown as { takenText_: boolean }).takenText_), false);
    console.log("PASS Open here takes the pane without painting its takeover diagnostic, and the displaced bridge waits");
    await openHere(here).click();
    await told(here, "attach-resumed");
    await waiting(here).waitFor({ state: "detached" });
    await openHere(there).waitFor();
    console.log("PASS the displaced bridge takes it back only after another click");
  } finally {
    await context.close();
    other.stop();
    await workspaceClose(created.workspace.workspace_id).catch((error) => { if (error?.code !== "workspace_not_found") throw error; });
    rmSync(root, { recursive: true, force: true });
  }
}
