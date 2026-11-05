### Fixed
- Typing sent just before a connection closes is no longer lost when it never reached the PC: until
  the PC confirms it, it is kept, and a connection that ends first shows it as held input to send or
  discard. A PC too old to answer pings keeps the earlier behaviour, where such typing is lost.
