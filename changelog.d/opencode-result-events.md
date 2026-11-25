### Changed
- On OpenCode 2, a `/compact` sent from Chat is marked done when the compaction it started ends, instead of staying
  "sent"; a compaction OpenCode starts by itself, or one that was already running, does not count, and one that fails
  leaves it as it was.
