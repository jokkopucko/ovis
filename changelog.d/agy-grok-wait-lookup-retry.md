### Fixed
- An agy or grok pane waiting on a background task or timer no longer reads DONE and alerts, then
  reads BG again, when one lookup of its session fails: the wait is dropped only when the next
  lookup, ten seconds later, fails too. A pane whose session cannot be found is no longer looked up
  on every refresh: only every ten seconds, and when its status changes.
