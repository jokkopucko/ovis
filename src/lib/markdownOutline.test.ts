import { describe, expect, it } from "bun:test";

import { parseMarkdown } from "../../shared/markdown.ts";
import { currentHeading, outlineOf } from "./markdownOutline.ts";

describe("outlineOf", () => {
  it("lists the document's own headings in order, with their levels and their words", () => {
    const blocks = parseMarkdown("# Guide\n\nText.\n\n## Install **now**\n\n### With `bun`\n\n> # Quoted\n\n#### [Links](https://example.com) and $x^2$ ![logo](./a.png)\n");
    expect(outlineOf(blocks)).toEqual([
      { level: 1, text: "Guide", at: 0 },
      { level: 2, text: "Install now", at: 1 },
      { level: 3, text: "With bun", at: 2 },
      { level: 4, text: "Links and x^2 logo", at: 3 },
    ]);
  });

  it("keeps a heading written twice as two entries, each its own place in the document", () => {
    const entries = outlineOf(parseMarkdown("## Usage\n\none\n\n## Usage\n\ntwo\n"));
    expect(entries.map((entry) => entry.at)).toEqual([0, 1]);
    expect(entries.map((entry) => entry.text)).toEqual(["Usage", "Usage"]);
  });

  it("leaves out a heading with no words to list, keeping the places of the ones after it", () => {
    expect(outlineOf(parseMarkdown("# ![ ](./logo.png)\n\n## Next\n"))).toEqual([{ level: 2, text: "Next", at: 1 }]);
  });
});

describe("currentHeading", () => {
  it("is the last heading at or above the reading line, the first above it, none without headings", () => {
    const tops = [10, 400, 900];
    expect(currentHeading(tops, 0)).toBe(0);
    expect(currentHeading(tops, 10)).toBe(0);
    expect(currentHeading(tops, 399)).toBe(0);
    expect(currentHeading(tops, 400)).toBe(1);
    expect(currentHeading(tops, 5_000)).toBe(2);
    expect(currentHeading([], 100)).toBe(-1);
  });
});
