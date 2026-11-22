/**
 * Hermes ignores a lone Escape; its interrupt is Ctrl+C, and that same key exits an idle Hermes
 * (measured on Hermes 0.21.5, classic CLI and TUI) and force-quits the classic CLI on a second
 * press within 2 s. So Stop sends one Ctrl+C, and only while Hermes' own input row says a turn
 * is running: the classic CLI's `msg=interrupt · /queue · … · Ctrl+C cancel` or the TUI's
 * `Ctrl+C to interrupt…`.
 *
 * Only the bottom-most `❯` row is read: a message echoed in the transcript sits above it, so
 * quoted hint text there never counts. A draft typed into Hermes hides the hint, and Stop then
 * sends nothing rather than guess.
 */
export function hermesInterruptible(rows: readonly string[]): boolean {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    // the row's first `❯` is the prompt: one after it is text typed into the input
    const at = row.indexOf("❯");
    if (at < 0) continue;
    const input = row.slice(at + 1).trim();
    return /^msg=\w+ · .*Ctrl\+C cancel$/.test(input) || /^Ctrl\+C to interrupt(?:…|\.\.\.)$/.test(input);
  }
  return false;
}

/** Hermes force-quits the classic CLI on a second Ctrl+C within this window of the first. */
export const HERMES_CTRL_C_WINDOW_MS = 2000;

/**
 * True while a Ctrl+C sent at `lastCtrlCAt` is still inside Hermes' force-quit window. Status
 * flicker or a quick new turn resets the per-turn guard, so the time of the last Ctrl+C decides.
 */
export function hermesCtrlCTooSoon(lastCtrlCAt: number | null, now: number): boolean {
  return lastCtrlCAt !== null && now - lastCtrlCAt < HERMES_CTRL_C_WINDOW_MS;
}

/**
 * Grok's cancel is Ctrl+C, which its own key row names while a turn runs (`Shift+Tab:mode  │  Ctrl+c:cancel  │ …`,
 * Grok 1.0.77); Escape is its scrollback key, and an idle Grok's key row has no cancel. Only the screen's last
 * written row is read, so a quoted hint above it never counts.
 */
export function grokCancellable(rows: readonly string[]): boolean {
  const last = [...rows].reverse().find((row) => row.trim() !== "");
  return last !== undefined && /(?:^|│)\s*Ctrl\+c:cancel\s*(?:│|$)/.test(last.trim());
}

/**
 * Agents whose interrupt is Escape pressed twice: one press only arms it ("esc again to interrupt" in Kilo 7.8,
 * "esc twice to interrupt" in Devin 3000.12), or does nothing (maki), and Devin's single Escape moves the running
 * command to a background shell instead. Measured in the agent lab, 2026-11-12.
 */
const DOUBLE_ESCAPE_AGENTS: ReadonlySet<string> = new Set(["devin", "kilo", "maki"]);

/** The gap Chat's Stop leaves between the two Escapes, well inside the window each of those agents gives the second. */
export const DOUBLE_ESCAPE_GAP_MS = 150;

export type StopKey = "\u001b" | "\u001b\u001b" | "\u0003" | null;

export function stopKey(
  agent: string | null | undefined,
  rows: () => readonly string[],
  sentThisTurn: boolean,
  lastCtrlCAt: number | null,
  now: number,
): StopKey {
  if (agent === "hermes" || agent === "grok") {
    if (sentThisTurn || hermesCtrlCTooSoon(lastCtrlCAt, now)) return null;
    return (agent === "hermes" ? hermesInterruptible(rows()) : grokCancellable(rows())) ? "\u0003" : null;
  }
  return agent && DOUBLE_ESCAPE_AGENTS.has(agent) ? "\u001b\u001b" : "\u001b";
}
