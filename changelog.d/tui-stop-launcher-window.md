### Fixed
- `ovis tui` stops with its job again on a busy machine: when the shell stopped the job, the screen
  could read its launcher as still running in the moment before it stopped, and then stayed running
  in the stopped job instead of stopping with it.
