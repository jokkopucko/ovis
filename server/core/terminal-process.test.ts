import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as herdr from "../herdr/client.ts";
import { attachScreenStarted, createSpawnAttachment, type PaneAttachment, screenGrid } from "./terminal-process.ts";

// herdr 0.9.5 `terminal attach`, captured through the Rust PTY host with its two startup queries
// taken out (AttachStartupProbes): the setup, then a screen or a refusal's teardown and line
const MOUSE_OFF = "\x1b[?1006l\x1b[?1016l\x1b[?1015l\x1b[?1005l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?9l";
const SETUP = `${MOUSE_OFF}\x1b[?1049h${MOUSE_OFF}\x1b[?2031l${MOUSE_OFF}\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1015h\x1b[?1006h\x1b[?2004h\x1b[?7l`;
const TEARDOWN = `\x1b[?7h\x1b[?1004l\x1b[?2004l${MOUSE_OFF}\x1b[?1006l\x1b[?1015l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1049l\x1b[?25h\x1b[0 q`;
const REFUSALS = [
  "herdr: server shut down: terminal attach failed: terminal term_0 already has an attached client; retry with --takeover\r\n",
  "herdr: server shut down: terminal attach failed: terminal term_0 has a read in progress; retry\r\n",
];
const SCREEN = "\x1b[?2026h\x1b[?25l\x1b]8;;\x1b\\\x1b[2J\x1b[1;1H\x1b[0;39;49mbash-5.3$ echo PROBE-READY";

describe("attachScreenStarted", () => {
  it("never takes any part of a refusal for a screen, at whatever byte its reads end", () => {
    for (const line of REFUSALS) {
      const output = SETUP + TEARDOWN + line;
      for (let end = 0; end <= output.length; end++) expect([end, attachScreenStarted(output.slice(0, end))]).toEqual([end, false]);
    }
    // a teardown with control sequences or a line break 0.9.5 does not write still waits
    const other = `${SETUP}\x1b[>4;0m\x1b[<u${TEARDOWN}\r\n${REFUSALS[0]}`;
    for (let end = 0; end <= other.length; end++) expect([end, attachScreenStarted(other.slice(0, end))]).toEqual([end, false]);
    // the words of a takeover's diagnostic without herdr's prefix
    expect(attachScreenStarted("terminal attach taken over\r\n")).toBe(false);
  });
  it("takes a screen only from its first printable text, never from an escape alone", () => {
    expect(attachScreenStarted(SETUP)).toBe(false);
    // the OSC (its hyperlink reset), the clear and the colours come first: none of them is the screen yet
    const first = SETUP.length + SCREEN.indexOf("bash");
    for (let end = 0; end <= first; end++) expect([end, attachScreenStarted((SETUP + SCREEN).slice(0, end))]).toEqual([end, false]);
    // an OSC title, a cursor save or an escape cut short, before a refusal (#2255 review)
    for (const lead of ["\x1b]", "\x1b]0;title", "\x1b]0;title\x07", "\x1b7", "\x1b8\x1b(B", "\x1b[", "\x1b[?10"]) {
      expect([lead, attachScreenStarted(SETUP + lead)]).toEqual([lead, false]);
      expect([lead, attachScreenStarted(SETUP + lead + REFUSALS[0])]).toEqual([lead, false]);
    }
    for (let end = first + 1; end <= SETUP.length + SCREEN.length; end++) expect([end, attachScreenStarted((SETUP + SCREEN).slice(0, end))]).toEqual([end, true]);
    // a screen whose first text is not a refusal's start
    expect(attachScreenStarted(`${SETUP}pane text: has a read in progress; retry\r\n`)).toBe(true);
  });
});

