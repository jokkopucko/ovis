### Added
- Settings → About → Terminals says which runtime this PC serves, herdr's TUI or the Herdr app
  (herdr-core). On herdr's TUI, when the Herdr app's core is on the same PC too, it says how to
  show the app's terminals instead.

### Changed
- With `OVIS_RUNTIME=herdr-core`, Ovis finds `hc` the way the Herdr app does: `OVIS_HC_BIN`, the
  `PATH`, the login shell's `PATH`, then the usual install places such as `~/.local/bin`, taking
  only one whose `--version` says `hc`, so an unrelated `hc` from a window manager is passed over.
  When none answers, Ovis does not start and says where it looked.
