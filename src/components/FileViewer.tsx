import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { Braces, Check, Code, Copy, Download, Ellipsis, ExternalLink as ExternalLinkIcon, Link2, Maximize2, PanelRight, Pencil, TableOfContents, TriangleAlert, X } from "lucide-react";

import "./FileViewer.css";
import { DirectoryBrowser } from "./DirectoryBrowser.tsx";
import { FileGlyph } from "./FileGlyph.tsx";
import { useHighlightedLines } from "./HighlightedCode.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { flushSync } from "react-dom";
import { RelayRenderedPage } from "./RelayRenderedPage.tsx";
import { usePageFocusGuard } from "../lib/usePageFocusGuard.ts";
import { hasDraft, TextFileEditor } from "./TextFileEditor.tsx";
import { TextFileView } from "./TextFileView.tsx";
import { MarkdownImageContext } from "./Markdown.tsx";
import { MarkdownOutline, OUTLINE_COLUMN_MIN_PX, useWideEnough } from "./MarkdownOutline.tsx";

import type { FileInfo } from "../../shared/protocol.ts";
import { MAX_EDITABLE_TEXT_BYTES } from "../../shared/files.ts";
import { ApiError, errorFrom } from "../lib/api.ts";
import { formatBytes } from "../lib/bridgeProgress.ts";
import { LOCAL_MACHINE, paneStorageId } from "../../shared/machines.ts";
import { useOpeningPaneLane } from "../lib/chatLane.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { copyText, selectContents } from "../lib/clipboard.ts";
import { fileLineTarget, pathParts } from "../lib/filePaths.ts";
import { lineRequest, readBudget, shownSource, sourceLayout, virtualHighlightable } from "../lib/sourcePreview.ts";
import { canHighlight, countLines, languageForPath, normalizeCode } from "../lib/highlight.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { MAX_INLINE_IMAGE_BYTES, markdownImagePreview } from "../lib/markdownImages.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useAppWindow } from "../lib/install.ts";
import type { MarkdownBlock } from "../../shared/markdown.ts";
import { knownPreview, parsePreviewOffThread } from "../lib/markdownPreview.ts";
import { outlineOf } from "../lib/markdownOutline.ts";
import { hasPreview, type TextViewMode } from "../lib/textPreview.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSettings } from "../lib/settings.ts";
import { readFilePreviewText, SOURCE_PREVIEW_LINES, type FilePreviewText } from "../lib/filePreviewText.ts";
import { readerHref } from "../lib/fileReader.ts";
import type { FilePresentation } from "../lib/filePresentation.ts";
import { getTransport } from "../lib/transport.ts";
import { useResourceUrl, useResourceUrlState } from "../lib/useResourceUrl.ts";
import { RelayResourceTooLargeError } from "../lib/relay/resources.ts";
import { fileFailure, fileFailureText, type FileFailure } from "../lib/fileFailure.ts";
import { ExternalLink } from "../lib/externalLink.ts";

type Preview = { status: "none" | "pending" | "failed" } | { status: "ready"; blocks: MarkdownBlock[] };

const NO_PREVIEW: Preview = { status: "none" };
const PENDING_PREVIEW: Preview = { status: "pending" };
const FAILED_PREVIEW: Preview = { status: "failed" };

function useMarkdownPreview(text: string | null): Preview {
  const known = useMemo((): Preview | null => {
    if (text === null) return NO_PREVIEW;
    const blocks = knownPreview(text);
    if (blocks === undefined) return null;
    return blocks === null ? FAILED_PREVIEW : { status: "ready", blocks };
  }, [text]);
  const [answer, setAnswer] = useState<{ text: string; blocks: MarkdownBlock[] | null } | null>(null);
  useEffect(() => {
    if (known !== null || text === null) return;
    let live = true;
    const job = parsePreviewOffThread(text);
    void job.promise.then((blocks) => { if (live) setAnswer({ text, blocks }); });
    return () => { live = false; job.cancel(); };
  }, [known, text]);
  if (known !== null) return known;
  if (answer === null || answer.text !== text) return PENDING_PREVIEW;
  return answer.blocks === null ? FAILED_PREVIEW : { status: "ready", blocks: answer.blocks };
}

