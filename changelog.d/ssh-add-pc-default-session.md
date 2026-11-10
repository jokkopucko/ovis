### Fixed
- A PC added over SSH with "Use Default session" (offered when it runs both herdr and its own Ovis)
  starts herdr by itself again after that PC restarts, instead of stopping at "the herdr session
  chosen for this PC is no longer running".
- Installing Ovis on a PC that is not added yet no longer ends in a choice between that PC's Ovis
  and its herdr, which the install could not show: it connects to the herdr running there.
