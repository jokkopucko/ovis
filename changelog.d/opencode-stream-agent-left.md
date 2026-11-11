### Fixed
- Ovis lets go of OpenCode's event stream within seconds of OpenCode leaving its last pane, even
  when herdr says nothing of it (seen on a busy host): herdr may change the pane's agent without an
  event, or keep calling it OpenCode with only the shell left in front. A pane that holds the stream
  is now read again each time its check is due, and the shell alone in front releases it.
