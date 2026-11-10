### Fixed
- A signed-in dashboard with no PC now says how to add one: install Ovis on the PC (the macOS or
  Linux line and the Windows line each have a Copy button), sign in there with the same provider
  account, and choose Add this PC to my account. It also says that GitHub and Google are separate
  Ovis accounts until linked (an account signed in with Apple is told a PC signs in with GitHub or
  Google only), and Check again re-reads the account's PCs at once instead of waiting for the
  next refresh, also when a read was already under way. When the account's PCs could not be read,
  the steps are not shown under that notice.
