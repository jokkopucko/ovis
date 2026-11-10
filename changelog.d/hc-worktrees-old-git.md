### Fixed
- With herdr-core, a workspace's menu offers New worktree and Open worktree… on a PC whose git is
  older than 2.36, such as Ubuntu 22.04's git 2.34: listing the repository's checkouts failed
  there, so neither was offered
  ([#3478](https://github.com/devswha/ovis/issues/3478), reported by @datacas).
