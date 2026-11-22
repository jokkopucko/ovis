import { fileUriPath } from "./fileUri.ts";
import { charBefore } from "./lookbehind.ts";
import { visualizationReference, type VisualizationReference } from "./visualization.ts";
import { parseHtmlBlock, startsHtml } from "./markdownHtml.ts";
import { linkTaskCode, linkTaskIds } from "./taskLinks.ts";

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "math"; value: string; dollar?: true }
  | { type: "strong" | "em" | "del"; children: InlineNode[] }
  | { type: "link"; href: string; title?: string; children: InlineNode[] }
  | { type: "image"; alt: string; src: string; fallback: InlineNode[]; width?: number }
  | { type: "file"; path: string; children: InlineNode[]; written?: string };

export interface ListItem {
  content: InlineNode[];
  checked?: boolean;
  blocks?: MarkdownBlock[];
  /**
   * An ordered item's number as written, when its list's numbers neither count up from the first
   * nor all repeat it: `1.` then `4.` shows 1 and 4, as typed, where markdown would renumber them
   * 1 and 2 and change what was said. Absent, so the list counts up from its first number, from a
   * list that counts up; from one whose first two items share a number (`1.` `1.` …, markdown's way
   * to let the numbers count), so a `2.` arriving in a streamed reply changes no number already on
   * screen; and from one holding a number past `LIST_NUMBER_LIMIT`, which the browser cannot draw.
   */
  number?: number;
}

/** The largest list number a browser draws: past a 32-bit integer it ignores `start` and `value`. */
export const LIST_NUMBER_LIMIT = 2 ** 31 - 1;

export interface ListBlock {
  type: "list";
  ordered: boolean;
  start?: number;
  items: ListItem[];
}

export type MarkdownBlock =
  | ({ type: "visualization" } & VisualizationReference)
  | { type: "math"; value: string; dollar?: true; oneLine?: true }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; content: InlineNode[]; align?: "center" }
  | { type: "paragraph"; lines: InlineNode[][]; align?: "center" }
  | ListBlock
  | { type: "blockquote"; blocks: MarkdownBlock[] }
  | { type: "code"; language: string; value: string }
  | { type: "table"; header: InlineNode[][]; rows: InlineNode[][][] }
  | { type: "hr" };

export function shownText(nodes: InlineNode[], addresses = false): string | null {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text": case "code": out += node.value; break;
      case "strong": case "em": case "del": {
        const inner = shownText(node.children, addresses);
        if (inner === null) return null;
        out += inner;
        break;
      }
      case "link": case "file": {
        const words = shownText(node.children);
        if (words === null) return null;
        const href = node.type === "link" ? node.href : node.written ?? node.path;
        out += addresses && href && words !== href && words !== href.replace(/^mailto:/, "") ? `${words} (${href})` : words;
        break;
      }
      case "math": case "image": return null;
    }
  }
  return out;
}

export function safeMarkdownHref(href: string): string | null {
  const value = href.trim();
  return /^(?:https?:\/\/|mailto:)/i.test(value) ? value : null;
}

export function webLikeHref(target: string): string | null {
  const value = target.trim();
  if (/^(?:localhost(?::\d+)?|\d{1,3}(?:\.\d{1,3}){3}:\d+|\d{1,3}(?:\.\d{1,3}){3}(?=\/))(?:\/\S*)?$/i.test(value)) return `http://${value}`;
  const match = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?::\d+)?(\/\S*)?$/i.exec(value);
  if (match === null) return null;
  const [, host, path] = match;
  return /^www\./i.test(host!) || path !== undefined ? `https://${value}` : null;
}

/**
 * A path that begins with two separators (`//nas/work/a.md`, a network share on a Windows PC) stays a
 * link: whether it opens is the server's to say, which knows its system and where its panes work
 * (server/windows-share.ts).
 */
