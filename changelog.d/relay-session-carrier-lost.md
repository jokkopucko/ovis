### Fixed
- The PC's server log names a relay session whose device went away (a reload, the app put away, the
  network gone) `carrier_lost`, not `internal_error`: nothing failed on the PC, and `internal_error`
  is left to a session the PC itself could not go on with.
