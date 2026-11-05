import { createContext, Fragment, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { BookOpen, Check, Copy, ImageOff, Maximize2 } from "lucide-react";

import { foldCode, mathNestsTooDeep, parseInline, parseMarkdown, type InlineNode, type ListBlock, type MarkdownBlock } from "../../shared/markdown.ts";
import { codeIsFilePath, OpenFileContext, splitFilePaths } from "../lib/filePaths.ts";
import { FilePathLink } from "./FilePathLink.tsx";
import { fileUriPath } from "../../shared/fileUri.ts";
import { shouldOpenWebPage, WebPanelContext } from "../lib/webPanel.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { CHAT_HIGHLIGHT_LIMIT, languageForFence } from "../lib/highlight.ts";
import { HighlightedCode } from "./HighlightedCode.tsx";
import { useT } from "../lib/i18n.ts";
import { useResourceUrlState } from "../lib/useResourceUrl.ts";
import { type MarkdownImagePreview } from "../lib/markdownImages.ts";
import { imageSlotStyle, standaloneImage } from "../lib/imageBox.ts";
import { formatBytes } from "../lib/bridgeProgress.ts";
import { MermaidLightbox } from "./MermaidLightbox.tsx";
import { svgFigurePalette, svgFigureUrl } from "../lib/svgFigure.ts";
import { copyText } from "../lib/clipboard.ts";
import { lazyChunk } from "../lib/lazyChunk.ts";
import type { SkillMatcher } from "../lib/skillMentions.ts";
import { previewChunks } from "../lib/textPreview.ts";
import type { GalleryImage } from "../lib/imageViewer.ts";
import { useSettings } from "../lib/settings.ts";
import { isWebLink, openWebLink } from "../lib/terminalFileLinks.ts";

/** The pane's skill names: a name in an answer's plain text, in its trigger form, reads as a chip. */
const SkillMatcherContext = createContext<SkillMatcher | null>(null);

type Katex = typeof import("katex").default;
/** KaTeX is a fifth of the app's script: the first expression loads it (lib/katex.ts), and every later one has it at once. */
let katexModule: Katex | null = null;

/**
 * KaTeX, fetched once; a static render (the unit test) waits on it to draw math as the chat does.
 * Offline before it was ever fetched, or in a tab older than the server's build, every expression
 * stays in its source form and the app offers a reload (lib/lazyChunk.ts).
 */
export const loadKatex: () => Promise<Katex> = lazyChunk(() => import("../lib/katex.ts").then((module) => (katexModule = module.default)));

function useKatex(): Katex | null {
  const [katex, setKatex] = useState(katexModule);
  useEffect(() => {
    if (katex) return;
    let live = true;
    loadKatex().then((loaded) => { if (live) setKatex(loaded); }, () => {});
    return () => { live = false; };
  }, [katex]);
  return katex;
}

/**
 * A formula drawn by KaTeX. Until KaTeX loads, or when it cannot draw the formula, `fallback`
 * shows instead: by default the formula as the agent wrote it (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`).
 */
function MathExpression({ value, displayMode = false, dollar = false, oneLine = false, fallback }: { value: string; displayMode?: boolean; dollar?: boolean; oneLine?: boolean; fallback?: ReactNode }) {
  const katex = useKatex();
  // a $$ formula keeps its own lines, as written
  const source = fallback ?? (dollar && displayMode
    ? <span className="markdown-math-source">{oneLine ? `$$${value}$$` : `$$\n${value}\n$$`}</span>
    : <span>{dollar ? `$${value}$` : displayMode ? `\\[${value}\\]` : `\\(${value}\\)`}</span>);
  if (!katex || mathNestsTooDeep(value)) return source;
  try {
    // KaTeX escapes text and rejects untrusted commands by default, and an unknown command
    // throws - the catch below then draws the source form. `trust` stays at its default, which
    // is what keeps \href and \includegraphics refused. `strict` only governs input LaTeX would
    // not accept: "ignore" draws Korean, Japanese or Chinese text inside an expression, which
    // `strict: true` throws on.
    const html = katex.renderToString(value, { displayMode, strict: "ignore" });
    return <span className={displayMode ? "markdown-math-display" : "markdown-math"} dangerouslySetInnerHTML={{ __html: html }} />;
  } catch {
    return source;
  }
}

type MermaidRender = typeof import("../lib/mermaid.ts").renderMermaid;

/** Mermaid, fetched once with the first diagram (lib/mermaid.ts); one that cannot load leaves diagrams as code blocks until a reload. */
const loadMermaid: () => Promise<MermaidRender> = lazyChunk(() => import("../lib/mermaid.ts").then((module) => module.renderMermaid));

/** Whether the page is drawn dark (`data-theme` on <html>, which Settings keeps current). */
function useDarkTheme(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme !== "light");
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setDark(root.dataset.theme !== "light"));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** A ```mermaid fence drawn as a diagram. Until it parses (a reply still streaming, a syntax error) it shows as the code block it is. */
function MermaidDiagram({ value }: { value: string }) {
  const t = useT();
  const [svg, setSvg] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const dark = useDarkTheme();
  useEffect(() => {
    let live = true;
    // the parse runs after a pause, so a streaming block is not re-parsed on every poll
    const timer = window.setTimeout(() => {
      loadMermaid().then((render) => render(value, dark)).then(
        (markup) => { if (live) setSvg(markup); },
        () => { if (live) setSvg(null); },
      );
    }, 300);
    return () => { live = false; window.clearTimeout(timer); };
  }, [value, dark]);
  if (svg === null) return <CodeBlock language="mermaid" value={value} />;
  return (
    <div className="markdown-mermaid-frame">
      <div className="markdown-mermaid" onClick={() => setZoomed(true)} dangerouslySetInnerHTML={{ __html: svg }} />
      <button type="button" className="icon-button markdown-mermaid-zoom" onClick={() => setZoomed(true)} aria-label={t("Enlarge diagram")} title={t("Enlarge diagram")}>
        <Maximize2 aria-hidden="true" />
      </button>
      {zoomed && <MermaidLightbox svg={svg} onClose={() => setZoomed(false)} />}
    </div>
  );
}

/** Counts changes to <html>'s theme attributes (`data-theme`, `data-palette`, inline colors), so a figure redraws in the new colors. */
function useThemeRevision(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setRevision((value) => value + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette", "style", "class"] });
    return () => observer.disconnect();
  }, []);
  return revision;
}

/**
 * A ```svg fence drawn as the figure it is (lib/svgFigure.ts), as an image so its markup never
 * joins the page. Until it is a whole figure (a reply still streaming) or when it does not draw,
 * it shows as the code block it is.
 */
