### Fixed
- The desktop app on the beta update channel is offered beta builds on Linux and Mac. Each commit
  on main whose checks passed was built for it, but the builds were never uploaded, so the app
  found no beta feed and stayed on the release it had.
