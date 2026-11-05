### Added
- An opt-in beta update channel: with `beta` in the state dir's `update-channel` file (or
  `OVIS_UPDATE_CHANNEL=beta`), a PC also updates to the `beta/vX.Y.Z-beta.N` builds made from each
  commit on main whose checks pass, and the desktop app to its beta builds. Off by default.
