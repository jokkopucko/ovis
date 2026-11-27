import assert from "node:assert/strict";
import type { SlashCommand } from "../../shared/protocol.ts";
import { agentBuiltins, type CaseRun } from "../skill-menu-case.ts";

export const agent = "codex";
export const commands: SlashCommand[] = [
  ...agentBuiltins(agent),
  { name: "probe-skill", description: "Check the selected files. Report any issues.", source: "skill", trigger: "$", origin: "user" },
  { name: "repo-check", description: "Check this project's conventions.", source: "skill", trigger: "$", origin: "project" },
  { name: "skill-creator", description: "Create a reusable skill. Explain its inputs.", source: "skill", trigger: "$", origin: "bundled" },
  { name: "plugin-check", description: "Check the plugin's configuration.", source: "skill", trigger: "$", origin: "plugin" },
  { name: "prompts:review", description: "Review the selected changes.", source: "user" },
];
export const turnText = "please run $probe-skill hello";
export const chips = ["$probe-skill"];

export const expect = async ({ page, width, box, menu, scenario, clear, rowLabels, rowNames, menuFits, rowsBrief, chipGeometry }: CaseRun): Promise<void> => {
  await scenario(`A: slash offers commands without skill rows (${width}px)`, `a-slash-${width}.png`, async (capture) => {
    await box.fill("/");
    await menu.locator(".menu-item").first().waitFor();
    assert.deepEqual((await rowNames()).sort(), commands.filter((command) => command.source !== "skill" && command.visibility !== "agent-hidden" && command.name !== "plan").map((command) => command.name).sort());
    await menuFits("A");
    await rowsBrief("A");
    await menu.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await capture();
  });

  await scenario(`B: namespaced saved prompt inserts with slash (${width}px)`, `b-prompts-${width}.png`, async (capture) => {
    await clear();
    await box.fill("/prompts:rev");
    await menu.locator(".menu-item").first().waitFor();
    assert.deepEqual(await rowLabels(), ["/prompts:review"]);
    await menuFits("B");
    await rowsBrief("B");
    await capture();
    await box.press("Enter");
    assert.equal(await box.inputValue(), "/prompts:review ");
    await menu.waitFor({ state: "detached" });
  });

  await scenario(`C: mid-sentence dollar inserts a bare skill (${width}px)`, `c-dollar-${width}.png`, async (capture) => {
    await clear();
    await box.fill("run with $probe");
    await menu.locator(".menu-item").first().waitFor();
    assert.deepEqual(await rowLabels(), ["$probe-skill"]);
    await menuFits("C");
    await rowsBrief("C");
    await capture();
    await box.press("Enter");
    assert.equal(await box.inputValue(), "run with $probe-skill ");
    await menu.waitFor({ state: "detached" });
  });

  await scenario(`D: system skills appear under Built-in (${width}px)`, `d-system-${width}.png`, async (capture) => {
    await clear();
    await box.fill("$");
    await menu.locator(".menu-item").first().waitFor();
    assert.deepEqual((await rowLabels()).sort(), commands.filter((command) => command.source === "skill").map((command) => `$${command.name}`).sort());
    const headings = await menu.locator(".menu-heading").allTextContents();
    assert.deepEqual(headings, ["Your skills", "Project skills", "Built-in skills", "Plugin skills"]);
    assert.equal(await menu.locator('[data-origin="bundled"] .menu-item-main').textContent(), "$skill-creator");
    await menuFits("D");
    await rowsBrief("D");
    await capture();
  });

  await scenario(`E: the user's invocation is a chip (${width}px)`, `e-chips-${width}.png`, async (capture) => {
    await clear();
    const turn = page.locator(".chat-turn-user").last();
    await turn.locator(".markdown-skill").waitFor();
    await turn.scrollIntoViewIfNeeded();
    const geometry = await chipGeometry();
    assert.deepEqual(geometry.chips, chips);
    assert.ok(geometry.inside && geometry.onScreen && !geometry.overlapping && !geometry.overflowing, JSON.stringify(geometry));
    await capture();
  });

  await scenario(`F: a hidden command names a command under its own trigger only (${width}px)`, null, async () => {
    const unmatched = page.locator(".chat-inline-state", { hasText: "No command matches" });
    await clear();
    // Codex's menu hides /apps, which still runs when typed; $apps names no skill (#3458)
    await box.fill("$apps");
    await unmatched.waitFor();
    await box.fill("/apps");
    await unmatched.waitFor({ state: "detached" });
    await clear();
  });
};
