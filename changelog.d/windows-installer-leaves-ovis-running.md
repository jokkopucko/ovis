### Changed
- The Windows installer (`irm https://ovis.sh/install.ps1 | iex`) now ends with Ovis running on a PC
  where herdr was not running: it starts herdr's server with no window, and the app with it, in your
  signed-in desktop, also when it runs over SSH or from a coding agent's command, and sets herdr to
  start at your sign-in, the same Startup entry (`Ovis`) the Ovis app for Windows sets. It needs no
  administrator and sets up no Windows service. `-NoService` (`OVIS_NO_SERVICE=1`) starts herdr once
  and sets up no sign-in start. Over SSH with nobody signed in at the PC it starts nothing unless
  given `-Headless` (`OVIS_HEADLESS=1`), which starts herdr without a desktop. A herdr that already
  runs is left as it is.

### Added
- `& ([scriptblock]::Create((irm https://ovis.sh/install.ps1))) -Add -Account <id>` (or
  `OVIS_ADD_ACCOUNT=<id>` before `irm https://ovis.sh/install.ps1 | iex`) adds a Windows PC to your
  Ovis account with no terminal, as a script or a coding agent runs it: the installer runs
  `ovis add --account <id>` and fails when the PC was not added. `-Add` alone runs `ovis add` at a
  terminal.
- `& ([scriptblock]::Create((irm https://ovis.sh/install.ps1))) -JoinFile <file> -Account <id>` (or
  the line in `OVIS_JOIN`) joins a Windows PC to your Ovis account with an invite a device of it made,
  with no sign-in on the PC: once Ovis runs, the installer runs `ovis join` with the line in its
  environment, never on a command line, and fails unless the PC joined, saying why in one line.
  Without `-Account` it runs the join at a terminal, which asks whether the invite's account is yours,
  and where nobody can answer it refuses before installing anything.
  `-Help` lists the installer's options.
