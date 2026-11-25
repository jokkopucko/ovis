### Maintenance
- CI's Fast checks and Integration tests can prefer the fastest self-hosted machine's own label
  (`CI_FAST_SELF_HOSTED_LABELS`, `CI_INTEGRATION_SELF_HOSTED_LABELS`) and fall back to the shared
  pool while its queue is long or it looks offline. herdr-core live contract runs GitHub-hosted
  unless `CI_HC_LIVE_LABELS` moves it back.
