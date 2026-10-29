/** The server refused the message before any of it reached the pane: nothing was typed.
 * Unknown failures are ambiguous on both sides of a held-copy resend. */
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
