### Fixed
- Opening the whole output of a Letta Code tool call no longer stalls every other request and
  terminal while its transcript is searched: one very long line held the server for seconds. The
  search runs on a file thread, one transcript at a time, and reads a long line once instead of
  copying it again at every read. While no file thread is free the output answers "try again" (503)
  rather than "not found", and a pane that moved to another conversation meanwhile gets no output.
