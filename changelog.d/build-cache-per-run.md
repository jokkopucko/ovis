### Maintenance
- The self-hosted runner's client-build cache keeps each build under the CI run whose job built it,
  and a job restores only its own run's. Before, a pull request's run could hand in a build under
  the key of a new commit of main ahead of main's own run, and main's Integration and Browser
  jobs, and a release validated by that run, would have tested that build. The launcher installed
  on every runner host that uses the cache must be updated (copy `scripts/self-hosted-runner`
  again with `rsync -a`; no restart, which would cancel the jobs in flight); until then no build
  is restored there and every job builds.
- The runner's build cache takes a build in only from the container whose job handed it in, for a
  job that started once that container had: a claim naming the run of the slot's next job, or of a
  killed container's job that GitHub still lists as running, is refused, and so is a build an
  earlier job left in an outbox that could not be emptied. An old entry that cannot be removed is
  moved out of the names jobs read instead of being tried and logged every second.
