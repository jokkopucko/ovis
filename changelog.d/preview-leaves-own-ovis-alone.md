### Fixed
- The Mac preview app no longer takes over a PC's released Ovis when it reaches that PC over SSH:
  it used to find that Ovis, offer to update it to the newest release of its own channel and, in an
  account add, take it into the preview's test account. It now leaves that Ovis alone, adds no PC
  to its account over SSH and installs no Ovis on another PC.
