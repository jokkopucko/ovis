import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, Columns2, Copy, CopySlash, FileText, FoldVertical, MessageSquarePlus, Rows3, Search, TriangleAlert, X } from "lucide-react";

import "./FindBar.css";
import "./RepoDiffViewer.css";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { Skeleton } from "./Skeleton.tsx";

import { paneStorageId } from "../../shared/machines.ts";
import type { RepoDiffFilePatch } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { capturedComparison, diffNoteQuote, lineAtRow, noteOverflows } from "../lib/diffLineNotes.ts";
import { replyComments, replyCommentsKey } from "../lib/replyComments.ts";
import { pathParts } from "../lib/filePaths.ts";
import { canHighlight, languageForPath } from "../lib/highlight.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { comparisonChangedWord, comparisonWord, diffColorable, diffErrorMessage, diffStyleFor, repositoryFilePath, sameComparison, statusWord, unavailableMessage, type RepoDiffTarget } from "../lib/repoDiff.ts";
import { DIFF_FIND_MAX_QUERY, diffFindLines, findInDiff, stepMatch, type DiffFindLine } from "../lib/repoDiffFind.ts";
import { useSettings } from "../lib/settings.ts";
import { SHEET_QUERY, useSheetSwipe } from "../lib/sheets.ts";
import { skeletonRows } from "../lib/skeleton.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";

const RepoDiff = lazy(() => import("./RepoDiff.tsx"));

export interface RepoDiffViewerProps {
  target: RepoDiffTarget;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  keyboardActive?: boolean;
  note?: { machine: string; blocked: string | null };
}

interface Writing { line: DiffFindLine; quote: string }

interface DiffNoteDraft {
  writing: Writing;
  text: string;
  open: boolean;
}

const diffTargetDrafts = new Map<string, DiffNoteDraft>();
interface DiffLineDraft { text: string; quote: string }
const diffLineDrafts = new Map<string, DiffLineDraft>();

function diffTargetDraftKey(target: RepoDiffTarget): string {
  return `${target.machineId}\n${target.paneId ?? ""}\n${target.directory ?? ""}\n${target.scope}\n${target.base ?? ""}\n${target.head ?? ""}\n${target.path}`;
}

function diffLineDraftKey(target: RepoDiffTarget, line: Pick<DiffFindLine, "side" | "line">): string {
  return `${diffTargetDraftKey(target)}\n${line.side}:${line.line}`;
}

