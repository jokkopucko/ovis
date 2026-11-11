### Fixed
- On Linux and macOS, Codex Chat can identify its conversation from the full Thread ID enabled in `/statusline`, even when only tool output is visible. The lookup checks the local loaded thread and rechecks the footer when reading it; it does not save a stale thread binding after `/new` or a picker resume.
