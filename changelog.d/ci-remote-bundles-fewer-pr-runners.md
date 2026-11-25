### Maintenance
- A pull request's Remote PC bundles run takes two GitHub-hosted runners instead of four: its
  Linux job also assembles the Windows bundle and runs the SSH checks on the bundle it built, and
  a change to the server's unit tests or notes alone no longer starts it. A tag or a manual run
  keeps every job as before.
