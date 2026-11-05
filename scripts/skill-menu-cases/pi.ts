import assert from "node:assert/strict";
import type { SlashCommand } from "../../shared/protocol.ts";
import { agentBuiltins, type CaseRun } from "../skill-menu-case.ts";

// pi's `/` menu and its skill chips: pi's own builtins, one of the person's prompt templates and
// three of their skills, named `skill:<name>` as pi types them, and a chat that ends with a user
// turn invoking two of them. pi has no `$` syntax: "x $" opens nothing.
export const agent = "pi";

/** the person's own skills, as pi loads them from ~/.pi/agent/skills and ~/.agents/skills */
const SKILLS: Record<string, { description: string; origin: "user" }> = {
  "pdf-tools": { origin: "user", description: "Extracts text and tables from PDF files with pdftotext and pdfplumber. Use when a PDF is attached or named; never for scanned pages, which need OCR first." },
  "docs-release": { origin: "user", description: "Writes the docs site's release notes from merged PRs. Use when cutting a docs release; never for the app's own changelog." },
  // one sentence with no full stop, too long for the row: nothing is cut from the text, the row cuts it, and the tooltip still holds it
  "preview-deploy": { origin: "user", description: "Builds the docs site, deploys it to a throwaway preview host and posts the address on the pull request it was asked from, then tears the host down once that pull request closes" },
};
export const commands: SlashCommand[] = [
  ...agentBuiltins("pi"),
  // a prompt template from ~/.pi/agent/prompts: a command of the person's own, listed under User with no origin icon
  { name: "review", description: "Review staged git changes", source: "user" },
  ...Object.entries(SKILLS).map(([name, { description, origin }]) => ({ name: `skill:${name}`, description, source: "skill" as const, origin })),
];
export const turnText = "please run /skill:pdf-tools on the attached brief, then /skill:docs-release for the notes";
export const chips = ["/skill:pdf-tools", "/skill:docs-release"];

export const expect = async ({ page, width, box, menu, scenario, log, clear, rowLabels, rowNames, menuGeometry, menuFits, rowsBrief, chipGeometry }: CaseRun): Promise<void> => {
  await scenario(`E: a pi pane opens no menu for "x $", and "/" lists its commands by where they come from (${width}px)`, `e-slash-${width}.png`, async (capture) => {
    await box.fill("x $");
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer-text")?.value === "x $");
    assert.equal(await box.getAttribute("aria-expanded"), "false", "the message box names no open menu");
    assert.equal(await menu.count(), 0, "no .composer-menu");
    await clear();
    await box.fill("/");
    await menu.locator(".menu-item").filter({ hasText: "/compact" }).waitFor();
    assert.equal(await box.getAttribute("aria-expanded"), "true", "the same pane's own / menu opens");
    const rows = await rowNames();
    assert.ok(rows.includes("tree"), `the menu lists tree, a terminal command: ${rows.join(" ")}`);
    // /debug and the other builtins pi's own menu hides stay out of it, though pi runs them when typed
    assert.deepEqual([...rows].sort(), commands.filter((command) => command.visibility !== "agent-hidden").map((command) => command.name).sort(), "every pi command but those pi hides is offered, once");
    assert.ok(commands.some((command) => command.name === "debug" && command.visibility === "agent-hidden"), "pi's hidden builtins are still in its command list");
    const headings = await menu.locator(".menu-heading").allTextContents();
    assert.deepEqual(headings, ["Built in", "User", "Your skills", "Terminal commands"], "pi's builtins, the person's template, their skills and the terminal commands under their own headings");
    await menuFits("E");
    await rowsBrief("E");
    // the skills end the list: the capture shows their heading, icons and rows after the last builtins
    await menu.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await capture();
    log(`  ${rows.length} rows, skills: ${rows.filter((row) => row.startsWith("skill:")).join(", ")}`);
  });

  await scenario(`F: "/skill:pd" stays open past the colon, ranks skill:pdf-tools first and Enter inserts it (${width}px)`, `f-skill-colon-${width}.png`, async (capture) => {
    await clear();
    await box.fill("/skill:pd");
    await menu.locator(".menu-item").first().waitFor();
    assert.equal(await box.getAttribute("aria-expanded"), "true", "the menu is still open after the colon");
    const rows = await rowNames();
    assert.equal(rows[0], "skill:pdf-tools", `the first row is skill:pdf-tools: ${rows.join(" ")}`);
    assert.equal((await rowLabels())[0], "/skill:pdf-tools", "drawn with the typed /");
    assert.equal((await menuGeometry()).selected, 0, "and it is the highlighted one");
    await menuFits("F");
    await rowsBrief("F");
    await capture();
    await box.press("Enter");
    assert.equal(await box.inputValue(), "/skill:pdf-tools ");
    await menu.waitFor({ state: "detached" });
    log(`  rows: ${rows.join(", ")}; Enter wrote ${JSON.stringify(await box.inputValue())}`);
  });

  await scenario(`G: the user's message shows chips for pdf-tools and docs-release (${width}px)`, `g-chips-${width}.png`, async (capture) => {
    await clear();
    const turn = page.locator(".chat-turn-user").last();
    await turn.locator(".chat-bubble-body").filter({ hasText: "please run" }).waitFor();
    await turn.scrollIntoViewIfNeeded();
    // the matcher arrives with the pane's command list: a bounded wait, not a fixed one
    const drawn = await turn.locator(".markdown-skill").first().waitFor({ timeout: 5_000 }).then(() => true, () => false);
    const state = await chipGeometry();
    await capture();
    assert.ok(drawn, `the bubble shows the text but no .markdown-skill chip: ${JSON.stringify(state)}`);
    assert.deepEqual(state.chips, chips, `a chip for each skill, in the form it was written: ${JSON.stringify(state)}`);
    assert.ok(state.inside && state.onScreen && !state.overlapping && !state.overflowing, `the chips sit whole inside the bubble and the screen, apart: ${JSON.stringify(state)}`);
    log(`  chips: ${state.chips.join(", ")}`);
  });
};
