import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { useTestHerdr } from "./test-herdr.ts";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import type { SetupRequest } from "../shared/machines.ts";
import type { HerdrMachineProfile } from "../server/herdr-profiles.ts";

await useTestHerdr();
const stateDir = mkdtempSync(join(tmpdir(), "herdr-profile-browser-"));
const evidence = process.env.EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
const workspace = await workspaceCreate({ label: "ovis-test-profile-inheritance", cwd: stateDir, focus: false });
// Discovery must not connect. Explicit setup uses a closed loopback port, never a user’s machine.
const profile: HerdrMachineProfile = { id: "browser-fixture", label: "Build machine", enabled: true, target: { destination: "127.0.0.1", port: 1, session: "project-agents" } };
let profiles = [profile];
const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, herdrProfiles: async () => profiles });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const phone of [false, true]) {
    profiles = [profile];
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: phone, hasTouch: phone });
    try {
      await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const submitted: SetupRequest[] = [];
      let delaySetup = false;
      let releaseSetup: (() => void) | undefined;
      let cancelled = 0;
      const job = () => ({ id: "qa-job", machine_id: submitted.at(-1)?.machine_id, phase: "approval", step: "Review the changes on this PC", challenge: null, installations: ["Install a web bridge"], error: null, ssh_output: null, target: submitted.at(-1) });
      await page.route("**/api/machines/setup", async (route) => {
        submitted.push(route.request().postDataJSON() as SetupRequest);
        if (delaySetup) await new Promise<void>((resolve) => { releaseSetup = resolve; });
        await route.fulfill({ json: job() });
      });
      await page.route("**/api/machines/setup/qa-job", async (route) => {
        if (route.request().method() === "POST" && route.request().postDataJSON()?.action === "cancel") cancelled++;
        await route.fulfill({ json: job() });
      });
      await page.goto(`http://127.0.0.1:${server.port}`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      const group = page.getByRole("region", { name: "PC Build machine", exact: true });
      if (phone) {
        const toggle = page.locator('[aria-controls="workspace-drawer"]').first();
        if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
      }
      await group.waitFor({ state: "attached" });
      if (!phone) await group.locator(".machine-header").hover();
      await group.getByRole("button", { name: "Manage Build machine" }).click();
      const menu = page.locator(".row-menu, .row-sheet");
      await menu.getByText("Managed by herdr. Rename, disable or remove it there.").waitFor();
      assert.equal(await menu.getByText("Remove PC…", { exact: true }).count(), 0);
      assert.equal(await menu.getByText("Rename…", { exact: true }).count(), 0);
      assert.equal(submitted.length, 0);
      if (evidence) await page.screenshot({ path: join(evidence, phone ? "phone.png" : "desktop.png"), fullPage: true });
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      await group.getByRole("button", { name: "Connect", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Connect", exact: true });
      await dialog.getByRole("button", { name: "Install and connect", exact: true }).waitFor();
      assert.equal(await dialog.getByLabel("SSH alias or user@address").count(), 0, "inherited setup requires no repeated address entry");
      assert.equal(submitted.length, 1);
      assert.deepEqual({ ...submitted[0], machine_id: "stable" }, { destination: "127.0.0.1", port: 1, session: "project-agents", machine_id: "stable" });
      assert.ok(submitted[0]?.machine_id);
      assert.equal(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
      if (evidence) await page.screenshot({ path: join(evidence, phone ? "phone-approval.png" : "desktop-approval.png"), fullPage: true });
      await dialog.getByRole("button", { name: "Close PC setup" }).click();
      const waitCancelled = async (count: number) => {
        const deadline = Date.now() + 5000;
        while (cancelled < count) { assert.ok(Date.now() < deadline, "closed dialog cancels pending setup"); await Bun.sleep(10); }
      };
      await waitCancelled(1);
      delaySetup = true;
      await group.getByRole("button", { name: "Connect", exact: true }).click();
      const requestDeadline = Date.now() + 5000;
      while (!releaseSetup) { assert.ok(Date.now() < requestDeadline, "setup request started"); await Bun.sleep(10); }
      await dialog.getByRole("button", { name: "Close PC setup" }).click();
      releaseSetup!();
      await waitCancelled(2);
      profiles = [{ ...profile, label: "Renamed machine", enabled: false }];
      const renamed = page.getByRole("region", { name: "PC Renamed machine", exact: true });
      await renamed.waitFor({ state: "attached", timeout: 12_000 });
      if (!phone) await renamed.locator(".machine-header").hover();
      await renamed.getByRole("button", { name: "Manage Renamed machine" }).click();
      const setup = menu.locator(".menu-item, .row-sheet-item").filter({ hasText: "Reconnect / setup" });
      await setup.waitFor();
      assert.equal(await setup.getAttribute("aria-disabled"), "true");
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      profiles = [];
      await renamed.waitFor({ state: "detached", timeout: 12_000 });
      assert.deepEqual(errors, []);
      console.log(`PASS ${phone ? "phone" : "desktop"}: automatic row, inherited controls, no address entry, approval, rename, disable and removal`);
    } finally { await context.close(); }
  }
} finally {
  await browser.close(); server.stop(); await workspaceClose(workspace.workspace.workspace_id); rmSync(stateDir, { recursive: true, force: true });
}
