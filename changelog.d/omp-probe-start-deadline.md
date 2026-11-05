### Fixed
- An omp pane's Chat no longer falls back to the terminal view on a busy PC: the helper that reads
  which session store omp uses now has its one-second deadline for its read alone, not for its own
  start as well.
