/** The server refused the message before any of it reached the pane: nothing was typed.
 * Unknown failures are ambiguous on both sides of a held-copy resend. */
/** The bridge's `agent_not_ready` message when no agent is in front of the pane at all (#511); the same code also says an agent's input state is unknown. */
export const NO_AGENT_MESSAGE = "No agent is in front of this pane now; nothing was typed";

/**
 * The bridge's `pasted_not_sent` message (#511): a message for an agent alone was pasted, then its Enter was held
 * back as its agent was no longer in front. The text may sit in the terminal's input line; it is never pasted again
 * automatically, and the code is no proof that nothing was typed (submitNotTyped).
 */
export const PASTED_NOT_SENT_MESSAGE = "The message is in the terminal's input line, not sent; clear it or press Enter there";

export function submitNotTyped(code: string): boolean {
  return ["agent_blocked", "read_only", "submit_timeout", "agent_not_ready", "pending_input_unsupported", "invalid_delivery", "invalid_submit_text",
    "invalid_submit_id", "pending_limit", "pending_not_found", "pending_busy", "invalid_pending_action", "pending_target_changed", "first_message_launch_ended", "pending_lease_lost", "not_attached", "input_not_ready", "attach_held", "pane_not_found", "retired_submit_id", "input_draft",
    // Claude Code's rewind dialog was on screen: nothing went into it
    "rewind_dialog_open",
    // refused by this view while the terminal holds input (PaneTerminal), before anything was sent
    "held_input",
    // the connection dropped before the request's frame left the browser (HerdrSocket)
    "not_transmitted",
    // the wait for the bridge's snapshot ended before it said what the bridge takes: nothing left (HerdrSocket)
    "capabilities_unknown",
    // a message for an agent alone was not sent to a bridge that cannot keep that rule (HerdrSocket)
    "agent_only_unsupported"].includes(code);
}
