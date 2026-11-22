import type { SessionSnapshot } from "../../shared/protocol.ts";
import { readLink, resolveLink, type AppLink } from "./deepLink.ts";
import { desktopLinks, type DesktopLinks } from "./desktopLink.ts";

export type NotificationPaneView = "chat" | "terminal";
export type NotificationTarget = { machine_id: string; pane_id: string; view?: NotificationPaneView; workspace_id?: string; link?: AppLink };
type Target = NotificationTarget;
type Select = (target: Target) => void;

export function notificationTargetFromSearch(search: string): NotificationTarget | null {
  const params = new URLSearchParams(search);
  const pane_id = params.get("pane");
  const view = params.get("view");
  if (!pane_id || (view !== "chat" && view !== "terminal")) return null;
  return { machine_id: params.get("machine") ?? "local", pane_id, view };
}

export function notificationViewForPane(target: NotificationTarget | null, machineId: string, paneId: string | null): NotificationPaneView | null {
  if (!target || paneId === null || target.machine_id !== machineId || target.pane_id !== paneId) return null;
  return target.view ?? null;
}
export function machineMissing(roster: readonly { id: string }[], machineId: string): boolean {
  return roster.length > 0 && !roster.some((machine) => machine.id === machineId);
}

/**
 * Whether a PC named at roster `since` (the count of rosters the server had sent then) is gone:
 * only a roster the server sent after that can say so. The list in hand when a link or a
 * selection was made may predate the PC (a tab resumed before its roster refreshed, a PC just
 * added), and a list rebuilt from it (a pane's status) is no newer. `since` null: nothing waits.
 */
export function machineGone(roster: readonly { id: string }[], rosterSeq: number, since: number | null, machineId: string): boolean {
  return since !== null && rosterSeq > since && machineMissing(roster, machineId);
}

type RosterMachine = { id: string; snapshot?: { panes: readonly { pane_id: string }[] } | null };

export function notificationLanding(roster: readonly RosterMachine[], target: NotificationTarget): { kind: "select" } | { kind: "link"; link: AppLink; stale: boolean } {
  const machine = roster.find((candidate) => candidate.id === target.machine_id);
  if (machine?.snapshot?.panes.some((pane) => pane.pane_id === target.pane_id)) return { kind: "select" };
  const link: AppLink = { machine: target.machine_id, workspace: target.workspace_id ?? null, pane: target.pane_id, view: target.view ?? null, settings: null };
  return { kind: "link", link, stale: machineMissing(roster, target.machine_id) };
}

type LinkRoster = { id: string; state?: string; snapshot?: Pick<SessionSnapshot, "workspaces" | "panes" | "layouts"> | null };

/**
 * Anything else selects no pane yet: the link waits as the
 * address's does, settled once its PC is connected with its roster in, with its note
 * (lib/useSelection.ts), since an offline PC's cached roster may list a pane that has closed.
 */
export function linkLanding(roster: readonly LinkRoster[], link: AppLink): { kind: "select"; pane: string } | { kind: "wait"; stale: boolean } {
  const machine = roster.find((candidate) => candidate.id === link.machine);
  const landed = machine?.state === "connected" && machine.snapshot ? resolveLink(machine.snapshot, link) : null;
  if (landed?.pane && !landed.note) return { kind: "select", pane: landed.pane };
  return { kind: "wait", stale: machineMissing(roster, link.machine) };
}

export function sameLink(a: AppLink | null, b: AppLink): boolean {
  return a !== null && a.machine === b.machine && a.pane === b.pane && (a.workspace ?? null) === (b.workspace ?? null)
    && (a.workspaceSlug ?? null) === (b.workspaceSlug ?? null) && (a.view ?? null) === (b.view ?? null);
}

type MessageSource = { addEventListener: (type: string, listener: (event: Event) => void) => void };

/**
 * The event the Android app dispatches on an open page's window with a tapped alert's "select-pane"
 * as its data (PCStore.selectionScript): a page on plain http has no navigator.serviceWorker. Taken
 * as the worker's message is, and cancelled, so the app knows this page heard it and does not
 * dispatch it on the worker as well, as it does for an older page.
 */
export const SELECT_PANE_EVENT = "ovis-select-pane";

export function linkTarget(query: string): NotificationTarget | null {
  const link = readLink(query);
  if (!link.pane) return null;
  const place: AppLink = { machine: link.machine, workspace: link.workspace, workspaceSlug: link.workspaceSlug ?? null, pane: link.pane, view: link.view, settings: null };
  return { machine_id: link.machine, pane_id: link.pane, ...(link.view ? { view: link.view } : {}), link: place };
}

export function notificationTargets(source?: MessageSource, links?: DesktopLinks, page?: MessageSource): (select: Select) => () => void {
  let pending: Target | null = null;
  let consumer: Select | null = null;
  const take = (target: Target): void => {
    if (consumer) consumer(target);
    else pending = target;
  };
  links?.onOpen((query) => {
    const target = linkTarget(query);
    if (target) take(target);
  });
  const receive = (event: Event) => {
    const data = (event as Partial<MessageEvent>).data as { type?: unknown; pane_id?: unknown; machine_id?: unknown; view?: unknown; workspace_id?: unknown } | null;
    if (data?.type !== "select-pane" || typeof data.pane_id !== "string") return;
    const target: Target = {
      machine_id: typeof data.machine_id === "string" ? data.machine_id : "local",
      pane_id: data.pane_id,
    };
    if (data.view === "chat" || data.view === "terminal") target.view = data.view;
    if (typeof data.workspace_id === "string" && data.workspace_id !== "") target.workspace_id = data.workspace_id;
    take(target);
  };
  source?.addEventListener("message", receive);
  page?.addEventListener(SELECT_PANE_EVENT, (event) => {
    event.preventDefault();
    receive(event);
  });
  return (select) => {
    consumer = select;
    const target = pending;
    pending = null;
    if (target) select(target);
    return () => { if (consumer === select) consumer = null; };
  };
}

// Browser messages can arrive after document loading but before React's effect.
// Install this listener while App's module loads, before creating its root.
export const onNotificationTarget = notificationTargets(
  typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : undefined,
  desktopLinks(),
  typeof window !== "undefined" ? window : undefined,
);
