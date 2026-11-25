### Fixed
- Live terminals no longer fall back to a mirrored view when the PC's Node takes more than 3 seconds
  to answer its first start (a cold disk right after boot) and the Rust PTY host is not there.
