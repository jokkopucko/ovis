import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appFaces } from "./app-faces.ts";
import { withDemoBrowser } from "./demo-browser.ts";

await withDemoBrowser({ tempPrefix: "ovis-header-context-", prefix: "/" }, async ({ newContext, baseUrl, evidence }) => {
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    const context = await newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390 });
    try {
      await context.addInitScript(({ width, theme }) => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme }));
        if (width === 1440) sessionStorage.setItem("ovis:split", JSON.stringify({ other: { machineId: "local", paneId: "w1C:p1" }, bSide: "right", active: "a" }));
      }, { width, theme });
      for (const pane of [
        { id: "w1H:p1", title: "Fix the flaky retry test", agent: "Claude Code", workspace: "flaky-retry-test" },
        { id: "w1D:p1", title: "Guard the export button", agent: "Codex", workspace: "export-guard" },
      ]) {
        const page = await context.newPage();
        try {
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`${baseUrl}?pane=${encodeURIComponent(pane.id)}`);
          const title = page.locator(".context-title-text");
          await title.waitFor();
          await appFaces(page);
          const snapshot = await title.ariaSnapshot();
          const full = `${pane.agent} · workstation · ${pane.workspace} · ${pane.title} · /home/demo/.herdr/worktrees/checkout-api/${pane.workspace}`;
          const label = `${width}-${theme}-${pane.workspace}`;
          if (evidence) {
            writeFileSync(join(evidence, `${label}.txt`), snapshot);
            await page.screenshot({ path: join(evidence, `${label}.png`), animations: "disabled" });
          }
          assert.ok(snapshot.includes(`group "${full}"`), `${label}: accessible title names the agent, PC, workspace, title and complete path: ${snapshot}`);
          assert.equal(await title.textContent(), pane.title, "visible text is unchanged");
          assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1, "the copy lane's hidden h1 stays the only first-level heading");
          assert.equal(await page.locator("h1.visually-hidden").textContent(), pane.title);
          await page.locator(".context-title .agent-mark svg").waitFor();
          const centres = await page.locator("header.app-header").evaluate((header) => {
            const box = header.getBoundingClientRect();
            const style = getComputedStyle(header);
            const line = (box.top + parseFloat(style.paddingTop) + box.bottom - parseFloat(style.borderBottomWidth)) / 2;
            return [...header.querySelectorAll(".context-title .agent-mark svg, .header-side .icon-button")]
              .filter((element) => element.getClientRects().length > 0)
              .map((element) => {
                const drawn = element.getBoundingClientRect();
                return { control: element.closest(".agent-mark") ? "agent mark" : element.getAttribute("aria-label"), offset: Math.round((drawn.top + drawn.height / 2 - line) * 100) / 100 };
              });
          });
          if (width === 1440) assert.ok(centres.some(({ control }) => control === "Hide workspace list"), `${label}: the sidebar's top row is in the header`);
          assert.deepEqual(centres.filter(({ offset }) => Math.abs(offset) > 0.25), [], `${label}: the agent's mark and the sidebar's top row are centred on the header's line`);
          assert.deepEqual(errors, []);
          console.log(`PASS ${label}: full accessible context and one unchanged h1; the mark and the sidebar's top row on the header's line`);
        } finally { await page.close(); }
      }
    } finally { await context.close(); }
  }
});
