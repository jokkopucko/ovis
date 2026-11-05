### Fixed
- A Claude Code turn no longer shows "Working…" end about a second before its answer, as if it
  had ended with no answer: the chat keeps the turn at work until the answer is read, or for up
  to 2 seconds with no new transcript content.
- `/clear` in an empty Claude Code chat no longer flashes "Conversation unavailable" and drops
  the composer to the bottom: the greeting stays in place.
