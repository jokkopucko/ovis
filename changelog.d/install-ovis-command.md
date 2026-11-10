### Added
- The installer puts an `ovis` command in `~/.local/bin` (Linux and macOS): `ovis add` adds the PC to
  your Ovis account from its terminal, `ovis pair` shows a pairing code and `ovis status` says whether
  the app runs. It finds the installed Ovis each time it runs, so updates need no new command, and
  on a plugin first installed before `ovis add` existed it runs the release that Settings → Updates
  installed for that plugin and port, found with the plugin's own `env` and `.env` settings. An `ovis`
  of your own in `~/.local/bin` is never replaced, and none is written where it would take the name of
  another `ovis` on your PATH; one that comes first there keeps the name until `~/.local/bin` is put
  before it.
- `curl -fsSL https://ovis.sh/install.sh | sh -s -- --add` (or `OVIS_ADD=1`) ends the install by adding
  the PC to your account at the terminal; without a terminal to answer at, or while the app is not
  running yet, the installer prints the command to run. Its last lines now name `ovis add`, and say to set `OVIS_TOKEN` first on a PC other
  people log in to.

### Fixed
- On Windows, `scripts/plugin.ps1` passes a command's flags on (`plugin.ps1 link --code`) instead of
  dropping them.
