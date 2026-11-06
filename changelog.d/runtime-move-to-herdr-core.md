### Added
- Move everything to herdr-core in one click (Settings > About, on a PC running herdr): every
  workspace, tab, split and pane name comes along, agents reopen on their own conversation (or
  start new in the same folder when it cannot be told), and shells start in the same folder. Ovis
  ends an idle Claude Code itself; other agents wait for you to end them, so nothing typed in their
  input is sent. Nothing moves while an agent works or a shell runs a command: the move waits for
  them. If any step fails, Ovis puts back in herdr what it can and lists what it could not; herdr
  itself is never closed.
