### Fixed
- `ovis tui` no longer stays frozen after a quick `fg`: when its job was stopped from the shell, the
  shell could report it stopped before the screen had stopped, and an `fg` typed at once was lost.
