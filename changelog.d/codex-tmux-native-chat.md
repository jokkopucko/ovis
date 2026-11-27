### Fixed
- Codex chat can read a native conversation through a verified local tmux attachment when the
  Codex process holds its transcript open, or its own app server holds the transcript and its
  writer lock. A shared daemon or an unproven attachment keeps the terminal view.
