### Maintenance
- A pull request that changes only the client (`src/` but the account and relay code the `ovis`
  command shares, `public/`, `index.html`, changelog fragments) skips the herdr-core live contract,
  Rust PTY host and Native macOS session identity jobs, none of whose tests loads those files. Any
  other path, and every push to `main`, Release and manual run, runs them as before.
