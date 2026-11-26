### Fixed
- Clear a Send now copy when an Ovis-managed Codex server acknowledges that request or records
  its message ID. A matching line from another terminal no longer counts as confirmation.
  A stale copy already cleared by that transcript receipt is not sent again after a bridge restart.
