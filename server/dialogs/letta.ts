import type { DialogReader } from "./registry.ts";
import { pickerPlan } from "./interaction-plan.ts";
import { ANSI_RE, KEY, type ParsedPrompt, findLastIndex, finishPrompt, keySteps, navigationKeys, normalizeText, own } from "./shared.ts";

/**
 * Letta Code's `/model` picker, as letta-code 0.34.31 draws it (src/cli/components/ModelSelector.tsx):
 *
 *   Swap your agent's model
 *
 *     Recents [5]    Recommended [12]    All models [21]
 *     Models you've recently used
 *     Search: (type to filter)
 *
 *   > Claude Opus 5.5 · Anthropic
 *     Claude Sonnet 5.5 · Anthropic
 *     Claude Opus 5.5 · Amazon Bedrock (current)
 *     ↓ 2 more below
 *
 *     5 models · cached · R to refresh list
 *     Enter select · ↑↓ navigate · ←→/Tab switch · Esc cancel
 *
 * A row is `> ` under the cursor and two spaces elsewhere, then the model's label, ` (current)` on the
 * model in use, and ` · <description>` when it has one. The window shows a few rows of the tab's list;
 * the count line says how many the tab holds. Enter picks the row: Letta then opens the model's
 * reasoning levels (parseLettaEffort) or applies it. The card also offers the tabs beside the one
 * shown (← and → step one tab), and a search, which Letta matches against every model of the tab:
 * each answers by keys and leaves the picker open, so the next card shows what it drew.
 */
const LETTA_MODEL_TITLE = "Swap your agent's model";
const LETTA_MODEL_HINT = "Enter select · ↑↓ navigate · ←→/Tab switch · Esc cancel";
const LETTA_MODEL_COUNT_RE = /^(\d+) models?(?: · cached)?(?: · R to refresh list| · refreshing\.\.\.)$/;
const LETTA_MODEL_MORE_RE = /^↓ \d+ more below$/;
const LETTA_MODEL_ROW_RE = /^(> | {2})(?:🔒 )?(\S.*)$/;
const LETTA_CURRENT_RE = /\s\(current\)(?=$|\s·\s)/;
/** A search that matches nothing: no rows and no footer, only this line under the search (ModelSelector.tsx) */
const LETTA_MODEL_NO_MATCH = "No models match your search.";
/** Lines Letta draws above the rows that are none: a refresh under way, a catalog it could not fetch */
const LETTA_MODEL_NOTES = new Set(["Refreshing list...", "Warning: Could not fetch available models. Showing all models."]);

/**
 * The reasoning step that follows a pick (src/cli/components/ModelReasoningSelector.tsx):
 *
 *   Set your model's reasoning settings
 *
 *    Claude Haiku 4.5 · Anthropic
 *
 *    ▌▌▌▌ Medium reasoning effort
 *
 *    Enter select · ←→/Tab switch · Esc back
 *
 * It draws the level under its cursor only, and ←/→ cycle through levels the screen never lists.
 */
const LETTA_EFFORT_TITLE = "Set your model's reasoning settings";
const LETTA_EFFORT_HINT = "Enter select · ←→/Tab switch · Esc back";
const LETTA_EFFORT_RE = /^▌+ (\S.*) reasoning effort$/;

function screenLines(screen: string): { lines: string[]; end: number } {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map((line) => line.trimEnd());
  let end = lines.length - 1;
  while (end >= 0 && lines[end]!.trim() === "") end -= 1;
  return { lines, end };
}

/** Letta's tabs by the line it draws under them (getCategoryDescription in ModelSelector.tsx). */
const LETTA_TAB_OF: Record<string, string> = {
  "Models you've recently used": "Recents",
  "Recommended models currently available for this account": "Recommended",
  "All models currently available for this account": "All models",
  "Recommended Letta API models currently available for this account": "Letta API",
  "All Letta API models currently available for this account": "Letta API (all)",
  "Recommended models via your connected API keys (use /connect to add more)": "BYOK",
  "All models via your connected API keys (use /connect to add more)": "BYOK (all)",
};
const LETTA_TAB_RE = /^(\S.*?) \[(\d+)\]$/;
/** What a search may hold: typed one character at a time, as Letta reads a key (input.length === 1) */
export const LETTA_SEARCH_MAX = 40;

