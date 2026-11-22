import MarkdownIt, { type StateBlock, type StateInline, type Token } from "markdown-it";

import { type InlineNode, LIST_NUMBER_LIMIT, type ListBlock, type ListItem, type MarkdownBlock, markdownFileNode, safeMarkdownHref, trimUrl, webLikeHref } from "../../shared/markdown.ts";
import { parseHtmlBlock, startsHtml } from "../../shared/markdownHtml.ts";

/**
 * A file's Preview read the CommonMark way by markdown-it, so reference links (`[text][label]` with
 * `[label]: address "title"`) resolve while the library reads the document's structure, and their
 * definition lines are left out as CommonMark and GitHub leave them out. Chat keeps
 * shared/markdown.ts. The library only reads: every address it finds, inline or by reference,
 * goes through the same rules as the chat's links (web and mail addresses link, a path opens the
 * file, anything else stays text), and HTML blocks go through the same reader the chat's Preview
 * used (never markup on the page).
 */

type Env = { unclosedMath: Record<string, number>; found: { src: string; close: number; lineBreak: number } | null };

const md = new MarkdownIt("default", { html: true, linkify: true, typographer: false });
// bare `https://`, `www.` and `file:///` addresses link, as in chat; a bare domain or e-mail
// address stays text (`linkNode` gets only those three kinds from `autoLinkAddress`)
md.linkify.set({ fuzzyEmail: false, fuzzyIP: false });
const fileTail = /\/\/\/[!#-;=?-_a-~]+/y;
md.linkify.add("file:", { validate: (text: string, pos: number) => {
  fileTail.lastIndex = pos;
  const tail = fileTail.exec(text)?.[0];
  return tail === undefined ? 0 : trimUrl(tail).length;
} });
// every address stays as written for `linkNode`, the one place that decides what may link (the
// library's own check is a deny-list, and its encoding would change a file path)
md.validateLink = () => true;
md.normalizeLink = (url) => url;
md.normalizeLinkText = (url) => url;
md.block.ruler.before("table", "too_deep", tooDeep);
md.block.ruler.before("fence", "math_block", mathBlock, { alt: ["paragraph", "reference", "blockquote", "list"] });
md.block.ruler.before("html_block", "html_reader", htmlBlock, { alt: ["paragraph", "reference", "blockquote"] });
md.inline.ruler.before("escape", "math_inline", mathInline);

export function parsePreviewMarkdown(source: string): MarkdownBlock[] {
  const env: Env = { unclosedMath: {}, found: null };
  return readBlocks(md.parse(source, env), { at: 0 }, null);
}

/**
 * Containers nested this deep keep the rest of their lines as written text: past its own limit
 * markdown-it drops what is left of the file. markdown-it counts a quote as one level and a list
 * item as two, so this is 33 quotes (the chat's 32 inside one) or about 17 lists.
 */
const MAX_LEVEL = 33;

function tooDeep(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.level < MAX_LEVEL) return false;
  if (silent) return true;
  let next = startLine;
  const lines: string[] = [];
  while (next < endLine && !state.isEmpty(next) && (next === startLine || state.sCount[next]! >= state.blkIndent)) lines.push(lineText(state, next++));
  const token = state.push("too_deep", "", 0);
  token.content = lines.join("\n");
  token.map = [startLine, next];
  state.line = next;
  return true;
}

function lineText(state: StateBlock, line: number): string {
  return state.src.slice(state.bMarks[line]! + state.tShift[line]!, state.eMarks[line]);
}

/**
 * The HTML blocks shared/markdownHtml.ts reads, where it says they start and end (a README's
 * `<p align="center"><img ...></p>` or `<a ...><img ...></a>` line, a comment up to its `-->`),
 * before CommonMark's own HTML blocks, which would leave a line of badges as raw markup. What only
 * CommonMark takes for HTML (a `<pre>` up to its `</pre>`) stays its written text.
 */
function htmlBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  const first = lineText(state, startLine);
  if (!startsHtml(first)) return false;
  if (silent) return true;
  let next = startLine;
  if (first.startsWith("<!--")) {
    while (next < endLine && state.sCount[next]! >= state.blkIndent && !lineText(state, next++).includes("-->"));
  } else {
    while (next < endLine && state.sCount[next]! >= state.blkIndent && !state.isEmpty(next)) next += 1;
  }
  const token = state.push("html_reader", "", 0);
  token.content = state.getLines(startLine, next, state.blkIndent, false);
  token.map = [startLine, next];
  state.line = next;
  return true;
}

