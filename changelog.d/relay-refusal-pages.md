### Fixed
- A signed-in device that a PC of its account does not let in, and never let in (a sign-in the
  account does not count yet, such as one without two-step), is offered the PC's join instead of
  being told it was removed from that PC.
- **Ask again** on the line that says a device was removed from a PC asks that PC to let it join,
  at once. It used to open the PC by the account's key again, which brought the same line back.
- The join a sign-in's launch asked, refused by the PC before anybody was asked (a PC not in the
  account yet, or one paused after too many tries), says the PC cannot take this device yet,
  rather than that it was not allowed.