function parseLettaModel(screen: string): ParsedPrompt | null {
  const { lines, end } = screenLines(screen);
  // the picker holds the end of the screen: a hint above later output is an answered picker's. A search that
  // matches nothing ends it with its own line instead, and draws no rows
  if (end < 0) return null;
  const empty = lines[end]!.trim() === LETTA_MODEL_NO_MATCH;
  if (!empty && lines[end]!.trim() !== LETTA_MODEL_HINT) return null;
  const count = empty ? null : lines[end - 1]?.trim().match(LETTA_MODEL_COUNT_RE);
  if (!empty && !count) return null;
  const search = findLastIndex(lines, (line, index) => index < end && /^\s{2}Search: /.test(line));
  if (search < 2 || !lines.slice(0, search).some((line) => line.trim() === LETTA_MODEL_TITLE)) return null;
  const rows: { label: string; cursor: boolean; current: boolean; lineIndex: number }[] = [];
  for (let index = search + 1; index < (empty ? end : end - 1); index += 1) {
    const line = lines[index]!;
    if (line.trim() === "" || LETTA_MODEL_MORE_RE.test(line.trim()) || LETTA_MODEL_NOTES.has(line.trim())) continue;
    const row = line.match(LETTA_MODEL_ROW_RE);
    if (!row) return null;
    const current = LETTA_CURRENT_RE.test(row[2]!);
    const text = row[2]!.replace(LETTA_CURRENT_RE, "");
    rows.push({ label: normalizeText(text), cursor: row[1] === "> ", current, lineIndex: index });
  }
  if (empty ? rows.length > 0 : rows.filter((row) => row.cursor).length !== 1) return null;
  const selectedIndex = Math.max(0, rows.findIndex((row) => row.cursor));
  const query = lines[search]!.replace(/^\s{2}Search: /, "");
  const typed = query === "(type to filter)" ? "" : query;

  const tabs = lines[search - 2]?.trim().split(/\s{2,}/).map((tab) => tab.match(LETTA_TAB_RE)) ?? [];
  const shown = LETTA_TAB_OF[lines[search - 1]?.trim() ?? ""];
  // a tab known by its line alone: a line two tabs share (a free tier's Letta API tabs) tells them apart from no card
  if (shown === undefined) return null;
  const names = tabs.every((tab) => tab !== null) ? tabs.map((tab) => tab![1]!) : [];
  const at = shown === undefined ? -1 : names.indexOf(shown);
  const beside = at < 0 || names.length < 2 ? [] : [...new Set([(at + 1) % names.length, (at - 1 + names.length) % names.length])]
    .filter((tab) => tab !== at).map((tab) => ({ tab, key: tab === (at + 1) % names.length ? KEY.right : KEY.left }));

  const current = rows.find((row) => row.current);
  const asked = current ? own("Select model for this session (currently {model})", { model: current.label }) : own("Select model for this session");
  const hidden = count ? Number(count[1]) - rows.length : 0;
  const options = [
    ...rows.map((row) => ({ label: row.label, description: null })),
    ...beside.map(({ tab }) => ({ label: own("Show the {tab} tab", { tab: `${names[tab]} [${tabs[tab]![2]}]` }), description: null })),
    { label: own("Search models"), description: null },
    // Esc: Letta clears a search first, and closes the picker when there is none
    { label: own("Cancel"), description: null },
  ];
  const searchIndex = options.length - 2;
  const cancelIndex = options.length - 1;
  return finishPrompt("letta", {
    kind: "question",
    title: "",
    question: hidden <= 0 ? asked : own("{question}. {count} more models in this tab: search, or show another tab.", { question: asked, count: hidden }),
    body: null,
    options,
    multi_select: false,
    custom_option_index: searchIndex,
  }, {
    responder: "letta-model", menuLabels: [...rows.map((row) => row.label), ...beside.map(({ tab }) => `tab ${names[tab]}`), "search", "cancel"], selectedIndex, lettaSearch: typed,
    lettaTab: shown, lettaTabs: names,
    checkedOptionIndices: [], customMenuIndex: searchIndex, rejectWithEscapeIndex: cancelIndex,
    optionSteps: [
      ...rows.map((_, index) => [...keySteps(navigationKeys(index - selectedIndex)), { keys: [KEY.enter] }]),
      // one key switches the tab, and Letta clears the search with it
      ...beside.map(({ key }) => [{ keys: [key] }]),
      [],
      [{ keys: [KEY.escape] }],
    ],
    // the search: what was typed is taken out a key at a time, then the new words go in a key at a
    // time, as Letta reads one. The first goes into a search the backspaces emptied, where `r` refreshes the list
    // instead: its capital goes in
    customSteps: (text: string) => {
      const first = text.startsWith("r") ? `R${text.slice(1)}` : text;
      return [...keySteps(Array.from({ length: typed.length }, () => KEY.backspace)), ...[...first].map((character) => ({ text: character }))];
    },
  }, { call: `search ${typed}` });
}

