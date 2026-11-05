import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Eye, EyeOff, FolderPlus, House } from "lucide-react";

import "./DirectoryBrowser.css";
import { FileGlyph } from "./FileGlyph.tsx";

import type { DirectoryListing } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { formatBytes } from "../lib/bridgeProgress.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { resolveWorkspaceRoot, workspaceRelativePath } from "../lib/workspacePath.ts";
import { homeRelative, subscribeFilesFolder, takeFilesFolder } from "../lib/paletteFolders.ts";

export { homeRelative };

export interface DirectoryBrowserProps {
  /** where to open: the path typed so far (absolute, `~` or `~/…`); empty or unreadable opens home */
  start: string;
  /** the folder chosen, in the dialog's own syntax (`~/…` inside home); without it there is no "Use this folder" */
  onPick?: (path: string) => void;
  /** lists files too, and opens the one clicked (its absolute path) */
  onOpenFile?: (path: string) => void;
  /** told the folder shown (its absolute path, and the PC's home) each time one opens; New workspace drafts Directory from it */
  onFolder?: (path: string, home: string) => void;
}

function childPath(parent: string, name: string): string {
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

/**
 * A folder browser for the new-session dialog: one directory at a time, fetched from the
 * PC the session starts on. Nothing is kept but the folder shown now.
 */
export function DirectoryBrowser({ start, onPick, onOpenFile, onFolder }: DirectoryBrowserProps) {
  const t = useT();
  const { fetchDirectories, createDirectory } = useMachineApi();
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // New folder: the name being typed (null: no field), and why the last try failed
  const [naming, setNaming] = useState<string | null>(null);
  const [namingError, setNamingError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const request = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);
  const shownPath = listing?.path;
  // home shown in place of a path that does not open was not opened by the user: the typed path stays
  const fellBack = useRef(false);
  // counts moves to another folder; a refresh of the one shown (Show hidden) is not one
  const moves = useRef(0);
  // Show hidden as it is when a made folder opens, not as it was when making it began
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const shownByFallback = useRef(false);
  useEffect(() => { if (listing && !shownByFallback.current) onFolder?.(listing.path, listing.home); }, [shownPath]);

  const open = useCallback(async (path: string, showHidden: boolean, fallbackHome: boolean) => {
    const id = ++request.current;
    if (path !== listing?.path) moves.current++;
    const fallback = fellBack.current;
    fellBack.current = false;
    setLoading(true);
    try {
      const next = await fetchDirectories(path, showHidden, onOpenFile !== undefined);
      if (id !== request.current) return;
      if (listing !== null && next.path !== listing.path) setQuery("");
      shownByFallback.current = fallback;
      setListing(next);
      setError(null);
      listRef.current?.scrollTo({ top: 0 });
    } catch (reason: unknown) {
      if (id !== request.current) return;
      // a path typed half-way opens home instead of an error
      if (fallbackHome && reason instanceof ApiError && reason.code === "invalid_cwd") {
        fellBack.current = true;
        return void open("", showHidden, false);
      }
      setError(reason instanceof ApiError && reason.status === 404
        ? t("This PC's bridge cannot browse folders yet. Type the path instead.")
        : reason instanceof ApiError && reason.code === "invalid_cwd" ? t("This folder cannot be opened.") : t("Folders could not be loaded."));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [fetchDirectories, listing, onOpenFile, t]);

  // Files opens on a folder the palette picked (lib/paletteFolders.ts) instead of the pane's own,
  // also when it is open already
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const requested = onOpenFile ? takeFilesFolder() : null;
    void open(requested ?? start, false, requested === null);
    if (!onOpenFile) return;
    return subscribeFilesFolder(() => {
      const next = takeFilesFolder();
      if (next === null) return;
      setHidden(false);
      void openRef.current(next, false, false);
    });
  }, []);

  // makes the folder inside the one shown and opens it, so New workspace's Directory follows
  const makeFolder = async () => {
    if (listing === null || naming === null || naming.trim() === "" || creating) return;
    setCreating(true);
    // the user may open another folder while the folder is made: then the made one is not opened
    const asked = moves.current;
    try {
      const made = await createDirectory(listing.path, naming);
      setNaming(null);
      setNamingError(null);
      if (moves.current === asked) void open(made.path, hiddenRef.current, false);
    } catch (reason: unknown) {
      const code = reason instanceof ApiError ? reason.code : null;
      setNamingError(code === "folder_exists" ? t("Something with that name is already here.")
        : code === "invalid_name" ? t("That name cannot be a folder name.")
        : code === "permission_denied" ? t("No permission to make a folder here.")
        // a PC on an older version answers the listing's own GET-only refusal
        : code === "method_not_allowed" || (reason instanceof ApiError && reason.status === 404) ? t("This PC's bridge cannot make folders yet.")
        : t("The folder could not be made."));
    } finally {
      setCreating(false);
    }
  };

  const path = listing?.path ?? "";
  const homeShown = listing ? homeRelative(listing.path, listing.home) : start || "~";
  // browsing files reads from the folder opened on; picking a folder keeps the `~/…` form it hands back
  const shown = listing && onPick === undefined ? workspaceRelativePath(listing.path, resolveWorkspaceRoot(start, listing.home), homeShown) : homeShown;
  const normalizedQuery = query.trim().toLowerCase();
  const directories = listing === null || onPick === undefined || normalizedQuery === ""
    ? listing?.directories
    : listing.directories.filter((name) => name.toLowerCase().includes(normalizedQuery));
  // A listing in flight owns the next answer: a toggle that opened the old path would discard it.
  const toggleHidden = (): void => {
    if (loading || listing === null) return;
    const next = !hidden;
    setHidden(next);
    void open(listing.path, next, false);
  };
  const footer = <div className="dir-browser-footer">
    <label className="dir-browser-hidden">
      <input type="checkbox" checked={hidden} disabled={loading || listing === null} onChange={toggleHidden} />
      {t("Show hidden")}
    </label>
  </div>;

  return (
    <div className="dir-browser" role="group" aria-label={t("Choose a folder")} aria-busy={loading}>
      <div className="dir-browser-bar">
        <button type="button" className="icon-button" aria-label={t("Parent folder")} title={t("Parent folder")} disabled={!listing?.parent || loading} onClick={() => listing?.parent && void open(listing.parent, hidden, false)}>
          <ArrowUp aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" aria-label={t("Home folder")} title={t("Home folder")} disabled={loading || (listing !== null && listing.path === listing.home)} onClick={() => void open("", hidden, false)}>
          <House aria-hidden="true" />
        </button>
        <span className="dir-browser-path" title={path}><span dir="ltr">{shown}</span></span>
        {onPick !== undefined && (
          <button type="button" className="icon-button" aria-label={t("Show hidden")} title={t("Show hidden")} aria-pressed={hidden} disabled={loading || listing === null} onClick={toggleHidden}>
            {hidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
          </button>
        )}
        {onPick !== undefined && (
          <button type="button" className="icon-button" aria-label={t("New folder")} title={t("New folder")} aria-expanded={naming !== null} disabled={listing === null || loading || error !== null} onClick={() => setNaming((current) => current ?? "")}>
            <FolderPlus aria-hidden="true" />
          </button>
        )}
      </div>
      {onPick !== undefined && <div className="dir-browser-tools">
        <div className="dir-browser-filter">
          {/* a touch screen would raise its keyboard over the list just opened; Escape clears the
              filter before it reaches the dialog's own Escape, which closes the dialog */}
          <input type="search" className="input" aria-label={t("Filter folders")} placeholder={t("Filter folders")} value={query} autoFocus={window.matchMedia?.("(pointer: coarse)").matches !== true}
            autoComplete="off" spellCheck={false}
            onChange={(event) => { setQuery(event.target.value); listRef.current?.scrollTo({ top: 0 }); }}
            onKeyDown={(event) => {
              // Enter confirms an IME candidate; Escape dismisses it, not this dialog.
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
                event.stopPropagation();
                return;
              }
              if (event.key === "Enter") event.preventDefault();
              if (event.key === "Escape" && query !== "") {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }
            }} />
        </div>
        <button type="button" className="btn btn-primary" disabled={listing === null || loading} onClick={() => listing && onPick(homeRelative(listing.path, listing.home))}>
          {t("Use this folder")}
        </button>
      </div>}
      {naming !== null && (
        <div className="dir-browser-new">
          {/* inside New workspace's form: Enter makes the folder rather than starting the workspace,
              Escape closes this field rather than the dialog, and an IME keeps its own keys */}
          <input className="input" aria-label={t("New folder name")} placeholder={t("New folder name")} autoFocus value={naming} readOnly={creating}
            autoComplete="off" autoCapitalize="off" spellCheck={false} aria-invalid={namingError !== null}
            onChange={(event) => { setNaming(event.target.value); setNamingError(null); }}
            onBlur={() => { if (naming.trim() === "") setNaming(null); }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
                event.stopPropagation();
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                void makeFolder();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setNaming(null);
                setNamingError(null);
              }
            }} />
          {namingError !== null && <p className="dir-browser-note dir-browser-error" role="alert">{namingError}</p>}
        </div>
      )}
      {error !== null ? <p className="dir-browser-note dir-browser-error" role="alert">{error}</p> : (
        <ul className="dir-browser-list" ref={listRef}>
          {listing === null && <li className="dir-browser-note" role="status">{t("Loading…")}</li>}
          {directories?.map((name) => (
            <li key={name}>
              <button type="button" className="dir-browser-item" disabled={loading} onClick={() => void open(childPath(path, name), hidden, false)}>
                <FileGlyph name={name} kind="directory" />
                <span>{name}</span>
              </button>
            </li>
          ))}
          {onOpenFile !== undefined && listing?.files?.map((file) => (
            <li key={`file:${file.name}`}>
              <button type="button" className="dir-browser-item is-file" disabled={loading} onClick={() => onOpenFile(childPath(path, file.name))}>
                <FileGlyph name={file.name} />
                <span>{file.name}</span>
                <span className="dir-browser-size">{formatBytes(file.size)}</span>
              </button>
            </li>
          ))}
          {listing !== null && onPick !== undefined && normalizedQuery !== "" && directories?.length === 0 && <li className="dir-browser-note" role="status">{t("No matching folders")}</li>}
          {listing !== null && normalizedQuery === "" && listing.directories.length === 0 && (listing.files ?? []).length === 0 && <li className="dir-browser-note">{t(onOpenFile ? "Nothing here" : "No folders here")}</li>}
          {listing?.truncated && <li className="dir-browser-note">{t("Showing the first {n} folders; type the rest of the path to go further.", { n: listing.directories.length })}</li>}
          {listing?.truncated && onPick !== undefined && <li className="dir-browser-note">{t("Search is limited to the {n} loaded folders.", { n: listing.directories.length })}</li>}
        </ul>
      )}
      {onPick === undefined && footer}
    </div>
  );
}