export function markdownFileTarget(href: string): string | null {
  const value = href.trim();
  if (/^file:\/\/\//i.test(value)) return fileUriPath(value);
  if (value === "" || value.startsWith("#")) return null;
  const target = value.replace(/#(?!L\d+(?:-L?\d+)?$).*$/, "");
  const path = target.replace(/(?::\d+){1,2}$|#L\d+(?:-L?\d+)?$/, "");
  if (path === "" || /^[a-z][a-z0-9+.-]*:/i.test(path) || (path !== target && !/[./]/.test(path))) return null;
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch {}
  // a control character belongs to no path, an encoded `%3A12` or `%23L12` names the file, not a
  // line, and an encoded space at either end would be trimmed away by the viewer
  if (/[\u0000-\u001f\u007f]|(?::\d+){1,2}$|#L\d+(?:-L?\d+)?$|^\s|\s$/.test(decoded)) decoded = path;
  return decoded + target.slice(path.length);
}

export function markdownFileNode(href: string, children: InlineNode[]): InlineNode | null {
  const path = markdownFileTarget(href);
  if (path === null) return null;
  const written = href.trim();
  return /^file:/i.test(written) || !/%[0-9a-f]{2}/i.test(written) || path === written
    ? { type: "file", path, children } : { type: "file", path, written, children };
}

/** A bare URL without the punctuation that closes the sentence around it (GFM's autolink rule). */
export function trimUrl(url: string): string {
  let end = url.length;
  let opened = 0;
  let closed = 0;
  for (let index = 0; index < end; index += 1) {
    if (url[index] === "(") opened += 1;
    else if (url[index] === ")") closed += 1;
  }
  for (;;) {
    const last = url[end - 1];
    if (last !== undefined && ".,:;!?'\"*_~".includes(last)) { end -= 1; continue; }
    if (last === ")" && closed > opened) { end -= 1; closed -= 1; continue; }
    break;
  }
  return url.slice(0, end);
}

const MAX_INLINE_DEPTH = 16;

function codexFileCitation(token: string): { path: string; label: string } | null {
  const body = token.slice(21, -1).replace(/[ \t]+$/, "");
  const attribute = /\s*([a-z_]+)="((?:[^"\\]|\\.)*)"/gy;
  const values = new Map<string, string>();
  let at = 0;
  while (at < body.length) {
    attribute.lastIndex = at;
    const match = attribute.exec(body);
    if (match === null || values.has(match[1]!)) return null;
    try { values.set(match[1]!, JSON.parse(`"${match[2]}"`) as string); } catch { return null; }
    at = attribute.lastIndex;
  }
  const path = values.get("path");
  // as a file:/// link (fileUri.ts): an absolute local path, never a network share however its separators are written
  if (!path || !(/^(?:\/|[A-Za-z]:[\\/])/.test(path)) || /^[\\/]{2}/.test(path) || /[\x00-\x1f\x7f]/.test(path)
    || !["source", "output"].includes(values.get("purpose") ?? "") || values.has("mode")) return null;
  const label = path.split(/[\\/]/).pop();
  return label ? { path, label } : null;
}

/**
 * The marks in a line, left to right, as one search of the line for the pattern found them. That
 * search looks from every `[`, `\(` and `_` to the end of the line for what closes it, so a long
 * line of them that never close took a minute. Here the pattern is tried only where a mark can
 * start, and where a closer may be far away, only if one is there: each closer is looked for
 * once, for every opener before it.
 */
export function* inlineMarks(source: string): Generator<RegExpExecArray> {
  const marker = /(`[^`\n]+`|:codex-file-citation\{(?:[ \t]*[a-z_]+="[^"\\\n]*(?:\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4})[^"\\\n]*)*")+[ \t]*\}|\\\(.+?\\\)|\$(?:[^\s$\\`]|[^\s$`][^\n\r\u2028\u2029$`]*[^\s$\\`])\$(?![A-Za-z0-9_${#@*(`])|\[[^\]\n]+\]\([^\s)]+(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\)|<https?:\/\/[^\s<>]+>|file:\/\/\/[!#-;=?-_a-~]+|https?:\/\/[!-;=?-~]+|www\.[!-;=?-~]+|\*\*[^*\n]+\*\*|__(?=\S)[^\n]*?\S__(?![\p{L}\p{N}\p{M}_])|~~[^~\n]+~~|\*[^*\n]+\*(?!\*)|_(?=\S)[^\n]*?\S_(?![\p{L}\p{N}\p{M}_]))/yu;
  const emphasis = /_(?=\S)[^\n]*?\S_(?![\p{L}\p{N}\p{M}_])/yu;
  const strong = /\*\*[^*\n]+\*\*/y;
  const word = /^[\p{L}\p{N}\p{M}_]$/u;
  const opener = /[`[<*_~$]|:codex-file-citation\{|\\\(|file:\/\/\/|https?:\/\/|www\./g;
  const next = (pattern: RegExp, startsAt: (index: number) => boolean = () => true): ((from: number) => number) => {
    let found = -1;
    return (from) => {
      if (found < from) {
        pattern.lastIndex = from;
        for (;;) {
          const index = pattern.exec(source)?.index;
          if (index === undefined) { found = Infinity; break; }
          if (startsAt(index)) { found = index; break; }
          pattern.lastIndex = index + 1;
        }
      }
      return found;
    };
  };
  const afterNonSpace = (index: number): boolean => /\S/.test(source[index - 1] ?? "");
  const lineEnd = next(/\n/g);
  const citationEnd = next(/}/g);
  // `.` stops at these, and a formula is `.+?`
  const mathBreak = next(/[\n\r\u2028\u2029]/g);
  const mathClose = next(/\\\)/g);
  const dollarClose = next(/\$/g);
  const labelEnd = next(/[\]\n]/g);
  const targetEnd = next(/[\s)]/g);
  const titleStart = next(/[^ \t]/g);
  const doubleQuoteEnd = next(/["\n]/g);
  const singleQuoteEnd = next(/['\n]/g);
  const parenthesisEnd = next(/[()\n]/g);
  const emphasisClose = next(/_(?![\p{L}\p{N}\p{M}_])/gu, afterNonSpace);
  const strongClose = next(/__(?![\p{L}\p{N}\p{M}_])/gu, afterNonSpace);
  const closesLink = (target: number): boolean => {
    const end = targetEnd(target);
    if (!(end > target)) return false;
    if (source[end] === ")") return true;
    if (source[end] !== " " && source[end] !== "\t") return false;
    const open = titleStart(end);
    const quote = source[open];
    const close = quote === '"' ? doubleQuoteEnd(open + 1) : quote === "'" ? singleQuoteEnd(open + 1) : quote === "(" ? parenthesisEnd(open + 1) : null;
    return close !== null && source[close] === (quote === "(" ? ")" : quote) && source[close + 1] === ")";
  };
  let from = 0;
  for (;;) {
    opener.lastIndex = from;
    const start = opener.exec(source)?.index;
    if (start === undefined) return;
    from = start + 1;
    let pattern: RegExp | null = marker;
    const char = source[start];
    if (char === ":") {
      if (!(citationEnd(start + 21) < lineEnd(start + 21))) pattern = null;
    } else if (char === "\\") {
      if (!(mathClose(start + 3) < mathBreak(start + 2))) pattern = null;
    } else if (char === "$") {
      if (/[A-Za-z0-9\\$]/.test(source[start - 1] ?? "") || !(dollarClose(start + 2) < mathBreak(start + 1))) pattern = null;
    } else if (char === "[") {
      const label = labelEnd(start + 1);
      if (!(label > start + 1 && source[label] === "]" && source[label + 1] === "(" && closesLink(label + 2))) pattern = null;
    } else if (char === "w") {
      if (/[\w.@/-]/.test(source[start - 1] ?? "")) pattern = null;
    } else if (char === "*") {
      if (source[start - 1] === "*") pattern = strong;
    } else if (char === "_") {
      const end = lineEnd(start + 1);
      if (word.test(charBefore(source, start))) continue;
      if (!(source[start + 1] === "_" && strongClose(start + 3) < end)) pattern = emphasisClose(start + 2) < end ? emphasis : null;
    }
    if (pattern === null) continue;
    pattern.lastIndex = start;
    const match = pattern.exec(source);
    if (match === null) continue;
    if (char === "$" && /^\$\d[\d.,]*\s+\p{L}/u.test(match[0])) continue;
    from = start + match[0].length;
    yield match;
  }
}

function inlineLink(inside: string): { destination: string; title?: string } {
  const space = inside.search(/\s/);
  return space === -1 ? { destination: inside } : { destination: inside.slice(0, space), title: inside.slice(space).trim().slice(1, -1) };
}

export function parseInline(source: string, links = true, depth = 0): InlineNode[] {
  if (depth > MAX_INLINE_DEPTH) return source === "" ? [] : [{ type: "text", value: source }];
  const nodes: InlineNode[] = [];
  let offset = 0;
  for (const match of inlineMarks(source)) {
    const index = match.index ?? 0;
    let token = match[0];
    const image = token.startsWith("[") && index > offset && source[index - 1] === "!";
    const textEnd = image ? index - 1 : index;
    if (textEnd > offset) nodes.push(...plainText(source.slice(offset, textEnd), links));
    if (token.startsWith(":codex-file-citation{")) {
      const citation = links ? codexFileCitation(token) : null;
      nodes.push(citation === null ? { type: "text", value: token }
        : { type: "file", path: citation.path, children: [{ type: "text", value: citation.label }] });
    } else if (token.startsWith("file:///")) {
      token = trimUrl(token);
      const path = fileUriPath(token);
      nodes.push(links && path !== null ? { type: "file", path, children: [{ type: "text", value: token }] } : { type: "text", value: token });
    } else if (token.startsWith("<")) {
      const url = token.slice(1, -1);
      nodes.push(links ? { type: "link", href: url, children: [{ type: "text", value: url }] } : { type: "text", value: token });
    } else if (/^(?:https?:|www\.)/i.test(token)) {
      token = trimUrl(token);
      const href = /^www\./i.test(token) ? `https://${token}` : token;
      nodes.push(links ? { type: "link", href, children: [{ type: "text", value: token }] } : { type: "text", value: token });
    } else if (token.startsWith("`")) {
      nodes.push(links ? linkTaskCode(token.slice(1, -1)) : { type: "code", value: token.slice(1, -1) });
    } else if (token.startsWith("\\(")) {
      nodes.push({ type: "math", value: token.slice(2, -2) });
    } else if (token.startsWith("$")) {
      nodes.push({ type: "math", value: token.slice(1, -1), dollar: true });
    } else if (token.startsWith("[")) {
      const close = token.indexOf("]");
      const label = token.slice(1, close);
      const { destination: target, title } = inlineLink(token.slice(close + 2, -1));
      const href = safeMarkdownHref(target) ?? webLikeHref(target);
      const children = parseInline(label, false, depth);
      const shown: InlineNode = href !== null ? (title ? { type: "link", href, title, children } : { type: "link", href, children })
        : markdownFileNode(target, children) ?? { type: "text", value: label };
      if (image) nodes.push({ type: "image", alt: label, src: target, fallback: [{ type: "text", value: "!" }, shown] });
      else nodes.push(shown);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push({ type: "strong", children: parseInline(token.slice(2, -2), links, depth + 1) });
    } else if (token.startsWith("~~")) {
      nodes.push({ type: "del", children: parseInline(token.slice(2, -2), links, depth + 1) });
    } else {
      nodes.push({ type: "em", children: parseInline(token.slice(1, -1), links, depth + 1) });
    }
    offset = index + token.length;
  }
  if (offset < source.length) nodes.push(...plainText(source.slice(offset), links));
  return nodes;
}

