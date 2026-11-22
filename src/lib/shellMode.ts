import { SERVER_ID_PATTERN } from "../../shared/relay-id.ts";

export type ShellMode = "relay" | null;

export function shellModeOf(document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null }): ShellMode {
  return document.querySelector('meta[name="ovis-shell"]')?.getAttribute("content") === "relay" ? "relay" : null;
}

export function shellMode(): ShellMode {
  return typeof document === "undefined" ? null : shellModeOf(document);
}

export function serverScopePath(serverId: string): string {
  return `/s/${serverId}/`;
}

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

/**
 * The hosted shell's worker opens a PC's page from the shell it kept (public/sw.js), so a reload
 * meant to bring in a newer shell asks that PC's worker to go to the host first; the kept copy
 * stays its fallback. Keyed by the PC: another PC's worker on the origin does not take the request.
 */
export async function requestFreshShell(storage: Pick<CacheStorage, "open">, serverId: string): Promise<void> {
  await (await storage.open("ovis-files-v1")).put(`/__ovis-fresh-shell/${serverId}`, new Response("1"));
}