function SvgFigure({ value }: { value: string }) {
  const t = useT();
  const revision = useThemeRevision();
  const [zoomed, setZoomed] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // `revision` is not read: a change to it may be a new theme, whose colors the palette reads again.
  // The viewport also writes <html>'s style (lib/viewport.ts): the figure is drawn again only when
  // a color it reads changed, so a keyboard or resize does not reparse every figure.
  const paletteKey = useMemo(() => JSON.stringify(svgFigurePalette((property) => getComputedStyle(document.documentElement).getPropertyValue(property))), [revision]);
  const palette = useMemo(() => JSON.parse(paletteKey) as ReturnType<typeof svgFigurePalette>, [paletteKey]);
  const src = useMemo(() => svgFigureUrl(value, palette), [value, palette]);
  if (src === null || failed === src) return <CodeBlock language="svg" value={value} />;
  return (
    <div className="markdown-mermaid-frame">
      <div className="markdown-mermaid" onClick={() => setZoomed(true)}>
        <img src={src} alt={t("Diagram")} draggable={false} onError={() => setFailed(src)} />
      </div>
      <button type="button" className="icon-button markdown-mermaid-zoom" onClick={() => setZoomed(true)} aria-label={t("Enlarge diagram")} title={t("Enlarge diagram")}>
        <Maximize2 aria-hidden="true" />
      </button>
      {zoomed && <MermaidLightbox src={src} onClose={() => setZoomed(false)} />}
    </div>
  );
}

/** An image's natural size, once it decoded. */
export type ImageSize = { width: number; height: number };
/**
 * Stats an image before it can load; null context keeps image references as links. `size` gives
 * the size an image of this source decoded at before, and `remember` keeps it, so a reopened image
 * holds that box, not 16:9, while it is stat'ed and loaded again. Nothing else is reused: its
 * bytes wait for the new stat.
 */
