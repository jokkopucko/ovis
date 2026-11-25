### Fixed
- A failed repair of the read receipts file no longer removes it from its original location.
- Read receipts saved while the server stops are written in one go, still mark the terminal read in the Herdr app, and a busy server asks the browser to send them again instead of dropping them.
