### Fixed
- The installer no longer takes a hung Rust PTY host for a working one when the host exits cleanly as
  its timed-out check is stopped; it falls back to Node as intended.
