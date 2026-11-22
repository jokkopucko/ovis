/**
 * `new` opens the New workspace dialog (a tab in the linked workspace with `tab`), its fields
 * filled from the link and the address following what is typed. A link never creates anything:
 * it fills the form, and Create is still the user's.
 *
 * `machine` is left out for the local PC; `pane` and `machine` are the names a tapped
 * notification already opens the app with (public/sw.js). `ws` is herdr's workspace id, then a
 * hyphen and the workspace's name as a short slug: readable, and a check, since herdr's ids are
 * short counters a new session can hand out again.
 */
import type { SessionSnapshot } from "../../shared/protocol.ts";

export type LinkView = "chat" | "terminal";

export interface AppLink {
  machine: string;
  workspace: string | null;
  workspaceSlug?: string | null;
  pane: string | null;
  view: LinkView | null;
  file?: string | null;
  settings: string | null;
  section?: string | null;
  create?: CreateDraft | null;
  sidebar?: "shown" | "hidden" | null;
}

export interface CreateDraft {
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
const OWN = ["machine", "ws", "pane", "view", "file", "settings", "section", "new", "cwd", "name", "agent", "sidebar"] as const;
const SIDEBAR: Readonly<Record<string, "shown" | "hidden">> = { shown: "shown", show: "shown", open: "shown", "1": "shown", hidden: "hidden", hide: "hidden", closed: "hidden", "0": "hidden" };
const SLUG_MAX = 24;

export function slugOf(label: string | null | undefined): string {
  const words = (label ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (words.length <= SLUG_MAX) return words;
  const cut = words.slice(0, SLUG_MAX + 1);
  const end = cut.lastIndexOf("-");
  return (end > SLUG_MAX / 2 ? cut.slice(0, end) : words.slice(0, SLUG_MAX)).replace(/-+$/, "");
}

const MOVED_SETTINGS: Readonly<Record<string, string>> = { usage: "agents", integrations: "agents", voice: "chat", remote: "devices" };
const MOVED_SECTIONS: Readonly<Record<string, string>> = { voice: "voice", remote: "remote" };

export function currentSettingsPage(page: string): string;
export function currentSettingsPage(page: string | null): string | null;
export function currentSettingsPage(page: string | null): string | null {
  return page === null ? null : MOVED_SETTINGS[page] ?? page;
}

const named = (value: string | null): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

export function fileFromLink(link: Pick<AppLink, "file" | "pane">): string | null {
  return link.file && (link.pane || /^(?:\/|[A-Za-z]:[\\/])/.test(link.file)) ? link.file : null;
}

export function readLink(search: string): AppLink {
  const query = new URLSearchParams(search);
  const view = query.get("view");
  // the first hyphen starts the slug; herdr-core's ids hold hyphens, and resolveLink joins those again
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
    section: settings ? named(query.get("section")) ?? MOVED_SECTIONS[named(query.get("settings")) ?? ""] ?? null : null,
    create: readCreate(query),
    sidebar: SIDEBAR[query.get("sidebar") ?? ""] ?? null,
  };
}

/** The names Windows serves WSL's own files under: this PC, no other host (server/windows-share.ts) */
const WSL_HOSTS = new Set(["wsl$", "wsl.localhost"]);

function readCreate(query: URLSearchParams): CreateDraft | null {
  const kind = query.get("new");
  if (kind !== "workspace" && kind !== "tab") return null;
  const field = (name: "cwd" | "name") => named(query.get(name))?.slice(0, FIELD_MAX[name]) ?? null;
  const agent = query.get("agent");
  // A folder that begins with two separators is a network share on a Windows PC, and reading one asks its host for
  // it with the user's sign-in. The dialog's Start reads the folder it shows, and shows a long path by its end, so
  // an address fills in none: a share is typed or picked by the person who means it. WSL's own folders
  // (`\\wsl$\…`, `\\wsl.localhost\…`) are this PC's, as the server's share rule has them (#3634)
  const cwd = field("cwd");
  const share = cwd === null ? null : /^(?:~\/)?[\\/]{2}([^\\/]*)/.exec(cwd);
  return { kind, cwd: share && !WSL_HOSTS.has(share[1]!.toLowerCase()) ? null : cwd, name: field("name"), agent: agent === "" || agent === "shell" ? "" : agent && AGENT_KIND.test(agent) ? agent : null };
}

export function linksSomewhere(search: string): boolean {
  const query = new URLSearchParams(search);
  return OWN.some((name) => query.has(name));
}

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

export function workspacePane(snapshot: Pick<SessionSnapshot, "workspaces" | "panes" | "layouts">, workspaceId: string): string | null {
  const workspace = snapshot.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
  if (!workspace) return null;
  const panes = snapshot.panes.filter((pane) => pane.workspace_id === workspaceId);
  const front = snapshot.layouts?.find((layout) => layout.tab_id === workspace.active_tab_id)?.focused_pane_id;
  return (panes.find((pane) => pane.pane_id === front) ?? panes.find((pane) => pane.focused) ?? panes[0])?.pane_id ?? null;
}

export type LinkNote = "pane-closed" | "workspace-closed" | "machine-missing";

/** What a selection leaves of the header's note: a landing's note speaks of a pane left behind, Link copied of an action done */
export const noteAfterSelection = (note: LinkNote | "copied" | null): "copied" | null => note === "copied" ? note : null;

/**
 * The workspace is the id's when the slug still names it
 * (or the link has none); when another open workspace has the slug and this one does not, the id
 * was handed out again and the slug's workspace is the one meant.
 */
export function resolveLink(snapshot: Pick<SessionSnapshot, "workspaces" | "panes" | "layouts">, named: Pick<AppLink, "workspace" | "workspaceSlug" | "pane">): { pane: string | null; workspace: string | null; note: LinkNote | null } {
  const link = withRosterId(snapshot, named);
  const byId = link.workspace ? snapshot.workspaces.find((candidate) => candidate.workspace_id === link.workspace) : undefined;
  const bySlug = link.workspaceSlug ? snapshot.workspaces.filter((candidate) => slugOf(candidate.label) === link.workspaceSlug) : [];
  const workspace = byId && (!link.workspaceSlug || slugOf(byId.label) === link.workspaceSlug || bySlug.length !== 1) ? byId : bySlug.length === 1 ? bySlug[0] : byId;
  const pane = link.pane ? snapshot.panes.find((candidate) => candidate.pane_id === link.pane) : undefined;
  if (pane && (!workspace || pane.workspace_id === workspace.workspace_id)) return { pane: pane.pane_id, workspace: pane.workspace_id, note: null };
  if (workspace) return { pane: workspacePane(snapshot, workspace.workspace_id), workspace: workspace.workspace_id, note: link.pane ? "pane-closed" : null };
  return { pane: null, workspace: null, note: link.pane || link.workspace ? "workspace-closed" : null };
}

/**
 * The link with the workspace id as the roster holds it. readLink cuts `ws` at its first hyphen,
 * but herdr-core's ids hold hyphens (`ovis-<uuid>`): when no workspace has the cut id, the whole
 * value is a workspace's id, or its id followed by the slug. Such an id is never handed out again,
 * so it alone names the workspace: its slug is dropped, never preferred as a short id's is.
 */
function withRosterId<T extends Pick<AppLink, "workspace" | "workspaceSlug">>(snapshot: Pick<SessionSnapshot, "workspaces">, link: T): T {
  if (!link.workspace || !link.workspaceSlug || snapshot.workspaces.some((candidate) => candidate.workspace_id === link.workspace)) return link;
  const whole = `${link.workspace}-${link.workspaceSlug}`;
  const id = snapshot.workspaces.map((candidate) => candidate.workspace_id)
    .filter((candidate) => whole === candidate || whole.startsWith(`${candidate}-`))
    .sort((one, other) => other.length - one.length)[0];
  return id === undefined ? link : { ...link, workspace: id, workspaceSlug: null };
}

export function isNavigation(from: Pick<AppLink, "machine" | "pane">, to: Pick<AppLink, "machine" | "pane">): boolean {
  return to.pane !== null && (from.machine !== to.machine || from.pane !== to.pane);
}

export const NAV_KEY = "ovis:nav";
