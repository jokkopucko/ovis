### Fixed
- A managed start no longer fails when herdr's socket file is left over from a herdr that was
  killed or lost power: a socket that refuses the connect counts as a stopped herdr, like no socket.
