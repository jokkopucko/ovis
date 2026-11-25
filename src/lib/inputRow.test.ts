import { describe, expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { FrameGate, inputRowState, readScreen, readScreenLines, readsInputRow, type InputRowState, type ScreenSnapshot } from "./inputRow.ts";
import { matchHerdrWidths } from "./terminalWidths.ts";
import { drawsColour, screenFromAnsi, typedDraft } from "../../shared/input-row.ts";
import { SCREEN_AUTO_RETURN, watchReturn } from "./terminalPeek.ts";

const FIXTURES = join(import.meta.dir, "fixtures-input-rows");
const CLAUDE = join(import.meta.dir, "../../server/fixtures");

const parse = (term: Terminal, data: string): Promise<void> => new Promise((resolve) => term.write(data, resolve));
const terminal = (cols: number, rows = 40): Terminal => {
  const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  matchHerdrWidths(term);
  return term;
};

test("logical screen lines preserve spaces across wraps but not hard line breaks", async () => {
  const term = terminal(40, 5);
  const text = `${"a".repeat(39)} b`;
  try {
    await parse(term, `${text}\r\nnext`);
    expect(readScreenLines(term.buffer.active, term.rows)).toEqual([text, "next", "", ""]);
  } finally {
    term.dispose();
  }
});

test("logical screen lines reject a wrapped line clipped at the screen top", async () => {
  const term = terminal(40, 2);
  try {
    await parse(term, `${"a".repeat(81)}\r\nnext`);
    expect(readScreenLines(term.buffer.active, term.rows)).toBeNull();
  } finally {
    term.dispose();
  }
});

async function screenOf(text: string, cols: number): Promise<ScreenSnapshot> {
  const term = terminal(cols);
  const rows = text.replace(/\r/g, "").split("\n").slice(0, 40);
  await parse(term, rows.map((row, index) => `\u001b[${index + 1};1H${row}`).join(""));
  const screen = readScreen(term.buffer.active, term.cols, term.rows);
  term.dispose();
  return screen;
}
const columnsOf = (name: string): number => Number(/-(\d+)\.(?:ansi|txt)$/.exec(name)![1]);
async function recorded(agent: string, name: string): Promise<InputRowState | null> {
  const file = `${name}.ansi`;
  return inputRowState(agent, await screenOf(readFileSync(join(FIXTURES, agent, file), "utf8"), columnsOf(file)));
}

async function replay(agent: string, name: string): Promise<(InputRowState | null)[]> {
  const frames = readFileSync(join(FIXTURES, agent, `${name}.frames.jsonl`), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { cols: number; rows: number; data: string });
  const term = terminal(frames[0]!.cols, frames[0]!.rows);
  const gate = new FrameGate();
  term.onResize(() => gate.resized());
  const states: (InputRowState | null)[] = [];
  for (const frame of frames) {
    if (frame.cols !== term.cols || frame.rows !== term.rows) term.resize(frame.cols, frame.rows);
    const cut = Math.floor(frame.data.length / 2);
    for (const part of [frame.data.slice(0, cut), frame.data.slice(cut)]) {
      const stamp = gate.enqueue(part, true);
      await parse(term, part);
      if (gate.settle(stamp, true)) states.push(inputRowState(agent, readScreen(term.buffer.active, term.cols, term.rows)));
      else expect(part).toBe(frame.data.slice(0, cut));
    }
  }
  term.dispose();
  return states;
}

function watch(agent: string, states: readonly (InputRowState | null)[]): { armed: boolean; returnedAt: number | null; manualAt: number | null } {
  let armed = false;
  for (const [index, state] of states.entries()) {
    if (state === null) continue;
    const step = watchReturn(agent, armed, state);
    if (step.step === "return") return { armed, returnedAt: index, manualAt: null };
    if (step.step === "manual") return { armed, returnedAt: null, manualAt: index };
    armed = step.armed;
  }
  return { armed, returnedAt: null, manualAt: null };
}

const EXPECTED: Record<string, Record<string, InputRowState>> = {
  claude: {
    "btw-open-119": "gone", "btw-closed-119": "ready", "btw-open-fullscreen-119": "gone", "btw-closed-fullscreen-119": "ready",
  },
  codex: {
    "permissions-idle-120": "ready", "permissions-idle-40": "ready", "permissions-open-120": "gone", "permissions-open-40": "gone",
    "permissions-closed-120": "ready", "permissions-closed-40": "ready",
    "theme-open-120": "gone", "theme-open-40": "gone", "statusline-open-120": "gone", "statusline-open-40": "gone",
    // /rename's field has the empty composer's very cells: its footer tells it apart
    "rename-open-120": "gone", "rename-open-40": "gone", "rename-closed-40": "ready",
    // the /diff pager: Escape does nothing, q closes it
    "diff-open-120": "gone", "diff-open-40": "gone", "diff-closed-120": "gone", "diff-closed-q-120": "ready", "diff-closed-q-40": "ready",
    "cd-untrusted-repo-open-120": "gone", "cd-untrusted-repo-open-40": "gone", "cd-untrusted-repo-closed-120": "ready",
    // /mention leaves `@` in the composer
    "mention-closed-120": "draft",
  },
  omp: {
    "settings-idle-119": "ready", "settings-idle-40": "ready", "settings-open-119": "gone", "settings-open-40": "gone",
    "settings-closed-119": "ready", "settings-closed-40": "ready",
    // /context's `⎋ to close` box over a status bar and an editor that both stay drawn at 119 columns
    "context-open-119": "covered", "context-open-40": "gone", "context-closed-119": "ready",
    "btw-open-119": "gone", "btw-open-40": "gone", "switch-open-119": "gone",
    // /plan prints and keeps the editor: never armed, it stays manual
    "plan-open-119": "ready",
    // omp 18.14 drops the status bar's frame: the peek (18.8.7's shape) does not make it out; the draft check does
    "draft-empty-119": "gone", "draft-typed-119": "gone", "draft-lines-119": "gone", "draft-slash-119": "gone",
  },
  pi: {
    "draft-empty-119": "ready", "draft-typed-119": "draft", "draft-slash-119": "gone",
    // pi 1.5.2 with pi-powerline-footer 0.22.0, its status bar above the editor
    "powerline-draft-empty-200": "ready", "powerline-draft-typed-200": "draft", "powerline-draft-multiline-200": "draft",
    // its turn's spinner in the upper border (`── ⠸ Working ──`)
    "powerline-working-typed-200": "draft",
    "settings-idle-119": "ready", "settings-idle-40": "ready", "settings-open-119": "gone", "settings-open-40": "gone",
    "settings-closed-119": "ready", "settings-closed-40": "ready",
    "tree-open-119": "gone", "tree-open-40": "gone", "resume-open-119": "gone", "resume-open-40": "gone",
    "scoped-models-open-119": "gone", "scoped-models-open-40": "gone",
    // printed under the editor, which stays
    "hotkeys-open-119": "ready",
  },
  gjc: {
    "settings-idle-119": "ready", "settings-idle-40": "ready", "settings-open-119": "gone", "settings-open-40": "gone",
    "settings-closed-119": "ready", "settings-closed-40": "ready",
    "model-open-119": "gone", "model-open-40": "gone", "transcript-open-119": "gone", "transcript-open-40": "gone",
    // /sessions keeps the empty box for 10 to 15 s before its list draws
    "sessions-open-early-119": "ready", "sessions-open-loading10s-119": "ready", "sessions-closed-119": "ready",
    "session-delete-after-first-enter-119": "draft",
    "draft-empty-119": "ready", "draft-typed-119": "draft", "draft-slash-119": "draft",
  },
  omo: {
    "draft-empty-119": "ready", "draft-typed-119": "draft", "draft-slash-119": "gone",
    "settings-idle-119": "ready", "settings-idle-40": "ready", "settings-open-119": "gone", "settings-open-40": "gone",
    "settings-closed-119": "ready", "settings-closed-40": "ready",
    // dialogs draw a bare `>` under one rule
    "rename-open-119": "gone", "rename-open-40": "gone", "trust-open-119": "gone", "trust-open-40": "gone", "share-open-119": "gone",
    "btw-open-119": "ready", "btw-typed-autocomplete-119": "draft",
  },
  hermes: {
    "model-idle-120": "ready", "model-idle-40": "ready", "model-closed-120": "ready", "model-closed-40": "ready",
    // the picker and the palette hide the status bar over an empty row; a confirmation replaces the row
    "model-open-120": "covered", "model-open-40": "covered", "palette-open-120": "covered",
    "reload-mcp-open-120": "covered", "reload-mcp-open-40": "covered", "reload-mcp-closed-120": "ready", "reload-mcp-closed-40": "ready",
    "new-open-120": "covered", "new-open-40": "covered", "clear-open-120": "covered",
    // Escape puts `/palette` back in the row; /prompt hands the screen to $EDITOR
    "palette-closed-40": "draft", "prompt-open-120": "gone",
  },
  devin: {
    "model-idle-119": "ready", "model-idle-40": "ready", "model-open-119": "gone", "model-open-40": "gone",
    "model-closed-119": "ready", "model-closed-40": "ready",
    // /btw's own field: a labelled top rule, `❭ Ask a /btw…`, `esc back to chat`
    "btw-open-119": "gone", "btw-open-40": "gone", "btw-closed-119": "ready",
    "config-open-119": "gone", "config-open-40": "gone",
  },
  agy: {
    "model-idle-119": "ready", "model-idle-40": "ready", "model-closed-119": "ready", "model-closed-40": "ready",
    // its panels draw under an empty box; /codesearch even keeps `? for shortcuts` last
    "model-open-119": "covered", "model-open-40": "covered", "config-open-119": "covered", "config-open-40": "covered",
    "codesearch-open-119": "covered", "codesearch-open-40": "covered",
    "diff-open-119": "gone", "diff-open-40": "gone", "changelog-open-119": "gone",
    // /open's first Enter only takes the completion
    "open-open-119": "draft",
  },
  grok: {
    // before the first key the welcome card and `[stable]` footer stand: not ready
    "settings-idle-119": "covered", "help-idle-40": "ready",
    "settings-open-119": "covered", "settings-open-40": "gone", "settings-closed-119": "ready", "settings-closed-40": "ready",
    "sessions-open-119": "gone", "sessions-open-40": "gone", "history-open-119": "gone", "history-open-40": "gone",
    "help-open-119": "covered",
    // Escape leaves `/model` in the row
    "model-closed-119": "draft",
  },
};

describe("inputRowState on recorded screens", () => {
  for (const [agent, screens] of Object.entries(EXPECTED)) {
    test(`${agent}: idle and closed are ready, an open screen is not`, async () => {
      const found: Record<string, InputRowState | null> = {};
      for (const name of Object.keys(screens)) found[name] = await recorded(agent, name);
      expect(found).toEqual(screens);
    });
  }

  test("every recorded screen is listed above", () => {
    const listed = Object.entries(EXPECTED).flatMap(([agent, screens]) => Object.keys(screens).map((name) => `${agent}/${name}.ansi`)).sort();
    const files = readdirSync(FIXTURES).filter((agent) => readsInputRow(agent)).flatMap((agent) =>
      readdirSync(join(FIXTURES, agent)).filter((file) => file.endsWith(".ansi")).map((file) => `${agent}/${file}`)).sort();
    expect(files).toEqual(listed);
  });

  test("Claude Code's box (server/prompt.ts claudeInputBox): ready under its rules, gone under a panel", async () => {
    const claude = readdirSync(CLAUDE).filter((file) => file.startsWith("claude-") && file.endsWith(".txt"));
    const found = Object.fromEntries(await Promise.all(claude.map(async (file) =>
      [file, inputRowState("claude", await screenOf(readFileSync(join(CLAUDE, file), "utf8"), columnsOf(file)))] as const)));
    const ready = ["claude-effort-2.1.311-set-120.txt", "claude-rewind-2.1.304-closed-40.txt", "claude-rewind-2.1.304-confirm-apple-esc-esc-120.txt", "claude-rewind-2.1.304-confirm-apple-esc-esc-40.txt"];
    expect(claude.length).toBeGreaterThan(10);
    for (const file of claude) expect([file, found[file]]).toEqual([file, ready.includes(file) ? "ready" : "gone"]);
  });

  test("Claude Code's grey text, cursor and IDE pill are no draft; typed text and pastes are", async () => {
    const rule = "─".repeat(60);
    const grey = (text: string): string => `\u001b[2m${text}\u001b[22m`;
    const box = (row: string): Promise<ScreenSnapshot> => screenOf(["● earlier output", "", rule, row, rule, "  ? for shortcuts"].join("\n"), 60);
    const pill = "[⧉ 3 lines selected] ";
    expect(inputRowState("claude", await box("❯ "))).toBe("ready");
    expect(inputRowState("claude", await box(`❯ ${grey("run the tests again")}`))).toBe("ready");
    expect(inputRowState("claude", await box(`❯ \u001b[7m${grey("r")}\u001b[27m${grey("un the tests again")}`))).toBe("ready");
    expect(inputRowState("claude", await box(`❯ ${pill}`))).toBe("ready");
    expect(inputRowState("claude", await box(`❯ ${pill}${grey("run the tests again")}`))).toBe("ready");
    expect(inputRowState("claude", await box("❯ still typing"))).toBe("draft");
    expect(inputRowState("claude", await box(`❯ ${pill}typed`))).toBe("draft");
    expect(inputRowState("claude", await box(grey("❯ [Pasted text #1 +12 lines]")))).toBe("draft");
    expect(inputRowState("claude", await box("❯ \u001b[7mx\u001b[27m"))).toBe("draft");
    expect(inputRowState("claude", await box("! ls"))).toBe("draft");
    // NO_COLOR: the tip as the box's one row, on a screen without any colour, is Claude's own
    expect(inputRowState("claude", await box('❯ \u001b[7mT\u001b[27mry "refactor this function"'))).toBe("ready");
    expect(inputRowState("claude", await box("❯ Try this instead"))).toBe("draft");
    // a named session labels its rule
    expect(inputRowState("claude", await screenOf([`── my-session ${"─".repeat(40)}`, "❯ ", rule, "  ? for shortcuts"].join("\n"), 60))).toBe("ready");
    expect(inputRowState("claude", await box("❯ 1. Yes"))).toBe("draft");
    expect(inputRowState("claude", await screenOf("  Side question\n\n  Press Space, Enter, or Escape to dismiss", 60))).toBe("gone");
  });

  test("Codex at Ultra reasoning effort marks its composer »: the same row, read the same way", async () => {
    const ultra = (name: string): Promise<ScreenSnapshot> => screenOf(readFileSync(join(FIXTURES, "codex-0.167.0", `${name}.ansi`), "utf8"), columnsOf(`${name}.ansi`));
    expect(inputRowState("codex", await ultra("composer-ultra-empty-100"))).toBe("ready");
    expect(inputRowState("codex", await ultra("composer-ultra-empty-40"))).toBe("ready");
    expect(inputRowState("codex", await ultra("composer-ultra-draft-100"))).toBe("draft");
    const swapped = readFileSync(join(FIXTURES, "codex", "permissions-open-120.ansi"), "utf8").replace("›", "»");
    expect(inputRowState("codex", await screenOf(swapped, 120))).toBe("gone");
  });

  test("a blank screen says nothing, and an agent without a recognizer is not read", async () => {
    const blank = await screenOf("", 40);
    expect(inputRowState("codex", blank)).toBe("unknown");
    expect(inputRowState("claude", blank)).toBe("unknown");
    expect(inputRowState("opencode", blank)).toBeNull();
    expect(inputRowState(null, blank)).toBeNull();
    expect(readsInputRow("opencode")).toBe(false);
    expect(readsInputRow("toString")).toBe(false);
    for (const agent of [...Object.keys(SCREEN_AUTO_RETURN), "claude"]) expect(readsInputRow(agent)).toBe(true);
  });
});

describe("FrameGate", () => {
  const OPEN = "\u001b[?2026h";
  const CLOSE = "\u001b[?2026l";

  test("reads a frame only once its synchronized block has closed, however a read cut it", () => {
    const gate = new FrameGate();
    const first = gate.enqueue(`${OPEN}\u001b[1;1Hhalf`, true);
    expect(gate.settle(first, true)).toBe(false);
    expect(gate.current).toBe(false);
    const second = gate.enqueue(" a frame\u001b[?20", true);
    expect(gate.settle(second, true)).toBe(false);
    const third = gate.enqueue(`26l`, true);
    expect(gate.settle(third, true)).toBe(true);
    expect(gate.current).toBe(true);
  });

  test("after a resize, only a whole frame written for the new grid reads", () => {
    const gate = new FrameGate();
    expect(gate.settle(gate.enqueue(`${OPEN}idle${CLOSE}`, true), true)).toBe(true);
    const queued = gate.enqueue(`${OPEN}old${CLOSE}`, true);
    gate.resized();
    expect(gate.current).toBe(false);
    expect(gate.settle(queued, true)).toBe(false);
    expect(gate.settle(gate.enqueue(`${OPEN}old size${CLOSE}`, false), true)).toBe(false);
    const opened = gate.enqueue(`${OPEN}redraw`, true);
    expect(gate.settle(opened, true)).toBe(false);
    gate.resized();
    expect(gate.settle(gate.enqueue(`rest${CLOSE}`, true), true)).toBe(false);
    expect(gate.settle(gate.enqueue(`${OPEN}new${CLOSE}`, true), true)).toBe(true);
    expect(gate.settle(gate.enqueue("\u001b[1;1Hmore", true), true)).toBe(true);
    expect(gate.settle(gate.enqueue(`${OPEN}x${CLOSE}`, true), false)).toBe(false);
  });

  test("a stream drawn without blocks (a mirrored pane's whole screens) reads each chunk", () => {
    const gate = new FrameGate();
    expect(gate.settle(gate.enqueue("\u001b[2J\u001b[Hscreen", true), true)).toBe(true);
    gate.resized();
    expect(gate.settle(gate.enqueue("\u001b[2J\u001b[Hscreen", true), true)).toBe(true);
  });

  // hc 0.1.21's attach paint (server/herdr-core/adapter.test.ts): CAN, DECSTR and an end of synchronized update, then the
  // screen outside any block ending at win32-input-mode (?9001l/h); the server puts its history clear (attach-session.ts CLEAR_HISTORY) ahead of it
  const CORE_PAINT = "\u001b[?1049l\u001b[3J\u001b[H\u001b[2J\u0018\u001b[!p\u001b[?2026l\u001b[H\u001b[2J\u00bb Ask Codex to do anything\u001b[?9001l";

  test("an end that closes no block frames nothing: herdr-core's attach paint reads, and the program's blocks after it", () => {
    const gate = new FrameGate();
    const paint = gate.enqueue(CORE_PAINT, true);
    expect(paint.synchronized).toBe(false);
    expect(gate.settle(paint, true)).toBe(true);
    expect(gate.current).toBe(true);
    gate.resized();
    expect(gate.settle(gate.enqueue(`${OPEN}\u001b[1;1Hhalf`, true), true)).toBe(false);
    expect(gate.settle(gate.enqueue(` drawn${CLOSE}`, true), true)).toBe(true);
    // a stream drawn in blocks stays one: after a resize, an end alone is no frame of the new grid
    gate.resized();
    expect(gate.settle(gate.enqueue(`late${CLOSE}`, true), true)).toBe(false);
    expect(gate.settle(gate.enqueue(`${OPEN}new${CLOSE}`, true), true)).toBe(true);
  });

  test("herdr-core's attach paint reads after a stream drawn in blocks, and when a read cuts its end in two", () => {
    const gate = new FrameGate();
    expect(gate.settle(gate.enqueue(`${OPEN}old${CLOSE}`, true), true)).toBe(true);
    gate.reset();
    expect(gate.settle(gate.enqueue(CORE_PAINT, true), true)).toBe(true);
    gate.reset();
    const cut = CORE_PAINT.indexOf("?2026l") + 3;
    expect(gate.settle(gate.enqueue(CORE_PAINT.slice(0, cut), true), true)).toBe(false);
    expect(gate.settle(gate.enqueue(CORE_PAINT.slice(cut), true), true)).toBe(true);
    gate.resized();
    expect(gate.settle(gate.enqueue("\u001b[1;1Hthe shell's prompt", true), true)).toBe(true);
  });

  test("a truncated replay with a restored unmatched ?2026l does not settle as a complete screen", () => {
    // ReplayBuffer.text() prepends saved modes (\x1b[?2026l) with no CAN+DECSTR paint reset
    const gate = new FrameGate();
    const truncated = `\u001b[?1049h\u001b[?2026l\u001b[1;1H${"─".repeat(60)}\r\n❯ \r\n${"─".repeat(60)}\r\n  Waiting for 1 background agent`;
    expect(gate.settle(gate.enqueue(truncated, true), true)).toBe(false);
    expect(gate.current).toBe(false);
    // a subsequent plain diff still waits until a real synchronized frame closes
    expect(gate.settle(gate.enqueue("\u001b[2;3H ", true), true)).toBe(false);
    expect(gate.current).toBe(false);
    expect(gate.settle(gate.enqueue(`${OPEN}\u001b[1;1Hfull frame${CLOSE}`, true), true)).toBe(true);
    expect(gate.current).toBe(true);
  });

  test("a split herdr-core attach paint holds off until its ?9001 end mark, so history chunks never arm a peek watcher", async () => {
    const idle = readFileSync(join(FIXTURES, "codex", "permissions-idle-120.ansi"), "utf8").replace(/\r/g, "").split("\n").slice(0, 40);
    const term = terminal(120, 40);
    const gate = new FrameGate();
    const states: InputRowState[] = [];
    const write = async (chunk: string): Promise<boolean> => {
      const stamp = gate.enqueue(chunk, true);
      await parse(term, chunk);
      const settled = gate.settle(stamp, true);
      if (settled) states.push(inputRowState("codex", readScreen(term.buffer.active, term.cols, term.rows))!);
      return settled;
    };
    try {
      const historyChunk = `\u001b[?1049l\u001b[3J\u001b[H\u001b[2J\u0018\u001b[!p\u001b[?2026l\u001b[H\u001b[2J${"old scrollback line\r\n".repeat(400)}`;
      const screenChunk = `\u001b[0m\r\n${"\n".repeat(40)}\u001b[H\u001b[2J${idle.map((row, index) => `\u001b[${index + 1};1H${row}`).join("")}\u001b[0m\u001b[?9001l`;
      expect(await write(historyChunk)).toBe(false);
      expect(gate.current).toBe(false);
      expect(await write(screenChunk)).toBe(true);
      expect(gate.current).toBe(true);
      expect(states).toEqual(["ready"]);
      expect(watch("codex", states)).toEqual({ armed: false, returnedAt: null, manualAt: null });
    } finally {
      term.dispose();
    }
    // split byte-by-byte across CAN+DECSTR and ?9001h, and aborted paint restarted by a second CAN+DECSTR
    const splitGate = new FrameGate();
    const hPaint = CORE_PAINT.replace("\u001b[?9001l", "\u001b[?9001h");
    for (let i = 0; i < hPaint.length - 1; i++) {
      const stamp = splitGate.enqueue(hPaint[i]!, true);
      if (i >= hPaint.indexOf("\u0018\u001b[!p") + 4) expect(splitGate.settle(stamp, true)).toBe(false);
    }
    expect(splitGate.settle(splitGate.enqueue(hPaint.at(-1)!, true), true)).toBe(true);
    // aborted paint without ?9001 followed by a fresh paint settles only on the fresh paint
    const abortGate = new FrameGate();
    expect(abortGate.settle(abortGate.enqueue("\u0018\u001b[!p\u001b[?2026lSTALE", true), true)).toBe(false);
    expect(abortGate.settle(abortGate.enqueue("\u0018\u001b[!p\u001b[?2026lFRESH\u001b[?9001l", true), true)).toBe(true);
    // paint started before a resize does not settle as a whole frame for the new epoch
    const resizeGate = new FrameGate();
    expect(resizeGate.settle(resizeGate.enqueue("\u0018\u001b[!p\u001b[?2026lhalf", true), true)).toBe(false);
    resizeGate.resized();
    expect(resizeGate.settle(resizeGate.enqueue("old-size\u001b[?9001l", true), true)).toBe(false);
  });

  test("combined private mode sequences (?25;2026h / ?25;2026l) gate unfinished updates like xterm", () => {
    const gate = new FrameGate();
    expect(gate.settle(gate.enqueue(CORE_PAINT, true), true)).toBe(true);
    // combined mode opening in the next chunk holds the unfinished update
    expect(gate.settle(gate.enqueue("\u001b[?25;2026h\u001b[1;1Hunfinished picker", true), true)).toBe(false);
    expect(gate.current).toBe(false);
    // split across chunks and closed with combined mode
    expect(gate.settle(gate.enqueue(" still drawing\u001b[?25;020", true), true)).toBe(false);
    expect(gate.settle(gate.enqueue("26l", true), true)).toBe(true);
    expect(gate.current).toBe(true);
    // combined open sharing the tail of an attach paint chunk also holds until closed
    gate.reset();
    expect(gate.settle(gate.enqueue(`${CORE_PAINT}\u001b[?25;2026hpartial`, true), true)).toBe(false);
    expect(gate.settle(gate.enqueue("done\u001b[?2026;25l", true), true)).toBe(true);
    // DECRQM (?2026$p) and distinct mode numbers (?20260h) are ignored
    gate.reset();
    expect(gate.settle(gate.enqueue("\u001b[?2026$p\u001b[?20260hplain", true), true)).toBe(true);
  });

  test("same-channel recovery paint after a resize settles without an external gate.reset()", () => {
    const gate = new FrameGate();
    expect(gate.settle(gate.enqueue(`${OPEN}before resize${CLOSE}`, true), true)).toBe(true);
    gate.resized();
    expect(gate.current).toBe(false);
    // upstream reconnect repaints on the same channel (adapter.test.ts): CAN+DECSTR clears prior synced state
    const recovery = "\u0018\u001b[!p\u001b[?2026l\u001b[?1049l\u001b[H\u001b[2J$ vim\r\n$ back\u001b[2;8H\u001b[?9001l";
    const cut = recovery.indexOf("$ vim");
    expect(gate.settle(gate.enqueue(recovery.slice(0, cut), true), true)).toBe(false);
    expect(gate.settle(gate.enqueue(recovery.slice(cut), true), true)).toBe(true);
    expect(gate.current).toBe(true);
    // plain writes after the recovery paint continue to settle until a synchronized block opens again
    expect(gate.settle(gate.enqueue("\u001b[2;8Hmore", true), true)).toBe(true);
    expect(gate.settle(gate.enqueue(`${OPEN}half`, true), true)).toBe(false);
    expect(gate.settle(gate.enqueue(`done${CLOSE}`, true), true)).toBe(true);
  });

  test("a stale recovery paint never consumes the resize reflow guard, even if a display query follows or geometry catches up mid-paint", () => {
    // case 1: recovery paint starts before a resize and closes after it; subsequent plain display query must not consume reflow
    const gate = new FrameGate();
    expect(gate.settle(gate.enqueue(`${OPEN}before${CLOSE}`, true), true)).toBe(true);
    expect(gate.settle(gate.enqueue("\u0018\u001b[!p\u001b[?2026lold-half", true), true)).toBe(false);
    gate.reflowed();
    gate.resized();
    expect(gate.settle(gate.enqueue("old-rest\u001b[?9001l", true), true)).toBe(false);
    expect(gate.settle(gate.enqueue("\u001b]10;?\u001b\\\u001b[c", true), true)).toBe(false);
    expect(gate.settle(gate.enqueue(`${OPEN}reflowed${CLOSE}`, true), true)).toBe(true);
    expect(gate.reflowing).toBe(true);

    // case 2: paint starts while geometry is false and closes after geometry becomes true
    const geomGate = new FrameGate();
    expect(geomGate.settle(geomGate.enqueue(`${OPEN}before${CLOSE}`, true), true)).toBe(true);
    geomGate.resized();
    expect(geomGate.settle(geomGate.enqueue("\u0018\u001b[!p\u001b[?2026lold-grid", false), true)).toBe(false);
    geomGate.reflowed();
    expect(geomGate.settle(geomGate.enqueue("old-rest\u001b[?9001l", true), true)).toBe(false);
    expect(geomGate.settle(geomGate.enqueue(`${OPEN}reflowed${CLOSE}`, true), true)).toBe(true);
    expect(geomGate.reflowing).toBe(true);
  });

  test("RIS (ESC c) and standalone DECSTR (CSI ! p) clear an open synchronized block like xterm 6, and CSI param count caps at 32", () => {
    const risGate = new FrameGate();
    expect(risGate.settle(risGate.enqueue("\u001b[?25;2026hpartial", true), true)).toBe(false);
    expect(risGate.settle(risGate.enqueue("\u001bcplain prompt", true), true)).toBe(true);
    expect(risGate.current).toBe(true);

    const decstrGate = new FrameGate();
    expect(decstrGate.settle(decstrGate.enqueue("\u001b[?25;2026hpartial", true), true)).toBe(false);
    expect(decstrGate.settle(decstrGate.enqueue("\u001b[!pplain prompt", true), true)).toBe(true);
    expect(decstrGate.current).toBe(true);

    // xterm 6 ignores parameter #33 in a CSI private mode list
    const capGate = new FrameGate();
    expect(capGate.settle(capGate.enqueue(`${OPEN}partial`, true), true)).toBe(false);
    const thirtyThree = `\u001b[?${Array(32).fill("25").join(";")};2026l`;
    expect(capGate.settle(capGate.enqueue(thirtyThree, true), true)).toBe(false);
    expect(capGate.settle(capGate.enqueue(CLOSE, true), true)).toBe(true);
  });

  test("a reset forgets a block the old stream left open", () => {
    const gate = new FrameGate();
    gate.enqueue(`${OPEN}cut off`, true);
    gate.reset();
    expect(gate.settle(gate.enqueue(`${OPEN}fresh${CLOSE}`, true), true)).toBe(true);
  });

  test("when the pane's grid changes size, its first frame (maybe herdr's reflow of the old screen) reads but is marked", () => {
    const gate = new FrameGate();
    expect(gate.settle(gate.enqueue(`${OPEN}idle${CLOSE}`, true), true)).toBe(true);
    expect(gate.reflowing).toBe(false);
    gate.reflowed();
    expect(gate.current).toBe(false);
    gate.resized();
    expect(gate.settle(gate.enqueue(`${OPEN}old screen, reflowed${CLOSE}`, true), true)).toBe(true);
    expect(gate.reflowing).toBe(true);
    expect(gate.settle(gate.enqueue(`${OPEN}the agent's redraw${CLOSE}`, true), true)).toBe(true);
    expect(gate.reflowing).toBe(false);
    gate.resized();
    expect(gate.settle(gate.enqueue(`${OPEN}before the pane's size${CLOSE}`, false), true)).toBe(false);
    gate.reflowed();
    expect(gate.settle(gate.enqueue(`${OPEN}old screen, reflowed${CLOSE}`, true), true)).toBe(true);
    expect(gate.reflowing).toBe(true);
    expect(gate.settle(gate.enqueue(`${OPEN}half`, true), true)).toBe(false);
    expect(gate.reflowing).toBe(false);
    gate.reflowed();
    gate.reset();
    expect(gate.settle(gate.enqueue(`${OPEN}fresh${CLOSE}`, true), true)).toBe(true);
    expect(gate.reflowing).toBe(false);
  });
});

describe("recorded frame streams", () => {
  test("Codex /permissions at 40 columns: the send hides the row, the close draws it back in one frame", async () => {
    const sent = await replay("codex", "permissions-send-40");
    expect(sent).toEqual(["ready", "draft", "gone"]);
    expect(watch("codex", sent)).toEqual({ armed: true, returnedAt: null, manualAt: null });
    const closed = await replay("codex", "permissions-closing-40");
    expect(closed).toEqual(["gone", "ready"]);
    expect(watch("codex", closed)).toEqual({ armed: true, returnedAt: 1, manualAt: null });
  });

  test("Codex /diff: an empty composer drawn before the pager never arms or returns", async () => {
    const sent = await replay("codex", "diff-send-120");
    expect(sent).toEqual(["ready", "draft", "ready", "gone"]);
    expect(watch("codex", sent)).toEqual({ armed: true, returnedAt: null, manualAt: null });
  });

  test("Codex /cd's trust screen closes through one blank frame", async () => {
    const closed = await replay("codex", "cd-untrusted-repo-closing-40");
    expect(closed).toEqual(["gone", "unknown", "ready"]);
    expect(watch("codex", closed)).toEqual({ armed: true, returnedAt: 2, manualAt: null });
  });

  test("agy /model at 40 columns: the empty box drawn before the panel never arms", async () => {
    const frames = await replay("agy", "model-40");
    expect(frames).toEqual(["ready", "draft", "ready", "covered", "ready"]);
    expect(watch("agy", frames)).toEqual({ armed: true, returnedAt: 4, manualAt: null });
  });

  test("Devin /btw: its own field is no input row; the close is one frame", async () => {
    const frames = await replay("devin", "btw-119");
    expect(frames).toEqual(["ready", "draft", "gone", "ready"]);
    expect(watch("devin", frames)).toEqual({ armed: true, returnedAt: 3, manualAt: null });
  });

  test("Hermes: the empty row drawn between the echo and the screen arms nothing; only a covered row does", async () => {
    // every slash command: draft, the echo (gone), the empty row with its status bar for a moment, the screen
    const sequence = [
      await recorded("hermes", "model-idle-120"), await recorded("hermes", "palette-closed-40"), await recorded("hermes", "prompt-open-120"),
      await recorded("hermes", "model-idle-120"), await recorded("hermes", "model-open-120"), await recorded("hermes", "model-closed-120"),
    ];
    expect(sequence).toEqual(["ready", "draft", "gone", "ready", "covered", "ready"]);
    expect(watch("hermes", sequence)).toEqual({ armed: true, returnedAt: 5, manualAt: null });
    // /prompt's $EDITOR hides the row and never covers it: manual
    expect(watch("hermes", sequence.slice(0, 4))).toEqual({ armed: false, returnedAt: null, manualAt: null });
  });

  test("gjc /sessions: the empty box it keeps while loading never arms", async () => {
    const sequence = [await recorded("gjc", "sessions-open-early-119"), await recorded("gjc", "sessions-open-loading10s-119"), await recorded("gjc", "sessions-closed-119")];
    expect(watch("gjc", sequence)).toEqual({ armed: false, returnedAt: null, manualAt: null });
    const loaded = [...sequence.slice(0, 2), await recorded("gjc", "settings-open-119"), await recorded("gjc", "sessions-closed-119")];
    expect(watch("gjc", loaded)).toEqual({ armed: true, returnedAt: 3, manualAt: null });
  });

  test("a phone peek's resize: herdr's reflowed frame of gjc's loading /sessions neither arms nor returns", async () => {
    const loading = readFileSync(join(FIXTURES, "gjc", "sessions-open-loading10s-119.ansi"), "utf8").replace(/\r/g, "").split("\n").slice(0, 40);
    // herdr's own frame for the new grid: the old screen, reflowed to 40 columns (its box cut at the borders)
    const old = terminal(119);
    await parse(old, loading.map((row, index) => `\u001b[${index + 1};1H${row}`).join(""));
    old.resize(40, 40);
    await parse(old, "");
    const reflowed = Array.from({ length: 40 }, (_, y) => old.buffer.active.getLine(old.buffer.active.baseY + y)!.translateToString(true));
    old.dispose();
    expect(inputRowState("gjc", await screenOf(reflowed.join("\n"), 40))).toBe("gone");
    const redrawn = readFileSync(join(FIXTURES, "gjc", "settings-closed-40.ansi"), "utf8").replace(/\r/g, "").split("\n").slice(0, 40);
    const frame = (rows: readonly string[]): string => `\u001b[?2026h\u001b[2J${rows.map((row, index) => `\u001b[${index + 1};1H${row}`).join("")}\u001b[?2026l`;
    const term = terminal(119);
    const gate = new FrameGate();
    term.onResize(() => gate.resized());
    const states: InputRowState[] = [];
    const write = async (data: string): Promise<void> => {
      const stamp = gate.enqueue(data, true);
      await parse(term, data);
      if (gate.settle(stamp, true) && !gate.reflowing) states.push(inputRowState("gjc", readScreen(term.buffer.active, term.cols, term.rows))!);
    };
    await write(frame(loading));
    gate.reflowed();
    term.resize(40, 40);
    await write(frame(reflowed));
    await write(frame(redrawn));
    term.dispose();
    expect(states).toEqual(["ready", "ready"]);
    expect(watch("gjc", states)).toEqual({ armed: false, returnedAt: null, manualAt: null });
    expect(watch("gjc", ["ready", "gone", "ready"])).toEqual({ armed: true, returnedAt: 2, manualAt: null });
  });

  test("a screen that closes onto text in the row leaves the return to the reader", async () => {
    expect(watch("hermes", [await recorded("hermes", "palette-open-120"), await recorded("hermes", "palette-closed-40")]))
      .toEqual({ armed: true, returnedAt: null, manualAt: 1 });
    expect(watch("grok", [await recorded("grok", "settings-open-119"), await recorded("grok", "model-closed-119")]))
      .toEqual({ armed: true, returnedAt: null, manualAt: 1 });
  });

  test("omp /context at 119 columns arms on its covered editor and comes back on the closed one", async () => {
    expect(watch("omp", [await recorded("omp", "settings-idle-119"), await recorded("omp", "context-open-119"), await recorded("omp", "context-closed-119")]))
      .toEqual({ armed: true, returnedAt: 2, manualAt: null });
    expect(watch("omp", [await recorded("omp", "settings-idle-119"), await recorded("omp", "plan-open-119"), await recorded("omp", "settings-closed-119")]))
      .toEqual({ armed: false, returnedAt: null, manualAt: null });
  });
});

describe("the chat send's read of the same screens (shared/input-row.ts)", () => {
  const agents = readdirSync(FIXTURES).filter((name) => !name.includes(".") && name !== "codex-0.167.0");
  const files = agents.flatMap((agent) => readdirSync(join(FIXTURES, agent)).filter((file) => file.endsWith(".ansi")).map((file) => [agent, file] as const));
  test.each(files)("%s %s", async (agent, file) => {
    const text = readFileSync(join(FIXTURES, agent, file), "utf8");
    expect(inputRowState(agent, screenFromAnsi(text))).toBe(inputRowState(agent, await screenOf(text, columnsOf(file))));
  });

  const typed = (agent: string, file: string): boolean => typedDraft(agent, screenFromAnsi(readFileSync(join(FIXTURES, file), "utf8")));

  test("text typed into the box is a draft; an empty box, a placeholder and a box not made out are not", () => {
    expect(typed("pi", "pi/draft-typed-119.ansi")).toBeTrue();
    expect(typed("omo", "omo/draft-typed-119.ansi")).toBeTrue();
    expect(typed("codex", "codex-0.167.0/composer-ultra-draft-100.ansi")).toBeTrue();
    expect(typed("codex", "codex/mention-closed-120.ansi")).toBeTrue();
    expect(typed("pi", "pi/draft-empty-119.ansi")).toBeFalse();
    expect(typed("omo", "omo/draft-empty-119.ansi")).toBeFalse();
    expect(typed("codex", "codex-0.167.0/composer-ultra-empty-100.ansi")).toBeFalse();
    // their autocomplete moves the box out of its recorded place: not made out, so not refused
    expect(typed("pi", "pi/draft-slash-119.ansi")).toBeFalse();
    expect(typed("omo", "omo/draft-slash-119.ansi")).toBeFalse();
  });

  test("pi's editor drawn by pi-powerline-footer, its status bar above it, is read as pi's own", () => {
    const screen = (name: string): ScreenSnapshot => screenFromAnsi(readFileSync(join(FIXTURES, `pi/powerline-${name}-200.ansi`), "utf8"));
    // a chat message pasted over a typed `2` was sent and recorded as `2…`, so its receipt never matched
    expect(inputRowState("pi", screen("draft-typed"))).toBe("draft");
    expect(typedDraft("pi", screen("draft-typed"))).toBeTrue();
    expect(typedDraft("pi", screen("draft-multiline"))).toBeTrue();
    expect(inputRowState("pi", screen("draft-empty"))).toBe("ready");
    expect(typedDraft("pi", screen("draft-empty"))).toBeFalse();
    // Left moves pi's cursor onto the `2`, which its editor then draws inverse: still typed text
    const onCursor = readFileSync(join(FIXTURES, "pi/powerline-draft-typed-200.ansi"), "utf8").replace(" 2\u001b[0m\u001b[7m\u001b[0m", " \u001b[7m2\u001b[0m");
    expect(typedDraft("pi", screenFromAnsi(onCursor))).toBeTrue();
    // after the first prompt the extension draws it under the editor (`powerline-last-prompt`, on by default), as
    // its renderLastPromptLines does
    const lastPrompt = (name: string, rows: string): ScreenSnapshot => screenFromAnsi(`${readFileSync(join(FIXTURES, `pi/powerline-${name}-200.ansi`), "utf8").replace(/\n$/, "")}\n${rows}\n`);
    const arrow = " \u001b[38;2;102;102;102m↳\u001b[0m \u001b[38;2;102;102;102mwhat does this repo do?\u001b[0m";
    expect(inputRowState("pi", lastPrompt("draft-typed", arrow))).toBe("draft");
    expect(typedDraft("pi", lastPrompt("draft-typed", arrow))).toBeTrue();
    expect(inputRowState("pi", lastPrompt("draft-empty", arrow))).toBe("ready");
    // anything else under the editor (its autocomplete list) still fails safe
    expect(inputRowState("pi", lastPrompt("draft-typed", `   /model  Select model\n${arrow}`))).toBe("gone");
    // while pi works its upper border carries the spinner: a send then queues, and would join a typed `how`
    expect(typedDraft("pi", screen("working-typed"))).toBeTrue();
    const workingEmpty = readFileSync(join(FIXTURES, "pi/powerline-working-typed-200.ansi"), "utf8").replace(">\u001b[0m how\u001b[0m", ">\u001b[0m\u001b[0m");
    expect(inputRowState("pi", screenFromAnsi(workingEmpty))).toBe("ready");
    // pi 1.5.2 draws that border (CustomEditor.renderTopBorder) with the dashes the row leaves, one where its status fills
    // the row, and ` ↑ 2 more ` in it where the editor scrolls: each is still the box's upper border
    const accent = (text: string): string => `\u001b[38;2;111;164;201m${text}\u001b[0m`;
    const workingBox = (border: string, rows: string[]): ScreenSnapshot => screenFromAnsi([" status", ` ${accent(border)}`,
      ...rows.map((row, index) => index > 0 ? `   ${row}` : ` \u001b[38;2;200;200;200m>\u001b[0m${row === "" ? "" : ` ${row}`}\u001b[0m\u001b[7m\u001b[0m`),
      ` ${accent("─".repeat(border.length))}`].join("\n"));
    for (const border of ["── ⠸ Working ───────", "── ⠸ Auto-compacting... (esc to ─", "── ⠸ Working ──────── ↑ 2 more ─────────────"]) {
      expect(typedDraft("pi", workingBox(border, ["how"]))).toBeTrue();
      expect(typedDraft("pi", workingBox(border, ["line3", "line4", "line5", "line6", "line7"]))).toBeTrue();
      expect(inputRowState("pi", workingBox(border, [""]))).toBe("ready");
    }
  });

  test("pi's editor holding a line typed with leading spaces is a draft to the send, still a dialog's row to the peek", () => {
    const indented = readFileSync(join(FIXTURES, "pi/draft-typed-119.ansi"), "utf8").replace("leftover draft", "  indented snippet");
    expect(typedDraft("pi", screenFromAnsi(indented))).toBeTrue();
    expect(inputRowState("pi", screenFromAnsi(indented))).toBe("gone");
    const typedRow = (row: string): boolean => typedDraft("pi", screenFromAnsi(readFileSync(join(FIXTURES, "pi/draft-typed-119.ansi"), "utf8").replace("leftover draft", row)));
    expect(typedRow("> please retain this quote")).toBeTrue();
    expect(typedRow("→ note to self")).toBeTrue();
    expect(typedRow("> sea\r\n\u001b[38;2;167;152;215m→ Auto-compact\u001b[0m")).toBeFalse();
    expect(typedRow("> quoted\r\n→ an arrow line")).toBeTrue();
  });

  test("a read whose escapes carry no colour or style (bold, resets) proves nothing", () => {
    const colourless = readFileSync(join(FIXTURES, "pi/draft-typed-119.ansi"), "utf8").replace(/\u001b\[(?:[0-9;:]*)m/g, "\u001b[0m\u001b[1m");
    expect(drawsColour(colourless)).toBeFalse();
    expect(drawsColour(readFileSync(join(FIXTURES, "pi/draft-typed-119.ansi"), "utf8"))).toBeTrue();
  });

  test("loads and reads a screen where the runtime has no Intl.Segmenter (Safari 14, Firefox before 125)", async () => {
    const script = `delete Intl.Segmenter;
      const row = await import(${JSON.stringify(join(import.meta.dir, "inputRow.ts"))});
      const shared = await import(${JSON.stringify(join(import.meta.dir, "../../shared/input-row.ts"))});
      console.log(typeof row.FrameGate, shared.screenFromAnsi("\\u276f typed").rows[0].text);`;
    const child = Bun.spawn([process.execPath, "-e", script], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited, err).toBe(0);
    expect(out.trim()).toBe("function \u276f typed");
  });

  test.each([
    // `/mo` typed with the command list open: read with the list inside the box (muse), the box still whole (gjc, qwen,
    // cline), or the box out of its place (dsh-tui)
    ["gjc", true], ["muse", true], ["qwen", true], ["cline", true], ["dsh-tui", false],
  ])("%s, recorded in the agent lab: typed text is a draft, its empty box and placeholder are not", (agent, slash) => {
    expect(typed(agent, `${agent}/draft-typed-119.ansi`)).toBeTrue();
    expect(typed(agent, `${agent}/draft-empty-119.ansi`)).toBeFalse();
    expect(typed(agent, `${agent}/draft-slash-119.ansi`)).toBe(slash);
  });

  test("a Qwen draft whose second row starts with Qwen's own mark is still its box's draft (#3769)", () => {
    const rows = readFileSync(join(FIXTURES, "qwen/draft-typed-119.ansi"), "utf8").split("\n");
    const at = rows.findIndex((row) => row.includes("leftover draft"));
    rows.splice(at + 1, 0, "> quoted line\r");
    expect(typedDraft("qwen", screenFromAnsi(rows.join("\n")))).toBeTrue();
  });

  test("a GJC draft wrapped onto a second row of its box is read whole by the draft check", () => {
    const rows = readFileSync(join(FIXTURES, "gjc/draft-typed-119.ansi"), "utf8").split("\n");
    const at = rows.findIndex((row) => row.includes("\u2502 \u001b") && row.includes(">"));
    rows.splice(at + 1, 0, `\u2502   typed on the second row${" ".repeat(90)}\u2502\r`);
    expect(typedDraft("gjc", screenFromAnsi(rows.join("\n")))).toBeTrue();
  });

  test("a GJC draft that starts with a blank line is read from its wrapped rows", () => {
    const rows = readFileSync(join(FIXTURES, "gjc/draft-typed-119.ansi"), "utf8").replace("leftover draft", "").split("\n");
    const at = rows.findIndex((row) => row.includes("\u2502 \u001b") && row.includes(">"));
    rows.splice(at + 1, 0, `\u2502   typed on the second row${" ".repeat(90)}\u2502\r`);
    expect(typedDraft("gjc", screenFromAnsi(rows.join("\n")))).toBeTrue();
  });

  test("a draft wrapped onto a second row of the box is read whole", () => {
    const rows = readFileSync(join(FIXTURES, "muse/draft-typed-119.ansi"), "utf8").replace("leftover draft", "").split("\n");
    const at = rows.findIndex((row) => row.includes("\u276f"));
    rows.splice(at + 1, 0, "\u001b[38;2;204;211;219mtyped on the second row\u001b[0m\r");
    expect(typedDraft("muse", screenFromAnsi(rows.join("\n")))).toBeTrue();
  });

  test.each([
    // `/mo` typed: in the terminal's colour or the recorded typed colour (letta, maki, kilo), or drawn as a command (kimi, gemini)
    ["letta", true], ["maki", true], ["kimi", false], ["gemini", false], ["kilo", true],
  ])("%s, recorded in the agent lab: typed text is a draft, its empty box and placeholder are not", (agent, slash) => {
    expect(typed(agent, `${agent}/draft-typed-119.ansi`)).toBeTrue();
    expect(typed(agent, `${agent}/draft-empty-119.ansi`)).toBeFalse();
    expect(typed(agent, `${agent}/draft-slash-119.ansi`)).toBe(slash);
  });

  test("omp 18.14's editor under its unframed status line: typed text, on one row or more, and `/mo` are a draft; its hint is not", () => {
    expect(typed("omp", "omp/draft-typed-119.ansi")).toBeTrue();
    expect(typed("omp", "omp/draft-lines-119.ansi")).toBeTrue();
    expect(typed("omp", "omp/draft-slash-119.ansi")).toBeTrue();
    expect(typed("omp", "omp/draft-empty-119.ansi")).toBeFalse();
    // 18.8.7's framed editor reports no cells: never refused
    expect(typed("omp", "omp/settings-idle-119.ansi")).toBeFalse();
    const themed = readFileSync(join(FIXTURES, "omp/draft-typed-119.ansi"), "utf8").replace("\u001b[38;5;254mleftover", "\u001b[38;5;250mleftover");
    expect(typedDraft("omp", screenFromAnsi(themed))).toBeFalse();
  });

  test("omp 18.14's draft is read past an empty first row, an indented row and an empty row between, and as typed when it is the hint's words", () => {
    const lines = readFileSync(join(FIXTURES, "omp/draft-lines-119.ansi"), "utf8");
    expect(typedDraft("omp", screenFromAnsi(lines.replace("leftover draft", "").replace("second line", "    indented")))).toBeTrue();
    const rows = lines.replace("leftover draft", "").split("\n");
    rows.splice(rows.findIndex((row) => row.includes("second line")), 0, "\r");
    expect(typedDraft("omp", screenFromAnsi(rows.join("\n")))).toBeTrue();
    expect(typedDraft("omp", screenFromAnsi(readFileSync(join(FIXTURES, "omp/draft-typed-119.ansi"), "utf8").replace("leftover draft", "⇧⇥ to change thinking effort")))).toBeTrue();
  });

  test("Kilo's box in a session, under its first answer, reads as on its home screen", () => {
    expect(typed("kilo", "kilo/draft-session-typed-119.ansi")).toBeTrue();
    expect(typed("kilo", "kilo/draft-session-empty-119.ansi")).toBeFalse();
    expect(typed("kilo", "kilo/draft-session-slash-119.ansi")).toBeTrue();
  });

  test("Kilo's empty editor does not include the previous message across blank screen rows", () => {
    const rows = readFileSync(join(FIXTURES, "kilo/draft-session-empty-119.ansi"), "utf8").split("\n");
    rows.fill("", 4, 33);
    expect(typedDraft("kilo", screenFromAnsi(rows.join("\n")))).toBeFalse();
  });

  test("a Pi draft can consist of a single private-use glyph", () => {
    const screen = readFileSync(join(FIXTURES, "pi/draft-typed-119.ansi"), "utf8");
    expect(typedDraft("pi", screenFromAnsi(screen.replace("leftover draft", "\uE0B0")))).toBeTrue();
  });

  test("Letta's inverse cursor cell can contain the only typed character", () => {
    const screen = readFileSync(join(FIXTURES, "letta/draft-typed-119.ansi"), "utf8");
    expect(typedDraft("letta", screenFromAnsi(screen.replace("leftover draft", "\u001b[7mx\u001b[27m")))).toBeTrue();
  });

  test("a character that draws nothing (Letta pads its empty box with zero-width spaces) is no typed text", () => {
    const rule = "\u2500".repeat(60);
    expect(typedDraft("letta", screenFromAnsi([rule, "\u203a \u001b[7m \u001b[0m\u200b\u200b\u200b", rule].join("\n")))).toBeFalse();
    expect(typedDraft("letta", screenFromAnsi([rule, "\u203a typed", rule].join("\n")))).toBeTrue();
  });

  test("an agent that draws typed text in a colour of its own: only that colour, as recorded, is typed", () => {
    const muse = readFileSync(join(FIXTURES, "muse/draft-typed-119.ansi"), "utf8");
    expect(typedDraft("muse", screenFromAnsi(muse))).toBeTrue();
    expect(typedDraft("muse", screenFromAnsi(muse.replaceAll("38;2;204;211;219m", "38;2;120;120;120m")))).toBeFalse();
    const cline = readFileSync(join(FIXTURES, "cline/draft-empty-119.ansi"), "utf8");
    expect(typedDraft("cline", screenFromAnsi(cline))).toBeFalse();
  });

  test("only typed-looking cells count: the same words dim, grey or italic are no draft", () => {
    const omo = readFileSync(join(FIXTURES, "omo/draft-typed-119.ansi"), "utf8");
    const styled = (sgr: string) => typedDraft("omo", screenFromAnsi(omo.replace(" leftover draft", ` \u001b[${sgr}mleftover draft\u001b[0m`)));
    expect(styled("0")).toBeTrue();
    expect(styled("2")).toBeFalse();
    expect(styled("3")).toBeFalse();
    expect(styled("38;5;244")).toBeFalse();
    expect(styled("38:2::90:90:90")).toBeFalse();
    expect(typedDraft("claude", screenFromAnsi(["\u2500".repeat(40), "\u276f still typing", "\u2500".repeat(40)].join("\n")))).toBeFalse();
    expect(typedDraft("letta", screenFromAnsi(omo))).toBeFalse();
    // a Codex `›` row with no model line under it is one of the history's messages, not the composer
    expect(typedDraft("codex", screenFromAnsi("› an earlier message"))).toBeFalse();
    expect(typedDraft("codex", screenFromAnsi("› typed\n\n  GPT-6.1-Sol default · ~/work"))).toBeTrue();
    // Codex's placeholder drawn undimmed (NO_COLOR) keeps its `? for shortcuts` hint, which typed text takes away
    expect(typedDraft("codex", screenFromAnsi("› Ask Codex to do anything\n\n  GPT-6.1-Sol default · ~/work\n  ← for agents · ? for shortcuts"))).toBeFalse();
  });
});
