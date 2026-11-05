#!/usr/bin/env bash
# Prints the path of the ffmpeg the relay media run encodes its test video with (FFMPEG in
# scripts/relay-media-browser-qa.ts): a static Linux x64 build pinned by release and SHA-256, as
# scripts/check.ts pins actionlint. An ffmpeg on PATH that reports the pinned version is used as it
# is; otherwise the pinned archive is fetched once, checked and kept in node_modules/.cache.
set -euo pipefail

release="b6.1.1"
version="7.0.2-static"
sha256="bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd -- "$script_dir/.." && pwd)"

reports_pinned() { "$1" -hide_banner -version 2>/dev/null | head -n 1 | grep -q "^ffmpeg version $version "; }

if found="$(command -v ffmpeg)" && reports_pinned "$found"; then
  printf '%s\n' "$found"
  exit 0
fi
if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  printf '%s\n' "[setup] the pinned ffmpeg is a Linux x64 build; set FFMPEG to an ffmpeg with libx264 instead" >&2
  exit 1
fi

dir="$repo/node_modules/.cache/ffmpeg-$release"
binary="$dir/ffmpeg"
if [ ! -x "$binary" ] || ! reports_pinned "$binary"; then
  mkdir -p "$dir"
  printf '%s\n' "[setup] Fetching ffmpeg $version (ffmpeg-static $release)..." >&2
  curl --fail --location --silent --show-error --retry 3 \
    "https://github.com/eugeneware/ffmpeg-static/releases/download/$release/ffmpeg-linux-x64.gz" -o "$dir/ffmpeg.gz"
  echo "$sha256  $dir/ffmpeg.gz" | sha256sum --check --quiet
  gunzip --force "$dir/ffmpeg.gz"
  chmod +x "$binary"
  reports_pinned "$binary" || { printf '%s\n' "[setup] the pinned ffmpeg does not report version $version" >&2; exit 1; }
fi
printf '%s\n' "$binary"