export type MarkdownImageResolver = ((src: string) => Promise<MarkdownImagePreview | null>) & {
  size?: (src: string) => ImageSize | undefined; remember?: (src: string, size: ImageSize) => void;
};
export const MarkdownImageContext = createContext<MarkdownImageResolver | null>(null);
/** Chat holds its viewer above virtualized rows; file previews keep their own image behavior. */
export const MarkdownImageOpenContext = createContext<((image: GalleryImage) => void) | null>(null);
/** A reconnect retries only failed images; decoded images and pending stats stay as they are. */
export const MarkdownImageRetryContext = createContext(0);

/**
 * An image that holds its box until it decodes (lib/imageBox.ts). With `slot`, the wrapper is the
 * box while the bytes arrive and after a failure, where a note stands in for the picture, so the
 * row around it moves at most once, when the natural size is in; ChatView.css draws a standalone
 * Markdown image's 16:9 frame and a chat picture's lane-wide 16:9 slot. Decoded, the wrapper gives its box
 * up (`display: contents`) and the one image renders bare, nothing remounted: its box, hit area
 * and alignment are its own. Without `slot` (a badge in a sentence) nothing is held and a failure
 * shows `fallback`. `src` is null while an address is still being resolved: the slot stands from
 * the first paint. With `size` (what this image decoded at before), the loading slot is the box
 * `.markdown-image` will take, not 16:9; `onDecoded` reports the natural size to keep.
 */
export function ReservedImage({ src: address, alt, width, className, slot, slotStyle, fallback, onError, retry = 0, renderImage, size, onDecoded }: {
  src: string | null; alt: string; width?: number; className?: string; slot: boolean; slotStyle?: CSSProperties; fallback?: ReactNode; onError?: () => void; retry?: number;
  renderImage?: (image: ReactNode) => ReactNode; size?: ImageSize; onDecoded?: (size: ImageSize) => void;
}) {
  const t = useT();
  const resource = useResourceUrlState(address, retry);
  const src = resource.url;
  // Transport failures happen before an <img> exists, but must reach the same parent failure path.
  useEffect(() => { if (resource.error !== null) onError?.(); }, [resource.error, onError]);
  // keyed by address: another one starts from the slot again and never takes the old one's answer
  const [settled, setSettled] = useState<{ src: string; failed: boolean; attempt?: number } | null>(null);
  // an address the transport refused fails like an image that would not decode
  const phase = resource.error !== null ? "failed" : src !== null && settled?.src === src && (!settled.failed || settled.attempt === retry) ? (settled.failed ? "failed" : "decoded") : "loading";
  // a cached image is complete before `onLoad` can fire
  const element = useRef<HTMLImageElement | null>(null);
  const decoded = useRef(onDecoded);
  decoded.current = onDecoded;
  const report = (image: HTMLImageElement | null) => {
    if (image !== null && image.naturalWidth > 0 && image.naturalHeight > 0) decoded.current?.({ width: image.naturalWidth, height: image.naturalHeight });
  };
  const complete = useCallback((image: HTMLImageElement | null) => {
    element.current = image;
    if (image === null || src === null || !image.complete || image.naturalWidth <= 0) return;
    report(image);
    setSettled({ src, failed: false });
  }, [src]);
  if (phase === "failed" && !slot) return <>{fallback}</>;
  const image = src === null ? null : <img ref={complete} className={className} src={src} alt={alt} width={width} loading="lazy"
    onLoad={() => { report(element.current); setSettled({ src, failed: false }); }}
    onError={() => { setSettled({ src, failed: true, attempt: retry }); onError?.(); }} />;
  // the decoded image is as wide as its authored or natural width allows, its height from its ratio
  const sized = size === undefined ? slotStyle : {
    "--image-width": `${width !== undefined && Number.isFinite(width) && width > 0 ? Math.round(width) : size.width}px`,
    "--image-ratio": `${size.width} / ${size.height}`,
    "--image-aspect": String(size.width / size.height),
  } as CSSProperties;
  // Only the image or its reserved slot can be wrapped in a viewer control, never the fallback.
  const content = !slot ? image : phase === "failed"
    ? <span className="image-slot is-failed" style={slotStyle}>
      <span className="image-slot-note"><ImageOff aria-hidden="true" /><span>{t("Image unavailable")}</span>{alt !== "" && <span>{alt}</span>}</span>
    </span>
    : phase === "loading"
      ? <span className={`image-slot is-loading${size === undefined ? "" : " is-sized"}`} style={sized} role="status" aria-label={t("Loading image")}>{image}</span>
      : <span className="image-slot">{image}</span>;
  return content !== null && renderImage ? renderImage(content) : content;
}

