### Fixed
- Ovis on Windows can add a Linux or macOS PC to your account over SSH (Add PC over SSH with "Add it
  to my account"), which it refused before. It needs OpenSSH 9.4 or newer for the ssh Ovis uses on
  Windows (Git for Windows' today), and says so when it is older.
