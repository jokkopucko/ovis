### Fixed
- Looking for herdr-core no longer runs an `hc` or `herdr-core` from a folder another account can
  change on Linux and macOS, nor lets one it runs find its helpers in such a folder, and the usual
  install places now come before the PATH (on Windows too). A path set in `OVIS_HC_BIN` is still
  run as named. A sticky folder further up (like `/tmp`) is allowed, and on macOS so is Homebrew's
  `admin`-writable `/opt/homebrew` and `/usr/local`, where another administrator could change it.
  When no herdr-core is found, the error names each one passed over and why. Where accounts come
  from a directory service (as with sss on Fedora and RHEL) a group-writable `~/.local/bin` is not
  trusted: run `chmod g-w ~/.local/bin` or set `OVIS_HC_BIN`.
- A Portal visitor that drives a PC can no longer switch its runtime between herdr and herdr-core,
  nor read its herdr-core session and runtime switch facts.