function MarkdownImage({ src, alt, width, fallback, resolve, interactive, standalone }: { src: string; alt: string; width?: number; fallback: ReactNode; resolve: MarkdownImageResolver; interactive: boolean; standalone: boolean }) {
  const t = useT();
  const openImage = useContext(MarkdownImageOpenContext);
  const retry = useContext(MarkdownImageRetryContext);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState<{ src: string; resolve: MarkdownImageResolver; preview: MarkdownImagePreview | null; retry: number } | null>(null);
  const request = useRef<{ src: string; resolve: MarkdownImageResolver; failed: boolean; pending: boolean } | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  useEffect(() => () => { request.current = null; }, [src, resolve]);
  useEffect(() => {
    // Reconnects and manual retries never multiply a pending lookup or reload a healthy image.
    if (request.current?.src === src && request.current.resolve === resolve && (request.current.pending || !request.current.failed)) return;
    const current = { src, resolve, failed: false, pending: true };
    request.current = current;
    setPending(true);
    const finish = (preview: MarkdownImagePreview | null, failed = preview?.kind === "unavailable") => {
      if (request.current !== current) return;
      current.pending = false;
      current.failed = failed;
      setPending(false);
      setFailedUrl(null);
      setLoaded({ src, resolve, preview, retry: retry + attempt });
    };
    resolve(src).then(
      (preview) => finish(preview),
      () => finish(null, true),
    );
  }, [src, resolve, retry, attempt]);
  const preview = loaded?.src === src && loaded.resolve === resolve ? loaded.preview : undefined;
  if (preview === null) return <>{fallback}</>;
  if (preview?.kind === "unavailable") return <span className="markdown-image-unavailable" role="group" aria-label={alt || src}>
    {fallback}
    {interactive && <button type="button" className="btn markdown-image-retry" disabled={pending} onClick={() => {
      if (request.current?.pending || !request.current?.failed) return;
      setPending(true);
      setAttempt((value) => value + 1);
    }}>{t("Try again")}</button>}
  </span>;
  if (preview?.kind === "too-large") {
    const message = t("This image is {size}; download it to view.", { size: formatBytes(preview.size) });
    return interactive ? <a href={preview.downloadUrl} download>{message}</a> : <span>{message}</span>;
  }
  // still being stat'ed: a standalone image's slot stands from the first paint, a badge shows its alt
  if (preview === undefined && !standalone) return <span>{alt}</span>;
  if (!standalone && preview?.url === failedUrl) return <>{fallback}</>;
  // A failed byte load retries only after the new stat has passed the same size/type checks.
  return <ReservedImage src={preview?.url ?? null} alt={alt} width={width} className="markdown-image" slot={standalone} size={standalone ? resolve.size?.(src) : undefined} onDecoded={standalone ? (size) => resolve.remember?.(src, size) : undefined} slotStyle={standalone ? imageSlotStyle(width) : undefined} fallback={fallback} retry={loaded?.retry ?? 0} renderImage={preview === undefined || !interactive || openImage === null ? undefined : (image) =>
    <button type="button" className={`markdown-image-open${standalone ? " is-standalone" : ""}`} aria-label={alt || preview.name} title={t("Open image")} onClick={(event) => {
      event.currentTarget.focus({ preventScroll: true });
      openImage({ src: preview.url, name: alt || preview.name, file: preview.name });
    }}>{image}</button>
  } onError={() => {
    if (request.current?.src === src && request.current.resolve === resolve && !request.current.pending) request.current.failed = true;
    setFailedUrl(preview?.url ?? null);
  }} />;
}

/**
 * `interactive` is false inside a link or file label: nothing clickable nests in another.
 * `standalone` says the line is one image and nothing else (lib/imageBox.ts): it holds a slot while it decodes.
 */
