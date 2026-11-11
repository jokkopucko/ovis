### Fixed
- Opening a tool's row, or pressing "Show all" on a long output, at the end of a chat no longer
  scrolls you past what you opened now and then. It happened when the click came within a tenth of
  a second of the chat moving to its end (Jump to latest, or an answer still being written): the
  list was still keeping the end in view, so the lines you had just opened were scrolled past to
  the new end.
