### Fixed
- A Chat send to Claude Code is no longer refused when Claude's input box holds only the chat's own
  long message, folded as "[Pasted text #N +M lines]", that Claude put back after the turn was
  stopped. Ovis clears it and sends only when Claude's own prompt history shows it is that message.
