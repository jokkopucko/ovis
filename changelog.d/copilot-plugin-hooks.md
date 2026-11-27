### Changed
- A GitHub Copilot CLI (1.0.109 or later) that Ovis starts tells Ovis its session and the end of each
  turn through a hook plugin mounted for that launch alone (`--plugin-dir`), so Chat shows the
  session that very process runs and the pane reads DONE as soon as the turn ends. Copilot's own
  settings, hooks and installed plugins are left as they are.
