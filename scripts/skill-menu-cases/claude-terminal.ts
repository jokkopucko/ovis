import assert from "node:assert/strict";
import type { SlashCommand } from "../../shared/protocol.ts";
import type { CaseRun } from "../skill-menu-case.ts";

export const agent = "claude";
const builtin = (name: string, description: string, rest: Partial<SlashCommand> = {}): SlashCommand => ({ name, description, source: "builtin", ...rest });
export const commands: SlashCommand[] = [
  builtin("compact", "Compact conversation context", { forms: [{ match: "bare", interaction: "none" }, { match: "other", interaction: "none" }] }),
  builtin("config", "Open configuration", { visibility: "terminal", forms: [{ match: "bare", interaction: "terminal" }] }),
  builtin("cost", "Show token usage and cost", { forms: [{ match: "bare", interaction: "terminal" }] }),
  builtin("doctor", "Check the installation", { forms: [{ match: "bare", interaction: "terminal" }] }),
  builtin("help", "Show available commands. Lists every command with its description.", { forms: [{ match: "bare", interaction: "terminal" }] }),
  builtin("model", "Choose a model", { forms: [{ match: "bare", interaction: "dialog", dialog: "model" }, { match: "other", interaction: "none" }] }),
  builtin("resume", "Resume a conversation by ID or name", { visibility: "terminal", forms: [{ match: "bare", interaction: "terminal" }] }),
  builtin("status", "Show session status", { forms: [{ match: "bare", interaction: "terminal" }] }),
  builtin("terminal-setup", "Configure terminal integration", { forms: [{ match: "bare", interaction: "terminal" }] }),
  builtin("heapdump", "Write a heap snapshot", { visibility: "agent-hidden", forms: [{ match: "bare", interaction: "terminal" }] }),
  { name: "deploy", description: "Deploy this project.", source: "skill", origin: "project" },
];
export const turnText = "/deploy staging";
export const chips = ["/deploy"];
export const widths = [1280, 390, 320] as const;
export const schemes = ["light", "dark"] as const;
// a phone's Return breaks the line: the 390 phone sends with Send, the 320 one chose Enter sends
export const enterSendsAt = [320] as const;
const TERMINAL_ROWS = ["config", "cost", "doctor", "help", "resume", "status", "terminal-setup"];

