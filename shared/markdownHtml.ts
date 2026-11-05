import type { InlineNode, MarkdownBlock } from "./markdown.ts";
import { markdownFileNode, safeMarkdownHref, webLikeHref } from "./markdown.ts";

/**
 * The HTML a README carries (a centered logo, a row of badges, `<details>`), read into the blocks
 * the markdown view already draws: never markup put on the page. Only what reads as text comes
 * through: paragraphs and headings (centered when `align="center"` says so), links, images,
 * emphasis, code and line breaks. Any other tag is left out and its text kept; a comment, a script
 * and a style are dropped.
 * An HTML block starts with one of these tags or a comment and ends at a blank line (CommonMark).
 */
const BLOCK_TAGS = new Set(["p", "div", "center", "details", "summary", "picture", "h1", "h2", "h3", "h4", "h5", "h6", "table", "tr", "td", "th", "tbody", "thead", "ul", "ol", "li", "blockquote", "figure", "figcaption", "section"]);
const START_TAGS = new Set([...BLOCK_TAGS, "img", "a", "br", "source", "b", "strong", "em", "i", "code", "kbd", "sub", "sup", "span", "hr"]);

/** Whether the line opens an HTML block the file viewer reads. */
export function startsHtml(line: string): boolean {
  const match = /^ {0,3}<(!--|\/?([a-zA-Z][a-zA-Z0-9]*)(?=[\s/>]|$))/.exec(line);
  return match !== null && (match[1] === "!--" || START_TAGS.has((match[2] ?? "").toLowerCase()));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", middot: "·", copy: "©", reg: "®", mdash: "—", ndash: "–", hellip: "…" };
/** a numeric reference outside Unicode, a surrogate or zero (`&#1114112;`) is the replacement character, never a throw */
function codePoint(value: number): string {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : "\ufffd";
}
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) return codePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return codePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attributes);
  return match === null ? null : decode(match[1] ?? match[2] ?? match[3] ?? "");
}

type Holder = { kind: "link"; href: string | null; file: string | null; children: InlineNode[] } | { kind: "strong" | "em"; children: InlineNode[] };

/** Reads the lines of one HTML block, from `index`, into blocks; `next` is the line after it. */
export function parseHtmlBlock(lines: readonly string[], index: number): { blocks: MarkdownBlock[]; next: number } {
  let next = index;
  const body: string[] = [];
  // a comment runs to the line that ends it, blank lines and all, and no further: the heading or
  // the fence on the next line is markdown again; anything else runs to the first blank line
  if (/^ {0,3}<!--/.test(lines[index] ?? "")) {
    while (next < lines.length) { const line = lines[next++] ?? ""; body.push(line); if (line.includes("-->")) break; }
  } else {
    while (next < lines.length && (lines[next] ?? "").trim() !== "") body.push(lines[next++] ?? "");
  }
  return { blocks: readHtml(body.join("\n")), next };
}

