### Fixed
- Adding a PC over SSH now asks which to use when that PC runs both herdr and its own Ovis on
  herdr-core: before, a herdr running there was taken without a word, so the PC's herdr-core
  terminals could not be reached over SSH until that herdr was stopped. A PC already saved
  reconnects as before.
