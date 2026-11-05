### Fixed
- A workspace or tab create request with a first message but no page connection (a script or CLI)
  now says in its answer that the message is held (`first_message.held`), instead of reading as
  queued while the agent sits idle.
