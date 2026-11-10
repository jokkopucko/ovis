### Fixed
- Searching a conversation that holds a very long line of `[` that never close (a pasted log,
  minified text) no longer stalls the server. Such a line was read in time that grew with the
  square of its length, 36 seconds for 200,000 characters, and every terminal and request waited
  until the search was done.
