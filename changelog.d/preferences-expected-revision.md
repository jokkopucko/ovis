### Fixed
- Two devices or programs saving shared preferences at the same moment no longer silently undo each
  other's pins, muted panes or other list settings: each save names the revision it read, a stale
  one is refused, and the browser re-applies only its own change on top of the newer one.

### Added
- `PUT /api/preferences` takes an optional `expected_revision`; when another write came first it
  saves nothing and answers 409 `revision_conflict` with the current document.
