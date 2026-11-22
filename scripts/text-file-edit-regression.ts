/**
 * Settings → File viewer → Edit text files (#771) at 1280 and 390, light and dark, on an owned herdr
 * pane: off by default no Edit; on, a file in the pane's folder is edited, Save asks once more and
 * writes it, Cancel leaves it, a file changed on the PC meanwhile is not overwritten (the typed
 * text stays, Reload file shows the PC's), and a read-only file says it cannot be written.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-text-edit-"));
const project = join(root, "project");
mkdirSync(project);
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
let server: ReturnType<typeof createServer> | undefined;
let workspace: string | undefined;
let browser: Browser | undefined;

async function open(origin: string, pane: string, width: number, theme: "light" | "dark", settings: Record<string, unknown>, file: string): Promise<{ page: Page; viewer: Locator; errors: string[]; close: () => Promise<void> }> {
  const phone = width <= 480;
  const context = await browser!.newContext({ viewport: { width, height: phone ? 844 : 900 }, locale: "en-US", hasTouch: phone, isMobile: phone, colorScheme: theme });
  await context.addInitScript((value) => { if (window.top === window && localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", value); }, JSON.stringify({ language: "en", theme, fileOpen: "popup", ...settings }));
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}&file=${encodeURIComponent(file)}`);
  const viewer = page.getByRole("dialog", { name: file, exact: true });
  await viewer.waitFor();
  return { page, viewer, errors, close: () => context.close() };
}

const shot = async (page: Page, name: string): Promise<void> => { if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`) }); };

try {
  const created = await workspaceCreate({ cwd: project, label: "ovis-test-text-edit" });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });

  for (const width of [1280, 390]) {
    for (const theme of ["light", "dark"] as const) {
      const tag = `${width}-${theme}`;
      const notes = join(project, `notes-${tag}.md`);
      writeFileSync(notes, "# Notes\n\nFirst line.\n");

      const off = await open(origin, pane, width, theme, {}, `notes-${tag}.md`);
      await off.viewer.getByRole("button", { name: "Show source", exact: true }).waitFor();
      assert.equal(await off.viewer.getByRole("button", { name: "Edit file", exact: true }).count(), 0, `${tag}: no Edit while the setting is off`);
      await off.page.goto(`${origin}/?pane=${encodeURIComponent(pane)}&settings=chat&section=file-viewer-more`);
      const toggle = off.page.locator(".settings-dialog").getByRole("switch", { name: "Edit text files", exact: true });
      await toggle.scrollIntoViewIfNeeded();
      assert.equal(await toggle.getAttribute("aria-checked"), "false", `${tag}: Edit text files is off by default`);
      await shot(off.page, `text-edit-setting-${tag}`);
      await off.close();

      const on = await open(origin, pane, width, theme, { editTextFiles: true }, `notes-${tag}.md`);
      const { page, viewer } = on;
      await viewer.getByRole("button", { name: "Edit file", exact: true }).click();
      const box = viewer.getByRole("textbox", { name: `Text of notes-${tag}.md`, exact: true });
      assert.equal(await box.inputValue(), "# Notes\n\nFirst line.\n");
      await box.fill("# Notes\n\nFirst line.\nSecond line.\n");
      await viewer.getByText("Unsaved changes", { exact: true }).waitFor();
      await viewer.getByRole("button", { name: "Save", exact: true }).evaluate((button) => Promise.all(button.getAnimations().map((animation) => animation.finished)));
      await shot(page, `text-edit-editing-${tag}`);
      await page.keyboard.press("Escape");
      assert.equal(await viewer.isVisible(), true, `${tag}: Escape keeps the editor open over changes`);
      await viewer.getByRole("button", { name: "Save", exact: true }).click();
      await viewer.getByText(`Save changes to notes-${tag}.md?`, { exact: true }).waitFor();
      assert.equal(readFileSync(notes, "utf8"), "# Notes\n\nFirst line.\n", `${tag}: the first Save writes nothing`);
      await shot(page, `text-edit-confirm-${tag}`);
      await viewer.getByRole("button", { name: "Save", exact: true }).click();
      await viewer.getByRole("button", { name: "Edit file", exact: true }).waitFor();
      assert.equal(readFileSync(notes, "utf8"), "# Notes\n\nFirst line.\nSecond line.\n", `${tag}: the second Save writes the file`);
      await viewer.getByText("Second line.", { exact: true }).waitFor();
      console.log(`PASS ${tag}: Edit, Save asks once more, then the file holds the text and the viewer shows it`);

      if (width >= 1280) {
        await viewer.getByRole("button", { name: "Edit file", exact: true }).click();
        await box.fill("typed before the move\n");
        await viewer.getByRole("button", { name: "Show beside the pane", exact: true }).click();
        const docked = page.getByRole("complementary", { name: `notes-${tag}.md`, exact: true });
        await docked.getByText("Unsaved changes", { exact: true }).waitFor();
        assert.equal(await docked.getByRole("textbox", { name: `Text of notes-${tag}.md`, exact: true }).inputValue(), "typed before the move\n", `${tag}: the draft survives the move beside the pane`);
        await docked.getByRole("button", { name: "Cancel", exact: true }).click();
        await docked.getByRole("button", { name: "Show as a popup", exact: true }).click();
        await viewer.waitFor();
        console.log(`PASS ${tag}: text typed and not saved survives moving the viewer beside the pane`);
      }

      await viewer.getByRole("button", { name: "Edit file", exact: true }).click();
      await box.fill("thrown away\n");
      await viewer.getByRole("button", { name: "Cancel", exact: true }).click();
      await viewer.getByRole("button", { name: "Edit file", exact: true }).waitFor();
      assert.equal(readFileSync(notes, "utf8"), "# Notes\n\nFirst line.\nSecond line.\n", `${tag}: Cancel writes nothing`);
      console.log(`PASS ${tag}: Cancel leaves the file as it was`);

      await viewer.getByRole("button", { name: "Edit file", exact: true }).click();
      await box.fill("mine\n");
      writeFileSync(notes, "the agent's version\n");
      await viewer.getByRole("button", { name: "Save", exact: true }).click();
      await viewer.getByRole("button", { name: "Save", exact: true }).click();
      await viewer.getByRole("alert").getByText(/your changes were not saved/).waitFor();
      assert.equal(readFileSync(notes, "utf8"), "the agent's version\n", `${tag}: a changed file is not overwritten`);
      assert.equal(await box.inputValue(), "mine\n", `${tag}: the typed text stays to copy`);
      await shot(page, `text-edit-conflict-${tag}`);
      await viewer.getByRole("button", { name: "Reload file", exact: true }).click();
      await page.waitForFunction(([name]) => document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="Text of ${name}"]`)?.value === "the agent's version\n", [`notes-${tag}.md`]);
      await viewer.getByRole("button", { name: "Cancel", exact: true }).click();
      console.log(`PASS ${tag}: a file changed on the PC is not overwritten; Reload file shows the PC's text`);
      assert.deepEqual(on.errors, [], `${tag}: no page errors`);
      await on.close();

      const locked = join(project, `locked-${tag}.md`);
      writeFileSync(locked, "locked\n");
      chmodSync(locked, 0o444);
      const ro = await open(origin, pane, width, theme, { editTextFiles: true }, `locked-${tag}.md`);
      await ro.viewer.getByRole("button", { name: "Edit file", exact: true }).click();
      await ro.viewer.getByRole("textbox").fill("changed\n");
      await ro.viewer.getByRole("button", { name: "Save", exact: true }).click();
      await ro.viewer.getByRole("button", { name: "Save", exact: true }).click();
      await ro.viewer.getByRole("alert").getByText("This file can't be written here.", { exact: true }).waitFor();
      assert.equal(readFileSync(locked, "utf8"), "locked\n");
      await shot(ro.page, `text-edit-refused-${tag}`);
      console.log(`PASS ${tag}: a read-only file says it can't be written, and stays as it was`);
      await ro.close();
    }
  }
} finally {
  await browser?.close();
  server?.stop();
  if (workspace) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
}
