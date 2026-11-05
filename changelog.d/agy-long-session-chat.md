### Fixed
- Antigravity chat no longer falls back to the terminal on a long session whose conversation
  database and its write-ahead log pass 32 MiB during a turn; a catalog that has not changed for
  a few seconds is no longer copied on every read.
