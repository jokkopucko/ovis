### Removed
- The desktop app no longer carries node-pty: its terminals run in hc, and a private sign-in
  terminal runs on the app's Rust PTY host (on Windows, where there is none, a sign-in from
  Settings offers a terminal tab instead).