function Inline({ nodes, interactive = true, standalone = false }: { nodes: InlineNode[]; interactive?: boolean; standalone?: boolean }) {
  const context = useContext(OpenFileContext);
  const open = interactive ? context : null;
  const t = useT();
  const imageResolver = useContext(MarkdownImageContext);
  const skillMatcher = useContext(SkillMatcherContext);
  const openWebPage = useContext(WebPanelContext);
  const machineId = useContext(MachineContext);
  const { settings } = useSettings();
  // a plain or Shift click may open the address beside the pane; Ctrl, Cmd and Alt keep the browser's own meaning
  const webClick = (href: string) => (event: MouseEvent<HTMLAnchorElement>): void => {
    if (shouldOpenWebPage(event, href, openWebPage, machineId)) event.preventDefault();
    else if (settings.reuseExternalLinkTab && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey && isWebLink(href)) {
      event.preventDefault();
      openWebLink(href, true);
    }
  };
  return <>{nodes.map((node, index) => {
    const key = `${node.type}-${index}`;
    switch (node.type) {
      case "text":
        // a skill chip carries its raw text, so a selection copies what the agent wrote; not inside a link or file label
        return <span key={key}>{(interactive && skillMatcher !== null ? skillMatcher(node.value) : [node.value]).map((piece, p) => {
          if (typeof piece !== "string") return <span key={p} className="markdown-skill"><BookOpen aria-hidden="true" />{piece.raw}</span>;
          if (open === null) return piece;
          return <Fragment key={p}>{splitFilePaths(piece).map((part, n) => typeof part === "string" ? part : <FilePathLink key={n} path={part.path} code={false} open={open} />)}</Fragment>;
        })}</span>;
      case "code": {
        const file = fileUriPath(node.value);
        if (open !== null && file !== null) return <FilePathLink key={key} path={file} code open={open} />;
        // agents often put an address in backticks: it stays code to the eye, and opens
        if (interactive && /^https?:\/\/\S+$/i.test(node.value)) return <a key={key} className="markdown-code-link" href={node.value} target="_blank" rel="noopener noreferrer" onClick={webClick(node.value)}><code>{node.value}</code></a>;
        return open !== null && codeIsFilePath(node.value) ? <FilePathLink key={key} path={node.value} code open={open} /> : <code key={key}>{node.value}</code>;
      }
      case "math": return <MathExpression key={key} value={node.value} dollar={node.dollar} />;
      case "image": {
        return <span key={key}>{imageResolver === null
          ? <Inline key={key} nodes={node.fallback} interactive={interactive} />
          : <MarkdownImage src={node.src} alt={node.alt} width={node.width} resolve={imageResolver} interactive={interactive} standalone={standalone} fallback={<Inline nodes={node.fallback} interactive={interactive} />} />}</span>;
      }
      case "strong": return <strong key={key}><Inline nodes={node.children} interactive={interactive} /></strong>;
      case "em": return <em key={key}><Inline nodes={node.children} interactive={interactive} /></em>;
      case "del": return <del key={key}><Inline nodes={node.children} interactive={interactive} /></del>;
      case "link": return <a key={key} href={node.href} target="_blank" rel="noopener noreferrer" onClick={webClick(node.href)}><Inline nodes={node.children} interactive={false} standalone={standalone} /></a>;
      // the label opens the file; where nothing can open one, the path shows after it, as Codex's terminal does
      case "file": {
        const label = <Inline nodes={node.children} interactive={false} />;
        return open !== null
          ? <button key={key} type="button" className="markdown-file" title={t("Open {path}", { path: node.path })} onClick={() => open(node.path)}>{label}</button>
          : <span key={key}>{label} (<code>{node.path}</code>)</span>;
      }
    }
  })}</>;
}

/** A list, nested lists and tables in its items; a task item's box stands in for its bullet. */
function List({ block }: { block: ListBlock }) {
  const Tag = block.ordered ? "ol" : "ul";
  // the widest number's digits: its marker sets the list's indent (ChatView.css). The browser counts
  // from 1 when `start` is past a 32-bit integer, so such a start sets no wider indent
  const first = block.start !== undefined && block.start <= 2 ** 31 - 1 ? block.start : 1;
  const digits = block.ordered ? String(first + block.items.length - 1).length : 1;
  const t = useT();
  const id = useId();
  return (
    <Tag className="markdown-list" start={block.ordered ? block.start : undefined} style={digits > 1 ? { "--markdown-list-digits": digits } as CSSProperties : undefined}>
      {block.items.map((item, index) => (
        <li key={index} className={item.checked === undefined ? undefined : "markdown-task"}>
          {/* a task's box shows its state; the agent's text owns it, so it cannot be ticked here. Drawn,
              not an <input>: a disabled checkbox is greyed by the browser and ignores the accent. It is
              named by the item's text, or, with none (`- [ ]`), as an empty task */}
          {item.checked !== undefined && <span className="markdown-task-box" role="checkbox" aria-checked={item.checked} aria-disabled="true"
            aria-labelledby={item.content.length === 0 ? undefined : `${id}-${index}`} aria-label={item.content.length === 0 ? t("Empty task") : undefined}>{item.checked && <Check aria-hidden="true" />}</span>}
          {item.checked === undefined ? <Inline nodes={item.content} /> : <span id={`${id}-${index}`}><Inline nodes={item.content} /></span>}
          {item.blocks !== undefined && <Blocks blocks={item.blocks} />}
        </li>
      ))}
    </Tag>
  );
}

