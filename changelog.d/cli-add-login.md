### Changed
- `bun scripts/plugin.ts add` and `login` now run `link`, the terminal command that signs a PC with
  no screen in and adds it to your account. While it waits it reopens its approval window every 30
  seconds and waits for an Ovis server that restarts instead of ending the sign-in, so a restart no
  longer leaves the window closed for up to nine minutes. It stops by itself after 30 minutes, also
  with a request left unanswered at its y/N question, and asks again about a request whose answer
  did not reach the server.

### Fixed
- `link` no longer reports "This PC is in your account" before that is true: it waits until the
  account's other devices are brought in, names the account, and fails with what to do when the PC
  ended in another account than the one that signed in. Run again while those devices are still
  coming in, it waits for them rather than reporting the PC as done.
