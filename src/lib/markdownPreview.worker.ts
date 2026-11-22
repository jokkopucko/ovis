// Parses a Markdown file for the viewer's Preview off the page (src/lib/markdownPreview.ts): an
// input the parser handles slowly stalls this worker, which is ended past its budget, never the tab.
import type { MarkdownBlock } from "../../shared/markdown.ts";
import { parsePreviewMarkdown } from "./markdownCommonmark.ts";
import { serveOffThread } from "./offThread.ts";
import { PREVIEW_ELEMENT_LIMIT, previewElements } from "./textPreview.ts";

serveOffThread<string, MarkdownBlock[] | null>((text) => {
  const blocks = parsePreviewMarkdown(text);
  return { result: previewElements(blocks) > PREVIEW_ELEMENT_LIMIT ? null : blocks };
});