/** A fence in no language, or in one that says plain output (a log, a command's answer): the files it names open. */
const PLAIN_FENCE = /^(?:|text|txt|plain|plaintext|log|console|output|shell-session)$/i;

function CodeBlock({ language, value }: { language: string; value: string }) {
  const t = useT();
  const open = useContext(OpenFileContext);
  const grammar = languageForFence(language);
  // the tag decides, not the grammar: code in a language with no grammar here is still code
  const plain = PLAIN_FENCE.test(language.trim().split(/\s+/)[0] ?? "");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const block = useRef<HTMLDivElement>(null);
  // no inner scroll: a long block folds, with a visible "Show all" row
  const fold = useMemo(() => foldCode(value), [value]);
  const copy = async (): Promise<void> => {
    const ok = await copyText(value);
    setCopied(ok);
    setCopyFailed(!ok);
    if (ok) window.setTimeout(() => setCopied(false), 1500);
  };
  const folding = useRef(false);
  const toggle = (): void => {
    folding.current = expanded;
    setExpanded(!expanded);
  };
  // "Show less" sits at the bottom of a long block: after folding, bring the block's top back
  // into view rather than leave the reader far below it
  useLayoutEffect(() => {
    if (!folding.current) return;
    folding.current = false;
    const node = block.current;
    const view = node?.closest(".chat-view");
    if (node && view && node.getBoundingClientRect().top < view.getBoundingClientRect().top) node.scrollIntoView({ block: "start" });
  }, [expanded]);
  return (
    <div className="markdown-code" ref={block}>
      <div className="markdown-code-header">
        <span>{language || "text"}</span>
        <button type="button" className="icon-button markdown-code-copy" onClick={() => void copy()} aria-label={t(copied ? "Code copied" : "Copy code")}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
      </div>
      {copyFailed && <p className="markdown-code-error" role="alert">{t("Couldn't copy. Select the text and copy it manually.")}</p>}
      {/* a block in no language is output (a log, a command's answer): the files it names open */}
      <HighlightedCode code={fold !== null && !expanded ? fold.head : value} language={grammar} limit={CHAT_HIGHLIGHT_LIMIT} open={plain ? open : null} />
      {fold !== null && (
        <button type="button" className="markdown-code-more" aria-expanded={expanded} onClick={toggle}>
          {expanded ? t("Show less") : t("Show all {n} lines", { n: fold.lines })}
        </button>
      )}
    </div>
  );
}

function Blocks({ blocks }: { blocks: MarkdownBlock[] }) {
  return <>{blocks.map((block, index): ReactNode => {
    const key = `${block.type}-${index}`;
    switch (block.type) {
      case "heading":
        // agent headings are h3 whatever the agent wrote: the app's own h1/h2 (Brand, the dialog
        // titles) stay the outline above them. The level rides on a class, so the stylesheet
        // keeps drawing each level as it did (ChatView.css `.markdown h1`...`.markdown h6`).
        return <h3 key={key} className={`markdown-h${block.level}${block.align ? " markdown-center" : ""}`}><Inline nodes={block.content} /></h3>;
      case "paragraph":
        return <p key={key} className={block.align ? "markdown-center" : undefined}>{block.lines.map((line, lineIndex) => <span key={lineIndex}><Inline nodes={line} standalone={standaloneImage(line)} />{lineIndex < block.lines.length - 1 && <br />}</span>)}</p>;
      case "list": return <List key={key} block={block} />;
      case "blockquote": return <blockquote key={key}><Blocks blocks={block.blocks} /></blockquote>;
      case "code": return block.language === "mermaid"
        ? <MermaidDiagram key={key} value={block.value} />
        : block.language.toLowerCase() === "svg"
          ? <SvgFigure key={key} value={block.value} />
          // a ```math fence (GitHub's form) is display math; one KaTeX cannot draw stays the code block it is
          : block.language === "math"
            ? <MathExpression key={key} value={block.value} displayMode fallback={<CodeBlock language="math" value={block.value} />} />
            : <CodeBlock key={key} language={block.language} value={block.value} />;
      case "math": return <MathExpression key={key} value={block.value} displayMode dollar={block.dollar} oneLine={block.oneLine} />;
      case "hr": return <hr key={key} />;
      case "table": return (
        <div className="markdown-table-wrap" key={key}>
          <table><thead><tr>{block.header.map((cell, cellIndex) => <th key={cellIndex}><Inline nodes={cell} /></th>)}</tr></thead>
            <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}><Inline nodes={cell} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    }
  })}</>;
}

