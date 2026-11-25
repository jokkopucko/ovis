### Fixed
- A device the account just let in, opening a PC (in an account with no signed list) that has not
  read it yet, is told the PC is checking the account and asks again, instead of being refused
  until the PC's next read. Once a read finished without the device, it is refused as before.
