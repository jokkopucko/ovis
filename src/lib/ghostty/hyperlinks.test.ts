import { expect, test } from "bun:test";
import { Terminal, type ILink, type ILinkProvider } from "@xterm/xterm";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { matchHerdrWidths } from "../terminalWidths.ts";
import type { ScreenRows } from "../terminalScreen.ts";
import { terminalFileLinkProvider, terminalFileLinks } from "../terminalFileLinks.ts";
import { hyperlinkProvider } from "./hyperlinks.ts";
import { ghosttyRows } from "./screenRows.ts";
import { GhosttyVt } from "./vt.ts";

const parse = (term: Terminal, data: string): Promise<void> => new Promise((resolve) => term.write(data, resolve));
const provided = (provider: ILinkProvider, y: number): Promise<ILink[] | undefined> => new Promise((resolve) => provider.provideLinks(y, resolve));
const ranges = (links: ILink[] | undefined) => links?.map(({ range, text }) => ({ range, text })) ?? [];

function webLinks(rows: () => ScreenRows): ILinkProvider {
  let provider: ILinkProvider | null = null;
  new WebLinksAddon().activate({ registerLinkProvider: (registered: ILinkProvider) => { provider = registered; }, buffer: { get active() { return rows(); } } } as unknown as Terminal);
  return provider!;
}

async function both(cols: number, rows: number, stream: string): Promise<{ term: Terminal; vt: GhosttyVt; done: () => void }> {
  const term = new Terminal({ cols, rows, scrollback: 20, allowProposedApi: true });
  matchHerdrWidths(term);
  const vt = await GhosttyVt.create(cols, rows);
  vt.setScrollback(20);
  vt.write(stream);
  await parse(term, stream);
  return { term, vt, done: () => { vt.dispose(); term.dispose(); } };
}

const LINKS = "see https://example.com/a?b=1 and 한글 https://ovis.sh/docs/long/path/that/wraps/over/the/edge, then src/lib/terminalScreen.ts:42\r\n"
  + "\x1b]8;;https://example.com/osc\x1b\\label\x1b]8;;\x1b\\ plain \x1b]8;;file:///tmp/x.txt\x07file\x1b]8;;\x07\r\n";

test("web and file links are found at the same cells in libghostty's rows as in xterm's", async () => {
  const { term, vt, done } = await both(40, 8, LINKS);
  try {
    const xterm = webLinks(() => term.buffer.active), ghostty = webLinks(() => ghosttyRows(vt));
    for (let y = 1; y <= 6; y++) {
      expect(ranges(await provided(ghostty, y))).toEqual(ranges(await provided(xterm, y)));
      expect(ranges(terminalFileLinks(ghosttyRows(vt), y, () => {}))).toEqual(ranges(terminalFileLinks(term.buffer.active, y, () => {})));
    }
    expect(ranges(await provided(ghostty, 1)).map((link) => link.text)).toEqual(["https://example.com/a?b=1", "https://ovis.sh/docs/long/path/that/wraps/over/the/edge"]);
  } finally { done(); }
});

test("libghostty's OSC 8 hyperlinks are links over their cells that open their targets", async () => {
  const { term, vt, done } = await both(40, 8, LINKS);
  try {
    const opened: string[] = [];
    const ghostty = hyperlinkProvider(() => ghosttyRows(vt), () => true, (_event, uri) => opened.push(uri));
    const row = [1, 2, 3, 4, 5, 6].find((y) => ghosttyRows(vt).getLine(y - 1)?.translateToString(true).startsWith("label"))!;
    const links = await provided(ghostty, row);
    expect(ranges(links)).toEqual([
      { range: { start: { x: 1, y: row }, end: { x: 5, y: row } }, text: "https://example.com/osc" },
      { range: { start: { x: 13, y: row }, end: { x: 16, y: row } }, text: "file:///tmp/x.txt" },
    ]);
    links![1]!.activate({} as MouseEvent, links![1]!.text);
    expect(opened).toEqual(["file:///tmp/x.txt"]);
    expect(await provided(hyperlinkProvider(() => term.buffer.active, () => true, () => {}), row)).toBeUndefined();
  } finally { done(); }
});

test("an OSC 8 target the app does not open is no link, and a file link under it is still found", async () => {
  // herdr's OmO panel links its rows to omo-panel: targets, which xterm's own provider leaves alone (#739)
  const { vt, done } = await both(40, 4, "\x1b]8;;omo-panel:file/main\x1b\\see src/main.ts\x1b]8;;\x1b\\\r\n");
  try {
    const opens = (uri: string): boolean => uri.startsWith("https://") || uri.startsWith("file:");
    expect(await provided(hyperlinkProvider(() => ghosttyRows(vt), opens, () => {}), 1)).toBeUndefined();
    expect(ranges(terminalFileLinks(ghosttyRows(vt), 1, () => {})).map((link) => link.text)).toEqual(["src/main.ts"]);
  } finally { done(); }
});

test("a file link found in libghostty's rows opens only if the row still shows it when clicked", async () => {
  const { vt, done } = await both(40, 4, "open src/main.ts");
  try {
    const opened: string[] = [];
    const links = await provided(terminalFileLinkProvider(() => ghosttyRows(vt), (path) => opened.push(path)), 1);
    vt.write("x");
    links!.find((link) => link.text === "src/main.ts")!.activate({} as MouseEvent, "src/main.ts");
    expect(opened).toEqual([]);
  } finally { done(); }
});
