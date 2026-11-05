### Fixed
- An SSH connection to a remote PC makes its private temporary folder only once it starts, so a
  connection that never starts no longer leaves an empty `/tmp/herdr-ssh-*` folder behind. The
  server also removes such leftover empty folders older than an hour when it starts; enough of
  them could fill a tmpfs `/tmp` and make unrelated programs fail with "no space left".
