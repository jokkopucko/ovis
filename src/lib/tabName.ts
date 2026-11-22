import { paneTitle } from "../../shared/notify-policy.ts";
import type { HerdrTab, PaneInfo } from "../../shared/protocol.ts";
import { folderName, shortPathTitle, stripPaneChrome } from "./paneName.ts";
import { pasteFolder } from "./pasteFolders.ts";
import { attachmentTabLabel, shortTabLabel, tabLabelKey } from "./tabLabels.ts";

/**
 * The name a tab was given, or null while herdr names it itself: by its place in the row ("2"),
 * which herdr moves up when a tab before it closes while the tab keeps its number.
 */
export function customTabLabel(tab: Pick<HerdrTab, "label" | "number">, place: number = tab.number): string | null {
  const label = tab.label.trim();
  return label === "" || label === String(place) ? null : label;
}

/** herdr names a tab by its place until it is renamed: the strip says so in words. */
export function tabLabel(tab: Pick<HerdrTab, "label" | "number">, t: (key: string, vars?: Record<string, string | number>) => string, place: number = tab.number): string {
  return customTabLabel(tab, place) ?? t("Tab {n}", { n: place });
}

type TabPane = Pick<PaneInfo, "pane_id" | "terminal_id" | "agent" | "display_agent" | "label" | "title" | "cwd" | "foreground_cwd" | "terminal_title" | "terminal_title_stripped">;

const words = (text: string | null | undefined): string[] => text?.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function commandLine(text: string, kind: string): boolean {
  const first = text.split(/\s/, 1)[0] ?? "";
  return first === kind || first.endsWith(`/${kind}`);
}

/**
 * The agents whose terminal title names the conversation: Codex's "<thread> | <folder>", Claude
 * Code's "\u2733 <topic>". Another agent's says what it is doing ("\u25c7 Ready (app)"), which names no tab.
 */
const CONVERSATION_TITLES: ReadonlySet<string> = new Set(["codex", "claude"]);

export function agentPaneName(pane: Partial<TabPane>, uploadFolder?: string): string | null {
  if (!pane.agent) return null;
  const label = pane.label?.trim();
  if (label) return label;
  const agent = words(pane.agent);
  const said = new Set([...agent, ...words(pane.display_agent), ...[pane.cwd, pane.foreground_cwd].flatMap((path) => path ? words(folderName(path)) : [])]);
  const generic = (named: readonly string[]): boolean => named.every((word) => said.has(word) || (word === "code" && named.some((other) => agent.includes(other))));
  // herdr-core reports the terminal title as the pane's title too: that one is a terminal title
  const reported = pane.title === pane.terminal_title || pane.title === pane.terminal_title_stripped ? null : pane.title;
  for (const title of [reported, CONVERSATION_TITLES.has(pane.agent) ? paneTitle({ ...pane, pane_id: "" }) : null]) {
    const bare = stripPaneChrome(title ?? "", pane.agent).trim();
    if (shortPathTitle(bare) !== bare) continue;
    const text = bare.replace(/^[^\p{L}\p{N}@]+/u, "");
    const named = words(text);
    if (named.length === 0 || commandLine(text, pane.agent) || /^[a-z0-9._-]+$/.test(text) || generic(named)) continue;
    const short = shortTabLabel(text, uploadFolder);
    if (short !== null) return short;
  }
  return null;
}

/**
 * The label a tab takes from its agent's own name for its conversation (`agentPaneName`), else from
 * its first message (lib/tabLabels.ts): only while herdr names it by its number, never over a name
 * someone gave it (Rename tab, the New tab dialog's Name, a script, an agent's name typed as one).
 * `panes` are the tab's, in the order whose label wins; null when none has one. The tab's hover
 * stays its pane's title.
 */
export function autoTabLabel(tab: Pick<HerdrTab, "label" | "number">, panes: readonly TabPane[], machineId: string, labels: Readonly<Record<string, string>>, place: number = tab.number): string | null {
  if (customTabLabel(tab, place) !== null) return null;
  for (const pane of panes) {
    const learned = labels[tabLabelKey(machineId, pane)];
    const label = agentPaneName(pane, pasteFolder(machineId)) ?? (learned && !attachmentTabLabel(learned) ? learned : null);
    if (label) return label;
  }
  return null;
}
