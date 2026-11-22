import assert from "node:assert/strict";
import type { SlashCommand } from "../../shared/protocol.ts";
import { agentBuiltins, type CaseRun } from "../skill-menu-case.ts";

export const agent = "omp";
export const commands: SlashCommand[] = [
  ...agentBuiltins(agent),
  { name: "deploy", description: "Deploy the preview site. Verify its health before sharing it.", source: "project" },
  { name: "review-docs", description: "Review the documentation for this release. Explain anything missing. (user)", source: "user" },
  { name: "skill:probe-skill", description: "Check the attached release brief. Use only when asked to probe a release.", source: "skill", origin: "user" },
  { name: "skill:project-check", description: "Check this project's release conventions and report the changes needed before publishing the release notes", source: "skill", origin: "project" },
  { name: "skill:plugin-check", description: "Check the plugin's assets. Keep their full description in the tooltip.", source: "skill", origin: "plugin" },
];
export const turnText = "/skill:probe-skill hello";
export const chips = ["/skill:probe-skill"];

export const expect = async ({ page, width, box, menu, scenario, clear, rowNames, rowLabels, menuFits, rowsBrief, chipGeometry }: CaseRun): Promise<void> => {
  await scenario(`omp slash commands and origin groups (${width}px)`, `slash-${width}.png`, async (capture) => {
    await box.fill("/");
    await menu.locator(".menu-item").first().waitFor();
    assert.deepEqual((await rowNames()).sort(), commands.map((row) => row.name).sort());
    assert.deepEqual(await menu.locator(".menu-heading").allTextContents(), ["Built in", "User", "Project", "Your skills", "Project skills", "Plugin skills", "Terminal commands"]);
    await menuFits("slash");
    await rowsBrief("slash");
    await menu.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await capture();
  });
  await scenario(`omp inline skill query and insertion (${width}px)`, `inline-${width}.png`, async (capture) => {
    await clear();
    await box.fill("please /skill:pro");
    await menu.locator(".menu-item").first().waitFor();
    assert.ok((await rowNames()).includes("skill:probe-skill"));
    assert.ok((await rowLabels()).every((name) => name.startsWith("/skill:")));
    await menuFits("inline");
    await rowsBrief("inline");
    await capture();
    await box.press("Enter");
    assert.equal(await box.inputValue(), "please /skill:probe-skill ");
  });
  await scenario(`omp Python sigil has no skill menu (${width}px)`, `dollar-${width}.png`, async (capture) => {
    await clear();
    await box.fill("$ ");
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer-text")?.value === "$ ");
    assert.equal(await menu.count(), 0);
    assert.equal(await box.getAttribute("aria-expanded"), "false");
    await capture();
  });
  await scenario(`omp skill invocation is a user chip (${width}px)`, `chips-${width}.png`, async (capture) => {
    await clear();
    assert.equal(turnText, "/skill:probe-skill hello");
    const turn = page.locator(".chat-turn-user").last();
    await turn.locator(".markdown-skill").waitFor();
    await turn.scrollIntoViewIfNeeded();
    const state = await chipGeometry();
    assert.deepEqual(state.chips, chips);
    assert.ok(state.inside && state.onScreen && !state.overlapping && !state.overflowing, JSON.stringify(state));
    await capture();
  });
};
