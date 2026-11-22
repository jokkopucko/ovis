import { createCSSVariablesTheme, registerCustomTheme } from "@pierre/diffs";

export const SOURCE_THEME = "herdr-source";
registerCustomTheme(SOURCE_THEME, async () => {
  const theme = createCSSVariablesTheme({
    name: SOURCE_THEME,
    variablePrefix: "--herdr-code-",
    fontStyle: false,
  });
  return {
    ...theme,
    tokenColors: [...(theme.tokenColors ?? []), {
      scope: ["markup.heading", "punctuation.definition.heading", "punctuation.definition.list.begin.markdown"],
      settings: { foreground: "var(--herdr-code-token-link)" },
    }],
  };
});

/**
 * The app's tokens for the rows inside the virtualizer's shadow root, where the document's rules do
 * not reach but its custom properties do. The hooks are the package's own theming properties, in
 * its `unsafe` layer, so neither Pierre's white nor its black code background is painted here.
 */
export const SHADOW_CSS = `
:host {
  --herdr-code-foreground: var(--text);
  --herdr-code-background: var(--bg);
  --herdr-code-token-comment: var(--syntax-comment);
  --herdr-code-token-keyword: var(--syntax-keyword);
  --herdr-code-token-constant: var(--syntax-number);
  --herdr-code-token-string: var(--syntax-string);
  --herdr-code-token-string-expression: var(--syntax-string);
  --herdr-code-token-function: var(--syntax-function);
  --herdr-code-token-parameter: var(--syntax-variable);
  --herdr-code-token-punctuation: var(--text);
  --herdr-code-token-link: var(--syntax-meta);
  --herdr-code-token-inserted: var(--syntax-inserted);
  --herdr-code-token-deleted: var(--syntax-deleted);
  --herdr-code-token-changed: var(--syntax-meta);
  --diffs-light-bg: var(--bg);
  --diffs-dark-bg: var(--bg);
  --diffs-light: var(--text);
  --diffs-dark: var(--text);
  --diffs-fg-number-override: var(--line-number);
  --diffs-bg-selection-override: var(--accent-tint);
  --diffs-bg-selection-number-override: var(--accent-tint);
  --diffs-selection-number-fg: var(--accent);
  --diffs-font-family: var(--font-mono);
  /* --source-scale: Settings → File text size on a file's own source (VirtualSource.css); 1 in a diff */
  --diffs-font-size: calc(var(--fs-xs) * var(--source-scale, 1));
  --diffs-line-height: calc(var(--fs-xs) * var(--source-scale, 1) * var(--lh-base));
}
`;

export const SCROLL_CONFIG = { overscrollSize: 600, intersectionObserverMargin: 1200 };

/**
 * The highlighter runs in the package's own worker, never on the page: the whole file is colored
 * at once, and 8 MiB of it measured 54 s of blocked page without one. Two workers color one file
 * at a time; the pool is created with the first virtualized source (plain rows use its manager's
 * windowed rows) or diff, and ended after the last. Its two
 * result caches (files, diffs) hold 12 entries each, not the package's 100: one colored file can
 * be megabytes of heap, and stepping through a repository's changes keeps the pool alive.
 */
export const POOL_OPTIONS = { workerFactory: (): Worker => new Worker(new URL("@pierre/diffs/worker/worker.js", import.meta.url), { type: "module" }), poolSize: 2, totalASTLRUCacheSize: 12 };
export const HIGHLIGHTER_OPTIONS = { theme: SOURCE_THEME, preferredHighlighter: "shiki-js" as const };

/** A key for the worker's highlight cache: two contents of one name and length must not share one (FNV-1a, 32 bit). */
export function contentKey(name: string, text: string): string {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${name}:${text.length}:${(hash >>> 0).toString(16)}`;
}

/**
 * A blank source line is an empty span in its row, which the browser's text serializer skips: a
 * selection over it loses the line. A line break inside the span keeps the line's newline in a
 * copy, without changing the row's height. Colored rows arrive with one; plain rows get it here.
 */
export function keepEmptyRows(shadow: ShadowRoot): void {
  for (const span of shadow.querySelectorAll<HTMLElement>("[data-line] > span")) {
    if (span.textContent === "" && span.firstElementChild === null) span.append(document.createElement("br"));
  }
}
