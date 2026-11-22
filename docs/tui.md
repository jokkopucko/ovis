# Terminal client (`ovis tui`)

`ovis tui` shows herdr-core's terminals in your terminal the way herdr shows its own: the sidebar
of workspaces and agents with their state, tabs, splits, and herdr's keys from your herdr config.
It opens on the workspace and terminal you were on last, and `Ctrl+B q` (herdr's detach key)
leaves it. It is for PCs that run [herdr-core](https://github.com/herdrdev/herdr-core); it talks
to the core alone and works without the Ovis server.

The screen is [hc-tui](https://github.com/followcat/hc-tui) (Apache-2.0), used as a library at a
pinned commit with a few small changes of ours (`crates/ovis-tui/patches/`). It is not affiliated
with or endorsed by hc-tui or the Herdr project.

## Run it

```bash
ovis tui                             # or, in a checkout: bun scripts/plugin.ts tui
ovis tui --session work              # another herdr-core session
```

It never starts a core. When none runs, it says so with the command that starts one
(`hc server start`) and exits.

Released installs do not ship the program yet. `ovis tui` runs `OVIS_TUI_BIN`, else `ovis-tui` in
the install's `bin/` (beside the compiled `ovis-server`), else a build in the install's own checkout.
A build anywhere else, such as another checkout, is found through `OVIS_TUI_BIN`: put
`OVIS_TUI_BIN=/path/to/ovis-tui` in Ovis's settings file, or export it. To build it:

```bash
crates/ovis-tui/prepare.sh           # fetches the pinned hc-tui and applies our patches
cargo build --release --manifest-path crates/ovis-tui/Cargo.toml
```

The build needs Rust and Zig 0.16 (hc-tui builds Ghostty's terminal library with it).

## On a phone over SSH

At 64 columns or fewer (hc-tui's `mobile_width_threshold`; Termux and iOS SSH apps in portrait
are 45 to 60) the screen switches to hc-tui's phone layout and shows the focused terminal alone instead of its tab's whole split. Use the extra keys
row's CTRL for `Ctrl+B`.

When the connection drops, the client ends with it; run it again and it opens where you were.
Keys typed while a terminal's connection is down are refused with a notice, never sent once it
is back.

- **tmux:** run it inside tmux on the PC and a dropped connection does not end it; `tmux attach`
  shows it as it was. tmux keeps `Ctrl+B` for itself, so herdr's prefix becomes `Ctrl+B Ctrl+B`
  (or bind another prefix in your herdr config).
- **mosh:** the session survives sleep and network changes. mosh sends the keys typed while the
  network was gone once it is back: that is mosh's own behaviour. Use SSH with tmux if anything
  typed offline must not arrive later.

## Limits

- herdr-core only, on Linux and macOS.