function wholeFormula(line: string): boolean {
  const open = /^\s*(\\\[|\$\$)/.exec(line);
  if (open === null) return false;
  const close = line.indexOf(open[1] === "$$" ? "$$" : "\\]", open[0].length);
  return close !== -1 && line.slice(close + 2).trim() === "";
}

function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  const first = lineText(state, startLine);
  const open = first.startsWith("$$") ? "$$" : first.startsWith("\\[") ? "\\[" : null;
  if (open === null) return false;
  const env = state.env as Env;
  // an opener that found no close is not tried again before the line its search stopped at, or
  // a file of openers would be read once per opener
  if (startLine < (env.unclosedMath[open] ?? 0)) return false;
  const close = open === "$$" ? "$$" : "\\]";
  const other = open === "$$" ? /^\s*\\\[/ : /^\s*\$\$/;
  const body: string[] = [];
  let next = startLine;
  let part = first.slice(2);
  for (;;) {
    const at = part.indexOf(close);
    if (at !== -1 && next === startLine && part.slice(at + 2).trim() !== "") return false;
    if (at !== -1 && part.slice(at + 2).trim() === "") {
      body.push(part.slice(0, at));
      break;
    }
    body.push(part);
    next += 1;
    const line = next < endLine ? lineText(state, next) : "";
    if (next >= endLine || state.isEmpty(next) || state.sCount[next]! < state.blkIndent || /^\s{0,3}```/.test(line) || wholeFormula(line) || other.test(line)) {
      env.unclosedMath[open] = next;
      return false;
    }
    part = line;
  }
  if (silent) return true;
  const token = state.push("math_block", "math", 0);
  token.content = body.join("\n").trim();
  token.markup = open;
  token.meta = { oneLine: next === startLine };
  token.map = [startLine, next + 1];
  state.line = next + 1;
  return true;
}

/** `$…$` and `\(…\)` inside a line, by the chat's rules (no `$5 and $6`, no `a$b$`). */
function mathInline(state: StateInline, silent: boolean): boolean {
  const { src, pos } = state;
  let value: string;
  let length: number;
  let dollar = false;
  if (src[pos] === "\\" && src[pos + 1] === "(") {
    const env = state.env as Env;
    // the next `\)` and line break are found once per text and moved past only when passed: a
    // line of `\(` is read once, not once per `\(`
    if (env.found === null || env.found.src !== src) env.found = { src, close: -1, lineBreak: -1 };
    const found = env.found;
    if (found.close < pos + 3) found.close = nextIndex(src, /\\\)/g, pos + 3);
    if (found.lineBreak < pos + 2) found.lineBreak = nextIndex(src, /[\n\r\u2028\u2029]/g, pos + 2);
    const end = found.close;
    if (end + 2 > state.posMax || found.lineBreak < end) return false;
    value = src.slice(pos + 2, end);
    length = end + 2 - pos;
  } else if (src[pos] === "$") {
    if (/[A-Za-z0-9\\$]/.test(src[pos - 1] ?? "")) return false;
    const pattern = /\$(?:[^\s$\\`]|[^\s$`][^\n\r\u2028\u2029$`]*[^\s$\\`])\$(?![A-Za-z0-9_${#@*(`])/y;
    pattern.lastIndex = pos;
    const match = pattern.exec(src);
    if (match === null || pos + match[0].length > state.posMax || /^\$\d[\d.,]*\s+\p{L}/u.test(match[0])) return false;
    value = match[0].slice(1, -1);
    length = match[0].length;
    dollar = true;
  } else {
    return false;
  }
  // skipped over only while a link's words are looked for: a formula there ends with them, as in
  // chat, so `[\( x](a.md) \(y\)` is a link and a formula, not one formula
  if (silent && value.includes("]")) return false;
  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.content = value;
    token.meta = { dollar };
  }
  state.pos += length;
  return true;
}

function nextIndex(src: string, pattern: RegExp, from: number): number {
  pattern.lastIndex = from;
  return pattern.exec(src)?.index ?? Infinity;
}

