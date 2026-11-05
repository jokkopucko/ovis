### Fixed
- A Chat link to a local file written percent-encoded (`/a%20b/%EC%82%AC%EC%A7%84.png`), as agents
  write paths with spaces or non-ASCII names, opens that file instead of "no readable file".
