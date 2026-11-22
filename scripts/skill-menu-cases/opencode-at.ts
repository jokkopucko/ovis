import assert from "node:assert/strict";
import type { SlashCommand } from "../../shared/protocol.ts";
import { agentBuiltins, type CaseRun } from "../skill-menu-case.ts";

// An OpenCode v2 pane whose skills are `@skill-id` attachments: the rows carry the `@` trigger,
// so the `@` menu lists them under a Skills heading beside the files, a pick inserts the id, a
// path never matches a skill, and the `/` menu keeps them out.
export const agent = "opencode";
export const commands: SlashCommand[] = [
  ...agentBuiltins(agent),
  { name: "pdf-tools", description: "Extracts text and tables from PDF files. Use when a PDF is attached.", source: "skill", origin: "user", trigger: "@", id: "pdf-tools" },
  { name: "docs-release", description: "Writes release notes from the project's merged changes.", source: "skill", origin: "project", trigger: "@", id: "docs-release" },
  { name: "internal-only", description: "Hidden by OpenCode's own menu.", source: "skill", origin: "bundled", trigger: "@", visibility: "agent-hidden" },
];
export const turnText = "@pdf-tools summarise the attached report";
export const chips = ["@pdf-tools"];
export const widths = [1280, 390, 320] as const;
export const schemes = ["light", "dark"] as const;

export const expect = async ({ page, width, scheme, box, menu, scenario, clear, rowNames, rowLabels, menuFits, rowsBrief, chipGeometry, submits }: CaseRun): Promise<void> => {
  const tag = `${scheme}-${width}`;

  await scenario(`@ lists the skills at ${tag}`, `at-${tag}.png`, async (capture) => {
    // The demo answers in the page, so hold the file response there until we've checked the skill rows.
    const files = await page.evaluateHandle(() => {
      const browserWindow: Window = window;
      const fetch = browserWindow.fetch;
      const { promise, resolve } = Promise.withResolvers<void>();
      browserWindow.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input, location.href);
        if (url.pathname === "/api/pane/files" && url.searchParams.get("q") === "") {
          await promise;
        }
        return fetch(input, init);
      };
      return () => { browserWindow.fetch = fetch; resolve(); };
    });
    try {
      await box.fill("@");
      await menu.locator(".menu-item").first().waitFor();
      assert.deepEqual(await rowLabels(), ["@docs-release", "@pdf-tools"]);
      assert.equal(await page.getByRole("listbox", { name: "Skills and files", exact: true }).count(), 1);
    } finally {
      await files.evaluate((release) => release());
      await files.dispose();
    }
    await menu.locator(".menu-item").nth(2).waitFor();
    assert.deepEqual(await menu.locator(".menu-heading").allTextContents(), ["Skills", "Files"]);
    assert.deepEqual((await rowLabels()).slice(0, 2), ["@docs-release", "@pdf-tools"]);
    assert.ok((await rowLabels()).slice(2).every((label) => !label.startsWith("@")), "the files come after the skills, unprefixed");
    await menuFits("@ skills");
    await rowsBrief("@ skills");
    await capture();
  });

  await scenario(`picking an @ skill inserts its id at ${tag}`, `pick-${tag}.png`, async (capture) => {
    await clear();
    await box.fill("see @pdf");
    await menu.locator(".menu-item").first().waitFor();
    assert.deepEqual(await rowLabels(), ["@pdf-tools"]);
    await menuFits("@ pick");
    await capture();
    await box.press("Enter");
    assert.equal(await box.inputValue(), "see @pdf-tools ");
    await menu.locator(".menu-item").waitFor({ state: "detached" });
    assert.deepEqual(await submits(), []);
  });

  await scenario(`a path is never a skill, and / keeps @ skills out at ${tag}`, null, async () => {
    await clear();
    await box.fill("@src/");
    await menu.locator(".menu-item").first().waitFor();
    assert.deepEqual(await menu.locator(".menu-heading").allTextContents(), ["Files"]);
    assert.ok((await rowLabels()).every((label) => label.startsWith("src/")), "only files match a path");
    await clear();
    await box.fill("/");
    await menu.locator(".menu-item").first().waitFor();
    assert.deepEqual((await rowNames()).sort(), agentBuiltins(agent).map(({ name }) => name).sort());
    await clear();
  });

  await scenario(`@ skill chip at ${tag}`, `chip-${tag}.png`, async (capture) => {
    const turn = page.locator(".chat-turn-user").last();
    await turn.locator(".markdown-skill").first().waitFor();
    await turn.scrollIntoViewIfNeeded();
    const geometry = await chipGeometry();
    assert.deepEqual(geometry.chips, chips);
    assert.ok(geometry.inside && geometry.onScreen && !geometry.overlapping && !geometry.overflowing, JSON.stringify(geometry));
    await capture();
  });
};
