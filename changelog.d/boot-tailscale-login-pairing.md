### Fixed
- After the PC restarts, your own devices on Tailscale are no longer asked for a pairing code for
  up to five minutes: Ovis reads the PC's Tailscale login again once Tailscale has finished
  starting, instead of keeping the empty answer it got at boot.
