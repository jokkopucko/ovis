### Fixed
- A message queued behind one Ovis sent to a Codex it started on herdr-core now waits for Codex's own
  word that the turn ended. It is no longer typed into a turn that is still running when the pane's
  status lags, and no longer held as "the next turn did not start in time" when Codex had already
  taken the turn.
