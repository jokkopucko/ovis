/** Rendered selection -> native plain text and resource-free rich HTML.
 * HTML sanitization adapted from t3code's markdown-clipboard.ts (MIT).
 */
export interface ClipboardNode {
  readonly tag: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly children?: readonly ClipboardNode[];
}

export interface ClipboardPayload {
  readonly text: string;
  readonly html: string | null;
}

const OMIT = new Set(["BUTTON", "INPUT", "SCRIPT", "STYLE", "TEMPLATE", "SVG", "IFRAME", "OBJECT", "EMBED", "LINK", "META"]);
const HTML_TAGS = new Set(["P", "BR", "HR", "PRE", "CODE", "STRONG", "B", "EM", "I", "DEL", "S", "A", "UL", "OL", "LI", "BLOCKQUOTE", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "H1", "H2", "H3", "H4", "H5", "H6"]);
const OMIT_CLASSES = new Set(["markdown-code-header", "markdown-code-error", "hl-note", "chat-turn-meta", "chat-meta", "sr-only"]);
const attr = (node: ClipboardNode, name: string): string | undefined => node.attrs?.[name];
const children = (node: ClipboardNode): readonly ClipboardNode[] => node.children ?? [];
const visible = (node: ClipboardNode): boolean => (!OMIT.has(node.tag) || (node.tag === "BUTTON" && (attr(node, "class") ?? "").split(/\s+/).includes("markdown-file"))) && attr(node, "aria-hidden") !== "true" && !(attr(node, "class") ?? "").split(/\s+/).some((name) => OMIT_CLASSES.has(name));
const escapeHtml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Rebuild, rather than scrub arbitrary HTML: attributes cannot smuggle resources or handlers. */
function richHtml(node: ClipboardNode): string {
  if (!visible(node)) return "";
  if (node.text !== undefined) return escapeHtml(node.text);
  if (node.tag === "IMG") return escapeHtml(attr(node, "alt") ?? "");
  const content = children(node).map(richHtml).join("");
  if (!HTML_TAGS.has(node.tag)) return content;
  const tag = node.tag.toLowerCase();
  let attributes = "";
  const href = attr(node, "href");
  if (node.tag === "A" && href && /^(https?:\/\/|mailto:)/i.test(href)) attributes = ` href="${escapeHtml(href)}"`;
  const start = attr(node, "start");
  if (node.tag === "OL" && start && /^\d+$/.test(start)) attributes = ` start="${start}"`;
  const value = attr(node, "value");
  if (node.tag === "LI" && value && /^\d+$/.test(value)) attributes = ` value="${value}"`;
  return node.tag === "BR" || node.tag === "HR" ? `<${tag}>` : `<${tag}${attributes}>${content}</${tag}>`;
}

export function renderedClipboardPayload(nodes: readonly ClipboardNode[], text: string): ClipboardPayload & { readonly html: string } {
  return { text, html: nodes.map(richHtml).join("") };
}

function fromDom(node: Node): ClipboardNode {
  if (!(node instanceof Element)) return { tag: "", text: node.nodeType === 3 ? node.textContent ?? "" : "", children: [...node.childNodes].map(fromDom) };
  const attrs = Object.fromEntries([...node.attributes].map((entry) => [entry.name, entry.value]));
  return { tag: node.tagName, attrs, children: [...node.childNodes].map(fromDom) };
}

function withRawToolPaths<T>(selection: Selection, scope: ParentNode, read: (grew: boolean) => T): T {
  const grown: { text: Text; head: number }[] = [];
  try {
    for (const label of scope.querySelectorAll<HTMLElement>("[data-raw-path]")) {
      const text = label.firstChild;
      const raw = label.dataset["rawPath"] ?? "";
      if (!(text instanceof Text) || label.childNodes.length !== 1 || text.data === raw || !raw.endsWith(text.data)) continue;
      const whole = [...Array(selection.rangeCount).keys()].some((index) => {
        const range = selection.getRangeAt(index);
        return range.comparePoint(text, 0) === 0 && range.comparePoint(text, text.length) === 0;
      });
      if (!whole || label.getClientRects().length === 0 || getComputedStyle(label).visibility !== "visible") continue;
      const head = raw.slice(0, raw.length - text.data.length);
      text.insertData(0, head);
      grown.push({ text, head: head.length });
    }
    return read(grown.length > 0);
  } finally {
    for (const { text, head } of grown) text.deleteData(0, head);
  }
}

/**
 * Claim ranges wholly in this chat. A selection reaching past it (Select All, a drag out of the
 * chat) is claimed only when it takes a shown, shortened tool-file label whole, so the copy carries
 * the path as written; any other keeps native copy, as composer fields and the terminal do. That
 * claim is the browser's plain text alone: rebuilding HTML from the whole page would carry what
 * the plain text leaves out (a composer's unsent draft, a hidden chat).
 */
export function chatSelectionClipboardPayload(selection: Selection, root: Element): ClipboardPayload | null {
  if (selection.isCollapsed || selection.rangeCount === 0) return null;
  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
      // a selection with no part in this chat is another chat's (which copies it with its HTML),
      // or the page's: whichever chat's listener runs first must not take it over
      if (![...Array(selection.rangeCount).keys()].some((other) => selection.getRangeAt(other).intersectsNode(root))) return null;
      return withRawToolPaths(selection, document, (grew) => grew ? { text: selection.toString(), html: null } : null);
    }
  }
  return withRawToolPaths(selection, root, () => selectionPayload(selection));
}

function selectionPayload(selection: Selection): ClipboardPayload | null {
  const nodes: ClipboardNode[] = [];
  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index);
    const ancestor = range.commonAncestorContainer;
    const element = ancestor instanceof Element ? ancestor : ancestor.parentElement;
    if (element?.closest("input, textarea, [contenteditable=true]")) return null;
    const container = document.createElement("div");
    container.append(range.cloneContents());
    // cloneContents drops the common ancestor and all its formatting.
    let wrapped: Node = container;
    if (element?.closest(".markdown")) {
      for (let current: Element | null = element; current && !current.classList.contains("markdown"); current = current.parentElement) {
        const wrapper = current.cloneNode(false);
        while (wrapped.firstChild) wrapper.appendChild(wrapped.firstChild);
        const parent = document.createElement("div");
        parent.appendChild(wrapper);
        wrapped = parent;
      }
    }
    nodes.push(...[...wrapped.childNodes].map(fromDom));
  }
  const text = selection.toString();
  // An image-only range can have no plain text; still intercept it so native copy cannot
  // bypass the resource-free HTML representation.
  return renderedClipboardPayload(nodes, text);
}
