/**
 * The address says where the app is, so any moment can be linked to and returned to:
 *
 *   ?machine=<pc>&ws=<id>-<slug>&pane=<pane>&view=chat|terminal&file=<path>&settings=<page>&section=<group>
 *   ?new=workspace|tab&cwd=<folder>&name=<name>&agent=<kind>
 *   &sidebar=hidden|shown
 *
 * `sidebar=hidden` opens a desktop with the sidebar collapsed, and is in the address while it is;
 * `sidebar=shown` opens a phone with its drawer out (a phone's drawer closes once a pane is picked,
 * so its address never says so).
 *
 * `new` opens the New workspace dialog (a tab in the linked workspace with `tab`), its fields
 * filled from the link and the address following what is typed. A link never creates anything:
 * it fills the form, and Create is still the user's.
 *
 * `machine` is left out for the local PC; `pane` and `machine` are the names a tapped
 * notification already opens the app with (public/sw.js). `ws` is herdr's workspace id, then a
 * hyphen and the workspace's name as a short slug: readable, and a check, since herdr's ids are
 * short counters a new session can hand out again. A link to a workspace (`ws` alone, or a
 * `pane` that has closed) opens the pane its sidebar row opens. Opening another pane is an
 * entry of the history, so Back returns to the last one; a lens switch, a Settings page and a
 * pane the app picked itself only replace the entry. Settings keeps its own entries
 * (lib/settingsHistory.ts); the address of the one shown carries its page.
 */
import type { SessionSnapshot } from "../../shared/protocol.ts";

export type LinkView = "chat" | "terminal";

export interface AppLink {
  machine: string;
  /** herdr's workspace id */
  workspace: string | null;
  /** the workspace's name as it was when the link was made (`slugOf`), or null */
  workspaceSlug?: string | null;
  pane: string | null;
  view: LinkView | null;
  /** the file open in the viewer over the pane, as the chat or the Files dialog gave its path */
  file?: string | null;
  settings: string | null;
  /** a group on the Settings page (`data-section` on its SettingsGroup) */
  section?: string | null;
  /** the New workspace dialog, and what its fields say */
  create?: CreateDraft | null;
  /** the sidebar, when not as the screen opens it: collapsed on a desktop, out on a phone */
  sidebar?: "shown" | "hidden" | null;
}

export interface CreateDraft {
  /** a workspace, or a tab in the linked workspace */
  kind: "workspace" | "tab";
  cwd: string | null;
  name: string | null;
  /** an agent kind herdr names (the dialog keeps it only when herdr offers it); "" is a shell */
  agent: string | null;
}

/** what a link may put in the dialog's fields: no more than a person would type */
const FIELD_MAX = { cwd: 1024, name: 120 } as const;
const AGENT_KIND = /^[a-z0-9][a-z0-9._-]{0,39}$/;

const LOCAL = "local";
/** the query names this module owns; anything else in the address is left as it is */
const OWN = ["machine", "ws", "pane", "view", "file", "settings", "section", "new", "cwd", "name", "agent", "sidebar"] as const;
const SIDEBAR: Readonly<Record<string, "shown" | "hidden">> = { shown: "shown", show: "shown", open: "shown", "1": "shown", hidden: "hidden", hide: "hidden", closed: "hidden", "0": "hidden" };
/** a slug stays this short, cut at a word where it can be: a link names the workspace, it does not spell it out */
const SLUG_MAX = 24;

