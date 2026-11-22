import { lazy, Suspense, useCallback, useLayoutEffect, useRef, type RefObject } from "react";

import { OpenFileContext } from "../lib/filePaths.ts";
import { resolveFromDocument } from "../lib/fileReader.ts";
import type { Lines } from "../lib/highlight.ts";
import { useT } from "../lib/i18n.ts";
import type { MarkdownBlock } from "../../shared/markdown.ts";
import { useSettings } from "../lib/settings.ts";
import { CodeLines } from "./HighlightedCode.tsx";
import { ProgressiveMarkdown } from "./Markdown.tsx";

const VirtualSource = lazy(() => import("./VirtualSource.tsx"));

export interface TextFileViewProps {
  path: string;
  blocks: MarkdownBlock[] | null;
  lines: Lines;
  virtual: { text: string; colored: boolean } | null;
  selectable: boolean;
  onOpen: (path: string) => void;
  sourceRef: RefObject<HTMLElement | null>;
  markedLine: number | null;
}

export function TextFileView({ path, blocks, lines, virtual, selectable, onOpen, sourceRef, markedLine }: TextFileViewProps) {
  const t = useT();
  const { settings, resolvedEntry } = useSettings();
  const onOpenRef = useRef(onOpen);
  useLayoutEffect(() => { onOpenRef.current = onOpen; });
  const openLink = useCallback((href: string) => onOpenRef.current(resolveFromDocument(path, href)), [path]);
  useLayoutEffect(() => {
    if (blocks === null && virtual === null && markedLine !== null) sourceRef.current?.querySelector(".hl-line.is-marked")?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [path, blocks, virtual, markedLine, sourceRef]);
  const code = (() => {
    if (virtual === null) return <CodeLines ref={sourceRef as RefObject<HTMLPreElement | null>} className="file-viewer-text" lines={lines} open={null} lineNumbers wrap={settings.wrapCode} markedLine={markedLine} />;
    if (selectable) return <textarea ref={sourceRef as RefObject<HTMLTextAreaElement | null>} className="file-viewer-select-source" readOnly value={virtual.text} aria-label={t("File source")} spellCheck={false} />;
    return <Suspense fallback={<p className="file-viewer-note">{t("Opening…")}</p>}>
      <VirtualSource name={path} text={virtual.text} colored={virtual.colored} wrap={settings.wrapCode} theme={resolvedEntry.mode} markedLine={markedLine} />
    </Suspense>;
  })();
  return <div className={virtual !== null && blocks === null ? "file-viewer-content file-viewer-content-virtual" : "file-viewer-content"}>
    {blocks !== null
      ? <OpenFileContext.Provider value={openLink}><ProgressiveMarkdown className="file-viewer-markdown file-viewer-markdown-readable" blocks={blocks} /></OpenFileContext.Provider>
      : code}
  </div>;
}