/**
 * Markdown rendered. Its props are primitive values, so `memo` skips a parent's re-render: a long plan in
 * the file viewer is not rendered again every time the app polls.
 */
export const Markdown = memo(function Markdown({ children, className, html = false, skills = null }: { children: string; className?: string; html?: boolean; skills?: SkillMatcher | null }) {
  const blocks = useMemo(() => parseMarkdown(children, 0, html), [children, html]);
  // always a provider, which passes on the names around it when it has none of its own: the pane's skill names
  // load after its text, and a tree that changed shape then would mount every message again, a decoded image
  // dropping back to its loading slot
  const around = useContext(SkillMatcherContext);
  return <SkillMatcherContext.Provider value={skills ?? around}><ParsedMarkdown blocks={blocks} className={className} /></SkillMatcherContext.Provider>;
});

/** `nodes` with each link, file link and picture as its words: text in a control that answers when clicked opens nothing itself. */
function withoutLinks(nodes: InlineNode[]): InlineNode[] {
  return nodes.flatMap((node): InlineNode[] => {
    switch (node.type) {
      case "link": case "file": return withoutLinks(node.children);
      case "image": return node.alt === "" ? [] : [{ type: "text", value: node.alt }];
      case "strong": case "em": case "del": return [{ ...node, children: withoutLinks(node.children) }];
      default: return [node];
    }
  });
}

/** One line of inline Markdown inside a button or a checkbox's label (an Ask card's option): emphasis, code and math, with no link in it. */
export const InlineMarkdown = memo(function InlineMarkdown({ children }: { children: string }) {
  const nodes = useMemo(() => withoutLinks(parseInline(children, false)), [children]);
  return <Inline nodes={nodes} interactive={false} />;
});

/**
 * Markdown parsed elsewhere, rendered as `Markdown` renders its text: the file viewer parses a file
 * in a worker, so a file the parser is slow on cannot hold the page.
 */
export const ParsedMarkdown = memo(function ParsedMarkdown({ blocks, className }: { blocks: MarkdownBlock[]; className?: string }) {
  return <div className={className === undefined ? "markdown" : `markdown ${className}`}><Blocks blocks={blocks} /></div>;
});

const BlockChunk = memo(function BlockChunk({ blocks }: { blocks: MarkdownBlock[] }) {
  return <Blocks blocks={blocks} />;
});

/**
 * `ParsedMarkdown` drawn a chunk of blocks per task (previewChunks), for a whole file's Preview: up
 * to PREVIEW_ELEMENT_LIMIT elements drawn and laid out in one task held a slow page past a second.
 * The first chunk shows at once and each later one is added in a task of its own; a drawn chunk is
 * never drawn again, and new blocks start over from the first chunk.
 */
export const ProgressiveMarkdown = memo(function ProgressiveMarkdown({ blocks, className }: { blocks: MarkdownBlock[]; className?: string }) {
  const chunks = useMemo(() => previewChunks(blocks), [blocks]);
  const [drawn, setDrawn] = useState<{ blocks: MarkdownBlock[]; count: number }>({ blocks, count: 1 });
  const count = drawn.blocks === blocks ? drawn.count : 1;
  useEffect(() => {
    if (count >= chunks.length) return;
    const timer = setTimeout(() => setDrawn({ blocks, count: count + 1 }), 0);
    return () => clearTimeout(timer);
  }, [blocks, chunks.length, count]);
  return <div className={className === undefined ? "markdown" : `markdown ${className}`}>
    {chunks.slice(0, count).map((chunk, index) => <BlockChunk key={index} blocks={chunk} />)}
  </div>;
});
