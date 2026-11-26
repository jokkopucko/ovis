### Changed
- The one-line installer now ends with Ovis running on a PC where herdr was not running (just
  installed, or stopped): it starts herdr's server headless, and the app with it, and sets up what
  starts herdr again: on a Linux PC used without a desktop the user service `ovis-herdr`, only where
  lingering is on or can be turned on without a password, so herdr starts at boot and keeps running
  after a logout; on a Mac the Mac app's `sh.ovis.herdr-server` LaunchAgent. On a Linux desktop
  (its session, a display manager or a graphical session), without lingering, or with `--no-service`
  (`OVIS_NO_SERVICE=1`) it starts herdr once and sets up nothing, and it removes a service an earlier
  run set up where none is wanted now. The service never stops herdr, a herdr that already runs is left as it
  is, and the guide's Uninstall removes the service. Its last lines say what runs, what starts it
  again, `ovis status` to see it and `ovis stop` to stop it.

### Added
- `curl -fsSL https://ovis.sh/install.sh | sh -s -- --add --account <id>` (or
  `OVIS_ADD_ACCOUNT=<id>`) adds a new server to your Ovis account with no terminal, as a script or a
  coding agent runs it: the installer runs `ovis add --account <id>` and exits non-zero when the PC
  was not added.
- `curl -fsSL https://ovis.sh/install.sh | sh -s -- --join-file <file> --account <id>` (or the line in
  `OVIS_JOIN`) joins a new PC to your Ovis account with an invite a device of it made, with no sign-in
  on the PC: once Ovis runs, the installer runs `ovis join` with the line in its environment, never on
  a command line, and exits non-zero unless the PC joined, saying why in one line. Without `--account`
  it runs the join at a terminal, which asks whether the invite's account is yours, and where nobody
  can answer it refuses before installing anything. `--help` lists
  the installer's options.
