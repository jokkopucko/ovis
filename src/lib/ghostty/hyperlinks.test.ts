import { expect, test } from "bun:test";
import { terminalFileLinkProvider, terminalFileLinks } from "../terminalFileLinks.ts";
import { hyperlinkProvider } from "./hyperlinks.ts";
import { ghosttyRows } from "./screenRows.ts";
import { GhosttyVt } from "./vt.ts";

import type { ILink, ILinkProvider } from "../terminalSelection/types.ts";
import { webLinkProvider } from "../terminalSelection/webLinks.ts";

async function terminal(cols: number, rows: number, text: string) {
  const vt = await GhosttyVt.create(cols, rows);
  vt.write(text);
  return vt;
}
const provided = (provider: ILinkProvider, y: number): Promise<ILink[] | undefined> => new Promise((resolve) => provider.provideLinks(y, resolve));
const ranges = (links: ILink[] | undefined) => links?.map(({ range, text }) => ({ range, text })) ?? [];

const LINKS = "see https://example.com/a?b=1 and 한글 https://ovis.sh/docs/long/path/that/wraps/over/the/edge, then src/lib/terminalScreen.ts:42\r\n"
  + "\x1b]8;;https://example.com/osc\x1b\\label\x1b]8;;\x1b\\ plain \x1b]8;;file:///tmp/x.txt\x07file\x1b]8;;\x07\r\n";

test("web and file links keep their text and coordinates across a wrap", async () => {
  const vt = await terminal(40, 8, LINKS);
  try {
    const ghostty = webLinkProvider(() => ghosttyRows(vt), () => {});
    expect(ranges(await provided(ghostty, 1)).map((link) => link.text)).toEqual(["https://example.com/a?b=1", "https://ovis.sh/docs/long/path/that/wraps/over/the/edge"]);
    expect(ranges(await provided(ghostty, 1)).map(({ range }) => range)).toEqual([
      { start: { x: 5, y: 1 }, end: { x: 29, y: 1 } },
      { start: { x: 40, y: 1 }, end: { x: 14, y: 3 } },
    ]);
    expect(ranges(terminalFileLinks(ghosttyRows(vt), 3, () => {})).map(({ text }) => text)).toContain("src/lib/terminalScreen.ts:42");
  } finally { vt.dispose(); }
});

test("libghostty's OSC 8 hyperlinks are links over their cells that open their targets", async () => {
  const vt = await terminal(40, 8, LINKS);
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
  } finally { vt.dispose(); }
});

test("an OSC 8 target the app does not open is no link, and a file link under it is still found", async () => {
  // herdr's OmO panel links its rows to omo-panel: targets, which xterm's own provider leaves alone (#739)
  const vt = await terminal(40, 4, "\x1b]8;;omo-panel:file/main\x1b\\see src/main.ts\x1b]8;;\x1b\\\r\n");
  try {
    const opens = (uri: string): boolean => uri.startsWith("https://") || uri.startsWith("file:");
    expect(await provided(hyperlinkProvider(() => ghosttyRows(vt), opens, () => {}), 1)).toBeUndefined();
    expect(ranges(terminalFileLinks(ghosttyRows(vt), 1, () => {})).map((link) => link.text)).toEqual(["src/main.ts"]);
  } finally { vt.dispose(); }
});

test("a file link found in libghostty's rows opens only if the row still shows it when clicked", async () => {
  const vt = await terminal(40, 4, "open src/main.ts");
  try {
    const opened: string[] = [];
    const links = await provided(terminalFileLinkProvider(() => ghosttyRows(vt), (path) => opened.push(path)), 1);
    vt.write("x");
    links!.find((link) => link.text === "src/main.ts")!.activate({} as MouseEvent, "src/main.ts");
    expect(opened).toEqual([]);
  } finally { vt.dispose(); }
});
