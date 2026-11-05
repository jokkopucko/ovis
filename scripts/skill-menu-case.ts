import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { paneCommands } from "../server/commands.ts";
import type { SlashCommand } from "../shared/protocol.ts";

// What one agent's case file (scripts/skill-menu-cases/<agent>.ts) exports, and the tools
// scripts/agent-skill-menu-demo-regression.ts hands its scenarios on the page it opened.

/** the demo's docs pane's folder: no agent's loader finds anything of this machine's there */
const DEMO_CWD = "/home/demo/.herdr/worktrees/cli-tools/changelog";

/** An agent's own builtins, as its loader answers over a home that does not exist: none of this machine's skills. */
export function agentBuiltins(agent: string): SlashCommand[] {
  return paneCommands(agent, DEMO_CWD, join(tmpdir(), "herdr-skill-menu-demo-no-home"), {}).filter((command) => command.source === "builtin");
}

export type ColorScheme = "light" | "dark";

export interface SkillMenuCase {
  /** the pane's agent, as the snapshot names it (the case file is named after the agent, or after the agent and what it tries) */
  agent: string;
  /** GET /api/pane/commands: the agent's own builtins and the case's skills */
  commands: SlashCommand[];
  /** the user turn the chat ends with */
  turnText: string;
  /** the chips that turn shows, in the forms they were written */
  chips: string[];
  /** the window widths the scenarios run at; the runner's own (1280 and a 390 phone) when absent */
  widths?: readonly number[];
  /** the themes the scenarios run in (the app's theme setting); dark alone when absent */
  schemes?: readonly ColorScheme[];
  /** the phone widths where this device chose Enter sends (Settings > Chat > Composer); a phone's Return breaks the
   *  line otherwise, and its scenarios send with the Send button */
  enterSendsAt?: readonly number[];
  /** the scenarios, run once at every width on a page showing the pane's chat */
  expect: (run: CaseRun) => Promise<void>;
}

export interface CaseRun {
  page: Page;
  width: number;
  scheme: ColorScheme;
  /** the message box */
  box: Locator;
  menu: Locator;
  /**
   * One scenario. Its screenshot is taken where it asks for it (`capture`), or at the failure when
   * it fails before that, so the evidence shows the state that was asserted. A failure ends the
   * scenario, not the run: every scenario at every width leaves its picture, and the run fails at
   * the end.
   */
  scenario(name: string, file: string | null, run: (capture: () => Promise<void>) => Promise<void>): Promise<void>;
  log(line: string): void;
  /** empties the box and waits for its menu to close */
  clear(): Promise<void>;
  /** the rows as drawn: the typed `/` or `$`, then the command's name */
  rowLabels(): Promise<string[]>;
  rowNames(): Promise<string[]>;
  menuGeometry(): Promise<MenuGeometry>;
  /** the menu sits inside the viewport over the box, no row overlaps another, every name is whole */
  menuFits(what: string): Promise<void>;
  /** every row's description is one line and one sentence; a listed command's tooltip is its whole text and its icon its origin's */
  rowsBrief(what: string): Promise<void>;
  chipGeometry(): Promise<ChipGeometry>;
  /** the texts of every submit frame the page's sockets sent so far (the demo's stand-in included) */
  submits(): Promise<string[]>;
}

export interface MenuGeometry {
  rows: number;
  selected: number;
  fits: boolean;
  aboveInput: boolean;
  overlapping: number;
  clipped: (string | null)[];
  overflowing: boolean;
}

export interface ChipGeometry {
  text: string | null;
  chips: (string | null)[];
  inside: boolean;
  onScreen: boolean;
  overlapping: boolean;
  overflowing: boolean;
}

const menuGeometry = (page: Page): Promise<MenuGeometry> => page.evaluate(() => {
  const menu = document.querySelector<HTMLElement>(".composer-menu")!;
  const box = menu.getBoundingClientRect();
  const input = document.querySelector<HTMLElement>(".composer-text")!.getBoundingClientRect();
  const rows = [...menu.querySelectorAll<HTMLElement>(".menu-item")];
  const rects = rows.map((row) => row.getBoundingClientRect());
  return {
    rows: rows.length,
    selected: rows.findIndex((row) => row.getAttribute("aria-selected") === "true"),
    fits: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
    aboveInput: box.bottom <= input.top + 0.5,
    // a row the column shrank spills its text over the next one: no two rows share a pixel
    overlapping: rects.filter((rect, index) => index > 0 && Math.min(rect.bottom, rects[index - 1]!.bottom) - Math.max(rect.top, rects[index - 1]!.top) > 0.5).length,
    // a command's name is drawn whole; only its description may give way
    clipped: rows.map((row) => row.querySelector<HTMLElement>(".menu-item-main")!).filter((main) => main.scrollWidth > main.clientWidth + 1).map((main) => main.textContent),
    overflowing: document.documentElement.scrollWidth > innerWidth,
  };
});

