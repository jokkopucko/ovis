import { expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import { createSecretScreen } from "./secretScreen.ts";
import { matchHerdrWidths } from "./terminalWidths.ts";

const parse = (term: Terminal, data: string): Promise<void> => new Promise((resolve) => term.write(data, resolve));
const terminal = (cols: number, rows = 10): Terminal => {
  const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  matchHerdrWidths(term);
  return term;
};
/** What herdr's attach sends before its first screen: the alternate screen, where a resize joins no rows, and no wrap. */
const SETUP = "\x1b[?1049h\x1b[?7l";
/** A terminal as an attached pane's is once herdr's attach has begun. */
const attached = async (cols: number, rows = 10): Promise<Terminal> => {
  const term = terminal(cols, rows);
  await parse(term, SETUP);
  return term;
};

/**
 * One screen as herdr's attach stream draws it: inside a synchronized update, every row at its own place with
 * every cell written, and the cursor last. No row is a wrapped continuation of the one above.
 */
const frame = (cols: number, rows: string[], [row, column]: [number, number]): string =>
  `\x1b[?2026h\x1b[?25l${rows.map((text, index) => `\x1b[${index + 1};1H${text.padEnd(cols)}`).join("")}\x1b[${row + 1};${column + 1}H\x1b[?25h\x1b[?2026l`;

const GIT = "Password for 'https://alice@github.com':";

test("a prompt asks while the cursor is on its line, and is answered once the cursor has left it", async () => {
  const term = await attached(80);
  const screen = createSecretScreen(term, () => true);
  try {
    await parse(term, frame(80, ["$ git push", `${GIT} `, "", ""], [1, 41]));
    expect(screen.read("a")).toBe(GIT);
    // git read the answer and printed its line break: the prompt is still the last text
    await parse(term, frame(80, ["$ git push", `${GIT} `, "", ""], [2, 0]));
    expect(screen.read("a")).toBeNull();
    // asked again in place, as after a wrong password
    await parse(term, frame(80, ["$ git push", `${GIT} `, `${GIT} `, ""], [2, 41]));
    expect(screen.read("a")).toBe(GIT);
    // at the screen's last row the answer's line break scrolls the prompt up, which herdr redraws a row higher
    await parse(term, frame(80, ["a", "b", "c", "d", "e", "f", "g", "h", "$ git push", `${GIT} `], [9, 41]));
    expect(screen.read("a")).toBe(GIT);
    await parse(term, frame(80, ["b", "c", "d", "e", "f", "g", "h", "$ git push", `${GIT} `, ""], [9, 0]));
    expect(screen.read("a")).toBeNull();
  } finally { term.dispose(); }
});

test("a prompt printed with its line break and read on the row below asks, whose cursor was never on it", async () => {
  const term = await attached(80);
  const screen = createSecretScreen(term, () => true);
  try {
    await parse(term, frame(80, ["$ ./setup.sh", "Password:", "", ""], [2, 0]));
    expect(screen.read("a")).toBe("Password:");
    await parse(term, frame(80, ["$ ./setup.sh", "Password:", "", ""], [2, 0]));
    expect(screen.read("a")).toBe("Password:");
  } finally { term.dispose(); }
});

test("what was seen of one pane's prompt says nothing of the next pane's", async () => {
  const term = await attached(80);
  const screen = createSecretScreen(term, () => true);
  try {
    // pane A runs a script that waits at `Password: ` with the cursor on it
    await parse(term, frame(80, ["$ ./setup.sh", "Password: ", "", ""], [1, 10]));
    expect(screen.read("a")).toBe("Password:");
    // the terminal is switched to pane B, where the same script printed the same words and reads below them: the
    // line above is the same too, so only the pane tells the two apart
    term.reset();
    await parse(term, SETUP);
    await parse(term, frame(80, ["$ ./setup.sh", "Password:", "", ""], [2, 0]));
    expect(screen.read("b")).toBe("Password:");
  } finally { term.dispose(); }
});

test("an answered prompt stays answered when its own pane's screen is drawn again", async () => {
  const term = await attached(80);
  const screen = createSecretScreen(term, () => true);
  try {
    await parse(term, SETUP + frame(80, ["$ git push", `${GIT} `, "", ""], [1, 41]));
    expect(screen.read("a")).toBe(GIT);
    await parse(term, frame(80, ["$ git push", `${GIT} `, "", ""], [2, 0]));
    expect(screen.read("a")).toBeNull();
    // a phone lets the pane go when the page is hidden and takes it again: the terminal is reset and redrawn
    await parse(term, "\x1bc");
    await parse(term, SETUP + frame(80, ["$ git push", `${GIT} `, "", ""], [2, 0]));
    expect(screen.read("a")).toBeNull();
    // a reconnect redraws without the reset
    await parse(term, SETUP + frame(80, ["$ git push", `${GIT} `, "", ""], [2, 0]));
    expect(screen.read("a")).toBeNull();
  } finally { term.dispose(); }
});

test("an answered prompt stays answered when the pane's width changes and the line above it is drawn another way", async () => {
  const term = await attached(80);
  const screen = createSecretScreen(term, () => true);
  const command = "alice@laptop:~/work/some-project (main)$ git push";
  try {
    await parse(term, frame(80, [command, "Password: ", "", ""], [1, 10]));
    expect(screen.read("a")).toBe("Password:");
    await parse(term, frame(80, [command, "Password: ", "", ""], [2, 0]));
    expect(screen.read("a")).toBeNull();
    // the phone is turned: 40 columns, the command over two rows
    term.resize(40, 10);
    await parse(term, frame(40, [command.slice(0, 40), command.slice(40), "Password: ", "", ""], [3, 0]));
    expect(screen.read("a")).toBeNull();
  } finally { term.dispose(); }
});

test("an answered prompt stays answered when the line above it scrolls off the screen", async () => {
  const term = await attached(80, 2);
  const screen = createSecretScreen(term, () => true);
  try {
    await parse(term, frame(80, ["$ sudo true", "Password: "], [1, 10]));
    expect(screen.read("a")).toBe("Password:");
    // the answer's line break scrolls the command away: the prompt is the first row, the cursor on the empty second
    await parse(term, frame(80, ["Password: ", ""], [1, 0]));
    expect(screen.read("a")).toBeNull();
  } finally { term.dispose(); }
});

test("a prompt of the same words printed below an answered one is another asking", async () => {
  const term = await attached(80);
  const screen = createSecretScreen(term, () => true);
  try {
    await parse(term, frame(80, ["$ ./ask", "Password: ", "", "", ""], [1, 10]));
    expect(screen.read("a")).toBe("Password:");
    // answered, and before the next frame the script prints the words again with a line break and reads below them
    await parse(term, frame(80, ["$ ./ask", "Password: ", "Password:", "", ""], [3, 0]));
    expect(screen.read("a")).toBe("Password:");
    // that one answered in turn: nothing new was printed, and the cursor was never on it, so it asks as before
    await parse(term, frame(80, ["$ ./ask", "Password: ", "Password:", "", ""], [3, 0]));
    expect(screen.read("a")).toBe("Password:");
  } finally { term.dispose(); }
});

test("a third prompt of the same words, read below its line, is not the second one answered", async () => {
  const term = await attached(80);
  const screen = createSecretScreen(term, () => true);
  try {
    await parse(term, frame(80, ["$ ./ask", "Password: ", "", "", "", ""], [1, 10]));
    expect(screen.read("a")).toBe("Password:");
    // the second asks on its line too, and is answered
    await parse(term, frame(80, ["$ ./ask", "Password: ", "Password: ", "", "", ""], [2, 10]));
    expect(screen.read("a")).toBe("Password:");
    await parse(term, frame(80, ["$ ./ask", "Password: ", "Password: ", "", "", ""], [3, 0]));
    expect(screen.read("a")).toBeNull();
    // the third is printed with its line break and read below it: the line above it reads as the second's did
    await parse(term, frame(80, ["$ ./ask", "Password: ", "Password: ", "Password:", "", ""], [4, 0]));
    expect(screen.read("a")).toBe("Password:");
  } finally { term.dispose(); }
});

test("an answered prompt under others of its words stays answered when the first of them scrolls off", async () => {
  const term = await attached(80, 3);
  const screen = createSecretScreen(term, () => true);
  try {
    // the third asking, the two before it filling the screen above
    await parse(term, frame(80, ["Password: ", "Password: ", "Password: "], [2, 10]));
    expect(screen.read("a")).toBe("Password:");
    // its answer scrolls the first one away: one line of the same words is left above it
    await parse(term, frame(80, ["Password: ", "Password: ", ""], [2, 0]));
    expect(screen.read("a")).toBeNull();
  } finally { term.dispose(); }
});

test("a prompt herdr draws over two rows, printed again below an answered one, is not told from it, as before", async () => {
  // only a line of the same words directly above tells two askings apart, and this prompt's last row has its first above it
  const term = await attached(30);
  const screen = createSecretScreen(term, () => true);
  const [first, second] = [GIT.slice(0, 30), GIT.slice(30)];
  try {
    await parse(term, frame(30, ["$ git push", first, `${second} `, "", "", "", ""], [2, 11]));
    expect(screen.read("a")).toBe(GIT);
    await parse(term, frame(30, ["$ git push", first, `${second} `, "", "", "", ""], [3, 0]));
    expect(screen.read("a")).toBeNull();
    await parse(term, frame(30, ["$ git push", first, `${second} `, first, second, "", ""], [5, 0]));
    expect(screen.read("a")).toBeNull();
  } finally { term.dispose(); }
});

test("an answered prompt stays answered while a line above it changes", async () => {
  const term = await attached(80);
  const screen = createSecretScreen(term, () => true);
  try {
    // tmux with its status line at the top, a clock in it
    await parse(term, frame(80, ["[0] 0:bash*                                                  12:34", "$ git push", `${GIT} `, ""], [2, 41]));
    expect(screen.read("a")).toBe(GIT);
    await parse(term, frame(80, ["[0] 0:bash*                                                  12:34", "$ git push", `${GIT} `, ""], [3, 0]));
    expect(screen.read("a")).toBeNull();
    await parse(term, frame(80, ["[0] 0:bash*                                                  12:35", "$ git push", `${GIT} `, ""], [3, 0]));
    expect(screen.read("a")).toBeNull();
  } finally { term.dispose(); }
});

test("a prompt that went away and is printed again, read below its line, asks", async () => {
  const term = await attached(80);
  const screen = createSecretScreen(term, () => true);
  try {
    await parse(term, frame(80, ["$ ./ask", "Password: ", "", "", ""], [1, 10]));
    expect(screen.read("a")).toBe("Password:");
    await parse(term, frame(80, ["$ ./ask", "Password: ", "", "", ""], [2, 0]));
    expect(screen.read("a")).toBeNull();
    // the answer was wrong: the script says so, which ends that asking, and prints its prompt again with a line break
    await parse(term, frame(80, ["$ ./ask", "Password: ", "Wrong.", "", ""], [3, 0]));
    expect(screen.read("a")).toBeNull();
    await parse(term, frame(80, ["$ ./ask", "Password: ", "Wrong.", "Password:", ""], [4, 0]));
    expect(screen.read("a")).toBe("Password:");
  } finally { term.dispose(); }
});

test("a row is read as wide as the pane is now, not as it was drawn when the pane was wider", async () => {
  // herdr draws on the alternate screen, where xterm keeps a row's cells past a narrower edge, and its redraw for
  // a new grid clears nothing
  const listing = ["-rw-r--r-- 1 alice alice  48213 Nov 11 10:02 quarterly-report-final.pdf", "-rw-r--r-- 1 alice alice   1178 Nov 11 10:02 notes-from-the-planning-call.txt"];
  const term = await attached(80, 8);
  const screen = createSecretScreen(term, () => true);
  const sudo = "[sudo] password for alice:";
  try {
    await parse(term, frame(80, ["$ ls -l", "total 56", ...listing, "$ cd work", "$ git status -s", "$ "], [6, 2]));
    expect(screen.read("a")).toBeNull();
    term.resize(40, 8);
    const narrow = [listing[0]!.slice(0, 40), listing[0]!.slice(40), listing[1]!.slice(0, 40), listing[1]!.slice(40)];
    // sudo asks on the last row, on rows that held the listing's right half
    await parse(term, frame(40, [...narrow, "$ cd work", "$ git status -s", "$ sudo true", `${sudo} `], [7, 27]));
    expect(screen.read("a")).toBe(sudo);
    // its answer scrolls the screen a row
    await parse(term, frame(40, [...narrow.slice(1), "$ cd work", "$ git status -s", "$ sudo true", `${sudo} `, ""], [7, 0]));
    expect(screen.read("a")).toBeNull();
  } finally { term.dispose(); }
  // and a prompt wider than the new width, redrawn over two rows while it asks, is still read
  const git = await attached(80, 6);
  const gitScreen = createSecretScreen(git, () => true);
  try {
    await parse(git, frame(80, ["$ git push", `${GIT} `], [1, 41]));
    expect(gitScreen.read("a")).toBe(GIT);
    git.resize(30, 6);
    await parse(git, frame(30, ["$ git push", GIT.slice(0, 30), `${GIT.slice(30)} `], [2, 11]));
    expect(gitScreen.read("a")).toBe(GIT);
  } finally { git.dispose(); }
});

test("on a stream of the program's own bytes, a long line cut by the screen's top does not undo an answer", async () => {
  // a herdr-core pane with history: the line above the command starts off screen, and each scroll shows less of it
  const term = new Terminal({ cols: 40, rows: 8, scrollback: 2000, allowProposedApi: true });
  matchHerdrWidths(term);
  const screen = createSecretScreen(term, () => true);
  const sudo = "[sudo] password for alice:";
  try {
    await parse(term, `$ cat notes\r\nremote: ${"x".repeat(267)}\r\n$ sudo -k true\r\n${sudo} `);
    expect(screen.read("a")).toBe(sudo);
    await parse(term, "\r\n");
    expect(screen.read("a")).toBeNull();
  } finally { term.dispose(); }
});

test("on a stream of the program's own bytes, a prompt xterm wrapped is answered by a line feed alone", async () => {
  // a herdr-core pane: xterm wraps the 40-column prompt at 30 columns itself and joins its rows
  const term = terminal(30);
  const screen = createSecretScreen(term, () => true);
  try {
    await parse(term, `$ git push\r\n${GIT} `);
    expect(screen.read("a")).toBe(GIT);
    // a reader in raw mode ends its line with a line feed: the cursor is on the next row, past its start
    await parse(term, "\n");
    expect(screen.read("a")).toBeNull();
  } finally { term.dispose(); }
  // and one that fills its row exactly still asks from the row below, where its wrapped space is
  const edge = terminal(40);
  const edgeScreen = createSecretScreen(edge, () => true);
  try {
    await parse(edge, `$ git push\r\n${GIT} `);
    expect(edgeScreen.read("a")).toBe(GIT);
    await parse(edge, "\r\n");
    expect(edgeScreen.read("a")).toBeNull();
  } finally { edge.dispose(); }
});

test("a pane whose cursor is not known keeps its prompt while it is the last text", async () => {
  const term = await attached(80);
  const screen = createSecretScreen(term, () => false);
  try {
    await parse(term, frame(80, ["$ git push", `${GIT} `, "", ""], [1, 41]));
    expect(screen.read("a")).toBe(GIT);
    await parse(term, frame(80, ["$ git push", `${GIT} `, "", ""], [2, 0]));
    expect(screen.read("a")).toBe(GIT);
  } finally { term.dispose(); }
});
