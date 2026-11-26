import { describe, expect, it } from "bun:test";
import { testTerminal, type TestTerminal } from "./ghostty/testTerminal.test-support.ts";
import type { ILink } from "./terminalSelection/types.ts";
import { fileUriPath } from "../../shared/fileUri.ts";
import { bareNameLinks, hyperlinkFilter, terminalFileLinkProvider, terminalFileLinks } from "./terminalFileLinks.ts";

const click = { button: 0 } as MouseEvent;
const written = (term: TestTerminal, text: string) => new Promise<void>((resolve) => term.write(text, resolve));

describe("hyperlinkFilter", () => {
  const underlined = (term: TestTerminal, y: number, cols: number) => Array.from({ length: cols },
    (_, x) => term.buffer.active.getLine(y)?.getCell(x)?.isUnderline() ? "1" : "0").join("");
  const filtered = async () => {
    const term = await testTerminal({ cols: 30, rows: 4 });
    const filter = hyperlinkFilter();
    term.parser.registerOscHandler(8, filter.handler);
    return Object.assign(term, { filter });
  };

  it("draws no line under a link this app cannot open, as herdr streams OmO's side panel", async () => {
    const term = await filtered();
    // herdr's stream: the link stays open over the row's padding and closes on the next row
    await written(term, "\x1b]8;;omo-panel:file/.gitignore\x1b\\ M .gitignore\x1b[0;39;49m     \x1b[2;1H\x1b]8;;\x1b\\\x1b]8;;omo-panel:file/AGENTS.md\x1b\\ M AGENTS.md");
    expect(underlined(term, 0, 30)).toBe("0".repeat(30));
    expect(underlined(term, 1, 30)).toBe("0".repeat(30));
    expect(term.buffer.active.getLine(0)?.translateToString(true).trimEnd()).toBe(" M .gitignore");
  });

  it("keeps the links it opens, and an SGR underline", async () => {
    const term = await filtered();
    await written(term, "\x1b]8;;https://example.com\x1b\\web\x1b]8;;\x1b\\ \x1b]8;;file:///tmp/a.md\x1b\\file\x1b]8;;\x1b\\ \x1b[4mul\x1b[24m");
    const line = term.buffer.active.getLine(0);
    expect([0, 4, 9].map((x) => line?.hyperlink?.(x))).toEqual(["https://example.com", "file:///tmp/a.md", null]);
    expect(underlined(term, 0, 12)).toBe("000000000110");
  });

  it("lets a link that replaces an open one through, so the open one ends where it should", async () => {
    const term = await filtered();
    await written(term, "\x1b]8;;https://example.com\x1b\\ab\x1b]8;;omo-panel:x\x1b\\cd\x1b]8;;\x1b\\ef\x1b]8;;omo-panel:y\x1b\\gh");
    const line = term.buffer.active.getLine(0);
    expect(Array.from({ length: 8 }, (_, x) => line?.hyperlink?.(x))).toEqual(["https://example.com", "https://example.com", "omo-panel:x", "omo-panel:x", null, null, null, null]);
  });

  it("starts over with the terminal when a pane change resets it under an open link", async () => {
    const term = await filtered();
    await written(term, "\x1b]8;;https://example.com\x1b\\open");
    term.reset();
    term.filter.reset();
    await written(term, "\x1b]8;;omo-panel:file/a\x1b\\ M a");
    expect(underlined(term, 0, 4)).toBe("0000");
  });
});

