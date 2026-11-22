import type { InlineNode, MarkdownBlock } from "../../shared/markdown.ts";

type HeadingLevel = Extract<MarkdownBlock, { type: "heading" }>["level"];

export interface OutlineEntry {
  level: HeadingLevel;
  text: string;
  at: number;
}

function headingText(nodes: InlineNode[]): string {
  return nodes.map((node) => {
    switch (node.type) {
      case "text": case "code": case "math": return node.value;
      case "image": return node.alt;
      case "strong": case "em": case "del": case "link": case "file": return headingText(node.children);
    }
  }).join("");
}

export function outlineOf(blocks: readonly MarkdownBlock[]): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  let at = 0;
  for (const block of blocks) {
    if (block.type !== "heading") continue;
    const text = headingText(block.content).replace(/\s+/g, " ").trim();
    if (text !== "") entries.push({ level: block.level, text, at });
    at += 1;
  }
  return entries;
}

export function currentHeading(tops: readonly number[], line: number): number {
  if (tops.length === 0) return -1;
  let current = 0;
  for (const [index, top] of tops.entries()) {
    if (top > line) break;
    current = index;
  }
  return current;
}
