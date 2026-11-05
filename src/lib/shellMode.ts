/**
 * Which build this page is. The hosted shell (app.ovis.sh, `vite build --mode shell`,
 * scripts/shell-build.ts) names itself in one meta; the build a PC's own server serves has none,
 * and every caller here then behaves as before. Read from the document, never from a setting:
 * the mode is a property of the page that loaded, not of the user.
 */
import { SERVER_ID_PATTERN } from "../../shared/relay-id.ts";

export type ShellMode = "relay" | null;

export function shellModeOf(document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null }): ShellMode {
  return document.querySelector('meta[name="ovis-shell"]')?.getAttribute("content") === "relay" ? "relay" : null;
}

/** The mode of this page; null in the server-served build and outside a browser. */
export function shellMode(): ShellMode {
  return typeof document === "undefined" ? null : shellModeOf(document);
}

/** The path a PC's app lives under in the hosted shell: its scope, its manifest's and its worker's base. */
export function serverScopePath(serverId: string): string {
  return `/s/${serverId}/`;
}

/** The PC whose scope `pathname` is in (`/s/<server_id>/…`); null on the shell's front page or any other path. */
export function serverIdOfPath(pathname: string): string | null {
  const id = /^\/s\/([^/]+)(?:\/|$)/.exec(pathname)?.[1];
  return id !== undefined && SERVER_ID_PATTERN.test(id) ? id : null;
}

/**
 * The service worker a page of the hosted shell registers: a PC's scope registers the worker
 * under its own path (`/s/<id>/sw.js`, which the host answers with /sw.js), so each PC's app has
 * a worker, a cache and a push subscription of its own; the front page registers none.
 */
export function shellServiceWorker(pathname: string): { script: string; scope: string } | null {
  const serverId = serverIdOfPath(pathname);
  if (serverId === null) return null;
  const scope = serverScopePath(serverId);
  return { script: `${scope}sw.js`, scope };
}
