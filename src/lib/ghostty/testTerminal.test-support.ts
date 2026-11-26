import { ParserHooks, hookedStream } from "./hooks.ts";
import { ghosttyRows } from "./screenRows.ts";
import { GhosttyVt } from "./vt.ts";
import { holdScreenRows } from "../terminalScreen.ts";

/** A real VT and its rows, without the browser renderer or input layer. */
export async function testTerminal({ cols = 80, rows = 24, scrollback = 0 } = {}) {
  const vt = await GhosttyVt.create(cols, rows);
  vt.setScrollback(scrollback);
  const parser = new ParserHooks();
  const write = hookedStream(parser, (text) => vt.write(text));
  const resized = new Set<() => void>();
  const read = () => ghosttyRows(vt);
  const term = {
    get cols() { return vt.cols; },
    get rows() { return vt.rows; },
    buffer: { get active() { return read(); } },
    parser,
    write(text: string, done?: () => void) { write(text); done?.(); },
    resize(cols: number, rows: number) { vt.resize(cols, rows, 8, 16); for (const listener of resized) listener(); },
    onResize(listener: () => void) { resized.add(listener); },
    scrollFromBottom(lines: number) { vt.scrollFromBottom(lines); },
    reset() { write.reset(); vt.reset(); },
    dispose() { holdScreenRows(term, null); vt.dispose(); },
  };
  holdScreenRows(term, read);
  return term;
}

export type TestTerminal = Awaited<ReturnType<typeof testTerminal>>;
