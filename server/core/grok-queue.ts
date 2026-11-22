/**
 * Send now to a working Grok. Grok queues an Enter on typed text while a turn runs; one more Enter on its empty
 * prompt sends the top queued row now, cancelling the turn at work. What Grok's live screen shows of that queue is read
 * here from the screens recorded in src/lib/fixtures-input-rows/grok-1.0.77 (README there).
 */
import { stripVTControlCharacters } from "node:util";
import { inputRowState, screenFromAnsi } from "../../shared/input-row.ts";
import { GROK_QUEUED_MESSAGE, GROK_SEND_NOW_UNCONFIRMED_MESSAGE, GROK_SEND_UNCONFIRMED_MESSAGE, grokQueuedBehindMessage } from "../../shared/submit-outcome.ts";
import { HerdrError } from "../herdr/client.ts";

export type GrokQueue =
  /**
   * Fullscreen: each queued row's text as Grok draws it (its first line, cut with `…`, ` (+N lines)` for the rest),
   * and whether its shortcuts row offers `Enter:send now`, which it does only with the prompt empty and focused.
   */
  | { readonly mode: "fullscreen"; readonly rows: readonly string[]; readonly enterSendsNow: boolean }
  /** Minimal mode: no input box, only a count on the info row (`1 queued · /queue`), 0 when none is drawn. */
  | { readonly mode: "minimal"; readonly count: number };

const QUEUE_ROW = /^ {4}#(\d+) (.*)$/;
/** a row of the agent's output, which Grok indents by five */
const OUTPUT_ROW = /^ {5}\S/;

