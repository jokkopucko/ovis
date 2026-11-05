### Fixed
- Reading the background-command history of a long Claude transcript on slow storage, such as an
  SSHFS home, no longer blocks the server for its bulk reads, and reads each part once instead of
  once for every task notification or task ID in it. One stuck transcript no longer holds up the
  history of other sessions. On a local Linux filesystem, a transcript the page cache holds is
  still read as fast as before.
