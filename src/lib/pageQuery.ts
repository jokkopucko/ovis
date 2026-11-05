/**
 * The query of this page's address: what it shows, such as the app's place (lib/deepLink.ts), a
 * reader tab's file (lib/fileReader.ts) or a tapped alert's pane (public/sw.js). A PC's own server
 * keeps it in the query (`/?file=…`), as it always has: that server is the PC. In the hosted shell
 * (app.ovis.sh) every request goes to a host of ours, query included, while the paths and names in
 * it are the PC's: there the same query rides in the fragment (`/s/<id>/#file=…`), which a browser
 * keeps to the page and never sends, as the pairing offer does.
 */
import { shellMode, type ShellMode } from "./shellMode.ts";

/** This page's query, `?` and all, or "". */
export function pageSearch(location: { search: string; hash: string } = window.location, mode: ShellMode = shellMode()): string {
  if (mode !== "relay") return location.search;
  // an address from before the fragment carried it (a link, or an older entry of the history) is
  // still read, its query first; boot.ts moves it into the fragment (moveQueryToFragment)
  if (location.search.length > 1) return location.search;
  // a pairing link pasted over the app is the shell's to ask about (lib/relay/shell.tsx), never the page's state
  return location.hash.length > 1 && !location.hash.startsWith("#offer=") ? `?${location.hash.slice(1)}` : "";
}

interface LinkClick { button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; currentTarget: { getAttribute(name: string): string | null }; preventDefault(): void }
interface Reloadable { location: { pathname: string; reload(): void }; history: { state: unknown; replaceState(data: unknown, unused: string, url: string): void } }

/**
 * A plain click on a link to this page's own address (`pageAddress`), such as Reconnect: in the
 * hosted shell it changes only the fragment, which loads nothing, so the page takes the address
 * and reloads. A click that opens a new tab or window, or saves the link, is the browser's.
 */
export function reloadOnPlainClick(event: LinkClick, page: Reloadable = window, mode: ShellMode = shellMode()): void {
  if (mode !== "relay" || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  page.history.replaceState(page.history.state, "", event.currentTarget.getAttribute("href") ?? page.location.pathname);
  page.location.reload();
}

/**
 * An address of the hosted shell with a query left from an older build, the load's own or an
 * entry Back or Forward lands on: the query moves into the fragment, so a reload or the page's
 * next request does not carry it again. Returns whether it moved.
 */
export function moveQueryToFragment(page: { location: { pathname: string; search: string }; history: { state: unknown; replaceState(data: unknown, unused: string, url: string): void } }): boolean {
  if (page.location.search.length <= 1) return false;
  page.history.replaceState(page.history.state, "", `${page.location.pathname}#${page.location.search.slice(1)}`);
  return true;
}

/** The address that says `search` (as pageSearch gives it) at `pathname`: what history.pushState takes. */
export function pageAddress(pathname: string, search: string, hash: string, mode: ShellMode = shellMode()): string {
  if (mode !== "relay") return `${pathname}${search}${hash}`;
  const query = search.startsWith("?") ? search.slice(1) : search;
  return query === "" ? pathname : `${pathname}#${query}`;
}
