### Fixed
- On a herdr-core server the page reads an agent's input row from the attach on, not only once the
  agent draws again: herdr-core's attach paint begins by ending a synchronized update that never
  began (`CSI ? 2026 l`), which no longer makes the page wait for a whole synchronized frame. Chat's
  note that a command's screen (Codex's `/model` list) is still open in the terminal shows again.
