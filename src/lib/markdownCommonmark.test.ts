import { describe, expect, it } from "bun:test";

import { parsePreviewMarkdown } from "./markdownCommonmark.ts";

describe("parsePreviewMarkdown", () => {
  it("resolves full, collapsed and shortcut references, case-folded, and leaves definitions out", () => {
    expect(parsePreviewMarkdown("[a][Docs], [Docs][] and [docs].\n\n[DOCS]: https://d.dev 'Docs'")).toEqual([
      { type: "paragraph", lines: [[
        { type: "link", href: "https://d.dev", title: "Docs", children: [{ type: "text", value: "a" }] },
        { type: "text", value: ", " },
        { type: "link", href: "https://d.dev", title: "Docs", children: [{ type: "text", value: "Docs" }] },
        { type: "text", value: " and " },
        { type: "link", href: "https://d.dev", title: "Docs", children: [{ type: "text", value: "docs" }] },
        { type: "text", value: "." },
      ]] },
    ]);
  });

  it("sends a reference to a path to the file, as an inline link to it", () => {
    expect(parsePreviewMarkdown("[plan][p]\n\n[p]: docs/plan.md")).toEqual(parsePreviewMarkdown("[plan](docs/plan.md)"));
    expect(parsePreviewMarkdown("[plan](docs/plan.md)")[0]).toMatchObject({ lines: [[{ type: "file", path: "docs/plan.md" }]] });
  });

  it("keeps a definition that is not one as its text", () => {
    expect(parsePreviewMarkdown("[r]\n\n[r]: <https://a.dev>@b.dev")).toEqual([
      { type: "paragraph", lines: [[{ type: "text", value: "[r]" }]] },
      { type: "paragraph", lines: [[{ type: "text", value: "[r]: " }, { type: "link", href: "https://a.dev", children: [{ type: "text", value: "https://a.dev" }] }, { type: "text", value: "@b.dev" }]] },
    ]);
  });

  it("takes the first of a label defined twice, as CommonMark does", () => {
    expect(parsePreviewMarkdown("[docs]\n\n[docs]: https://good.example\n[docs]: https://other.example")).toEqual([
      { type: "paragraph", lines: [[{ type: "link", href: "https://good.example", children: [{ type: "text", value: "docs" }] }]] },
    ]);
  });

  it("reads no definition inside a comment, a table cell or a heading", () => {
    const blocks = parsePreviewMarkdown([
      "<!--", "", "[docs]: https://wrong.example", "", "-->", "",
      "| [r]: https://wrong.example | x |", "|---|---|", "",
      "# [h]: https://wrong.example", "",
      "[docs] [r] [h]",
    ].join("\n"));
    expect(JSON.stringify(blocks)).not.toContain("\"href\":\"https://wrong.example\",\"children\":[{\"type\":\"text\",\"value\":\"docs\"");
    expect(blocks.at(-1)).toEqual({ type: "paragraph", lines: [[{ type: "text", value: "[docs] [r] [h]" }]] });
  });

  it("draws a reference to an address that cannot link as its words", () => {
    expect(parsePreviewMarkdown("[run] [data]\n\n[run]: javascript:alert(1)\n[data]: data:text/html,x")).toEqual([
      { type: "paragraph", lines: [[{ type: "text", value: "run data" }]] },
    ]);
  });

  it("reads HTML blocks with the chat's HTML reader and leaves inline tags as text", () => {
    expect(parsePreviewMarkdown('<p align="center"><a href="https://a.dev"><img src="logo.png" alt="Logo"></a></p>\n\nan <b>inline</b> tag')).toEqual([
      { type: "paragraph", align: "center", lines: [[{ type: "link", href: "https://a.dev", children: [{ type: "image", alt: "Logo", src: "logo.png", fallback: [{ type: "text", value: "Logo" }] }] }]] },
      { type: "paragraph", lines: [[{ type: "text", value: "an <b>inline</b> tag" }]] },
    ]);
  });

  it("ends an HTML line in a list item with the item", () => {
    expect(parsePreviewMarkdown("- a\n- <b>x</b>\n- c")).toEqual([
      { type: "list", ordered: false, items: [
        { content: [{ type: "text", value: "a" }] },
        { content: [{ type: "strong", children: [{ type: "text", value: "x" }] }] },
        { content: [{ type: "text", value: "c" }] },
      ] },
    ]);
  });

  it("links a bare web or file address whole, and no bare domain or mail address", () => {
    expect(parsePreviewMarkdown("https://a.dev/a*b*c, www.ovis.sh/a_b_c_, file:///tmp/a_b.md, ovis.sh, me@ovis.sh")).toEqual([
      { type: "paragraph", lines: [[
        { type: "link", href: "https://a.dev/a*b*c", children: [{ type: "text", value: "https://a.dev/a*b*c" }] },
        { type: "text", value: ", " },
        { type: "link", href: "https://www.ovis.sh/a_b_c_", children: [{ type: "text", value: "www.ovis.sh/a_b_c_" }] },
        { type: "text", value: ", " },
        { type: "file", path: "/tmp/a_b.md", children: [{ type: "text", value: "file:///tmp/a_b.md" }] },
        { type: "text", value: ", ovis.sh, me@ovis.sh" },
      ]] },
    ]);
  });

  it("keeps what only CommonMark takes for HTML as its written text, reading no definition in it", () => {
    expect(parsePreviewMarkdown("<pre>\n\n[docs]: a.md\n\n</pre>\n\n[docs]")).toEqual([
      { type: "paragraph", lines: ["<pre>", "", "[docs]: a.md", "", "</pre>"].map((value) => [{ type: "text", value }]) },
      { type: "paragraph", lines: [[{ type: "text", value: "[docs]" }]] },
    ]);
  });

  it("draws a linked picture's fallback inside its link, never as a second link", () => {
    expect(parsePreviewMarkdown("[![Badge][b]][d]\n\n[b]: https://a.dev/b.svg\n[d]: https://a.dev/docs")).toEqual([
      { type: "paragraph", lines: [[{ type: "link", href: "https://a.dev/docs", children: [
        { type: "image", alt: "Badge", src: "https://a.dev/b.svg", fallback: [{ type: "text", value: "!" }, { type: "text", value: "Badge" }] },
      ] }]] },
    ]);
  });

  it("keeps a line break inside emphasis or a link", () => {
    expect(parsePreviewMarkdown("**one  \ntwo** [a\nb](https://a.dev)")).toEqual([
      { type: "paragraph", lines: [
        [{ type: "strong", children: [{ type: "text", value: "one" }] }],
        [{ type: "strong", children: [{ type: "text", value: "two" }] }, { type: "text", value: " " }, { type: "link", href: "https://a.dev", children: [{ type: "text", value: "a" }] }],
        [{ type: "link", href: "https://a.dev", children: [{ type: "text", value: "b" }] }],
      ] },
    ]);
  });

  it("ends a formula at a link's words, and reads no task box without a space after it", () => {
    expect(parsePreviewMarkdown("[\\(a](x.md) \\(b\\)\n\n- [x]**axis**")).toEqual([
      { type: "paragraph", lines: [[{ type: "file", path: "x.md", children: [{ type: "text", value: "(a" }] }, { type: "text", value: " " }, { type: "math", value: "b" }]] },
      { type: "list", ordered: false, items: [{ content: [{ type: "text", value: "[x]" }, { type: "strong", children: [{ type: "text", value: "axis" }] }] }] },
    ]);
  });

  it.each([
    ["quotes", `${"> ".repeat(200)}deepest\nand on`],
    ["lists", `${"- ".repeat(200)}deepest\nand on`],
    ["quotes in lists", `${"- > ".repeat(100)}deepest\nand on`],
  ])("keeps the words of %s nested past its limit", (_, text) => {
    const drawn = JSON.stringify(parsePreviewMarkdown(text));
    expect(drawn).toContain("deepest");
    expect(drawn).toContain("and on");
  });

  it("reads formulas as the chat does", () => {
    expect(parsePreviewMarkdown("$$\nx^2\n$$\n\n\\[y\\]\n\nIt costs $5 and $6, $a$ and \\(b\\).")).toEqual([
      { type: "math", value: "x^2", dollar: true },
      { type: "math", value: "y" },
      { type: "paragraph", lines: [[
        { type: "text", value: "It costs $5 and $6, " },
        { type: "math", value: "a", dollar: true },
        { type: "text", value: " and " },
        { type: "math", value: "b" },
        { type: "text", value: "." },
      ]] },
    ]);
  });

  it("reads task boxes, list numbers and bare web addresses", () => {
    expect(parsePreviewMarkdown("3. [x] done\n1. see www.ovis.sh.")).toEqual([
      { type: "list", ordered: true, start: 3, items: [
        { content: [{ type: "text", value: "done" }], checked: true, number: 3 },
        { content: [{ type: "text", value: "see " }, { type: "link", href: "https://www.ovis.sh", children: [{ type: "text", value: "www.ovis.sh" }] }, { type: "text", value: "." }], number: 1 },
      ] },
    ]);
  });
});