function parseLettaEffort(screen: string): ParsedPrompt | null {
  const { lines, end } = screenLines(screen);
  if (end < 0 || lines[end]!.trim() !== LETTA_EFFORT_HINT) return null;
  const level = findLastIndex(lines.slice(0, end), (line) => LETTA_EFFORT_RE.test(line.trim()));
  const title = findLastIndex(lines.slice(0, Math.max(level, 0)), (line) => line.trim() === LETTA_EFFORT_TITLE);
  if (level < 0 || title < 0 || lines.slice(level + 1, end).some((line) => line.trim() !== "")) return null;
  const named = lines.slice(title + 1, level).map((line) => line.trim()).filter(Boolean);
  if (named.length !== 1) return null;
  const shown = lines[level]!.trim().match(LETTA_EFFORT_RE)![1]!;
  return finishPrompt("letta", {
    kind: "question",
    title: "",
    question: own("{question}. More levels are listed in the terminal.", {
      question: own("Select reasoning level for {model} for this session (currently {level})", { model: named[0]!, level: shown }),
    }),
    body: null,
    // Esc goes back to the model list, whose card closes the picker
    options: [{ label: shown, description: null }, { label: own("Cancel"), description: null }],
    multi_select: false,
    custom_option_index: null,
  }, {
    responder: "letta-effort", menuLabels: [`${named[0]}  ${shown}`, "cancel"], selectedIndex: 0,
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: 1,
    optionSteps: [[{ keys: [KEY.enter] }], [{ keys: [KEY.escape] }]],
  });
}

/**
 * Letta moves to the first tab with models itself once the search leaves the shown one none (and draws
 * that tab no more): a tab still drawn but not shown is a switch from somewhere else, where the search would not go.
 */
export function lettaSearchShown(shown: ParsedPrompt | null | undefined, card: ParsedPrompt, search: string): boolean {
  const tabs = shown?.lettaTabs ?? [];
  return shown?.responder === "letta-model" && shown.lettaSearch === search.trimEnd()
    && (shown.lettaTab === card.lettaTab || (tabs.length > 0 && tabs[0] === shown.lettaTab && !tabs.includes(card.lettaTab ?? "")));
}

export function lettaPick(parsed: ParsedPrompt | undefined): string | undefined {
  if (parsed?.responder === "letta-model") return `model\n${parsed.lettaTab}\n${parsed.lettaSearch}\n${parsed.menuLabels[parsed.selectedIndex]}`;
  if (parsed?.responder === "letta-effort") return `effort\n${parsed.menuLabels[0]}`;
  return undefined;
}

export const readers: readonly DialogReader[] = [
  {
    id: "letta-model", agents: ["letta"], priority: 50,
    reread: "before-commit", list: "letter-window",
    // a row is its tab's and its search's: Recents and Recommended may both have one model under the cursor
    interaction: (parsed) => pickerPlan(parsed, parseLettaModel, parsed.optionSteps ?? [],
      (shown, cursor) => `${shown.lettaTab}\n${shown.lettaSearch}\n${shown.menuLabels[cursor]}`),
    parse: (screen) => {
      const parsed = parseLettaModel(screen);
      return parsed?.responder === "letta-model" ? parsed : null;
    },
  },
  {
    id: "letta-effort", agents: ["letta"], priority: 60,
    reread: "before-commit", list: "none",
    interaction: (parsed) => pickerPlan(parsed, parseLettaEffort, parsed.optionSteps ?? [], (shown, cursor) => shown.menuLabels[cursor]),
    parse: (screen) => {
      const parsed = parseLettaEffort(screen);
      return parsed?.responder === "letta-effort" ? parsed : null;
    },
  },
];
