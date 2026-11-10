### Maintenance
- The self-hosted runner's client-build cache keeps each build under the CI run whose job built it,
  and a job restores only its own run's. Before, a pull request's run could hand in a build under
  the key of a new commit of main ahead of main's own run, and main's Integration and Browser
  jobs, and a release validated by that run, would have tested that build. The launcher installed
  on every runner host that uses the cache must be updated (copy `scripts/self-hosted-runner`
  again and restart the unit); until then no build is restored there and every job builds.
