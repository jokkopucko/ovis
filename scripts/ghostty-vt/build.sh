#!/usr/bin/env bash
# Rebuilds shared/ghostty/ghostty-vt.wasm: libghostty-vt from ghostty (MIT) at a pinned commit, with
# kitty-on-wasm.patch, which turns the Kitty graphics protocol on for wasm32-freestanding (upstream
# leaves it off there: no file medium and no PNG decoder). The patch refuses the file, temporary
# file and shared memory media, which have no meaning in a browser, and links ghostty's bundled
# wuffs PNG decoder, so a PNG a program sends is decoded inside the module.
# screen-generation.patch exposes the selection lifetime at the native switch/reset sites.
# erase-ends-wrap.patch makes an erase from a row's first column (EL 0 there, EL 2, ED 0 there) and a line
# feed onto a row end the soft wrap that led into the row. ED 1 and DECSED 1 end the wrap into the
# next row when they clear the cursor's whole row, matching how xterm joins a pane's lines.
#
#   ZIG=/path/to/zig-0.17.1/zig scripts/ghostty-vt/build.sh
#
# Expected output sha256 (zig 0.17.1, x86_64-linux):
#   ef5b5329666ce5b9dd4b56b1bb620966b186e2aa56946893546036ea04305468
set -euo pipefail
GHOSTTY_COMMIT=e95bed63330cc921f3cf2fe3d14e024396b09d43
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
zig="${ZIG:-zig}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git -C "$work" init -q ghostty
git -C "$work/ghostty" fetch -q --depth 1 https://github.com/ghostty-org/ghostty "$GHOSTTY_COMMIT"
git -C "$work/ghostty" checkout -q FETCH_HEAD
git -C "$work/ghostty" apply "$here/kitty-on-wasm.patch"
git -C "$work/ghostty" apply "$here/screen-generation.patch"
git -C "$work/ghostty" apply "$here/erase-ends-wrap.patch"
(cd "$work/ghostty" && "$zig" build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall --prefix "$work/out")
cp "$work/out/bin/ghostty-vt.wasm" "$repo/shared/ghostty/ghostty-vt.wasm"
sha256sum "$repo/shared/ghostty/ghostty-vt.wasm"
