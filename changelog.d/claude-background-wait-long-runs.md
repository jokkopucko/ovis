### Fixed
- A Claude Code pane waiting on a long CI run, deploy or test suite over several turns no longer
  reads DONE and alerts "work finished" once its first rest is 30 minutes old: each rest is held
  on its own, and a `Monitor` or `/loop` wakeup the turn started holds it too.
