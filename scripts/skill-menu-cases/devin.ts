import assert from "node:assert/strict";
import type { SlashCommand } from "../../shared/protocol.ts";
import { agentBuiltins, type CaseRun } from "../skill-menu-case.ts";

export const agent = "devin";
export const commands: SlashCommand[] = [
  ...agentBuiltins(agent),
  { name: "probe-skill", description: "Probe skill for recorded invocations. Its full description stays in the tooltip.", source: "skill", origin: "project" },
  { name: "docs-release", description: "Writes the documentation release notes from merged pull requests. Use when cutting a release.", source: "skill", origin: "user" },
  { name: "claude:review", description: "Review a change imported from Claude Code and report the findings before committing or publishing the change to the repository", source: "skill", origin: "project" },
  { name: "tools:review", description: "Review changes with the installed plugin. Check correctness and the regression tests.", source: "skill", origin: "plugin" },
];
export const turnText = "/probe-skill hello";
export const chips = ["/probe-skill"];

export const expect = async ({ page, width, box, menu, scenario, clear, rowNames, rowLabels, menuFits, rowsBrief, chipGeometry }: CaseRun): Promise<void> => {
  await scenario(`A: Devin commands and source groups (${width}px)`, `a-slash-${width}.png`, async (capture) => {
    await box.fill("/");
    await menu.locator(".menu-item").first().waitFor();
    assert.deepEqual((await rowNames()).sort(), commands.filter((row) => !row.chatPaletteHidden).map(({ name }) => name).sort());
    const headings = await menu.locator(".menu-heading").allTextContents();
    assert.deepEqual(headings, ["Built in", "Your skills", "Project skills", "Plugin skills", "Terminal commands"]);
    await menuFits("A");
    await rowsBrief("A");
    await menu.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await capture();
  });
  await scenario(`B: source-prefixed query and insertion (${width}px)`, `b-colon-${width}.png`, async (capture) => {
    await clear();
    await box.fill("/claude:rev");
    await menu.locator(".menu-item").first().waitFor();
    assert.deepEqual(await rowLabels(), ["/claude:review"]);
    await menuFits("B");
    await rowsBrief("B");
    await capture();
    await box.press("Enter");
    assert.equal(await box.inputValue(), "/claude:review ");
    await menu.waitFor({ state: "detached" });
  });
  await scenario(`C: Devin has no dollar or inline slash menu (${width}px)`, `c-no-inline-${width}.png`, async (capture) => {
    await clear();
    await box.fill("$probe");
    assert.equal(await box.getAttribute("aria-expanded"), "false");
    assert.equal(await menu.count(), 0);
    await box.fill("please /probe");
    assert.equal(await box.getAttribute("aria-expanded"), "false");
    assert.equal(await menu.count(), 0);
    await capture();
  });
  await scenario(`D: recorded skill invocation chip (${width}px)`, `d-chips-${width}.png`, async (capture) => {
    await clear();
    const turn = page.locator(".chat-turn-user").last();
    await turn.scrollIntoViewIfNeeded();
    await turn.locator(".markdown-skill").first().waitFor();
    const geometry = await chipGeometry();
    assert.deepEqual(geometry.chips, chips);
    assert.ok(geometry.inside && geometry.onScreen && !geometry.overlapping && !geometry.overflowing, JSON.stringify(geometry));
    await capture();
  });
};
