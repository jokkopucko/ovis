### Fixed
- On a phone paired through the Ovis relay, opening a PC's file in a tab of its own or as a raw
  file, following a link there, reloading, tapping Reconnect or tapping an alert no longer puts the
  file's path, the workspace's name or the pane in a request to app.ovis.sh: the page keeps them in
  its address's fragment, which the browser never sends. A link saved from an older version still
  sends them with its first load; the page then moves them into the fragment, so later loads don't.
