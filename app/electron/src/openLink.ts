/**
 * A link is read here only to be passed on: it becomes a query of the deep link's own names, which
 * the window's page reads as any address of its own. Nothing else of it is kept, so a link can never
 * send the window to another address, path or scheme, and one that names no pane is no link.
 */

export const LINK_SCHEME = "ovis";

/** the names a link passes on: the place of a pane, nothing that opens a file, a dialog or Settings. */
const NAMES = ["machine", "ws", "pane", "view"] as const;
/** no name a link passes on is longer: herdr's ids and a PC's name are short */
const VALUE_MAX = 256;

/**
 * The query an `ovis://open?…` link names (`?machine=…&ws=…&pane=…&view=…`, in that order and
 * only those), or null when `value` is not such a link: another scheme or host, a user, port or
 * path, no pane, or a value too long or holding a control character.
 */
export function openLinkQuery(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== `${LINK_SCHEME}:` || url.hostname.toLowerCase() !== "open" || url.username || url.password || url.port) return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  const query = new URLSearchParams();
  for (const name of NAMES) {
    const named = url.searchParams.get(name)?.trim();
    if (!named) continue;
    if (named.length > VALUE_MAX || /[\u0000-\u001f\u007f]/.test(named)) return null;
    query.set(name, named);
  }
  if (!query.has("pane")) return null;
  return `?${query.toString()}`;
}

/**
 * The query of the link a start of the app was handed (Windows and Linux open a link by starting
 * the app with it; a second start passes its arguments to the running one), or null. Only an
 * argument that is a whole link counts: the last one, as the system puts it last.
 */
export function argvLinkQuery(argv: readonly string[]): string | null {
  for (let at = argv.length - 1; at >= 0; at -= 1) {
    const arg = argv[at]!;
    if (arg.toLowerCase().startsWith(`${LINK_SCHEME}:`)) return openLinkQuery(arg);
  }
  return null;
}

export type LinkPage = { ours: boolean; loadingMainFrame: boolean };

/**
 * Whether main tells the waiting link to its window's page now: only to its own server's page, and
 * only once that page itself has loaded (`loaded`: its did-finish-load), as a page still loading
 * would lose it. A frame in the page (a web panel, a file's preview) may load for long after, so
 * only the page's own load counts: isLoadingMainFrame, never isLoading.
 */
export function tellsLink(pending: string | null, page: LinkPage | null, loaded: boolean): boolean {
  return pending !== null && page !== null && page.ours && (loaded || !page.loadingMainFrame);
}

export function linkHold(): { receive(query: unknown): void; onOpen(listener: (query: string) => void): void } {
  let held: string | null = null;
  let listening: ((query: string) => void) | null = null;
  return {
    receive(query) {
      if (typeof query !== "string") return;
      if (listening) listening(query);
      else held = query;
    },
    onOpen(listener) {
      listening = listener;
      const waiting = held;
      held = null;
      if (waiting !== null) listener(waiting);
    },
  };
}