/** herdr 0.9.5's whole screen of a bash prompt, byte for byte as captured: its first one clears, the redraw for a new grid does not */
function wholeScreen(cols: number, rows: number, first = false): string {
  let rest = "";
  for (let row = 2; row <= rows; row++) rest += `\x1b[${row};1H${" ".repeat(cols)}`;
  return `\x1b[?2026h\x1b[?25l\x1b]8;;\x1b\\${first ? "\x1b[2J" : ""}\x1b[1;1H\x1b[0;39;49m${"bash-5.3$ ".padEnd(cols)}${rest}\x1b[0m\x1b[1;11H\x1b[?25h\x1b[?2026l\x1b[1;11H\x1b[?25h`;
}

/** the body of one of herdr's updates: what is between its markers */
const body = (update: string): string => update.slice(update.indexOf("\x1b[?2026h") + 8, update.indexOf("\x1b[?2026l"));

describe("screenGrid", () => {
  it("reads the grid a whole screen was drawn at", () => {
    expect(screenGrid(body(wholeScreen(80, 24, true)))).toEqual({ cols: 80, rows: 24 });
    expect(screenGrid(body(wholeScreen(91, 27)))).toEqual({ cols: 91, rows: 27 });
    // the cursor herdr places before the update ends at column 1 (a command running on the next line): one more row move, no text
    expect(screenGrid(body(wholeScreen(91, 27).replaceAll("\x1b[1;11H", "\x1b[2;1H")))).toEqual({ cols: 91, rows: 27 });
  });
  it("takes no update that does not draw every row, or whose plain rows differ in width, for a screen", () => {
    // an update of a few rows, as a program printing between screens gives
    expect(screenGrid("\x1b[3;1Hline\x1b[4;1H\x1b[K")).toBeNull();
    expect(screenGrid(`\x1b[1;1H${"a".repeat(80)}\x1b[2;1Hshort`)).toBeNull();
  });
  it("reads the width from plain rows only, never from text whose width tables disagree (#2289 review)", () => {
    // herdr gives each "\u0915\u093e" two cells and Bun one: 11 of them and 69 spaces are herdr's 91 columns
    const marks = "\u0915\u093e".repeat(11) + " ".repeat(69);
    let rest = "";
    for (let row = 2; row <= 24; row++) rest += `\x1b[${row};1H${" ".repeat(91)}`;
    expect(screenGrid(`\x1b[1;1H${marks}${rest}`)).toEqual({ cols: 91, rows: 24 });
    // a screen with no plain row says nothing of its width
    expect(screenGrid(`\x1b[1;1H${marks}`)).toBeNull();
  });
});

describe("spawnAttachment", () => {
  afterEach(() => mock.restore());

  it("waits for a process retiring under the pane's ID that a move set while the terminal was looked up (#1503)", async () => {
    const looked = Promise.withResolvers<void>();
    spyOn(herdr, "sessionSnapshot").mockImplementation((async () => {
      looked.resolve();
      return { panes: [{ pane_id: "B", terminal_id: "t1" }], layouts: [] };
    }) as unknown as typeof herdr.sessionSnapshot);
    // the mirror's first read never ends: the test watches the attachment's creation only
    spyOn(herdr, "paneRead").mockImplementation((() => new Promise(() => {})) as unknown as typeof herdr.paneRead);
    const attachments = new Map<string, PaneAttachment>();
    const retiring = new Map<string, Promise<void>>();
    const mode = Promise.withResolvers<boolean>();
    const { spawnAttachment } = createSpawnAttachment({
      attachments, retiringAttachments: retiring, terminalAttach: () => mode.promise, isStopped: () => false,
      closeAttachment() {}, broadcast() {}, sendOutput() {}, reconcileOutput() {}, holdPendingPane() {}, inputReady() {},
      holdFor: 0, heldRetry: 0, retryFor: 0, relookupFor: 0,
    });
    const spawning = spawnAttachment("B", 80, 24, false);
    // the move lands after the entry check: the old ID's process still holds herdr's slot
    const exited = Promise.withResolvers<void>();
    retiring.set("B", exited.promise);
    mode.resolve(false);
    await looked.promise;
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(attachments.has("B")).toBe(false);
    exited.resolve();
    const made = await spawning;
    expect(attachments.get("B")).toBe(made);
    made.process.kill();
  });
});
