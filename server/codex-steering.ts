import { stripVTControlCharacters } from "node:util";

export interface CodexSteeringContext { agent: string | null; working: boolean; screen: string }
interface SteeringIO {
  read: () => Promise<CodexSteeringContext>;
  /** presses `key`; `fresh` is asked again when herdr is reached, and a stale write is withheld */
  press: (key: string, fresh: () => boolean) => Promise<void>;
  restarting: () => void;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

const EMPTY_COMPOSER = /^[›»](?:\s+Ask Codex to do anything)?$/;
const WORKING = /^[•◦]\s*(?:Working|Reconnecting(?:\.{3}|…)?(?: waiting for network)?)\s*\((?:\d+[hms]\s*)+•\s*esc to interrupt\)$/;
const STEERING_HINT = "Messages to be submitted after next tool call (press esc to interrupt and send immediately)";
const compact = (text: string) => text.replace(/\s/g, "");
function lastLine<T>(lines: T[], matches: (line: T) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index--) if (matches(lines[index]!)) return index;
  return -1;
}
/** The rows under the composer: the model and folder (with `fast` after the effort in Fast mode), context left, warnings, and (0.162) the shortcuts hint. */
export const FOOTER = /^(?:\S+(?:[ \t]+\S+){0,3}[ \t]+(?:default|minimal|none|low|medium|high|xhigh|max|ultra)(?:[ \t]+[Ff]ast)?[ \t]*·|\d+% context left\b|⚠\s*\d+\s*warnings?\b|(?:←[^·]*·\s*)?\?\s*for shortcuts\b|[/\\]|[A-Za-z]:\\)/;

/**
 * A native steering panel in the live composer, never a hint quoted in scrollback, whose last
 * entry is `text`: the message just submitted, not one that was already waiting. Codex wraps an
 * entry over indented rows and cuts a long one with a "…" row, so the entry is compared without
 * whitespace, and as the start of `text` when it was cut.
 */
export function codexSteeringPending(screen: string, text: string, beforeEnter = false): boolean {
  // the indent is kept beside the trimmed text: Codex tells an entry from its continuation rows by it
  const rows = stripVTControlCharacters(screen).split(/\r?\n/).map((raw) => {
    const line = raw.replace(/^│/, "").replace(/\s*│\s*$/, "").trimEnd();
    return { indent: line.length - line.trimStart().length, text: line.trim() };
  }).filter((row) => row.text);
  const lines = rows.map((row) => row.text);
  const composer = lastLine(lines, (line) => beforeEnter ? /^[›»](?:\s|$)/.test(line) : EMPTY_COMPOSER.test(line));
  if (composer < 0) return false;
  const footer = lines.slice(composer + 1);
  if (footer.length > 4 || footer.some((line) => !FOOTER.test(line))) return false;
  const status = lastLine(lines.slice(0, composer), (line) => WORKING.test(line));
  if (status < 0) return false;
  const panel = rows.slice(status + 1, composer);
  const isEntry = (row: { text: string }) => /^↳\s*\S/.test(row.text);
  const first = panel.findIndex(isEntry);
  if (first < 1) return false;
  if (compact(panel.slice(0, first).map((row) => row.text).join("").replace(/^[•◦]\s*/, "")) !== compact(STEERING_HINT)) return false;
  // the steering section ends at the next header: Codex lists end-of-turn and rejected inputs under their own
  const next = panel.findIndex((row, index) => index > first && /^[•◦]/.test(row.text));
  const section = panel.slice(first, next < 0 ? panel.length : next);
  // an entry starts at the arrows' indent; a deeper arrow is the message's own text on a continuation row
  const indent = section[0]!.indent;
  const entry = section.slice(lastLine(section, (row) => row.indent === indent && isEntry(row)));
  // Codex cuts a long entry with a "…" row of its own; an ellipsis ending a text row is the message's
  const cut = entry.length > 1 && entry[entry.length - 1]!.text === "…";
  const shown = compact((cut ? entry.slice(0, -1) : entry).map((row) => row.text).join("").replace(/^↳/, ""));
  const sent = compact(text);
  if (!sent || !shown) return false;
  return cut ? sent.startsWith(shown) : shown === sent;
}

/**
 * agy queues what Enter commits during a turn as `▸ <text> (alt+m to send immediately)` right above
 * its input box, one row per message cut with "..." on a narrow pane, the hint on the last one only.
 */
export function agySteeringPending(screen: string, text: string): boolean {
  const lines = stripVTControlCharacters(screen).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const composer = lastLine(lines, (line) => /^>(?:\s|$)/.test(line));
  // the box empty between its rules: alt+m is agy's "send with the opposite Queued Messages setting", which sends a draft too
  const empty = lines[composer] === ">" && /^─+$/.test(lines[composer + 1] ?? "");
  const entry = /^▸\s*(.*?)\s*\(alt\+m to send immediately\)$/.exec(lines[composer - 2] ?? "");
  if (composer < 2 || !empty || !/^─+$/.test(lines[composer - 1]!) || !entry) return false;
  const shown = compact(entry[1]!), sent = compact(text);
  const cut = /(?:\.\.\.|…)$/.exec(shown);
  // a row cut to its dots alone could be any message
  return !!sent && (shown === sent || (cut !== null && cut.index > 0 && sent.startsWith(shown.slice(0, cut.index))));
}

// Codex's Escape ends its turn and starts one with the message (`restart`); agy's alt+m adds it to the turn at work
const SEND_NOW: Record<string, { pending: (screen: string, text: string) => boolean; key: string; restart: boolean }> = {
  codex: { pending: codexSteeringPending, key: "Escape", restart: true },
  agy: { pending: agySteeringPending, key: "alt+m", restart: false },
};

/** Enter can leave steering pending until a tool boundary. Only Send now may send it at once, and only for `text`. */
export async function interruptCodexSteering(explicit: boolean, text: string, submitted: CodexSteeringContext, io: SteeringIO): Promise<void> {
  const agent = submitted.agent;
  const steer = agent !== null && Object.hasOwn(SEND_NOW, agent) ? SEND_NOW[agent] : undefined;
  if (!explicit || !steer || !submitted.working) return;
  const now = io.now ?? Date.now;
  const wait = io.wait ?? Bun.sleep;
  const deadline = now() + 1500;
  const unconfirmed = () => new Error("Immediate delivery was not confirmed. Check the terminal before sending again.");
  // The pane can already be holding identical text from its terminal, underneath our paste.
  if (agent === "codex" && codexSteeringPending(submitted.screen, text, true)) throw unconfirmed();
  while (now() < deadline) {
    // The caller rechecks live identity, lease, authority and interactive prompts in this read.
    const current = await io.read();
    if (current.agent !== agent) throw unconfirmed();
    if (now() >= deadline) break;
    if (!current.working) return;
    if (steer.pending(current.screen, text)) {
      if (steer.restart) io.restarting();
      // the RPC's connect is awaited: by the time herdr is written to, the deadline may have passed
      await io.press(steer.key, () => now() < deadline);
      return;
    }
    // A user row in scrollback can belong to an earlier terminal send. It cannot acknowledge Enter.
    await wait(Math.min(50, deadline - now()));
  }
  // agy draws no queued row for a message it took straight away (e.g. its turn ended before the status
  // said so), and a missed row only leaves it in agy's own queue: Enter went either way, so no resend
  if (!steer.restart) return;
  throw unconfirmed();
}
