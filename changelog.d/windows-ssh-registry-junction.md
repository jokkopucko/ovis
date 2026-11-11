### Fixed
- Windows PCs reconnect over SSH after the Ovis state-directory migration, without failing to
  write the bridge launcher, start herdr in the desktop session or read startup status through an
  untrusted mount point. Registry paths with brackets are treated literally, and the bridge keeps
  starting from the user's home directory.
