### Added
- Settings → About → Terminals can switch this PC between herdr's TUI and the Herdr app
  (herdr-core) when it has both: Ovis asks first, restarts on the chosen runtime and shows it in
  place; a start that fails goes back to the previous runtime. Without `OVIS_RUNTIME` and a choice
  made there, a PC with no trace of herdr's TUI but the Herdr app's core serves the Herdr app.

### Fixed
- On the Herdr app runtime, Settings no longer shows herdr-core's version as herdr's or offers
  Update herdr, and the header names herdr-core.
- With `OVIS_RUNTIME=herdr-core`, an hc an update moved is found again where the start looked,
  the login shell's `PATH` included, and only after its `--version` checks out.
