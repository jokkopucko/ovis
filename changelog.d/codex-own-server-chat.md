### Fixed
- A Codex that Ovis starts on herdr-core now opens in Chat again, even for a one-line exchange and after a
  server restart. Ovis asks that Codex's own server which conversation it holds for the pane instead of matching
  the screen against every conversation in the folder. After `/new` or a resume, while that server holds more than
  one conversation, the screen picks among those only, and the pane falls back to the terminal when it cannot tell.
