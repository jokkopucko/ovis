### Fixed
- Add PC over SSH with "Add it to my account" no longer offers "Continue in background" while it
  updates that PC's Ovis first: the add runs from the dialog once the update connects, so closing it
  there left a plain SSH PC that was never added. The dialog now asks to stay open until the PC
  connects.
