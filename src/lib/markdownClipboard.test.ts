import { describe, expect, test } from "bun:test";
import { renderedClipboardPayload, type ClipboardNode } from "./markdownClipboard.ts";

const text = (value: string): ClipboardNode => ({ tag: "", text: value });
const element = (tag: string, content: readonly ClipboardNode[], attrs?: Record<string, string>): ClipboardNode => ({ tag, children: content, attrs });
const html = (nodes: readonly ClipboardNode[]): string => renderedClipboardPayload(nodes, "").html;

describe("renderedClipboardPayload", () => {
  test("rebuilds headings, lists, emphasis and safe links as rich HTML", () => {
    expect(html([
      element("H3", [text("Plan")], { class: "markdown-h1" }),
      element("UL", [
        element("LI", [element("STRONG", [text("First")])]),
        element("LI", [element("A", [text("Docs")], { href: "https://example.com" })]),
      ]),
    ])).toBe('<h3>Plan</h3><ul><li><strong>First</strong></li><li><a href="https://example.com">Docs</a></li></ul>');
  });

  test("retains nested ordered lists and their start number", () => {
    expect(html([element("OL", [
      element("LI", [text("Done"), element("UL", [element("LI", [text("Child")])])]),
    ], { start: "3" })])).toBe('<ol start="3"><li>Done<ul><li>Child</li></ul></li></ol>');
  });

  test("keeps an item's own number, and nothing else an item says", () => {
    expect(html([element("OL", [
      element("LI", [text("one")], { value: "1" }),
      element("LI", [text("four")], { value: "4", onclick: "x" }),
      element("LI", [text("odd")], { value: "4x" }),
    ])])).toBe('<ol><li value="1">one</li><li value="4">four</li><li>odd</li></ol>');
  });

  test("keeps code whitespace and leaves out a code block's label, controls and notes", () => {
    const code = "  one\n\n\n  two  ";
    expect(html([element("P", [text("Run this")]), element("DIV", [
      element("DIV", [element("SPAN", [text("ts")]), element("BUTTON", [text("Copy")], { class: "icon-button markdown-code-copy" })], { class: "markdown-code-header" }),
      element("P", [text("Couldn't copy. Select the text and copy it manually.")], { class: "markdown-code-error", role: "alert" }),
      element("PRE", [element("CODE", [text(code)])]),
      element("P", [text("Too long to highlight")], { class: "hl-note" }),
      element("BUTTON", [text("Show all 40 lines")], { class: "markdown-code-more" }),
    ], { class: "markdown-code" })])).toBe(`<p>Run this</p><pre><code>${code}</code></pre>`);
  });

  test("keeps a selected file button's text and an image's fallback label", () => {
    expect(html([element("P", [
      element("BUTTON", [element("CODE", [text("main.ts")])], { class: "markdown-file" }),
      element("SPAN", [text("diagram")]),
    ])])).toBe("<p><code>main.ts</code>diagram</p>");
  });

  test("exports rich HTML without executable attributes, embedded resources, or unsafe links", () => {
    expect(html([
      element("P", [text('<hello & "world">')], { onclick: "alert(1)", style: "background:url(https://example.com)" }),
      element("SCRIPT", [text("alert(1)")]),
      element("IFRAME", [], { src: "https://example.com" }),
      element("IMG", [], { alt: "picture", src: "https://example.com/p.png", onerror: "alert(1)" }),
      element("A", [text("unsafe")], { href: "javascript:alert(1)" }),
      element("STRONG", [text("safe")]),
      element("SPAN", [text("hidden")], { "aria-hidden": "true" }),
    ])).toBe('<p>&lt;hello &amp; &quot;world&quot;&gt;</p>picture<a>unsafe</a><strong>safe</strong>');
  });

  test("retains quotes and tables as rich HTML", () => {
    expect(html([
      element("BLOCKQUOTE", [element("P", [text("Quote")])]),
      element("TABLE", [
        element("THEAD", [element("TR", [element("TH", [text("Name")])])]),
        element("TBODY", [element("TR", [element("TD", [text("a|b")])])]),
      ]),
    ])).toBe("<blockquote><p>Quote</p></blockquote><table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>a|b</td></tr></tbody></table>");
  });
});
