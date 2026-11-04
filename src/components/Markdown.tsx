import { createContext, Fragment, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { BookOpen, Check, Copy, ImageOff, Maximize2 } from "lucide-react";

import { foldCode, mathNestsTooDeep, parseInline, parseMarkdown, type InlineNode, type ListBlock, type MarkdownBlock } from "../../shared/markdown.ts";
import { codeIsFilePath, OpenFileContext, splitFilePaths } from "../lib/filePaths.ts";
import { FilePathLink } from "./FilePathLink.tsx";
import { fileUriPath } from "../../shared/fileUri.ts";
import { WebPanelContext } from "../lib/webPanel.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { CHAT_HIGHLIGHT_LIMIT, languageForFence } from "../lib/highlight.ts";
import { HighlightedCode } from "./HighlightedCode.tsx";
import { useT } from "../lib/i18n.ts";
import { type MarkdownImagePreview } from "../lib/markdownImages.ts";
import { imageSlotStyle, standaloneImage } from "../lib/imageBox.ts";
import { formatBytes } from "../lib/bridgeProgress.ts";
import { MermaidLightbox } from "./MermaidLightbox.tsx";
import { copyText } from "../lib/clipboard.ts";
import { lazyChunk } from "../lib/lazyChunk.ts";
import type { SkillMatcher } from "../lib/skillMentions.ts";
import { previewChunks } from "../lib/textPreview.ts";
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

function MathExpression({ value, displayMode = false }: { value: string; displayMode?: boolean }) {
  const katex = useKatex();
  const source = displayMode ? `\\[${value}\\]` : `\\(${value}\\)`;
  if (!katex || mathNestsTooDeep(value)) return <span>{source}</span>;
  try {
    // KaTeX escapes text and rejects untrusted commands by default, and an unknown command
    // throws - the catch below then draws the source form. `trust` stays at its default, which
    // is what keeps \href and \includegraphics refused. `strict` only governs input LaTeX would
    // not accept: "ignore" draws Korean, Japanese or Chinese text inside an expression, which
    // `strict: true` throws on.
    const html = katex.renderToString(value, { displayMode, strict: "ignore" });
    return <span className={displayMode ? "markdown-math-display" : "markdown-math"} dangerouslySetInnerHTML={{ __html: html }} />;
  } catch {
    return <span>{source}</span>;
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

/** Stats an image before it can load; null context keeps chat images as links. */
type MarkdownImageResolver = (src: string) => Promise<MarkdownImagePreview | null>;
export const MarkdownImageContext = createContext<MarkdownImageResolver | null>(null);

/**
 * An image that holds its box until it decodes (lib/imageBox.ts). With `slot`, the wrapper is the
 * box while the bytes arrive and after a failure, where a note stands in for the picture, so the
 * row around it moves at most once, when the natural size is in; ChatView.css draws a standalone
 * Markdown image's 16:9 frame and a chat thumbnail's fixed box. Decoded, the wrapper gives its box
 * up (`display: contents`) and the one image renders bare, nothing remounted: its box, hit area
 * and alignment are its own. Without `slot` (a badge in a sentence) nothing is held and a failure
 * shows `fallback`. `src` is null while an address is still being resolved: the slot stands from
 * the first paint.
 */
export function ReservedImage({ src, alt, width, className, slot, slotStyle, fallback }: {
  src: string | null; alt: string; width?: number; className?: string; slot: boolean; slotStyle?: CSSProperties; fallback?: ReactNode;
}) {
  const t = useT();
  // keyed by address: another one starts from the slot again and never takes the old one's answer
  const [settled, setSettled] = useState<{ src: string; failed: boolean } | null>(null);
  const phase = src !== null && settled?.src === src ? (settled.failed ? "failed" : "decoded") : "loading";
  // a cached image is complete before `onLoad` can fire
  const complete = useCallback((image: HTMLImageElement | null) => {
    if (image !== null && src !== null && image.complete && image.naturalWidth > 0) setSettled({ src, failed: false });
  }, [src]);
  if (phase === "failed" && !slot) return <>{fallback}</>;
  const image = src === null ? null : <img ref={complete} className={className} src={src} alt={alt} width={width} loading="lazy"
    onLoad={() => setSettled({ src, failed: false })} onError={() => setSettled({ src, failed: true })} />;
  if (!slot) return image;
  if (phase === "failed") {
    return <span className="image-slot is-failed" style={slotStyle}>
      <span className="image-slot-note"><ImageOff aria-hidden="true" /><span>{t("Image unavailable")}</span>{alt !== "" && <span>{alt}</span>}</span>
    </span>;
  }
  if (phase === "loading") return <span className="image-slot is-loading" style={slotStyle} role="status" aria-label={t("Loading image")}>{image}</span>;
  return <span className="image-slot">{image}</span>;
}

function MarkdownImage({ src, alt, width, fallback, resolve, interactive, standalone }: { src: string; alt: string; width?: number; fallback: ReactNode; resolve: MarkdownImageResolver; interactive: boolean; standalone: boolean }) {
  const t = useT();
  const [loaded, setLoaded] = useState<{ src: string; resolve: MarkdownImageResolver; preview: MarkdownImagePreview | null } | null>(null);
  useEffect(() => {
    let live = true;
    resolve(src).then(
      (preview) => { if (live) setLoaded({ src, resolve, preview }); },
      () => { if (live) setLoaded({ src, resolve, preview: null }); },
    );
    return () => { live = false; };
  }, [src, resolve]);
  const preview = loaded?.src === src && loaded.resolve === resolve ? loaded.preview : undefined;
  if (preview === null) return <>{fallback}</>;
  if (preview?.kind === "too-large") {
    const message = t("This image is {size}; download it to view.", { size: formatBytes(preview.size) });
    return interactive ? <a href={preview.downloadUrl} download>{message}</a> : <span>{message}</span>;
  }
  // still being stat'ed: a standalone image's slot stands from the first paint, a badge shows its alt
  if (preview === undefined && !standalone) return <span>{alt}</span>;
  return <ReservedImage src={preview?.url ?? null} alt={alt} width={width} className="markdown-image" slot={standalone} slotStyle={standalone ? imageSlotStyle(width) : undefined} fallback={fallback} />;
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
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey) return;
    if (openWebPage?.(href, event.shiftKey, machineId)) event.preventDefault();
    else if (settings.reuseExternalLinkTab && isWebLink(href)) {
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
      case "math": return <MathExpression key={key} value={node.value} />;
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
        : <CodeBlock key={key} language={block.language} value={block.value} />;
      case "math": return <MathExpression key={key} value={block.value} displayMode />;
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
  const parsed = <ParsedMarkdown blocks={blocks} className={className} />;
  return skills === null ? parsed : <SkillMatcherContext.Provider value={skills}>{parsed}</SkillMatcherContext.Provider>;
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
