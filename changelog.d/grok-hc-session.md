### Fixed
- Grok chat on herdr-core (Linux) now binds the active session via `<GROK_HOME>/active_sessions.json`
  when no Herdr session report is present, still confirmed by the process's strictly newest held
  `events.jsonl`, and resolves the native Grok binary behind an npm `node`/`bun` launcher.
