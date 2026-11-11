### Fixed
- A message queued for a Claude Code pane no longer goes into the turn Claude just began by itself
  because a background task ended (a subagent, a background command, a monitor or a workflow), once
  Claude has written that turn's prompt: for up to a minute after that it waits for the turn to end,
  whatever herdr reads the pane as meanwhile, as after a `/loop` wakeup. A message already waiting
  when the turn begins can still go into it if herdr reads the pane as idle before Claude writes
  that prompt, as before this change. When such a turn is interrupted, or ends in a session
  whose Claude Code writes no end-of-turn entry, the pane's queue can stay held for up to about a
  minute after the turn began though the pane shows as idle, and for as long as such turns keep
  beginning less than a minute apart; Send now still sends a waiting message at once. A turn that
  begins this way while a message is being typed, in the few tenths of a second between its paste
  and its Enter, leaves the text in Claude's input line, with the message marked as not confirmed,
  instead of sending it into that turn. That can happen to a message that waited behind a turn
  during which the task ended, as that turn's end both sends the message and begins the new turn.
