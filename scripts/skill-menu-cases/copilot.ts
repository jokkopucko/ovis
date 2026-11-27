import assert from "node:assert/strict";
import type { SlashCommand } from "../../shared/protocol.ts";
import { agentBuiltins, type CaseRun } from "../skill-menu-case.ts";

export const agent = "copilot";
export const commands: SlashCommand[] = [
  ...agentBuiltins(agent),
  { name: "probe-skill", description: "Inspect the supplied example. Use for a focused check.", source: "skill", origin: "user" },
  { name: "project-check", description: "Check this project's conventions.", source: "skill", origin: "project" },
];
export const turnText = "/probe-skill hello";
export const chips = ["/probe-skill"];
export const schemes = ["light", "dark"] as const;

export const expect = async ({ page, width, scheme, box, menu, scenario, clear, rowNames, menuFits, rowsBrief, chipGeometry }: CaseRun): Promise<void> => {
  const tag = `${scheme}-${width}`;
  await scenario(`copilot leading slash and groups (${tag})`, `menu-${tag}.png`, async (capture) => {
    await clear();
    await box.fill("/");
    await menu.locator(".menu-item").filter({ hasText: "/probe-skill" }).waitFor();
    const listed = commands.filter((row) => row.visibility !== "agent-hidden" && !row.chatPaletteHidden).map(({ name }) => name).sort();
    assert.deepEqual((await rowNames()).sort(), listed);
    assert.ok(!listed.includes("rewind"));
    assert.deepEqual(await menu.locator(".menu-heading").allTextContents(), ["Built in", "Your skills", "Project skills", "Terminal commands"]);
    await menuFits("copilot menu");
    await rowsBrief("copilot menu");
    await capture();
  });
  await scenario(`copilot picker command is a terminal command (${tag})`, `terminal-${tag}.png`, async (capture) => {
    await clear();
    await box.fill("/mod");
    const model = menu.locator(".menu-item").filter({ hasText: "/model" });
    await model.waitFor();
    assert.deepEqual(await model.locator(".composer-menu-badge").allTextContents(), ["Terminal"]);
    assert.equal(await menu.locator(".menu-item").filter({ hasText: "/fleet" }).locator(".composer-menu-badge").count(), 0);
    await capture();
  });
  await scenario(`copilot filtering and insertion (${tag})`, `insert-${tag}.png`, async (capture) => {
    await clear();
    await box.fill("/probe");
    await menu.locator(".menu-item").first().waitFor();
    assert.deepEqual(await rowNames(), ["probe-skill"]);
    await menuFits("copilot filtered menu");
    await rowsBrief("copilot filtered menu");
    await capture();
    await box.press("Enter");
    assert.equal(await box.inputValue(), "/probe-skill ");
    await menu.waitFor({ state: "detached" });
  });
  await scenario(`copilot invocation chip (${tag})`, `chips-${tag}.png`, async (capture) => {
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