/** null: neither layout is on the screen, or the queue pane holds the focus and frames its rows. */
export function grokQueue(screen: string): GrokQueue | null {
  const rows = stripVTControlCharacters(screen).split("\n").map((row) => row.trimEnd());
  const last = rows.filter((row) => row.trim() !== "").at(-1) ?? "";
  const input = rows.map((row) => /^\s*│ ❯/.test(row)).lastIndexOf(true);
  if (input < 0) {
    const minimal = /(?:^|· )(\d+) queued · \/queue(?: ·|$)/.exec(last);
    if (minimal) return { mode: "minimal", count: Number(minimal[1]) };
    return last.endsWith("ctrl+o transcript") && rows.some((row) => /^❯(?: |$)/.test(row)) ? { mode: "minimal", count: 0 } : null;
  }
  if (rows.some((row) => /^\s*│\s+#\d+ /.test(row))) return null;
  const top = rows.slice(0, input).map((row) => /^\s*╭/.test(row)).lastIndexOf(true);
  const above = rows.slice(0, top < 0 ? input : top);
  const end = above.map((row) => QUEUE_ROW.test(row)).lastIndexOf(true);
  const queued: string[] = [];
  for (let index = end; index >= 0; index--) {
    const row = QUEUE_ROW.exec(above[index]!);
    if (!row) break;
    queued.unshift(row[2]!);
  }
  const numbered = queued.every((_, index) => QUEUE_ROW.exec(above[end - queued.length + 1 + index]!)![1] === String(index + 1));
  const rowsOfQueue = numbered && !above.slice(end + 1).some((row) => OUTPUT_ROW.test(row)) ? queued : [];
  return { mode: "fullscreen", rows: rowsOfQueue, enterSendsNow: last.split("│").some((part) => part.trim() === "Enter:send now") };
}

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

export function showsMessage(row: string, message: string): boolean {
  const lines = message.replace(/\n+$/, "").split("\n");
  let shown = squash(row);
  const more = / \(\+(\d+) lines?\)$/.exec(shown);
  if (more) shown = shown.slice(0, more.index);
  if (Number(more?.[1] ?? 0) !== lines.length - 1) return false;
  const first = squash(lines[0]!);
  if (!shown.endsWith("…")) return shown === first;
  const cut = shown.slice(0, -1).trimEnd();
  return cut !== "" && first.startsWith(cut);
}

/** a prompt as Grok echoes it in the transcript once sent: `     ❯ first line` (its time on the right), the rest under it */
const ECHO_ROW = /^ {5}❯ (.*)$/;
const ECHO_MORE = /^ {7}\S/;

export type GrokEcho = { readonly text: string; readonly echoes: number };

export function grokEcho(screen: string): GrokEcho | null {
  const rows = stripVTControlCharacters(screen).split("\n").map((row) => row.replace(/\s+█$/, "").trimEnd());
  const box = rows.map((row) => /^\s*╭/.test(row)).lastIndexOf(true);
  const above = rows.slice(0, box < 0 ? rows.length : box);
  const echoes = above.map((row) => ECHO_ROW.test(row));
  const at = echoes.lastIndexOf(true);
  if (at < 0) return null;
  const echo = [ECHO_ROW.exec(above[at]!)![1]!.replace(/\s{2,}\d{1,2}:\d{2}(?: [AP]M)?$/, "")];
  for (const row of above.slice(at + 1)) {
    if (!ECHO_MORE.test(row)) break;
    echo.push(row);
  }
  return { text: squash(echo.join(" ")), echoes: echoes.filter(Boolean).length };
}

/**
 * An echo already drawn then (an earlier prompt of the same words) is not the message's, nor a new one drawn as the
 * oldest scrolls off the top (the safe direction); the echo's time is to the minute, so it does not tell.
 */
function echoesMessage(screen: string, before: GrokEcho | null, message: string): boolean {
  const echo = grokEcho(screen);
  if (echo === null) return false;
  if (before !== null && echo.text === before.text && echo.echoes <= before.echoes) return false;
  const shown = echo.text;
  const whole = squash(message);
  if (!shown.endsWith("…")) return shown === whole;
  const cut = shown.slice(0, -1).trimEnd();
  return cut !== "" && whole.startsWith(cut);
}

const grokPromptEmpty = (screen: string): boolean => inputRowState("grok", screenFromAnsi(screen)) === "ready";

const changed = (message: string): HerdrError => new HerdrError("submit_changed", message);

const onlyRows = (screen: string): readonly string[] => {
  const queue = grokQueue(screen);
  return queue?.mode === "fullscreen" ? queue.rows : [];
};

export type GrokBeforeSend = { readonly working: boolean; readonly queue: GrokQueue | null; readonly echo: GrokEcho | null };

function sendNowStep(seen: { status: string; screen: string }, before: GrokBeforeSend, message: string): "press" | "done" {
  const queue = grokQueue(seen.screen);
  if (queue === null) throw changed(GROK_SEND_UNCONFIRMED_MESSAGE);
  switch (queue.mode) {
    case "minimal": {
      if (queue.count === 0) return "done";
      const earlier = before.queue?.mode === "minimal" ? before.queue.count : null;
      if (earlier === null || queue.count !== earlier + 1) throw changed(GROK_SEND_UNCONFIRMED_MESSAGE);
      throw changed(earlier > 0 ? grokQueuedBehindMessage(earlier) : GROK_QUEUED_MESSAGE);
    }
    case "fullscreen": {
      if (queue.rows.length === 0) {
        if (seen.status !== "working") return "done";
        if (before.working || before.queue?.mode !== "fullscreen" || !echoesMessage(seen.screen, before.echo, message)) throw changed(GROK_SEND_UNCONFIRMED_MESSAGE);
        return "done";
      }
      const at = queue.rows.map((row) => showsMessage(row, message)).lastIndexOf(true);
      if (at < 0) throw changed(GROK_SEND_UNCONFIRMED_MESSAGE);
      if (at > 0) throw changed(grokQueuedBehindMessage(at));
      // the top row reads as the message, but an older row can be drawn the same way (the same cut prefix, first line and
      // line count, or words) while the message's own row is not drawn yet: it is the message only as the one row of a
      // queue that held none before the send
      if (before.queue?.mode !== "fullscreen") throw changed(GROK_SEND_UNCONFIRMED_MESSAGE);
      if (before.queue.rows.length > 0 || queue.rows.length > 1) throw changed(GROK_QUEUED_MESSAGE);
      if (seen.status !== "working" || !queue.enterSendsNow || !grokPromptEmpty(seen.screen)) throw changed(GROK_QUEUED_MESSAGE);
      return "press";
    }
    default: {
      const unreachable: never = queue;
      throw new Error(`unknown Grok queue ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * After the Enter that typed `message` into Grok (`delayMs` later, on a fresh read `look` that throws once the pane holds
 * another Grok session), one more Enter goes only when the screen shows the message as the one row of a queue that held
 * none before the send (`before`), herdr reports the pane working, and the shortcuts row offers `Enter:send now` over
 * Grok's empty prompt; and once more `delayMs` later, with the same one row: another row in its place says the message is
 * behind a row another client queued, and a second row under the same one says it is queued (the screen does not tell
 * whose the first row is). `lastScreen`: the screen once more, read last before the Enter's write when `look`
 * awaits more after its own read; that read must say the same, or nothing is pressed.
 */
export async function sendGrokQueuedNow(opts: {
  message: string;
  before: GrokBeforeSend;
  delayMs: number;
  look: () => Promise<{ status: string; screen: string }>;
  lastScreen?: () => Promise<string>;
  sendEnter: () => Promise<void>;
}): Promise<void> {
  // fixed wait: Grok draws the queued row after the Enter that queued it (SUBMIT_DELAY_MS; drawn by 150 ms when recorded)
  await Bun.sleep(opts.delayMs);
  const seen = await opts.look().catch(() => { throw changed(GROK_SEND_UNCONFIRMED_MESSAGE); });
  if (sendNowStep(seen, opts.before, opts.message) === "done") return;
  // the one row can be another client's, queued between the read before the send and its Enter and drawn the same way
  // (`yes`, the same first line and line count, the same cut prefix), with the message's own row not drawn yet: read once
  // more, and it must still be that one row. Left after it, a limit of reading a screen: such a row with the message's own
  // row drawn only after this read, as Grok draws no owner on a row
  // fixed wait: one more SUBMIT_DELAY_MS for Grok to draw a row queued after the one the read above showed
  await Bun.sleep(opts.delayMs);
  const again = await opts.look().catch(() => { throw changed(GROK_SEND_UNCONFIRMED_MESSAGE); });
  const [row] = onlyRows(seen.screen);
  const rows = onlyRows(again.screen);
  if (rows.length > 0 && rows[0] !== row) throw changed(grokQueuedBehindMessage(1));
  if (rows.length > 1) throw changed(GROK_QUEUED_MESSAGE);
  if (sendNowStep(again, opts.before, opts.message) !== "press") throw changed(GROK_SEND_UNCONFIRMED_MESSAGE);
  if (opts.lastScreen) {
    const screen = await opts.lastScreen().catch(() => { throw changed(GROK_SEND_UNCONFIRMED_MESSAGE); });
    if (sendNowStep({ status: again.status, screen }, opts.before, opts.message) !== "press") throw changed(GROK_SEND_UNCONFIRMED_MESSAGE);
  }
  await opts.sendEnter().catch(() => { throw changed(GROK_SEND_NOW_UNCONFIRMED_MESSAGE); });
}
