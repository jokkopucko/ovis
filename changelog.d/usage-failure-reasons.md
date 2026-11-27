### Changed
- Subscription usage says why an account's limits could not be read (the provider is busy or down,
  it answered too slowly, it sent something that is not its usage, this PC could not connect, or
  the Hub could not read the account) instead of "could not be reached" for all of them, and a
  failed or rate-limited Claude sign-in on this PC also offers to read Claude's status line.
- A Claude that Ovis starts now keeps the limits its status line shows, and Subscription usage
  shows them before asking Claude's usage endpoint, without the Settings switch.
