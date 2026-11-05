### Fixed
- On herdr-core, closing a tab or pane in the Herdr app (or in Ovis) no longer sends a "terminal
  ended" notification, as closing one in herdr does not. A program that exits by itself, or is
  ended by a signal from elsewhere, still sends one.
- Closing a pane, on herdr or herdr-core, now clears what it held as an ended pane does: a message
  still waiting for it is turned away instead of waiting for good, and a sign-in tab closed no
  longer sends a "terminal ended" notification either.
