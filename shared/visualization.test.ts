import { describe, expect, it } from "bun:test";
import { parseMarkdown } from "./markdown.ts";
import { visualizationName, visualizationReference, visualizationTitle } from "./visualization.ts";

const directive = (data: unknown) => `\uE200visualize\uE202${JSON.stringify(data)}\uE201`;
const answer = (source: string) => parseMarkdown(source, 0, false, true);

describe("Codex visualization references", () => {
  it("is a block only where a chat answer asks for it: any other Markdown keeps the reference as the text it is", () => {
    const line = directive({ path: "/repo/diagram.html" });
    const text = (value: string) => [{ type: "text" as const, value }];
    expect(answer(`Before\n${line}`).map((each) => each.type)).toEqual(["paragraph", "visualization"]);
    expect(parseMarkdown(`Before\n${line}`)).toEqual([{ type: "paragraph", lines: [text("Before"), text(line)] }]);
    expect(parseMarkdown(`Before\n${line}`, 0, true)).toEqual([{ type: "paragraph", lines: [text("Before"), text(line)] }]);
    expect(parseMarkdown(`- Item\n  ${line}\n- Next`)).toEqual([{ type: "list", ordered: false, items: [{ content: [...text("Item"), ...text(" "), ...text(line)] }, { content: text("Next") }] }]);
    expect(parseMarkdown(`> ${line}`)).toEqual([{ type: "blockquote", blocks: [{ type: "paragraph", lines: [text(line)] }] }]);
    expect(answer(`> ${line}`)).toEqual([{ type: "blockquote", blocks: [{ type: "visualization", path: "/repo/diagram.html" }] }]);
  });
  it("recognizes an absolute HTML file, metadata and Windows paths as a block between prose", () => {
    const line = directive({ path: "/repo/도식 with spaces.html", mode: "wide", title: " Before / After " });
    expect(answer(`Before\n${line}\nAfter`)).toEqual([
      { type: "paragraph", lines: [[{ type: "text", value: "Before" }]] },
      { type: "visualization", path: "/repo/도식 with spaces.html", title: "Before / After" },
      { type: "paragraph", lines: [[{ type: "text", value: "After" }]] },
    ]);
    expect(visualizationReference(directive({ path: "C:\\work\\diagram.HTM" }))).toEqual({ path: "C:\\work\\diagram.HTM" });
  });
  it("leaves fenced/inline examples, unfinished JSON and unsupported targets as text", () => {
    const line = directive({ path: "/repo/diagram.html" });
    expect(answer(`\`\`\`text\n${line}\n\`\`\``)[0]?.type).toBe("code");
    expect(answer(`Example: ${line}`)[0]?.type).toBe("paragraph");
    for (const data of [null, [], { path: "https://example.org/a.html" }, { path: "//host/a.html" },
      // a network share on a Windows PC, however its leading separators are written
      { path: "/\\host/share/a.html" }, { path: "\\\\host\\share\\a.html" }, { path: "\\/host/share/a.html" },
      { path: "relative/a.html" }, { path: "/repo/a.svg" }, { path: "/repo/a.html\n" },
      { path: "/repo/a.html", title: 2 }]) {
      expect(visualizationReference(directive(data))).toBeNull();
      expect(answer(directive(data))[0]?.type).toBe("paragraph");
    }
    expect(visualizationReference(line.slice(0, -1))).toBeNull();
    expect(visualizationReference("\uE200visualize\uE202{bad}\uE201")).toBeNull();
    expect(visualizationReference(directive({ path: "/" + "a".repeat(17_000) + ".html" }))).toBeNull();
  });
  it("draws a reference indented under a list item in that item, and the list goes on after it", () => {
    const line = directive({ path: "/repo/diagram.html" });
    const block = { type: "visualization" as const, path: "/repo/diagram.html" };
    const text = (value: string) => [{ type: "text" as const, value }];
    expect(answer(`1. First\n   ${line}\n   More about first\n1. Second`)).toEqual([{ type: "list", ordered: true, items: [
      { content: text("First"), blocks: [block, { type: "paragraph", lines: [text("More about first")] }] },
      { content: text("Second") },
    ] }]);
    expect(answer(`- The flow:\n\n  ${line}\n  ${line}\n- Next`)).toEqual([{ type: "list", ordered: false, items: [
      { content: text("The flow:"), blocks: [block, block] }, { content: text("Next") },
    ] }]);
    expect(answer(`- Outer\n  - Inner\n    ${line}\n- Next`)).toEqual([{ type: "list", ordered: false, items: [
      { content: text("Outer"), blocks: [{ type: "list", ordered: false, items: [{ content: text("Inner"), blocks: [block] }] }] }, { content: text("Next") },
    ] }]);
    expect(answer(`- The flow:\n${line}\n- Next`).map((each) => each.type)).toEqual(["list", "visualization", "list"]);
    for (const source of [`1. First\n   ${line}\n1. Second`, `- The flow:\n\n  ${line}\n- Next`, `- The flow:\n${line}\n- Next`]) {
      expect(JSON.stringify(answer(source))).not.toContain("\uE200");
    }
    expect(answer(`- The flow:\n  it reads ${line}`)).toEqual([{ type: "list", ordered: false, items: [{ content: [...text("The flow:"), ...text(" "), ...text(`it reads ${line}`)] }] }]);
  });
  it("draws the same card for every mode, also one this app has never seen", () => {
    // `mode` is how Codex's own app lays its preview out: the card does not use it, so it never turns a reference back into text
    for (const mode of ["wide", "inline", "unknown", 3, null, { nested: true }]) {
      expect(visualizationReference(directive({ path: "/repo/a.html", mode, title: "A" }))).toEqual({ path: "/repo/a.html", title: "A" });
      expect(answer(directive({ path: "/repo/a.html", mode }))).toEqual([{ type: "visualization", path: "/repo/a.html" }]);
    }
  });
  it("names a card by the file's own name, and shows the reference's title only beside it", () => {
    expect(visualizationName("/repo/out/report.html")).toBe("report.html");
    expect(visualizationName("C:\\work\\out/diagram.HTM")).toBe("diagram.HTM");
    // what reorders or hides text is taken out: a right-to-left override, zero-width characters, a byte-order mark
    expect(visualizationName("/repo/report\u202Efdp.html")).toBe("reportfdp.html");
    expect(visualizationName("/repo/a\u200Bb\u2066c\uFEFF.html")).toBe("abc.html");
    const long = visualizationName(`/repo/${"x".repeat(300)}-final.html`);
    expect([[...long].length, long.startsWith("xxxx"), long.endsWith("xxxxx-final.html"), long.includes("\u2026")]).toEqual([80, true, true, true]);
    expect(visualizationTitle({ path: "/repo/a.html", title: "Before \u202E/ After\t now" })).toBe("Before / After now");
    expect([...visualizationTitle({ path: "/repo/a.html", title: "t".repeat(200) })!].length).toBe(120);
    expect(visualizationTitle({ path: "/repo/a.html" })).toBeNull();
    expect(visualizationTitle({ path: "/repo/a.html", title: "a.html" })).toBeNull();
    expect(visualizationTitle({ path: "/repo/a.html", title: "\u200B\u202E" })).toBeNull();
    expect(visualizationReference(directive({ path: "/repo/report\u202Efdp.html", title: "x" }))?.path).toBe("/repo/report\u202Efdp.html");
  });
});
