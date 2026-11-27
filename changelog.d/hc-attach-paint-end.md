### Fixed
- On herdr-core, a terminal opens at its newest rows even when the PC is busy: the server now waits
  for the end of herdr-core's history replay instead of guessing it from a 15 ms pause.
