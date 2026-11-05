### Fixed
- A fresh Devin CLI session on Linux opens as structured chat without a reported session ID or a
  resume argument: Ovis reads the session from the Devin process's own session lock. A resumed
  pane whose lock names another session (after switching sessions inside Devin) now falls back to
  the terminal instead of showing the old session.
