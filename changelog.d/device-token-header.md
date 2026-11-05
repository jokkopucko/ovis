### Added
- A script or CLI can pair as a device of its own: `POST /api/devices/pair` with
  `Accept: application/json` returns the device's token, which then works as
  `Authorization: Device <token>` with the same role, last-seen time and Revoke as a paired
  browser's cookie.
