/**
 * Folder browsing inside the command palette (adapted from T3 Code's palette browse mode): a query
 * that starts as a path does (`~`, `/`, `C:\`) lists the folders of the PC instead of panes.
 */

import { sidebarPinKey } from "./sidebarPins.ts";

export interface FolderQuery {
  directory: string;
  filter: string;
}

const PATH_START = /^(?:~(?:[\\/]|$)|\/|[A-Za-z]:[\\/])/u;

export function folderQuery(query: string): FolderQuery | null {
  if (!PATH_START.test(query)) return null;
  const path = query.replace(/\\/g, "/");
  const cut = path.lastIndexOf("/");
  if (cut < 0) return { directory: path, filter: "" };
  let directory = path.slice(0, cut + 1);
  // `~/` is home and `C:/` a drive's root: only a deeper folder loses its trailing slash
  if (directory === "~/") directory = "~";
  else if (directory !== "/" && !/^[A-Za-z]:\/$/u.test(directory)) directory = directory.replace(/\/+$/u, "") || "/";
  return { directory, filter: path.slice(cut + 1) };
}

export function homeRelative(path: string, home: string): string {
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export function folderQueryFor(path: string, home: string | null): string {
  const shown = home === null ? path : homeRelative(path, home);
  return shown.endsWith("/") ? shown : `${shown}/`;
}

export function browseEntries(directories: readonly string[], filter: string): string[] {
  const lower = filter.toLowerCase();
  const showHidden = filter.startsWith(".");
  const visible = directories.filter((name) => name.toLowerCase().startsWith(lower) && (showHidden || !name.startsWith(".")));
  const exact = filter === "" ? -1 : visible.findIndex((name) => name.toLowerCase() === lower);
  return exact <= 0 ? visible : [visible[exact]!, ...visible.slice(0, exact), ...visible.slice(exact + 1)];
}

interface PinnedPane { pane_id: string; cwd?: string | null; foreground_cwd?: string | null }

export function pinnedFolders(pins: readonly string[], machineId: string, panes: readonly PinnedPane[]): string[] {
  const byKey = new Map(panes.map((pane) => [sidebarPinKey(machineId, pane.pane_id), pane]));
  const folders = pins.flatMap((key) => {
    const pane = byKey.get(key);
    const path = pane?.foreground_cwd ?? pane?.cwd;
    return path ? [path] : [];
  });
  return [...new Set(folders)];
}

export function matchFolders(paths: readonly string[], query: string, home: string | null, limit: number): string[] {
  const typed = query.replace(/\\/g, "/").toLowerCase();
  const forms = (path: string): string[] => [folderQueryFor(path, null), ...(home === null ? [] : [folderQueryFor(path, home)])].map((form) => form.toLowerCase());
  return paths.filter((path) => forms(path).some((form) => form !== typed && form.startsWith(typed))).slice(0, limit);
}

let requestedFolder: string | null = null;
const folderListeners = new Set<() => void>();

export function requestFilesFolder(path: string): void {
  requestedFolder = path;
  for (const listener of [...folderListeners]) listener();
}

export function takeFilesFolder(): string | null {
  const path = requestedFolder;
  requestedFolder = null;
  return path;
}

export function subscribeFilesFolder(listener: () => void): () => void {
  folderListeners.add(listener);
  return () => { folderListeners.delete(listener); };
}
