/** An input_draft refusal over typed text in an agent's box other than Claude Code's or Hermes' (server/core/composer.ts freeAgentInput). */
export const AGENT_INPUT_DRAFT_MESSAGE = "The agent's input box in the terminal holds typed text; send or clear it there, then send this message";

/** An input_draft refusal over Claude Code's box holding a paste or an image it folded, whose lines are not shown: no send anyway (#3563). */
export const CLAUDE_FOLDED_DRAFT_MESSAGE = "Claude Code's input box holds a paste or an image it folded, whose lines are not shown here; send or clear it in the terminal, then send this message";

/** The bridge's `agent_not_ready` message when no agent is in front of the pane at all (#511); the same code also says an agent's input state is unknown. */
export const NO_AGENT_MESSAGE = "No agent is in front of this pane now; nothing was typed";

/**
 * The bridge's `submit_changed` message when Send now queued its message in a working Grok and pressed nothing more
 * (server/core/grok-queue.ts): Grok's screen showed the message queued, but not as the one row of a queue empty before
 * it under Grok's empty prompt, whose Enter sends it now; or Grok was in minimal mode, where Send now presses nothing more.
 * It names no reason, as these differ.
 */
export const GROK_QUEUED_MESSAGE = "The message is in Grok's queue and goes when Grok gets to it; nothing more was pressed";

/** The same, when the user had `count` rows queued in Grok before it: Send now never sends those. */
export const grokQueuedBehindMessage = (count: number): string =>
  `The message is in Grok's queue behind ${count} queued before it and goes when they do; nothing more was pressed`;

export function grokQueuedAhead(message: string): number | null {
  const match = /^The message is in Grok's queue behind (\d+) queued before it and goes when they do; nothing more was pressed$/.exec(message);
  return match ? Number(match[1]) : null;
}

/** The bridge's `submit_changed` message when the Enter that would send a Grok's queued message now may not have gone. */
export const GROK_SEND_NOW_UNCONFIRMED_MESSAGE = "The message went to Grok's queue, but sending it now was not confirmed. Check the terminal before sending again.";

/**
 * The bridge's `submit_changed` message when, after Send now's Enter into a working Grok, Grok's screen did not show
 * where the message went: no queued row while herdr reports it working, another row, a screen not read, a failed read.
 */
export const GROK_SEND_UNCONFIRMED_MESSAGE = "Grok's screen did not show where the message went after its Enter, so nothing more was pressed. Check the terminal before sending again.";

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
    "held_input",
    "not_transmitted",
    "capabilities_unknown",
    // a message for an agent alone was not sent to a bridge that cannot keep that rule (HerdrSocket)
    "agent_only_unsupported",
    // a hold that must never go on its own was not sent to a bridge that cannot hold one (HerdrSocket)
    "pending_hold_unsupported"].includes(code);
}
