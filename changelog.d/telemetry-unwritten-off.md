### Fixed
- When an Ovis server stops partway through turning usage counts off, and another server shares
  its state folder, a browser tab that missed the off can no longer get settings from before
  the off sent with the next install or update event.