function readHtml(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let lines: InlineNode[][] = [[]];
  let align: "center" | undefined;
  // the alignment of each open block, outermost first: `<center><h1>…</h1><p>…</p></center>` centers both
  const aligns: Array<"center" | undefined> = [];
  let heading: 1 | 2 | 3 | 4 | 5 | 6 | null = null;
  const holders: Holder[] = [];
  const target = (): InlineNode[] => holders.at(-1)?.children ?? lines[lines.length - 1]!;
  const flush = (): void => {
    while (holders.length > 0) close(holders[holders.length - 1]!.kind);
    const kept = lines.map(trimLine).filter((line, at, all) => line.length > 0 || (at > 0 && at < all.length - 1));
    if (kept.length > 0) {
      if (heading !== null) blocks.push({ type: "heading", level: heading, content: kept.flatMap((line, at) => at === 0 ? line : [{ type: "text", value: " " }, ...line]), ...(align ? { align } : {}) });
      else blocks.push({ type: "paragraph", lines: kept, ...(align ? { align } : {}) });
    }
    lines = [[]];
    heading = null;
  };
  const push = (node: InlineNode): void => {
    const into = target();
    const last = into[into.length - 1];
    if (node.type === "text" && last?.type === "text") into[into.length - 1] = { type: "text", value: last.value + node.value };
    else into.push(node);
  };
  const close = (kind: Holder["kind"]): void => {
    const at = holders.map((holder) => holder.kind).lastIndexOf(kind);
    if (at === -1) return;
    while (holders.length > at) {
      const holder = holders.pop()!;
      const children = holder.children;
      if (holder.kind === "link") {
        if (holder.href !== null) push({ type: "link", href: holder.href, children });
        else {
          const file = holder.file === null ? null : markdownFileNode(holder.file, children);
          if (file !== null) push(file);
          else for (const child of children) push(child);
        }
      } else push({ type: holder.kind, children });
    }
  };

  const token = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</g;
  // what a script or a style holds is no text
  let hidden: string | null = null;
  for (const match of source.matchAll(token)) {
    const [whole, closing, rawName, attributes = "", text] = match;
    if (whole.startsWith("<!--")) continue;
    if (hidden !== null) { if (closing && rawName?.toLowerCase() === hidden) hidden = null; continue; }
    if (!closing && (rawName?.toLowerCase() === "script" || rawName?.toLowerCase() === "style")) { hidden = rawName.toLowerCase(); continue; }
    if (text !== undefined || rawName === undefined) {
      // HTML folds its whitespace: a line break in the source is a space
      const value = decode((text ?? whole).replace(/\s+/g, " "));
      // a space between two words in a link or an emphasis stays; one at a paragraph's start does not
      if (value.trim() !== "" || target().length > 0) push({ type: "text", value });
      continue;
    }
    const name = rawName.toLowerCase();
    if (BLOCK_TAGS.has(name)) {
      flush();
      if (closing) { aligns.pop(); align = aligns.at(-1); continue; }
      align = /^center$/i.test(attribute(attributes, "align") ?? "") || name === "center" ? "center" : aligns.at(-1);
      aligns.push(align);
      if (/^h[1-6]$/.test(name)) heading = Number(name[1]) as 1 | 2 | 3 | 4 | 5 | 6;
      continue;
    }
    if (name === "br") {
      // a break inside a link or an emphasis: the open ones end on this line and go on on the next
      const reopened: Holder[] = holders.map((holder) => holder.kind === "link" ? { kind: "link", href: holder.href, file: holder.file, children: [] } : { kind: holder.kind, children: [] });
      while (holders.length > 0) close(holders[holders.length - 1]!.kind);
      lines.push([]);
      holders.push(...reopened);
      continue;
    }
    if (name === "hr") { flush(); blocks.push({ type: "hr" }); continue; }
    if (name === "img") {
      const src = attribute(attributes, "src");
      const alt = attribute(attributes, "alt") ?? "";
      const width = Number.parseInt(attribute(attributes, "width") ?? "", 10);
      if (src) push({ type: "image", alt, src, fallback: alt ? [{ type: "text", value: alt }] : [], ...(width > 0 ? { width } : {}) });
      continue;
    }
    if (name === "a") {
      if (closing) { close("link"); continue; }
      const raw = attribute(attributes, "href") ?? "";
      const href = safeMarkdownHref(raw) ?? webLikeHref(raw);
      holders.push({ kind: "link", href, file: href === null ? raw : null, children: [] });
      continue;
    }
    if (name === "strong" || name === "b") { if (closing) close("strong"); else holders.push({ kind: "strong", children: [] }); continue; }
    if (name === "em" || name === "i") { if (closing) close("em"); else holders.push({ kind: "em", children: [] }); continue; }
    // code and kbd hold text; anything else (span, sub, source…) is left out, its text kept
  }
  flush();
  return blocks;
}

/** A line's text without the spaces HTML's indentation left at its ends. */
function trimLine(line: InlineNode[]): InlineNode[] {
  const out = [...line];
  const first = out[0];
  if (first?.type === "text") { const value = first.value.trimStart(); if (value === "") out.shift(); else out[0] = { type: "text", value }; }
  const last = out[out.length - 1];
  if (last?.type === "text") { const value = last.value.trimEnd(); if (value === "") out.pop(); else out[out.length - 1] = { type: "text", value }; }
  return out;
}
