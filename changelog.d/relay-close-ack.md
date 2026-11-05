### Fixed
- A phone that closes its relay connection is no longer left showing itself connected for about
  17 seconds: the relay answers the close at once, and what is typed while the connection is closing
  stays a draft instead of being lost.
