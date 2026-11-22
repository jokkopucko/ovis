import assert from "node:assert/strict";
import type { SlashCommand } from "../../shared/protocol.ts";
import { agentBuiltins, type CaseRun } from "../skill-menu-case.ts";

export const agent = "claude";
export const commands: SlashCommand[] = [
  ...agentBuiltins(agent),
  { name: "probe-skill", description: "Run the probe skill. More detail stays in the tooltip.", source: "skill", origin: "user" },
  { name: "deploy", description: "Deploy this project.", source: "skill", origin: "project" },
  { name: "tools:check", description: "Check the project. Inspect its current state.", source: "skill", origin: "plugin" },
];
export const turnText = "/probe-skill hello";
export const chips = ["/probe-skill"];

export const expect = async ({ page, width, box, menu, scenario, clear, rowNames, menuFits, rowsBrief, chipGeometry }: CaseRun): Promise<void> => {
  await scenario(`origin groups at ${width}px`, `origins-${width}.png`, async (capture) => {
    await box.fill("/");
    await menu.locator(".menu-item").first().waitFor();
    assert.deepEqual((await rowNames()).sort(), commands.filter((command) => command.visibility !== "agent-hidden").map(({ name }) => name).sort());
    const headings = await menu.locator(".menu-heading").allTextContents();
    for (const heading of ["Your skills", "Project skills", "Plugin skills"]) assert.ok(headings.includes(heading), headings.join(", "));
    assert.ok(!headings.includes("Built-in skills"));
    await menuFits("origins");
    await rowsBrief("origins");
    await menu.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await capture();
  });
  await scenario(`plugin colon query at ${width}px`, `plugin-${width}.png`, async (capture) => {
    await clear();
    await box.fill("/tools:ch");
    await menu.locator(".menu-item").first().waitFor();
    assert.deepEqual(await rowNames(), ["tools:check"]);
    await menuFits("plugin");
    await rowsBrief("plugin");
    await capture();
    await box.press("Enter");
    assert.equal(await box.inputValue(), "/tools:check ");
  });
  await scenario(`inline slash retained at ${width}px`, `inline-${width}.png`, async (capture) => {
    await clear();
    await box.fill("please run /probe");
    await menu.locator(".menu-item").first().waitFor();
    assert.deepEqual(await rowNames(), ["probe-skill"]);
    await menuFits("inline");
    await capture();
    await box.press("Enter");
    assert.equal(await box.inputValue(), "please run /probe-skill ");
  });
  await scenario(`user skill chip at ${width}px`, `chip-${width}.png`, async (capture) => {
    await clear();
    await page.locator(".chat-turn-user").last().locator(".markdown-skill").waitFor();
    const geometry = await chipGeometry();
    assert.deepEqual(geometry.chips, chips);
    assert.ok(geometry.inside && geometry.onScreen && !geometry.overlapping && !geometry.overflowing, JSON.stringify(geometry));
    await capture();
  });
};