function readBlocks(tokens: Token[], cursor: { at: number }, closing: string | null): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  while (cursor.at < tokens.length) {
    const token = tokens[cursor.at++]!;
    if (token.type === closing) break;
    switch (token.type) {
      case "heading_open": {
        const content = joinLines(inlineLines(tokens[cursor.at++]!.children ?? []));
        cursor.at += 1;
        blocks.push({ type: "heading", level: Number(token.tag.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6, content });
        break;
      }
      case "paragraph_open": {
        const lines = inlineLines(tokens[cursor.at++]!.children ?? []);
        cursor.at += 1;
        blocks.push({ type: "paragraph", lines });
        break;
      }
      case "blockquote_open":
        blocks.push({ type: "blockquote", blocks: readBlocks(tokens, cursor, "blockquote_close") });
        break;
      case "bullet_list_open": case "ordered_list_open":
        blocks.push(readList(tokens, cursor, token));
        break;
      case "table_open":
        blocks.push(readTable(tokens, cursor));
        break;
      case "fence":
        blocks.push({ type: "code", language: /^[^\s`]*/.exec(token.info.trim())?.[0] ?? "", value: token.content.replace(/\n$/, "") });
        break;
      case "code_block":
        blocks.push({ type: "code", language: "", value: token.content.replace(/\n$/, "") });
        break;
      case "math_block":
        blocks.push(token.markup === "$$"
          ? { type: "math", value: token.content, dollar: true, ...((token.meta as { oneLine: boolean }).oneLine ? { oneLine: true as const } : {}) }
          : { type: "math", value: token.content });
        break;
      case "hr":
        blocks.push({ type: "hr" });
        break;
      case "html_reader":
        blocks.push(...parseHtmlBlock([token.content.replace(/\n+$/, "").trimStart()], 0).blocks);
        break;
      case "html_block": case "too_deep":
        blocks.push({ type: "paragraph", lines: token.content.replace(/\n+$/, "").split("\n").map((line) => [{ type: "text", value: line }]) });
        break;
    }
  }
  return blocks;
}

function readList(tokens: Token[], cursor: { at: number }, open: Token): ListBlock {
  const ordered = open.type === "ordered_list_open";
  const start = ordered ? Number(open.attrGet("start") ?? 1) : 1;
  const block: ListBlock = { type: "list", ordered, ...(ordered && start !== 1 ? { start } : {}), items: [] };
  const numbers: number[] = [];
  while (tokens[cursor.at]?.type === "list_item_open") {
    const item = tokens[cursor.at++]!;
    if (ordered) numbers.push(Number(item.info));
    const inner = readBlocks(tokens, cursor, "list_item_close");
    const first = inner[0];
    const content = first?.type === "paragraph" ? joinLines(first.lines) : [];
    const rest = first?.type === "paragraph" ? inner.slice(1) : inner;
    block.items.push({ ...taskItem(content), ...(rest.length > 0 ? { blocks: rest } : {}) });
  }
  cursor.at += 1;
  const counts = numbers.every((written, at) => written === start + at);
  const lazy = numbers.length > 1 && numbers[1] === start;
  const drawable = numbers.every((written) => written <= LIST_NUMBER_LIMIT);
  if (!counts && !lazy && drawable) block.items.forEach((item, at) => { item.number = numbers[at]; });
  return block;
}

function taskItem(content: InlineNode[]): ListItem {
  const head = content[0];
  const task = head?.type === "text" ? /^\[([ xX])\](\s+|$)/.exec(head.value) : null;
  if (head?.type !== "text" || task === null || (task[2] === "" && content.length > 1)) return { content };
  const value = head.value.slice(task[0].length);
  return { content: value === "" ? content.slice(1) : [{ type: "text", value }, ...content.slice(1)], checked: task[1] !== " " };
}

function readTable(tokens: Token[], cursor: { at: number }): MarkdownBlock {
  const header: InlineNode[][] = [];
  const rows: InlineNode[][][] = [];
  let row: InlineNode[][] | null = null;
  let head = false;
  while (cursor.at < tokens.length) {
    const token = tokens[cursor.at++]!;
    if (token.type === "table_close") break;
    if (token.type === "thead_open") head = true;
    else if (token.type === "thead_close") head = false;
    else if (token.type === "tr_open") row = head ? header : [];
    else if (token.type === "tr_close" && row !== null && !head) rows.push(row);
    else if (token.type === "inline" && row !== null) row.push(joinLines(inlineLines(token.children ?? [])));
  }
  return { type: "table", header, rows };
}

function joinLines(lines: InlineNode[][]): InlineNode[] {
  return lines.flatMap((line, at) => (at === 0 ? line : [{ type: "text", value: " " } as InlineNode, ...line]));
}

type Holder =
  | { kind: "strong" | "em" | "del"; children: InlineNode[] }
  | { kind: "link"; href: string; title: string | null; auto: boolean; children: InlineNode[] };

const HOLDERS: Record<string, "strong" | "em" | "del"> = { strong_open: "strong", em_open: "em", s_open: "del" };

function inlineLines(tokens: Token[]): InlineNode[][] {
  const lines: InlineNode[][] = [[]];
  const holders: Holder[] = [];
  const push = (...nodes: InlineNode[]): void => {
    const into = holders.at(-1)?.children ?? lines.at(-1)!;
    for (const node of nodes) {
      if (node.type === "text" && node.value === "") continue;
      const last = into.at(-1);
      if (node.type === "text" && last?.type === "text") into[into.length - 1] = { type: "text", value: last.value + node.value };
      else into.push(node);
    }
  };
  const close = (): void => {
    const holder = holders.pop()!;
    if (holder.children.length === 0) return;
    if (holder.kind !== "link") push({ type: holder.kind, children: holder.children });
    else if (!holder.auto) push(...linkNode(holder.href, holder.title, holder.children));
    else {
      const address = autoLinkAddress(holder.children);
      push(...(address === null ? holder.children : linkNode(address, null, holder.children)));
    }
  };
  for (const token of tokens) {
    switch (token.type) {
      case "softbreak": case "hardbreak": {
        // a line break inside emphasis or a link keeps its line: both halves keep the marks
        const reopened = holders.map((holder) => ({ ...holder, children: [] }));
        while (holders.length > 0) close();
        lines.push([]);
        holders.push(...reopened);
        break;
      }
      case "code_inline":
        push({ type: "code", value: token.content });
        break;
      case "math_inline":
        push((token.meta as { dollar: boolean }).dollar ? { type: "math", value: token.content, dollar: true } : { type: "math", value: token.content });
        break;
      case "strong_open": case "em_open": case "s_open":
        holders.push({ kind: HOLDERS[token.type]!, children: [] });
        break;
      case "link_open":
        holders.push({ kind: "link", href: token.attrGet("href") ?? "", title: token.attrGet("title"), auto: token.markup === "linkify", children: [] });
        break;
      case "strong_close": case "em_close": case "s_close": case "link_close":
        if (holders.length > 0) close();
        break;
      case "image": {
        const src = token.attrGet("src") ?? "";
        const label = joinLines(inlineLines(token.children ?? []));
        // inside a link, a picture that fails to load shows its words in that link, never a link of its own
        const fallback = holders.some((holder) => holder.kind === "link") ? label : linkNode(src, token.attrGet("title"), label);
        push({ type: "image", alt: token.content, src, fallback: [{ type: "text", value: "!" }, ...fallback] });
        break;
      }
      default:
        push({ type: "text", value: token.content });
    }
  }
  return lines;
}

function linkNode(address: string, title: string | null, children: InlineNode[]): InlineNode[] {
  const href = safeMarkdownHref(address) ?? webLikeHref(address);
  if (href !== null) return [title ? { type: "link", href, title, children } : { type: "link", href, children }];
  const file = markdownFileNode(address, children);
  return file === null ? children : [file];
}

/** A bare address read by linkify, by what it shows: the chat links `https://`, `www.` and `file:///` ones. */
function autoLinkAddress(children: InlineNode[]): string | null {
  const shown = children.length === 1 && children[0]!.type === "text" ? children[0]!.value : null;
  if (shown === null) return null;
  if (/^www\./i.test(shown)) return webLikeHref(shown);
  return /^(?:https?:\/\/|file:\/\/\/)/i.test(shown) ? shown : null;
}
