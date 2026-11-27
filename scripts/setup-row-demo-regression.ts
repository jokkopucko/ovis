/** With UI_EVIDENCE_DIR, each state is captured under setup-row/. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { withDemoBrowser } from "./demo-browser.ts";

const evidence = process.env["UI_EVIDENCE_DIR"] ? join(process.env["UI_EVIDENCE_DIR"], "setup-row") : null;
if (evidence) mkdirSync(evidence, { recursive: true });
const DIALOG = "Set up Ovis";
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity)).map((animation) => animation.finished.catch(() => undefined))).then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))));

const serve = (app: string) => Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/icons/")) { const icon = Bun.file(join(app, path)); return (await icon.exists()) ? new Response(icon) : new Response("not found", { status: 404 }); }
  if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
  let file: string;
  try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
  catch { return new Response("bad path", { status: 400 }); }
  if (!file || file.endsWith("/")) file += "index.html";
  if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
  const body = Bun.file(join(app, file));
  return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
} });

await withDemoBrowser({ tempPrefix: "ovis-setup-row-", serve }, async ({ newContext, baseUrl: root }) => {
  const sizes = [
    { width: 1920, height: 1080 },
    { width: 1280, height: 720 },
    { width: 390, height: 844, phone: true },
    { width: 700, height: 900, drawer: true },
  ] as const;
  for (const size of sizes) {
    for (const theme of ["dark", "light"] as const) {
      const at = `${size.width}x${size.height}-${theme}`;
      const phone = "phone" in size;
      const drawer = "drawer" in size;
      const context = await newContext(phone
        ? { viewport: { width: size.width, height: size.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, colorScheme: theme }
        : { viewport: { width: size.width, height: size.height }, colorScheme: theme });
      await context.addInitScript(([value]) => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: value, palette: "codex", darkTheme: "codex", lightTheme: "codex" }));
        if (sessionStorage.getItem("seeded") === null) {
          localStorage.setItem("ovis:setup-guide", JSON.stringify({ status: "closed" }));
          localStorage.setItem("ovis:first-hints", "pending");
          localStorage.setItem("ovis:setup-row", "on");
          sessionStorage.setItem("seeded", "1");
        }
      }, [theme] as const);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const shot = async (name: string) => { if (evidence) { await settled(page); await page.screenshot({ path: join(evidence, `${name}-${at}.png`) }); } };
      try {
        await page.goto(root);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        if (phone || drawer) {
          await page.locator(".conn-live").waitFor({ state: "attached" });
          await page.getByText("Idempotent payments", { exact: true }).first().waitFor();
          await settled(page);
          await settled(page);
          assert.equal(await page.locator(".first-hint").count(), 0, `no hint where the sidebar is a drawer ${at}`);
          console.log(`PASS no first-start hint where the sidebar is a drawer (${at})`);
          continue;
        }

        const hint = page.getByRole("dialog", { name: "Chat or Terminal", exact: true });
        await hint.waitFor();
        await settled(page);
        assert.equal(await hint.locator(".first-hint-count").innerText(), "1/3", `the first hint counts itself ${at}`);
        const switchBox = (await page.locator(".view-switch").boundingBox())!;
        const hintBox = (await hint.boundingBox())!;
        assert.ok(hintBox.y >= switchBox.y + switchBox.height, `the first hint sits under the switch ${at}: ${JSON.stringify({ switchBox, hintBox })}`);
        assert.equal(await page.evaluate(() => document.activeElement?.closest(".first-hint") ?? null), null, `the hint takes no keyboard ${at}`);
        await shot("1-hint-chat");
        await hint.getByRole("button", { name: "Next", exact: true }).focus();
        await page.keyboard.press("Enter");
        const second = page.getByRole("dialog", { name: "Waiting agents first", exact: true });
        await second.waitFor();
        await settled(page);
        const agentsBox = (await page.locator(".agents-sidebar > .agent-section-toggle").boundingBox())!;
        assert.ok((await second.boundingBox())!.x >= agentsBox.x + agentsBox.width, `the second hint sits beside the Agents section ${at}`);
        assert.equal(await page.evaluate(() => document.activeElement?.closest(".first-hint")?.querySelector("h2")?.textContent ?? null), "Waiting agents first", `Next from the keyboard keeps the focus in the hints ${at}`);
        await shot("2-hint-agents");
        await second.getByRole("button", { name: "Next", exact: true }).focus();
        await page.keyboard.press("Escape");
        await second.waitFor({ state: "detached" });
        assert.equal(await page.evaluate(() => localStorage.getItem("ovis:first-hints")), "done", `closed hints stay done ${at}`);

        const row = page.locator(".sidebar-footer .setup-row-open");
        await row.waitFor();
        assert.equal((await row.innerText()).trim(), "Setup: 2 left", `the row counts what is left ${at}`);
        await shot("3-setup-row");
        // the row is a checklist of the parts, each left one opening its own setting: never the whole guide again
        await row.click();
        const checklist = page.getByRole("menu", { name: "Setup: 2 left", exact: true });
        await checklist.waitFor();
        assert.deepEqual(await checklist.locator("[data-item]").evaluateAll((items) => items.map((item) => [item.getAttribute("data-item"), item.getAttribute("aria-checked"), item.getAttribute("aria-disabled")])),
          [["workspace", "true", "true"], ["theme", "true", "true"], ["phone", "false", null], ["alerts", "false", null]], `the checklist ticks the done parts and leaves them inert ${at}`);
        await settled(page);
        await shot("4-checklist");
        assert.equal(await page.getByRole("dialog", { name: DIALOG, exact: true }).count(), 0, `the checklist opens no guide ${at}`);
        await checklist.getByRole("menuitemcheckbox", { name: "Connect your phone", exact: true }).click();
        const connect = page.getByRole("dialog", { name: "Add a connection", exact: true });
        await connect.waitFor();
        assert.equal(await page.getByRole("dialog", { name: DIALOG, exact: true }).count(), 0, `Connect your phone opens Add a connection, not the guide ${at}`);
        const relayTab = connect.locator('.connect-tabs [data-tab="relay"]');
        if (await relayTab.count() > 0) assert.equal(await relayTab.getAttribute("aria-pressed"), "true", `Add a connection opens on Ovis relay ${at}`);
        await settled(page);
        await shot("5-connect-your-phone");
        await page.keyboard.press("Escape");
        await connect.waitFor({ state: "detached" });
        await page.keyboard.press("Escape");
        await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor({ state: "detached" });
        await page.getByRole("button", { name: "Hide setup reminder", exact: true }).click();
        await row.waitFor({ state: "detached" });
        await page.reload();
        await page.locator(".workspace-group[data-workspace]").first().waitFor({ state: "attached" });
        await page.locator(".view-switch").first().waitFor();
        await settled(page);
        await settled(page);
        assert.equal(await page.locator(".setup-row-open").count(), 0, `a hidden row stays hidden ${at}`);
        assert.equal(await page.locator(".first-hint").count(), 0, `no hints after they were closed ${at}`);
        if (size.width === 1920) {
          const listed = await context.newPage();
          try {
            await listed.addInitScript(() => localStorage.setItem("ovis:setup-row", "on"));
            await listed.goto(`${root}?demo_devices=list`);
            await listed.locator(".sidebar-footer .setup-row-open").filter({ hasText: "Setup: 1 left" }).waitFor();
          } finally {
            await listed.close();
          }
        }
        console.log(`PASS the hints show one at a time by their anchors and close for good, and Setup: N left counts what is left and opens a checklist whose Connect your phone opens Add a connection (${at})`);
        assert.deepEqual(errors, [], `no page errors ${at}`);
      } finally {
        await context.close();
      }
    }
  }
});