function plainText(value: string, links: boolean): InlineNode[] {
  return links ? linkTaskIds(value) : [{ type: "text", value }];
}

// `s`: the text may hold a line separator (U+2028) that `.` would stop at, and the pattern then
// tries every split of the spaces before it; with it the line is an item, as it reads
const listLine = /^(\s*)([-*]|\d+\.)\s+(.+)$/s;
/**
 * The line under a table's header: two or more cells of dashes (`---`, `:-:`; one dash is enough, as on GitHub), with or without
 * the outer pipes. Read cell by cell: one pattern for the whole line tries every way to share
 * a run of spaces between its parts, and a long blank line takes seconds.
 */
export function isTableSeparator(line: string): boolean {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  const columns = row.split("|");
  return columns.length >= 2 && columns.every((column) => /^:?-+:?$/.test(column.trim()));
}

function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}
function lineAt(lines: string[], index: number): string {
  return lines[index] ?? "";
}
function startsTable(lines: string[], index: number): boolean {
  return lineAt(lines, index).includes("|") && isTableSeparator(lineAt(lines, index + 1));
}
function parseTable(lines: string[], start: number, within = 0): { block: MarkdownBlock; next: number } {
  const header = cells(lineAt(lines, start)).map((cell) => parseInline(cell));
  let index = start + 2;
  const rows: InlineNode[][][] = [];
  const inItem = (line: string): boolean => within === 0 || ((/^\s*/.exec(line)?.[0].length ?? 0) >= within && !listLine.test(line));
  while (index < lines.length && lineAt(lines, index).includes("|") && lineAt(lines, index).trim() !== "" && inItem(lineAt(lines, index))) {
    rows.push(cells(lineAt(lines, index)).map((cell) => parseInline(cell)));
    index += 1;
  }
  return { block: { type: "table", header, rows }, next: index };
}

