#!/usr/bin/env bash
# Reads a pull request's changed paths, one a line, and prints browser=false when none of them can reach the
# Browser regression jobs, browser=true otherwise. Those jobs build the client and start the server, the relay
# shell, the demo and the desktop harness, and their scripts read files all over the repository (a docs page's
# example, the notices the build bundles, a worker's folder they copy, every file of public/ and of
# scripts/skill-menu-cases/), so only these are left out: unit tests beside the code they test, in the folders
# no browser job takes in whole (Fast checks and Integration tests run them), the terminal client, the push worker, the site, the phone and
# native apps' own folders, the installers, the runner launcher, changelog fragments, and every workflow but
# ci.yml. Any other path keeps the jobs, and so does a path this script cannot read: a new folder runs them
# until it is added here, and scripts/ci-browser-reach.test.ts fails when a browser script names a path left out.
# A change whose other paths are all under server/ (its fixtures aside) prints browser=live: the jobs run, but
# without the scripts that check the static demo alone and load no file of the server (scripts/ci-browser-parallel.ts's
# demoOnlyScripts, BROWSER_LIVE_ONLY).
set -euo pipefail

apart='^(tui|crates/ovis-tui|push-relay|ovis-site|app/(android|ios|mac|windows|store|assets)|scripts/self-hosted-runner|changelog\.d)/.'
files='^(\.coderabbit\.yaml|install\.sh|install\.ps1)$'
tests='^((server|shared|relay|integrations)/.+\.test\.ts|src/.+\.test\.tsx?|scripts/[^/]+\.test\.ts)$'
ci='^\.github/(workflows/ci\.yml$|actions/)'

seen=0
server=0
while IFS= read -r path || [ -n "$path" ]; do
  [ -n "$path" ] || continue
  seen=1
  if [[ $path == server/fixtures/* ]]; then echo "browser=true"; exit 0; fi
  if [[ $path =~ $ci ]]; then echo "browser=true"; exit 0; fi
  if [[ $path == .github/* ]] || [[ $path =~ $apart ]] || [[ $path =~ $files ]] || [[ $path =~ $tests ]]; then continue; fi
  if [[ $path == server/?* ]]; then server=1; continue; fi
  echo "browser=true"; exit 0
done
if [ "$seen" = 0 ]; then echo "browser=true"
elif [ "$server" = 1 ]; then echo "browser=live"
else echo "browser=false"
fi