/** A workspace name as a slug: lowercase ASCII words joined by hyphens, at most SLUG_MAX long; "" when nothing is left. */
export function slugOf(label: string | null | undefined): string {
  const words = (label ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (words.length <= SLUG_MAX) return words;
  const cut = words.slice(0, SLUG_MAX + 1);
  const end = cut.lastIndexOf("-");
  return (end > SLUG_MAX / 2 ? cut.slice(0, end) : words.slice(0, SLUG_MAX)).replace(/-+$/, "");
}

/** Settings pages merged into another: a link or history entry naming one opens the page it went to. */
const MOVED_SETTINGS: Readonly<Record<string, string>> = { usage: "agents", integrations: "agents" };

/** The Settings page a link or history entry names, as this version calls it. */
export function currentSettingsPage(page: string): string;
export function currentSettingsPage(page: string | null): string | null;
export function currentSettingsPage(page: string | null): string | null {
  return page === null ? null : MOVED_SETTINGS[page] ?? page;
}

const named = (value: string | null): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/** Relative file links need a pane; an absolute file can outlive the pane that wrote it. */
export function fileFromLink(link: Pick<AppLink, "file" | "pane">): string | null {
  return link.file && (link.pane || /^(?:\/|[A-Za-z]:[\\/])/.test(link.file)) ? link.file : null;
}

/** The place an address names. Every field is optional in an address; a missing PC is the local one. */
export function readLink(search: string): AppLink {
  const query = new URLSearchParams(search);
  const view = query.get("view");
  // herdr's ids hold no hyphen: the first one starts the slug
  const ws = named(query.get("ws"));
  const cut = ws?.indexOf("-") ?? -1;
  const settings = currentSettingsPage(named(query.get("settings")));
  return {
    machine: named(query.get("machine")) ?? LOCAL,
    workspace: ws && cut > 0 ? ws.slice(0, cut) : ws,
    workspaceSlug: ws && cut > 0 ? named(ws.slice(cut + 1)) : null,
    pane: named(query.get("pane")),
    view: view === "chat" || view === "terminal" ? view : null,
    file: named(query.get("file")),
    settings,
    section: settings ? named(query.get("section")) : null,
    create: readCreate(query),
    sidebar: SIDEBAR[query.get("sidebar") ?? ""] ?? null,
  };
}

function readCreate(query: URLSearchParams): CreateDraft | null {
  const kind = query.get("new");
  if (kind !== "workspace" && kind !== "tab") return null;
  const field = (name: "cwd" | "name") => named(query.get(name))?.slice(0, FIELD_MAX[name]) ?? null;
  const agent = query.get("agent");
  return { kind, cwd: field("cwd"), name: field("name"), agent: agent === "" || agent === "shell" ? "" : agent && AGENT_KIND.test(agent) ? agent : null };
}

/** Whether an address names a place at all, as opposed to the app's own start. */
export function linksSomewhere(search: string): boolean {
  const query = new URLSearchParams(search);
  return OWN.some((name) => query.has(name));
}

/** The query for a place, keeping whatever else `current` holds that is not this module's. */
export function linkSearch(link: AppLink, current = ""): string {
  const query = new URLSearchParams(current);
  for (const name of OWN) query.delete(name);
  if (link.machine !== LOCAL) query.set("machine", link.machine);
  if (link.workspace) query.set("ws", link.workspaceSlug ? `${link.workspace}-${link.workspaceSlug}` : link.workspace);
  if (link.pane) query.set("pane", link.pane);
  if (link.pane && link.view) query.set("view", link.view);
  const file = fileFromLink(link);
  if (file) query.set("file", file);
  if (link.settings) query.set("settings", link.settings);
  if (link.settings && link.section) query.set("section", link.section);
  if (link.sidebar) query.set("sidebar", link.sidebar);
  if (link.create) {
    query.set("new", link.create.kind);
    if (link.create.cwd) query.set("cwd", link.create.cwd);
    if (link.create.name) query.set("name", link.create.name);
    if (link.create.agent !== null) query.set("agent", link.create.agent === "" ? "shell" : link.create.agent);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

/**
 * The pane a link to a workspace opens, as its sidebar row does: the one in front in its active
 * tab, else its focused pane, else its first. Null when the workspace is not open.
 */
export function workspacePane(snapshot: Pick<SessionSnapshot, "workspaces" | "panes" | "layouts">, workspaceId: string): string | null {
  const workspace = snapshot.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
  if (!workspace) return null;
  const panes = snapshot.panes.filter((pane) => pane.workspace_id === workspaceId);
  const front = snapshot.layouts?.find((layout) => layout.tab_id === workspace.active_tab_id)?.focused_pane_id;
  return (panes.find((pane) => pane.pane_id === front) ?? panes.find((pane) => pane.focused) ?? panes[0])?.pane_id ?? null;
}

/** Why a link could not open what it named: its pane closed (its workspace opened instead), or its workspace too. */
export type LinkNote = "pane-closed" | "workspace-closed" | "machine-missing";

/**
 * Where a link lands on a PC's roster. The workspace is the id's when the slug still names it
 * (or the link has none); when another open workspace has the slug and this one does not, the id
 * was handed out again and the slug's workspace is the one meant. Its pane is the link's when it
 * is in that workspace, else the one its row opens. Nothing named and nothing found: no pane.
 */
export function resolveLink(snapshot: Pick<SessionSnapshot, "workspaces" | "panes" | "layouts">, link: Pick<AppLink, "workspace" | "workspaceSlug" | "pane">): { pane: string | null; workspace: string | null; note: LinkNote | null } {
  const byId = link.workspace ? snapshot.workspaces.find((candidate) => candidate.workspace_id === link.workspace) : undefined;
  const bySlug = link.workspaceSlug ? snapshot.workspaces.filter((candidate) => slugOf(candidate.label) === link.workspaceSlug) : [];
  const workspace = byId && (!link.workspaceSlug || slugOf(byId.label) === link.workspaceSlug || bySlug.length !== 1) ? byId : bySlug.length === 1 ? bySlug[0] : byId;
  const pane = link.pane ? snapshot.panes.find((candidate) => candidate.pane_id === link.pane) : undefined;
  if (pane && (!workspace || pane.workspace_id === workspace.workspace_id)) return { pane: pane.pane_id, workspace: pane.workspace_id, note: null };
  if (workspace) return { pane: workspacePane(snapshot, workspace.workspace_id), workspace: workspace.workspace_id, note: link.pane ? "pane-closed" : null };
  return { pane: null, workspace: null, note: link.pane || link.workspace ? "workspace-closed" : null };
}

/** Whether going from one place to another is a move the history keeps (another pane or PC). */
export function isNavigation(from: Pick<AppLink, "machine" | "pane">, to: Pick<AppLink, "machine" | "pane">): boolean {
  return to.pane !== null && (from.machine !== to.machine || from.pane !== to.pane);
}

/** Marks an entry the app pushed for a move between panes. */
export const NAV_KEY = "ovis:nav";
