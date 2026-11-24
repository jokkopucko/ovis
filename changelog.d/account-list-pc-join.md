### Added
- A PC is added to an account that keeps a signed list by that list alone. `ovis add` shows a
  six-digit number that the device adding the PC shows too; the PC joins only after you say at the
  PC that they are the same (`yes` in the terminal, or `ovis add --confirm <number>` where nobody
  can type) and press **Add** on the device. `ovis join` joins such an account with an invite's
  line, which never leaves the command. A PC the list removed comes back only as a new PC, which
  `ovis add` offers in one confirmed step.
