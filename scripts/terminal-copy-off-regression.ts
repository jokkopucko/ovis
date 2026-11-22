/**
 * herdr's `[ui] copy_on_select = false` (#1559): a plain drag in the desktop terminal selects without
 * copying, a buttonless move over the grid keeps the selection (herdr reports no hover to a pane that
 * holds one), and Ctrl+C then copies it instead of interrupting the program.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { paneSendText, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { shownRow, shownRows } from "./shown-rows.ts";

export async function checkTerminalCopyOff(browser: Browser): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ovis-copy-off-"));
  const state = join(root, "state");
  mkdirSync(state);
  const configPath = join(root, "config.toml");
  writeFileSync(configPath, "[ui]\ncopy_on_select = false\n");
  const script = join(root, "show.cjs");
  writeFileSync(script, `process.stdout.write("\\x1b[2J\\x1b[H");
process.stdout.write("COPYOFF-first-line\\r\\n");
process.stdout.write("COPYOFF-second-line\\r\\n");
setInterval(() => {}, 1000);
`);
  let server: ReturnType<typeof createServer> | undefined;
  let workspace: string | undefined;
  let targetWorkspace: string | undefined;
  try {
    server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []), herdrConfigPath: configPath });
    const origin = `http://127.0.0.1:${server.port}`;
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-copy-off" });
    workspace = created.workspace.workspace_id;
    const pane = created.root_pane.pane_id;
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      await context.addInitScript((id) => {
        localStorage.setItem(`ovis:view:${id}`, "terminal");
        const reads = { asked: 0, open: 0 };
        (window as any).scrollReads = reads;
        const writes = { pending: 0 };
        (window as any).clipboardWrites = writes;
        for (const method of ["write", "writeText"] as const) {
          const original = navigator.clipboard[method].bind(navigator.clipboard);
          (navigator.clipboard as any)[method] = (value: any) => {
            writes.pending++;
            return original(value).finally(() => { writes.pending--; });
          };
        }
        const fetchPage = window.fetch.bind(window);
        (window as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          if (!url.pathname.endsWith("/pane/scroll")) return fetchPage(input, init);
          reads.asked++;
          reads.open++;
          let closed = false;
          const close = (): void => { if (!closed) reads.open--; closed = true; };
          try {
            const response = await fetchPage(input, init);
            if (!response.ok) close();
            const json = response.json.bind(response);
            response.json = () => json().finally(close);
            return response;
          } catch (error) {
            close();
            throw error;
          }
        };
      }, pane);
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      // the preference is read as the terminal mounts: a drag before its answer would copy nothing either way
      const preference = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/herdr-ui");
      await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
      await page.locator(shownRows()).first().waitFor();
      assert.equal((await (await preference).json()).copy_on_select, false, "the server reads herdr's copy_on_select");
      await paneSendText(pane, `clear; node ${script}\r`);
      const first = page.locator(shownRow(), { hasText: "COPYOFF-first-line" });
      await first.waitFor();
      const clipboard = (): Promise<string> => page.evaluate(() => navigator.clipboard.readText());
      await page.evaluate(() => navigator.clipboard.writeText("UNCHANGED"));

      const box = (await first.boundingBox())!;
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + 1, y);
      await page.mouse.down();
      await page.mouse.move(box.x + 200, y, { steps: 4 });
      await page.mouse.move(box.x + 400, y, { steps: 4 });
      await page.mouse.up();
      await page.getByRole("button", { name: "Quote in message" }).waitFor();
      assert.equal(await clipboard(), "UNCHANGED", "with copy_on_select off, letting go of a drag copies nothing");
      assert.equal(await page.locator(".terminal-banner", { hasText: "copied to clipboard" }).count(), 0, "nothing says it was copied");

      // a buttonless move over the grid keeps the selection: xterm would clear it on the hover report
      for (const x of [box.x + 100, box.x + 300, box.x + 500, box.x + 150]) await page.mouse.move(x, y + box.height, { steps: 3 });
      await page.keyboard.press("Control+c");
      assert.match(await clipboard(), /^COPYOFF-first-line/, "Ctrl+C copies the selection the hover kept");
      await page.locator(".terminal-banner", { hasText: "copied to clipboard" }).waitFor();
      console.log("PASS with herdr's copy_on_select off, a drag only selects, a hover keeps the selection, and Ctrl+C copies it");

      const copyBeforeAnswer = async (meanwhile: () => Promise<void>): Promise<string> => {
        let answer!: () => void;
        const answered = new Promise<void>((resolve) => { answer = resolve; });
        let asked!: () => void;
        const requested = new Promise<void>((resolve) => { asked = resolve; });
        await page.route("**/api/pane/selection?*", async (route) => {
          asked();
          await answered;
          await route.fulfill({ json: { text: "COPYOFF-herdr-whole-range" } });
        });
        try {
          await page.evaluate(() => navigator.clipboard.writeText("UNCHANGED"));
          await page.mouse.move(box.x + 1, y);
          const reads = await page.evaluate(() => (window as any).scrollReads.asked as number);
          await page.mouse.down();
          await page.waitForFunction((count) => {
            const { asked, open } = (window as any).scrollReads;
            return asked > count && open === 0;
          }, reads);
          await page.mouse.move(box.x + 200, y, { steps: 4 });
          await page.mouse.move(box.x + 400, y, { steps: 4 });
          await page.mouse.up();
          await requested;
          assert.equal(await clipboard(), "UNCHANGED", "the release copies nothing");
          await page.keyboard.press("Control+c");
          assert.match(await clipboard(), /^COPYOFF-first-line/, "Ctrl+C copies the visible rows at once");
          await meanwhile();
          answer();
          await page.waitForFunction(() => (window as any).clipboardWrites.pending === 0);
          return await clipboard();
        } finally {
          await page.unroute("**/api/pane/selection?*");
        }
      };

      assert.equal(await copyBeforeAnswer(async () => {}), "COPYOFF-herdr-whole-range", "Ctrl+C before herdr's answer copies herdr's text, not the visible rows");
      console.log("PASS Ctrl+C before herdr's text arrives copies herdr's whole range, not the visible rows");

      const target = await workspaceCreate({ cwd: root, label: "ovis-test-copy-off-target" });
      targetWorkspace = target.workspace.workspace_id;
      const targetPane = target.root_pane.pane_id;
      await paneSendText(targetPane, "echo COPYOFF-target-pane\r");
      await page.evaluate((id) => localStorage.setItem(`ovis:view:${id}`, "terminal"), targetPane);
      const row = page.locator(`.pane-select[data-pane="${targetPane}"]`);
      await row.waitFor();
      const left = await copyBeforeAnswer(async () => {
        await row.click();
        await page.locator(shownRow(), { hasText: "COPYOFF-target-pane" }).first().waitFor();
      });
      assert.match(left, /^COPYOFF-first-line/, "leaving the pane before herdr answers cancels the explicit copy of herdr's text");
      console.log("PASS leaving the pane before herdr answers cancels that explicit copy, which keeps the visible rows");
    } finally {
      await context.close();
    }
  } finally {
    if (workspace) await workspaceClose(workspace).catch(() => {});
    if (targetWorkspace) await workspaceClose(targetWorkspace).catch(() => {});
    server?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { chromePath } = await import("./chrome-path.ts");
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    await checkTerminalCopyOff(browser);
  } finally {
    await browser?.close();
  }
}
