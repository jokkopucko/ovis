#!/usr/bin/env bash
# Rebuilds shared/ghostty/ghostty-vt.wasm: libghostty-vt from ghostty (MIT) at a pinned commit, with
# kitty-on-wasm.patch, which turns the Kitty graphics protocol on for wasm32-freestanding (upstream
# leaves it off there: no file medium and no PNG decoder). The patch refuses the file, temporary
# file and shared memory media, which have no meaning in a browser, and links ghostty's bundled
# wuffs PNG decoder, so a PNG a program sends is decoded inside the module.
#
#   ZIG=/path/to/zig-0.17.1/zig scripts/ghostty-vt/build.sh
#
# Expected output sha256 (zig 0.17.1, x86_64-linux):
#   b8e8d0f8dd4e84718002198f80d5399005d6d42f2d419b31644343d5703a1444
set -euo pipefail
GHOSTTY_COMMIT=e95bed6
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
zig="${ZIG:-zig}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git -C "$work" init -q ghostty
git -C "$work/ghostty" fetch -q --depth 1 https://github.com/ghostty-org/ghostty "$GHOSTTY_COMMIT"
git -C "$work/ghostty" checkout -q FETCH_HEAD
git -C "$work/ghostty" apply "$here/kitty-on-wasm.patch"
(cd "$work/ghostty" && "$zig" build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall --prefix "$work/out")
cp "$work/out/bin/ghostty-vt.wasm" "$repo/shared/ghostty/ghostty-vt.wasm"
sha256sum "$repo/shared/ghostty/ghostty-vt.wasm"
