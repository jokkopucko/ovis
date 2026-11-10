import { describe, expect, it } from "bun:test";
import { parseMarkdown } from "./markdown.ts";
import { visualizationName, visualizationReference, visualizationTitle } from "./visualization.ts";

const directive = (data: unknown) => `\uE200visualize\uE202${JSON.stringify(data)}\uE201`;
/** a chat answer's Markdown: the one place a reference is read as a block */
const answer = (source: string) => parseMarkdown(source, 0, false, true);

describe("Codex visualization references", () => {
  it("is a block only where a chat answer asks for it: any other Markdown keeps the reference as the text it is", () => {
    const line = directive({ path: "/repo/diagram.html" });
    const text = (value: string) => [{ type: "text" as const, value }];
    expect(answer(`Before\n${line}`).map((each) => each.type)).toEqual(["paragraph", "visualization"]);
    // a prompt card, a task result, release notes: one paragraph, the reference its second line
    expect(parseMarkdown(`Before\n${line}`)).toEqual([{ type: "paragraph", lines: [text("Before"), text(line)] }]);
    // the file viewer's Preview of a .md file (README mode)
    expect(parseMarkdown(`Before\n${line}`, 0, true)).toEqual([{ type: "paragraph", lines: [text("Before"), text(line)] }]);
    // in a list item and in a quote it is the item's and the quote's text
    expect(parseMarkdown(`- Item\n  ${line}\n- Next`)).toEqual([{ type: "list", ordered: false, items: [{ content: [...text("Item"), ...text(" "), ...text(line)] }, { content: text("Next") }] }]);
    expect(parseMarkdown(`> ${line}`)).toEqual([{ type: "blockquote", blocks: [{ type: "paragraph", lines: [text(line)] }] }]);
    expect(answer(`> ${line}`)).toEqual([{ type: "blockquote", blocks: [{ type: "visualization", path: "/repo/diagram.html", wide: false }] }]);
  });
  it("recognizes an absolute HTML file, metadata and Windows paths as a block between prose", () => {
    const line = directive({ path: "/repo/도식 with spaces.html", mode: "wide", title: " Before / After " });
    expect(answer(`Before\n${line}\nAfter`)).toEqual([
      { type: "paragraph", lines: [[{ type: "text", value: "Before" }]] },
      { type: "visualization", path: "/repo/도식 with spaces.html", title: "Before / After", wide: true },
      { type: "paragraph", lines: [[{ type: "text", value: "After" }]] },
    ]);
    expect(visualizationReference(directive({ path: "C:\\work\\diagram.HTM" }))).toEqual({ path: "C:\\work\\diagram.HTM", wide: false });
  });
  it("leaves fenced/inline examples, unfinished JSON and unsupported targets as text", () => {
    const line = directive({ path: "/repo/diagram.html" });
    expect(answer(`\`\`\`text\n${line}\n\`\`\``)[0]?.type).toBe("code");
    expect(answer(`Example: ${line}`)[0]?.type).toBe("paragraph");
    for (const data of [null, [], { path: "https://example.org/a.html" }, { path: "//host/a.html" },
      // a network share on a Windows PC, however its leading separators are written
      { path: "/\\host/share/a.html" }, { path: "\\\\host\\share\\a.html" }, { path: "\\/host/share/a.html" },
      { path: "relative/a.html" }, { path: "/repo/a.svg" }, { path: "/repo/a.html\n" },
      { path: "/repo/a.html", mode: "unknown" }, { path: "/repo/a.html", title: 2 }]) {
      expect(visualizationReference(directive(data))).toBeNull();
      expect(answer(directive(data))[0]?.type).toBe("paragraph");
    }
    expect(visualizationReference(line.slice(0, -1))).toBeNull();
    expect(visualizationReference("\uE200visualize\uE202{bad}\uE201")).toBeNull();
    expect(visualizationReference(directive({ path: "/" + "a".repeat(17_000) + ".html" }))).toBeNull();
  });
  it("draws a reference indented under a list item in that item, and the list goes on after it", () => {
    const line = directive({ path: "/repo/diagram.html" });
    const block = { type: "visualization" as const, path: "/repo/diagram.html", wide: false };
    const text = (value: string) => [{ type: "text" as const, value }];
    // lazily numbered, as agents write ordered lists: one list of two items, so the second is drawn as 2
    expect(answer(`1. First\n   ${line}\n   More about first\n1. Second`)).toEqual([{ type: "list", ordered: true, items: [
      { content: text("First"), blocks: [block, { type: "paragraph", lines: [text("More about first")] }] },
      { content: text("Second") },
    ] }]);
    // after a blank line, two references in one item, and under a nested item
    expect(answer(`- The flow:\n\n  ${line}\n  ${line}\n- Next`)).toEqual([{ type: "list", ordered: false, items: [
      { content: text("The flow:"), blocks: [block, block] }, { content: text("Next") },
    ] }]);
    expect(answer(`- Outer\n  - Inner\n    ${line}\n- Next`)).toEqual([{ type: "list", ordered: false, items: [
      { content: text("Outer"), blocks: [{ type: "list", ordered: false, items: [{ content: text("Inner"), blocks: [block] }] }] }, { content: text("Next") },
    ] }]);
    // not indented, it is no part of the item: it ends the list, as any block there does
    expect(answer(`- The flow:\n${line}\n- Next`).map((each) => each.type)).toEqual(["list", "visualization", "list"]);
    for (const source of [`1. First\n   ${line}\n1. Second`, `- The flow:\n\n  ${line}\n- Next`, `- The flow:\n${line}\n- Next`]) {
      expect(JSON.stringify(answer(source))).not.toContain("\uE200");
    }
    // an example of a reference in a list item's text is not a reference
    expect(answer(`- The flow:\n  it reads ${line}`)).toEqual([{ type: "list", ordered: false, items: [{ content: [...text("The flow:"), ...text(" "), ...text(`it reads ${line}`)] }] }]);
  });
  it("names a card by the file's own name, and shows the reference's title only beside it", () => {
    expect(visualizationName("/repo/out/report.html")).toBe("report.html");
    expect(visualizationName("C:\\work\\out/diagram.HTM")).toBe("diagram.HTM");
    // what reorders or hides text is taken out: a right-to-left override, zero-width characters, a byte-order mark
    expect(visualizationName("/repo/report\u202Efdp.html")).toBe("reportfdp.html");
    expect(visualizationName("/repo/a\u200Bb\u2066c\uFEFF.html")).toBe("abc.html");
    // a long name is cut in the middle: its end, the file's type, stays
    const long = visualizationName(`/repo/${"x".repeat(300)}-final.html`);
    expect([[...long].length, long.startsWith("xxxx"), long.endsWith("xxxxx-final.html"), long.includes("\u2026")]).toEqual([80, true, true, true]);
    // the title is the second line: cleaned the same way, clamped, and left out when there is none or it repeats the name
    expect(visualizationTitle({ path: "/repo/a.html", title: "Before \u202E/ After\t now" })).toBe("Before / After now");
    expect([...visualizationTitle({ path: "/repo/a.html", title: "t".repeat(200) })!].length).toBe(120);
    expect(visualizationTitle({ path: "/repo/a.html" })).toBeNull();
    expect(visualizationTitle({ path: "/repo/a.html", title: "a.html" })).toBeNull();
    expect(visualizationTitle({ path: "/repo/a.html", title: "\u200B\u202E" })).toBeNull();
    // the reference itself keeps the path as written: it is what the viewer is asked to open
    expect(visualizationReference(directive({ path: "/repo/report\u202Efdp.html", title: "x" }))?.path).toBe("/repo/report\u202Efdp.html");
  });
});
