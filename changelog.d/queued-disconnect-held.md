### Fixed
- A queued follow-up held when the connection drops or reloads before anything is typed now
  recovers as **Held message — review and send** with **Send now** enabled once the browser
  reconnects, instead of staying stuck as "Not confirmed. Check the terminal before sending
  again."
  ([#3173](https://github.com/devswha/ovis/pull/3173) by @jimbb)

### Changed
- A message the PC held for a reason of its own (a lost connection, a turn that never started, a
  send it refused) keeps **Send now** only while the PC can still confirm that nothing was typed:
  on its own live connection, or once the same browser reconnects, reloads or shows it in another
  tab within ten minutes of losing the connection. Past those ten minutes, after this server or
  the PC's server restarts or updates, and on a remote PC that runs an older version, it now shows
  "Not confirmed. Check the terminal before sending again." with Copy and Discard, where it used
  to keep Send now. A message you held yourself (Alt+Enter, or any follow-up with automatic
  sending off) is not affected: it stays held until its Send now.
  ([#3173](https://github.com/devswha/ovis/pull/3173))