function startsBlock(lines: string[], index: number, html = false, visualizations = false): boolean {
  const line = lines[index] ?? "";
  return (visualizations && visualizationReference(line) !== null) || (html && startsHtml(line)) || /^\s*(?:\\\[|\$\$)/.test(line) || /^\s{0,3}```/.test(line) || /^#{1,6}\s+/.test(line) || /^\s*>/.test(line) || /^(?:\s*[-*_]){3,}\s*$/.test(line) || listLine.test(line)
    || startsTable(lines, index);
}

/** An item's text, with a GitHub task box (`[x]`, `[X]`, `[ ]`) read off its start. */
function listItem(text: string): ListItem {
  const task = /^\[([ xX])\](?:\s+(.*))?$/.exec(text);
  if (task === null) return { content: parseInline(text) };
  return { content: parseInline(task[2] ?? ""), checked: task[1] !== " " };
}

function parseList(lines: string[], start: number, visualizations = false): { block: ListBlock; next: number } {
  const first = listLine.exec(lineAt(lines, start));
  if (first === null) return { block: { type: "list", ordered: false, items: [] }, next: start + 1 };
  const baseIndent = (first[1] ?? "").length;
  const ordered = /\d/.test(first[2] ?? "");
  const number = ordered ? Number.parseInt(first[2] ?? "1", 10) : 1;
  const block: ListBlock = { type: "list", ordered, ...(ordered && number !== 1 ? { start: number } : {}), items: [] };
  const numbers: number[] = [];
  let index = start;
  while (index < lines.length) {
    if (block.items.length > 0 && !listLine.test(lineAt(lines, index))) {
      let ahead = index;
      while (ahead < lines.length && lineAt(lines, ahead).trim() === "") ahead += 1;
      const line = lineAt(lines, ahead);
      const indent = /^\s*/.exec(line)?.[0].length ?? 0;
      const sibling = listLine.exec(line);
      if (sibling !== null && (sibling[1] ?? "").length === baseIndent && /\d/.test(sibling[2] ?? "") === ordered) { index = ahead; continue; }
      if (sibling !== null && (sibling[1] ?? "").length >= baseIndent + 2) { index = ahead; continue; }
      if (ahead < lines.length && sibling === null && indent >= baseIndent + 2 && startsTable(lines, ahead)) {
        const item = block.items.at(-1)!;
        const table = parseTable(lines, ahead, baseIndent + 2);
        (item.blocks ??= []).push(table.block);
        index = table.next;
        continue;
      }
      const reference = visualizations && ahead < lines.length && sibling === null && indent >= baseIndent + 2 ? visualizationReference(line) : null;
      if (reference !== null) {
        (block.items.at(-1)!.blocks ??= []).push({ type: "visualization", ...reference });
        index = ahead + 1;
        continue;
      }
      if (ahead < lines.length && sibling === null && indent >= baseIndent + 2 && !/^\s*```/.test(line)) {
        const item = block.items.at(-1)!;
        const last = item.blocks?.at(-1);
        if (last === undefined) {
          // added to, not copied: an item of thousands of lines copies itself at every one
          item.content.push({ type: "text", value: " " });
          for (const node of parseInline(line.trim())) item.content.push(node);
        } else {
          if (startsBlock(lines, ahead, false, visualizations)) break;
          if (last.type === "paragraph" && ahead === index) last.lines.push(parseInline(line.trim()));
          else item.blocks!.push({ type: "paragraph", lines: [parseInline(line.trim())] });
        }
        index = ahead + 1;
        continue;
      }
      break;
    }
    const match = listLine.exec(lineAt(lines, index));
    if (match === null || (match[1] ?? "").length < baseIndent) break;
    if ((match[1] ?? "").length >= baseIndent + 2) {
      const parent = block.items.at(-1);
      if (parent === undefined) break;
      const nested = parseList(lines, index, visualizations);
      (parent.blocks ??= []).push(nested.block);
      index = nested.next;
      continue;
    }
    if ((match[1] ?? "").length !== baseIndent || /\d/.test(match[2] ?? "") !== ordered) break;
    block.items.push(listItem(match[3] ?? ""));
    if (ordered) numbers.push(Number.parseInt(match[2] ?? "1", 10));
    index += 1;
  }
  const counts = numbers.every((written, at) => written === number + at);
  const lazy = numbers.length > 1 && numbers[1] === number;
  const drawable = numbers.every((written) => written <= LIST_NUMBER_LIMIT);
  if (!counts && !lazy && drawable) block.items.forEach((item, at) => { item.number = numbers[at]; });
  return { block, next: index };
}