describe("terminal file links", () => {
  it("excludes sentence punctuation but preserves encoded filename punctuation", async () => {
    const term = await testTerminal({ cols: 150 });
    await new Promise<void>((resolve) => term.write("file:///tmp/a.md: file:///tmp/a.md! file:///tmp/a.md? file:///tmp/a%21.md", resolve));
    const opened: string[] = [];
    const links = terminalFileLinks(term.buffer.active, 1, (path) => opened.push(path));
    expect(links.map((link) => link.text)).toEqual(["file:///tmp/a.md", "file:///tmp/a.md", "file:///tmp/a.md", "file:///tmp/a%21.md"]);
    for (const link of links) link.activate(click);
    expect(opened).toEqual(["/tmp/a.md", "/tmp/a.md", "/tmp/a.md", "/tmp/a!.md"]);
    term.dispose();
  });
  it("keeps an apostrophe inside a file URI and drops one after it", async () => {
    const term = await testTerminal({ cols: 120 });
    await written(term, "see file:///tmp/Bob's-notes.md and 'file:///tmp/a.md'");
    expect(terminalFileLinks(term.buffer.active, 1, () => {}).map((link) => link.text)).toEqual(["file:///tmp/Bob's-notes.md", "file:///tmp/a.md"]);
    term.dispose();
  });
  it("does not append an unrelated hard row after a full-width URI", async () => {
    const uri = "file:///tmp/README.md";
    const term = await testTerminal({ cols: uri.length });
    await new Promise<void>((resolve) => term.write(uri + "\r\nPASS unrelated output", resolve));
    const opened: string[] = [];
    const links = terminalFileLinks(term.buffer.active, 1, (path) => opened.push(path));
    links[0]?.activate(click);
    expect(opened).toEqual(["/tmp/README.md"]);
    term.dispose();
  });
  it("does not link method calls or dotted identifiers", async () => {
    const term = await testTerminal({ cols: 160 });
    await new Promise<void>((resolve) => term.write("tool.monitor({}) display(await tool.read({})) Math.random process.env example.com README.md src/custom.monitor", resolve));
    expect(terminalFileLinks(term.buffer.active, 1, () => {}).map((link) => link.text)).toEqual(["src/custom.monitor"]);
    term.dispose();
  });
  it("opens a wrapped file URI with encoded Korean and spaces", async () => {
    const term = await testTerminal({ cols: 40 });
    const uri = "file:///tmp/%ED%95%9C%EA%B8%80%20sheet.png";
    await new Promise<void>((resolve) => term.write(uri, resolve));
    const opened: string[] = [];
    const links = terminalFileLinks(term.buffer.active, 1, (path) => opened.push(path));
    expect(links.map((link) => link.text)).toEqual([uri]);
    links[0]?.activate(click);
    expect(opened).toEqual(["/tmp/한글 sheet.png"]);
    term.dispose();
  });

  it("rejects malformed or nonlocal file URIs", () => {
    for (const uri of ["file://host/tmp/a.png", "file:///tmp/%zz", "file:///tmp/%00", "https://example.com/a.png"])
      expect(fileUriPath(uri)).toBeNull();
    // a network share on a Windows PC, however its second separator is written, and a control character
    for (const uri of ["file:////attacker.example/share/doc.txt", "file:///%2Fattacker.example/share/doc.txt", "file:///%5C%5Cattacker.example/share", "file:///tmp/a.md\u0000", "file:///tmp/a\u001b.md"])
      expect(fileUriPath(uri)).toBeNull();
    // a control character written encoded is refused too: the server trimmed `%0A` and opened /etc/hosts
    for (const uri of ["file:///etc/hosts%0A", "file:///tmp/a%1B.md", "file:///tmp/a%7F.md"]) expect(fileUriPath(uri)).toBeNull();
    expect(fileUriPath("file:///tmp/Bob's-notes.md")).toBe("/tmp/Bob's-notes.md");
    // a Windows drive path loses the slash a URI puts before it
    expect(fileUriPath("file:///C:/Users/Alice/readme.md")).toBe("C:/Users/Alice/readme.md");
  });

  it("reads a long line of paths in one pass", async () => {
    // `(src/a.ts)` over and over as one wrapped line froze the page for seconds while hovering
    const term = await testTerminal({ cols: 200, rows: 40 });
    await written(term, "(src/a.ts)".repeat(700));
    expect(terminalFileLinks(term.buffer.active, 1, () => {})).toHaveLength(20);
    term.dispose();
    const blob = await testTerminal({ cols: 200, rows: 60 });
    await written(blob, "(src/a.ts)".repeat(900));
    expect(terminalFileLinks(blob.buffer.active, 1, () => {})).toEqual([]);
    blob.dispose();
  });

  it("does not link the tail of a line whose beginning scrolled off", async () => {
    const term = await testTerminal({ cols: 20, rows: 2, scrollback: 0 });
    await written(term, "file:///work/abcdefghijk/subdir/App.tsx\r\n");
    expect(term.buffer.active.getLine(0)?.isWrapped).toBe(true);
    expect(terminalFileLinks(term.buffer.active, 1, () => {})).toEqual([]);
    term.dispose();
  });

  it("keeps a name with a combining mark whole", async () => {
    const term = await testTerminal({ cols: 80 });
    await written(term, "see src/cafe\u0301/index.ts");
    const opened: string[] = [];
    const links = terminalFileLinks(term.buffer.active, 1, (path) => opened.push(path));
    expect(links).toHaveLength(1);
    links[0]?.activate(click);
    expect(opened).toEqual(["src/cafe\u0301/index.ts"]);
    term.dispose();
  });

  it("links a compiler's file(line,column) and leaves a call alone", async () => {
    const term = await testTerminal({ cols: 120 });
    await written(term, "src/App.tsx(120,8): error TS1000 lib/run.js(42) and lib/run.js(arg)");
    expect(terminalFileLinks(term.buffer.active, 1, () => {}).map((link) => link.text)).toEqual(["src/App.tsx", "lib/run.js"]);
    term.dispose();
  });

  it("ends a link on the last cell of a wide character", async () => {
    const term = await testTerminal({ cols: 80 });
    await written(term, "file:///tmp/한글");
    expect(terminalFileLinks(term.buffer.active, 1, () => {})[0]?.range).toEqual({ start: { x: 1, y: 1 }, end: { x: 16, y: 1 } });
    term.dispose();
  });

  it("opens nothing when the row no longer shows the link it was read from", async () => {
    const term = await testTerminal({ cols: 80 });
    await written(term, "open src/old.ts");
    const opened: string[] = [];
    const links = terminalFileLinks(term.buffer.active, 1, (path) => opened.push(path), undefined, () => term.buffer.active);
    expect(links.map((link) => link.text)).toEqual(["src/old.ts"]);
    // herdr repaints the row; xterm still holds the link it read before
    await written(term, "\r\u001b[2Kopen src/new.ts");
    links[0]?.activate(click);
    expect(opened).toEqual([]);
    await written(term, "\r\u001b[2Kopen src/foo.ts");
    const grown = terminalFileLinks(term.buffer.active, 1, (path) => opened.push(path), undefined, () => term.buffer.active);
    await written(term, "x");
    grown[0]?.activate(click);
    expect(opened).toEqual([]);
    terminalFileLinks(term.buffer.active, 1, (path) => opened.push(path))[0]?.activate(click);
    expect(opened).toEqual(["src/foo.tsx"]);
    term.dispose();
  });
  it("opens a link read on the normal screen when the alternate one comes up before the release", async () => {
    const term = await testTerminal({ cols: 80 });
    await written(term, "open src/report.ts");
    const opened: string[] = [];
    const links = await new Promise<ILink[] | undefined>((resolve) =>
      terminalFileLinkProvider(() => term.buffer.active, (path) => opened.push(path)).provideLinks(1, resolve));
    expect(links?.map((link) => link.text)).toEqual(["src/report.ts"]);
    // a full-screen program starts between the press and the release, before the next draw
    await written(term, "\x1b[?1049h");
    links?.[0]?.activate(click, links[0].text);
    expect(opened).toEqual(["src/report.ts"]);
    term.dispose();
  });
  it("opens the full path when a wide character wraps from the last column", async () => {
    const term = await testTerminal({ cols: 40 });
    await new Promise<void>((resolve) => term.write("check: ".padEnd(30) + "src/abc한글.ts", resolve));
    const opened: string[] = [];
    const links = terminalFileLinks(term.buffer.active, 2, (path) => opened.push(path));
    expect(links.map((link) => link.text)).toEqual(["src/abc한글.ts"]);
    links[0]?.activate(click);
    expect(opened).toEqual(["src/abc한글.ts"]);
    term.dispose();
  });
  it("leaves a bare file name alone: only a path with a folder in it, or a file URI, is a link", async () => {
    const term = await testTerminal({ cols: 120 });
    await new Promise<void>((resolve) => term.write("README.md package.json main.c\r\n M src/App.tsx\r\n?? ./notes.txt ~/x/a.md /etc/hosts.conf", resolve));
    const texts = (line: number) => terminalFileLinks(term.buffer.active, line, () => {}).map((link) => link.text);
    expect(texts(1)).toEqual([]);
    expect(texts(2)).toEqual(["src/App.tsx"]);
    expect(texts(3)).toEqual(["./notes.txt", "~/x/a.md", "/etc/hosts.conf"]);
    term.dispose();
  });
  it("opens a bare file name on Cmd+click (Ctrl+click off a Mac) only, drawn while the key is held", async () => {
    const term = await testTerminal({ cols: 120 });
    await written(term, "설계 문서를 다시 썼습니다(11_two-version-design.md, push 완료). see src/App.tsx process.env Math.random 1.2.3");
    for (const mac of [true, false]) {
      const bare = bareNameLinks(mac);
      const opened: string[] = [];
      const links = terminalFileLinks(term.buffer.active, 1, (path) => opened.push(path), bare);
      expect(links.map((link) => link.text)).toEqual(["11_two-version-design.md", "src/App.tsx"]);
      const [name, folder] = links;
      expect({ ...name?.decorations }).toEqual({ pointerCursor: false, underline: false });
      expect(folder?.decorations).toBeUndefined();
      const cmd = { button: 0, metaKey: true, ctrlKey: false } as MouseEvent;
      const ctrl = { button: 0, metaKey: false, ctrlKey: true } as MouseEvent;
      name?.activate(click);
      name?.activate(mac ? ctrl : cmd);
      expect(opened).toEqual([]);
      bare.update(mac ? cmd : ctrl);
      expect({ ...name?.decorations }).toEqual({ pointerCursor: true, underline: true });
      name?.activate(mac ? cmd : ctrl);
      folder?.activate(click);
      expect(opened).toEqual(["11_two-version-design.md", "src/App.tsx"]);
      bare.reset();
      expect({ ...name?.decorations }).toEqual({ pointerCursor: false, underline: false });
    }
    term.dispose();
  });
  it("redraws only the link under the pointer as the key goes down and up, and on a second hover", async () => {
    const term = await testTerminal({ cols: 120 });
    await written(term, "a.md b.md src/c.md");
    const bare = bareNameLinks(false);
    const [first, second, folder] = terminalFileLinks(term.buffer.active, 1, () => {}, bare);
    // what xterm 5.5's Linkifier does (_handleNewLink, _linkHover, _linkLeave): a hovered link's
    // drawing is read from its decorations, which are then swapped for an object whose getters and
    // setters reach the link hovered now. A link hovered again on its row is read from that object
    // while it still answers with how the link was drawn when the pointer left it.
    type Drawn = { pointerCursor: boolean; underline: boolean };
    const states = new Map<object, { state?: Drawn }>();
    let current: { state?: Drawn } | undefined;
    const hover = (link: typeof first) => {
      const entry = states.get(link!) ?? {};
      states.set(link!, entry);
      current = entry;
      entry.state = {
        pointerCursor: link!.decorations === undefined ? true : link!.decorations.pointerCursor,
        underline: link!.decorations === undefined ? true : link!.decorations.underline,
      };
      link!.hover?.({} as MouseEvent, link!.text);
      const decorations = {} as Drawn;
      Object.defineProperties(decorations, {
        pointerCursor: { get: () => current?.state?.pointerCursor, set: (on: boolean) => { if (current?.state) current.state.pointerCursor = on; } },
        underline: { get: () => current?.state?.underline, set: (on: boolean) => { if (current?.state) current.state.underline = on; } },
      });
      link!.decorations = decorations;
    };
    const leave = (link: typeof first) => {
      link!.leave?.({} as MouseEvent, link!.text);
      current = undefined;
    };
    const drawn = () => current?.state && { ...current.state };
    const ctrl = (down: boolean) => bare.update({ metaKey: false, ctrlKey: down });
    hover(first);
    expect(drawn()).toEqual({ pointerCursor: false, underline: false });
    ctrl(true);
    expect(drawn()).toEqual({ pointerCursor: true, underline: true });
    ctrl(false);
    expect(drawn()).toEqual({ pointerCursor: false, underline: false });
    ctrl(true);
    leave(first);
    ctrl(false);
    hover(first);
    expect(drawn()).toEqual({ pointerCursor: false, underline: false });
    leave(first);
    ctrl(true);
    hover(first);
    expect(drawn()).toEqual({ pointerCursor: true, underline: true });
    leave(first);
    expect(folder?.decorations).toBeUndefined();
    hover(folder);
    ctrl(false);
    expect(drawn()).toEqual({ pointerCursor: true, underline: true });
    leave(folder);
    hover(second);
    expect(drawn()).toEqual({ pointerCursor: false, underline: false });
    ctrl(true);
    expect(drawn()).toEqual({ pointerCursor: true, underline: true });
    bare.reset();
    expect(drawn()).toEqual({ pointerCursor: false, underline: false });
    term.dispose();
  });
  it("recognizes files with line and column suffixes", async () => {
    const term = await testTerminal({ cols: 100 });
    await new Promise<void>((resolve) => term.write("see src/app.ts:42:3 and README.md", resolve));
    const opened: string[] = [];
    const links = terminalFileLinks(term.buffer.active, 1, (path) => opened.push(path), undefined, () => term.buffer.active);
    expect(links.map((link) => link.text)).toEqual(["src/app.ts:42:3"]);
    links[0]?.activate(click);
    expect(opened).toEqual(["src/app.ts:42:3"]);
    term.dispose();
  });

  it("opens the first-line anchor and range intact across wrapped rows", async () => {
    const term = await testTerminal({ cols: 20 });
    await written(term, "see src/app.ts#L42-L48");
    const opened: string[] = [];
    const links = terminalFileLinks(term.buffer.active, 2, (path) => opened.push(path));
    expect(links.map((link) => link.text)).toEqual(["src/app.ts#L42-L48"]);
    links[0]?.activate(click);
    expect(opened).toEqual(["src/app.ts#L42-L48"]);
    term.dispose();
  });

  it("keeps cell coordinates after Korean text and across wrapped lines", async () => {
    const term = await testTerminal({ cols: 20 });
    await new Promise<void>((resolve) => term.write("확인 src/폴더/example.ts", resolve));
    const links = terminalFileLinks(term.buffer.active, 2, () => {});
    expect(links.map((link) => link.text)).toEqual(["src/폴더/example.ts"]);
    expect(links[0]?.range).toEqual({ start: { x: 6, y: 1 }, end: { x: 4, y: 2 } });
    term.dispose();
  });

  it("does not turn URLs, versions or ordinary words into file links", async () => {
    const term = await testTerminal({ cols: 150 });
    await new Promise<void>((resolve) => term.write("https://example.com/src/app.ts v1.2.3 1.2.3 and/or", resolve));
    expect(terminalFileLinks(term.buffer.active, 1, () => {})).toEqual([]);
    term.dispose();
  });
});
