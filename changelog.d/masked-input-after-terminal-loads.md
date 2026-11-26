### Fixed
- A pane opened while its program waits at a password prompt shows the masked input again on a slow
  device: the prompt drawn before the terminal's renderer finished loading is now read once it has.
