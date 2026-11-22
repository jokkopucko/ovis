import { describe, expect, it } from "bun:test";

import type { InlineNode, MarkdownBlock } from "../../shared/markdown.ts";
import { knownPreview, parsePreviewOffThread } from "./markdownPreview.ts";

type Link = Extract<InlineNode, { type: "link" }>;

function linksIn(blocks: readonly MarkdownBlock[]): Link[] {
  const found: Link[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (value === null || typeof value !== "object") return;
    if ((value as { type?: unknown }).type === "link") found.push(value as Link);
    for (const child of Object.values(value)) visit(child);
  };
  visit(blocks);
  return found;
}

async function previewLinks(text: string): Promise<{ text: string; href: string; title?: string }[]> {
  const blocks = await parsePreviewOffThread(text).promise;
  expect(blocks).not.toBeNull();
  return linksIn(blocks!).map((link) => ({
    text: link.children.map((child) => (child.type === "text" ? child.value : "")).join(""),
    href: link.href,
    ...(link.title === undefined ? {} : { title: link.title }),
  }));
}

describe("parsePreviewOffThread", () => {
  it("parses in a real worker and remembers the file", async () => {
    const text = "# Plan\n\n- [x] done\n- [ ] open\n";
    const blocks = await parsePreviewOffThread(text).promise;
    expect(blocks?.[0]).toMatchObject({ type: "heading", level: 1 });
    expect(blocks?.[1]).toMatchObject({ type: "list" });
    expect(knownPreview(text)).toBe(blocks!);
    expect(knownPreview("# another file")).toBeUndefined();
  });

  it("draws titled and reference-style links as links (#3987)", async () => {
    const links = await previewLinks([
      'This is a [link with title](https://www.google.com "Click to go to google").',
      "This is a [reference link][1].",
      "This is another [reference link][link-name].",
      "",
      "[1]: https://www.google.com",
      '[link-name]: https://www.google.com "Google!"',
    ].join("\n"));
    expect(links.filter((link) => link.text !== link.href)).toEqual([
      { text: "link with title", href: "https://www.google.com", title: "Click to go to google" },
      { text: "reference link", href: "https://www.google.com" },
      { text: "reference link", href: "https://www.google.com", title: "Google!" },
    ]);
  });

  it("links a label only to its own definition, never a look-alike's", async () => {
    const links = await previewLinks("[docs]\n\n[d\u043Ecs]: https://evil.example\n[docs]: https://good.example");
    expect(links.filter((link) => link.text === "docs")).toEqual([{ text: "docs", href: "https://good.example" }]);
  });

  it("never links a reference to a host its definition line does not show", async () => {
    const links = await previewLinks("[r]\n\n[x]: no target here\n[r]: <https://a.dev>@b.dev");
    expect(links.filter((link) => new URL(link.href).host === "b.dev")).toEqual([]);
  });

  it("never sends a label defined twice to its second address", async () => {
    const links = await previewLinks("[docs]\n\n[docs]: https://good.example\n[docs]: https://other.example");
    expect(links.filter((link) => link.text === "docs" && link.href !== "https://good.example")).toEqual([]);
  });

  it("links no reference whose address is not a web or mail address", async () => {
    const links = await previewLinks("[r] and [s]\n\n[r]: javascript:alert(1)\n[s]: data:text/html,x");
    expect(links).toEqual([]);
  });

  it("previews a 40,000-character line of unclosed brackets beside a definition", async () => {
    const links = await previewLinks(`${"[".repeat(40_000)}x\n\n[r]: https://a.dev\n\n[r]`);
    expect(links.filter((link) => link.text === "r")).toEqual([{ text: "r", href: "https://a.dev" }]);
  });

  // each input is read in a fraction of the Preview's budget; a reading that grows with its square
  // takes minutes and the worker gives up, so the file would open as its source
  it.each([
    ["a 150 KB line of unclosed brackets", `${"a [".repeat(50_000)}x\n\n[r]: https://a.dev`],
    ["one definition repeated 20,000 times", `${"[r]: https://a.dev\n".repeat(20_000)}\n[r]`],
    ["10,000 references to one definition", `[r]: https://a.dev\n\n${"[x][r] ".repeat(10_000)}`],
    ["5,000 nested HTML tags around a reference", `${"<b>".repeat(5_000)}prose${"</b>".repeat(5_000)}\n\n[r]: https://a.dev\n\n[r]`],
    ["quotes and lists nested 20,000 deep", `${"> ".repeat(20_000)}x\n\n${"- ".repeat(20_000)}[r]\n\n[r]: https://a.dev`],
    ["20,000 nested emphasis marks", `${"*_".repeat(20_000)}[r]${"_*".repeat(20_000)}\n\n[r]: https://a.dev`],
    ["a 100,000-character label", `[${"a".repeat(100_000)}]: https://a.dev\n\n[${"a".repeat(100_000)}]`],
    ["a line of 300,000 formula openers closed on the next line", `${"\\(".repeat(300_000)}\n\\)`],
    ["10,000 formula openers that never close", "$$ x\n".repeat(10_000)],
    ["25,000 bare `www.` in a row", "www.".repeat(25_000)],
    ["a bare address of 50,000 open parentheses", `https://a.dev/${"(".repeat(50_000)}`],
  ])("previews %s", async (_, text) => {
    expect(await parsePreviewOffThread(text).promise).not.toBeNull();
  });

});
