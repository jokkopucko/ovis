import assert from "node:assert/strict";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { appContext } from "./app-context.ts";
import { appFaces } from "./app-faces.ts";
import { withDemoBrowser } from "./demo-browser.ts";

// On the
// unmodified app over the demo's fixture transport, at a desktop's width and a touch tablet's
// (the header row starts at 769px), every tab's mark is centred on its tab, and an agent's mark
// box is as tall as its logo. All files and HTTP traffic stay in this disposable, loopback-only
// app and no herdr session is opened. Screenshots go to UI_EVIDENCE_DIR when it is set.
const PANE = panes.api;
const CASES = [
  { name: "desktop", width: 1280, touch: false, shell: true },
  { name: "tablet", width: 800, touch: true, shell: false },
] as const;

interface TabMark { name: string; agent: boolean; markOffset: number; boxHeight: number; logoHeight: number }

async function check(browser: Browser, baseUrl: string, evidence: string | null, testCase: (typeof CASES)[number]): Promise<void> {
  const context = await appContext(browser, { viewport: { width: testCase.width, height: 900 }, hasTouch: testCase.touch });
  try {
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", alertsOn: false })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseUrl}?pane=${encodeURIComponent(PANE)}`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await page.locator(".header-tabs .tab-strip-agent .agent-mark svg").first().waitFor();
    if (testCase.shell) await page.locator(".header-tabs .tab-strip-agent.is-shell svg").first().waitFor();
    await appFaces(page);

    const marks = await page.locator(".header-tabs .tab-strip-tab").evaluateAll((tabs): TabMark[] => tabs.flatMap((tab) => {
      const logo = tab.querySelector(".tab-strip-agent svg");
      if (!logo) return [];
      const box = tab.querySelector(".tab-strip-agent .agent-mark") ?? logo;
      const middle = (rect: DOMRect) => rect.top + rect.height / 2;
      const drawn = logo.getBoundingClientRect();
      return [{
        name: tab.querySelector(".tab-strip-label")?.textContent ?? "",
        agent: tab.querySelector(".agent-mark") !== null,
        markOffset: Math.round((middle(drawn) - middle(tab.getBoundingClientRect())) * 10) / 10,
        boxHeight: box.getBoundingClientRect().height,
        logoHeight: drawn.height,
      }];
    }));
    assert.ok(marks.some((mark) => mark.agent), `${testCase.name}: an agent's tab is drawn`);
    if (testCase.shell) assert.ok(marks.some((mark) => !mark.agent), `${testCase.name}: a shell's tab is drawn`);
    const offCentre = marks.filter((mark) => Math.abs(mark.markOffset) > 0.5);
    assert.deepEqual(offCentre, [], `${testCase.name} ${testCase.width}px: every tab's mark is centred on its tab`);
    const tallBoxes = marks.filter((mark) => mark.agent && Math.abs(mark.boxHeight - mark.logoHeight) > 0.5);
    assert.deepEqual(tallBoxes, [], `${testCase.name} ${testCase.width}px: an agent's mark box is as tall as its logo, no line box around it`);
    assert.deepEqual(errors, []);
    if (evidence !== null) {
      const row = (await page.locator(".header-tabs").boundingBox())!;
      await page.screenshot({ path: join(evidence, `tab-agent-mark-${testCase.name}.png`), clip: { x: row.x, y: row.y, width: Math.min(row.width, 600), height: row.height } });
    }
    console.log(`PASS ${testCase.width}px ${testCase.name}: ${marks.length} tab marks centred on their tabs`);
  } finally { await context.close(); }
}

await withDemoBrowser({ tempPrefix: "herdr-tab-agent-mark-demo-" }, async ({ browser, baseUrl, evidence }) => {
  for (const testCase of CASES) await check(browser, baseUrl, evidence, testCase);
});
