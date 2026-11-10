### Maintenance
- The Release run no longer runs the whole CI a second time when main's own CI run already passed
  the same commit: it takes that run, waiting up to 40 minutes for one still going, and still runs
  Fast checks itself, on GitHub's runner, where the unit tests the self-hosted runner skips run.
  It runs the whole CI itself whenever main's run is missing, failed, was rerun more than once or
  cannot be read. Its new `revalidate` input runs the whole CI in the Release run as before, and
  **Actions → Release validation** is a dry run of the decision that publishes nothing.
