import type { Translate } from "./i18n.ts";

export type SettingsPageId = "appearance" | "chat" | "terminal" | "alerts" | "voice" | "agents" | "shortcuts" | "devices" | "remote" | "about";

/**
 * What the palette shows for one Settings page, or for one group on it: its name and the words a
 * user may look for it by. A group's entry names the group (`section`, its `data-section`) as well
 * as the page it is on, and opens on the group.
 */
export interface SettingsPageEntry {
  id: SettingsPageId;
  section?: string;
  label: string;
  aliases: string;
}

/**
 * The Settings pages as the palette lists them. The aliases are one translated phrase per page, so
 * a user finds a page by the words of their own language ("theme", "font", "sound"); every phrase is
 * a literal key, which keeps it in the translation files. A setting's own label is added where
 * Japanese and Chinese write it as one word the phrase lacks (Chat font size, Terminal font size).
 *
 * After the pages come the groups a setting is looked for by but whose page's words do not say it,
 * as Zed's settings search lands on the setting: each is found by its heading and the labels of the
 * settings it holds, a touch screen's and a desktop's alike. Within a rank a page comes before its groups.
 */
export function settingsPageEntries(t: Translate): SettingsPageEntry[] {
  return [
    { id: "appearance", label: t("Appearance"), aliases: t("theme themes palette dark light mode colors density language sidebar logos") },
    { id: "chat", label: t("Chat"), aliases: `${t("chat font size message width composer enter send thinking code")} ${t("Chat font size")} ${t("Expand thinking")} ${t("Collapse work")}` },
    { id: "terminal", label: t("Terminal"), aliases: `${t("terminal font size key bar keyboard clipboard")} ${t("Terminal font size")}` },
    { id: "alerts", label: t("Alerts"), aliases: t("notifications sound push bell needs input finished") },
    { id: "voice", label: t("Voice input"), aliases: t("dictation microphone speech openai") },
    { id: "agents", label: t("Agents"), aliases: `${t("agents hooks claude codex install")} ${t("plan limits quota meters")} ${t("Subscription usage")} ${t("Agent integrations")}` },
    { id: "shortcuts", label: t("Shortcuts"), aliases: t("keyboard keys bindings hotkeys") },
    { id: "devices", label: t("Phone & devices"), aliases: t("phone install keep screen on app") },
    { id: "remote", label: t("Remote PCs"), aliases: t("machines computers ssh bridge plugins") },
    { id: "about", label: t("About"), aliases: t("version update release herdr") },
    { id: "agents", section: "guide", label: t("Setup guide"), aliases: t("onboarding first run getting started welcome") },
    { id: "appearance", section: "typography", label: t("Typography"), aliases: `${t("Interface font size")} ${t("Interface font")}` },
    { id: "chat", section: "composer", label: t("Composer"), aliases: [t("Enter sends"), t("Return inserts a new line"), t("Send queued messages automatically"), t("New tab button"), t("Artifacts chip"), t("Suggestion chip")].join(" ") },
    { id: "chat", section: "quick-replies", label: t("Quick replies"), aliases: t("Show above the message box") },
    { id: "remote", section: "sidebar-pcs", label: t("Show in sidebar"), aliases: t("hide PCs on this device") },
    { id: "voice", section: "openai-key", label: t("OpenAI API key"), aliases: "" },
    { id: "agents", section: "plan-limits", label: t("Plan limits"), aliases: [t("Show plan limits"), t("Meters show"), t("Limit shown")].join(" ") },
    { id: "agents", section: "other-accounts", label: t("Other accounts"), aliases: [t("Add account"), t("Hub")].join(" ") },
  ];
}

/** Other words for the palette's actions, by action id: a name the user may remember instead of the label. */
export function actionAliases(t: Translate): Readonly<Record<string, string>> {
  return {
    new: t("create workspace session start"),
    "new-tab": t("create tab add"),
    "rename-tab": t("edit tab name title"),
    "split-right": t("divide pane layout side"),
    "split-down": t("divide pane layout below"),
    "split-right-open": t("divide pane layout side"),
    "split-down-open": t("divide pane layout below"),
    zoom: t("maximize fullscreen full screen focus"),
    view: t("lens chat terminal conversation"),
    sidebar: t("panel drawer hide show"),
    "filter-sidebar": t("search find narrow sidebar"),
    theme: t("dark light mode appearance colors"),
    settings: t("preferences options config"),
    "add-pc": t("remote machine computer connect ssh"),
    notifications: t("alerts push bell"),
    lock: t("logout log out lock"),
    files: t("folder explorer open file"),
    refresh: t("reload update sync"),
  };
}

export interface SearchableRow<T> {
  item: T;
  title: string;
  aliases?: string;
}

function normalize(text: string): string {
  return text.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Rows a query finds, best first. A title that holds every word of the query is a strong match
 * (the whole title, then its start, then anywhere in it); a row found only through its aliases is a
 * weak match and comes after every strong one, as T3 Code sorts a secondary hit last. Within a rank
 * the rows keep the order they came in. An empty query keeps every row as it is.
 */
export function rankByTitle<T>(query: string, rows: readonly SearchableRow<T>[]): T[] {
  const needle = normalize(query);
  if (needle === "") return rows.map((row) => row.item);
  const words = needle.split(" ");
  const found: { item: T; index: number; rank: number }[] = [];
  rows.forEach((row, index) => {
    const title = normalize(row.title);
    const all = `${title} ${normalize(row.aliases ?? "")}`;
    if (words.every((word) => title.includes(word))) {
      found.push({ item: row.item, index, rank: title === needle ? 3 : title.startsWith(needle) ? 2 : 1 });
    } else if (words.every((word) => all.includes(word))) {
      found.push({ item: row.item, index, rank: 0 });
    }
  });
  return found.sort((a, b) => b.rank - a.rank || a.index - b.index).map((entry) => entry.item);
}

/** A page the palette asks Settings to open, and the group on it to land on, when it names one. */
export interface SettingsPageRequest {
  page: SettingsPageId;
  section?: string;
}

/**
 * The page the palette asked Settings to open. The dialog mounts per opening and reads it when it
 * mounts; it clears it once it has, and the palette clears it on its own opening, so a request the
 * dialog never saw cannot steer a later opening.
 */
let requested: SettingsPageRequest | null = null;

export function requestSettingsPage(request: SettingsPageRequest | null): void {
  requested = request;
}

export function requestedSettingsPage(): SettingsPageRequest | null {
  return requested;
}
