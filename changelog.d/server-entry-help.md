### Fixed
- `ovis-server <entry> -h` or `--help` prints the usage instead of running the entry: `ovis-server serve
  --help` started a server. `serve` now refuses any argument it does not take.
