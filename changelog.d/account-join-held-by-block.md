### Fixed
- On a PC that follows no account list, `ovis approve` no longer says a device "is let in" when a
  block on that PC keeps it out: it says the device is not let in until the block is lifted, and
  an up-to-date device says the PC keeps it out for now instead of "Nobody approved this device"
  (an older app still shows that generic message).
