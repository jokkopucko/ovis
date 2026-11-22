import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadKatex, ParsedMarkdown } from "../components/Markdown.tsx";
import { OpenFileContext } from "./filePaths.ts";
import { SettingsProvider } from "./settings.ts";
import { parseMarkdown } from "../../shared/markdown.ts";
import { TEXT_PREVIEW_BYTES } from "./filePreviewText.ts";
import { hasPreview, PREVIEW_CHUNK_ELEMENTS, PREVIEW_ELEMENT_LIMIT, previewChunks, previewElements } from "./textPreview.ts";

describe("hasPreview", () => {
  it("gives only Markdown a Preview", () => {
    expect(hasPreview("markdown")).toBe(true);
    expect(hasPreview("typescript")).toBe(false);
    expect(hasPreview(null)).toBe(false);
  });
});

describe("previewChunks", () => {
  it("splits a long Preview into whole blocks under the chunk size, in order and complete", () => {
    const blocks = parseMarkdown("# Notes\n\nA paragraph of ordinary notes, with *emphasis* and a [link](./notes.txt).\n\n".repeat(4_000), 0, true);
    const chunks = previewChunks(blocks);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.flat()).toEqual(blocks);
    for (const chunk of chunks) expect(previewElements(chunk) - 1).toBeLessThanOrEqual(PREVIEW_CHUNK_ELEMENTS);
  });

  it("keeps a short Preview, an empty one and an oversized block each whole", () => {
    const short = parseMarkdown("# Title\n\nsome text", 0, true);
    expect(previewChunks(short)).toEqual([short]);
    expect(previewChunks([])).toEqual([]);
    const big = parseMarkdown("- a\n".repeat(3_000), 0, true);
    expect(previewChunks([...big, ...short])).toEqual([big, short]);
  });
});

describe("previewElements", () => {
  // what the Preview draws, counted on its markup: the estimate the worker refuses a file by must
  // never be below it, or a file under the limit could still hold the page
  const drawn = (source: string): { estimate: number; actual: number } => {
    const blocks = parseMarkdown(source, 0, true);
    const html = renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(OpenFileContext.Provider, {
      value: () => {}, children: createElement(ParsedMarkdown, { blocks }),
    }) }));
    return { estimate: previewElements(blocks), actual: (html.match(/<[A-Za-z][^>]*>/g) ?? []).length };
  };

  it("never counts fewer elements than the Preview draws", async () => {
    await loadKatex();
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    try {
      for (const source of [
        "# Title", "one **two**\nthree", "- a\n- b\n  - c", "> - a",
        "- [x] done\n".repeat(300), "- [ ] open\n".repeat(300), "- a\n".repeat(300),
        "a/a.c ".repeat(500), "`src/a.ts` and `x` ".repeat(200), "\\(x_i + y\\) ".repeat(100),
        "\\[" + "a+".repeat(300) + "a\\]",
        "| a | b |\n| --- | --- |\n" + "| c/d | `e` |\n".repeat(100),
        "A paragraph with *em*, **strong**, [link](https://x.y/z) and ./docs/a.md.\n".repeat(100),
        '<p align="center"><img src="a.png" width="80"></p>\n\n' + "![alt](b/c.png) text\n\n".repeat(50),
      ]) {
        const { estimate, actual } = drawn(source);
        expect({ source: source.slice(0, 40), short: estimate < actual }).toEqual({ source: source.slice(0, 40), short: false });
      }
    } finally {
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  });

  it("puts a file of the load limit's short list items past what a Preview draws", () => {
    expect(previewElements(parseMarkdown("- a\n".repeat(TEXT_PREVIEW_BYTES / 4)))).toBeGreaterThan(PREVIEW_ELEMENT_LIMIT);
    const changelog = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8").slice(0, TEXT_PREVIEW_BYTES);
    expect(previewElements(parseMarkdown(changelog, 0, true))).toBeLessThan(PREVIEW_ELEMENT_LIMIT * 0.75);
  });
});
