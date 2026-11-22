#!/bin/sh
# covered.sh           lists the covered files that differ from covered.blobs. Exit 0: none does.
#                      Exit 1: some do, so the model needs another look.
# covered.sh --record  writes covered.blobs from the files as they are now. Run it only after
#                      confirming that the model describes them.
# covered.blobs holds each covered file's git blob id. A squash merge keeps blob ids, so the sync
# commit is whichever commit last changed that file.
here=$(cd "$(dirname "$0")" && pwd)
top=$(git -C "$here" rev-parse --show-toplevel) || exit 2
cd "$top" || exit 2
record=${here#"$top"/}/covered.blobs
files="server/core/pending.ts server/pending-input.ts server/input-guard.ts
server/core/terminals.ts server/core/terminal-process.ts server/core/connections.ts
server/core/socket.ts server/core/server-core.ts server/core/input.ts server/core/composer.ts
server/opencode-skill-attach.ts server/workspace-routes.ts server/herdr/client.ts"
if [ "$1" = "--record" ]; then
  new=$record.new
  : > "$new" || exit 2
  for file in $files; do
    id=$(git hash-object "$file") || { rm -f "$new"; echo "$file cannot be read: nothing recorded" >&2; exit 2; }
    echo "$id $file" >> "$new" || { rm -f "$new"; echo "$new cannot be written: nothing recorded" >&2; exit 2; }
  done
  mv "$new" "$record" || exit 2
  echo "recorded $record"
  exit 0
fi
[ -f "$record" ] || { echo "no $record" >&2; exit 2; }
sync=$(git log -1 --format=%H -- "$record")
echo "sync commit: ${sync:-none yet, $record is not committed}"
changed=0
for file in $files; do
  was=$(sed -n "s| $file\$||p" "$record")
  [ -n "$was" ] || { echo "$file is not in $record" >&2; exit 2; }
  if [ ! -f "$file" ]; then echo "$file is gone or moved"; changed=1; continue; fi
  now=$(git hash-object "$file") || exit 2
  [ "$was" = "$now" ] && continue
  changed=1
  if git cat-file -e "$was" 2>/dev/null; then
    echo "$file changed: $(git cat-file -p "$was" | diff - "$file" | grep -c '^[<>]') lines differ"
  else
    echo "$file changed"
  fi
done
[ "$changed" = 0 ] && echo "no covered file changed since"
exit "$changed"
