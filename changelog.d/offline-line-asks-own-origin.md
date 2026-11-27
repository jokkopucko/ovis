### Fixed
- A hosted app built with no account service (`OVIS_ACCOUNT_SERVICE_URL=off`) said the device was
  offline and refused to open a PC whenever the browser said so, even on a working network. It now
  asks its own address first and opens the PC when that answers.