export interface FileViewerProps {
  path: string;
  paneId: string | null;
  onClose: () => void;
  /** Settings can open above this preview; its Escape must not also close the file. */
  keyboardActive?: boolean;
  onOpen?: (path: string) => void;
  page?: boolean;
  docked?: boolean;
  panelStart?: ReactNode;
  onKind?: (presentation: FilePresentation) => void;
  onTogglePresentation?: () => void;
  /** this browser drives the PC (not a watching device, a Portal visitor or an open LAN window): with Settings → Edit text files on, a text file can be edited */
  editable?: boolean;
}

/**
 * When nothing copies it (no clipboard API on plain-HTTP LAN, and the browser's copy command
 * refused: copyText) it selects the source `<pre>` instead; in a Markdown Preview there is none,
 * and a virtualized source has no element holding the whole text, so `onShowSource` shows a
 * selectable source first and the viewer selects it once rendered.
 */
function CopyFileButton({ text, sourceRef, onShowSource }: { text: string; sourceRef: RefObject<HTMLElement | null>; onShowSource: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const label = copied ? t("File copied") : t("Copy file");
  const copy = async (): Promise<void> => {
    const source = sourceRef.current;
    if (await copyText(text, source)) setCopied(true);
    else if (!source) onShowSource();
  };
  return <button type="button" className="icon-button file-viewer-action" aria-label={label} title={label} onClick={() => void copy()}>
    {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
  </button>;
}

/**
 * In the installed app's window, where a new tab of this origin would open another app window,
 * the address is copied instead, to paste into a browser.
 */
function CopyLinkButton({ href, menuItem = false, onDone }: { href: string; menuItem?: boolean; onDone?: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const label = copied ? t("Link copied") : t("Copy link");
  const copy = async (): Promise<void> => {
    if (await copyText(new URL(href, window.location.href).href)) setCopied(true);
    onDone?.();
  };
  return menuItem
    ? <button type="button" role="menuitem" className="file-viewer-more-item" onClick={() => void copy()}><Link2 aria-hidden="true" />{label}</button>
    : <button type="button" className="icon-button file-viewer-action file-viewer-wide" aria-label={label} title={label} onClick={() => void copy()}>
      {copied ? <Check aria-hidden="true" /> : <Link2 aria-hidden="true" />}
    </button>;
}

function selectSource(element: HTMLElement): void {
  if (element instanceof HTMLTextAreaElement) { element.focus(); element.select(); }
  else selectContents(element);
}

export function FileViewer({ path: asked, paneId, onClose, onOpen, keyboardActive = true, page = false, docked = false, panelStart, onKind, onTogglePresentation, editable = false }: FileViewerProps) {
  const t = useT();
  const { settings } = useSettings();
  const [editing, setEditing] = useState(false);
  const [editChanged, setEditChanged] = useState(false);
  const [saves, setSaves] = useState(0);
  const locale = useLocale();
  const { fetchFileInfo, fileUrl, fetchDirectories } = useMachineApi();
  // a remote PC's bridge reads a relative folder from the pane's folder only from its next bundle
  // on; until then it would list the bridge's own folder, so only an absolute or ~/ one is listed there
  const machineId = useMachineId();
  const remote = machineId !== LOCAL_MACHINE;
  const [directory, setDirectory] = useState<string | null>(null);
  const [path, setPath] = useState(asked);
  const target = useMemo(() => fileLineTarget(path), [path]);
  const [info, setInfo] = useState<FileInfo | null>(null);
  const reportedKind = useRef<string | null>(null);
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [source, setSource] = useState(false);
  // A page is drawn without its scripts until the person asks for them: for the file named here, and for as long
  // as this viewer stays open (another file, a close or a reload starts without them again). `stopped`: the file
  // whose scripts were taken away again because its frame took the keyboard (lib/usePageFocusGuard.ts).
  const [scriptsFor, setScriptsFor] = useState<string | null>(null);
  const [stopped, setStopped] = useState<string | null>(null);
  const pageFrame = useRef<HTMLIFrameElement | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  usePhoneSheetBack(() => setMoreOpen(false), moreOpen);
  // the popup opens with the focus on its content, not its first button: Space then plays a video or
  // scrolls the text, where on the first button (Show beside the pane) it would press it
  const bodyRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLMediaElement>(null);
  const surface = useFocusTrap<HTMLElement>(!page && !docked, { initialFocus: bodyRef });
  const appWindow = useAppWindow();
  useOpeningPaneLane(surface, paneId === null ? null : paneStorageId(machineId, paneId));
  const [error, setError] = useState<FileFailure | null>(null);
  const [loaded, setLoaded] = useState<FilePreviewText | null>(null);
  const [chosen, setChosen] = useState<{ path: string; mode: TextViewMode } | null>(null);
  const mode = chosen?.path === path ? chosen.mode : target.line === null ? "preview" : "code";
  const sourceRef = useRef<HTMLElement>(null);
  const [selectable, setSelectable] = useState(false);
  const selectSourceOnCode = useRef(false);
  const showSourceToSelect = (): void => {
    selectSourceOnCode.current = true;
    setSelectable(true);
    setChosen({ path, mode: "code" });
    setSource(true);
  };
  useLayoutEffect(() => {
    if (!selectSourceOnCode.current || mode !== "code") return;
    selectSourceOnCode.current = false;
    if (sourceRef.current) selectSource(sourceRef.current);
  }, [mode, loaded, source, selectable]);

  useSheetSwipe(surface, page || docked || editChanged ? null : onClose);
  useEffect(() => setPath(asked), [asked]);
  useEffect(() => { setEditing(false); setEditChanged(false); }, [path]);
  useEffect(() => setSource(target.line !== null), [path, target.line]);

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    setInfo(null); setCandidates(null); setError(null); setLoaded(null); setDirectory(null); setSelectable(false);
    fetchFileInfo(target.path, paneId).then(async (next) => {
      if (cancelled) return;
      if ("candidates" in next) { setCandidates(next.candidates); return; }
      setInfo(next);
      if (next.kind !== "text") return;
      const budget = readBudget(languageForPath(next.path), next.size);
      const started = Date.now();
      deadline = setTimeout(() => abort.abort(), budget.timeoutMs);
      try {
        const response = await getTransport().fetch(fileUrl(next.path, paneId), { signal: abort.signal, headers: { range: `bytes=0-${budget.bytes - 1}` } });
        if (!response.ok && !(response.status === 416 && response.headers.get("content-range")?.trim() === "bytes */0")) {
          if (response.headers.get("content-type")?.includes("application/json")) throw await errorFrom(fileUrl(next.path, paneId), response);
          await response.body?.cancel();
          throw new ApiError(fileUrl(next.path, paneId), response.status, response.statusText, null);
        }
        clearTimeout(deadline);
        const timeoutMs = Math.max(1, budget.timeoutMs - (Date.now() - started));
        const body = await readFilePreviewText(response, budget.bytes, { signal: abort.signal, maxLines: budget.lines, timeoutMs, partialOnTimeout: true });
        if (!cancelled) setLoaded(body);
      } finally { clearTimeout(deadline); }
    }).catch(async (reason: unknown) => {
      if (cancelled) return;
      if (reason instanceof ApiError && reason.status === 404 && (!remote || /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/])/.test(target.path))) {
        try {
          const listing = await fetchDirectories(target.path, false, true, paneId);
          if (!cancelled) setDirectory(listing.path);
          return;
        } catch {  }
      }
      if (cancelled) return;
      setError(fileFailure(reason));
    });
    return () => { cancelled = true; clearTimeout(deadline); abort.abort(); };
  }, [target.path, paneId, fetchFileInfo, fileUrl, fetchDirectories, remote, saves]);

  useEffect(() => {
    if ((info === null && directory === null) || reportedKind.current === path) return;
    reportedKind.current = path;
    onKind?.(info?.kind === "text" ? "panel" : "popup");
  }, [info, directory, path, onKind]);

  const mediaKind = info?.kind === "video" || info?.kind === "audio" ? info.kind : null;
  useEffect(() => {
    if (page || docked || mediaKind === null) return;
    if (document.activeElement === bodyRef.current) mediaRef.current?.focus({ preventScroll: true });
  }, [mediaKind, page, docked]);

  useLayoutEffect(() => {
    if (!page || surface.current?.contains(document.activeElement)) return;
    bodyRef.current?.focus({ preventScroll: true });
  }, [page]);

  useEffect(() => {
    if (!keyboardActive || page) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current) || editChanged) return;
      if (docked && !surface.current?.contains(document.activeElement)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, keyboardActive, page, docked, editChanged]);

  const closeMore = useCallback((refocus: boolean) => {
    setMoreOpen(false);
    if (refocus) moreRef.current?.querySelector<HTMLElement>(".file-viewer-action")?.focus();
  }, []);
  useEffect(() => {
    if (!moreOpen) return;
    moreRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const onPointer = (event: PointerEvent): void => {
      if (!moreRef.current?.contains(event.target as Node)) closeMore(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.stopPropagation();
      closeMore(true);
    };
    const wide = window.matchMedia("(min-width: 601px)");
    const onWide = (): void => { if (wide.matches) closeMore(false); };
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey, true);
    wide.addEventListener("change", onWide);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey, true);
      wide.removeEventListener("change", onWide);
    };
  }, [moreOpen, closeMore]);
  const moveInMore = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to = event.key === "ArrowDown" ? (at + 1) % items.length : event.key === "ArrowUp" ? (at - 1 + items.length) % items.length
      : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    items[to]?.focus();
  };

  const url = fileUrl(info?.path ?? target.path, paneId);
  // drawn by its own script in a sandbox with no origin and no network (server/file-view.ts); a PC
  // whose bridge predates `render` answers with the source, which the frame shows as text
  const htmlPage = info !== null && info.kind === "text" && info.mime === "text/html";
  const pageUrl = `${url}&render=1`;
  const pageScripts = htmlPage && !source && scriptsFor === info.path;
  // beside the pane the app stays in reach, so a page with scripts must not take its keys; the popup holds the focus itself
  const guard = usePageFocusGuard(pageFrame, docked && pageScripts, () => {
    // at once, not at the next render: only taking the frame away gives the keys back
    flushSync(() => { setScriptsFor(null); setStopped(info?.path ?? null); });
  });
  const relay = getTransport().kind === "relay";
  const resource = useResourceUrlState(info !== null && info.kind !== "text" && info.kind !== "image" ? url : null);
  const urlSrc = relay ? resource.url : url;
  const pageSrc = useResourceUrl(!relay && htmlPage && !source ? pageUrl : null);
  const image = useResourceUrlState(info?.kind === "image" && info.size <= MAX_INLINE_IMAGE_BYTES ? `${url}&revision=${encodeURIComponent(`${info.modified}:${info.size}`)}` : null);
  const imageSrc = image.url;
  // The same inert media body can be saved through the download attribute. In blob mode this
  // avoids fetching and retaining a second complete video/PDF merely to draw its download link.
  const mediaDownload = relay && (info?.kind === "video" || info?.kind === "audio" || info?.kind === "pdf");
  const download = useResourceUrlState(info === null || mediaDownload ? null : fileUrl(info.path, paneId, true));
  const downloadHref = mediaDownload ? resource.url : download.url;
  const modes = <div className="segmented file-viewer-modes" role="group" aria-label={t("Show the HTML file as")}>
    <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>{t("Page")}</button>
    <button type="button" aria-pressed={source} onClick={() => setSource(true)}>{t("Source")}</button>
  </div>;
  const textFile = info?.kind === "text";
  const language = languageForPath(info?.path ?? target.path);
  const preview = useMarkdownPreview(textFile && loaded !== null && mode === "preview" && hasPreview(language) ? loaded.text : null);
  const previewRefused = preview.status === "failed";
  const previewable = hasPreview(language) && !previewRefused;
  const view = previewable && mode === "preview" ? "markdown" : "code";
  const previewBlocks = !editing && view === "markdown" && preview.status === "ready" ? preview.blocks : null;
  const outline = useMemo(() => previewBlocks !== null ? outlineOf(previewBlocks) : [], [previewBlocks]);
  const outlined = outline.length > 1;
  const [split, setSplit] = useState<HTMLDivElement | null>(null);
  const outlineColumn = useWideEnough(outlined ? split : null, OUTLINE_COLUMN_MIN_PX);
  const [outlineChoice, setOutlineChoice] = useState<boolean | null>(null);
  const outlineShown = outlined && (outlineChoice ?? outlineColumn);
  const outlineToggle = useRef<HTMLButtonElement>(null);
  const outlineId = useId();
  const closeOutline = useCallback((refocus: boolean) => {
    setOutlineChoice(null);
    if (refocus) outlineToggle.current?.focus();
  }, []);
  const outlineButton = outlined && <button ref={outlineToggle} type="button" className="icon-button file-viewer-action file-viewer-outline-toggle" aria-expanded={outlineShown} aria-controls={outlineShown ? outlineId : undefined} aria-label={t("Outline")} title={t("Outline")} onClick={() => setOutlineChoice(!outlineShown)}>
    <TableOfContents aria-hidden="true" />
  </button>;
  /** The wrapper is always there (`display: contents` without an outline), so the body is never remounted, its focus and scroll kept, as an outline comes and goes. */
  const withOutline = (box: ReactNode) => <div ref={setSplit} className={outlined ? "file-viewer-split is-outlined" : "file-viewer-split"}>
    {box}
    {outlineShown && <MarkdownOutline id={outlineId} entries={outline} scroller={bodyRef} drawer={!outlineColumn} toggle={outlineToggle} onClose={closeOutline} />}
  </div>;
  const codeShown = textFile && loaded !== null && view === "code" && (!htmlPage || source);
  const sourceText = useMemo(() => codeShown ? shownSource(normalizeCode(loaded.text), loaded.truncated) : "", [codeShown, loaded]);
  const sourceLines = useMemo(() => countLines(sourceText), [sourceText]);
  const layout = sourceLayout(sourceLines);
  const colorable = canHighlight(language);
  const virtual = useMemo(() => codeShown && layout === "virtual" ? { text: sourceText, colored: colorable && virtualHighlightable(sourceText.length, sourceLines) } : null, [codeShown, layout, sourceText, colorable, sourceLines]);
  const code = useHighlightedLines(codeShown && layout === "elements" ? sourceText : "", codeShown ? language : null);
  const shownPath = info?.path ?? target.path;
  const { stem, extension } = pathParts(info?.name ?? shownPath);
  const { folder } = pathParts(shownPath);
  const cutShort = textFile && (!htmlPage || source) && loaded !== null && loaded.truncated;
  const budget = textFile ? readBudget(language, info.size) : null;
  const cutBytes = cutShort && budget !== null && loaded.truncatedBy !== "lines" && loaded.truncatedBy !== "time" && (loaded.total ?? info.size) > budget.bytes ? { shown: budget.bytes, total: loaded.total ?? info.size } : null;
  const request = useMemo(() => codeShown ? lineRequest(target.line, sourceText, loaded.truncated, loaded.lines) : null, [codeShown, target.line, sourceText, loaded]);
  const requestNotice = (() => {
    if (request === null) return null;
    switch (request.kind) {
      case "shown": return null;
      case "past-preview": return t("Line {line} is past the part of this file shown here. Download it to read the rest.", { line: request.line });
      case "past-end": return t("This file has {count} lines; there is no line {line}.", { count: request.lines, line: request.line });
    }
  })();
  const notes = [
    requestNotice,
    cutShort && (loaded.truncatedBy === "lines"
      ? t("Showing the first {count} lines of this file. Download it to read the rest.", { count: SOURCE_PREVIEW_LINES.toLocaleString(locale) })
      : cutBytes !== null
        ? t("Showing the first {shown} of {total}.", { shown: formatBytes(cutBytes.shown), total: formatBytes(cutBytes.total) })
        : t("Only part of this file is shown. Download it to read the rest.")),
    textFile && loaded !== null && previewRefused && t("Too long to preview"),
    codeShown && (code.tooLong || (virtual !== null && colorable && !virtual.colored)) && t("Too long to highlight"),
  ].filter((note): note is string => typeof note === "string");
  const noticed = notes.length > 0;
  const copyable = textFile && loaded !== null && !loaded.truncated;
  // shown as text (an HTML page as its source), in a pane's folder the server checks it lies in, and small enough
  const canEdit = editable && settings.editTextFiles && !page && paneId !== null && textFile && (!htmlPage || source) && info.size <= MAX_EDITABLE_TEXT_BYTES;
  const draftWaits = canEdit && hasDraft(machineId, info.path);
  useEffect(() => { if (draftWaits) setEditing(true); }, [draftWaits]);
  const markdown = info?.kind === "text" && /\.(?:md|markdown)$/i.test(info.name);
  const previewUrl = readerHref(machineId, shownPath + (target.line === null ? "" : `#L${target.line}`));
  const imagePreview = useCallback((src: string) => markdownImagePreview(
    src, shownPath, (target) => fetchFileInfo(target, paneId), (target, download) => fileUrl(target, paneId, download),
  ), [shownPath, paneId, fetchFileInfo, fileUrl]);
  // "Opening…" while the file's info, or a text's content or preview, is on its way. The note is in the
  // viewer from its first render, clipped while empty (never display: none), and its words land a frame
  // after it (lib/useAnnouncedText.ts)
  const opening = directory === null && error === null && candidates === null
    && (info === null || (info.kind === "text" && (!htmlPage || source) && (loaded === null || (view === "markdown" && preview.status !== "ready"))));
  const openingWords = useAnnouncedText(opening ? t("Opening…") : null);
  const openingNote = <p className={openingWords === null ? "visually-hidden" : "file-viewer-note"} role="status">{openingWords}</p>;
  const body = (() => {
    if (directory !== null) return <DirectoryBrowser key={directory} start={directory} onOpenFile={onOpen ?? setPath} />;
    if (error !== null) return <>
      <p className="file-viewer-note" role="alert">{fileFailureText(error, t)}</p>
      {error === "unreadable" && <p className="file-viewer-note file-viewer-note-hint">{t("Download it or open the raw file.")}</p>}
    </>;
    if (candidates !== null) return <div className="file-viewer-choices">
      <p className="file-viewer-note">{t("Several files are named {name}:", { name: target.path.split("/").pop() ?? target.path })}</p>
      <ul>{candidates.map((candidate) => <li key={candidate}><button type="button" className="btn btn-ghost" onClick={() => setPath(candidate + path.slice(target.path.length))}>{candidate}</button></li>)}</ul>
    </div>;
    if (info === null) return null;
    const resourceError = resource.error ?? image.error;
    if (resourceError) return resourceError instanceof RelayResourceTooLargeError
      ? <p className="file-viewer-note" role="alert">{t("Too large to open on the phone - download on the PC")}</p>
      : <>
        <p className="file-viewer-note" role="alert">{fileFailureText(fileFailure(resourceError), t)}</p>
        {fileFailure(resourceError) === "unreadable" && downloadHref !== null && <p className="file-viewer-note file-viewer-note-hint">{t("Download it or open the raw file.")}</p>}
      </>;
    switch (info.kind) {
      case "image":
        return info.size > MAX_INLINE_IMAGE_BYTES
          ? <p className="file-viewer-note">{t("This image is {size}; download it to view.", { size: formatBytes(info.size) })}</p>
          : <img className="file-viewer-media" src={imageSrc ?? undefined} alt={info.name} />;
      case "video":
        return <video ref={(node) => { mediaRef.current = node; }} className="file-viewer-media" src={urlSrc ?? undefined} controls playsInline preload="metadata" />;
      case "audio":
        return <audio ref={(node) => { mediaRef.current = node; }} className="file-viewer-audio" src={urlSrc ?? undefined} controls preload="metadata" />;
      case "pdf":
        return <iframe className="file-viewer-pdf" src={urlSrc ?? undefined} title={info.name} />;
      case "text":
        if (editing && paneId !== null) return <TextFileEditor path={info.path} paneId={paneId} name={info.name} onChanged={setEditChanged}
          onDone={(saved) => { setEditing(false); setEditChanged(false); if (saved) setSaves((count) => count + 1); }} />;
        if (htmlPage && !source) return <>
          {!docked && modes}
          {/* The line stays in the document while the scripts run, clipped and without words: a status line that
              appears together with its words is not announced, and "took the keyboard" has to be. */}
          <div className={pageScripts ? "visually-hidden" : "file-viewer-scripts"}>
            <span role="status">{pageScripts ? null : stopped === info.path ? t("This page took the keyboard, so its scripts are off again.") : t("Scripts in this page are off.")}</span>
            {!pageScripts && <button type="button" className="btn btn-ghost" onClick={() => { setStopped(null); setScriptsFor(info.path); }}>{t("Run scripts")}</button>}
          </div>
          {/* The frame is a new one when the scripts come or go: a frame's sandbox is read as it loads. Without
              `allow-scripts` the page's HTML and CSS still draw, and nothing in it runs. */}
          {/* A press inside a frame is not seen from here. While the page with scripts does not have the focus by the
              person's doing, its frame takes no pointer (`data-page-shield`), so the press comes to this box instead and
              puts the focus in the page (usePageFocusGuard); the next press is the page's. */}
          <div className="file-viewer-page-frame" data-page-shield={guard.shield ? "" : undefined} onClick={guard.shield ? guard.enter : undefined}>
            {relay ? <RelayRenderedPage key={pageScripts ? "scripts" : "static"} path={pageUrl} title={info.name} scripts={pageScripts} frame={pageFrame} />
              : <iframe key={pageScripts ? "scripts" : "static"} ref={pageFrame} className="file-viewer-page" src={pageSrc ?? undefined} sandbox={pageScripts ? "allow-scripts" : ""}
                data-page-scripts={pageScripts ? "on" : "off"} title={info.name} />}
          </div>
        </>;
        return <>
          {htmlPage && !docked && modes}
          {loaded === null || (view === "markdown" && preview.status !== "ready")
          ? null
          : <RenderBoundary key={view} resetKey={loaded} fallback={() => view === "markdown"
            ? <div className="file-viewer-note" role="alert">
              <p>{t("This preview can't be shown.")}</p>
              <button type="button" className="btn btn-ghost" onClick={() => setChosen({ path, mode: "code" })}>{t("Show source")}</button>
            </div>
            : <p className="file-viewer-note" role="alert">{t("The file could not be opened.")}</p>}>
            <MarkdownImageContext.Provider value={imagePreview}><TextFileView path={info.path} blocks={view === "markdown" && preview.status === "ready" ? preview.blocks : null} lines={code.lines} virtual={virtual} selectable={selectable} onOpen={onOpen ?? setPath} sourceRef={sourceRef} markedLine={request?.kind === "shown" ? request.line : null} /></MarkdownImageContext.Provider>
          </RenderBoundary>}
        </>;
      default:
        return <p className="file-viewer-note">{t("This file can't be previewed here. Download it to open it.")} <span className="file-viewer-note-meta">{info.mime}, {formatBytes(info.size)}</span></p>;
    }
  })();

  const Heading = page ? "h1" : "h2";
  const locationTitle = remote ? `${machineId} · ${shownPath}` : shownPath;
  const meta = <p className="file-viewer-meta" title={locationTitle}>
    {info && (noticed
      ? <span className="file-viewer-notice" title={notes.join("\n")}>
        <TriangleAlert aria-hidden="true" />
        <span>{cutBytes !== null ? t("{done} of {total}", { done: formatBytes(cutBytes.shown), total: formatBytes(cutBytes.total) }) : formatBytes(info.size)}</span>
        <span className="visually-hidden">{notes.join(". ")}</span>
      </span>
      : <span className="file-viewer-size">{formatBytes(info.size)}</span>)}
    {folder !== "" && <span className="file-viewer-path"><span dir="ltr">{info && <span className="file-viewer-dot" aria-hidden="true">·</span>}{remote ? `${machineId}:${folder}` : folder}</span></span>}
  </p>;
  // the file itself: a Markdown tab is the reader; raw and download keep the original bytes
  // A saved shell link opens the reader, which can establish its own channel after a reload.
  // In particular, never navigate a blob containing HTML, SVG, XML or other active text.
  const newTabHref = relay ? previewUrl : htmlPage && !source ? pageUrl : markdown ? previewUrl : url;
  const newTabSrc = useResourceUrl(newTabHref);
  const rawSrc = relay ? readerHref(machineId, `${shownPath}#L1`) : urlSrc;
  const fileActions = <>
    {!page && onTogglePresentation && <button type="button" className="icon-button file-viewer-action" aria-label={docked ? t("Show as a popup") : t("Show beside the pane")} title={docked ? t("Show as a popup") : t("Show beside the pane")} onClick={onTogglePresentation}>
      {docked ? <Maximize2 aria-hidden="true" /> : <PanelRight aria-hidden="true" />}
    </button>}
    {/* in the installed app's window a new tab would be another app window: Copy link takes their place */}
    {!page && !appWindow && <ExternalLink kind="ovis" referrer className="icon-button file-viewer-action file-viewer-wide" href={newTabSrc ?? undefined} aria-label={t("Open in a new tab")} title={t("Open in a new tab")}><ExternalLinkIcon aria-hidden="true" /></ExternalLink>}
    {(page || markdown) && !appWindow && <ExternalLink kind="ovis" referrer className="icon-button file-viewer-action file-viewer-wide" href={rawSrc ?? undefined} aria-label={t("Open raw file")} title={t("Open raw file")}><Code aria-hidden="true" /></ExternalLink>}
    {!page && appWindow && <CopyLinkButton href={newTabHref} />}
    <a className="icon-button file-viewer-action file-viewer-wide" href={downloadHref ?? undefined} download={info?.name ?? true} aria-label={t("Download")} title={t("Download")}><Download aria-hidden="true" /></a>
    {canEdit && !editing && <button type="button" className="icon-button file-viewer-action" aria-label={t("Edit file")} title={t("Edit file")} onClick={() => setEditing(true)}><Pencil aria-hidden="true" /></button>}
    {copyable && !editing && <CopyFileButton text={loaded.text} sourceRef={sourceRef} onShowSource={showSourceToSelect} />}
    {!docked && <div className="file-viewer-more" ref={moreRef}>
      <button type="button" className="icon-button file-viewer-action" aria-label={t("More")} title={t("More")} aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}><Ellipsis aria-hidden="true" /></button>
      {moreOpen && <div className="file-viewer-more-menu" role="menu" aria-label={t("More")} onKeyDown={moveInMore}>
        <p className="file-viewer-more-path" title={locationTitle}><span dir="ltr">{locationTitle}</span></p>
        {!page && !appWindow && <ExternalLink kind="ovis" referrer role="menuitem" className="file-viewer-more-item" href={newTabSrc ?? undefined} onClick={() => closeMore(true)}><ExternalLinkIcon aria-hidden="true" />{t("Open in a new tab")}</ExternalLink>}
        {(page || markdown) && !appWindow && <ExternalLink kind="ovis" referrer role="menuitem" className="file-viewer-more-item" href={rawSrc ?? undefined} onClick={() => closeMore(true)}><Code aria-hidden="true" />{t("Open raw file")}</ExternalLink>}
        {!page && appWindow && <CopyLinkButton href={newTabHref} menuItem onDone={() => closeMore(true)} />}
        <a role="menuitem" className="file-viewer-more-item" href={downloadHref ?? undefined} download={info?.name ?? true} onClick={() => closeMore(true)}><Download aria-hidden="true" />{t("Download")}</a>
      </div>}
    </div>}
  </>;
  const closeButton = !page && <button type="button" className="icon-button file-viewer-action file-viewer-close" aria-label={t("Close file")} title={t("Close file")} onClick={onClose}><X aria-hidden="true" /></button>;
  const header = docked
    ? <header className="file-viewer-header file-viewer-header-docked">
      <FileGlyph name={info?.name ?? shownPath} className="file-viewer-glyph" />
      <h2 className="file-viewer-name" title={locationTitle}><span className="file-viewer-stem">{stem}</span>{extension}</h2>
      <div className="file-viewer-actions">{fileActions}</div>
      {closeButton}
    </header>
    : <header className={"modal-header file-viewer-header file-viewer-header-stacked" + (page ? " file-reader-header" : "")}>
      <div className="file-viewer-title" title={locationTitle}>
        <Heading className="modal-title" title={locationTitle}><span className="file-viewer-stem">{stem}</span>{extension}</Heading>
        {meta}
      </div>
      <div className="file-viewer-actions">
        {textFile && previewable && !editing && <div className="file-viewer-group">
          {outlineButton}
          <button type="button" className="icon-button file-viewer-action" aria-pressed={mode === "code"} aria-label={t("Show source")} title={t("Show source")} onClick={() => setChosen({ path, mode: mode === "code" ? "preview" : "code" })}><Braces aria-hidden="true" /></button>
        </div>}
        <div className="file-viewer-group">{fileActions}</div>
      </div>
      {closeButton}
    </header>;
  const toolbar = docked && directory === null && <div className="file-viewer-toolbar">
    {meta}
    {textFile && previewable && !editing && <div className="segmented file-viewer-modes" role="group" aria-label={t("Show the Markdown file as")}>
      <button type="button" aria-pressed={mode === "preview"} onClick={() => setChosen({ path, mode: "preview" })}>{t("Preview")}</button>
      <button type="button" aria-pressed={mode === "code"} onClick={() => setChosen({ path, mode: "code" })}>{t("Source")}</button>
    </div>}
    {outlineButton}
    {htmlPage && modes}
  </div>;
  const bodyClass = virtual !== null && view === "code" ? "file-viewer-body file-viewer-body-virtual" : "file-viewer-body";
  if (page) return (
    <main ref={surface} className="file-reader">
      {header}
      {withOutline(<div ref={bodyRef} className={`${bodyClass} file-reader-body`} tabIndex={-1}>{body}{openingNote}</div>)}
    </main>
  );

  if (docked) return (
    <aside className="file-panel" aria-label={info?.name ?? path} ref={surface}>
      {panelStart}
      <section className="file-viewer file-viewer-docked">
        {header}
        {toolbar}
        {withOutline(<div ref={bodyRef} className={bodyClass}>{body}</div>)}
      </section>
    </aside>
  );

  return (
    <div className="modal-scrim file-viewer-scrim" onMouseDown={(event) => event.target === event.currentTarget && !editChanged && onClose()}>
      <section className={virtual !== null && view === "code" ? "modal file-viewer file-viewer-virtual" : "modal file-viewer"} role="dialog" aria-modal="true" aria-label={info?.name ?? path} ref={surface} tabIndex={-1}>
        {header}
        {withOutline(<div ref={bodyRef} className={bodyClass} tabIndex={-1}>{body}{openingNote}</div>)}
      </section>
    </div>
  );
}
