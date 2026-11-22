import { forwardRef, Fragment, memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { canHighlight, countLines, extendLines, LINE_ELEMENT_LIMIT, normalizeCode, plainLines, type Lines } from "../lib/highlight.ts";
import { highlightedFrom, highlightKnown, highlightOffThread, type Highlighted } from "../lib/highlightOffThread.ts";
import { useT } from "../lib/i18n.ts";
import { linkFilePaths, linksFilePaths } from "./FilePathLink.tsx";
import "./HighlightedCode.css";

export function useHighlightedLines(code: string, language: string | null, limit?: number): Highlighted {
  const source = useMemo(() => normalizeCode(code), [code]);
  const highlighted = canHighlight(language) ? language : null;
  const manyLines = useMemo(() => countLines(source) > LINE_ELEMENT_LIMIT, [source]);
  const overLimit = highlighted !== null && ((limit !== undefined && code.length > limit) || manyLines);
  const known = useMemo((): Highlighted | null => {
    if (highlighted === null || overLimit) return { lines: plainLines(source), tooLong: overLimit };
    return highlightKnown(source, highlighted);
  }, [source, highlighted, overLimit]);
  const [answer, setAnswer] = useState<{ source: string; language: string; lines: Lines | null } | null>(null);
  useEffect(() => {
    if (known !== null || highlighted === null) return;
    let live = true;
    const job = highlightOffThread(source, highlighted);
    void job.promise.then((lines) => { if (live) setAnswer({ source, language: highlighted, lines }); });
    return () => { live = false; job.cancel(); };
  }, [known, source, highlighted]);
  const shown = useRef<{ source: string; language: string; lines: Lines } | null>(null);
  const result = useMemo((): Highlighted => {
    if (known !== null) return known;
    if (answer !== null && answer.source === source && answer.language === highlighted) return highlightedFrom(source, answer.lines);
    const last = shown.current;
    if (last !== null && last.language === highlighted && source.startsWith(last.source)) {
      return { lines: extendLines(last.lines, source.slice(last.source.length)), tooLong: false };
    }
    return { lines: plainLines(source), tooLong: false };
  }, [known, answer, source, highlighted]);
  useEffect(() => {
    shown.current = highlighted === null || result.tooLong ? null : { source, language: highlighted, lines: result.lines };
  }, [result, source, highlighted]);
  return result;
}

interface CodeLinesProps {
  lines: Lines;
  lineNumbers?: boolean;
  wrap?: boolean;
  className?: string;
  markedLine?: number | null;
  open: ((path: string) => void) | null;
}

/**
 * Code colored by role, one `.hl-line` per source line. `memo` skips a parent's re-render while
 * `lines` is the same array, and the line elements are built apart from the attributes: toggling
 * `wrap` or `lineNumbers` leaves them alone. The line-number gutter is a CSS counter, so it never
 * reaches a copy.
 *
 * The lines are inline spans joined by literal "\n" text nodes (none after the last line), so the
 * text of the `<pre>` is the code itself: `innerText` and a copied selection keep every blank line.
 * Block lines would add a line break of their own between lines and drop or double the blank ones.
 * Past `LINE_ELEMENT_LIMIT` lines it is one text, as drawing an element per line would hold the page.
 * The ref is that `<pre>`: the file viewer selects it when the clipboard is out of reach.
 */
export const CodeLines = memo(forwardRef<HTMLPreElement, CodeLinesProps>(function CodeLines({ lines, open, lineNumbers = false, wrap = false, className, markedLine = null }, ref) {
  const plain = lines.length > LINE_ELEMENT_LIMIT;
  const elements = useMemo(() => plain
    ? linkFilePaths(lines.map((tokens) => tokens.map((token) => token.text).join("")).join("\n"), open)
    : lines.map((tokens, index) => (
      <Fragment key={index}>
        {index > 0 && "\n"}
        <span className={index + 1 === markedLine ? "hl-line is-marked" : "hl-line"} data-line={index + 1}>
          {tokens.map((token, n) => token.role === null ? <Fragment key={n}>{linkFilePaths(token.text, open)}</Fragment> : <span className={`hl-${token.role}`} key={n}>{linkFilePaths(token.text, open)}</span>)}
        </span>
      </Fragment>
    )), [lines, plain, open, markedLine]);
  const numbered = lineNumbers && !plain;
  const gutter = numbered ? { "--hl-digits": String(Math.max(2, String(lines.length).length)) } as CSSProperties : undefined;
  return <pre ref={ref} className={className ? `hl-code ${className}` : "hl-code"} style={gutter} data-line-numbers={numbered ? "" : undefined} data-wrap={wrap ? "" : undefined}><code>{elements}</code></pre>;
}));

interface HighlightedCodeProps {
  code: string;
  language: string | null;
  limit?: number;
  open?: ((path: string) => void) | null;
}

export const HighlightedCode = memo(function HighlightedCode({ code, language, limit, open = null }: HighlightedCodeProps) {
  const t = useT();
  const { lines, tooLong } = useHighlightedLines(code, language, limit);
  const links = useMemo(() => open !== null && linksFilePaths(code), [code, open]);
  return (
    <>
      <CodeLines lines={lines} open={links ? open : null} />
      {tooLong && <p className="hl-note">{t("Too long to highlight")}</p>}
    </>
  );
});