export const expect = async ({ page, width, scheme, box, menu, scenario, clear, rowNames, menuFits, rowsBrief, submits }: CaseRun): Promise<void> => {
  const tag = `${scheme}-${width}`;
  const send = page.getByRole("button", { name: "Send message", exact: true });
  const returnSends = width > 480 || (enterSendsAt as readonly number[]).includes(width);
  // the Chat lens, and a terminal command's peek over it: the chat stays mounted under the grid
  const chat = page.locator(".terminal-stack.is-chat:not(.is-peek)");
  const peek = page.locator(".terminal-stack.is-chat.is-peek");
  const hint = page.locator(".terminal-banner-command");
  const back = async (): Promise<void> => {
    await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
    await chat.waitFor();
  };

  await scenario(`terminal group at ${tag}`, `group-${tag}.png`, async (capture) => {
    await box.fill("/");
    await menu.locator(".menu-item").first().waitFor();
    assert.deepEqual(await menu.locator(".menu-heading").allTextContents(), ["Built in", "Project skills", "Terminal commands"]);
    // the terminal group is listed last, each row with its badge; the hidden row is nowhere
    const groups = menu.locator(".composer-menu-group");
    const last = groups.nth((await groups.count()) - 1);
    assert.deepEqual(await last.locator(".menu-item-main").allTextContents(), TERMINAL_ROWS.map((name) => `/${name}`));
    assert.equal(await last.locator(".menu-item .composer-menu-badge").count(), TERMINAL_ROWS.length);
    assert.deepEqual(await last.locator(".composer-menu-badge").allTextContents(), TERMINAL_ROWS.map(() => "Terminal"));
    assert.equal(await menu.locator(".composer-menu-badge").count(), TERMINAL_ROWS.length);
    assert.deepEqual((await rowNames()).sort(), commands.filter((command) => command.visibility !== "agent-hidden").map(({ name }) => name).sort());
    await menuFits("terminal group");
    await rowsBrief("terminal group");
    // the badge stands whole beside the name: neither is cut, whatever the width
    const cut = await menu.locator(".composer-menu-badge").evaluateAll((badges) => badges.filter((badge) => badge.scrollWidth > badge.clientWidth + 1).length);
    assert.equal(cut, 0, "no badge is cut");
    await menu.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await capture();
  });

  await scenario(`picking inserts without sending at ${tag}`, `pick-${tag}.png`, async (capture) => {
    await clear();
    await box.fill("/conf");
    await menu.locator(".menu-item").first().waitFor();
    // /config by its name first; /terminal-setup follows, found by its description ("Configure ")
    const listed = await rowNames();
    assert.equal(listed[0], "config");
    assert.equal(await menu.locator(".menu-item .composer-menu-badge").count(), listed.filter((name) => TERMINAL_ROWS.includes(name)).length, "a typed query keeps the badge on the rows");
    await box.press("Enter");
    assert.equal(await box.inputValue(), "/config ");
    assert.deepEqual(await submits(), []);
    assert.equal(await page.locator(".composer-notices").count(), 0);
    await capture();
  });

  await scenario(`${returnSends ? "Enter" : "Send"} sends then opens a peek at ${tag}`, `terminal-${tag}.png`, async (capture) => {
    if (returnSends) await box.press("Enter");
    else await send.click();
    await hint.waitFor();
    assert.equal(await chat.count(), 0);
    assert.equal(await peek.count(), 1, "the terminal shows over the chat, which stays mounted");
    assert.equal(await hint.getByText("Chat may come back when you close it", { exact: true }).count(), 1, "the head says Claude's /config may come back by itself");
    assert.deepEqual(await submits(), ["/config "]);
    const geometry = await hint.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const buttons = [...node.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
      return {
        inside: box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
        overlay: getComputedStyle(node.parentElement!).position === "absolute",
        overlap: buttons.some((a, i) => buttons.slice(i + 1).some((b) => Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top))),
      };
    });
    assert.ok(geometry.inside && geometry.overlay && !geometry.overlap, JSON.stringify(geometry));
    await capture();
  });

  await scenario(`return shows one quiet row at ${tag}`, `returned-${tag}.png`, async (capture) => {
    await hint.getByRole("button", { name: "Back to Chat", exact: true }).click();
    await chat.waitFor();
    await page.locator(".chat-terminal-command").waitFor();
    assert.equal(await box.inputValue(), "");
    const row = page.locator(".chat-terminal-command");
    assert.equal(await row.count(), 1);
    assert.equal(await row.locator(".chat-outcome, .chat-bubble, .chat-outcome-preview").count(), 0);
    assert.equal(await row.getByRole("button", { name: "Open Terminal", exact: true }).count(), 1);
    await capture();
    // the row's Open Terminal opens a peek the reader ends by hand, and sends nothing
    await row.getByRole("button", { name: "Open Terminal", exact: true }).click();
    await peek.waitFor();
    await hint.getByText("/config ran", { exact: true }).waitFor();
    assert.equal(await hint.getByText("Chat may come back when you close it", { exact: true }).count(), 0);
    assert.deepEqual(await submits(), ["/config "]);
    await hint.getByRole("button", { name: "Back to Chat", exact: true }).click();
    await chat.waitFor();
    assert.equal(await hint.count(), 0, "the chat's return clears the head");
  });

  await scenario(`typed send and Keep Terminal at ${tag}`, `kept-${tag}.png`, async (capture) => {
    await page.locator('.composer-status[data-status="done"], .composer-status[data-status="idle"]').waitFor();
    await box.fill("/config");
    await send.click();
    await hint.waitFor();
    // shown, not only laid out: under the chat the grid keeps its box with content-visibility hidden
    assert.ok(await page.locator(".terminal-stack.is-peek .xterm-screen").isVisible(), "the terminal grid shows over the chat");
    await hint.getByRole("button", { name: "Keep Terminal", exact: true }).click();
    await page.locator(".terminal-stack:not(.is-chat) .xterm-screen").waitFor();
    assert.equal(await hint.count(), 0, "the terminal lens has no peek head");
    assert.deepEqual(await submits(), ["/config ", "/config"]);
    await capture();
    await back();
  });

  await scenario(`/resume opens Earlier sessions without a send at ${tag}`, `resume-${tag}.png`, async (capture) => {
    await clear();
    await box.fill("/res");
    await menu.locator(".menu-item").first().waitFor();
    await box.press("Enter");
    await page.locator(".session-modal").waitFor();
    assert.deepEqual(await submits(), ["/config ", "/config"]);
    await capture();
    await page.keyboard.press("Escape");
    await page.locator(".session-modal").waitFor({ state: "detached" });
    await send.click();
    await page.locator(".session-modal").waitFor();
    assert.deepEqual(await submits(), ["/config ", "/config"]);
    await page.keyboard.press("Escape");
  });

  await scenario(`hidden commands still send normally at ${tag}`, `hidden-${tag}.png`, async (capture) => {
    await clear();
    await box.fill("/heapdump");
    assert.equal(await menu.count(), 0);
    await send.click();
    await page.locator(".chat-bubble-body", { hasText: "/heapdump" }).first().waitFor();
    assert.equal(await chat.count(), 1);
    assert.deepEqual(await submits(), ["/config ", "/config", "/heapdump"]);
    await capture();
  });
};
