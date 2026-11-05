### Fixed
- A Claude Code `/compact` sent from Chat no longer says "Done" when Claude compacts the
  conversation on its own before that `/compact` runs.
- Command receipts stay with the right conversation around `/clear` and `/resume`: a `/resume` back
  to an earlier conversation keeps the chips of the commands sent there, a slow poll no longer
  brings the left conversation's commands into a cleared chat, and a `/clear` typed in the terminal
  no longer shows the commands sent since the last Chat `/clear` in the new, empty chat.
