### Fixed
- With herdr-core, a pin or unpin made in the Herdr app is no longer overwritten when it comes
  while Ovis is still writing its own pin, when Ovis could not save it, or when `preferences.json`
  was lost and another pinned agent started the list again.