/** KaTeX reads a formula one call per group: nested deeper than this, it is shown as its source. */
const MAX_MATH_DEPTH = 100;

/**
 * Whether a formula's braces nest deeper than anyone writes them. KaTeX takes over a second on
 * thousands of nested fractions before it gives up, with the page waiting on it.
 */
export function mathNestsTooDeep(value: string): boolean {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\") index += 1;
    else if (char === "{") { depth += 1; if (depth > MAX_MATH_DEPTH) return true; }
    else if (char === "}" && depth > 0) depth -= 1;
  }
  return false;
}

function wholeFormula(line: string): boolean {
  const open = /^\s*(\\\[|\$\$)/.exec(line);
  if (open === null) return false;
  const close = line.indexOf(open[1] === "$$" ? "$$" : "\\]", open[0].length);
  return close !== -1 && line.slice(close + 2).trim() === "";
}

export const FOLD_CODE_AFTER_LINES = 30;
export const FOLDED_CODE_LINES = 20;

export function foldCode(value: string): { head: string; lines: number } | null {
  const lines = value.split("\n");
  if (lines.length <= FOLD_CODE_AFTER_LINES) return null;
  return { head: lines.slice(0, FOLDED_CODE_LINES).join("\n"), lines: lines.length };
}

/**
 * Past this many characters an output folds even in few lines: one long line wraps into hundreds on
 * a phone. About 20 wrapped lines on a phone, as the line fold shows.
 */
export const FOLD_OUTPUT_CHARS = 1000;

export function foldToolOutput(output: string): { head: string; lines: number | null } | null {
  const byLines = foldCode(output);
  const head = byLines?.head ?? output;
  if (head.length <= FOLD_OUTPUT_CHARS) return byLines;
  const end = head.lastIndexOf("\n", FOLD_OUTPUT_CHARS);
  let cut = end > FOLD_OUTPUT_CHARS / 2 ? end : FOLD_OUTPUT_CHARS;
  // never between the two halves of a character outside the BMP (an emoji): half of one draws as a replacement glyph
  const last = head.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return { head: head.slice(0, cut), lines: byLines?.lines ?? null };
}

const MAX_QUOTE_DEPTH = 32;

export function parseMarkdown(source: string, depth = 0, html = false, visualizations = false): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  const unclosedMath = { "\\[": 0, "$$": 0 };
  while (index < lines.length) {
    const line = lineAt(lines, index);
    if (line.trim() === "") { index += 1; continue; }

    const visualization = visualizations ? visualizationReference(line) : null;
    if (visualization !== null) {
      blocks.push({ type: "visualization", ...visualization });
      index += 1;
      continue;
    }

    const fence = /^( {0,3})```\s*([^\s`]*)/.exec(line);
    if (fence !== null) {
      const indent = fence[1] ?? "";
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s{0,3}```\s*$/.test(lineAt(lines, index))) {
        const bodyLine = lineAt(lines, index++);
        body.push(bodyLine.startsWith(indent) ? bodyLine.slice(indent.length) : bodyLine.trimStart());
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language: fence[2] ?? "", value: body.join("\n") });
      continue;
    }

    const display = /^\s*(\\\[|\$\$)(.*)$/.exec(line);
    const open = display?.[1] as keyof typeof unclosedMath | undefined;
    if (display !== null && open !== undefined && index >= unclosedMath[open]) {
      const close = open === "$$" ? "$$" : "\\]";
      const body: string[] = [];
      let next = index;
      let part = display[2] ?? "";
      let complete = false;
      while (true) {
        const at = part.indexOf(close);
        if (at !== -1 && next === index && part.slice(at + 2).trim() !== "") break;
        if (at !== -1 && part.slice(at + 2).trim() === "") {
          body.push(part.slice(0, at));
          const value = body.join("\n").trim();
          blocks.push(open === "$$" ? { type: "math", value, dollar: true, ...(next === index ? { oneLine: true as const } : {}) } : { type: "math", value });
          index = next + 1;
          complete = true;
          break;
        }
        body.push(part);
        next += 1;
        if (next >= lines.length || lineAt(lines, next).trim() === "" || /^\s{0,3}```/.test(lineAt(lines, next)) || wholeFormula(lineAt(lines, next))
          || (open === "$$" ? /^\s*\\\[/ : /^\s*\$\$/).test(lineAt(lines, next))) break;
        part = lineAt(lines, next);
      }
      if (complete) continue;
      unclosedMath[open] = next;
    }

    if (html && startsHtml(line)) {
      const read = parseHtmlBlock(lines, index);
      blocks.push(...read.blocks);
      index = read.next;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/s.exec(line);
    if (heading !== null) {
      blocks.push({ type: "heading", level: (heading[1] ?? "#").length as 1 | 2 | 3 | 4 | 5 | 6, content: parseInline(heading[2] ?? "") });
      index += 1;
      continue;
    }

    if (/^(?:\s*[-*_]){3,}\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lineAt(lines, index))) quoted.push(lineAt(lines, index++).replace(/^\s*>\s?/, ""));
      // a line of thousands of ">" (text nobody wrote by hand) would otherwise overflow the stack
      blocks.push({ type: "blockquote", blocks: depth < MAX_QUOTE_DEPTH ? parseMarkdown(quoted.join("\n"), depth + 1, html, visualizations)
        : [{ type: "paragraph", lines: quoted.map((quotedLine) => parseInline(quotedLine)) }] });
      continue;
    }

    if (listLine.test(line)) {
      const parsed = parseList(lines, index, visualizations);
      blocks.push(parsed.block);
      index = parsed.next;
      continue;
    }

    if (startsTable(lines, index)) {
      const table = parseTable(lines, index);
      blocks.push(table.block);
      index = table.next;
      continue;
    }

    const paragraph: InlineNode[][] = [];
    while (index < lines.length && lineAt(lines, index).trim() !== "" && (paragraph.length === 0 || !startsBlock(lines, index, html, visualizations))) {
      paragraph.push(parseInline(lineAt(lines, index)));
      index += 1;
    }
    blocks.push({ type: "paragraph", lines: paragraph });
  }
  return blocks;
}
