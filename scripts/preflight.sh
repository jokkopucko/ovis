#!/bin/sh
# herdr runs this first when it installs the plugin (herdr-plugin.toml, [[build]]), with its own
# environment rather than your shell's. It says in one line what is missing, instead of a failed
# `bun install` some steps later. The startup hook runs with the same PATH, so a bun that is
# missing here would also keep the app from starting with herdr. Also looks in the usual bun and
# node install places (~/.bun/bin, Homebrew, etc.) to handle GUI app PATH scenarios.
set -u
. "$(dirname "$0")/bun-path.sh"
fail=0
if command -v bun >/dev/null 2>&1; then
  version=$(bun --version 2>/dev/null || echo unknown)
  case "$version" in
    0.*|1.[0-3].*)
      # a Homebrew bun is updated by Homebrew, not by `bun upgrade`: follow the bun on PATH link by
      # link (plain readlink, or ls where there is none) and look at each path on the way
      update="bun upgrade"
      # Homebrew's default prefixes; tests point this at prefixes under a temporary root
      brew_prefixes=${OVIS_TEST_BREW_PREFIXES:-/opt/homebrew /home/linuxbrew/.linuxbrew}
      bun_path=$(command -v bun)
      case "$bun_path" in */*) ;; *) bun_path=./$bun_path ;; esac
      hops=0
      while :; do
        case "$bun_path" in */Cellar/*) update="brew upgrade bun"; break ;; esac
        for prefix in $brew_prefixes; do
          case "$bun_path" in "$prefix"/*) update="brew upgrade bun"; break 2 ;; esac
        done
        { [ -L "$bun_path" ] && [ "$hops" -lt 16 ]; } || break
        target=$(readlink "$bun_path" 2>/dev/null) || {
          # ls prints "path -> target"; a path that itself contains " -> " is misread (rare, falls back)
          listing=$(ls -ld "$bun_path" 2>/dev/null) || break
          case "$listing" in *" -> "*) target=${listing#* -> } ;; *) break ;; esac
        }
        case "$target" in /*) bun_path=$target ;; *) bun_path=${bun_path%/*}/$target ;; esac
        hops=$((hops + 1))
      done
      echo "Ovis needs Bun 1.4 or newer; this is Bun $version. Update it with: $update"; fail=1 ;;
  esac
else
  echo "Ovis needs Bun, and 'bun' is not on the PATH of the shell that started herdr."
  echo "Install it (https://bun.sh), start herdr from a shell where 'bun --version' works, then install again."
  fail=1
fi
if command -v node >/dev/null 2>&1; then
  major=$(node --version 2>/dev/null | sed 's/^\([^0-9]*\)\([0-9]*\).*/\2/')
  if [ "${major:-0}" -lt 18 ]; then
    echo "Ovis: Node $(node --version) is older than 18. Terminals run on the Rust PTY host; if that cannot run, the Node fallback may fail on this Node."
  fi
fi
exit $fail
