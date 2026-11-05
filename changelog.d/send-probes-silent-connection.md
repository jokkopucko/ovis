### Fixed
- A message sent right after the network came back (a phone moving from Wi-Fi to cellular, a
  laptop waking on another network) no longer waits about 25 seconds before Ovis notices the old
  connection is gone: when the PC has said nothing for 3 seconds after a send, the connection is
  checked at once and replaced if it does not answer.
