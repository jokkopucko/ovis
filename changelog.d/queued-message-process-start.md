### Fixed
- A queued next-turn message is no longer typed into another process that took the agent's PID, or
  whose start can no longer be read, between its last check and the write, nor into a masked
  password prompt that came up during that last check. Nothing typed, it stays queued; with the
  paste already typed, it waits for your OK.
