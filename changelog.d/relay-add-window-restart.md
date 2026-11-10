### Fixed
- A PC waiting to be added to an account keeps its pairing window when its server restarts (an update),
  for the rest of the window's ten minutes, instead of refusing the device that then asks. The window
  closes on Revoke all, Reset relay identity and turning the relay off, and `POST /api/relay/link/close`
  closes it on request.
