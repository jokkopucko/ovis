### Maintenance
- A pull request that changes only the server (its fixtures aside, beside paths that cannot reach
  the browser jobs) runs Browser regression without the demo scripts that load no file of the
  server: they check the static demo build, which no server change reaches. Every other pull
  request, and every push, manual run and release validation, runs them all as before.
