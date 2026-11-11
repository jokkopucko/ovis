/**
 * Network shares on a Windows PC. Reading a path on one (a stat is enough) makes Windows ask that host for the
 * file and sign in to it with the user's account, so a path that a link, an address or an agent's reply names
 * must not reach the filesystem as one. Every path the page asks for is resolved by resolveFilePath
 * (file-view.ts) or resolveFolder (directories.ts), and both refuse it here.
 */

/** The names Windows serves WSL's own files under: this PC, and no other host. */
const WSL_HOSTS = new Set(["wsl$", "wsl.localhost"]);

/**
 * The host and share of a path Windows has resolved (`\\host\share\…`), in lower case. undefined for a path on
 * a drive, in its long form too (`\\?\C:\…`); null for any other device path (`\\?\UNC\…`, `\\.\…`,
 * `\\?\GLOBALROOT\…`), which can name a share in more ways than are worth telling apart.
 */
function shareOf(path: string): string | null | undefined {
  if (!path.startsWith("\\\\") || /^\\\\\?\\[a-z]:(?:\\|$)/i.test(path)) return undefined;
  const [, host = "", share = ""] = /^\\\\([^\\]*)\\?([^\\]*)/.exec(path) ?? [];
  return host === "?" || host === "." ? null : `${host}\\${share}`.toLowerCase();
}

/**
 * Whether `path`, as Windows resolved it, is on a network share other than WSL's and the ones the `own` folders
 * are on (the pane's folder, the home folder): a PC that works on a share reads its own files there already.
 */
export function otherHostsShare(path: string, own: ReadonlyArray<string | null>): boolean {
  const share = shareOf(path);
  if (share === undefined) return false;
  if (share === null) return true;
  if (WSL_HOSTS.has(share.slice(0, share.indexOf("\\")))) return false;
  return !own.some((folder) => folder !== null && shareOf(folder) === share);
}
