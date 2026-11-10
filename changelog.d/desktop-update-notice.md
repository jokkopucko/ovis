### Changed
- The desktop app now tells you when an update is ready instead of waiting for you to open the
  tray menu: one system notification per version ("Ovis X.Y.Z is ready"), whose click opens the
  window, and a line in the window with the same Restart to Update as the tray. The line can be
  closed for that version, and the connection screen shows it too, so an app whose server cannot
  start still offers its update.
- The desktop app checks for an update every hour instead of every 6 hours, and no longer
  downloads again a version it already holds.

### Fixed
- Restart to Update in the desktop app no longer leaves Ovis with its server stopped and nothing
  installed. A downloaded update whose file is gone (a newer download that failed removed it) is
  no longer offered and is downloaded again at the next check; on a Mac the update is offered
  only once the system's updater holds it; an AppImage in a folder it cannot write does not
  offer updates it could not install; and an install that fails at once starts Ovis again.
