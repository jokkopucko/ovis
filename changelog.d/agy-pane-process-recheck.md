### Fixed
- An Antigravity pane no longer counts another process's background tasks, or shows the greeting
  of a new conversation, when its agent exits and that process number is reused while Ovis looks
  its conversation up: the pane's process is asked of herdr again after its locks are read, and
  the answer stands only when it is still the same process.
