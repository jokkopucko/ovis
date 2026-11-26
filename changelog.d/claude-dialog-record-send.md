### Fixed
- Chat no longer types a message into a dialog Claude Code draws in its input box's place that Ovis
  could not read from the screen (such as `/model`'s list or `/add-dir`'s confirmation): Claude's
  own record of what it waits on now refuses the send, and the message waits until the dialog is closed.
