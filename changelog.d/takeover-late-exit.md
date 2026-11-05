### Fixed
- A tab another browser took a pane from no longer shows herdr's "terminal attach taken over"
  line when herdr's attach takes more than a tenth of a second to exit, as on a busy PC. The
  line is held for up to 2 seconds; an exit later than that comes too late, so the line is shown
  and stays.