function readDiffTargetDraft(target: RepoDiffTarget): DiffNoteDraft | null {
  const key = diffTargetDraftKey(target);
  const mem = diffTargetDrafts.get(key);
  if (mem !== undefined) return mem;
  try {
    const raw = window.sessionStorage?.getItem(`ovis:diff-note-target:${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DiffNoteDraft>;
    if (parsed.writing && typeof parsed.text === "string") {
      return { writing: parsed.writing, text: parsed.text, open: parsed.open === true };
    }
  } catch {}
  return null;
}

function writeDiffTargetDraft(target: RepoDiffTarget, draft: DiffNoteDraft | null): void {
  const key = diffTargetDraftKey(target);
  if (draft === null || draft.text.trim() === "") {
    diffTargetDrafts.delete(key);
    try { window.sessionStorage?.removeItem(`ovis:diff-note-target:${key}`); } catch {}
    return;
  }
  diffTargetDrafts.set(key, draft);
  try { window.sessionStorage?.setItem(`ovis:diff-note-target:${key}`, JSON.stringify(draft)); } catch {}
}

function readDiffLineDraft(target: RepoDiffTarget, line: Pick<DiffFindLine, "side" | "line">): DiffLineDraft | null {
  const key = diffLineDraftKey(target, line);
  const mem = diffLineDrafts.get(key);
  if (mem !== undefined) return mem;
  try {
    const raw = window.sessionStorage?.getItem(`ovis:diff-note-line:${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DiffLineDraft>;
    if (typeof parsed.text === "string" && typeof parsed.quote === "string") return { text: parsed.text, quote: parsed.quote };
  } catch {}
  return null;
}

function writeDiffLineDraft(target: RepoDiffTarget, writing: Writing, text: string): void {
  const key = diffLineDraftKey(target, writing.line);
  if (text.trim() === "") {
    diffLineDrafts.delete(key);
    try { window.sessionStorage?.removeItem(`ovis:diff-note-line:${key}`); } catch {}
    return;
  }
  const draft = { text, quote: writing.quote };
  diffLineDrafts.set(key, draft);
  try { window.sessionStorage?.setItem(`ovis:diff-note-line:${key}`, JSON.stringify(draft)); } catch {}
}

type Load = { status: "pending" } | { status: "failed"; error: unknown } | { status: "stale" } | { status: "ready"; answer: RepoDiffFilePatch };
const PENDING: Load = { status: "pending" };

type Shown = { kind: "patch" | "path"; text: string };

function CopyButton({ text, label, doneLabel, icon, onShowText }: { text: string | null; label: string; doneLabel: string; icon: ReactNode; onShowText: (text: string) => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const name = copied ? doneLabel : label;
  const copy = async (): Promise<void> => {
    if (text === null) return;
    if (await copyText(text)) setCopied(true);
    else onShowText(text);
  };
  return <button type="button" className="icon-button repo-diff-action" aria-label={name} title={name} disabled={text === null} onClick={() => void copy()}>
    {copied ? <Check aria-hidden="true" /> : icon}
  </button>;
}

function matchPlace(t: Translate, match: DiffFindLine): string {
  const line = match.line.toLocaleString();
  switch (match.kind) {
    case "addition": return t("Added line {line}", { line });
    case "deletion": return t("Removed line {line}", { line });
    case "context": return t("Unchanged line {line}", { line });
  }
}

function DiffNoteForm({ writing, path, text, error, disabled, onText, onSave, onCancel }: {
  writing: Writing; path: string; text: string; error: string | null; disabled: boolean;
  onText: (value: string) => void; onSave: () => void; onCancel: () => void;
}) {
  const t = useT();
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { field.current?.focus({ preventScroll: true }); }, []);
  return <form className="repo-diff-line-note-form" aria-label={t("Note on {place}", { place: matchPlace(t, writing.line) })}
    onSubmit={(event) => { event.preventDefault(); onSave(); }}>
    <p className="repo-diff-line-note-place"><span>{matchPlace(t, writing.line)}</span><span className="repo-diff-line-note-path" dir="ltr">{path}</span></p>
    <pre className="repo-diff-line-note-line" data-kind={writing.line.kind}><code>{writing.line.text === "" ? " " : writing.line.text}</code></pre>
    <textarea ref={field} className="input repo-diff-line-note-field" rows={2} value={text} placeholder={t("What should the agent know about this line?")}
      aria-label={t("Note")} onChange={(event) => onText(event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onSave(); }
      }} />
    {error !== null && <p className="repo-diff-line-note-error" role="alert">{error}</p>}
    <div className="repo-diff-line-note-actions">
      <button type="button" className="btn" onClick={onCancel}>{t("Cancel")}</button>
      <button type="submit" className="btn btn-primary" disabled={disabled || text.trim() === ""}>{t("Add to next message")}</button>
    </div>
  </form>;
}

const DIFF_SKELETON_ROWS = 6;

function DiffSkeleton({ label }: { label: string }) {
  return <div className="repo-diff-loading" role="status">
    <span className="visually-hidden">{label}</span>
    {skeletonRows(DIFF_SKELETON_ROWS).map((width, index) => <div key={index} className="repo-diff-loading-row" aria-hidden="true">
      <Skeleton className="repo-diff-loading-number" />
      <Skeleton width={width} />
    </div>)}
  </div>;
}

export function RepoDiffViewer({ target, onClose, onOpenFile, keyboardActive = true, note }: RepoDiffViewerProps) {
  const t = useT();
  const { settings, update, resolvedEntry } = useSettings();
  const { fetchRepoDiffFile } = useMachineApi();
  const surface = useFocusTrap<HTMLElement>(true);
  const narrow = useMediaQuery(SHEET_QUERY);
  const [load, setLoad] = useState<Load>(PENDING);
  const [folded, setFolded] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [findRequest, setFindRequest] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const findButton = useRef<HTMLButtonElement>(null);
  const findOpener = useRef<HTMLElement | null>(null);
  const findingRef = useRef(finding);
  findingRef.current = finding;
  const initialDraft = readDiffTargetDraft(target);
  const [cursor, setCursor] = useState<{ index: number; quiet: boolean } | null>(null);
  const [writing, setWriting] = useState<Writing | null>(() => initialDraft?.open ? initialDraft.writing : null);
  const [noteText, setNoteText] = useState(() => initialDraft?.open ? initialDraft.text : "");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteAdded, setNoteAdded] = useState(false);
  const writingRef = useRef<{ open: boolean; empty: boolean }>({ open: false, empty: true });
  writingRef.current = { open: writing !== null, empty: noteText.trim() === "" };
  const bodyRef = useRef<HTMLDivElement>(null);
  const beginNoteRef = useRef<(line: DiffFindLine) => void>(() => {});
  useSheetSwipe(surface, onClose);

  const { machineId, paneId, directory, scope, base, head, comparison, path, oldPath } = target;
  useEffect(() => {
    const saved = readDiffTargetDraft(target);
    if (saved?.open) {
      setWriting(saved.writing);
      setNoteText(saved.text);
    } else {
      setWriting(null);
      setNoteText("");
    }
    setNoteError(null);
    setNoteAdded(false);
  }, [machineId, paneId, directory, scope, base, head, path]);
  useEffect(() => {
    let live = true;
    setLoad(PENDING);
    setShown(null);
    fetchRepoDiffFile({ paneId, directory, scope, base, head, comparison }, path, oldPath).then(
      (answer) => { if (live) setLoad(sameComparison(answer.comparison ?? null, comparison) ? { status: "ready", answer } : { status: "stale" }); },
      (error: unknown) => { if (live) setLoad({ status: "failed", error }); },
    );
    return () => { live = false; };
  }, [fetchRepoDiffFile, paneId, directory, scope, base, head, comparison, path, oldPath]);

  const patchText = load.status === "ready" ? load.answer.patch : null;
  useEffect(() => {
    setQuery("");
    setActiveIndex(null);
    setCursor(null);
  }, [patchText]);

  const openFind = useCallback((): void => {
    const focused = document.activeElement;
    if (!findingRef.current || findOpener.current?.isConnected !== true) findOpener.current = focused instanceof HTMLElement && focused !== findInput.current ? focused : findButton.current;
    setShown(null);
    setFinding(true);
    setFindRequest((request) => request + 1);
  }, []);
  useLayoutEffect(() => {
    if (findRequest === 0) return;
    findInput.current?.focus();
    findInput.current?.select();
  }, [findRequest]);
  const closeFind = useCallback((): void => {
    setFinding(false);
    const opener = findOpener.current;
    findOpener.current = null;
    (opener?.isConnected === true ? opener : findButton.current)?.focus();
  }, []);

  useEffect(() => {
    if (!keyboardActive) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229 || nativeModalOver(surface.current)) return;
      // Ctrl/Cmd+F is this dialog's: the browser's own find cannot reach the rows not mounted
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
        const focused = document.activeElement;
        const owner = focused instanceof Element && surface.current?.contains(focused) !== true ? focused.closest("dialog, [aria-modal='true']") : null;
        if (owner !== null && surface.current !== null && !owner.contains(surface.current)) return;
        event.preventDefault();
        if (patchText !== null || findingRef.current) openFind();
        return;
      }
      if (event.key !== "Escape") return;
      const inFind = document.activeElement instanceof Element && document.activeElement.closest(".repo-diff-find") !== null;
      if (findingRef.current && inFind) { event.preventDefault(); closeFind(); return; }
      if (writingRef.current.open) {
        event.preventDefault();
        if (writingRef.current.empty) { setWriting(null); bodyRef.current?.focus({ preventScroll: true }); }
        return;
      }
      if (findingRef.current) { event.preventDefault(); closeFind(); return; }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, keyboardActive, surface, patchText, openFind, closeFind]);

  useLayoutEffect(() => {
    if (shown === null) return;
    textRef.current?.focus();
    textRef.current?.select();
  }, [shown]);

  const answer = load.status === "ready" ? load.answer : null;
  const file = answer?.file ?? null;
  const patch = answer?.patch ?? null;
  const style = diffStyleFor(settings.diffStyle, narrow);
  const wantsColor = canHighlight(languageForPath(path));
  const colored = patch !== null && diffColorable(path, patch);
  const notes = [
    wantsColor && patch !== null && !colored ? t("Too long to highlight") : null,
    narrow && settings.diffStyle === "split" ? t("Split view needs a wider screen; showing one column.") : null,
  ].filter((note): note is string => note !== null);
  const { stem, extension } = pathParts(path);
  const { folder } = pathParts(path);
  const openable = answer !== null && file !== null && file.status !== "deleted";
  const findLines = useMemo(() => diffFindLines(patch), [patch]);
  const matches = useMemo(() => findInDiff(findLines, query), [findLines, query]);
  const current = activeIndex !== null && activeIndex < matches.length ? activeIndex : null;
  const activeMatch = current === null ? null : matches[current] ?? null;
  const step = (direction: 1 | -1): void => { setActiveIndex(stepMatch(current, matches.length, direction)); setCursor(null); };
  const cursorLine = cursor === null ? null : findLines[cursor.index] ?? null;
  const pointed: DiffFindLine | null = finding && activeMatch !== null && cursor === null ? activeMatch : cursorLine;
  const indexOf = (line: DiffFindLine): number => findLines.findIndex((item) => item.side === line.side && item.line === line.line);
  const blocked = note?.blocked ?? null;
  const commentsKey = target.paneId === null ? null : replyCommentsKey(paneStorageId(target.machineId, target.paneId));
  const beginNote = (line: DiffFindLine): void => {
    if (note === undefined || answer === null || patch === null || blocked !== null || (writing !== null && noteText.trim() !== "")) return;
    const quote = diffNoteQuote({ machine: note.machine, repository: answer.repository.root, comparison: capturedComparison(answer, patch), path, line });
    const restored = readDiffLineDraft(target, line);
    const nextWriting = { line, quote: restored?.quote ?? quote };
    const text = restored?.text ?? "";
    setWriting(nextWriting);
    setNoteText(text);
    writeDiffTargetDraft(target, { writing: nextWriting, text, open: text.trim() !== "" });
    setNoteError(null);
    setNoteAdded(false);
  };
  beginNoteRef.current = beginNote;
  const closeNote = (): void => {
    if (writing !== null) writeDiffLineDraft(target, writing, noteText);
    writeDiffTargetDraft(target, null);
    setWriting(null);
    setNoteError(null);
    bodyRef.current?.focus({ preventScroll: true });
  };
  const updateNoteText = (value: string): void => {
    setNoteText(value);
    setNoteError(null);
    if (writing !== null) {
      writeDiffLineDraft(target, writing, value);
      writeDiffTargetDraft(target, { writing, text: value, open: value.trim() !== "" });
    }
  };
  const saveNote = (): void => {
    if (writing === null || commentsKey === null || target.paneId === null || noteText.trim() === "" || blocked !== null) return;
    const draft = composerDrafts.read(`ovis:composer-draft:${paneStorageId(target.machineId, target.paneId)}`).text;
    if (noteOverflows(replyComments.unreserved(replyComments.read(commentsKey)), draft, writing.quote, noteText)) {
      setNoteError(t("This note would make your next message too long. Shorten the note or the message, or remove a waiting comment."));
      return;
    }
    if (!replyComments.add(commentsKey, writing.quote, noteText, "diff")) {
      setNoteError(t("This note could not be saved on this device."));
      return;
    }
    writeDiffLineDraft(target, writing, "");
    writeDiffTargetDraft(target, null);
    setNoteAdded(true);
    setWriting(null);
    setNoteText("");
    setNoteError(null);
    bodyRef.current?.focus({ preventScroll: true });
  };
  const onLine = useCallback((side: "deletions" | "additions", lineNumber: number, open: boolean): void => {
    const line = lineAtRow(findLines, side, lineNumber);
    if (line === null) return;
    setCursor({ index: findLines.indexOf(line), quiet: true });
    setNoteAdded(false);
    if (open) beginNoteRef.current(line);
  }, [findLines]);
  const moveCursor = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (note === undefined || findLines.length === 0 || !(event.target instanceof Element) || event.target.closest("input, textarea, button, a") !== null || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const from = pointed === null ? -1 : indexOf(pointed);
      const index = from < 0 ? (event.key === "ArrowDown" ? 0 : findLines.length - 1) : Math.min(Math.max(from + (event.key === "ArrowDown" ? 1 : -1), 0), findLines.length - 1);
      setCursor({ index, quiet: false });
      setNoteAdded(false);
    } else if (event.key === "Enter" && pointed !== null) {
      event.preventDefault();
      beginNote(pointed);
    }
  };
  const mark = finding && cursor === null ? activeMatch : cursorLine === null || cursor === null ? null : { side: cursorLine.side, line: cursorLine.line, start: 0, end: 0, quiet: cursor.quiet };
  const unfold = useCallback(() => setFolded(false), []);
  const findCount = query === "" ? "" : current !== null ? t("{current} of {total}", { current: current + 1, total: matches.length }) : matches.length === 0 ? t("No matches") : "";

  const body = (() => {
    if (shown !== null) return <textarea ref={textRef} className="repo-diff-select-source" readOnly value={shown.text} aria-label={shown.kind === "patch" ? t("Patch") : t("Path")} spellCheck={false} />;
    if (load.status === "pending") return <DiffSkeleton label={t("Opening…")} />;
    if (load.status === "stale") return <p className="repo-diff-note" role="alert">{comparisonChangedWord(t)}</p>;
    if (load.status === "failed") {
      const stale = load.error instanceof ApiError && load.error.status === 404 && load.error.code === "not_found";
      return <p className="repo-diff-note" role="alert">{stale ? t("This file has no changes here any more; the list is out of date.") : diffErrorMessage(t, load.error)}</p>;
    }
    const unavailable = unavailableMessage(t, load.answer);
    if (unavailable !== null || patch === null) return <p className="repo-diff-note">{unavailable ?? t("No lines changed.")}</p>;
    return <RenderBoundary resetKey={patch} fallback={() => <p className="repo-diff-note" role="alert">{t("This change can't be shown.")}</p>}>
      <Suspense fallback={<DiffSkeleton label={t("Opening…")} />}>
        <RepoDiff patch={patch} style={style} folded={folded} wrap={settings.wrapCode} theme={resolvedEntry.mode} colored={colored} active={mark} onUnfold={unfold}
          onLine={note === undefined ? undefined : onLine} noteBlocked={blocked} />
      </Suspense>
    </RenderBoundary>;
  })();

  return (
    <div className="modal-scrim repo-diff-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal repo-diff-viewer" role="dialog" aria-modal="true" aria-label={t("Changes to {name}", { name: `${stem}${extension}` })} ref={surface} tabIndex={-1}>
        <header className="modal-header repo-diff-header">
          <div className="repo-diff-title">
            <h2 className="modal-title"><span className="repo-diff-stem">{stem}</span>{extension}</h2>
            <p className="repo-diff-meta" title={oldPath === null ? path : t("Renamed from {path}", { path: oldPath })}>
              {load.status === "pending" && <>
                <Skeleton className="repo-diff-skeleton-status" />
                <Skeleton className="repo-diff-skeleton-counts" />
              </>}
              {file !== null && <span className="repo-diff-status" data-status={file.status}>{statusWord(t, file.status)}</span>}
              {file !== null && file.additions !== null && file.deletions !== null && <span className="repo-diff-counts">
                <span className="repo-diff-added">+{file.additions.toLocaleString()}</span>
                <span className="repo-diff-deleted">−{file.deletions.toLocaleString()}</span>
              </span>}
              {file?.binary === true && <span className="repo-diff-binary">{t("Binary")}</span>}
              {notes.length > 0 && <span className="repo-diff-notice" title={notes.join("\n")}>
                <TriangleAlert aria-hidden="true" />
                <span>{notes[0]}</span>
                <span className="visually-hidden">{notes.join(". ")}</span>
              </span>}
              <span className="repo-diff-compare">{comparisonWord(t, target)}</span>
              {folder !== "" && <span className="repo-diff-path"><span dir="ltr">{folder}</span></span>}
            </p>
          </div>
          <div className="repo-diff-actions">
            <div className="segmented repo-diff-styles" role="group" aria-label={t("Diff layout")}>
              <button type="button" aria-pressed={style === "unified"} title={t("Unified")} onClick={() => update({ diffStyle: "unified" })}><Rows3 aria-hidden="true" /><span className="repo-diff-style-word">{t("Unified")}</span></button>
              <button type="button" aria-pressed={style === "split"} disabled={narrow} title={narrow ? t("Split view needs a wider screen") : t("Split")} onClick={() => update({ diffStyle: "split" })}><Columns2 aria-hidden="true" /><span className="repo-diff-style-word">{t("Split")}</span></button>
            </div>
            <div className="repo-diff-group">
              <button ref={findButton} type="button" className="icon-button repo-diff-action" aria-pressed={finding} aria-label={t("Find in diff")} title={patch === null && !finding ? t("There is no loaded patch to search.") : t("Find in diff")} disabled={patch === null && !finding} onClick={() => (finding ? closeFind() : openFind())}><Search aria-hidden="true" /></button>
              <button type="button" className="icon-button repo-diff-action" aria-pressed={folded} aria-label={t("Fold context")} title={folded ? t("Showing one line around each change") : t("Fold context")} disabled={patch === null} onClick={() => setFolded((value) => !value)}><FoldVertical aria-hidden="true" /></button>
              <button type="button" className="icon-button repo-diff-action" aria-label={t("Open file")} title={t("Open file")} disabled={!openable} onClick={() => answer !== null && onOpenFile(repositoryFilePath(answer.repository.root, path))}><FileText aria-hidden="true" /></button>
              {shown === null && <>
                <CopyButton text={path} label={t("Copy path")} doneLabel={t("Path copied")} icon={<CopySlash aria-hidden="true" />} onShowText={(text) => setShown({ kind: "path", text })} />
                {(load.status === "pending" || patch !== null) && <CopyButton text={patch} label={t("Copy patch")} doneLabel={t("Patch copied")} icon={<Copy aria-hidden="true" />} onShowText={(text) => setShown({ kind: "patch", text })} />}
              </>}
            </div>
          </div>
          <button type="button" className="icon-button repo-diff-action repo-diff-close" aria-label={t("Close diff")} title={t("Close diff")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        {finding && <form className="find-bar repo-diff-find" role="search" aria-label={t("Find in diff")} onSubmit={(event) => { event.preventDefault(); step(1); }}>
          <div className="find-bar-controls">
            <label className="find-bar-query">
              <Search size={16} aria-hidden="true" />
              <span className="repo-diff-find-label">{t("Find in diff")}</span>
              <input ref={findInput} className="input" type="search" value={query} maxLength={DIFF_FIND_MAX_QUERY} disabled={patch === null} spellCheck={false}
                onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); setCursor(null); }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                  if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
                }} />
            </label>
            <span className="find-bar-count" role="status">
              {findCount}
              {activeMatch !== null && <span className="repo-diff-find-place">{matchPlace(t, activeMatch)}</span>}
            </span>
            <button className="icon-button repo-diff-action" type="button" aria-label={t("Previous match")} title={t("Previous match")} disabled={matches.length === 0} onClick={() => step(-1)}><ArrowUp size={16} aria-hidden="true" /></button>
            <button className="icon-button repo-diff-action" type="button" aria-label={t("Next match")} title={t("Next match")} disabled={matches.length === 0} onClick={() => step(1)}><ArrowDown size={16} aria-hidden="true" /></button>
            <button className="icon-button repo-diff-action" type="button" aria-label={t("Close search")} title={t("Close search")} onClick={closeFind}><X size={16} aria-hidden="true" /></button>
          </div>
          <p className="find-bar-hint">{patch === null ? t("There is no loaded patch to search.") : t("Searches this loaded patch, including context. Content outside the patch is not searched.")}</p>
        </form>}
        <div className="repo-diff-body" ref={bodyRef} onKeyDown={moveCursor}
          {...(note !== undefined && patch !== null && shown === null ? { tabIndex: 0, "aria-label": t("Diff lines: the arrow keys pick a line, Enter adds a note on it") } : {})}>{body}</div>
        {note !== undefined && patch !== null && shown === null && writing === null && <div className="repo-diff-line-bar">
          <p className="repo-diff-line-place" role="status">
            {noteAdded ? t("Note added. It goes first in the next message you send from this pane's Chat (not with a slash command, a ! line or an answer to a question).")
              : blocked !== null ? blocked
              : pointed !== null ? matchPlace(t, pointed)
              : t("Pick a line to add a note.")}
          </p>
          <button type="button" className="btn repo-diff-line-note-open" disabled={pointed === null || blocked !== null} title={blocked ?? undefined}
            onClick={() => pointed !== null && beginNote(pointed)}>
            <MessageSquarePlus aria-hidden="true" />{t("Add a note")}
          </button>
        </div>}
        {writing !== null && <DiffNoteForm writing={writing} path={path} text={noteText} error={noteError ?? blocked} disabled={blocked !== null}
          onText={updateNoteText} onSave={saveNote} onCancel={closeNote} />}
      </section>
    </div>
  );
}
