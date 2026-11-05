### Added
- `POST /api/workspace/create` and `POST /api/tab/create` take an optional `env` object, set in the new
  pane's shell and any agent started there, so an API client no longer has to type variables as a
  command prefix. Names must be shell identifiers and values text without control characters (at
  most 64 names, 32 KiB in all); anything else is refused with 400 `invalid_env`.
