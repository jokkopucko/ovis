### Fixed
- `ovis tui` finds the core named in herdr's plugin settings, honors the desktop app's custom
  session, and keeps relative socket paths tied to the folder where the command was run.
- A core started by `ovis tui` over SSH no longer passes the forwarded X display to later panes.
- The desktop `ovis` command no longer uses a remembered port after its app's server stops.
