import { describe, expect, it } from "bun:test";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();
const css = await read("./styles.css");

/** Body of the first `@media <query> { ... }` block, found by matching braces. */
function mediaBody(query: string, source = css, file = "styles.css"): string {
  const start = source.indexOf(`@media ${query} {`);
  if (start < 0) throw new Error(`no @media ${query} block in ${file}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unclosed @media ${query} block in ${file}`);
}

function rule(block: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(block)?.[1] ?? "";
}

describe("window-controls-overlay styles", () => {
  it("makes .app-header drag the window and pads it clear of the window controls", () => {
    const block = mediaBody("(display-mode: window-controls-overlay)");
    const header = /\.app-header\s*\{([^}]*)\}/.exec(block)?.[1] ?? "";
    expect(header).toContain("app-region: drag;");
    expect(header).toContain("env(titlebar-area-x");
    expect(header).toContain("env(titlebar-area-width");

    const controls =
      /\.app-header\s*:is\(button,\s*a,\s*input,\s*select,\s*textarea,\s*\[tabindex\]\)\s*\{([^}]*)\}/.exec(
        block,
      )?.[1] ?? "";
    expect(controls).toContain("app-region: no-drag;");
  });

  // #2026: the header's drag region and the browser's window controls sit over the title bar
  // band even under a full-screen preview, so the preview cancels the drag region and its bar
  // starts below the band.
  for (const name of ["image", "mermaid"]) {
    it(`keeps the ${name} preview's bar out of the title bar area`, async () => {
      const file = `${name === "image" ? "Image" : "Mermaid"}Lightbox.css`;
      const block = mediaBody("(display-mode: window-controls-overlay)", await read(`./components/${file}`), file);
      expect(rule(block, `.${name}-lightbox-scrim`)).toContain("app-region: no-drag;");
      const top = /(?:^|;)\s*top:([^;]*);/.exec(rule(block, `.${name}-lightbox-bar`))?.[1] ?? "";
      expect(top).toContain("env(titlebar-area-y, 0px)");
      expect(top).toContain("env(titlebar-area-height, 0px)");
    });
  }
});
