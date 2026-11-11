### Fixed
- A Windows PC no longer reads a path on another host's network share for a link or an address that
  names one: a Markdown link (`[x](//host/share/a.md)`, also written with backslashes,
  percent-encoded or after `~/`), a tool call's file row, or an Ovis address with `?file=` or
  `?read=`. Opening one asked that host for the file with your sign-in. A share the pane's folder or
  your home folder is on, and WSL's own files (`\\wsl$\…`, `\\wsl.localhost\…`), open as before.
- A connection, a watch-only device included, can no longer make the PC run more than 64 of the
  processes that draw a watched pane: a watch names its pane by a pane's id, a pane has one such
  process at a time, and one connection watches at most 64 panes.
- A message of tens of thousands of line breaks followed by a letter no longer stalls the PC's
  server, and every terminal with it, while it is refused.
