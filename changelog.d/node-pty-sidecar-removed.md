### Removed
- The Node PTY sidecar (node-pty) is gone: on Linux and macOS every terminal runs on the Rust PTY host
  each release ships, the one-line installer no longer installs Node, and remote PC bundles no longer
  carry Node. Where the host cannot run, panes are mirrored and the server's log says why and how to
  get one (`bun scripts/pty-sidecar.ts install`, or `cargo build` in a checkout).
