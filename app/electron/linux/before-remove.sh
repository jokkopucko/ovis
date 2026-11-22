#!/bin/bash

[ "$1" = remove ] || exit 0

wanted="${PKEXEC_UID:-${SUDO_UID:-}}"
case "$wanted" in '' | *[!0-9]*) exit 0 ;; esac
entry="$(getent passwd "$wanted")" || exit 0
# the account's own numbers, not the variable's spelling (00 is root too): never root
user="$(printf '%s' "$entry" | cut -d: -f1)"
uid="$(printf '%s' "$entry" | cut -d: -f3)"
home="$(printf '%s' "$entry" | cut -d: -f6)"
[ "$uid" != 0 ] || exit 0
hc="$home/.config/Ovis/bin/herdr-core"
[ -n "$user" ] && [ -x "$hc" ] || exit 0

runtime="/run/user/$uid"
[ -d "$runtime" ] || runtime=""
command -v runuser >/dev/null 2>&1 || exit 0
timeout 20 runuser -u "$user" -- env -i HOME="$home" USER="$user" LOGNAME="$user" PATH=/usr/local/bin:/usr/bin:/bin \
  ${runtime:+XDG_RUNTIME_DIR="$runtime"} HC_SESSION=ovis "$hc" server stop >/dev/null 2>&1 \
  && echo "Ovis: the herdr-core server it started for $user is stopped." \
  || echo "Ovis: could not stop the herdr-core server it started for $user."
exit 0
