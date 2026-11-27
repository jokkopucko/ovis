### Fixed
- Pressing Send now on a second queued message in a Codex app-server pane while an earlier Send now
  is restarting the turn now keeps waiting for the restarted turn before draining later queued
  messages.
- Unconfirmed pending sends (`uncertain`) now keep their committed turn gate across native
  transcript confirmation or dismissal and block new queued sends from typing at once behind an
  uncertain message.
