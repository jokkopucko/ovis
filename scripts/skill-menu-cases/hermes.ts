import assert from "node:assert/strict";
import type { SlashCommand } from "../../shared/protocol.ts";
import { agentBuiltins, type CaseRun } from "../skill-menu-case.ts";

export const agent = "hermes";
export const commands: SlashCommand[] = [
  ...agentBuiltins(agent),
  { name: "ship", description: "Run the project's release checks.", source: "user" },
  { name: "probe-skill", description: "Review the attached brief and extract its action items. Preserve links to the original sources when summarizing the findings.", source: "skill", origin: "user" },
  { name: "probe-bundle", description: "Load the review and release skills together.", source: "skill", origin: "user" },
  { name: "probe-project", description: "Check this repository's release checklist.", source: "skill", origin: "project" },
  { name: "probe-bundled", description: "Inspect the codebase with the installed Hermes tools.", source: "skill", origin: "bundled" },
];
export const turnText = "/probe-skill hello, then /probe-bundle for the release";
export const chips = ["/probe-skill", "/probe-bundle"];

export const expect = async ({ page, width, box, menu, scenario, clear, rowNames, rowLabels, menuFits, rowsBrief, chipGeometry, log }: CaseRun): Promise<void> => {
  await scenario(`Hermes lists builtins, quick commands, skills and bundles (${width}px)`, `a-menu-${width}.png`, async (capture) => {
    await box.fill("/");
    await menu.locator(".menu-item").first().waitFor();
    const rows = await rowNames();
    assert.deepEqual([...rows].sort(), commands.filter((row) => !row.chatPaletteHidden).map(({ name }) => name).sort());
    assert.ok(rows.includes("new") && rows.includes("status") && rows.includes("prompt"));
    // Hermes's terminal screens are listed, in the Terminal commands group; start is not a command of its own
    for (const screen of ["model", "resume", "sessions", "config", "agents", "plugins", "skills", "skin"]) assert.ok(rows.includes(screen), screen);
    assert.ok(!rows.includes("start"));
    assert.deepEqual(await menu.locator(".menu-heading").allTextContents(), ["Built in", "User", "Your skills", "Project skills", "Built-in skills", "Terminal commands"]);
    await menuFits("Hermes full menu");
    await rowsBrief("Hermes full menu");
    await menu.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await capture();
    log(`  ${rows.length} rows; all three Hermes skill origins and quick commands`);
  });

  await scenario(`Hermes filters skills and bundles with one-line descriptions (${width}px)`, `b-skills-${width}.png`, async (capture) => {
    await clear();
    await box.fill("/probe");
    await menu.locator(".menu-item").first().waitFor();
    assert.deepEqual((await rowNames()).sort(), ["probe-bundle", "probe-bundled", "probe-project", "probe-skill"]);
    await menuFits("Hermes filtered skills");
    await rowsBrief("Hermes filtered skills");
    await capture();
    await box.fill("/probe-sk");
    await menu.locator(".menu-item").first().waitFor();
    assert.equal((await rowLabels())[0], "/probe-skill");
    await box.press("Enter");
    assert.equal(await box.inputValue(), "/probe-skill ");
    await menu.waitFor({ state: "detached" });
  });

  await scenario(`Hermes has neither inline slash nor dollar invocation (${width}px)`, `c-triggers-${width}.png`, async (capture) => {
    for (const text of ["please /probe", "$probe", "please $probe"]) {
      await clear();
      await box.fill(text);
      assert.equal(await box.getAttribute("aria-expanded"), "false");
      assert.equal(await menu.count(), 0);
    }
    await capture();
  });

  await scenario(`Hermes user messages chip skills and bundles (${width}px)`, `d-chips-${width}.png`, async (capture) => {
    await clear();
    const turn = page.locator(".chat-turn-user").last();
    await turn.locator(".markdown-skill").first().waitFor({ timeout: 5_000 });
    await turn.scrollIntoViewIfNeeded();
    const state = await chipGeometry();
    assert.deepEqual(state.chips, chips);
    assert.ok(state.inside && state.onScreen && !state.overlapping && !state.overflowing, JSON.stringify(state));
    await capture();
    log(`  chips: ${state.chips.join(", ")}`);
  });
};
