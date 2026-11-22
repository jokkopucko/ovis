import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "../../server/commands.ts";
import type { CaseRun } from "../skill-menu-case.ts";

export const agent = "gjc";
const home = mkdtempSync(join(tmpdir(), "gjc-menu-case-"));
const cwd = join(home, "docs");
const agentDir = join(home, ".gjc", "agent");
mkdirSync(join(cwd, ".git"), { recursive: true });
for (const [root, name, description] of [
  [join(agentDir, "skills"), "pdf-tools", "Extracts text and tables from PDF files. Use when reviewing an attached brief."],
  [join(cwd, ".gjc", "skills"), "docs-release", "Writes the project's release notes from merged changes. Keeps links to each change."],
] as const) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nFixture body\n`);
}
mkdirSync(join(agentDir, "commands"), { recursive: true });
writeFileSync(join(agentDir, "commands", "omg:setup.md"), "---\ndescription: Inspect the local installation. Never changes configuration.\n---\nInspect\n");
export const commands = paneCommands(agent, cwd, home, { environ: [`GJC_CODING_AGENT_DIR=${agentDir}`] });
rmSync(home, { recursive: true, force: true });
export const turnText = "/skill:pdf-tools review the brief, then /skill:docs-release for the notes";
export const chips = ["/skill:pdf-tools", "/skill:docs-release"];

export const expect = async ({ page, width, box, menu, scenario, log, clear, rowNames, rowLabels, menuFits, rowsBrief, chipGeometry }: CaseRun): Promise<void> => {
  await scenario(`gjc opens only a leading slash menu (${width}px)`, `a-menu-${width}.png`, async (capture) => {
    for (const text of ["x $", "please /skill:pdf"]) {
      await box.fill(text);
      assert.equal(await box.getAttribute("aria-expanded"), "false");
      assert.equal(await menu.count(), 0);
    }
    await clear();
    await box.fill("/");
    await menu.locator(".menu-item").first().waitFor();
    assert.deepEqual((await rowNames()).sort(), commands.map((command) => command.name).sort());
    assert.ok((await rowNames()).includes("tree"));
    await menuFits("slash");
    await rowsBrief("slash");
    await menu.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await capture();
    log(`  origin groups: ${(await menu.locator(".menu-heading").allTextContents()).join(", ")}`);
  });

  await scenario(`gjc skill origins and descriptions (${width}px)`, `b-origins-${width}.png`, async (capture) => {
    await clear();
    await box.fill("/");
    await menu.locator(".menu-item").first().waitFor();
    const headings = await menu.locator(".menu-heading").allTextContents();
    assert.deepEqual(headings, ["Built in", "User", "Your skills", "Project skills", "Built-in skills", "Terminal commands"]);
    await menuFits("origins");
    await rowsBrief("origins");
    await menu.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await capture();
  });

  await scenario(`gjc colon query and Enter insertion (${width}px)`, `c-colon-${width}.png`, async (capture) => {
    await clear();
    await box.fill("/skill:pd");
    await menu.locator(".menu-item").first().waitFor();
    assert.equal((await rowNames())[0], "skill:pdf-tools");
    assert.equal((await rowLabels())[0], "/skill:pdf-tools");
    await menuFits("colon");
    await rowsBrief("colon");
    await capture();
    await box.press("Enter");
    assert.equal(await box.inputValue(), "/skill:pdf-tools ");
    await menu.waitFor({ state: "detached" });
    await clear();
    await box.fill("/omg:se");
    await menu.locator(".menu-item").first().waitFor();
    assert.equal((await rowNames())[0], "omg:setup");
    await box.press("Enter");
    assert.equal(await box.inputValue(), "/omg:setup ");
  });

  await scenario(`gjc user invocation chips (${width}px)`, `d-chips-${width}.png`, async (capture) => {
    await clear();
    const turn = page.locator(".chat-turn-user").last();
    await turn.locator(".markdown-skill").first().waitFor();
    await turn.scrollIntoViewIfNeeded();
    const geometry = await chipGeometry();
    assert.deepEqual(geometry.chips, chips);
    assert.ok(geometry.inside && geometry.onScreen && !geometry.overlapping && !geometry.overflowing, JSON.stringify(geometry));
    await capture();
  });
};
