import assert from "node:assert/strict";
import type { SlashCommand } from "../../shared/protocol.ts";
import { agentBuiltins, type CaseRun } from "../skill-menu-case.ts";

// omo's `/` and `$` skill menu and its skill chips: its own builtins with three of its skills and
// two of the person's own, and a chat that ends with a user turn invoking two of them.
export const agent = "omo";

/** omo's own descriptions, as long as omo 5.1.34 ships them, and one of the person's own skills */
const SKILLS: Record<string, { description: string; origin: "bundled" | "user" }> = {
  "ulw-plan": { origin: "bundled", description: "Explore-first planning consultant that writes one decision-complete work plan before coding. Use only on an explicit user request for the ulw-plan workflow or a plan before implementation; it never self-activates on a bare ulw run." },
  "mass-ulw": { origin: "bundled", description: "Drives dependency-ordered child work through the native workflow tool, each phase's stages defined up front in one run, with retry/amend/send recovery. Use when the user asks for mass-ulw, a DAG of tasks, or fan-out work where some tasks must wait on others." },
  "review-work": { origin: "bundled", description: "Post-implementation gate review: run manual QA on the real surface yourself, then launch ONE gate reviewer (never a panel) to audit goal, constraints, code quality, security, missed context, and QA evidence. Use before a PR handoff or when the user explicitly asks to review completed work." },
  "docs-release": { origin: "user", description: "Writes the docs site's release notes from merged PRs. Use when cutting a docs release; never for the app's own changelog." },
  "preview-deploy": { origin: "user", description: "Builds the docs site, deploys it to a throwaway preview host and posts the address on the pull request it was asked from, then tears the host down once that pull request closes" },
};
export const commands: SlashCommand[] = [
  ...agentBuiltins("omo"),
  ...Object.entries(SKILLS).map(([name, { description, origin }]) => ({ name: `skill:${name}`, description, source: "skill" as const, origin })),
];
/** the user turn the omo chat ends with: one skill typed inline, one recorded by omo as its placeholder */
export const turnText = "please run $skill:mass-ulw now, then [skill: ulw-plan] for what is left";
export const chips = ["$skill:mass-ulw", "[skill: ulw-plan]"];

export const expect = async ({ page, width, box, menu, scenario, log, clear, rowLabels, rowNames, menuGeometry, menuFits, rowsBrief, chipGeometry }: CaseRun): Promise<void> => {
  await scenario(`A: "/" lists omo's builtins and its skills (${width}px)`, `a-slash-${width}.png`, async (capture) => {
    await box.fill("/");
    await menu.locator(".menu-item").filter({ hasText: "/compact" }).waitFor();
    const rows = await rowNames();
    assert.ok(rows.includes("skill:mass-ulw") && rows.includes("compact"), `the menu lists skill:mass-ulw and compact: ${rows.join(" ")}`);
    assert.ok(rows.includes("tree"), `the menu lists tree, a terminal command: ${rows.join(" ")}`);
    assert.deepEqual([...rows].sort(), commands.filter((row) => !row.chatPaletteHidden).map(({ name }) => name).sort(), "every offered OmO command and skill is listed once");
    const headings = await menu.locator(".menu-heading").allTextContents();
    assert.ok(headings.includes("Your skills") && headings.includes("Built-in skills") && !headings.includes("Skills"), `yours and omo's stand under their own headings: ${headings.join(" | ")}`);
    assert.ok(headings.indexOf("Your skills") < headings.indexOf("Built-in skills"), "yours first");
    await menuFits("A");
    await rowsBrief("A");
    await menu.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await capture();
    log(`  ${rows.length} rows, skills: ${rows.filter((row) => row.startsWith("skill:")).join(", ")}`);
  });

  await scenario(`B: "/skill:ul" ranks skill:ulw-plan first and Enter inserts it (${width}px)`, `b-slash-pick-${width}.png`, async (capture) => {
    await clear();
    await box.fill("/skill:ul");
    await menu.locator(".menu-item").first().waitFor();
    const rows = await rowNames();
    assert.equal(rows[0], "skill:ulw-plan", `the first row is skill:ulw-plan: ${rows.join(" ")}`);
    assert.equal((await rowLabels())[0], "/skill:ulw-plan", "drawn with the typed /");
    assert.equal((await menuGeometry()).selected, 0, "and it is the highlighted one");
    await menuFits("B");
    await rowsBrief("B");
    await capture();
    await box.press("Enter");
    assert.equal(await box.inputValue(), "/skill:ulw-plan ");
    await menu.waitFor({ state: "detached" });
    log(`  rows: ${rows.join(", ")}; Enter wrote ${JSON.stringify(await box.inputValue())}`);
  });

  await scenario(`C: "run with $mas" offers the skills matching mas and Enter inserts $skill:mass-ulw (${width}px)`, `c-dollar-${width}.png`, async (capture) => {
    await clear();
    await box.fill("run with $mas");
    await menu.locator(".menu-item").first().waitFor();
    const rows = await rowNames();
    assert.deepEqual(rows, Object.keys(SKILLS).filter((name) => name.includes("mas")).map((name) => `skill:${name}`), "exactly the skill rows matching \"mas\"");
    const labels = await rowLabels();
    assert.ok(labels.every((label) => label.startsWith("$skill:")), `drawn with the typed $, as Enter will write them: ${labels.join(" ")}`);
    await menuFits("C");
    await rowsBrief("C");
    await capture();
    await box.press("Enter");
    assert.equal(await box.inputValue(), "run with $skill:mass-ulw ");
    await menu.waitFor({ state: "detached" });
    log(`  rows: ${rows.join(", ")}; Enter wrote ${JSON.stringify(await box.inputValue())}`);
  });

  await scenario(`D: the user's message shows chips for mass-ulw and ulw-plan (${width}px)`, `d-chips-${width}.png`, async (capture) => {
    await clear();
    const turn = page.locator(".chat-turn-user").last();
    await turn.locator(".chat-bubble-body").filter({ hasText: "please run" }).waitFor();
    await turn.scrollIntoViewIfNeeded();
    const drawn = await turn.locator(".markdown-skill").first().waitFor({ timeout: 5_000 }).then(() => true, () => false);
    const state = await chipGeometry();
    await capture();
    assert.ok(drawn, `the bubble shows the text but no .markdown-skill chip: ${JSON.stringify(state)}`);
    assert.deepEqual(state.chips, chips, `a chip for each skill, in the form it was written: ${JSON.stringify(state)}`);
    assert.ok(state.inside && state.onScreen && !state.overlapping && !state.overflowing, `the chips sit whole inside the bubble and the screen, apart: ${JSON.stringify(state)}`);
    log(`  chips: ${state.chips.join(", ")}`);
  });
};
