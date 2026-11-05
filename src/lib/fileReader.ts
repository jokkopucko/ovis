/**
 * A markdown file opened in a tab of its own (the file viewer's "Open in a new tab"): a page of
 * just the document, never the whole app over it. Its address names the file and the PC it is on,
 * in the fragment in the hosted shell (lib/pageQuery.ts).
 */
import { pageAddress, pageSearch } from "./pageQuery.ts";
import { shellMode, type ShellMode } from "./shellMode.ts";

export interface ReaderTarget { machine: string; path: string }

const PARAM = "read";

export function readerHref(machine: string, path: string, pathname = window.location.pathname, mode: ShellMode = shellMode()): string {
  const query = new URLSearchParams({ [PARAM]: path, machine });
  return pageAddress(pathname, `?${query.toString()}`, "", mode);
}

export function readerFromSearch(search: string): ReaderTarget | null {
  const query = new URLSearchParams(search);
  const path = query.get(PARAM);
  if (path === null || path.trim() === "") return null;
  return { machine: query.get("machine") || "local", path };
}

/**
 * The page is the reader or the app as it loaded (main.tsx). A PC's own server loads a new page for
 * every address it is sent to; in the hosted shell an address that changes only the fragment
 * (pasted, or Back and Forward) loads nothing, so one that turns the page into the other, or puts
 * the reader on another PC, loads it. A step between two files of the same PC is the reader's own
 * (FileReader), as a step between two places is the app's (useAddressBar).
 */
export function reloadWhenReaderChanges(loaded: ReaderTarget | null, page: { addEventListener(type: "hashchange", listener: () => void): void; location: { search: string; hash: string; reload(): void } } = window, mode: ShellMode = shellMode()): void {
  if (mode !== "relay") return;
  page.addEventListener("hashchange", () => {
    const next = readerFromSearch(pageSearch(page.location, mode));
    if ((next === null) !== (loaded === null) || (next !== null && next.machine !== loaded?.machine)) page.location.reload();
  });
}

/**
 * A link in the document, from the folder the document is in: `docs/guide.md`, `../x.md`; absolute and
 * `~/` paths stay. Above a `~/` document's home the `..` is kept (`~/../x.md`): only the PC knows where
 * its home is, and it expands the path.
 */
export function resolveFromDocument(document: string, target: string): string {
  if (/^(?:[\\/]|~\/|[A-Za-z]:[\\/])/.test(target)) return target;
  const folder = document.replace(/\\/g, "/").split("/").slice(0, -1);
  const home = folder[0] === "~";
  // a Windows share (//server/share) is a root as a whole: `..` never climbs above it
  const root = folder[0] === "" && folder[1] === "" && folder.length >= 4 ? 4 : 1;
  for (const part of target.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (folder.length > root && folder[folder.length - 1] !== "..") folder.pop();
      else if (home) folder.push("..");
    } else folder.push(part);
  }
  return folder.join("/") || "/";
}
