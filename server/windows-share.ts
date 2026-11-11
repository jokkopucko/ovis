/**
 * Network shares on a Windows PC. Reading a path on one (a stat is enough) makes Windows ask that host for the
 * file and sign in to it with the user's account, so a path that a link, an address or an agent's reply names
 * must not reach the filesystem as one. Every path the page asks for is resolved by resolveFilePath
 * (file-view.ts), resolveFolder or expandedPath (directories.ts), and each refuses it here; only the folder of a
 * create request is taken as named (expandedPath's "chosen"). A Markdown link is not refused on the page: the page
 * does not know the server's system, nor where its panes work. (A `file:///` link, a Codex citation and an image
 * still are, as before.)
 */

/** The names Windows serves WSL's own files under: this PC, and no other host. */
const WSL_HOSTS = new Set(["wsl$", "wsl.localhost"]);

/**
 * The host and share of a path Windows has resolved (`\\host\share\…`), in lower case, in its long form too
 * (`\\?\UNC\host\share\…`, as a pane's folder may be told). undefined for a path on a drive, in its long form
 * too (`\\?\C:\…`); null for any other device path (`\\.\…`, `\\?\GLOBALROOT\…`), which can name a share in
 * more ways than are worth telling apart.
 */
function shareOf(path: string): string | null | undefined {
  if (!path.startsWith("\\\\") || /^\\\\\?\\[a-z]:(?:\\|$)/i.test(path)) return undefined;
  const [, host = "", share = ""] = /^\\\\(?:\?\\UNC\\)?([^\\]*)\\?([^\\]*)/i.exec(path) ?? [];
  return host === "?" || host === "." ? null : `${host}\\${share}`.toLowerCase();
}

/** The shares the PC's panes work on, as herdr's last snapshot named their folders (notePaneFolders). */
let paneShares: ReadonlySet<string> = new Set();

/**
 * herdr's snapshot was read: the folders its panes are in, in either spelling of the separators. A share one of them
 * is on is the PC's own to read, for every route: the folder browser, a folder's skills and a workspace's icon
 * name no pane whose folder could say so, and a page older than this server names none either.
 */
export function notePaneFolders(folders: Iterable<string | null | undefined>): void {
  const shares = new Set<string>();
  for (const folder of folders) {
    const share = folder ? shareOf(folder.replaceAll("/", "\\")) : undefined;
    if (share) shares.add(share);
  }
  paneShares = shares;
}

/**
 * Whether `path`, as Windows resolved it, is on a network share other than WSL's, the ones the PC's panes work on
 * and the ones the `own` folders are on (the pane a request names, the home folder): a PC that works on a share
 * reads its own files there already.
 */
export function otherHostsShare(path: string, own: ReadonlyArray<string | null>): boolean {
  const share = shareOf(path);
  if (share === undefined) return false;
  if (share === null) return true;
  if (WSL_HOSTS.has(share.slice(0, share.indexOf("\\")))) return false;
  return !paneShares.has(share) && !own.some((folder) => folder !== null && shareOf(folder) === share);
}
