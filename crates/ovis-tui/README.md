# ovis-tui

The terminal client: herdr-core's terminals as herdr shows them. Users read
[docs/tui.md](../../docs/tui.md); this file is for working on it.

## Layout

- `src/`: the program. It resolves the herdr-core endpoint, says how to start a core when none
  answers (it never starts one), and runs hc-tui's screen with three settings: input typed while a
  terminal's connection recovers is refused, a phone-width screen shows the focused terminal
  alone, and hc-tui never runs `hc server start`. The Ovis token and address are removed from its
  environment first, so nothing it starts can see them.
- `hc-tui.pin` and `prepare.sh`: the pinned hc-tui revision. `prepare.sh` fetches it into
  `upstream/` (ignored by git) and applies `patches/`; run it after a checkout and whenever
  `hc-tui.pin` or `patches/` change. The patches are `git format-patch` output of commits made
  in `upstream/`, each with its tests; hc-tui's own conventions apply to them.

## Checks

```bash
./prepare.sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
(cd upstream && cargo test -p hc-tui)   # the patches' own tests
```

The build needs Zig 0.16 for hc-tui's Ghostty library. CI runs the same on a pull request that
touches the crate (`.github/workflows/ovis-tui.yml`).

## Release packaging (not done yet)

Released installs do not ship `ovis-tui` yet; `ovis tui` finds a local build or `OVIS_TUI_BIN`.
A second change should:

1. Build static binaries in CI for linux-x64 and linux-arm64 (`x86_64-unknown-linux-musl`,
   `aarch64-unknown-linux-musl`) and macOS (arm64 and x86_64), as `pty-sidecar.yml` does for the
   PTY host: `rustup target add`, Zig 0.16 on the runner, `prepare.sh`, then `cargo build
   --release --locked --target <triple>`. A musl build is about 11 MB, `static-pie linked`, and
   runs in a bare Alpine container.
2. Attach them to the release with a manifest (version, SHA-256 per platform) and build provenance,
   and install the one for the platform as `bin/ovis-tui`, which `scripts/plugin-tui.ts` already
   looks for.
3. Ship the licence texts and notices of everything linked into the binary beside it: hc-tui's
   `LICENSE` and `NOTICE` (Apache-2.0 section 4), Ghostty's MIT licence and those of its
   packages, and every Rust crate in `Cargo.lock` (generated, e.g. with cargo-about).
4. Pin the Rust toolchain the build and `clippy -D warnings` use.

A one-line install on a headless Linux box then needs nothing but the binary and a herdr-core.
