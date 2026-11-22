import assert from "node:assert/strict";
import type { SlashCommand } from "../../shared/protocol.ts";
import { agentBuiltins, type CaseRun } from "../skill-menu-case.ts";

export const agent = "agy";
export const commands: SlashCommand[] = [
  ...agentBuiltins(agent),
  { name: "probe-skill", description: "Inspect the supplied example. Use for a focused check.", source: "skill", origin: "user" },
  { name: "project-check", description: "Check this project's conventions.", source: "skill", origin: "project" },
  { name: "bundled-check", description: "Run a bundled check.", source: "skill", origin: "bundled" },
  { name: "plugin-check", description: "Run the plugin's check.", source: "skill", origin: "plugin" },
];
export const turnText = "/probe-skill hello";
export const chips = ["/probe-skill"];

export const expect = async ({ page, width, box, menu, scenario, clear, rowNames, menuFits, rowsBrief, chipGeometry }: CaseRun): Promise<void> => {
  await scenario(`agy leading slash and origins (${width}px)`, `menu-${width}.png`, async (capture) => {
    for (const text of ["x $", "x /"]) {
      await box.fill(text);
      assert.equal(await box.getAttribute("aria-expanded"), "false");
      assert.equal(await menu.count(), 0);
    }
    await clear();
    await box.fill("/");
    await menu.locator(".menu-item").filter({ hasText: "/probe-skill" }).waitFor();
    assert.deepEqual((await rowNames()).sort(), commands.map(({ name }) => name).sort());
    assert.deepEqual(await menu.locator(".menu-heading").allTextContents(), [
      "Built in", "Your skills", "Project skills", "Built-in skills", "Plugin skills", "Terminal commands",
    ]);
    await menuFits("agy menu");
    await rowsBrief("agy menu");
    await menu.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await capture();
  });
  await scenario(`agy filtering and insertion (${width}px)`, `insert-${width}.png`, async (capture) => {
    await clear();
    await box.fill("/probe");
    await menu.locator(".menu-item").first().waitFor();
    assert.deepEqual(await rowNames(), ["probe-skill"]);
    await menuFits("agy filtered menu");
    await rowsBrief("agy filtered menu");
    await capture();
    await box.press("Enter");
    assert.equal(await box.inputValue(), "/probe-skill ");
    await menu.waitFor({ state: "detached" });
  });
  await scenario(`agy recorded invocation chip (${width}px)`, `chips-${width}.png`, async (capture) => {
    await clear();
    const turn = page.locator(".chat-turn-user").last();
    await turn.locator(".markdown-skill").waitFor();
    await turn.scrollIntoViewIfNeeded();
    const geometry = await chipGeometry();
    assert.deepEqual(geometry.chips, chips);
    assert.ok(geometry.inside && geometry.onScreen && !geometry.overlapping && !geometry.overflowing, JSON.stringify(geometry));
    await capture();
  });
};
