### Fixed
- A slow phone that is the only one viewing a pane on herdr-core no longer loses its terminal
  ("reopen the pane") when an agent prints a large burst of Korean or emoji text: it may now hold
  the pane's output paused for up to 60 s while it catches up, instead of 10 s.