/** each command row's description (a file row has none): its height in lines, the row's tooltip, origin and icon */
const rowDescriptions = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".composer-menu .menu-item")].filter((row) => row.querySelector(".menu-item-hint") !== null).map((row) => {
  const hint = row.querySelector<HTMLElement>(".menu-item-hint")!;
  return {
    name: row.querySelector<HTMLElement>(".menu-item-main")!.textContent ?? "",
    hint: hint.textContent ?? "",
    lines: Math.round(hint.getBoundingClientRect().height / parseFloat(getComputedStyle(hint).lineHeight || "16")),
    title: row.getAttribute("title"),
    origin: row.getAttribute("data-origin"),
    icon: row.querySelector(":scope > svg") !== null,
  };
}));

const chipGeometry = (page: Page): Promise<ChipGeometry> => page.evaluate(() => {
  const turns = document.querySelectorAll<HTMLElement>(".chat-turn-user");
  const turn = turns[turns.length - 1]!;
  const body = turn.querySelector<HTMLElement>(".chat-bubble-body")!;
  const box = body.getBoundingClientRect();
  const rects = [...turn.querySelectorAll<HTMLElement>(".markdown-skill")].map((chip) => chip.getBoundingClientRect());
  return {
    text: body.textContent,
    chips: [...turn.querySelectorAll<HTMLElement>(".markdown-skill")].map((chip) => chip.textContent),
    inside: rects.every((rect) => rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5 && rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5),
    onScreen: rects.every((rect) => rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight),
    overlapping: rects.some((a, index) => rects.slice(index + 1).some((b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5)),
    overflowing: document.documentElement.scrollWidth > innerWidth,
  };
});

export function caseRun(page: Page, width: number, skillCase: SkillMenuCase, scenario: CaseRun["scenario"], log: CaseRun["log"], scheme: ColorScheme = "dark"): CaseRun {
  const box = page.getByRole("textbox", { name: "Message", exact: true });
  const menu = page.locator(".composer-menu");
  const rowLabels = (): Promise<string[]> => menu.locator(".menu-item-main").allTextContents();
  return {
    page, width, scheme, box, menu, scenario, log,
    submits: () => page.evaluate(() => (window as unknown as { sentSubmits?: string[] }).sentSubmits ?? []),
    clear: async () => {
      await box.fill("");
      await menu.waitFor({ state: "detached" });
    },
    rowLabels,
    rowNames: async () => (await rowLabels()).map((row) => row.replace(/^[/$]/u, "")),
    menuGeometry: () => menuGeometry(page),
    menuFits: async (what) => {
      const geometry = await menuGeometry(page);
      assert.ok(geometry.fits && geometry.aboveInput, `${what}: the menu sits inside the viewport, over the message box: ${JSON.stringify(geometry)}`);
      assert.equal(geometry.overlapping, 0, `${what}: no row overlaps the one before it: ${JSON.stringify(geometry)}`);
      assert.deepEqual(geometry.clipped, [], `${what}: every name is drawn whole`);
      assert.equal(geometry.overflowing, false, `${what}: the page does not scroll sideways`);
    },
    rowsBrief: async (what) => {
      for (const row of await rowDescriptions(page)) {
        assert.ok(row.lines <= 1, `${what}: ${row.name}'s description takes one line: ${JSON.stringify(row)}`);
        assert.ok(!/[.!?]\s+[A-Z]/u.test(row.hint), `${what}: ${row.name}'s description is one sentence: ${JSON.stringify(row)}`);
        const listed = skillCase.commands.filter((command) => command.name === row.name.replace(/^[/$]/u, ""));
        if (listed.length !== 1) continue;
        const [command] = listed;
        assert.equal(row.title, command!.description.trim() === "" ? null : command!.description, `${what}: ${row.name}'s whole description is its tooltip`);
        assert.equal(row.origin, command!.origin ?? null, `${what}: ${row.name} says where it comes from`);
        assert.equal(row.icon, command!.origin !== undefined, `${what}: ${row.name} has its origin's icon, and only with an origin`);
      }
    },
    chipGeometry: () => chipGeometry(page),
  };
}
