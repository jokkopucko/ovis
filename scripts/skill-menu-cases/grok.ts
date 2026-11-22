import assert from "node:assert/strict";
import type { SlashCommand } from "../../shared/protocol.ts";
import { agentBuiltins, type CaseRun } from "../skill-menu-case.ts";

// Grok's `/` skill menu and its skill chips, from the upstream docs only (grok is not installed
// here): its README's slash table, one skill of the person's own, two of the project's and one
// from a plugin, each named `name` as grok types it, and a chat that ends with a user turn invoking
// two of them. Grok has no `$` syntax: "x $" opens nothing.
export const agent = "grok";

/** skills as grok loads them from ~/.grok/skills, ./.grok/skills and a plugin's skills directory */
const SKILLS: Record<string, { description: string; origin: "user" | "project" | "plugin" }> = {
  commit: { origin: "user", description: "Create well-formatted git commits following conventional commit standards. Use when the user wants to commit changes or asks for /commit." },
  "pdf-tools": { origin: "project", description: "Extracts text and tables from PDF files with pdftotext and pdfplumber. Use when a PDF is attached or named; never for scanned pages, which need OCR first." },
  "preview-deploy": { origin: "project", description: "Builds the docs site, deploys it to a throwaway preview host and posts the address on the pull request it was asked from, then tears the host down once that pull request closes" },
  "lint-fix": { origin: "plugin", description: "Runs the team's linter and applies its safe fixes. Use after a refactor." },
};
export const commands: SlashCommand[] = [
  ...agentBuiltins("grok"),
  ...Object.entries(SKILLS).map(([name, { description, origin }]) => ({ name, description, source: "skill" as const, origin })),
];
export const turnText = "please run /commit on the staged changes, then /pdf-tools for the attached brief";
export const chips = ["/commit", "/pdf-tools"];

export const expect = async ({ page, width, box, menu, scenario, log, clear, rowLabels, rowNames, menuGeometry, menuFits, rowsBrief, chipGeometry }: CaseRun): Promise<void> => {
  await scenario(`H: a grok pane opens no menu for "x $", and "/" lists the README's commands and the skills by where they come from (${width}px)`, `h-slash-${width}.png`, async (capture) => {
    await box.fill("x $");
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer-text")?.value === "x $");
    assert.equal(await box.getAttribute("aria-expanded"), "false", "the message box names no open menu");
    assert.equal(await menu.count(), 0, "no .composer-menu");
    await clear();
    await box.fill("/");
    await menu.locator(".menu-item-main").filter({ hasText: /^\/compact$/ }).waitFor();
    assert.equal(await box.getAttribute("aria-expanded"), "true", "the same pane's own / menu opens");
    const rows = await rowNames();
    assert.deepEqual([...rows].sort(), commands.filter((command) => command.visibility !== "agent-hidden").map((command) => command.name).sort(), "every grok command but those grok hides is offered, once");
    const headings = await menu.locator(".menu-heading").allTextContents();
    assert.deepEqual([...headings].sort(), ["Built in", "Plugin skills", "Project skills", "Terminal commands", "Your skills"], `builtins and each origin stand under their own heading: ${headings.join(" | ")}`);
    await menuFits("H");
    await rowsBrief("H");
    await menu.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await capture();
    log(`  ${rows.length} rows, skills: ${Object.keys(SKILLS).join(", ")}`);
  });

  await scenario(`I: "/pdf" ranks pdf-tools first and Enter inserts it (${width}px)`, `i-skill-pick-${width}.png`, async (capture) => {
    await clear();
    await box.fill("/pdf");
    await menu.locator(".menu-item").first().waitFor();
    const rows = await rowNames();
    assert.equal(rows[0], "pdf-tools", `the first row is pdf-tools: ${rows.join(" ")}`);
    assert.equal((await rowLabels())[0], "/pdf-tools", "drawn with the typed /");
    assert.equal((await menuGeometry()).selected, 0, "and it is the highlighted one");
    await menuFits("I");
    await rowsBrief("I");
    await capture();
    await box.press("Enter");
    assert.equal(await box.inputValue(), "/pdf-tools ");
    await menu.waitFor({ state: "detached" });
    log(`  rows: ${rows.join(", ")}; Enter wrote ${JSON.stringify(await box.inputValue())}`);
  });

  await scenario(`J: the user's message shows chips for commit and pdf-tools (${width}px)`, `j-chips-${width}.png`, async (capture) => {
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
