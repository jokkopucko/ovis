### Fixed
- A pane moved to another workspace from outside this browser (herdr's own window, another browser)
  no longer leaves its queued and held messages behind under its old ID: they follow the pane, held
  for an explicit send. Its terminal also connects under the new ID at once, without waiting for an
  attach still open under the old one, and the server tells browsers which pane moved where.
