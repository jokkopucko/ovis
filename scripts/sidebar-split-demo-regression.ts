/**
 * The PCs/Agents height divider on the real demo, never a live herdr session: default, drag,
 * persistence, reset, keyboard, snap-fold (Agents only: the PCs have no head to fold to), scrolling, a short
 * window and both section orders.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";
import { serveDemo } from "./demo-server.ts";

const app = mkdtempSync(join(tmpdir(), "ovis-sidebar-split-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
const metrics = (page: Page) => page.evaluate(() => {
  const box = (selector: string) => {
    const r = document.querySelector(selector)!.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height };
  };
  const pcs = box(".pcs-sidebar"), agents = box(".agents-sidebar");
  const grouped = document.querySelector(".sidebar-shell")!.classList.contains("is-agents-first");
  return { pcs, agents, top: grouped ? agents : pcs, bottom: grouped ? pcs : agents,
    shell: box(".sidebar-shell"), footer: box(".sidebar-footer"), line: box(".sidebar-split"),
    topHead: grouped ? box(".agent-section-toggle").height + 8 : 0,
    bottomHead: grouped ? 0 : box(".agent-section-toggle").height + 8,
    agentsFolded: document.querySelector(".agent-section-toggle")!.getAttribute("aria-expanded") === "false",
  };
});
const pcListLayout = (page: Page) => page.evaluate(() => {
  const pcs = document.querySelector<HTMLElement>(".pcs-sidebar")!;
  const list = document.querySelector<HTMLElement>(".machine-list")!;
  const grouped = document.querySelector(".sidebar-shell")!.classList.contains("is-agents-first");
  const end = document.querySelector<HTMLElement>(grouped ? ".sidebar-footer" : ".sidebar-split")!.getBoundingClientRect().top;
  const style = getComputedStyle(pcs);
  const room = Math.max(0, end - pcs.getBoundingClientRect().top - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
  list.scrollTop = 0;
  const viewport = list.getBoundingClientRect();
  const first = list.querySelector(".workspace-group")?.getBoundingClientRect();
  return {
    clientHeight: list.clientHeight,
    expectedHeight: Math.min(list.scrollHeight, room),
    firstVisible: first !== undefined && first.top >= viewport.top - 1 && first.bottom <= viewport.bottom + 1,
    display: style.display,
  };
});

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script type="module"'));
  const server = serveDemo(app, { prefix: "/" });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const width of [1280, 390]) for (const mode of ["light", "dark"] as const) for (const grouped of [false, true]) {
        const phone = width === 390;
        const label = `${width}/${mode}/${grouped ? "agents-first" : "pcs-first"}`;
        const key = grouped ? "ovis:sidebar-split-agents-first" : "ovis:sidebar-split";
        const context = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: mode, hasTouch: phone, isMobile: phone, deviceScaleFactor: 1, locale: "en-US" });
        try {
          await context.addInitScript(({ mode, grouped }) => {
            if (localStorage.getItem("split-fixture-initialized") !== "1") {
              localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: mode, palette: "codex", defaultView: "chat" }));
              localStorage.setItem("ovis:agents-collapsed", "0");
              localStorage.setItem("ovis:agent-groups", String(grouped));
              localStorage.setItem("split-fixture-initialized", "1");
            }
          }, { mode, grouped });
          const page = await context.newPage();
          page.setDefaultTimeout(10_000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const open = async () => {
            await page.locator(".conn-live").waitFor({ state: "attached" });
            if (phone && await page.locator(".sidebar.is-open").count() === 0) await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
            // CDP touch dispatch has no actionability wait: wait for the drawer's slide to reach the screen.
            if (phone) await page.waitForFunction(() => (document.querySelector(".sidebar.is-open")?.getBoundingClientRect().left ?? -1) >= -0.5);
            await page.locator(".sidebar-split").waitFor();
            await page.evaluate(() => document.fonts.ready);
          };
          await page.goto(`http://127.0.0.1:${server.port}/`);
          await open();
          const line = page.getByRole("separator", { name: "Resize PCs and Agents", exact: true });
          const original = await metrics(page);
          const defaultPcs = await pcListLayout(page);
          // Chromium shows the rows with a column flexbox too; Safari caps its list at one row, so pin the grid
          assert.equal(defaultPcs.display, "grid", `${label} the PCs section stays a grid, or Safari draws its list one row tall`);
          assert.ok(Math.abs(defaultPcs.clientHeight - defaultPcs.expectedHeight) <= 1, `${label} the PCs' list takes its rows' height or the room it has (${defaultPcs.clientHeight}/${defaultPcs.expectedHeight}px)`);
          assert.ok(defaultPcs.firstVisible, `${label} the first PC row is in view by default`);
          assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), null, `${label} opening the sidebar does not save a split`);
          assert.ok(original.agents.height <= original.shell.height / 2 + 1, `${label} the default starts at no more than today's half-shell allocation`);
          const controls = await line.getAttribute("aria-controls");
          assert.equal(controls, await page.locator(grouped ? ".agent-list-contents" : ".machine-list").getAttribute("id"), `${label} the divider names the list it sizes`);
          const footerVisible = async () => {
            const m = await metrics(page);
            assert.ok(m.footer.bottom <= m.shell.bottom + 1 && m.footer.top >= m.shell.top, `${label} footer stays reachable`);
            assert.ok(m.bottom.bottom <= m.footer.top + 1, `${label} the lower list does not run under the footer`);
          };
          const shot = async (name: string) => {
            if (!evidence) return;
            mkdirSync(evidence, { recursive: true });
            await page.screenshot({ path: join(evidence, `split-${width}-${mode}-${grouped ? "agents" : "pcs"}-${name}.png`), animations: "disabled" });
          };
          await shot("default");
          const drag = async (to: number, beforeRelease?: () => Promise<void>) => {
            const box = (await line.boundingBox())!;
            const x = box.x + box.width / 2, y = box.y + box.height / 2;
            if (phone) {
              const cdp = await context.newCDPSession(page);
              try {
                await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
                for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (to - y) * i / 8 }] });
                await beforeRelease?.();
                await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
              } finally { await cdp.detach(); }
            } else {
              await page.mouse.move(x, y);
              await page.mouse.down();
              await page.mouse.move(x, to, { steps: 8 });
              await beforeRelease?.();
              await page.mouse.up();
            }
          };
          const wanted = original.shell.height * 0.65;
          await drag(grouped
            ? original.agents.top + wanted + original.line.height / 2
            : original.footer.top - wanted - original.line.height / 2);
          await page.waitForFunction((key) => localStorage.getItem(key) !== null, key);
          const dragged = await metrics(page);
          assert.ok(dragged.agents.height > original.agents.height + 30, `${label} a drag gives Agents more height`);
          assert.ok(dragged.agents.height > dragged.shell.height / 2, `${label} Agents may use more than half the sidebar`);
          await footerVisible();
          await shot("resized");
          const stored = await page.evaluate((key) => localStorage.getItem(key), key);
          await page.reload();
          await open();
          assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), stored, `${label} reload keeps the device's chosen split`);
          assert.ok(Math.abs((await metrics(page)).top.height - dragged.top.height) <= 1, `${label} reload restores the same height`);
          for (const selector of [".machine-list", ".agent-list-contents"]) {
            const scrolling = await page.locator(selector).evaluate((list) => {
              list.scrollTop = list.scrollHeight;
              const bounds = list.getBoundingClientRect();
              const section = list.closest(".pcs-sidebar, .agents-sidebar")!.getBoundingClientRect();
              return { max: list.scrollHeight - list.clientHeight, top: list.scrollTop, overflow: getComputedStyle(list).overflowY, fits: bounds.top >= section.top - 1 && bounds.bottom <= section.bottom + 1 };
            });
            assert.ok(scrolling.fits, `${label} ${selector} fits inside its section instead of being clipped`);
            assert.equal(scrolling.overflow, "auto", `${label} ${selector} owns its scroll`);
            if (scrolling.max > 1) assert.ok(scrolling.top > 0, `${label} ${selector} still scrolls after resizing`);
          }
          await line.focus();
          await page.keyboard.press("ArrowDown");
          await page.waitForFunction(({ key, stored }) => localStorage.getItem(key) !== stored, { key, stored });
          assert.ok((await metrics(page)).top.height > dragged.top.height, `${label} ArrowDown grows the upper section`);
          const foldsAgents = async (press: "Home" | "End") => {
            const before = await page.evaluate((key) => localStorage.getItem(key), key);
            await page.keyboard.press(press);
            if ((press === "Home") === grouped) await page.waitForFunction(() => document.querySelector(".agents-sidebar")!.classList.contains("is-collapsed"));
            else {
              await page.waitForFunction(({ key, before }) => localStorage.getItem(key) !== before, { key, before });
              assert.equal(await page.locator(".pcs-sidebar.is-collapsed, .agents-sidebar.is-collapsed").count(), 0, `${label} ${press} on the PCs' side folds nothing`);
              assert.ok(await page.locator(".machine-list .workspace-group").first().isVisible(), `${label} ${press} keeps a PC row in view`);
            }
          };
          await foldsAgents("Home");
          await footerVisible();
          await page.keyboard.press("ArrowDown");
          await page.waitForFunction(() => !document.querySelector(".pcs-sidebar.is-collapsed, .agents-sidebar.is-collapsed"));
          await foldsAgents("End");
          await footerVisible();
          await page.keyboard.press("Enter");
          await page.waitForFunction((key) => localStorage.getItem(key) === null && !document.querySelector(".pcs-sidebar.is-collapsed, .agents-sidebar.is-collapsed"), key);
          assert.ok(Math.abs((await metrics(page)).agents.height - original.agents.height) <= 1, `${label} Enter restores today's default`);
          if (!phone) {
            await page.keyboard.press("ArrowUp");
            await line.dblclick();
            await page.waitForFunction((key) => localStorage.getItem(key) === null, key);
          } else {
            const grip = await line.evaluate((element) => ({ height: parseFloat(getComputedStyle(element, "::after").height), action: getComputedStyle(element).touchAction }));
            assert.ok(grip.height >= 44, `${label} the touch target is at least 44px`);
            assert.ok((await line.boundingBox())!.height >= 44, `${label} the touch target has its own layout space, never overlapping PC actions`);
            assert.equal(grip.action, "none");
            assert.notEqual(await page.locator(".machine-list").evaluate((list) => getComputedStyle(list).touchAction), "none", `${label} only the divider suppresses touch scrolling`);
          }
          let m = await metrics(page);
          await drag(m.top.top + (grouped ? m.topHead / 2 : 2), async () => {
            const preview = await metrics(page);
            if (grouped) assert.ok(Math.abs(preview.top.height - preview.topHead) <= 1, `${label} the upper snap preview reaches its heading before release`);
            else assert.equal(await page.locator(".sidebar-split.is-snapping, .will-fold").count(), 0, `${label} no snap preview over the PCs`);
          });
          if (grouped) await page.waitForFunction(() => document.querySelector(".agents-sidebar")!.classList.contains("is-collapsed"));
          else assert.equal(await page.locator(".pcs-sidebar.is-collapsed, .agents-sidebar.is-collapsed").count(), 0, `${label} a drag to the PCs' top folds nothing`);
          await line.focus(); await page.keyboard.press("Enter");
          await page.waitForFunction(() => !document.querySelector(".pcs-sidebar.is-collapsed, .agents-sidebar.is-collapsed"));
          m = await metrics(page);
          await drag(m.footer.top - (grouped ? 2 : m.bottomHead / 2), async () => {
            const preview = await metrics(page);
            if (!grouped) assert.ok(Math.abs(preview.bottom.height - preview.bottomHead) <= 1, `${label} the lower snap preview reaches its heading before release`);
            else assert.equal(await page.locator(".sidebar-split.is-snapping, .will-fold").count(), 0, `${label} no snap preview over the PCs`);
          });
          if (!grouped) {
            await page.waitForFunction(() => document.querySelector(".agents-sidebar")!.classList.contains("is-collapsed"));
            const folded = await pcListLayout(page);
            assert.ok(Math.abs(folded.clientHeight - folded.expectedHeight) <= 1, `${label} with Agents folded the PCs' list takes its rows' height or the room it has (${folded.clientHeight}/${folded.expectedHeight}px)`);
          } else assert.equal(await page.locator(".pcs-sidebar.is-collapsed, .agents-sidebar.is-collapsed").count(), 0, `${label} a drag to the PCs' foot folds nothing`);
          await line.focus(); await page.keyboard.press("Enter");
          await page.waitForFunction(() => !document.querySelector(".pcs-sidebar.is-collapsed, .agents-sidebar.is-collapsed"));
          await line.focus(); await page.keyboard.press(grouped ? "Home" : "End");
          await page.waitForFunction(() => document.querySelector(".agents-sidebar")!.classList.contains("is-collapsed"));
          await page.locator(".agent-section-toggle").click();
          assert.equal(await page.locator(".agent-section-toggle").getAttribute("aria-expanded"), "true");
          await line.focus(); await page.keyboard.press("ArrowDown");
          const saved: Record<string, { stored: string; height: number }> = {
            [key]: { stored: (await page.evaluate((key) => localStorage.getItem(key), key))!, height: (await metrics(page)).top.height },
          };
          for (const expected of [!grouped, grouped, !grouped, grouped]) {
            await page.locator(".sidebar-footer-settings").click();
            await openSettingsPage(page, "Appearance");
            await page.getByRole("group", { name: "Agents order", exact: true }).getByRole("button", { name: expected ? "By state" : "Workspaces", exact: true }).click();
            await page.keyboard.press("Escape"); await open();
            assert.equal(await page.locator(".sidebar-shell").evaluate((shell) => shell.classList.contains("is-agents-first")), expected);
            assert.equal(await page.locator(".agent-section-toggle").getAttribute("aria-expanded"), "true", `${label} changing order preserves the caret's newer fold choice`);
            const activeKey = expected ? "ovis:sidebar-split-agents-first" : "ovis:sidebar-split";
            if (!saved[activeKey]) {
              await line.focus();
              for (let step = 0; step < 3; step++) await page.keyboard.press("ArrowUp");
              saved[activeKey] = { stored: (await page.evaluate((key) => localStorage.getItem(key), activeKey))!, height: (await metrics(page)).top.height };
              assert.notEqual(saved[activeKey].stored, saved[key]!.stored, `${label} the two orders have distinct allocations`);
            }
            assert.ok(Math.abs((await metrics(page)).top.height - saved[activeKey]!.height) <= 1, `${label} changing order restores its own height`);
            for (const [savedKey, value] of Object.entries(saved)) {
              assert.equal(await page.evaluate((key) => localStorage.getItem(key), savedKey), value.stored, `${label} ${savedKey} keeps its independent value`);
            }
          }
          await page.evaluate((key) => localStorage.setItem(key, "2000"), key);
          await page.setViewportSize({ width, height: 300 });
          await page.reload(); await open();
          await footerVisible();
          const clamped = await metrics(page);
          assert.ok(clamped.top.height < 2000, `${label} a short window clamps a tall saved height`);
          assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), "2000", `${label} clamping does not discard the saved allocation`);
          assert.deepEqual(errors, [], `${label} no browser errors`);
          console.log(`PASS ${label}: default, drag, persistence, scroll, keys, folds, reset, touch and short window`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
