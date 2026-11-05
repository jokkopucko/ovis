### Added
- The one-line installer (`install.sh`) sets Ovis up on a Linux or macOS PC that has herdr-core (`hc`)
  and no herdr: it installs neither herdr nor the plugin, builds Ovis in `~/.local/share/ovis/app`,
  runs it on herdr-core, and starts it at login from a user service (systemd on Linux, launchd on
  macOS). `OVIS_RUNTIME=herdr` or `herdr-core` picks the runtime by hand. On Windows,
  `install.ps1` keeps herdr and says why.
